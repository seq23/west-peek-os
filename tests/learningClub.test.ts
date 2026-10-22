import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import {
  TLC_DRIP_DAYS,
  TLC_SEATS,
  bookingPackProblems,
  bookingPackTotals,
  brandSendGate,
  classifyBrandMail,
  decisionEmail,
  dripEmail,
  eventEconomics,
  goAheadCheck,
  needsSwap,
  nextDripAt,
  parseDecisionReply,
  renderOnePager,
  rollingTopicMonths,
  runOfShowMinutes,
  sponsorshipAgreement,
  stageMoveProblem,
  ticketPriceProblem,
  ticketVerdict,
  vetoedMonths,
  warmupDailyCap,
  type BookingPack,
} from "../src/shared/tlc/learningClub";
import {
  openBrandBatchCard,
  openDecisionCard,
  openTopicsCard,
  recordBrandMail,
  runDrip,
  runTlcCard,
  runTlcDaily,
  type TlcDealRow,
} from "../src/worker/services/learningClub";
import { sweepOnce } from "../src/worker/services/workSweep";

/**
 * THE LEARNING CLUB (owner-approved 22 Oct 2026), proven offline. What has to be true: the owner's
 * numbers decide go or escalate; Parker's picks proceed after 3 days unless a partner says no;
 * nothing reaches a brand while the switch is off; a reply stops the sequence; the partners' reply
 * decides a deal; nobody here books or pays for anything.
 */

const econ = (sponsorCashUsd: number, costs: number, tickets: number) =>
  eventEconomics({ sponsorCashUsd, committedCostsUsd: costs, tickets: Array.from({ length: tickets }, () => ({ amount_usd: 10, fee_usd: null })) });

describe("the rules, pure", () => {
  it("holds three months ahead, never before January 2027", () => {
    expect(rollingTopicMonths(new Date("2026-10-22T12:00:00Z"))).toEqual(["2027-01", "2027-02", "2027-03"]);
    expect(rollingTopicMonths(new Date("2026-11-01T14:00:00Z"))).toEqual(["2027-01", "2027-02", "2027-03"]);
    expect(rollingTopicMonths(new Date("2026-12-01T14:00:00Z"))).toEqual(["2027-02", "2027-03", "2027-04"]);
  });

  it("runs 3–4 hours in the owner's shape", () => {
    const m = runOfShowMinutes();
    expect(m.min).toBeGreaterThanOrEqual(180);
    expect(m.max).toBeLessThanOrEqual(240);
  });

  it("judges the $10K target and the $7.5K floor on sponsor money alone; tickets add to net after fees", () => {
    const e = econ(12_000, 4_500, 30);
    expect(e.sponsorNetUsd).toBe(7_500);
    expect(e.hitsFloor).toBe(true);
    expect(e.hitsTarget).toBe(false);
    expect(e.ticketNetUsd).toBeCloseTo(30 * (10 - 0.59), 2);
    expect(e.netUsd).toBeGreaterThan(e.sponsorNetUsd);
    // 40 paid tickets can never carry a club to the target.
    expect(econ(9_000, 0, 40).hitsTarget).toBe(false);
    expect(econ(9_000, 5_001, 0).overCostCap).toBe(true);
  });

  it("goes only at 21 and 14 days, and needs 25 PAID tickets two weeks out", () => {
    expect(goAheadCheck({ daysOut: 20, economics: econ(0, 0, 0) }).verdict).toBe("NOT_YET");
    expect(goAheadCheck({ daysOut: 21, economics: econ(10_000, 2_000, 3) }).verdict).toBe("GO");
    const short = goAheadCheck({ daysOut: 14, economics: econ(10_000, 2_000, 24) });
    expect(short.verdict).toBe("ESCALATE");
    expect(short.reasons.join(" ")).toMatch(/24 paid ticket/);
    expect(short.options).toHaveLength(3);
    expect(goAheadCheck({ daysOut: 14, economics: econ(10_000, 2_000, 25) }).verdict).toBe("GO");
    expect(goAheadCheck({ daysOut: 21, economics: econ(7_000, 0, 40) }).verdict).toBe("ESCALATE");
  });

  it("sells $10 tickets, 40 at most", () => {
    expect(ticketPriceProblem(0)).toMatch(/free seat/);
    expect(ticketPriceProblem(12)).toMatch(/at most \$10/);
    expect(ticketPriceProblem(10)).toBeNull();
    expect(ticketVerdict(39).verdict).toBe("OPEN");
    expect(ticketVerdict(TLC_SEATS.max).verdict).toBe("FULL");
    expect(ticketVerdict(25).meetsFloor).toBe(true);
  });

  it("drips at day 0, 4, 10, 18 from the first send, and stops on any stop", () => {
    const first = "2027-01-04T14:00:00.000Z";
    const now = new Date(first);
    expect(TLC_DRIP_DAYS).toEqual([0, 4, 10, 18]);
    expect(nextDripAt(1, first, now, null)).toBe("2027-01-08T14:00:00.000Z");
    expect(nextDripAt(3, first, now, null)).toBe("2027-01-22T14:00:00.000Z");
    expect(nextDripAt(4, first, now, null)).toBeNull();
    expect(nextDripAt(1, first, now, "REPLIED")).toBeNull();
    expect(warmupDailyCap(null, now)).toBe(5);
    expect(warmupDailyCap("2026-12-20T00:00:00Z", now)).toBe(20);
    expect(classifyBrandMail({ from: "MAILER-DAEMON@x.com", subject: "Undeliverable: hi" })).toBe("BOUNCED");
    expect(classifyBrandMail({ from: "a@brand.com", subject: "Re: unsubscribe" })).toBe("UNSUBSCRIBED");
    expect(classifyBrandMail({ from: "a@brand.com", subject: "Re: sounds good" })).toBe("REPLIED");
  });

  it("writes the brand email as we, with one ask and a way to stop", () => {
    const m = dripEmail({ step: 0, brand: "Acme", contactName: "Jo Doe", topic: "Matcha & Tea", month: "2027-02", eventDate: "2027-02-18", why: null });
    expect(m.text).toMatch(/^Hi Jo,/);
    expect(m.text).toMatch(/\bWe run West Peek Rooms/);
    expect(m.text).toMatch(/Every attendee buys a ticket/);
    expect(m.text).toMatch(/unsubscribe/);
    expect(m.text).not.toMatch(/\bI'm\b|\bmy brother\b/);
    expect(dripEmail({ step: 2, brand: "Acme", contactName: null, topic: "T", month: "2027-02", eventDate: "", why: null }).subject).toBe(m.subject.replace("Matcha & Tea", "T"));
  });

  it("reads the partners' reply as yes, no or counter", () => {
    expect(parseDecisionReply("Yes, do it")).toEqual({ kind: "YES" });
    expect(parseDecisionReply("no thanks")).toEqual({ kind: "NO" });
    expect(parseDecisionReply("counter $6,500")).toEqual({ kind: "COUNTER", amountUsd: 6500 });
    expect(parseDecisionReply("let's counter at 7k")).toEqual({ kind: "COUNTER", amountUsd: 7000 });
    expect(parseDecisionReply("hmm")).toEqual({ kind: "UNCLEAR" });
  });

  it("reads a veto: a named month or topic, or every month on a bare no", () => {
    const p = [{ month: "2027-01", topic: "Matcha & Tea" }, { month: "2027-02", topic: "Fragrance Lab" }];
    expect(vetoedMonths("Looks great!", p)).toEqual([]);
    expect(vetoedMonths("no to February please", p)).toEqual(["2027-02"]);
    expect(vetoedMonths("not matcha", p)).toEqual(["2027-01"]);
    expect(vetoedMonths("no", p)).toEqual(["2027-01", "2027-02"]);
  });

  it("moves a deal forward only, except a counter back to CALL", () => {
    expect(stageMoveProblem("PITCHED", "AGREED")).toBeNull();
    expect(stageMoveProblem("AGREED", "PITCHED")).toMatch(/forward/);
    expect(stageMoveProblem("WAITING_ON_OWNERS", "CALL", { counter: true })).toBeNull();
    expect(stageMoveProblem("DECLINED", "AGREED")).toMatch(/DECLINED/);
  });

  it("swaps a topic six weeks out when no brand is interested", () => {
    expect(needsSwap(42, [{ stage: "PITCHED" }])).toBe(true);
    expect(needsSwap(42, [{ stage: "PITCHED", replied_at: "2027-01-01" }])).toBe(false);
    expect(needsSwap(43, [])).toBe(false);
  });

  it("prices the booking pack against the cap and the sponsor cash, and says what is short", () => {
    const o = (name: string, priceUsd: number) => ({ name, priceUsd, bookBy: "2027-01-05", url: `https://x.example/${name}` });
    const pack: BookingPack = {
      hosts: [o("h1", 400), o("h2", 500), o("h3", 600)],
      donatedVenueLeads: [o("law firm", 0)],
      paidVenues: [o("v1", 1200), o("v2", 1500)],
      teachers: [o("t1", 800), o("t2", 1000)],
      food: [o("f1", 1100), o("f2", 1300)],
      materials: [{ item: "whisks", url: "https://x.example/w", qty: 40, unitUsd: 8 }],
      photographers: [o("p1", 450), o("p2", 500)],
    };
    expect(bookingPackProblems(pack)).toEqual([]);
    const t = bookingPackTotals(pack, 15_000);
    expect(t.costUsd).toBe(400 + 1200 + 800 + 1100 + 450 + 320);
    expect(t.underCap).toBe(true);
    expect(t.bestCaseCostUsd).toBe(t.costUsd - 1200);
    expect(t.netUsd).toBe(15_000 - t.costUsd);
    expect(bookingPackProblems({ ...pack, hosts: [o("h1", 400)] }).join(" ")).toMatch(/1 NYC paid host/);
  });

  it("keeps the send gate shut until both approvals, the switch and the firm's external switch", () => {
    expect(brandSendGate({}, {}).open).toBe(false);
    expect(brandSendGate({ brand_send: "on", onepager_mock_approved_at: "x", playbook_approved_at: "x" }, {}).reasons).toEqual(["employees may not email outside the firm (WP_OS_AI_EMAIL_EXTERNAL)"]);
    expect(brandSendGate({ brand_send: "ON", onepager_mock_approved_at: "x", playbook_approved_at: "x" }, { WP_OS_AI_EMAIL_EXTERNAL: "enabled" }).open).toBe(false);
    expect(brandSendGate({ brand_send: "on", onepager_mock_approved_at: "x", playbook_approved_at: "x" }, { WP_OS_AI_EMAIL_EXTERNAL: "enabled" }).open).toBe(true);
  });

  it("sells real hands-on time and paid seats on the one-pager, with no invented case study", () => {
    const html = renderOnePager({ topic: "Matcha & Tea", angle: null, month: "2027-02", eventDate: "2027-02-18", whyNow: "why", categories: ["Tea brands"], story: null, citations: [], proof: ["real history"], recap: null });
    expect(html).toMatch(/Every seat paid/);
    expect(html).toMatch(/hands-on time/);
    expect(html).toMatch(/real history/);
    expect(html).not.toMatch(/<script/);
    expect(html).toMatch(/prefers-color-scheme:dark/);
  });

  it("marks the agreement as not legal advice and the decision email carries the net if we say yes", () => {
    expect(sponsorshipAgreement({ brand: "Acme", topic: "T", eventDate: "2027-02-18", cashUsd: 5000, inKind: null, deliverables: null, dueDate: "2027-02-01" })).toMatch(/^TEMPLATE ONLY\. NOT LEGAL ADVICE/);
    const mail = decisionEmail({ brand: "Acme", topic: "T", month: "2027-02", cashUsd: 5000, inKind: "product for 40", inKindValueUsd: 800, wants: "a demo table" }, econ(6_000, 1_000, 0));
    expect(mail.tldr).toMatch(/nets \$10,000/);
    expect(mail.sections.map((s) => s.label)).toEqual(["The offer", "Net if we say yes", "Recommendation"]);
    expect(`Wynn: ${mail.what}`.length).toBeLessThanOrEqual(70);
  });
});

// ── Through the database ──────────────────────────────────────────────────────────────────────

let t: TestDb;
let env: Env;
const NOV1 = new Date("2026-11-01T14:00:00.000Z");
const live = async (url: string): Promise<boolean> => !url.includes("dead.example");

const picksJson = (months: string[], topics: string[]) => JSON.stringify({
  picks: months.map((m, i) => ({
    month: m, topic: topics[i], angle: "an angle", why_now: "why", criteria: {}, hands_on: "make it", take_home: "a thing", teacher_profile: "an expert",
    sponsor_categories: ["A", "B", "C", "D", "E", "F"].map((c) => ({ category: `${c} category`, why: "fits", example_brands: [] })),
    sources: [{ title: "Real page", url: `https://news.example/${i}` }, { title: "Dead", url: "https://dead.example/x" }],
  })),
});

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>);
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_parker','aie_wynn')").run();
});
afterAll(async () => { await disposeTestDb(t); });

describe("the Learning Club in the database", () => {
  it("brings Wynn back as the sales seat through the lifecycle, and seeds the switch OFF", async () => {
    const wynn = await env.WP_OS_DB.prepare("SELECT role, primary_machines_json FROM ai_employee WHERE id = 'aie_wynn'").first<{ role: string; primary_machines_json: string }>();
    expect(wynn!.role).toBe("TLC Sales & Partnerships");
    const history = (await env.WP_OS_DB.prepare("SELECT from_status, to_status FROM ai_employee_status_history WHERE id LIKE 'aesh_wynn_%_0259' ORDER BY id").all<{ from_status: string; to_status: string }>()).results;
    expect(history).toEqual([{ from_status: "INACTIVE", to_status: "ACTIVE" }, { from_status: "RETIRED", to_status: "INACTIVE" }]);
    const sw = await env.WP_OS_DB.prepare("SELECT value FROM tlc_setting WHERE key = 'brand_send'").first<{ value: string }>();
    expect(sw!.value).toBe("off");
    for (const key of ["tlc_topics", "tlc_daily", "tlc_brand_batch", "tlc_trend_story"]) {
      expect(await env.WP_OS_DB.prepare("SELECT 1 FROM scheduled_job WHERE job_key = ?1").bind(key).first()).toBeTruthy();
    }
  });

  it("Parker picks three topics, emails both partners, and holds them for the 3-day veto window", async () => {
    const opened = await openTopicsCard(env, NOV1);
    expect(opened.opened).toBe(true);
    const out = await sweepOnce(env, NOV1, {
      tlc: (e, card) => runTlcCard(e, card, { search: async () => ({ ok: true, text: picksJson(["2027-01", "2027-02", "2027-03"], ["Matcha & Tea", "Fragrance Lab", "Film Photography"]), detail: "ok" }), urlCheck: live, now: NOV1 }),
    });
    expect(out.outcome).toBe("PROGRESSED");
    const evs = (await env.WP_OS_DB.prepare("SELECT month, topic, status, veto_until FROM tlc_event ORDER BY month").all<{ month: string; topic: string; status: string; veto_until: string }>()).results!;
    expect(evs.map((e) => e.status)).toEqual(["TOPIC_PROPOSED", "TOPIC_PROPOSED", "TOPIC_PROPOSED"]);
    expect(evs[0]!.veto_until).toBe("2026-11-04T14:00:00.000Z");
    const card = await env.WP_OS_DB.prepare("SELECT lease_until FROM work_card WHERE id = ?1").bind(opened.cardId).first<{ lease_until: string }>();
    expect(card!.lease_until).toBe("2026-11-04T14:00:00.000Z");
    // Nothing sells while a pick can still be vetoed.
    expect((await openBrandBatchCard(env, NOV1)).opened).toBe(false);
  });

  it("a partner's no swaps that month; silence lets the rest proceed", async () => {
    const card = await env.WP_OS_DB.prepare("SELECT id FROM work_card WHERE kind = 'TLC_TOPICS'").first<{ id: string }>();
    await env.WP_OS_DB.prepare("INSERT INTO work_card_note (id, work_card_id, author_id, body, firm_scope) VALUES ('wcn_t1', ?1, 'fu_scooter_taylor', 'no to February', 'west-peek')").bind(card!.id).run();
    const later = new Date("2026-11-05T14:00:00.000Z");
    // First tick reads the no and re-picks February, holding it for its own window.
    await sweepOnce(env, later, {
      tlc: (e, c) => runTlcCard(e, c, { search: async () => ({ ok: true, text: picksJson(["2027-02"], ["Zero-Proof Home Bar"]), detail: "ok" }), urlCheck: live, now: later }),
    });
    await env.WP_OS_DB.prepare("UPDATE work_card SET lease_until = NULL WHERE id = ?1").bind(card!.id).run();
    const afterWindow = new Date("2026-11-09T14:00:00.000Z");
    await sweepOnce(env, afterWindow, { tlc: (e, c) => runTlcCard(e, c, { now: afterWindow, urlCheck: live }) });
    const evs = (await env.WP_OS_DB.prepare("SELECT month, topic, status, vetoed_topics_json FROM tlc_event ORDER BY month").all<{ month: string; topic: string; status: string; vetoed_topics_json: string | null }>()).results!;
    expect(evs.map((e) => [e.month, e.topic, e.status])).toEqual([
      ["2027-01", "Matcha & Tea", "TOPIC_READY"],
      ["2027-02", "Zero-Proof Home Bar", "TOPIC_READY"],
      ["2027-03", "Film Photography", "TOPIC_READY"],
    ]);
    expect(evs[1]!.vetoed_topics_json).toContain("Fragrance Lab");
    const done = await env.WP_OS_DB.prepare("SELECT state FROM work_card WHERE id = ?1").bind(card!.id).first<{ state: string }>();
    expect(done!.state).toBe("DONE");
  });

  it("Wynn queues only brands whose address is really on the page", async () => {
    const monday = new Date("2026-11-09T14:00:00.000Z");
    const opened = await openBrandBatchCard(env, monday);
    expect(opened.opened).toBe(true);
    const brands = JSON.stringify({ brands: [
      { month: "2027-01", brand: "Leaf Co", category: "Tea brands", contact_name: "Ana Lee", contact_email: "ana@leaf.example", contact_source_url: "https://leaf.example/team", why_fit: "they run tastings" },
      { month: "2027-01", brand: "Guess Co", contact_email: "guess@guess.example", contact_source_url: "https://guess.example/about" },
      { month: "2027-01", brand: "Dead Co", contact_email: "a@dead.example", contact_source_url: "https://dead.example/x" },
    ] });
    await sweepOnce(env, monday, {
      tlc: (e, c) => runTlcCard(e, c, { search: async () => ({ ok: true, text: brands, detail: "ok" }), urlCheck: live, pageText: async (u) => (u.includes("leaf") ? "Partnerships: ana@leaf.example" : "no address here"), now: monday }),
    });
    const deals = (await env.WP_OS_DB.prepare("SELECT brand, stage FROM tlc_deal").all<{ brand: string; stage: string }>()).results!;
    expect(deals).toEqual([{ brand: "Leaf Co", stage: "PROSPECT" }]);
  });

  it("HOLDS every brand email while the switch is off: composed, stored, nothing filed or sent", async () => {
    const out = await runDrip(env, new Date("2026-11-09T15:00:00.000Z"));
    expect(out.gate.open).toBe(false);
    expect(out.held).toBe(1);
    expect(out.awaitingApproval + out.sent).toBe(0);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM external_effect_request").first<{ n: number }>())!.n).toBe(0);
    const m = await env.WP_OS_DB.prepare("SELECT state, held_reason FROM tlc_drip_message").first<{ state: string; held_reason: string }>();
    expect(m!.state).toBe("HELD");
    expect(m!.held_reason).toMatch(/one-pager mock.*playbook.*switch is off/);
  });

  it("with everything approved and on, each email waits for a partner's approval card", async () => {
    await env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value) VALUES ('onepager_mock_approved_at','x'),('playbook_approved_at','x') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    await env.WP_OS_DB.prepare("UPDATE tlc_setting SET value = 'on' WHERE key = 'brand_send'").run();
    const on = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled", WP_OS_AI_EMAIL_EXTERNAL: "enabled" } as Partial<Env>);
    const out = await runDrip(on, new Date("2026-11-09T15:05:00.000Z"));
    expect(out.awaitingApproval).toBe(1);
    expect(out.sent).toBe(0);
    const m = await env.WP_OS_DB.prepare("SELECT m.state, a.action_key FROM tlc_drip_message m JOIN approval_card a ON a.id = m.approval_card_id").first<{ state: string; action_key: string }>();
    expect(m).toEqual({ state: "AWAITING_APPROVAL", action_key: "effect.email.send" });
    await env.WP_OS_DB.prepare("UPDATE tlc_setting SET value = 'off' WHERE key = 'brand_send'").run();
  });

  it("a reply from the brand stops its sequence and lands on the sales card", async () => {
    const r = await recordBrandMail(env, { from: "Ana Lee <ana@leaf.example>", subject: "Re: Leaf Co x a Matcha & Tea learning club", now: new Date("2026-11-10T10:00:00Z") });
    expect(r).toEqual({ matched: 1, stop: "REPLIED" });
    const d = await env.WP_OS_DB.prepare("SELECT stop_reason, next_send_at, replied_at FROM tlc_deal").first<TlcDealRow>();
    expect(d!.stop_reason).toBe("REPLIED");
    expect(d!.next_send_at).toBeNull();
    const card = await env.WP_OS_DB.prepare("SELECT description FROM work_card WHERE kind = 'TLC_BRAND_BATCH'").first<{ description: string }>();
    expect(card!.description).toMatch(/Leaf Co .*replied/);
  });

  it("both partners decide; a counter sends the deal back to a call", async () => {
    await env.WP_OS_DB.prepare("UPDATE tlc_deal SET stage = 'WAITING_ON_OWNERS', cash_offer_usd = 5000, in_kind_offer = 'tea for 40', in_kind_value_usd = 600").run();
    const deal = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal").first<TlcDealRow>())!;
    const cardId = await openDecisionCard(env, deal, new Date("2026-11-11T10:00:00Z"));
    const first = await sweepOnce(env, new Date("2026-11-11T10:05:00Z"), { tlc: (e, c) => runTlcCard(e, c, { now: new Date("2026-11-11T10:05:00Z") }) });
    expect(first.outcome).toBe("BLOCKED");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'OPEN', block_answer = 'counter $6,500', block_answered_by = 'fu_sequoia_taylor', lease_until = NULL, work_attempts = 0 WHERE id = ?1").bind(cardId).run();
    await sweepOnce(env, new Date("2026-11-11T11:00:00Z"), { tlc: (e, c) => runTlcCard(e, c, { now: new Date("2026-11-11T11:00:00Z") }) });
    const after = await env.WP_OS_DB.prepare("SELECT stage, decision, counter_usd FROM tlc_deal").first<TlcDealRow>();
    expect(after).toMatchObject({ stage: "CALL", decision: "COUNTER", counter_usd: 6500 });
  });

  it("the daily pass escalates a club short of the floor two weeks out, to both partners, once", async () => {
    const twoWeeks = new Date("2027-01-07T13:30:00.000Z"); // Jan club is the third Thursday, 21 Jan.
    const out = await runTlcDaily(env, twoWeeks);
    expect(out.failures).toEqual([]);
    expect(out.goChecks).toEqual([{ month: "2027-01", checkpoint: 14, verdict: "ESCALATE" }]);
    expect((await runTlcDaily(env, twoWeeks)).goChecks).toEqual([]);
    const ev = await env.WP_OS_DB.prepare("SELECT status FROM tlc_event WHERE month = '2027-01'").first<{ status: string }>();
    expect(ev!.status).toBe("ESCALATED");
  });
});

// 22 Oct 2026: a review flagged "more than 5,000 founders…" as unsourced and #258 swapped it for a
// QuarantineCon line. Sequoia confirmed the same day the 5,000 community figure is real, so the
// original line is restored. Sponsor copy states the community size only in this exact, confirmed form.
const TLC_CONFIRMED_COMMUNITY_LINE =
  "The West Peek community: more than 5,000 founders, operators, investors, creatives and builders.";
describe("TLC pre-launch proof states the confirmed community size", () => {
  it("carries the owner-confirmed 5,000 line, and no other head-count", async () => {
    const { TLC_PRE_LAUNCH_PROOF } = await import("../src/shared/tlc/learningClub");
    expect(TLC_PRE_LAUNCH_PROOF).toContain(TLC_CONFIRMED_COMMUNITY_LINE);
    const counted = TLC_PRE_LAUNCH_PROOF.filter((l) => /\d{1,3},\d{3}/.test(l));
    expect(counted).toEqual([TLC_CONFIRMED_COMMUNITY_LINE]);
  });
});
