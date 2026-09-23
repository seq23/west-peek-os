#!/usr/bin/env node
/**
 * PULL A GOOGLE DRIVE FOLDER TO DISK, on her Mac, with the firm's service account.
 *
 *   node scripts/drive/pull.mjs --map <folder-id> <out-dir>    list every file into DRIVE_MANIFEST.json, fetch the documents
 *   node scripts/drive/pull.mjs --fetch <out-dir> <path>…      fetch named assets from that manifest, on demand
 *   node scripts/drive/pull.mjs --self-test                     no network: the pure parts
 *
 * WHAT IT IS. The Worker cannot read a partner's Drive folder — the service account lives in the
 * vault on her Mac (`GSC_SERVICE_ACCOUNT_JSON`, gsc-bot, `drive.readonly`, impersonating
 * sequoia@westpeek.ventures). This script runs under `vault.mjs run --` so the credential exists
 * only in this process's environment and never on a command line, in a plist, or in a log.
 *
 * WHAT IT DOES. Walks the folder recursively; downloads binary files as they are; EXPORTS Google
 * Docs as text, Sheets as CSV and Slides as PDF; skips other Google-native types and says so.
 *
 * NO FILE OVER 1 GB IS EVER DOWNLOADED, BY ANY PATH (23 Sep 2026). The refusal used to guard
 * `--fetch` only, and the legacy whole-folder mode (`pull.mjs <folder> <out>`, no flag) had no cap
 * at all — a stale claimer ran it on the community package and began copying a 14.6 GB recording.
 * The legacy mode is gone (nothing in the repo called it: the duty runs `--map` and `--fetch` only,
 * and its own self-test pins that), and the ceiling now lives in `fetchOne`, the ONE function every
 * download goes through: refused up front on Drive's reported size, and cut off mid-stream by a byte
 * counter when the size is missing or wrong. `--self-test` pins both.
 *
 * ZERO FILES IS A FAILURE, NOT A SUCCESS (Rule 0). A folder the account cannot see, an empty
 * folder, or a share that was never granted all look the same from here — no files — and every
 * one of them means the PLAN phase has nothing to plan from. Exit 1 with the folder id in the
 * message, so the card blocks NAMING THE FOLDER rather than planning from an empty directory.
 *
 * Copied into the repo from the session scratchpad on 20 Sep 2026 (Plan A), where it pulled the
 * westpeek.ventures package by hand; `card kind: WEB_PROPERTY_CHANGE` uses it from
 * scripts/duties/web-property-change.mjs.
 */
import { writeFileSync, mkdirSync, readFileSync, createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, relative } from "node:path";

const SUBJECT = process.env.DRIVE_SUBJECT ?? "sequoia@westpeek.ventures";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Google-native types and how each is exported. Anything else Google-native is skipped, by name. */
export const EXPORT = {
  "application/vnd.google-apps.document": ["text/plain", ".txt"],
  "application/vnd.google-apps.spreadsheet": ["text/csv", ".csv"],
  "application/vnd.google-apps.presentation": ["application/pdf", ".pdf"],
};

/** A file name Drive gave us, made safe for a directory: no separators, no leading dots. */
export function safeName(name) {
  const cleaned = String(name ?? "").replace(/[\\/]/g, "_").replace(/^\.+/, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "unnamed";
}

/** The Drive folder id out of any of the link shapes a partner pastes, or the bare id. */
export function folderIdFrom(input) {
  const s = String(input ?? "").trim();
  const m = s.match(/(?:folders\/|[?&]id=)([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(s) ? s : null;
}

async function accessToken(creds) {
  const { createSign } = await import("node:crypto");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: creds.client_email, sub: SUBJECT, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }),
  );
  const s = createSign("RSA-SHA256");
  s.update(`${header}.${claims}`);
  const sig = b64url(s.sign(creds.private_key));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${sig}` }),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).access_token;
}

/**
 * LIST FIRST, THEN DOWNLOAD IN PARALLEL (23 Sep 2026). The walk used to fetch one file at a time:
 * the community-site package (11 folders, 199 files in six of them, 16 MB) took over 15 minutes and
 * had not reached 00-03 when it was cut off, inside a PLAN phase whose whole budget is 40 minutes
 * (shared/work/localJobs.ts). Listing is cheap and stays sequential; the downloads run CONCURRENCY
 * at a time. Every file is still printed, FAILs are still counted, and zero files still rejects.
 */
export const CONCURRENCY = 8;

async function list(token, id, dir, out) {
  mkdirSync(dir, { recursive: true });
  let pageToken = "";
  do {
    const u = new URL("https://www.googleapis.com/drive/v3/files");
    u.searchParams.set("q", `'${id}' in parents and trashed=false`);
    u.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,size)");
    u.searchParams.set("supportsAllDrives", "true");
    u.searchParams.set("includeItemsFromAllDrives", "true");
    u.searchParams.set("pageSize", "1000");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const r = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`list ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    pageToken = j.nextPageToken ?? "";
    for (const f of j.files ?? []) {
      if (f.mimeType === "application/vnd.google-apps.folder") {
        await list(token, f.id, join(dir, safeName(f.name)), out);
        continue;
      }
      out.push({ f, dir });
    }
  } while (pageToken);
  return out;
}

/** Run `fn` over `items`, at most `n` at a time. Pure scheduling, self-tested. */
export async function pool(items, n, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/** A pass-through that errors once more than `max` bytes have gone by — the cap for a size Drive did not report. */
export function byteCap(max, what) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, done) {
      seen += chunk.length;
      if (seen > max) done(new Error(`${what} passed the ${max / 1e9} GB ceiling mid-download and was stopped`));
      else done(null, chunk);
    },
  });
}

export async function fetchOne(token, { f, dir }, tally, maxBytes = FETCH_MAX_BYTES) {
  let url;
  let name = safeName(f.name);
  if (Number(f.size) > maxBytes) {
    console.log(`FAIL ${dir}/${name} is ${(Number(f.size) / 1e9).toFixed(1)} GB: over the ${maxBytes / 1e9} GB ceiling, not downloaded`);
    tally.failed += 1;
    return;
  }
  if (EXPORT[f.mimeType]) {
    const [mt, ext] = EXPORT[f.mimeType];
    url = `https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=${encodeURIComponent(mt)}`;
    name += ext;
  } else if (f.mimeType.startsWith("application/vnd.google-apps")) {
    console.log(`SKIP ${dir}/${name} (${f.mimeType})`);
    tally.skipped += 1;
    return;
  } else {
    url = `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&supportsAllDrives=true`;
  }
  // EVERY DOWNLOAD HAS A CEILING (23 Sep 2026). A fetch with no timeout hung on one file of the
  // community package after every other file had landed, and the pull never returned — inside a
  // 40-minute PLAN phase that would have spent its whole budget waiting and reported nothing useful.
  // The ceiling scales with the file (a 100 MB podcast MP3 is in that package); one retry; then a
  // named FAIL, counted like any other, never a silent hang.
  const ceiling = fileCeilingMs(f.size);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const d = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(ceiling) });
      if (!d.ok) {
        console.log(`FAIL ${dir}/${name} ${d.status}`);
        tally.failed += 1;
        return;
      }
      // Streamed to disk, never held whole in memory (a 14.6 GB episode recording sits in the
      // community package; arrayBuffer() on it would take the Mac's memory with it).
      await pipeline(Readable.fromWeb(d.body), byteCap(maxBytes, `${dir}/${name}`), createWriteStream(join(dir, name)));
      console.log(`${dir}/${name} (${f.size ?? "export"})`);
      tally.files += 1;
      return;
    } catch (err) {
      if (/GB ceiling/.test(String(err?.message))) {
        console.log(`FAIL ${err.message}`);
        tally.failed += 1;
        return;
      }
      if (attempt === 2) {
        console.log(`FAIL ${dir}/${name} ${err?.name === "TimeoutError" ? `timed out after ${Math.round(ceiling / 1000)}s twice` : String(err?.message ?? err).slice(0, 120)}`);
        tally.failed += 1;
        return;
      }
    }
  }
}

/** 2 minutes, plus 1 minute per 20 MB — generous for a slow line, finite for a dead one. */
export function fileCeilingMs(size) {
  const bytes = Number(size) || 0;
  return 120_000 + Math.ceil(bytes / 20_000_000) * 60_000;
}

// ── MAP FIRST, FETCH ON DEMAND (owner's decision, 23 Sep 2026) ──────────────────────────────────
// "It's there in Google Drive to access for a reason." A job no longer copies a whole package: the
// community-site folder was 226 files / 119 MB (a 100 MB podcast MP3, 180 flyers, two old-site
// ZIPs) and the whole-folder pull was slow enough to threaten a 40-minute PLAN. `--map` lists
// every file into DRIVE_MANIFEST.json and downloads only the DOCUMENTS (briefs, READMEs, notes,
// sheets); every asset stays in Drive and `--fetch` brings one by its path when the plan needs it.

export const MANIFEST = "DRIVE_MANIFEST.json";
const DOC_EXT = /\.(md|markdown|txt|pdf|csv|json|rtf|docx?)$/i;
const DOC_MAX_BYTES = 25_000_000;

/** Nothing a job fetches may exceed this: the community package carries a 14.6 GB episode recording. */
export const FETCH_MAX_BYTES = 1_000_000_000;
export function tooBigToFetch(size) {
  return Number(size) > FETCH_MAX_BYTES;
}

/** A file the plan reads to understand the job (fetched up front), as opposed to an asset. */
export function isDocument(f) {
  if (EXPORT[f.mimeType]) return true;
  const small = !(Number(f.size) > DOC_MAX_BYTES);
  if (!small) return false;
  if (f.mimeType?.startsWith("text/") || f.mimeType === "application/pdf" || f.mimeType === "application/json") return true;
  return DOC_EXT.test(String(f.name ?? ""));
}

/** The manifest entries a request names: an exact path, else ONE case-insensitive path/name match. */
export function resolveEntries(entries, wanted) {
  const found = [];
  const missing = [];
  for (const w of wanted) {
    const exact = entries.find((e) => e.path === w);
    if (exact) { found.push(exact); continue; }
    const hits = entries.filter((e) => e.path.toLowerCase().includes(String(w).toLowerCase()));
    if (hits.length === 1) found.push(hits[0]);
    else missing.push(hits.length ? `${w} (matches ${hits.length} files — use the full path)` : `${w} (no such file in the manifest)`);
  }
  return { found, missing };
}

/** List everything, fetch the documents, write the manifest. REJECTS when the folder lists nothing. */
export async function mapFolder(folderId, outDir, creds) {
  const token = await accessToken(creds);
  const files = await list(token, folderId, outDir, []);
  if (files.length === 0) {
    throw new Error(`Drive folder ${folderId} lists ZERO files. Either it is empty, or ${SUBJECT} cannot see it — share it with that account, or send the right folder.`);
  }
  const tally = { files: 0, skipped: 0, failed: 0 };
  const docs = files.filter(({ f }) => isDocument(f));
  await pool(docs, CONCURRENCY, (item) => fetchOne(token, item, tally));
  const entries = files.map(({ f, dir }) => ({
    path: relative(outDir, join(dir, safeName(f.name))) + (EXPORT[f.mimeType]?.[1] ?? ""),
    id: f.id,
    mimeType: f.mimeType,
    size: f.size ? Number(f.size) : null,
    fetched: isDocument(f),
  }));
  writeFileSync(join(outDir, MANIFEST), JSON.stringify({ folder_id: folderId, listed_at: new Date().toISOString(), files: entries }, null, 2));
  return { listed: files.length, documents: tally.files, failed: tally.failed, skipped: tally.skipped };
}

/** Fetch named assets from an earlier --map into the same place. REJECTS naming anything it cannot find. */
export async function fetchFiles(outDir, wanted, creds) {
  const manifest = JSON.parse(readFileSync(join(outDir, MANIFEST), "utf8"));
  const { found, missing } = resolveEntries(manifest.files, wanted);
  if (missing.length) throw new Error(`not fetched — ${missing.join("; ")}`);
  const huge = found.filter((e) => tooBigToFetch(e.size));
  if (huge.length) {
    throw new Error(`not fetched — ${huge.map((e) => `${e.path} is ${(e.size / 1e9).toFixed(1)} GB`).join("; ")}: over the ${FETCH_MAX_BYTES / 1e9} GB ceiling. A site embeds video from YouTube and does not host the recording; if a clip is needed, ask for an exported cut.`);
  }
  const token = await accessToken(creds);
  const tally = { files: 0, skipped: 0, failed: 0 };
  await pool(found, CONCURRENCY, (e) => {
    const dir = join(outDir, e.path.split("/").slice(0, -1).join("/"));
    mkdirSync(dir, { recursive: true });
    const base = e.path.split("/").pop();
    const name = EXPORT[e.mimeType] ? base.slice(0, -EXPORT[e.mimeType][1].length) : base;
    return fetchOne(token, { f: { id: e.id, name, mimeType: e.mimeType, size: e.size }, dir }, tally);
  });
  if (tally.failed) throw new Error(`${tally.failed} of ${found.length} file(s) failed to fetch`);
  return tally;
}

async function selfTest() {
  const cases = [
    ["pool runs every item exactly once and never more than n at a time", async () => {
      let live = 0, peak = 0;
      const seen = [];
      await pool([...Array(20).keys()], 8, async (x) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); seen.push(x); live--; });
      return seen.length === 20 && new Set(seen).size === 20 && peak <= 8 && peak > 1;
    }],
    ["every download has a finite ceiling that grows with the file", () => fileCeilingMs(undefined) === 120_000 && fileCeilingMs(103_597_440) === 120_000 + 6 * 60_000 && fileCeilingMs(1) > 0],
    ["a brief, a README, notes and a Google Doc are documents; a font, an image, an MP3 and a ZIP are assets", () =>
      isDocument({ name: "Brief.pdf", mimeType: "application/pdf", size: "500000" }) &&
      isDocument({ name: "README FOR CLAUDE.md", mimeType: "text/markdown", size: "13000" }) &&
      isDocument({ name: "notes", mimeType: "application/vnd.google-apps.document" }) &&
      isDocument({ name: "Links.md", mimeType: "application/octet-stream", size: "900" }) &&
      !isDocument({ name: "Maax-Bold.otf", mimeType: "font/otf", size: "60848" }) &&
      !isDocument({ name: "logo.png", mimeType: "image/png", size: "68166" }) &&
      !isDocument({ name: "Good People.mp3", mimeType: "audio/mpeg", size: "103597440" }) &&
      !isDocument({ name: "site.zip", mimeType: "application/zip", size: "1120849" }) &&
      !isDocument({ name: "huge.pdf", mimeType: "application/pdf", size: String(DOC_MAX_BYTES + 1) })],
    ["fetch resolves an exact path, a unique fragment, and refuses an ambiguous or unknown one by name", () => {
      const entries = [{ path: "03-fonts/205 - Maax-Bold.otf" }, { path: "03-fonts/Maax-Medium.otf" }, { path: "02-design-and-brand/West Peek - W Monogram - Black on White.png" }];
      const a = resolveEntries(entries, ["03-fonts/Maax-Medium.otf", "monogram"]);
      const b = resolveEntries(entries, ["maax", "sengo logo"]);
      return a.found.length === 2 && a.missing.length === 0 && b.found.length === 0 && b.missing.length === 2 && /matches 2 files/.test(b.missing[0]) && /no such file/.test(b.missing[1]);
    }],
    ["a 14.6 GB recording is refused on fetch; a 100 MB MP3 and a font are not", () => tooBigToFetch(14_621_500_000) && !tooBigToFetch(103_597_440) && !tooBigToFetch(60_848) && !tooBigToFetch(null)],
    ["fetchOne — the one download path — refuses a file over the ceiling before it asks Drive for a byte", async () => {
      const realFetch = globalThis.fetch;
      let called = 0;
      globalThis.fetch = async () => { called += 1; throw new Error("fetched"); };
      try {
        const tally = { files: 0, skipped: 0, failed: 0 };
        await fetchOne("t", { f: { id: "x", name: "Episode 12.mp4", mimeType: "video/mp4", size: "14621500000" }, dir: "/nonexistent" }, tally);
        return called === 0 && tally.failed === 1 && tally.files === 0;
      } finally {
        globalThis.fetch = realFetch;
      }
    }],
    ["a file whose size Drive did not report is cut off mid-stream at the ceiling", async () => {
      const { mkdtempSync, existsSync: exists, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(join(tmpdir(), "pull-cap-"));
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(1000)); c.close(); } }));
      try {
        const tally = { files: 0, skipped: 0, failed: 0 };
        await fetchOne("t", { f: { id: "x", name: "unsized.bin", mimeType: "application/octet-stream" }, dir }, tally, 2500);
        const underCap = { files: 0, skipped: 0, failed: 0 };
        await fetchOne("t", { f: { id: "y", name: "small.bin", mimeType: "application/octet-stream" }, dir }, underCap, 10_000);
        return tally.failed === 1 && tally.files === 0 && underCap.files === 1 && exists(join(dir, "small.bin"));
      } finally {
        globalThis.fetch = realFetch;
        rmSync(dir, { recursive: true, force: true });
      }
    }],
    ["every download goes through fetchOne, and the legacy whole-folder mode is gone", async () => {
      const whole = readFileSync(new URL(import.meta.url), "utf8");
      const src = whole.slice(0, whole.indexOf("async function selfTest(")) + whole.slice(whole.lastIndexOf("const isMain"));
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const downloads = (code.match(/alt=media|\/export\?mimeType=/g) ?? []).length;
      const pipelines = (code.match(/await pipeline\(/g) ?? []).length;
      return downloads === 2 && pipelines === 1 && /byteCap\(maxBytes/.test(code) && !/pullFolder|async function walk\(/.test(code);
    }],
    ["pool with nothing to do resolves", async () => { await pool([], 8, async () => { throw new Error("ran"); }); return true; }],
    ["a folders/ link yields its id", () => folderIdFrom("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing") === "1AbCdEfGhIjKlMnOp"],
    ["a u/0 link yields its id", () => folderIdFrom("https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOp") === "1AbCdEfGhIjKlMnOp"],
    ["an open?id= link yields its id", () => folderIdFrom("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp") === "1AbCdEfGhIjKlMnOp"],
    ["a bare id is accepted", () => folderIdFrom("1AbCdEfGhIjKlMnOp") === "1AbCdEfGhIjKlMnOp"],
    ["a file link is not a folder id", () => folderIdFrom("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view") === null],
    ["nonsense is null", () => folderIdFrom("hello") === null],
    ["a slash in a name cannot escape the directory", () => safeName("../../etc/passwd") === "_.._etc_passwd" || !safeName("../../etc/passwd").includes("/")],
    ["an empty name is named", () => safeName("") === "unnamed"],
    ["docs export as text", () => EXPORT["application/vnd.google-apps.document"][1] === ".txt"],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try {
      ok = (await fn()) === true;
    } catch {
      ok = false;
    }
    console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
    if (!ok) failed += 1;
  }
  if (cases.length === 0 || failed > 0) {
    console.error(`SELF-TEST FAILED: ${failed} of ${cases.length}`);
    process.exit(1);
  }
  console.log(`SELF-TEST PASSED: ${cases.length} cases`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  if (process.argv.includes("--self-test")) {
    await selfTest();
  } else {
    const creds0 = () => {
      const c = JSON.parse(process.env.GSC_SERVICE_ACCOUNT_JSON ?? "null");
      if (!c) {
        console.error("No service account in the environment. Run under `node scripts/vault/vault.mjs run -- …` so GSC_SERVICE_ACCOUNT_JSON is injected.");
        process.exit(2);
      }
      return c;
    };
    const fail = (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); };
    if (process.argv[2] === "--map") {
      const [, rootArg, out] = process.argv.slice(2);
      const root = folderIdFrom(rootArg);
      if (!root || !out) { console.error("usage: node scripts/drive/pull.mjs --map <folder-id-or-link> <out-dir>"); process.exit(2); }
      await mapFolder(root, out, creds0())
        .then((t) => console.log(`MAPPED ${t.listed} file(s) from ${root} into ${out}/${MANIFEST}; fetched ${t.documents} document(s) (${t.failed} failed, ${t.skipped} skipped). Assets stay in Drive: node scripts/drive/pull.mjs --fetch ${out} <path>…`))
        .catch(fail);
      process.exit(0);
    }
    if (process.argv[2] === "--fetch") {
      const [, out, ...wanted] = process.argv.slice(2);
      if (!out || wanted.length === 0) { console.error("usage: node scripts/drive/pull.mjs --fetch <out-dir-of-a-map> <path-or-unique-fragment>…"); process.exit(2); }
      await fetchFiles(out, wanted, creds0())
        .then((t) => console.log(`FETCHED ${t.files} file(s) into ${out}`))
        .catch(fail);
      process.exit(0);
    }
    // THE LEGACY WHOLE-FOLDER MODE IS GONE (23 Sep 2026): no flag is a usage error, never a copy of everything.
    console.error("usage: node scripts/drive/pull.mjs --map <folder-id-or-link> <out-dir> | --fetch <out-dir-of-a-map> <path>… | --self-test");
    process.exit(2);
  }
}
