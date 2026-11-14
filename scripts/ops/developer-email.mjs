#!/usr/bin/env node
/**
 * SEND THE DEVELOPER'S EXACT EMAIL TO THE PARTNER WHO ASKED FOR A WEBSITE JOB, AS PORTER, ON THE JOB'S THREAD
 * (14 Nov 2026). Calls `POST /api/work-cards/<id>/developer-email` as the Mac's own identity
 * (src/worker/services/developerDirection.ts). The file is "Subject: …" (other header lines ignored), a blank
 * line, then the body sent exactly. The Worker sends to the one partner who asked and nobody else.
 *
 *   npm run -s vault:run -- node scripts/ops/developer-email.mjs wc_… --file <path>
 *
 * Exit 0 with a one-line JSON result; exit 1 with the refusal.
 */
import { readFileSync } from "node:fs";

const BASE_URL = process.env.WP_OS_BASE_URL ?? "https://os.joinwestpeek.com";
const [cardId, flag, file] = process.argv.slice(2);
function stop(msg) {
  console.error(msg);
  console.error("usage: node scripts/ops/developer-email.mjs <wc_…> --file <path>");
  process.exit(1);
}
if (!cardId || !/^wc_[\w-]+$/.test(cardId)) stop("the first argument must be the work card id (wc_…)");
if (flag !== "--file" || !file) stop("--file is required");
const raw = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const split = raw.indexOf("\n\n");
if (split < 0) stop("the file needs header lines, a blank line, then the body");
const subject = (/^Subject:\s*(.+)$/m.exec(raw.slice(0, split)) ?? [])[1]?.trim();
const text = raw.slice(split + 2).trim();
if (!subject || !text) stop("the file needs a Subject: line and a body");
const id = process.env.WP_OS_MAC_ACCESS_CLIENT_ID;
const secret = process.env.WP_OS_MAC_ACCESS_CLIENT_SECRET;
if (!id || !secret) stop("WP_OS_MAC_ACCESS_CLIENT_ID / WP_OS_MAC_ACCESS_CLIENT_SECRET are not in the environment — run through `npm run -s vault:run -- node …`");
const res = await fetch(`${BASE_URL}/api/work-cards/${cardId}/developer-email`, {
  method: "POST",
  headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret, "content-type": "application/json" },
  body: JSON.stringify({ subject, text }),
  signal: AbortSignal.timeout(60_000),
});
const out = await res.text();
if (!res.ok) {
  console.error(`REFUSED (${res.status}): ${out.slice(0, 600)}`);
  process.exit(1);
}
console.log(out.slice(0, 600));
