import type { Env } from "../env";
import { periodStart } from "./routing";
import { evaluateSpend, LADDER, type SpendBehaviour, type SpendLever } from "../../shared/ai/spendLever";
import { readLaneFailure } from "../../shared/ai/laneFailure";

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

/**
 * THE OWNER'S LADDER, IN DOLLARS, because that is how she stated it.
 *
 * This used to be three PERCENTAGES of the ceiling — 10/50/80 — which worked only while the ceiling
 * was $50 and 10% of it happened to land on her $5 target. The ceiling is now $75, and 10% of $75
 * is $7.50, a number she never named. A threshold expressed as a fraction of something else moves
 * when that something else moves, silently, which is precisely what a warning must not do.
 *
 * So the thresholds are absolute and they are hers: $5 and $10 are the gradient's own lines, $50 is
 * where she is NOTIFIED with the bypass decision attached, and $75 is where the firm stops. The
 * `threshold_pct` column is still populated — the schema requires it — but it is now DERIVED from
 * the dollar figure for display, not the thing being compared.
 */
export const FIRM_BUDGET_ALERT_USD = [LADDER.tighteningUsd, LADDER.cautiousUsd, LADDER.notifyUsd] as const;

/** Severity escalates at the notify line: $50 is not the same kind of event as $5. */
function severityFor(thresholdUsd: number): "WARNING" | "BREACH" {
  return thresholdUsd >= LADDER.notifyUsd ? "BREACH" : "WARNING";
}

/**
 * Raise a deduped alert as month-to-date spend crosses one of the owner's lines. Never blocks; the
 * block is `checkFirmBudgets` itself. `INSERT OR IGNORE` on the unique dedupe key does the deduping,
 * so this costs one insert that usually does nothing.
 *
 * AT $50 IT CARRIES THE BYPASS DECISION. Her instruction was not "tell me at $50", it was "notify
 * her, with the bypass decision in front of her" — a notification that only says a number has been
 * passed leaves her to go and find the control, which is how a warning becomes noise. So the $50
 * alert is raised at BREACH severity and `notifyAtFiftyReason` states what the decision is and what
 * happens if she does nothing.
 */
export async function raiseFirmBudgetWarning(
  env: Env,
  firmScope: string,
  window: FirmBudgetWindow,
  capUsd: number,
  observedUsd: number,
  now: Date = new Date(),
): Promise<void> {
  if (capUsd <= 0) return;
  const crossed = [...FIRM_BUDGET_ALERT_USD].reverse().find((t) => observedUsd >= t);
  if (crossed === undefined) return;
  const period = window === "MONTHLY" ? now.toISOString().slice(0, 7) : "ever";
  await env.WP_OS_DB.prepare(
    `INSERT OR IGNORE INTO cost_alert (id, scope_type, scope_id, period, threshold_pct, cap_usd, observed_usd, severity, dedupe_key)
     VALUES (?1, 'FIRM', ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      `calr_${crypto.randomUUID()}`,
      firmScope,
      window,
      // Derived for the column, not the comparison. Rounded to the integer the schema wants.
      Math.round((crossed / capUsd) * 100),
      capUsd,
      Math.round(observedUsd * 1_000_000) / 1_000_000,
      severityFor(crossed),
      `FIRM:${firmScope}:${window}:${period}:USD${crossed}`,
    )
    .run();
}

/**
 * The $50 notification, in the words she needs to decide with. Exported so the page, the alert list
 * and any future delivery channel print the same sentence rather than three glosses of it.
 */
export function notifyAtFiftyReason(observedUsd: number): string {
  return (
    `The firm has spent $${observedUsd.toFixed(2)} this month. You asked to be told at $${LADDER.notifyUsd}. ` +
    `Nothing has stopped: work continues until $${LADDER.hardStopUsd}, where it stops automatically. ` +
    `The decision in front of you is whether to grant a bypass now — a bypass names a higher ceiling, a reason and an ` +
    `expiry, and it lapses on its own. Doing nothing is a real choice and it means the firm stops at $${LADDER.hardStopUsd}.`
  );
}

// ── Bypass: an event with an expiry and a name ──────────────────────────────────────────────

export interface SpendBypassRow {
  id: string;
  firm_scope: string;
  budget_window: FirmBudgetWindow;
  ceiling_cents: number;
  reason: string;
  granted_by: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

/**
 * The bypass in force right now, or null.
 *
 * STRATEGIC_SURGE was a LEVER POSITION, which meant "lift the caps" was a state somebody could
 * leave the firm in by forgetting about it — and the code that read it had to re-validate an
 * expiry, an owner and a budget out of a JSON blob on every call, treating a malformed one as
 * NORMAL. A bypass is a row with those as columns: unexpired, unrevoked, highest ceiling wins, and
 * it lapses without anybody remembering to undo it.
 */
export async function liveBypass(
  env: Env,
  firmScope: string,
  window: FirmBudgetWindow,
  now: Date = new Date(),
): Promise<SpendBypassRow | null> {
  const row = await env.WP_OS_DB.prepare(
    `SELECT * FROM spend_bypass
      WHERE firm_scope = ?1 AND budget_window = ?2 AND revoked_at IS NULL AND expires_at > ?3
      ORDER BY ceiling_cents DESC, created_at DESC LIMIT 1`,
  )
    .bind(firmScope, window, now.toISOString())
    .first<SpendBypassRow>();
  return row ?? null;
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
    /*
     * A CEILING THAT IS ONLY HEARD FROM WHEN IT STOPS THE WORK IS NOT A BUDGET, IT IS AN AMBUSH.
     *
     * The monthly cap is $50, which is the worst case the owner named. Her TARGET is $5. A single
     * warning at 80% of the cap would first speak at $40 — eight times what she expects to spend,
     * and far too late to be information. So the first threshold is her own number.
     *
     * Deduped per (window, month, threshold), so a busy month raises three alerts and not
     * thousands. Written even when the run is allowed, because that is the entire point.
     */
    await raiseFirmBudgetWarning(env, firmScope, w, cap, wouldBe, now);
    if (wouldBe > cap) {
      /*
       * THE HARD STOP IS AUTOMATIC, AND THE BYPASS IS A SEPARATE DECISION SOMEBODY TOOK.
       *
       * $75 is not a lever position she selects — it is where the firm stops, on its own, because
       * she said so once. What she can do is decide, at a moment, for a reason, until a time, that
       * this month may go further; that decision is a `spend_bypass` row and it is consulted HERE
       * rather than folded into the ceiling, so the ceiling she set stays the number she set and
       * the override stays visible as an override.
       *
       * Checked only on the failing path. A firm with no bypass — which is every firm, almost
       * always — pays nothing for this.
       */
      const bypass = await liveBypass(env, firmScope, w, now);
      if (bypass) {
        const bypassCap = centsToUsd(bypass.ceiling_cents);
        if (wouldBe <= bypassCap) continue;
        return {
          ok: false,
          reason:
            `firm_${w.toLowerCase()}_cap_exceeded:${wouldBe.toFixed(6)}>${bypassCap.toFixed(2)} ` +
            `(the $${cap.toFixed(2)} ceiling is bypassed until ${bypass.expires_at} by ${bypass.granted_by}, to $${bypassCap.toFixed(2)}, and that is exceeded too)`,
        };
      }
      return {
        ok: false,
        reason:
          `firm_${w.toLowerCase()}_cap_exceeded:${wouldBe.toFixed(6)}>${cap.toFixed(2)} ` +
          `(this is the automatic stop, not a setting. A bypass names a higher ceiling, a reason and an expiry, and lapses on its own.)`,
      };
    }
  }
  return { ok: true };
}

// ── Where the firm is on the gradient ───────────────────────────────────────────────────────

/**
 * WHAT THE FIRM IS ACTUALLY DOING RIGHT NOW: the lever she set, plus — inside MODERATE only — where
 * this month's spend against this month's elapsed time has put it on the gradient.
 *
 * ONE FUNCTION, so the page, the router and the run record cannot disagree about where she is. The
 * arithmetic itself is pure and lives in shared/ai/spendLever.ts; this is only the read of what the
 * month has cost, through `firmSpend`, which is the same figure every ceiling is measured against.
 *
 * HER HAND ALWAYS WINS, and nothing here writes. The gradient can never move `spend_lever`: if she
 * sets FREE_ONLY it stays free at $0 spent, and if she sets OPEN it stays open at $40. This decides
 * behaviour BETWEEN her instructions and nothing else.
 */
export async function currentSpendBehaviour(
  env: Env,
  firmScope: string,
  lever: SpendLever,
  now: Date = new Date(),
): Promise<SpendBehaviour> {
  const spend = await firmSpend(env, firmScope, "THIS_MONTH", now);
  return evaluateSpend(lever, spend.total_usd, now);
}

// ── What STOPPED, and why, in words she can act on ──────────────────────────────────────────

/**
 * EVERY STATUS `ai_run.status` MAY HOLD, in the order migration 0004 declares them.
 *
 * Written down here because two screens were counting "blocked runs" from two hand-typed lists and
 * getting different answers for the same morning. Home named five statuses literally; the cost
 * centre said "anything not committed". The five Home named omitted `PREFLIGHT_BLOCKED` — which is
 * the status of EVERY named stop the spend lever raises (`free_only_cannot_serve_protected_work`,
 * `no_search_grounded_model_available`, `no_active_priced_model`) — and `FAILED`. So a run the
 * owner's own lever had stopped was invisible on the page she reads first.
 *
 * `scripts/validate/what-stopped-is-counted-once.mjs` reads the CHECK constraint out of
 * migrations/0004_ai_cost_privacy.sql and fails the build if this list and that constraint differ,
 * so a status added in SQL cannot quietly become a run nobody counts.
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

/**
 * Runs that did NOT reach a model, or reached one and got nothing back. Derived — never typed out —
 * so adding a status to the schema adds it here rather than creating a sixth place to forget it.
 */
export const STOPPED_RUN_STATUSES: readonly string[] = Object.freeze(
  AI_RUN_STATUSES.filter((s) => !(COMMITTED_RUN_STATUSES as readonly string[]).includes(s)),
);

export interface StoppedRuns {
  /** How many stopped inside the window. */
  count: number;
  /** The most recent one's timestamp, or null. A count with no clock reads as "right now" forever. */
  last_at: string | null;
  /** One sentence naming the cause, in the owner's vocabulary. Never a status code. */
  reason: string | null;
  /** Can she do anything about it from the Cockpit? Stated, because "2 blocked" alone cannot be acted on. */
  she_can_fix: boolean;
}

/**
 * A count is not a diagnosis. "2 blocked run(s)" is what the owner read on Home this morning and
 * could not act on: no cause, no clock, and no idea whether the thing was still happening. Both
 * numbers now come from here, with the vendor's own classification attached.
 */
export async function stoppedRuns(env: Env, firmScope: string, window: SpendWindow, now: Date = new Date()): Promise<StoppedRuns> {
  const since = spendWindowStart(window, now);
  const list = STOPPED_RUN_STATUSES.map((s) => `'${s}'`).join(",");
  const where = since
    ? `firm_scope = ?1 AND status IN (${list}) AND created_at >= ?2`
    : `firm_scope = ?1 AND status IN (${list})`;
  const rows =
    (
      await env.WP_OS_DB.prepare(
        `SELECT status, failure_reason, created_at FROM ai_run WHERE ${where} ORDER BY created_at DESC`,
      )
        .bind(...(since ? [firmScope, since] : [firmScope]))
        .all<{ status: string; failure_reason: string | null; created_at: string }>()
    ).results ?? [];
  if (rows.length === 0) return { count: 0, last_at: null, reason: null, she_can_fix: false };

  const newest = rows[0]!;
  const failure = readLaneFailure(newest.failure_reason);
  const sentence = stoppedRunSentence(newest.status, newest.failure_reason);
  return {
    count: rows.length,
    last_at: newest.created_at,
    reason: sentence,
    /*
     * WHAT "SHE CAN FIX IT" MEANS HERE: there is a control on the Cockpit that changes this outcome.
     * A lane that is out of credit, refusing a key, or disabled is one she can stand down, fund or
     * re-enable from that page. A vendor having a bad minute is not, and saying so is the honest
     * answer rather than sending her to a page with nothing on it for her.
     */
    she_can_fix: failure.kind === "CREDIT" || failure.kind === "CREDENTIAL" || failure.kind === "NO_LANE",
  };
}

/**
 * The stop, in one sentence. Exported so the page, Home and any future channel print the same words
 * — three glosses of one event is exactly how "what has the firm spent" came to have three answers.
 */
export function stoppedRunSentence(status: string, failureReason: string | null): string {
  const failure = readLaneFailure(failureReason);
  switch (failure.kind) {
    case "CREDIT":
      return "a lane refused the work because the account behind it is out of credit — fund it or stand the lane down on the Cockpit";
    case "CREDENTIAL":
      return `a lane refused our key${failure.lane ? ` (${failure.lane})` : ""} — set or replace that vendor's credential`;
    case "RATE_LIMIT":
      return "a lane was rate-limited; this clears itself and the run will be retried";
    case "LANE_DOWN":
      return "a lane failed to answer; the run fell through the chain and nothing left could serve it";
    case "NO_LANE":
      return "no enabled lane was allowed to serve this work — check which providers are enabled on the Cockpit";
    default:
      break;
  }
  if (status === "BUDGET_BLOCKED") return "a spending ceiling stopped it; raise the cap or grant a bypass on the Cockpit";
  if (status === "EGRESS_BLOCKED") return "its privacy label is not allowed to reach any enabled lane";
  if (status === "KILL_SWITCHED") return "the provider is kill-switched";
  if (status === "PROVIDER_DISABLED") return "every lane that could serve it is disabled";
  if (status === "PREFLIGHT_BLOCKED") {
    return failureReason?.startsWith("free_only")
      ? "the spend lever is set to Free only, and no free lane may see this work (or her Claude Code and Codex seats are away or out of usage), so it stopped rather than spend money or send private work somewhere that trains"
      : "it was stopped before any model was chosen; the run record names which rule";
  }
  return "it stopped without reaching a usable answer; the run record names the lane and the reason";
}
