#!/usr/bin/env node
/**
 * Fold the four stray cards of 28 Sep 2026 into the one carrying the community-site work.
 *
 * WHAT HAPPENED. Overnight Scooter sent five emails about the community site, each under its own
 * subject. The door read each as a new assignment (fixed the same day: a partner's new email about
 * an open site job is now a follow-up on that job — `openSiteCardFor` in services/emailThread.ts,
 * pinned by tests/followUpJoinsTheOpenSiteCard.test.ts). Meanwhile her Mac's lid was closed, the
 * claimer took each plan in a five-second wake and the Mac slept again; every run went quiet, every
 * "attempt" was spent, and all five cards blocked on her with "tried and could not finish" (also
 * fixed the same day: a nap is not an attempt — services/../subscriptionSeats.ts).
 *
 * The survivor is Porter's live WEB_PROPERTY_CHANGE card for the community site (PR
 * join-west-peek-main#24). The strays are three Porter cards the door opened for his three
 * follow-up emails, and one Percy card Walker opened for the fourth.
 *
 * IT DRIVES THE REAL API, NEVER SQL — the same `POST /api/work-cards/:id/merge-into` the "Merge
 * into…" button calls (migration 0242), so the inbound messages, threads, attachments, trail and
 * event all move the one way they always do, and nothing is emailed. Then the survivor's spent
 * attempts are forgiven through the same door a partner's answer uses (`POST …/unblock`, ANSWER),
 * with the sentence below as the answer, so the record says why.
 *
 * IT IS IDEMPOTENT. A card already merged is reported and skipped; a survivor already OPEN is left.
 *
 * Usage (production — run once, after the deploy that carries the two fixes):
 *   node scripts/merge-stray-cards-2026-09-28.mjs --base-url https://os.joinwestpeek.com \
 *     --access-token "$(cloudflared access token --app=https://os.joinwestpeek.com)"
 *   …add --dry-run to read the cards and print the plan without changing anything.
 *   …add --no-unblock to merge only (when the survivor's build is being finished by hand).
 * Locally: --base-url http://127.0.0.1:8787 --dev-user sequoia@westpeek.ventures
 */
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? true);
};
const DRY_RUN = args.includes("--dry-run");
const NO_UNBLOCK = args.includes("--no-unblock");
const BASE_URL = String(flag("base-url", "http://127.0.0.1:8787")).replace(/\/$/, "");
const DEV_USER = flag("dev-user");
const ACCESS_TOKEN = flag("access-token");
if (!DEV_USER && !ACCESS_TOKEN) {
  console.error("Refusing to run: pass --dev-user (local) or --access-token (deployed; a partner's Access session).");
  process.exit(2);
}

const SURVIVOR = "wc_77f52b33-efb0-4e96-a293-49df8422018a";
const STRAYS = [
  { id: "wc_3cc510cf-e548-4955-be8f-822163226777", why: "Porter card the door opened for Scooter's 'Friends-testing link + animated hero + flyer fade fix' email; a follow-up on the community-site job" },
  { id: "wc_94240792-8462-4cb7-82aa-7e438bb66bea", why: "Porter card the door opened for Scooter's 'Names missing on the HBCU flyers' email; a follow-up on the community-site job" },
  { id: "wc_1366cbaf-d81b-40ba-9d54-ab95c0ee9316", why: "Porter card the door opened for Scooter's 'Update form is broken + site fixes' email (Carlos photo attached); a follow-up on the community-site job" },
  { id: "wc_9d99e053-705c-4836-a732-ad5eafbc4846", why: "Percy card Walker opened for Scooter's 'Two more - remove my email, fix the Past Winners heading' email; a follow-up on the community-site job, which is Porter's" },
];
const REASON_PREFIX = "28 Sep 2026 stray cards (scripts/merge-stray-cards-2026-09-28.mjs)";
const ANSWER =
  "Taken over by Sequoia's session, 28 Sep 2026. The three failed attempts were the Mac asleep with its lid closed, not the work: " +
  "the claimer took each run in a five-second wake and the Mac slept again. Fixed at the source the same day (a nap is not an attempt; " +
  "a partner's new email about an open site job joins that job). The four follow-up emails are folded into this card; build everything they ask on this card's branch (PR join-west-peek-main#24).";

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
  console.log(`survivor: ${SURVIVOR} — "${survivor.data.title}" (${survivor.data.state}, attempts ${survivor.data.work_attempts ?? "?"})`);

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

  // The survivor's spent attempts are forgiven the way a partner's answer forgives them.
  if (!NO_UNBLOCK && !DRY_RUN && survivor.data.state === "BLOCKED") {
    const out = await api("POST", `/api/work-cards/${SURVIVOR}/unblock`, { action: "ANSWER", text: ANSWER });
    if (out.status !== 200) {
      failed += 1;
      console.log(`  !  survivor — unblock refused (${out.status}): ${out.data?.detail ?? out.data?.said ?? JSON.stringify(out.data)}`);
    } else {
      console.log(`  +  survivor — ${out.data.said ?? "re-opened"} (state ${out.data.state ?? "?"})`);
    }
  } else if (survivor.data.state === "BLOCKED") {
    console.log(`  ·  survivor — BLOCKED (${survivor.data.block_reason ?? "?"}); ${DRY_RUN ? "would be" : "not"} re-opened${NO_UNBLOCK ? " (--no-unblock)" : ""}`);
  }

  console.log(`\n${DRY_RUN ? "dry run — " : ""}merged ${merged}, already ${already}, failed ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
