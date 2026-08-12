import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, privacyVisibilityClause, type Actor } from "./authorize";
import { runAi, type AIRunRow, type RunAiDeps } from "../ai/runAi";
import { privacyLabelSchema } from "../../shared/privacy";

/**
 * AI run routes (P4). POST /api/ai/run is available to any authenticated firm
 * user; the run itself is gated by the runAi pipeline (privacy/cost/egress).
 * Run visibility follows the P3 privacy rules: rows with sensitive labels are
 * visible only to MPs / privacy-scoped users (SQL-enforced).
 *
 * Output quarantine: external-provider outputs stay quarantined until a HUMAN
 * accept step (acceptQuarantinedOutput). Quarantined text never auto-enters
 * any other table.
 */

const runSchema = z.object({
  purpose: z.string().trim().min(1),
  inputs: z.array(z.string()).min(1),
  sensitivity: privacyLabelSchema,
  capability_requirement: z.string().trim().min(1).optional(),
  budget_context: z
    .object({
      critical: z.boolean().optional(),
      expected_input_tokens: z.number().int().positive().optional(),
      expected_output_tokens: z.number().int().positive().optional(),
      preferred_model: z.string().trim().min(1).optional(),
      provider_key: z.string().trim().min(1).optional(),
    })
    .optional(),
});

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function runAiForActor(
  env: Env,
  actor: Actor,
  body: z.infer<typeof runSchema>,
  deps: RunAiDeps = {},
): Promise<AIRunRow> {
  const authz = await authorize(env, actor, "ai.run", { objectType: "ai_run", firmScope: actor.firmScopes[0] });
  if (authz.decision === "DENY") throw new AiRouteError(403, "forbidden", authz.reason);
  const { run } = await runAi(
    env,
    {
      purpose: body.purpose,
      actor,
      inputs: body.inputs,
      sensitivity: body.sensitivity,
      capabilityRequirement: body.capability_requirement,
      budgetContext: body.budget_context
        ? {
            critical: body.budget_context.critical,
            expectedInputTokens: body.budget_context.expected_input_tokens,
            expectedOutputTokens: body.budget_context.expected_output_tokens,
            preferredModel: body.budget_context.preferred_model,
            providerKey: body.budget_context.provider_key,
          }
        : undefined,
    },
    deps,
  );
  return run;
}

export class AiRouteError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof AiRouteError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

export async function handleRunAi(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = runSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const run = await runAiForActor(ctx.env, actorFromIdentity(ctx.identity!), parsed.data);
    return json(run, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListAiRuns(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const status = url.searchParams.get("status");
  const visibility = privacyVisibilityClause(ctx.identity!, "sensitivity");
  const rows = status
    ? await ctx.env.WP_OS_DB.prepare(
        `SELECT * FROM ai_run WHERE status = ?1 AND ${visibility} ORDER BY created_at DESC, id LIMIT 200`,
      )
        .bind(status)
        .all<AIRunRow>()
    : await ctx.env.WP_OS_DB.prepare(`SELECT * FROM ai_run WHERE ${visibility} ORDER BY created_at DESC, id LIMIT 200`).all<AIRunRow>();
  return json({ runs: rows.results ?? [] });
}

export async function handleGetAiRun(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "sensitivity");
  const row = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM ai_run WHERE id = ?1 AND ${visibility}`)
    .bind(ctx.params.id!)
    .first<AIRunRow>();
  if (!row) return json({ error: "not_found" }, { status: 404 });
  return json({ ...row, trace_id: row.trace_id });
}

/**
 * Human accept of a quarantined external output. The ONLY promotion path:
 * flips output_quarantine to 0 and appends ai_output.accepted. AI/SYSTEM
 * actors can never accept (service-level check, not just route auth).
 */
export async function acceptQuarantinedOutput(env: Env, actor: Actor, runId: string): Promise<AIRunRow> {
  if (actor.type !== "HUMAN") {
    throw new AiRouteError(403, "forbidden", "quarantined output accept is human-reserved");
  }
  const authz = await authorize(env, actor, "ai_output.accept", { objectType: "ai_run", objectId: runId });
  if (authz.decision === "DENY") throw new AiRouteError(403, "forbidden", authz.reason);

  const run = await env.WP_OS_DB.prepare("SELECT * FROM ai_run WHERE id = ?1").bind(runId).first<AIRunRow>();
  if (!run) throw new AiRouteError(404, "not_found");
  if (run.status !== "COMPLETED") throw new AiRouteError(409, "not_completed", "only completed runs have acceptable output");
  if (run.output_quarantine !== 1) throw new AiRouteError(409, "not_quarantined", "run output is not quarantined");

  await env.WP_OS_DB.prepare("UPDATE ai_run SET output_quarantine = 0 WHERE id = ?1").bind(runId).run();
  await appendEvent(env, {
    eventType: "ai_output.accepted",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "ai_run",
    objectId: runId,
    firmScope: run.firm_scope,
    payload: { trace_id: run.trace_id },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM ai_run WHERE id = ?1").bind(runId).first<AIRunRow>())!;
}

export async function handleAcceptAiOutput(ctx: RouteContext): Promise<Response> {
  try {
    const run = await acceptQuarantinedOutput(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!);
    return json(run);
  } catch (err) {
    return errorResponse(err);
  }
}
