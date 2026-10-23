import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
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
  contentHashes,
  type TlcDealRow,
} from "../src/worker/services/learningClub";
import { sweepOnce } from "../src/worker/services/workSweep";
import { brandPitchProblems, clubWhen, renderBrandPitch, renderInternalOnePager, type TlcClubView, type TlcInternalView } from "../src/shared/tlc/pitch";

/**
 * THE LEARNING CLUB (owner-approved 22 Oct 2026), proven offline. What has to be true: the owner's
 * numbers decide go or escalate; Parker's picks proceed after 3 days unless a partner says no;
 * nothing reaches a brand while the switch is off; a reply stops the sequence; the partners' reply
 * decides a deal; nobody here books or pays for anything.
 */

const econ = (sponsorCashUsd: number, costs: number, tickets: number) =>
  eventEconomics({ sponsorCashUsd, committedCostsUsd: costs, tickets: Array.from({ length: tickets }, () => ({ amount_usd: 10, fee_usd: null })) });

const VIEW = (topic: string, month: string, over: Partial<TlcClubView> = {}): TlcClubView => ({
  topic, angle: `${topic}, taught properly. A second line.`, month, eventDate: `${month}-11`, slot: "EVENING", whyNow: "Brands in this category are paying for rooms like this now.",
  sources: [{ title: "A real source", url: "https://news.example/a" }], categories: [{ category: "Tea brands (lead)", why: "fits", example_brands: ["Leaf Co"] }],
  handsOn: null, takeHome: null, recap: null, ...over,
});

const IVIEW = (topic: string, month: string, over: Partial<TlcInternalView> = {}): TlcInternalView => ({
  ...VIEW(topic, month), origin: "TREND", status: "TOPIC_PROPOSED", vetoUntil: "2026-10-25T23:28:12.271Z", committedUsd: 0, committedPartners: 0, pitchUrl: null, ...over,
});

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
    // The cost budget is $15,000 now (owner, 22 Oct 2026), and a club with its own goal carries its own budget.
    expect(econ(30_000, 15_000, 0).overCostCap).toBe(false);
    expect(econ(30_000, 15_001, 0).overCostCap).toBe(true);
    expect(eventEconomics({ sponsorCashUsd: 40_000, committedCostsUsd: 25_000, tickets: [], costBudgetUsd: 30_000 }).overCostCap).toBe(false);
    expect(eventEconomics({ sponsorCashUsd: 40_000, committedCostsUsd: 30_001, tickets: [], costBudgetUsd: 30_000 }).overCostCap).toBe(true);
    // $25,000 raised less $15,000 spent is exactly the $10,000 net target; $7,500 stays the escalation line.
    expect(econ(25_000, 15_000, 0).hitsTarget).toBe(true);
    expect(econ(22_499, 15_000, 0).hitsFloor).toBe(false);
  });

  it("goes only at 21 and 14 days, and needs 25 PAID tickets two weeks out", () => {
    expect(goAheadCheck({ daysOut: 20, economics: econ(0, 0, 0) }).verdict).toBe("NOT_YET");
    expect(goAheadCheck({ daysOut: 21, economics: econ(10_000, 2_000, 3) }).verdict).toBe("GO");
    const short = goAheadCheck({ daysOut: 14, economics: econ(10_000, 2_000, 24) });
    expect(short.verdict).toBe("ESCALATE");
    expect(short.reasons.join(" ")).toMatch(/24 paid ticket/);
    expect(short.options).toHaveLength(3);
    expect(goAheadCheck({ daysOut: 14, economics: econ(10_000, 2_000, 25) }).verdict).toBe("GO");
    // A room the partners sized for 60–75 needs 60 paid two weeks out, and caps tickets at 75.
    expect(goAheadCheck({ daysOut: 14, economics: econ(10_000, 2_000, 59), seats: { min: 60, max: 75 } }).reasons.join(" ")).toMatch(/59 paid ticket\(s\), under the 60 needed/);
    expect(goAheadCheck({ daysOut: 14, economics: econ(10_000, 2_000, 60), seats: { min: 60, max: 75 } }).verdict).toBe("GO");
    expect(ticketVerdict(74, { min: 60, max: 75 }).verdict).toBe("OPEN");
    expect(ticketVerdict(75, { min: 60, max: 75 }).verdict).toBe("FULL");
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

  it("writes the brand emails signed by Sequoia: the brand's reason first, one proof line, one ask, no pitch or price, a quiet subject", () => {
    const why = "your team ran three tastings in Brooklyn this autumn";
    const steps = [0, 1, 2, 3].map((step) => dripEmail({ step, brand: "Acme", contactName: "Jo Doe", topic: "Matcha & Tea", month: "2027-02", eventDate: "2027-02-11", why }));
    const [first, second] = steps;
    // Signed by her, with her address; never by an employee, never by Scooter.
    for (const m of steps) {
      expect(m.text).toMatch(/\nSequoia Taylor\nWest Peek Ventures\nsequoia@westpeek\.ventures\n/);
      expect(m.text).not.toMatch(/Scooter|Wynn|Parker|West Peek Rooms\n\nIf you/);
      expect(m.text).toMatch(/unsubscribe/);
      // No pitch, no price, no attachment, no exclusivity until they reply.
      expect(m.text).not.toMatch(/\$\d|one-pager|one-sheet|pitch|attach|exclusiv|per category|to itself/i);
      // One quiet subject for all four, so they thread.
      expect(m.subject).toBe("Acme + a small room in New York");
    }
    // Email 1 leads with the brand's own reason, then one proof line, then the one ask.
    expect(first!.text).toMatch(/^Hi Jo,\n\nI am writing because your team ran three tastings in Brooklyn this autumn\./);
    expect(first!.text).toContain("Our community of more than 5,000 founders, operators and creatives");
    expect(first!.text).toContain("founding partners");
    expect(first!.text.indexOf("I am writing because")).toBeLessThan(first!.text.indexOf("Our community"));
    expect(first!.text).toMatch(/Would you be open to exploring a partnership\?/);
    expect((first!.text.match(/\?/g) ?? []).length).toBe(1);
    // Email 2 is a short picture of the room.
    expect(second!.text).toMatch(/A quick picture of the room/);
    expect(second!.text).toMatch(/paid seat/);
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

  it("keeps the send gate shut until both approvals OF THE CURRENT CONTENT, the switch and her Outside email list", () => {
    const h = { pitch: "a".repeat(64), playbook: "b".repeat(64) };
    const approved = { pitch_approved_hash: h.pitch, playbook_approved_hash: h.playbook };
    const notOnList = { allowed: false, code: "NOT_ON_LIST", reason: "TLC brand sales is not on your Outside email list." };
    const onList = { allowed: true, code: "ALLOWED", reason: "TLC brand sales is on your Outside email list." };
    expect(brandSendGate({}, notOnList, h).open).toBe(false);
    // The one line the panel turns into "tap to allow", word for word.
    expect(brandSendGate({ brand_send: "on", ...approved }, notOnList, h).reasons).toEqual(["TLC brand sales is not on your Outside email list — tap to allow."]);
    expect(brandSendGate({ brand_send: "on", ...approved }, notOnList, h).outside_email_allowed).toBe(false);
    // Off and break-glass say so in their own words, and still shut the gate.
    expect(brandSendGate({ brand_send: "on", ...approved }, { allowed: false, code: "BREAK_GLASS", reason: "Stopped by the break-glass switch." }, h).reasons).toEqual(["Stopped by the break-glass switch. — tap to open your Outside email list."]);
    expect(brandSendGate({ brand_send: "on", ...approved }, { allowed: false, code: "MODE_OFF", reason: "Outside email is off." }, h).open).toBe(false);
    // Allowing the job opens nothing by itself: the TLC switch and both approvals still stand.
    expect(brandSendGate({ brand_send: "ON", ...approved }, onList, h).open).toBe(false);
    expect(brandSendGate({ ...approved }, onList, h).reasons).toEqual(["the TLC brand-send switch is off"]);
    expect(brandSendGate({ brand_send: "on", ...approved }, onList, h)).toEqual({ open: true, reasons: [], outside_email_allowed: true });
    // The old time-stamped approvals predate the content: they are not approvals.
    expect(brandSendGate({ brand_send: "on", onepager_mock_approved_at: "2026-10-22T19:34:00Z", playbook_approved_at: "x" }, onList, h).reasons).toEqual([
      "the owner has not approved the brand pitch",
      "the owner has not approved the sales playbook",
    ]);
    // Any change to the content clears its approval, and the gate says so.
    const changed = brandSendGate({ brand_send: "on", ...approved }, onList, { pitch: "c".repeat(64), playbook: h.playbook });
    expect(changed.open).toBe(false);
    expect(changed.reasons).toEqual(["the brand pitch changed after it was approved; approve it again"]);
  });

  it("prices Title $25,000, Partner $5,000, Lead $10,000, Presenting $15,000 and a Product partner in kind; the goal is $25,000 raised and no exclusivity is promised", async () => {
    const m = await import("../src/shared/tlc/learningClub");
    expect(m.TLC_TIER_KEYS).toEqual(["TITLE", "PARTNER", "LEAD", "PRESENTING", "PRODUCT"]);
    expect([m.TLC_TIERS.TITLE.priceUsd, m.TLC_TIERS.PARTNER.priceUsd, m.TLC_TIERS.LEAD.priceUsd, m.TLC_TIERS.PRESENTING.priceUsd, m.TLC_TIERS.PRODUCT.priceUsd]).toEqual([25_000, 5_000, 10_000, 15_000, null]);
    expect(m.tierCashUsd("PRODUCT")).toBe(0);
    expect(m.TLC_SPONSOR_GOAL_USD).toBe(25_000);
    expect(m.TLC_COST_BUDGET_USD).toBe(15_000);
    expect(m.TLC_SPONSOR_GOAL_USD - m.TLC_COST_BUDGET_USD).toBe(m.TLC_NET_TARGET_USD);
    expect(m.TLC_PARTNERS_TO_TARGET).toBe(5);
    expect(m.TLC_TARGET_PATH).toMatch(/one Title partner at \$25,000; or a mix: at least 5 partners at \$5,000, or larger sponsors at \$10,000–\$15,000/);
    expect(m.seasonOption()).toMatch(/Partner \$15,000, Lead partner \$30,000, Presenting partner \$45,000, or Title partner \$75,000/);
    // A Title partner is the only cash partner that night; product partners are another matter.
    expect(m.titleConflict([{ id: "a", tier: "PARTNER" }], { id: "t", tier: "TITLE" })).toMatch(/only cash partner/);
    expect(m.titleConflict([{ id: "t", tier: "TITLE" }], { id: "b", tier: "LEAD" })).toMatch(/Title partner/);
    expect(m.titleConflict([{ id: "t", tier: "TITLE" }], { id: "p", tier: "PRODUCT" })).toBeNull();
    expect(m.titleConflict([{ id: "p", tier: "PRODUCT" }], { id: "t", tier: "TITLE" })).toBeNull();
    // Pace: 40% of the goal by 60 days out, 60% by 42.
    expect(m.paceCheck(60, 9_999)).toEqual({ checkpoint: 60, neededUsd: 10_000, behind: true });
    expect(m.paceCheck(42, 15_000)).toEqual({ checkpoint: 42, neededUsd: 15_000, behind: false });
    expect(m.paceCheck(50, 0)).toBeNull();
    // The ONE place "exclusivity" may appear is the sentence that refuses it, exactly once.
    const NO_EXCLUSIVITY = "we never offer or claim category exclusivity.";
    expect(m.TLC_PLAYBOOK.join(" ").split(NO_EXCLUSIVITY).length - 1).toBe(1);
    expect(m.TLC_PLAYBOOK.find((l) => l.includes(NO_EXCLUSIVITY))).toMatch(/^Sponsors in a club are complementary, never competitors/);
    for (const text of [m.TLC_PLAYBOOK.join(" ").replace(NO_EXCLUSIVITY, ""), sponsorshipAgreement({ brand: "Acme", topic: "T", eventDate: "2027-02-11", cashUsd: 5000, inKind: null, deliverables: null, dueDate: "2027-02-01" })]) {
      expect(text).not.toMatch(/exclusiv|one (sponsor )?per category|to itself/i);
    }
    expect(m.TLC_PLAYBOOK.join(" ")).toMatch(/Partner \$5,000.*Lead partner \$10,000.*Presenting partner \$15,000/);
    // The Title tier, first on the Price line, matching the brand pitch.
    const price = m.TLC_PLAYBOOK.find((l) => l.startsWith("Price:"))!;
    expect(price).toMatch(/^Price: Title partner \$25,000: one brand funds the whole room, the club is "presented by" that brand, it is the only cash partner that night, and in-kind partners need its OK\. In January the Title partner is the primary route to \$25K\. Partner \$5,000/);
    // The room is sized per club, never a fixed 25 to 40.
    const what = m.TLC_PLAYBOOK.find((l) => l.startsWith("What we sell:"))!;
    expect(what).toContain("a room sized to the partners' goals (set per club; 25 to 40 by default, 60 to 150 when the club calls for it), each guest paid to be there");
    expect(m.TLC_PLAYBOOK.join(" ")).not.toContain("a room of 25 to 40 people");
    expect(m.TLC_PLAYBOOK.join(" ")).toMatch(/\$25,000 raised from sponsors, costs up to \$15,000, \$10,000 net/);
  });

  it("the brand pitch sells real hands-on time and paid seats, and carries no script", () => {
    const html = renderBrandPitch(VIEW("Matcha & Tea", "2027-02"));
    expect(html).toMatch(/Every seat is a paid ticket \(\$10\), so everyone in the room chose to come\./);
    expect(html).toMatch(/hands-on hour/);
    expect(html).not.toMatch(/<script/);
    expect(html).toMatch(/prefers-color-scheme:dark/);
    expect(brandPitchProblems(html)).toEqual([]);
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
    month: m, topic: topics[i], origin: "TREND", angle: "an angle", why_now: "why", criteria: {}, hands_on: "make it", take_home: "a thing", teacher_profile: "an expert", ai_segment: "Guests use an AI assistant on their own notes.",
    sponsor_categories: ["A", "B", "C", "D", "E", "F"].map((c) => ({ category: `${c} category`, why: "fits", example_brands: [] })),
    sources: [{ title: "Real page", url: `https://news.example/${i}` }, { title: "Dead", url: "https://dead.example/x" }],
  })),
  // Parker's email carries nine alternatives with every set of picks (owner, 22 Oct 2026).
  alternatives: ["Knit", "Bake", "Brew", "Paint", "Pot", "Climb", "Run", "Sing", "Code"].map((t) => ({ topic: `${t} club`, origin: "TREND", reason: "people pay for it", brands: ["Brand One"] })),
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

  it("Sequoia's no swaps that month (only her reply counts); silence lets the rest proceed", async () => {
    const card = await env.WP_OS_DB.prepare("SELECT id FROM work_card WHERE kind = 'TLC_TOPICS'").first<{ id: string }>();
    // Owner, 22 Oct 2026: only her reply is a veto. Scooter's note is read and acknowledged, never obeyed.
    await env.WP_OS_DB.prepare("INSERT INTO work_card_note (id, work_card_id, author_id, body, firm_scope) VALUES ('wcn_t0', ?1, 'fu_scooter_taylor', 'no to January', 'west-peek')").bind(card!.id).run();
    await env.WP_OS_DB.prepare("INSERT INTO work_card_note (id, work_card_id, author_id, body, firm_scope) VALUES ('wcn_t1', ?1, 'fu_sequoia_taylor', 'no to February', 'west-peek')").bind(card!.id).run();
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
    expect(evs[0]!.vetoed_topics_json ?? "").not.toContain("Matcha");
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
    // 23 Oct 2026: the owner's must-pitch brands (migration 0266) came back with no address, so each is a
    // "Needs a way in" item naming its months, never a silent drop.
    const ways = (await env.WP_OS_DB.prepare("SELECT brand, state, months_json FROM tlc_way_in ORDER BY brand").all<{ brand: string; state: string; months_json: string }>()).results!;
    expect(ways).toEqual([
      { brand: "Anthropic", state: "OPEN", months_json: '["2027-01","2027-03"]' },
      { brand: "Google", state: "OPEN", months_json: '["2027-03"]' },
    ]);
  });

  it("HOLDS every brand email while the switch is off: composed, stored, nothing filed or sent", async () => {
    const out = await runDrip(env, new Date("2026-11-09T15:00:00.000Z"));
    expect(out.gate.open).toBe(false);
    expect(out.held).toBe(1);
    expect(out.awaitingApproval + out.sent).toBe(0);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM external_effect_request").first<{ n: number }>())!.n).toBe(0);
    const m = await env.WP_OS_DB.prepare("SELECT state, held_reason FROM tlc_drip_message").first<{ state: string; held_reason: string }>();
    expect(m!.state).toBe("HELD");
    expect(m!.held_reason).toMatch(/brand pitch.*playbook.*switch is off.*TLC brand sales is not on your Outside email list/);
  });

  it("with everything approved and on, each email waits for a partner's approval card", async () => {
    // The old time-stamped approvals alone open nothing.
    await env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value) VALUES ('onepager_mock_approved_at','x'),('playbook_approved_at','x') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    await env.WP_OS_DB.prepare("UPDATE tlc_setting SET value = 'on' WHERE key = 'brand_send'").run();
    const onEnv = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>);
    // Default deny: nothing is on her Outside email list until she allows it.
    expect((await runDrip(onEnv, new Date("2026-11-09T15:03:00.000Z"))).gate.reasons).toContain("TLC brand sales is not on your Outside email list — tap to allow.");
    await env.WP_OS_DB.prepare("INSERT INTO outside_email_allow (item_type, item_id, allowed, changed_by) VALUES ('JOB','tlc_brand_sales',1,'test')").run();
    expect((await runDrip(onEnv, new Date("2026-11-09T15:04:00.000Z"))).gate.reasons).toEqual(["the owner has not approved the brand pitch", "the owner has not approved the sales playbook"]);
    const h = await contentHashes(env);
    await env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value) VALUES ('pitch_approved_hash', ?1), ('playbook_approved_hash', ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(h.pitch, h.playbook).run();
    await env.WP_OS_DB.prepare("UPDATE tlc_setting SET value = 'on' WHERE key = 'brand_send'").run();
    const on = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>);
    const out = await runDrip(on, new Date("2026-11-09T15:05:00.000Z"));
    expect(out.awaitingApproval).toBe(1);
    expect(out.sent).toBe(0);
    // The request names its job, so the executor asks her list about exactly this job.
    expect((await env.WP_OS_DB.prepare("SELECT outside_job FROM external_effect_request").all<{ outside_job: string }>()).results!.map((r) => r.outside_job)).toEqual(["tlc_brand_sales"]);
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
    // A reply that is not a no puts the pitch email (PDF + call link) behind the gate, signed by Sequoia.
    const f = await env.WP_OS_DB.prepare("SELECT state, subject, body FROM tlc_pitch_followup").first<{ state: string; subject: string; body: string }>();
    expect(f!.state).toBe("HELD");
    expect(f!.subject).toBe("Leaf Co + a small room in New York");
    expect(f!.body).toMatch(/The PDF is attached, and it is also here: https:\/\/os\.joinwestpeek\.com\/api\/tlc-pitch\/[0-9a-f]{32}/);
    expect(f!.body).toMatch(/Sequoia Taylor\nWest Peek Ventures\nsequoia@westpeek\.ventures$/);
  });

  it("Sequoia decides; a counter sends the deal back to a call", async () => {
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

  it("the daily pass escalates a club short of the floor two weeks out, to Sequoia, once", async () => {
    const twoWeeks = new Date("2027-01-07T13:30:00.000Z"); // Jan club is the third Thursday, 21 Jan.
    const out = await runTlcDaily(env, twoWeeks);
    expect(out.failures).toEqual([]);
    // February (the 18th) is 42 days out the same day: its pace check runs too, and nothing is agreed.
    expect(out.goChecks).toEqual([{ month: "2027-01", checkpoint: 14, verdict: "ESCALATE" }, { month: "2027-02", checkpoint: 42, verdict: "BEHIND_PACE" }]);
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

// 22 Oct 2026: the owner had the Workshops line taken off every one-pager. The proof is now exactly
// the Rooms line and the confirmed community line, in that order; nothing else may creep back in.
describe("TLC pre-launch proof carries no Workshops line", () => {
  it("is exactly the Rooms line and the confirmed community line, and the rendered page never says Workshops", async () => {
    const { TLC_PRE_LAUNCH_PROOF } = await import("../src/shared/tlc/learningClub");
    expect(TLC_PRE_LAUNCH_PROOF).toEqual([
      "West Peek Rooms: the firm's in-person gatherings. The Learning Club is their monthly New York edition.",
      TLC_CONFIRMED_COMMUNITY_LINE,
    ]);
    expect(TLC_PRE_LAUNCH_PROOF.some((l) => /workshop/i.test(l))).toBe(false);
    for (const html of [renderBrandPitch(VIEW("Fragrance Lab", "2027-02")), renderInternalOnePager(IVIEW("Fragrance Lab", "2027-02"))]) {
      expect(html).not.toMatch(/West Peek Workshops/i);
      expect(html).not.toMatch(/West Peek Live/i);
    }
  });
});

// The owner's About block, word for word, on every one-pager (22 Oct 2026).
const TLC_ABOUT_EXACT =
  "West Peek Ventures is a venture firm and community. We have facilitated more than $100M in secondary transactions, with late-stage positions including Higgsfield, Databricks and Stripe, among others. Our community of more than 5,000 founders, operators, investors, creatives and builders meets in person through West Peek Rooms, our event series. The Learning Club is a series within Rooms: small, hands-on deep dives in New York.";
describe("TLC About blocks: the full one only inside, the community-first one for brands", () => {
  it("the internal one-pager carries the owner's exact text; the brand pitch carries the community-first text and no internal-only fact", async () => {
    const { TLC_ABOUT_WEST_PEEK, TLC_ABOUT_COMMUNITY } = await import("../src/shared/tlc/learningClub");
    expect(TLC_ABOUT_WEST_PEEK).toBe(TLC_ABOUT_EXACT);
    for (const about of [TLC_ABOUT_WEST_PEEK, TLC_ABOUT_COMMUNITY]) {
      expect(about).not.toMatch(/—|–|\$500M|Fund I\b|fund size|carry|management fee|Parker|Wynn|\bcard\b/i);
      expect(about).toMatch(/\b(We|we)\b/);
      // The only head-count either states is the confirmed 5,000.
      expect(about.match(/\d{1,3},\d{3}/g)).toEqual(["5,000"]);
    }
    expect(TLC_ABOUT_COMMUNITY).not.toMatch(/\$100M|secondary|Higgsfield|Databricks|Stripe/);
    for (const recap of [null, "Twenty-eight people made a bar."]) {
      const inside = renderInternalOnePager(IVIEW("AI Tools", "2027-03", { recap }));
      expect(inside).toContain("<h2>About West Peek Ventures</h2>");
      expect(inside).toContain(`<p>${TLC_ABOUT_EXACT}</p>`);
      expect(inside).toContain("<title>Internal: AI Tools</title>");
      const pitch = renderBrandPitch(VIEW("AI Tools", "2027-03", { recap }));
      expect(pitch).toContain(`<p>${TLC_ABOUT_COMMUNITY}</p>`);
      expect(pitch).not.toMatch(/\$100M|Higgsfield|Databricks|Stripe/);
      expect(pitch).toContain("<title>The Learning Club: AI Tools</title>");
    }
  });
});

// 22 Oct 2026: the topics email attached each one-sheet as its raw HTML source, and the owner opened
// files full of code. A one-sheet leaves only as a rendered PDF that names its topic.
describe("TLC one-sheet attachments are rendered PDFs, never HTML source", () => {
  const fixture = () => new Uint8Array(readFileSync(new URL("./fixtures/tlc-onepager-rendered.pdf", import.meta.url)));
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
  const htmlAsPdf = (html: string) => new TextEncoder().encode(`%PDF-1.4\n1 0 obj << /Title (Zero-Proof Home Bar) >> endobj\n2 0 obj << /Length ${html.length} >>\nstream\nBT (${html}) Tj ET\nendstream\nendobj\n%%EOF`);

  it("the check passes a browser-rendered one-sheet and refuses HTML written into a PDF, raw or compressed", async () => {
    const { renderedPdfProblem } = await import("../src/shared/pdf/renderedPdf");
    expect(await renderedPdfProblem(fixture(), "Zero-Proof Home Bar")).toBeNull();
    expect(await renderedPdfProblem(fixture(), "Fragrance Lab")).toMatch(/does not name "Fragrance Lab"/);
    const html = renderBrandPitch(VIEW("Zero-Proof Home Bar", "2027-01"));
    expect(await renderedPdfProblem(new TextEncoder().encode(html), "Zero-Proof Home Bar")).toBe("the file is not a PDF");
    expect(await renderedPdfProblem(htmlAsPdf(html), "Zero-Proof Home Bar")).toMatch(/HTML source code \(<!doctype\)/);
    for (const tag of ['<div class="fact">', "<html lang=\"en\">", 'style="color:red"']) {
      expect(await renderedPdfProblem(htmlAsPdf(`Zero-Proof Home Bar ${tag}`), "Zero-Proof Home Bar")).toMatch(/HTML source code/);
    }
    const deflated = new Uint8Array(deflateSync(Buffer.from(`BT (${html}) Tj ET`)));
    const head = new TextEncoder().encode(`%PDF-1.4\n1 0 obj << /Title (Zero-Proof Home Bar) >> endobj\n2 0 obj << /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`);
    const tail = new TextEncoder().encode("\nendstream\nendobj\n%%EOF");
    expect(await renderedPdfProblem(new Uint8Array([...head, ...deflated, ...tail]), "Zero-Proof Home Bar")).toMatch(/HTML source code/);
  });

  it("the topics email attaches each one-sheet as application/pdf, and a render that is HTML source is never attached", async () => {
    const { onePagerAttachments } = await import("../src/worker/services/learningClub");
    await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, topic) VALUES ('tlce_pdf_guard', '2031-07', '2031-07-15', 'Zero-Proof Home Bar')").run();
    const seen: string[] = [];
    const good = await onePagerAttachments(env, ["tlce_pdf_guard"], async (html) => { seen.push(html); return { pdfBase64: b64(fixture()), pageCount: 1 }; });
    expect(seen[0]).toContain("<title>The Learning Club: Zero-Proof Home Bar</title>");
    expect(seen[1]).toContain("<title>Internal: Zero-Proof Home Bar</title>");
    expect(good.problems).toEqual([]);
    expect(good.attachments.map((a) => [a.filename, a.contentType])).toEqual([
      ["TLC July 2031 - Zero-Proof Home Bar - brand pitch.pdf", "application/pdf"],
      ["TLC July 2031 - Zero-Proof Home Bar - internal one-pager.pdf", "application/pdf"],
    ]);
    for (const a of good.attachments) expect(Buffer.from(a.content, "base64").subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const bad = await onePagerAttachments(env, ["tlce_pdf_guard"], async (html) => ({ pdfBase64: b64(htmlAsPdf(html)), pageCount: 1 }));
    expect(bad.attachments).toEqual([]);
    expect(bad.problems[0]).toMatch(/^TLC July 2031 - Zero-Proof Home Bar - brand pitch\.pdf: the PDF carries HTML source code/);
    const long = await onePagerAttachments(env, ["tlce_pdf_guard"], async () => ({ pdfBase64: b64(fixture()), pageCount: 2 }));
    expect(long.attachments).toEqual([]);
    expect(long.problems).toEqual(["TLC July 2031 - Zero-Proof Home Bar - brand pitch.pdf: it ran to 2 pages", "TLC July 2031 - Zero-Proof Home Bar - internal one-pager.pdf: it ran to 2 pages"]);
    const none = await onePagerAttachments(env, ["tlce_pdf_guard"], async () => ({ pdfBase64: null, reason: "no browser" }));
    expect(none).toEqual({ attachments: [], problems: ["TLC July 2031 - Zero-Proof Home Bar - brand pitch.pdf: no browser", "TLC July 2031 - Zero-Proof Home Bar - internal one-pager.pdf: no browser"] });
    await env.WP_OS_DB.prepare("DELETE FROM tlc_event WHERE id = 'tlce_pdf_guard'").run();
  });
});
