import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize } from "./authorize";
import { privacyLabelSchema } from "../../shared/privacy";
import {
  credentialConfigured,
  credentialNameFor,
  credentialSourceName,
  GENERIC_CREDENTIAL_NAME,
} from "../../shared/ai/providerCredentials";
import { directVendorRouteFor } from "../../shared/ai/directVendorRoute";

/**
 * Provider / model router surface (P16, GAP-03).
 *
 * What this exposes, and what it refuses to imply:
 *
 * - The model catalogue with capability, context, latency, and PRICING PROVENANCE. Every price
 *   carries `pricing_state` — the seeded catalogue is ILLUSTRATIVE because that is what the P4
 *   placeholder pricing is. A number is never presented as a current vendor price unless an
 *   operator recorded it as SOURCED with a note and a date.
 * - Credential PRESENCE, never credential values: `credential_configured` is a boolean derived
 *   from the environment. No secret is read, echoed, logged, or returned.
 * - Health checks stamped LOCAL_FIXTURE or LIVE. This runtime can only produce LOCAL_FIXTURE —
 *   it verifies that configuration is coherent, not that a vendor answered.
 * - Routing policies as ordered, versioned, immutable records; the router's decision for each run
 *   is stored on `ai_run_routing` so "why this model?" is answerable from fact.
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

/*
 * WHICH ENV VAR BACKS WHICH PROVIDER — now one name per vendor, and this is a correctness fix
 * rather than a tidy-up.
 *
 * This function used to return `AI_PROVIDER_API_KEY` for every vendor except OpenRouter and
 * Fireworks. One name shared by five companies cannot answer the only question that matters during
 * an outage — "is Anthropic configured?" — it can only answer "is SOMETHING configured?". So the
 * Cockpit was reporting one boolean five times over: green beside OpenAI because a key belonging to
 * somebody else existed. `credential_configured` was wrong for four of five vendors.
 *
 * The map now lives in src/shared/ai/providerCredentials.ts, shared with the router, so the page
 * and the thing that actually makes the call cannot disagree about what is configured.
 */
export { credentialNameFor, credentialConfigured } from "../../shared/ai/providerCredentials";

export async function handleProviderCatalog(ctx: RouteContext): Promise<Response> {
  const providers = (
    await ctx.env.WP_OS_DB.prepare("SELECT * FROM provider_registry ORDER BY provider_key").all<{
      id: string;
      provider_key: string;
      display_name: string;
      enabled: number;
      kill_switched: number;
      base_url: string | null;
    }>()
  ).results ?? [];

  const models = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT m.*, p.provider_key,
              (SELECT s.input_per_mtok_usd FROM provider_pricing_snapshot s
                WHERE s.provider_id = m.provider_id AND s.model = m.model
                ORDER BY s.captured_at DESC LIMIT 1) AS input_per_mtok_usd,
              (SELECT s.output_per_mtok_usd FROM provider_pricing_snapshot s
                WHERE s.provider_id = m.provider_id AND s.model = m.model
                ORDER BY s.captured_at DESC LIMIT 1) AS output_per_mtok_usd
         FROM provider_model m
         JOIN provider_registry p ON p.id = m.provider_id
        ORDER BY p.provider_key, m.model`,
    ).all<Record<string, unknown>>()
  ).results ?? [];

  const policies = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT * FROM provider_data_policy WHERE allowed = 1 ORDER BY provider_id, privacy_label`,
    ).all<{ provider_id: string; privacy_label: string }>()
  ).results ?? [];

  const health = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT h.* FROM provider_health_check h
        WHERE h.created_at = (SELECT MAX(h2.created_at) FROM provider_health_check h2 WHERE h2.provider_id = h.provider_id)`,
    ).all<{ provider_id: string; mode: string; ok: number; latency_ms: number | null; detail: string; created_at: string }>()
  ).results ?? [];

  /*
   * WHEN DID THIS FIRM LAST ACTUALLY FALL BACK?
   *
   * The page could say a provider was configured and could not say whether anything had ever
   * survived that provider failing. A fallback nobody has seen work is not a fallback, so the
   * evidence is served: the last handovers, each naming what failed, what caught it, and when.
   * Read from `ai_run_routing`, which is written by the boundary itself — not from a counter
   * somebody remembers to increment.
   */
  const fallbacks = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT r.ai_run_id, r.selected_provider_key, r.selected_model, r.attempts_json, a.created_at
         FROM ai_run_routing r
         JOIN ai_run a ON a.id = r.ai_run_id
        WHERE r.fallback_used = 1
        ORDER BY a.created_at DESC
        LIMIT 10`,
    ).all<{ ai_run_id: string; selected_provider_key: string | null; selected_model: string | null; attempts_json: string; created_at: string }>()
  ).results ?? [];

  const recentFallbacks = fallbacks.map((f) => {
    let attempts: Array<{ provider_key?: string; model?: string; outcome?: string; detail?: string }> = [];
    try {
      attempts = JSON.parse(f.attempts_json) as typeof attempts;
    } catch {
      attempts = [];
    }
    const handedOn = attempts.find((a) => a.outcome === "FAILED_OVER");
    return {
      ai_run_id: f.ai_run_id,
      at: f.created_at,
      failed: handedOn ? `${handedOn.provider_key}/${handedOn.model}` : null,
      // The classifier's label, ahead of the raw message: AUTH_REJECTED, RATE_LIMITED,
      // VENDOR_ERROR, TIMEOUT_OR_NETWORK, REFUSED_BY_VENDOR, MODEL_NOT_SERVED.
      why: handedOn?.detail?.split(":")[0] ?? null,
      caught_by: `${f.selected_provider_key}/${f.selected_model}`,
      completed: attempts.some((a) => a.outcome === "COMPLETED"),
    };
  });

  return json({
    providers: providers.map((p) => {
      const configured = credentialConfigured(ctx.env, p.provider_key);
      return {
        ...p,
        /** The name THIS vendor's own credential lives under — a binding name where it is one. */
        credential_name: credentialSourceName(p.provider_key),
        credential_configured: configured,
        /*
         * ENABLED IS NOT THE SAME AS AVAILABLE, and conflating them is how a lane reads green and
         * cannot be called. A provider that is switched on with no credential is reported here as
         * unavailable, with the reason, rather than as configured.
         */
        available: p.enabled === 1 && p.kill_switched !== 1 && configured,
        unavailable_reason:
          p.enabled !== 1
            ? "provider is disabled"
            : p.kill_switched === 1
              ? "provider is kill-switched"
              : configured
                ? null
                : `no credential: ${credentialSourceName(p.provider_key)} is not set in this environment`,
        allowed_data_classes: policies.filter((d) => d.provider_id === p.id).map((d) => d.privacy_label),
        latest_health: health.find((h) => h.provider_id === p.id) ?? null,
      };
    }),
    models: models.map((m) => ({
      ...m,
      /*
       * Where an outage on this model would land. Derived from the model id rather than registered,
       * so it cannot drift into a weaker "equivalent": it is the same model at its own vendor.
       */
      direct_fallback: (() => {
        const direct = directVendorRouteFor(String(m.model ?? ""));
        if (!direct) return null;
        return {
          provider_key: direct.providerKey,
          model: direct.model,
          configured: credentialConfigured(ctx.env, direct.providerKey),
        };
      })(),
    })),
    recent_fallbacks: recentFallbacks,
    notes: {
      credentials:
        `credential_configured reports only whether THIS VENDOR'S OWN secret name is populated in this environment. No secret value is read, returned, or logged. A provider whose own name is unset still falls back to the shared ${GENERIC_CREDENTIAL_NAME}, which is why a vendor can be configured without its own name being set.`,
      pricing:
        "pricing_state is the provenance of the number beside it. SOURCED means a vendor figure was read on the date recorded; ILLUSTRATIVE means nobody ever read one, and such a price takes no part in any cost comparison the router makes.",
      health:
        "A LOCAL_FIXTURE check verifies configuration coherence only. It is NOT evidence that the vendor is reachable.",
      egress: "Default deny: a data class not listed under a provider may never egress to it.",
      fallback:
        "recent_fallbacks is read from ai_run_routing, written by the AI boundary itself. An empty list means no run has ever failed over — not that failover is untested; the tests that prove it are tests/aiFallback.test.ts.",
    },
  });
}

const modelSchema = z.object({
  provider_key: z.string().trim().min(1),
  model: z.string().trim().min(1),
  display_name: z.string().trim().min(1),
  capabilities: z.array(z.string().trim().min(1)).default(["text-completion"]),
  context_window: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  supports_tools: z.boolean().default(false),
  supports_reasoning: z.boolean().default(false),
  latency_p50_ms: z.number().int().positive().optional(),
  latency_source: z.enum(["UNKNOWN", "VENDOR_PUBLISHED", "MEASURED_LOCAL", "MEASURED_LIVE"]).default("UNKNOWN"),
  max_data_class: privacyLabelSchema.default("INTERNAL"),
  pricing: z
    .object({
      input_per_mtok_usd: z.number().nonnegative(),
      output_per_mtok_usd: z.number().nonnegative(),
      state: z.enum(["SOURCED", "ILLUSTRATIVE", "STALE", "UNKNOWN"]),
      source_note: z.string().trim().min(1),
      sourced_at: z.string().trim().min(1).optional(),
    })
    .optional(),
});

export async function handleRegisterModel(ctx: RouteContext): Promise<Response> {
  const parsed = modelSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "provider_model.register", { objectType: "provider_model" });
  if (authz.decision !== "ALLOW") return errorResponse(403, "forbidden", authz.reason);

  const body = parsed.data;
  const provider = await ctx.env.WP_OS_DB.prepare("SELECT id FROM provider_registry WHERE provider_key = ?1")
    .bind(body.provider_key)
    .first<{ id: string }>();
  if (!provider) return errorResponse(404, "provider_not_found");

  // A SOURCED price must carry a date. Claiming a price is vendor-sourced without saying when
  // it was read is exactly the kind of claim this system refuses to store.
  if (body.pricing?.state === "SOURCED" && !body.pricing.sourced_at) {
    return errorResponse(400, "sourced_pricing_requires_date", "a SOURCED price must record when it was read");
  }

  const id = `pm_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO provider_model
       (id, provider_id, model, display_name, capabilities_json, context_window, max_output_tokens,
        supports_tools, supports_reasoning, latency_p50_ms, latency_source, max_data_class,
        pricing_state, pricing_source_note, pricing_sourced_at, status, registered_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'BENCH', ?16)
     ON CONFLICT (provider_id, model) DO UPDATE SET
       display_name = excluded.display_name,
       capabilities_json = excluded.capabilities_json,
       context_window = excluded.context_window,
       max_output_tokens = excluded.max_output_tokens,
       supports_tools = excluded.supports_tools,
       supports_reasoning = excluded.supports_reasoning,
       latency_p50_ms = excluded.latency_p50_ms,
       latency_source = excluded.latency_source,
       max_data_class = excluded.max_data_class,
       pricing_state = excluded.pricing_state,
       pricing_source_note = excluded.pricing_source_note,
       pricing_sourced_at = excluded.pricing_sourced_at`,
  )
    .bind(
      id,
      provider.id,
      body.model,
      body.display_name,
      JSON.stringify(body.capabilities),
      body.context_window ?? null,
      body.max_output_tokens ?? null,
      body.supports_tools ? 1 : 0,
      body.supports_reasoning ? 1 : 0,
      body.latency_p50_ms ?? null,
      body.latency_source,
      body.max_data_class,
      body.pricing?.state ?? "UNKNOWN",
      body.pricing?.source_note ?? "",
      body.pricing?.sourced_at ?? null,
      ctx.identity!.id,
    )
    .run();

  if (body.pricing) {
    await ctx.env.WP_OS_DB.prepare(
      "INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, captured_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
      .bind(
        `pps_${crypto.randomUUID()}`,
        provider.id,
        body.model,
        body.pricing.input_per_mtok_usd,
        body.pricing.output_per_mtok_usd,
        body.pricing.sourced_at ?? new Date().toISOString(),
      )
      .run();
  }

  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM provider_model WHERE provider_id = ?1 AND model = ?2")
    .bind(provider.id, body.model)
    .first();
  return json(row, { status: 201 });
}

const promoteSchema = z.object({
  status: z.enum(["ACTIVE", "BENCH", "DEPRECATED"]),
  reason: z.string().trim().min(1),
  /**
   * Required to promote a model whose price nobody has read. Not a formality: ACTIVE is what makes
   * a model selectable, and price is what orders the selectable ones, so promoting on a placeholder
   * number is how a guess becomes the firm's default. Saying so out loud makes it a decision on the
   * record instead of a default nobody noticed.
   */
  price_unread_acknowledged: z.boolean().default(false),
});

export async function handlePromoteModel(ctx: RouteContext): Promise<Response> {
  const parsed = promoteSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "provider_model.promote", { objectType: "provider_model", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return errorResponse(403, "forbidden", authz.reason);

  const model = await ctx.env.WP_OS_DB.prepare("SELECT * FROM provider_model WHERE id = ?1")
    .bind(ctx.params.id!)
    .first<{ id: string; model: string; status: string; pricing_state: string }>();
  if (!model) return errorResponse(404, "not_found");

  // Promotion to ACTIVE requires an evaluation on record. A model becomes the firm's default for
  // a task only after somebody measured something and said how they measured it.
  if (parsed.data.status === "ACTIVE") {
    const evaluated = await ctx.env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM model_evaluation WHERE provider_model_id = ?1")
      .bind(model.id)
      .first<{ n: number }>();
    if ((evaluated?.n ?? 0) === 0) {
      return errorResponse(
        409,
        "evaluation_required",
        "promote to ACTIVE only with at least one recorded evaluation; record one (with its method) first",
      );
    }
    /*
     * A PLACEHOLDER PRICE MAY NOT QUIETLY BECOME THE FIRM'S DEFAULT.
     *
     * runAi keeps an unread price out of every cost comparison, which is the structural half. This
     * is the other half, at the door where models become selectable at all: promoting a model whose
     * `pricing_state` is ILLUSTRATIVE or UNKNOWN takes an explicit acknowledgement, and the
     * acknowledgement is stored on the event. Migration 0158 needed neither, and a single seeded
     * row re-elected an unsuitable model for every unpinned call in the firm.
     */
    if (
      (model.pricing_state === "ILLUSTRATIVE" || model.pricing_state === "UNKNOWN") &&
      !parsed.data.price_unread_acknowledged
    ) {
      return errorResponse(
        409,
        "price_never_read",
        `this model's price is ${model.pricing_state} — nobody has read a figure from the vendor. Source a price first, or promote with price_unread_acknowledged: true and say why in the reason. Until a price is read it takes no part in any cost comparison, so this model will only ever run when something names it explicitly.`,
      );
    }
  }

  await ctx.env.WP_OS_DB.prepare("UPDATE provider_model SET status = ?2 WHERE id = ?1").bind(model.id, parsed.data.status).run();
  await appendEvent(ctx.env, {
    eventType: "provider_model.status_changed",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "provider_model",
    objectId: model.id,
    payload: {
      from: model.status,
      to: parsed.data.status,
      reason: parsed.data.reason,
      pricing_state: model.pricing_state,
      price_unread_acknowledged: parsed.data.price_unread_acknowledged,
    },
  });
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM provider_model WHERE id = ?1").bind(model.id).first());
}

/**
 * Provider health check. In this runtime the only honest mode is LOCAL_FIXTURE: it asserts that
 * the provider row exists, is enabled, is not kill-switched, has a base URL, has at least one
 * priced model, and reports whether its credential NAME is populated. It never contacts a vendor.
 */
export async function handleProviderHealthCheck(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "provider_health.check", { objectType: "provider_registry", objectId: ctx.params.key! });
  if (authz.decision !== "ALLOW") return errorResponse(403, "forbidden", authz.reason);

  const provider = await ctx.env.WP_OS_DB.prepare("SELECT * FROM provider_registry WHERE provider_key = ?1")
    .bind(ctx.params.key!)
    .first<{ id: string; provider_key: string; enabled: number; kill_switched: number; base_url: string | null }>();
  if (!provider) return errorResponse(404, "not_found");

  const priced = await ctx.env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM provider_pricing_snapshot WHERE provider_id = ?1")
    .bind(provider.id)
    .first<{ n: number }>();
  const hasCredential = credentialConfigured(ctx.env, provider.provider_key);

  const problems: string[] = [];
  if (provider.enabled !== 1) problems.push("provider is disabled");
  if (provider.kill_switched === 1) problems.push("provider is kill-switched");
  if (!provider.base_url) problems.push("no base URL configured");
  if ((priced?.n ?? 0) === 0) problems.push("no pricing snapshot recorded");
  if (!hasCredential) problems.push(`credential ${credentialNameFor(provider.provider_key)} is not configured in this environment`);

  const ok = problems.length === 0;
  const detail = ok
    ? "LOCAL_FIXTURE: configuration is coherent. This is NOT evidence that the vendor is reachable. No request was made."
    : `LOCAL_FIXTURE: ${problems.join("; ")}. No request was made.`;

  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO provider_health_check (id, provider_id, mode, ok, latency_ms, detail, checked_by) VALUES (?1, ?2, 'LOCAL_FIXTURE', ?3, NULL, ?4, ?5)",
  )
    .bind(`phc_${crypto.randomUUID()}`, provider.id, ok ? 1 : 0, detail, ctx.identity!.id)
    .run();

  return json({ provider_key: provider.provider_key, mode: "LOCAL_FIXTURE", ok, detail, problems }, { status: 201 });
}

const evaluationSchema = z.object({
  task_class: z.string().trim().min(1),
  method: z.enum(["FIXTURE", "OFFLINE_DETERMINISTIC", "LIVE"]),
  score: z.number(),
  sample_size: z.number().int().nonnegative().default(0),
  notes: z.string().trim().min(1),
  /** Required for LIVE: the run that proves the vendor call happened. Verified, not trusted. */
  ai_run_id: z.string().trim().min(1).optional(),
});

export async function handleRecordEvaluation(ctx: RouteContext): Promise<Response> {
  const parsed = evaluationSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "model_evaluation.record", { objectType: "provider_model", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return errorResponse(403, "forbidden", authz.reason);

  const model = await ctx.env.WP_OS_DB.prepare("SELECT id FROM provider_model WHERE id = ?1").bind(ctx.params.id!).first();
  if (!model) return errorResponse(404, "not_found");

  // A LIVE evaluation asserts a real vendor call happened, so it has to point at the one it means.
  //
  // This used to be refused outright, on the grounds that no provider credential existed and the
  // record would therefore be false. That reasoning expired: OpenRouter is configured and real
  // calls happen daily, so the refusal had stopped protecting anything and started blocking the
  // honest case. Verifying the cited run is strictly stronger than refusing the method — the claim
  // becomes checkable by anyone reading the audit trail rather than taken on trust.
  if (parsed.data.method === "LIVE") {
    if (!parsed.data.ai_run_id) {
      return errorResponse(400, "evidence_required", "a LIVE evaluation must cite the ai_run_id of the call it is based on");
    }
    const evidence = await ctx.env.WP_OS_DB.prepare(
      `SELECT r.id, r.status, m.id AS model_row
         FROM ai_run r
         LEFT JOIN provider_model m ON m.model = r.model
        WHERE r.id = ?1`,
    )
      .bind(parsed.data.ai_run_id)
      .first<{ id: string; status: string; model_row: string | null }>();

    if (!evidence) return errorResponse(404, "unknown_run", `no ai_run ${parsed.data.ai_run_id} — a LIVE claim must cite a real call`);
    if (evidence.status !== "COMPLETED") {
      return errorResponse(409, "run_did_not_complete", `ai_run ${parsed.data.ai_run_id} ended ${evidence.status}; a run that did not complete proves nothing`);
    }
    // The run must be ON the model being evaluated. Citing someone else's good run is the exact
    // way a fabricated evaluation would look, and it is cheap to rule out.
    if (evidence.model_row !== ctx.params.id!) {
      return errorResponse(409, "evidence_model_mismatch", "the cited run was not made on the model being evaluated");
    }
  }

  const id = `mev_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO model_evaluation (id, provider_model_id, task_class, method, score, sample_size, notes, evaluated_by, ai_run_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  )
    .bind(id, ctx.params.id!, parsed.data.task_class, parsed.data.method, parsed.data.score, parsed.data.sample_size, parsed.data.notes, ctx.identity!.id, parsed.data.ai_run_id ?? null)
    .run();
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM model_evaluation WHERE id = ?1").bind(id).first(), { status: 201 });
}

const routingSchema = z.object({
  task_class: z.string().trim().min(1),
  candidates: z
    .array(z.object({ provider_key: z.string().trim().min(1), model: z.string().trim().min(1) }))
    .min(1),
  require_capability: z.string().trim().min(1).default("text-completion"),
  max_data_class: privacyLabelSchema.default("INTERNAL"),
  allow_fallback: z.boolean().default(true),
  notes: z.string().trim().default(""),
});

export async function handleSetRoutingPolicy(ctx: RouteContext): Promise<Response> {
  const parsed = routingSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "routing_policy.set", { objectType: "routing_policy" });
  if (authz.decision !== "ALLOW") return errorResponse(403, "forbidden", authz.reason);

  // Every named candidate must exist in the catalogue: a policy cannot route to a model the
  // firm has never registered.
  for (const c of parsed.data.candidates) {
    const hit = await ctx.env.WP_OS_DB.prepare(
      `SELECT m.id FROM provider_model m JOIN provider_registry p ON p.id = m.provider_id
        WHERE p.provider_key = ?1 AND m.model = ?2`,
    )
      .bind(c.provider_key, c.model)
      .first();
    if (!hit) return errorResponse(404, "unknown_candidate", `${c.provider_key}/${c.model} is not in the model catalogue`);
  }

  const current = await ctx.env.WP_OS_DB.prepare("SELECT MAX(version_no) AS v FROM routing_policy WHERE task_class = ?1")
    .bind(parsed.data.task_class)
    .first<{ v: number | null }>();
  const version = (current?.v ?? 0) + 1;
  const id = `rpol_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO routing_policy (id, task_class, version_no, candidates_json, require_capability, max_data_class, allow_fallback, notes, set_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      id,
      parsed.data.task_class,
      version,
      JSON.stringify(parsed.data.candidates),
      parsed.data.require_capability,
      parsed.data.max_data_class,
      parsed.data.allow_fallback ? 1 : 0,
      parsed.data.notes,
      ctx.identity!.id,
    )
    .run();

  await appendEvent(ctx.env, {
    eventType: "routing_policy.set",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "routing_policy",
    objectId: id,
    payload: { task_class: parsed.data.task_class, version_no: version, candidates: parsed.data.candidates },
  });
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM routing_policy WHERE id = ?1").bind(id).first(), { status: 201 });
}

export async function handleListRoutingPolicies(ctx: RouteContext): Promise<Response> {
  const rows = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT r.* FROM routing_policy r
        WHERE r.version_no = (SELECT MAX(r2.version_no) FROM routing_policy r2 WHERE r2.task_class = r.task_class)
        ORDER BY r.task_class`,
    ).all()
  ).results ?? [];
  return json({
    policies: rows,
    note: "A task class with no policy uses the P4 default: cheapest priced capable model, one attempt, no fallback.",
  });
}

const machinePolicySchema = z.object({
  preferred_provider_key: z.string().trim().min(1).nullable().optional(),
  preferred_model: z.string().trim().min(1).nullable().optional(),
  max_data_class: privacyLabelSchema.default("INTERNAL"),
  notes: z.string().trim().default(""),
});

export async function handleSetMachineModelPolicy(ctx: RouteContext): Promise<Response> {
  const parsed = machinePolicySchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "machine_model_policy.set", { objectType: "machine", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return errorResponse(403, "forbidden", authz.reason);

  const machineId = Number(ctx.params.id!);
  const machine = await ctx.env.WP_OS_DB.prepare("SELECT id FROM machine WHERE id = ?1").bind(machineId).first();
  if (!machine) return errorResponse(404, "machine_not_found");

  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO machine_model_policy (machine_id, preferred_provider_key, preferred_model, max_data_class, notes, set_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (machine_id) DO UPDATE SET
       preferred_provider_key = excluded.preferred_provider_key,
       preferred_model = excluded.preferred_model,
       max_data_class = excluded.max_data_class,
       notes = excluded.notes,
       set_by = excluded.set_by,
       updated_at = excluded.updated_at`,
  )
    .bind(
      machineId,
      parsed.data.preferred_provider_key ?? null,
      parsed.data.preferred_model ?? null,
      parsed.data.max_data_class,
      parsed.data.notes,
      ctx.identity!.id,
      new Date().toISOString(),
    )
    .run();
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM machine_model_policy WHERE machine_id = ?1").bind(machineId).first(), { status: 201 });
}

/** Why did a given run choose the model it chose? Answered from the stored record. */
export async function handleGetRunRouting(ctx: RouteContext): Promise<Response> {
  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM ai_run_routing WHERE ai_run_id = ?1").bind(ctx.params.id!).first();
  if (!row) return errorResponse(404, "not_found", "no routing record for this run");
  const attribution = await ctx.env.WP_OS_DB.prepare("SELECT * FROM ai_run_attribution WHERE ai_run_id = ?1").bind(ctx.params.id!).first();
  return json({ routing: row, attribution });
}
