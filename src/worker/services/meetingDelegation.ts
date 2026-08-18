import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { runAi } from "../ai/runAi";
import { json } from "../router";
import type { RouteContext } from "../router";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { notifyQuietly } from "./notifications";
import { personaPrompt } from "../../shared/registry/aiEmployeePersonas";
import {
  assignmentLabel,
  isAssigned,
  resolveAssignment,
  type AssigneeKind,
  type ProposedCommitment,
  type ResolvedCommitment,
  type RosterEntry,
} from "../../shared/meetings/delegationPolicy";

/**
 * Meeting close-out — the step that turns a finished meeting into assigned work (P33).
 *
 * V1 #29 requires Walter to "prepare, assist live, debrief, ROUTE FOLLOW-UPS, and create approval
 * outputs". Everything but the routing existed. Prep packets, live help, notes and debriefs all
 * worked, and then the meeting ended and the deliverables stayed as prose somebody had to re-read.
 *
 * Three steps, in order, each of which can fail without destroying the one before it:
 *
 *   1. EXTRACT   Walter reads the notes and proposes deliverables, each quoting the line it came
 *                from. Proposals only — nothing is assigned by the model.
 *   2. ASSIGN    delegationPolicy decides who holds each one. AI employees by default; human work
 *                is recommended, never assigned. This is code, not prompt text, so the policy holds
 *                even on a run where the model ignores its instructions.
 *   3. REPORT    A stored digest saying what was gathered, who has what, and what is unresolved,
 *                delivered in-app and by push.
 *
 * NOTHING LEAVES THE BUILDING. There is no send here and no recipient address anywhere in the
 * table. Canon §3.3 ends with "no external follow-up is sent without human approval", and the
 * operator's direction on 17 Aug 2026 was explicitly "for now everything can be push notification
 * only and internal". Outbound email exists as a governed effect (effects/executor.ts) that this
 * module deliberately does not call.
 */

export class DelegationError extends Error {
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
  privacy_label: string;
  firm_scope: string;
  ai_access_state: string;
}

interface CommitmentRow {
  id: string;
  meeting_id: string;
  commitment_text: string;
  owner_side: string;
  due_date: string | null;
  status: string;
  work_card_id: string | null;
  origin: string;
  assignee_kind: AssigneeKind;
  ai_employee_id: string | null;
  human_touch_reason: string | null;
  source_quote: string | null;
  created_at: string;
}

export interface CloseoutRow {
  id: string;
  meeting_id: string;
  digest_md: string;
  commitment_count: number;
  assigned_count: number;
  recommended_count: number;
  unresolved_count: number;
  state: string;
  detail: string | null;
  ai_run_id: string | null;
  created_at: string;
}

async function requireMeeting(env: Env, meetingId: string): Promise<MeetingRow> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT id, title, meeting_type, status, privacy_label, firm_scope, ai_access_state FROM meeting WHERE id = ?1",
  )
    .bind(meetingId)
    .first<MeetingRow>();
  if (!row) throw new DelegationError(404, "not_found", "meeting not found");
  return row;
}

async function mustAuthorize(env: Env, actor: Actor, actionKey: string, meeting: MeetingRow): Promise<void> {
  const authz = await authorize(env, actor, actionKey, {
    objectType: "meeting",
    objectId: meeting.id,
    firmScope: meeting.firm_scope,
  });
  if (authz.decision !== "ALLOW") throw new DelegationError(403, "forbidden", authz.reason);
}

/** ACTIVE employees only — a paused employee must not be handed work. */
async function activeRoster(env: Env, firmScope: string): Promise<RosterEntry[]> {
  const res = await env.WP_OS_DB.prepare(
    "SELECT id, name, role, status FROM ai_employee WHERE status = 'ACTIVE' AND firm_scope = ?1 ORDER BY name",
  )
    .bind(firmScope)
    .all<RosterEntry>();
  return res.results ?? [];
}

/**
 * Who takes a deliverable nobody was named for.
 *
 * Preference order is deliberate: an employee already seated in this meeting heard the discussion,
 * so they are the least surprising owner. Failing that, a chief of staff — sequencing a partner's
 * follow-through is literally the job. Failing that, anyone active.
 */
async function fallbackOwner(env: Env, meetingId: string, roster: readonly RosterEntry[]): Promise<RosterEntry | null> {
  if (roster.length === 0) return null;
  const seated = await env.WP_OS_DB.prepare("SELECT ai_employee_id FROM meeting_employee WHERE meeting_id = ?1")
    .bind(meetingId)
    .all<{ ai_employee_id: string }>()
    .catch(() => ({ results: [] as Array<{ ai_employee_id: string }> }));
  const seatedIds = new Set((seated.results ?? []).map((s) => s.ai_employee_id));
  return (
    roster.find((r) => seatedIds.has(r.id)) ??
    roster.find((r) => /chief of staff/i.test(r.role)) ??
    roster.find((r) => /assistant/i.test(r.role)) ??
    roster[0] ??
    null
  );
}

const proposalSchema = z.object({
  commitments: z
    .array(
      z.object({
        commitment_text: z.string().min(3).max(400),
        owner_side: z.enum(["FIRM", "COUNTERPARTY"]),
        due_date: z.string().max(40).nullish(),
        source_quote: z.string().max(400).nullish(),
        suggested_employee_name: z.string().max(60).nullish(),
        human_touch_reason: z.string().max(300).nullish(),
      }),
    )
    .max(30),
});

/**
 * Pull the model's JSON out of whatever it wrapped it in. Models fence JSON in ```json blocks
 * often enough that failing the whole close-out over a code fence would be a silly way to lose a
 * meeting's follow-ups.
 */
export function parseProposals(raw: string): ProposedCommitment[] | null {
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
  const checked = proposalSchema.safeParse(parsed);
  if (!checked.success) return null;
  return checked.data.commitments as ProposedCommitment[];
}

function extractionPrompt(meeting: MeetingRow, notes: string, participants: string): string {
  return [
    personaPrompt("Walter", "Meeting Buddy"),
    "",
    "The meeting has ended. Read the notes and list the DELIVERABLES that came out of it.",
    "",
    `MEETING: ${meeting.title} (${meeting.meeting_type})`,
    `PARTICIPANTS: ${participants || "not recorded"}`,
    "",
    "NOTES:",
    notes,
    "",
    "Return ONLY a JSON object of this shape, with no commentary:",
    '{"commitments":[{"commitment_text":"...","owner_side":"FIRM|COUNTERPARTY","due_date":"YYYY-MM-DD or null","source_quote":"the words this came from","suggested_employee_name":"a first name or null","human_touch_reason":"why a person should be involved, or null"}]}',
    "",
    "RULES:",
    "- Only what was actually committed to. Do not invent follow-ups that would be sensible but were not said.",
    "- owner_side is FIRM if we owe it, COUNTERPARTY if they do.",
    "- source_quote must be words that appear in the notes. If you cannot quote it, do not list it.",
    "- due_date only if a date or deadline was actually stated. Otherwise null.",
    "- If the notes contain no commitments, return an empty array. An empty list is a correct answer.",
    "- suggested_employee_name is a hint only; assignment is decided elsewhere.",
  ].join("\n");
}

export interface CloseoutResult {
  closeout: CloseoutRow;
  commitments: CommitmentRow[];
}

/**
 * Run the close-out. Extracts, assigns, writes the digest, notifies.
 *
 * Re-running is allowed and additive: it writes a NEW digest (the table is append-only) and skips
 * any deliverable whose text already exists on this meeting, so a second run after more notes were
 * added tops up rather than duplicating.
 */
export async function runCloseout(env: Env, actor: Actor, meetingId: string): Promise<CloseoutResult> {
  const meeting = await requireMeeting(env, meetingId);
  await mustAuthorize(env, actor, "meeting.commitment.create", meeting);

  // Canon §9.6.2E: a revoked room means "no AI employee can process follow-up from the room".
  // Extraction reads the notes, so it is one of the five prohibited actions and refuses here.
  if (meeting.ai_access_state === "REVOKED") {
    return await writeCloseout(env, actor, meeting, {
      digest: "AI access to this meeting is revoked, so nothing was read and nothing was assigned.",
      state: "REFUSED",
      detail: "ai access revoked",
      aiRunId: null,
      resolved: [],
    });
  }

  const notesRes = await env.WP_OS_DB.prepare(
    "SELECT body FROM meeting_note WHERE meeting_id = ?1 ORDER BY created_at, id LIMIT 200",
  )
    .bind(meetingId)
    .all<{ body: string }>();
  const notes = (notesRes.results ?? []).map((n) => `- ${n.body}`).join("\n").slice(0, 8000);

  const peopleRes = await env.WP_OS_DB.prepare(
    "SELECT display_name, participant_type FROM meeting_participant WHERE meeting_id = ?1 LIMIT 30",
  )
    .bind(meetingId)
    .all<{ display_name: string; participant_type: string }>()
    .catch(() => ({ results: [] as Array<{ display_name: string; participant_type: string }> }));
  const participants = (peopleRes.results ?? []).map((p) => `${p.display_name} [${p.participant_type}]`).join(", ");

  // No notes means nothing to read. Say so plainly instead of asking a model to invent deliverables
  // from an empty page — which is exactly what it would do.
  if (!notes.trim()) {
    return await writeCloseout(env, actor, meeting, {
      digest: "No notes were captured in this meeting, so there is nothing to extract. Add notes and run close-out again.",
      state: "REFUSED",
      detail: "no meeting notes",
      aiRunId: null,
      resolved: [],
    });
  }

  const roster = await activeRoster(env, meeting.firm_scope);
  const fallback = await fallbackOwner(env, meetingId, roster);

  let proposals: ProposedCommitment[] | null = null;
  let aiRunId: string | null = null;
  try {
    const { run } = await runAi(env, {
      purpose: `meeting close-out extraction for ${meeting.id}`,
      actor,
      inputs: [extractionPrompt(meeting, notes, participants)],
      // The meeting's own label, never lowered — same rule as Live Help. A CONFIDENTIAL meeting
      // must be refused by provider policy rather than quietly downgraded to reach a cheaper lane.
      sensitivity: meeting.privacy_label as never,
      budgetContext: { expectedOutputTokens: 900 },
      routing: { category: "INTELLIGENCE" },
    });
    aiRunId = run.id;
    if (run.status === "COMPLETED" && run.output_text) proposals = parseProposals(run.output_text);
  } catch (err) {
    return await writeCloseout(env, actor, meeting, {
      digest: "Close-out could not run. The meeting and its notes are unchanged.",
      state: "FAILED",
      detail: err instanceof Error ? err.message : String(err),
      aiRunId: null,
      resolved: [],
    });
  }

  if (proposals === null) {
    return await writeCloseout(env, actor, meeting, {
      digest: "Walter could not read deliverables out of these notes. Nothing was assigned.",
      state: "FAILED",
      detail: "extraction returned no usable result",
      aiRunId,
      resolved: [],
    });
  }

  const existing = await env.WP_OS_DB.prepare(
    "SELECT commitment_text FROM meeting_commitment WHERE meeting_id = ?1",
  )
    .bind(meetingId)
    .all<{ commitment_text: string }>();
  const seen = new Set((existing.results ?? []).map((r) => r.commitment_text.trim().toLowerCase()));

  const resolved: Array<ResolvedCommitment & { id: string }> = [];
  for (const proposal of proposals) {
    const decided = resolveAssignment(proposal, roster, fallback);
    if (!decided.commitment_text || seen.has(decided.commitment_text.toLowerCase())) continue;
    seen.add(decided.commitment_text.toLowerCase());

    const id = `mcm_${crypto.randomUUID()}`;
    await env.WP_OS_DB.prepare(
      `INSERT INTO meeting_commitment
         (id, meeting_id, commitment_text, owner_side, owner_id, due_date, firm_scope, created_by,
          origin, assignee_kind, ai_employee_id, human_touch_reason, source_quote, extraction_ai_run_id)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, 'EXTRACTED', ?8, ?9, ?10, ?11, ?12)`,
    )
      .bind(
        id, meetingId, decided.commitment_text, decided.owner_side, decided.due_date,
        meeting.firm_scope, actor.firmUserId ?? "system",
        decided.assignee_kind, decided.ai_employee_id, decided.human_touch_reason,
        decided.source_quote, aiRunId,
      )
      .run();
    resolved.push({ ...decided, id });
  }

  return await writeCloseout(env, actor, meeting, {
    digest: buildDigest(meeting, resolved, roster),
    state: "READY",
    detail: null,
    aiRunId,
    resolved,
  });
}

/** The digest text. Written here rather than by the model: it is a report of what the system did. */
export function buildDigest(
  meeting: Pick<MeetingRow, "title">,
  resolved: readonly ResolvedCommitment[],
  roster: readonly RosterEntry[],
): string {
  if (resolved.length === 0) {
    return `No new deliverables came out of "${meeting.title}". Nothing was assigned.`;
  }
  const nameOf = (id: string | null) => roster.find((r) => r.id === id)?.name ?? "Unassigned";
  const lines: string[] = [];
  const firm = resolved.filter((c) => c.owner_side === "FIRM");
  const theirs = resolved.filter((c) => c.owner_side === "COUNTERPARTY");

  const assigned = firm.filter((c) => c.assignee_kind === "AI_EMPLOYEE");
  const withTouch = firm.filter((c) => c.assignee_kind === "AI_WITH_HUMAN_TOUCH");
  const recommended = firm.filter((c) => c.assignee_kind === "HUMAN_RECOMMENDED");
  const unassigned = firm.filter((c) => c.assignee_kind === "UNASSIGNED");

  lines.push(`**${meeting.title}** — ${firm.length} deliverable${firm.length === 1 ? "" : "s"} for us.`);

  if (assigned.length) {
    lines.push("", "**Assigned**");
    for (const c of assigned) lines.push(`- ${nameOf(c.ai_employee_id)} — ${c.commitment_text}${c.due_date ? ` _(by ${c.due_date})_` : ""}`);
  }
  if (withTouch.length) {
    lines.push("", "**Assigned, your input wanted**");
    for (const c of withTouch) lines.push(`- ${nameOf(c.ai_employee_id)} — ${c.commitment_text}${c.due_date ? ` _(by ${c.due_date})_` : ""}  \n  ${c.human_touch_reason ?? ""}`);
  }
  if (recommended.length) {
    lines.push("", "**Recommended for you** — not assigned to anyone");
    for (const c of recommended) lines.push(`- ${c.commitment_text}  \n  ${c.human_touch_reason ?? ""}`);
  }
  if (unassigned.length) {
    lines.push("", "**Needs an owner**");
    for (const c of unassigned) lines.push(`- ${c.commitment_text}`);
  }
  if (theirs.length) {
    lines.push("", "**They owe us** — tracked, not assigned");
    for (const c of theirs) lines.push(`- ${c.commitment_text}${c.due_date ? ` _(by ${c.due_date})_` : ""}`);
  }
  lines.push("", "_Nothing has been sent. Drafts and external follow-ups still need your approval._");
  return lines.join("\n");
}

async function writeCloseout(
  env: Env,
  actor: Actor,
  meeting: MeetingRow,
  input: {
    digest: string;
    state: "READY" | "FAILED" | "REFUSED";
    detail: string | null;
    aiRunId: string | null;
    resolved: readonly ResolvedCommitment[];
  },
): Promise<CloseoutResult> {
  const id = `mco_${crypto.randomUUID()}`;
  const firm = input.resolved.filter((c) => c.owner_side === "FIRM");
  const counts = {
    total: input.resolved.length,
    assigned: firm.filter((c) => isAssigned(c.assignee_kind)).length,
    recommended: firm.filter((c) => c.assignee_kind === "HUMAN_RECOMMENDED").length,
    unresolved: firm.filter((c) => c.assignee_kind === "UNASSIGNED").length,
  };

  await env.WP_OS_DB.prepare(
    `INSERT INTO meeting_closeout
       (id, meeting_id, digest_md, commitment_count, assigned_count, recommended_count,
        unresolved_count, state, detail, ai_run_id, firm_scope, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  )
    .bind(
      id, meeting.id, input.digest, counts.total, counts.assigned, counts.recommended,
      counts.unresolved, input.state, input.detail, input.aiRunId, meeting.firm_scope,
      actor.firmUserId ?? "system",
    )
    .run();

  await appendEvent(env, {
    eventType: "meeting.closeout_created",
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "meeting_closeout",
    objectId: id,
    firmScope: meeting.firm_scope,
    payload: { meeting_id: meeting.id, state: input.state, ...counts },
  });

  // In-app and push only. notifyQuietly so a notification-preference block or quiet hours can
  // never take down the close-out itself — the digest is already stored and readable.
  if (input.state === "READY" && actor.firmUserId) {
    await notifyQuietly(env, {
      firmUserId: actor.firmUserId,
      kind: "MEETING",
      severity: "INFO",
      // Keyed on the close-out, not the meeting: re-running after more notes is a genuinely new
      // fact and should notify again, whereas a duplicate write of the same close-out should not.
      dedupeKey: `meeting.closeout:${id}`,
      title: `Close-out: ${meeting.title}`,
      body:
        counts.total === 0
          ? "No deliverables were found in this meeting."
          : `${counts.assigned} assigned to your AI employees` +
            (counts.recommended ? `, ${counts.recommended} recommended for you` : "") +
            (counts.unresolved ? `, ${counts.unresolved} need an owner` : "") + ".",
      objectType: "meeting",
      objectId: meeting.id,
      firmScope: meeting.firm_scope,
    });
  }

  const closeout = (await env.WP_OS_DB.prepare("SELECT * FROM meeting_closeout WHERE id = ?1").bind(id).first<CloseoutRow>())!;
  const commitments = await env.WP_OS_DB.prepare(
    "SELECT * FROM meeting_commitment WHERE meeting_id = ?1 ORDER BY created_at, id",
  )
    .bind(meeting.id)
    .all<CommitmentRow>();
  return { closeout, commitments: commitments.results ?? [] };
}

// ── Route handlers ───────────────────────────────────────────────────────────

function errorResponse(err: unknown): Response {
  if (err instanceof DelegationError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

/** POST /api/meetings/:id/closeout — run extraction and delegation. */
export async function handleRunCloseout(ctx: RouteContext): Promise<Response> {
  const meetingId = ctx.params.id;
  if (!meetingId) return json({ error: "invalid_input" }, { status: 400 });
  try {
    const result = await runCloseout(ctx.env, actorFromIdentity(ctx.identity!), meetingId);
    return json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

/** GET /api/meetings/:id/closeout — latest digest plus every deliverable. */
export async function handleGetCloseout(ctx: RouteContext): Promise<Response> {
  const meetingId = ctx.params.id;
  if (!meetingId) return json({ error: "invalid_input" }, { status: 400 });
  try {
    const meeting = await requireMeeting(ctx.env, meetingId);
    const closeout = await ctx.env.WP_OS_DB.prepare(
      "SELECT * FROM meeting_closeout WHERE meeting_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1",
    )
      .bind(meetingId)
      .first<CloseoutRow>();
    const commitments = await ctx.env.WP_OS_DB.prepare(
      "SELECT * FROM meeting_commitment WHERE meeting_id = ?1 ORDER BY created_at, id",
    )
      .bind(meetingId)
      .all<CommitmentRow>();
    const roster = await activeRoster(ctx.env, meeting.firm_scope);
    return json({
      closeout: closeout ?? null,
      commitments: (commitments.results ?? []).map((c) => ({
        ...c,
        assignee_label: assignmentLabel(c.assignee_kind),
        assignee_name: roster.find((r) => r.id === c.ai_employee_id)?.name ?? null,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
