import type { Env } from "../env";
import { appendEvent } from "../events";
import type { Actor } from "../services/authorize";
import type { PrivacyLabel } from "../../shared/privacy";
import { createMockLocalAdapter, MOCK_LOCAL_MODEL } from "./providers/mockLocal";
import { createHttpExternalAdapter } from "./providers/httpExternal";
import type { ProviderAdapter } from "./providers/types";
import { scrubInputs } from "./scrub";

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

export interface RunAiInput {
  purpose: string;
  actor: Actor;
  inputs: string[];
  sensitivity: PrivacyLabel;
  capabilityRequirement?: string;
  budgetContext?: RunAiBudgetContext;
  /** AI employee id when an AI employee is the actor (later phases). */
  aiEmployeeId?: string;
}

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

/** Execute an adapter for a run already decided as executable; records the outcome. */
async function executeRun(
  env: Env,
  rec: RunRecordInput,
  adapter: ProviderAdapter,
  quarantine: boolean,
): Promise<AIRunRow> {
  const running = await insertRun(env, { ...rec, status: "RUNNING" });
  try {
    const response = await adapter.complete({
      purpose: rec.input.purpose,
      inputs: rec.input.inputs,
      model: rec.model,
      capabilityRequirement: rec.input.capabilityRequirement,
    });
    const actualUsage = {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
      cost_usd: response.usage.costUsd,
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
        cost_usd: response.usage.costUsd,
      },
    });
  } catch (err) {
    // Manual fallback: provider failure is visible, never silently discarded (§3.5).
    const reason = err instanceof Error ? err.message : String(err);
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
    input.budgetContext?.expectedInputTokens ?? Math.max(1, Math.ceil(input.inputs.join("\n").length / 4));
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

  const baseRec: Omit<RunRecordInput, "status" | "estimate" | "failureReason" | "providerId" | "model"> = {
    input,
    firmScope,
    privacyMode: policy.privacy_mode,
    costMode: effectiveCostMode,
    inputHash,
    traceId,
    runId,
  };

  const blocked = (status: AIRunStatus, reason: string, estimate: CostEstimate = baseEstimate, providerId: string | null = null, model: string | null = null) =>
    recordBlockedRun(env, { ...baseRec, providerId, model, status, estimate, failureReason: reason });

  // 1. Cost-mode gate: CRITICAL_ONLY runs only critical/risk/deadline/LP/IC/deal/
  //    compliance purposes; everything else is deferred, not discarded.
  if (effectiveCostMode === "CRITICAL_ONLY" && !isCriticalPurpose(input.purpose, input.budgetContext)) {
    return { run: await blocked("BLOCKED_DEFERRED", "cost_mode_critical_only:non_critical_purpose") };
  }

  // 2. Credential scrub: no credentials in LLM context, ever.
  const scrub = scrubInputs(input.inputs);
  if (scrub.blocked) {
    return { run: await blocked("EGRESS_BLOCKED", `credential_like_content:${scrub.matches.join(",")}`) };
  }

  // 3. Privacy-mode resolution (D8).
  if (policy.privacy_mode === "LOCKDOWN" || policy.privacy_mode === "LOCAL") {
    // Local/manual path: the deterministic local adapter always works offline.
    const adapter = createMockLocalAdapter();
    const run = await executeRun(
      env,
      { ...baseRec, providerId: null, model: MOCK_LOCAL_MODEL, status: "RUNNING", estimate: baseEstimate },
      adapter,
      false,
    );
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
  const pricing = await latestPricing(env, capable.map((p) => p.id));
  const options: ModelOption[] = pricing.flatMap((price) => {
    const provider = capable.find((p) => p.id === price.provider_id);
    return provider ? [{ provider, pricing: price }] : [];
  });
  if (options.length === 0) {
    return { run: await blocked("PREFLIGHT_BLOCKED", "no_priced_capable_model") };
  }

  const estimateFor = (option: ModelOption): number =>
    (expectedInputTokens * option.pricing.input_per_mtok_usd + expectedOutputTokens * option.pricing.output_per_mtok_usd) / 1_000_000;

  let selected: ModelOption;
  const preferred = input.budgetContext?.preferredModel;
  if (effectiveCostMode !== "CHEAPO" && preferred) {
    selected = options.find((o) => o.pricing.model === preferred) ?? options.reduce((a, b) => (estimateFor(a) <= estimateFor(b) ? a : b));
  } else {
    // CHEAPO (and default): cheapest adequate model — critical work preserved by
    // the capability filter, cost minimized otherwise.
    selected = options.reduce((a, b) => (estimateFor(a) <= estimateFor(b) ? a : b));
  }

  const estimate: CostEstimate = {
    ...baseEstimate,
    estimated_cost_usd: estimateFor(selected),
    provider_key: selected.provider.provider_key,
    model: selected.pricing.model,
    input_per_mtok_usd: selected.pricing.input_per_mtok_usd,
    output_per_mtok_usd: selected.pricing.output_per_mtok_usd,
  };

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

  // 8. External call through the generic HTTPS adapter (fixture/stub in tests;
  //    no live credentials exist — UNPROVEN, CREDENTIAL GATE). Output quarantined.
  const adapter = createHttpExternalAdapter({
    baseUrl: selected.provider.base_url ?? "",
    model: selected.pricing.model,
    fetchImpl: deps.fetchImpl,
  });
  const run = await executeRun(
    env,
    { ...baseRec, providerId: selected.provider.id, model: selected.pricing.model, status: "RUNNING", estimate },
    adapter,
    true,
  );
  return { run };
}
