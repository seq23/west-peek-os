#!/usr/bin/env node
/**
 * REMIND BOTH PARTNERS HOW A DECK ROUND STARTS, AS PRESTON, ON THE PROCESS NOTE'S OWN THREAD (19 Nov 2026).
 * Calls `POST /api/deck/process-reminder` as the Mac's own identity (src/worker/services/deckPreview.ts
 * sendProcessReminder). The Worker writes the words, sends to the two partners only, and refuses when the note
 * was never sent, a partner already answered, or a reminder went today.
 *
 *   npm run -s vault:run -- node scripts/ops/deck-process-reminder.mjs
 *
 * Exit 0 with a one-line JSON result; exit 1 with the refusal.
 */
const BASE_URL = process.env.WP_OS_BASE_URL ?? "https://os.joinwestpeek.com";
const id = process.env.WP_OS_MAC_ACCESS_CLIENT_ID;
const secret = process.env.WP_OS_MAC_ACCESS_CLIENT_SECRET;
if (!id || !secret) {
  console.error("WP_OS_MAC_ACCESS_CLIENT_ID / WP_OS_MAC_ACCESS_CLIENT_SECRET are not in the environment — run through `npm run -s vault:run -- node …`");
  process.exit(1);
}
const res = await fetch(`${BASE_URL}/api/deck/process-reminder`, {
  method: "POST",
  headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret, "content-type": "application/json" },
  body: "{}",
  signal: AbortSignal.timeout(60_000),
});
const out = await res.text();
if (!res.ok) {
  console.error(`REFUSED (${res.status}): ${out.slice(0, 600)}`);
  process.exit(1);
}
console.log(out.slice(0, 600));
