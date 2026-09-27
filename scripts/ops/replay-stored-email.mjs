#!/usr/bin/env node
/**
 * REPLAY A STORED INBOUND EMAIL THROUGH THE DOOR (27 Sep 2026).
 *
 * Every message that reaches os@joinwestpeek.com is kept in R2 (`inbound-email/<day>/<uuid>.eml`,
 * indexed in `inbound_message`). When the door mis-read one — the day this was written, two of
 * Scooter's oversize replies opened new cards instead of steering the card they answered — the fix
 * is landed and then the SAME bytes are read again through the fixed door, by this script, so the
 * correction is recorded (an `inbound_email.reingested` event names the key, what was superseded and
 * what the read produced) rather than done by a hand query.
 *
 * It calls `POST /api/inbound-email/reingest` as the Mac's own identity (the claimer's Access
 * service token — the same one `scripts/claimer/local-job-claimer.mjs` uses, which that route admits).
 * The token comes from the vault, never from a command line:
 *
 *   npm run -s vault:run -- node scripts/ops/replay-stored-email.mjs inbound-email/2026-09-27/4927cc15-8fbb-4bed-8658-c995ec389b6a.eml
 *
 * Options: `--tldr "…"` puts those words first in the RECEIVED email if the read opens a NEW card;
 * `--on-thread wpt_…` threads that RECEIVED under an earlier note. Neither applies when the message
 * is a reply that steers an existing card (the route says so in its answer).
 *
 * Exit 0 with a one-line JSON result; exit 1 with the route's refusal. Nothing is printed that is
 * not already on the card.
 */
import { hostname } from "node:os";

const BASE_URL = process.env.WP_OS_BASE_URL ?? "https://os.joinwestpeek.com";

function accessHeaders() {
  // NEVER CF_ACCESS_CLIENT_ID: that token is the browser agent and is refused on this route.
  const id = process.env.WP_OS_MAC_ACCESS_CLIENT_ID;
  const secret = process.env.WP_OS_MAC_ACCESS_CLIENT_SECRET;
  if (!id || !secret) return null;
  return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret, "content-type": "application/json" };
}

function usage(msg) {
  console.error(msg);
  console.error("usage: node scripts/ops/replay-stored-email.mjs <inbound-email/…/….eml> [--tldr \"…\"] [--on-thread wpt_…]");
  process.exit(1);
}

const args = process.argv.slice(2);
const key = args.find((a) => !a.startsWith("--"));
if (!key || !/^inbound-email\/[\w./-]+\.eml$/.test(key)) usage("the first argument must be the stored object key (inbound-email/<day>/<uuid>.eml)");
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const body = { object_key: key };
const tldr = opt("--tldr");
if (tldr) body.received_tldr = tldr;
const onThread = opt("--on-thread");
if (onThread) body.reply_on_thread = onThread;

const headers = accessHeaders();
if (!headers) usage("WP_OS_MAC_ACCESS_CLIENT_ID / WP_OS_MAC_ACCESS_CLIENT_SECRET are not in the environment — run through `npm run -s vault:run -- node …`");

const res = await fetch(`${BASE_URL}/api/inbound-email/reingest`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
const text = await res.text();
let parsed = null;
try {
  parsed = JSON.parse(text);
} catch {
  /* reported by status below */
}
const out = { status: res.status, from: `${hostname()}`, key, ...(parsed ?? { raw: text.slice(0, 300) }) };
console.log(JSON.stringify(out));
process.exit(res.ok ? 0 : 1);
