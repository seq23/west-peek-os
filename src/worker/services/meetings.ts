import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import type { FirmUserIdentity } from "../auth";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, canAccessPrivacyLabel, privacyVisibilityClause, type Actor } from "./authorize";
import { consumeApprovalCard } from "./approvals";
import { createWorkCardInternal } from "./workCards";
import { createClaim, getEvidenceSummary } from "./evidence";
import { privacyLabelSchema } from "../../shared/privacy";

/**
 * Meeting intelligence (P7): prep → consent → notes/transcript → debrief →
 * commitments → governed follow-up.
 *
 * Governing law (plan §8/P7): a conversation is never institutional truth.
 * - Transcript ingestion passes TWO independent gates: an activated recording
 *   policy (MP/compliance-reserved receipt on the meeting) AND a currently GRANTED
 *   consent record. A refusal is itself recorded (transcript_import status REFUSED)
 *   so "we did not record" is auditable.
 * - consent_record is append-only; the current state is the latest row per
 *   (meeting, consent_type). REVOKED immediately re-closes the gate.
 * - Transcript- and debrief-derived claims are created through the P5 evidence
 *   path with TRANSCRIPT/HUMAN_STATEMENT provenance, so the structural
 *   self-promotion ban applies: they can never be VERIFIED without a human
 *   attaching a qualifying source. OFF_RECORD notes are never a promotion source.
 * - Commitments become work cards; no follow-up leaves the building except through
 *   the P3 external-effect route (authorize() + approved receipt + executor).
 * - AI may draft prep packets, notes, and debriefs (ai_run_id recorded); nothing
 *   here lets an AI promote its own output. Provider failure degrades to the manual
 *   path — every write here is deterministic and provider-independent.
 */

export class MeetingError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

export const MEETING_TYPES = ["FOUNDER", "DILIGENCE", "PORTFOLIO", "LP", "INTERNAL", "BROKER", "OTHER"] as const;
export const MEETING_STATUSES = ["SCHEDULED", "HELD", "CANCELLED"] as const;
export const CONSENT_TYPES = ["RECORDING", "TRANSCRIPTION", "NOTE_SHARING"] as const;
export const CONSENT_STATES = ["REQUESTED", "GRANTED", "DENIED", "REVOKED"] as const;
export const NOTE_TYPES = ["MANUAL", "OFF_RECORD", "TRANSCRIPT_DERIVED"] as const;

export type ConsentType = (typeof CONSENT_TYPES)[number];
export type ConsentState = (typeof CONSENT_STATES)[number];

export interface MeetingRow {
  id: string;
  company_id: string | null;
  title: string;
  meeting_type: string;
  scheduled_at: string | null;
  occurred_at: string | null;
  location: string | null;
  status: string;
  recording_enabled: number;
  recording_policy_receipt_id: string | null;
  privacy_label: string;
  firm_scope: string;
  created_by: string;
  created_at: string;
  /** Migration 0199. The LP this conversation is with, when it is one. */
  lp_record_id?: string | null;
  /** Migration 0140. Set means the meeting is off the record; the three always travel together. */
  archived_at?: string | null;
  archived_by?: string | null;
  archive_reason?: string | null;
}

export interface ConsentRecordRow {
  id: string;
  meeting_id: string;
  consent_type: ConsentType;
  state: ConsentState;
  basis: string;
  granted_by: string | null;
  recorded_by: string;
  firm_scope: string;
  created_at: string;
}

function eventActor(actor: Actor): { actorType: "firm_user" | "ai_employee" | "system"; actorId: string } {
  return {
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
  };
}

async function mustAuthorize(env: Env, actor: Actor, actionKey: string, objectType: string, objectId?: string, firmScope?: string): Promise<void> {
  const authz = await authorize(env, actor, actionKey, { objectType, objectId, firmScope: firmScope ?? actor.firmScopes[0] ?? "west-peek" });
  if (authz.decision === "DENY") throw new MeetingError(403, "forbidden", authz.reason);
  if (authz.decision === "REQUIRE_APPROVAL") throw new MeetingError(409, "approval_required", authz.reason);
}

export async function getMeeting(env: Env, id: string): Promise<MeetingRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM meeting WHERE id = ?1").bind(id).first<MeetingRow>();
}

async function requireMeeting(env: Env, id: string): Promise<MeetingRow> {
  const meeting = await getMeeting(env, id);
  if (!meeting) throw new MeetingError(404, "not_found");
  return meeting;
}

// ── Meetings and participants ──

export interface CreateMeetingInput {
  title: string;
  meeting_type: (typeof MEETING_TYPES)[number];
  company_id?: string;
  /** Migration 0199. The LP this conversation is with, so the next brief can find the last one. */
  lp_record_id?: string;
  scheduled_at?: string;
  occurred_at?: string;
  location?: string;
  privacy_label?: string;
  participants?: Array<{ participant_type: "FIRM_USER" | "EXTERNAL"; display_name: string; firm_user_id?: string; organization?: string; participant_role?: string }>;
}

export async function createMeeting(env: Env, actor: Actor, input: CreateMeetingInput): Promise<MeetingRow> {
  await mustAuthorize(env, actor, "meeting.create", "meeting");
  if (input.company_id) {
    const company = await env.WP_OS_DB.prepare("SELECT id FROM canonical_company WHERE id = ?1").bind(input.company_id).first();
    if (!company) throw new MeetingError(400, "unknown_company", `canonical_company '${input.company_id}' does not exist`);
  }
  if (input.lp_record_id) {
    const lp = await env.WP_OS_DB.prepare("SELECT id FROM lp_record WHERE id = ?1").bind(input.lp_record_id).first();
    if (!lp) throw new MeetingError(400, "unknown_lp", `lp_record '${input.lp_record_id}' does not exist`);
  }
  const id = `mtg_${crypto.randomUUID()}`;
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  await env.WP_OS_DB.prepare(
    `INSERT INTO meeting (id, company_id, title, meeting_type, scheduled_at, occurred_at, location, status, privacy_label, firm_scope, created_by, lp_record_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  )
    .bind(
      id,
      input.company_id ?? null,
      input.title,
      input.meeting_type,
      input.scheduled_at ?? null,
      input.occurred_at ?? null,
      input.location ?? null,
      input.occurred_at ? "HELD" : "SCHEDULED",
      input.privacy_label ?? "INTERNAL",
      firmScope,
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
      input.lp_record_id ?? null,
    )
    .run();
  for (const participant of input.participants ?? []) {
    await addParticipant(env, actor, id, participant);
  }
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "meeting.created",
    actorType,
    actorId,
    objectType: "meeting",
    objectId: id,
    firmScope,
    payload: { title: input.title, meeting_type: input.meeting_type, company_id: input.company_id ?? null },
  });
  return (await getMeeting(env, id))!;
}

export async function addParticipant(
  env: Env,
  actor: Actor,
  meetingId: string,
  input: { participant_type: "FIRM_USER" | "EXTERNAL"; display_name: string; firm_user_id?: string; organization?: string; participant_role?: string },
) {
  const meeting = await requireMeeting(env, meetingId);
  await mustAuthorize(env, actor, "meeting.participant.add", "meeting_participant", meetingId, meeting.firm_scope);
  const id = `mtp_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO meeting_participant (id, meeting_id, participant_type, firm_user_id, display_name, organization, participant_role, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(id, meetingId, input.participant_type, input.firm_user_id ?? null, input.display_name, input.organization ?? null, input.participant_role ?? null, meeting.firm_scope)
    .run();
  return env.WP_OS_DB.prepare("SELECT * FROM meeting_participant WHERE id = ?1").bind(id).first();
}

export async function transitionMeeting(env: Env, actor: Actor, meetingId: string, to: (typeof MEETING_STATUSES)[number], occurredAt?: string): Promise<MeetingRow> {
  const meeting = await requireMeeting(env, meetingId);
  await mustAuthorize(env, actor, "meeting.update", "meeting", meetingId, meeting.firm_scope);
  if (meeting.status === "CANCELLED") throw new MeetingError(409, "illegal_transition", "a cancelled meeting is terminal");
  if (meeting.status === "HELD" && to === "SCHEDULED") throw new MeetingError(409, "illegal_transition", "a held meeting cannot be un-held");
  await env.WP_OS_DB.prepare("UPDATE meeting SET status = ?2, occurred_at = COALESCE(?3, occurred_at) WHERE id = ?1")
    .bind(meetingId, to, occurredAt ?? null)
    .run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "meeting.transitioned",
    actorType,
    actorId,
    objectType: "meeting",
    objectId: meetingId,
    firmScope: meeting.firm_scope,
    payload: { from: meeting.status, to },
  });
  return (await getMeeting(env, meetingId))!;
}

// ── Consent (append-only; current state = latest row per type) ──

export async function currentConsent(env: Env, meetingId: string, consentType: ConsentType): Promise<ConsentRecordRow | null> {
  return env.WP_OS_DB.prepare(
    "SELECT * FROM consent_record WHERE meeting_id = ?1 AND consent_type = ?2 ORDER BY created_at DESC, rowid DESC LIMIT 1",
  )
    .bind(meetingId, consentType)
    .first<ConsentRecordRow>();
}

/**
 * Append a consent state. Human-only: consent is obtained by a person from a person,
 * and an AI may never record that a human consented.
 */
export async function recordConsent(
  env: Env,
  actor: Actor,
  meetingId: string,
  input: { consent_type: ConsentType; state: ConsentState; basis: string; granted_by?: string },
): Promise<ConsentRecordRow> {
  const meeting = await requireMeeting(env, meetingId);
  if (actor.type !== "HUMAN") throw new MeetingError(403, "forbidden", "consent records are human-only");
  await mustAuthorize(env, actor, "meeting.consent.record", "consent_record", meetingId, meeting.firm_scope);
  if (input.state === "GRANTED" && !input.granted_by) {
    throw new MeetingError(400, "invalid_input", "a GRANTED consent must name who granted it");
  }
  const id = `csr_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO consent_record (id, meeting_id, consent_type, state, basis, granted_by, recorded_by, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(id, meetingId, input.consent_type, input.state, input.basis, input.granted_by ?? null, actor.firmUserId!, meeting.firm_scope)
    .run();
  await appendEvent(env, {
    eventType: "meeting.consent_recorded",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "consent_record",
    objectId: id,
    firmScope: meeting.firm_scope,
    payload: { meeting_id: meetingId, consent_type: input.consent_type, state: input.state },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM consent_record WHERE id = ?1").bind(id).first<ConsentRecordRow>())!;
}

/**
 * Activate the recording/transcription policy for a meeting — a named human gate
 * (§15). Requires an approved meeting.recording_policy.activate receipt, which is
 * consumed here and can never be replayed.
 */
export async function activateRecordingPolicy(env: Env, actor: Actor, meetingId: string, receiptId?: string): Promise<MeetingRow> {
  const meeting = await requireMeeting(env, meetingId);
  const authz = await authorize(
    env,
    actor,
    "meeting.recording_policy.activate",
    { objectType: "meeting", objectId: meetingId, firmScope: meeting.firm_scope },
    { receiptId },
  );
  if (authz.decision === "DENY") throw new MeetingError(403, "forbidden", authz.reason);
  if (authz.decision === "REQUIRE_APPROVAL") throw new MeetingError(409, "approval_required", authz.reason);
  if (meeting.recording_enabled === 1) throw new MeetingError(409, "already_active", "recording policy is already active for this meeting");

  await env.WP_OS_DB.prepare("UPDATE meeting SET recording_enabled = 1, recording_policy_receipt_id = ?2 WHERE id = ?1")
    .bind(meetingId, authz.receiptId ?? null)
    .run();
  await consumeApprovalCard(env, authz.receiptId!, { actorId: actor.firmUserId! });
  await appendEvent(env, {
    eventType: "meeting.recording_policy_activated",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "meeting",
    objectId: meetingId,
    firmScope: meeting.firm_scope,
    payload: { receipt_id: authz.receiptId ?? null },
  });
  return (await getMeeting(env, meetingId))!;
}

// ── Prep packets → the BEFORE brief (Phase B) ──

/**
 * Generalised, not duplicated. This was the IC-shaped prep (evidence summary, contradictions,
 * open questions); it now assembles the whole BEFORE brief for every meeting type through
 * `meetingBrief.assembleMeetingBrief`, which still fills the P7 columns beside the brief. The
 * signature is unchanged so every caller and test of `POST /api/meetings/:id/prep` keeps working.
 */
export async function assemblePrepPacket(
  env: Env,
  actor: Actor,
  meetingId: string,
  input: { open_questions?: string[]; ai_run_id?: string },
  visibleClause = "1=1",
) {
  await requireMeeting(env, meetingId);
  const { assembleMeetingBrief, MeetingBriefError } = await import("./meetingBrief");
  try {
    const stored = await assembleMeetingBrief(env, actor, meetingId, input, visibleClause);
    return env.WP_OS_DB.prepare("SELECT * FROM meeting_prep_packet WHERE id = ?1").bind(stored.id).first();
  } catch (err) {
    if (err instanceof MeetingBriefError) throw new MeetingError(err.status, err.code, err.message);
    throw err;
  }
}

// ── Transcript import (two independent gates; refusals are recorded) ──

export interface TranscriptImportRow {
  id: string;
  meeting_id: string;
  document_id: string | null;
  consent_record_id: string | null;
  source: string;
  status: "IMPORTED" | "REFUSED";
  refusal_reason: string | null;
  imported_by: string;
  firm_scope: string;
  created_at: string;
}

async function recordTranscriptImport(
  env: Env,
  meeting: MeetingRow,
  actorId: string,
  input: { source: string; document_id?: string; consent_record_id?: string },
  status: "IMPORTED" | "REFUSED",
  refusalReason?: string,
): Promise<TranscriptImportRow> {
  const id = `tri_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO transcript_import (id, meeting_id, document_id, consent_record_id, source, status, refusal_reason, imported_by, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(id, meeting.id, input.document_id ?? null, input.consent_record_id ?? null, input.source, status, refusalReason ?? null, actorId, meeting.firm_scope)
    .run();
  await appendEvent(env, {
    eventType: status === "IMPORTED" ? "meeting.transcript_imported" : "meeting.transcript_refused",
    actorType: "firm_user",
    actorId,
    objectType: "transcript_import",
    objectId: id,
    firmScope: meeting.firm_scope,
    payload: { meeting_id: meeting.id, source: input.source, status, reason: refusalReason ?? null },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM transcript_import WHERE id = ?1").bind(id).first<TranscriptImportRow>())!;
}

/**
 * Import a transcript. Refused (and recorded as REFUSED) unless BOTH the recording
 * policy is active for this meeting AND transcription consent is currently GRANTED.
 */
export async function importTranscript(
  env: Env,
  actor: Actor,
  meetingId: string,
  input: { source: string; document_id?: string },
): Promise<TranscriptImportRow> {
  const meeting = await requireMeeting(env, meetingId);
  if (actor.type !== "HUMAN") throw new MeetingError(403, "forbidden", "transcript import is human-initiated");
  await mustAuthorize(env, actor, "meeting.transcript.import", "transcript_import", meetingId, meeting.firm_scope);

  if (meeting.recording_enabled !== 1) {
    const refused = await recordTranscriptImport(env, meeting, actor.firmUserId!, input, "REFUSED", "recording_policy_not_activated");
    throw new MeetingError(409, "recording_policy_not_activated", `transcript refused and recorded as ${refused.id}`);
  }
  const consent = await currentConsent(env, meetingId, "TRANSCRIPTION");
  if (!consent || consent.state !== "GRANTED") {
    const refused = await recordTranscriptImport(env, meeting, actor.firmUserId!, input, "REFUSED", `consent_state:${consent?.state ?? "NOT_RECORDED"}`);
    throw new MeetingError(409, "consent_not_granted", `transcript refused and recorded as ${refused.id}`);
  }
  if (input.document_id) {
    const doc = await env.WP_OS_DB.prepare("SELECT id FROM document WHERE id = ?1").bind(input.document_id).first();
    if (!doc) throw new MeetingError(400, "unknown_document", `document '${input.document_id}' does not exist`);
  }
  return recordTranscriptImport(env, meeting, actor.firmUserId!, { ...input, consent_record_id: consent.id }, "IMPORTED");
}

// ── Notes ──

export interface MeetingNoteRow {
  id: string;
  meeting_id: string;
  note_type: (typeof NOTE_TYPES)[number];
  body: string;
  author_type: "HUMAN" | "AI";
  author_id: string;
  ai_run_id: string | null;
  transcript_import_id: string | null;
  privacy_label: string;
  firm_scope: string;
  created_at: string;
}

export async function addNote(
  env: Env,
  actor: Actor,
  meetingId: string,
  input: { note_type: (typeof NOTE_TYPES)[number]; body: string; transcript_import_id?: string; ai_run_id?: string; privacy_label?: string },
): Promise<MeetingNoteRow> {
  const meeting = await requireMeeting(env, meetingId);
  await mustAuthorize(env, actor, "meeting.note.add", "meeting_note", meetingId, meeting.firm_scope);
  if (actor.type === "AI" && !input.ai_run_id) {
    throw new MeetingError(400, "invalid_input", "an AI-authored note must record its ai_run_id (run_ai trace)");
  }
  if (input.note_type === "TRANSCRIPT_DERIVED") {
    if (!input.transcript_import_id) throw new MeetingError(400, "invalid_input", "a transcript-derived note must cite its transcript_import_id");
    const imported = await env.WP_OS_DB.prepare("SELECT id, status FROM transcript_import WHERE id = ?1 AND meeting_id = ?2")
      .bind(input.transcript_import_id, meetingId)
      .first<{ id: string; status: string }>();
    if (!imported || imported.status !== "IMPORTED") {
      throw new MeetingError(409, "no_imported_transcript", "transcript-derived notes require an IMPORTED transcript for this meeting");
    }
  }
  const id = `mnt_${crypto.randomUUID()}`;
  const { actorType, actorId } = eventActor(actor);
  await env.WP_OS_DB.prepare(
    `INSERT INTO meeting_note (id, meeting_id, note_type, body, author_type, author_id, ai_run_id, transcript_import_id, privacy_label, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      id,
      meetingId,
      input.note_type,
      input.body,
      actor.type === "AI" ? "AI" : "HUMAN",
      actorId,
      input.ai_run_id ?? null,
      input.transcript_import_id ?? null,
      input.privacy_label ?? meeting.privacy_label,
      meeting.firm_scope,
    )
    .run();
  await appendEvent(env, {
    eventType: "meeting.note_added",
    actorType,
    actorId,
    objectType: "meeting_note",
    objectId: id,
    firmScope: meeting.firm_scope,
    payload: { meeting_id: meetingId, note_type: input.note_type },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM meeting_note WHERE id = ?1").bind(id).first<MeetingNoteRow>())!;
}

// ── Commitments → work cards ──

export interface MeetingCommitmentRow {
  id: string;
  meeting_id: string;
  commitment_text: string;
  owner_side: "FIRM" | "COUNTERPARTY";
  owner_id: string | null;
  due_date: string | null;
  status: "OPEN" | "CONVERTED" | "DROPPED";
  work_card_id: string | null;
  firm_scope: string;
  created_by: string;
  created_at: string;
}

export async function createCommitment(
  env: Env,
  actor: Actor,
  meetingId: string,
  input: { commitment_text: string; owner_side: "FIRM" | "COUNTERPARTY"; owner_id?: string; due_date?: string },
): Promise<MeetingCommitmentRow> {
  const meeting = await requireMeeting(env, meetingId);
  await mustAuthorize(env, actor, "meeting.commitment.create", "meeting_commitment", meetingId, meeting.firm_scope);
  const id = `mcm_${crypto.randomUUID()}`;
  const { actorType, actorId } = eventActor(actor);
  await env.WP_OS_DB.prepare(
    `INSERT INTO meeting_commitment (id, meeting_id, commitment_text, owner_side, owner_id, due_date, firm_scope, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(id, meetingId, input.commitment_text, input.owner_side, input.owner_id ?? null, input.due_date ?? null, meeting.firm_scope, actorId)
    .run();
  await appendEvent(env, {
    eventType: "meeting.commitment_created",
    actorType,
    actorId,
    objectType: "meeting_commitment",
    objectId: id,
    firmScope: meeting.firm_scope,
    payload: { meeting_id: meetingId, owner_side: input.owner_side },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM meeting_commitment WHERE id = ?1").bind(id).first<MeetingCommitmentRow>())!;
}

/**
 * Convert a commitment into a governed work card. The work card is ordinary
 * governed work — sending anything externally still requires the P3 effect route.
 */
export async function convertCommitment(env: Env, identity: FirmUserIdentity, commitmentId: string): Promise<MeetingCommitmentRow> {
  const commitment = await env.WP_OS_DB.prepare("SELECT * FROM meeting_commitment WHERE id = ?1").bind(commitmentId).first<MeetingCommitmentRow>();
  if (!commitment) throw new MeetingError(404, "not_found");
  const meeting = await requireMeeting(env, commitment.meeting_id);
  const actor = actorFromIdentity(identity);
  await mustAuthorize(env, actor, "meeting.commitment.convert", "meeting_commitment", commitmentId, commitment.firm_scope);
  if (commitment.status !== "OPEN") throw new MeetingError(409, "illegal_state", `commitment is ${commitment.status}`);

  const card = await createWorkCardInternal(env, identity, {
    title: `Follow-up: ${commitment.commitment_text}`,
    description: `From meeting "${meeting.title}" (${meeting.id}). Owner side: ${commitment.owner_side}.`,
    owner_type: commitment.owner_id ? "HUMAN" : "UNASSIGNED",
    owner_id: commitment.owner_id ?? undefined,
    privacy_label: meeting.privacy_label,
    firm_scope: commitment.firm_scope,
    next_action: commitment.commitment_text,
    due_at: commitment.due_date ?? undefined,
    // Migration 0199: a card raised from a meeting returns to it.
    meeting_id: meeting.id,
  });
  await env.WP_OS_DB.prepare("UPDATE meeting_commitment SET status = 'CONVERTED', work_card_id = ?2 WHERE id = ?1").bind(commitmentId, card.id).run();
  await appendEvent(env, {
    eventType: "meeting.commitment_converted",
    actorType: "firm_user",
    actorId: identity.id,
    objectType: "meeting_commitment",
    objectId: commitmentId,
    firmScope: commitment.firm_scope,
    payload: { meeting_id: commitment.meeting_id, work_card_id: card.id },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM meeting_commitment WHERE id = ?1").bind(commitmentId).first<MeetingCommitmentRow>())!;
}

// ── Debrief and evidence promotion ──

export async function createDebrief(
  env: Env,
  actor: Actor,
  meetingId: string,
  input: { summary: string; signal_notes?: string; ai_run_id?: string },
) {
  const meeting = await requireMeeting(env, meetingId);
  await mustAuthorize(env, actor, "meeting.debrief.create", "meeting_debrief", meetingId, meeting.firm_scope);
  if (actor.type === "AI" && !input.ai_run_id) {
    throw new MeetingError(400, "invalid_input", "an AI-drafted debrief must record its ai_run_id (run_ai trace)");
  }
  const id = `mdb_${crypto.randomUUID()}`;
  const { actorType, actorId } = eventActor(actor);
  await env.WP_OS_DB.prepare(
    `INSERT INTO meeting_debrief (id, meeting_id, summary, signal_notes, drafted_by_type, drafted_by_id, ai_run_id, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(id, meetingId, input.summary, input.signal_notes ?? null, actor.type === "AI" ? "AI" : "HUMAN", actorId, input.ai_run_id ?? null, meeting.firm_scope)
    .run();
  await appendEvent(env, {
    eventType: "meeting.debrief_created",
    actorType,
    actorId,
    objectType: "meeting_debrief",
    objectId: id,
    firmScope: meeting.firm_scope,
    payload: { meeting_id: meetingId, drafted_by_type: actor.type === "AI" ? "AI" : "HUMAN" },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM meeting_debrief WHERE id = ?1").bind(id).first();
}

/**
 * Promote a note or debrief line into a diligence CLAIM CANDIDATE. The claim is
 * created through the P5 path with TRANSCRIPT (transcript-derived) or
 * HUMAN_STATEMENT (manual note) provenance — never VERIFIED, never self-promoting.
 * OFF_RECORD notes are refused outright.
 */
export async function promoteToClaimCandidate(
  env: Env,
  actor: Actor,
  meetingId: string,
  input: { note_id?: string; debrief_id?: string; claim_text: string; metric_key?: string; metric_value?: string; confidence?: number; ai_run_id?: string },
) {
  const meeting = await requireMeeting(env, meetingId);
  await mustAuthorize(env, actor, "meeting.debrief.promote_claim", "diligence_claim", meetingId, meeting.firm_scope);
  if (!meeting.company_id) throw new MeetingError(400, "no_company", "only a company-linked meeting can produce a company claim candidate");
  if (!input.note_id && !input.debrief_id) throw new MeetingError(400, "invalid_input", "cite the note_id or debrief_id being promoted");
  if (actor.type === "AI" && !input.ai_run_id) {
    throw new MeetingError(400, "invalid_input", "an AI-proposed claim candidate must record its ai_run_id (run_ai trace)");
  }

  let sourceType: "TRANSCRIPT" | "HUMAN_STATEMENT" = "HUMAN_STATEMENT";
  let location = `meeting ${meeting.id}`;
  if (input.note_id) {
    const note = await env.WP_OS_DB.prepare("SELECT * FROM meeting_note WHERE id = ?1 AND meeting_id = ?2").bind(input.note_id, meetingId).first<MeetingNoteRow>();
    if (!note) throw new MeetingError(404, "not_found", "note not found on this meeting");
    if (note.note_type === "OFF_RECORD") throw new MeetingError(409, "off_record", "off-record notes can never become institutional evidence");
    sourceType = note.note_type === "TRANSCRIPT_DERIVED" ? "TRANSCRIPT" : "HUMAN_STATEMENT";
    location = `meeting ${meeting.id} note ${note.id}`;
  } else {
    const debrief = await env.WP_OS_DB.prepare("SELECT id FROM meeting_debrief WHERE id = ?1 AND meeting_id = ?2").bind(input.debrief_id, meetingId).first<{ id: string }>();
    if (!debrief) throw new MeetingError(404, "not_found", "debrief not found on this meeting");
    location = `meeting ${meeting.id} debrief ${debrief.id}`;
  }

  // Goes through the P5 evidence service: the self-promotion ban applies there.
  return createClaim(
    env,
    actor,
    {
      company_id: meeting.company_id,
      subject_type: "company",
      subject_id: meeting.company_id,
      claim_text: input.claim_text,
      metric_key: input.metric_key,
      metric_value: input.metric_value,
      confidence: input.confidence ?? 0.5,
      privacy_label: meeting.privacy_label,
      sources: [
        {
          source_type: sourceType,
          location,
          source_date: meeting.occurred_at?.slice(0, 10) ?? meeting.created_at.slice(0, 10),
          method: input.note_id ? "meeting note promotion" : "meeting debrief promotion",
        },
      ],
    },
    {
      // Attribution follows the ACTOR: an AI-promoted line is an AI extraction
      // (AI_INFERRED + quarantined), never a human statement of record.
      eventType: "meeting.claim_candidate_created",
      extractor: actor.type === "AI" ? { type: "AI", id: actor.aiEmployeeId ?? "ai" } : { type: "HUMAN", id: actor.firmUserId ?? "system" },
      aiRunId: actor.type === "AI" ? input.ai_run_id : undefined,
    },
  );
}

// ── HTTP handlers ──

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof MeetingError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

const participantSchema = z.object({
  participant_type: z.enum(["FIRM_USER", "EXTERNAL"]),
  display_name: z.string().trim().min(1),
  firm_user_id: z.string().optional(),
  organization: z.string().optional(),
  participant_role: z.string().optional(),
});

const createMeetingSchema = z.object({
  title: z.string().trim().min(1),
  meeting_type: z.enum(MEETING_TYPES),
  company_id: z.string().trim().min(1).optional(),
  lp_record_id: z.string().trim().min(1).optional(),
  scheduled_at: z.string().optional(),
  occurred_at: z.string().optional(),
  location: z.string().optional(),
  privacy_label: privacyLabelSchema.optional(),
  participants: z.array(participantSchema).optional(),
});

export async function handleCreateMeeting(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = createMeetingSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createMeeting(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListMeetings(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const companyId = url.searchParams.get("company_id");
  const visibility = privacyVisibilityClause(ctx.identity!, "m.privacy_label");
  /*
   * ARCHIVED IS OFF THE RECORD (migration 0140). `?archived=1` is the other half of the honesty:
   * what was taken off, by whom and why, exactly as the pass pile works on Dealflow. Nothing is
   * destroyed, so nothing has to be believed on trust.
   *
   * THE FOUR COUNTS TRAVEL WITH EVERY ROW because the confirm has to say what stops being shown
   * and what stays. A partner archiving a test meeting must not find out six weeks later that a
   * real work card went with it — so the count is on screen BEFORE the press, not implied after.
   */
  const wantArchived = url.searchParams.get("archived") === "1";
  const shelf = wantArchived ? "m.archived_at IS NOT NULL" : "m.archived_at IS NULL";
  /*
   * THE THREE FACES ON THE LIST (Phase B). An upcoming meeting carries its READINESS — is the brief
   * built, how many open questions roll forward, how many things we still owe them — and a past
   * one carries its OUTPUTS — decisions, and commitments overdue. "Same company or LP" is the join
   * for anything carried forward; a meeting about neither carries zeros, honestly.
   */
  const today = new Date().toISOString().slice(0, 10);
  const sameParty = "(m2.id <> m.id AND m2.archived_at IS NULL AND ((m.company_id IS NOT NULL AND m2.company_id = m.company_id) OR (m.lp_record_id IS NOT NULL AND m2.lp_record_id = m.lp_record_id)))";
  const select = `SELECT m.*,
      (SELECT COUNT(*) FROM meeting_note n WHERE n.meeting_id = m.id) AS note_count,
      (SELECT COUNT(*) FROM meeting_commitment c WHERE c.meeting_id = m.id) AS commitment_count,
      (SELECT COUNT(*) FROM meeting_commitment c WHERE c.meeting_id = m.id AND c.work_card_id IS NOT NULL) AS work_card_count,
      (SELECT COUNT(*) FROM transcript_import t WHERE t.meeting_id = m.id) AS transcript_count,
      (SELECT COUNT(*) FROM meeting_prep_packet p WHERE p.meeting_id = m.id AND p.brief_json IS NOT NULL) > 0 AS brief_ready,
      (SELECT COUNT(*) FROM meeting_open_question q JOIN meeting m2 ON m2.id = q.meeting_id WHERE q.state = 'OPEN' AND ${sameParty}) AS carried_open_questions,
      (SELECT COUNT(*) FROM meeting_commitment c JOIN meeting m2 ON m2.id = c.meeting_id WHERE c.owner_side = 'FIRM' AND c.status = 'OPEN' AND c.honoured_at IS NULL AND ${sameParty}) AS we_owe_them,
      (SELECT COUNT(*) FROM meeting_commitment c JOIN meeting m2 ON m2.id = c.meeting_id WHERE c.owner_side = 'COUNTERPARTY' AND c.status = 'OPEN' AND c.honoured_at IS NULL AND ${sameParty}) AS they_owe_us,
      (SELECT COUNT(*) FROM meeting_decision d WHERE d.meeting_id = m.id) AS decision_count,
      (SELECT COUNT(*) FROM meeting_commitment c WHERE c.meeting_id = m.id AND c.status = 'OPEN' AND c.honoured_at IS NULL AND c.due_date IS NOT NULL AND substr(c.due_date, 1, 10) < '${today}') AS commitment_overdue_count,
      (SELECT COUNT(*) FROM meeting_open_question q WHERE q.meeting_id = m.id AND q.state = 'OPEN') AS open_question_count,
      (SELECT COUNT(*) FROM meeting_stage_proposal sp WHERE sp.meeting_id = m.id AND sp.state = 'PROPOSED') AS stage_proposal_pending_count,
      (SELECT COUNT(*) FROM meeting_after_draft ad WHERE ad.meeting_id = m.id AND ad.state = 'DRAFTED') AS draft_waiting_count
     FROM meeting m`;
  const rows = companyId
    ? await ctx.env.WP_OS_DB.prepare(`${select} WHERE m.company_id = ?1 AND ${visibility} AND ${shelf} ORDER BY m.created_at DESC, m.id LIMIT 500`).bind(companyId).all<MeetingRow>()
    : await ctx.env.WP_OS_DB.prepare(`${select} WHERE ${visibility} AND ${shelf} ORDER BY m.created_at DESC, m.id LIMIT 500`).all<MeetingRow>();
  // WHERE THE FIRM IS IN THE IC SEQUENCE. Four counts, so the page can say "you are here" rather
  // than showing four steps and leaving the operator to work out which one is blocked. Cheap
  // aggregates, and the alternative is a page that cannot tell "nothing has reached this yet" from
  // "this is broken" — which is exactly the confusion reported.
  const count = async (sql: string): Promise<number> =>
    Number((await ctx.env.WP_OS_DB.prepare(sql).first<{ n: number }>())?.n ?? 0);

  const ic = {
    // A deal far enough along that a committee is the next thing that happens to it.
    ready_deals: await count(
      "SELECT COUNT(*) AS n FROM investment_opportunity WHERE status IN ('DILIGENCE','IC_READY')",
    ),
    packets: await count("SELECT COUNT(*) AS n FROM ic_packet"),
    // There is no 'IC' meeting_type in the schema — the committee meets against a packet rather
    // than against a calendar entry, so the honest count of "has a committee sat" is decisions.
    meetings: await count("SELECT COUNT(*) AS n FROM ic_decision"),
    decisions: await count("SELECT COUNT(*) AS n FROM ic_decision"),
    // Poppy runs this. If she is switched off, the packet does not get assembled and nobody records
    // the dissent — which is a fact the page has to state rather than discover mid-meeting.
    facilitator: await ctx.env.WP_OS_DB.prepare(
      "SELECT name, status FROM ai_employee WHERE name = 'Poppy'",
    ).first<{ name: string; status: string }>(),
  };

  return json({ meetings: rows.results ?? [], ic });
}

/** A meeting read carries consent state, notes, commitments, debriefs, and transcript history. */
export async function handleGetMeeting(ctx: RouteContext): Promise<Response> {
  const meeting = await getMeeting(ctx.env, ctx.params.id!);
  if (!meeting) return json({ error: "not_found" }, { status: 404 });
  if (!canAccessPrivacyLabel(ctx.identity!, meeting.privacy_label)) return json({ error: "not_found" }, { status: 404 });
  const all = async (sql: string) => (await ctx.env.WP_OS_DB.prepare(sql).bind(meeting.id).all()).results ?? [];
  const consent: Record<string, ConsentRecordRow | null> = {};
  for (const type of CONSENT_TYPES) consent[type] = await currentConsent(ctx.env, meeting.id, type);
  return json({
    ...meeting,
    participants: await all("SELECT * FROM meeting_participant WHERE meeting_id = ?1 ORDER BY created_at, id"),
    consent_current: consent,
    consent_history: await all("SELECT * FROM consent_record WHERE meeting_id = ?1 ORDER BY created_at, id"),
    prep_packets: await all("SELECT * FROM meeting_prep_packet WHERE meeting_id = ?1 ORDER BY created_at, id"),
    transcript_imports: await all("SELECT * FROM transcript_import WHERE meeting_id = ?1 ORDER BY created_at, id"),
    notes: await all("SELECT * FROM meeting_note WHERE meeting_id = ?1 ORDER BY created_at, id"),
    commitments: await all("SELECT * FROM meeting_commitment WHERE meeting_id = ?1 ORDER BY created_at, id"),
    debriefs: await all("SELECT * FROM meeting_debrief WHERE meeting_id = ?1 ORDER BY created_at, id"),
  });
}

export async function handleAddParticipant(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = participantSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await addParticipant(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const transitionSchema = z.object({ to: z.enum(MEETING_STATUSES), occurred_at: z.string().optional() });

export async function handleTransitionMeeting(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = transitionSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await transitionMeeting(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.to, parsed.data.occurred_at));
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/meetings/:id/archive — take a meeting off the record.
 *
 * NOT A DELETE, and the difference is the point. Operator, 22 Aug 2026: "the call with scooter
 * meeting has no way to delete it. it was a test and some meetings i want to delete....we need a way
 * to delete them and we can have an audit trail if someone deletes." A meeting is referenced by its
 * consent records, its transcript imports, its notes, the employees seated in it, its commitments
 * and every work card a close-out made out of one — destroying the row would break all of that and
 * erase the trail the audit exists to keep. So it leaves every list and the record survives: who,
 * when, and why.
 *
 * A REASON IS REQUIRED. "It was a test" is a perfectly good reason, and typing it is the half
 * second that stops an accidental press.
 *
 * HUMAN ONLY. An employee does not get to remove the firm's record of a conversation, and that is
 * checked here rather than left to the action key, which is ordinary for everybody who may do it.
 *
 * ARCHIVING TWICE IS A NO-OP THAT SAYS SO. A second press is somebody who could not tell whether
 * the first one worked; answering it with an error teaches them the product is broken.
 */
export async function handleArchiveMeeting(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") {
    return json(
      { error: "forbidden", detail: "Taking a meeting off the record is a person's decision. An employee cannot make it." },
      { status: 403 },
    );
  }
  const meeting = await getMeeting(ctx.env, ctx.params.id!);
  if (!meeting) return json({ error: "not_found" }, { status: 404 });
  if (!canAccessPrivacyLabel(ctx.identity!, meeting.privacy_label)) return json({ error: "not_found" }, { status: 404 });

  const authz = await authorize(ctx.env, actor, "meeting.archive", {
    objectType: "meeting",
    objectId: meeting.id,
    firmScope: meeting.firm_scope,
  });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const body = (await parseJsonBody(ctx.request)) as { reason?: unknown } | null;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 3) {
    return json(
      {
        error: "reason_required",
        detail: "Say why in a few words. Six months from now the reason is the only part of this that still helps.",
      },
      { status: 400 },
    );
  }

  if (meeting.archived_at) {
    return json({
      id: meeting.id,
      archived: true,
      already_archived: true,
      note: "This one is already off the record — it was taken off on " + meeting.archived_at + ". Nothing changed.",
    });
  }

  await ctx.env.WP_OS_DB.prepare(
    `UPDATE meeting
        SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), archived_by = ?2, archive_reason = ?3
      WHERE id = ?1`,
  )
    .bind(meeting.id, actor.firmUserId ?? "system", reason.slice(0, 400))
    .run();

  await appendEvent(ctx.env, {
    eventType: "meeting.archived",
    actorType: "firm_user",
    actorId: actor.firmUserId ?? "system",
    objectType: "meeting",
    objectId: meeting.id,
    firmScope: meeting.firm_scope,
    payload: { title: meeting.title, meeting_type: meeting.meeting_type, reason: reason.slice(0, 400) },
  });

  return json({
    id: meeting.id,
    archived: true,
    already_archived: false,
    note: "Off the record. Nothing was destroyed — the notes, the transcript and any work card made out of it are untouched, and what you typed is on the trail with your name and the time.",
  });
}

const consentSchema = z.object({
  consent_type: z.enum(CONSENT_TYPES),
  state: z.enum(CONSENT_STATES),
  basis: z.string().trim().min(1),
  granted_by: z.string().optional(),
});

export async function handleRecordConsent(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = consentSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await recordConsent(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const recordingPolicySchema = z.object({ approval_receipt_id: z.string().trim().min(1).optional() });

export async function handleActivateRecordingPolicy(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = recordingPolicySchema.safeParse(body ?? {});
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await activateRecordingPolicy(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.approval_receipt_id));
  } catch (err) {
    return errorResponse(err);
  }
}

const prepSchema = z.object({ open_questions: z.array(z.string()).optional() });

export async function handleAssemblePrepPacket(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = prepSchema.safeParse(body ?? {});
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const packet = await assemblePrepPacket(
      ctx.env,
      actorFromIdentity(ctx.identity!),
      ctx.params.id!,
      parsed.data,
      privacyVisibilityClause(ctx.identity!, "privacy_label"),
    );
    return json(packet, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const transcriptSchema = z.object({ source: z.string().trim().min(1), document_id: z.string().trim().min(1).optional() });

export async function handleImportTranscript(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = transcriptSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await importTranscript(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const noteSchema = z.object({
  note_type: z.enum(NOTE_TYPES),
  body: z.string().trim().min(1),
  transcript_import_id: z.string().trim().min(1).optional(),
  privacy_label: privacyLabelSchema.optional(),
});

export async function handleAddNote(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = noteSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await addNote(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const commitmentSchema = z.object({
  commitment_text: z.string().trim().min(1),
  owner_side: z.enum(["FIRM", "COUNTERPARTY"]),
  owner_id: z.string().optional(),
  due_date: z.string().optional(),
});

export async function handleCreateCommitment(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = commitmentSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createCommitment(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleConvertCommitment(ctx: RouteContext): Promise<Response> {
  try {
    return json(await convertCommitment(ctx.env, ctx.identity!, ctx.params.id!));
  } catch (err) {
    return errorResponse(err);
  }
}

const debriefSchema = z.object({ summary: z.string().trim().min(1), signal_notes: z.string().optional() });

export async function handleCreateDebrief(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = debriefSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createDebrief(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const promoteSchema = z.object({
  note_id: z.string().trim().min(1).optional(),
  debrief_id: z.string().trim().min(1).optional(),
  claim_text: z.string().trim().min(1),
  metric_key: z.string().optional(),
  metric_value: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export async function handlePromoteToClaim(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = promoteSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await promoteToClaimCandidate(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    if (err instanceof MeetingError) return errorResponse(err);
    // Evidence-layer refusals (e.g. the self-promotion ban) surface with their own codes.
    const evidenceError = err as { status?: number; code?: string; message?: string };
    if (typeof evidenceError.status === "number" && typeof evidenceError.code === "string") {
      return json({ error: evidenceError.code, detail: evidenceError.message }, { status: evidenceError.status });
    }
    throw err;
  }
}
