import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize } from "./authorize";
import { activeBudgetScopes, periodStart, scopeSpendUsd, type BudgetPeriod, type BudgetScopeType } from "../ai/routing";
import { getLatestBudgetPolicy } from "../ai/runAi";
import { evidenceGrid, MIN_RUNS_FOR_EVIDENCE } from "../ai/modelLearning";
import { LADDER, leverFromPolicy } from "../../shared/ai/spendLever";
import {
  COMMITTED_SPEND_DEFINITION,
  centsToUsd,
  committedCostOf,
  firmBudgetStates,
  firmSpend,
  currentSpendBehaviour,
  liveBypass,
  notifyAtFiftyReason,
  type FirmBudgetWindow,
} from "../ai/spend";

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

/**
 * One row's committed cost — delegated, not re-derived. This file used to hold its own copy and a
 * separate all-time SQL query with a third definition again, which is how the same page could show
 * a period total counting estimates and an all-time total silently valuing them at zero.
 */
function costOf(row: RunCostRow): { committed: number } {
  return { committed: committedCostOf(row) };
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

  // ALL THREE FIGURES, ONE DEFINITION. Today, this month and ever now come from the same function,
  // over the same population, with the same day boundary. They used to come from three places and
  // the operator caught two of them 28% apart under the same word.
  const todaySpend = await firmSpend(ctx.env, firmScope, "TODAY", now);
  const allTime = await firmSpend(ctx.env, firmScope, "ALL_TIME", now);
  const firmBudgets = await firmBudgetStates(ctx.env, firmScope, now);

  const committed = runs.reduce((sum, r) => sum + costOf(r).committed, 0);
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
   * SPEND WITH VENDORS THAT ARE NOT REASONING MODELS, broken out by vendor.
   *
   * The totals themselves come from `firmSpend` with everything else; this query exists only to say
   * WHICH vendor. Image generation deliberately does not go through the model boundary — see the
   * exemption in scripts/validate/no-direct-provider-calls.mjs — so it is a second ledger, and the
   * firm's number is both.
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

  /*
   * ── WHAT SHE MUST BE ABLE TO SEE WITHOUT ASKING ─────────────────────────────────────────────
   *
   * Four things, and they were four separate unanswerable questions before: where the lever is,
   * where she is on the gradient AND WHY, what the position is costing her in capability, and — at
   * $50 — the notification carrying the bypass decision rather than just the number.
   *
   * Computed from `currentSpendBehaviour`, which is the same function the AI boundary routes on.
   * The page cannot show a position the router is not in, because there is only one of them.
   */
  const lever = leverFromPolicy(policy as unknown as Parameters<typeof leverFromPolicy>[0]);
  const behaviour = await currentSpendBehaviour(ctx.env, firmScope, lever, now);
  const bypass = await liveBypass(ctx.env, firmScope, "MONTHLY", now);

  return json({
    /**
     * Since the very first run. Stated apart from the period totals because they answer different
     * questions, and because this one carries a caveat worth seeing: runs completed before cost
     * recording was fixed on 19 Aug 2026 stored zero, so the true figure is a little higher than
     * this. Understating is the honest direction for a number nobody should be surprised by.
     */
    all_time: {
      spent_usd: allTime.total_usd,
      model_spent_usd: allTime.model_usd,
      vendor_spent_usd: allTime.vendor_usd,
      runs: allTime.runs,
      since: allTime.first_run_at,
      // How many charges the vendor did not price. Real money of an unknown amount, not zero.
      unpriced_vendor_calls: allTime.unpriced_vendor_calls,
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
    /**
     * THE LEVER AND THE GRADIENT, in one block, in her words.
     *
     * `why` and `capability_cost` are sentences written once in shared/ai/spendLever.ts and printed
     * verbatim. The page does not get to reword them: three glosses of one number is how this firm
     * ended up with three different answers to "what has it spent".
     */
    spend_lever: {
      lever,
      position: behaviour.position,
      // False at FREE_ONLY and OPEN. Her hand is on the control and the gradient does not move it.
      gradient_applies: behaviour.gradientApplies,
      why: behaviour.why,
      capability_cost: behaviour.capabilityCost,
      month_to_date_usd: behaviour.monthToDateUsd,
      month_elapsed_pct: Math.round(behaviour.elapsedFraction * 1000) / 10,
      // The pro-rated lines, so "why am I being careful" is arithmetic she can check rather than a mood.
      tightening_allowance_usd: behaviour.tighteningAllowanceUsd,
      cautious_allowance_usd: behaviour.cautiousAllowanceUsd,
      projected_month_end_usd: behaviour.projectedMonthEndUsd,
      // VISIBLE BEFORE IT BITES. Null until she is 80% of the way to a line that has not yet acted.
      approaching: behaviour.approaching,
      ladder: { tightening_usd: LADDER.tighteningUsd, cautious_usd: LADDER.cautiousUsd, notify_usd: LADDER.notifyUsd, hard_stop_usd: LADDER.hardStopUsd },
      /**
       * THE $50 NOTIFICATION, CARRYING THE DECISION. Not "you have passed $50" — what the choice is,
       * what happens if she does nothing, and what a bypass would mean. Null below the line.
       */
      notification: behaviour.notify ? notifyAtFiftyReason(behaviour.monthToDateUsd) : null,
      bypass: bypass
        ? { ceiling_usd: centsToUsd(bypass.ceiling_cents), reason: bypass.reason, granted_by: bypass.granted_by, expires_at: bypass.expires_at }
        : null,
    },
    /**
     * WHAT THE MODELS HAVE ACTUALLY DONE, by task kind — and the gaps reported as gaps.
     *
     * A cell below the evidence threshold shows INSUFFICIENT_EVIDENCE and a null rate rather than a
     * percentage computed from three runs. An unproven model is unknown, not good, and the screen
     * has to say so as plainly as the router acts on it.
     */
    model_evidence: {
      min_runs_for_evidence: MIN_RUNS_FOR_EVIDENCE,
      cells: await evidenceGrid(ctx.env),
      note:
        `A model must have ${MIN_RUNS_FOR_EVIDENCE} decided outcomes on a task kind before it counts as proven or poor. ` +
        `Below that the answer is 'not enough evidence', not a rate — and routing falls back to capability and price, ` +
        `exactly as it does today.`,
    },
    firm_policy: {
      cost_mode: policy.cost_mode,
      // Which posture this is, so the lever can show where it currently sits rather than making
      // the operator infer it from a mode name and a boolean.
      honours_pins: Number((policy as unknown as { honours_pins?: number }).honours_pins ?? 1) === 1,
      // The bit that finally tells "Best available" apart from "Balanced". Without it the page
      // showed a partner who chose the expensive setting that they were on the middle one.
      prefers_frontier: Number((policy as unknown as { prefers_frontier?: number }).prefers_frontier ?? 0) === 1,
      privacy_mode: policy.privacy_mode,
      daily_cap_usd: policy.daily_cap_usd,
      per_run_cap_usd: policy.per_run_cap_usd,
      spent_today_usd: todaySpend.total_usd,
    },
    /**
     * The firmwide ceilings, and their usage, from the same function the AI boundary refuses runs
     * with. A cap here is a cap there — there is no second copy to fall out of step.
     */
    firm_budgets: firmBudgets,
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
      // ONE SENTENCE, IMPORTED. Every spend figure on the page — today, this period, all time, and
      // the two ceilings — counts the same thing, and this is the only place that says what.
      committed: COMMITTED_SPEND_DEFINITION,
      estimate_only_runs: "Committed runs where no provider reported an actual cost — these totals are estimates, not invoices.",
      rework_cost_usd: "Committed cost of completed runs whose output is still quarantined (nobody accepted it). A cost-of-rework measure, not a quality verdict.",
      forecast_period_usd: "Straight-line projection of the current period from the elapsed fraction. A projection, not a prediction.",
      value: "No 'value generated' figure exists here. Spend is money; benefit is not measured as money.",
    },
  });
}

// ── The firmwide ceiling ──

const firmBudgetSchema = z.object({
  budget_window: z.enum(["MONTHLY", "ALL_TIME"]),
  /**
   * CENTS, and the client sends cents. Taking dollars here and multiplying would put a float
   * conversion between the number the operator typed and the number that refuses a run — which for
   * a ceiling is the one place a rounding artefact becomes work being blocked early.
   */
  cap_cents: z.number().int().nonnegative(),
  reason: z.string().trim().min(1),
  active: z.boolean().default(true),
});

/**
 * Set what the firm will spend — this month, or ever.
 *
 * Operator, item 23: "i need to be able to set a firmwide budget very easily and have it change,
 * show up and persist." Persist is the operative word, so this writes a versioned row that the AI
 * boundary reads before every run, rather than a display value.
 *
 * Managing Partner only, and not because of a role table: this is the firm deciding how much of its
 * money may go to a category of expense, which is the same class of decision as the privacy mode
 * next to it.
 */
export async function handleSetFirmBudget(ctx: RouteContext): Promise<Response> {
  const parsed = firmBudgetSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") {
    return errorResponse(403, "forbidden", "the firm's spending ceiling is set by a person, never by an employee");
  }
  if (!actor.roles.includes("MANAGING_PARTNER")) {
    return errorResponse(403, "forbidden", "only a Managing Partner can change what the firm will spend");
  }
  const authz = await authorize(ctx.env, actor, "firm_budget.set", { objectType: "firm_spend_budget" });
  if (authz.decision !== "ALLOW") return errorResponse(403, "forbidden", authz.reason);

  const body = parsed.data;
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const window = body.budget_window as FirmBudgetWindow;

  /*
   * AN ALL-TIME CEILING BELOW WHAT HAS ALREADY BEEN SPENT stops every run the moment it is saved,
   * and would do it silently — the page would look fine and the firm would simply stop thinking.
   * Refused here, naming both figures, because a partner typing 50 when they meant 500 should find
   * out now rather than from a week of blocked work.
   */
  const spend = await firmSpend(ctx.env, firmScope, window === "MONTHLY" ? "THIS_MONTH" : "ALL_TIME");
  const cap = centsToUsd(body.cap_cents);
  if (body.active && cap < spend.total_usd) {
    return errorResponse(
      409,
      "cap_below_spend",
      `That ceiling is $${cap.toFixed(2)} and the firm has already spent $${spend.total_usd.toFixed(2)} ${
        window === "MONTHLY" ? "this month" : "in total"
      }. Saving it would refuse every run immediately.`,
    );
  }

  const current = await ctx.env.WP_OS_DB.prepare(
    "SELECT MAX(version_no) AS v FROM firm_spend_budget WHERE firm_scope = ?1 AND budget_window = ?2",
  )
    .bind(firmScope, window)
    .first<{ v: number | null }>();
  const version = (current?.v ?? 0) + 1;
  const id = `fsb_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO firm_spend_budget (id, firm_scope, budget_window, cap_cents, version_no, active, reason, set_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(id, firmScope, window, body.cap_cents, version, body.active ? 1 : 0, body.reason, actor.firmUserId!)
    .run();

  await appendEvent(ctx.env, {
    eventType: "firm_budget.set",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "firm_spend_budget",
    objectId: id,
    firmScope,
    payload: { budget_window: window, cap_cents: body.cap_cents, version_no: version, active: body.active },
  });

  return json(
    {
      budget: await ctx.env.WP_OS_DB.prepare("SELECT * FROM firm_spend_budget WHERE id = ?1").bind(id).first(),
      state: (await firmBudgetStates(ctx.env, firmScope)).find((s) => s.budget_window === window) ?? null,
    },
    { status: 201 },
  );
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
