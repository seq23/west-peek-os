#!/usr/bin/env node
/**
 * SEED OR EDIT A PARTNER'S PROFILE (0255; owner, 9 Oct 2026).
 *
 * A partner profile lives in D1 only — NEVER in this repo, which is public. So the words for a seed
 * live in a JSON file OUTSIDE the repo, and this script sends them to `POST /api/partner-profiles/:email`
 * as the Mac's own identity (the claimer's Access service token, from the vault — never a command line):
 *
 *   npm run -s vault:run -- node scripts/ops/seed-partner-profile.mjs scooter@westpeek.ventures ~/somewhere/scooter-profile.json
 *
 * The JSON: { "who": "…", "writes_like": "…", "usually_asks": "…",
 *             "aliases": [{ "host": "voting.topbarz.xyz", "words": ["top barz", "culturecon"] }],
 *             "notes": ["…"], "working_on": [{ "body": "…", "at": "2026-10-09" }] }
 *
 * The route runs every line through the profile filter (no LP names, deal terms or fund details) and
 * answers with what it refused and the block a job prompt will carry. Exit 0 with that JSON; exit 1
 * with the route's refusal. Refuses a file inside the repo, so a profile can never be committed by
 * accident.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.WP_OS_BASE_URL ?? "https://os.joinwestpeek.com";
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function usage(msg) {
  console.error(msg);
  console.error("usage: node scripts/ops/seed-partner-profile.mjs <partner email> <profile.json outside the repo>");
  process.exit(1);
}

const [email, file] = process.argv.slice(2);
if (!email || !/@/.test(email)) usage("the first argument is the partner's email address");
if (!file) usage("the second argument is the profile JSON file");
const abs = path.resolve(file);
if (abs.startsWith(path.resolve(REPO_ROOT) + path.sep)) usage(`refused: ${file} is inside the repo — a partner profile never lives in the repo (it is public)`);
let body;
try {
  body = JSON.parse(readFileSync(abs, "utf8"));
} catch (err) {
  usage(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
}

const id = process.env.WP_OS_MAC_ACCESS_CLIENT_ID;
const secret = process.env.WP_OS_MAC_ACCESS_CLIENT_SECRET;
if (!id || !secret) usage("WP_OS_MAC_ACCESS_CLIENT_ID / WP_OS_MAC_ACCESS_CLIENT_SECRET are not in the environment — run through `npm run -s vault:run -- node …`");

const res = await fetch(`${BASE_URL}/api/partner-profiles/${encodeURIComponent(email.trim().toLowerCase())}`, {
  method: "POST",
  headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret, "content-type": "application/json" },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(60_000),
});
const text = await res.text();
let parsed = null;
try {
  parsed = JSON.parse(text);
} catch {
  /* reported below */
}
console.log(JSON.stringify({ status: res.status, ...(parsed ?? { raw: text.slice(0, 300) }) }));
process.exit(res.ok ? 0 : 1);
