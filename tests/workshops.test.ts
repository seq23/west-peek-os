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
import { WORKSHOP_SERIES, WORKSHOP_WHERE, computeWorkshopEconomics, parseWorkshopConcepts, parseWorkshopPacket, verifyWorkshopPacket } from "../src/shared/events/workshopPacket";
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

const conceptsJson = (set: boolean) => JSON.stringify({
  concepts: [
    { title: set ? "Something the model invented" : "Price your service in 90 minutes", who_its_for: "solopreneurs billing by the hour", promise: "Leave with three admin tasks handed to an AI tool, set up and tested", mode: "DO", signature_exercise: "each person automates one real task live in a breakout", leave_with: "a filled-in automation checklist", facilitator: { name: "Sequoia Taylor", kind: "PARTNER", why: "runs a fund on these tools", evidence_url: null }, cost_band: "$0 — free by design", chosen: true },
    { title: set ? "Another invented title" : "Hire your first contractor", who_its_for: "owners with a first hire coming", promise: "Leave with a one-page AI policy for a small team", mode: "TEACH", signature_exercise: "draft the policy", leave_with: "the policy template", facilitator: { name: "Scooter Taylor", kind: "PARTNER", why: "runs an agency", evidence_url: null }, cost_band: "$0" },
    { title: set ? "A third" : "Community that sells", who_its_for: "community builders", promise: "Leave with a content calendar drafted by AI", mode: "SHOW", signature_exercise: "build the calendar", leave_with: "the calendar", facilitator: { name: "Guest Person", kind: "GUEST", why: "teaches this", evidence_url: GUEST_PAGE }, cost_band: "$500–1,500 guest fee" },
  ],
  choice_rationale: "Doing beats hearing; the admin task is the one every solopreneur has.",
  pushback: "",
});

const packetJson = (over: Record<string, unknown> = {}) => JSON.stringify({
  title: "A title the model chose",
  who_its_for: "solopreneurs and owners of businesses under ten people",
  promise: "Leave with three admin tasks handed to an AI tool, set up and tested",
  mode: "DO",
  target_min: 20, target_max: 60,
  run_of_show: [
    { time: "12:00 PM", minutes: 10, what: "Welcome and the promise", who: "Sequoia (facilitator)", segment: "STAGE" },
    { time: "12:10 PM", minutes: 15, what: "Teach: the three tasks worth automating first", who: "Sequoia", segment: "STAGE" },
    { time: "12:25 PM", minutes: 25, what: "Exercise 1: pick your task, set it up", who: "breakout groups of 5", segment: "BREAKOUT" },
    { time: "12:50 PM", minutes: 10, what: "Show: two groups demo", who: "volunteers", segment: "STAGE" },
    { time: "1:00 PM", minutes: 20, what: "Exercise 2: test it on real input, fix it", who: "breakout groups of 5", segment: "BREAKOUT" },
    { time: "1:20 PM", minutes: 10, what: "What to do Monday, and the checklist", who: "Sequoia", segment: "STAGE" },
  ],
  exercises: ["pick one admin task and set it up in a tool", "test it on a real input and fix it"],
  leave_with: ["the automation checklist, filled in for their business", "a list of the three tools tried"],
  facilitator: { name: "Sequoia Taylor", kind: "PARTNER", why: "runs a fund on these tools", evidence_url: null },
  delivery: { platform_run_of_show: ["stage: welcome", "breakout: exercise 1", "stage: demos", "breakout: exercise 2", "stage: close"], on_screen: ["slides", "a shared checklist doc", "a timer"], join_flow: ["invite goes out with the date", "join code lands the morning of", "attendees join by code", "breakouts assigned by tool"], tech_check: "Thirty minutes before: Sequoia on stage, screen share tested, breakout assignment rehearsed." },
  sponsorship: { free: true, note: "A community session; a sponsor would change what it is.", category_fit: null, ask_usd: null },
  promo_one_liner: "Ninety minutes, three admin tasks gone: a working session for solopreneurs.",
  invitations: [
    { n: 1, send_when: "10 days before", subject: "Three admin tasks, gone", body: "Come and hand three tasks to an AI tool, live, with me.\nSee " + LIVE_1 + " for the thread that prompted it." },
    { n: 2, send_when: "3 days before", subject: "Bring one task", body: "Bring the task that eats your Tuesday." },
    { n: 3, send_when: "the morning of", subject: "Your join code", body: "Your code is in this email; join on West Peek Live at noon." },
  ],
  budget_lines: [{ key: "facilitator_fee", low_usd: 0, high_usd: 0, basis: "partner-led" }, { key: "production_time", low_usd: 500, high_usd: 800, basis: "8 hours" }, { key: "materials", low_usd: 0, high_usd: 150, basis: "the checklist" }],
  risks: ["people arrive without a task in mind", "a tool's free tier changes"],
  commitment_md: "A date on West Peek Live, Sequoia's afternoon, an invitation to the community.",
  pushback: "",
  ...over,
});

const TINY_PDF = btoa("%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF");

function deps(set: boolean, over: Partial<ChainDeps> = {}): ChainDeps {
  return {
    research: async () => ({ ok: true, text: notesJson, citations: [], detail: "ok" }),
    judge: async () => ({ ok: true, text: verdictsJson, detail: "ok" }),
    urlCheck: async (url) => (url === DEAD ? 404 : 200),
    synthesise: async (prompt) => ({ text: prompt.includes("Ideate THREE") ? conceptsJson(set) : packetJson(), aiRunId: null }),
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
  it("September and November are set in code; the method says one Room and one Workshop a month, virtual only", () => {
    expect(WORKSHOP_SERIES["2026-09"]).toBe("How to use AI for small businesses / solopreneurs");
    expect(WORKSHOP_SERIES["2026-11"]).toBe("How to build community");
    expect(WORKSHOP_SERIES["2026-10"]).toBeUndefined();
    const skills = skillsForMachines(["west_peek_live_events"]);
    expect(skills.find((s) => s.key === "propose_on_the_firm_rhythm")!.guidance.join(" ")).toMatch(/one Room and one Workshop/);
    const ws = skills.find((s) => s.key === "a_workshop_they_can_use_on_monday")!;
    expect(ws.guidance.join(" ")).toMatch(/virtual only, on West Peek Live/);
    expect(ws.guidance.join(" ")).toMatch(/Never research a venue/);
    expect(ws.guidance.join(" ")).toMatch(/September 2026: 'How to use AI for small businesses \/ solopreneurs'/);
  });
});

describe("the monthly job proposes both kinds, once", () => {
  it("queues the Room, then the Workshop, then nothing — each guarded by kind", async () => {
    const first = await runMonthlyRoomProposal(env, actor(), NOW);
    expect(first.generated).toBe(true);
    expect(first.detail).toMatch(/queued Parker's own Room for 2026-10/);
    const second = await runMonthlyRoomProposal(env, actor(), NOW);
    expect(second.generated).toBe(true);
    expect(second.detail).toMatch(/queued Parker's own Workshop for 2026-10/);
    const ws = await row(second.packetId!);
    expect(ws.kind).toBe("WORKSHOP");
    expect(ws.title).toBe("Parker's Workshop for 2026-10");
    expect(ws.work_card_id).not.toBeNull();
    const third = await runMonthlyRoomProposal(env, actor(), NOW);
    expect(third.generated).toBe(false);
    expect(third.detail).toMatch(/2026-10 already has a Room and a Workshop proposal/);
    const counts = (await env.WP_OS_DB.prepare("SELECT kind, COUNT(*) AS n FROM evt_room_packet WHERE proposed_for_month = '2026-10' GROUP BY kind ORDER BY kind").all<{ kind: string; n: number }>()).results;
    expect(counts).toEqual([{ kind: "ROOM", n: 1 }, { kind: "WORKSHOP", n: 1 }]);
    // Parked so the chain tests below claim their own cards.
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE kind = 'ROOM_PACKET'").run();
    await env.WP_OS_DB.prepare("UPDATE evt_room_packet SET status = 'DECLINED' WHERE proposed_for_month = '2026-10'").run();
  });

  it("a series month queued by the job carries the partners' title", async () => {
    const nov = await runMonthlyRoomProposal(env, actor(), "2026-10-05T12:00:00.000Z");
    expect(nov.detail).toMatch(/Room for 2026-11/);
    const ws = await runMonthlyRoomProposal(env, actor(), "2026-10-05T12:00:00.000Z");
    expect(ws.detail).toMatch(/queued Parker's own Workshop for 2026-11 — title set by the partners: "How to build community"/);
    expect((await row(ws.packetId!)).title).toBe("Workshop: How to build community");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE kind = 'ROOM_PACKET'").run();
    await env.WP_OS_DB.prepare("UPDATE evt_room_packet SET status = 'DECLINED' WHERE proposed_for_month = '2026-11'").run();
  });
});

describe("the request door", () => {
  it("a Workshop request for a SET month keeps the partners' title whatever was typed; the city is dropped", async () => {
    const res = await handleGeneratePacket(ctx("POST", { kind: "WORKSHOP", audience: "AI for tiny businesses (my wording)", month: "2026-09", city: "New York", notes: "keep it practical" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { packet: PacketRow; queued: boolean; cardId: string | null };
    expect(body.queued).toBe(true);
    expect(body.packet.kind).toBe("WORKSHOP");
    expect(body.packet.title).toBe("Workshop: How to use AI for small businesses / solopreneurs");
    expect(body.packet.origin).toBe("PARTNER_BRIEF");
    const brief = JSON.parse(body.packet.brief_json!) as { audience: string; city: string | null; notes: string; kind: string };
    expect(brief.audience).toBe("How to use AI for small businesses / solopreneurs");
    expect(brief.city).toBeNull();
    expect(brief.kind).toBe("WORKSHOP");
    expect(brief.notes).toMatch(/Asked as: AI for tiny businesses \(my wording\) · keep it practical/);
    const card = (await env.WP_OS_DB.prepare("SELECT title, description FROM work_card WHERE id = ?1").bind(body.cardId).first<{ title: string; description: string }>())!;
    expect(card.title).toBe("Parker: build the September 2026 Workshop packet — How to use AI for small businesses / solopreneurs");
    expect(card.description).toMatch(/title is SET by the partners/);
    expect(card.description).toMatch(/Virtual only — no venue is researched/);
  });

  it("a Workshop request for an OPEN month is built to the topic typed; 'let Parker think of one' works for a Workshop too", async () => {
    const res = await handleGeneratePacket(ctx("POST", { kind: "WORKSHOP", audience: "how to price a service business", month: "2026-12" }));
    const body = (await res.json()) as { packet: PacketRow };
    expect(body.packet.title).toBe("Workshop requested: how to price a service business");
    expect(body.packet.kind).toBe("WORKSHOP");
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
    expect(outcomes).toEqual(["PROGRESSED", "PROGRESSED", "PROGRESSED", "DONE"]);
    expect(stages).toEqual(["CONCEPTS", "PACKET", "PDF", "DONE"]);

    const p = await row(draft.id);
    expect(p.status).toBe("PROPOSED");
    expect(p.kind).toBe("WORKSHOP");
    expect(p.format).toBe("WORKSHOP");
    // THE TITLE IS THE PARTNERS'. The model offered "A title the model chose" and three invented concept titles.
    expect(p.title).toBe("How to use AI for small businesses / solopreneurs");
    const concepts = JSON.parse(p.concepts_json) as Array<{ title: string; chosen: boolean; promise: string; mode: string }>;
    expect(concepts).toHaveLength(3);
    expect(concepts.every((c) => c.title === "How to use AI for small businesses / solopreneurs")).toBe(true);
    expect(concepts.filter((c) => c.chosen)).toHaveLength(1);
    expect(concepts[0]!.promise).toMatch(/three admin tasks/);
    expect(p.central_question).toMatch(/^Leave with three admin tasks/);
    expect(p.live_url).toBe("https://westpeek.live");
    expect(p.document_id).toMatch(/^doc_/);

    const w = workshopViewOf(p)!;
    expect(w.topicSet).toBe(true);
    expect(w.delivery.where).toBe(WORKSHOP_WHERE);
    expect(w.runOfShow.filter((l) => l.segment === "BREAKOUT")).toHaveLength(2);
    expect(w.leaveWith[0]).toMatch(/automation checklist/);
    expect(w.invitations).toHaveLength(3);
    expect(w.invitations[0]!.body).toContain(LIVE_1); // a judged URL survives
    expect(w.notes.map((n) => n.url).sort()).toEqual([LIVE_1, LIVE_2, GUEST_PAGE].sort());
    expect(w.economics.free).toBe(true);
    expect(w.economics.lines.map((l) => l.key)).toEqual(["facilitator_fee", "production_time", "materials", "contingency"]);
    expect(w.economics.estimatedCostHighUsd).toBe(Math.round(950 * 1.1));
    expect(p.sponsor_count).toBe(0);
    expect(p.sponsor_total_usd).toBe(0);

    // Both partners were emailed ONCE, in the busy-executive format, with the packet under the rule.
    const mail = (await env.WP_OS_DB.prepare("SELECT event_type, payload_json FROM event_record WHERE object_type = 'room_packet' AND object_id = ?1 AND event_type LIKE 'deliverable.%' ORDER BY created_at").bind(p.id).all<{ event_type: string; payload_json: string }>()).results!;
    expect(mail).toHaveLength(2);
    expect(mail.map((m) => (JSON.parse(m.payload_json) as { to: string }).to).sort()).toEqual(["scooter@westpeek.ventures", "sequoia@westpeek.ventures"]);
    expect((JSON.parse(mail[0]!.payload_json) as { subject: string }).subject).toBe("Parker: your September 2026 Workshop — How to use AI for small busine…");
    const summary = workshopSummary(p, w);
    const rendered = renderExecEmail({ employee: "Parker", what: "x", tldr: summary.tldr, sections: summary.sections, details: renderWorkshopPacketText(p, w) });
    expect(lintExecEmail(rendered.subject, rendered.text, "Parker")).toEqual([]);
    expect(rendered.text).toMatch(/\*\*TL;DR:\*\* A September 2026 Workshop proposed: \*\*How to use AI for small businesses \/ solopreneurs\*\*/);
    expect(rendered.text).toMatch(/title set by the partners/);

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
    expect(text).toMatch(/RUN OF SHOW — 90 minutes/);
    expect(text).toMatch(/12:25 PM \(25 min\) — BREAKOUT: Exercise 1/);
    expect(text).toMatch(/INVITATIONS — three emails, yours to send/);
    expect(text).toMatch(/Free by design/);

    const view = { packetId: p.id, title: p.title, theme: p.theme, centralQuestion: p.central_question, month: p.proposed_for_month, format: p.format, targetMin: p.target_min, targetMax: p.target_max, audience: p.audience, origin: p.origin, brief: JSON.parse(p.brief_json!), pushback: p.pushback_md, concepts: JSON.parse(p.concepts_json), conceptChoiceMd: p.concept_choice_md, runOfShow: [], agendaMd: null, seedQuestions: [], guestIdeas: [], venues: [], sponsors: [], economics: null, sponsorThesis: null, risks: JSON.parse(p.risks_json), commitmentMd: p.commitment_md, pitchEmail: null, inviteCheck: null, alsoLookedAt: [], generatedAt: NOW };
    const html = renderWorkshopHtml(view, w);
    expect(html).toContain("Workshop packet · September 2026");
    expect(html).toContain(`Where — ${WORKSHOP_WHERE}`);
    expect(html).toContain("Three ways to run it, compared");
    expect(html).toContain("The join-code invitation flow");
    expect(html).not.toMatch(/Where it could be held|Who pays for it — ranked|room minimum|unverified until called|Venue hire/);
    expect(html).toContain("no venue, no food and beverage, no room hire");
  });

  it("verification strips a venue a model offers, an unjudged URL, and a guest without evidence; a set title is forced", () => {
    const raw = packetJson({ title: "Ignored", venues: [{ name: "A room in Brooklyn", source_url: "https://venue.example" }], facilitator: { name: "Somebody Unproven", kind: "GUEST", why: "seems good", evidence_url: "https://unchecked.example/bio" }, promo_one_liner: "See https://unchecked.example/promo" });
    const parsed = parseWorkshopPacket(raw, "How to build community")!;
    expect(parsed.title).toBe("How to build community");
    const { packet, flags } = verifyWorkshopPacket(parsed, [LIVE_1], raw);
    expect(flags.map((f) => f.code)).toEqual(expect.arrayContaining(["venue_removed", "unjudged_url_removed", "guest_without_evidence"]));
    expect(packet.facilitator.kind).toBe("PARTNER");
    expect(packet.facilitator.why).toMatch(/Guest idea to verify: Somebody Unproven/);
    expect(packet.promoOneLiner).toContain("[link removed: not a checked source]");
    expect(packet.delivery.where).toBe(WORKSHOP_WHERE);
    expect(JSON.stringify(packet)).not.toContain("Brooklyn");
    // Concepts for a set month: every title forced, one chosen.
    const c = parseWorkshopConcepts(conceptsJson(true), "How to build community")!;
    expect(c.concepts.every((x) => x.title === "How to build community")).toBe(true);
    expect(c.concepts.filter((x) => x.chosen)).toHaveLength(1);
    // Money: a sponsored one shows the keep; a free one shows zero sponsorship.
    const sponsored = computeWorkshopEconomics({ budgetLines: parsed.budgetLines, sponsorship: { free: false, note: "a tools vendor fits", categoryFit: "small-business software", askUsd: 3000 } });
    expect(sponsored.sponsorshipUsd).toBe(3000);
    expect(sponsored.keepUsd).toBe(3000 - sponsored.estimatedCostHighUsd);
    expect(computeWorkshopEconomics(parsed).sponsorshipUsd).toBe(0);
  });
});

describe("the chain, for an OPEN month", () => {
  it("three different concepts, one chosen; the chosen title names the Workshop; the page's detail carries the Workshop half", async () => {
    const draft = (await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE proposed_for_month = '2026-12' AND kind = 'WORKSHOP'").first<PacketRow>())!;
    await openPacketCard(env, draft);
    const { outcomes } = await buildToDone(await row(draft.id), deps(false));
    expect(outcomes[outcomes.length - 1]).toBe("DONE");
    const p = await row(draft.id);
    expect(p.title).toBe("A title the model chose");
    const concepts = JSON.parse(p.concepts_json) as Array<{ title: string; chosen: boolean }>;
    expect(concepts.map((c) => c.title)).toEqual(["Price your service in 90 minutes", "Hire your first contractor", "Community that sells"]);
    expect(concepts[0]!.chosen).toBe(true);
    expect(workshopViewOf(p)!.topicSet).toBe(false);

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
