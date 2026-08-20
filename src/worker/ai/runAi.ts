import type { Env } from "../env";
import { appendEvent } from "../events";
import type { Actor } from "../services/authorize";
import type { PrivacyLabel } from "../../shared/privacy";
import { createMockLocalAdapter, MOCK_LOCAL_MODEL } from "./providers/mockLocal";
import type { ProviderAdapter } from "./providers/types";
import { redactInputs, scrubInputs } from "./scrub";
import {
  adapterFor,
  checkScopedBudgets,
  latestRoutingPolicy,
  orderByPolicy,
  raiseCostAlert,
  recordAttribution,
  recordRouting,
  type RoutingCandidate,
} from "./routing";

/**
 * runAi — THE governed AI boundary (P4). No other module may call a provider
 * (enforced by scripts/validate/no-direct-provider-calls.mjs).
 *
 * Pipeline (fail closed at every step; EVERY run — including blocked ones —
 * lands in ai_run with a trace_id, a cost estimate, and a visible reason):
 *
 *   1. cost-mode gate (CRITICAL_ONLY defers non-critical purposes),
 *   2. credential scrub (secret-shaped input → EGRESS_BLOCKED; nothing with
 *      credentials ever enters LLM context, local or external),
 *   3. privacy-mode resolution (D8): LOCKDOWN/LOCAL → deterministic local
 *      adapter only; FRONTIER → external allowed only for labels the
 *      provider_data_policy allows (default-deny),
 *   4. provider availability: globally disabled → PROVIDER_DISABLED;
 *      kill-switched → KILL_SWITCHED,
 *   5. cost preflight against provider_pricing_snapshot + budget_policy caps
 *      (per-run and daily; STRATEGIC_SURGE lifts caps only inside an unexpired,
 *      fully-specified surge record; expired/invalid surge → NORMAL),
 *   6. adapter call (mockLocal | httpExternal — never a real vendor in tests),
 *   7. output quarantine: external outputs land quarantined until a human
 *      accept step; local outputs are unquarantined,
 *   8. provider failure → BLOCKED_DEFERRED with the reason visible (never
 *      silently discarded); the deterministic app is unaffected.
 */

export const AI_RUN_STATUSES = [
  "PREFLIGHT_BLOCKED",
  "BUDGET_BLOCKED",
  "EGRESS_BLOCKED",
  "KILL_SWITCHED",
  "PROVIDER_DISABLED",
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "BLOCKED_DEFERRED",
] as const;

export type AIRunStatus = (typeof AI_RUN_STATUSES)[number];

export type PrivacyMode = "LOCAL" | "FRONTIER" | "LOCKDOWN";
export type CostMode = "NORMAL" | "CHEAPO" | "CRITICAL_ONLY" | "STRATEGIC_SURGE";

export interface AIRunRow {
  id: string;
  purpose: string;
  actor_type: string;
  actor_id: string;
  ai_employee_id: string | null;
  capability_requirement: string | null;
  sensitivity: string;
  privacy_mode: string;
  cost_mode: string;
  provider_id: string | null;
  model: string | null;
  status: AIRunStatus;
  cost_estimate_json: string;
  actual_usage_json: string | null;
  input_hash: string;
  output_quarantine: number;
  output_text: string | null;
  trace_id: string;
  failure_reason: string | null;
  firm_scope: string;
  created_at: string;
  completed_at: string | null;
}

export interface RunAiBudgetContext {
  /** Marks the purpose critical (risk/deadline/LP/IC/deal/compliance class work). */
  critical?: boolean;
  expectedInputTokens?: number;
  expectedOutputTokens?: number;
  /** NORMAL-mode model preference (CHEAPO overrides with cheapest adequate). */
  preferredModel?: string;
  /** Pin a specific provider by provider_key. */
  providerKey?: string;
}

/**
 * P16 routing/attribution context. All optional: a call that supplies none of it behaves
 * exactly as it did at P4 — cheapest priced capable model, one attempt, no fallback.
 */
export interface RunAiRoutingContext {
  /** Names a routing policy (`routing_policy.task_class`). Absent → legacy selection. */
  taskClass?: string;
  /** Machine this work belongs to — drives machine model policy and machine budgets. */
  machineId?: number;
  /** Work card this run serves, for cost attribution. */
  workCardId?: string;
  /** Spend category for category budgets and the cost centre's breakdown. */
  category?: "PROACTIVE" | "RESEARCH" | "LEGAL" | "COMPLIANCE" | "OPERATIONS" | "INTELLIGENCE" | "OTHER";
}

export interface RunAiInput {
  purpose: string;
  actor: Actor;
  inputs: string[];
  /**
   * Images for vision work. Optional, and deliberately routed through this boundary rather than
   * around it — see the gate in the pipeline below for why that is not a formality.
   */
  images?: RunAiImage[];
  sensitivity: PrivacyLabel;
  capabilityRequirement?: string;
  budgetContext?: RunAiBudgetContext;
  /** AI employee id when an AI employee is the actor (later phases). */
  aiEmployeeId?: string;
  /** P16 routing/attribution. Optional; absence preserves P4 behaviour exactly. */
  routing?: RunAiRoutingContext;
  /**
   * What to do when the input looks like it contains a credential.
   *
   * "block" is the default and the behaviour everything had before this existed: the run is
   * refused. Use "redact" ONLY for input the firm did not author and cannot correct — gathered
   * third-party text, where a false positive costs a day's output and fixing the source is not
   * available to anybody here. The secret never reaches a provider under either setting; what
   * differs is whether a suspicious span or the whole run is discarded.
   */
  onCredentialLike?: "block" | "redact";
}

export interface RunAiImage {
  mediaType: string;
  dataBase64: string;
  label: string;
}

/**
 * Images cost tokens, and a lot of them.
 *
 * A screenshot at 1440×900 runs to roughly this many input tokens on the models that can see. It is
 * an approximation and it is deliberately generous: the budget check exists to stop a run that
 * would be expensive, and under-estimating an image would let exactly that run through.
 */
const TOKENS_PER_IMAGE = 1_200;

/**
 * The most images one run may carry.
 *
 * Two viewports of one page is the real case. A run trying to send twenty screenshots is either a
 * mistake or a way to spend a lot of money in one call, and neither should be possible by accident.
 */
const MAX_IMAGES_PER_RUN = 4;

/**
 * Models known to actually accept images.
 *
 * Maintained by hand and deliberately so. The provider registry has no vision concept — every model
 * in it declares `text-completion` and nothing else — so there is nothing to derive this from, and
 * inferring it from the model name would let anything through that happened to be spelled right.
 *
 * The consequence of an omission is a blocked run with the model named in the reason, which is the
 * right direction to fail: a missing entry is a five-second fix, and a wrong entry is a design
 * review of a page the model never saw.
 */
const VISION_CAPABLE_MODELS: ReadonlySet<string> = new Set([
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-4",
  "openai/gpt-5",
  "openai/gpt-4o",
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
]);

export interface RunAiDeps {
  /** Injected into the external adapter — tests ALWAYS pass a stub. */
  fetchImpl?: typeof fetch;
  /** Clock override for surge-expiry testing. */
  now?: Date;
}

export interface AIRunResult {
  run: AIRunRow;
}

export class RunAiError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

// ── Policy loading ──

export interface BudgetPolicyRow {
  id: string;
  firm_scope: string;
  cost_mode: CostMode;
  /**
   * Whether a routing pin survives CHEAPO. 0 only under the "free only" posture, which is the one
   * setting allowed to override the brief's frontier pin — see the routing branch below.
   */
  honours_pins?: number;
  privacy_mode: PrivacyMode;
  daily_cap_usd: number;
  per_run_cap_usd: number;
  strategic_surge_json: string | null;
  set_by: string;
  created_at: string;
}

/** Fail-closed default when no policy row exists: LOCKDOWN, zero caps. */
const FAIL_CLOSED_POLICY: Omit<BudgetPolicyRow, "id" | "firm_scope" | "set_by" | "created_at"> = {
  cost_mode: "NORMAL",
  privacy_mode: "LOCKDOWN",
  daily_cap_usd: 0,
  per_run_cap_usd: 0,
  strategic_surge_json: null,
};

export async function getLatestBudgetPolicy(env: Env, firmScope: string): Promise<BudgetPolicyRow> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT * FROM budget_policy WHERE firm_scope = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1",
  )
    .bind(firmScope)
    .first<BudgetPolicyRow>();
  if (row) return row;
  return {
    id: "bp_fail_closed",
    firm_scope: firmScope,
    set_by: "system",
    created_at: "",
    ...FAIL_CLOSED_POLICY,
  };
}

export interface StrategicSurge {
  purpose: string;
  owner: string;
  budget: number;
  scope?: string;
  start?: string;
  end?: string;
  success_metric?: string;
  kill_condition?: string;
}

/**
 * Resolve the effective cost mode. A STRATEGIC_SURGE policy applies only while an
 * unexpired, fully-specified surge record exists (purpose + owner + budget + end);
 * an expired or malformed surge is treated as NORMAL (fail closed).
 */
export function resolveEffectiveCostMode(
  policy: BudgetPolicyRow,
  now: Date,
): { mode: CostMode; surge: StrategicSurge | null } {
  if (policy.cost_mode !== "STRATEGIC_SURGE" || !policy.strategic_surge_json) {
    return { mode: policy.cost_mode, surge: null };
  }
  let surge: Partial<StrategicSurge>;
  try {
    surge = JSON.parse(policy.strategic_surge_json) as Partial<StrategicSurge>;
  } catch {
    return { mode: "NORMAL", surge: null };
  }
  const end = surge.end ? new Date(surge.end) : null;
  const complete =
    typeof surge.purpose === "string" &&
    surge.purpose.length > 0 &&
    typeof surge.owner === "string" &&
    surge.owner.length > 0 &&
    typeof surge.budget === "number" &&
    surge.budget > 0 &&
    end !== null &&
    !Number.isNaN(end.getTime());
  if (!complete || !end || end.getTime() <= now.getTime()) {
    return { mode: "NORMAL", surge: null };
  }
  return { mode: "STRATEGIC_SURGE", surge: surge as StrategicSurge };
}

const CRITICAL_PURPOSE = /critical|risk|deadline|\blp\b|\bic\b|deal|compliance/i;

export function isCriticalPurpose(purpose: string, budgetContext?: RunAiBudgetContext): boolean {
  return budgetContext?.critical === true || CRITICAL_PURPOSE.test(purpose);
}

// ── Provider selection ──

interface ProviderRow {
  id: string;
  provider_key: string;
  display_name: string;
  enabled: number;
  kill_switched: number;
  capabilities_json: string;
  cost_metadata_json: string;
  base_url: string | null;
}

interface PricingRow {
  provider_id: string;
  model: string;
  input_per_mtok_usd: number;
  output_per_mtok_usd: number;
}

interface ModelOption {
  provider: ProviderRow;
  pricing: PricingRow;
}

async function dataPolicyAllows(env: Env, providerId: string, label: string): Promise<boolean> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT allowed FROM provider_data_policy WHERE provider_id = ?1 AND privacy_label = ?2",
  )
    .bind(providerId, label)
    .first<{ allowed: number }>();
  // DEFAULT DENY: no allowing row → denied.
  return row?.allowed === 1;
}

async function latestPricing(env: Env, providerIds: string[]): Promise<PricingRow[]> {
  if (providerIds.length === 0) return [];
  const placeholders = providerIds.map((_, i) => `?${i + 1}`).join(", ");
  const rows = await env.WP_OS_DB.prepare(
    `SELECT p.provider_id, p.model, p.input_per_mtok_usd, p.output_per_mtok_usd
       FROM provider_pricing_snapshot p
      WHERE p.provider_id IN (${placeholders})
        AND p.captured_at = (
          SELECT MAX(p2.captured_at) FROM provider_pricing_snapshot p2
           WHERE p2.provider_id = p.provider_id AND p2.model = p.model
        )`,
  )
    .bind(...providerIds)
    .all<PricingRow>();
  return rows.results ?? [];
}

// ── Spend accounting ──

interface CostEstimate {
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  provider_key: string | null;
  model: string | null;
  input_per_mtok_usd: number | null;
  output_per_mtok_usd: number | null;
  surge_applied: boolean;
}

/** Today's committed spend (actual where known, else estimate) for a firm scope. */
export async function dailySpendUsd(env: Env, firmScope: string): Promise<number> {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT cost_estimate_json, actual_usage_json
       FROM ai_run
      WHERE firm_scope = ?1
        AND date(created_at) = date('now')
        AND status IN ('QUEUED','RUNNING','COMPLETED')`,
  )
    .bind(firmScope)
    .all<{ cost_estimate_json: string; actual_usage_json: string | null }>();
  let total = 0;
  for (const row of rows.results ?? []) {
    let cost = 0;
    if (row.actual_usage_json) {
      try {
        cost = (JSON.parse(row.actual_usage_json) as { cost_usd?: number }).cost_usd ?? 0;
      } catch {
        cost = 0;
      }
    } else {
      try {
        cost = (JSON.parse(row.cost_estimate_json) as { estimated_cost_usd?: number }).estimated_cost_usd ?? 0;
      } catch {
        cost = 0;
      }
    }
    total += cost;
  }
  return total;
}

// ── Run recording ──

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function actorTypeForEvent(actor: Actor): "firm_user" | "ai_employee" | "system" {
  return actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system";
}

function actorIdOf(actor: Actor): string {
  return actor.firmUserId ?? actor.aiEmployeeId ?? "system";
}

interface RunRecordInput {
  input: RunAiInput;
  firmScope: string;
  privacyMode: PrivacyMode;
  costMode: CostMode;
  providerId: string | null;
  /** Provider key for the routing record; the run row itself stores provider_id. */
  providerKey?: string | null;
  model: string | null;
  status: AIRunStatus;
  estimate: CostEstimate;
  inputHash: string;
  traceId: string;
  runId: string;
  failureReason?: string;
}

async function insertRun(env: Env, rec: RunRecordInput): Promise<AIRunRow> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO ai_run
       (id, purpose, actor_type, actor_id, ai_employee_id, capability_requirement, sensitivity,
        privacy_mode, cost_mode, provider_id, model, status, cost_estimate_json, input_hash,
        trace_id, failure_reason, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
  )
    .bind(
      rec.runId,
      rec.input.purpose,
      rec.input.actor.type,
      actorIdOf(rec.input.actor),
      rec.input.aiEmployeeId ?? null,
      rec.input.capabilityRequirement ?? null,
      rec.input.sensitivity,
      rec.privacyMode,
      rec.costMode,
      rec.providerId,
      rec.model,
      rec.status,
      JSON.stringify(rec.estimate),
      rec.inputHash,
      rec.traceId,
      rec.failureReason ?? null,
      rec.firmScope,
    )
  .run();
  return (await env.WP_OS_DB.prepare("SELECT * FROM ai_run WHERE id = ?1").bind(rec.runId).first<AIRunRow>())!;
}

async function recordBlockedRun(env: Env, rec: RunRecordInput): Promise<AIRunRow> {
  const row = await insertRun(env, rec);
  await appendEvent(env, {
    eventType: "ai_run.blocked",
    actorType: actorTypeForEvent(rec.input.actor),
    actorId: actorIdOf(rec.input.actor),
    objectType: "ai_run",
    objectId: row.id,
    firmScope: rec.firmScope,
    payload: { status: rec.status, reason: rec.failureReason ?? null, trace_id: rec.traceId, purpose: rec.input.purpose },
  });
  return row;
}

/**
 * Execute one or more candidate providers for a run already decided as executable.
 *
 * One `ai_run` row is written regardless of how many candidates are tried: a run is one unit of
 * governed work, and the attempts are recorded on `ai_run_routing` instead of multiplying runs.
 * Candidates after the first are only supplied when a routing policy explicitly allows fallback.
 */
async function executeRun(
  env: Env,
  rec: RunRecordInput,
  adapter: ProviderAdapter,
  quarantine: boolean,
  fallbacks: Array<{ candidate: RoutingCandidate; adapter: ProviderAdapter }> = [],
  attempts: Array<{ provider_key: string; model: string; outcome: string; detail?: string }> = [],
): Promise<AIRunRow> {
  const running = await insertRun(env, { ...rec, status: "RUNNING" });
  return executeAttempt(env, rec, running.id, adapter, quarantine, fallbacks, attempts);
}

/** One provider attempt against an ai_run row that already exists. */
async function executeAttempt(
  env: Env,
  rec: RunRecordInput,
  runId: string,
  adapter: ProviderAdapter,
  quarantine: boolean,
  fallbacks: Array<{ candidate: RoutingCandidate; adapter: ProviderAdapter }> = [],
  attempts: Array<{ provider_key: string; model: string; outcome: string; detail?: string }> = [],
): Promise<AIRunRow> {
  const running = { id: runId };
  try {
    const response = await adapter.complete({
      purpose: rec.input.purpose,
      inputs: rec.input.inputs,
      ...(rec.input.images?.length ? { images: rec.input.images } : {}),
      model: rec.model,
      capabilityRequirement: rec.input.capabilityRequirement,
    });
    // WHAT THE RUN ACTUALLY COST, priced locally when the provider will not say.
    //
    // Every completed run was recording cost_usd: 0, because OpenRouter only returns a cost when
    // asked and nobody was asking. The consequence was not cosmetic: spend-to-date is summed from
    // this field, so "spent today" was permanently zero and the firm's daily cap could never fire.
    // The only ceiling actually in force was the per-run one.
    //
    // The provider's own figure is preferred — it is the real bill. Falling back to the catalogue
    // rate on the planned model is an approximation, and on a run that fell back to a DIFFERENT
    // model it prices the tokens at the planned model's rate. That is a knowable inaccuracy and it
    // is still far better than recording nothing spent, because no run is free.
    const pricedLocally =
      (response.usage.inputTokens * (rec.estimate.input_per_mtok_usd ?? 0) +
        response.usage.outputTokens * (rec.estimate.output_per_mtok_usd ?? 0)) /
      1_000_000;
    const costUsd = response.usage.costUsd > 0 ? response.usage.costUsd : pricedLocally;

    const actualUsage = {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
      cost_usd: costUsd,
      /** Whether the number above is the provider's bill or our own arithmetic. */
      cost_source: response.usage.costUsd > 0 ? "provider" : "catalogue_rate",
      model: response.model,
    };
    await env.WP_OS_DB.prepare(
      `UPDATE ai_run
          SET status = 'COMPLETED', actual_usage_json = ?2, output_text = ?3,
              output_quarantine = ?4, completed_at = ?5
        WHERE id = ?1`,
    )
      .bind(running.id, JSON.stringify(actualUsage), response.text, quarantine ? 1 : 0, new Date().toISOString())
      .run();
    attempts.push({ provider_key: rec.providerKey ?? "local", model: response.model, outcome: "COMPLETED" });
    await appendEvent(env, {
      eventType: "ai_run.completed",
      actorType: actorTypeForEvent(rec.input.actor),
      actorId: actorIdOf(rec.input.actor),
      objectType: "ai_run",
      objectId: running.id,
      firmScope: rec.firmScope,
      payload: {
        trace_id: rec.traceId,
        purpose: rec.input.purpose,
        provider_id: rec.providerId,
        model: response.model,
        output_quarantine: quarantine,
        cost_usd: costUsd,
      },
    });
  } catch (err) {
    // Manual fallback: provider failure is visible, never silently discarded (§3.5).
    const reason = err instanceof Error ? err.message : String(err);
    attempts.push({ provider_key: rec.providerKey ?? "unknown", model: rec.model ?? "unknown", outcome: "FAILED", detail: reason });

    // Policy-authorized fallback: retry the NEXT candidate against the same run row, so one unit
    // of governed work stays one run. The failed attempt is preserved in the routing record —
    // a fallback never hides a provider failure.
    const next = fallbacks[0];
    if (next) {
      await env.WP_OS_DB.prepare("UPDATE ai_run SET provider_id = ?2, model = ?3 WHERE id = ?1")
        .bind(running.id, next.candidate.providerId, next.candidate.model)
        .run();
      return executeAttempt(
        env,
        { ...rec, providerId: next.candidate.providerId, providerKey: next.candidate.providerKey, model: next.candidate.model },
        running.id,
        next.adapter,
        quarantine,
        fallbacks.slice(1),
        attempts,
      );
    }

    await env.WP_OS_DB.prepare(
      "UPDATE ai_run SET status = 'BLOCKED_DEFERRED', failure_reason = ?2, completed_at = ?3 WHERE id = ?1",
    )
      .bind(running.id, `provider_failure:${reason}`, new Date().toISOString())
      .run();
    await appendEvent(env, {
      eventType: "ai_run.blocked",
      actorType: actorTypeForEvent(rec.input.actor),
      actorId: actorIdOf(rec.input.actor),
      objectType: "ai_run",
      objectId: running.id,
      firmScope: rec.firmScope,
      payload: { status: "BLOCKED_DEFERRED", reason: `provider_failure:${reason}`, trace_id: rec.traceId, purpose: rec.input.purpose },
    });
  }
  return (await env.WP_OS_DB.prepare("SELECT * FROM ai_run WHERE id = ?1").bind(running.id).first<AIRunRow>())!;
}

// ── The boundary ──

/** True when the platform gave this Worker the Workers AI binding — the near-free tier. */
export function workersAiConfigured(env: Env): boolean {
  return Boolean((env as unknown as { AI?: unknown }).AI);
}

export async function runAi(env: Env, input: RunAiInput, deps: RunAiDeps = {}): Promise<AIRunResult> {
  if (!input.purpose || input.purpose.trim().length === 0) {
    throw new RunAiError(400, "invalid_input", "purpose is required");
  }
  if (!Array.isArray(input.inputs) || input.inputs.length === 0) {
    throw new RunAiError(400, "invalid_input", "at least one input is required");
  }

  const now = deps.now ?? new Date();
  const firmScope = input.actor.firmScopes[0] ?? "west-peek";
  const policy = await getLatestBudgetPolicy(env, firmScope);
  const { mode: effectiveCostMode, surge } = resolveEffectiveCostMode(policy, now);

  const traceId = `trc_${crypto.randomUUID()}`;
  const runId = `air_${crypto.randomUUID()}`;
  const inputHash = await sha256Hex(input.inputs.join("\n"));

  const expectedInputTokens =
    input.budgetContext?.expectedInputTokens ??
    // Images are the expensive half of a vision run, and a budget check that cannot see them is
    // checking the cheap part.
    Math.max(1, Math.ceil(input.inputs.join("\n").length / 4)) + (input.images?.length ?? 0) * TOKENS_PER_IMAGE;
  const expectedOutputTokens = input.budgetContext?.expectedOutputTokens ?? 512;

  const baseEstimate: CostEstimate = {
    input_tokens: expectedInputTokens,
    output_tokens: expectedOutputTokens,
    estimated_cost_usd: 0,
    provider_key: null,
    model: null,
    input_per_mtok_usd: null,
    output_per_mtok_usd: null,
    surge_applied: surge !== null,
  };

  /*
   * MUTABLE BECAUSE REDACTION HAPPENS AFTER THIS IS BUILT. The record carries the input that is
   * handed to the provider adapter, and the credential scrub runs further down; leaving this
   * `const` meant a redacting run would have redacted a local copy and sent the original — a
   * safety feature that reported success while doing nothing. It is rebuilt in place there, and
   * `blocked()` closes over the binding rather than the value so it always sees the current one.
   */
  let baseRec: Omit<RunRecordInput, "status" | "estimate" | "failureReason" | "providerId" | "model"> = {
    input,
    firmScope,
    privacyMode: policy.privacy_mode,
    costMode: effectiveCostMode,
    inputHash,
    traceId,
    runId,
  };

  const attribution = {
    machineId: input.routing?.machineId ?? null,
    workCardId: input.routing?.workCardId ?? null,
    category: input.routing?.category ?? "OTHER",
  };

  const blocked = async (
    status: AIRunStatus,
    reason: string,
    estimate: CostEstimate = baseEstimate,
    providerId: string | null = null,
    model: string | null = null,
  ) => {
    const row = await recordBlockedRun(env, { ...baseRec, providerId, model, status, estimate, failureReason: reason });
    // Attribution is recorded for BLOCKED runs too: a run that was refused still tells the cost
    // centre which machine/category is generating refused work.
    await recordAttribution(env, row.id, attribution);
    return row;
  };

  /*
   * 0a. IMAGES — the gate, and it is not a formality.
   *
   * Every control in this pipeline was written for text. The credential scrubber reads strings; a
   * screenshot of a page displaying an API key is, to that scrubber, an opaque blob. So an image
   * cannot be cleared the way a paragraph can, and the only honest position is that images ride the
   * DECLARED sensitivity and nothing else.
   *
   * PUBLIC and INTERNAL only, checked here rather than left to the data policy alone. The data
   * policy would already deny RESTRICTED and above to OpenRouter, and this is the same answer
   * arrived at twice on purpose: a future provider permitted a higher label for text would silently
   * inherit that permission for images, and a screenshot of an LP portal is not the same risk as a
   * sentence about one. Refusing here means adding such a provider cannot quietly widen this.
   *
   * The count cap is a spend control. Two viewports of one page is the real case; twenty
   * screenshots in one call is either a mistake or an expensive accident.
   */
  if (input.images?.length) {
    if (input.sensitivity !== "PUBLIC" && input.sensitivity !== "INTERNAL") {
      return {
        run: await blocked("EGRESS_BLOCKED", `images_not_permitted_at_label:${input.sensitivity}`),
      };
    }
    if (input.images.length > MAX_IMAGES_PER_RUN) {
      return {
        run: await blocked("PREFLIGHT_BLOCKED", `too_many_images:${input.images.length}>${MAX_IMAGES_PER_RUN}`),
      };
    }
    const badType = input.images.find((i) => i.mediaType !== "image/jpeg" && i.mediaType !== "image/png");
    if (badType) {
      return { run: await blocked("PREFLIGHT_BLOCKED", `unsupported_image_type:${badType.mediaType}`) };
    }
  }

  // 0. Machine pause (P17): a paused machine cannot spend AI budget. Checked before anything
  //    else so a paused machine costs nothing, not even an estimate.
  if (attribution.machineId !== null) {
    const machineState = await env.WP_OS_DB.prepare("SELECT status, pause_reason FROM machine_state WHERE machine_id = ?1")
      .bind(attribution.machineId)
      .first<{ status: string; pause_reason: string | null }>();
    if (machineState?.status === "PAUSED") {
      return {
        run: await blocked(
          "PREFLIGHT_BLOCKED",
          `machine_paused:${attribution.machineId}:${machineState.pause_reason ?? "no reason recorded"}`,
        ),
      };
    }
  }

  // 1. Cost-mode gate: CRITICAL_ONLY runs only critical/risk/deadline/LP/IC/deal/
  //    compliance purposes; everything else is deferred, not discarded.
  if (effectiveCostMode === "CRITICAL_ONLY" && !isCriticalPurpose(input.purpose, input.budgetContext)) {
    return { run: await blocked("BLOCKED_DEFERRED", "cost_mode_critical_only:non_critical_purpose") };
  }

  // 2. Credential scrub: no credentials in LLM context, ever.
  //
  // Two ways to honour that. Blocking refuses the run; redacting removes the span and proceeds.
  // Neither lets the matched text reach a provider, and redaction is available only to callers
  // that asked for it — see RunAiInput.onCredentialLike for when that is the right trade.
  let effectiveInputs = input.inputs;
  const scrub = scrubInputs(input.inputs);
  if (scrub.blocked) {
    if (input.onCredentialLike !== "redact") {
      return { run: await blocked("EGRESS_BLOCKED", `credential_like_content:${scrub.matches.join(",")}`) };
    }
    const cut = redactInputs(input.inputs);
    effectiveInputs = cut.inputs;
    // The record is what reaches the adapter. Rebuilding it here is the entire point of redacting.
    baseRec = { ...baseRec, input: { ...input, inputs: effectiveInputs } };
    // Recorded, because altering what a model was shown and not saying so would make the run
    // record a description of a call that did not happen.
    await appendEvent(env, {
      eventType: "ai.input_redacted",
      actorType: "system",
      actorId: "system",
      objectType: "ai_run",
      objectId: input.purpose,
      payload: { purpose: input.purpose, patterns: cut.redacted, spans: cut.count },
    });
    /*
     * BELT AND BRACES. If redaction somehow left something matching, the run is refused as it
     * would have been before. Redaction is a narrowing of the blast radius, never a way past
     * the gate.
     */
    if (scrubInputs(effectiveInputs).blocked) {
      return { run: await blocked("EGRESS_BLOCKED", `credential_like_content:${scrub.matches.join(",")}`) };
    }
  }

  /*
   * 2b. NO MODEL THAT RUNS LOCALLY CAN SEE.
   *
   * LOCKDOWN and LOCAL route to the deterministic offline adapter, which returns canned text. Hand
   * it screenshots and it does not fail — it answers from the prompt, exactly as a text-only
   * frontier model would, and a design review comes back fluent and entirely invented.
   *
   * This is the same failure the vision-capability check below guards against, arriving one step
   * earlier and by a different door: the privacy short-circuit returns before that check is ever
   * reached. Caught by instrumenting the guard and finding it was never executed in a test that
   * completed a run with images attached.
   *
   * REFUSED RATHER THAN DEGRADED. There is no honest text-only version of "look at this page and
   * tell me what is wrong with it", so the run stops and says why. Anyone who needs it can take the
   * firm out of lockdown deliberately.
   */
  if (input.images?.length && (policy.privacy_mode === "LOCKDOWN" || policy.privacy_mode === "LOCAL")) {
    return {
      run: await blocked("PREFLIGHT_BLOCKED", `images_need_a_frontier_model:privacy_mode_${policy.privacy_mode}`),
    };
  }

  // 3. Privacy-mode resolution (D8).
  if (policy.privacy_mode === "LOCKDOWN" || policy.privacy_mode === "LOCAL") {
    // Local/manual path: the deterministic local adapter always works offline.
    const adapter = createMockLocalAdapter();
    const attempts: Array<{ provider_key: string; model: string; outcome: string; detail?: string }> = [];
    const run = await executeRun(
      env,
      { ...baseRec, providerId: null, providerKey: "local", model: MOCK_LOCAL_MODEL, status: "RUNNING", estimate: baseEstimate },
      adapter,
      false,
      [],
      attempts,
    );
    await recordAttribution(env, run.id, attribution);
    await recordRouting(env, {
      runId: run.id,
      taskClass: input.routing?.taskClass,
      selectedProviderKey: "local",
      selectedModel: MOCK_LOCAL_MODEL,
      attempts,
      fallbackUsed: false,
      explanation: `privacy mode ${policy.privacy_mode}: no external provider may be used, so the deterministic local adapter ran. No data left this system.`,
    });
    return { run };
  }

  // ── FRONTIER: external path ──

  // 4. Provider availability (kill switch / disabled).
  const pinnedKey = input.budgetContext?.providerKey;
  let candidates: ProviderRow[];
  if (pinnedKey) {
    const pinned = await env.WP_OS_DB.prepare("SELECT * FROM provider_registry WHERE provider_key = ?1")
      .bind(pinnedKey)
      .first<ProviderRow>();
    if (!pinned || pinned.enabled !== 1) {
      return { run: await blocked("PROVIDER_DISABLED", `provider_disabled:${pinnedKey}`) };
    }
    if (pinned.kill_switched === 1) {
      return { run: await blocked("KILL_SWITCHED", `provider_kill_switched:${pinnedKey}`) };
    }
    candidates = [pinned];
  } else {
    const enabled = await env.WP_OS_DB.prepare("SELECT * FROM provider_registry WHERE enabled = 1").all<ProviderRow>();
    const all = enabled.results ?? [];
    candidates = all.filter((p) => p.kill_switched !== 1);
    if (candidates.length === 0) {
      if (all.some((p) => p.kill_switched === 1)) {
        return { run: await blocked("KILL_SWITCHED", "provider_kill_switched:all_enabled_providers") };
      }
      return { run: await blocked("PROVIDER_DISABLED", "provider_disabled:no_enabled_providers") };
    }
  }

  // 5. Egress check (D9 default-deny): the sensitivity label must be explicitly
  //    allowed for the provider. Restricted labels can never leave.
  const egressAllowed: ProviderRow[] = [];
  for (const provider of candidates) {
    if (await dataPolicyAllows(env, provider.id, input.sensitivity)) egressAllowed.push(provider);
  }
  if (egressAllowed.length === 0) {
    return { run: await blocked("EGRESS_BLOCKED", `data_policy_denies_label:${input.sensitivity}`) };
  }

  // 6. Model selection from the latest pricing snapshots.
  const capability = input.capabilityRequirement ?? "text-completion";
  const capable = egressAllowed.filter((p) => {
    try {
      return (JSON.parse(p.capabilities_json) as string[]).includes(capability);
    } catch {
      return false;
    }
  });
  /*
   * A PROVIDER THAT CANNOT BE CALLED IS NOT A CANDIDATE — but only where that is knowable.
   *
   * HTTP providers are excluded from this check on purpose. A missing key there produces a run that
   * lands BLOCKED_DEFERRED with an honest reason, and the tests inject a fetch stub precisely so
   * that path stays exercisable; filtering on key presence would quietly change what they cover.
   *
   * Workers AI is different in kind. It is a BINDING: absent means there is no object to call at
   * all, it cannot be stubbed through fetch, and it is the cheapest thing in the catalogue — so it
   * wins every unpinned selection and then fails every one of them. Adding it broke every routing
   * test in exactly that way, which is the same thing that would have happened in any environment
   * where the binding was not granted.
   *
   * So: skipped when unbound, considered when bound. Narrow, and for a reason that does not
   * generalise to the others.
   */
  const bindingAbsent = !workersAiConfigured(env);
  const selectable = bindingAbsent ? capable.filter((p) => p.provider_key !== "workers_ai") : capable;

  const pricing = await latestPricing(env, selectable.map((p) => p.id));
  const options: ModelOption[] = pricing.flatMap((price) => {
    const provider = selectable.find((p) => p.id === price.provider_id);
    return provider ? [{ provider, pricing: price }] : [];
  });
  if (options.length === 0) {
    return { run: await blocked("PREFLIGHT_BLOCKED", "no_priced_capable_model") };
  }

  const estimateFor = (option: ModelOption): number =>
    (expectedInputTokens * option.pricing.input_per_mtok_usd + expectedOutputTokens * option.pricing.output_per_mtok_usd) / 1_000_000;

  // ── P16 routing ──
  // Precedence, most specific first: machine model policy → task routing policy →
  // explicit preferred model → cheapest adequate. Every step is recorded in the
  // explanation, so "why this model?" is answerable from stored fact.
  const routingCandidates: RoutingCandidate[] = options.map((o) => ({
    providerId: o.provider.id,
    providerKey: o.provider.provider_key,
    model: o.pricing.model,
    estimatedCostUsd: estimateFor(o),
    baseUrl: o.provider.base_url,
  }));

  const machinePolicy = input.routing?.machineId
    ? await env.WP_OS_DB.prepare("SELECT * FROM machine_model_policy WHERE machine_id = ?1")
        .bind(input.routing.machineId)
        .first<{ preferred_provider_key: string | null; preferred_model: string | null }>()
    : null;
  const routePolicy = await latestRoutingPolicy(env, input.routing?.taskClass);

  let ordered: RoutingCandidate[] = [];
  let explanation: string;
  if (machinePolicy?.preferred_provider_key && machinePolicy.preferred_model) {
    const pinned = routingCandidates.find(
      (c) => c.providerKey === machinePolicy.preferred_provider_key && c.model === machinePolicy.preferred_model,
    );
    if (pinned) {
      ordered = [pinned];
      explanation = `machine ${input.routing!.machineId} pins ${pinned.providerKey}/${pinned.model}`;
    } else {
      ordered = [];
      explanation = `machine ${input.routing!.machineId} pins ${machinePolicy.preferred_provider_key}/${machinePolicy.preferred_model}, which is not available (disabled, egress-denied, or unpriced)`;
    }
  } else if (routePolicy && !(effectiveCostMode === "CHEAPO" && Number(policy.honours_pins ?? 1) === 0)) {
    ordered = orderByPolicy(routePolicy, routingCandidates);
    explanation =
      ordered.length > 0
        ? `routing policy '${routePolicy.task_class}' v${routePolicy.version_no}: ${ordered.map((c) => `${c.providerKey}/${c.model}`).join(" → ")}${routePolicy.allow_fallback ? " (fallback allowed)" : " (no fallback)"}`
        : `routing policy '${routePolicy.task_class}' v${routePolicy.version_no} names no available candidate`;
  } else if (routePolicy) {
    /*
     * THE ONE POSTURE THAT OVERRIDES A PIN, and it says so on the record.
     *
     * "Free only" exists because the operator asked for a lever that gets the firm to $0, and a
     * lever that stops at the two things which actually run is not a lever. Both the morning brief
     * and employee work are pinned, so honouring pins meant CHEAPO changed nothing at all.
     *
     * Overriding is stated rather than silent for a specific reason: the brief is pinned BECAUSE
     * the cheap tier once produced "the 30-year U.S. tax at 19 year high" and shipped it as fact.
     * Anyone reading a thin brief later can find this explanation on the run and know why.
     */
    const cheapest = routingCandidates.reduce((a, b) => (a.estimatedCostUsd <= b.estimatedCostUsd ? a : b));
    ordered = [cheapest];
    explanation =
      `spend posture is 'free only', which overrides routing policy '${routePolicy.task_class}' ` +
      `v${routePolicy.version_no} (pinned ${orderByPolicy(routePolicy, routingCandidates)[0]?.model ?? "nothing available"}). ` +
      `Cheapest available used instead: ${cheapest.providerKey}/${cheapest.model}. Quality on pinned work is lower by design.`;
  } else {
    const preferred = input.budgetContext?.preferredModel;
    let head: RoutingCandidate;
    if (effectiveCostMode !== "CHEAPO" && preferred) {
      head =
        routingCandidates.find((c) => c.model === preferred) ??
        routingCandidates.reduce((a, b) => (a.estimatedCostUsd <= b.estimatedCostUsd ? a : b));
      explanation =
        head.model === preferred
          ? `no routing policy for this task; caller preferred ${preferred}`
          : `no routing policy for this task; preferred model ${preferred} unavailable, fell to cheapest adequate`;
    } else {
      head = routingCandidates.reduce((a, b) => (a.estimatedCostUsd <= b.estimatedCostUsd ? a : b));
      explanation =
        effectiveCostMode === "CHEAPO"
          ? "CHEAPO cost mode: cheapest adequate priced model"
          : "no routing policy for this task; cheapest adequate priced model";
    }
    // No policy → no fallback. Behaviour is exactly P4's.
    ordered = [head];
  }

  if (ordered.length === 0) {
    return { run: await blocked("PREFLIGHT_BLOCKED", `routing_no_candidate:${explanation}`) };
  }

  const head = ordered[0]!;
  const selected = options.find((o) => o.provider.id === head.providerId && o.pricing.model === head.model)!;

  const estimate: CostEstimate = {
    ...baseEstimate,
    estimated_cost_usd: estimateFor(selected),
    provider_key: selected.provider.provider_key,
    model: selected.pricing.model,
    input_per_mtok_usd: selected.pricing.input_per_mtok_usd,
    output_per_mtok_usd: selected.pricing.output_per_mtok_usd,
  };

  /*
   * 6b. A VISION RUN MUST REACH A MODEL THAT CAN SEE.
   *
   * The capability filter above works at PROVIDER level, and every model in the registry declares
   * only "text-completion" — there is no concept of vision anywhere in the routing data. So today a
   * run carrying screenshots resolves to whatever the task class pins, and the fact that it happens
   * to be a model with eyes is luck rather than design.
   *
   * The failure that makes this worth blocking rather than warning: a text-only model handed a
   * multimodal message does not error. It ignores the images and answers from the prompt — which
   * for a design review means a fluent, confident, entirely invented critique of a page nobody
   * looked at. That is precisely the failure `look_at` exists to prevent, and it would arrive
   * looking exactly like success.
   *
   * A NAMED LIST, not a heuristic. Guessing from a model string is how a text-only model with
   * "vision" in its name gets through. Anything not on this list is refused, loudly, naming the
   * model — adding a model here is a deliberate act, and the cost of forgetting is a blocked run
   * rather than a fabricated review.
   */
  if (input.images?.length) {
    if (!VISION_CAPABLE_MODELS.has(selected.pricing.model)) {
      return {
        run: await blocked(
          "PREFLIGHT_BLOCKED",
          `model_cannot_see_images:${selected.pricing.model}`,
          estimate,
          selected.provider.id,
          selected.pricing.model,
        ),
      };
    }
  }

  // 7. Cost preflight: per-run and daily caps. A valid unexpired surge lifts both
  //    caps to the surge budget.
  const perRunCap = surge ? surge.budget : policy.per_run_cap_usd;
  const dailyCap = surge ? surge.budget : policy.daily_cap_usd;
  if (estimate.estimated_cost_usd > perRunCap) {
    return {
      run: await blocked(
        "BUDGET_BLOCKED",
        `per_run_cap_exceeded:${estimate.estimated_cost_usd.toFixed(6)}>${perRunCap}`,
        estimate,
        selected.provider.id,
        selected.pricing.model,
      ),
    };
  }
  const spentToday = await dailySpendUsd(env, firmScope);
  if (spentToday + estimate.estimated_cost_usd > dailyCap) {
    return {
      run: await blocked(
        "BUDGET_BLOCKED",
        `daily_cap_exceeded:${(spentToday + estimate.estimated_cost_usd).toFixed(6)}>${dailyCap}`,
        estimate,
        selected.provider.id,
        selected.pricing.model,
      ),
    };
  }

  // 7b. Scoped budgets (P16): employee / machine / provider / model / category ceilings on top
  //     of the firmwide caps. A run must satisfy EVERY scope it falls inside; the first
  //     violation blocks and is named exactly.
  const scoped = await checkScopedBudgets(
    env,
    {
      employeeId: input.aiEmployeeId ?? null,
      machineId: attribution.machineId,
      providerKey: selected.provider.provider_key,
      model: selected.pricing.model,
      category: attribution.category,
    },
    estimate.estimated_cost_usd,
    firmScope,
    now,
  );
  if (!scoped.ok && scoped.violation) {
    const v = scoped.violation;
    await raiseCostAlert(env, v.scope, v.would_be, "BREACH", now);
    return {
      run: await blocked(
        "BUDGET_BLOCKED",
        `scoped_cap_exceeded:${v.scope.scope_type}:${v.scope.scope_id}:${v.scope.period}:${v.would_be.toFixed(6)}>${v.scope.cap_usd}`,
        estimate,
        selected.provider.id,
        selected.pricing.model,
      ),
    };
  }
  for (const warn of scoped.warnings) {
    await raiseCostAlert(env, warn.scope, warn.would_be, "WARNING", now);
  }

  // 8. External call through the provider's adapter (OpenRouter, Fireworks, or the generic
  //    HTTPS shape). No live credentials exist in any current environment, so a real call
  //    fails closed with `credential_missing:<provider>` — UNPROVEN, CREDENTIAL GATE.
  //    Output is quarantined until a human accepts it.
  const { adapter } = adapterFor(env, head, deps.fetchImpl);
  const allowFallback = routePolicy?.allow_fallback === 1;
  const fallbacks = allowFallback
    ? ordered.slice(1).map((c) => ({ candidate: c, adapter: adapterFor(env, c, deps.fetchImpl).adapter }))
    : [];
  const attempts: Array<{ provider_key: string; model: string; outcome: string; detail?: string }> = [];

  const run = await executeRun(
    env,
    {
      ...baseRec,
      providerId: selected.provider.id,
      providerKey: selected.provider.provider_key,
      model: selected.pricing.model,
      status: "RUNNING",
      estimate,
    },
    adapter,
    true,
    fallbacks,
    attempts,
  );

  await recordAttribution(env, run.id, attribution);
  await recordRouting(env, {
    runId: run.id,
    taskClass: input.routing?.taskClass,
    policyId: routePolicy?.id ?? null,
    selectedProviderKey: attempts.find((a) => a.outcome === "COMPLETED")?.provider_key ?? selected.provider.provider_key,
    selectedModel: run.model,
    attempts,
    fallbackUsed: attempts.filter((a) => a.outcome === "FAILED").length > 0 && run.status === "COMPLETED",
    explanation,
  });
  return { run };
}
