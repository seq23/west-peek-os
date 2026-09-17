import type { Env } from "../env";
import type { TaskKind } from "../../shared/ai/spendLever";

/**
 * WHICH MODELS ACTUALLY DO WHICH JOBS — and the honest limit on saying so.
 *
 * WHAT THIS REPLACES. Model selection judges "cheapest adequate" on paper specs: a context window,
 * two capability booleans and a price. That is exactly how `perplexity/sonar` won a JUDGING job —
 * migration 0158 gave it a price of $1/$1, which made it the cheapest priced model on the account,
 * and by that single configuration row it became the answer for every unpinned call in the firm. It
 * then refused its own answer three times and blocked Parker's packet. Nothing in the catalogue
 * recorded that it had done the job badly, because nothing in the catalogue recorded outcomes at
 * all.
 *
 * So outcomes are recorded, by (task kind, model), and the router prefers the cheapest model that
 * has ACTUALLY DONE THIS JOB WELL over the cheapest that merely looks adequate.
 *
 * ── THE HONEST LIMIT, AND IT IS BUILT IN RATHER THAN NOTED ──────────────────────────────────
 *
 * There are a few hundred runs of history in this system. That is not enough to rank models, and a
 * design that pretended otherwise would repeat the sonar failure with a different single number —
 * three accepted runs is not evidence, it is an anecdote with a denominator.
 *
 * AN UNPROVEN MODEL IS UNKNOWN, NOT GOOD. The two rules that follow from that are the whole design:
 *
 *   1. A cell below `MIN_RUNS_FOR_EVIDENCE` reports INSUFFICIENT_EVIDENCE — it does not report a
 *      rate. There is no number to round, so there is no number to be misread.
 *   2. UNKNOWN NEVER WINS A JOB THAT MATTERS. Evidence may only ever REORDER models that have
 *      already passed the capability filter, and an unproven model can never be promoted past a
 *      proven one on protected work. Where the evidence is insufficient, selection falls back to
 *      exactly the capability-and-price rule it uses today. This is the "state it plainly rather
 *      than guess" requirement, expressed as behaviour and not as a caveat on a screen.
 *
 * HOW LONG BEFORE THIS DOES ANYTHING USEFUL. The grid is four task kinds by roughly six registered
 * models, and a cell needs 20 decided outcomes. At the September run rate — about 210 committed runs
 * in 17 days, of which only the ones a human actually accepted or discarded count — the busy cells
 * (mechanical work on the default cheap model) should cross the threshold in two to four weeks. The
 * protected cells will take months, because protected runs are rarer and each needs a human
 * decision. Until a cell crosses, this module changes NOTHING about that cell's routing and says so
 * on the run. That is the intended behaviour for at least the first month, not a defect.
 */

/**
 * How many decided outcomes a (task kind, model) cell needs before it may influence anything.
 *
 * Twenty, and the number is a judgement rather than a derivation — but it is the smallest number at
 * which one bad run moves an acceptance rate by 5 points rather than by 33, which is the property
 * that matters. Below it the cell reports insufficient evidence and is invisible to routing.
 */
export const MIN_RUNS_FOR_EVIDENCE = 20;

/**
 * A cell must beat this acceptance rate to be called PROVEN. A model a human threw away a third of
 * the time has not done the job well, however cheap it is.
 */
export const PROVEN_ACCEPTANCE_RATE = 0.8;

/** A cell at or below this is actively AVOIDED, not merely unpromoted. */
export const POOR_ACCEPTANCE_RATE = 0.5;

export type ModelJobOutcome = "SUCCEEDED" | "REWORKED" | "REJECTED";

export type EvidenceVerdict = "PROVEN" | "POOR" | "INSUFFICIENT_EVIDENCE";

export interface CellEvidence {
  taskKind: TaskKind;
  providerId: string;
  model: string;
  succeeded: number;
  reworked: number;
  rejected: number;
  decided: number;
  /** Null — not zero, and not 1 — when there is not enough evidence to state one. */
  acceptanceRate: number | null;
  verdict: EvidenceVerdict;
}

/**
 * The verdict for one cell. Pure, so the rule can be tested without a database and so the page and
 * the router cannot hold two versions of "proven".
 *
 * REWORKED COUNTS AGAINST, and it counts in the denominator rather than as a rejection. A run that
 * needed a fallback to a different model did eventually produce something a human may have accepted;
 * what it did NOT do is do the job on its own. Treating it as a rejection would punish a model for
 * a provider outage; ignoring it would hide the case this table was built for.
 */
export function verdictFor(counts: { succeeded: number; reworked: number; rejected: number }): {
  decided: number;
  acceptanceRate: number | null;
  verdict: EvidenceVerdict;
} {
  const decided = counts.succeeded + counts.reworked + counts.rejected;
  if (decided < MIN_RUNS_FOR_EVIDENCE) {
    return { decided, acceptanceRate: null, verdict: "INSUFFICIENT_EVIDENCE" };
  }
  const rate = counts.succeeded / decided;
  return {
    decided,
    acceptanceRate: Math.round(rate * 1000) / 1000,
    verdict: rate >= PROVEN_ACCEPTANCE_RATE ? "PROVEN" : rate <= POOR_ACCEPTANCE_RATE ? "POOR" : "INSUFFICIENT_EVIDENCE",
  };
}

/**
 * Record what happened. Called from the two places a human actually decides — accept and discard —
 * and from the router when a fallback was needed.
 *
 * NEVER THROWS. This is bookkeeping attached to a decision that has already been taken; a failure to
 * record an outcome must not undo a partner's accept. A dropped row costs the grid one data point,
 * which is recoverable; a failed accept costs the firm the work.
 */
export async function recordModelJobOutcome(
  env: Env,
  args: {
    taskKind: TaskKind | null;
    providerId: string | null;
    model: string | null;
    outcome: ModelJobOutcome;
    aiRunId: string;
    firmScope: string;
  },
): Promise<boolean> {
  // A run from before the marker was stored, or one that never reached a provider, has nothing to
  // attribute. Absent from the evidence is the honest state; a guess would be worse than a gap.
  if (!args.taskKind || !args.providerId || !args.model) return false;
  try {
    await env.WP_OS_DB.prepare(
      `INSERT OR IGNORE INTO model_job_outcome (id, task_kind, provider_id, model, outcome, ai_run_id, firm_scope)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(`mjo_${crypto.randomUUID()}`, args.taskKind, args.providerId, args.model, args.outcome, args.aiRunId, args.firmScope)
      .run();
    return true;
  } catch {
    return false;
  }
}

/**
 * The evidence for one task kind, keyed `providerId model` so a caller can look a candidate up
 * directly. One grouped query rather than one per candidate: this runs inside the AI boundary on
 * every routed call, and a per-candidate lookup is how a gate becomes the reason work is slow.
 */
export async function evidenceForTaskKind(env: Env, taskKind: TaskKind): Promise<Map<string, CellEvidence>> {
  const rows =
    (
      await env.WP_OS_DB.prepare(
        `SELECT provider_id, model,
                SUM(CASE WHEN outcome = 'SUCCEEDED' THEN 1 ELSE 0 END) AS succeeded,
                SUM(CASE WHEN outcome = 'REWORKED'  THEN 1 ELSE 0 END) AS reworked,
                SUM(CASE WHEN outcome = 'REJECTED'  THEN 1 ELSE 0 END) AS rejected
           FROM model_job_outcome
          WHERE task_kind = ?1
          GROUP BY provider_id, model`,
      )
        .bind(taskKind)
        .all<{ provider_id: string; model: string; succeeded: number; reworked: number; rejected: number }>()
    ).results ?? [];

  const out = new Map<string, CellEvidence>();
  for (const r of rows) {
    const counts = { succeeded: Number(r.succeeded), reworked: Number(r.reworked), rejected: Number(r.rejected) };
    out.set(`${r.provider_id} ${r.model}`, { taskKind, providerId: r.provider_id, model: r.model, ...counts, ...verdictFor(counts) });
  }
  return out;
}

export interface LearnedOrdering<T extends { providerId: string; model: string; estimatedCostUsd: number }> {
  ordered: T[];
  /** What the evidence did, in one clause, appended to the run's explanation. Never silent. */
  note: string;
  /** True only when evidence actually changed the order. */
  applied: boolean;
}

/**
 * PREFER THE CHEAPEST MODEL THAT HAS ACTUALLY DONE THIS JOB WELL.
 *
 * The candidates arriving here have ALREADY passed every capability and privacy filter — this can
 * only reorder them, never widen the set. That constraint is the reason a thin evidence table is
 * safe to consult at all: the worst it can do is pick a differently-adequate model.
 *
 * The order, and each tier is sorted by price within itself:
 *
 *   1. PROVEN cells, cheapest first. This is the whole point: a model that has done this job well
 *      twenty times beats a cheaper one that has never been asked.
 *   2. Cells with INSUFFICIENT_EVIDENCE, in whatever order they arrived. Unknown is neither
 *      promoted nor punished — it keeps today's behaviour exactly.
 *   3. POOR cells, last. This is the sonar case: demonstrated, repeatedly, that it cannot do this
 *      job, and no price makes that adequate.
 *
 * WHEN NOTHING IS PROVEN, NOTHING HAPPENS. If no candidate has enough evidence the input order is
 * returned untouched and the note says so, which is the state this system will be in for most cells
 * for at least the first month.
 */
export function orderByEvidence<T extends { providerId: string; model: string; estimatedCostUsd: number }>(
  candidates: T[],
  evidence: Map<string, CellEvidence>,
  taskKind: TaskKind,
): LearnedOrdering<T> {
  const verdictOf = (c: T): EvidenceVerdict => evidence.get(`${c.providerId} ${c.model}`)?.verdict ?? "INSUFFICIENT_EVIDENCE";

  const proven = candidates.filter((c) => verdictOf(c) === "PROVEN").sort((a, b) => a.estimatedCostUsd - b.estimatedCostUsd);
  const unknown = candidates.filter((c) => verdictOf(c) === "INSUFFICIENT_EVIDENCE");
  const poor = candidates.filter((c) => verdictOf(c) === "POOR").sort((a, b) => a.estimatedCostUsd - b.estimatedCostUsd);

  if (proven.length === 0 && poor.length === 0) {
    return {
      ordered: candidates,
      applied: false,
      note:
        ` No model has yet done '${taskKind}' work ${MIN_RUNS_FOR_EVIDENCE} times with a human decision on it, so there is ` +
        `insufficient evidence to prefer one on past performance and this call was routed on capability and price alone.`,
    };
  }

  const ordered = [...proven, ...unknown, ...poor];
  const parts: string[] = [];
  if (proven.length > 0) {
    const head = proven[0]!;
    const cell = evidence.get(`${head.providerId} ${head.model}`)!;
    parts.push(
      `${head.model} is the cheapest model with a proven record on '${taskKind}' work (${cell.succeeded} of ${cell.decided} ` +
        `decided outcomes accepted), so it was preferred over cheaper models with no record.`,
    );
  }
  if (poor.length > 0) {
    parts.push(
      `${poor.map((p) => p.model).join(", ")} ${poor.length === 1 ? "has" : "have"} a measured record of NOT doing this job ` +
        `well and ${poor.length === 1 ? "was" : "were"} moved to last regardless of price.`,
    );
  }
  if (unknown.length > 0) {
    parts.push(`${unknown.length} candidate${unknown.length === 1 ? "" : "s"} had insufficient evidence and kept their existing order.`);
  }
  return { ordered, applied: true, note: ` ${parts.join(" ")}` };
}

/** The whole grid, for the screen. Reports gaps as gaps rather than as zeroes. */
export async function evidenceGrid(env: Env): Promise<CellEvidence[]> {
  const rows =
    (
      await env.WP_OS_DB.prepare(
        `SELECT task_kind, provider_id, model,
                SUM(CASE WHEN outcome = 'SUCCEEDED' THEN 1 ELSE 0 END) AS succeeded,
                SUM(CASE WHEN outcome = 'REWORKED'  THEN 1 ELSE 0 END) AS reworked,
                SUM(CASE WHEN outcome = 'REJECTED'  THEN 1 ELSE 0 END) AS rejected
           FROM model_job_outcome
          GROUP BY task_kind, provider_id, model
          ORDER BY task_kind, model`,
      ).all<{ task_kind: TaskKind; provider_id: string; model: string; succeeded: number; reworked: number; rejected: number }>()
    ).results ?? [];
  return rows.map((r) => {
    const counts = { succeeded: Number(r.succeeded), reworked: Number(r.reworked), rejected: Number(r.rejected) };
    return { taskKind: r.task_kind, providerId: r.provider_id, model: r.model, ...counts, ...verdictFor(counts) };
  });
}
