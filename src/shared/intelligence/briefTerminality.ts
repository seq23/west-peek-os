/**
 * IS THIS BRIEF FINISHED? — one answer, for every component that asks.
 *
 * WHAT WENT WRONG, 18 Sep 2026. At 14:58 the two partners' rows for the day read:
 *
 *   fu_scooter_taylor   FAILED      attempts=3   "the brief was rejected twice: ..."
 *   fu_sequoia_taylor   GENERATING  attempts=3   error_message EMPTY
 *
 * His ended stated. Hers did not, and the difference is not cosmetic: the reason on a row is
 * written by the code that finishes the attempt, and hers never ran. Two `ai_run` rows completed at
 * 14:56 and 14:57 — the write stage and its one retry — and the row's `stage_at` never moved from
 * 14:41:47. The isolate was evicted between the model returning and the outcome being persisted.
 * No code of ours ran, so nothing failed the row and nothing was caught. She got a blank card with
 * no reason while her partner's card explained itself.
 *
 * ─── THE STRUCTURAL DEFECT, AND IT IS NOT "IT DID NOT RETRY" ───────────────────────────────────
 *
 * `attempts` counts attempt STARTS and nothing counts attempt ENDS. It is incremented in
 * `startReport`, which the tick calls only for a row that is absent or FAILED. So a row wedged in a
 * NON-terminal state is picked up by every following tick — the skip guard was written as
 * `status === 'FAILED' && attempts >= MAX`, which such a row does not match — advanced again, and
 * charged nothing. Six model calls went to her brief today against a three-attempt budget that was
 * already spent, and had the eviction kept recurring the only brake would have been a thirty-minute
 * staleness timer, not the attempt cap the owner asked for.
 *
 * At the same time the two "is this brief finished?" queries say
 * `status = 'READY' OR (status = 'FAILED' AND attempts >= MAX)`, which her row also does not match.
 * So the row was simultaneously not-finished (so the cron kept spending on it) and not-retryable
 * within budget (so the budget meant nothing). Two components each keeping their own idea of
 * terminal, with no link between them — the defect class this repo already knows by name.
 *
 * ─── THE INVARIANT ─────────────────────────────────────────────────────────────────────────────
 *
 * A report may never REST holding a spent attempt budget in a non-terminal status. That pairing is
 * named here — `stranded` — precisely so it can be detected rather than described, and the
 * recovery's whole job is to turn every stranded row into a FAILED one carrying a sentence a person
 * can read. `validate:brief-ends-stated` drives the full cross-product of status × attempts through
 * `briefTerminality` and fails if any pairing is stranded with nothing that closes it.
 *
 * THE NUMBER IS NOT THE PROBLEM AND IS NOT CHANGED. The owner: "if the brief doesnt land it should
 * self heal and keep trying (at least 2 additional tries for a total of 3 before it says broken)."
 * Three is right. What was missing is that the third failure must ALWAYS produce a stated broken
 * state rather than silence.
 */

/**
 * How many times a partner's brief may be attempted on one date.
 *
 * Three across a morning survives a provider blip and a bad feed. A fourth would be the system
 * insisting rather than trying, and every attempt pays for two AI calls.
 *
 * DECLARED HERE, beside the terminality it governs, because the cap and the definition of
 * "finished" are the same rule seen from two sides and they drifted apart when they lived apart.
 */
export const MAX_BRIEF_ATTEMPTS = 3;

/** The two statuses that mean the pipeline has stopped for the day. */
export const TERMINAL_STATUSES = ["READY", "FAILED"] as const;

export type BriefTerminalityKind =
  /** There is a brief to read. */
  | "delivered"
  /** It failed and has no attempts left. Finished, and it says why. */
  | "failed_out"
  /** It failed and may be tried again today. */
  | "retryable"
  /** Mid-pipeline with budget left. Normal. */
  | "in_progress"
  /**
   * MID-PIPELINE WITH THE BUDGET SPENT. Neither finished nor retryable — the state that must never
   * be at rest, and the one both the skip guard and the done-query used to fall through.
   */
  | "stranded";

export interface BriefTerminality {
  /** True when nothing further is owed today. The done-queries and the tick's skip both use this. */
  terminal: boolean;
  kind: BriefTerminalityKind;
  /** True when this row must be CLOSED by the recovery rather than skipped or advanced. */
  mustBeClosed: boolean;
}

export function briefTerminality(status: string, attempts: number, max: number = MAX_BRIEF_ATTEMPTS): BriefTerminality {
  if (status === "READY") return { terminal: true, kind: "delivered", mustBeClosed: false };
  if (status === "FAILED") {
    return attempts >= max
      ? { terminal: true, kind: "failed_out", mustBeClosed: false }
      : { terminal: false, kind: "retryable", mustBeClosed: false };
  }
  // Non-terminal status. The budget is what decides whether this is alive or stranded.
  if (attempts >= max) {
    /*
     * STRANDED. Advancing it again would spend a fourth, fifth, sixth model call against a budget
     * that is gone; skipping it would leave the partner with a blank card and no reason, for ever.
     * Neither. It is closed, with a sentence, by `closeUnfinishableReports`.
     */
    return { terminal: false, kind: "stranded", mustBeClosed: true };
  }
  return { terminal: false, kind: "in_progress", mustBeClosed: false };
}

/**
 * The SQL form of `terminal`, so the database and the code cannot disagree about what "finished"
 * means. Every query that asks "does this partner still need a brief today?" uses this fragment and
 * nothing else — `validate:brief-ends-stated` reads the service and fails on a hand-written variant.
 */
export const TERMINAL_SQL = `(status = 'READY' OR (status = 'FAILED' AND attempts >= ${MAX_BRIEF_ATTEMPTS}))`;

/**
 * The SQL that finds stranded rows.
 *
 * WHY IT IS NOT SIMPLY "attempts spent and not terminal". A healthy third attempt sits between
 * stages with no lease held — the pipeline is three ticks — and closing that would kill a run that
 * was about to write the brief. So a row counts as stranded only once it is ALSO not holding a
 * stage lease and has not moved for longer than a whole stage's lease. The tick runs every minute,
 * so a live run moves far sooner than that; a dead one never moves again.
 */
export const STRANDED_SQL =
  `status NOT IN ('READY','FAILED') AND attempts >= ${MAX_BRIEF_ATTEMPTS}` +
  " AND (stage_lease_until IS NULL OR stage_lease_until < ?1)" +
  " AND COALESCE(stage_at, started_at) < ?2";

/**
 * What a stranded row is told to say. Written from the row, not from the code that died — the whole
 * point is that the code that would normally write the reason is the code that did not run.
 */
export function strandedReason(attempts: number): string {
  return (
    `The last of its ${attempts} attempts stopped part-way through and never finished, so no reason was ` +
    "recorded. Nothing further will be tried automatically today — build it again when you want one."
  );
}
