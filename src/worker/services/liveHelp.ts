import type { Env } from "../env";
import { runAi } from "../ai/runAi";
import { authorize, type Actor } from "./authorize";
import { appendEvent } from "../events";
import { personaPrompt } from "../../shared/registry/aiEmployeePersonas";

/**
 * Live Help — the meeting workspace's chat with AI employees (canon §3, §28.5).
 *
 * "The Live Help tab is where Walter lives." The meeting record existed; the colleague did not.
 * This is that colleague: you seat one or more ACTIVE employees in a meeting and confer with them
 * while it happens, with the meeting's own prep, notes and participants as their context.
 *
 * FOUR RULES, all inherited rather than invented:
 *
 *   SEATING IS NOT AUTHORISATION. Only an ACTIVE employee may be seated. Seating grants no new
 *   capability — the ≤5 activation cap and the approval receipt already decided who may work at
 *   all; this only decides who is in *this* room.
 *
 *   THE MEETING'S PRIVACY LABEL TRAVELS. A CONFIDENTIAL meeting is sent at CONFIDENTIAL, which the
 *   provider policy will refuse for the OpenRouter lane. That refusal is correct and is surfaced as
 *   a REFUSED turn — never downgraded to slip material past the egress rule.
 *
 *   A REFUSAL IS A TURN. Blocked answers are written into the transcript with their reason. A live
 *   meeting where the assistant silently stops answering is worse than one that says why.
 *
 *   NOTHING IS SENT. A drafted follow-up is a draft. Canon §3.2: "No external follow-up is sent
 *   without human approval." This module has no send path at all.
 */

/** The quick actions from canon §28.5. Shown as buttons; each is just a seeded question. */
export const LIVE_HELP_QUICK_ACTIONS = [
  { key: "ask_next", label: "What should I ask next?", prompt: "What should I ask next?" },
  { key: "summarize", label: "Summarise so far", prompt: "Summarise the meeting so far." },
  { key: "promised", label: "What did we promise?", prompt: "What have we committed to so far in this meeting?" },
  { key: "risk", label: "Any risk?", prompt: "What risks or sensitivities should I be aware of right now?" },
  { key: "draft_email", label: "Draft follow-up email", prompt: "Draft a follow-up email for this meeting. It is a DRAFT for review and will not be sent." },
  { key: "before_end", label: "Before we end…", prompt: "What should I not forget to cover before this meeting ends?" },
] as const;

export interface SeatedEmployee {
  ai_employee_id: string;
  name: string;
  role: string;
  status: string;
}

export interface ChatTurnRow {
  id: string;
  meeting_id: string;
  turn_no: number;
  role: string;
  ai_employee_id: string | null;
  body: string;
  ai_run_id: string | null;
  state: string;
  detail: string | null;
  author_id: string;
  created_at: string;
}

interface MeetingRow {
  id: string;
  title: string;
  meeting_type: string;
  status: string;
  privacy_label: string;
  company_id: string | null;
  firm_scope: string;
  ai_access_state: string;
  ai_access_changed_by: string | null;
  ai_access_changed_at: string | null;
  ai_access_note: string | null;
}

export class LiveHelpError extends Error {
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

async function getMeeting(env: Env, meetingId: string): Promise<MeetingRow> {
  const m = await env.WP_OS_DB.prepare("SELECT * FROM meeting WHERE id = ?1").bind(meetingId).first<MeetingRow>();
  if (!m) throw new LiveHelpError(404, "not_found", "meeting not found");
  return m;
}

/** Seat an ACTIVE employee. Refuses anyone who is not activated. */
export async function seatEmployee(
  env: Env,
  actor: Actor,
  meetingId: string,
  aiEmployeeId: string,
): Promise<SeatedEmployee> {
  const meeting = await getMeeting(env, meetingId);
  const emp = await env.WP_OS_DB.prepare("SELECT id, name, role, status FROM ai_employee WHERE id = ?1")
    .bind(aiEmployeeId)
    .first<{ id: string; name: string; role: string; status: string }>();
  if (!emp) throw new LiveHelpError(404, "not_found", "ai employee not found");
  // Canon §9.6.2E: while access is revoked, no AI employee can be seated. Enforced here rather
  // than by hiding the picker — a revocation the API does not honour is decoration.
  if (meeting.ai_access_state === "REVOKED") {
    throw new LiveHelpError(
      409, "ai_access_revoked",
      "AI access to this room was revoked. An authorised human has to restore it before anyone can be seated.",
    );
  }
  if (emp.status !== "ACTIVE") {
    throw new LiveHelpError(
      409,
      "employee_not_active",
      `${emp.name} is ${emp.status}. Only an ACTIVE employee may join a meeting — activate them on Team → Employees first (a Managing Partner approval receipt is required).`,
    );
  }
  await env.WP_OS_DB.prepare(
    `INSERT OR IGNORE INTO meeting_employee (id, meeting_id, ai_employee_id, seated_by, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(`mse_${crypto.randomUUID()}`, meetingId, aiEmployeeId, actor.firmUserId ?? "system", meeting.firm_scope)
    .run();
  // Re-seating someone previously released puts them back in the room.
  await env.WP_OS_DB.prepare(
    "UPDATE meeting_employee SET released_at = NULL WHERE meeting_id = ?1 AND ai_employee_id = ?2",
  )
    .bind(meetingId, aiEmployeeId)
    .run();
  return { ai_employee_id: emp.id, name: emp.name, role: emp.role, status: emp.status };
}

export async function releaseEmployee(env: Env, meetingId: string, aiEmployeeId: string): Promise<void> {
  await env.WP_OS_DB.prepare(
    "UPDATE meeting_employee SET released_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE meeting_id = ?1 AND ai_employee_id = ?2",
  )
    .bind(meetingId, aiEmployeeId)
    .run();
}

export async function seatedEmployees(env: Env, meetingId: string): Promise<SeatedEmployee[]> {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT e.id AS ai_employee_id, e.name, e.role, e.status
       FROM meeting_employee me JOIN ai_employee e ON e.id = me.ai_employee_id
      WHERE me.meeting_id = ?1 AND me.released_at IS NULL
      ORDER BY e.name`,
  )
    .bind(meetingId)
    .all<SeatedEmployee>();
  return rows.results ?? [];
}

export async function chatTurns(env: Env, meetingId: string): Promise<ChatTurnRow[]> {
  const rows = await env.WP_OS_DB.prepare(
    "SELECT * FROM meeting_chat_turn WHERE meeting_id = ?1 ORDER BY turn_no",
  )
    .bind(meetingId)
    .all<ChatTurnRow>();
  return rows.results ?? [];
}

async function nextTurnNo(env: Env, meetingId: string): Promise<number> {
  const r = await env.WP_OS_DB.prepare(
    "SELECT COALESCE(MAX(turn_no), 0) AS n FROM meeting_chat_turn WHERE meeting_id = ?1",
  )
    .bind(meetingId)
    .first<{ n: number }>();
  return (r?.n ?? 0) + 1;
}

async function insertTurn(
  env: Env,
  meeting: MeetingRow,
  turn: Omit<ChatTurnRow, "id" | "meeting_id" | "turn_no" | "created_at">,
): Promise<ChatTurnRow> {
  const id = `mct_${crypto.randomUUID()}`;
  const turnNo = await nextTurnNo(env, meeting.id);
  await env.WP_OS_DB.prepare(
    `INSERT INTO meeting_chat_turn
       (id, meeting_id, turn_no, role, ai_employee_id, body, ai_run_id, state, detail, author_id, firm_scope)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
  )
    .bind(
      id, meeting.id, turnNo, turn.role, turn.ai_employee_id, turn.body,
      turn.ai_run_id, turn.state, turn.detail, turn.author_id, meeting.firm_scope,
    )
    .run();
  return (await env.WP_OS_DB.prepare("SELECT * FROM meeting_chat_turn WHERE id = ?1").bind(id).first<ChatTurnRow>())!;
}

/** Build the employee's context: who they are, the meeting, its prep, notes and recent turns. */
async function buildContext(env: Env, meeting: MeetingRow, employee: SeatedEmployee): Promise<string> {
  // The prep packet stores structured JSON, not prose — there is no `body` column. Reading the
  // real fields matters: a silent .catch() on a wrong column name would drop the single most
  // useful piece of context and the assistant would look merely unhelpful rather than broken.
  const prep = await env.WP_OS_DB.prepare(
    `SELECT evidence_summary_json, open_questions_json, unresolved_contradictions_json
       FROM meeting_prep_packet WHERE meeting_id = ?1 ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(meeting.id)
    .first<{ evidence_summary_json: string; open_questions_json: string; unresolved_contradictions_json: string }>()
    .catch(() => null);

  const prepText = prep
    ? [
        `evidence: ${prep.evidence_summary_json}`,
        `open questions: ${prep.open_questions_json}`,
        `unresolved contradictions: ${prep.unresolved_contradictions_json}`,
      ].join("\n")
    : "";

  const notes = await env.WP_OS_DB.prepare(
    "SELECT body FROM meeting_note WHERE meeting_id = ?1 ORDER BY created_at DESC LIMIT 12",
  )
    .bind(meeting.id)
    .all<{ body: string }>()
    .catch(() => ({ results: [] as Array<{ body: string }> }));

  const people = await env.WP_OS_DB.prepare(
    "SELECT display_name, participant_type FROM meeting_participant WHERE meeting_id = ?1 LIMIT 20",
  )
    .bind(meeting.id)
    .all<{ display_name: string; participant_type: string }>()
    .catch(() => ({ results: [] as Array<{ display_name: string; participant_type: string }> }));

  const recent = (await chatTurns(env, meeting.id)).slice(-10);

  return [
    // P32: identity, expertise and voice from the persona registry. Before this every employee
    // shared one voice, so seating Walter and seating Willow produced the same answer — which made
    // a thirty-one-person roster decorative.
    personaPrompt(employee.name, employee.role),
    `You are sitting in a live meeting with a Managing Partner and answering quietly, in the moment.`,
    "",
    `MEETING: ${meeting.title} (${meeting.meeting_type}, ${meeting.status})`,
    people.results?.length ? `PARTICIPANTS: ${people.results.map((p) => `${p.display_name} [${p.participant_type}]`).join(", ")}` : "PARTICIPANTS: not recorded",
    prepText ? `PREP PACKET:\n${prepText.slice(0, 2500)}` : "PREP PACKET: none",
    notes.results?.length ? `NOTES SO FAR:\n${notes.results.map((n) => `- ${n.body}`).join("\n").slice(0, 2500)}` : "NOTES SO FAR: none",
    recent.length ? `CONVERSATION SO FAR:\n${recent.map((t) => `${t.role === "OPERATOR" ? "MP" : t.ai_employee_id ?? "AI"}: ${t.body}`).join("\n").slice(0, 2500)}` : "",
    "",
    "HOW TO ANSWER:",
    "- Be brief. This is a live meeting; long answers are useless.",
    "- Use only the context above. If you do not know, say so — do not guess a number, name or date.",
    "- If asked to draft an external message, produce a DRAFT clearly marked as such. You cannot send anything.",
    "- No preamble. Answer directly.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Ask the seated employees. Returns the operator turn plus one answer turn per employee. */
export async function askLiveHelp(
  env: Env,
  actor: Actor,
  meetingId: string,
  question: string,
  onlyEmployeeId?: string,
): Promise<{ turns: ChatTurnRow[] }> {
  const meeting = await getMeeting(env, meetingId);
  const seated = await seatedEmployees(env, meetingId);
  const targets = onlyEmployeeId ? seated.filter((s) => s.ai_employee_id === onlyEmployeeId) : seated;

  const operatorTurn = await insertTurn(env, meeting, {
    role: "OPERATOR",
    ai_employee_id: null,
    body: question,
    ai_run_id: null,
    state: "OK",
    detail: null,
    author_id: actor.firmUserId ?? "system",
  });

  if (meeting.ai_access_state === "REVOKED") {
    const refusal = await insertTurn(env, meeting, {
      role: "SYSTEM",
      ai_employee_id: null,
      body: "AI access to this room is revoked.",
      ai_run_id: null,
      state: "REFUSED",
      detail: "No AI employee can read this room's notes or answer in it until access is restored.",
      author_id: "system",
    });
    return { turns: [operatorTurn, refusal] };
  }

  if (targets.length === 0) {
    const refusal = await insertTurn(env, meeting, {
      role: "SYSTEM",
      ai_employee_id: null,
      body: "No AI employee is seated in this meeting.",
      ai_run_id: null,
      state: "REFUSED",
      detail: "Add an active employee to this meeting to use Live Help.",
      author_id: "system",
    });
    return { turns: [operatorTurn, refusal] };
  }

  const answers: ChatTurnRow[] = [];
  for (const emp of targets) {
    try {
      const { run } = await runAi(env, {
        purpose: `live help in meeting ${meeting.id} (${emp.name})`,
        actor,
        inputs: [`${await buildContext(env, meeting, emp)}\n\nMANAGING PARTNER ASKS: ${question}`],
        // The meeting's own label. Never lowered: a CONFIDENTIAL meeting must be refused by the
        // provider policy rather than quietly downgraded to reach a permitted lane.
        sensitivity: meeting.privacy_label as never,
        aiEmployeeId: emp.ai_employee_id,
        budgetContext: { expectedOutputTokens: 350 },
        routing: { category: "INTELLIGENCE" },
      });

      answers.push(
        await insertTurn(env, meeting, {
          role: "EMPLOYEE",
          ai_employee_id: emp.ai_employee_id,
          body: run.output_text?.trim() || "(no answer returned)",
          ai_run_id: run.id,
          state: run.status === "COMPLETED" && run.output_text ? "OK" : "FAILED",
          detail: run.status === "COMPLETED" ? null : run.failure_reason ?? `run ${run.status}`,
          author_id: emp.ai_employee_id,
        }),
      );
    } catch (err) {
      // A governed refusal (privacy, budget, capability) is recorded as a visible turn.
      answers.push(
        await insertTurn(env, meeting, {
          role: "EMPLOYEE",
          ai_employee_id: emp.ai_employee_id,
          body: `${emp.name} could not answer.`,
          ai_run_id: null,
          state: "REFUSED",
          detail: err instanceof Error ? err.message : String(err),
          author_id: emp.ai_employee_id,
        }),
      );
    }
  }
  return { turns: [operatorTurn, ...answers] };
}

/**
 * Revoke every AI employee's access to a room (canon §9.6.2E).
 *
 * The affected list is captured BEFORE the seats are cleared. That ordering is the whole audit
 * requirement: §9.6.2E demands a record of "which AI employees were affected", and once the seats
 * are deleted there is nothing left to name.
 */
export async function revokeAllAiAccess(
  env: Env,
  actor: Actor,
  meetingId: string,
  note?: string,
): Promise<{ revoked: string[]; state: string }> {
  const meeting = await getMeeting(env, meetingId);
  const authz = await authorize(env, actor, "meeting.update", {
    objectType: "meeting", objectId: meetingId, firmScope: meeting.firm_scope,
  });
  if (authz.decision !== "ALLOW") throw new LiveHelpError(403, "forbidden", authz.reason);

  const seated = await seatedEmployees(env, meetingId);
  const affected = seated.map((s) => ({ id: s.ai_employee_id, name: s.name }));

  await env.WP_OS_DB.prepare("DELETE FROM meeting_employee WHERE meeting_id = ?1").bind(meetingId).run();
  await env.WP_OS_DB.prepare(
    `UPDATE meeting SET ai_access_state = 'REVOKED', ai_access_changed_by = ?2,
            ai_access_changed_at = ?3, ai_access_note = ?4 WHERE id = ?1`,
  )
    .bind(meetingId, actor.firmUserId ?? null, new Date().toISOString(), note ?? null)
    .run();

  await appendEvent(env, {
    eventType: "meeting.ai_access_revoked",
    actorType: actor.type === "HUMAN" ? "firm_user" : "system",
    actorId: actor.firmUserId ?? "system",
    objectType: "meeting",
    objectId: meetingId,
    firmScope: meeting.firm_scope,
    // Every field §9.6.2E requires: who, when (the event's own timestamp), which employees, and
    // what was removed.
    payload: {
      affected_employees: affected,
      access_removed: ["read_notes", "view_documents", "answer_in_room", "process_follow_up", "update_records"],
      note: note ?? null,
    },
  });

  return { revoked: affected.map((a) => a.id), state: "REVOKED" };
}

/** Restore AI access. Seats are NOT restored — re-granting is permission, not re-seating. */
export async function restoreAiAccess(env: Env, actor: Actor, meetingId: string): Promise<{ state: string }> {
  const meeting = await getMeeting(env, meetingId);
  const authz = await authorize(env, actor, "meeting.update", {
    objectType: "meeting", objectId: meetingId, firmScope: meeting.firm_scope,
  });
  if (authz.decision !== "ALLOW") throw new LiveHelpError(403, "forbidden", authz.reason);
  await env.WP_OS_DB.prepare(
    `UPDATE meeting SET ai_access_state = 'GRANTED', ai_access_changed_by = ?2, ai_access_changed_at = ?3 WHERE id = ?1`,
  )
    .bind(meetingId, actor.firmUserId ?? null, new Date().toISOString())
    .run();
  await appendEvent(env, {
    eventType: "meeting.ai_access_restored",
    actorType: actor.type === "HUMAN" ? "firm_user" : "system",
    actorId: actor.firmUserId ?? "system",
    objectType: "meeting",
    objectId: meetingId,
    firmScope: meeting.firm_scope,
    payload: {},
  });
  return { state: "GRANTED" };
}

// ── Route handlers ───────────────────────────────────────────────────────────

import { z } from "zod";
import { json } from "../router";
import type { RouteContext } from "../router";
import { actorFromIdentity } from "./authorize";

function fail(err: unknown): Response {
  if (err instanceof LiveHelpError) return json({ error: err.code, detail: err.message }, { status: err.status });
  return json({ error: "internal", detail: err instanceof Error ? err.message : String(err) }, { status: 500 });
}

const seatSchema = z.object({ ai_employee_id: z.string().trim().min(1) });
const askSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  ai_employee_id: z.string().trim().min(1).optional(),
});

/** GET — the workspace state: who is seated, the conversation, and the quick actions. */
export async function handleGetLiveHelp(ctx: RouteContext): Promise<Response> {
  try {
    const meetingId = ctx.params.id!;
    const meeting = await getMeeting(ctx.env, meetingId);
    return json({
      seated: await seatedEmployees(ctx.env, meetingId),
      turns: await chatTurns(ctx.env, meetingId),
      quick_actions: LIVE_HELP_QUICK_ACTIONS,
      // Access state travels with the room so the panel shows the true position rather than
      // inferring "nobody seated" from an empty list — revoked and simply-empty look identical
      // otherwise, and they mean very different things.
      ai_access_state: meeting.ai_access_state,
      ai_access_note: meeting.ai_access_note,
    });
  } catch (err) {
    return fail(err);
  }
}

export async function handleSeatEmployee(ctx: RouteContext): Promise<Response> {
  const parsed = seatSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const seated = await seatEmployee(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.ai_employee_id);
    return json(seated, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

export async function handleReleaseEmployee(ctx: RouteContext): Promise<Response> {
  const parsed = seatSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    await releaseEmployee(ctx.env, ctx.params.id!, parsed.data.ai_employee_id);
    return json({ released: true });
  } catch (err) {
    return fail(err);
  }
}

export async function handleAskLiveHelp(ctx: RouteContext): Promise<Response> {
  const parsed = askSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const out = await askLiveHelp(
      ctx.env,
      actorFromIdentity(ctx.identity!),
      ctx.params.id!,
      parsed.data.question,
      parsed.data.ai_employee_id,
    );
    return json(out, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

/** POST /api/meetings/:id/ai-access/revoke — canon §9.6.2E Revoke All. */
export async function handleRevokeAiAccess(ctx: RouteContext): Promise<Response> {
  const body = (await ctx.request.json().catch(() => ({}))) as { note?: string };
  try {
    return json(await revokeAllAiAccess(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, body?.note));
  } catch (err) {
    return fail(err);
  }
}

/** POST /api/meetings/:id/ai-access/restore — re-grant. Does not re-seat anyone. */
export async function handleRestoreAiAccess(ctx: RouteContext): Promise<Response> {
  try {
    return json(await restoreAiAccess(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!));
  } catch (err) {
    return fail(err);
  }
}
