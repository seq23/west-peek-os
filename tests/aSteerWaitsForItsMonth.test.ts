import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { RouteContext } from "../src/worker/router";
import { actorFromIdentity } from "../src/worker/services/authorize";
import { sweepIdentity } from "../src/worker/services/workSweep";
import {
  handleGeneratePacket,
  handleListPackets,
  handleWithdrawSteer,
  openPacketCard,
  queueDraft,
  runMonthlyRoomProposal,
  runStage,
  type PacketRow,
} from "../src/worker/services/roomPacket";
import { liveSteers, recordSteer, steerForMonth } from "../src/worker/services/monthSteer";
import { classifyAsk, deliveryMonth, dueOn, steerLines } from "../src/shared/events/monthlyPlan";
import { computeNextRun } from "../src/worker/services/jobs";

/**
 * A ONE-OFF IS BUILT NOW; A STEER WAITS FOR ITS MONTH (18 Sep 2026).
 *
 * ─── Her words ─────────────────────────────────────────────────────────────────────────────────
 *
 *   "if i make an ask of Parker for next month's proposal or ask for a one-off that is 2 diff
 *    things: a one off should be delivered and acted upon immediately; asking for a specific topic
 *    or angle to next months propoals should come when the month's proposal comes"
 *
 * ─── What this file pins, and why each one is here ────────────────────────────────────────────
 *
 * 1. THE DEFECT ITSELF, as a standing assertion rather than a memory. Before 0194 an ask naming
 *    November, given in September, opened a card in state OPEN titled "Parker: build the November
 *    2026 Room packet" and the sweep would have built and emailed it that afternoon. The first
 *    describe block below is that scenario; it now ends with nothing built.
 *
 * 2. THE STEER'S WORDS REACH THE PACKET — not "a column was written". The concepts prompt is
 *    captured and her sentence is read back out of it. The repo's own standard: a test proves the
 *    steering, not the provider.
 *
 * 3. THE CADENCE, so that moving it fails here. The floor (1st of the month prior), the zone (her
 *    clock, across a DST change), the hourly backstop, and the backstop being LOUD.
 */

let t: TestDb;
let env: Env;

/** September. Everything below is "what happens if she says this today". */
const SEPT = "2026-09-18T15:00:00.000Z";
/** The first tick of 1 October, which is when November's packets are due. */
const OCT_1 = "2026-10-01T06:30:00.000Z";

const actor = () => actorFromIdentity({ ...sweepIdentity(), id: "fu_sequoia_taylor" });
const ctx = (body?: unknown, params: Record<string, string> = {}, method = "POST"): RouteContext => ({
  request: new Request("https://os.joinwestpeek.com/api/rooms/packets", {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { "content-type": "application/json" },
  }),
  env,
  identity: { ...sweepIdentity(), id: "fu_sequoia_taylor" },
  params,
});

const row = async (id: string): Promise<PacketRow> =>
  (await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE id = ?1").bind(id).first<PacketRow>())!;

const packetsFor = async (month: string): Promise<PacketRow[]> =>
  (await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE proposed_for_month = ?1").bind(month).all<PacketRow>()).results ?? [];

beforeAll(async () => {
  /*
   * THE CLOCK IS PART OF THE FIXTURE. The request door classifies an ask by the calendar (`now` is
   * read inside `handleGeneratePacket`), and these scenarios are "what happens if she says this on
   * 18 September". Left on the real clock the first three tests were true until 30 Sep and false
   * from 1 Oct, when November is no longer a later month — a defect in the test, not the door
   * (found 1 Oct 2026, the first day it could fail). Only `Date` is faked: timers stay real, so the
   * local D1 and the request path keep running normally.
   */
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(SEPT));
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs } as Partial<Env>);
});
afterAll(async () => {
  vi.useRealTimers();
  await disposeTestDb(t);
});

// ── 1 · The two kinds of ask ───────────────────────────────────────────────────────────────────

describe("a steer for November is not built in September", () => {
  it("refuses to guess which kind of ask it is, and says both readings", async () => {
    const res = await handleGeneratePacket(
      ctx({ audience: "Black lawyers — several distinct name ideas this time", month: "2026-11" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; readings: string[]; intents: Array<{ intent: string }> };
    expect(body.error).toBe("intent_required");
    // BOTH readings, in words, because the refusal is only useful if it says what the choice is.
    expect(body.readings).toHaveLength(2);
    expect(body.readings[0]).toMatch(/[Bb]uild it now/);
    expect(body.readings[1]).toMatch(/steer/);
    expect(body.intents.map((i) => i.intent)).toEqual(["NOW", "STEER"]);
    // AND NOTHING WAS BUILT. This is the assertion that fails if the refusal ever becomes a guess.
    expect(await packetsFor("2026-11")).toHaveLength(0);
  });

  it("records a steer against the month it is FOR, and builds nothing", async () => {
    const res = await handleGeneratePacket(
      ctx({
        audience: "Black lawyers",
        month: "2026-11",
        intent: "STEER",
        notes: "catchy distinct names, and an experience that draws the sponsors as well as the people",
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { steer: { for_month: string; words: string }; queued: boolean; dueOn: string };
    expect(body.queued).toBe(false);
    // The month it is FOR, not the month it arrived in.
    expect(body.steer.for_month).toBe("2026-11");
    expect(body.dueOn).toBe("2026-10-01");
    // Her words, unedited.
    expect(body.steer.words).toContain("catchy distinct names");

    // NO PACKET, NO DRAFT, NO CARD. The whole requirement, as three queries.
    expect(await packetsFor("2026-11")).toHaveLength(0);
    const cards = await env.WP_OS_DB.prepare(
      "SELECT COUNT(*) AS n FROM work_card WHERE title LIKE '%November 2026%'",
    ).first<{ n: number }>();
    expect(cards?.n).toBe(0);
  });

  it("a one-off opens Parker's card in the request path, with no tick in between", async () => {
    const res = await handleGeneratePacket(
      ctx({ audience: "founders who sold to private equity", month: "2027-03", intent: "NOW" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { cardId: string; queued: boolean };
    expect(body.queued).toBe(true);
    /*
     * ZERO WAIT, PROVEN AS A STATE RATHER THAN A CLAIM: the card exists and is OPEN before the
     * route returned, so no scheduled job ran between her pressing the button and Parker having it.
     */
    const card = await env.WP_OS_DB.prepare("SELECT state, owner_id FROM work_card WHERE id = ?1")
      .bind(body.cardId)
      .first<{ state: string; owner_id: string }>();
    expect(card?.state).toBe("OPEN");
    expect(card?.owner_id).toBe("aie_parker");
  });

  it("an ask for the month already being delivered needs no choice — there is nothing to hold it for", () => {
    const delivering = deliveryMonth(SEPT);
    expect(delivering).toBe("2026-10");
    const now = classifyAsk({ month: delivering, declared: null, nowIso: SEPT });
    expect(now.intent).toBe("NOW");
    // And a month beyond it is the case that must ask.
    expect(classifyAsk({ month: "2026-11", declared: null, nowIso: SEPT }).intent).toBeNull();
  });
});

// ── 2 · The steer survives, and its words reach the packet ─────────────────────────────────────

describe("the steer reaches the packet it was given for", () => {
  it("survives to 1 October and is carried into the concepts prompt in her own words", async () => {
    // November's ROOM is SET in the plan ("Black lawyers"), so this exercises the merge of a
    // standing plan steer with the one she typed above.
    const before = await liveSteers(env, "west-peek", "2026-11", "ROOM");
    expect(before).toHaveLength(1);
    expect(before[0]!.delivered_packet_id).toBeNull();

    // The calendar rolls over. The job mints November's packets.
    const out = await runMonthlyRoomProposal(env, actor(), OCT_1, "America/Chicago");
    expect(out.generated).toBe(true);
    expect(out.detail).toContain("2026-11");
    const draft = await row(out.packetId!);
    expect(draft.proposed_for_month).toBe("2026-11");

    // Drive the chain to CONCEPTS and capture the prompt the model is actually given.
    const prompts: string[] = [];
    const deps = {
      research: async () => ({ ok: true as const, citations: [], text: JSON.stringify({ results: [] }), detail: "none" }),
      judge: async () => ({ ok: true as const, text: "", detail: "none" }),
      search: async () => ({ ok: true as const, hits: [], citations: [], aiRunId: null, detail: "none" }),
      synthesise: async (prompt: string) => {
        prompts.push(prompt);
        return { text: "", aiRunId: null };
      },
    } as never;

    let current = draft;
    for (let i = 0; i < 6 && current.build_stage !== "CONCEPTS"; i += 1) {
      await runStage(env, current, deps);
      current = await row(draft.id);
    }
    expect(current.build_stage).toBe("CONCEPTS");
    await runStage(env, current, deps).catch(() => undefined);

    const conceptsPrompt = prompts.find((p) => p.includes("THE TOPIC IS ONE SUBJECT")) ?? prompts.join("\n");
    /*
     * HER WORDS, READ BACK OUT OF THE PROMPT. Not "the steer column is non-null" — the sentence she
     * typed on 18 September is in the text a model is about to be given on 1 October.
     */
    expect(conceptsPrompt).toContain("catchy distinct names");
    expect(conceptsPrompt).toContain("draws the sponsors as well as the people");
    // And the plan's standing steer for the month is still in there beside it.
    expect(conceptsPrompt).toContain("Do not propose that title again");

    // It is marked as having reached a packet, so the board can stop saying she is owed it.
    const after = await liveSteers(env, "west-peek", "2026-11", "ROOM");
    expect(after[0]!.delivered_packet_id).toBe(draft.id);
  });

  it("two steers for one month both survive, oldest first, and the later one is named as outranking", async () => {
    await recordSteer(env, actor(), { month: "2027-01", stream: "ROOM", words: "first thought: general counsel" });
    await recordSteer(env, actor(), { month: "2027-01", stream: "ROOM", words: "second thought: make it founders instead" });
    const merged = await steerForMonth(env, "west-peek", "2027-01", "ROOM", null);
    expect(merged.rows).toHaveLength(2);
    // BOTH, IN ORDER. Replacing the first would lose an instruction she gave with no trace.
    expect(merged.text!.indexOf("first thought")).toBeLessThan(merged.text!.indexOf("second thought"));
    // And the conflict rule is stated rather than left to the model's taste.
    expect(merged.text).toContain("the LAST one is what she wants");
  });

  it("a steer she takes back does not reach the packet", async () => {
    const steer = await recordSteer(env, actor(), { month: "2027-02", stream: "WORKSHOP", words: "do something about pricing" });
    expect((await steerForMonth(env, "west-peek", "2027-02", "WORKSHOP", null)).text).toContain("pricing");
    const res = await handleWithdrawSteer(ctx(undefined, { id: steer.id }));
    expect(res.status).toBe(200);
    // Withdrawn is a column, not a delete: the record of what she asked for survives.
    const still = await env.WP_OS_DB.prepare("SELECT withdrawn_at, words FROM evt_month_steer WHERE id = ?1")
      .bind(steer.id)
      .first<{ withdrawn_at: string | null; words: string }>();
    expect(still?.withdrawn_at).toBeTruthy();
    expect(still?.words).toContain("pricing");
    // But it no longer reaches Parker.
    expect((await steerForMonth(env, "west-peek", "2027-02", "WORKSHOP", null)).text).toBeNull();
  });

  it("she can see what Parker has been told before the month comes round", async () => {
    const res = await handleListPackets(ctx(undefined, {}, "GET"));
    const body = (await res.json()) as { steers: Array<{ for_month: string; words: string; withdrawn_at: string | null }> };
    // An instruction given in September that is invisible until October is one she cannot correct.
    const live = body.steers.filter((s) => !s.withdrawn_at);
    expect(live.some((s) => s.for_month === "2027-01" && s.words.includes("founders"))).toBe(true);
  });

  it("steerLines keeps the plan's standing steer and hers in one string, and is null when there is nothing", () => {
    expect(steerLines(null, [])).toBeNull();
    expect(steerLines("   ", ["  "])).toBeNull();
    expect(steerLines("the plan says X", [])).toBe("the plan says X");
    const both = steerLines("the plan says X", ["she says Y"])!;
    expect(both.indexOf("the plan says X")).toBeLessThan(both.indexOf("she says Y"));
  });
});

// ── 3 · The cadence ────────────────────────────────────────────────────────────────────────────

describe("the cadence, and a test that fails if it moves", () => {
  it("delivers on the 1st of the month prior, on HER clock, across the November clock change", () => {
    /*
     * 2026-11-01T04:30Z is 2026-10-31 23:30 in Chicago (still CDT, UTC-5 — the change is at 02:00
     * local on 1 November). Read in UTC that instant is already November and would mint DECEMBER's
     * packets a day early by her calendar. Read on her clock it is still October, so November is
     * what is being delivered.
     */
    expect(deliveryMonth("2026-11-01T04:30:00.000Z")).toBe("2026-12");
    expect(deliveryMonth("2026-11-01T04:30:00.000Z", "America/Chicago")).toBe("2026-11");
    /*
     * 2026-11-01T06:30Z is 01:30 in Chicago, STILL CDT (UTC-5), and now genuinely 1 November there.
     * December is due.
     */
    expect(deliveryMonth("2026-11-01T06:30:00.000Z", "America/Chicago")).toBe("2026-12");
    /*
     * AND AFTER THE CLOCKS GO BACK the offset is different and the answer is still right — this is
     * the assertion a hardcoded -5 or -6 would fail. 2026-11-01T08:30Z is 02:30 CST (UTC-6).
     */
    expect(deliveryMonth("2026-11-01T08:30:00.000Z", "America/Chicago")).toBe("2026-12");
    // Summer, for contrast: 2026-07-01T04:30Z is 30 June 23:30 CDT.
    expect(deliveryMonth("2026-07-01T04:30:00.000Z", "America/Chicago")).toBe("2026-07");

    // The due date is derived from the constant, in both directions across a year boundary.
    expect(dueOn("2026-11")).toBe("2026-10-01");
    expect(dueOn("2027-01")).toBe("2026-12-01");
  });

  it("IT IS A FLOOR, NOT A WINDOW: a tick on the 9th because the 1st was missed still delivers", async () => {
    // 2027-04 has no packet and no plan entry, so Parker picks the topic himself.
    const out = await runMonthlyRoomProposal(env, actor(), "2027-03-09T14:00:00.000Z", "America/Chicago");
    expect(out.generated).toBe(true);
    expect(out.detail).toContain("2027-04");
    expect(out.detail).toContain("due 2027-03-01");
  });

  it("the job row says hourly, on her clock — and this fails if either moves", async () => {
    const job = await env.WP_OS_DB.prepare(
      "SELECT schedule_kind, interval_minutes, daily_at_tz, status FROM scheduled_job WHERE job_key = 'monthly_room_proposal'",
    ).first<{ schedule_kind: string; interval_minutes: number | null; daily_at_tz: string | null; status: string }>();
    expect(job).toBeTruthy();
    // NOT fifteen minutes. Ninety-six ticks a day to catch a miss that should not happen is the
    // runaway shape 0193 removed from the deck lane.
    expect(job!.schedule_kind).toBe("INTERVAL");
    expect(job!.interval_minutes).toBe(60);
    // The zone is STORED rather than a UTC hour being guessed — the mechanism 0193 introduced.
    expect(job!.daily_at_tz).toBe("America/Chicago");
    /*
     * AND STORING THE ZONE DOES NOT ACCIDENTALLY RESCHEDULE IT. `computeNextRun` returns on the
     * INTERVAL branch before it reads a zone, so the cadence is exactly one hour and every other
     * job in the table is untouched by this column being set here.
     */
    const from = new Date("2026-09-18T15:00:00.000Z");
    const next = computeNextRun(
      { schedule_kind: "INTERVAL", interval_minutes: 60, daily_at_utc: null, daily_at_tz: "America/Chicago" },
      from,
    );
    expect(next).toBe("2026-09-18T16:00:00.000Z");
  });
});

// ── 4 · The backstop is a backstop, and it is loud ─────────────────────────────────────────────

describe("the poll is a safety net that says when it catches something", () => {
  it("a draft the request path never opened a card for is reported as a DEFECT, not a quiet save", async () => {
    // The state the event path is supposed to make impossible: a draft with no card.
    const orphan = await queueDraft(env, actor(), {
      month: "2027-06",
      origin: "PARTNER_BRIEF",
      brief: { audience: "nobody opened my card", month: "2027-06", city: null, sponsorProspects: [], notes: null },
    });
    expect(orphan.work_card_id).toBeNull();

    const out = await runMonthlyRoomProposal(env, actor(), SEPT, "America/Chicago");
    expect(out.packetId).toBe(orphan.id);
    // LOUD. A run that quietly repairs a defect in the request path is how a broken door stays
    // broken for a month.
    expect(out.backstopCaught).toBe(true);
    expect(out.detail).toContain("DEFECT");
    expect(out.detail).toMatch(/request path/);
    // The work still runs — the reporting never holds the work hostage.
    const card = await env.WP_OS_DB.prepare("SELECT state FROM work_card WHERE id = ?1")
      .bind((await row(orphan.id)).work_card_id)
      .first<{ state: string }>();
    expect(card?.state).toBe("OPEN");
    // And the partners were told, rather than it living only in a run summary nobody opens.
    const notice = await env.WP_OS_DB.prepare(
      "SELECT COUNT(*) AS n FROM notification WHERE object_id = ?1 AND severity = 'WARNING'",
    ).bind(orphan.id).first<{ n: number }>();
    expect(notice?.n ?? 0).toBeGreaterThan(0);
  });

  it("a card a human CANCELLED is re-opened without crying defect — the two are told apart", async () => {
    const draft = await queueDraft(env, actor(), {
      month: "2027-07",
      origin: "PARTNER_BRIEF",
      brief: { audience: "cancelled then resumed", month: "2027-07", city: null, sponsorProspects: [], notes: null },
    });
    const opened = await openPacketCard(env, draft);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(opened.cardId).run();

    const out = await runMonthlyRoomProposal(env, actor(), SEPT, "America/Chicago");
    expect(out.packetId).toBe(draft.id);
    expect(out.backstopCaught).toBeFalsy();
    expect(out.detail).not.toContain("DEFECT");
    expect(out.detail).toContain("cancelled");
  });
});
