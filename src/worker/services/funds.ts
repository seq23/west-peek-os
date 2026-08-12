import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";

/**
 * Fund + policy substrate (P2).
 *
 * - Funds carry NO hardcoded sizes, sleeve targets, or strategies; all policy content
 *   lives in versioned JSON rows created by humans.
 * - Affiliated legal entities (fund_entity) stay distinct — never collapsed.
 * - Policy versions are IMMUTABLE: change = a new version row; UPDATE/DELETE are
 *   rejected by database triggers on all four *_policy_version tables, for every role.
 */

interface FundRow {
  id: string;
  name: string;
  status: string;
  firm_scope: string;
  created_at: string;
}

const POLICY_KINDS = {
  mandate: { table: "investment_mandate_version", column: "mandate_json" },
  sleeve: { table: "sleeve_policy_version", column: "sleeve_json" },
  reserve: { table: "reserve_policy_version", column: "reserve_json" },
  concentration: { table: "concentration_policy_version", column: "concentration_json" },
} as const;

type PolicyKind = keyof typeof POLICY_KINDS;

const createFundSchema = z.object({
  name: z.string().trim().min(1),
});

const createFundEntitySchema = z.object({
  legal_entity_name: z.string().trim().min(1),
  entity_type: z.string().trim().min(1),
  jurisdiction: z.string().trim().min(1).optional(),
});

const createPolicyVersionSchema = z.object({
  version_no: z.number().int().positive(),
  effective_from: z.string().trim().min(1),
  policy: z.record(z.unknown()),
});

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function getFundById(env: Env, id: string): Promise<FundRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM fund WHERE id = ?1").bind(id).first<FundRow>();
}

export async function handleCreateFund(ctx: RouteContext): Promise<Response> {
  const { env, identity } = ctx;
  const body = await parseJsonBody(ctx.request);
  const parsed = createFundSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  const id = `fund_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare("INSERT INTO fund (id, name) VALUES (?1, ?2)").bind(id, parsed.data.name).run();

  await appendEvent(env, {
    eventType: "fund.created",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "fund",
    objectId: id,
    payload: { name: parsed.data.name },
  });

  const fund = await getFundById(env, id);
  return json(fund, { status: 201 });
}

export async function handleListFunds(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare("SELECT * FROM fund ORDER BY created_at, id").all<FundRow>();
  return json({ funds: rows.results ?? [] });
}

export async function handleGetFund(ctx: RouteContext): Promise<Response> {
  const fund = await getFundById(ctx.env, ctx.params.id!);
  if (!fund) return json({ error: "not_found" }, { status: 404 });
  const entities = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM fund_entity WHERE fund_id = ?1 ORDER BY created_at, id",
  )
    .bind(fund.id)
    .all();
  return json({ ...fund, entities: entities.results ?? [] });
}

/** Fund entities are affiliated-but-distinct legal entities; no dedup, never collapsed. */
export async function handleCreateFundEntity(ctx: RouteContext): Promise<Response> {
  const { env, identity } = ctx;
  const fund = await getFundById(env, ctx.params.id!);
  if (!fund) return json({ error: "not_found" }, { status: 404 });

  const body = await parseJsonBody(ctx.request);
  const parsed = createFundEntitySchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;

  const id = `fe_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO fund_entity (id, fund_id, legal_entity_name, entity_type, jurisdiction) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(id, fund.id, input.legal_entity_name, input.entity_type, input.jurisdiction ?? null)
    .run();

  await appendEvent(env, {
    eventType: "fund.entity_created",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "fund_entity",
    objectId: id,
    payload: { fund_id: fund.id, legal_entity_name: input.legal_entity_name },
  });

  const row = await env.WP_OS_DB.prepare("SELECT * FROM fund_entity WHERE id = ?1").bind(id).first();
  return json(row, { status: 201 });
}

export async function handleListFundEntities(ctx: RouteContext): Promise<Response> {
  const fund = await getFundById(ctx.env, ctx.params.id!);
  if (!fund) return json({ error: "not_found" }, { status: 404 });
  const rows = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM fund_entity WHERE fund_id = ?1 ORDER BY created_at, id",
  )
    .bind(fund.id)
    .all();
  return json({ entities: rows.results ?? [] });
}

/** Create a NEW policy version. Update/delete routes do not exist — see triggers. */
export async function handleCreatePolicyVersion(ctx: RouteContext): Promise<Response> {
  const { env, identity, params } = ctx;
  const kind = params.kind as PolicyKind;
  const spec = POLICY_KINDS[kind];
  if (!spec) return json({ error: "not_found", detail: `unknown policy kind: ${params.kind}` }, { status: 404 });

  const fund = await getFundById(env, params.id!);
  if (!fund) return json({ error: "not_found" }, { status: 404 });

  const body = await parseJsonBody(ctx.request);
  const parsed = createPolicyVersionSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;

  const existing = await env.WP_OS_DB.prepare(
    `SELECT id FROM ${spec.table} WHERE fund_id = ?1 AND version_no = ?2`,
  )
    .bind(fund.id, input.version_no)
    .first<{ id: string }>();
  if (existing) {
    return json(
      { error: "conflict", detail: `version_no ${input.version_no} already exists for this fund; create the next version` },
      { status: 409 },
    );
  }

  const id = `pv_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO ${spec.table} (id, fund_id, version_no, effective_from, ${spec.column}, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(id, fund.id, input.version_no, input.effective_from, JSON.stringify(input.policy), identity!.id)
    .run();

  await appendEvent(env, {
    eventType: "policy.version_created",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: spec.table,
    objectId: id,
    payload: { fund_id: fund.id, kind, version_no: input.version_no },
  });

  const row = await env.WP_OS_DB.prepare(`SELECT * FROM ${spec.table} WHERE id = ?1`).bind(id).first();
  return json(row, { status: 201 });
}

export async function handleListPolicyVersions(ctx: RouteContext): Promise<Response> {
  const kind = ctx.params.kind as PolicyKind;
  const spec = POLICY_KINDS[kind];
  if (!spec) return json({ error: "not_found", detail: `unknown policy kind: ${ctx.params.kind}` }, { status: 404 });
  const fund = await getFundById(ctx.env, ctx.params.id!);
  if (!fund) return json({ error: "not_found" }, { status: 404 });
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT * FROM ${spec.table} WHERE fund_id = ?1 ORDER BY version_no`,
  )
    .bind(fund.id)
    .all();
  return json({ versions: rows.results ?? [] });
}

export async function handleGetPolicyVersion(ctx: RouteContext): Promise<Response> {
  const kind = ctx.params.kind as PolicyKind;
  const spec = POLICY_KINDS[kind];
  if (!spec) return json({ error: "not_found", detail: `unknown policy kind: ${ctx.params.kind}` }, { status: 404 });
  const fund = await getFundById(ctx.env, ctx.params.id!);
  if (!fund) return json({ error: "not_found" }, { status: 404 });
  const versionNo = Number(ctx.params.versionNo);
  if (!Number.isInteger(versionNo) || versionNo <= 0) {
    return json({ error: "invalid_input", detail: "versionNo must be a positive integer" }, { status: 400 });
  }
  const row = await ctx.env.WP_OS_DB.prepare(
    `SELECT * FROM ${spec.table} WHERE fund_id = ?1 AND version_no = ?2`,
  )
    .bind(fund.id, versionNo)
    .first();
  if (!row) return json({ error: "not_found" }, { status: 404 });
  return json(row);
}
