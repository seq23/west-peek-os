import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { actorFromIdentity } from "../src/worker/services/authorize";
import { sweepIdentity, sweepOnce } from "../src/worker/services/workSweep";
import {
  BUILD_STAGES,
  decidePacket,
  generatePacket,
  openPacketCard,
  parseBrief,
  parseState,
  queueDraft,
  renderPacketText,
  runMonthlyRoomProposal,
  runRoomPacketCard,
  runStage,
  type ChainDeps,
  type PacketRow,
} from "../src/worker/services/roomPacket";
import type { SearchResult } from "../src/worker/services/liveSearch";

/**
 * Parker runs the whole chain (15 Sep 2026).
 *
 * The operator's verdict on the one-prompt packet was "sub par". This proves the chain without a
 * model, a browser or a network: her brief is on the record and Parker's card is open the moment
 * she asks; the sweep runs one stage per tick and charges no attempt for a stage that completed;
 * sponsors carry evidence that answered and contacts read off fetched pages; the named seed with
 * no history is said to have none; the packet, the PDF document and the two emails all land.
 */

let t: TestDb;
let env: Env;
const NOW = "2026-09-15T12:00:00.000Z";

const VENUE_URL = "https://www.saga-nyc.com/private-events";
const HARVEY_EVIDENCE = "https://www.harvey.ai/blog/harvey-us-open";
const HARVEY_TEAM = "https://www.harvey.ai/team";
const DEAD_URL = "https://www.dead.example/gone";

const search = async (): Promise<SearchResult> => ({
  ok: true,
  hits: [{ name: "SAGA", url: VENUE_URL, description: "Charlie Mitchell's tasting room, 63rd floor" }],
  citations: [VENUE_URL],
  aiRunId: null,
  detail: "1 venue(s)",
});

const discoveryJson = JSON.stringify({ results: [
  { org_name: "Harvey", category: "LEGAL", evidence_url: HARVEY_EVIDENCE, evidence_note: "official AI partner of the 2025 US Open", why_this_audience: "sells to elite law firms" },
  { org_name: "J.P. Morgan Private Bank", category: "BANKING", evidence_url: "https://www.jpmorgan.com/private-bank/events", evidence_note: "sponsors MCCA's gala", why_this_audience: "courts partners and GCs" },
  { org_name: "Ghost Co", category: "OTHER", evidence_url: DEAD_URL, evidence_note: "a page that is gone", why_this_audience: "…" },
] });

const researchJson = (org: string) => JSON.stringify({
  history: org.startsWith("Harvey")
    ? [{ url: "https://www.harvey.ai/blog/harvey-warriors", note: "partner of the Golden State Warriors" }, { url: DEAD_URL, note: "gone" }]
    : org.startsWith("Clio") ? [] : [{ url: "https://www.jpmorgan.com/private-bank/mcca", note: "MCCA gala 2025" }],
  contacts: org.startsWith("Harvey")
    ? [{ name: "Nobody Real", title: "Head of Nothing", source_url: "https://www.harvey.ai/nobody" }, { name: "Mali Robertson", title: "Director of Brand Partnerships", source_url: HARVEY_TEAM }]
    : [],
  strategic_language: org.startsWith("Harvey") ? ["the AI platform for elite law firms"] : ["for the people who lead"],
  summary: org.startsWith("Clio") ? "No sponsorship history found on any public page." : `${org} sponsors things.`,
  category: org.startsWith("Harvey") || org.startsWith("Clio") ? "LEGAL" : "BANKING",
});

const conceptsJson = JSON.stringify({
  concepts: [
    { title: "The Scaled Boardroom", format: "DINNER", premise: "an executive dinner and think tank", tone: "serious", value_to_sponsor: "six minutes at the head of the table", who_it_fits: "partners and GCs", cost_band: "$22–28K", signature_moment: "the one-page brief each guest writes for the room", venue_direction: "a Black-chef-led private dining room in Manhattan, because the room should say who it is for", chosen: true },
    { title: "Prompt-to-Partner War Room", format: "WORKSHOP", premise: "live work with the sponsor's tool", tone: "electric", value_to_sponsor: "hands on the product", who_it_fits: "associates", cost_band: "$15–20K", signature_moment: "the live brief", venue_direction: "a moot courtroom" },
    { title: "Founders & Advocates", format: "SALON", premise: "speed-venturing", tone: "brisk", value_to_sponsor: "…", who_it_fits: "founders", cost_band: "$10–14K", signature_moment: "…", venue_direction: "…" },
  ],
  choice_rationale: "A senior crowd wants a serious table, and the sponsor's executive gets a real moment.",
  pushback: "The firm's own list cannot fill forty seats of Black lawyers; widen to the founders who need them, or co-host with an association.",
});

function packetJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: "The Scaled Boardroom",
    theme: "Black lawyers and the founders who need them",
    central_question: "What does the next decade of Black legal leadership need from its peers?",
    format: "DINNER",
    target_min: 30,
    target_max: 40,
    audience: "senior associates and new partners, in-house counsel, and the founders who hire them",
    agenda_md: "## 6:30 arrivals",
    run_of_show: [
      { time: "6:30 PM", minutes: 30, what: "Arrival, cocktails", who: "Sequoia Taylor (host)" },
      { time: "7:00 PM", minutes: 5, what: "Welcome", who: "Sequoia Taylor" },
      { time: "7:05 PM", minutes: 6, what: "Harvey's executive", who: "Harvey — 6 minutes" },
      { time: "7:15 PM", minutes: 60, what: "Dinner, Chatham House rule", who: "moderator" },
      { time: "8:15 PM", minutes: 20, what: "Signature moment", who: "moderator" },
      { time: "9:15 PM", minutes: 30, what: "Nightcap", who: "Parker" },
    ],
    seed_questions: ["Who sponsored you?", "Which client did you turn down?", "When did you know?"],
    guest_ideas: [{ description: "a newly made partner at an AmLaw 50 firm", why: "lived it this year" }],
    venues: [{ name: "SAGA", city: "New York", capacity: 40, why_here: "Charlie Mitchell, the first Black chef in NYC with a Michelin star", room_minimum_usd: 5500, source_url: VENUE_URL, estimate_low_usd: 9000, estimate_high_usd: 11000, estimate_basis: "$250/head × 40 comp" }],
    budget: [{ key: "food_beverage", low_usd: 10000, high_usd: 10000, basis: "$250/head × 40 incl. tax and 22% service" }, { key: "venue", low_usd: 5500, high_usd: 5500, basis: "room minimum" }],
    sponsorship: { slots: [{ tier: "TITLE", count: 1, ask_usd: 20000, gets: "six minutes, the credit" }, { tier: "SUPPORTING", count: 2, ask_usd: 10000, gets: "a seat" }], exclusive_usd: 45000, exclusive_gets: "the whole room", rationale: "forty seats carry three logos" },
    sponsor_thesis: "Underwrite the room where the next generation of counsel meets each other.",
    sponsor_prospects: [
      { org_name: "Harvey", category: "LEGAL", tier: "PRESENTING", ask_usd: 20000, rank: 1, fit_argument: "'the AI platform for elite law firms' — this is that room", pitch: "Be in the room", evidence_url: HARVEY_EVIDENCE, evidence_note: "US Open", contact_name: "Mali Robertson", contact_title: "Director of Brand Partnerships", contact_source_url: HARVEY_TEAM },
      { org_name: "J.P. Morgan Private Bank", category: "BANKING", tier: "SUPPORTING", ask_usd: 10000, rank: 2, fit_argument: "courts partners and GCs", pitch: "…", evidence_url: "https://www.jpmorgan.com/made-up", contact_name: "Somebody Invented", contact_title: "VP" },
    ],
    pitch_email: { to: "Mali Robertson, Director of Brand Partnerships, Harvey", subject: "A room of the lawyers Harvey is built for", body: "Mali —\n\nWest Peek Ventures is hosting…\n\n— Sequoia" },
    risks: ["A single legal sponsor reads as an endorsement"],
    commitment_md: "About $25k of spend, Parker's time, Harvey approached in West Peek's name.",
    pushback: "Widen the audience to the founders who need these lawyers.",
    concept_choice_md: "The boardroom wins because a senior crowd wants a serious table.",
    ...over,
  });
}

/** A one-page PDF, enough for the document store and the page count. */
const TINY_PDF = btoa("%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF");

function deps(over: Partial<ChainDeps> = {}): ChainDeps {
  return {
    search,
    research: async (_env, _actor, prompt) => {
      if (prompt.includes("PAY TO BE IN FRONT OF")) return { ok: true, text: discoveryJson, citations: [], detail: "ok" };
      const org = /Research (.+?) as a sponsor/.exec(prompt)?.[1] ?? "?";
      return { ok: true, text: researchJson(org), citations: [], detail: "ok" };
    },
    urlCheck: async (url) => (url === DEAD_URL ? 404 : url.includes("jpmorgan") ? 403 : 200),
    pageText: async (url) => (url === HARVEY_TEAM ? "<h3>Mali <b>Robertson</b></h3> Director of Brand Partnerships" : url === "https://www.harvey.ai/nobody" ? "<p>Team page</p>" : null),
    synthesise: async (prompt) => ({ text: prompt.includes("THREE distinct concepts") ? conceptsJson : packetJson(), aiRunId: null }),
    render: async () => ({ pdfBase64: TINY_PDF, pageCount: 1 }),
    ...over,
  };
}

const actor = () => actorFromIdentity({ ...sweepIdentity(), id: "fu_sequoia_taylor" });
const BRIEF = { audience: "an event for top Black lawyers in our network", month: "2026-10", city: "New York", sponsorProspects: ["Harvey AI (harvey.ai)", "Clio"], notes: "$10,000 pocketed to the firm; push back where needed" };

async function row(id: string): Promise<PacketRow> {
  return (await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE id = ?1").bind(id).first<PacketRow>())!;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled", WP_OS_DOCUMENTS: t.docs } as Partial<Env>);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("her brief becomes a card on Parker's desk, then a packet", () => {
  it("records the brief and opens Parker's card before any model runs", async () => {
    const draft = await queueDraft(env, actor(), { month: "2026-10", origin: "PARTNER_BRIEF", brief: BRIEF });
    expect(draft.status).toBe("DRAFT");
    expect(draft.build_stage).toBe("QUEUED");
    expect(parseBrief(draft.brief_json)?.sponsorProspects).toEqual(["Harvey AI (harvey.ai)", "Clio"]);
    const card = await openPacketCard(env, draft);
    expect(card.opened).toBe(true);
    const c = (await env.WP_OS_DB.prepare("SELECT kind, owner_id, state, title FROM work_card WHERE id = ?1").bind(card.cardId).first<{ kind: string; owner_id: string; state: string; title: string }>())!;
    expect(c.kind).toBe("ROOM_PACKET");
    expect(c.owner_id).toBe("aie_parker");
    expect(c.title).toContain("October 2026 Room packet");
    expect((await row(draft.id)).work_card_id).toBe(card.cardId);
    // Asking again does not open a second card.
    expect((await openPacketCard(env, await row(draft.id))).opened).toBe(false);
  });

  it("the sweep runs one stage per tick, charges no attempt for a finished stage, and lands the packet, the PDF and the two emails", async () => {
    const draft = (await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE proposed_for_month = '2026-10'").first<PacketRow>())!;
    const runner = (e: Env, card: Parameters<typeof runRoomPacketCard>[1]) => runRoomPacketCard(e, card, deps());
    const outcomes: string[] = [];
    const stages: string[] = [];
    for (let i = 0; i < 12; i++) {
      const out = await sweepOnce(env, new Date(NOW), { roomPacket: runner });
      outcomes.push(out.outcome);
      stages.push((await row(draft.id)).build_stage);
      if (out.outcome === "DONE" || out.outcome === "NOTHING_WAITING") break;
    }
    // DISCOVER → RESEARCH (two ticks: Harvey + Clio, then J.P. Morgan) → CONCEPTS → VENUES → PACKET → PDF → done.
    expect(outcomes).toEqual(["PROGRESSED", "PROGRESSED", "PROGRESSED", "PROGRESSED", "PROGRESSED", "PROGRESSED", "DONE"]);
    expect(stages).toEqual(["RESEARCH", "RESEARCH", "CONCEPTS", "VENUES", "PACKET", "PDF", "DONE"]);
    const card = (await env.WP_OS_DB.prepare("SELECT state, work_attempts, description FROM work_card WHERE id = ?1").bind(draft.work_card_id).first<{ state: string; work_attempts: number; description: string }>())!;
    expect(card.state).toBe("DONE");
    // Six progressed ticks gave their attempt back; only the finishing tick's stands.
    expect(card.work_attempts).toBe(1);
    expect(card.description).toMatch(/PDF: https:\/\/os\.joinwestpeek\.com\/api\/documents\/doc_/);

    const p = await row(draft.id);
    expect(p.status).toBe("PROPOSED");
    expect(p.origin).toBe("PARTNER_BRIEF");
    expect(p.title).toBe("The Scaled Boardroom");
    expect(p.document_id).toMatch(/^doc_/);
    expect(p.pushback_md).toMatch(/Widen the audience/);
    expect(JSON.parse(p.concepts_json)).toHaveLength(3);
    expect(JSON.parse(p.concepts_json).filter((c: { chosen: boolean }) => c.chosen)).toHaveLength(1);
    expect(JSON.parse(p.run_of_show_json)).toHaveLength(6);
    expect(JSON.parse(p.pitch_email_json!).subject).toContain("Harvey");
    const invite = JSON.parse(p.invite_check_json!) as { verdict: string; matchedOn: string[]; totalContacts: number };
    expect(invite.matchedOn).toEqual(["lawyers and legal roles"]);
    expect(invite.verdict).toBe("STARTING_LIST"); // an empty test firm is a starting list of zero — information, never a veto
    const eco = JSON.parse(p.economics_json) as { sponsorCount: number; sponsorTargetHighUsd: number; keepTargetUsd: number; requiredUsd: number; lines: Array<{ key: string; basis: string }> };
    expect(eco.sponsorCount).toBe(3);
    expect(eco.sponsorTargetHighUsd).toBe(40_000);
    expect(eco.keepTargetUsd).toBe(10_000);
    expect(eco.lines.find((l) => l.key === "food_beverage")!.basis).toContain("22% service");
    expect(p.sponsor_count).toBe(3);
    expect(p.sponsor_total_usd).toBe(40_000);

    // The sponsors: ranked, with evidence that answered and a contact read off a fetched page.
    const sponsors = (await env.WP_OS_DB.prepare("SELECT org_name, rank, tier, evidence_url, contact_name, contact_title, contact_source_url, fit_argument, note, category FROM evt_sponsor_prospect WHERE packet_id = ?1 ORDER BY rank").bind(p.id).all<{ org_name: string; rank: number; tier: string; evidence_url: string | null; contact_name: string | null; contact_title: string | null; contact_source_url: string | null; fit_argument: string | null; note: string | null; category: string }>()).results!;
    expect(sponsors.map((s) => s.org_name)).toEqual(["Harvey", "J.P. Morgan Private Bank", "Clio"]);
    expect(sponsors[0]).toMatchObject({ rank: 1, tier: "PRESENTING", evidence_url: HARVEY_EVIDENCE, contact_name: "Mali Robertson", contact_title: "Director of Brand Partnerships", contact_source_url: HARVEY_TEAM });
    expect(sponsors[0]!.fit_argument).toContain("elite law firms");
    // The bank's made-up evidence was swapped for the research's verified page; its invented contact went.
    // The bank's site answered 403 — a guarded page is kept and marked for a person to verify.
    expect(sponsors[1]!.evidence_url).toBe("https://www.jpmorgan.com/private-bank/events");
    expect(parseState(p.build_state_json).candidates.find((c) => c.orgName.startsWith("J.P."))!.evidenceNote).toMatch(/refused an automated read/);
    expect(parseState(p.build_state_json).dropped).toEqual([{ orgName: "Ghost Co", url: DEAD_URL, status: 404 }]);
    expect(sponsors[1]!.contact_name).toBeNull();
    // Her second seed had no sponsorship history: kept, last, and said so.
    expect(sponsors[2]!.note).toMatch(/No sponsorship history was found/);
    expect(sponsors[2]!.evidence_url).toBeNull();
    expect(sponsors[2]!.category).toBe("LEGAL");

    const venues = (await env.WP_OS_DB.prepare("SELECT name, why_here, room_minimum_usd, estimate_low_usd, is_fallback FROM evt_packet_venue WHERE packet_id = ?1").bind(p.id).all<{ name: string; why_here: string; room_minimum_usd: number; estimate_low_usd: number; is_fallback: number }>()).results!;
    expect(venues).toEqual([{ name: "SAGA", why_here: "Charlie Mitchell, the first Black chef in NYC with a Michelin star", room_minimum_usd: 5500, estimate_low_usd: 9000, is_fallback: 0 }]);

    // The PDF is a document of its own type, and the bytes are in the bucket.
    const doc = (await env.WP_OS_DB.prepare("SELECT doc_type, title, current_version_id FROM document WHERE id = ?1").bind(p.document_id).first<{ doc_type: string; title: string; current_version_id: string }>())!;
    expect(doc.doc_type).toBe("ROOM_PACKET");
    expect(doc.title).toContain("The Scaled Boardroom");
    const version = (await env.WP_OS_DB.prepare("SELECT r2_key, content_type FROM document_version WHERE id = ?1").bind(doc.current_version_id).first<{ r2_key: string; content_type: string }>())!;
    expect(version.content_type).toBe("application/pdf");
    expect(await t.docs.head(version.r2_key)).not.toBeNull();

    // Both partners were emailed once, with Parker's introduction and the PDF link in the body.
    const mail = (await env.WP_OS_DB.prepare("SELECT event_type, payload_json FROM event_record WHERE object_type = 'room_packet' AND object_id = ?1 AND event_type LIKE 'deliverable.%' ORDER BY created_at").bind(p.id).all<{ event_type: string; payload_json: string }>()).results!;
    expect(mail).toHaveLength(2);
    expect(mail.map((m) => (JSON.parse(m.payload_json) as { to: string }).to).sort()).toEqual(["scooter@westpeek.ventures", "sequoia@westpeek.ventures"]);
    expect((JSON.parse(mail[0]!.payload_json) as { subject: string }).subject).toBe("Parker: your October 2026 Room — The Scaled Boardroom (PDF inside)");
  });

  it("renders the whole packet as the email body, opening with who Parker is", async () => {
    const p = (await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE title = 'The Scaled Boardroom'").first<PacketRow>())!;
    const text = renderPacketText(p, [{ name: "SAGA", city: "New York", capacity: 40, price_low_usd: null, price_high_usd: null, price_note: null, booking_phone: null, booking_email: null, source_url: VENUE_URL, why_here: "Charlie Mitchell", room_minimum_usd: 5500, estimate_low_usd: 9000, estimate_high_usd: 11000, estimate_basis: "comp" }], [
      { org_name: "Harvey", category: "LEGAL", tier: "PRESENTING", ask_low_usd: 20000, pitch: "Be in the room", ask_detail: null, source_url: HARVEY_EVIDENCE, note: "Named by the partner in her brief.", evidence_url: HARVEY_EVIDENCE, evidence_note: "US Open", contact_name: "Mali Robertson", contact_title: "Director of Brand Partnerships", contact_source_url: HARVEY_TEAM, fit_argument: "their words", rank: 1 },
    ]);
    expect(text.startsWith("I'm Parker, West Peek's Event Marketing Coordinator.")).toBe(true);
    for (const heading of ["WHAT WAS ASKED FOR", "WHERE I PUSH BACK", "THE CONCEPT", "CAN OUR OWN LIST FILL IT?", "RUN OF SHOW", "VENUE SHORTLIST", "BUDGET", "SPONSORSHIP STRUCTURE", "SPONSORS, RANKED", "THE PITCH", "RISKS", "WHAT SAYING KEEP COMMITS THE FIRM TO"]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain(`Download the packet (PDF): https://os.joinwestpeek.com/api/documents/${p.document_id}/download`);
    expect(text).toContain("Mali Robertson, Director of Brand Partnerships (read from https://www.harvey.ai/team)");
    expect(text).toContain("1 × title at $20,000");
    expect(text).toContain("Charlie Mitchell");
    expect(text).toContain("6:30 PM (30 min) — Arrival, cocktails — Sequoia Taylor (host)");
  });

  it("a stage that fails leaves the packet where it was, with the reason, and keeps what earlier stages found", async () => {
    const draft = await queueDraft(env, actor(), { month: "2026-11", origin: "PARTNER_BRIEF", brief: { ...BRIEF, audience: "founders who sold to private equity", month: "2026-11" } });
    const failing = deps({ synthesise: async () => ({ text: "I cannot help with that.", aiRunId: null }) });
    await runStage(env, await row(draft.id), failing); // DISCOVER
    await runStage(env, await row(draft.id), failing); // RESEARCH
    await runStage(env, await row(draft.id), failing); // RESEARCH
    await expect(runStage(env, await row(draft.id), failing)).rejects.toThrow(/CONCEPTS: the concepts did not come back/);
    const stuck = await row(draft.id);
    expect(stuck.status).toBe("DRAFT");
    expect(stuck.build_stage).toBe("CONCEPTS");
    expect(stuck.build_error).toMatch(/CONCEPTS/);
    expect(parseState(stuck.build_state_json).research.length).toBeGreaterThan(0);
    // The same stage is retried with a model that answers, and the chain carries on from there.
    const out = await runStage(env, stuck, deps());
    expect(out.stage).toBe("CONCEPTS");
    expect(out.next).toBe("VENUES");
  });

  it("dismissing a draft takes its card off Parker's desk; a draft cannot be kept", async () => {
    const draft = await queueDraft(env, actor(), { month: "2026-12", origin: "PARTNER_BRIEF", brief: { ...BRIEF, audience: "something", month: "2026-12" } });
    const card = await openPacketCard(env, draft);
    await expect(decidePacket(env, actor(), draft.id, "APPROVED")).rejects.toThrow(/not been built/);
    const dismissed = await decidePacket(env, actor(), draft.id, "DECLINED", "never mind");
    expect(dismissed.status).toBe("DECLINED");
    const c = (await env.WP_OS_DB.prepare("SELECT state FROM work_card WHERE id = ?1").bind(card.cardId).first<{ state: string }>())!;
    expect(c.state).toBe("CANCELLED");
  });

  it("the one-call form runs every stage to the end", async () => {
    const out = await generatePacket(env, actor(), { month: "2027-01", brief: { ...BRIEF, month: "2027-01", sponsorProspects: [] } }, deps());
    expect(out.packet.status).toBe("PROPOSED");
    expect(out.packet.build_stage).toBe("DONE");
    expect(out.stages.map((s) => s.stage)).toEqual(["DISCOVER", "RESEARCH", "CONCEPTS", "VENUES", "PACKET", "PDF"]);
    expect(out.venuesKept).toBe(1);
    expect(BUILD_STAGES).toContain(out.packet.build_stage);
  });

  it("without a browser the packet still lands and the email says there is no PDF", async () => {
    const out = await generatePacket(env, actor(), { month: "2027-02", brief: { ...BRIEF, month: "2027-02", sponsorProspects: [] } }, deps({ render: async () => ({ pdfBase64: null, reason: "no browser here" }) }));
    expect(out.packet.status).toBe("PROPOSED");
    expect(out.packet.document_id).toBeNull();
    expect(parseState(out.packet.build_state_json).pdfError).toBe("no browser here");
    const last = out.stages[out.stages.length - 1]!;
    expect(last.note).toMatch(/no PDF: no browser here/);
  });
});

describe("the Rooms job does one cheap thing", () => {
  it("opens a card for a draft that has none, then queues Parker's own Room for the following month, then says the shelf is stocked", async () => {
    // A draft whose card was cancelled (dismissed above) does not come back; a fresh draft with no card does.
    const orphan = await queueDraft(env, actor(), { month: "2027-03", origin: "PARTNER_BRIEF", brief: { ...BRIEF, audience: "orphan", month: "2027-03" } });
    // Oldest first: the November draft left at CONCEPTS above has no card either, so it goes first.
    const opened: string[] = [];
    for (let i = 0; i < 3 && !opened.includes(orphan.id); i++) {
      const out = await runMonthlyRoomProposal(env, actor(), NOW);
      expect(out.generated).toBe(true);
      expect(out.detail).toMatch(/opened Parker's card/);
      opened.push(out.packetId!);
    }
    expect(opened).toContain(orphan.id);
    expect((await row(orphan.id)).work_card_id).not.toBeNull();

    // October is stocked (built above); from mid-November, December has only a dismissed draft — so
    // Parker queues his own Room for December.
    await env.WP_OS_DB.prepare("DELETE FROM evt_room_packet WHERE proposed_for_month = '2026-12'").run();
    const second = await runMonthlyRoomProposal(env, actor(), "2026-11-15T12:00:00.000Z");
    expect(second.generated).toBe(true);
    expect(second.detail).toMatch(/queued Parker's own Room for 2026-12/);
    const own = await row(second.packetId!);
    expect(own.origin).toBe("PARKER");
    expect(own.status).toBe("DRAFT");
    expect(own.work_card_id).not.toBeNull();

    // ONE ROOM AND ONE WORKSHOP A MONTH (16 Sep 2026): the next run queues December's Workshop —
    // its own guard, its own card — and only then is the month stocked.
    const third = await runMonthlyRoomProposal(env, actor(), "2026-11-16T12:00:00.000Z");
    expect(third.generated).toBe(true);
    expect(third.detail).toMatch(/queued Parker's own Workshop for 2026-12/);
    expect((await row(third.packetId!)).kind).toBe("WORKSHOP");
    const fourth = await runMonthlyRoomProposal(env, actor(), "2026-11-16T12:30:00.000Z");
    expect(fourth.generated).toBe(false);
    expect(fourth.detail).toMatch(/2026-12 already has a Room and a Workshop proposal; \d+ request\(s\) being built/);
  });

  it("'propose again with changes' links the new packet to the declined one", async () => {
    const built = (await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE proposed_for_month = '2027-01'").first<PacketRow>())!;
    await decidePacket(env, actor(), built.id, "DECLINED", "too generic — make it about GC hiring");
    const again = await queueDraft(env, actor(), { month: "2027-01", origin: "PARTNER_BRIEF", brief: { ...BRIEF, audience: "general counsel hired in the last year", month: "2027-01" }, parentPacketId: built.id });
    expect(again.parent_packet_id).toBe(built.id);
    expect((await row(built.id)).decision_note).toBe("too generic — make it about GC hiring");
  });
});
