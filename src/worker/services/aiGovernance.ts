import { z } from "zod";
import { legacyCostModeFor, translateLegacyCostMode } from "../../shared/ai/spendLever";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { consumeApprovalCard } from "./approvals";
import { AiRouteError } from "./aiRuns";
import { dailySpendUsd, getLatestBudgetPolicy } from "../ai/runAi";

/**
 * AI provider + budget governance (P4, D8/D9).
 *
 * Provider kill-switch / enable and firmwide budget-policy changes are RESERVED
 * governance actions: every mutation routes through authorize() with
 * governance.policy_change and executes only behind an approved approval-card
 * receipt (P3 mechanism). Nothing here bypasses the choke point; every change
 * appends to the event spine (D15).
 */

interface ProviderRow {
  id: string;
  provider_key: string;
  display_name: string;
  enabled: number;
  kill_switched: number;
  capabilities_json: string;
  cost_metadata_json: string;
  base_url: string | null;
  firm_scope: string;
  created_at: string;
}

function errorResponse(err: unknown): Response {
  if (err instanceof AiRouteError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

async function governedProviderChange(
  env: Env,
  actor: Actor,
  providerKey: string,
  change: "kill_switch" | "enable",
  receiptId: string | undefined,
): Promise<ProviderRow> {
  const provider = await env.WP_OS_DB.prepare("SELECT * FROM provider_registry WHERE provider_key = ?1")
    .bind(providerKey)
    .first<ProviderRow>();
  if (!provider) throw new AiRouteError(404, "not_found");

  const authz = await authorize(
    env,
    actor,
    "governance.policy_change",
    { objectType: "provider_registry", objectId: provider.provider_key, firmScope: provider.firm_scope },
    { receiptId },
  );
  if (authz.decision === "DENY") throw new AiRouteError(403, "forbidden", authz.reason);
  if (authz.decision !== "ALLOW") {
    throw new AiRouteError(409, "approval_required", `provider ${change} requires an approved governance.policy_change receipt (${authz.reason})`);
  }

  if (change === "kill_switch") {
    if (provider.kill_switched === 1) throw new AiRouteError(409, "already_in_state", "provider is already kill-switched");
    await env.WP_OS_DB.prepare("UPDATE provider_registry SET kill_switched = 1 WHERE id = ?1").bind(provider.id).run();
  } else {
    if (provider.enabled === 1 && provider.kill_switched !== 1) {
      throw new AiRouteError(409, "already_in_state", "provider is already enabled");
    }
    // TURNING A LANE BACK ON LIFTS A STAND-DOWN TOO (0185). She can park a lane from a blocked
    // work card; if deliberately enabling it here left `paused_until` in place, the switch would
    // read on and the lane would still be unusable, with nothing on the page explaining why.
    await env.WP_OS_DB.prepare(
      "UPDATE provider_registry SET enabled = 1, kill_switched = 0, paused_until = NULL, paused_reason = NULL, paused_by = NULL WHERE id = ?1",
    )
      .bind(provider.id)
      .run();
  }

  await consumeApprovalCard(env, receiptId!, { actorId: actor.firmUserId! });

  await appendEvent(env, {
    eventType: change === "kill_switch" ? "provider.kill_switched" : "provider.enabled",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "provider_registry",
    objectId: provider.provider_key,
    firmScope: provider.firm_scope,
    payload: { provider_key: provider.provider_key, approval_receipt_id: receiptId },
  });

  return (await env.WP_OS_DB.prepare("SELECT * FROM provider_registry WHERE id = ?1").bind(provider.id).first<ProviderRow>())!;
}

const providerChangeSchema = z.object({
  approval_receipt_id: z.string().trim().min(1).optional(),
});

export async function handleListAiProviders(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare("SELECT * FROM provider_registry ORDER BY provider_key").all<ProviderRow>();
  return json({ providers: rows.results ?? [] });
}

export async function handleProviderKillSwitch(ctx: RouteContext): Promise<Response> {
  const body = await ctx.request.json().catch(() => null);
  const parsed = providerChangeSchema.safeParse(body ?? {});
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const provider = await governedProviderChange(
      ctx.env,
      actorFromIdentity(ctx.identity!),
      ctx.params.key!,
      "kill_switch",
      parsed.data.approval_receipt_id,
    );
    return json(provider);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleProviderEnable(ctx: RouteContext): Promise<Response> {
  const body = await ctx.request.json().catch(() => null);
  const parsed = providerChangeSchema.safeParse(body ?? {});
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const provider = await governedProviderChange(
      ctx.env,
      actorFromIdentity(ctx.identity!),
      ctx.params.key!,
      "enable",
      parsed.data.approval_receipt_id,
    );
    return json(provider);
  } catch (err) {
    return errorResponse(err);
  }
}

// ── Budget policy ──

export async function handleGetAiBudget(ctx: RouteContext): Promise<Response> {
  const firmScope = ctx.identity!.authorityScopes.find((s) => s.scopeKey === "firm_scope")?.scopeValue ?? "west-peek";
  const policy = await getLatestBudgetPolicy(ctx.env, firmScope);
  const spentToday = await dailySpendUsd(ctx.env, firmScope);

  /**
   * Who changed this last, and when. budget_policy is versioned and immutable by trigger, so the
   * history already existed — it was simply never returned, which is why a setting that decides
   * whether the workforce can think at all appeared to have come from nowhere.
   */
  const history = await ctx.env.WP_OS_DB.prepare(
    `SELECT p.id, p.privacy_mode, p.cost_mode, p.created_at, p.set_by,
            u.full_name AS set_by_name
       FROM budget_policy p
       LEFT JOIN firm_user u ON u.id = p.set_by
      WHERE p.firm_scope = ?1
      ORDER BY p.created_at DESC
      LIMIT 10`,
  )
    .bind(firmScope)
    .all<Record<string, unknown>>();

  return json({
    policy,
    today: { spent_usd: spentToday, daily_cap_usd: policy.daily_cap_usd },
    history: history.results ?? [],
  });
}

const surgeSchema = z.object({
  purpose: z.string().trim().min(1),
  owner: z.string().trim().min(1),
  scope: z.string().trim().min(1).optional(),
  budget: z.number().positive(),
  start: z.string().trim().min(1).optional(),
  end: z.string().trim().min(1),
  success_metric: z.string().trim().min(1).optional(),
  kill_condition: z.string().trim().min(1).optional(),
});

const budgetUpdateSchema = z.object({
  /**
   * THE ONE LEVER SHE TOUCHES. Optional, because `cost_mode` below is still accepted from older
   * clients and translated — see the resolution in the handler.
   */
  spend_lever: z.enum(["FREE_ONLY", "MODERATE", "OPEN"]).optional(),
  /**
   * "What work runs at all", which is NOT a spend level and now has its own field. Optional and
   * defaulting to false, so a caller that does not mention it does not accidentally defer the
   * firm's work as a side effect of changing how much it spends.
   */
  defer_non_critical: z.boolean().optional(),
  /**
   * LEGACY, STILL ACCEPTED, NO LONGER CONSULTED BY ROUTING.
   *
   * Anything still sending one of these four values keeps working: the value is TRANSLATED to a
   * lever position (and, for CRITICAL_ONLY, to the separate defer flag) by
   * `translateLegacyCostMode`, rather than being ignored or refused. `spend_lever` wins when both
   * are sent, because an explicit new-world instruction is not ambiguous.
   *
   * Optional now: a caller that sends only `spend_lever` should not have to name a dead field.
   */
  cost_mode: z.enum(["NORMAL", "CHEAPO", "CRITICAL_ONLY", "STRATEGIC_SURGE"]).optional(),
  privacy_mode: z.enum(["LOCAL", "FRONTIER", "LOCKDOWN"]),
  daily_cap_usd: z.number().min(0),
  per_run_cap_usd: z.number().min(0),
  strategic_surge: surgeSchema.nullable().optional(),
  /**
   * Whether a routing pin survives CHEAPO. Only the "free only" posture sets this false, and it is
   * the one setting allowed to override the morning brief's frontier pin. Defaults true so nothing
   * changes for anyone who does not send it.
   */
  honours_pins: z.boolean().default(true),
  /**
   * Which way UNPINNED work leans. Only "best available" sets this true, and it is the whole
   * difference between that posture and "balanced" — without it the two wrote identical rows and a
   * partner who chose to spend more got the cheap behaviour and was told they were on Balanced.
   * Defaults false so nothing changes for anyone who does not send it.
   */
  prefers_frontier: z.boolean().default(false),
  approval_receipt_id: z.string().trim().min(1).optional(),
});

/**
 * Firmwide budget/privacy policy change: a NEW budget_policy row (versioned,
 * immutable by trigger) behind an approved governance.policy_change receipt.
 */
export async function handleUpdateAiBudget(ctx: RouteContext): Promise<Response> {
  const body = await ctx.request.json().catch(() => null);
  const parsed = budgetUpdateSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;
  if (input.spend_lever === undefined && input.cost_mode === undefined) {
    return json({ error: "invalid_input", detail: "say which way the lever goes: spend_lever is one of FREE_ONLY, MODERATE, OPEN" }, { status: 400 });
  }
  if (input.cost_mode === "STRATEGIC_SURGE" && !input.strategic_surge) {
    return json({ error: "invalid_input", detail: "STRATEGIC_SURGE requires a strategic_surge record (purpose/owner/budget/end)" }, { status: 400 });
  }

  /*
   * ── RESOLVING THE TWO WORLDS, AND THE ARROW ONLY POINTS ONE WAY ─────────────────────────────
   *
   * `spend_lever` is the control. `cost_mode` is translated INTO it when that is all a caller sent,
   * and the `cost_mode` actually written to the row is then DERIVED from the resolved lever so the
   * NOT NULL column stays truthful for any reader that has not been migrated.
   *
   * What it is NOT is a second input to routing. Nothing in runAi.ts reads the column any more, and
   * `scripts/validate/one-lever-not-four.mjs` fails the build if anything starts to again — because
   * "four values answering three questions" is not a thing you fix once, it is a thing that grows
   * back the first time somebody needs a fifth behaviour and the enum is right there.
   */
  const legacy = translateLegacyCostMode(input.cost_mode ?? "NORMAL", input.honours_pins, input.prefers_frontier);
  const lever = input.spend_lever ?? legacy.lever;
  const deferNonCritical = input.defer_non_critical ?? (input.spend_lever ? false : legacy.deferNonCritical);
  const costModeToStore = legacyCostModeFor(lever);

  const actor = actorFromIdentity(ctx.identity!);
  const firmScope = actor.firmScopes[0] ?? "west-peek";

  /**
   * A Managing Partner may change this directly. Anyone else still needs an approved receipt.
   *
   * WHY THIS IS NOT A WEAKENING. `governance.policy_change` is reserved to MANAGING_PARTNER, and
   * nothing anywhere requires a DIFFERENT partner to approve it — so the receipt path had the MP
   * raising a card, approving their own card, and then applying it. Three steps, one decision, no
   * second pair of eyes. What that ceremony actually protected against was an AI employee or a
   * non-MP human changing the policy, and the role check alone does all of that.
   *
   * The thing worth keeping was never the card, it was the RECORD: budget_policy is versioned and
   * immutable by trigger, so every change already carries who set it and when. That is now surfaced
   * instead of buried.
   *
   * A second partner reviewing a policy change is a real control and this does not remove the
   * ability to run one — a receipt still applies if supplied, and anyone without the MP role still
   * cannot proceed without one. It stops pretending a self-approval was a review.
   */
  const selfServe = actor.type === "HUMAN" && actor.roles.includes("MANAGING_PARTNER");

  try {
    if (!selfServe) {
      const authz = await authorize(
        ctx.env,
        actor,
        "governance.policy_change",
        { objectType: "budget_policy", objectId: firmScope, firmScope },
        { receiptId: input.approval_receipt_id },
      );
      if (authz.decision === "DENY") throw new AiRouteError(403, "forbidden", authz.reason);
      if (authz.decision !== "ALLOW") {
        throw new AiRouteError(409, "approval_required", `budget policy change requires an approved governance.policy_change receipt (${authz.reason})`);
      }
    }

    const id = `bp_${crypto.randomUUID()}`;
    await ctx.env.WP_OS_DB.prepare(
      `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, strategic_surge_json, honours_pins, prefers_frontier, spend_lever, defer_non_critical, set_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
      .bind(
        id,
        firmScope,
        costModeToStore,
        input.privacy_mode,
        input.daily_cap_usd,
        input.per_run_cap_usd,
        input.strategic_surge ? JSON.stringify(input.strategic_surge) : null,
        input.honours_pins ? 1 : 0,
        input.prefers_frontier ? 1 : 0,
        lever,
        deferNonCritical ? 1 : 0,
        actor.firmUserId!,
      )
      .run();

    // Only consume a receipt when one was actually used. A partner changing this directly has no
    // card, and burning an unrelated one would be worse than not having it.
    if (!selfServe && input.approval_receipt_id) {
      await consumeApprovalCard(ctx.env, input.approval_receipt_id, { actorId: actor.firmUserId! });
    }

    await appendEvent(ctx.env, {
      eventType: "budget_policy.updated",
      actorType: "firm_user",
      actorId: actor.firmUserId!,
      objectType: "budget_policy",
      objectId: id,
      firmScope,
      payload: {
        spend_lever: lever,
        defer_non_critical: deferNonCritical,
        // Recorded when a caller sent one, so "who was still using the old field" is a query.
        legacy_cost_mode_sent: input.cost_mode ?? null,
        legacy_translation: input.spend_lever ? null : legacy.note,
        cost_mode: costModeToStore,
        privacy_mode: input.privacy_mode,
        daily_cap_usd: input.daily_cap_usd,
        per_run_cap_usd: input.per_run_cap_usd,
        approval_receipt_id: input.approval_receipt_id,
      },
    });

    const policy = await ctx.env.WP_OS_DB.prepare("SELECT * FROM budget_policy WHERE id = ?1").bind(id).first();
    return json(policy, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
