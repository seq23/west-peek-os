import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity } from "./authorize";
import { runAi } from "../ai/runAi";
import { THESIS_PROMPT_VERSION, buildStatementPrompt, parseStatement } from "../../shared/thesis/statement";
import { sectorOptions } from "../../shared/investment/sectors";

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
  const versions = (rows.results ?? []) as Array<Record<string, unknown>>;

  /*
   * `current` IS RETURNED SO NOBODY HAS TO INDEX.
   *
   * Versions come back oldest-first, which is right for a history. Seven call sites then took
   * `versions[0]` believing it was the newest, and one took `.at(-1)` believing the opposite — so
   * the Thesis page, Deal Math and the fund allocation ring all displayed version 1 for ever while
   * the allocation model pinned the latest. Amending the mandate said "Saved as version 2" and
   * changed nothing on screen.
   *
   * Only one version has ever existed in production, which is why nobody saw it. It would have
   * fired the first time the operator did the thing the Thesis page exists for.
   *
   * Naming the current one removes the question rather than answering it seven times.
   */
  return json({
    versions,
    current: versions.length > 0 ? versions[versions.length - 1] : null,
    note: "versions is oldest-first, for history. Use `current` for what is in force — do not index.",
  });
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

const statementSchema = z.object({
  fund_name: z.string().trim().min(1).max(120),
  sectors: z.array(z.string().trim().max(80)).max(30).default([]),
  stage: z.array(z.string().trim().max(80)).max(30).default([]),
  geography: z.array(z.string().trim().max(80)).max(30).default([]),
  cross_cutting_filter: z.string().trim().max(400).nullable().default(null),
  check_min_usd: z.number().nullable().default(null),
  check_max_usd: z.number().nullable().default(null),
  target_ownership_pct: z.number().nullable().default(null),
  target_positions: z.number().nullable().default(null),
  open_question: z.string().trim().max(400).nullable().default(null),
});

/**
 * POST /api/thesis/statement — write the thesis sentence from the fields.
 *
 * PROPOSES ONLY. Returns the sentence; the partner edits it and saves a version through the
 * ordinary policy path. Nothing here writes to the mandate — a model quietly rewriting the firm's
 * thesis would be putting words in two partners' mouths on the document an LP is most likely to
 * read, and the version history would show it as theirs.
 */
export async function handleWriteThesisStatement(ctx: RouteContext): Promise<Response> {
  const parsed = statementSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);
  const input = parsed.data;

  const { run } = await runAi(ctx.env, {
    purpose: `writing the thesis statement for ${input.fund_name}`,
    actor,
    inputs: [
      buildStatementPrompt({
        fundName: input.fund_name,
        sectors: input.sectors,
        stage: input.stage,
        geography: input.geography,
        crossCuttingFilter: input.cross_cutting_filter,
        checkMinUsd: input.check_min_usd,
        checkMaxUsd: input.check_max_usd,
        targetOwnershipPct: input.target_ownership_pct,
        targetPositions: input.target_positions,
        openQuestion: input.open_question,
      }),
    ],
    // The mandate is firm-internal: it names sectors and cheque sizes the firm has not published.
    sensitivity: "INTERNAL" as never,
    budgetContext: { expectedOutputTokens: 300 },
    routing: { category: "OPERATIONS", taskClass: "employee-work" },
  });

  if (run.status !== "COMPLETED" || !run.output_text) {
    return json({ error: "write_failed", detail: run.failure_reason ?? `run ${run.status}`, run_id: run.id }, { status: 502 });
  }

  const result = parseStatement(run.output_text);
  if (!result) return json({ error: "unreadable", run_id: run.id }, { status: 502 });
  return json({ ...result, run_id: run.id, prompt_version: THESIS_PROMPT_VERSION });
}

// ── The sectors a company can be filed under ──

/**
 * Derived from the current mandate, plus the off-thesis catch-all.
 *
 * ONE ROUTE RATHER THAN CLIENT PLUMBING. Every surface that files a company needs this list, and
 * making each one fetch the fund, then the mandate, then parse its JSON would put the same
 * three-step derivation in three places — where it would drift, and where a page that got it wrong
 * would silently offer a different taxonomy from the page next to it.
 */
export async function handleThesisSectors(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const firmScope = actor.firmScopes[0] ?? "west-peek";

  const row = await ctx.env.WP_OS_DB.prepare(
    `SELECT m.mandate_json
       FROM investment_mandate_version m
       JOIN fund f ON f.id = m.fund_id
      WHERE f.firm_scope = ?1
      ORDER BY m.version_no DESC
      LIMIT 1`,
  )
    .bind(firmScope)
    .first<{ mandate_json: string }>();

  let sectors: string[] | undefined;
  try {
    sectors = JSON.parse(row?.mandate_json ?? "{}").sectors as string[] | undefined;
  } catch {
    sectors = undefined;
  }

  return json({
    options: sectorOptions(sectors),
    // Said, so a surface can explain itself rather than looking arbitrary.
    from: sectors?.length ? "the fund's written mandate" : "no sectors are stated in the mandate yet",
  });
}
