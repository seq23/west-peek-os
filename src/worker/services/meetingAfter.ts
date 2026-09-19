import { z } from "zod";
import { NOT_SUPERSEDED_NOTE_CLAUSE } from "./meetLiveNotes";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { runAi } from "../ai/runAi";
import { actorFromIdentity, authorize, canAccessPrivacyLabel, privacyVisibilityClause, type Actor } from "./authorize";
import { OPPORTUNITY_STATUSES, transitionOpportunity, type OpportunityStatus } from "./investment";
import { meetingType } from "../../shared/meetings/meetingTypes";
import { personaPrompt } from "../../shared/registry/aiEmployeePersonas";
import { resolveAssignment, type RosterEntry } from "../../shared/meetings/delegationPolicy";

/**
 * The AFTER face of a meeting (Phase B, owner-approved 18 Sep 2026).
 *
 * A meeting is one object with three faces: BEFORE (the brief — meetingBrief.ts), DURING (capture
 * and the live room — Phase C) and AFTER: what came out. Four things come out of any meeting, of
 * any type, and each is a first-class row here:
 *
 *   meeting_decision        a thing was settled
 *   meeting_commitment      a thing is owed — by us OR by them (the P7 table, extended)
 *   meeting_open_question   a thing is still unknown, and somebody owes the answer
 *   meeting_stage_proposal  for a deal meeting: what this means for the deal's stage — PROPOSED
 *
 * plus `meeting_artifact`, a block saved on the meeting by the live room (Phase C writes these;
 * this file lists them).
 *
 * THE DRAFT IS THE ONLY DOOR IN FOR AI. `draftMeetingAfter` reads the notes and the transcript and
 * asks the type's lead employee (meetingTypes.ts, `suggests[0]`) for a JSON draft of all four. The
 * draft is stored, and NOTHING it contains is a record until a partner approves it —
 * `approveMeetingAfter` is human-only in code and writes each object through its own authorize()
 * key. A stage proposal, once recorded, is still only a proposal: `decideStageProposal` is the one
 * click, and accepting calls the ordinary `transitionOpportunity` path, which authorizes
 * `opportunity.transition` and applies every rule that path already has (a pass needs a reason,
 * CLOSED is a Managing Partner's call). Nothing here ever moves a deal on its own.
 *
 * WRITTEN FOR A ROLLING CALLER. Phase C calls the drafter while the meeting is still happening.
 * So the drafter is idempotent over its input — the notes are fingerprinted and a draft that
 * already exists for the same text is returned rather than re-run — and the pure parts
 * (`afterDraftPrompt`, `parseAfterDraft`, `recordAfterDraft`) are exported so a caller with its own
 * text, or its own model run, can use them without going through the read here.
 *
 * OFF-RECORD NOTES ARE NEVER READ. The P7 rule that an off-record note can never become
 * institutional evidence applies to a decision or a commitment exactly as it does to a claim.
 */

export class MeetingAfterError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

interface MeetingRow {
  id: string;
  title: string;
  meeting_type: string;
  status: string;
  company_id: string | null;
  lp_record_id: string | null;
  privacy_label: string;
  firm_scope: string;
  ai_access_state: string;
}

export interface MeetingDecisionRow {
  id: string;
  meeting_id: string;
  decision_text: string;
  decided_by: string | null;
  source_note_id: string | null;
  source_quote: string | null;
  recorded_by_type: string;
  recorded_by_id: string;
  ai_run_id: string | null;
  after_draft_id: string | null;
  recorded_at: string;
}

export interface MeetingCommitmentRow {
  id: string;
  meeting_id: string;
  commitment_text: string;
  owner_side: "FIRM" | "COUNTERPARTY";
  owner_id: string | null;
  owed_by: string | null;
  due_date: string | null;
  status: "OPEN" | "CONVERTED" | "DROPPED";
  work_card_id: string | null;
  honoured_at: string | null;
  honoured_note: string | null;
  origin: string;
  assignee_kind: string;
  ai_employee_id: string | null;
  human_touch_reason: string | null;
  source_quote: string | null;
  created_at: string;
}

export interface MeetingOpenQuestionRow {
  id: string;
  meeting_id: string;
  question: string;
  owed_by_kind: "PARTNER" | "AI_EMPLOYEE" | "COUNTERPARTY" | "UNASSIGNED";
  owed_by: string | null;
  state: "OPEN" | "ANSWERED" | "WITHDRAWN";
  answer: string | null;
  resolved_in_meeting_id: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  withdrawn_reason: string | null;
  raised_by_type: string;
  raised_by_id: string;
  source_quote: string | null;
  created_at: string;
}

export interface MeetingStageProposalRow {
  id: string;
  meeting_id: string;
  opportunity_id: string;
  from_status: string;
  to_status: string;
  rationale: string;
  state: "PROPOSED" | "ACCEPTED" | "DECLINED";
  proposed_by_type: string;
  proposed_by_id: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

export interface MeetingArtifactRow {
  id: string;
  meeting_id: string;
  /** `artifact` (0218) is the room's LINK BLOCK to something built on demand; the artifact itself lives in `artifact`. */
  kind: "answer" | "table" | "chart" | "packet" | "summary" | "artifact";
  title: string;
  body_json: string;
  produced_by_type: string;
  produced_by_id: string;
  ai_run_id: string | null;
  created_at: string;
}

export interface MeetingAfterDraftRow {
  id: string;
  meeting_id: string;
  draft_json: string;
  source_hash: string;
  notes_read: number;
  drafted_by: string;
  ai_run_id: string | null;
  state: "DRAFTED" | "APPROVED" | "DISCARDED" | "FAILED" | "REFUSED";
  detail: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

// ── The draft's shape: what the model may propose, checked in code ─────────────────────────────

const OWED_BY_KINDS = ["PARTNER", "AI_EMPLOYEE", "COUNTERPARTY", "UNASSIGNED"] as const;

export const afterDraftSchema = z.object({
  decisions: z
    .array(
      z.object({
        decision_text: z.string().trim().min(3).max(500),
        decided_by: z.string().trim().max(120).nullish(),
        source_quote: z.string().trim().max(400).nullish(),
      }),
    )
    .max(30)
    .default([]),
  commitments: z
    .array(
      z.object({
        commitment_text: z.string().trim().min(3).max(400),
        owner_side: z.enum(["FIRM", "COUNTERPARTY"]),
        owed_by: z.string().trim().max(120).nullish(),
        due_date: z.string().trim().max(40).nullish(),
        source_quote: z.string().trim().max(400).nullish(),
        suggested_employee_name: z.string().trim().max(60).nullish(),
      }),
    )
    .max(30)
    .default([]),
  open_questions: z
    .array(
      z.object({
        question: z.string().trim().min(8).max(500),
        owed_by_kind: z.enum(OWED_BY_KINDS).default("UNASSIGNED"),
        owed_by: z.string().trim().max(120).nullish(),
        source_quote: z.string().trim().max(400).nullish(),
      }),
    )
    .max(30)
    .default([]),
  stage_proposal: z
    .object({
      to_status: z.enum(OPPORTUNITY_STATUSES),
      rationale: z.string().trim().min(8).max(600),
    })
    .nullish(),
});

export type AfterDraft = z.infer<typeof afterDraftSchema>;

/**
 * Pull the model's JSON out of whatever it wrapped it in and check it against the schema.
 *
 * `null` means "no usable draft", which the caller records as FAILED with the reason. A draft with
 * every list empty is NOT null — "nothing came out of this meeting" is a legitimate answer, and the
 * draft says it examined the notes and found nothing.
 */
export function parseAfterDraft(raw: string): AfterDraft | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  const checked = afterDraftSchema.safeParse(parsed);
  return checked.success ? checked.data : null;
}

/** What the drafter is told about the deal, so a stage proposal can only name a legal move. */
export interface DealContext {
  opportunity_id: string;
  title: string;
  status: string;
  /** The statuses the deal may legally move to from where it is. */
  next: readonly string[];
}

/**
 * The prompt, in the voice of the type's lead employee.
 *
 * Exported so Phase C can build the same prompt over a rolling transcript and so the tests can
 * read what the model is asked without running one.
 */
export function afterDraftPrompt(args: {
  leadName: string;
  leadRole: string;
  meeting: { title: string; meeting_type: string };
  participants: string;
  text: string;
  deal: DealContext | null;
}): string {
  const lines = [
    personaPrompt(args.leadName, args.leadRole),
    "",
    "The meeting has ended (or is still going). Read what was said and DRAFT the four things that came out of it.",
    "You are drafting a proposal for a partner to approve. Nothing you write is a record until they do.",
    "",
    `MEETING: ${args.meeting.title} (${args.meeting.meeting_type})`,
    `PARTICIPANTS: ${args.participants || "not recorded"}`,
  ];
  if (args.deal) {
    lines.push(
      `DEAL: "${args.deal.title}" is at stage ${args.deal.status}. ` +
        (args.deal.next.length > 0
          ? `The only stages it may legally move to from here are: ${args.deal.next.join(", ")}.`
          : "It cannot move from here; propose no stage change."),
    );
  } else {
    lines.push("DEAL: none is linked to this meeting, so stage_proposal must be null.");
  }
  lines.push(
    "",
    "WHAT WAS SAID:",
    args.text,
    "",
    "Return ONLY a JSON object of this shape, with no commentary:",
    JSON.stringify({
      decisions: [{ decision_text: "...", decided_by: "who settled it, or null", source_quote: "the words this came from" }],
      commitments: [
        {
          commitment_text: "...",
          owner_side: "FIRM|COUNTERPARTY",
          owed_by: "the person or company holding it, or null",
          due_date: "YYYY-MM-DD or null",
          source_quote: "the words this came from",
          suggested_employee_name: "a first name or null",
        },
      ],
      open_questions: [
        { question: "...", owed_by_kind: "PARTNER|AI_EMPLOYEE|COUNTERPARTY|UNASSIGNED", owed_by: "who owes the answer, or null", source_quote: "the words this came from" },
      ],
      stage_proposal: { to_status: "one of the legal stages, or omit", rationale: "why, in a sentence" },
    }),
    "",
    "RULES:",
    "- A DECISION is something that was actually settled. A plan to decide later is an open question, not a decision.",
    "- A COMMITMENT is something somebody said they would do. owner_side is FIRM if we owe it, COUNTERPARTY if they do.",
    "- An OPEN QUESTION is something the meeting needed to know and did not find out.",
    "- source_quote must be words that appear in what was said. If you cannot quote it, do not list it.",
    "- due_date only if a date or deadline was actually stated. Otherwise null.",
    "- stage_proposal only if what was said clearly warrants moving the deal, and only to a legal stage. Otherwise null.",
    "- Do not invent anything that would be sensible but was not said. Empty lists are a correct answer.",
  );
  return lines.join("\n");
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────

async function requireMeeting(env: Env, meetingId: string): Promise<MeetingRow> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT id, title, meeting_type, status, company_id, lp_record_id, privacy_label, firm_scope, ai_access_state FROM meeting WHERE id = ?1",
  )
    .bind(meetingId)
    .first<MeetingRow>();
  if (!row) throw new MeetingAfterError(404, "not_found", "meeting not found");
  return row;
}

function eventActor(actor: Actor): { actorType: "firm_user" | "ai_employee" | "system"; actorId: string } {
  return {
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
  };
}

function byType(actor: Actor): "HUMAN" | "AI" | "SYSTEM" {
  return actor.type === "HUMAN" ? "HUMAN" : actor.type === "AI" ? "AI" : "SYSTEM";
}

async function mustAuthorize(env: Env, actor: Actor, actionKey: string, objectType: string, objectId: string, firmScope: string): Promise<void> {
  const authz = await authorize(env, actor, actionKey, { objectType, objectId, firmScope });
  if (authz.decision === "DENY") throw new MeetingAfterError(403, "forbidden", authz.reason);
  if (authz.decision === "REQUIRE_APPROVAL") throw new MeetingAfterError(409, "approval_required", authz.reason);
}

function requireHuman(actor: Actor, what: string): void {
  if (actor.type !== "HUMAN") {
    throw new MeetingAfterError(403, "forbidden", `${what} is a person's decision. An employee prepares it and cannot make it.`);
  }
}

export interface MeetingAfter {
  decisions: MeetingDecisionRow[];
  commitments: MeetingCommitmentRow[];
  open_questions: MeetingOpenQuestionRow[];
  stage_proposals: MeetingStageProposalRow[];
  artifacts: MeetingArtifactRow[];
  /** The newest draft of any state, so a FAILED one is visible rather than silently absent. */
  latest_draft: MeetingAfterDraftRow | null;
  counts: AfterCounts;
}

export interface AfterCounts {
  decisions: number;
  commitments_firm_open: number;
  commitments_counterparty_open: number;
  commitments_overdue: number;
  open_questions: number;
  stage_proposals_pending: number;
  artifacts: number;
}

/** Everything the After face holds for one meeting. The record and Phase C both read this. */
export async function readMeetingAfter(env: Env, meetingId: string, now: Date = new Date()): Promise<MeetingAfter> {
  const all = async <T>(sql: string) => (await env.WP_OS_DB.prepare(sql).bind(meetingId).all<T>()).results ?? [];
  const decisions = await all<MeetingDecisionRow>("SELECT * FROM meeting_decision WHERE meeting_id = ?1 ORDER BY recorded_at, id");
  const commitments = await all<MeetingCommitmentRow>("SELECT * FROM meeting_commitment WHERE meeting_id = ?1 ORDER BY created_at, id");
  const open_questions = await all<MeetingOpenQuestionRow>("SELECT * FROM meeting_open_question WHERE meeting_id = ?1 ORDER BY created_at, id");
  const stage_proposals = await all<MeetingStageProposalRow>("SELECT * FROM meeting_stage_proposal WHERE meeting_id = ?1 ORDER BY created_at, id");
  const artifacts = await all<MeetingArtifactRow>("SELECT * FROM meeting_artifact WHERE meeting_id = ?1 ORDER BY created_at, id");
  const latest_draft =
    (await env.WP_OS_DB.prepare("SELECT * FROM meeting_after_draft WHERE meeting_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1")
      .bind(meetingId)
      .first<MeetingAfterDraftRow>()) ?? null;
  const today = now.toISOString().slice(0, 10);
  const isOpen = (c: MeetingCommitmentRow) => c.status === "OPEN" && !c.honoured_at;
  return {
    decisions,
    commitments,
    open_questions,
    stage_proposals,
    artifacts,
    latest_draft,
    counts: {
      decisions: decisions.length,
      commitments_firm_open: commitments.filter((c) => c.owner_side === "FIRM" && isOpen(c)).length,
      commitments_counterparty_open: commitments.filter((c) => c.owner_side === "COUNTERPARTY" && isOpen(c)).length,
      commitments_overdue: commitments.filter((c) => isOpen(c) && c.due_date !== null && c.due_date.slice(0, 10) < today).length,
      open_questions: open_questions.filter((q) => q.state === "OPEN").length,
      stage_proposals_pending: stage_proposals.filter((p) => p.state === "PROPOSED").length,
      artifacts: artifacts.length,
    },
  };
}

// ── Records, one at a time. Each goes through its own key. ─────────────────────────────────────

export async function recordDecision(
  env: Env,
  actor: Actor,
  meetingId: string,
  input: { decision_text: string; decided_by?: string | null; source_note_id?: string | null; source_quote?: string | null; ai_run_id?: string | null; after_draft_id?: string | null },
): Promise<MeetingDecisionRow> {
  const meeting = await requireMeeting(env, meetingId);
  await mustAuthorize(env, actor, "meeting.decision.record", "meeting_decision", meetingId, meeting.firm_scope);
  if (actor.type === "AI" && !input.ai_run_id) {
    throw new MeetingAfterError(400, "invalid_input", "an AI-recorded decision must carry its ai_run_id (run_ai trace)");
  }
  if (input.source_note_id) {
    const note = await env.WP_OS_DB.prepare("SELECT note_type FROM meeting_note WHERE id = ?1 AND meeting_id = ?2")
      .bind(input.source_note_id, meetingId)
      .first<{ note_type: string }>();
    if (!note) throw new MeetingAfterError(404, "not_found", "source note not found on this meeting");
    if (note.note_type === "OFF_RECORD") throw new MeetingAfterError(409, "off_record", "an off-record note can never be the source of a decision");
  }
  const id = `mdc_${crypto.randomUUID()}`;
  const { actorType, actorId } = eventActor(actor);
  await env.WP_OS_DB.prepare(
    `INSERT INTO meeting_decision
       (id, meeting_id, decision_text, decided_by, source_note_id, source_quote, recorded_by_type, recorded_by_id, ai_run_id, after_draft_id, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      id, meetingId, input.decision_text.trim(), input.decided_by?.trim() || null, input.source_note_id ?? null,
      input.source_quote?.trim() || null, byType(actor), actorId, input.ai_run_id ?? null, input.after_draft_id ?? null, meeting.firm_scope,
    )
    .run();
  await appendEvent(env, {
    eventType: "meeting.decision_recorded",
    actorType, actorId,
    objectType: "meeting_decision",
    objectId: id,
    firmScope: meeting.firm_scope,
    payload: { meeting_id: meetingId, after_draft_id: input.after_draft_id ?? null },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM meeting_decision WHERE id = ?1").bind(id).first<MeetingDecisionRow>())!;
}

export async function recordOpenQuestion(
  env: Env,
  actor: Actor,
  meetingId: string,
  input: { question: string; owed_by_kind?: (typeof OWED_BY_KINDS)[number]; owed_by?: string | null; source_quote?: string | null; ai_run_id?: string | null; after_draft_id?: string | null },
): Promise<MeetingOpenQuestionRow> {
  const meeting = await requireMeeting(env, meetingId);
  await mustAuthorize(env, actor, "meeting.open_question.record", "meeting_open_question", meetingId, meeting.firm_scope);
  if (actor.type === "AI" && !input.ai_run_id) {
    throw new MeetingAfterError(400, "invalid_input", "an AI-raised question must carry its ai_run_id (run_ai trace)");
  }
  const id = `moq_${crypto.randomUUID()}`;
  const { actorType, actorId } = eventActor(actor);
  await env.WP_OS_DB.prepare(
    `INSERT INTO meeting_open_question
       (id, meeting_id, question, owed_by_kind, owed_by, raised_by_type, raised_by_id, source_quote, ai_run_id, after_draft_id, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      id, meetingId, input.question.trim(), input.owed_by_kind ?? "UNASSIGNED", input.owed_by?.trim() || null,
      byType(actor), actorId, input.source_quote?.trim() || null, input.ai_run_id ?? null, input.after_draft_id ?? null, meeting.firm_scope,
    )
    .run();
  await appendEvent(env, {
    eventType: "meeting.open_question_recorded",
    actorType, actorId,
    objectType: "meeting_open_question",
    objectId: id,
    firmScope: meeting.firm_scope,
    payload: { meeting_id: meetingId, owed_by_kind: input.owed_by_kind ?? "UNASSIGNED" },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM meeting_open_question WHERE id = ?1").bind(id).first<MeetingOpenQuestionRow>())!;
}

/**
 * Answer or withdraw a question. Withdrawing is not answering: a question the firm decided it does
 * not need is a different fact from one it answered, and both are recorded as what they are.
 */
export async function resolveOpenQuestion(
  env: Env,
  actor: Actor,
  questionId: string,
  input: { state: "ANSWERED" | "WITHDRAWN"; answer?: string; withdrawn_reason?: string; resolved_in_meeting_id?: string },
): Promise<MeetingOpenQuestionRow> {
  const q = await env.WP_OS_DB.prepare("SELECT * FROM meeting_open_question WHERE id = ?1").bind(questionId).first<MeetingOpenQuestionRow>();
  if (!q) throw new MeetingAfterError(404, "not_found", "open question not found");
  const meeting = await requireMeeting(env, q.meeting_id);
  await mustAuthorize(env, actor, "meeting.open_question.record", "meeting_open_question", questionId, meeting.firm_scope);
  if (q.state !== "OPEN") throw new MeetingAfterError(409, "illegal_state", `question is already ${q.state}`);
  const text = (input.state === "ANSWERED" ? input.answer : input.withdrawn_reason)?.trim() ?? "";
  if (text.length < 3) {
    throw new MeetingAfterError(400, "reason_required", input.state === "ANSWERED" ? "Say what the answer was." : "Say why the question is no longer needed.");
  }
  if (input.resolved_in_meeting_id) await requireMeeting(env, input.resolved_in_meeting_id);
  const { actorType, actorId } = eventActor(actor);
  await env.WP_OS_DB.prepare(
    `UPDATE meeting_open_question
        SET state = ?2, answer = ?3, withdrawn_reason = ?4, resolved_in_meeting_id = ?5, resolved_by = ?6,
            resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?1`,
  )
    .bind(questionId, input.state, input.state === "ANSWERED" ? text : null, input.state === "WITHDRAWN" ? text : null, input.resolved_in_meeting_id ?? null, actorId)
    .run();
  await appendEvent(env, {
    eventType: "meeting.open_question_resolved",
    actorType, actorId,
    objectType: "meeting_open_question",
    objectId: questionId,
    firmScope: meeting.firm_scope,
    payload: { meeting_id: q.meeting_id, state: input.state, resolved_in_meeting_id: input.resolved_in_meeting_id ?? null },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM meeting_open_question WHERE id = ?1").bind(questionId).first<MeetingOpenQuestionRow>())!;
}

/**
 * A commitment was delivered on. For a COUNTERPARTY commitment this is the whole chase: it stops
 * appearing in the next brief and on the ledger. For a FIRM one it is the non-work-card way of
 * closing it — a promise kept in the meeting itself, say.
 */
export async function honourCommitment(env: Env, actor: Actor, commitmentId: string, note?: string): Promise<MeetingCommitmentRow> {
  const c = await env.WP_OS_DB.prepare("SELECT * FROM meeting_commitment WHERE id = ?1").bind(commitmentId).first<MeetingCommitmentRow>();
  if (!c) throw new MeetingAfterError(404, "not_found", "commitment not found");
  const meeting = await requireMeeting(env, c.meeting_id);
  await mustAuthorize(env, actor, "meeting.commitment.create", "meeting_commitment", commitmentId, meeting.firm_scope);
  if (c.honoured_at) throw new MeetingAfterError(409, "illegal_state", "already marked as delivered");
  if (c.status === "DROPPED") throw new MeetingAfterError(409, "illegal_state", "a dropped commitment is no longer tracked");
  const { actorType, actorId } = eventActor(actor);
  await env.WP_OS_DB.prepare(
    "UPDATE meeting_commitment SET honoured_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), honoured_note = ?2 WHERE id = ?1",
  )
    .bind(commitmentId, note?.trim() || null)
    .run();
  await appendEvent(env, {
    eventType: "meeting.commitment_honoured",
    actorType, actorId,
    objectType: "meeting_commitment",
    objectId: commitmentId,
    firmScope: meeting.firm_scope,
    payload: { meeting_id: c.meeting_id, owner_side: c.owner_side },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM meeting_commitment WHERE id = ?1").bind(commitmentId).first<MeetingCommitmentRow>())!;
}

/** The live opportunity a meeting's company is in, if any, with the moves it may legally make. */
export async function dealContextFor(env: Env, companyId: string | null): Promise<DealContext | null> {
  if (!companyId) return null;
  const opp = await env.WP_OS_DB.prepare(
    `SELECT id, title, status FROM investment_opportunity
      WHERE company_id = ?1 AND archived_at IS NULL AND status NOT IN ('CLOSED','PASS','WITHDRAWN')
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(companyId)
    .first<{ id: string; title: string; status: OpportunityStatus }>();
  if (!opp) return null;
  return { opportunity_id: opp.id, title: opp.title, status: opp.status, next: LEGAL_NEXT[opp.status] ?? [] };
}

/**
 * The legal moves, restated here from investment.ts's private table for the PROMPT and the
 * pre-check only. The transition itself is still decided by `transitionOpportunity`, so a
 * disagreement between the two can only ever make a proposal be refused, never let an illegal
 * one through.
 */
const LEGAL_NEXT: Readonly<Record<string, readonly OpportunityStatus[]>> = {
  NEW: ["SCREENING", "PASS", "WITHDRAWN"],
  SCREENING: ["DILIGENCE", "PASS", "WITHDRAWN"],
  DILIGENCE: ["IC_READY", "PASS", "WITHDRAWN"],
  IC_READY: ["IC_DECIDED", "PASS", "WITHDRAWN"],
  IC_DECIDED: ["CLOSED", "WITHDRAWN"],
  CLOSED: [],
  PASS: ["SCREENING"],
  WITHDRAWN: ["SCREENING"],
};

export async function proposeStageChange(
  env: Env,
  actor: Actor,
  meetingId: string,
  input: { opportunity_id?: string; to_status: OpportunityStatus; rationale: string; ai_run_id?: string | null; after_draft_id?: string | null },
): Promise<MeetingStageProposalRow> {
  const meeting = await requireMeeting(env, meetingId);
  await mustAuthorize(env, actor, "meeting.stage_change.propose", "meeting_stage_proposal", meetingId, meeting.firm_scope);
  if (actor.type === "AI" && !input.ai_run_id) {
    throw new MeetingAfterError(400, "invalid_input", "an AI-proposed stage change must carry its ai_run_id (run_ai trace)");
  }
  const opp = input.opportunity_id
    ? await env.WP_OS_DB.prepare("SELECT id, title, status, company_id FROM investment_opportunity WHERE id = ?1")
        .bind(input.opportunity_id)
        .first<{ id: string; title: string; status: OpportunityStatus; company_id: string }>()
    : await dealContextFor(env, meeting.company_id).then((d) =>
        d ? { id: d.opportunity_id, title: d.title, status: d.status as OpportunityStatus, company_id: meeting.company_id! } : null,
      );
  if (!opp) throw new MeetingAfterError(400, "no_deal", "no live deal is linked to this meeting's company, so there is no stage to propose moving");
  if (meeting.company_id && opp.company_id !== meeting.company_id) {
    throw new MeetingAfterError(400, "wrong_company", "that deal belongs to a different company from this meeting");
  }
  if (!(LEGAL_NEXT[opp.status] ?? []).includes(input.to_status)) {
    throw new MeetingAfterError(409, "illegal_transition", `a deal at ${opp.status} cannot move to ${input.to_status}`);
  }
  const pending = await env.WP_OS_DB.prepare(
    "SELECT id FROM meeting_stage_proposal WHERE meeting_id = ?1 AND opportunity_id = ?2 AND state = 'PROPOSED' LIMIT 1",
  )
    .bind(meetingId, opp.id)
    .first<{ id: string }>();
  if (pending) throw new MeetingAfterError(409, "already_proposed", `a proposal for this deal is already waiting on a partner (${pending.id})`);

  const id = `msp_${crypto.randomUUID()}`;
  const { actorType, actorId } = eventActor(actor);
  await env.WP_OS_DB.prepare(
    `INSERT INTO meeting_stage_proposal
       (id, meeting_id, opportunity_id, from_status, to_status, rationale, proposed_by_type, proposed_by_id, ai_run_id, after_draft_id, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(id, meetingId, opp.id, opp.status, input.to_status, input.rationale.trim(), byType(actor), actorId, input.ai_run_id ?? null, input.after_draft_id ?? null, meeting.firm_scope)
    .run();
  await appendEvent(env, {
    eventType: "meeting.stage_change_proposed",
    actorType, actorId,
    objectType: "meeting_stage_proposal",
    objectId: id,
    firmScope: meeting.firm_scope,
    payload: { meeting_id: meetingId, opportunity_id: opp.id, from: opp.status, to: input.to_status },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM meeting_stage_proposal WHERE id = ?1").bind(id).first<MeetingStageProposalRow>())!;
}

/**
 * The one click. ACCEPT runs the ordinary transition — `opportunity.transition` under authorize(),
 * with every rule that path has — and only marks the proposal ACCEPTED if that succeeded. DECLINE
 * records the partner's reason. Human only: a proposal a model could accept is not a proposal.
 */
export async function decideStageProposal(
  env: Env,
  actor: Actor,
  proposalId: string,
  input: { decision: "ACCEPT" | "DECLINE"; note?: string },
): Promise<MeetingStageProposalRow> {
  requireHuman(actor, "Moving a deal");
  const p = await env.WP_OS_DB.prepare("SELECT * FROM meeting_stage_proposal WHERE id = ?1").bind(proposalId).first<MeetingStageProposalRow>();
  if (!p) throw new MeetingAfterError(404, "not_found", "stage proposal not found");
  const meeting = await requireMeeting(env, p.meeting_id);
  if (p.state !== "PROPOSED") throw new MeetingAfterError(409, "illegal_state", `proposal is already ${p.state}`);
  const note = input.note?.trim() || null;
  if (input.decision === "DECLINE" && (note ?? "").length < 3) {
    throw new MeetingAfterError(400, "reason_required", "Say why in a few words, so the next reader knows this was considered.");
  }
  if (input.decision === "ACCEPT") {
    try {
      // The reason handed to the transition is the proposal's rationale, or the partner's note
      // where they wrote one: a PASS needs a sentence and this is where it comes from.
      await transitionOpportunity(env, actor, p.opportunity_id, p.to_status as OpportunityStatus, note ?? p.rationale);
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      if (typeof e.status === "number" && typeof e.code === "string") throw new MeetingAfterError(e.status, e.code, e.message);
      throw err;
    }
  }
  const { actorType, actorId } = eventActor(actor);
  await env.WP_OS_DB.prepare(
    `UPDATE meeting_stage_proposal
        SET state = ?2, decided_by = ?3, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), decision_note = ?4
      WHERE id = ?1`,
  )
    .bind(proposalId, input.decision === "ACCEPT" ? "ACCEPTED" : "DECLINED", actorId, note)
    .run();
  await appendEvent(env, {
    eventType: "meeting.stage_change_decided",
    actorType, actorId,
    objectType: "meeting_stage_proposal",
    objectId: proposalId,
    firmScope: meeting.firm_scope,
    payload: { meeting_id: p.meeting_id, opportunity_id: p.opportunity_id, decision: input.decision, to: p.to_status },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM meeting_stage_proposal WHERE id = ?1").bind(proposalId).first<MeetingStageProposalRow>())!;
}

/**
 * Save a block on the meeting. Phase C's "ask the room" is the caller; the record renders these
 * read-only. Kept here so the table has exactly one writer to look at.
 */
export async function saveMeetingArtifact(
  env: Env,
  actor: Actor,
  meetingId: string,
  input: { kind: MeetingArtifactRow["kind"]; title: string; body: unknown; ai_run_id?: string | null },
): Promise<MeetingArtifactRow> {
  const meeting = await requireMeeting(env, meetingId);
  // A saved block is a note in a different shape, so it is governed by the note key.
  await mustAuthorize(env, actor, "meeting.note.add", "meeting_artifact", meetingId, meeting.firm_scope);
  if (actor.type === "AI" && !input.ai_run_id) {
    throw new MeetingAfterError(400, "invalid_input", "an AI-produced artifact must carry its ai_run_id (run_ai trace)");
  }
  const id = `mar_${crypto.randomUUID()}`;
  const { actorType, actorId } = eventActor(actor);
  await env.WP_OS_DB.prepare(
    `INSERT INTO meeting_artifact (id, meeting_id, kind, title, body_json, produced_by_type, produced_by_id, ai_run_id, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(id, meetingId, input.kind, input.title.trim(), JSON.stringify(input.body ?? {}), byType(actor), actorId, input.ai_run_id ?? null, meeting.firm_scope)
    .run();
  await appendEvent(env, {
    eventType: "meeting.artifact_saved",
    actorType, actorId,
    objectType: "meeting_artifact",
    objectId: id,
    firmScope: meeting.firm_scope,
    payload: { meeting_id: meetingId, kind: input.kind },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM meeting_artifact WHERE id = ?1").bind(id).first<MeetingArtifactRow>())!;
}

// ── The draft ──────────────────────────────────────────────────────────────────────────────────

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The words the drafter reads: on-the-record notes and transcript lines, never off-record ones. */
export async function draftInputFor(env: Env, meetingId: string): Promise<{ text: string; notes: number }> {
  const res = await env.WP_OS_DB.prepare(
    // A live import the official Meet transcript has superseded (tier 4) is not read twice.
    `SELECT body FROM meeting_note WHERE meeting_id = ?1 AND note_type IN ('MANUAL','TRANSCRIPT_DERIVED') AND ${NOT_SUPERSEDED_NOTE_CLAUSE} ORDER BY created_at, id LIMIT 400`,
  )
    .bind(meetingId)
    .all<{ body: string }>();
  const rows = res.results ?? [];
  return { text: rows.map((n) => `- ${n.body}`).join("\n").slice(0, 12_000), notes: rows.length };
}

/** The type's lead employee: `suggests[0]` on meetingTypes.ts, with the roster row if it exists. */
export async function leadEmployeeFor(env: Env, meetingTypeKey: string): Promise<{ name: string; role: string; id: string | null; status: string | null }> {
  const type = meetingType(meetingTypeKey);
  const name = type?.suggests[0] ?? "Walter";
  const row = await env.WP_OS_DB.prepare("SELECT id, role, status FROM ai_employee WHERE name = ?1").bind(name).first<{ id: string; role: string; status: string }>();
  return { name, role: row?.role ?? "Meeting Buddy", id: row?.id ?? null, status: row?.status ?? null };
}

/**
 * Store a draft. Exported for Phase C (a draft made from its own model run over a rolling
 * transcript) and for tests (a draft with no run at all). The draft is validated against the same
 * schema the model's output is, so a caller cannot store a shape the approver would refuse.
 */
export async function recordAfterDraft(
  env: Env,
  actor: Actor,
  meetingId: string,
  input: { draft: AfterDraft | null; source_hash: string; notes_read: number; drafted_by: string; ai_run_id?: string | null; state?: MeetingAfterDraftRow["state"]; detail?: string | null },
): Promise<MeetingAfterDraftRow> {
  const meeting = await requireMeeting(env, meetingId);
  const draft = input.draft ? afterDraftSchema.parse(input.draft) : null;
  const state = input.state ?? (draft ? "DRAFTED" : "FAILED");
  const id = `mad_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO meeting_after_draft (id, meeting_id, draft_json, source_hash, notes_read, drafted_by, ai_run_id, state, detail, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(id, meetingId, JSON.stringify(draft ?? {}), input.source_hash, input.notes_read, input.drafted_by, input.ai_run_id ?? null, state, input.detail ?? null, meeting.firm_scope)
    .run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "meeting.after_drafted",
    actorType, actorId,
    objectType: "meeting_after_draft",
    objectId: id,
    firmScope: meeting.firm_scope,
    payload: {
      meeting_id: meetingId,
      state,
      drafted_by: input.drafted_by,
      decisions: draft?.decisions.length ?? 0,
      commitments: draft?.commitments.length ?? 0,
      open_questions: draft?.open_questions.length ?? 0,
      stage_proposal: Boolean(draft?.stage_proposal),
    },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM meeting_after_draft WHERE id = ?1").bind(id).first<MeetingAfterDraftRow>())!;
}

/**
 * Draft the After face from what was said.
 *
 * Idempotent over its input: the text is fingerprinted, and a draft that already exists for that
 * fingerprint (drafted or approved) is returned rather than re-run. That is what makes it safe for
 * Phase C to call after every few transcript lines — the cost is one run per CHANGE in the text,
 * not one per call.
 *
 * `opts.text` lets a caller hand in the words directly (the live room's transcript so far). Without
 * it the meeting's on-record notes are read.
 *
 * Every outcome is a row. A refusal (access revoked, nothing to read) and a failure (the model
 * could not be read) are both stored with their reason, so the record can say "no draft, because"
 * rather than showing nothing.
 */
export async function draftMeetingAfter(
  env: Env,
  actor: Actor,
  meetingId: string,
  opts: { text?: string } = {},
): Promise<{ draft: MeetingAfterDraftRow; reused: boolean }> {
  const meeting = await requireMeeting(env, meetingId);
  // Drafting is preparing a proposal, governed by the same key that lets a commitment be recorded.
  await mustAuthorize(env, actor, "meeting.commitment.create", "meeting_after_draft", meetingId, meeting.firm_scope);
  const lead = await leadEmployeeFor(env, meeting.meeting_type);

  if (meeting.ai_access_state === "REVOKED") {
    // Canon §9.6.2E: a revoked room means no AI employee can process follow-up from it.
    const draft = await recordAfterDraft(env, actor, meetingId, {
      draft: null, source_hash: "revoked", notes_read: 0, drafted_by: lead.name, state: "REFUSED",
      detail: "AI access to this meeting is revoked, so nothing was read and nothing was drafted.",
    });
    return { draft, reused: false };
  }

  const input = opts.text !== undefined ? { text: opts.text.trim().slice(0, 12_000), notes: 0 } : await draftInputFor(env, meetingId);
  if (!input.text.trim()) {
    const draft = await recordAfterDraft(env, actor, meetingId, {
      draft: null, source_hash: "empty", notes_read: 0, drafted_by: lead.name, state: "REFUSED",
      detail: "Nothing on the record to read — no on-the-record notes and no transcript. Add notes and draft again.",
    });
    return { draft, reused: false };
  }

  const hash = await sha256(input.text);
  const existing = await env.WP_OS_DB.prepare(
    "SELECT * FROM meeting_after_draft WHERE meeting_id = ?1 AND source_hash = ?2 AND state IN ('DRAFTED','APPROVED') ORDER BY created_at DESC LIMIT 1",
  )
    .bind(meetingId, hash)
    .first<MeetingAfterDraftRow>();
  if (existing) return { draft: existing, reused: true };

  const peopleRes = await env.WP_OS_DB.prepare("SELECT display_name, participant_type FROM meeting_participant WHERE meeting_id = ?1 LIMIT 30")
    .bind(meetingId)
    .all<{ display_name: string; participant_type: string }>();
  const participants = (peopleRes.results ?? []).map((p) => `${p.display_name} [${p.participant_type}]`).join(", ");
  const deal = await dealContextFor(env, meeting.company_id);

  let aiRunId: string | null = null;
  let parsed: AfterDraft | null = null;
  try {
    const { run } = await runAi(env, {
      purpose: `meeting after-draft for ${meeting.id}`,
      actor,
      aiEmployeeId: lead.id ?? undefined,
      inputs: [afterDraftPrompt({ leadName: lead.name, leadRole: lead.role, meeting, participants, text: input.text, deal })],
      // The meeting's own label, never lowered. And the CONTENT rule, enforced at the router and
      // not in a prompt: an LP conversation names limited partners, so it is declared
      // PRIVATE_MODEL_ONLY here — `confidential` is read by runAi's content class before a route
      // is chosen, and no training-permitting lane can serve it. Every other type is undeclared,
      // which the router already treats as private.
      sensitivity: meeting.privacy_label as never,
      budgetContext: {
        judgement: true,
        expectedOutputTokens: 1200,
        confidential: meeting.meeting_type === "LP" || meeting.lp_record_id !== null,
      },
      routing: { category: "INTELLIGENCE" },
    });
    aiRunId = run.id;
    if (run.status === "COMPLETED" && run.output_text) parsed = parseAfterDraft(run.output_text);
  } catch (err) {
    const draft = await recordAfterDraft(env, actor, meetingId, {
      draft: null, source_hash: hash, notes_read: input.notes, drafted_by: lead.name, state: "FAILED",
      detail: `The draft could not run: ${err instanceof Error ? err.message : String(err)}. The notes are unchanged.`,
    });
    return { draft, reused: false };
  }

  if (!parsed) {
    const draft = await recordAfterDraft(env, actor, meetingId, {
      draft: null, source_hash: hash, notes_read: input.notes, drafted_by: lead.name, ai_run_id: aiRunId, state: "FAILED",
      detail: `${lead.name} could not read decisions, commitments or questions out of these notes. Nothing was recorded.`,
    });
    return { draft, reused: false };
  }

  // A stage proposal to a stage the deal cannot legally reach is dropped HERE, in code, and the
  // draft says so — the model does not get to widen the pipeline by naming a stage.
  let detail: string | null = null;
  if (parsed.stage_proposal && (!deal || !deal.next.includes(parsed.stage_proposal.to_status))) {
    detail = deal
      ? `A move to ${parsed.stage_proposal.to_status} was proposed and dropped: the deal is at ${deal.status} and cannot go there.`
      : `A move to ${parsed.stage_proposal.to_status} was proposed and dropped: no live deal is linked to this meeting.`;
    parsed = { ...parsed, stage_proposal: null };
  }

  const draft = await recordAfterDraft(env, actor, meetingId, {
    draft: parsed, source_hash: hash, notes_read: input.notes, drafted_by: lead.name, ai_run_id: aiRunId, state: "DRAFTED", detail,
  });
  return { draft, reused: false };
}

/** ACTIVE employees only — a paused employee must not be handed work. */
async function activeRoster(env: Env, firmScope: string): Promise<RosterEntry[]> {
  const res = await env.WP_OS_DB.prepare("SELECT id, name, role, status FROM ai_employee WHERE status = 'ACTIVE' AND firm_scope = ?1 ORDER BY name")
    .bind(firmScope)
    .all<RosterEntry>();
  return res.results ?? [];
}

/**
 * Approve a draft: the moment its contents become records.
 *
 * HUMAN ONLY, in code. Each object is written through its own key so the trail says a decision was
 * recorded, a question raised, a stage move proposed — not "a blob was approved". Firm-side
 * commitments go through the P33 assignment policy exactly as close-out's do (employees by default,
 * human work recommended, never assigned), and counterparty ones are tracked with who owes them.
 *
 * `override` lets the partner approve an EDITED draft — a line struck, a due date corrected — and
 * is checked against the same schema. What is approved is what is written.
 *
 * Duplicates are skipped by text against what the meeting already holds, so approving twice, or
 * approving after a hand-typed record of the same thing, tops up rather than doubling.
 */
export async function approveMeetingAfter(
  env: Env,
  actor: Actor,
  draftId: string,
  override?: AfterDraft,
): Promise<{ draft: MeetingAfterDraftRow; written: { decisions: number; commitments: number; open_questions: number; stage_proposal: boolean; skipped: number }; after: MeetingAfter }> {
  requireHuman(actor, "Approving what came out of a meeting");
  const row = await env.WP_OS_DB.prepare("SELECT * FROM meeting_after_draft WHERE id = ?1").bind(draftId).first<MeetingAfterDraftRow>();
  if (!row) throw new MeetingAfterError(404, "not_found", "draft not found");
  const meeting = await requireMeeting(env, row.meeting_id);
  await mustAuthorize(env, actor, "meeting.after.approve", "meeting_after_draft", draftId, meeting.firm_scope);
  if (row.state !== "DRAFTED") throw new MeetingAfterError(409, "illegal_state", `draft is ${row.state}, not waiting for approval`);

  const stored = afterDraftSchema.safeParse(JSON.parse(row.draft_json));
  if (!stored.success && !override) throw new MeetingAfterError(409, "unreadable_draft", "the stored draft does not parse; draft again");
  const draft = override ? afterDraftSchema.parse(override) : stored.data!;

  const before = await readMeetingAfter(env, meeting.id);
  const seenDecisions = new Set(before.decisions.map((d) => d.decision_text.trim().toLowerCase()));
  const seenCommitments = new Set(before.commitments.map((c) => c.commitment_text.trim().toLowerCase()));
  const seenQuestions = new Set(before.open_questions.map((q) => q.question.trim().toLowerCase()));
  const written = { decisions: 0, commitments: 0, open_questions: 0, stage_proposal: false, skipped: 0 };
  const { actorId } = eventActor(actor);

  for (const d of draft.decisions) {
    const key = d.decision_text.trim().toLowerCase();
    if (seenDecisions.has(key)) { written.skipped += 1; continue; }
    seenDecisions.add(key);
    await recordDecision(env, actor, meeting.id, { ...d, ai_run_id: row.ai_run_id, after_draft_id: row.id });
    written.decisions += 1;
  }

  const roster = await activeRoster(env, meeting.firm_scope);
  const fallback = roster.find((r) => r.name === row.drafted_by) ?? roster.find((r) => /chief of staff/i.test(r.role)) ?? roster[0] ?? null;
  for (const c of draft.commitments) {
    const key = c.commitment_text.trim().toLowerCase();
    if (seenCommitments.has(key)) { written.skipped += 1; continue; }
    seenCommitments.add(key);
    await mustAuthorize(env, actor, "meeting.commitment.create", "meeting_commitment", meeting.id, meeting.firm_scope);
    const decided = resolveAssignment(
      { commitment_text: c.commitment_text, owner_side: c.owner_side, due_date: c.due_date, source_quote: c.source_quote, suggested_employee_name: c.suggested_employee_name },
      roster,
      fallback,
    );
    const id = `mcm_${crypto.randomUUID()}`;
    await env.WP_OS_DB.prepare(
      `INSERT INTO meeting_commitment
         (id, meeting_id, commitment_text, owner_side, owner_id, owed_by, due_date, firm_scope, created_by,
          origin, assignee_kind, ai_employee_id, human_touch_reason, source_quote, extraction_ai_run_id, after_draft_id)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, 'EXTRACTED', ?9, ?10, ?11, ?12, ?13, ?14)`,
    )
      .bind(
        id, meeting.id, decided.commitment_text, decided.owner_side,
        c.owed_by?.trim() || (decided.ai_employee_id ? roster.find((r) => r.id === decided.ai_employee_id)?.name ?? null : null),
        decided.due_date, meeting.firm_scope, actorId,
        decided.assignee_kind, decided.ai_employee_id, decided.human_touch_reason, decided.source_quote, row.ai_run_id, row.id,
      )
      .run();
    await appendEvent(env, {
      eventType: "meeting.commitment_created",
      actorType: "firm_user",
      actorId,
      objectType: "meeting_commitment",
      objectId: id,
      firmScope: meeting.firm_scope,
      payload: { meeting_id: meeting.id, owner_side: decided.owner_side, after_draft_id: row.id },
    });
    written.commitments += 1;
  }

  for (const q of draft.open_questions) {
    const key = q.question.trim().toLowerCase();
    if (seenQuestions.has(key)) { written.skipped += 1; continue; }
    seenQuestions.add(key);
    await recordOpenQuestion(env, actor, meeting.id, { ...q, ai_run_id: row.ai_run_id, after_draft_id: row.id });
    written.open_questions += 1;
  }

  if (draft.stage_proposal) {
    const alreadyPending = before.stage_proposals.some((p) => p.state === "PROPOSED");
    if (alreadyPending) {
      written.skipped += 1;
    } else {
      await proposeStageChange(env, actor, meeting.id, { ...draft.stage_proposal, ai_run_id: row.ai_run_id, after_draft_id: row.id });
      written.stage_proposal = true;
    }
  }

  await env.WP_OS_DB.prepare(
    `UPDATE meeting_after_draft SET state = 'APPROVED', approved_by = ?2, approved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), draft_json = ?3 WHERE id = ?1`,
  )
    .bind(draftId, actorId, JSON.stringify(draft))
    .run();
  await appendEvent(env, {
    eventType: "meeting.after_approved",
    actorType: "firm_user",
    actorId,
    objectType: "meeting_after_draft",
    objectId: draftId,
    firmScope: meeting.firm_scope,
    payload: { meeting_id: meeting.id, ...written },
  });

  const draftRow = (await env.WP_OS_DB.prepare("SELECT * FROM meeting_after_draft WHERE id = ?1").bind(draftId).first<MeetingAfterDraftRow>())!;
  return { draft: draftRow, written, after: await readMeetingAfter(env, meeting.id) };
}

/** A partner sets a draft aside without recording any of it. The row stays, saying so. */
export async function discardMeetingAfter(env: Env, actor: Actor, draftId: string, reason?: string): Promise<MeetingAfterDraftRow> {
  requireHuman(actor, "Setting a draft aside");
  const row = await env.WP_OS_DB.prepare("SELECT * FROM meeting_after_draft WHERE id = ?1").bind(draftId).first<MeetingAfterDraftRow>();
  if (!row) throw new MeetingAfterError(404, "not_found", "draft not found");
  const meeting = await requireMeeting(env, row.meeting_id);
  await mustAuthorize(env, actor, "meeting.after.approve", "meeting_after_draft", draftId, meeting.firm_scope);
  if (row.state !== "DRAFTED") throw new MeetingAfterError(409, "illegal_state", `draft is ${row.state}`);
  await env.WP_OS_DB.prepare("UPDATE meeting_after_draft SET state = 'DISCARDED', detail = ?2 WHERE id = ?1")
    .bind(draftId, reason?.trim() || "Set aside by a partner without recording any of it.")
    .run();
  return (await env.WP_OS_DB.prepare("SELECT * FROM meeting_after_draft WHERE id = ?1").bind(draftId).first<MeetingAfterDraftRow>())!;
}

// ── The ask/offer ledger ───────────────────────────────────────────────────────────────────────

export interface LedgerRow {
  company_id: string | null;
  company_name: string | null;
  meeting_id: string;
  meeting_title: string;
  occurred_at: string | null;
  commitment_id: string;
  commitment_text: string;
  owner_side: "FIRM" | "COUNTERPARTY";
  owed_by: string | null;
  due_date: string | null;
  overdue: boolean;
}

/**
 * What we owe our portfolio companies and what they owe us, still open, grouped by company.
 *
 * PORTFOLIO meetings only, by design: a founder or LP conversation has its own place for what is
 * owed (the next brief). This is the view a partner opens before a portfolio review to see the
 * standing balance with each company.
 */
export async function askOfferLedger(env: Env, visibleClause: string, now: Date = new Date()): Promise<{ rows: LedgerRow[]; meetings_examined: number }> {
  const today = now.toISOString().slice(0, 10);
  const meetings = await env.WP_OS_DB.prepare(
    `SELECT COUNT(*) AS n FROM meeting m WHERE m.meeting_type = 'PORTFOLIO' AND m.archived_at IS NULL AND ${visibleClause}`,
  ).first<{ n: number }>();
  const res = await env.WP_OS_DB.prepare(
    `SELECT m.company_id, cc.canonical_name AS company_name, m.id AS meeting_id, m.title AS meeting_title, m.occurred_at,
            c.id AS commitment_id, c.commitment_text, c.owner_side, c.owed_by, c.due_date
       FROM meeting_commitment c
       JOIN meeting m ON m.id = c.meeting_id
       LEFT JOIN canonical_company cc ON cc.id = m.company_id
      WHERE m.meeting_type = 'PORTFOLIO' AND m.archived_at IS NULL AND ${visibleClause}
        AND c.status = 'OPEN' AND c.honoured_at IS NULL
      ORDER BY cc.canonical_name, c.owner_side, c.due_date, c.created_at
      LIMIT 500`,
  ).all<Omit<LedgerRow, "overdue">>();
  return {
    rows: (res.results ?? []).map((r) => ({ ...r, overdue: r.due_date !== null && r.due_date.slice(0, 10) < today })),
    meetings_examined: Number(meetings?.n ?? 0),
  };
}

// ── HTTP ───────────────────────────────────────────────────────────────────────────────────────

function errorResponse(err: unknown): Response {
  if (err instanceof MeetingAfterError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function visibleMeeting(ctx: RouteContext, meetingId: string): Promise<MeetingRow | Response> {
  const meeting = await ctx.env.WP_OS_DB.prepare("SELECT id, title, meeting_type, status, company_id, lp_record_id, privacy_label, firm_scope, ai_access_state FROM meeting WHERE id = ?1")
    .bind(meetingId)
    .first<MeetingRow>();
  if (!meeting || !canAccessPrivacyLabel(ctx.identity!, meeting.privacy_label)) return json({ error: "not_found" }, { status: 404 });
  return meeting;
}

/** GET /api/meetings/:id/after */
export async function handleGetMeetingAfter(ctx: RouteContext): Promise<Response> {
  const m = await visibleMeeting(ctx, ctx.params.id!);
  if (m instanceof Response) return m;
  return json(await readMeetingAfter(ctx.env, m.id));
}

/** GET /api/meetings/:id/artifacts — the saved blocks, read-only. */
export async function handleListMeetingArtifacts(ctx: RouteContext): Promise<Response> {
  const m = await visibleMeeting(ctx, ctx.params.id!);
  if (m instanceof Response) return m;
  const res = await ctx.env.WP_OS_DB.prepare("SELECT * FROM meeting_artifact WHERE meeting_id = ?1 ORDER BY created_at, id")
    .bind(m.id)
    .all<MeetingArtifactRow>();
  return json({ artifacts: res.results ?? [] });
}

const decisionSchema = z.object({
  decision_text: z.string().trim().min(3),
  decided_by: z.string().trim().optional(),
  source_note_id: z.string().trim().min(1).optional(),
  source_quote: z.string().trim().optional(),
});

/** POST /api/meetings/:id/decisions */
export async function handleRecordDecision(ctx: RouteContext): Promise<Response> {
  const parsed = decisionSchema.safeParse(await body(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await recordDecision(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const openQuestionSchema = z.object({
  question: z.string().trim().min(8),
  owed_by_kind: z.enum(OWED_BY_KINDS).optional(),
  owed_by: z.string().trim().optional(),
  source_quote: z.string().trim().optional(),
});

/** POST /api/meetings/:id/open-questions */
export async function handleRecordOpenQuestion(ctx: RouteContext): Promise<Response> {
  const parsed = openQuestionSchema.safeParse(await body(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await recordOpenQuestion(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const resolveSchema = z.object({
  state: z.enum(["ANSWERED", "WITHDRAWN"]),
  answer: z.string().trim().optional(),
  withdrawn_reason: z.string().trim().optional(),
  resolved_in_meeting_id: z.string().trim().min(1).optional(),
});

/** POST /api/meeting-open-questions/:id/resolve */
export async function handleResolveOpenQuestion(ctx: RouteContext): Promise<Response> {
  const parsed = resolveSchema.safeParse(await body(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await resolveOpenQuestion(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data));
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/meeting-commitments/:id/honour */
export async function handleHonourCommitment(ctx: RouteContext): Promise<Response> {
  const b = (await body(ctx.request)) as { note?: unknown };
  try {
    return json(await honourCommitment(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, typeof b?.note === "string" ? b.note : undefined));
  } catch (err) {
    return errorResponse(err);
  }
}

const proposeSchema = z.object({
  opportunity_id: z.string().trim().min(1).optional(),
  to_status: z.enum(OPPORTUNITY_STATUSES),
  rationale: z.string().trim().min(8),
});

/** POST /api/meetings/:id/stage-proposals */
export async function handleProposeStageChange(ctx: RouteContext): Promise<Response> {
  const parsed = proposeSchema.safeParse(await body(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await proposeStageChange(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const decideSchema = z.object({ decision: z.enum(["ACCEPT", "DECLINE"]), note: z.string().trim().optional() });

/** POST /api/meeting-stage-proposals/:id/decide — the one click. */
export async function handleDecideStageProposal(ctx: RouteContext): Promise<Response> {
  const parsed = decideSchema.safeParse(await body(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await decideStageProposal(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data));
  } catch (err) {
    return errorResponse(err);
  }
}

const artifactSchema = z.object({
  kind: z.enum(["answer", "table", "chart", "packet", "summary"]),
  title: z.string().trim().min(1),
  body: z.unknown().optional(),
});

/** POST /api/meetings/:id/artifacts — Phase C's write path; a person may also save a block by hand. */
export async function handleSaveMeetingArtifact(ctx: RouteContext): Promise<Response> {
  const parsed = artifactSchema.safeParse(await body(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await saveMeetingArtifact(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, { ...parsed.data, body: parsed.data.body ?? {} }), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/meetings/:id/after-draft — run the drafter over the meeting's notes (or `text`). */
export async function handleDraftMeetingAfter(ctx: RouteContext): Promise<Response> {
  const b = (await body(ctx.request)) as { text?: unknown };
  try {
    const out = await draftMeetingAfter(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, typeof b?.text === "string" ? { text: b.text } : {});
    return json(out, { status: out.reused ? 200 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/meeting-after-drafts/:id/approve — body may carry an edited `draft`. */
export async function handleApproveMeetingAfter(ctx: RouteContext): Promise<Response> {
  const b = (await body(ctx.request)) as { draft?: unknown };
  let override: AfterDraft | undefined;
  if (b?.draft !== undefined) {
    const parsed = afterDraftSchema.safeParse(b.draft);
    if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
    override = parsed.data;
  }
  try {
    return json(await approveMeetingAfter(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, override));
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/meeting-after-drafts/:id/discard */
export async function handleDiscardMeetingAfter(ctx: RouteContext): Promise<Response> {
  const b = (await body(ctx.request)) as { reason?: unknown };
  try {
    return json(await discardMeetingAfter(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, typeof b?.reason === "string" ? b.reason : undefined));
  } catch (err) {
    return errorResponse(err);
  }
}

/** GET /api/meeting-ledger/ask-offer */
export async function handleAskOfferLedger(ctx: RouteContext): Promise<Response> {
  return json(await askOfferLedger(ctx.env, privacyVisibilityClause(ctx.identity!, "m.privacy_label")));
}
