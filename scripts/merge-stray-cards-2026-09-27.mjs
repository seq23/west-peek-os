#!/usr/bin/env node
/**
 * Fold the four stray cards of 27 Sep 2026 into the one carrying the community-site work.
 *
 * WHAT HAPPENED. Two of Scooter's replies were too large for the reply matcher and opened new cards
 * instead of steering the one he was answering. By the afternoon the desk held five cards for one
 * job. The survivor is Porter's live WEB_PROPERTY_CHANGE card; the strays are the original
 * community-site card (BLOCKED on a preview of join-west-peek-main#21, which the survivor builds on
 * and supersedes; it holds the Sequoia→Scooter hand-off and her early notices), two Walker intakes
 * that already finished, and a Percy card cancelled by hand.
 *
 * IT DRIVES THE REAL API, NEVER SQL — the same `POST /api/work-cards/:id/merge-into` the "Merge
 * into…" button calls, so `services/mergeCards.ts` stays the one writer (migration 0242): the
 * inbound messages inm_03106e92… and inm_efb87c63… move with their Walker cards, the email threads
 * move so a late reply steers the survivor, the attachments move, the trail bullets and the event
 * are written, and nothing is emailed.
 *
 * IT IS IDEMPOTENT. A card already merged into the survivor is reported and skipped (the route
 * answers `already: true`); a re-run after a partial failure finishes the rest.
 *
 * Usage (production — run once, after the deploy that carries 0242):
 *   node scripts/merge-stray-cards-2026-09-27.mjs --base-url https://os.joinwestpeek.com \
 *     --access-token "$(cloudflared access token --app=https://os.joinwestpeek.com)"
 *   …add --dry-run to read the cards and print the plan without merging.
 * Locally: --base-url http://127.0.0.1:8787 --dev-user sequoia@westpeek.ventures
 */
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? true);
};
const DRY_RUN = args.includes("--dry-run");
const BASE_URL = String(flag("base-url", "http://127.0.0.1:8787")).replace(/\/$/, "");
const DEV_USER = flag("dev-user");
const ACCESS_TOKEN = flag("access-token");
if (!DEV_USER && !ACCESS_TOKEN) {
  console.error("Refusing to run: pass --dev-user (local) or --access-token (deployed; a partner's Access session).");
  process.exit(2);
}

const SURVIVOR = "wc_77f52b33-efb0-4e96-a293-49df8422018a";
const STRAYS = [
  { id: "wc_c9e36e8b-5450-45c1-ba83-06dff7542d2f", why: "the original community-site card; blocked on a preview of join-west-peek-main#21, which the survivor builds on and supersedes" },
  { id: "wc_8888da84-bed1-4c65-88b6-b156468165ef", why: "Walker intake opened by an oversize reply from Scooter; the reply belongs on the community-site card" },
  { id: "wc_c4671f50-d0e1-4c59-b7de-c46c8e2d2bfc", why: "Walker intake opened by an oversize reply from Scooter; the reply belongs on the community-site card" },
  { id: "wc_f24501cc-eee5-4d20-9eab-e077d4d8e48d", why: "Percy card opened by the same replies, already cancelled by hand" },
];
const REASON_PREFIX = "27 Sep 2026 stray cards (scripts/merge-stray-cards-2026-09-27.mjs)";

const headers = {
  "content-type": "application/json",
  ...(DEV_USER ? { "x-wpos-dev-user": String(DEV_USER) } : {}),
  ...(ACCESS_TOKEN ? { "cf-access-token": String(ACCESS_TOKEN) } : {}),
};

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 400) };
  }
  return { status: res.status, data };
}

async function main() {
  const survivor = await api("GET", `/api/work-cards/${SURVIVOR}`);
  if (survivor.status !== 200) throw new Error(`cannot read the survivor ${SURVIVOR}: ${survivor.status} ${JSON.stringify(survivor.data)}`);
  if (["DONE", "CANCELLED"].includes(survivor.data.state)) throw new Error(`the survivor is ${survivor.data.state}; a merge needs a card in flight`);
  console.log(`survivor: ${SURVIVOR} — "${survivor.data.title}" (${survivor.data.state})`);

  let merged = 0;
  let already = 0;
  let failed = 0;
  for (const stray of STRAYS) {
    const card = await api("GET", `/api/work-cards/${stray.id}`);
    if (card.status !== 200) {
      failed += 1;
      console.log(`  !  ${stray.id} — cannot read it (${card.status})`);
      continue;
    }
    if (card.data.merged_into_card_id === SURVIVOR) {
      already += 1;
      console.log(`  ·  ${stray.id} — already merged into the survivor`);
      continue;
    }
    if (card.data.merged_into_card_id) {
      failed += 1;
      console.log(`  !  ${stray.id} — merged into a different card (${card.data.merged_into_card_id}); left alone`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`  +  ${stray.id} — WOULD MERGE "${card.data.title}" (${card.data.state}) into the survivor`);
      continue;
    }
    const out = await api("POST", `/api/work-cards/${stray.id}/merge-into`, { into: SURVIVOR, reason: `${REASON_PREFIX}: ${stray.why}` });
    if (out.status !== 200) {
      failed += 1;
      console.log(`  !  ${stray.id} — refused (${out.status}): ${out.data?.detail ?? JSON.stringify(out.data)}`);
      continue;
    }
    if (out.data.already) {
      already += 1;
      console.log(`  ·  ${stray.id} — already merged into the survivor`);
      continue;
    }
    merged += 1;
    const m = out.data.moved ?? {};
    console.log(`  +  ${stray.id} — merged: ${m.messages ?? 0} email(s), ${m.threads ?? 0} thread(s), ${m.files ?? 0} file(s), ${m.runs_abandoned ?? 0} run(s) abandoned`);
  }
  console.log(`\n${DRY_RUN ? "dry run — " : ""}merged ${merged}, already ${already}, failed ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
