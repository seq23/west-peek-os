import { z } from "zod";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize } from "./authorize";
import { executeExternalEffect, EffectError, isKnownEffectType, type ExternalEffectRequestRow } from "../effects/executor";

/**
 * External effect requests (P3). Creating a request is an ordinary internal action
 * (it changes nothing outside the system). EXECUTION is gated: it happens only in
 * effects/executor.ts, behind authorize() + an approved approval-card receipt.
 */

const createEffectRequestSchema = z.object({
  effect_type: z.string().trim().min(1),
  destination: z.string().trim().min(1),
  payload: z.unknown().optional(),
});

const executeSchema = z.object({
  receipt_id: z.string().trim().min(1).optional(),
});

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function handleCreateEffectRequest(ctx: RouteContext): Promise<Response> {
  const { env, identity } = ctx;
  const body = await parseJsonBody(ctx.request);
  const parsed = createEffectRequestSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;

  if (!isKnownEffectType(input.effect_type)) {
    return json({ error: "invalid_input", detail: `unknown effect_type '${input.effect_type}'` }, { status: 400 });
  }

  const actor = actorFromIdentity(identity!);
  // Requesting is internal; execution is the gated step (effects/executor.ts).
  const authz = await authorize(env, actor, "approval.request", { objectType: "external_effect_request", firmScope: "west-peek" });
  if (authz.decision === "DENY") return json({ error: "forbidden", reason: authz.reason }, { status: 403 });

  const id = `eer_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO external_effect_request (id, effect_type, destination, payload_json, requested_by_type, requested_by_id)
     VALUES (?1, ?2, ?3, ?4, 'HUMAN', ?5)`,
  )
    .bind(id, input.effect_type, input.destination, JSON.stringify(input.payload ?? {}), identity!.id)
    .run();

  await appendEvent(env, {
    eventType: "effect.requested",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "external_effect_request",
    objectId: id,
    payload: { effect_type: input.effect_type, destination: input.destination },
  });

  const row = await env.WP_OS_DB.prepare("SELECT * FROM external_effect_request WHERE id = ?1").bind(id).first<ExternalEffectRequestRow>();
  return json(row, { status: 201 });
}

export async function handleListEffectRequests(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM external_effect_request ORDER BY created_at DESC, id",
  ).all<ExternalEffectRequestRow>();
  return json({ effect_requests: rows.results ?? [] });
}

/** Execute via the executor — the only execution path. Receipt required. */
export async function handleExecuteEffectRequest(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = executeSchema.safeParse(body ?? {});
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  try {
    const result = await executeExternalEffect(
      ctx.env,
      actorFromIdentity(ctx.identity!),
      ctx.params.id!,
      parsed.data.receipt_id,
    );
    return json(result);
  } catch (err) {
    if (err instanceof EffectError) return json({ error: err.code, detail: err.message }, { status: err.status });
    throw err;
  }
}
