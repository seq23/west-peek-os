import { z } from "zod";
import type { Env } from "../env";
import type { FirmUserIdentity } from "../auth";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { privacyLabelSchema, DEFAULT_PRIVACY_LABEL } from "../../shared/privacy";
import { actorFromIdentity, authorize, canAccessPrivacyLabel, privacyVisibilityClause } from "./authorize";
import { getVisibleCapture } from "./captures";

/**
 * Work spine (P3): the unit of governed work. State transitions are enforced
 * here; every material mutation appends to the event spine (D15).
 */

export interface WorkCardRow {
  id: string;
  capture_id: string | null;
  title: string;
  description: string | null;
  domain_id: string | null;
  machine_id: number | null;
  owner_type: string;
  owner_id: string | null;
  state: string;
  priority: string;
  privacy_label: string;
  firm_scope: string;
  next_action: string | null;
  due_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export const WORK_CARD_STATES = ["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"] as const;
export type WorkCardState = (typeof WORK_CARD_STATES)[number];

const ALLOWED_TRANSITIONS: Readonly<Record<WorkCardState, readonly WorkCardState[]>> = {
  OPEN: ["IN_PROGRESS", "BLOCKED", "CANCELLED"],
  IN_PROGRESS: ["BLOCKED", "DONE", "CANCELLED"],
  BLOCKED: ["OPEN", "IN_PROGRESS", "CANCELLED"],
  DONE: ["OPEN"], // reopen
  CANCELLED: [],
};

export class WorkCardError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

const createWorkCardSchema = z.object({
  capture_id: z.string().min(1).optional(),
  title: z.string().trim().min(1),
  description: z.string().optional(),
  domain_id: z.string().trim().min(1).optional(),
  machine_id: z.number().int().positive().optional(),
  owner_type: z.enum(["HUMAN", "AI", "UNASSIGNED"]).optional(),
  owner_id: z.string().trim().min(1).optional(),
  priority: z.string().trim().min(1).optional(),
  privacy_label: privacyLabelSchema.optional(),
  next_action: z.string().optional(),
  due_at: z.string().trim().min(1).optional(),
});

const updateWorkCardSchema = z
  .object({
    state: z.enum(WORK_CARD_STATES).optional(),
    title: z.string().trim().min(1).optional(),
    description: z.string().nullable().optional(),
    owner_type: z.enum(["HUMAN", "AI", "UNASSIGNED"]).optional(),
    owner_id: z.string().trim().min(1).nullable().optional(),
    priority: z.string().trim().min(1).optional(),
    next_action: z.string().nullable().optional(),
    due_at: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function firmScopesOf(identity: FirmUserIdentity): string[] {
  const scopes = identity.authorityScopes.filter((s) => s.scopeKey === "firm_scope").map((s) => s.scopeValue);
  return scopes.length > 0 ? scopes : ["west-peek"];
}

async function getVisibleWorkCard(env: Env, identity: FirmUserIdentity, id: string): Promise<WorkCardRow | null> {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<WorkCardRow>();
  if (!row) return null;
  if (!firmScopesOf(identity).includes(row.firm_scope)) return null;
  if (!canAccessPrivacyLabel(identity, row.privacy_label)) return null;
  return row;
}

export interface CreateWorkCardInput {
  capture_id?: string;
  title: string;
  description?: string;
  domain_id?: string;
  machine_id?: number;
  owner_type?: "HUMAN" | "AI" | "UNASSIGNED";
  owner_id?: string;
  priority?: string;
  privacy_label?: string;
  firm_scope?: string;
  next_action?: string;
  due_at?: string;
}

/** Shared creation path (HTTP handler and capture routing). Authorizes internally. */
export async function createWorkCardInternal(
  env: Env,
  identity: FirmUserIdentity,
  input: CreateWorkCardInput,
): Promise<WorkCardRow> {
  const firmScope = input.firm_scope ?? "west-peek";
  const actor = actorFromIdentity(identity);
  const authz = await authorize(env, actor, "work_card.create", { objectType: "work_card", firmScope });
  if (authz.decision !== "ALLOW") throw new WorkCardError(403, "forbidden", authz.reason);

  const id = `wc_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO work_card
       (id, capture_id, title, description, domain_id, machine_id, owner_type, owner_id,
        state, priority, privacy_label, firm_scope, next_action, due_at, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'OPEN', ?9, ?10, ?11, ?12, ?13, ?14)`,
  )
    .bind(
      id,
      input.capture_id ?? null,
      input.title,
      input.description ?? null,
      input.domain_id ?? null,
      input.machine_id ?? null,
      input.owner_type ?? "UNASSIGNED",
      input.owner_id ?? null,
      input.priority ?? "NORMAL",
      input.privacy_label ?? DEFAULT_PRIVACY_LABEL,
      firmScope,
      input.next_action ?? null,
      input.due_at ?? null,
      identity.id,
    )
    .run();

  await appendEvent(env, {
    eventType: "work_card.created",
    actorType: "firm_user",
    actorId: identity.id,
    objectType: "work_card",
    objectId: id,
    firmScope,
    payload: { title: input.title, capture_id: input.capture_id ?? null, machine_id: input.machine_id ?? null },
  });

  return (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<WorkCardRow>())!;
}

export async function handleCreateWorkCard(ctx: RouteContext): Promise<Response> {
  const { env, identity } = ctx;
  const body = await parseJsonBody(ctx.request);
  const parsed = createWorkCardSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;

  try {
    let derived: CreateWorkCardInput = { ...input };
    if (input.capture_id) {
      const capture = await getVisibleCapture(env, identity!, input.capture_id);
      if (!capture) return json({ error: "not_found", detail: "capture not found or not visible" }, { status: 404 });
      // The work card inherits the capture's sensitivity and firm scope.
      derived = {
        ...derived,
        privacy_label: input.privacy_label ?? capture.privacy_label,
        firm_scope: capture.firm_scope,
      };
    }
    const card = await createWorkCardInternal(env, identity!, derived);
    return json(card, { status: 201 });
  } catch (err) {
    if (err instanceof WorkCardError) return json({ error: err.code, detail: err.message }, { status: err.status });
    throw err;
  }
}

export async function handleListWorkCards(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const state = url.searchParams.get("state");
  const ownerId = url.searchParams.get("owner_id");
  const visibility = privacyVisibilityClause(ctx.identity!);
  const scopes = firmScopesOf(ctx.identity!);
  const scopeClause = `firm_scope IN (${scopes.map((s) => `'${s.replaceAll("'", "''")}'`).join(", ")})`;

  const conditions = [scopeClause, visibility];
  const binds: string[] = [];
  if (state) {
    binds.push(state);
    conditions.push(`state = ?${binds.length}`);
  }
  if (ownerId) {
    binds.push(ownerId);
    conditions.push(`owner_id = ?${binds.length}`);
  }
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT * FROM work_card WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id`,
  )
    .bind(...binds)
    .all<WorkCardRow>();
  return json({ work_cards: rows.results ?? [] });
}

export async function handleGetWorkCard(ctx: RouteContext): Promise<Response> {
  const card = await getVisibleWorkCard(ctx.env, ctx.identity!, ctx.params.id!);
  if (!card) return json({ error: "not_found" }, { status: 404 });
  return json(card);
}

export async function handleUpdateWorkCard(ctx: RouteContext): Promise<Response> {
  const { env, identity } = ctx;
  const card = await getVisibleWorkCard(env, identity!, ctx.params.id!);
  if (!card) return json({ error: "not_found" }, { status: 404 });

  const body = await parseJsonBody(ctx.request);
  const parsed = updateWorkCardSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;

  const actor = actorFromIdentity(identity!);
  const authz = await authorize(env, actor, "work_card.update", { objectType: "work_card", objectId: card.id, firmScope: card.firm_scope });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", reason: authz.reason }, { status: 403 });

  if (input.state !== undefined && input.state !== card.state) {
    const allowed = ALLOWED_TRANSITIONS[card.state as WorkCardState];
    if (!allowed.includes(input.state)) {
      return json(
        { error: "illegal_transition", detail: `work card cannot transition ${card.state} → ${input.state}` },
        { status: 409 },
      );
    }
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const field of ["title", "description", "owner_type", "owner_id", "priority", "next_action", "due_at", "state"] as const) {
    if (input[field] !== undefined) {
      binds.push(input[field]);
      sets.push(`${field} = ?${binds.length + 1}`);
    }
  }
  if (sets.length === 0) return json({ error: "invalid_input", detail: "no updatable fields provided" }, { status: 400 });

  await env.WP_OS_DB.prepare(
    `UPDATE work_card SET ${sets.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`,
  )
    .bind(card.id, ...binds)
    .run();

  const stateChanged = input.state !== undefined && input.state !== card.state;
  await appendEvent(env, {
    eventType: stateChanged ? "work_card.state_changed" : "work_card.updated",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: stateChanged
      ? { from_state: card.state, to_state: input.state }
      : { fields: Object.keys(input) },
  });

  const updated = await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(card.id).first<WorkCardRow>();
  return json(updated);
}
