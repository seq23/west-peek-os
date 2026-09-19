import { z } from "zod";
import type { Env } from "../env";
import type { FirmUserIdentity } from "../auth";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { runAi } from "../ai/runAi";
import { actorFromIdentity, authorize, canAccessPrivacyLabel, privacyVisibilityClause, type Actor } from "./authorize";
import { draftMeetingAfter, draftInputFor, saveMeetingArtifact, type MeetingAfterDraftRow, type MeetingArtifactRow } from "./meetingAfter";
import { latestBrief } from "./meetingBrief";
import { captureReadiness, transcribeWithSpeakers, CaptureRefused } from "./liveTranscription";
import { seatEmployee, seatedEmployees, type SeatedEmployee } from "./liveHelp";
import { createWorkCardInternal } from "./workCards";
import { TranscriptionUnavailable } from "../ai/providers/workersAiWhisper";
import { pageHost } from "../../shared/help/pageHosts";
import { personaPrompt } from "../../shared/registry/aiEmployeePersonas";
import { AI_EMPLOYEE_ROSTER } from "../../shared/registry/aiEmployees";
import { citationsFor, compileRecordQuery, describeAllowlist, RecordQueryRefused, recordQueryPlanSchema, CHART_TYPES } from "../../shared/meetings/roomQuery";

/**
 * THE DURING FACE — the meeting is a live room (Phase C, owner-approved 18 Sep 2026).
 *
 * Phase B made a meeting one object with three faces and built BEFORE and AFTER. This is the
 * room while it is happening: one status line and one button for recording (the consent prompt
 * still asked every session — `liveTranscription.ts`); the After draft written WHILE they talk
 * (`rollSummary`, which is Phase B's `draftMeetingAfter` on the transcript so far — idempotent over
 * the fingerprint, so a poll every five minutes costs one run per CHANGE); a question asked by text
 * or by push-to-talk voice (`askRoom`); a table or chart built on the spot from the firm's record
 * (`roomQuery.ts` — a plan against an allowlist, never SQL from a model); and an employee pulled in
 * for a task whose result returns to the room as a block (`pullInEmployee`, `returnCardToRoom`).
 *
 * NOTHING WRITES FROM VOICE. Read this before adding anything. A question — typed or spoken —
 * may produce exactly three kinds of write:
 *
 *   (a) a BLOCK on the meeting        `saveMeetingArtifact`   (Phase B; under meeting.note.add)
 *   (b) a WORK CARD, preview-first     `createWorkCardInternal` (the ordinary door; card.prompt is
 *                                     what instruction.ts's `steerFor` reads before a stage runs)
 *   (c) the After DRAFT                `draftMeetingAfter`      (Phase B; a proposal, not a record)
 *
 * No decision, commitment, open question, stage proposal, opportunity or company row is reachable
 * from here. A partner clicks Phase B's approve route to make any of it a record.
 * `scripts/validate/nothing-writes-from-voice.mjs` reads this file and fails the build if a
 * forbidden write appears in it.
 *
 * WHO ANSWERS. The host of the Meetings page (`pageHosts.ts` — Walter) unless the question opens
 * with an employee's name ("Wyatt, …"), in which case that employee answers in their own persona
 * through the same door, and is seated if they were not. The MEETING CONTEXT PACK they read is
 * scoped to THIS meeting's objects: the brief, the notes and transcript so far, the company or LP
 * record, prior meetings' After objects with the same counterparty, what has already been asked in
 * this room. Never the whole firm.
 *
 * LP MEETINGS ARE CONFIDENTIAL AT THE ROUTER. `budgetContext.confidential` is derived from the
 * meeting exactly as Phase B derives it, on every run_ai call in this file. The record-query path
 * sends no rows to any model at all.
 */

export class RoomError extends Error {
  constructor(public status: number, public code: string, detail?: string) {
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

async function requireMeeting(env: Env, meetingId: string): Promise<MeetingRow> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT id, title, meeting_type, status, company_id, lp_record_id, privacy_label, firm_scope, ai_access_state FROM meeting WHERE id = ?1",
  )
    .bind(meetingId)
    .first<MeetingRow>();
  if (!row) throw new RoomError(404, "not_found", "meeting not found");
  return row;
}

/** Phase B's rule, reused verbatim: an LP conversation names limited partners. */
export function isConfidentialMeeting(meeting: Pick<MeetingRow, "meeting_type" | "lp_record_id">): boolean {
  return meeting.meeting_type === "LP" || meeting.lp_record_id !== null;
}

// ── The rolling summary ────────────────────────────────────────────────────────────────────────

export const ROLL_EVERY_MS = 5 * 60_000;

/**
 * Write the After draft from the transcript so far.
 *
 * Phase B's drafter, unchanged: it fingerprints the on-record notes and returns the existing draft
 * when nothing new has been said, so the room can call this every five minutes (or on demand) and
 * pay for one run per change. The draft is shown live on the During face and is a DRAFT until a
 * partner approves it through Phase B's route — this function cannot approve anything.
 */
export async function rollSummary(env: Env, actor: Actor, meetingId: string): Promise<{ draft: MeetingAfterDraftRow; reused: boolean; notes_read: number }> {
  const input = await draftInputFor(env, meetingId);
  const out = await draftMeetingAfter(env, actor, meetingId);
  return { ...out, notes_read: input.notes };
}

// ── The room's state, for the During face ──────────────────────────────────────────────────────

export interface RoomTask {
  work_card_id: string;
  title: string;
  state: string;
  owner_name: string | null;
  /** working | done | needs you — what the chip says. */
  chip: "working" | "done" | "needs you";
  block_needed: string | null;
  created_at: string;
}

export interface RoomState {
  meeting: { id: string; title: string; meeting_type: string; status: string; ai_access_state: string; confidential: boolean };
  host: { name: string; role: string } | null;
  capture: Awaited<ReturnType<typeof captureReadiness>>;
  summary: MeetingAfterDraftRow | null;
  artifacts: MeetingArtifactRow[];
  seated: SeatedEmployee[];
  tasks: RoomTask[];
  roll_every_ms: number;
}

function chipFor(state: string): RoomTask["chip"] {
  if (state === "DONE") return "done";
  if (state === "BLOCKED") return "needs you";
  return "working";
}

export async function roomState(env: Env, identity: FirmUserIdentity, meetingId: string): Promise<RoomState> {
  const meeting = await requireMeeting(env, meetingId);
  if (!canAccessPrivacyLabel(identity, meeting.privacy_label)) throw new RoomError(404, "not_found", "meeting not found");
  const host = pageHost("meetings", identity.fullName);
  const [capture, summary, artifacts, seated, cards] = await Promise.all([
    captureReadiness(env, meetingId),
    env.WP_OS_DB.prepare(
      "SELECT * FROM meeting_after_draft WHERE meeting_id = ?1 AND state IN ('DRAFTED','APPROVED') ORDER BY created_at DESC LIMIT 1",
    ).bind(meetingId).first<MeetingAfterDraftRow>(),
    env.WP_OS_DB.prepare("SELECT * FROM meeting_artifact WHERE meeting_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 60").bind(meetingId).all<MeetingArtifactRow>(),
    seatedEmployees(env, meetingId),
    env.WP_OS_DB.prepare(
      `SELECT wc.id, wc.title, wc.state, wc.block_needed, wc.created_at, e.name AS owner_name
         FROM work_card wc LEFT JOIN ai_employee e ON e.id = wc.owner_id
        WHERE wc.meeting_id = ?1 ORDER BY wc.created_at DESC LIMIT 40`,
    ).bind(meetingId).all<{ id: string; title: string; state: string; block_needed: string | null; created_at: string; owner_name: string | null }>(),
  ]);
  return {
    meeting: { id: meeting.id, title: meeting.title, meeting_type: meeting.meeting_type, status: meeting.status, ai_access_state: meeting.ai_access_state, confidential: isConfidentialMeeting(meeting) },
    host: host ? { name: host.name, role: host.role } : null,
    capture,
    summary: summary ?? null,
    artifacts: artifacts.results ?? [],
    seated,
    tasks: (cards.results ?? []).map((c) => ({ work_card_id: c.id, title: c.title, state: c.state, owner_name: c.owner_name, chip: chipFor(c.state), block_needed: c.block_needed, created_at: c.created_at })),
    roll_every_ms: ROLL_EVERY_MS,
  };
}

// ── The meeting context pack ───────────────────────────────────────────────────────────────────

/**
 * Everything the answering employee may read, all of it THIS meeting's: the brief, the notes and
 * transcript so far, the company/opportunity or LP record, prior meetings' After objects with the
 * same counterparty, and what has been asked in this room already. Retrieval is by the meeting's
 * own foreign keys; nothing here fans out to the firm.
 */
export async function buildRoomContext(env: Env, meeting: MeetingRow): Promise<string> {
  const db = env.WP_OS_DB;
  const brief = await latestBrief(env, meeting.id);
  const notes = (await db.prepare(
    "SELECT body FROM meeting_note WHERE meeting_id = ?1 AND note_type IN ('MANUAL','TRANSCRIPT_DERIVED') ORDER BY created_at DESC, id DESC LIMIT 60",
  ).bind(meeting.id).all<{ body: string }>()).results ?? [];
  const people = (await db.prepare("SELECT display_name, participant_type FROM meeting_participant WHERE meeting_id = ?1 LIMIT 20").bind(meeting.id).all<{ display_name: string; participant_type: string }>()).results ?? [];

  let record = "";
  if (meeting.company_id) {
    const co = await db.prepare("SELECT canonical_name, sector, one_liner, status FROM canonical_company WHERE id = ?1").bind(meeting.company_id).first<{ canonical_name: string; sector: string | null; one_liner: string | null; status: string }>();
    const opp = await db.prepare("SELECT title, status, opportunity_type, recommendation FROM investment_opportunity WHERE company_id = ?1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1").bind(meeting.company_id).first<{ title: string; status: string; opportunity_type: string; recommendation: string | null }>();
    if (co) record += `COMPANY: ${co.canonical_name}${co.sector ? ` (${co.sector})` : ""}${co.one_liner ? ` — ${co.one_liner}` : ""}; status ${co.status}\n`;
    if (opp) record += `DEAL: "${opp.title}" ${opp.opportunity_type}, stage ${opp.status}${opp.recommendation ? `, recommendation ${opp.recommendation}` : ""}\n`;
  }
  if (meeting.lp_record_id) {
    const lp = await db.prepare("SELECT legal_name, lp_type, status, relationship_owner FROM lp_record WHERE id = ?1").bind(meeting.lp_record_id).first<{ legal_name: string; lp_type: string; status: string; relationship_owner: string | null }>();
    if (lp) record += `LIMITED PARTNER: ${lp.legal_name} (${lp.lp_type}), status ${lp.status}${lp.relationship_owner ? `, relationship owner ${lp.relationship_owner}` : ""}\n`;
  }

  // Prior meetings with the same counterparty: their After objects, most recent three meetings.
  let prior = "";
  if (meeting.company_id || meeting.lp_record_id) {
    const priorMeetings = (await db.prepare(
      `SELECT id, title, occurred_at, scheduled_at FROM meeting
        WHERE id <> ?1 AND archived_at IS NULL AND ((?2 IS NOT NULL AND company_id = ?2) OR (?3 IS NOT NULL AND lp_record_id = ?3))
        ORDER BY COALESCE(occurred_at, scheduled_at) DESC LIMIT 3`,
    ).bind(meeting.id, meeting.company_id, meeting.lp_record_id).all<{ id: string; title: string; occurred_at: string | null; scheduled_at: string | null }>()).results ?? [];
    for (const pm of priorMeetings) {
      const decisions = (await db.prepare("SELECT decision_text FROM meeting_decision WHERE meeting_id = ?1 ORDER BY recorded_at LIMIT 10").bind(pm.id).all<{ decision_text: string }>()).results ?? [];
      const commitments = (await db.prepare("SELECT commitment_text, owner_side, status, honoured_at FROM meeting_commitment WHERE meeting_id = ?1 ORDER BY created_at LIMIT 10").bind(pm.id).all<{ commitment_text: string; owner_side: string; status: string; honoured_at: string | null }>()).results ?? [];
      const questions = (await db.prepare("SELECT question, state FROM meeting_open_question WHERE meeting_id = ?1 ORDER BY created_at LIMIT 10").bind(pm.id).all<{ question: string; state: string }>()).results ?? [];
      prior += `\n${pm.title} (${(pm.occurred_at ?? pm.scheduled_at ?? "").slice(0, 10)}):\n`;
      prior += decisions.map((d) => `  decided: ${d.decision_text}`).join("\n");
      prior += commitments.map((c) => `\n  ${c.owner_side === "FIRM" ? "we owe" : "they owe"}: ${c.commitment_text} [${c.honoured_at ? "honoured" : c.status}]`).join("");
      prior += questions.map((q) => `\n  open question: ${q.question} [${q.state}]`).join("");
    }
  }

  const asked = (await db.prepare("SELECT asked_text, kind, title FROM meeting_artifact WHERE meeting_id = ?1 AND asked_text IS NOT NULL ORDER BY created_at DESC LIMIT 8").bind(meeting.id).all<{ asked_text: string; kind: string; title: string }>()).results ?? [];

  return [
    `MEETING: ${meeting.title} (${meeting.meeting_type}, ${meeting.status})`,
    people.length ? `PARTICIPANTS: ${people.map((p) => `${p.display_name} [${p.participant_type}]`).join(", ")}` : "PARTICIPANTS: not recorded",
    record ? `THE RECORD:\n${record.trim()}` : "THE RECORD: this meeting is linked to no company and no LP.",
    brief ? `THE BRIEF (written before the meeting):\n${brief.body_md.slice(0, 3000)}` : "THE BRIEF: none was written for this meeting.",
    notes.length ? `SAID SO FAR (newest first):\n${notes.map((n) => `- ${n.body}`).join("\n").slice(0, 5000)}` : "SAID SO FAR: nothing is on the record yet.",
    prior ? `PRIOR MEETINGS WITH THE SAME COUNTERPARTY:${prior.slice(0, 2500)}` : "",
    asked.length ? `ALREADY ASKED IN THIS ROOM:\n${asked.map((a) => `- ${a.asked_text} → ${a.kind}: ${a.title}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

// ── Asking the room ────────────────────────────────────────────────────────────────────────────

/** What the model may propose in reply to a question. Checked in code; every branch is read-only. */
export const roomReplySchema = z.object({
  mode: z.enum(["answer", "query", "task", "refuse"]),
  answer: z.string().trim().max(2000).nullish(),
  query: recordQueryPlanSchema.nullish(),
  task: z.object({ employee: z.string().trim().min(2).max(40), brief: z.string().trim().min(8).max(900) }).nullish(),
  reason: z.string().trim().max(400).nullish(),
});
export type RoomReply = z.infer<typeof roomReplySchema>;

export function parseRoomReply(raw: string): RoomReply | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const checked = roomReplySchema.safeParse(JSON.parse(candidate.slice(start, end + 1)));
    return checked.success ? checked.data : null;
  } catch {
    return null;
  }
}

/** "Wyatt, pull the comparables" → { name: "Wyatt", rest: "pull the comparables" }. */
export function addressee(question: string): { name: string | null; rest: string } {
  // Any case: a spoken "wyatt, …" arrives however the transcriber cased it.
  const m = question.match(/^\s*([A-Za-z]+)\s*[,:—-]\s*(.+)$/s);
  if (!m) return { name: null, rest: question.trim() };
  const onRoster = AI_EMPLOYEE_ROSTER.find((e) => e.name.toLowerCase() === m[1]!.toLowerCase());
  return onRoster ? { name: onRoster.name, rest: m[2]!.trim() } : { name: null, rest: question.trim() };
}

export function roomPrompt(args: { name: string; role: string; context: string; question: string; seated: string[]; hostName: string }): string {
  return [
    personaPrompt(args.name, args.role),
    "You are in a LIVE meeting with a Managing Partner. They asked the room something and you are answering quietly, now.",
    "",
    args.context,
    "",
    `EMPLOYEES IN THE ROOM: ${args.seated.length ? args.seated.join(", ") : "nobody else yet"}. The host is ${args.hostName}.`,
    "",
    "YOU CAN DO EXACTLY FOUR THINGS, and you say which as JSON:",
    '  {"mode":"answer","answer":"…"}  — answer from the context above. Cite the line or record you used. If it is not in the context, say so; never invent a number, a name or a date.',
    '  {"mode":"query","answer":"one line saying what the table shows","query":{…}}  — when they want a report, a table, a chart or a count from the firm\'s record. The query is a PLAN, not SQL:',
    '     {"table":"<one of the tables below>","select":["col",…],"where":[{"column":"col","op":"eq|neq|gt|gte|lt|lte|like|in|is_null|not_null","value":…}],"group_by":"col","metric":{"fn":"count|sum|avg|min|max","column":"col"},"order_by":{"column":"col","dir":"asc|desc"},"limit":25,"chart":"bar|line|pie"}',
    "     Use group_by + metric for a chart. Use chart only when they asked to see it drawn. Tables you may read (name: columns):",
    describeAllowlist(),
    '  {"mode":"task","task":{"employee":"Name","brief":"what to do, in one paragraph"}}  — when they are handing an employee a piece of WORK to go and do (research, pull comparables, draft something, check a cap table). Name the employee they addressed, or the one whose job it is.',
    '  {"mode":"refuse","reason":"…"}  — when the question needs a table not listed above, or would need you to change a record. You cannot record a decision, a commitment, a question, or move a deal: a partner does that after the meeting from the draft.',
    "",
    "Return ONLY the JSON object. Short. No preamble.",
    "",
    `THE PARTNER ASKED: ${args.question}`,
  ].join("\n");
}

/** Injectable so tests prove the room without a provider. Same seam shape as instruction.ts. */
export type RoomAnswerer = (env: Env, actor: Actor, args: { prompt: string; meeting: MeetingRow; employeeId: string | null }) => Promise<{ ok: boolean; text: string; aiRunId: string | null; detail: string }>;

const defaultAnswerer: RoomAnswerer = async (env, actor, { prompt, meeting, employeeId }) => {
  const { run } = await runAi(env, {
    purpose: `ask the room in meeting ${meeting.id}`,
    actor,
    aiEmployeeId: employeeId ?? undefined,
    inputs: [prompt],
    // The meeting's own label, never lowered — and the CONTENT rule at the router: an LP
    // conversation is confidential, exactly as Phase B derives it (isConfidentialMeeting).
    sensitivity: meeting.privacy_label as never,
    budgetContext: { judgement: true, expectedOutputTokens: 600, confidential: isConfidentialMeeting(meeting) },
    routing: { category: "INTELLIGENCE", taskClass: "ask_the_room" },
  });
  return { ok: run.status === "COMPLETED" && Boolean(run.output_text), text: run.output_text ?? "", aiRunId: run.id, detail: run.failure_reason ?? run.status };
};

export interface AskInput {
  question?: string;
  /** Push-to-talk: the audio the room heard while the button was held. */
  audio_base64?: string;
  content_type?: string;
}

export interface AskResult {
  /** The question, as heard or typed. */
  asked: string;
  via: "TEXT" | "VOICE";
  answered_by: string;
  artifact: MeetingArtifactRow;
  /** Set when the room opened a card. */
  work_card_id: string | null;
}

/**
 * Ask the room. Text or push-to-talk voice; the result is ALWAYS a saved block — an answer, a
 * table, a chart, a card's receipt, or a stated refusal/failure — never chat that evaporates.
 */
export async function askRoom(env: Env, identity: FirmUserIdentity, meetingId: string, input: AskInput, answer: RoomAnswerer = defaultAnswerer): Promise<AskResult> {
  const meeting = await requireMeeting(env, meetingId);
  if (!canAccessPrivacyLabel(identity, meeting.privacy_label)) throw new RoomError(404, "not_found", "meeting not found");
  const actor = actorFromIdentity(identity);
  const authz = await authorize(env, actor, "meeting.room.ask", { objectType: "meeting", objectId: meetingId, firmScope: meeting.firm_scope });
  if (authz.decision !== "ALLOW") throw new RoomError(403, "forbidden", authz.reason);
  if (meeting.ai_access_state === "REVOKED") {
    throw new RoomError(409, "ai_access_revoked", "AI access to this room is revoked. Nobody can answer here until a person restores it.");
  }

  // The words. Voice → text on the platform binding; the audio is never kept.
  let via: AskResult["via"] = "TEXT";
  let question = (input.question ?? "").trim();
  if (input.audio_base64) {
    via = "VOICE";
    try {
      const heard = await transcribeWithSpeakers(env, input.audio_base64, input.content_type);
      // A spoken question is one voice; the diariser's labels are noise here.
      question = heard.text.replace(/^Speaker (?:\d+|not identified): /gm, "").replace(/\s+/g, " ").trim();
    } catch (err) {
      if (err instanceof TranscriptionUnavailable) throw new RoomError(503, "transcription_unavailable", err.reason);
      throw err;
    }
    if (!question) throw new RoomError(400, "nothing_heard", "The room heard nothing while the button was held. Try again, closer to the microphone.");
  }
  if (question.length < 2) throw new RoomError(400, "invalid_input", "Ask something.");
  if (question.length > 1200) throw new RoomError(400, "invalid_input", "That is long enough to be a document. Ask the shorter version.");

  // Who answers: the addressed employee, else the page's host.
  const host = pageHost("meetings", identity.fullName);
  const hostName = host?.name ?? "Walter";
  const { name: addressed, rest } = addressee(question);
  const who = addressed ?? hostName;
  const emp = await env.WP_OS_DB.prepare("SELECT id, name, role, status FROM ai_employee WHERE name = ?1").bind(who).first<{ id: string; name: string; role: string; status: string }>();
  const seated = await seatedEmployees(env, meetingId);

  const save = (kind: MeetingArtifactRow["kind"], title: string, body: Record<string, unknown>, aiRunId: string | null, workCardId: string | null = null) =>
    saveRoomArtifact(env, actor, meetingId, { kind, title, body, ai_run_id: aiRunId, asked_text: question, asked_via: via, work_card_id: workCardId });

  if (!emp || emp.status !== "ACTIVE") {
    const why = emp ? `${emp.name} is ${emp.status.toLowerCase()}, so they cannot answer. Employ them on Employees and ask again.` : `Nobody called ${who} works here.`;
    const artifact = await save("answer", `${who} could not answer`, { state: "REFUSED", detail: why, answered_by: who }, null);
    return { asked: question, via, answered_by: who, artifact, work_card_id: null };
  }
  if (addressed && !seated.some((s) => s.ai_employee_id === emp.id)) {
    // Addressed by name → in the room. Seating grants no authority (liveHelp.ts).
    await seatEmployee(env, actor, meetingId, emp.id);
  }

  const context = await buildRoomContext(env, meeting);
  const prompt = roomPrompt({ name: emp.name, role: emp.role, context, question: addressed ? rest : question, seated: seated.map((s) => s.name), hostName });

  let out: Awaited<ReturnType<RoomAnswerer>>;
  try {
    out = await answer(env, actor, { prompt, meeting, employeeId: emp.id });
  } catch (err) {
    out = { ok: false, text: "", aiRunId: null, detail: err instanceof Error ? err.message : String(err) };
  }
  const reply = out.ok ? parseRoomReply(out.text) : null;

  if (!reply) {
    const detail = out.ok ? `${emp.name} replied, but not in a shape the room could read.` : `${emp.name} could not answer: ${out.detail}`.slice(0, 400);
    const artifact = await save("answer", `${emp.name} could not answer`, { state: "FAILED", detail, answered_by: emp.name }, out.aiRunId);
    return { asked: question, via, answered_by: emp.name, artifact, work_card_id: null };
  }

  if (reply.mode === "refuse") {
    const artifact = await save("answer", `${emp.name} declined`, { state: "REFUSED", detail: reply.reason ?? "Outside what the room may do.", answered_by: emp.name }, out.aiRunId);
    return { asked: question, via, answered_by: emp.name, artifact, work_card_id: null };
  }

  if (reply.mode === "query" && reply.query) {
    return { asked: question, via, answered_by: emp.name, artifact: await runRecordQuery(env, identity, actor, meeting, emp.name, reply, question, via, out.aiRunId), work_card_id: null };
  }

  if (reply.mode === "task" && reply.task) {
    const pulled = await pullInEmployee(env, identity, meeting, { employee: reply.task.employee, brief: reply.task.brief, asked: question, via, askedOf: emp.name });
    return { asked: question, via, answered_by: emp.name, artifact: pulled.artifact, work_card_id: pulled.work_card_id };
  }

  const text = (reply.answer ?? "").trim() || `${emp.name} had nothing to add.`;
  const artifact = await save("answer", text.slice(0, 80).replace(/\s+\S*$/, "") || `${emp.name} answered`, { state: "OK", text, answered_by: emp.name }, out.aiRunId);
  return { asked: question, via, answered_by: emp.name, artifact, work_card_id: null };
}

/**
 * The one writer for a room block. Wraps Phase B's `saveMeetingArtifact` (the artifact table's
 * writer) and stamps the 0204 provenance columns — the question, how it arrived, the card.
 */
export async function saveRoomArtifact(
  env: Env,
  actor: Actor,
  meetingId: string,
  input: { kind: MeetingArtifactRow["kind"]; title: string; body: Record<string, unknown>; ai_run_id: string | null; asked_text: string | null; asked_via: "TEXT" | "VOICE" | "SYSTEM"; work_card_id: string | null },
): Promise<MeetingArtifactRow> {
  const row = await saveMeetingArtifact(env, actor, meetingId, { kind: input.kind, title: input.title, body: input.body, ai_run_id: input.ai_run_id });
  await env.WP_OS_DB.prepare("UPDATE meeting_artifact SET asked_text = ?2, asked_via = ?3, work_card_id = ?4 WHERE id = ?1")
    .bind(row.id, input.asked_text, input.asked_via, input.work_card_id)
    .run();
  return (await env.WP_OS_DB.prepare("SELECT * FROM meeting_artifact WHERE id = ?1").bind(row.id).first<MeetingArtifactRow>())!;
}

// ── A table or chart, on the spot ──────────────────────────────────────────────────────────────

async function runRecordQuery(
  env: Env,
  identity: FirmUserIdentity,
  actor: Actor,
  meeting: MeetingRow,
  answeredBy: string,
  reply: RoomReply,
  question: string,
  via: "TEXT" | "VOICE",
  aiRunId: string | null,
): Promise<MeetingArtifactRow> {
  let compiled;
  try {
    compiled = compileRecordQuery(reply.query, { firmScope: meeting.firm_scope, visibility: privacyVisibilityClause(identity) });
  } catch (err) {
    const detail = err instanceof RecordQueryRefused ? err.message : String(err);
    return saveRoomArtifact(env, actor, meeting.id, { kind: "answer", title: "That is not something the room can read", body: { state: "REFUSED", detail, answered_by: answeredBy, plan: reply.query }, ai_run_id: aiRunId, asked_text: question, asked_via: via, work_card_id: null });
  }
  const res = await env.WP_OS_DB.prepare(compiled.sql).bind(...compiled.params).all<Record<string, unknown>>();
  const rows = res.results ?? [];
  const cites = citationsFor(compiled, rows);
  const chart = reply.query?.chart && CHART_TYPES.includes(reply.query.chart) && reply.query.group_by ? reply.query.chart : null;
  const title = (reply.answer ?? "").trim().slice(0, 90) || `${rows.length} rows from ${compiled.table}`;
  return saveRoomArtifact(env, actor, meeting.id, {
    kind: chart ? "chart" : "table",
    title,
    body: {
      state: "OK",
      answered_by: answeredBy,
      table: compiled.table,
      columns: compiled.columns,
      rows,
      row_cap: 50,
      cites,
      chart,
      // What was run — a partner can see exactly which question of the record produced this.
      sql: compiled.sql,
      confidential: compiled.confidential,
      note: rows.length === 0 ? "The record holds nothing matching that." : null,
    },
    ai_run_id: aiRunId,
    asked_text: question,
    asked_via: via,
    work_card_id: null,
  });
}

// ── Pulling an employee in for a task ──────────────────────────────────────────────────────────

/**
 * "Wyatt, pull the last three rounds' comparables." Seats the employee if they are not, opens a
 * work card with `meeting_id` through the ordinary door — PREVIEW-FIRST, with the partner's words
 * on `prompt` so `steerFor` in instruction.ts reads them before the first stage runs — and saves a
 * receipt block so the room shows the task the moment it exists. The card's result returns through
 * `returnCardToRoom`. The card is ordinary work: the existing chains, the existing approvals.
 */
export async function pullInEmployee(
  env: Env,
  identity: FirmUserIdentity,
  meeting: MeetingRow,
  input: { employee: string; brief: string; asked: string; via: "TEXT" | "VOICE"; askedOf: string },
): Promise<{ artifact: MeetingArtifactRow; work_card_id: string | null }> {
  const actor = actorFromIdentity(identity);
  const emp = await env.WP_OS_DB.prepare("SELECT id, name, status FROM ai_employee WHERE lower(name) = lower(?1)").bind(input.employee.trim()).first<{ id: string; name: string; status: string }>();
  if (!emp || emp.status !== "ACTIVE") {
    const detail = emp ? `${emp.name} is ${emp.status.toLowerCase()} and cannot be handed work. Employ them on Employees first.` : `Nobody called ${input.employee} works here, so the task was not opened.`;
    const artifact = await saveRoomArtifact(env, actor, meeting.id, { kind: "answer", title: "The task was not opened", body: { state: "REFUSED", detail, answered_by: input.askedOf }, ai_run_id: null, asked_text: input.asked, asked_via: input.via, work_card_id: null });
    return { artifact, work_card_id: null };
  }
  const seated = await seatedEmployees(env, meeting.id);
  if (!seated.some((s) => s.ai_employee_id === emp.id)) await seatEmployee(env, actor, meeting.id, emp.id);

  const card = await createWorkCardInternal(env, identity, {
    title: input.brief.split(/\r?\n/)[0]!.slice(0, 90),
    description: [`Asked in the room during "${meeting.title}" (${meeting.id}).`, "", "THE BRIEF:", input.brief].join("\n"),
    owner_type: "AI",
    owner_id: emp.id,
    priority: "NORMAL",
    privacy_label: meeting.privacy_label,
    firm_scope: meeting.firm_scope,
    next_action: input.brief.slice(0, 300),
    // Her words, verbatim, are what instruction.ts reads before any stage runs.
    prompt: input.asked,
    // Preview-first: the result comes back to her before it goes anywhere.
    preview_first: true,
    meeting_id: meeting.id,
  });
  await appendEvent(env, {
    eventType: "meeting.room_task_opened",
    actorType: "firm_user",
    actorId: identity.id,
    objectType: "work_card",
    objectId: card.id,
    firmScope: meeting.firm_scope,
    payload: { meeting_id: meeting.id, employee: emp.name, via: input.via },
  });
  const artifact = await saveRoomArtifact(env, actor, meeting.id, {
    kind: "packet",
    title: `${emp.name} is on it: ${card.title}`,
    body: { state: "WORKING", work_card_id: card.id, employee: emp.name, brief: input.brief, answered_by: input.askedOf },
    ai_run_id: null,
    asked_text: input.asked,
    asked_via: input.via,
    work_card_id: card.id,
  });
  return { artifact, work_card_id: card.id };
}

/**
 * THE RETURN ADDRESS. Called by employeeWork.ts when a card finishes: if the card was raised from
 * a meeting, its result becomes a block on that meeting. One block per card (0204's unique index):
 * the receipt saved when the task opened is UPDATED with the result rather than joined by a second
 * block, so the During face shows one card, one status, one result.
 */
export async function returnCardToRoom(env: Env, cardId: string, result: { employee: string; finding: string; deliverableId: string | null }): Promise<MeetingArtifactRow | null> {
  const card = await env.WP_OS_DB.prepare("SELECT id, title, meeting_id, firm_scope FROM work_card WHERE id = ?1").bind(cardId).first<{ id: string; title: string; meeting_id: string | null; firm_scope: string }>();
  if (!card?.meeting_id) return null;
  const existing = await env.WP_OS_DB.prepare("SELECT * FROM meeting_artifact WHERE work_card_id = ?1").bind(cardId).first<MeetingArtifactRow>();
  const body = { state: "DONE", work_card_id: cardId, employee: result.employee, finding: result.finding.slice(0, 12_000), deliverable_id: result.deliverableId };
  if (existing) {
    await env.WP_OS_DB.prepare("UPDATE meeting_artifact SET title = ?2, body_json = ?3 WHERE id = ?1")
      .bind(existing.id, `${result.employee} finished: ${card.title}`.slice(0, 120), JSON.stringify({ ...safeJson(existing.body_json), ...body }))
      .run();
    return (await env.WP_OS_DB.prepare("SELECT * FROM meeting_artifact WHERE id = ?1").bind(existing.id).first<MeetingArtifactRow>())!;
  }
  // A card raised from a meeting some other way (a converted commitment) returns too.
  const system: Actor = { type: "SYSTEM", roles: [], firmScopes: [card.firm_scope] };
  return saveRoomArtifact(env, system, card.meeting_id, { kind: "packet", title: `${result.employee} finished: ${card.title}`.slice(0, 120), body, ai_run_id: null, asked_text: null, asked_via: "SYSTEM", work_card_id: cardId });
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── Route handlers ─────────────────────────────────────────────────────────────────────────────

function fail(err: unknown): Response {
  if (err instanceof RoomError) return json({ error: err.code, detail: err.message }, { status: err.status });
  if (err instanceof CaptureRefused) return json({ error: err.code, detail: err.message }, { status: err.status });
  const e = err as { status?: number; code?: string; message?: string };
  if (typeof e?.status === "number") return json({ error: e.code ?? "refused", detail: e.message }, { status: e.status });
  throw err;
}

/** GET /api/meetings/:id/room — the During face in one read. */
export async function handleRoomState(ctx: RouteContext): Promise<Response> {
  try {
    return json(await roomState(ctx.env, ctx.identity!, ctx.params.id!));
  } catch (err) {
    return fail(err);
  }
}

/** POST /api/meetings/:id/room/roll — write the After draft from the transcript so far. */
export async function handleRoomRoll(ctx: RouteContext): Promise<Response> {
  try {
    const meeting = await requireMeeting(ctx.env, ctx.params.id!);
    if (!canAccessPrivacyLabel(ctx.identity!, meeting.privacy_label)) return json({ error: "not_found" }, { status: 404 });
    return json(await rollSummary(ctx.env, actorFromIdentity(ctx.identity!), meeting.id), { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

/** What the recorder may say it produced. An audio container, optionally with codecs — nothing else reaches the model. */
export const AUDIO_CONTENT_TYPE = /^audio\/[a-z0-9.+-]{1,40}(;\s*codecs=[a-z0-9.,+ -]{1,60})?$/i;

const askSchema = z.object({
  question: z.string().trim().max(1200).optional(),
  // ~6.7 MB of base64, the same cap as a recording chunk; base64 alphabet only, so a malformed
  // body is refused here with a 400 rather than inside the adapter with a 503.
  audio_base64: z.string().min(1).max(9_000_000).regex(/^[A-Za-z0-9+/=\s]+$/, "audio must be base64").optional(),
  content_type: z.string().trim().max(80).regex(AUDIO_CONTENT_TYPE, "content_type must be an audio type").optional(),
}).refine((v) => Boolean(v.question?.trim()) || Boolean(v.audio_base64), { message: "type a question or hold the button and speak" });

/** POST /api/meetings/:id/room/ask — text or push-to-talk. Always answers with a saved block. */
export async function handleRoomAsk(ctx: RouteContext): Promise<Response> {
  const parsed = askSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await askRoom(ctx.env, ctx.identity!, ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return fail(err);
  }
}
