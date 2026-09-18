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
  // The daily brief. Declares 8000; writes three times that. n=68 single-rung completions in
  // production; these are the slowest and the largest of them.
  [8000, 27536, 276.0],
  [8000, 26562, 281.2],
  [8000, 26130, 256.7],
  [8000, 25899, 274.5],
  [8000, 24351, 262.0],
  [8000, 23211, 228.1],
  [8000, 22969, 240.8],
  [8000, 22578, 224.2],
  [8000, 22556, 237.6],
  [8000, 21341, 226.9],
  [8000, 19444, 194.3],
  [8000, 18141, 214.6],
  [8000, 13396, 153.6],
  [8000, 8669, 98.5],
  // Everything else, at the worst case recorded for each declared ask.
  [6000, 17998, 144.2],
  [2500, 9811, 67.9],
  [1200, 10352, 63.9],
  [1500, 4392, 72.4],
  [3000, 6209, 72.1],
  [900, 6938, 45.2],
  [400, 4570, 53.8],
  [20, 5711, 33.8],
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
 * The slowest a model may be assumed to write, in output tokens per second.
 *
 * MEASURED, over 70 single-rung completions above 5,000 tokens: the slowest sustained rate ever
 * recorded here is **83.7 tok/s** and the average is **104.3**. The brief's own band is 84-121.
 *
 * 65 is 22% below the slowest of those, and it is deliberately not a performance target — it is the
 * rate the DEADLINE has to be willing to wait for. `validate:chain-budget` fails if it ever rises
 * above the slowest rate actually observed.
 *
 * WHY NOT 50, WHICH IS WHAT BOTH VALIDATORS ASSUMED UNTIL NOW. Because 50 tok/s and the 32,768-token
 * ceiling are two independent worst cases, and multiplying them gives 655s — longer than the ten
 * minute stage lease that has to contain the attempt, the retry and the caller's own work. No
 * deadline can satisfy that, so a bar built on it is not a bar, it is an impossibility. The honest
 * question is what the system has ACTUALLY written at the slowest rate it has actually managed:
 * 27,536 tokens at 83.7 tok/s. Both validators now measure that instead.
 *
 * REPLACES a fitted `25 ms per token`. That fit came from ten completions dominated by small runs
 * and it was the wrong model: what varies between calls is how MANY tokens are written, not how
 * fast. Rate is stable to within a factor of 1.4 across every run in the sample.
 */
export const MIN_TOKENS_PER_SEC = 65;

/**
 * No single lane may hold a run longer than this, whatever the arithmetic says.
 *
 * THIS CAP GOVERNS THE BRIEF, AND IT IS DOING REAL WORK RATHER THAN PAPERING OVER THE FORMULA.
 * Said plainly here because the previous pass left a 300s cap silently overriding a 655s derivation
 * and nothing said which number was in charge.
 *
 * It is derived twice and the two agree:
 *
 *   · THE LARGEST REPLY THIS SYSTEM HAS EVER WRITTEN, at the conservative floor rate. 27,536
 *     tokens at 65 tok/s is 424s, plus 15s of connection and queue: **439s**. An attempt allowed
 *     less than that could be killed while still legitimately writing.
 *   · THE SLOWEST THING THIS SYSTEM HAS EVER FINISHED. 281.2s, a 26,562-token brief. 450s is 60%
 *     above it.
 *
 * NOT the full 32,768 ceiling at the floor rate, which would be 519s. The ceiling is a guard against
 * a runaway, not a prediction of a reply; requiring the deadline to cover it multiplies a worst-case
 * size by a worst-case rate and produces a number the stage lease cannot hold.
 *
 * WHY 300s WAS WRONG, and it was mine: it sat 6.7% above that 281.2s run. That is the same mistake
 * as 180s — a wall placed where the work already reaches — and the owner named the shape of it
 * before anyone had the numbers: a deadline equal to the expected duration fails half the calls.
 *
 * It is also small enough that a second lane is always reachable inside `CHAIN_BUDGET_MS`, which a
 * cap that consumed the whole budget would not be.
 */
export const MAX_ATTEMPT_MS = 450_000;

/**
 * Below this there is no point starting another attempt: a lane given eight seconds aborts on its
 * own deadline, and the only thing the attempt buys is eight more seconds of the owner waiting.
 * Stopping with a named reason is strictly better.
 */
export const MIN_USEFUL_ATTEMPT_MS = 30_000;

/**
 * THE WHOLE-RUN ALLOWANCE FOR FINDING A LANE THAT ANSWERS.
 *
 * The brief's stage lease is ten minutes (`STAGE_LEASE_MINUTES`, `dailyIntelligence.ts`). A run that
 * outlives its lease is picked up and started again while the first is still going, which is how
 * fourteen minutes of retries happened on 17 Sep. So the chain gets eight minutes and the caller
 * keeps two to judge the output and write it away.
 *
 * It moved with `MAX_ATTEMPT_MS` rather than being left behind, which is the incoherence to avoid:
 * a single attempt permitted 420s inside a 420s chain budget would mean the first lane could
 * consume the entire run and the chain would have exactly one rung. 480s leaves the full attempt
 * plus a real second one.
 *
 * Worst case, brief-class: 420s on the lead lane, then 60s for a second. Worst case, ordinary work:
 * roughly five attempts of 97s. Either way a run stops after eight minutes with a named reason.
 */
export const CHAIN_BUDGET_MS = 480_000;

/** The caller keeps at least this much of its own lease after the chain has given up. */
export const CALLER_RESERVE_MS = 120_000;

/**
 * How far past its own declared ask a caller may actually go, as a multiple.
 *
 * MEASURED, and the reason the deadline is no longer derived from the ask alone. Declarations in
 * this repo are wrong by up to 285x (one caller declares 20 tokens and returns 5,711), and the
 * brief declares 8,000 and returns up to 27,536 — a factor of 3.44. Four covers the brief at its
 * own declared size, which is the call that matters, and the floors below cover the small asks
 * where a multiple alone is useless.
 */
export const OVERSHOOT_MULTIPLE = 4;

/**
 * The smallest per-call wire ceiling. Covers every small-ask overshoot in the sample — 10,352 from a
 * 1,200-token ask, 9,811 from 2,500, 6,938 from 900, 5,711 from a 20-token ask — so no caller is
 * truncated for under-declaring. It is 19% above the largest of those, and `validate:chain-budget`
 * fails if a row ever appears that it would cut.
 */
export const TRUNCATION_FLOOR_TOKENS = 12_288;

/**
 * The smallest token allowance a DEADLINE is sized on. Lower than the truncation floor on purpose:
 * see `deadlineTokenAllowance`. At 4096 the brief's 6.5s market call gets 97s rather than 179s.
 */
export const TIMING_FLOOR_TOKENS = 4_096;

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
  const wanted = Math.max(0, expectedOutputTokens) * OVERSHOOT_MULTIPLE;
  return Math.min(PROVIDER_MAX_OUTPUT_TOKENS, Math.max(TRUNCATION_FLOOR_TOKENS, wanted));
}

/**
 * The tokens a DEADLINE must make room for. Deliberately a smaller floor than the truncation one.
 *
 * WHY THEY DIFFER, and it is the "300-second rope" problem. Truncation is silent and destroys work,
 * so its floor is generous — 8192, which covers every small-ask overshoot in the sample. A DEADLINE
 * with that floor hands a call that finishes in 6.5s a three-minute rope, and a dead search lane
 * then holds a run for three minutes before anybody learns anything. The brief's market call is
 * `perplexity/sonar` at a 6.5s median and a 45.2s worst over 70 runs; it has no business being
 * given the same clock as a 22,000-token write.
 *
 * So timing uses a 4096 floor. At that floor the market call gets 97s — twice its worst observed
 * run — and the brief still gets everything the cap allows. The gap between the two floors is the
 * one case this cannot serve: a call that BOTH overshoots to the truncation floor AND runs at half
 * the slowest rate ever recorded. That is stated rather than hidden, and it costs a failover rather
 * than a truncation, which is the right way round.
 */
export function deadlineTokenAllowance(expectedOutputTokens: number): number {
  const wanted = Math.max(0, expectedOutputTokens) * OVERSHOOT_MULTIPLE;
  return Math.min(PROVIDER_MAX_OUTPUT_TOKENS, Math.max(TIMING_FLOOR_TOKENS, wanted));
}

/**
 * How long ONE attempt may take, for a call asking for this many output tokens, with this much of
 * the chain's budget left.
 *
 * Derived from what the model may ACTUALLY EMIT divided by the slowest rate ever measured, rather
 * than from the caller's ask — because the ask is not reliable and the sample proves it. Never
 * longer than `MAX_ATTEMPT_MS`, and never longer than what remains: the last attempt in a chain
 * gets the time that is genuinely left rather than a deadline the budget cannot honour. That clamp
 * is what makes the worst case fit, and `validate:chain-budget` fails if it is removed.
 */
export function attemptDeadlineMs(expectedOutputTokens: number, remainingMs: number = CHAIN_BUDGET_MS): number {
  const forTheWork = ATTEMPT_BASE_MS + (deadlineTokenAllowance(expectedOutputTokens) / MIN_TOKENS_PER_SEC) * 1000;
  const sized = Math.min(MAX_ATTEMPT_MS, Math.max(MIN_USEFUL_ATTEMPT_MS, forTheWork));
  /*
   * A WHOLE NUMBER OF MILLISECONDS, because `AbortSignal.timeout` takes an integer and throws on
   * anything else. Dividing tokens by a rate produces a float — 4096 / 65 * 1000 is 63015.38 — and
   * the resulting `TypeError: The value of "delay" is out of range` surfaced as
   * `provider_failure:…`, i.e. as though the VENDOR had failed. Forty-four tests caught it; without
   * them every lane in the chain would have "failed" instantly and the run would have deferred with
   * a reason naming the wrong culprit.
   */
  return Math.floor(Math.max(0, Math.min(sized, remainingMs)));
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
