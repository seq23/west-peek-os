import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { TLC_ALTERNATIVES, topicsEmail, topicsEmailProblems, type TopicsEmailAlternative, type TopicsEmailPick } from "../src/shared/tlc/learningClub";
import { openTopicsCard, runTlcCard } from "../src/worker/services/learningClub";
import { sweepOnce } from "../src/worker/services/workSweep";

/**
 * PARKER'S TOPICS EMAIL (owner, 22 Oct 2026). What has to be true:
 *  - every month is in it, or it does not go ("only gave 2 picks Jan and Feb");
 *  - each pick carries the glossy one-sheet a brand would see, linked and attached;
 *  - nine alternatives, each with a one-line reason and the brands that would pay;
 *  - none of Parker's working notes ("I don't need to see that he rejected trading for Jan");
 *  - picks already chosen are kept, and a second topics card never opens for months a live one holds;
 *  - a search no lane could serve holds the card and spends no attempt, so the owner gets no STUCK email.
 */

const MONTHS = ["2027-01", "2027-02", "2027-03"];
const pick = (month: string, topic: string): TopicsEmailPick => ({ month, topic, origin: "OWNER_IDEA", angle: `${topic}, hands on`, categories: ["A", "B", "C", "D", "E"], onePagerUrl: `https://os.joinwestpeek.com/api/tlc/events/tlc_${month}/onepager` });
const alts = (n: number): TopicsEmailAlternative[] => Array.from({ length: n }, (_, i) => ({ topic: `Alt topic ${i + 1}`, origin: (i % 2 ? "TREND" : "BRANDS_SPENDING") as "TREND" | "BRANDS_SPENDING", reason: "People already pay for it.", brands: ["Brand A", "Brand B"] }));
const three = [pick("2027-01", "Zero-Proof Home Bar"), pick("2027-02", "Fragrance Lab"), pick("2027-03", "AI Tools for Your Work")];

describe("the topics email, pure", () => {
  it("goes with three picks and nine alternatives, and carries both", () => {
    expect(topicsEmailProblems(MONTHS, three, alts(9))).toEqual([]);
    const e = topicsEmail({ months: MONTHS, picks: three, alternatives: alts(9), goAheadOn: "2026-10-25" });
    const text = JSON.stringify(e);
    for (const p of three) expect(text).toContain(p.topic);
    for (const p of three) expect(text).toContain(p.onePagerUrl);
    for (let i = 1; i <= 9; i++) expect(text).toContain(`Alt topic ${i} (${i % 2 ? "Brands spending now" : "Trend"}): People already pay for it. Brands that would pay: Brand A, Brand B.`);
    // Every section fits the exec-email cap of six lines, so nothing is folded away below the rule.
    for (const s of e.sections) expect(s.bullets.length).toBeLessThanOrEqual(6);
  });
  it("refuses an email missing a month", () => {
    expect(topicsEmailProblems(MONTHS, three.slice(0, 2), alts(9)).join()).toMatch(/March 2027 has 0 picks/);
    expect(() => topicsEmail({ months: MONTHS, picks: three.slice(0, 2), alternatives: alts(9), goAheadOn: "2026-10-25" })).toThrow(/must not go/);
  });
  it("refuses anything but nine alternatives, each with a reason and a brand", () => {
    expect(topicsEmailProblems(MONTHS, three, alts(8)).join()).toMatch(/8 alternatives; it needs 9/);
    expect(topicsEmailProblems(MONTHS, three, [...alts(8), { topic: "X", origin: "TREND" as const, reason: "y", brands: [] }]).join()).toMatch(/names no brand/);
    expect(topicsEmailProblems(MONTHS, three, [...alts(8), { topic: "Fragrance Lab", origin: "TREND" as const, reason: "y", brands: ["b"] }]).join()).toMatch(/repeats a pick/);
  });
  it("refuses Parker's working notes: what he rejected stays on the card", () => {
    const noted = [{ ...three[0]!, angle: "Rejected for January: Trading & Investing 'Money Reset'." }, three[1]!, three[2]!];
    expect(topicsEmailProblems(MONTHS, noted, alts(9)).join()).toMatch(/working notes/);
    const altNoted = [...alts(8), { topic: "Money Reset", origin: "OWNER_IDEA" as const, reason: "Ruled out for now.", brands: ["b"] }];
    expect(topicsEmailProblems(MONTHS, three, altNoted).join()).toMatch(/working notes/);
  });
});

let t: TestDb;
let env: Env;
const NOW = new Date("2026-10-22T20:00:00.000Z");
const live = async (): Promise<boolean> => true;
const answer = (months: string[], topics: string[], altCount = TLC_ALTERNATIVES) => JSON.stringify({
  picks: months.map((m, i) => ({
    month: m, topic: topics[i], origin: "TREND", angle: "an angle", why_now: "why", criteria: {}, hands_on: "make it", take_home: "a thing", teacher_profile: "an expert",
    sponsor_categories: ["A", "B", "C", "D", "E", "F"].map((c) => ({ category: `${c} category`, why: "fits", example_brands: [] })),
    sources: [{ title: "Real page", url: `https://news.example/${i}` }],
  })),
  alternatives: Array.from({ length: altCount }, (_, i) => ({ topic: `Alternative ${"ABCDEFGHI"[i]}`, origin: "BRANDS_SPENDING", reason: "a one-line reason", brands: ["Brand One", "Brand Two"] })),
});
const sends: string[] = [];

beforeAll(async () => {
  t = await createTestDb();
  env = { ...makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>), RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Env;
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_parker','aie_wynn')").run();
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) { sends.push(String(init?.body)); return new Response(JSON.stringify({ id: `re_${sends.length}` }), { status: 200 }); }
    return new Response("ok", { status: 200 });
  });
});
afterAll(async () => { vi.unstubAllGlobals(); await disposeTestDb(t); });
beforeEach(() => { sends.length = 0; });

const cardState = async (id: string) => (await env.WP_OS_DB.prepare("SELECT state, COALESCE(work_attempts,0) AS work_attempts, lease_until FROM work_card WHERE id = ?1").bind(id).first<{ state: string; work_attempts: number; lease_until: string | null }>())!;

describe("the topics card in the database", () => {
  let cardId = "";
  it("keeps picks already chosen, and never opens a second card for months a live one holds", async () => {
    const opened0 = await openTopicsCard(env, NOW); // creates the three months
    // The partners' chosen picks, recorded on the months (no packet yet).
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(opened0.cardId).run();
    const chosen: Record<string, string> = { "2027-01": "Zero-Proof Home Bar", "2027-02": "Fragrance Lab", "2027-03": "AI Tools for Your Work" };
    for (const [m, topic] of Object.entries(chosen)) await env.WP_OS_DB.prepare("UPDATE tlc_event SET topic = ?2 WHERE month = ?1").bind(m, topic).run();
    const opened = await openTopicsCard(env, NOW);
    expect(opened.opened).toBe(true);
    cardId = opened.cardId!;
    const again = await openTopicsCard(env, NOW);
    expect(again.opened).toBe(false);
    expect(again.cardId).toBe(cardId);
    // Months shift (January gets its packet elsewhere), so the title would differ: still no second card.
    await env.WP_OS_DB.prepare("UPDATE tlc_event SET packet_json = '{}' WHERE month = '2027-01'").run();
    const shifted = await openTopicsCard(env, NOW);
    expect(shifted.opened).toBe(false);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card WHERE kind = 'TLC_TOPICS' AND state != 'CANCELLED'").first<{ n: number }>())!.n).toBe(1);
    await env.WP_OS_DB.prepare("UPDATE tlc_event SET packet_json = NULL WHERE month = '2027-01'").run();
  });

  it("a search no lane could serve holds the card: no attempt spent, no block, no email", async () => {
    const out = await sweepOnce(env, NOW, {
      tlc: (e, c) => runTlcCard(e, c, { search: async () => ({ ok: false, text: "", detail: "provider_failure:subscription_seat_failed:Codex CLI: The 'gpt-5.5' model is not supported" }), urlCheck: live, now: NOW }),
    });
    expect(out.outcome).toBe("PROGRESSED");
    const c = await cardState(cardId);
    expect(c.state).not.toBe("BLOCKED");
    expect(c.work_attempts).toBe(0);
    expect(c.lease_until).toBe("2026-10-22T20:30:00.000Z");
    expect(sends).toHaveLength(0);
    await env.WP_OS_DB.prepare("UPDATE work_card SET lease_until = NULL WHERE id = ?1").bind(cardId).run();
  });

  it("a set missing a month, or short of nine alternatives, is never written or sent", async () => {
    for (const text of [answer(["2027-01", "2027-02"], ["Zero-Proof Home Bar", "Fragrance Lab"]), answer(MONTHS, ["a", "b", "c"], 8)]) {
      await sweepOnce(env, NOW, { tlc: (e, c) => runTlcCard(e, c, { search: async () => ({ ok: true, text, detail: "ok" }), urlCheck: live, now: NOW }) });
      await env.WP_OS_DB.prepare("UPDATE work_card SET lease_until = NULL, work_attempts = 0, state = 'OPEN' WHERE id = ?1").bind(cardId).run();
    }
    expect(sends).toHaveLength(0);
    const evs = (await env.WP_OS_DB.prepare("SELECT status FROM tlc_event ORDER BY month").all<{ status: string }>()).results!;
    expect(evs.map((e) => e.status)).toEqual(["PLANNING", "PLANNING", "PLANNING"]);
  });

  it("sends both partners the three chosen picks with their one-sheets attached, and nine alternatives", async () => {
    // The model offers a different January; the chosen one is kept.
    const text = answer(MONTHS, ["Trading & Investing", "Fragrance Lab", "AI Tools for Your Work"]);
    const out = await sweepOnce(env, NOW, { tlc: (e, c) => runTlcCard(e, c, { search: async () => ({ ok: true, text, detail: "ok" }), urlCheck: live, now: NOW }) });
    expect(out.outcome).toBe("PROGRESSED");
    const evs = (await env.WP_OS_DB.prepare("SELECT month, topic, status FROM tlc_event ORDER BY month").all<{ month: string; topic: string; status: string }>()).results!;
    expect(evs.map((e) => [e.month, e.topic, e.status])).toEqual([
      ["2027-01", "Zero-Proof Home Bar", "TOPIC_PROPOSED"],
      ["2027-02", "Fragrance Lab", "TOPIC_PROPOSED"],
      ["2027-03", "AI Tools for Your Work", "TOPIC_PROPOSED"],
    ]);
    expect(sends).toHaveLength(2);
    for (const raw of sends) {
      const body = JSON.parse(raw) as { text: string; attachments?: Array<{ filename: string }> };
      for (const m of ["January 2027: Zero-Proof Home Bar", "February 2027: Fragrance Lab", "March 2027: AI Tools for Your Work"]) expect(body.text).toContain(m);
      for (const l of "ABCDEFGHI") expect(body.text).toContain(`Alternative ${l} (Brands spending now): a one-line reason. Brands that would pay: Brand One, Brand Two.`);
      expect(body.text).toContain("/api/tlc/events/tlc_2027-01/onepager");
      expect(body.text).not.toMatch(/reject|not picked|ruled out/i);
      expect(body.attachments?.map((a) => a.filename)).toEqual(["TLC January 2027 - Zero-Proof Home Bar.html", "TLC February 2027 - Fragrance Lab.html", "TLC March 2027 - AI Tools for Your Work.html"]);
    }
  });
});
