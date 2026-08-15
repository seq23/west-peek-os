import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { notifyQuietly } from "./notifications";
import { actorFromIdentity, authorize, privacyVisibilityClause, type Actor } from "./authorize";
import { MAX_ACTIVE_AI_EMPLOYEES, type AIEmployeeRow } from "./aiEmployees";

/**
 * Employee Lounge / Digital Office / Performance Management (P15; GAP-01, GAP-10, GAP-11).
 *
 * This is the operating layer over the governed roster, not a replacement for it:
 *
 * - The roster, its statuses, the ≤5-ACTIVE cap (D10), and activation-by-receipt stay in
 *   `services/aiEmployees.ts`. Nothing here raises an employee to ACTIVE.
 * - Lowering authority (ACTIVE → PAUSED / RESTRICTED / RETIRED) is human-only and fails safe:
 *   it removes capability rather than granting it, so it does not need a capital-grade receipt,
 *   but it is still audited and appended to the same `ai_employee_status_history` spine.
 * - An AI employee can never change any lifecycle state, decide a handoff, or record a review —
 *   including its own. Those checks live here, at the service level.
 * - Scorecards are DETERMINISTIC counts over `ai_run` and `approval_card`, and every snapshot
 *   stores the definition it used. No subjective "value generated" number is stored as money.
 */

export class WorkforceError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof WorkforceError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function getEmployee(env: Env, id: string): Promise<AIEmployeeRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM ai_employee WHERE id = ?1").bind(id).first<AIEmployeeRow>();
}

function requireHuman(actor: Actor, what: string): void {
  if (actor.type !== "HUMAN" || !actor.firmUserId) {
    throw new WorkforceError(403, "forbidden", `${what} is human-reserved: an AI employee can never perform it`);
  }
}

// ── Lounge listing ──

export interface LoungeEmployee {
  id: string;
  name: string;
  role: string;
  department: string;
  avatar_initials: string;
  brief: string;
  manager_employee_id: string | null;
  manager_firm_user_id: string | null;
  status: string;
  primary_machines: string[];
  assigned_machine_ids: number[];
  tool_scopes: string[];
  current_work: Array<{ id: string; title: string; state: string; priority: string }>;
  recent_runs: Array<{ id: string; purpose: string; status: string; created_at: string; cost_usd: number }>;
  runs_30d: number;
  blocked_runs_30d: number;
  cost_30d_usd: number;
  latest_snapshot_id: string | null;
}

function costOfRun(row: { cost_estimate_json: string; actual_usage_json: string | null }): number {
  try {
    if (row.actual_usage_json) return (JSON.parse(row.actual_usage_json) as { cost_usd?: number }).cost_usd ?? 0;
    return (JSON.parse(row.cost_estimate_json) as { estimated_cost_usd?: number }).estimated_cost_usd ?? 0;
  } catch {
    return 0;
  }
}

export async function listLounge(env: Env): Promise<{ employees: LoungeEmployee[]; departments: string[]; active_count: number; max_active: number }> {
  const employees = (
    await env.WP_OS_DB.prepare(
      `SELECT e.*, p.department, p.avatar_initials, p.brief, p.manager_employee_id, p.manager_firm_user_id
         FROM ai_employee e
         LEFT JOIN ai_employee_profile p ON p.ai_employee_id = e.id
        ORDER BY p.department, e.rowid`,
    ).all<AIEmployeeRow & { department: string | null; avatar_initials: string | null; brief: string | null; manager_employee_id: string | null; manager_firm_user_id: string | null }>()
  ).results ?? [];

  const assignments = (await env.WP_OS_DB.prepare("SELECT ai_employee_id, machine_id FROM ai_employee_assignment WHERE active = 1").all<{ ai_employee_id: string; machine_id: number }>()).results ?? [];
  const scopes = (await env.WP_OS_DB.prepare("SELECT ai_employee_id, tool_key FROM ai_employee_tool_scope").all<{ ai_employee_id: string; tool_key: string }>()).results ?? [];
  const work = (
    await env.WP_OS_DB.prepare(
      "SELECT id, title, state, priority, owner_id FROM work_card WHERE owner_type = 'AI' AND state IN ('OPEN','IN_PROGRESS','BLOCKED') ORDER BY created_at DESC",
    ).all<{ id: string; title: string; state: string; priority: string; owner_id: string }>()
  ).results ?? [];
  const runs = (
    await env.WP_OS_DB.prepare(
      `SELECT id, ai_employee_id, purpose, status, created_at, cost_estimate_json, actual_usage_json
         FROM ai_run
        WHERE ai_employee_id IS NOT NULL AND created_at >= date('now', '-30 days')
        ORDER BY created_at DESC`,
    ).all<{ id: string; ai_employee_id: string; purpose: string; status: string; created_at: string; cost_estimate_json: string; actual_usage_json: string | null }>()
  ).results ?? [];
  const snapshots = (
    await env.WP_OS_DB.prepare(
      "SELECT ai_employee_id, id FROM employee_performance_snapshot ORDER BY computed_at DESC",
    ).all<{ ai_employee_id: string; id: string }>()
  ).results ?? [];

  const out: LoungeEmployee[] = employees.map((e) => {
    const myRuns = runs.filter((r) => r.ai_employee_id === e.id);
    let primaryMachines: string[] = [];
    try {
      primaryMachines = JSON.parse(e.primary_machines_json) as string[];
    } catch {
      primaryMachines = [];
    }
    return {
      id: e.id,
      name: e.name,
      role: e.role,
      department: e.department ?? e.layer,
      avatar_initials: e.avatar_initials ?? e.name.slice(0, 2).toUpperCase(),
      brief: e.brief ?? e.role,
      manager_employee_id: e.manager_employee_id,
      manager_firm_user_id: e.manager_firm_user_id,
      status: e.status,
      primary_machines: primaryMachines,
      assigned_machine_ids: assignments.filter((a) => a.ai_employee_id === e.id).map((a) => a.machine_id),
      tool_scopes: scopes.filter((s) => s.ai_employee_id === e.id).map((s) => s.tool_key),
      current_work: work.filter((w) => w.owner_id === e.id).map((w) => ({ id: w.id, title: w.title, state: w.state, priority: w.priority })),
      recent_runs: myRuns.slice(0, 5).map((r) => ({ id: r.id, purpose: r.purpose, status: r.status, created_at: r.created_at, cost_usd: costOfRun(r) })),
      runs_30d: myRuns.length,
      blocked_runs_30d: myRuns.filter((r) => r.status !== "COMPLETED").length,
      cost_30d_usd: Math.round(myRuns.reduce((sum, r) => sum + costOfRun(r), 0) * 10_000) / 10_000,
      latest_snapshot_id: snapshots.find((s) => s.ai_employee_id === e.id)?.id ?? null,
    };
  });

  const departments = [...new Set(out.map((e) => e.department))].sort();
  return {
    employees: out,
    departments,
    active_count: out.filter((e) => e.status === "ACTIVE").length,
    max_active: MAX_ACTIVE_AI_EMPLOYEES,
  };
}

export async function handleLounge(ctx: RouteContext): Promise<Response> {
  const lounge = await listLounge(ctx.env);
  return json({
    ...lounge,
    activation_law:
      `At most ${MAX_ACTIVE_AI_EMPLOYEES} employees may be ACTIVE at once (D10). Activation requires an approved ai_employee.activate receipt; nothing on this surface can bypass it.`,
  });
}

// ── Profile / assignment ──

const profileSchema = z.object({
  department: z.string().trim().min(1).optional(),
  manager_employee_id: z.string().trim().min(1).nullable().optional(),
  manager_firm_user_id: z.string().trim().min(1).nullable().optional(),
  avatar_initials: z.string().trim().min(1).max(3).optional(),
  brief: z.string().trim().optional(),
});

export async function handleUpdateProfile(ctx: RouteContext): Promise<Response> {
  const parsed = profileSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  try {
    requireHuman(actor, "changing an employee profile");
  } catch (err) {
    return errorResponse(err);
  }
  const employee = await getEmployee(ctx.env, ctx.params.id!);
  if (!employee) return json({ error: "not_found" }, { status: 404 });
  const authz = await authorize(ctx.env, actor, "ai_employee.profile.update", { objectType: "ai_employee", objectId: employee.id });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const current = await ctx.env.WP_OS_DB.prepare("SELECT * FROM ai_employee_profile WHERE ai_employee_id = ?1")
    .bind(employee.id)
    .first<{ department: string; manager_employee_id: string | null; manager_firm_user_id: string | null; avatar_initials: string; brief: string }>();
  const next = {
    department: parsed.data.department ?? current?.department ?? employee.layer,
    manager_employee_id: parsed.data.manager_employee_id !== undefined ? parsed.data.manager_employee_id : current?.manager_employee_id ?? null,
    manager_firm_user_id: parsed.data.manager_firm_user_id !== undefined ? parsed.data.manager_firm_user_id : current?.manager_firm_user_id ?? null,
    avatar_initials: parsed.data.avatar_initials ?? current?.avatar_initials ?? employee.name.slice(0, 2).toUpperCase(),
    brief: parsed.data.brief ?? current?.brief ?? employee.role,
  };
  if (next.manager_employee_id === employee.id) {
    return json({ error: "invalid_input", detail: "an employee cannot manage itself" }, { status: 400 });
  }

  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO ai_employee_profile (ai_employee_id, department, manager_employee_id, manager_firm_user_id, avatar_initials, brief, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (ai_employee_id) DO UPDATE SET
       department = excluded.department,
       manager_employee_id = excluded.manager_employee_id,
       manager_firm_user_id = excluded.manager_firm_user_id,
       avatar_initials = excluded.avatar_initials,
       brief = excluded.brief,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  )
    .bind(employee.id, next.department, next.manager_employee_id, next.manager_firm_user_id, next.avatar_initials, next.brief, actor.firmUserId!, new Date().toISOString())
    .run();

  await appendEvent(ctx.env, {
    eventType: "ai_employee.profile_updated",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "ai_employee",
    objectId: employee.id,
    payload: { department: next.department, manager_employee_id: next.manager_employee_id },
  });
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM ai_employee_profile WHERE ai_employee_id = ?1").bind(employee.id).first());
}

const assignSchema = z.object({ machine_id: z.number().int().positive(), active: z.boolean().default(true) });

export async function handleAssignMachine(ctx: RouteContext): Promise<Response> {
  const parsed = assignSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  try {
    requireHuman(actor, "assigning a machine");
  } catch (err) {
    return errorResponse(err);
  }
  const employee = await getEmployee(ctx.env, ctx.params.id!);
  if (!employee) return json({ error: "not_found" }, { status: 404 });
  const machine = await ctx.env.WP_OS_DB.prepare("SELECT id, key FROM machine WHERE id = ?1").bind(parsed.data.machine_id).first<{ id: number; key: string }>();
  if (!machine) return json({ error: "machine_not_found" }, { status: 404 });

  const authz = await authorize(ctx.env, actor, "ai_employee.assign_machine", { objectType: "ai_employee", objectId: employee.id });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO ai_employee_assignment (id, ai_employee_id, machine_id, assigned_by, active)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (ai_employee_id, machine_id) DO UPDATE SET active = excluded.active, assigned_by = excluded.assigned_by`,
  )
    .bind(`aiasg_${crypto.randomUUID()}`, employee.id, machine.id, actor.firmUserId!, parsed.data.active ? 1 : 0)
    .run();

  await appendEvent(ctx.env, {
    eventType: "ai_employee.machine_assigned",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "ai_employee",
    objectId: employee.id,
    payload: { machine_id: machine.id, machine_key: machine.key, active: parsed.data.active },
  });
  return json({ ok: true, ai_employee_id: employee.id, machine_id: machine.id, active: parsed.data.active }, { status: 201 });
}

// ── Lifecycle (lowering only) ──

export const LOWERING_STATES = ["PAUSED", "RESTRICTED", "RETIRED"] as const;

const lifecycleSchema = z.object({
  to_status: z.enum(LOWERING_STATES),
  reason: z.string().trim().min(1),
});

/**
 * Lower an employee's lifecycle state. Refuses to be used as a back door to ACTIVE:
 * `to_status` cannot be ACTIVE, and a RETIRED employee is terminal on this path — bringing
 * anyone back up runs the reserved activation receipt.
 */
export async function changeLifecycle(
  env: Env,
  actor: Actor,
  employeeId: string,
  toStatus: (typeof LOWERING_STATES)[number],
  reason: string,
): Promise<AIEmployeeRow> {
  requireHuman(actor, "changing an employee's lifecycle state");
  const employee = await getEmployee(env, employeeId);
  if (!employee) throw new WorkforceError(404, "not_found");
  if (employee.status === toStatus) throw new WorkforceError(409, "already_in_state", `employee is already ${toStatus}`);
  if (employee.status === "RETIRED") {
    throw new WorkforceError(409, "retired_is_terminal", "a RETIRED employee returns only through the reserved ai_employee.activate path");
  }

  const authz = await authorize(env, actor, "ai_employee.lifecycle_change", {
    objectType: "ai_employee",
    objectId: employee.id,
    firmScope: employee.firm_scope,
  });
  if (authz.decision !== "ALLOW") throw new WorkforceError(403, "forbidden", authz.reason);

  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = ?2 WHERE id = ?1").bind(employee.id, toStatus).run();
  await env.WP_OS_DB.prepare(
    `INSERT INTO ai_employee_status_history (id, ai_employee_id, from_status, to_status, actor_type, actor_id, reason, approval_receipt_id, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8)`,
  )
    .bind(`aish_${crypto.randomUUID()}`, employee.id, employee.status, toStatus, actor.type, actor.firmUserId!, reason, employee.firm_scope)
    .run();

  await appendEvent(env, {
    eventType: "ai_employee.lifecycle_lowered",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "ai_employee",
    objectId: employee.id,
    firmScope: employee.firm_scope,
    payload: { from_status: employee.status, to_status: toStatus, reason },
  });
  await notifyQuietly(env, {
    kind: "EMPLOYEE_EXCEPTION",
    severity: toStatus === "RETIRED" ? "WARNING" : "INFO",
    title: `${employee.name} is now ${toStatus}`,
    body: reason,
    objectType: "ai_employee",
    objectId: employee.id,
    dedupeKey: `employee_lifecycle:${employee.id}:${toStatus}:${new Date().toISOString().slice(0, 10)}`,
    firmScope: employee.firm_scope,
  });
  return (await getEmployee(env, employee.id))!;
}

export async function handleChangeLifecycle(ctx: RouteContext): Promise<Response> {
  const parsed = lifecycleSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await changeLifecycle(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.to_status, parsed.data.reason));
  } catch (err) {
    return errorResponse(err);
  }
}

// ── Rooms ──

const messageSchema = z.object({
  context_kind: z.enum(["WORK_CARD", "AI_RUN", "HANDOFF", "ANNOUNCEMENT"]),
  context_id: z.string().trim().min(1).optional(),
  body: z.string().trim().min(1),
  mentions: z.array(z.string().trim().min(1)).default([]),
});

export async function postRoomMessage(
  env: Env,
  actor: Actor,
  roomId: string,
  body: z.infer<typeof messageSchema>,
): Promise<Record<string, unknown>> {
  const room = await env.WP_OS_DB.prepare("SELECT * FROM department_room WHERE id = ?1 OR room_key = ?1").bind(roomId).first<{ id: string }>();
  if (!room) throw new WorkforceError(404, "room_not_found");

  const authz = await authorize(env, actor, "employee_room.post", { objectType: "department_room", objectId: room.id });
  if (authz.decision !== "ALLOW") throw new WorkforceError(403, "forbidden", authz.reason);

  // Collaboration maps to work. An announcement without a reference is a HUMAN act only:
  // an AI employee cannot broadcast to the firm with no work behind it.
  if (body.context_kind === "ANNOUNCEMENT") {
    if (actor.type !== "HUMAN") {
      throw new WorkforceError(403, "forbidden", "only a human may post a firm announcement; AI messages must reference work, a run, or a handoff");
    }
  } else if (!body.context_id) {
    throw new WorkforceError(400, "context_required", `${body.context_kind} messages must name the record they are about`);
  } else {
    const table = body.context_kind === "WORK_CARD" ? "work_card" : body.context_kind === "AI_RUN" ? "ai_run" : "employee_handoff";
    const exists = await env.WP_OS_DB.prepare(`SELECT id FROM ${table} WHERE id = ?1`).bind(body.context_id).first();
    if (!exists) throw new WorkforceError(404, "context_not_found", `no ${body.context_kind} with id ${body.context_id}`);
  }

  const id = `rmsg_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO room_message (id, room_id, author_type, author_id, context_kind, context_id, body, mentions_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      id,
      room.id,
      actor.type,
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
      body.context_kind,
      body.context_id ?? null,
      body.body,
      JSON.stringify(body.mentions),
    )
    .run();

  await appendEvent(env, {
    eventType: "employee_room.message_posted",
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "department_room",
    objectId: room.id,
    payload: { context_kind: body.context_kind, context_id: body.context_id ?? null },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM room_message WHERE id = ?1").bind(id).first()) as Record<string, unknown>;
}

export async function handleListRooms(ctx: RouteContext): Promise<Response> {
  const rooms = (await ctx.env.WP_OS_DB.prepare("SELECT * FROM department_room ORDER BY department").all()).results ?? [];
  const counts = (
    await ctx.env.WP_OS_DB.prepare("SELECT room_id, COUNT(*) AS n FROM room_message GROUP BY room_id").all<{ room_id: string; n: number }>()
  ).results ?? [];
  return json({
    rooms: rooms.map((r) => ({ ...(r as Record<string, unknown>), message_count: counts.find((c) => c.room_id === (r as { id: string }).id)?.n ?? 0 })),
    rule: "Every message references a work card, an AI run, or a handoff. Only a human may post an unreferenced firm announcement.",
  });
}

export async function handleGetRoom(ctx: RouteContext): Promise<Response> {
  const room = await ctx.env.WP_OS_DB.prepare("SELECT * FROM department_room WHERE id = ?1 OR room_key = ?1").bind(ctx.params.id!).first<{ id: string; department: string }>();
  if (!room) return json({ error: "not_found" }, { status: 404 });
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const messages = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT * FROM room_message WHERE room_id = ?1 AND ${visibility} ORDER BY created_at DESC LIMIT 100`,
    )
      .bind(room.id)
      .all()
  ).results ?? [];
  const members = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT e.id, e.name, e.role, e.status FROM ai_employee e
         JOIN ai_employee_profile p ON p.ai_employee_id = e.id
        WHERE p.department = ?1 ORDER BY e.rowid`,
    )
      .bind(room.department)
      .all()
  ).results ?? [];
  return json({ room, messages, members });
}

export async function handlePostRoomMessage(ctx: RouteContext): Promise<Response> {
  const parsed = messageSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await postRoomMessage(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

// ── Handoffs ──

const handoffSchema = z.object({
  work_card_id: z.string().trim().min(1),
  to_employee_id: z.string().trim().min(1),
  reason: z.string().trim().min(1),
});

export async function proposeHandoff(env: Env, actor: Actor, body: z.infer<typeof handoffSchema>) {
  const authz = await authorize(env, actor, "employee_handoff.propose", { objectType: "work_card", objectId: body.work_card_id });
  if (authz.decision !== "ALLOW") throw new WorkforceError(403, "forbidden", authz.reason);

  const card = await env.WP_OS_DB.prepare("SELECT id, owner_type, owner_id, state FROM work_card WHERE id = ?1")
    .bind(body.work_card_id)
    .first<{ id: string; owner_type: string; owner_id: string | null; state: string }>();
  if (!card) throw new WorkforceError(404, "work_card_not_found");
  const target = await getEmployee(env, body.to_employee_id);
  if (!target) throw new WorkforceError(404, "employee_not_found");
  if (target.status !== "ACTIVE") {
    throw new WorkforceError(409, "target_not_active", `${target.name} is ${target.status}: work can only be handed to an ACTIVE employee (D10)`);
  }

  const id = `hoff_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO employee_handoff (id, work_card_id, from_owner_type, from_owner_id, to_employee_id, reason, proposed_by_type, proposed_by_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(id, card.id, card.owner_type, card.owner_id, target.id, body.reason, actor.type, actor.firmUserId ?? actor.aiEmployeeId ?? "system")
    .run();

  await appendEvent(env, {
    eventType: "employee_handoff.proposed",
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "employee_handoff",
    objectId: id,
    payload: { work_card_id: card.id, to_employee_id: target.id },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM employee_handoff WHERE id = ?1").bind(id).first();
}

const handoffDecisionSchema = z.object({
  decision: z.enum(["ACCEPTED", "REJECTED"]),
  note: z.string().trim().min(1).optional(),
});

/** Accepting a handoff MOVES the work card's owner. Only a human may do it. */
export async function decideHandoff(env: Env, actor: Actor, handoffId: string, body: z.infer<typeof handoffDecisionSchema>) {
  requireHuman(actor, "deciding a handoff");
  const handoff = await env.WP_OS_DB.prepare("SELECT * FROM employee_handoff WHERE id = ?1")
    .bind(handoffId)
    .first<{ id: string; status: string; work_card_id: string; to_employee_id: string }>();
  if (!handoff) throw new WorkforceError(404, "not_found");
  if (handoff.status !== "PROPOSED") throw new WorkforceError(409, "already_decided", `handoff is ${handoff.status}`);

  const authz = await authorize(env, actor, "employee_handoff.decide", { objectType: "employee_handoff", objectId: handoff.id });
  if (authz.decision !== "ALLOW") throw new WorkforceError(403, "forbidden", authz.reason);

  await env.WP_OS_DB.prepare(
    "UPDATE employee_handoff SET status = ?2, decided_by = ?3, decided_at = ?4, decision_note = ?5 WHERE id = ?1",
  )
    .bind(handoff.id, body.decision, actor.firmUserId!, new Date().toISOString(), body.note ?? null)
    .run();

  if (body.decision === "ACCEPTED") {
    await env.WP_OS_DB.prepare("UPDATE work_card SET owner_type = 'AI', owner_id = ?2, updated_at = ?3 WHERE id = ?1")
      .bind(handoff.work_card_id, handoff.to_employee_id, new Date().toISOString())
      .run();
  }

  await appendEvent(env, {
    eventType: "employee_handoff.decided",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "employee_handoff",
    objectId: handoff.id,
    payload: { decision: body.decision, work_card_id: handoff.work_card_id, to_employee_id: handoff.to_employee_id },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM employee_handoff WHERE id = ?1").bind(handoff.id).first();
}

export async function handleProposeHandoff(ctx: RouteContext): Promise<Response> {
  const parsed = handoffSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await proposeHandoff(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleDecideHandoff(ctx: RouteContext): Promise<Response> {
  const parsed = handoffDecisionSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await decideHandoff(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListHandoffs(ctx: RouteContext): Promise<Response> {
  const rows = (await ctx.env.WP_OS_DB.prepare("SELECT * FROM employee_handoff ORDER BY created_at DESC LIMIT 100").all()).results ?? [];
  return json({ handoffs: rows });
}

// ── Memos + governance acknowledgement ──

const memoSchema = z.object({
  audience: z.enum(["FIRM", "DEPARTMENT"]),
  department: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
});

export async function handleCreateMemo(ctx: RouteContext): Promise<Response> {
  const parsed = memoSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  if (parsed.data.audience === "DEPARTMENT" && !parsed.data.department) {
    return json({ error: "invalid_input", detail: "a DEPARTMENT memo must name its department" }, { status: 400 });
  }
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "internal_memo.create", { objectType: "internal_memo" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const id = `memo_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO internal_memo (id, author_type, author_id, audience, department, title, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(id, actor.type, actor.firmUserId ?? "system", parsed.data.audience, parsed.data.department ?? null, parsed.data.title, parsed.data.body)
    .run();
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM internal_memo WHERE id = ?1").bind(id).first(), { status: 201 });
}

export async function handleListMemos(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const rows = (
    await ctx.env.WP_OS_DB.prepare(`SELECT * FROM internal_memo WHERE ${visibility} ORDER BY created_at DESC LIMIT 100`).all()
  ).results ?? [];
  return json({ memos: rows });
}

export async function handleAcknowledgeGovernance(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const update = await ctx.env.WP_OS_DB.prepare("SELECT id FROM governance_update WHERE id = ?1").bind(ctx.params.id!).first();
  if (!update) return json({ error: "not_found" }, { status: 404 });
  const authz = await authorize(ctx.env, actor, "governance_update.acknowledge", { objectType: "governance_update", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  try {
    await ctx.env.WP_OS_DB.prepare(
      "INSERT INTO governance_acknowledgement (id, governance_update_id, actor_type, actor_id) VALUES (?1, ?2, 'HUMAN', ?3)",
    )
      .bind(`gack_${crypto.randomUUID()}`, ctx.params.id!, actor.firmUserId!)
      .run();
  } catch (err) {
    if (String(err).includes("UNIQUE")) return json({ error: "already_acknowledged" }, { status: 409 });
    throw err;
  }
  return json({ ok: true }, { status: 201 });
}

// ── Performance ──

export const SCORECARD_DEFINITION = {
  runs_total: "ai_run rows attributed to this employee inside the window",
  runs_completed: "runs with status COMPLETED",
  runs_blocked: "runs that ended in any blocked/failed status — the governed pipeline refused or the provider failed",
  outputs_accepted: "completed runs whose output is not quarantined (a human accepted it, or it never needed quarantine)",
  outputs_quarantined: "completed runs whose output is still quarantined and therefore unusable",
  approvals_requested: "approval cards this employee requested",
  approvals_rejected: "those cards a human rejected or sent back for revision",
  cost_usd: "actual provider cost where reported, otherwise the recorded estimate",
  cost_per_accepted_output: "cost_usd / outputs_accepted, null when nothing was accepted",
  not_measured: "subjective value. No 'value generated' figure is stored, because none of it is money the firm actually received.",
} as const;

export async function computeScorecard(
  env: Env,
  actor: Actor,
  employeeId: string,
  window: { start: string; end: string },
): Promise<Record<string, unknown>> {
  requireHuman(actor, "computing a scorecard");
  const employee = await getEmployee(env, employeeId);
  if (!employee) throw new WorkforceError(404, "not_found");
  const authz = await authorize(env, actor, "employee_performance.compute", { objectType: "ai_employee", objectId: employee.id });
  if (authz.decision !== "ALLOW") throw new WorkforceError(403, "forbidden", authz.reason);

  const runs = (
    await env.WP_OS_DB.prepare(
      `SELECT status, output_quarantine, failure_reason, cost_estimate_json, actual_usage_json
         FROM ai_run
        WHERE ai_employee_id = ?1 AND created_at >= ?2 AND created_at <= ?3`,
    )
      .bind(employee.id, window.start, window.end)
      .all<{ status: string; output_quarantine: number; failure_reason: string | null; cost_estimate_json: string; actual_usage_json: string | null }>()
  ).results ?? [];

  const approvals = (
    await env.WP_OS_DB.prepare(
      `SELECT state FROM approval_card
        WHERE requested_by_type = 'AI' AND requested_by_id = ?1 AND created_at >= ?2 AND created_at <= ?3`,
    )
      .bind(employee.id, window.start, window.end)
      .all<{ state: string }>()
  ).results ?? [];

  const completed = runs.filter((r) => r.status === "COMPLETED");
  const accepted = completed.filter((r) => r.output_quarantine === 0).length;
  const quarantined = completed.filter((r) => r.output_quarantine === 1).length;
  const blocked = runs.filter((r) => r.status !== "COMPLETED");
  const cost = Math.round(runs.reduce((sum, r) => sum + costOfRun(r), 0) * 1_000_000) / 1_000_000;

  // Failure patterns: group the blocked runs by the reason PREFIX the pipeline recorded, so a
  // recurring cause is visible instead of a wall of one-off strings.
  const patternCounts = new Map<string, number>();
  for (const r of blocked) {
    const key = (r.failure_reason ?? r.status).split(":")[0]!;
    patternCounts.set(key, (patternCounts.get(key) ?? 0) + 1);
  }
  const patterns = [...patternCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));

  const id = `eps_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO employee_performance_snapshot
       (id, ai_employee_id, period_start, period_end, runs_total, runs_completed, runs_blocked,
        outputs_accepted, outputs_quarantined, approvals_requested, approvals_rejected, cost_usd,
        cost_per_accepted_output, failure_patterns_json, definition_json, computed_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
  )
    .bind(
      id,
      employee.id,
      window.start,
      window.end,
      runs.length,
      completed.length,
      blocked.length,
      accepted,
      quarantined,
      approvals.length,
      approvals.filter((a) => a.state === "rejected" || a.state === "revise_requested").length,
      cost,
      accepted > 0 ? Math.round((cost / accepted) * 1_000_000) / 1_000_000 : null,
      JSON.stringify(patterns),
      JSON.stringify(SCORECARD_DEFINITION),
      actor.firmUserId!,
    )
    .run();

  await appendEvent(env, {
    eventType: "employee_performance.computed",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "ai_employee",
    objectId: employee.id,
    payload: { snapshot_id: id, runs_total: runs.length, cost_usd: cost },
  });

  return (await env.WP_OS_DB.prepare("SELECT * FROM employee_performance_snapshot WHERE id = ?1").bind(id).first()) as Record<string, unknown>;
}

const scorecardSchema = z.object({
  period_start: z.string().trim().min(1).optional(),
  period_end: z.string().trim().min(1).optional(),
});

export async function handleComputeScorecard(ctx: RouteContext): Promise<Response> {
  const parsed = scorecardSchema.safeParse((await parseJsonBody(ctx.request)) ?? {});
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const end = parsed.data.period_end ?? new Date().toISOString();
  const start = parsed.data.period_start ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  try {
    const snapshot = await computeScorecard(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, { start, end });
    return json({ snapshot, definition: SCORECARD_DEFINITION }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const reviewSchema = z.object({
  snapshot_id: z.string().trim().min(1).optional(),
  finding: z.string().trim().min(1),
  disposition: z.enum(["CONTINUE", "IMPROVEMENT_PLAN", "RETRAIN", "RESTRICT", "RETIRE"]),
  note: z.string().trim().min(1).optional(),
});

/**
 * Record a manager review. A review that DISPOSES to RESTRICT or RETIRE also applies the
 * lifecycle change, so the record and the state can never disagree — but it applies it through
 * the same lowering path (human-only, audited, never a route to ACTIVE).
 */
export async function handleRecordReview(ctx: RouteContext): Promise<Response> {
  const parsed = reviewSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  try {
    requireHuman(actor, "recording a manager review");
  } catch (err) {
    return errorResponse(err);
  }
  const employee = await getEmployee(ctx.env, ctx.params.id!);
  if (!employee) return json({ error: "not_found" }, { status: 404 });
  const authz = await authorize(ctx.env, actor, "employee_review.record", { objectType: "ai_employee", objectId: employee.id });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const id = `erev_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO employee_review (id, ai_employee_id, reviewer_id, snapshot_id, finding, disposition, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(id, employee.id, actor.firmUserId!, parsed.data.snapshot_id ?? null, parsed.data.finding, parsed.data.disposition, parsed.data.note ?? null)
    .run();

  let lifecycle: AIEmployeeRow | null = null;
  if (parsed.data.disposition === "RESTRICT" || parsed.data.disposition === "RETIRE") {
    const target = parsed.data.disposition === "RESTRICT" ? "RESTRICTED" : "RETIRED";
    if (employee.status !== target && employee.status !== "RETIRED") {
      lifecycle = await changeLifecycle(ctx.env, actor, employee.id, target, `manager review: ${parsed.data.finding}`);
    }
  }

  await appendEvent(ctx.env, {
    eventType: "employee_review.recorded",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "ai_employee",
    objectId: employee.id,
    payload: { review_id: id, disposition: parsed.data.disposition, lifecycle_applied: lifecycle?.status ?? null },
  });

  return json(
    {
      review: await ctx.env.WP_OS_DB.prepare("SELECT * FROM employee_review WHERE id = ?1").bind(id).first(),
      employee: lifecycle ?? employee,
    },
    { status: 201 },
  );
}

export async function handleEmployeeDetail(ctx: RouteContext): Promise<Response> {
  const employee = await getEmployee(ctx.env, ctx.params.id!);
  if (!employee) return json({ error: "not_found" }, { status: 404 });
  const profile = await ctx.env.WP_OS_DB.prepare("SELECT * FROM ai_employee_profile WHERE ai_employee_id = ?1").bind(employee.id).first();
  const snapshots = (
    await ctx.env.WP_OS_DB.prepare("SELECT * FROM employee_performance_snapshot WHERE ai_employee_id = ?1 ORDER BY computed_at DESC LIMIT 10")
      .bind(employee.id)
      .all()
  ).results ?? [];
  const reviews = (
    await ctx.env.WP_OS_DB.prepare("SELECT * FROM employee_review WHERE ai_employee_id = ?1 ORDER BY created_at DESC LIMIT 20").bind(employee.id).all()
  ).results ?? [];
  const history = (
    await ctx.env.WP_OS_DB.prepare("SELECT * FROM ai_employee_status_history WHERE ai_employee_id = ?1 ORDER BY created_at DESC").bind(employee.id).all()
  ).results ?? [];
  const work = (
    await ctx.env.WP_OS_DB.prepare("SELECT id, title, state, priority FROM work_card WHERE owner_type = 'AI' AND owner_id = ?1 ORDER BY created_at DESC LIMIT 20")
      .bind(employee.id)
      .all()
  ).results ?? [];
  const runs = (
    await ctx.env.WP_OS_DB.prepare(
      "SELECT id, purpose, status, model, failure_reason, created_at, cost_estimate_json, actual_usage_json FROM ai_run WHERE ai_employee_id = ?1 ORDER BY created_at DESC LIMIT 20",
    )
      .bind(employee.id)
      .all<{ id: string; purpose: string; status: string; model: string | null; failure_reason: string | null; created_at: string; cost_estimate_json: string; actual_usage_json: string | null }>()
  ).results ?? [];

  return json({
    employee,
    profile,
    snapshots,
    reviews,
    status_history: history,
    current_work: work,
    recent_runs: runs.map((r) => ({ ...r, cost_usd: costOfRun(r) })),
    scorecard_definition: SCORECARD_DEFINITION,
  });
}
