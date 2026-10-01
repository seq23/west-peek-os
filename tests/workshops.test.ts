import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saidNothing } from "./helpers/interpret";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { actorFromIdentity } from "../src/worker/services/authorize";
import { sweepIdentity, sweepOnce } from "../src/worker/services/workSweep";
import {
  handleGeneratePacket,
  handleGetPacket,
  handleListPackets,
  openPacketCard,
  queueDraft,
  renderWorkshopPacketText,
  runMonthlyRoomProposal,
  runRoomPacketCard,
  scheduleRoom,
  decidePacket,
  workshopSummary,
  workshopViewOf,
  type ChainDeps,
  type PacketRow,
} from "../src/worker/services/roomPacket";
import { WORKSHOP_SERIES, WORKSHOP_WHERE, computeWorkshopEconomics, normaliseSponsorship, parseWorkshopConcepts, parseWorkshopPacket, verifyWorkshopPacket } from "../src/shared/events/workshopPacket";
import { deliveryMonth, dueOn, planFor } from "../src/shared/events/monthlyPlan";
import { EVENT_KIT_PROMPT_MARKER } from "../src/shared/events/eventKit";
import { eventKitOf } from "../src/worker/services/eventKit";
import { renderWorkshopHtml } from "../src/shared/events/roomPacketPdf";
import { lintExecEmail, renderExecEmail } from "../src/shared/email/execEmail";
import { skillsForMachines } from "../src/shared/skills/library";
import type { RouteContext } from "../src/worker/router";

/**
 * MONTHLY WORKSHOPS, THE SAME CHAIN AS ROOMS (16 Sep 2026).
 *
 * Operator: "we are introducing monthly workshops in addition to Rooms … the same workflow as
 * Rooms: a packet with three concepts compared, one chosen" — and "WORKSHOPS ARE VIRTUAL ONLY."
 * September and November are set; October and December are Parker's to propose. This proves,
 * without a model or a network: the monthly job proposes BOTH kinds once per month; the request
 * form's Workshop switch lands a WORKSHOP draft (a set month keeps the partners' title); the
 * chain runs a SET topic with the title preserved and an OPEN month with three concepts; the
 * packet is emailed once to both partners through the exec-email formatter; and a Workshop packet
 * NEVER carries a venue or a venue cost — not in the rows, not in the text, not in the PDF.
 */

let t: TestDb;
let env: Env;
const NOW = "2026-09-16T12:00:00.000Z";
const LIVE_1 = "https://community.example/threads/ai-for-solopreneurs";
const LIVE_2 = "https://survey.example/2026/small-business-ai";
const DEAD = "https://dead.example/gone";
const GUEST_PAGE = "https://guest.example/about";

const notesJson = JSON.stringify({ results: [
  { fact: "Solopreneurs ask most about replacing admin hours with AI, not marketing", source: "Community Example", url: LIVE_1, date: "2026-08" },
  { fact: "61% of small businesses tried an AI tool in the last 12 months; 22% kept one", source: "Survey Example", url: LIVE_2, date: "2026-07" },
  { fact: "A dead page", source: "dead", url: DEAD },
  { fact: "A guest who teaches this", source: "Guest Example", url: GUEST_PAGE, date: "2026-05" },
] });
const verdictsJson = JSON.stringify({ verdicts: [
  { url: LIVE_1, keep: true, reason: "a forum where they actually ask" },
  { url: LIVE_2, keep: true, reason: "a dated survey" },
  { url: GUEST_PAGE, keep: true, reason: "a practitioner's own page" },
] });

/**
 * THREE ANGLES ON ONE TOPIC. Every angle echoes `angle_on` — a different value on any of them and
 * the parse returns null, which is what the rejection tests below rely on.
 */
const SET_TOPIC = "How to use AI for small businesses / solopreneurs";
const OPEN_TOPIC = "how to price a service business";
const conceptsJson = (set: boolean, over: { angleOn?: string[]; topic?: string } = {}) => {
  const topic = set ? SET_TOPIC : (over.topic ?? OPEN_TOPIC);
  const on = over.angleOn ?? [topic, topic, topic];
  return JSON.stringify({
    topic,
    concepts: [
      { title: "The AI Back Office, in an hour", angle_on: on[0], angle_kind: "NAME", who_its_for: "solopreneurs billing by the hour", promise: "Leave with three admin tasks handed to an AI tool, set up and tested", mode: "DO", signature_exercise: "each person automates one real task live in a breakout", leave_with: "a filled-in automation checklist", facilitator: { name: "Scooter Taylor", kind: "PARTNER", why: "runs an agency on these tools", evidence_url: null }, co_host: { name: "Sequoia Taylor", kind: "PARTNER", why: "runs a fund on these tools", evidence_url: null }, cost_band: "$0 to attend — free by design", chosen: true },
      { title: "Your Monday Morning, Automated", angle_on: on[1], angle_kind: "FRAMING", who_its_for: "owners with a first hire coming", promise: "Leave with a one-page AI policy for a small team", mode: "TEACH", signature_exercise: "draft the policy", leave_with: "the policy template", facilitator: { name: "Scooter Taylor", kind: "PARTNER", why: "runs an agency", evidence_url: null }, co_host: { name: "Sequoia Taylor", kind: "PARTNER", why: "runs a fund", evidence_url: null }, cost_band: "$0 to attend" },
      { title: "Build Night: one tool, one task", angle_on: on[2], angle_kind: "FORMAT", who_its_for: "community builders", promise: "Leave with a content calendar drafted by AI", mode: "SHOW", signature_exercise: "build the calendar", leave_with: "the calendar", facilitator: { name: "Guest Person", kind: "GUEST", why: "teaches this", evidence_url: GUEST_PAGE }, co_host: null, cost_band: "$500–1,500 guest fee" },
    ],
    choice_rationale: "Doing beats hearing; the admin task is the one every solopreneur has.",
    pushback: "",
  });
};

const packetJson = (over: Record<string, unknown> = {}) => JSON.stringify({
  title: "A title the model chose",
  who_its_for: "solopreneurs and owners of businesses under ten people",
  promise: "Leave with three admin tasks handed to an AI tool, set up and tested",
  mode: "DO",
  target_min: 20, target_max: 60,
  run_of_show: [
    { time: "12:00 PM", minutes: 5, what: "Welcome and the promise", who: "Scooter (host)", segment: "STAGE" },
    { time: "12:05 PM", minutes: 10, what: "Teach: the three tasks worth automating first", who: "Scooter", segment: "STAGE" },
    { time: "12:15 PM", minutes: 15, what: "Exercise 1: pick your task, set it up", who: "breakout groups of 5", segment: "BREAKOUT" },
    { time: "12:30 PM", minutes: 5, what: "Show: two groups demo", who: "volunteers", segment: "STAGE" },
    { time: "12:35 PM", minutes: 15, what: "Exercise 2: test it on real input, fix it", who: "breakout groups of 5", segment: "BREAKOUT" },
    { time: "12:50 PM", minutes: 5, what: "What to do Monday, and the checklist", who: "Sequoia (co-host)", segment: "STAGE" },
  ],
  exercises: ["pick one admin task and set it up in a tool", "test it on a real input and fix it"],
  leave_with: ["the automation checklist, filled in for their business", "a list of the three tools tried"],
  facilitator: { name: "Scooter Taylor", kind: "PARTNER", why: "runs an agency on these tools", evidence_url: null },
  co_host: { name: "Sequoia Taylor", kind: "PARTNER", why: "runs a fund on these tools", evidence_url: null },
  delivery: { platform_run_of_show: ["stage: welcome", "breakout: exercise 1", "stage: demos", "breakout: exercise 2", "stage: close"], on_screen: ["slides", "a shared checklist doc", "a timer"], join_flow: ["invite goes out with the date", "join code lands the morning of", "attendees join by code", "breakouts assigned by tool"], tech_check: "Thirty minutes before: Sequoia on stage, screen share tested, breakout assignment rehearsed." },
  sponsorship: { note: "Free to attend by design; a sponsor would cover the materials.", suggested: { category_fit: "a small-business accounting tool", ask_usd: 750, why: "they already sell to exactly this audience" } },
  promo_one_liner: "An hour, three admin tasks gone: a working session for solopreneurs.",
  invitations: [
    { n: 1, send_when: "10 days before", subject: "Three admin tasks, gone", body: "Come and hand three tasks to an AI tool, live, with me.\nSee " + LIVE_1 + " for the thread that prompted it." },
    { n: 2, send_when: "3 days before", subject: "Bring one task", body: "Bring the task that eats your Tuesday." },
    { n: 3, send_when: "the morning of", subject: "Your join code", body: "Your code is in this email; join on West Peek Live at noon." },
  ],
  budget_lines: [{ key: "facilitator_fee", low_usd: 0, high_usd: 0, basis: "partner-led" }, { key: "production_time", low_usd: 500, high_usd: 800, basis: "8 hours" }, { key: "materials", low_usd: 0, high_usd: 150, basis: "the checklist" }],
  risks: ["people arrive without a task in mind", "a tool's free tier changes"],
  commitment_md: "A date on West Peek Live, Scooter's and Sequoia's afternoon, an invitation to the community.",
  pushback: "",
  ...over,
});


/**
 * THE DRAFT PROPOSED EVENT KIT the kit stage asks for (0180). Answered whenever the prompt carries
 * `EVENT_KIT_PROMPT_MARKER`, so the Workshop chain exercises the kit stage on every run through it.
 */
const kitJson = JSON.stringify({
  event_title: "Three admin tasks, gone — live",
  format: "Live working session (teach + do)",
  description: {
    title: "Three admin tasks, gone — live",
    hook: "Bring the task that eats your Tuesday. Leave with it handed to a tool.",
    parts: [{ label: "Part 1: The working session", minutes: 60, detail: "Three tasks, set up live." }],
    who_its_for: "small-business owners and solopreneurs",
    audience_tip: "Join from a desktop with the tool open in a second tab.",
  },
  run_of_show: [
    { time: "5:45 PM ET", segment: "Greenroom check-in", description: "Audio and video test, screen share rehearsed.", on_screen: { shape: "BACKSTAGE", who: "Scooter Taylor + Sequoia Taylor" } },
    { time: "6:00 PM ET", segment: "Welcome", description: "Sets the hour.", on_screen: { shape: "SOLO", who: "Scooter Taylor" } },
    { time: "6:05 PM ET", segment: "Set one up, live", description: "Screen share through the first task.", on_screen: { shape: "SCREEN SHARE", who: "Scooter Taylor" } },
    { time: "6:45 PM ET", segment: "Wrap", description: "What to do Monday.", on_screen: { shape: "3-UP", who: "Scooter Taylor + Sequoia Taylor + the room" } },
  ],
  discussion_guide: {
    opening_script: "Welcome in. An hour, and you leave with three tasks handed over.",
    questions: [
      { n: 1, theme: "The first task", question: "Which task would you hand over first, and why that one?" },
      { n: 2, theme: "The failure mode", question: "Where do these setups usually break in week two?" },
    ],
  },
  social_posts: [
    { kind: "ANNOUNCE", voice: "West Peek", body: "An hour. Three admin tasks, gone.", hashtags: ["#WestPeek"] },
    { kind: "SPEAKER", voice: "Scooter Taylor", body: "I am going live to hand three admin tasks to a tool, with you.", hashtags: ["#WestPeek"] },
  ],
});

const TINY_PDF = btoa("%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF");

function deps(set: boolean, over: Partial<ChainDeps> = {}): ChainDeps {
  return {
    research: async () => ({ ok: true, text: notesJson, citations: [], detail: "ok" }),
    judge: async () => ({ ok: true, text: verdictsJson, detail: "ok" }),
    urlCheck: async (url) => (url === DEAD ? 404 : 200),
    // The packet prompt is the only one that says WRITE THE PACKET; everything else in the chain
    // that reaches the reasoning model is the angles call.
    synthesise: async (prompt) => ({ text: prompt.includes(EVENT_KIT_PROMPT_MARKER) ? kitJson : prompt.includes("WRITE THE PACKET") ? packetJson() : conceptsJson(set), aiRunId: null }),
    render: async () => ({ pdfBase64: TINY_PDF, pageCount: 1 }),
    // A venue search must never be reached by a Workshop; if it is, the test fails loudly.
    search: async () => { throw new Error("a Workshop searched for a venue"); },
    // The interpretation pass in front of the chain. Supplied because these packets carry a
    // partner's brief, so her words DO reach a model — see tests/helpers/interpret.ts.
    interpret: saidNothing,
    ...over,
  };
}

const actor = () => actorFromIdentity({ ...sweepIdentity(), id: "fu_sequoia_taylor" });
const row = async (id: string): Promise<PacketRow> => (await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE id = ?1").bind(id).first<PacketRow>())!;
const ctx = (method: string, body?: unknown, params: Record<string, string> = {}): RouteContext => ({
  request: new Request("https://os.joinwestpeek.com/api/rooms/packets", { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } }),
  env,
  identity: { ...sweepIdentity(), id: "fu_sequoia_taylor" },
  params,
});

async function buildToDone(draft: PacketRow, d: ChainDeps): Promise<{ outcomes: string[]; stages: string[] }> {
  const outcomes: string[] = [];
  const stages: string[] = [];
  for (let i = 0; i < 12; i++) {
    const out = await sweepOnce(env, new Date(NOW), { roomPacket: (e, card) => runRoomPacketCard(e, card, d) });
    outcomes.push(out.outcome);
    stages.push((await row(draft.id)).build_stage);
    if (out.outcome === "DONE" || out.outcome === "NOTHING_WAITING" || out.outcome === "BLOCKED") break;
  }
  return { outcomes, stages };
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled", WP_OS_DOCUMENTS: t.docs } as Partial<Env>);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("the series on the record", () => {
  it("is derived from MONTHLY_PLAN, and October is nobody's to build", () => {
    expect(WORKSHOP_SERIES["2026-09"]).toBe(SET_TOPIC);
    // The topic she gave, not the old title "How to build community" — a title is already an angle.
    expect(WORKSHOP_SERIES["2026-11"]).toBe("Community");
    // October is EXTERNAL, so it is not a title Parker builds to.
    expect(WORKSHOP_SERIES["2026-10"]).toBeUndefined();
    expect(planFor("2026-10", "WORKSHOP")!.status).toBe("EXTERNAL");
    expect(planFor("2026-10", "WORKSHOP")!.topic).toBe("Content creation");
    expect(planFor("2026-09", "ROOM")!.status).toBe("NOT_RUNNING");
    expect(planFor("2026-11", "ROOM")!.topic).toBe("Black lawyers");
    expect(planFor("2026-12", "ROOM")!.status).toBe("PARKER_CHOOSES");
  });

  it("the firm's written method carries the one-topic-several-angles rule and the free-plus-sponsor rule", () => {
    const skills = skillsForMachines(["west_peek_live_events"]);
    expect(skills.find((s) => s.key === "propose_on_the_firm_rhythm")!.guidance.join(" ")).toMatch(/one Room and one Workshop/);
    const ws = skills.find((s) => s.key === "a_workshop_they_can_use_on_monday")!;
    const text = ws.guidance.join(" ");
    expect(text).toMatch(/virtual only, on West Peek Live/);
    expect(text).toMatch(/Never research a venue/);
    expect(text).toMatch(/ONE TOPIC A MONTH, SEVERAL ANGLES INSIDE IT/);
    expect(text).toMatch(/Black lawyers is a topic\. Community is a topic\./);
    expect(text).toMatch(/Attendance is FREE, always, by design — and always suggest a small sponsor anyway/);
    expect(text).toMatch(/45–60 minutes/);
    expect(text).toMatch(/Scooter Taylor/);
    // The number that drifted, in the one place Parker actually reads.
    expect(text).not.toMatch(/90 minutes/);
  });
});

describe("the cadence: both streams deliver on the 1st of the month prior", () => {
  it("a month that is not Parker's is NOT queued, and the job says whose it is", async () => {
    // NOW is 16 Sep, so the delivery month is October: no Room runs, and the Workshop is hosted by
    // a friend of Scooter's. Parker must build neither — and must say so rather than go quiet.
    expect(deliveryMonth(NOW)).toBe("2026-10");
    const out = await runMonthlyRoomProposal(env, actor(), NOW);
    expect(out.generated).toBe(false);
    expect(out.detail).toMatch(/due 2026-09-01/);
    expect(out.detail).toMatch(/no Room runs in 2026-10/);
    expect(out.detail).toMatch(/hosted by a friend of Scooter's \(Content creation\), so it is not Parker's to build/);
    const counts = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM evt_room_packet WHERE proposed_for_month = '2026-10'").first<{ n: number }>();
    expect(counts!.n).toBe(0);
  });

  it("November's Room and Workshop are minted on 1 October, each with the topic she set", async () => {
    const onTheFirst = "2026-10-01T00:05:00.000Z";
    expect(deliveryMonth(onTheFirst)).toBe("2026-11");
    expect(dueOn("2026-11")).toBe("2026-10-01");

    const nov = await runMonthlyRoomProposal(env, actor(), onTheFirst);
    expect(nov.generated).toBe(true);
    expect(nov.detail).toMatch(/queued Parker's own Room for 2026-11, due 2026-10-01 — topic set by the partners: "Black lawyers"/);
    const ws = await runMonthlyRoomProposal(env, actor(), onTheFirst);
    expect(ws.generated).toBe(true);
    expect(ws.detail).toMatch(/queued Parker's own Workshop for 2026-11, due 2026-10-01 — topic set by the partners: "Community"/);
    expect((await row(ws.packetId!)).title).toBe("Workshop: Community");

    const third = await runMonthlyRoomProposal(env, actor(), onTheFirst);
    expect(third.generated).toBe(false);
    const counts = (await env.WP_OS_DB.prepare("SELECT kind, COUNT(*) AS n FROM evt_room_packet WHERE proposed_for_month = '2026-11' GROUP BY kind ORDER BY kind").all<{ kind: string; n: number }>()).results;
    expect(counts).toEqual([{ kind: "ROOM", n: 1 }, { kind: "WORKSHOP", n: 1 }]);

    // A LATE TICK STILL DELIVERS: the rule is a floor, not a single day. December is Parker's own
    // in both streams, and a tick on the 4th queues it rather than skipping the month.
    const late = await runMonthlyRoomProposal(env, actor(), "2026-11-04T09:00:00.000Z");
    expect(late.generated).toBe(true);
    expect(late.detail).toMatch(/for 2026-12, due 2026-11-01 — he picks the topic himself/);

    // Parked so the chain tests below claim their own cards.
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE kind = 'ROOM_PACKET'").run();
    await env.WP_OS_DB.prepare("UPDATE evt_room_packet SET status = 'DECLINED' WHERE proposed_for_month IN ('2026-11','2026-12')").run();
  });
});

describe("the request door", () => {
  it("a Workshop request for a SET month keeps the partners' title whatever was typed; the city is dropped", async () => {
    const res = await handleGeneratePacket(ctx("POST", { kind: "WORKSHOP", audience: "AI for tiny businesses (my wording)", month: "2026-09", city: "New York", notes: "keep it practical" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { packet: PacketRow; queued: boolean; cardId: string | null };
    expect(body.queued).toBe(true);
    expect(body.packet.kind).toBe("WORKSHOP");
    expect(body.packet.title).toBe(`Workshop: ${SET_TOPIC}`);
    expect(body.packet.origin).toBe("PARTNER_BRIEF");
    const brief = JSON.parse(body.packet.brief_json!) as { audience: string; city: string | null; notes: string; kind: string };
    expect(brief.audience).toBe(SET_TOPIC);
    expect(brief.city).toBeNull();
    expect(brief.kind).toBe("WORKSHOP");
    expect(brief.notes).toMatch(/Asked as: AI for tiny businesses \(my wording\) · keep it practical/);
    const card = (await env.WP_OS_DB.prepare("SELECT title, description FROM work_card WHERE id = ?1").bind(body.cardId).first<{ title: string; description: string }>())!;
    expect(card.title).toBe("Parker: build the September 2026 Workshop packet — How to use AI for small businesses / solopreneurs");
    expect(card.description).toMatch(/title is SET by the partners/);
    expect(card.description).toMatch(/Virtual only — no venue is researched/);
  });

  it("a Workshop request for an OPEN month is built to the topic typed; 'let Parker think of one' works for a Workshop too", async () => {
    /*
     * `intent: "NOW"` IS NOW REQUIRED HERE, AND THAT IS THE POINT (0194, 18 Sep 2026).
     *
     * 2026-12 is beyond the month being delivered, so this ask is genuinely two different asks —
     * "build a Workshop about pricing now" and "when you do December, make it about pricing" — and
     * the door refuses to pick. This test says the first one, which is what it always meant; the
     * assertion immediately below pins that saying NEITHER is refused rather than defaulted, which
     * is the behaviour the old version of this test was silently relying on.
     */
    const countDecember = async (): Promise<number> =>
      (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM evt_room_packet WHERE proposed_for_month = '2026-12'").first<{ n: number }>())?.n ?? -1;
    const before = await countDecember();
    const undeclared = await handleGeneratePacket(ctx("POST", { kind: "WORKSHOP", audience: "how to price a service business", month: "2026-12" }));
    expect(undeclared.status).toBe(400);
    expect(((await undeclared.json()) as { error: string }).error).toBe("intent_required");
    // A REFUSAL CREATES NOTHING. The whole point is that the ambiguous ask does not quietly build.
    expect(await countDecember()).toBe(before);

    const res = await handleGeneratePacket(ctx("POST", { kind: "WORKSHOP", audience: "how to price a service business", month: "2026-12", intent: "NOW" }));
    const body = (await res.json()) as { packet: PacketRow };
    expect(body.packet.title).toBe("Workshop requested: how to price a service business");
    expect(body.packet.kind).toBe("WORKSHOP");
    /*
     * NO INTENT NEEDED ON THIS ONE, DELIBERATELY. "Parker, think of one" carries no words to steer
     * WITH, so there is nothing that could have been held for the month — an empty-bodied ask is a
     * one-off by construction, and the door must not start asking a question with one answer.
     */
    const own = await handleGeneratePacket(ctx("POST", { kind: "WORKSHOP", month: "2027-02" }));
    const ownBody = (await own.json()) as { packet: PacketRow };
    expect(ownBody.packet.title).toBe("Parker's Workshop for 2027-02");
    expect(ownBody.packet.origin).toBe("PARKER");
    // The list names the kind and the series for the page's form.
    const list = (await (await handleListPackets(ctx("GET"))).json()) as { packets: Array<{ id: string; kind: string }>; workshopSeries: Record<string, string> };
    expect(list.packets.find((p) => p.id === body.packet.id)?.kind).toBe("WORKSHOP");
    expect(list.workshopSeries["2026-09"]).toBe(WORKSHOP_SERIES["2026-09"]);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE kind = 'ROOM_PACKET' AND title LIKE '%2026%' AND title NOT LIKE '%September 2026 Workshop%'").run();
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE kind = 'ROOM_PACKET' AND title LIKE '%2027%'").run();
  });
});

describe("the chain, for a SET topic", () => {
  it("runs DISCOVER → CONCEPTS → PACKET → PDF with no sponsor stage and no venue stage, keeps the set title, and emails both partners once", async () => {
    const draft = (await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE proposed_for_month = '2026-09' AND kind = 'WORKSHOP'").first<PacketRow>())!;
    expect(draft.status).toBe("DRAFT");
    const { outcomes, stages } = await buildToDone(draft, deps(true));
    expect(outcomes).toEqual(["PROGRESSED", "PROGRESSED", "PROGRESSED", "PROGRESSED", "DONE"]);
    // CONCEPTS → PACKET → KIT (the draft proposed event kit, 0180) → PDF → done.
    expect(stages).toEqual(["CONCEPTS", "PACKET", "KIT", "PDF", "DONE"]);

    const p = await row(draft.id);
    expect(p.status).toBe("PROPOSED");
    expect(p.kind).toBe("WORKSHOP");
    expect(p.format).toBe("WORKSHOP");
    /*
     * THE TOPIC IS THE PARTNERS'; THE TITLE IS THE ANGLE'S NAME. This is the change item 2 asked
     * for: a name is one of the things an angle varies, so forcing every concept's title to the set
     * title (which is what this used to assert) left the angles with nothing to differ in.
     */
    expect(p.theme).toBe(SET_TOPIC);
    expect(p.title).toBe("A title the model chose");
    const concepts = JSON.parse(p.concepts_json) as Array<{ title: string; chosen: boolean; promise: string; mode: string; angleOn: string; angleKind: string }>;
    expect(concepts).toHaveLength(3);
    // THREE ANGLES, ONE SUBJECT: three different names, every one of them on the partners' topic.
    expect(new Set(concepts.map((c) => c.title)).size).toBe(3);
    expect(concepts.every((c) => c.angleOn === SET_TOPIC)).toBe(true);
    expect(concepts.map((c) => c.angleKind)).toEqual(["NAME", "FRAMING", "FORMAT"]);
    expect(concepts.filter((c) => c.chosen)).toHaveLength(1);
    expect(concepts[0]!.promise).toMatch(/three admin tasks/);
    expect(p.central_question).toMatch(/^Leave with three admin tasks/);
    expect(p.live_url).toBe("https://westpeek.live");
    expect(p.document_id).toMatch(/^doc_/);

    const w = workshopViewOf(p)!;
    expect(w.topicSet).toBe(true);
    expect(w.topic).toBe(SET_TOPIC);
    expect(w.topicSetBy).toBe("PARTNERS");
    // Scooter hosts, with a co-host. It defaulted to Sequoia and named no co-host at all.
    expect(w.facilitator.name).toBe("Scooter Taylor");
    expect(w.coHost!.name).toBe("Sequoia Taylor");
    expect(w.delivery.where).toBe(WORKSHOP_WHERE);
    expect(w.runOfShow.filter((l) => l.segment === "BREAKOUT")).toHaveLength(2);
    expect(w.leaveWith[0]).toMatch(/automation checklist/);
    expect(w.invitations).toHaveLength(3);
    expect(w.invitations[0]!.body).toContain(LIVE_1); // a judged URL survives
    expect(w.notes.map((n) => n.url).sort()).toEqual([LIVE_1, LIVE_2, GUEST_PAGE].sort());
    // FREE TO ATTEND IS AN INVARIANT, AND A SPONSOR IS SUGGESTED ANYWAY. Both, without contradiction.
    expect(w.economics.attendanceFree).toBe(true);
    expect(w.sponsorship.attendanceFree).toBe(true);
    expect(w.sponsorship.suggested!.categoryFit).toBe("a small-business accounting tool");
    expect(w.economics.suggestedSponsorshipUsd).toBe(750);
    expect(w.economics.lines.map((l) => l.key)).toEqual(["facilitator_fee", "production_time", "materials", "contingency"]);
    expect(w.economics.estimatedCostHighUsd).toBe(Math.round(950 * 1.1));
    expect(p.sponsor_count).toBe(1);
    expect(p.sponsor_total_usd).toBe(750);

    // Both partners were emailed ONCE, in the busy-executive format, with the packet under the rule.
    /*
     * ONE EMAIL, ADDRESSED TO BOTH OF THEM — it used to be two, one per person. One event, one
     * message, both addresses on it.
     */
    const mail = (await env.WP_OS_DB.prepare("SELECT event_type, payload_json FROM event_record WHERE object_type = 'room_packet' AND object_id = ?1 AND event_type LIKE 'deliverable.%' ORDER BY created_at").bind(p.id).all<{ event_type: string; payload_json: string }>()).results!;
    expect(mail).toHaveLength(1);
    expect((JSON.parse(mail[0]!.payload_json) as { to: string[] }).to.slice().sort()).toEqual(["scooter@westpeek.ventures", "sequoia@westpeek.ventures"]);

    // The reply code is minted once per packet and the email spells it out both ways.
    const tok = (await env.WP_OS_DB.prepare("SELECT token, used_at, expires_at FROM evt_packet_decision_token WHERE packet_id = ?1").bind(p.id).first<{ token: string; used_at: string | null; expires_at: string }>())!;
    expect(tok.used_at).toBeNull();
    expect(tok.expires_at.slice(0, 7)).toBe("2026-10");

    const summary = workshopSummary(p, w, tok.token);
    const rendered = renderExecEmail({ employee: "Parker", what: "x", tldr: summary.tldr, sections: summary.sections, details: renderWorkshopPacketText(p, w) });
    expect(lintExecEmail(rendered.subject, rendered.text, "Parker")).toEqual([]);
    // THE TLDR IS THE TOPIC AND THE ANGLES IN ONE GLANCE.
    expect(rendered.text).toMatch(/\*\*TL;DR:\*\* \*\*September 2026 Workshop — topic: How to use AI for small businesses \/ solopreneurs\.\*\*/);
    expect(rendered.text).toMatch(/I looked at \*\*3\*\* angles on it and chose \*\*The AI Back Office, in an hour\*\*/);
    // PARKER INTRODUCES HIMSELF — Scooter may be reading one of these for the first time.
    expect(rendered.text).toMatch(/I'm \*\*Parker\*\*, West Peek's Event Marketing Coordinator/);
    // AND THE MAIL SAYS HOW TO ANSWER IT, with a worked example of each answer.
    expect(rendered.text).toContain(`#wpkeep-${tok.token}`);
    expect(rendered.text).toContain(`#wpno-${tok.token}`);
    expect(rendered.text).toMatch(/works once, and stops working at the end of the month it is for/);
    expect(rendered.text).toMatch(/Just hit Reply/);

    /*
     * THE DRAFT PROPOSED EVENT KIT, FILED AND LINKED (0180).
     *
     * The whole point of the kit is that the partner gets a LINK, not an attachment — a draft that
     * can be corrected in place. So the assertions are: the kit is on the packet, it is FILED as a
     * deliverable on a partner's Home, and the email carries the TL;DR and that link rather than
     * the text. A kit stored but never filed, or filed but never linked, is the "exists but nothing
     * invokes it" defect this repo keeps finding.
     */
    const kit = eventKitOf(p)!;
    expect(kit, "the chain reached DONE without writing an event kit").toBeTruthy();
    expect(kit.header.platform).toBe("West Peek Live");
    expect(kit.header.slot.label).toBe("PROPOSED — Thursday 10 September 2026, 6:00 PM ET");
    expect(kit.header.slot.greenroomEt).toBe("5:45 PM ET");
    // Every row says who is on screen — the column nothing else in this system thinks about.
    expect(kit.runOfShow.length).toBeGreaterThan(0);
    expect(kit.runOfShow.every((r) => r.onScreen.shape.length > 0)).toBe(true);
    expect(kit.runOfShow[0]!.segment).toMatch(/greenroom/i);
    // A co-host IS named on this packet, so the only thing open is the link that does not exist yet.
    expect(kit.open.map((o) => o.kind)).toEqual(["JOIN_LINK"]);
    expect(JSON.stringify(kit)).not.toContain("[Insert");

    expect(p.event_kit_deliverable_id).toMatch(/^dlv_/);
    const filed = (await env.WP_OS_DB.prepare("SELECT kind, title, body, prepared_by, prepared_for, document_id FROM deliverable WHERE id = ?1").bind(p.event_kit_deliverable_id).first<{ kind: string; title: string; body: string; prepared_by: string; prepared_for: string; document_id: string | null }>())!;
    expect(filed.kind).toBe("event_kit");
    expect(filed.prepared_by).toBe("Parker");
    expect(filed.body).toContain("## 3. Run of show");
    expect(filed.body).toContain("| Time (ET) | Segment | Description & notes | On screen |");
    expect(filed.body).toContain("PROPOSED — Thursday 10 September 2026, 6:00 PM ET");
    // THE EMAIL CARRIES THE TL;DR AND THE LINK, NEVER THE KIT.
    expect(rendered.text).toContain("Draft event kit —");
    expect(rendered.text).toContain(`https://os.joinwestpeek.com/api/deliverables/${p.event_kit_deliverable_id}/download`);
    expect(rendered.text).not.toContain("| Time (ET) | Segment |");

    const card = (await env.WP_OS_DB.prepare("SELECT state, description FROM work_card WHERE id = ?1").bind(p.work_card_id).first<{ state: string; description: string }>())!;
    expect(card.state).toBe("DONE");
    expect(card.description).toMatch(/PDF: https:\/\/os\.joinwestpeek\.com\/api\/documents\/doc_/);
  });

  it("A WORKSHOP PACKET NEVER CARRIES A VENUE OR A VENUE COST — rows, text, email, PDF", async () => {
    const p = (await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE proposed_for_month = '2026-09' AND kind = 'WORKSHOP'").first<PacketRow>())!;
    const venues = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM evt_packet_venue WHERE packet_id = ?1").bind(p.id).first<{ n: number }>();
    expect(venues!.n).toBe(0);
    const sponsors = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM evt_sponsor_prospect WHERE packet_id = ?1").bind(p.id).first<{ n: number }>();
    expect(sponsors!.n).toBe(0);
    const w = workshopViewOf(p)!;
    for (const l of w.economics.lines) expect(["facilitator_fee", "production_time", "materials", "contingency"]).toContain(l.key);
    expect(JSON.stringify(w.economics)).not.toMatch(/venue|food|room hire|travel/i);

    const text = renderWorkshopPacketText(p, w);
    expect(text).toContain(`WHERE — ${WORKSHOP_WHERE}`);
    expect(text).not.toMatch(/VENUE SHORTLIST|room minimum|SPONSORS, RANKED|CAN OUR OWN LIST FILL IT/);
    expect(text).toMatch(/RUN OF SHOW — 45–60 minutes/);
    expect(text).toMatch(/12:15 PM \(15 min\) — BREAKOUT: Exercise 1/);
    expect(text).toMatch(/INVITATIONS — three emails, yours to send/);
    expect(text).toMatch(/Free to attend — always, by design/);
    expect(text).toMatch(/A small sponsor worth asking: a small-business accounting tool/);

    const view = { packetId: p.id, title: p.title, theme: p.theme, centralQuestion: p.central_question, month: p.proposed_for_month, format: p.format, targetMin: p.target_min, targetMax: p.target_max, audience: p.audience, origin: p.origin, brief: JSON.parse(p.brief_json!), pushback: p.pushback_md, concepts: JSON.parse(p.concepts_json), conceptChoiceMd: p.concept_choice_md, runOfShow: [], agendaMd: null, seedQuestions: [], guestIdeas: [], venues: [], sponsors: [], economics: null, sponsorThesis: null, risks: JSON.parse(p.risks_json), commitmentMd: p.commitment_md, pitchEmail: null, inviteCheck: null, alsoLookedAt: [], generatedAt: NOW };
    const html = renderWorkshopHtml(view, w);
    expect(html).toContain("Workshop packet · September 2026");
    expect(html).toContain(`Where — ${WORKSHOP_WHERE}`);
    expect(html).toContain("Three angles on the topic, compared");
    expect(html).toContain("The join-code invitation flow");
    expect(html).not.toMatch(/Where it could be held|Who pays for it — ranked|room minimum|unverified until called|Venue hire/);
    expect(html).toContain("no venue, no food and beverage, no room hire");
  });

  it("verification strips a venue, an unjudged URL and an unproven guest, and FORCES attendance-free", () => {
    const raw = packetJson({ venues: [{ name: "A room in Brooklyn", source_url: "https://venue.example" }], facilitator: { name: "Somebody Unproven", kind: "GUEST", why: "seems good", evidence_url: "https://unchecked.example/bio" }, promo_one_liner: "See https://unchecked.example/promo" });
    const parsed = parseWorkshopPacket(raw, "Community")!;
    // The TOPIC is not the model's to change; the TITLE is the angle's name and is.
    expect(parsed.topic).toBe("Community");
    expect(parsed.title).toBe("A title the model chose");
    const { packet, flags } = verifyWorkshopPacket(parsed, [LIVE_1], raw);
    expect(flags.map((f) => f.code)).toEqual(expect.arrayContaining(["venue_removed", "unjudged_url_removed", "guest_without_evidence"]));
    expect(packet.facilitator.kind).toBe("PARTNER");
    // Demoted to the DEFAULT HOST, who is Scooter — not Sequoia, which is what it used to be.
    expect(packet.facilitator.name).toBe("Scooter Taylor");
    expect(packet.facilitator.why).toMatch(/Guest idea to verify: Somebody Unproven/);
    expect(packet.promoOneLiner).toContain("[link removed: not a checked source]");
    expect(packet.delivery.where).toBe(WORKSHOP_WHERE);
    expect(JSON.stringify(packet)).not.toContain("Brooklyn");
    expect(packet.sponsorship.attendanceFree).toBe(true);
  });

  it("a packet with no co-host and no suggested sponsor is FLAGGED rather than accepted quietly", () => {
    const raw = packetJson({ co_host: null, sponsorship: { note: "free" } });
    const { flags } = verifyWorkshopPacket(parseWorkshopPacket(raw, "Community")!, [LIVE_1], raw);
    expect(flags.map((f) => f.code)).toEqual(expect.arrayContaining(["no_co_host", "no_sponsor_suggested"]));
  });

  it("a run of show outside 45–60 minutes is flagged, and one inside it is not", () => {
    const long = packetJson({ run_of_show: [{ time: "12:00 PM", minutes: 90, what: "the old length", who: "Scooter", segment: "STAGE" }] });
    expect(verifyWorkshopPacket(parseWorkshopPacket(long, "Community")!, [LIVE_1], long).flags.map((f) => f.code)).toContain("length_off");
    const ok = packetJson();
    expect(verifyWorkshopPacket(parseWorkshopPacket(ok, "Community")!, [LIVE_1], ok).flags.map((f) => f.code)).not.toContain("length_off");
  });

  /**
   * THE REJECTION, WHICH IS THE POINT OF ITEM 2. Not "discouraged by the prompt": the parse
   * returns null, the stage fails, and nothing with three subjects in it is ever stored.
   */
  describe("three subjects cannot come back as a packet", () => {
    it("rejects an answer whose angles each declare a different subject", () => {
      const threeSubjects = conceptsJson(false, { topic: "Task triage", angleOn: ["Task triage", "An AI back office", "Content repurposing"] });
      expect(parseWorkshopConcepts(threeSubjects, null)).toBeNull();
    });

    it("rejects an angle that replaces a topic the partners set", () => {
      const drifted = conceptsJson(false, { topic: SET_TOPIC, angleOn: [SET_TOPIC, SET_TOPIC, "Something else entirely"] });
      expect(parseWorkshopConcepts(drifted, SET_TOPIC)).toBeNull();
      // And an answer that changes the subject wholesale, every angle agreeing with each other.
      const replaced = conceptsJson(false, { topic: "A better idea", angleOn: ["A better idea", "A better idea", "A better idea"] });
      expect(parseWorkshopConcepts(replaced, SET_TOPIC)).toBeNull();
    });

    it("rejects an answer with no `angle_on` at all — a missing guarantee is not a guarantee", () => {
      const silent = JSON.stringify({ topic: "Community", concepts: [{ title: "One", promise: "a" }, { title: "Two", promise: "b" }] });
      expect(parseWorkshopConcepts(silent, "Community")).toBeNull();
    });

    it("accepts three angles on one subject, keeps the three NAMES, and settles one topic", () => {
      const c = parseWorkshopConcepts(conceptsJson(true), SET_TOPIC)!;
      expect(c.topic).toBe(SET_TOPIC);
      expect(new Set(c.concepts.map((x) => x.title)).size).toBe(3);
      expect(c.concepts.every((x) => x.angleOn === SET_TOPIC)).toBe(true);
      expect(c.concepts.filter((x) => x.chosen)).toHaveLength(1);
    });

    it("PARKER CHOOSES when nobody set a topic — the same answer shape, no human present", () => {
      const own = conceptsJson(false, { topic: "Hiring your first contractor" });
      const c = parseWorkshopConcepts(own, null)!;
      expect(c.topic).toBe("Hiring your first contractor");
      expect(c.concepts.every((x) => x.angleOn === "Hiring your first contractor")).toBe(true);
    });
  });

  it("the money says free to attend and prices the SUGGESTION as cover, never as profit", () => {
    const parsed = parseWorkshopPacket(packetJson(), "Community")!;
    const eco = computeWorkshopEconomics(parsed);
    expect(eco.attendanceFree).toBe(true);
    expect(eco.suggestedSponsorshipUsd).toBe(750);
    expect(eco.wouldCoverUsd).toBe(Math.min(750, eco.estimatedCostHighUsd));
    const none = computeWorkshopEconomics({ budgetLines: parsed.budgetLines, sponsorship: normaliseSponsorship({}) });
    expect(none.suggestedSponsorshipUsd).toBe(0);
    expect(none.attendanceFree).toBe(true);
  });
});

describe("the chain, for a month whose topic was typed rather than set", () => {
  it("three angles on the typed topic, one chosen; the page's detail carries the Workshop half", async () => {
    const draft = (await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE proposed_for_month = '2026-12' AND kind = 'WORKSHOP'").first<PacketRow>())!;
    await openPacketCard(env, draft);
    const { outcomes } = await buildToDone(await row(draft.id), deps(false));
    expect(outcomes[outcomes.length - 1]).toBe("DONE");
    const p = await row(draft.id);
    expect(p.title).toBe("A title the model chose");
    expect(p.theme).toBe(OPEN_TOPIC);
    const concepts = JSON.parse(p.concepts_json) as Array<{ title: string; chosen: boolean; angleOn: string }>;
    expect(concepts.map((c) => c.title)).toEqual(["The AI Back Office, in an hour", "Your Monday Morning, Automated", "Build Night: one tool, one task"]);
    expect(concepts.every((c) => c.angleOn === OPEN_TOPIC)).toBe(true);
    expect(concepts[0]!.chosen).toBe(true);
    expect(workshopViewOf(p)!.topic).toBe(OPEN_TOPIC);

    const detail = (await (await handleGetPacket(ctx("GET", undefined, { id: p.id }))).json()) as { packet: { kind: string }; venues: unknown[]; sponsors: unknown[]; workshop: { promise: string; delivery: { where: string } } | null; flags: unknown[] };
    expect(detail.packet.kind).toBe("WORKSHOP");
    expect(detail.venues).toEqual([]);
    expect(detail.sponsors).toEqual([]);
    expect(detail.workshop!.delivery.where).toBe(WORKSHOP_WHERE);
    expect(detail.workshop!.promise).toMatch(/three admin tasks/);
  });

  it("a kept Workshop schedules as an event of kind WORKSHOP, virtual, with no location a person typed", async () => {
    const p = (await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE proposed_for_month = '2026-12' AND kind = 'WORKSHOP'").first<PacketRow>())!;
    await decidePacket(env, actor(), p.id, "APPROVED");
    const { eventId } = await scheduleRoom(env, actor(), p.id, { startsAt: "2026-12-10T17:00:00.000Z", location: "a room somebody typed" });
    const ev = (await env.WP_OS_DB.prepare("SELECT kind, event_class, event_type, location, live_url FROM evt_event WHERE id = ?1").bind(eventId).first<{ kind: string; event_class: string; event_type: string; location: string; live_url: string }>())!;
    expect(ev.kind).toBe("WORKSHOP");
    expect(ev.event_type).toBe("WORKSHOP");
    expect(ev.event_class).toBe("OTHER");
    expect(ev.location).toBe(WORKSHOP_WHERE);
    expect(ev.live_url).toBe("https://westpeek.live");
  });
});

describe("a packet written by a free lane carries the quality warning (0251)", () => {
  async function degradedRun(note: string): Promise<string> {
    const id = `air_${crypto.randomUUID()}`;
    await env.WP_OS_DB.prepare(
      `INSERT INTO ai_run (id, purpose, actor_type, actor_id, sensitivity, privacy_mode, cost_mode, status, input_hash, trace_id, quality_degraded, quality_note)
       VALUES (?1, 'Workshop packet', 'SYSTEM', 'test', 'PUBLIC', 'FRONTIER', 'NORMAL', 'COMPLETED', 'h', ?2, 1, ?3)`,
    ).bind(id, `trc_${id}`, note).run();
    return id;
  }

  it("a Workshop whose concepts and proposal were written by a free model not marked FULL says so in its flags — once", async () => {
    const note = "Written by Nemotron 3 Ultra 550B (free), a free model whose quality has not been measured against the Claude and OpenAI seats, because the seats were not available and the spend setting allows only free lanes. Read it with that in mind.";
    const runId = await degradedRun(note);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE kind = 'ROOM_PACKET' AND state IN ('OPEN','IN_PROGRESS','BLOCKED')").run();
    const res = await handleGeneratePacket(ctx("POST", { kind: "WORKSHOP", audience: "AI for tiny businesses", month: "2026-09" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { packet: PacketRow; queued: boolean; cardId: string | null };
    const packet = body.packet;
    const d = deps(false, {
      synthesise: async (prompt) => ({ text: prompt.includes(EVENT_KIT_PROMPT_MARKER) ? kitJson : prompt.includes("WRITE THE PACKET") ? packetJson() : conceptsJson(true), aiRunId: runId }),
    });
    const built = await buildToDone(await row(packet.id), d);
    expect(built.outcomes[built.outcomes.length - 1], String((await row(packet.id)).build_error)).toBe("DONE");
    const done = await row(packet.id);
    const flags = (JSON.parse(done.workshop_json as string) as { flags: Array<{ code: string; detail: string }> }).flags.filter((f) => f.code === "written_by_a_weaker_free_model");
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail).toBe(note);
    // The packet row carries the same sentence for the page, the PDF and the email, and the list the page reads exposes it.
    expect((done as unknown as { quality_note: string | null }).quality_note).toBe(note);
    const list = (await (await handleListPackets(ctx("GET"))).json()) as { packets: Array<{ id: string; quality_note?: string | null }> };
    expect(list.packets.find((x) => x.id === done.id)?.quality_note).toBe(note);
  });

  it("a Workshop written by a seat or a paid model (no degraded run) carries no such flag", async () => {
    const built = (await env.WP_OS_DB.prepare("SELECT workshop_json FROM evt_room_packet WHERE proposed_for_month = '2026-09' AND kind = 'WORKSHOP' AND workshop_json IS NOT NULL ORDER BY created_at ASC LIMIT 1").first<{ workshop_json: string }>())!;
    const flags = (JSON.parse(built.workshop_json) as { flags: Array<{ code: string }> }).flags;
    expect(flags.some((f) => f.code === "written_by_a_weaker_free_model")).toBe(false);
  });
});
