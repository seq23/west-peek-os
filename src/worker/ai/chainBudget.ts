import { PROVIDER_MAX_OUTPUT_TOKENS } from "./providers/outputCeiling";

/**
 * HOW LONG ONE ATTEMPT MAY TAKE, AND HOW LONG A RUN MAY SPEND LOOKING FOR ONE THAT ANSWERS.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * FIRST, A CORRECTION, BECAUSE THE OBVIOUS READING OF THE DATA IS WRONG
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Completed brief runs on 18 Sep alternate 250s, 69s, 250s, 69s… and that looks exactly like two
 * stages of different sizes. It is not. Joined against `ai_run_routing`, the correlation is perfect
 * and it is with the NUMBER OF LANES TRIED, twelve times out of twelve:
 *
 *     6 attempts → 250.3s   251.0s   250.4s   250.5s   191.2s
 *     2 attempts →  69.1s    68.9s    70.0s    69.2s    69.0s   70.8s   70.1s
 *
 * Six attempts is four 60s timeouts plus a 429 plus the answer; two attempts is one 60s timeout
 * plus the answer. Granite's own generation is the ~9s remainder in both. So NEITHER number is how
 * long a brief takes to write — both are how long the failing chain took, and a deadline sized from
 * them would be a deadline sized to the bug.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT GENERATION ACTUALLY COSTS, MEASURED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `OBSERVED_COMPLETIONS` below is the real sample: every SINGLE-ATTEMPT completion in production
 * on 17–18 Sep 2026, so the time is the model's and nothing else's. It is held as data rather than
 * described in a sentence because the last two deadlines in this repo — 60s, then 180s — were both
 * chosen to match somebody's prose, and `validate:chain-budget` now checks these constants against
 * this table rather than against a comment.
 *
 * Least squares over it: about **4 seconds fixed, plus 11.2 ms per output token**. The fit is
 * tight — 8,669 tokens predicts 101s against 98.5s observed; 4,570 predicts 55s against 53.8s.
 * The slowest completion ever recorded here is **153.6s** (13,396 tokens, claude-sonnet-5), and
 * that run produced the compliant brief of 17 Sep.
 *
 * WHY 180s WOULD STILL HAVE FAILED, and the owner said so before anyone measured: "if the call is
 * 3 min then 180s is prob right on the money and too short." She is right. 180s was set equal to a
 * prose estimate of the same call, which fails roughly half of them by construction, and it sits
 * only 17% above the slowest known-good brief. A deadline is a wall you must not be near.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * AND WHY THE DEADLINE IS NOT SIZED ON THE CALLER'S ASK ALONE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Because callers under-declare, badly, and the table proves it: an employee step declaring
 * `expectedOutputTokens: 400` produced **4,570** tokens — eleven times its own ask — and took 53.8s.
 * Sized on 400 tokens that run would have been killed at 20s, and the chain would have blamed the
 * lane. So the deadline is sized on what the model may ACTUALLY emit — `wireOutputCeiling`, which
 * is also the ceiling now sent on the wire — and the ask only narrows it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * PER-RUNG GENEROUS, TOTAL BOUNDED — the two are only in tension if the budget is on the rung
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A generous per-attempt deadline is only safe because the WHOLE CHAIN is capped. Five rungs at
 * five minutes would be twenty-five minutes of apparent silence, which the owner experiences as
 * nothing happening — the complaint that started the day. `CHAIN_BUDGET_MS` is the answer to that,
 * and `attemptDeadlineMs` shortens the last attempt to whatever is genuinely left rather than
 * promising a deadline the budget cannot honour.
 *
 * `PROVIDER_TIMEOUT_MS` (180s, PR #100) is untouched and remains the adapter fallback for any call
 * that declares nothing. A call that reaches here declares something, and gets a figure derived
 * from measurement instead.
 */

/**
 * EVERY SINGLE-ATTEMPT COMPLETION IN PRODUCTION, 17–18 Sep 2026.
 * `[expectedOutputTokens the caller declared, output_tokens it actually produced, seconds]`.
 *
 * THE ASK IS RECORDED BESIDE THE RESULT because the gap between them is itself a finding: one row
 * declares 400 and produces 4,570. A ceiling derived from the ask alone would have truncated it,
 * so `validate:chain-budget` checks `wireOutputCeiling(ask) >= produced` for EVERY row here — the
 * wire ceiling may never be below something this firm has already written.
 *
 * Single-attempt only, on purpose: a multi-attempt run's wall clock is mostly other lanes timing
 * out, which is what made the 69s/250s pattern look like two stages. Read from `ai_run` joined to
 * `ai_run_routing` where the attempts array has exactly one entry.
 *
 * THIS IS THE EVIDENCE THE CONSTANTS BELOW ARE DERIVED FROM, and `validate:chain-budget` recomputes
 * the fit from it and fails if a constant no longer clears the observed tail. Replace the sample
 * with fresher production data and the constants must be re-justified against it — which is the
 * entire point, and is why it is here rather than in a commit message nobody will find.
 */
export const OBSERVED_COMPLETIONS: ReadonlyArray<
  readonly [askedTokens: number, producedTokens: number, seconds: number]
> = Object.freeze([
  [400, 262, 6.8],
  [400, 577, 10.3],
  [900, 628, 10.8],
  [1200, 1301, 13.5],
  [3000, 1280, 15.1],
  [400, 4570, 53.8],
  [3000, 6209, 72.1],
  [6000, 6582, 68.1],
  [8000, 8669, 98.5],
  [8000, 13396, 153.6],
]);

/**
 * Fixed cost of an attempt before a single output token exists: DNS, TLS, the provider's queue and
 * time-to-first-token.
 *
 * Measured intercept is ~4s. This is 15s — near four times it — because the intercept is what a
 * HEALTHY lane costs, and the thing a deadline has to survive is an unhealthy one: a free rung
 * behind a queue, a cold model, a provider having a slow minute. None of that is visible in a fit
 * over successful calls, so it is bought with headroom rather than pretended away.
 */
export const ATTEMPT_BASE_MS = 15_000;

/**
 * Wall-clock allowed per output token the model may emit.
 *
 * Measured slope is 11.2 ms/token over the ten completions above. This is 25 — 2.2x — so a lane
 * running at less than half its observed speed still finishes inside its deadline. Against the
 * slowest run ever recorded here (13,396 tokens, 153.6s) the allowance is 350s, better than
 * double.
 */
export const MS_PER_OUTPUT_TOKEN = 25;

/**
 * No single lane may hold a run longer than this, whatever the arithmetic says.
 *
 * 300s is 95% above the slowest completion ever observed (153.6s) and 20% above the longest whole
 * CHAIN seen on the worst day (251s). It is also five-sevenths of the chain budget, so a second
 * lane is always reachable after the first one has taken everything it is allowed — a ceiling that
 * consumed the entire budget would turn the chain back into a single point of failure.
 */
export const MAX_ATTEMPT_MS = 300_000;

/**
 * Below this there is no point starting another attempt: a lane given eight seconds aborts on its
 * own deadline, and the only thing the attempt buys is eight more seconds of the owner waiting.
 * Stopping with a named reason is strictly better.
 */
export const MIN_USEFUL_ATTEMPT_MS = 30_000;

/**
 * THE WHOLE-RUN ALLOWANCE FOR FINDING A LANE THAT ANSWERS.
 *
 * The brief's stage lease is ten minutes (`STAGE_LEASE_MINUTES`, `dailyIntelligence.ts`). A run
 * that outlives its lease is picked up and started again while the first is still going, which is
 * how fourteen minutes of retries happened on 17 Sep. So the chain gets 70% of the lease and the
 * caller keeps three minutes to judge the output, rewrite it if the quality gate refuses, and
 * write it away. `validate:chain-budget` reads the lease out of that file and fails if this stops
 * being comfortably inside it.
 *
 * Worst case, brief-class: 300s on the lead lane, then 120s for a second — two real attempts.
 * Worst case, ordinary work: three attempts of ~165s. Either way a run stops after seven minutes
 * with a named reason, instead of the eighteen minutes six rungs at 180s would allow.
 */
export const CHAIN_BUDGET_MS = 420_000;

/** The caller keeps at least this much of its own lease after the chain has given up. */
export const CALLER_RESERVE_MS = 120_000;

/**
 * Callers under-declare, so the ask is a floor on the reply rather than a bound on it — 400 asked,
 * 4,570 delivered. This is what the model is actually ALLOWED to emit: twice the ask, never below
 * 8,192 (which covers that 4,570 and every other overshoot in the sample), never above the shared
 * catalogue ceiling.
 *
 * It is sent ON THE WIRE as well as used for the clock, which is the plumbing PR #100 flagged as
 * belonging here. NOTE WHAT IT IS NOT: it is not the caller's ask. Sending the bare ask would have
 * truncated the compliant brief of 17 Sep at 8,000 tokens when it needed 13,396 — the 256-token
 * defect PR #100 fixed, reintroduced from the other side.
 */
export function wireOutputCeiling(expectedOutputTokens: number): number {
  const wanted = Math.max(0, expectedOutputTokens) * 2;
  return Math.min(PROVIDER_MAX_OUTPUT_TOKENS, Math.max(8_192, wanted));
}

/**
 * How long ONE attempt may take, for a call asking for this many output tokens, with this much of
 * the chain's budget left.
 *
 * Never longer than `MAX_ATTEMPT_MS`, and never longer than what remains — the last attempt in a
 * chain gets the time that is actually left rather than a full deadline the run cannot pay for.
 * That clamp is what makes the worst case fit the budget, and `validate:chain-budget` fails if it
 * is removed.
 */
export function attemptDeadlineMs(expectedOutputTokens: number, remainingMs: number = CHAIN_BUDGET_MS): number {
  const forTheWork = ATTEMPT_BASE_MS + wireOutputCeiling(expectedOutputTokens) * MS_PER_OUTPUT_TOKEN;
  const sized = Math.min(MAX_ATTEMPT_MS, Math.max(MIN_USEFUL_ATTEMPT_MS, forTheWork));
  return Math.max(0, Math.min(sized, remainingMs));
}

/** What is left of the chain's budget, given when it started. */
export function remainingBudgetMs(startedAtMs: number, now: number, budgetMs: number = CHAIN_BUDGET_MS): number {
  return Math.max(0, budgetMs - (now - startedAtMs));
}

/**
 * Is there enough budget left to be worth trying another lane?
 *
 * Deliberately a question about TIME rather than about how many lanes remain. A chain that has
 * burned its budget on two slow lanes must stop even with four candidates still on the list, and a
 * chain of quick refusals may try all six.
 */
export function canTryAnotherLane(remainingMs: number): boolean {
  return remainingMs >= MIN_USEFUL_ATTEMPT_MS;
}

/**
 * The named stop, in the owner's vocabulary and with the arithmetic in it, so "why did this take
 * seven minutes and produce nothing" is answerable from the run record alone.
 */
export function chainBudgetExhaustedReason(lanesTried: number, spentMs: number, lanesLeft: number): string {
  return (
    `chain_budget_exhausted:${lanesTried} lane(s) were tried over ${Math.round(spentMs / 1000)}s and none answered, ` +
    `which is this run's whole budget for finding one. ${lanesLeft} further lane(s) were not tried: continuing would ` +
    `have spent more of the partner's morning on a search that is not working. The lanes it tried, and why each one ` +
    `failed, are on the run's routing record.`
  );
}
