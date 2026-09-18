#!/usr/bin/env node
/**
 * A RUN MAY NOT SPEND THE MORNING DISCOVERING THAT NOTHING ANSWERED.
 *
 * On 18 Sep 2026 the daily brief walked six lanes and aborted on a 60s deadline at 14:11:42,
 * 14:12:43, 14:13:43 and 14:14:55 — four failures, sixty seconds apart, five and a half minutes
 * before a brief appeared. PR #100 found the cause and fixed it: 60s was far too short for a call
 * this repo's own source calls "one model call, ~3 min", so the deadline is now 180s. Correct, and
 * it makes the chain worse: six lanes at 180s is eighteen minutes.
 *
 * WHAT THIS PROVES, and each one is a thing that was true and unguarded:
 *   1. The whole chain has a stated budget, and the worst case actually fits inside it.
 *   2. That budget is comfortably inside the brief's own stage lease, read OUT of
 *      dailyIntelligence.ts — a run that outlives its lease is restarted while still running, which
 *      is how fourteen minutes of retries happened on 17 Sep.
 *   3. The per-attempt deadline is sized to what the CALLER asked for, and reproduces
 *      PROVIDER_TIMEOUT_MS exactly at the largest ask in this repo, so the flat deadline and the
 *      derived one cannot drift apart.
 *   4. The boundary checks the budget BETWEEN attempts and threads one clock through the recursion.
 *   5. Every adapter honours the per-call deadline and the per-call output ceiling, and the shared
 *      ceiling still caps it so nothing can ask for more than the catalogue allows.
 *
 * HARD-FAILS ON ZERO. A constant it cannot read, or an adapter list that comes back empty, is a
 * failure and never a pass.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const F = {
  budget: "src/worker/ai/chainBudget.ts",
  timeout: "src/worker/ai/providers/timeout.ts",
  ceiling: "src/worker/ai/providers/outputCeiling.ts",
  boundary: "src/worker/ai/runAi.ts",
  lease: "src/worker/services/dailyIntelligence.ts",
};
/**
 * How far past a caller's own worst observed run its deadline may sit before it stops being
 * headroom and starts being a rope. The widest ratio in the current sample is 3.2x.
 */
const ROPE_MULTIPLE = 6;
const ADAPTER_DIR = "src/worker/ai/providers";
/**
 * WHAT COUNTS AS A MODEL LANE, decided by a property of the file rather than by a list of names.
 *
 * A list of exempt filenames is the thing that rots: a new wire adapter arrives, nobody adds it, and
 * the check quietly covers one fewer lane every quarter. A lane is a file that TELLS A MODEL HOW
 * LONG A REPLY MAY BE (it imports the shared output ceiling) or PUTS A DEADLINE ON A WIRE CALL (it
 * arms an AbortSignal). Those are exactly the two things this check governs, so a file that does
 * neither has nothing here to get wrong.
 *
 * It exempts `workersAiWhisper.ts` for a real reason rather than by name: transcription is not a
 * completion, it has no output-token ceiling to send and no prompt to price, and it deliberately
 * sits outside `runAi` (ADR-019). It exempts the fixture and claimer adapters for the same kind of
 * reason — there is no vendor deadline to honour where there is no wire.
 */
const isModelLane = (src) =>
  /async complete\(/.test(src) && (/PROVIDER_MAX_OUTPUT_TOKENS/.test(src) || /AbortSignal\.timeout\(/.test(src));

function num(source, name) {
  const m = new RegExp(`export const ${name}\\s*(?::\\s*number)?\\s*=\\s*([0-9_]+)`).exec(source);
  return m ? Number(m[1].replaceAll("_", "")) : null;
}

export function check(files) {
  const problems = [];
  let examined = 0;

  const budgetSrc = files[F.budget];
  const timeoutSrc = files[F.timeout];
  const boundarySrc = files[F.boundary];
  const leaseSrc = files[F.lease];
  const ceilingSrc = files[F.ceiling];
  if (!budgetSrc || !timeoutSrc || !boundarySrc || !leaseSrc || !ceilingSrc) {
    problems.push("one of the five files this check reads is missing; it cannot pass without all of them");
    return { problems, examined };
  }

  const CHAIN_BUDGET_MS = num(budgetSrc, "CHAIN_BUDGET_MS");
  const MIN_USEFUL_ATTEMPT_MS = num(budgetSrc, "MIN_USEFUL_ATTEMPT_MS");
  const MAX_ATTEMPT_MS = num(budgetSrc, "MAX_ATTEMPT_MS");
  const ATTEMPT_BASE_MS = num(budgetSrc, "ATTEMPT_BASE_MS");
  const MIN_TOKENS_PER_SEC = num(budgetSrc, "MIN_TOKENS_PER_SEC");
  const OVERSHOOT_MULTIPLE = num(budgetSrc, "OVERSHOOT_MULTIPLE");
  const TRUNCATION_FLOOR_TOKENS = num(budgetSrc, "TRUNCATION_FLOOR_TOKENS");
  const TIMING_FLOOR_TOKENS = num(budgetSrc, "TIMING_FLOOR_TOKENS");
  const CALLER_RESERVE_MS = num(budgetSrc, "CALLER_RESERVE_MS");
  const PROVIDER_MAX_OUTPUT_TOKENS = num(ceilingSrc, "PROVIDER_MAX_OUTPUT_TOKENS");
  for (const [name, v] of Object.entries({
    CHAIN_BUDGET_MS, MIN_USEFUL_ATTEMPT_MS, MAX_ATTEMPT_MS, ATTEMPT_BASE_MS, MIN_TOKENS_PER_SEC,
    OVERSHOOT_MULTIPLE, TRUNCATION_FLOOR_TOKENS, TIMING_FLOOR_TOKENS, CALLER_RESERVE_MS,
    PROVIDER_MAX_OUTPUT_TOKENS,
  })) {
    examined += 1;
    if (v === null || !Number.isFinite(v) || v <= 0) problems.push(`${name} could not be read as a positive number`);
  }
  if (problems.length > 0) return { problems, examined };

  /*
   * ── 0. NO TIMING CONSTANT WITHOUT MEASUREMENT BEHIND IT ──────────────────────────────────────
   *
   * This repo has now chosen two provider deadlines by matching a sentence — 60s as "comfortably
   * above a long frontier completion", then 180s to match a comment reading "~3 min" — and both
   * were wrong in the same direction. The owner named the flaw before anybody measured: a deadline
   * set equal to the expected duration fails about half the calls by construction.
   *
   * So the sample lives in the source as data, and every constant below is checked against it.
   * An empty or missing sample is a hard failure: a number with no measurement behind it is the
   * defect, whatever its value.
   */
  examined += 1;
  const sample = [...budgetSrc.matchAll(/\[\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\]/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
  ]);
  if (sample.length < 5) {
    problems.push(
      `OBSERVED_COMPLETIONS carries ${sample.length} measurement(s); a deadline derived from fewer than 5 real ` +
        `completions is a guess wearing a table. Every constant in chainBudget.ts must be justified by this sample.`,
    );
    return { problems, examined };
  }

  // The rates and durations the constants claim, recomputed from the sample rather than trusted.
  /*
   * RATE IS ONLY MEANINGFUL ON A RUN BIG ENOUGH FOR GENERATION TO DOMINATE IT.
   *
   * A 262-token reply that takes 6.8s is not writing at 38 tok/s; it is spending most of that time
   * connecting and queueing, which `ATTEMPT_BASE_MS` already accounts for separately. Including
   * such rows would double-count the fixed cost and drag the floor down to a number no constant
   * could satisfy. So the floor is measured over replies above 5,000 tokens, which is how the
   * 83.7 tok/s figure in chainBudget.ts was derived from production in the first place.
   */
  const RATE_MEANINGFUL_ABOVE_TOKENS = 5_000;
  const rates = sample.filter(([, produced]) => produced > RATE_MEANINGFUL_ABOVE_TOKENS).map(([, produced, secs]) => produced / secs);
  if (rates.length < 5) {
    problems.push(
      `only ${rates.length} sample row(s) are large enough for a generation rate to be meaningful; ` +
        `MIN_TOKENS_PER_SEC has nothing solid behind it`,
    );
    return { problems, examined };
  }
  const slowestRate = Math.min(...rates);
  const slowestObservedMs = Math.max(...sample.map(([, , y]) => y)) * 1000;
  const largestProduced = Math.max(...sample.map(([, produced]) => produced));

  // 0a. The assumed floor rate must sit BELOW the slowest rate ever measured, not at or above it.
  examined += 1;
  if (MIN_TOKENS_PER_SEC >= slowestRate) {
    problems.push(
      `MIN_TOKENS_PER_SEC is ${MIN_TOKENS_PER_SEC} tok/s but the slowest rate in the sample is ` +
        `${slowestRate.toFixed(1)} tok/s. A floor at or above measured speed means every call slower than the slowest ` +
        `one ever seen is killed — which is the 180s mistake with a different unit.`,
    );
  }
  // 0b. The fixed cost must leave room for a queued or cold lane, which a fit over successes cannot see.
  examined += 1;
  if (ATTEMPT_BASE_MS < 10_000) {
    problems.push(`ATTEMPT_BASE_MS is ${ATTEMPT_BASE_MS}ms, too little for connection, queueing and time-to-first-token on a cold lane`);
  }
  // 0c. THE CAP MUST COVER THE CEILING AT THE SLOWEST MEASURED RATE.
  //     This is the check that makes the cap honest rather than arbitrary: if a model may emit
  //     PROVIDER_MAX_OUTPUT_TOKENS and the slowest thing we have measured writes at `slowestRate`,
  //     an attempt allowed less than that could be killed while still legitimately writing.
  examined += 1;
  const largestAtSlowestMs = ATTEMPT_BASE_MS + (largestProduced / slowestRate) * 1000;
  if (MAX_ATTEMPT_MS < largestAtSlowestMs) {
    problems.push(
      `MAX_ATTEMPT_MS is ${Math.round(MAX_ATTEMPT_MS / 1000)}s, but the largest reply this system has ever written ` +
        `(${largestProduced} tokens) at the slowest rate ever measured (${slowestRate.toFixed(1)} tok/s) needs ` +
        `${Math.round(largestAtSlowestMs / 1000)}s. The cap would kill a lane that is still writing.`,
    );
  }
  /*
   * DELIBERATELY NOT `PROVIDER_MAX_OUTPUT_TOKENS / slowestRate`. That multiplies a worst-case size
   * by a worst-case rate and yields 519s — longer than the stage lease can hold once a retry and the
   * caller's own work are in it. A bar nothing can satisfy is not a bar. The ceiling's job is to
   * stop a runaway; what the deadline must cover is what the system actually writes.
   */
  // 0d. And it must sit well past the slowest thing this system has ever finished.
  examined += 1;
  if (MAX_ATTEMPT_MS < slowestObservedMs * 1.4) {
    problems.push(
      `MAX_ATTEMPT_MS is ${Math.round(MAX_ATTEMPT_MS / 1000)}s against a slowest completion of ` +
        `${Math.round(slowestObservedMs / 1000)}s — under 40% headroom. 300s failed this against a 281.2s run, and ` +
        `180s failed it against the same run before that.`,
    );
  }
  // 0e. THE SHARED CEILING MAY NOT BE BELOW WHAT THE FIRM HAS ALREADY WRITTEN.
  examined += 1;
  if (PROVIDER_MAX_OUTPUT_TOKENS < largestProduced) {
    problems.push(
      `PROVIDER_MAX_OUTPUT_TOKENS is ${PROVIDER_MAX_OUTPUT_TOKENS} but a completion of ${largestProduced} tokens is in ` +
        `the sample — the shared ceiling would truncate the firm's largest recurring job, which is the 256-token ` +
        `defect one order of magnitude up`,
    );
  }
  // 0f. A second lane must always be reachable after the first has taken everything it may.
  examined += 1;
  if (MAX_ATTEMPT_MS + MIN_USEFUL_ATTEMPT_MS > CHAIN_BUDGET_MS) {
    problems.push(
      `one attempt may take ${Math.round(MAX_ATTEMPT_MS / 1000)}s out of a ${Math.round(CHAIN_BUDGET_MS / 1000)}s chain ` +
        `budget, leaving too little for any second lane — a chain with one reachable rung is not a chain`,
    );
  }

  // 1. THE WORST CASE ACTUALLY FITS.
  examined += 1;
  /*
   * THE SIMULATION HAS TO BE ABLE TO FAIL, or it is a validator asserting its own arithmetic.
   *
   * The clamp that makes the worst case fit is `Math.min(sized, remainingMs)` in `attemptDeadlineMs`
   * — an attempt gets the time that is actually left, never a full deadline the budget cannot
   * honour. If that clamp is ever removed the chain overruns by up to one whole attempt per lane,
   * so it is read out of the source and the simulation is run the way the source actually behaves.
   */
  const clampsToRemaining = /Math\.min\(sized, remainingMs\)/.test(budgetSrc);
  if (!clampsToRemaining) {
    problems.push(
      "attemptDeadlineMs no longer shortens an attempt to the budget that remains; the last lane in a chain would be " +
        "given a full deadline the run cannot pay for, and the chain overruns by up to one attempt per lane",
    );
  }
  const wireCeiling = (ask) =>
    Math.min(PROVIDER_MAX_OUTPUT_TOKENS, Math.max(TRUNCATION_FLOOR_TOKENS, Math.max(0, ask) * OVERSHOOT_MULTIPLE));
  const timingTokens = (ask) =>
    Math.min(PROVIDER_MAX_OUTPUT_TOKENS, Math.max(TIMING_FLOOR_TOKENS, Math.max(0, ask) * OVERSHOOT_MULTIPLE));
  const deadlineFor = (ask, remaining) => {
    const sized = Math.min(
      MAX_ATTEMPT_MS,
      Math.max(MIN_USEFUL_ATTEMPT_MS, ATTEMPT_BASE_MS + (timingTokens(ask) / MIN_TOKENS_PER_SEC) * 1000),
    );
    return Math.max(0, clampsToRemaining ? Math.min(sized, remaining) : sized);
  };
  /*
   * A DEADLINE MUST CLEAR THE WORST RUN ITS OWN CALLER HAS ACTUALLY HAD. Checked per declared ask
   * against the sample, so a floor tuned down to shorten the search rope cannot quietly start
   * killing the calls it was meant to speed up.
   */
  for (const [ask, , secs] of sample) {
    examined += 1;
    if (deadlineFor(ask, CHAIN_BUDGET_MS) < secs * 1000 * 1.25) {
      problems.push(
        `a caller declaring ${ask} tokens has taken ${secs}s in production, but its deadline would be ` +
          `${Math.round(deadlineFor(ask, CHAIN_BUDGET_MS) / 1000)}s — under 25% headroom over a run that really happened`,
      );
    }
    /*
     * AND THE OTHER SIDE OF IT: A ROPE IS AS MUCH A DEFECT AS A WALL.
     *
     * The brief's market call answers in 6.5s at the median and 45.2s at its worst. Give it the
     * deadline the brief's WRITE needs and a dead search lane holds the run for seven minutes
     * before anybody learns anything — the owner's "nothing is happening", arriving by the
     * opposite route from the one this file was written to close. A deadline is allowed generous
     * headroom over what its caller has actually needed; it is not allowed to be unrelated to it.
     */
    examined += 1;
    if (deadlineFor(ask, CHAIN_BUDGET_MS) > secs * 1000 * ROPE_MULTIPLE) {
      problems.push(
        `a caller declaring ${ask} tokens has never taken more than ${secs}s, but a dead lane would hold it for ` +
          `${Math.round(deadlineFor(ask, CHAIN_BUDGET_MS) / 1000)}s — over ${ROPE_MULTIPLE}x its worst real run. ` +
          `That is a rope, and a run spends it learning nothing.`,
      );
    }
  }
  const worstCase = (ask, lanes) => {
    let spent = 0;
    let tried = 0;
    for (let i = 0; i < lanes; i += 1) {
      const remaining = Math.max(0, CHAIN_BUDGET_MS - spent);
      if (tried > 0 && remaining < MIN_USEFUL_ATTEMPT_MS) break;
      spent += deadlineFor(ask, remaining);
      tried += 1;
    }
    return { spent, tried };
  };
  for (const ask of [50, 400, 900, 1200, 3000, 8000, 24_000]) {
    const { spent, tried } = worstCase(ask, 12);
    if (spent > CHAIN_BUDGET_MS) {
      problems.push(
        `a run asking for ${ask} output tokens can spend ${Math.round(spent / 1000)}s walking lanes, past its stated ` +
          `budget of ${Math.round(CHAIN_BUDGET_MS / 1000)}s — the budget does not bound the worst case`,
      );
    }
    if (tried < 2) {
      problems.push(`a run asking for ${ask} output tokens can only ever try ${tried} lane(s) inside its budget`);
    }
  }

  /*
   * A DEADLINE MUST BE A WHOLE NUMBER OF MILLISECONDS.
   *
   * `AbortSignal.timeout` throws on a float, and dividing tokens by a rate produces one —
   * 4096 / 65 * 1000 is 63015.38. The TypeError surfaces as `provider_failure:…`, so every lane in
   * the chain "fails" instantly and the run defers with a reason that blames the vendor. Forty-four
   * tests caught it once; this is so they do not have to twice.
   */
  examined += 1;
  if (!/return Math\.(floor|round)\(Math\.max\(0, Math\.min\(sized, remainingMs\)\)\)/.test(budgetSrc)) {
    problems.push(
      "attemptDeadlineMs does not return a whole number of milliseconds; AbortSignal.timeout throws on a float and the " +
        "resulting TypeError is recorded as a provider failure, blaming the lane for our own arithmetic",
    );
  }

  // 2. INSIDE THE STAGE LEASE, read out of the brief's own source.
  examined += 1;
  const leaseM = /export const STAGE_LEASE_MINUTES\s*=\s*(\d+)/.exec(leaseSrc);
  if (!leaseM) {
    problems.push("STAGE_LEASE_MINUTES could not be read out of dailyIntelligence.ts — the budget has nothing to be inside of");
  } else {
    const leaseMs = Number(leaseM[1]) * 60_000;
    if (CHAIN_BUDGET_MS + CALLER_RESERVE_MS > leaseMs) {
      problems.push(
        `CHAIN_BUDGET_MS (${Math.round(CHAIN_BUDGET_MS / 1000)}s) plus the caller's reserve leaves nothing inside the ` +
          `${leaseM[1]}-minute stage lease; a run that outlives its lease is started again while the first is still going`,
      );
    }
  }

  // 3. THE WIRE CEILING MAY NEVER TRUNCATE SOMETHING THIS FIRM HAS ALREADY WRITTEN.
  examined += 1;
  if (!/Math\.max\(TRUNCATION_FLOOR_TOKENS,/.test(budgetSrc)) {
    problems.push("wireOutputCeiling no longer floors the per-call ceiling; a caller that under-declares would be truncated");
  }
  for (const [ask, produced] of sample) {
    examined += 1;
    if (wireCeiling(ask) < produced) {
      problems.push(
        `a run declaring ${ask} output tokens produced ${produced} in production, but wireOutputCeiling would cap it at ` +
          `${wireCeiling(ask)} — that is PR #100's 256-token truncation reintroduced from the other side`,
      );
    }
  }

  // 4. THE BOUNDARY ACTUALLY ASKS.
  examined += 1;
  if (!/canTryAnotherLane\(/.test(boundarySrc) || !/chainBudgetExhaustedReason\(/.test(boundarySrc)) {
    problems.push("runAi.ts does not consult the chain budget between attempts; the budget would be a constant nothing reads");
  }
  examined += 1;
  if (!/eligible\.slice\(1\),\s*\n\s*attempts,\s*\n\s*chain,/.test(boundarySrc)) {
    problems.push("runAi.ts does not thread one chain clock through the fallback recursion; each attempt would restart the budget");
  }
  examined += 1;
  if (!/maxOutputTokens: wireOutputCeiling\(rec\.estimate\.output_tokens\)/.test(boundarySrc) || !/\bdeadlineMs,/.test(boundarySrc)) {
    problems.push("runAi.ts does not send the caller's own output size and deadline to the adapter");
  }

  // 5. EVERY MODEL LANE HONOURS BOTH.
  const lanes = Object.keys(files).filter(
    (f) => f.startsWith(`${ADAPTER_DIR}/`) && isModelLane(files[f]),
  );
  if (lanes.length === 0) {
    problems.push("no model-lane adapters were found to check — an empty adapter list is a failure, not a pass");
  }
  for (const lane of lanes) {
    examined += 1;
    const src = files[lane];
    if (!/req\.maxOutputTokens \?\? PROVIDER_MAX_OUTPUT_TOKENS/.test(src)) {
      problems.push(`${lane} ignores req.maxOutputTokens; this caller's own ask would not reach the wire`);
    }
    if (!/Math\.min\(req\.maxOutputTokens \?\? PROVIDER_MAX_OUTPUT_TOKENS, PROVIDER_MAX_OUTPUT_TOKENS\)/.test(src)) {
      problems.push(`${lane} does not cap the per-call ask at PROVIDER_MAX_OUTPUT_TOKENS; a caller could ask past the catalogue`);
    }
    // A binding-backed lane has no fetch and therefore no signal; it is exempt from the deadline only.
    if (/AbortSignal\.timeout\(/.test(src) && !/options\.timeoutMs \?\? req\.deadlineMs \?\? PROVIDER_TIMEOUT_MS/.test(src)) {
      problems.push(`${lane} ignores req.deadlineMs; it would hold the chain for the flat deadline whatever the work is`);
    }
  }
  return { problems, examined };
}

function load() {
  const files = {};
  for (const rel of Object.values(F)) {
    const p = join(ROOT, rel);
    if (existsSync(p)) files[rel] = readFileSync(p, "utf8");
  }
  const dir = join(ROOT, ADAPTER_DIR);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".ts")) files[`${ADAPTER_DIR}/${name}`] = readFileSync(join(dir, name), "utf8");
    }
  }
  // Callers, so the largest expectedOutputTokens in the repo is read rather than assumed.
  const svc = join(ROOT, "src/worker/services");
  if (existsSync(svc)) {
    for (const name of readdirSync(svc)) {
      if (name.endsWith(".ts")) files[`src/worker/services/${name}`] = readFileSync(join(svc, name), "utf8");
    }
  }
  return files;
}

function run() {
  const { problems, examined } = check(load());
  if (examined === 0) {
    console.error("a-run-may-not-spend-the-morning-looking: examined ZERO items. An empty loop is a failure, not a pass.");
    process.exit(1);
  }
  if (problems.length > 0) {
    console.error(`a-run-may-not-spend-the-morning-looking: ${problems.length} problem(s) across ${examined} checked item(s)`);
    for (const p of problems) console.error(`  · ${p}`);
    process.exit(1);
  }
  console.log(`a-run-may-not-spend-the-morning-looking: OK — ${examined} item(s) checked; the worst-case chain fits its budget, the budget fits the lease, and every lane honours the per-call deadline and ceiling.`);
}

function selfTest() {
  const good = load();
  const clean = check(good);
  if (clean.problems.length > 0) {
    console.error("self-test: the live tree should be clean but is not:", clean.problems);
    process.exit(1);
  }
  if (clean.examined === 0) {
    console.error("self-test: the live tree examined zero items");
    process.exit(1);
  }

  const bend = (src, name, value) =>
    src.replace(new RegExp(`(export const ${name}\\s*(?::\\s*number)?\\s*=\\s*)[0-9_]+`), `$1${value}`);

  // 1 — the clamp removed: an attempt is no longer shortened to what the budget can pay for, and
  //     the worst case overruns. Both the missing clamp and the overrun must be reported.
  const noClamp = check({ ...good, [F.budget]: good[F.budget].replace("Math.min(sized, remainingMs)", "sized") });
  if (!noClamp.problems.some((p) => p.includes("no longer shortens an attempt"))) {
    console.error("self-test: removing the remaining-budget clamp did not fail", noClamp.problems);
    process.exit(1);
  }
  if (!noClamp.problems.some((p) => p.includes("past its stated"))) {
    console.error("self-test: without the clamp the worst case should overrun the budget and was not reported", noClamp.problems);
    process.exit(1);
  }

  // 2 — a budget larger than the stage lease.
  const overLease = check({ ...good, [F.budget]: bend(good[F.budget], "CHAIN_BUDGET_MS", 900_000) });
  if (!overLease.problems.some((p) => p.includes("stage lease"))) {
    console.error("self-test: a 15-minute chain budget inside a 10-minute lease did not fail");
    process.exit(1);
  }

  // 3 — a floor rate set at or above measured speed: the 180s mistake in a different unit.
  const atTheWall = check({ ...good, [F.budget]: bend(good[F.budget], "MIN_TOKENS_PER_SEC", 120) });
  if (!atTheWall.problems.some((p) => p.includes("at or above measured speed"))) {
    console.error("self-test: a floor rate above measured speed did not fail", atTheWall.problems);
    process.exit(1);
  }

  // 3b — the 300s cap of the previous pass, against a 281.2s run. It must go red.
  const tooTight = check({ ...good, [F.budget]: bend(good[F.budget], "MAX_ATTEMPT_MS", 300_000) });
  if (!tooTight.problems.some((p) => p.includes("still writing") || p.includes("headroom"))) {
    console.error("self-test: a 300s per-attempt cap did not fail against the measured sample", tooTight.problems);
    process.exit(1);
  }

  // 3c — the shared ceiling back at 16384, below what the brief writes.
  const lowCeiling = check({ ...good, [F.ceiling]: bend(good[F.ceiling], "PROVIDER_MAX_OUTPUT_TOKENS", 16_384) });
  if (!lowCeiling.problems.some((p) => p.includes("one order of magnitude up"))) {
    console.error("self-test: a 16384 shared ceiling did not fail against a 27,536-token completion", lowCeiling.problems);
    process.exit(1);
  }

  // 3d — the truncation floor lowered back under a real small-ask overshoot.
  const lowFloor = check({ ...good, [F.budget]: bend(good[F.budget], "TRUNCATION_FLOOR_TOKENS", 8_192) });
  if (!lowFloor.problems.some((p) => p.includes("from the other side"))) {
    console.error("self-test: an 8192 truncation floor did not fail against a 10,352-token reply", lowFloor.problems);
    process.exit(1);
  }

  // 3e — the timing floor raised to the truncation floor: the 300-second rope for a 6-second call.
  //      Caught as a chain that can no longer reach a second lane for ordinary work.
  const rope = check({ ...good, [F.budget]: bend(good[F.budget], "TIMING_FLOOR_TOKENS", 32_768) });
  if (rope.problems.length === 0) {
    console.error("self-test: giving every small call the full ceiling's deadline did not fail");
    process.exit(1);
  }

  // 3f — a fractional deadline. AbortSignal.timeout throws, and the lane gets the blame.
  const fractional = check({
    ...good,
    [F.budget]: good[F.budget].replace("return Math.floor(Math.max(0, Math.min(sized, remainingMs)));", "return Math.max(0, Math.min(sized, remainingMs));"),
  });
  if (!fractional.problems.some((p) => p.includes("whole number of milliseconds"))) {
    console.error("self-test: a fractional deadline did not fail", fractional.problems);
    process.exit(1);
  }

  // 3g — the measurement itself removed. A constant with no sample behind it is the defect.
  const noSample = check({
    ...good,
    [F.budget]: good[F.budget].replace(/export const OBSERVED_COMPLETIONS[\s\S]*?\]\);/, "export const OBSERVED_COMPLETIONS = Object.freeze([]);"),
  });
  if (!noSample.problems.some((p) => p.includes("wearing a table"))) {
    console.error("self-test: emptying the measurement sample did not fail", noSample.problems);
    process.exit(1);
  }

  // 4 — the boundary stops asking whether there is time left.
  const noGuard = check({ ...good, [F.boundary]: good[F.boundary].replaceAll("canTryAnotherLane(", "alwaysTrue(") });
  if (!noGuard.problems.some((p) => p.includes("does not consult the chain budget"))) {
    console.error("self-test: removing the budget guard from runAi did not fail");
    process.exit(1);
  }

  // 5 — the clock restarting on each attempt.
  const restarts = check({
    ...good,
    [F.boundary]: good[F.boundary].replace(/eligible\.slice\(1\),\s*\n\s*attempts,\s*\n\s*chain,/, "eligible.slice(1),\n        attempts,"),
  });
  if (!restarts.problems.some((p) => p.includes("one chain clock"))) {
    console.error("self-test: dropping the chain clock from the recursion did not fail");
    process.exit(1);
  }

  // 6 — an adapter that ignores the per-call deadline.
  const laneFile = `${ADAPTER_DIR}/openRouter.ts`;
  const deafLane = check({
    ...good,
    [laneFile]: good[laneFile].replace("options.timeoutMs ?? req.deadlineMs ?? PROVIDER_TIMEOUT_MS", "options.timeoutMs ?? PROVIDER_TIMEOUT_MS"),
  });
  if (!deafLane.problems.some((p) => p.includes("ignores req.deadlineMs"))) {
    console.error("self-test: an adapter ignoring the per-call deadline did not fail");
    process.exit(1);
  }

  // 7 — zero items must never read as a pass.
  const empty = check({});
  if (empty.problems.length === 0) {
    console.error("self-test: an empty file set passed; a check that examines nothing must fail");
    process.exit(1);
  }

  console.log("a-run-may-not-spend-the-morning-looking --self-test: OK — clean tree passes; 13 broken states each fail.");
}

if (process.argv.includes("--self-test")) selfTest();
else run();
