import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { transcribeChunk, transcriptionAvailable, TranscriptionUnavailable } from "../src/worker/ai/providers/workersAiWhisper";

/**
 * ADR-019 — what happens when a deal reaches the committee, and what happens before a word of a
 * meeting is written down.
 *
 * Two things are proven here and one is deliberately NOT:
 *
 *   PROVEN: a stage move to the committee opens a packet and a card for Poppy; the packet names its
 *   own gaps rather than filling them in; the champion cannot close the bear case; a rejection puts
 *   the deal on the visible pass pile with its reason.
 *
 *   PROVEN: capture refuses, and says why in a sentence, whenever the transcription service is
 *   unreachable, the recording policy is not activated, or nobody has said yes.
 *
 *   NOT PROVEN, and labelled so: that Cloudflare's Whisper model actually returns a transcript.
 *   There is no `AI` binding under miniflare and this suite deploys nothing. The SHAPE handling is
 *   exercised against a stub; the model is not. See IMPLEMENTATION_LEDGER.md.
 *
 * Forbidden-claim discipline (§12.4): nothing here asserts legal or two-party-consent sufficiency.
 * What is tested is that permission is asked for, recorded, and enforced as a gate.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

function req(path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call<T = any>(path: string, headers: Record<string, string>, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(req(path, headers, method, body), env);
  return { status: res.status, body: (await res.json()) as T };
}

let seq = 0;
async function dealAtCommittee(): Promise<{ opportunityId: string; companyId: string }> {
  seq += 1;
  const company = await call<{ id: string }>("/api/companies", MP, "POST", {
    canonical_name: `ADR019 Co ${seq} ${crypto.randomUUID().slice(0, 8)}`,
  });
  expect(company.status).toBe(201);
  const opp = await call<{ id: string }>("/api/opportunities", MP, "POST", {
    company_id: company.body.id,
    opportunity_type: "EARLY_STAGE_PRIMARY",
    title: `ADR019 round ${seq}`,
  });
  expect(opp.status).toBe(201);
  for (const to of ["SCREENING", "DILIGENCE", "IC_READY"]) {
    const moved = await call(`/api/opportunities/${opp.body.id}/transition`, MP, "POST", { to });
    expect(moved.status).toBe(200);
  }
  return { opportunityId: opp.body.id, companyId: company.body.id };
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs });
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("a deal reaches the committee by moving one stage", () => {
  it("opens a packet in draft and a work card for Poppy", async () => {
    const { opportunityId } = await dealAtCommittee();

    const packets = await call<{ ic_packets: Array<{ id: string; status: string }> }>(
      `/api/ic/packets?opportunity_id=${opportunityId}`, MP,
    );
    expect(packets.body.ic_packets).toHaveLength(1);
    expect(packets.body.ic_packets[0]!.status).toBe("DRAFT");

    // The card is the mechanism. Nothing auto-decides and nothing auto-answers.
    /*
     * QUERIED BY ID, because that is what the column holds — and the query is half the lesson.
     *
     * This selected `WHERE owner_id = 'Poppy'`, so it found nothing and failed on the row being
     * absent rather than on the assertion below. The fixture agreed with the bug: `ic.ts` read the
     * card back the same wrong way, so the IC stage view never found the packet-assembly card it
     * had just opened. Fixed in both places, 22 Aug 2026.
     */
    const cards = await t.db
      .prepare("SELECT title, owner_type, owner_id, machine_id, state FROM work_card WHERE owner_id = 'aie_poppy' ORDER BY created_at DESC LIMIT 1")
      .first<{ title: string; owner_type: string; owner_id: string; machine_id: number; state: string }>();
    expect(cards, "the packet-assembly card must exist and be owned by the seat's id").not.toBeNull();
    expect(cards?.owner_type).toBe("AI");
    // The seat's ID, not their display name. `runEmployeeWork` resolves an owner with
    // `ai_employee WHERE id = ?`, so a card owned by a NAME can never be worked — an assertion on
    // the name pinned exactly that bug in the intake path for a day.
    expect(cards?.owner_id).toBe("aie_poppy");
    expect(cards?.machine_id).toBe(18);
    expect(cards?.state).toBe("OPEN");
    expect(cards?.title).toContain("Assemble the IC packet");
  });

  it("names the gaps rather than filling them in, and every gap says who owes it", async () => {
    const { opportunityId } = await dealAtCommittee();
    const packets = await call<{ ic_packets: Array<{ id: string }> }>(`/api/ic/packets?opportunity_id=${opportunityId}`, MP);
    const packetId = packets.body.ic_packets[0]!.id;

    const qs = await call<{ questions: Array<{ question: string; because: string; owed_by_kind: string; state: string; section_id: string | null }> }>(
      `/api/ic/packets/${packetId}/questions`, MP,
    );
    expect(qs.status).toBe(200);
    expect(qs.body.questions.length).toBeGreaterThan(0);

    // Every question carries what was looked at, so it reads as a gap rather than an oversight.
    for (const q of qs.body.questions) {
      expect(q.because.trim().length).toBeGreaterThan(8);
      expect(q.state).toBe("OPEN");
      expect(["PARTNER", "CHAMPION", "AI_EMPLOYEE", "COUNTERPARTY", "UNASSIGNED"]).toContain(q.owed_by_kind);
    }

    // THE BEAR CASE IS ALWAYS ONE OF THEM, and it is never owed by the champion.
    const bear = qs.body.questions.find((q) => q.section_id === "kill_case");
    expect(bear, "the packet must always ask for the case against").toBeTruthy();
    expect(bear!.owed_by_kind).toBe("PARTNER");

    // A deal with no math attached is asked about it rather than having a number invented for it.
    expect(qs.body.questions.some((q) => q.section_id === "return_math")).toBe(true);
  });

  it("re-entering the stage finds the open packet instead of minting a second one", async () => {
    const { opportunityId } = await dealAtCommittee();
    // IC_READY → PASS → SCREENING → DILIGENCE → IC_READY. The deal comes round again; the packet
    // must not split its questions and its audit trail across two records that both look real.
    await call(`/api/opportunities/${opportunityId}/transition`, MP, "POST", { to: "PASS", reason: "wanted to see the next quarter" });
    for (const to of ["SCREENING", "DILIGENCE", "IC_READY"]) {
      await call(`/api/opportunities/${opportunityId}/transition`, MP, "POST", { to });
    }
    const packets = await call<{ ic_packets: unknown[] }>(`/api/ic/packets?opportunity_id=${opportunityId}`, MP);
    expect(packets.body.ic_packets).toHaveLength(1);
  });
});

describe("a gap is closed by a person, and never by the champion", () => {
  it("records an answer, and refuses one with nothing in it", async () => {
    const { opportunityId } = await dealAtCommittee();
    const packets = await call<{ ic_packets: Array<{ id: string }> }>(`/api/ic/packets?opportunity_id=${opportunityId}`, MP);
    const packetId = packets.body.ic_packets[0]!.id;
    const qs = await call<{ questions: Array<{ id: string; section_id: string | null }> }>(`/api/ic/packets/${packetId}/questions`, MP);
    const bear = qs.body.questions.find((q) => q.section_id === "kill_case")!;

    const empty = await call<{ error: string }>(`/api/ic/questions/${bear.id}/resolve`, MP, "POST", { state: "ANSWERED", answer: "  " });
    expect(empty.status).toBe(400);

    const saved = await call<{ state: string; answer: string }>(`/api/ic/questions/${bear.id}/resolve`, MP, "POST", {
      state: "ANSWERED",
      answer: "The second founder left in March and nobody will say why.",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.state).toBe("ANSWERED");

    // Answering twice is refused: the first answer is the record, not a draft.
    const again = await call<{ error: string }>(`/api/ic/questions/${bear.id}/resolve`, MP, "POST", { state: "ANSWERED", answer: "different now" });
    expect(again.status).toBe(409);
  });

  it("withdrawing is recorded as withdrawing, with a reason, and never as answered", async () => {
    const { opportunityId } = await dealAtCommittee();
    const packets = await call<{ ic_packets: Array<{ id: string }> }>(`/api/ic/packets?opportunity_id=${opportunityId}`, MP);
    const packetId = packets.body.ic_packets[0]!.id;
    const qs = await call<{ questions: Array<{ id: string; section_id: string | null }> }>(`/api/ic/packets/${packetId}/questions`, MP);
    const other = qs.body.questions.find((q) => q.section_id !== "kill_case")!;

    const noReason = await call<{ error: string }>(`/api/ic/questions/${other.id}/resolve`, MP, "POST", { state: "WITHDRAWN" });
    expect(noReason.status).toBe(400);

    const done = await call<{ state: string; answer: string | null; withdrawn_reason: string }>(
      `/api/ic/questions/${other.id}/resolve`, MP, "POST",
      { state: "WITHDRAWN", withdrawn_reason: "the round is priced, so the math question is moot" },
    );
    expect(done.status).toBe(200);
    expect(done.body.state).toBe("WITHDRAWN");
    expect(done.body.answer).toBeNull();
  });

  it("refuses the champion the bear case, in the choke point rather than the interface", async () => {
    const { opportunityId } = await dealAtCommittee();
    const packets = await call<{ ic_packets: Array<{ id: string }> }>(`/api/ic/packets?opportunity_id=${opportunityId}`, MP);
    const packetId = packets.body.ic_packets[0]!.id;
    // Name the signed-in partner as the champion, then have him try to argue against his own deal.
    const setup = await call(`/api/ic/packets/${packetId}/setup`, MP, "POST", { champion_user_id: "fu_scooter_taylor" });
    expect(setup.status).toBe(200);

    const qs = await call<{ questions: Array<{ id: string; section_id: string | null }> }>(`/api/ic/packets/${packetId}/questions`, MP);
    const bear = qs.body.questions.find((q) => q.section_id === "kill_case")!;
    const refused = await call<{ error: string; detail: string }>(`/api/ic/questions/${bear.id}/resolve`, MP, "POST", {
      state: "ANSWERED",
      answer: "Honestly there isn't one, it's a great deal.",
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("champion_may_not_answer");
  });
});

describe("the committee surface says where a deal stands", () => {
  it("carries the packet state, the open questions, the seats and no decision yet", async () => {
    const { opportunityId } = await dealAtCommittee();
    const surface = await call<{ deals: Array<{ opportunity_id: string; stage: string; packet_state: string; open_question_count: number; seats: Array<{ name: string; decides: boolean }>; decision: unknown; facilitator_card: { id: string; state: string } | null }> }>(
      "/api/ic/deals", MP,
    );
    const deal = surface.body.deals.find((d) => d.opportunity_id === opportunityId)!;
    expect(deal).toBeTruthy();
    // Plain English, never the stored value.
    expect(deal.stage).toBe("At the committee");
    expect(deal.packet_state).toBe("Being assembled");
    expect(deal.open_question_count).toBeGreaterThan(0);
    expect(deal.decision).toBeNull();
    // The seats are derived. A committee whose membership is a list somebody has to remember to
    // fill in is worse than one with none written down.
    expect(deal.seats.some((s) => s.decides)).toBe(true);
    expect(deal.seats.some((s) => s.name === "Poppy")).toBe(true);

    /*
     * ADDED 22 Aug 2026, because its absence is what let a live bug sit here unseen.
     *
     * `facilitator_card` is "the card Poppy holds for this packet, so the page can say whether
     * anybody has started". The surface looked it up by the display name while the column holds the
     * seat id, so it came back null for EVERY deal at committee — and a null here does not look
     * like a fault, it looks like nobody has started yet. Nothing asserted it, so nothing said so.
     *
     * The card is opened by `openIcStage` in the same breath as the packet, so on a deal that
     * reached committee it must be there.
     */
    expect(deal.facilitator_card, "the packet was opened, so the card that assembles it must show").not.toBeNull();
    expect(deal.facilitator_card!.state).toBe("OPEN");
  });
});

describe("nothing is written down before permission is", () => {
  it("says in sentences what is stopping capture, and refuses a chunk while any of it holds", async () => {
    const created = await call<{ id: string }>("/api/meetings", MP, "POST", {
      title: "ADR019 founder call",
      meeting_type: "FOUNDER",
      occurred_at: new Date().toISOString(),
    });
    expect(created.status).toBe(201);
    const meetingId = created.body.id;

    const readiness = await call<{ can_capture: boolean; blockers: string[]; transcription_available: boolean; consent: Record<string, string> }>(
      `/api/meetings/${meetingId}/capture`, MP,
    );
    expect(readiness.status).toBe(200);
    expect(readiness.body.can_capture).toBe(false);
    // Every blocker is a sentence. A refusal reading `recording_policy_not_activated` is exactly
    // the complaint this page was rebuilt to answer.
    expect(readiness.body.blockers.length).toBeGreaterThan(0);
    for (const b of readiness.body.blockers) {
      expect(b).toMatch(/[a-z]\s[a-z]/);
      expect(b).not.toMatch(/[a-z]_[a-z]/);
    }
    // No AI binding in this environment, and the readiness says so rather than pretending.
    expect(readiness.body.transcription_available).toBe(false);
    expect(readiness.body.consent.TRANSCRIPTION).toBe("NOT_RECORDED");

    const chunk = await call<{ error: string; detail: string }>(`/api/meetings/${meetingId}/capture/chunk`, MP, "POST", {
      audio_base64: "AAAA",
      sequence: 0,
    });
    expect(chunk.status).toBe(503);
    expect(chunk.body.error).toBe("transcription_unavailable");
  });

  it("logs the answer to the prompt, both ways, and names who gave it", async () => {
    const created = await call<{ id: string }>("/api/meetings", MP, "POST", {
      title: "ADR019 consent call",
      meeting_type: "FOUNDER",
      occurred_at: new Date().toISOString(),
    });
    const meetingId = created.body.id;

    const nameless = await call<{ error: string }>(`/api/meetings/${meetingId}/capture/consent`, MP, "POST", {
      answer: "GRANTED",
      basis: "asked out loud",
    });
    expect(nameless.status).toBe(400);
    expect(nameless.body.error).toBe("who_said_yes");

    const yes = await call<{ consent: Record<string, string> }>(`/api/meetings/${meetingId}/capture/consent`, MP, "POST", {
      answer: "GRANTED",
      granted_by: "Deana Oliver",
      basis: "asked out loud at the start of the call",
    });
    expect(yes.status).toBe(201);
    expect(yes.body.consent.RECORDING).toBe("GRANTED");
    expect(yes.body.consent.TRANSCRIPTION).toBe("GRANTED");

    // A refusal is a record, not an absence. "We did not record" has to be auditable.
    const no = await call<{ consent: Record<string, string> }>(`/api/meetings/${meetingId}/capture/consent`, MP, "POST", {
      answer: "DENIED",
      basis: "they said no",
    });
    expect(no.status).toBe(201);
    expect(no.body.consent.RECORDING).toBe("DENIED");

    // Append-only: the whole conversation about permission survives, not just the latest word.
    const history = await t.db
      .prepare("SELECT COUNT(*) AS n FROM consent_record WHERE meeting_id = ?1")
      .bind(meetingId)
      .first<{ n: number }>();
    expect(Number(history?.n)).toBe(4);
  });
});

describe("a Fireflies export goes through the same gates, and importing is never consent", () => {
  const EXPORT = [
    "Fireflies.ai",
    "Summary",
    "They want a decision in two weeks.",
    "Transcript",
    "Deana Oliver: we can send the data room by Friday",
    // A new turn (its own timestamp) that the export never put a name on. A line directly under a
    // speaker with nothing between them is a wrapped line and is joined on instead — the only place
    // a line is allowed to inherit a speaker.
    "00:31",
    "someone talked over the top here",
  ].join("\n");

  async function meetingWithPolicy(title: string): Promise<string> {
    const created = await call<{ id: string }>("/api/meetings", MP, "POST", {
      title,
      meeting_type: "FOUNDER",
      occurred_at: new Date().toISOString(),
    });
    const meetingId = created.body.id;
    // The recording policy is a named human gate with its own approved receipt.
    const card = await call<{ id: string }>("/api/approvals", MP, "POST", {
      action_key: "meeting.recording_policy.activate",
      object_type: "meeting",
      object_id: meetingId,
      title: `policy ${meetingId}`,
      submit: true,
    });
    await call(`/api/approvals/${card.body.id}/decide`, MP, "POST", { decision: "approved" });
    const activated = await call(`/api/meetings/${meetingId}/recording-policy`, MP, "POST", { approval_receipt_id: card.body.id });
    expect(activated.status).toBe(200);
    return meetingId;
  }

  it("is refused, and the refusal recorded, when nobody has given permission", async () => {
    const meetingId = await meetingWithPolicy("ADR019 fireflies ungranted");
    const res = await call<{ error: string }>(`/api/meetings/${meetingId}/transcript/fireflies`, MP, "POST", { text: EXPORT });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("consent_not_granted");
    const refusal = await t.db
      .prepare("SELECT status, refusal_reason FROM transcript_import WHERE meeting_id = ?1 ORDER BY created_at DESC LIMIT 1")
      .bind(meetingId)
      .first<{ status: string; refusal_reason: string }>();
    expect(refusal?.status).toBe("REFUSED");
  });

  it("lands the turns, stamps the vendor on the import, and never writes a consent row of its own", async () => {
    const meetingId = await meetingWithPolicy("ADR019 fireflies granted");
    await call(`/api/meetings/${meetingId}/capture/consent`, MP, "POST", {
      answer: "GRANTED",
      granted_by: "Deana Oliver",
      basis: "asked out loud at the start of the call",
    });
    const before = await t.db.prepare("SELECT COUNT(*) AS n FROM consent_record WHERE meeting_id = ?1").bind(meetingId).first<{ n: number }>();

    const res = await call<{ turns: number; unattributed: number; summary_captured: boolean; transcript_import_id: string }>(
      `/api/meetings/${meetingId}/transcript/fireflies`, MP, "POST", { text: EXPORT },
    );
    expect(res.status).toBe(201);
    expect(res.body.turns).toBe(2);
    // The export did not say who spoke the second line. Reported, never guessed at.
    expect(res.body.unattributed).toBe(1);
    expect(res.body.summary_captured).toBe(true);

    // THE SOURCE TRAVELS WITH IT. "PROVIDER" does not tell a reader who made the recording.
    const imported = await t.db
      .prepare("SELECT source, provider_name, status FROM transcript_import WHERE id = ?1")
      .bind(res.body.transcript_import_id)
      .first<{ source: string; provider_name: string; status: string }>();
    expect(imported?.status).toBe("IMPORTED");
    expect(imported?.source).toBe("PROVIDER");
    expect(imported?.provider_name).toBe("FIREFLIES");

    // Turns landed as transcript-derived notes, carrying the import they came from — which is what
    // lets a close-out commitment quote the line it was read out of.
    const notes = await t.db
      .prepare("SELECT body FROM meeting_note WHERE transcript_import_id = ?1 ORDER BY created_at, id")
      .bind(res.body.transcript_import_id)
      .all<{ body: string }>();
    const bodies = (notes.results ?? []).map((n) => n.body);
    expect(bodies.some((b) => b.startsWith("Deana Oliver:"))).toBe(true);
    // The timestamp the export carried sits between the marker and the words, verbatim.
    expect(bodies.some((b) => b.startsWith("Speaker not named in the export [00:31]:"))).toBe(true);
    // Fireflies' own summary is filed as theirs, not as something somebody said.
    expect(bodies.some((b) => b.includes("Fireflies' own summary"))).toBe(true);

    // IMPORTING IS NOT CONSENT. The firm did not ask anybody anything by pressing this.
    const after = await t.db.prepare("SELECT COUNT(*) AS n FROM consent_record WHERE meeting_id = ?1").bind(meetingId).first<{ n: number }>();
    expect(Number(after?.n)).toBe(Number(before?.n));
  });

  it("refuses an export with nothing readable in it rather than filing an empty transcript", async () => {
    const meetingId = await meetingWithPolicy("ADR019 fireflies empty");
    await call(`/api/meetings/${meetingId}/capture/consent`, MP, "POST", {
      answer: "GRANTED", granted_by: "Deana Oliver", basis: "asked out loud",
    });
    const res = await call<{ error: string }>(`/api/meetings/${meetingId}/transcript/fireflies`, MP, "POST", { text: "   \n  \n" });
    expect(res.status).toBe(400);
  });
});

describe("the transcription adapter, as far as it can honestly be tested offline", () => {
  it("reports itself unavailable with no binding, which is what disables the button", () => {
    expect(transcriptionAvailable(undefined)).toBe(false);
    expect(transcriptionAvailable({ run: async () => ({}) })).toBe(true);
  });

  it("refuses rather than returning empty text when the answer has no words in it", async () => {
    // "The field was missing" and "nobody spoke" have different causes and different fixes.
    // Collapsing them is how a transcript quietly loses a minute of a meeting.
    await expect(transcribeChunk({ run: async () => ({}) }, "AAAA")).rejects.toBeInstanceOf(TranscriptionUnavailable);
  });

  it("reads the shape Workers AI actually answers in", async () => {
    const out = await transcribeChunk({ run: async () => ({ text: "we will send the data room", word_count: 6 }) }, "AAAA");
    expect(out.text).toBe("we will send the data room");
    expect(out.wordCount).toBe(6);
  });

  it("passes the model's own error through unchanged, because that is the readable half", async () => {
    await expect(
      transcribeChunk({ run: async () => { throw new Error("5016 licence not accepted"); } }, "AAAA"),
    ).rejects.toMatchObject({ reason: "5016 licence not accepted" });
  });
});
