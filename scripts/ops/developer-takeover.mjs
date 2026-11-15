#!/usr/bin/env node
/**
 * TAKE A CARD OVER, OR HAND IT BACK, AS THE DEVELOPER'S PARTNER TAIL (15 Nov 2026; developerDirection.ts).
 *
 *   npm run -s vault:run -- node scripts/ops/developer-takeover.mjs take wc_… --why "what you are doing by hand"
 *   npm run -s vault:run -- node scripts/ops/developer-takeover.mjs hand-back wc_… --note "what was done" [--all-done] [--finished-at <ISO>] [--covers inm_…,inm_…]
 *     --covers: his emails from during the takeover that the developer's work already answers; they do not reopen the card
 *
 * Taken over: the card is held, says "A developer is doing this by hand", and nothing runs it; a partner's reply is
 * filed on it and acted on by nothing. Handed back: the note ("done by a developer on <day>, finished at <time>;
 * <employee>, take it from here") goes on the card; --all-done closes it when no reply came in meanwhile, otherwise
 * the employee carries on from the note. Calls the Worker as the Mac's own identity (vault). Exit 0 with the
 * route's JSON; exit 1 with its refusal.
 */
const BASE_URL = process.env.WP_OS_BASE_URL ?? "https://os.joinwestpeek.com";
const [which, cardId, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] ?? null : null;
};
function stop(msg) {
  console.error(msg);
  console.error('usage: developer-takeover.mjs take <wc_…> --why "…" | hand-back <wc_…> --note "…" [--all-done] [--finished-at <ISO>] [--covers inm_…,…]');
  process.exit(1);
}
if (!["take", "hand-back"].includes(which ?? "")) stop("the first argument is take or hand-back");
if (!cardId || !/^wc_[\w-]+$/.test(cardId)) stop("the second argument must be the work card id (wc_…)");
const id = process.env.WP_OS_MAC_ACCESS_CLIENT_ID;
const secret = process.env.WP_OS_MAC_ACCESS_CLIENT_SECRET;
if (!id || !secret) stop("WP_OS_MAC_ACCESS_CLIENT_ID / WP_OS_MAC_ACCESS_CLIENT_SECRET are not in the environment — run through `npm run -s vault:run -- node …`");
const body = which === "take"
  ? { why: opt("--why") ?? stop("--why is required") }
  : { note: opt("--note") ?? stop("--note is required"), all_done: rest.includes("--all-done"), finished_at: opt("--finished-at"), covers: (opt("--covers") ?? "").split(",").map((c) => c.trim()).filter(Boolean) };
const res = await fetch(`${BASE_URL}/api/work-cards/${cardId}/${which === "take" ? "developer-takeover" : "developer-hand-back"}`, {
  method: "POST",
  headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret, "content-type": "application/json" },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(60_000),
});
const text = await res.text();
if (!res.ok) {
  console.error(`REFUSED (${res.status}): ${text.slice(0, 600)}`);
  process.exit(1);
}
console.log(text.slice(0, 600));
