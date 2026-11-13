#!/usr/bin/env node
/**
 * ENTER THE DEVELOPER'S WORK INSTRUCTION ON A WEBSITE JOB, AS HER PARTNER TAIL (13 Nov 2026, #363, 0301).
 *
 * When the developer tells her partner tail what a job should do, the tail enters it here. Calls
 * `POST /api/work-cards/<id>/developer-changes` as the Mac's own identity (the claimer's Access
 * service token, from the vault, never a command line). The Worker records it as "<developer>
 * (developer), through the partner tail (Claude)" with the words and the time, and refuses anything
 * that reads as an approval, a publish, a preview request or a force
 * (src/worker/services/developerDirection.ts). The job must be waiting at its preview.
 *
 *   npm run -s vault:run -- node scripts/ops/developer-changes.mjs wc_… --changes "what to build or change"
 *   (or --changes-file <path>)
 *
 * Exit 0 with a one-line JSON result; exit 1 with the route's refusal.
 */
import { readFileSync } from "node:fs";

const BASE_URL = process.env.WP_OS_BASE_URL ?? "https://os.joinwestpeek.com";
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};
function stop(msg) {
  console.error(msg);
  console.error('usage: node scripts/ops/developer-changes.mjs <wc_…> (--changes "…" | --changes-file <path>)');
  process.exit(1);
}
const cardId = args[0];
if (!cardId || !/^wc_[\w-]+$/.test(cardId)) stop("the first argument must be the work card id (wc_…)");
const file = opt("--changes-file");
const changes = file ? readFileSync(file, "utf8").trim() : opt("--changes");
if (!changes) stop("--changes or --changes-file is required");
// NEVER CF_ACCESS_CLIENT_ID: that token is the browser agent and is refused on this route.
const id = process.env.WP_OS_MAC_ACCESS_CLIENT_ID;
const secret = process.env.WP_OS_MAC_ACCESS_CLIENT_SECRET;
if (!id || !secret) stop("WP_OS_MAC_ACCESS_CLIENT_ID / WP_OS_MAC_ACCESS_CLIENT_SECRET are not in the environment — run through `npm run -s vault:run -- node …`");

const res = await fetch(`${BASE_URL}/api/work-cards/${cardId}/developer-changes`, {
  method: "POST",
  headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret, "content-type": "application/json" },
  body: JSON.stringify({ changes }),
  signal: AbortSignal.timeout(60_000),
});
const text = await res.text();
if (!res.ok) {
  console.error(`REFUSED (${res.status}): ${text.slice(0, 600)}`);
  process.exit(1);
}
console.log(text.slice(0, 600));
