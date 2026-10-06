#!/usr/bin/env node
/**
 * push.mjs — share ONE file from Drive with a partner, as the firm's service account (0253).
 *
 *   node scripts/drive/push.mjs --file <path> --name <filename> --share <partner email>
 *   node scripts/drive/push.mjs --self-test
 *
 * THE OTHER HALF OF pull.mjs. A job may produce a file for the partner — an export, a QR sheet —
 * that is too large to attach to an email (the Worker caps a message's attachments at 10 MB). The
 * duty script calls this with the firm's Drive credential (the model never holds it): the file is
 * uploaded into a "West Peek OS — files" folder under the service account's delegated subject,
 * shared with the partner as reader, and the LINK is printed as one JSON line on stdout — the only
 * thing the caller reads. Any failure exits non-zero with one line; the duty records it on the
 * card and lists the file as "on the card" instead, so a refusal here is never a stop.
 *
 * Same credential and the same delegated subject as pull.mjs (GSC_SERVICE_ACCOUNT_JSON from the
 * vault, DRIVE_SUBJECT); a WIDER scope (`drive.file`: files this app created, nothing else). If the
 * delegation does not grant it yet, the token call says so and the duty falls back.
 *
 * PROVED 6 Oct 2026 by a read-only token request per scope: the delegation grants `drive.readonly`
 * and REFUSES `drive.file` and `drive` (`unauthorized_client`). So that refusal is a NAMED STOP, not
 * a bare 401: the script exits 3 with one line that names the scope, the service account's client
 * id and the exact place to add it (Workspace admin console → Security → Access and data control →
 * API controls → Domain-wide delegation). Only the Workspace super-admin can grant it; until then the
 * duty lists the file "on the card" and goes on.
 */
import { createReadStream, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

const SUBJECT = process.env.DRIVE_SUBJECT ?? "sequoia@westpeek.ventures";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME = "West Peek OS — files";

const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The flags, read strictly: a value is the next argument, never parsed out of a string. */
export function readArgs(argv) {
  const out = { file: null, name: null, share: null, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--self-test") out.selfTest = true;
    else if (a === "--file") out.file = argv[++i] ?? null;
    else if (a === "--name") out.name = argv[++i] ?? null;
    else if (a === "--share") out.share = argv[++i] ?? null;
  }
  return out;
}

/** The media type for a filename, by extension; octet-stream otherwise. */
export function mediaTypeFor(name) {
  const ext = String(name ?? "").toLowerCase().split(".").pop();
  return { csv: "text/csv", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", pdf: "application/pdf", json: "application/json", txt: "text/plain", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", zip: "application/zip", svg: "image/svg+xml", mp4: "video/mp4", mov: "video/quicktime" }[ext] ?? "application/octet-stream";
}

/** Only a partner's address is ever granted a share. */
export function shareableAddress(email) {
  const e = String(email ?? "").trim().toLowerCase();
  return /^[^\s@]+@(westpeek\.ventures|joinwestpeek\.com)$/.test(e) ? e : null;
}

async function accessToken(creds) {
  const { createSign } = await import("node:crypto");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: creds.client_email, sub: SUBJECT, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const s = createSign("RSA-SHA256");
  s.update(`${header}.${claims}`);
  const sig = b64url(s.sign(creds.private_key));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${sig}` }),
  });
  if (!res.ok) {
    const text = await res.text();
    const stop = scopeStop(res.status, text, creds.client_id);
    if (stop) throw Object.assign(new Error(stop), { named: true });
    throw new Error(`token ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()).access_token;
}

/** Exit code for the named stop: the delegation does not grant the scope. Distinct from 1 (any other failure). */
export const SCOPE_STOP_EXIT = 3;

/**
 * THE NAMED STOP when Google refuses the scope (`unauthorized_client` on the token call), or null.
 * Names the scope, the client id and where a super-admin adds it — the only thing that clears it.
 */
export function scopeStop(status, text, clientId) {
  if (!(status === 401 || status === 400) || !/unauthorized_client|not authorized for any of the scopes/i.test(String(text ?? ""))) return null;
  return `NAMED STOP — the Drive delegation does not grant ${SCOPE}. A Workspace super-admin adds it at admin.google.com → Security → Access and data control → API controls → Domain-wide delegation → client ${clientId ?? "(the gsc-bot service account)"} → Edit → add ${SCOPE} (keep drive.readonly). Until then the file is listed on the card instead of shared.`;
}

async function api(token, url, init = {}) {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function folderId(token) {
  const q = encodeURIComponent(`name = '${FOLDER_NAME.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const found = await api(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`);
  if (found.files?.[0]?.id) return found.files[0].id;
  const made = await api(token, "https://www.googleapis.com/drive/v3/files?fields=id", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }) });
  return made.id;
}

async function upload(token, parent, file, name) {
  const size = statSync(file).size;
  const meta = JSON.stringify({ name, parents: [parent] });
  const start = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8", "x-upload-content-type": mediaTypeFor(name), "x-upload-content-length": String(size) },
    body: meta,
  });
  if (!start.ok) throw new Error(`upload start ${start.status}: ${(await start.text()).slice(0, 300)}`);
  const session = start.headers.get("location");
  if (!session) throw new Error("upload start returned no session");
  const put = await fetch(session, { method: "PUT", headers: { "content-type": mediaTypeFor(name), "content-length": String(size) }, body: createReadStream(file), duplex: "half" });
  if (!put.ok) throw new Error(`upload ${put.status}: ${(await put.text()).slice(0, 300)}`);
  return put.json();
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();
  if (!args.file) throw new Error("usage: push.mjs --file <path> [--name <filename>] --share <partner email>");
  const share = shareableAddress(args.share);
  if (!share) throw new Error("--share must be a partner address (westpeek.ventures / joinwestpeek.com)");
  const raw = process.env.GSC_SERVICE_ACCOUNT_JSON ?? process.env.WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GSC_SERVICE_ACCOUNT_JSON is not in the environment (run under vault.mjs run)");
  const creds = JSON.parse(raw);
  const name = args.name ?? basename(args.file);
  const token = await accessToken(creds);
  const parent = await folderId(token);
  const made = await upload(token, parent, args.file, name);
  await api(token, `https://www.googleapis.com/drive/v3/files/${made.id}/permissions?sendNotificationEmail=false`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "reader", type: "user", emailAddress: share }) });
  const url = made.webViewLink ?? `https://drive.google.com/file/d/${made.id}/view`;
  process.stdout.write(`${JSON.stringify({ id: made.id, url, name, shared_with: share })}\n`);
}

function selfTest() {
  const checks = [
    ["flags are read strictly", () => { const a = readArgs(["--file", "/x/y.csv", "--name", "out.csv", "--share", "scooter@westpeek.ventures"]); return a.file === "/x/y.csv" && a.name === "out.csv" && a.share === "scooter@westpeek.ventures" && !a.selfTest; }],
    ["only a partner address is shareable", () => shareableAddress("Scooter@westpeek.ventures") === "scooter@westpeek.ventures" && shareableAddress("someone@gmail.com") === null && shareableAddress("") === null],
    ["a media type comes from the extension", () => mediaTypeFor("a.CSV") === "text/csv" && mediaTypeFor("x.png") === "image/png" && mediaTypeFor("blob") === "application/octet-stream"],
    ["the scope is drive.file, nothing wider", () => SCOPE === "https://www.googleapis.com/auth/drive.file"],
    ["an unauthorized_client token refusal is the NAMED STOP naming the scope, the client and the console", () => { const t = scopeStop(401, '{"error":"unauthorized_client","error_description":"Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested."}', "123"); return /^NAMED STOP/.test(t) && t.includes(SCOPE) && t.includes("client 123") && t.includes("Domain-wide delegation"); }],
    ["any other token failure is not dressed up as the named stop", () => scopeStop(500, "boom", "1") === null && scopeStop(401, '{"error":"invalid_grant"}', "1") === null],
    ["the source never prints the credential", () => !/console\.log\([^)]*(creds|private_key|GSC_)/.test(readFileSync(new URL(import.meta.url), "utf8"))],
  ];
  let failed = 0;
  for (const [name, fn] of checks) {
    let ok = false;
    try { ok = Boolean(fn()); } catch { ok = false; }
    console.log(`${ok ? "ok" : "FAIL"} · ${name}`);
    if (!ok) failed += 1;
  }
  if (failed) { console.error(`push.mjs self-test: ${failed} failed`); process.exit(1); }
  console.log(`push.mjs self-test: ${checks.length} checks passed`);
}

main().catch((err) => {
  console.error(`push.mjs: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(err?.named ? SCOPE_STOP_EXIT : 1);
});
