#!/usr/bin/env node
/**
 * "<EMPLOYEE>, TELL <PARTNER>: <WHAT TO SAY>" FROM THE MAC (20 Nov 2026, her words: "i should be able to tell u to tell
 * wesley to message a partner!!!!"). Opens the EXISTING PARTNER_MESSAGE card through `POST /api/work-cards` as the Mac's
 * own identity (the claimer's Access service token, from the vault, never a command line). The Worker reads the sentence
 * with the same `parsePartnerMessageAsk` an email to os@ goes through, so the words mean exactly what they mean there;
 * the employee composes it and the OS sends it to that partner (or, for "tell both", to one with the other copied), as it does for the email door. A job the Mac opens
 * is asked for by the partner it acts for (the developer), so the message says who asked.
 *
 *   npm run -s vault:run -- node scripts/ops/tell-partner.mjs "Wesley, tell Scooter: the DDQ is ready for Monday"
 *   npm run -s vault:run -- node scripts/ops/tell-partner.mjs "Wesley, tell Scooter: …" --card wc_…   (on that job's thread)
 *   npm run -s vault:run -- node scripts/ops/tell-partner.mjs "…" --private                          (Claude only)
 *   npm run -s vault:run -- node scripts/ops/tell-partner.mjs "Preston, tell both: …" --card wc_…   (both partners, one email; 24 Nov 2026)
 *
 * Prints the card id at once, then waits (up to 15 minutes) for the sweep to send it and prints the subject.
 * Exit 0 when sent; 1 on a refusal or a card that ended without sending; 2 when the wait ran out (the card still runs).
 */

const BASE_URL = process.env.WP_OS_BASE_URL ?? "https://os.joinwestpeek.com";
const WAIT_MS = 15 * 60_000;

/** The create request for one sentence. Pure; the test compares it with the email door's card. */
export function tellPartnerRequest(sentence, { cardId = null, privateOnly = false } = {}) {
  const words = String(sentence ?? "").trim();
  return {
    title: words.slice(0, 90) || "Partner message",
    partner_message: words,
    ...(cardId ? { from_card_id: cardId } : {}),
    ...(privateOnly ? { model_access: "PRIVATE_MODEL_ONLY" } : {}),
  };
}

function readArgv(argv) {
  const out = { sentence: null, cardId: null, privateOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--card") out.cardId = argv[++i] ?? null;
    else if (a === "--private") out.privateOnly = true;
    else if (out.sentence === null) out.sentence = a;
  }
  return out;
}

async function main() {
  const args = readArgv(process.argv.slice(2));
  const stop = (msg, code = 1) => {
    console.error(msg);
    console.error('usage: node scripts/ops/tell-partner.mjs "<Employee>, tell <Partner>: <what to say>" [--card wc_…] [--private]');
    process.exit(code);
  };
  if (!args.sentence) stop("the sentence is required");
  if (args.cardId && !/^wc_[\w-]+$/.test(args.cardId)) stop("--card must be a work card id (wc_…)");
  const id = process.env.WP_OS_MAC_ACCESS_CLIENT_ID;
  const secret = process.env.WP_OS_MAC_ACCESS_CLIENT_SECRET;
  if (!id || !secret) stop("WP_OS_MAC_ACCESS_CLIENT_ID / WP_OS_MAC_ACCESS_CLIENT_SECRET are not in the environment — run through `npm run -s vault:run -- node …`");
  const headers = { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret, "content-type": "application/json" };

  const res = await fetch(`${BASE_URL}/api/work-cards`, { method: "POST", headers, body: JSON.stringify(tellPartnerRequest(args.sentence, args)), signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  if (!res.ok) stop(`REFUSED (${res.status}): ${text.slice(0, 600)}`);
  const card = JSON.parse(text);
  console.log(JSON.stringify({ card_id: card.id, title: card.title, to: card.result_recipient }));

  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 30_000));
    const c = await (await fetch(`${BASE_URL}/api/work-cards/${card.id}`, { headers, signal: AbortSignal.timeout(60_000) })).json().catch(() => ({}));
    if (c.state === "DONE") {
      // The partner message's own email is filed under the employee's name with the card title as its subject.
      console.log(JSON.stringify({ card_id: card.id, state: "DONE", subject: `${c.owner_name ?? "?"}: ${c.title}`, to: c.result_recipient }));
      return;
    }
    if (["CANCELLED", "BLOCKED"].includes(c.state)) stop(`the card ended ${c.state} without sending: ${String(c.block_reason ?? c.next_action ?? "").slice(0, 300)}`);
  }
  stop(`still running after ${WAIT_MS / 60_000} minutes: card ${card.id}`, 2);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
