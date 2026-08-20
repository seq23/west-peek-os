import type { Env } from "../env";
import type { ProviderAdapter } from "./providers/types";
import { createHttpExternalAdapter } from "./providers/httpExternal";
import { createOpenRouterAdapter } from "./providers/openRouter";
import { createWorkersAiAdapter, type WorkersAiBinding } from "./providers/workersAi";
import { createFireworksAdapter } from "./providers/fireworks";
import { createSpecialistAdapter } from "./providers/specialist";

/**
 * Routing + scoped budgets for the governed AI boundary (P16; GAP-02, GAP-03).
 *
 * This module is called BY `runAi` and never bypasses it. It answers three questions:
 *
 *   1. Which provider/model should this task use, in what order? (routing policy)
 *   2. Is the run inside every budget it falls under? (scoped budgets)
 *   3. What do we record so "why this model, at this cost" is answerable later?
 *
 * Design decision (deliberate): a task class with NO routing policy behaves exactly as P4 did —
 * cheapest priced capable model, single attempt, no fallback. Routing and fallback are opt-in per
 * task class, so publishing a policy is a visible operator act rather than a silent change to how
 * every existing call behaves.
 */

export interface RoutingCandidate {
  providerId: string;
  providerKey: string;
  model: string;
  estimatedCostUsd: number;
  baseUrl: string | null;
}

export interface RoutingPolicyRow {
  id: string;
  task_class: string;
  version_no: number;
  candidates_json: string;
  require_capability: string;
  max_data_class: string;
  allow_fallback: number;
  notes: string;
  set_by: string;
  created_at: string;
}

export async function latestRoutingPolicy(env: Env, taskClass: string | undefined): Promise<RoutingPolicyRow | null> {
  if (!taskClass) return null;
  return env.WP_OS_DB.prepare("SELECT * FROM routing_policy WHERE task_class = ?1 ORDER BY version_no DESC LIMIT 1")
    .bind(taskClass)
    .first<RoutingPolicyRow>();
}

/**
 * Order the available options by the policy's candidate list. Candidates the policy names but
 * which are unavailable (disabled, kill-switched, egress-denied, unpriced) are simply not
 * returned — the reason is already recorded by the caller's own gates, and the router never
 * invents an option the pipeline rejected.
 */
export function orderByPolicy(policy: RoutingPolicyRow, available: RoutingCandidate[]): RoutingCandidate[] {
  let wanted: Array<{ provider_key: string; model: string }> = [];
  try {
    wanted = JSON.parse(policy.candidates_json) as Array<{ provider_key: string; model: string }>;
  } catch {
    return [];
  }
  const ordered: RoutingCandidate[] = [];
  for (const w of wanted) {
    const hit = available.find((a) => a.providerKey === w.provider_key && a.model === w.model);
    if (hit && !ordered.includes(hit)) ordered.push(hit);
  }
  return ordered;
}

/** Pick the adapter for a provider. Named vendors get their own; anything else uses the generic. */
export function adapterFor(
  env: Env,
  candidate: RoutingCandidate,
  fetchImpl?: typeof fetch,
): { adapter: ProviderAdapter; credentialConfigured: boolean } {
  const baseUrl = candidate.baseUrl ?? "";
  if (candidate.providerKey === "openrouter") {
    return {
      adapter: createOpenRouterAdapter({ baseUrl, model: candidate.model, apiKey: env.OPENROUTER_API_KEY, fetchImpl }),
      credentialConfigured: typeof env.OPENROUTER_API_KEY === "string" && env.OPENROUTER_API_KEY.length > 0,
    };
  }
  /*
   * WORKERS AI — a binding, so "is the credential configured" means "was the binding granted".
   *
   * No hostname, no bearer token, nothing to leak and nothing on the egress allowlist. If the
   * binding is absent the provider is simply unavailable and routing moves on, which is the same
   * shape as a missing API key everywhere else in this function.
   */
  if (candidate.providerKey === "workers_ai") {
    const binding = (env as unknown as { AI?: WorkersAiBinding }).AI;
    return {
      adapter: createWorkersAiAdapter({
        binding: binding ?? { run: async () => { throw new Error("workers_ai_binding_absent"); } },
        model: candidate.model,
      }),
      credentialConfigured: Boolean(binding),
    };
  }
  if (candidate.providerKey === "fireworks") {
    return {
      adapter: createFireworksAdapter({ baseUrl, model: candidate.model, apiKey: env.FIREWORKS_API_KEY, fetchImpl }),
      credentialConfigured: typeof env.FIREWORKS_API_KEY === "string" && env.FIREWORKS_API_KEY.length > 0,
    };
  }
  if (candidate.providerKey === "harvey" || candidate.providerKey === "norm") {
    // Specialist lane (P23): same boundary, same quarantine, no bypass. Fails closed with a
    // named reason because neither vendor endpoint nor credential exists here.
    const key = candidate.providerKey === "harvey" ? env.HARVEY_API_KEY : env.NORM_API_KEY;
    return {
      adapter: createSpecialistAdapter({
        vendor: candidate.providerKey,
        baseUrl: candidate.baseUrl,
        model: candidate.model,
        apiKey: key,
        fetchImpl,
      }),
      credentialConfigured: typeof key === "string" && key.length > 0,
    };
  }
  return {
    adapter: createHttpExternalAdapter({ baseUrl, model: candidate.model, apiKey: env.AI_PROVIDER_API_KEY, fetchImpl }),
    credentialConfigured: typeof env.AI_PROVIDER_API_KEY === "string" && env.AI_PROVIDER_API_KEY.length > 0,
  };
}

// ── Scoped budgets ──

export type BudgetScopeType = "FIRM" | "EMPLOYEE" | "MACHINE" | "PROVIDER" | "MODEL" | "CATEGORY";
export type BudgetPeriod = "DAILY" | "WEEKLY" | "MONTHLY";

export interface BudgetScopeRow {
  id: string;
  scope_type: BudgetScopeType;
  scope_id: string;
  period: BudgetPeriod;
  cap_usd: number;
  version_no: number;
  active: number;
  reason: string;
  set_by: string;
  created_at: string;
}

/** Inclusive lower bound (ISO) for a budget period, relative to `now`. */
export function periodStart(period: BudgetPeriod, now: Date): string {
  const d = new Date(now.getTime());
  if (period === "DAILY") {
    d.setUTCHours(0, 0, 0, 0);
  } else if (period === "WEEKLY") {
    // ISO-ish week: back up to Monday.
    const day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day);
    d.setUTCHours(0, 0, 0, 0);
  } else {
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
  }
  return d.toISOString();
}

export async function activeBudgetScopes(env: Env): Promise<BudgetScopeRow[]> {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT b.* FROM budget_scope b
      WHERE b.version_no = (
        SELECT MAX(b2.version_no) FROM budget_scope b2
         WHERE b2.scope_type = b.scope_type AND b2.scope_id = b.scope_id AND b2.period = b.period
      )
        AND b.active = 1`,
  ).all<BudgetScopeRow>();
  return rows.results ?? [];
}

export interface SpendDimensions {
  employeeId?: string | null;
  machineId?: number | null;
  providerKey?: string | null;
  model?: string | null;
  category?: string | null;
}

function costOf(row: { cost_estimate_json: string; actual_usage_json: string | null }): number {
  try {
    if (row.actual_usage_json) return (JSON.parse(row.actual_usage_json) as { cost_usd?: number }).cost_usd ?? 0;
    return (JSON.parse(row.cost_estimate_json) as { estimated_cost_usd?: number }).estimated_cost_usd ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Committed spend inside one scope for the current period. "Committed" means the same thing it
 * means firmwide in P4: actual cost where a provider reported one, the recorded estimate otherwise,
 * counting only runs that were queued, running, or completed.
 */
export async function scopeSpendUsd(env: Env, scope: BudgetScopeRow, now: Date): Promise<number> {
  const since = periodStart(scope.period, now);
  const base = `SELECT r.cost_estimate_json, r.actual_usage_json FROM ai_run r`;
  const status = `r.status IN ('QUEUED','RUNNING','COMPLETED') AND r.created_at >= ?1`;

  let sql: string;
  const binds: unknown[] = [since];
  switch (scope.scope_type) {
    case "FIRM":
      sql = `${base} WHERE ${status} AND r.firm_scope = ?2`;
      binds.push(scope.scope_id);
      break;
    case "EMPLOYEE":
      sql = `${base} WHERE ${status} AND r.ai_employee_id = ?2`;
      binds.push(scope.scope_id);
      break;
    case "PROVIDER":
      sql = `${base} JOIN provider_registry p ON p.id = r.provider_id WHERE ${status} AND p.provider_key = ?2`;
      binds.push(scope.scope_id);
      break;
    case "MODEL":
      sql = `${base} WHERE ${status} AND r.model = ?2`;
      binds.push(scope.scope_id);
      break;
    case "MACHINE":
      sql = `${base} JOIN ai_run_attribution a ON a.ai_run_id = r.id WHERE ${status} AND a.machine_id = ?2`;
      binds.push(Number(scope.scope_id));
      break;
    case "CATEGORY":
      sql = `${base} JOIN ai_run_attribution a ON a.ai_run_id = r.id WHERE ${status} AND a.category = ?2`;
      binds.push(scope.scope_id);
      break;
    default:
      return 0;
  }
  const rows = await env.WP_OS_DB.prepare(sql)
    .bind(...binds)
    .all<{ cost_estimate_json: string; actual_usage_json: string | null }>();
  return (rows.results ?? []).reduce((sum, r) => sum + costOf(r), 0);
}

/** Does this run fall inside the given scope? */
export function scopeApplies(scope: BudgetScopeRow, dims: SpendDimensions, firmScope: string): boolean {
  switch (scope.scope_type) {
    case "FIRM":
      return scope.scope_id === firmScope;
    case "EMPLOYEE":
      return !!dims.employeeId && scope.scope_id === dims.employeeId;
    case "MACHINE":
      return dims.machineId !== null && dims.machineId !== undefined && scope.scope_id === String(dims.machineId);
    case "PROVIDER":
      return !!dims.providerKey && scope.scope_id === dims.providerKey;
    case "MODEL":
      return !!dims.model && scope.scope_id === dims.model;
    case "CATEGORY":
      return !!dims.category && scope.scope_id === dims.category;
    default:
      return false;
  }
}

export interface ScopedBudgetVerdict {
  ok: boolean;
  /** Populated when a scope would be exceeded. */
  violation?: { scope: BudgetScopeRow; spent: number; would_be: number };
  /** Scopes that would cross 80% of their cap after this run — surfaced as warnings, not blocks. */
  warnings: Array<{ scope: BudgetScopeRow; spent: number; would_be: number }>;
}

/**
 * Check every ACTIVE scoped budget this run falls inside. The firmwide `budget_policy` caps in
 * P4 are checked separately and first; these are additional ceilings, so a run must satisfy all
 * of them. The FIRST violation blocks, and it is named precisely in the failure reason.
 */
export async function checkScopedBudgets(
  env: Env,
  dims: SpendDimensions,
  estimateUsd: number,
  firmScope: string,
  now: Date,
): Promise<ScopedBudgetVerdict> {
  const scopes = await activeBudgetScopes(env);
  const warnings: ScopedBudgetVerdict["warnings"] = [];
  for (const scope of scopes) {
    if (!scopeApplies(scope, dims, firmScope)) continue;
    const spent = await scopeSpendUsd(env, scope, now);
    const wouldBe = spent + estimateUsd;
    if (wouldBe > scope.cap_usd) {
      return { ok: false, violation: { scope, spent, would_be: wouldBe }, warnings };
    }
    if (scope.cap_usd > 0 && wouldBe >= scope.cap_usd * 0.8) {
      warnings.push({ scope, spent, would_be: wouldBe });
    }
  }
  return { ok: true, warnings };
}

/**
 * Record a budget-threshold alert. Deduped per (scope, period start, severity) so a busy day
 * raises one warning and one breach, not hundreds.
 */
export async function raiseCostAlert(
  env: Env,
  scope: BudgetScopeRow,
  observed: number,
  severity: "WARNING" | "BREACH",
  now: Date,
): Promise<void> {
  const dedupe = `${scope.scope_type}:${scope.scope_id}:${scope.period}:${periodStart(scope.period, now).slice(0, 10)}:${severity}`;
  await env.WP_OS_DB.prepare(
    `INSERT OR IGNORE INTO cost_alert (id, scope_type, scope_id, period, threshold_pct, cap_usd, observed_usd, severity, dedupe_key)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      `calr_${crypto.randomUUID()}`,
      scope.scope_type,
      scope.scope_id,
      scope.period,
      severity === "BREACH" ? 100 : 80,
      scope.cap_usd,
      Math.round(observed * 1_000_000) / 1_000_000,
      severity,
      dedupe,
    )
    .run();
}

// ── Recording ──

export interface RoutingRecord {
  runId: string;
  taskClass?: string;
  policyId?: string | null;
  selectedProviderKey?: string | null;
  selectedModel?: string | null;
  attempts: Array<{ provider_key: string; model: string; outcome: string; detail?: string }>;
  fallbackUsed: boolean;
  explanation: string;
}

export async function recordRouting(env: Env, rec: RoutingRecord): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT OR IGNORE INTO ai_run_routing
       (ai_run_id, task_class, policy_id, selected_provider_key, selected_model, attempts_json, fallback_used, explanation)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      rec.runId,
      rec.taskClass ?? null,
      rec.policyId ?? null,
      rec.selectedProviderKey ?? null,
      rec.selectedModel ?? null,
      JSON.stringify(rec.attempts),
      rec.fallbackUsed ? 1 : 0,
      rec.explanation,
    )
    .run();
}

export async function recordAttribution(
  env: Env,
  runId: string,
  dims: { machineId?: number | null; workCardId?: string | null; category?: string | null },
): Promise<void> {
  await env.WP_OS_DB.prepare(
    "INSERT OR IGNORE INTO ai_run_attribution (ai_run_id, machine_id, work_card_id, category) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(runId, dims.machineId ?? null, dims.workCardId ?? null, dims.category ?? "OTHER")
    .run();
}
