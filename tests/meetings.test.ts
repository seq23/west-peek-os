import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { addNote, assemblePrepPacket, createDebrief, createMeeting, promoteToClaimCandidate, recordConsent } from "../src/worker/services/meetings";
import { runAi } from "../src/worker/ai/runAi";

/**
 * P7 — meeting intelligence.
 *
 * Rules under test (plan §8/P7): transcript ingestion needs BOTH an activated
 * recording policy (human-reserved receipt) and GRANTED consent, and every refusal
 * is itself recorded; consent history is append-only and REVOKED re-closes the gate;
 * a manual / off-record path always exists; transcript-derived material can never
 * self-promote to VERIFIED; commitments become governed work cards and nothing
 * leaves the building without the P3 external-effect route; AI may draft but never
 * consents, never decides, and never promotes; and a dead AI provider degrades the
 * whole surface to manual mode rather than blocking it.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MEMBER = { "x-wpos-dev-user": "member@westpeek.ventures" };

const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const AI_ACTOR: Actor = { type: "AI", aiEmployeeId: "aie_paige", roles: [], firmScopes: ["west-peek"] };

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
async function createCompany(): Promise<string> {
  seq += 1;
  const res = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: `P7 Co ${seq} ${crypto.randomUUID().slice(0, 8)}` });
  expect(res.status).toBe(201);
  return res.body.id;
}

interface MeetingRow {
  id: string;
  status: string;
  recording_enabled: number;
  recording_policy_receipt_id: string | null;
  privacy_label: string;
}

async function createMeetingApi(over: Record<string, unknown> = {}): Promise<MeetingRow> {
  const res = await call<MeetingRow>("/api/meetings", MP, "POST", {
    title: "Founder call",
    meeting_type: "FOUNDER",
    occurred_at: "2026-05-04T15:00:00.000Z",
    ...over,
  });
  expect(res.status).toBe(201);
  return res.body;
}

/** Create + submit + approve an approval card as MP; returns the receipt id. */
async function approvedCard(actionKey: string, objectType: string, objectId: string): Promise<string> {
  const created = await call<{ id: string }>("/api/approvals", MP, "POST", {
    action_key: actionKey,
    object_type: objectType,
    object_id: objectId,
    title: `p7: ${actionKey} ${objectId}`,
    submit: true,
  });
  expect(created.status).toBe(201);
  const decided = await call(`/api/approvals/${created.body.id}/decide`, MP, "POST", { decision: "approved" });
  expect(decided.status).toBe(200);
  return created.body.id;
}

/** Activate the recording policy through the reserved gate. */
async function activateRecording(meetingId: string): Promise<string> {
  const receipt = await approvedCard("meeting.recording_policy.activate", "meeting", meetingId);
  const res = await call<MeetingRow>(`/api/meetings/${meetingId}/recording-policy`, MP, "POST", { approval_receipt_id: receipt });
  expect(res.status).toBe(200);
  expect(res.body.recording_enabled).toBe(1);
  return receipt;
}

async function grantTranscriptionConsent(meetingId: string): Promise<void> {
  const res = await call(`/api/meetings/${meetingId}/consent`, MP, "POST", {
    consent_type: "TRANSCRIPTION",
    state: "GRANTED",
    basis: "verbal consent at the top of the call, both participants",
    granted_by: "Founder (counterparty)",
  });
  expect(res.status).toBe(201);
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs });
  await t.db
    .prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_test_member', 'member@westpeek.ventures', 'Test Member', 'ACTIVE')")
    .run();
  await t.db.prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_test_member', 'role_investment_team')").run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

// ── 0. Unauthenticated requests are denied across the P7 surface ──

describe("0. unauthenticated requests are denied (401) across the P7 surface", () => {
  it("returns 401 on every P7 route", async () => {
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "/api/meetings", {}],
      ["GET", "/api/meetings"],
      ["GET", "/api/meetings/mtg_x"],
      ["POST", "/api/meetings/mtg_x/transition", { to: "HELD" }],
      ["POST", "/api/meetings/mtg_x/participants", {}],
      ["POST", "/api/meetings/mtg_x/consent", {}],
      ["POST", "/api/meetings/mtg_x/recording-policy", {}],
      ["POST", "/api/meetings/mtg_x/prep", {}],
      ["POST", "/api/meetings/mtg_x/transcript", {}],
      ["POST", "/api/meetings/mtg_x/notes", {}],
      ["POST", "/api/meetings/mtg_x/commitments", {}],
      ["POST", "/api/meeting-commitments/mcm_x/convert", {}],
      ["POST", "/api/meetings/mtg_x/debriefs", {}],
      ["POST", "/api/meetings/mtg_x/claim-candidates", {}],
    ];
    for (const [method, path, body] of routes) {
      const res = await handleRequest(req(path, {}, method, body), env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

// ── 1. Consent states ──

describe("1. consent is human-recorded, append-only, and revocable", () => {
  it("moves REQUESTED → GRANTED → REVOKED with full history, and rejects UPDATE/DELETE", async () => {
    const meeting = await createMeetingApi();
    for (const [state, granted_by] of [
      ["REQUESTED", undefined],
      ["GRANTED", "Founder (counterparty)"],
      ["REVOKED", undefined],
    ] as const) {
      const res = await call(`/api/meetings/${meeting.id}/consent`, MP, "POST", {
        consent_type: "TRANSCRIPTION",
        state,
        basis: `state ${state} recorded on the call`,
        granted_by,
      });
      expect(res.status).toBe(201);
    }
    const view = await call<{ consent_current: Record<string, { state: string } | null>; consent_history: unknown[] }>(`/api/meetings/${meeting.id}`, MP);
    expect(view.body.consent_current.TRANSCRIPTION!.state).toBe("REVOKED");
    expect(view.body.consent_history).toHaveLength(3);
    expect(view.body.consent_current.RECORDING).toBeNull();

    await expect(t.db.prepare("UPDATE consent_record SET state = 'GRANTED' WHERE meeting_id = ?1").bind(meeting.id).run()).rejects.toThrow(/append-only/);
    await expect(t.db.prepare("DELETE FROM consent_record WHERE meeting_id = ?1").bind(meeting.id).run()).rejects.toThrow(/append-only/);
  });

  it("a GRANTED consent must name who granted it", async () => {
    const meeting = await createMeetingApi();
    const res = await call<{ error: string }>(`/api/meetings/${meeting.id}/consent`, MP, "POST", {
      consent_type: "TRANSCRIPTION",
      state: "GRANTED",
      basis: "assumed",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });

  it("an AI actor can never record that a human consented", async () => {
    const meeting = await createMeetingApi();
    await expect(
      recordConsent(env, AI_ACTOR, meeting.id, { consent_type: "TRANSCRIPTION", state: "GRANTED", basis: "ai asserts consent", granted_by: "founder" }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

// ── 2. Transcript ingestion: two independent gates, refusals recorded ──

describe("2. transcript ingestion requires recording policy AND consent", () => {
  it("refuses (and records the refusal) when the recording policy is not activated", async () => {
    const meeting = await createMeetingApi();
    await grantTranscriptionConsent(meeting.id);
    const res = await call<{ error: string }>(`/api/meetings/${meeting.id}/transcript`, MP, "POST", { source: "otter export" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("recording_policy_not_activated");

    const view = await call<{ transcript_imports: Array<{ status: string; refusal_reason: string }> }>(`/api/meetings/${meeting.id}`, MP);
    expect(view.body.transcript_imports).toHaveLength(1);
    expect(view.body.transcript_imports[0]!.status).toBe("REFUSED");
    expect(view.body.transcript_imports[0]!.refusal_reason).toBe("recording_policy_not_activated");
  });

  it("refuses when the policy is active but consent was never granted", async () => {
    const meeting = await createMeetingApi();
    await activateRecording(meeting.id);
    const res = await call<{ error: string }>(`/api/meetings/${meeting.id}/transcript`, MP, "POST", { source: "otter export" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("consent_not_granted");
    const view = await call<{ transcript_imports: Array<{ status: string; refusal_reason: string }> }>(`/api/meetings/${meeting.id}`, MP);
    expect(view.body.transcript_imports[0]!.refusal_reason).toBe("consent_state:NOT_RECORDED");
  });

  it("imports with both gates satisfied, then refuses again once consent is REVOKED", async () => {
    const meeting = await createMeetingApi();
    await activateRecording(meeting.id);
    await grantTranscriptionConsent(meeting.id);
    const imported = await call<{ id: string; status: string; consent_record_id: string }>(`/api/meetings/${meeting.id}/transcript`, MP, "POST", {
      source: "otter export",
    });
    expect(imported.status).toBe(201);
    expect(imported.body.status).toBe("IMPORTED");
    expect(imported.body.consent_record_id).toMatch(/^csr_/);

    const revoked = await call(`/api/meetings/${meeting.id}/consent`, MP, "POST", {
      consent_type: "TRANSCRIPTION",
      state: "REVOKED",
      basis: "founder revoked after the call",
    });
    expect(revoked.status).toBe(201);
    const second = await call<{ error: string }>(`/api/meetings/${meeting.id}/transcript`, MP, "POST", { source: "otter export 2" });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("consent_not_granted");
  });

  it("the recording gate needs a valid receipt and cannot be replayed", async () => {
    const meeting = await createMeetingApi();
    const noReceipt = await call<{ error: string }>(`/api/meetings/${meeting.id}/recording-policy`, MP, "POST", {});
    expect(noReceipt.status).toBe(409);
    expect(noReceipt.body.error).toBe("approval_required");

    const wrongObject = await approvedCard("meeting.recording_policy.activate", "meeting", "mtg_other");
    const refused = await call(`/api/meetings/${meeting.id}/recording-policy`, MP, "POST", { approval_receipt_id: wrongObject });
    expect(refused.status).toBe(409);

    const receipt = await activateRecording(meeting.id);
    const replay = await call(`/api/meetings/${meeting.id}/recording-policy`, MP, "POST", { approval_receipt_id: receipt });
    expect(replay.status).toBe(409);
  });

  it("a non-MP/non-compliance human cannot activate the recording policy", async () => {
    const meeting = await createMeetingApi();
    const created = await call<{ id: string }>("/api/approvals", MEMBER, "POST", {
      action_key: "meeting.recording_policy.activate",
      object_type: "meeting",
      object_id: meeting.id,
      title: "member tries to self-approve recording",
      submit: true,
    });
    expect(created.status).toBe(201);
    const decision = await call(`/api/approvals/${created.body.id}/decide`, MEMBER, "POST", { decision: "approved" });
    expect(decision.status).toBe(403);
    const attempt = await call<{ error: string }>(`/api/meetings/${meeting.id}/recording-policy`, MEMBER, "POST", { approval_receipt_id: created.body.id });
    expect(attempt.status).toBe(403);
  });

  it("transcript-derived notes require an IMPORTED transcript on that meeting", async () => {
    const meeting = await createMeetingApi();
    const res = await call<{ error: string }>(`/api/meetings/${meeting.id}/notes`, MP, "POST", {
      note_type: "TRANSCRIPT_DERIVED",
      body: "founder said ARR is $9M",
      transcript_import_id: "tri_does_not_exist",
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_imported_transcript");
  });
});

// ── 3. The manual / off-record path always exists ──

describe("3. manual and off-record paths never depend on recording", () => {
  it("manual notes, commitments, and debriefs work with no consent and no recording", async () => {
    const meeting = await createMeetingApi({ title: "Off-record coffee" });
    const note = await call<{ id: string; note_type: string }>(`/api/meetings/${meeting.id}/notes`, MP, "POST", {
      note_type: "MANUAL",
      body: "Discussed hiring plan; no recording requested.",
    });
    expect(note.status).toBe(201);
    const offRecord = await call<{ id: string }>(`/api/meetings/${meeting.id}/notes`, MP, "POST", {
      note_type: "OFF_RECORD",
      body: "Personal context shared in confidence.",
    });
    expect(offRecord.status).toBe(201);
    const debrief = await call(`/api/meetings/${meeting.id}/debriefs`, MP, "POST", { summary: "Positive; revisit in Q3." });
    expect(debrief.status).toBe(201);
    const view = await call<{ notes: unknown[]; debriefs: unknown[]; transcript_imports: unknown[] }>(`/api/meetings/${meeting.id}`, MP);
    expect(view.body.notes).toHaveLength(2);
    expect(view.body.debriefs).toHaveLength(1);
    expect(view.body.transcript_imports).toHaveLength(0);
  });

  it("an off-record note can never become institutional evidence", async () => {
    const company = await createCompany();
    const meeting = await createMeetingApi({ company_id: company });
    const offRecord = await call<{ id: string }>(`/api/meetings/${meeting.id}/notes`, MP, "POST", { note_type: "OFF_RECORD", body: "in confidence" });
    const res = await call<{ error: string }>(`/api/meetings/${meeting.id}/claim-candidates`, MP, "POST", {
      note_id: offRecord.body.id,
      claim_text: "off-record disclosure",
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("off_record");
  });
});

// ── 4. Transcript/debrief material can never self-promote to VERIFIED ──

describe("4. meeting material enters evidence as UNVERIFIED and cannot self-promote", () => {
  it("a transcript-derived claim candidate lands with TRANSCRIPT provenance and cannot be verified", async () => {
    const company = await createCompany();
    const meeting = await createMeetingApi({ company_id: company });
    await activateRecording(meeting.id);
    await grantTranscriptionConsent(meeting.id);
    const imported = await call<{ id: string }>(`/api/meetings/${meeting.id}/transcript`, MP, "POST", { source: "otter export" });
    const note = await call<{ id: string }>(`/api/meetings/${meeting.id}/notes`, MP, "POST", {
      note_type: "TRANSCRIPT_DERIVED",
      body: "Founder: ARR just crossed $9M",
      transcript_import_id: imported.body.id,
    });
    expect(note.status).toBe(201);

    const candidate = await call<{ id: string; claim_status: string }>(`/api/meetings/${meeting.id}/claim-candidates`, MP, "POST", {
      note_id: note.body.id,
      claim_text: "ARR is $9M",
      metric_key: "arr",
      metric_value: "$9M",
    });
    expect(candidate.status).toBe(201);
    expect(candidate.body.claim_status).toBe("UNVERIFIED");

    const sources = await t.db.prepare("SELECT source_type, location FROM claim_source WHERE claim_id = ?1").bind(candidate.body.id).all<{ source_type: string; location: string }>();
    expect((sources.results ?? [])[0]!.source_type).toBe("TRANSCRIPT");
    expect((sources.results ?? [])[0]!.location).toContain(meeting.id);

    // The P5 self-promotion ban applies: a TRANSCRIPT-only claim cannot be VERIFIED.
    const verify = await call<{ error: string }>(`/api/claims/${candidate.body.id}/verify`, MP, "POST", {});
    expect(verify.status).toBe(409);
  });

  it("a debrief-derived candidate carries HUMAN_STATEMENT provenance and stays unverified", async () => {
    const company = await createCompany();
    const meeting = await createMeetingApi({ company_id: company });
    const debrief = await call<{ id: string }>(`/api/meetings/${meeting.id}/debriefs`, MP, "POST", {
      summary: "Founder claims two enterprise logos closed last month.",
    });
    const candidate = await call<{ id: string; claim_status: string }>(`/api/meetings/${meeting.id}/claim-candidates`, MP, "POST", {
      debrief_id: debrief.body.id,
      claim_text: "Two enterprise logos closed in April 2026",
    });
    expect(candidate.status).toBe(201);
    expect(candidate.body.claim_status).toBe("UNVERIFIED");
    const sources = await t.db.prepare("SELECT source_type FROM claim_source WHERE claim_id = ?1").bind(candidate.body.id).all<{ source_type: string }>();
    expect((sources.results ?? [])[0]!.source_type).toBe("HUMAN_STATEMENT");
  });

  it("an AI actor cannot promote meeting material into evidence at all", async () => {
    const company = await createCompany();
    const meeting = await createMeeting(env, MP_ACTOR, { title: "AI promote probe", meeting_type: "DILIGENCE", company_id: company, occurred_at: "2026-05-05T10:00:00.000Z" });
    const note = await addNote(env, MP_ACTOR, meeting.id, { note_type: "MANUAL", body: "founder mentioned churn" });
    // An AI proposal must carry its run trace…
    await expect(promoteToClaimCandidate(env, AI_ACTOR, meeting.id, { note_id: note.id, claim_text: "churn is 2%" })).rejects.toMatchObject({ status: 400 });
    // …a REAL run through the governed boundary (the claim's ai_run_id is an FK)…
    const run = await runAi(env, { purpose: "meeting_claim_candidate", actor: AI_ACTOR, inputs: [note.body], sensitivity: "INTERNAL" });
    expect(run.run.status).toBe("COMPLETED"); // deterministic local adapter (LOCKDOWN default)
    // …and lands attributed to the AI, AI_INFERRED and quarantined — never VERIFIED.
    const claim = await promoteToClaimCandidate(env, AI_ACTOR, meeting.id, { note_id: note.id, claim_text: "churn is 2%", ai_run_id: run.run.id });
    expect(claim.extracted_by_type).toBe("AI");
    expect(claim.claim_status).toBe("AI_INFERRED");
    expect(claim.ai_run_id).toBe(run.run.id);
    const verify = await handleRequest(req(`/api/claims/${claim.id}/verify`, MP, "POST", {}), env);
    expect(verify.status).toBe(409);
  });

  it("a company-less meeting cannot produce a company claim candidate", async () => {
    const meeting = await createMeetingApi({ title: "Internal sync", meeting_type: "INTERNAL" });
    const note = await call<{ id: string }>(`/api/meetings/${meeting.id}/notes`, MP, "POST", { note_type: "MANUAL", body: "internal" });
    const res = await call<{ error: string }>(`/api/meetings/${meeting.id}/claim-candidates`, MP, "POST", { note_id: note.body.id, claim_text: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_company");
  });
});

// ── 5. Commitments become governed work cards; sends stay gated ──

describe("5. commitments become work cards and follow-up sends stay authorization-gated", () => {
  it("converts a commitment into a work card exactly once", async () => {
    const meeting = await createMeetingApi();
    const commitment = await call<{ id: string; status: string }>(`/api/meetings/${meeting.id}/commitments`, MP, "POST", {
      commitment_text: "Send the data room link",
      owner_side: "FIRM",
      owner_id: "fu_scooter_taylor",
      due_date: "2026-05-06",
    });
    expect(commitment.status).toBe(201);

    const converted = await call<{ status: string; work_card_id: string }>(`/api/meeting-commitments/${commitment.body.id}/convert`, MP, "POST", {});
    expect(converted.status).toBe(200);
    expect(converted.body.status).toBe("CONVERTED");
    expect(converted.body.work_card_id).toMatch(/^wc_/);

    const card = await call<{ title: string; state: string; next_action: string }>(`/api/work-cards/${converted.body.work_card_id}`, MP);
    expect(card.status).toBe(200);
    expect(card.body.title).toContain("Send the data room link");
    expect(card.body.state).toBe("OPEN");

    const again = await call<{ error: string }>(`/api/meeting-commitments/${commitment.body.id}/convert`, MP, "POST", {});
    expect(again.status).toBe(409);
  });

  it("emailing a follow-up still requires the P3 external-effect receipt", async () => {
    const meeting = await createMeetingApi();
    const commitment = await call<{ id: string }>(`/api/meetings/${meeting.id}/commitments`, MP, "POST", {
      commitment_text: "Email the founder our diligence questions",
      owner_side: "FIRM",
    });
    const effect = await call<{ id: string }>("/api/effects/requests", MP, "POST", {
      effect_type: "email.send",
      destination: "founder@example.com",
      payload: { subject: "diligence questions", body: "…", commitment_id: commitment.body.id },
    });
    expect(effect.status).toBe(201);
    const noReceipt = await call<{ error: string }>(`/api/effects/requests/${effect.body.id}/execute`, MP, "POST", {});
    expect(noReceipt.status).toBe(409);
  });
});

// ── 6. Prep packets: evidence in, contradictions never filtered ──

describe("6. prep packets carry the company's evidence and unresolved contradictions", () => {
  it("assembles from the company evidence summary and records the contradiction count", async () => {
    const company = await createCompany();
    const meeting = await createMeetingApi({ company_id: company, meeting_type: "DILIGENCE" });
    const sources = [{ source_type: "HUMAN_STATEMENT", location: "call", source_date: "2026-02-02", method: "notes" }];
    for (const value of ["$4M", "$6M"]) {
      const res = await call(`/api/claims`, MP, "POST", {
        company_id: company,
        subject_type: "company",
        subject_id: company,
        claim_text: `ARR is ${value}`,
        metric_key: "arr",
        metric_value: value,
        period_start: "2025-01-01",
        period_end: "2025-12-31",
        confidence: 0.8,
        sources,
      });
      expect(res.status).toBe(201);
    }
    const claims = await call<{ claims: Array<{ id: string }> }>(`/api/claims?company_id=${company}`, MP);
    const contradiction = await call<{ id: string }>("/api/contradictions", MP, "POST", {
      contradiction_type: "VALUE",
      topic: "arr",
      company_id: company,
      materiality: "CRITICAL",
      claim_links: claims.body.claims.slice(0, 2).map((c, i) => ({ claim_id: c.id, side_label: `side_${i + 1}` })),
    });
    expect(contradiction.status).toBe(201);

    const packet = await call<{ id: string; unresolved_contradictions_json: string; open_questions_json: string; drafted_by_type: string }>(
      `/api/meetings/${meeting.id}/prep`,
      MP,
      "POST",
      { open_questions: ["Which ARR definition is authoritative?"] },
    );
    expect(packet.status).toBe(201);
    expect(JSON.parse(packet.body.unresolved_contradictions_json)).toHaveLength(1);
    expect(JSON.parse(packet.body.open_questions_json)).toContain("Which ARR definition is authoritative?");
    expect(packet.body.drafted_by_type).toBe("HUMAN");
  });

  it("an AI-drafted prep packet must carry its run trace", async () => {
    const company = await createCompany();
    const meeting = await createMeeting(env, MP_ACTOR, { title: "AI prep", meeting_type: "DILIGENCE", company_id: company });
    await expect(assemblePrepPacket(env, AI_ACTOR, meeting.id, {})).rejects.toMatchObject({ status: 400 });
    const packet = (await assemblePrepPacket(env, AI_ACTOR, meeting.id, { ai_run_id: "air_fixture" })) as { drafted_by_type: string; ai_run_id: string };
    expect(packet.drafted_by_type).toBe("AI");
    expect(packet.ai_run_id).toBe("air_fixture");
    await expect(createDebrief(env, AI_ACTOR, meeting.id, { summary: "ai debrief" })).rejects.toMatchObject({ status: 400 });
  });
});

// ── 7. Provider failure degrades to manual mode ──

describe("7. a dead AI provider degrades meetings to manual mode, never blocks them", () => {
  it("with every provider disabled the whole meeting journey still completes deterministically", async () => {
    // Kill every external provider AND move the firm to FRONTIER through the
    // governed policy route (budget_policy is immutable; a change is a new
    // version behind a governance.policy_change receipt). The default LOCKDOWN
    // mode would otherwise serve the deterministic local adapter.
    await t.db.prepare("UPDATE provider_registry SET enabled = 0, kill_switched = 1").run();
    const toFrontier = await call(`/api/ai/budget`, MP, "POST", {
      cost_mode: "NORMAL",
      privacy_mode: "FRONTIER",
      daily_cap_usd: 10,
      per_run_cap_usd: 1,
      approval_receipt_id: await approvedCard("governance.policy_change", "budget_policy", "west-peek"),
    });
    expect(toFrontier.status).toBe(201);
    const blocked = await runAi(env, {
      purpose: "meeting_debrief_draft",
      actor: MP_ACTOR,
      inputs: ["summarize the founder call"],
      sensitivity: "INTERNAL",
    });
    expect(["PROVIDER_DISABLED", "KILL_SWITCHED"]).toContain(blocked.run.status);

    const company = await createCompany();
    const meeting = await createMeetingApi({ company_id: company, title: "Manual-mode call" });
    expect((await call(`/api/meetings/${meeting.id}/prep`, MP, "POST", { open_questions: ["manual prep"] })).status).toBe(201);
    const note = await call<{ id: string }>(`/api/meetings/${meeting.id}/notes`, MP, "POST", { note_type: "MANUAL", body: "hand-typed notes" });
    expect(note.status).toBe(201);
    expect((await call(`/api/meetings/${meeting.id}/debriefs`, MP, "POST", { summary: "hand-written debrief" })).status).toBe(201);
    const commitment = await call<{ id: string }>(`/api/meetings/${meeting.id}/commitments`, MP, "POST", { commitment_text: "send deck", owner_side: "FIRM" });
    expect(commitment.status).toBe(201);
    expect((await call(`/api/meeting-commitments/${commitment.body.id}/convert`, MP, "POST", {})).status).toBe(200);
    const candidate = await call<{ claim_status: string }>(`/api/meetings/${meeting.id}/claim-candidates`, MP, "POST", {
      note_id: note.body.id,
      claim_text: "hand-entered claim",
    });
    expect(candidate.status).toBe(201);
    expect(candidate.body.claim_status).toBe("UNVERIFIED");

    // Restore the fail-closed default for any later test in this file.
    await t.db.prepare("UPDATE provider_registry SET enabled = 0, kill_switched = 0").run();
    const backToLockdown = await call(`/api/ai/budget`, MP, "POST", {
      cost_mode: "NORMAL",
      privacy_mode: "LOCKDOWN",
      daily_cap_usd: 10,
      per_run_cap_usd: 1,
      approval_receipt_id: await approvedCard("governance.policy_change", "budget_policy", "west-peek"),
    });
    expect(backToLockdown.status).toBe(201);
  });
});

// ── 8. Lifecycle, visibility, and the event spine ──

describe("8. meeting lifecycle, privacy scope, and typed spine events", () => {
  it("refuses illegal lifecycle transitions", async () => {
    const meeting = await createMeetingApi({ occurred_at: undefined, scheduled_at: "2026-06-01T09:00:00.000Z" });
    expect(meeting.status).toBe("SCHEDULED");
    const held = await call<{ status: string }>(`/api/meetings/${meeting.id}/transition`, MP, "POST", { to: "HELD", occurred_at: "2026-06-01T09:30:00.000Z" });
    expect(held.body.status).toBe("HELD");
    const backwards = await call<{ error: string }>(`/api/meetings/${meeting.id}/transition`, MP, "POST", { to: "SCHEDULED" });
    expect(backwards.status).toBe(409);
    const cancelled = await call(`/api/meetings/${meeting.id}/transition`, MP, "POST", { to: "CANCELLED" });
    expect(cancelled.status).toBe(200);
    const afterCancel = await call<{ error: string }>(`/api/meetings/${meeting.id}/transition`, MP, "POST", { to: "HELD" });
    expect(afterCancel.status).toBe(409);
  });

  it("an MNPI_SENSITIVE meeting is invisible to a non-MP user (list and read)", async () => {
    const meeting = await createMeetingApi({ title: "Restricted broker call", meeting_type: "BROKER", privacy_label: "MNPI_SENSITIVE" });
    const listed = await call<{ meetings: Array<{ id: string }> }>("/api/meetings", MEMBER);
    expect(listed.body.meetings.map((m) => m.id)).not.toContain(meeting.id);
    const read = await call<{ error: string }>(`/api/meetings/${meeting.id}`, MEMBER);
    expect(read.status).toBe(404);
    const asMp = await call(`/api/meetings/${meeting.id}`, MP);
    expect(asMp.status).toBe(200);
  });

  it("the journey leaves typed events on the ONE spine (D15)", async () => {
    const company = await createCompany();
    const meeting = await createMeetingApi({ company_id: company, title: "Spine meeting" });
    await activateRecording(meeting.id);
    await grantTranscriptionConsent(meeting.id);
    const imported = await call<{ id: string }>(`/api/meetings/${meeting.id}/transcript`, MP, "POST", { source: "otter" });
    await call(`/api/meetings/${meeting.id}/notes`, MP, "POST", { note_type: "TRANSCRIPT_DERIVED", body: "note", transcript_import_id: imported.body.id });
    const commitment = await call<{ id: string }>(`/api/meetings/${meeting.id}/commitments`, MP, "POST", { commitment_text: "follow up", owner_side: "FIRM" });
    await call(`/api/meeting-commitments/${commitment.body.id}/convert`, MP, "POST", {});
    await call(`/api/meetings/${meeting.id}/debriefs`, MP, "POST", { summary: "done" });

    const events = await t.db
      .prepare("SELECT event_type FROM event_record WHERE json_extract(payload_json, '$.meeting_id') = ?1 OR object_id = ?1 ORDER BY created_at, id")
      .bind(meeting.id)
      .all<{ event_type: string }>();
    const types = new Set((events.results ?? []).map((e) => e.event_type));
    for (const expected of [
      "meeting.created",
      "meeting.recording_policy_activated",
      "meeting.consent_recorded",
      "meeting.transcript_imported",
      "meeting.note_added",
      "meeting.commitment_created",
      "meeting.commitment_converted",
      "meeting.debrief_created",
    ]) {
      expect(types, expected).toContain(expected);
    }
  });
});
