import type { Env } from "../env";
import { periodStart } from "./routing";

/**
 * ONE definition of what the firm has spent. Everything that puts a spend figure on a screen, or
 * enforces a ceiling, reads it from here.
 *
 * WHY THIS FILE EXISTS — the operator found it, not a test. Three places answered "what has the
 * firm spent" and they disagreed by 28% while wearing the same label:
 *
 *   1. `dailySpendUsd` (the AI boundary, the cost centre's "today", Home) counted actual provider
 *      cost where one was reported and the pre-call ESTIMATE otherwise, over queued/running/
 *      completed runs.
 *   2. Diagnostics summed `actual_usage_json.cost_usd` alone, over runs of ANY status, and so
 *      counted an estimate-only run as costing nothing and a blocked run as if it had run.
 *   3. The cost centre's all-time headline summed actual cost over COMPLETED runs only, which
 *      silently valued every run the provider never priced at zero.
 *
 * Same word, three populations. It is the same class of bug as "follow-on candidate" — one word
 * over several populations — and the fix is the same: name the population once, put it behind one
 * function, and make every reader use it.
 *
 * THE DEFINITION, in one sentence, and it is the sentence printed on the page:
 *
 *   Committed spend = the provider's own reported cost where there is one, otherwise the estimate
 *   recorded before the call, counted only for runs that reached a provider (queued, running or
 *   completed), plus anything bought from a vendor outside the model boundary.
 *
 * Two things it deliberately does NOT do. It never counts a blocked run — nothing was bought. And
 * it never treats an unpriced call as free: an estimate is a number, and a vendor charge the vendor
 * did not price is reported as unpriced rather than rolled in as zero.
 */

/** Runs that reached a provider. Everything else was refused before any money moved. */
export const COMMITTED_RUN_STATUSES = ["QUEUED", "RUNNING", "COMPLETED"] as const;

/**
 * The one sentence, for the screen. UI must print this beside any spend figure rather than writing
 * its own gloss — three glosses is how the firm got three numbers.
 */
export const COMMITTED_SPEND_DEFINITION =
  "What the provider actually charged where it said, and our own estimate where it did not, for every run that reached a model — plus anything bought from another vendor. Work that was refused before it ran counts as nothing, because nothing was bought.";

export type SpendWindow = "TODAY" | "THIS_MONTH" | "ALL_TIME";

/** Plain-English name for a window, so no caller invents its own wording. */
export const SPEND_WINDOW_LABEL: Record<SpendWindow, string> = {
  TODAY: "today",
  THIS_MONTH: "this month",
  ALL_TIME: "since the first run",
};

/**
 * Inclusive lower bound for a window, or null for all time.
 *
 * TODAY and THIS_MONTH delegate to `periodStart`, which the scoped-budget enforcement already uses,
 * so a firmwide month and a scoped monthly budget can never start on different days.
 */
export function spendWindowStart(window: SpendWindow, now: Date): string | null {
  if (window === "ALL_TIME") return null;
  return periodStart(window === "TODAY" ? "DAILY" : "MONTHLY", now);
}

/**
 * Committed cost of one run row, in dollars. The in-memory twin of the SQL below; the cost centre
 * groups runs by employee/model/machine in JS and must not compute this a second way.
 *
 * Note the shape of the fallback: if a provider returned usage but no price, that is a REPORTED
 * zero and is honoured as one. Only a run with no usage at all falls back to its estimate.
 */
export function committedCostOf(row: {
  status: string;
  cost_estimate_json: string;
  actual_usage_json: string | null;
}): number {
  if (!(COMMITTED_RUN_STATUSES as readonly string[]).includes(row.status)) return 0;
  if (row.actual_usage_json) {
    try {
      return (JSON.parse(row.actual_usage_json) as { cost_usd?: number }).cost_usd ?? 0;
    } catch {
      return 0;
    }
  }
  try {
    return (JSON.parse(row.cost_estimate_json) as { estimated_cost_usd?: number }).estimated_cost_usd ?? 0;
  } catch {
    return 0;
  }
}

/**
 * The SQL twin of `committedCostOf`, kept literally beside it so the two cannot drift. Written as a
 * CASE rather than a COALESCE across both columns on purpose: COALESCE would fall through to the
 * estimate when a provider reported usage without a price, which is the opposite of what the JS
 * does and would make the same run cost two different amounts depending on who asked.
 */
const COMMITTED_COST_SQL = `CASE
        WHEN actual_usage_json IS NOT NULL
          THEN COALESCE(CAST(json_extract(actual_usage_json, '$.cost_usd') AS REAL), 0)
        ELSE COALESCE(CAST(json_extract(cost_estimate_json, '$.estimated_cost_usd') AS REAL), 0)
      END`;

const COMMITTED_STATUS_SQL = COMMITTED_RUN_STATUSES.map((s) => `'${s}'`).join(",");

export interface FirmSpend {
  window: SpendWindow;
  /** Everything that went through the governed model boundary. */
  model_usd: number;
  /** Everything bought outside it — image generation today. */
  vendor_usd: number;
  /** The firm's number. This is the one a cap is measured against. */
  total_usd: number;
  /** Runs counted, so a figure of $0.00 can be told apart from nothing having happened. */
  runs: number;
  /** Vendor charges the vendor did not price. Real money of an unknown amount, never counted as 0. */
  unpriced_vendor_calls: number;
  /** First committed run inside the window, or null. */
  first_run_at: string | null;
}

/** Round to the sixth decimal — sub-cent model pricing is real and must not be rounded away. */
function usd(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * What the firm has spent over a window. The single source every screen and every ceiling reads.
 *
 * Summed in SQL rather than by loading rows: `ai_run` grows without limit, and a page that loads
 * every run the firm has ever made stops working precisely when the firm is busiest.
 */
export async function firmSpend(env: Env, firmScope: string, window: SpendWindow, now: Date = new Date()): Promise<FirmSpend> {
  const since = spendWindowStart(window, now);

  const runWhere = since
    ? `firm_scope = ?1 AND status IN (${COMMITTED_STATUS_SQL}) AND created_at >= ?2`
    : `firm_scope = ?1 AND status IN (${COMMITTED_STATUS_SQL})`;
  const runBinds: unknown[] = since ? [firmScope, since] : [firmScope];
  const runs = await env.WP_OS_DB.prepare(
    `SELECT COUNT(*) AS runs,
            COALESCE(SUM(${COMMITTED_COST_SQL}), 0) AS spent,
            MIN(created_at) AS first_run
       FROM ai_run
      WHERE ${runWhere}`,
  )
    .bind(...runBinds)
    .first<{ runs: number; spent: number; first_run: string | null }>();

  const vendorWhere = since ? `firm_scope = ?1 AND created_at >= ?2` : `firm_scope = ?1`;
  const vendors = await env.WP_OS_DB.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS spent,
            SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
       FROM vendor_spend
      WHERE ${vendorWhere}`,
  )
    .bind(...runBinds)
    .first<{ spent: number; unpriced: number }>();

  const model = Number(runs?.spent ?? 0);
  const vendor = Number(vendors?.spent ?? 0);
  return {
    window,
    model_usd: usd(model),
    vendor_usd: usd(vendor),
    total_usd: usd(model + vendor),
    runs: Number(runs?.runs ?? 0),
    unpriced_vendor_calls: Number(vendors?.unpriced ?? 0),
    first_run_at: runs?.first_run ?? null,
  };
}

// ── The firmwide ceiling ──

export type FirmBudgetWindow = "MONTHLY" | "ALL_TIME";

export interface FirmBudgetRow {
  id: string;
  firm_scope: string;
  budget_window: FirmBudgetWindow;
  cap_cents: number;
  version_no: number;
  active: number;
  reason: string;
  set_by: string;
  created_at: string;
}

export interface FirmBudgetState {
  budget_window: FirmBudgetWindow;
  /** Null means the operator has not set one. Nothing is invented, and the screen says so. */
  cap_usd: number | null;
  spent_usd: number;
  remaining_usd: number | null;
  used_pct: number | null;
  version_no: number | null;
  reason: string | null;
  set_by: string | null;
  set_at: string | null;
}

/**
 * The cap in force for a window, or null if none was ever set.
 *
 * Versioned like every other policy here: a change writes a new row, the old one stays readable,
 * and "retired" is a row with active = 0 rather than a delete. The highest version wins, so the
 * answer is deterministic no matter what order rows were written in.
 */
export async function currentFirmBudget(env: Env, firmScope: string, window: FirmBudgetWindow): Promise<FirmBudgetRow | null> {
  const row = await env.WP_OS_DB.prepare(
    `SELECT * FROM firm_spend_budget
      WHERE firm_scope = ?1 AND budget_window = ?2
      ORDER BY version_no DESC LIMIT 1`,
  )
    .bind(firmScope, window)
    .first<FirmBudgetRow>();
  if (!row || row.active !== 1) return null;
  return row;
}

/** Cents in, dollars out. Money is stored as an integer count of cents; only display divides. */
export function centsToUsd(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * Both firmwide ceilings with their current usage, ready for the screen.
 *
 * DETERMINISTIC, and that word was the operator's. Given the same database and the same instant,
 * this returns the same numbers to the page, to Diagnostics, and to the gate that refuses a run —
 * because all three call this and none of them re-derive anything.
 */
export async function firmBudgetStates(env: Env, firmScope: string, now: Date = new Date()): Promise<FirmBudgetState[]> {
  const windows: Array<{ budget: FirmBudgetWindow; spend: SpendWindow }> = [
    { budget: "MONTHLY", spend: "THIS_MONTH" },
    { budget: "ALL_TIME", spend: "ALL_TIME" },
  ];
  const out: FirmBudgetState[] = [];
  for (const w of windows) {
    const row = await currentFirmBudget(env, firmScope, w.budget);
    const spend = await firmSpend(env, firmScope, w.spend, now);
    const cap = row ? centsToUsd(row.cap_cents) : null;
    out.push({
      budget_window: w.budget,
      cap_usd: cap,
      spent_usd: spend.total_usd,
      remaining_usd: cap === null ? null : usd(cap - spend.total_usd),
      used_pct: cap === null || cap <= 0 ? null : Math.round((spend.total_usd / cap) * 1000) / 10,
      version_no: row?.version_no ?? null,
      reason: row?.reason ?? null,
      set_by: row?.set_by ?? null,
      set_at: row?.created_at ?? null,
    });
  }
  return out;
}

export interface FirmBudgetVerdict {
  ok: boolean;
  /** Set when a ceiling would be breached. Names the window, the ceiling and the figure. */
  reason?: string;
}

/**
 * Would this run take the firm past a ceiling it set? Called from the AI boundary before the money
 * is spent, never after.
 *
 * A budget that displays but does not bind is worse than none — it reads as protection while
 * providing none — so this is wired into the same preflight as the daily cap and refuses with the
 * real figures in the reason rather than a generic "budget exceeded".
 */
export async function checkFirmBudgets(
  env: Env,
  firmScope: string,
  wouldSpendUsd: number,
  now: Date = new Date(),
): Promise<FirmBudgetVerdict> {
  /*
   * ONE QUERY FOR BOTH WINDOWS, and the spend sums only happen for a window that actually has a
   * ceiling. This runs on EVERY AI call, and the firm is on a plan where 10 ms of CPU per
   * invocation was the root cause of the morning brief failing for days — so a gate nobody has
   * configured must cost one indexed lookup and nothing else.
   */
  const rows = (
    await env.WP_OS_DB.prepare(
      `SELECT * FROM firm_spend_budget b
        WHERE b.firm_scope = ?1
          AND b.version_no = (
            SELECT MAX(b2.version_no) FROM firm_spend_budget b2
             WHERE b2.firm_scope = b.firm_scope AND b2.budget_window = b.budget_window
          )
          AND b.active = 1`,
    )
      .bind(firmScope)
      .all<FirmBudgetRow>()
  ).results ?? [];
  if (rows.length === 0) return { ok: true };

  for (const w of ["MONTHLY", "ALL_TIME"] as const) {
    const row = rows.find((r) => r.budget_window === w);
    if (!row) continue;
    const cap = centsToUsd(row.cap_cents);
    const spend = await firmSpend(env, firmScope, w === "MONTHLY" ? "THIS_MONTH" : "ALL_TIME", now);
    const wouldBe = spend.total_usd + wouldSpendUsd;
    if (wouldBe > cap) {
      return {
        ok: false,
        reason: `firm_${w.toLowerCase()}_cap_exceeded:${wouldBe.toFixed(6)}>${cap.toFixed(2)}`,
      };
    }
  }
  return { ok: true };
}
