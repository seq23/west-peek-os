#!/usr/bin/env node
/**
 * PULL A GOOGLE DRIVE FOLDER TO DISK, on her Mac, with the firm's service account.
 *
 *   node scripts/drive/pull.mjs <folder-id> <out-dir>          pull recursively, print each file, exit 1 on zero files
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
 * ZERO FILES IS A FAILURE, NOT A SUCCESS (Rule 0). A folder the account cannot see, an empty
 * folder, or a share that was never granted all look the same from here — no files — and every
 * one of them means the PLAN phase has nothing to plan from. Exit 1 with the folder id in the
 * message, so the card blocks NAMING THE FOLDER rather than planning from an empty directory.
 *
 * Copied into the repo from the session scratchpad on 20 Sep 2026 (Plan A), where it pulled the
 * westpeek.ventures package by hand; `card kind: WEB_PROPERTY_CHANGE` uses it from
 * scripts/duties/web-property-change.mjs.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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

async function walk(token, id, dir, tally) {
  mkdirSync(dir, { recursive: true });
  let pageToken = "";
  do {
    const u = new URL("https://www.googleapis.com/drive/v3/files");
    u.searchParams.set("q", `'${id}' in parents and trashed=false`);
    u.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,size)");
    u.searchParams.set("supportsAllDrives", "true");
    u.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const r = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`list ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    pageToken = j.nextPageToken ?? "";
    for (const f of j.files ?? []) {
      if (f.mimeType === "application/vnd.google-apps.folder") {
        await walk(token, f.id, join(dir, safeName(f.name)), tally);
        continue;
      }
      let url;
      let name = safeName(f.name);
      if (EXPORT[f.mimeType]) {
        const [mt, ext] = EXPORT[f.mimeType];
        url = `https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=${encodeURIComponent(mt)}`;
        name += ext;
      } else if (f.mimeType.startsWith("application/vnd.google-apps")) {
        console.log(`SKIP ${dir}/${name} (${f.mimeType})`);
        tally.skipped += 1;
        continue;
      } else {
        url = `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&supportsAllDrives=true`;
      }
      const d = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!d.ok) {
        console.log(`FAIL ${dir}/${name} ${d.status}`);
        tally.failed += 1;
        continue;
      }
      writeFileSync(join(dir, name), Buffer.from(await d.arrayBuffer()));
      console.log(`${dir}/${name} (${f.size ?? "export"})`);
      tally.files += 1;
    }
  } while (pageToken);
}

/** Pull a folder. Resolves with the tally; REJECTS on zero files, naming the folder. */
export async function pullFolder(folderId, outDir, creds) {
  const tally = { files: 0, skipped: 0, failed: 0 };
  await walk(await accessToken(creds), folderId, outDir, tally);
  if (tally.files === 0) {
    throw new Error(
      `Drive folder ${folderId} yielded ZERO files (${tally.skipped} skipped, ${tally.failed} failed). ` +
        `Either it is empty, or ${SUBJECT} cannot see it — share it with that account, or send the right folder.`,
    );
  }
  return tally;
}

function selfTest() {
  const cases = [
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
      ok = fn() === true;
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
    selfTest();
  } else {
    const [rootArg, out] = process.argv.slice(2);
    const root = folderIdFrom(rootArg);
    if (!root || !out) {
      console.error("usage: node scripts/drive/pull.mjs <folder-id-or-link> <out-dir>");
      process.exit(2);
    }
    const creds = JSON.parse(process.env.GSC_SERVICE_ACCOUNT_JSON ?? "null");
    if (!creds) {
      console.error("No service account in the environment. Run under `node scripts/vault/vault.mjs run -- …` so GSC_SERVICE_ACCOUNT_JSON is injected.");
      process.exit(2);
    }
    pullFolder(root, out, creds)
      .then((t) => console.log(`PULLED ${t.files} file(s) from ${root} into ${out} (${t.skipped} skipped, ${t.failed} failed)`))
      .catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      });
  }
}
