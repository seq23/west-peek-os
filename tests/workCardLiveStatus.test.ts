import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { FirmUserIdentity } from "../src/worker/auth";
import { createWorkCardInternal, handleGetWorkCard, handleWorkByOwner } from "../src/worker/services/workCards";
import { RUN_FRESH_MS, deskSummary, firstSentence, liveStatus, plainFailure, sentenceCase, siteWait, type LiveStatusInput } from "../src/shared/work/liveStatus";
import { plainTitle, shortAsk, siteStage } from "../src/shared/work/siteChange";
import { cardTimeline, trailSentence } from "../src/shared/work/cardTimeline";
import { askedBy } from "../src/shared/work/origin";
import { handleGetWebPropertyChange } from "../src/worker/services/webPropertyChange";
import { APPROVED_REPLY, CHANGES_REPLY_PREFIX, MATERIALS_ADDED_PHRASE, PUBLISH_REPLY } from "../src/shared/work/previewReplies";
import { readApprovalReply } from "../src/shared/work/approvalReply";

/**
 * THE WORK-CARD REDESIGN (23 Sep 2026), HELD TO ITS WORDS.
 *
 * Her approval: "it should be truly collapsed with only the title and in progress and the necessary
 * things showing". "In progress" is `liveStatus`, the one reader the desk row, the expanded card and
 * the card's own page all call. The pin that matters most is the negative one: "Working now" is
 * NEVER said unless a machine is holding the card this minute — a stale claim, a queued run, a card
 * between tries each say something else.
 */

const ME = "fu_sequoia_taylor";
const NOW = new Date("2026-09-23T17:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const ahead = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const porter = (over: Partial<LiveStatusInput> = {}): LiveStatusInput => ({
  state: "IN_PROGRESS",
  owner_type: "AI",
  owner_id: "aie_porter",
  owner_name: "Porter",
  work_attempts: 1,
  ...over,
});

describe("liveStatus — one reader, every state", () => {
  it("WORKING_NOW only for a CLAIMED run that pinged inside RUN_FRESH_MS, and it pulses", () => {
    const s = liveStatus(porter({ current_run: { status: "CLAIMED", claimed_at: ago(4 * 60_000), progressed_at: ago(20_000), progress_note: "reading the folder's docs" } }), ME, NOW);
    expect(s.kind).toBe("WORKING_NOW");
    expect(s.live).toBe(true);
    expect(s.pill).toBe("Working now");
    expect(s.line).toBe("Porter is working on your Mac: reading the folder's docs · 4 min");
    expect(s.section).toBe("worked");
  });

  it("a CLAIMED run that has gone quiet past RUN_FRESH_MS is WAITING, never Working now", () => {
    const s = liveStatus(porter({ current_run: { status: "CLAIMED", claimed_at: ago(20 * 60_000), progressed_at: ago(RUN_FRESH_MS + 1_000) } }), ME, NOW);
    expect(s.kind).toBe("WAITING");
    expect(s.live).toBe(false);
    expect(s.pill).toBe("Waiting");
    expect(s.line).toMatch(/went quiet/);
  });

  it("a CLAIMED run with no ping at all falls back to its claim time", () => {
    expect(liveStatus(porter({ current_run: { status: "CLAIMED", claimed_at: ago(60_000), progressed_at: null } }), ME, NOW).kind).toBe("WORKING_NOW");
    expect(liveStatus(porter({ current_run: { status: "CLAIMED", claimed_at: null, progressed_at: null } }), ME, NOW).kind).toBe("WAITING");
  });

  it("a QUEUED run is 'Queued for your Mac', with how long", () => {
    const s = liveStatus(porter({ current_run: { status: "QUEUED", created_at: ago(7 * 60_000) } }), ME, NOW);
    expect(s.kind).toBe("QUEUED");
    expect(s.live).toBe(false);
    expect(s.line).toBe("Queued for your Mac · waiting 7 min");
  });

  it("the sweep's live lease is WORKING_NOW; an expired lease is not", () => {
    expect(liveStatus(porter({ lease_until: ahead(60_000) }), ME, NOW).kind).toBe("WORKING_NOW");
    const expired = liveStatus(porter({ lease_until: ago(1_000), work_attempts: 2 }), ME, NOW);
    expect(expired.kind).toBe("WAITING");
    expect(expired.line).toBe("Next try within 5 min · try 2 of 3 so far");
  });

  it("a failing card says WAITING with the next try and the failure, and is marked failing", () => {
    const s = liveStatus(porter({ work_last_failure: "The run stalled on our side. Details follow." }), ME, NOW);
    expect(s.kind).toBe("WAITING");
    expect(s.failing).toBe(true);
    expect(s.line).toBe("Next try within 5 min · the last try failed: The run stalled on our side");
  });

  it("an untouched employee card is QUEUED for the sweep", () => {
    const s = liveStatus(porter({ state: "OPEN", work_attempts: 0 }), ME, NOW);
    expect(s.kind).toBe("QUEUED");
    expect(s.line).toBe("Queued · picked up within 5 min");
  });

  it("BLOCKED needs her, with the first sentence of what would clear it", () => {
    const s = liveStatus(porter({ state: "BLOCKED", block: { needed: "Tell Pierce which figure is right. Then he carries on.", stopped: "x", who: "SEQUOIA" } }), ME, NOW);
    expect(s).toMatchObject({ kind: "NEEDS_YOU", section: "needs", pill: "Needs you", line: "Needs you: Tell Pierce which figure is right", live: false });
    expect(liveStatus(porter({ state: "BLOCKED", block: { needed: "Fix the lane", who: "ENGINEER" } }), ME, NOW).line).toBe("Needs an engineer: Fix the lane");
  });

  it("a blocked card is never Working now, even with a fresh run beside it", () => {
    const s = liveStatus(porter({ state: "BLOCKED", block: { needed: "Answer" }, current_run: { status: "CLAIMED", claimed_at: ago(1_000), progressed_at: ago(1_000) } }), ME, NOW);
    expect(s.kind).toBe("NEEDS_YOU");
  });

  it("HELD, unowned, hers, her partner's, done and stopped", () => {
    expect(liveStatus(porter({ state: "HELD", held_by_name: "Sequoia Taylor", held_reason: "Big job" }), ME, NOW)).toMatchObject({ kind: "HELD", section: "needs", line: "Sequoia put this on hold: Big job. Nothing works it until it is released." });
    expect(liveStatus({ state: "OPEN", owner_type: "UNASSIGNED", owner_id: null }, ME, NOW)).toMatchObject({ kind: "NEEDS_YOU", section: "needs" });
    expect(liveStatus({ state: "OPEN", owner_type: "HUMAN", owner_id: ME, next_action: "Call Dan." }, ME, NOW)).toMatchObject({ kind: "NEEDS_YOU", pill: "Yours", line: "Yours to do: Call Dan" });
    expect(liveStatus({ state: "OPEN", owner_type: "HUMAN", owner_id: "fu_scooter_taylor", owner_name: "Scooter Taylor" }, ME, NOW)).toMatchObject({ kind: "WITH_PARTNER", section: "worked", pill: "With Scooter" });
    expect(liveStatus(porter({ state: "DONE" }), ME, NOW)).toMatchObject({ kind: "DONE", section: "finished" });
    expect(liveStatus(porter({ state: "CANCELLED" }), ME, NOW)).toMatchObject({ kind: "STOPPED", section: "finished" });
  });

  it("live is true for WORKING_NOW and for nothing else, across every state", () => {
    const inputs: LiveStatusInput[] = [
      porter({ current_run: { status: "CLAIMED", claimed_at: ago(1_000), progressed_at: ago(1_000) } }),
      porter({ lease_until: ahead(1_000) }),
      porter({ current_run: { status: "QUEUED", created_at: ago(1_000) } }),
      porter({ current_run: { status: "CLAIMED", claimed_at: ago(RUN_FRESH_MS * 3), progressed_at: ago(RUN_FRESH_MS * 2) } }),
      porter({ state: "OPEN", work_attempts: 0 }),
      porter({ work_last_failure: "boom" }),
      porter({ state: "BLOCKED", block: { needed: "x" } }),
      porter({ state: "HELD" }),
      porter({ state: "DONE" }),
      porter({ state: "CANCELLED" }),
      { state: "OPEN", owner_type: "UNASSIGNED", owner_id: null },
      { state: "OPEN", owner_type: "HUMAN", owner_id: "fu_scooter_taylor" },
    ];
    for (const i of inputs) {
      const s = liveStatus(i, ME, NOW);
      expect(s.live, `${s.kind} for ${JSON.stringify(i)}`).toBe(s.kind === "WORKING_NOW");
      expect(s.line.length).toBeGreaterThan(5);
    }
  });

  it("firstSentence cuts at a word, never mid-word", () => {
    const long = "word ".repeat(60);
    const cut = firstSentence(long, 40);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.slice(0, -1).trim().split(" ").every((w) => w === "word")).toBe(true);
  });
});

describe("deskSummary — the header counts what the sections draw", () => {
  it("says the canvas's line", () => {
    const statuses = [
      liveStatus(porter({ state: "BLOCKED", block: { needed: "x" } }), ME, NOW),
      liveStatus(porter({ lease_until: ahead(1_000) }), ME, NOW),
      liveStatus(porter({ current_run: { status: "CLAIMED", claimed_at: ago(1_000), progressed_at: ago(1_000) } }), ME, NOW),
      liveStatus(porter({ work_attempts: 2 }), ME, NOW),
    ];
    const s = deskSummary(statuses);
    expect(s.line).toBe("1 needs you · 2 being worked · 1 waiting for its next try");
    expect(s.needsYou).toBe(1);
    expect(s.clear).toBe(false);
  });

  it("counts a deck decision as needing her, beside the cards", () => {
    expect(deskSummary([], 2).line).toBe("2 need you");
  });

  it("the clear day is said plainly and in the good tone", () => {
    const s = deskSummary([liveStatus(porter({ lease_until: ahead(1_000) }), ME, NOW)]);
    expect(s.line).toBe("Nothing needs you · 1 being worked");
    expect(s.clear).toBe(true);
  });

  it("is not clear while a card is failing behind her back", () => {
    const s = deskSummary([liveStatus(porter({ work_last_failure: "boom" }), ME, NOW)]);
    expect(s.clear).toBe(false);
    expect(s.line).toBe("Nothing needs you · 1 waiting for its next try");
  });

  it("an unowned card is counted as needing her — the 23 Sep header and its sections now agree", () => {
    const unowned = liveStatus({ state: "OPEN", owner_type: "UNASSIGNED", owner_id: null }, ME, NOW);
    expect(unowned.section).toBe("needs");
    expect(deskSummary([unowned]).needsYou).toBe(1);
  });
});

describe("plainTitle — never the raw email cut off mid-word", () => {
  const raw = 'Change joinwestpeek.com: "Porter, We need to get started on the community site redesign (joinwestpeek.com). Ever';
  const email = "Porter,\n\nWe need to get started on the community site redesign (joinwestpeek.com). Everything is in this Drive folder.";

  it("uses the subject she typed, from the card it was handed off from", () => {
    expect(plainTitle({ title: raw, kind: "WEB_PROPERTY_CHANGE", host: "joinwestpeek.com", subject: "From sequoia@westpeek.ventures: Re: Community site redesign", ask: email })).toBe(
      "Community site redesign · joinwestpeek.com",
    );
  });

  it("without a subject, finds the ask in her first sentence", () => {
    expect(plainTitle({ title: raw, kind: "WEB_PROPERTY_CHANGE", host: "joinwestpeek.com", subject: null, ask: email })).toBe("Community site redesign · joinwestpeek.com");
    expect(plainTitle({ title: raw, kind: "WEB_PROPERTY_CHANGE", host: "joinwestpeek.com", subject: "From x@y.z: (no subject)", ask: null })).toBe("Community site redesign · joinwestpeek.com");
  });

  it("never ends mid-word, and leaves other kinds alone", () => {
    const ask = "Please rebuild the whole events calendar page so that every event shows its speakers and its sponsors and its venue map";
    const t = plainTitle({ title: "x", kind: "WEB_PROPERTY_CHANGE", host: "westpeek.live", ask });
    expect(t.endsWith(" · westpeek.live")).toBe(true);
    expect(t).toContain("…");
    const words = t.replace(" · westpeek.live", "").replace("…", "").split(" ");
    const whole = ask.toLowerCase().split(" ");
    for (const w of words) expect(whole, `"${w}" is a cut word`).toContain(w.toLowerCase());
    expect(plainTitle({ title: "Research packet · [COMPANY]", kind: null })).toBe("Research packet · [COMPANY]");
  });

  it("shortAsk strips the greeting and the lead-in", () => {
    expect(shortAsk("Hi Porter, can you fix the footer links on the site.")).toBe("Fix the footer links on the site");
  });
});

/**
 * THE LIVE CARD, wc_c9e36e8b, AS IT STOOD ON 23 SEP 2026 (read from production, owner review of #193).
 * Its title came out as the whole email subject, its status line as "Needs you: PREVIEW READY", and
 * its timeline as "A try failed: Attempt 1 of 3 did not get anywhere". These are its real strings.
 */
describe("wc_c9e36e8b — the owner's review of #193, pinned on the real strings", () => {
  const LIVE = {
    title: 'Change joinwestpeek.com: "Porter, We need to get started on the community site redesign (j',
    parent_title: "From sequoia@westpeek.ventures: Community site redesign — everything is in the Drive folder",
    ask: "Porter,\n\nWe need to get started on the community site redesign (joinwestpeek.com). Everything is in this Drive folder, and there's a README in it. Start there.",
    needed:
      "PREVIEW READY. Look at it here: https://a782bc7d.west-peek-ventures.pages.dev' · https://a782bc7d.west-peek-ventures.pages.dev</a · https://work-wpc-c9e36e8b.west-peek-community.pages.dev</a.",
  };
  const card = (over: Partial<LiveStatusInput> = {}): LiveStatusInput =>
    porter({
      kind: "WEB_PROPERTY_CHANGE",
      state: "BLOCKED",
      block: { needed: LIVE.needed, stopped: "Porter needs something from you before this can go any further.", who: "SEQUOIA" },
      site_phase: "BUILD",
      site_preview_url: "https://work-wpc-c9e36e8b.west-peek-community.pages.dev",
      site_check_state: "GREEN",
      site_preview_only: 1,
      site_publish_ready: 0,
      site_land_approved_at: null,
      site_plan_filed_at: "2026-09-23T17:30:00Z",
      site_plan_approved_at: "2026-09-23T17:48:18Z",
      work_last_failure: "Attempt 1 of 3 did not get anywhere.",
      ...over,
    });

  it("the title is the job's short name and the site — never the subject's whole sentence, never cut mid-word", () => {
    const t = plainTitle({ title: LIVE.title, kind: "WEB_PROPERTY_CHANGE", host: "joinwestpeek.com", subject: LIVE.parent_title, ask: LIVE.ask });
    expect(t).toBe("Community site redesign · joinwestpeek.com");
    // The subject's own name — its first clause — is enough on its own…
    expect(plainTitle({ title: LIVE.title, kind: "WEB_PROPERTY_CHANGE", host: "joinwestpeek.com", subject: LIVE.parent_title, ask: null })).toBe("Community site redesign · joinwestpeek.com");
    // …the ask names it when the subject is missing…
    expect(plainTitle({ title: LIVE.title, kind: "WEB_PROPERTY_CHANGE", host: "joinwestpeek.com", subject: null, ask: LIVE.ask })).toBe("Community site redesign · joinwestpeek.com");
    // …a subject that is all sentence and no name falls to the ask…
    expect(plainTitle({ title: LIVE.title, kind: "WEB_PROPERTY_CHANGE", host: "joinwestpeek.com", subject: "From x@y.z: Here is everything you need for the site this week with all of the files", ask: LIVE.ask })).toBe("Community site redesign · joinwestpeek.com");
    // And with neither, the truncated card title still yields whole words.
    expect(plainTitle({ title: LIVE.title, kind: "WEB_PROPERTY_CHANGE", host: "joinwestpeek.com", subject: null, ask: null })).toBe("Community site redesign · joinwestpeek.com");
  });

  it("the status line is 'Preview ready · look and reply', read from the row — never the block's shouting text", () => {
    const s = liveStatus(card(), ME, NOW);
    expect(s).toMatchObject({ kind: "NEEDS_YOU", section: "needs", pill: "Needs you", line: "Preview ready · look and reply", failing: false });
    expect(s.line).not.toMatch(/PREVIEW READY|pages\.dev|Needs you/);
    expect(siteWait(card())).toBe("PREVIEW");
  });

  it("every stage is sentence case: a plan waiting reads 'Plan ready · read it and reply'", () => {
    const plan = card({ site_phase: "PLAN", site_plan_approved_at: null, site_preview_url: null, site_check_state: null });
    expect(siteWait(plan)).toBe("PLAN");
    expect(liveStatus(plan, ME, NOW).line).toBe("Plan ready · read it and reply");
  });

  it("the preview wait ends when she approves, when it is forced, or when the build is not green", () => {
    expect(siteWait(card({ site_land_approved_at: "x" }))).toBeNull();
    expect(siteWait(card({ site_forced_by: "fu_sequoia_taylor" }))).toBeNull();
    expect(siteWait(card({ site_check_state: "PENDING" }))).toBeNull();
    expect(siteWait(card({ kind: null }))).toBeNull();
  });

  it("a shouting block on any other card is said in sentence case", () => {
    const s = liveStatus(porter({ state: "BLOCKED", block: { needed: "PREVIEW READY. Look at it." } }), ME, NOW);
    expect(s.line).toBe("Needs you: Preview ready");
    expect(sentenceCase("URGENT: CALL DAN today")).toBe("Urgent: call dan today");
  });

  it("the failed try says plainly whose it was: 'First try stalled on our side; retried automatically.'", () => {
    expect(plainFailure("Attempt 1 of 3 did not get anywhere.")).toBe("First try stalled on our side; retried automatically.");
    expect(plainFailure("Attempt 2 of 3 did not get anywhere")).toBe("Second try stalled on our side; retried automatically.");
    const out = cardTimeline({ created_at: "2026-09-23T17:00:00Z", owner_name: "Porter", asked_by: "You", trail: [], last_failure: "Attempt 1 of 3 did not get anywhere.", last_failure_at: "2026-09-23T17:24:00Z" });
    expect(out.map((e) => e.text)).toContain("First try stalled on our side; retried automatically.");
    expect(out.map((e) => e.text).join(" ")).not.toMatch(/did not get anywhere|A try failed/);
    const waiting = liveStatus(porter({ work_last_failure: "Attempt 1 of 3 did not get anywhere." }), ME, NOW);
    expect(waiting.line).toBe("Next try within 5 min · first try stalled on our side; retried automatically");
  });
});

describe("siteStage — Plan, Build, Preview, Live from the row's facts", () => {
  it("walks the four stages", () => {
    expect(siteStage({ phase: "PLAN" }).key).toBe("PLAN");
    expect(siteStage({ phase: "BUILD" }).key).toBe("BUILD");
    expect(siteStage({ phase: "BUILD", preview_url: "https://p" }).key).toBe("PREVIEW");
    expect(siteStage({ phase: "LAND", preview_only: 1 }).key).toBe("PREVIEW");
    expect(siteStage({ phase: "LAND", preview_only: 1, land_approved_at: "x" }).key).toBe("LIVE");
    expect(siteStage({ phase: "LAND", preview_only: 0, publish_ready: 1 }).key).toBe("LIVE");
    expect(siteStage({ phase: "DONE" })).toEqual({ index: 3, key: "LIVE", finished: true });
  });
});

describe("the timeline and who asked, in words", () => {
  it("an email she sent reads 'You emailed', a notice reads what it did", () => {
    expect(trailSentence({ at: "t", kind: "RECEIVED_EMAIL", who: "sequoia@westpeek.ventures", what: "emailed: Community site redesign" }, "Porter", ["sequoia@westpeek.ventures"])).toBe(
      "You emailed Porter: Community site redesign.",
    );
    expect(trailSentence({ at: "t", kind: "RECEIVED", who: "told sequoia@westpeek.ventures", what: "received" }, "Porter", ["sequoia@westpeek.ventures"])).toBe('Porter replied "got it" and started.');
    expect(trailSentence({ at: "t", kind: "PREVIEW", who: "tried to tell scooter@westpeek.ventures", what: "preview:1" }, "Porter", [])).toBe("Porter sent the preview link (to scooter@westpeek.ventures). The email did not send.");
  });

  it("orders what happened, and marks the run on her Mac as now", () => {
    const out = cardTimeline({
      created_at: "2026-09-23T11:55:00Z",
      owner_name: "Porter",
      asked_by: "You",
      trail: [{ at: "2026-09-23T11:56:00Z", kind: "RECEIVED", who: "told sequoia@westpeek.ventures", what: "received" }],
      run: { status: "CLAIMED", claimed_at: "2026-09-23T12:31:00Z" },
      work_attempts: 2,
      last_failure: "The first try stalled.",
      last_failure_at: "2026-09-23T12:10:00Z",
      my_emails: ["sequoia@westpeek.ventures"],
    });
    expect(out.map((e) => e.text)).toEqual([
      "You asked Porter.",
      'Porter replied "got it" and started.',
      "A try failed: The first try stalled. Retried automatically.",
      "Try 2 started on your Mac.",
    ]);
    expect(out[3]!.now).toBe(true);
  });

  it("names who actually asked — never 'a hand-off'", () => {
    const handed = { created_by: "aie_porter", requested_by_email: "sequoia@westpeek.ventures", capture_id: null, meeting_id: null, assigned_from_card_id: "wc_parent", created_at: "x" };
    expect(askedBy(handed, { id: ME, email: "sequoia@westpeek.ventures" })).toEqual({ who: "You", how: "by email", you: true });
    expect(askedBy(handed, { id: "fu_scooter_taylor", email: "scooter@westpeek.ventures" }).who).toBe("Sequoia Taylor");
  });
});

// ── The board and the card page serve what the readers need ─────────────────────────────────

let t: TestDb;
let env: Env;
const SEQUOIA: FirmUserIdentity = {
  id: ME,
  email: "sequoia@westpeek.ventures",
  fullName: "Sequoia Taylor",
  status: "ACTIVE",
  roles: ["MANAGING_PARTNER"],
  authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "west-peek" }],
};
const req = () => new Request("https://os.joinwestpeek.com/x");

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});
afterAll(async () => {
  await disposeTestDb(t);
});

describe("the board and the card page serve one title and one run", () => {
  it("serves plain_title, the site's facts and the run her Mac holds, identically on both routes", async () => {
    const parent = await createWorkCardInternal(env, SEQUOIA, { title: "From sequoia@westpeek.ventures: Community site redesign", owner_type: "UNASSIGNED" } as never);
    const card = await createWorkCardInternal(env, SEQUOIA, {
      title: 'Change joinwestpeek.com: "Porter, We need to get started on the community site redesign (joinwestpeek.com). Ever',
      owner_type: "AI",
      owner_id: "aie_porter",
      kind: "WEB_PROPERTY_CHANGE",
    } as never);
    await env.WP_OS_DB.prepare("UPDATE work_card SET assigned_from_card_id = ?2, requested_by_email = 'sequoia@westpeek.ventures', cc_emails = '[\"scooter@westpeek.ventures\"]' WHERE id = ?1").bind(card.id, parent.id).run();
    await env.WP_OS_DB.prepare("INSERT INTO web_property_change (work_card_id, target_repo, property_host, ask, phase, preview_only) VALUES (?1, 'join-west-peek-main', 'joinwestpeek.com', 'Porter, we need the redesign.', 'BUILD', 1)").bind(card.id).run();
    const claimed = new Date(Date.now() - 60_000).toISOString();
    await env.WP_OS_DB.prepare(
      "INSERT INTO subscription_seat_run (id, seat, purpose, prompt, work_card_id, status, claimed_at, progressed_at, progress_note, run_kind) VALUES ('ccr_t1', 'CLAUDE_CODE', 'p', 'p', ?1, 'CLAIMED', ?2, ?2, 'building', 'LOCAL_JOB')",
    )
      .bind(card.id, claimed)
      .run();
    // A finished run is not the card's current run.
    await env.WP_OS_DB.prepare("INSERT INTO subscription_seat_run (id, seat, purpose, prompt, work_card_id, status, run_kind) VALUES ('ccr_t0', 'CLAUDE_CODE', 'p', 'p', ?1, 'REPORTED', 'LOCAL_JOB')").bind(card.id).run();

    const board = (await (await handleWorkByOwner({ env, identity: SEQUOIA as never, params: {}, request: req() } as never)).json()) as { cards: Array<Record<string, unknown>> };
    const row = board.cards.find((c) => c.id === card.id)!;
    expect(row.plain_title).toBe("Community site redesign · joinwestpeek.com");
    expect(row.site_phase).toBe("BUILD");
    expect(row.site_preview_only).toBe(1);
    expect(row.current_run).toMatchObject({ status: "CLAIMED", progress_note: "building", run_kind: "LOCAL_JOB" });

    const page = (await (await handleGetWorkCard({ env, identity: SEQUOIA as never, params: { id: card.id }, request: req() } as never)).json()) as Record<string, unknown>;
    // 0239: the cc the expanded card draws as "cc Scooter" is on the board too, not only on the card page.
    expect(JSON.parse(String(row.cc_emails))).toEqual(["scooter@westpeek.ventures"]);
    for (const k of ["plain_title", "site_phase", "site_host", "site_preview_only", "current_run", "parent_title", "cc_emails"]) expect(page[k], k).toEqual(row[k]);

    // And the one reader says the same thing about both.
    const a = liveStatus(row as never, ME);
    const b = liveStatus(page as never, ME);
    expect(a).toEqual(b);
    expect(a.kind).toBe("WORKING_NOW");
  });

  it("a card with no live run serves current_run null — never Working now", async () => {
    const card = await createWorkCardInternal(env, SEQUOIA, { title: "Plain card with nothing running", owner_type: "AI", owner_id: "aie_wyatt" } as never);
    const board = (await (await handleWorkByOwner({ env, identity: SEQUOIA as never, params: {}, request: req() } as never)).json()) as { cards: Array<Record<string, unknown>> };
    const row = board.cards.find((c) => c.id === card.id)!;
    expect(row.current_run).toBeNull();
    expect(row.plain_title).toBe("Plain card with nothing running");
    expect(liveStatus(row as never, ME).kind).toBe("QUEUED");
  });
});

describe("the Preview-ready panel reads structured fields and speaks her four replies", () => {
  it("serves ONE clean link for the card's own site, from the stored mess on wc_c9e36e8b", async () => {
    const card = await createWorkCardInternal(env, SEQUOIA, { title: "Preview link fixture", owner_type: "AI", owner_id: "aie_porter", kind: "WEB_PROPERTY_CHANGE" } as never);
    const mess =
      "https://a782bc7d.west-peek-ventures.pages.dev' · https://a782bc7d.west-peek-ventures.pages.dev</a · https://work-wpc-c9e36e8b.west-peek-ventures.pages.dev' · " +
      "https://73efcfc2.west-peek-productions.pages.dev' · https://work-wpc-c9e36e8b.west-peek-productions.pages.dev</a · https://fe42ec36.west-peek-community.pages.dev' · " +
      "https://work-wpc-c9e36e8b.west-peek-community.pages.dev' · https://work-wpc-c9e36e8b.west-peek-community.pages.dev</a";
    await env.WP_OS_DB.prepare("INSERT INTO web_property_change (work_card_id, target_repo, property_host, ask, phase, branch, preview_url, check_state) VALUES (?1, 'join-west-peek-main', 'joinwestpeek.com', 'x', 'BUILD', 'work/wpc-c9e36e8b', ?2, 'GREEN')").bind(card.id, mess).run();
    const res = await handleGetWebPropertyChange({ env, identity: SEQUOIA as never, params: { id: card.id }, request: req() } as never);
    const body = (await res.json()) as { preview_link: string | null };
    expect(body.preview_link).toBe("https://work-wpc-c9e36e8b.west-peek-community.pages.dev");
  });

  it("each button's words mean what its label says, to the one reply reader", () => {
    expect(readApprovalReply(APPROVED_REPLY).kind).toBe("APPROVED");
    expect(readApprovalReply(`${CHANGES_REPLY_PREFIX} make the hero photo the group shot`)).toMatchObject({ kind: "REFUSED", changes: true });
    expect(readApprovalReply(PUBLISH_REPLY).kind).toBe("PUBLISH");
    expect(MATERIALS_ADDED_PHRASE).toBe("I added missing items");
  });
});
