import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import type { FirmUserIdentity } from "../auth";
import { privacyVisibilityClause } from "./authorize";

/**
 * Portfolio Intelligence Cockpit + Allocation Decision View (P25; GAP-12, GAP-13).
 *
 * Both are READ-ONLY aggregations over substrate that already exists — P8 monitoring and P11
 * allocation. No new truth is created here, and no calculation is re-implemented: the allocation
 * view reads the constraint results P11 already computed and verified.
 *
 * Two honesty rules carried through every payload:
 * - Trends are stated with their window and their metric direction, so "deteriorating" always
 *   means something specific rather than a colour.
 * - Allocation scenarios are comparisons, NOT predictions, and every option's decision remains
 *   human-reserved behind its own approval receipt. The payload says so.
 */

interface SnapshotRow {
  company_id: string;
  canonical_name: string | null;
  metric_key: string;
  as_of_date: string;
  value: number;
  direction: string;
  metric_name: string;
  stale_after_days: number | null;
}

export interface TrendRow {
  company_id: string;
  company: string;
  metric_key: string;
  metric: string;
  previous: number;
  latest: number;
  change_pct: number;
  direction: string;
  verdict: "IMPROVING" | "DETERIORATING" | "FLAT";
  window: string;
}

/**
 * Period-over-period movement for every metric with at least two dated snapshots. Deliberately
 * the SAME comparison P8 alerting uses (latest vs previous, read against the metric's declared
 * direction) so the cockpit and the alert list can never disagree.
 */
export function computeTrends(rows: SnapshotRow[]): TrendRow[] {
  const byKey = new Map<string, SnapshotRow[]>();
  for (const r of rows) {
    const key = `${r.company_id}|${r.metric_key}`;
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const out: TrendRow[] = [];
  for (const [, snaps] of byKey) {
    if (snaps.length < 2) continue;
    const sorted = [...snaps].sort((a, b) => (a.as_of_date < b.as_of_date ? 1 : -1));
    const latest = sorted[0]!;
    const previous = sorted[1]!;
    if (previous.value === 0) continue;
    const changePct = ((latest.value - previous.value) / Math.abs(previous.value)) * 100;
    const better = latest.direction === "HIGHER_IS_BETTER" ? changePct > 0 : changePct < 0;
    out.push({
      company_id: latest.company_id,
      company: latest.canonical_name ?? latest.company_id,
      metric_key: latest.metric_key,
      metric: latest.metric_name,
      previous: previous.value,
      latest: latest.value,
      change_pct: Math.round(changePct * 10) / 10,
      direction: latest.direction,
      verdict: Math.abs(changePct) < 0.0001 ? "FLAT" : better ? "IMPROVING" : "DETERIORATING",
      window: `${previous.as_of_date} → ${latest.as_of_date}`,
    });
  }
  return out.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));
}

export async function handlePortfolioCockpit(ctx: RouteContext): Promise<Response> {
  const identity = ctx.identity as FirmUserIdentity;
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const env: Env = ctx.env;

  const alerts = (
    await env.WP_OS_DB.prepare(
      `SELECT a.id, a.company_id, c.canonical_name, a.alert_type, a.severity, a.metric_key, a.status, a.last_seen_at
         FROM portfolio_alert a LEFT JOIN canonical_company c ON c.id = a.company_id
        WHERE a.status = 'OPEN'
        ORDER BY CASE a.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, a.last_seen_at DESC`,
    ).all<Record<string, unknown>>()
  ).results ?? [];

  const snapshotVisibility = privacyVisibilityClause(identity, "s.privacy_label");
  const snapshots = (
    await env.WP_OS_DB.prepare(
      `SELECT s.company_id, c.canonical_name, s.metric_key, s.as_of_date, s.value,
              d.direction, d.name AS metric_name, d.stale_after_days
         FROM portfolio_metric_snapshot s
         JOIN portfolio_metric_definition d ON d.metric_key = s.metric_key
         LEFT JOIN canonical_company c ON c.id = s.company_id
        WHERE ${snapshotVisibility}
        ORDER BY s.as_of_date DESC`,
    ).all<SnapshotRow>()
  ).results ?? [];
  const trends = computeTrends(snapshots);

  // Stale coverage: a company/metric pair whose newest snapshot is older than the metric's own
  // staleness rule. Missing data is a finding, not a blank.
  const stale: Array<{ company: string; metric: string; as_of_date: string; days_old: number; stale_after_days: number }> = [];
  const seen = new Set<string>();
  for (const s of snapshots) {
    const key = `${s.company_id}|${s.metric_key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (s.stale_after_days === null) continue;
    const days = Math.floor((now.getTime() - new Date(s.as_of_date).getTime()) / 86_400_000);
    if (days > s.stale_after_days) {
      stale.push({
        company: s.canonical_name ?? s.company_id,
        metric: s.metric_name,
        as_of_date: s.as_of_date,
        days_old: days,
        stale_after_days: s.stale_after_days,
      });
    }
  }

  const support = (
    await env.WP_OS_DB.prepare(
      `SELECT r.id, r.company_id, c.canonical_name, r.request_type, r.urgency, r.description, r.status, r.created_at
         FROM support_request r LEFT JOIN canonical_company c ON c.id = r.company_id
        WHERE r.status IN ('OPEN','MATCHED')
        ORDER BY CASE r.urgency WHEN 'HIGH' THEN 0 WHEN 'NORMAL' THEN 1 ELSE 2 END, r.created_at DESC
        LIMIT 25`,
    ).all<Record<string, unknown>>()
  ).results ?? [];

  const followOn = (
    await env.WP_OS_DB.prepare(
      `SELECT o.id, o.label, o.option_type, o.company_id, c.canonical_name, o.capital, o.decision, o.scenario_id
         FROM capital_allocation_option o LEFT JOIN canonical_company c ON c.id = o.company_id
        WHERE o.option_type IN ('FOLLOW_ON','RESERVE') AND o.decision = 'UNDECIDED'
        ORDER BY o.created_at DESC LIMIT 25`,
    ).all<Record<string, unknown>>()
  ).results ?? [];

  const oppVisibility = privacyVisibilityClause(identity, "o.privacy_label");
  const secondaries = (
    await env.WP_OS_DB.prepare(
      `SELECT o.id, o.title, o.status, o.company_id, c.canonical_name, o.price_per_share, o.quantity
         FROM investment_opportunity o LEFT JOIN canonical_company c ON c.id = o.company_id
        WHERE o.opportunity_type IN ('SECONDARY_PURCHASE','SECONDARY_SALE')
          AND o.status NOT IN ('CLOSED','PASS','WITHDRAWN') AND ${oppVisibility}
        ORDER BY o.created_at DESC LIMIT 25`,
    ).all<Record<string, unknown>>()
  ).results ?? [];

  const ownership = (
    await env.WP_OS_DB.prepare(
      `SELECT s.id, s.company_id, c.canonical_name, s.as_of_date, s.ownership_pct, s.source
         FROM ownership_snapshot s LEFT JOIN canonical_company c ON c.id = s.company_id
        ORDER BY s.as_of_date DESC LIMIT 15`,
    ).all<Record<string, unknown>>()
  ).results ?? [];

  const changedThisWeek = (
    await env.WP_OS_DB.prepare(
      `SELECT event_type, object_type, object_id, created_at FROM event_record
        WHERE created_at >= ?1 AND event_type LIKE 'portfolio%'
        ORDER BY created_at DESC LIMIT 50`,
    )
      .bind(weekAgo)
      .all<Record<string, unknown>>()
  ).results ?? [];

  return json({
    top_risks: alerts.slice(0, 10),
    open_alert_count: alerts.length,
    deteriorating: trends.filter((t) => t.verdict === "DETERIORATING").slice(0, 10),
    improving: trends.filter((t) => t.verdict === "IMPROVING").slice(0, 10),
    stale_or_missing: stale,
    support_asks: support,
    follow_on_candidates: followOn,
    secondary_opportunities: secondaries,
    ownership_changes: ownership,
    changed_this_week: changedThisWeek,
    definitions: {
      trend: "Latest dated snapshot against the previous one, read against the metric's declared direction. The same comparison P8 alerting uses, so the cockpit and the alert list cannot disagree.",
      stale_or_missing: "A company/metric pair whose newest snapshot is older than that metric's own operator-set staleness rule. Missing data is reported as a finding, never as a blank.",
      follow_on_candidates: "Undecided FOLLOW_ON and RESERVE options from allocation scenarios. A candidate is a comparison, not a recommendation to deploy.",
      runway: "Runway appears here only when the firm has defined a runway metric and recorded snapshots for it. West Peek OS does not estimate runway it was not given.",
    },
  });
}

/**
 * Allocation decision view (GAP-13). Reads the P11 comparison run's own results — it does not
 * recompute anything. Every option is shown with its constraint effects and the scenario's stated
 * assumptions, and the payload states plainly that a scenario is not a prediction and that each
 * option type routes to its own human-reserved approval.
 */
export async function handleAllocationStrategyView(ctx: RouteContext): Promise<Response> {
  const scenario = await ctx.env.WP_OS_DB.prepare("SELECT * FROM fund_construction_scenario WHERE id = ?1")
    .bind(ctx.params.id!)
    .first<{ id: string; name: string; fund_id: string; status: string }>();
  if (!scenario) return json({ error: "not_found" }, { status: 404 });

  const run = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM cross_sleeve_comparison_run WHERE scenario_id = ?1 ORDER BY created_at DESC LIMIT 1",
  )
    .bind(scenario.id)
    .first<{ id: string; created_at: string }>();

  const options = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT o.*, c.canonical_name FROM capital_allocation_option o
         LEFT JOIN canonical_company c ON c.id = o.company_id
        WHERE o.scenario_id = ?1 ORDER BY o.created_at`,
    )
      .bind(scenario.id)
      .all<Record<string, unknown>>()
  ).results ?? [];

  const results = run
    ? (
        await ctx.env.WP_OS_DB.prepare("SELECT * FROM comparison_run_option_result WHERE run_id = ?1").bind(run.id).all<Record<string, unknown>>()
      ).results ?? []
    : [];

  const violations = run
    ? (
        await ctx.env.WP_OS_DB.prepare("SELECT * FROM constraint_violation WHERE run_id = ?1 ORDER BY severity").bind(run.id).all<Record<string, unknown>>()
      ).results ?? []
    : [];

  const assumptions = (
    await ctx.env.WP_OS_DB.prepare("SELECT assumption_key, assumption_value, basis, stated_by, created_at FROM scenario_assumption WHERE scenario_id = ?1 ORDER BY created_at")
      .bind(scenario.id)
      .all<Record<string, unknown>>()
  ).results ?? [];

  const byType = new Map<string, Array<Record<string, unknown>>>();
  for (const o of options) {
    const t = String(o.option_type);
    byType.set(t, [...(byType.get(t) ?? []), { ...o, result: results.find((r) => r.option_id === o.id) ?? null }]);
  }

  return json({
    scenario,
    comparison_run: run,
    options_by_type: Object.fromEntries(byType),
    constraint_findings: violations,
    assumptions,
    reserved_actions: {
      INITIAL: "investment.approve",
      FOLLOW_ON: "follow_on.approve",
      RESERVE: "reserve_allocation.approve",
      SECONDARY_PURCHASE: "secondary_purchase.approve",
      SECONDARY_SALE: "secondary_sale.approve",
      EXIT: "exit.approve",
    },
    statements: {
      not_a_prediction: "A scenario compares options against stated constraints and assumptions. It is not a forecast and it is not a recommendation.",
      human_decision: "Each option type routes to its own human-reserved approval, and no capital moves without it. West Peek OS never moves capital.",
      computed_here: run
        ? "Constraint, concentration, and reserve effects shown here are the results P11 computed and recorded; nothing is recalculated for display."
        : "No comparison has been run for this scenario yet, so no constraint effects are shown — none are invented.",
      formula_gate: "Allocation formula verification is engineering work that the operator has NOT yet accepted (§7.2). Treat every figure accordingly.",
    },
  });
}
