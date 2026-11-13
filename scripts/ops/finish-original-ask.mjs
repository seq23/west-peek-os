#!/usr/bin/env node
/**
 * REOPEN A WEBSITE JOB TO FINISH PART OF THE ORIGINAL REQUEST IT LEFT OUT (13 Nov 2026, #363).
 *
 * Calls `POST /api/work-cards/<id>/finish-original-ask` as the Mac's own identity (the claimer's
 * Access service token, from the vault, never a command line). The Worker checks that the ask is in
 * the partner's stored request, refuses anything that reads as an approval, publish or force, and
 * records the reopening as the system (`finishOriginalAsk` in src/worker/services/webPropertyChange.ts).
 * The job rebuilds in the same preview; the fresh preview waits for the partner who asked.
 *
 *   npm run -s vault:run -- node scripts/ops/finish-original-ask.mjs wc_… --ask "the partner's own words" --instruction "what to build"
 *   (or --instruction-file <path>, for long instructions kept out of the shell history)
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
  console.error('usage: node scripts/ops/finish-original-ask.mjs <wc_…> --ask "…" (--instruction "…" | --instruction-file <path>)');
  process.exit(1);
}
const cardId = args[0];
if (!cardId || !/^wc_[\w-]+$/.test(cardId)) stop("the first argument must be the work card id (wc_…)");
const ask = opt("--ask");
const file = opt("--instruction-file");
const instruction = file ? readFileSync(file, "utf8").trim() : opt("--instruction");
if (!ask || !instruction) stop("--ask and an instruction are both required");
// NEVER CF_ACCESS_CLIENT_ID: that token is the browser agent and is refused on this route.
const id = process.env.WP_OS_MAC_ACCESS_CLIENT_ID;
const secret = process.env.WP_OS_MAC_ACCESS_CLIENT_SECRET;
if (!id || !secret) stop("WP_OS_MAC_ACCESS_CLIENT_ID / WP_OS_MAC_ACCESS_CLIENT_SECRET are not in the environment — run through `npm run -s vault:run -- node …`");

const res = await fetch(`${BASE_URL}/api/work-cards/${cardId}/finish-original-ask`, {
  method: "POST",
  headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret, "content-type": "application/json" },
  body: JSON.stringify({ ask, instruction }),
  signal: AbortSignal.timeout(60_000),
});
const text = await res.text();
if (!res.ok) {
  console.error(`REFUSED (${res.status}): ${text.slice(0, 600)}`);
  process.exit(1);
}
console.log(text.slice(0, 600));
