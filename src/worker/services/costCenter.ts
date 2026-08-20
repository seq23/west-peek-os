import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize } from "./authorize";
import { activeBudgetScopes, periodStart, scopeSpendUsd, type BudgetPeriod, type BudgetScopeType } from "../ai/routing";
import { dailySpendUsd, getLatestBudgetPolicy } from "../ai/runAi";

/**
 * AI Cost Command Center (P16, GAP-02).
 *
 * Reads `ai_run` (+ `ai_run_attribution`) and reports spend by the dimensions an operator
 * actually manages. Definitions, stated once and applied everywhere:
 *
 * - "Committed" cost = the provider's ACTUAL reported cost where one exists, otherwise the
 *   estimate recorded before the call. Blocked runs cost nothing and are counted separately.
 * - "Wasted" cost = completed runs whose output is still quarantined (nobody accepted it) plus
 *   runs attached to an approval card a human rejected. It is a cost-of-rework measure, not a
 *   verdict on quality.
 * - The forecast is a straight-line projection of the current period's run rate. It is a
 *   projection, labelled as one, and it is not a prediction of what the firm will decide to do.
 *
 * Nothing here is a "value generated" figure. Spend is money; benefit is not measured as money.
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

interface RunCostRow {
  id: string;
  status: string;
  output_quarantine: number;
  ai_employee_id: string | null;
  model: string | null;
  provider_key: string | null;
  machine_id: number | null;
  category: string | null;
  purpose: string;
  cost_estimate_json: string;
  actual_usage_json: string | null;
  created_at: string;
}

const COMMITTED = new Set(["QUEUED", "RUNNING", "COMPLETED"]);

function costOf(row: RunCostRow): { committed: number; estimated: number; actual: number | null } {
  let estimated = 0;
  let actual: number | null = null;
  try {
    estimated = (JSON.parse(row.cost_estimate_json) as { estimated_cost_usd?: number }).estimated_cost_usd ?? 0;
  } catch {
    estimated = 0;
  }
  if (row.actual_usage_json) {
    try {
      actual = (JSON.parse(row.actual_usage_json) as { cost_usd?: number }).cost_usd ?? 0;
    } catch {
      actual = null;
    }
  }
  const committed = COMMITTED.has(row.status) ? actual ?? estimated : 0;
  return { committed, estimated, actual };
}

async function loadRuns(env: Env, since: string): Promise<RunCostRow[]> {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT r.id, r.status, r.output_quarantine, r.ai_employee_id, r.model, r.purpose,
            r.cost_estimate_json, r.actual_usage_json, r.created_at,
            p.provider_key, a.machine_id, a.category
       FROM ai_run r
       LEFT JOIN provider_registry p ON p.id = r.provider_id
       LEFT JOIN ai_run_attribution a ON a.ai_run_id = r.id
      WHERE r.created_at >= ?1
      ORDER BY r.created_at DESC`,
  )
    .bind(since)
    .all<RunCostRow>();
  return rows.results ?? [];
}

function groupSpend(runs: RunCostRow[], key: (r: RunCostRow) => string | null): Array<{ key: string; committed_usd: number; runs: number; blocked: number }> {
  const map = new Map<string, { committed_usd: number; runs: number; blocked: number }>();
  for (const r of runs) {
    const k = key(r) ?? "(unattributed)";
    const cur = map.get(k) ?? { committed_usd: 0, runs: 0, blocked: 0 };
    cur.committed_usd += costOf(r).committed;
    cur.runs += 1;
    if (!COMMITTED.has(r.status)) cur.blocked += 1;
    map.set(k, cur);
  }
  return [...map.entries()]
    .map(([k, v]) => ({ key: k, committed_usd: Math.round(v.committed_usd * 1_000_000) / 1_000_000, runs: v.runs, blocked: v.blocked }))
    .sort((a, b) => b.committed_usd - a.committed_usd);
}

export async function handleCostOverview(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const period = (url.searchParams.get("period") ?? "MONTHLY") as BudgetPeriod;
  const now = new Date();
  const since = periodStart(period, now);
  const runs = await loadRuns(ctx.env, since);

  const firmScope = ctx.identity!.authorityScopes.find((s) => s.scopeKey === "firm_scope")?.scopeValue ?? "west-peek";
  const policy = await getLatestBudgetPolicy(ctx.env, firmScope);
  const today = await dailySpendUsd(ctx.env, firmScope);

  const committed = runs.reduce((sum, r) => sum + costOf(r).committed, 0);

  // EVERYTHING THE FIRM HAS EVER SPENT. The overview reports a period, which answers "are we on
  // track this month" and not "what has this cost us" — and the second question is the one somebody
  // asks first. Computed in SQL rather than by loading every run: this grows without limit and the
  // page must not.
  const allTime = await ctx.env.WP_OS_DB.prepare(
    `SELECT COUNT(*) AS runs,
            COALESCE(SUM(CAST(json_extract(actual_usage_json, '$.cost_usd') AS REAL)), 0) AS spent,
            MIN(created_at) AS first_run
       FROM ai_run
      WHERE status = 'COMPLETED' AND actual_usage_json IS NOT NULL`,
  ).first<{ runs: number; spent: number; first_run: string | null }>();
  const estimatedOnly = runs.filter((r) => COMMITTED.has(r.status) && r.actual_usage_json === null);
  const blocked = runs.filter((r) => !COMMITTED.has(r.status));
  const quarantined = runs.filter((r) => r.status === "COMPLETED" && r.output_quarantine === 1);
  const wasted = quarantined.reduce((sum, r) => sum + costOf(r).committed, 0);

  // Straight-line projection across the period, from elapsed fraction.
  const start = new Date(since).getTime();
  const endOfPeriod =
    period === "DAILY" ? start + 86_400_000 : period === "WEEKLY" ? start + 7 * 86_400_000 : start + 30 * 86_400_000;
  const elapsed = Math.max(1, now.getTime() - start);
  const fraction = Math.min(1, elapsed / (endOfPeriod - start));
  const forecast = fraction > 0 ? committed / fraction : committed;

  const scopes = await activeBudgetScopes(ctx.env);
  const budgets = [] as Array<Record<string, unknown>>;
  for (const s of scopes) {
    const spent = await scopeSpendUsd(ctx.env, s, now);
    budgets.push({
      scope_type: s.scope_type,
      scope_id: s.scope_id,
      period: s.period,
      cap_usd: s.cap_usd,
      spent_usd: Math.round(spent * 1_000_000) / 1_000_000,
      utilisation_pct: s.cap_usd > 0 ? Math.round((spent / s.cap_usd) * 1000) / 10 : null,
      version_no: s.version_no,
      set_by: s.set_by,
      reason: s.reason,
    });
  }

  const alerts = (
    await ctx.env.WP_OS_DB.prepare("SELECT * FROM cost_alert WHERE status = 'OPEN' ORDER BY created_at DESC LIMIT 50").all()
  ).results ?? [];

  /*
   * SPEND WITH VENDORS THAT ARE NOT REASONING MODELS.
   *
   * Everything above is summed from `ai_run`, which is the complete picture only for work that goes
   * through the model boundary. Image generation deliberately does not — see the exemption in
   * scripts/validate/no-direct-provider-calls.mjs — so it is summed here and added to the firm
   * total. Two ledgers, one number, and the model ledger stays clean.
   *
   * `unpriced` is reported rather than hidden: calls the vendor did not price are real spend of an
   * unknown amount, and rolling them in as zero would understate the total silently.
   */
  const vendors = ((await ctx.env.WP_OS_DB.prepare(
    `SELECT vendor,
            COALESCE(SUM(cost_usd), 0) AS spent,
            COUNT(*)                   AS calls,
            SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
            MIN(created_at)            AS first_call
       FROM vendor_spend
      GROUP BY vendor
      ORDER BY spent DESC`,
  ).all<{ vendor: string; spent: number; calls: number; unpriced: number; first_call: string }>()).results ?? []);

  const vendorTotal = vendors.reduce((sum, v) => sum + Number(v.spent ?? 0), 0);
  const vendorUnpriced = vendors.reduce((sum, v) => sum + Number(v.unpriced ?? 0), 0);

  return json({
    /**
     * Since the very first run. Stated apart from the period totals because they answer different
     * questions, and because this one carries a caveat worth seeing: runs completed before cost
     * recording was fixed on 19 Aug 2026 stored zero, so the true figure is a little higher than
     * this. Understating is the honest direction for a number nobody should be surprised by.
     */
    all_time: {
      // MODEL SPEND PLUS VENDOR SPEND. This used to be model spend alone and was labelled as the
      // firm total, which made it wrong the moment anything was bought outside the AI boundary.
      spent_usd: Math.round((Number(allTime?.spent ?? 0) + vendorTotal) * 1_000_000) / 1_000_000,
      model_spent_usd: Math.round(Number(allTime?.spent ?? 0) * 1_000_000) / 1_000_000,
      vendor_spent_usd: Math.round(vendorTotal * 1_000_000) / 1_000_000,
      runs: Number(allTime?.runs ?? 0),
      since: allTime?.first_run ?? null,
      // How many charges the vendor did not price. Real money of an unknown amount, not zero.
      unpriced_vendor_calls: vendorUnpriced,
    },
    by_vendor: vendors.map((v) => ({
      vendor: v.vendor,
      spent_usd: Math.round(Number(v.spent ?? 0) * 1_000_000) / 1_000_000,
      calls: Number(v.calls ?? 0),
      unpriced: Number(v.unpriced ?? 0),
      since: v.first_call,
    })),
    period,
    since,
    firm_policy: {
      cost_mode: policy.cost_mode,
      privacy_mode: policy.privacy_mode,
      daily_cap_usd: policy.daily_cap_usd,
      per_run_cap_usd: policy.per_run_cap_usd,
      spent_today_usd: Math.round(today * 1_000_000) / 1_000_000,
    },
    totals: {
      committed_usd: Math.round(committed * 1_000_000) / 1_000_000,
      runs: runs.length,
      blocked_runs: blocked.length,
      estimate_only_runs: estimatedOnly.length,
      quarantined_runs: quarantined.length,
      rework_cost_usd: Math.round(wasted * 1_000_000) / 1_000_000,
      forecast_period_usd: Math.round(forecast * 1_000_000) / 1_000_000,
    },
    by_employee: groupSpend(runs, (r) => r.ai_employee_id),
    by_provider: groupSpend(runs, (r) => r.provider_key),
    by_model: groupSpend(runs, (r) => r.model),
    by_machine: groupSpend(runs, (r) => (r.machine_id === null ? null : String(r.machine_id))),
    by_category: groupSpend(runs, (r) => r.category),
    budgets,
    alerts,
    definitions: {
      committed: "Provider-reported ACTUAL cost where one exists, otherwise the estimate recorded before the call. Blocked runs cost nothing.",
      estimate_only_runs: "Committed runs where no provider reported an actual cost — these totals are estimates, not invoices.",
      rework_cost_usd: "Committed cost of completed runs whose output is still quarantined (nobody accepted it). A cost-of-rework measure, not a quality verdict.",
      forecast_period_usd: "Straight-line projection of the current period from the elapsed fraction. A projection, not a prediction.",
      value: "No 'value generated' figure exists here. Spend is money; benefit is not measured as money.",
    },
  });
}

const budgetSchema = z.object({
  scope_type: z.enum(["FIRM", "EMPLOYEE", "MACHINE", "PROVIDER", "MODEL", "CATEGORY"]),
  scope_id: z.string().trim().min(1),
  period: z.enum(["DAILY", "WEEKLY", "MONTHLY"]),
  cap_usd: z.number().nonnegative(),
  reason: z.string().trim().min(1),
  active: z.boolean().default(true),
});

/**
 * Publish a scoped budget. Versioned and immutable like every other policy in this system:
 * a change is a new version with its author and reason, and the history is the change log.
 */
export async function handleSetBudgetScope(ctx: RouteContext): Promise<Response> {
  const parsed = budgetSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") return errorResponse(403, "forbidden", "budgets are set by humans");
  const authz = await authorize(ctx.env, actor, "budget_scope.set", { objectType: "budget_scope" });
  if (authz.decision !== "ALLOW") return errorResponse(403, "forbidden", authz.reason);

  const body = parsed.data;
  // The scope must name something real, or the cap silently protects nothing.
  const exists = await scopeTargetExists(ctx.env, body.scope_type, body.scope_id);
  if (!exists) return errorResponse(404, "unknown_scope_target", `${body.scope_type} '${body.scope_id}' does not exist`);

  const current = await ctx.env.WP_OS_DB.prepare(
    "SELECT MAX(version_no) AS v FROM budget_scope WHERE scope_type = ?1 AND scope_id = ?2 AND period = ?3",
  )
    .bind(body.scope_type, body.scope_id, body.period)
    .first<{ v: number | null }>();
  const version = (current?.v ?? 0) + 1;
  const id = `bsc_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO budget_scope (id, scope_type, scope_id, period, cap_usd, version_no, active, reason, set_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(id, body.scope_type, body.scope_id, body.period, body.cap_usd, version, body.active ? 1 : 0, body.reason, actor.firmUserId!)
    .run();

  await appendEvent(ctx.env, {
    eventType: "budget_scope.set",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "budget_scope",
    objectId: id,
    payload: { scope_type: body.scope_type, scope_id: body.scope_id, period: body.period, cap_usd: body.cap_usd, version_no: version },
  });
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM budget_scope WHERE id = ?1").bind(id).first(), { status: 201 });
}

async function scopeTargetExists(env: Env, scopeType: BudgetScopeType, scopeId: string): Promise<boolean> {
  switch (scopeType) {
    case "FIRM":
      return true;
    case "EMPLOYEE":
      return !!(await env.WP_OS_DB.prepare("SELECT id FROM ai_employee WHERE id = ?1").bind(scopeId).first());
    case "MACHINE":
      return !!(await env.WP_OS_DB.prepare("SELECT id FROM machine WHERE id = ?1").bind(Number(scopeId)).first());
    case "PROVIDER":
      return !!(await env.WP_OS_DB.prepare("SELECT id FROM provider_registry WHERE provider_key = ?1").bind(scopeId).first());
    case "MODEL":
      return !!(await env.WP_OS_DB.prepare("SELECT id FROM provider_model WHERE model = ?1").bind(scopeId).first());
    case "CATEGORY":
      return ["PROACTIVE", "RESEARCH", "LEGAL", "COMPLIANCE", "OPERATIONS", "INTELLIGENCE", "OTHER"].includes(scopeId);
    default:
      return false;
  }
}

export async function handleListBudgetScopes(ctx: RouteContext): Promise<Response> {
  const rows = (await ctx.env.WP_OS_DB.prepare("SELECT * FROM budget_scope ORDER BY scope_type, scope_id, period, version_no DESC").all()).results ?? [];
  return json({ budgets: rows, note: "Every row is a version. The highest active version per (scope, period) is enforced." });
}

export async function handleAcknowledgeCostAlert(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "cost_alert.decide", { objectType: "cost_alert", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return errorResponse(403, "forbidden", authz.reason);
  const alert = await ctx.env.WP_OS_DB.prepare("SELECT status FROM cost_alert WHERE id = ?1").bind(ctx.params.id!).first<{ status: string }>();
  if (!alert) return errorResponse(404, "not_found");
  if (alert.status === "ACKNOWLEDGED") return errorResponse(409, "already_acknowledged");
  await ctx.env.WP_OS_DB.prepare("UPDATE cost_alert SET status = 'ACKNOWLEDGED', decided_by = ?2, decided_at = ?3 WHERE id = ?1")
    .bind(ctx.params.id!, actor.firmUserId!, new Date().toISOString())
    .run();
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM cost_alert WHERE id = ?1").bind(ctx.params.id!).first());
}
