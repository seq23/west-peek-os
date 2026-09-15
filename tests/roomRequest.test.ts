import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { actorFromIdentity } from "../src/worker/services/authorize";
import { sweepIdentity } from "../src/worker/services/workSweep";
import {
  MAX_BUILD_ATTEMPTS,
  decidePacket,
  generatePacket,
  parseBrief,
  renderPacketText,
  runMonthlyRoomProposal,
  type PacketRow,
} from "../src/worker/services/roomPacket";
import type { SearchResult } from "../src/worker/services/liveSearch";

/**
 * A Room is asked for, or thought of — the two doors, one queue (15 Sep 2026).
 *
 * Operator: "i like that he can think of a room on demand but i need to be able to do that OR ask
 * for a specific type of room." Both packets Parker proposed before this were declined; this proves
 * the parts that changed without a model or a network: her brief is on the record before a model
 * runs, the packet records which door it came through, a failed build is visible and retried, the
 * job proposes for the FOLLOWING month, and the email carries the whole packet.
 */

let t: TestDb;
let env: Env;
const NOW = "2026-09-15T12:00:00.000Z";

const VENUE_URL = "https://www.gramercytavern.com/private-dining";
const search = async (): Promise<SearchResult> => ({
  ok: true,
  hits: [{ name: "Gramercy Tavern", url: VENUE_URL, description: "private dining" }],
  citations: [VENUE_URL, "https://www.harvey.ai/"],
  aiRunId: null,
  detail: "1 venue(s)",
});

function packetJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: "The Rising Counsel Room",
    theme: "Black lawyers on the rise",
    central_question: "What does the next decade of Black legal leadership need from its peers?",
    format: "DINNER",
    target_min: 25,
    target_max: 35,
    audience: "senior associates and new partners at large firms, in-house counsel at growth companies",
    agenda_md: "## 6:30 arrivals\n## 7:00 seated",
    seed_questions: ["Who sponsored you, and what did it cost them?", "Which client did you turn down?", "When did you know you would make partner?"],
    guest_ideas: [{ description: "a newly made partner at an AmLaw 50 firm", why: "lived it this year" }],
    venues: [{ name: "Gramercy Tavern", city: "New York", capacity: 40, price_low_usd: 6000, price_high_usd: 9000, source_url: VENUE_URL }],
    sponsor_thesis: "Underwrite the room where the next generation of counsel meets each other.",
    sponsor_count: 2,
    sponsor_prospects: [
      { org_name: "Harvey", category: "LEGAL", ask_usd: 10000, why_fit: "legal AI, the audience's tool", pitch: "Be in the room with the lawyers who will buy you", source_url: "https://www.harvey.ai/" },
      { org_name: "Carta", category: "EQUITY_CAPTABLE", ask_usd: 10000, why_fit: "counsel to founders", pitch: "Meet the lawyers your customers call" },
    ],
    risks: ["A single legal sponsor reads as an endorsement"],
    commitment_md: "About $10k of venue and food, Parker's time, and Harvey and Carta approached in West Peek's name.",
    ...over,
  });
}

const synthOk = async () => ({ text: packetJson(), aiRunId: null });
const actor = () => actorFromIdentity({ ...sweepIdentity(), id: "fu_sequoia_taylor" });

async function row(id: string): Promise<PacketRow> {
  return (await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE id = ?1").bind(id).first<PacketRow>())!;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("her brief becomes a packet", () => {
  it("records the brief and the door before the model runs, then builds in place", async () => {
    const out = await generatePacket(env, actor(), {
      month: "2026-10",
      brief: { audience: "top Black lawyers on the rise", month: "2026-10", city: "New York", sponsorProspects: ["Harvey AI (harvey.ai)"], notes: null },
    }, { search, synthesise: synthOk });

    const p = out.packet;
    expect(p.status).toBe("PROPOSED");
    expect(p.origin).toBe("PARTNER_BRIEF");
    expect(p.requested_by).toBe("fu_sequoia_taylor");
    expect(parseBrief(p.brief_json)?.audience).toBe("top Black lawyers on the rise");
    expect(p.title).toBe("The Rising Counsel Room");
    expect(p.sponsor_count).toBe(2);
    expect(p.sponsor_total_usd).toBe(20_000);
    expect(JSON.parse(p.risks_json)).toHaveLength(1);
    expect(p.commitment_md).toMatch(/Harvey and Carta/);

    // Her named prospect is a pipeline row, first, and says it came from her.
    const sponsors = (await env.WP_OS_DB.prepare("SELECT org_name, note, source_url, ask_low_usd, owner_employee FROM evt_sponsor_prospect WHERE packet_id = ?1 ORDER BY created_at").bind(p.id).all<{ org_name: string; note: string; source_url: string | null; ask_low_usd: number; owner_employee: string }>()).results!;
    expect(sponsors.map((s) => s.org_name)).toEqual(["Harvey", "Carta"]);
    expect(sponsors[0]!.note).toMatch(/partner/);
    expect(sponsors[0]!.source_url).toBe("https://www.harvey.ai/");
    expect(sponsors[0]!.ask_low_usd).toBe(10_000);
    expect(sponsors[0]!.owner_employee).toBe("Parker");
    // Parker's second prospect cited nothing the search returned; it survives without a citation.
    expect(sponsors[1]!.source_url).toBeNull();

    // The finished deliverable went to BOTH partners — recorded even though no mail provider is
    // configured here, so the attempt and its reason are on the record.
    const mail = (await env.WP_OS_DB.prepare("SELECT event_type, payload_json FROM event_record WHERE object_type = 'room_packet' AND object_id = ?1 AND event_type LIKE 'deliverable.%' ORDER BY created_at").bind(p.id).all<{ event_type: string; payload_json: string }>()).results!;
    expect(mail).toHaveLength(2);
    const to = mail.map((m) => (JSON.parse(m.payload_json) as { to: string }).to).sort();
    expect(to).toEqual(["scooter@westpeek.ventures", "sequoia@westpeek.ventures"]);
    expect((JSON.parse(mail[0]!.payload_json) as { subject: string }).subject).toBe("Parker: your October 2026 Room — The Rising Counsel Room");
  });

  it("renders the whole packet as the email body", async () => {
    const p = (await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE title = 'The Rising Counsel Room'").first<PacketRow>())!;
    const text = renderPacketText(p, [{ name: "Gramercy Tavern", city: "New York", capacity: 40, price_low_usd: 6000, price_high_usd: 9000, price_note: null, booking_phone: null, booking_email: null, source_url: VENUE_URL }], [
      { org_name: "Harvey", category: "LEGAL", ask_low_usd: 10000, pitch: "Be in the room", ask_detail: "legal AI", source_url: "https://www.harvey.ai/", note: "Named by the partner in her brief." },
    ]);
    for (const heading of ["WHAT WAS ASKED FOR", "CENTRAL QUESTION", "WHO IS IN THE ROOM", "FORMAT AND RUN OF SHOW", "VENUE SHORTLIST", "BUDGET VS SPONSORSHIP", "SPONSOR PROSPECTS", "RISKS", "WHAT SAYING KEEP COMMITS THE FIRM TO"]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("top Black lawyers on the rise");
    expect(text).toContain("2 sponsor(s) at $10,000 each");
    expect(text).toContain("Harvey (legal) — ask $10,000");
  });

  it("a request whose build fails stays on the record as a draft, with the reason", async () => {
    const failing = async () => ({ text: "I cannot help with that.", aiRunId: null });
    await expect(generatePacket(env, actor(), {
      month: "2026-11",
      brief: { audience: "founders who sold to private equity", month: "2026-11", city: null, sponsorProspects: [], notes: null },
    }, { search, synthesise: failing })).rejects.toThrow(/usable packet/);

    const draft = (await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE proposed_for_month = '2026-11'").first<PacketRow>())!;
    expect(draft.status).toBe("DRAFT");
    expect(draft.build_attempts).toBe(1);
    expect(draft.build_error).toMatch(/usable packet/);
    expect(draft.title).toBe("Room requested: founders who sold to private equity");
  });

  it("the job builds a waiting draft before it thinks of its own Room", async () => {
    const out = await runMonthlyRoomProposal(env, actor(), NOW, { search, synthesise: synthOk });
    expect(out.generated).toBe(true);
    expect(out.detail).toMatch(/built the Room that was asked for/);
    const built = await row(out.packetId!);
    expect(built.proposed_for_month).toBe("2026-11");
    expect(built.status).toBe("PROPOSED");
    expect(built.origin).toBe("PARTNER_BRIEF");
    expect(built.build_attempts).toBe(2);
  });

  it("a draft that fails MAX_BUILD_ATTEMPTS times is left for a person, and the job says so", async () => {
    const failing = async () => ({ text: "no", aiRunId: null });
    await expect(generatePacket(env, actor(), {
      month: "2026-12",
      brief: { audience: "something the model cannot do", month: "2026-12", city: null, sponsorProspects: [], notes: null },
    }, { search, synthesise: failing })).rejects.toThrow();
    for (let i = 1; i < MAX_BUILD_ATTEMPTS; i++) {
      await expect(runMonthlyRoomProposal(env, actor(), NOW, { search, synthesise: failing })).rejects.toThrow();
    }
    const stuck = (await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE proposed_for_month = '2026-12'").first<PacketRow>())!;
    expect(stuck.status).toBe("DRAFT");
    expect(stuck.build_attempts).toBe(MAX_BUILD_ATTEMPTS);
    // October already has a packet, so Parker's own idea is not needed; the stuck draft is named.
    const out = await runMonthlyRoomProposal(env, actor(), NOW, { search, synthesise: failing });
    expect(out.generated).toBe(false);
    expect(out.detail).toMatch(/2026-10 already has a proposal; 1 request\(s\) could not be built/);
  });

  it("a stuck draft cannot be kept — there is nothing to keep — but can be dismissed", async () => {
    const stuck = (await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE proposed_for_month = '2026-12'").first<PacketRow>())!;
    await expect(decidePacket(env, actor(), stuck.id, "APPROVED")).rejects.toThrow(/not been built/);
    const dismissed = await decidePacket(env, actor(), stuck.id, "DECLINED", "never mind");
    expect(dismissed.status).toBe("DECLINED");
    expect(dismissed.decision_note).toBe("never mind");
  });
});

describe("Parker's own Room, on the clock", () => {
  it("proposes for the FOLLOWING month only when that month has none", async () => {
    // October and November have requested Rooms. Run the job from mid-November: December has no
    // packet (the dismissed draft is cleared), so Parker proposes one — for December, not November.
    await env.WP_OS_DB.prepare("DELETE FROM evt_room_packet WHERE proposed_for_month = '2026-12'").run();
    const out = await runMonthlyRoomProposal(env, actor(), "2026-11-15T12:00:00.000Z", {
      search,
      synthesise: async () => ({ text: packetJson({ title: "The Long Winter Room", theme: "winter" }), aiRunId: null }),
    });
    expect(out.generated).toBe(true);
    const p = await row(out.packetId!);
    expect(p.proposed_for_month).toBe("2026-12");
    expect(p.origin).toBe("PARKER");
    expect(p.brief_json).toBeNull();

    // And again from the same month: December is stocked, nothing is built, the shelf is not padded.
    const again = await runMonthlyRoomProposal(env, actor(), "2026-11-16T12:00:00.000Z", { search, synthesise: synthOk });
    expect(again.generated).toBe(false);
    expect(again.detail).toMatch(/2026-12 already has a proposal/);
  });

  it("'propose again with changes' links the new packet to the declined one", async () => {
    const declined = (await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE title = 'The Long Winter Room'").first<PacketRow>())!;
    await decidePacket(env, actor(), declined.id, "DECLINED", "too generic — make it about GC hiring");
    const out = await generatePacket(env, actor(), {
      month: "2026-12",
      brief: { audience: "general counsel hired in the last year", month: "2026-12", city: "New York", sponsorProspects: [], notes: "the winter room, reworked" },
      parentPacketId: declined.id,
    }, { search, synthesise: async () => ({ text: packetJson({ title: "The First GC Room" }), aiRunId: null }) });
    expect(out.packet.parent_packet_id).toBe(declined.id);
    expect(out.packet.origin).toBe("PARTNER_BRIEF");
    expect((await row(declined.id)).decision_note).toBe("too generic — make it about GC hiring");
  });
});
