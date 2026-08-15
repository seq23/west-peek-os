import { z } from "zod";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize } from "./authorize";

/**
 * Capability Intelligence Center (P17, GAP-07).
 *
 * The firm's INTERNAL capability registry — deliberately not a commercial marketplace. It answers:
 * what can this firm actually do, how mature is it, what does it depend on, who holds it, what
 * happened when we used it, and did we decide to build or buy it.
 *
 * Two states are kept separate on purpose:
 * - `maturity` — how well developed the capability is (a design judgement);
 * - `tested_state` — whether anything has actually been proven (UNTESTED → FIXTURE_TESTED →
 *   PROVEN_LOCAL → PROVEN_LIVE).
 * A capability can be MATURE and UNTESTED, and the surface says so rather than blurring them.
 * `PROVEN_LIVE` is refused while no live provider access exists — claiming it would be false.
 *
 * The recommended stack is DETERMINISTIC and shows its arithmetic: it ranks only capabilities
 * with recorded after-action evidence, by observed success rate then by sample size. It is not a
 * model opinion and is never presented as one.
 */

function errorResponse(status: number, code: string, detail?: string): Response {
  return json({ error: code, detail }, { status });
}

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

const capabilitySchema = z.object({
  capability_key: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().trim().default(""),
  maturity: z.enum(["EXPERIMENTAL", "DEVELOPING", "MATURE"]).default("EXPERIMENTAL"),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]).default("LOW"),
  tested_state: z.enum(["UNTESTED", "FIXTURE_TESTED", "PROVEN_LOCAL", "PROVEN_LIVE"]).default("UNTESTED"),
  model_dependencies: z.array(z.string().trim().min(1)).default([]),
  tool_dependencies: z.array(z.string().trim().min(1)).default([]),
  cost_estimate_usd: z.number().nonnegative().optional(),
  cost_basis: z.string().trim().default(""),
  owner_firm_user_id: z.string().trim().min(1).optional(),
});

export async function handleRegisterCapability(ctx: RouteContext): Promise<Response> {
  const parsed = capabilitySchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "capability.register", { objectType: "capability" });
  if (authz.decision !== "ALLOW") return errorResponse(403, "forbidden", authz.reason);

  const body = parsed.data;
  if (body.tested_state === "PROVEN_LIVE") {
    return errorResponse(
      409,
      "live_proof_unavailable",
      "PROVEN_LIVE asserts a capability was exercised against a live provider; no live provider access exists, so this would be a false record",
    );
  }
  if (body.cost_estimate_usd !== undefined && body.cost_basis.length === 0) {
    return errorResponse(400, "cost_basis_required", "a cost estimate must state what it is based on");
  }

  const id = `cap_${crypto.randomUUID()}`;
  try {
    await ctx.env.WP_OS_DB.prepare(
      `INSERT INTO capability
         (id, capability_key, name, description, maturity, confidence, state, tested_state,
          model_dependencies_json, tool_dependencies_json, cost_estimate_usd, cost_basis, owner_firm_user_id, registered_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'BENCH', ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
      .bind(
        id,
        body.capability_key,
        body.name,
        body.description,
        body.maturity,
        body.confidence,
        body.tested_state,
        JSON.stringify(body.model_dependencies),
        JSON.stringify(body.tool_dependencies),
        body.cost_estimate_usd ?? null,
        body.cost_basis,
        body.owner_firm_user_id ?? null,
        ctx.identity!.id,
      )
      .run();
  } catch (err) {
    if (String(err).includes("UNIQUE")) return errorResponse(409, "duplicate_capability_key");
    throw err;
  }
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM capability WHERE id = ?1").bind(id).first(), { status: 201 });
}

export async function handleListCapabilities(ctx: RouteContext): Promise<Response> {
  const capabilities = (await ctx.env.WP_OS_DB.prepare("SELECT * FROM capability ORDER BY state, capability_key").all<Record<string, unknown>>())
    .results ?? [];
  const assignments = (
    await ctx.env.WP_OS_DB.prepare("SELECT * FROM capability_assignment WHERE active = 1").all<{ capability_id: string; target_kind: string; target_id: string }>()
  ).results ?? [];
  const afterAction = (
    await ctx.env.WP_OS_DB.prepare("SELECT capability_id, outcome, cost_usd FROM capability_after_action").all<{ capability_id: string; outcome: string; cost_usd: number | null }>()
  ).results ?? [];
  const decisions = (
    await ctx.env.WP_OS_DB.prepare("SELECT * FROM build_vs_buy_decision ORDER BY created_at DESC").all<Record<string, unknown>>()
  ).results ?? [];

  const enriched: Array<Record<string, unknown>> = capabilities.map((c) => {
    const id = c.id as string;
    const records = afterAction.filter((a) => a.capability_id === id);
    const success = records.filter((r) => r.outcome === "SUCCESS").length;
    const observedCost = records.filter((r) => r.cost_usd !== null).reduce((s, r) => s + (r.cost_usd ?? 0), 0);
    return {
      ...c,
      assignments: assignments.filter((a) => a.capability_id === id).map((a) => ({ kind: a.target_kind, id: a.target_id })),
      after_action_count: records.length,
      success_rate: records.length > 0 ? Math.round((success / records.length) * 1000) / 10 : null,
      observed_cost_usd: records.length > 0 ? Math.round(observedCost * 1_000_000) / 1_000_000 : null,
      build_vs_buy: decisions.find((d) => d.capability_id === id) ?? null,
    };
  });

  return json({
    capabilities: enriched,
    active: enriched.filter((c) => c.state === "ACTIVE"),
    bench: enriched.filter((c) => c.state === "BENCH"),
    archive: enriched.filter((c) => c.state === "ARCHIVE"),
    recommended_stack: recommendStack(enriched),
    definitions: {
      maturity: "How developed the capability is. A design judgement recorded by its owner.",
      tested_state: "Whether anything has actually been proven. A capability can be MATURE and UNTESTED.",
      success_rate: "Observed SUCCESS share of recorded after-action results. Null when nothing has been recorded — never assumed.",
      recommended_stack:
        "Deterministic: only capabilities that are ACTIVE and have at least one after-action record, ranked by observed success rate then sample size. It is arithmetic over recorded outcomes, not a model opinion.",
    },
  });
}

function recommendStack(
  capabilities: Array<Record<string, unknown>>,
): Array<{ capability_key: string; name: string; success_rate: number; sample_size: number; why: string }> {
  return capabilities
    .filter((c) => c.state === "ACTIVE" && (c.after_action_count as number) > 0)
    .map((c) => ({
      capability_key: c.capability_key as string,
      name: c.name as string,
      success_rate: c.success_rate as number,
      sample_size: c.after_action_count as number,
      why: `${c.success_rate}% success across ${c.after_action_count} recorded use(s)`,
    }))
    .sort((a, b) => b.success_rate - a.success_rate || b.sample_size - a.sample_size);
}

const transitionSchema = z.object({ state: z.enum(["ACTIVE", "BENCH", "ARCHIVE"]), reason: z.string().trim().min(1) });

export async function handleTransitionCapability(ctx: RouteContext): Promise<Response> {
  const parsed = transitionSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "capability.transition", { objectType: "capability", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return errorResponse(403, "forbidden", authz.reason);

  const cap = await ctx.env.WP_OS_DB.prepare("SELECT * FROM capability WHERE id = ?1")
    .bind(ctx.params.id!)
    .first<{ id: string; state: string; tested_state: string; capability_key: string }>();
  if (!cap) return errorResponse(404, "not_found");

  // A capability nobody has tested cannot be the firm's ACTIVE way of doing something.
  if (parsed.data.state === "ACTIVE" && cap.tested_state === "UNTESTED") {
    return errorResponse(
      409,
      "untested_capability",
      "an UNTESTED capability cannot be made ACTIVE; record what was tested and how first",
    );
  }

  await ctx.env.WP_OS_DB.prepare("UPDATE capability SET state = ?2 WHERE id = ?1").bind(cap.id, parsed.data.state).run();
  await appendEvent(ctx.env, {
    eventType: "capability.transitioned",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "capability",
    objectId: cap.id,
    payload: { from: cap.state, to: parsed.data.state, reason: parsed.data.reason },
  });
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM capability WHERE id = ?1").bind(cap.id).first());
}

const assignSchema = z.object({
  target_kind: z.enum(["EMPLOYEE", "MACHINE"]),
  target_id: z.string().trim().min(1),
  active: z.boolean().default(true),
});

export async function handleAssignCapability(ctx: RouteContext): Promise<Response> {
  const parsed = assignSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "capability.assign", { objectType: "capability", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return errorResponse(403, "forbidden", authz.reason);

  const cap = await ctx.env.WP_OS_DB.prepare("SELECT id FROM capability WHERE id = ?1").bind(ctx.params.id!).first();
  if (!cap) return errorResponse(404, "not_found");

  const exists =
    parsed.data.target_kind === "EMPLOYEE"
      ? await ctx.env.WP_OS_DB.prepare("SELECT id FROM ai_employee WHERE id = ?1").bind(parsed.data.target_id).first()
      : await ctx.env.WP_OS_DB.prepare("SELECT id FROM machine WHERE id = ?1").bind(Number(parsed.data.target_id)).first();
  if (!exists) return errorResponse(404, "target_not_found", `${parsed.data.target_kind} '${parsed.data.target_id}' does not exist`);

  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO capability_assignment (id, capability_id, target_kind, target_id, assigned_by, active)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (capability_id, target_kind, target_id) DO UPDATE SET active = excluded.active, assigned_by = excluded.assigned_by`,
  )
    .bind(`capa_${crypto.randomUUID()}`, ctx.params.id!, parsed.data.target_kind, parsed.data.target_id, ctx.identity!.id, parsed.data.active ? 1 : 0)
    .run();
  return json({ ok: true }, { status: 201 });
}

const afterActionSchema = z.object({
  outcome: z.enum(["SUCCESS", "PARTIAL", "FAILURE"]),
  note: z.string().trim().min(1),
  work_card_id: z.string().trim().min(1).optional(),
  ai_run_id: z.string().trim().min(1).optional(),
  cost_usd: z.number().nonnegative().optional(),
});

export async function handleRecordAfterAction(ctx: RouteContext): Promise<Response> {
  const parsed = afterActionSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "capability_after_action.record", { objectType: "capability", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return errorResponse(403, "forbidden", authz.reason);

  const cap = await ctx.env.WP_OS_DB.prepare("SELECT id FROM capability WHERE id = ?1").bind(ctx.params.id!).first();
  if (!cap) return errorResponse(404, "not_found");

  const id = `caa_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO capability_after_action (id, capability_id, work_card_id, ai_run_id, outcome, note, cost_usd, recorded_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(
      id,
      ctx.params.id!,
      parsed.data.work_card_id ?? null,
      parsed.data.ai_run_id ?? null,
      parsed.data.outcome,
      parsed.data.note,
      parsed.data.cost_usd ?? null,
      ctx.identity!.id,
    )
    .run();
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM capability_after_action WHERE id = ?1").bind(id).first(), { status: 201 });
}

const buildBuySchema = z.object({
  decision: z.enum(["BUILD", "BUY", "DEFER"]),
  vendor: z.string().trim().min(1).optional(),
  cost_estimate_usd: z.number().nonnegative().optional(),
  rationale: z.string().trim().min(1),
});

export async function handleBuildVsBuy(ctx: RouteContext): Promise<Response> {
  const parsed = buildBuySchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") return errorResponse(403, "forbidden", "a build-vs-buy decision is a human decision");
  const authz = await authorize(ctx.env, actor, "build_vs_buy.decide", { objectType: "capability", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return errorResponse(403, "forbidden", authz.reason);

  const cap = await ctx.env.WP_OS_DB.prepare("SELECT id FROM capability WHERE id = ?1").bind(ctx.params.id!).first();
  if (!cap) return errorResponse(404, "not_found");
  if (parsed.data.decision === "BUY" && !parsed.data.vendor) {
    return errorResponse(400, "vendor_required", "a BUY decision must name the vendor");
  }

  const id = `bvb_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO build_vs_buy_decision (id, capability_id, decision, vendor, cost_estimate_usd, rationale, decided_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(id, ctx.params.id!, parsed.data.decision, parsed.data.vendor ?? null, parsed.data.cost_estimate_usd ?? null, parsed.data.rationale, actor.firmUserId!)
    .run();

  await appendEvent(ctx.env, {
    eventType: "build_vs_buy.decided",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "capability",
    objectId: ctx.params.id!,
    payload: { decision: parsed.data.decision, vendor: parsed.data.vendor ?? null },
  });
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM build_vs_buy_decision WHERE id = ?1").bind(id).first(), { status: 201 });
}
