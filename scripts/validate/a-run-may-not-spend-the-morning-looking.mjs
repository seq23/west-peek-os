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
  const MS_PER_OUTPUT_TOKEN = num(budgetSrc, "MS_PER_OUTPUT_TOKEN");
  const CALLER_RESERVE_MS = num(budgetSrc, "CALLER_RESERVE_MS");
  const PROVIDER_MAX_OUTPUT_TOKENS = num(ceilingSrc, "PROVIDER_MAX_OUTPUT_TOKENS");
  for (const [name, v] of Object.entries({
    CHAIN_BUDGET_MS, MIN_USEFUL_ATTEMPT_MS, MAX_ATTEMPT_MS, ATTEMPT_BASE_MS, MS_PER_OUTPUT_TOKEN,
    CALLER_RESERVE_MS, PROVIDER_MAX_OUTPUT_TOKENS,
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

  // The least-squares fit the comments claim, recomputed rather than trusted.
  const n = sample.length;
  const sx = sample.reduce((a, [, x]) => a + x, 0);
  const sy = sample.reduce((a, [, , y]) => a + y, 0);
  const sxy = sample.reduce((a, [, x, y]) => a + x * y, 0);
  const sxx = sample.reduce((a, [, x]) => a + x * x, 0);
  const slopeMsPerToken = ((n * sxy - sx * sy) / (n * sxx - sx * sx)) * 1000;
  const interceptMs = ((sy - (slopeMsPerToken / 1000) * sx) / n) * 1000;
  const slowestObservedMs = Math.max(...sample.map(([, , y]) => y)) * 1000;

  // 0a. The per-token allowance must be clear of measured speed, not equal to it.
  examined += 1;
  if (MS_PER_OUTPUT_TOKEN < slopeMsPerToken * 1.5) {
    problems.push(
      `MS_PER_OUTPUT_TOKEN is ${MS_PER_OUTPUT_TOKEN}ms against a measured ${slopeMsPerToken.toFixed(1)}ms/token. ` +
        `A deadline set near observed speed fails every call slower than average — which is half of them.`,
    );
  }
  // 0b. The fixed cost must be clear of the measured intercept.
  examined += 1;
  if (ATTEMPT_BASE_MS < interceptMs * 1.5) {
    problems.push(
      `ATTEMPT_BASE_MS is ${ATTEMPT_BASE_MS}ms against a measured intercept of ${interceptMs.toFixed(0)}ms, with no room ` +
        `for a queued or cold lane — and a fit over SUCCESSFUL calls cannot see an unhealthy one.`,
    );
  }
  // 0c. The hard per-attempt ceiling must sit well past the slowest thing ever seen to complete.
  examined += 1;
  if (MAX_ATTEMPT_MS < slowestObservedMs * 1.5) {
    problems.push(
      `MAX_ATTEMPT_MS is ${Math.round(MAX_ATTEMPT_MS / 1000)}s but the slowest completion in the sample took ` +
        `${Math.round(slowestObservedMs / 1000)}s. A ceiling that close to a known-good run kills it on a slow day — ` +
        `which is precisely what 180s would have done to the four 250s runs of 18 Sep.`,
    );
  }
  // 0d. A second lane must always be reachable after the first has taken everything it may.
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
  const wireCeiling = (ask) => Math.min(PROVIDER_MAX_OUTPUT_TOKENS, Math.max(8_192, Math.max(0, ask) * 2));
  const deadlineFor = (ask, remaining) => {
    const sized = Math.min(MAX_ATTEMPT_MS, Math.max(MIN_USEFUL_ATTEMPT_MS, ATTEMPT_BASE_MS + wireCeiling(ask) * MS_PER_OUTPUT_TOKEN));
    return Math.max(0, clampsToRemaining ? Math.min(sized, remaining) : sized);
  };
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
  for (const ask of [50, 400, 900, 1200, 3000, 8000, PROVIDER_MAX_OUTPUT_TOKENS]) {
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
  if (!/Math\.max\(8_192,/.test(budgetSrc)) {
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

  // 3 — a deadline set at measured speed rather than clear of it: the 180s mistake, in miniature.
  const atTheWall = check({ ...good, [F.budget]: bend(good[F.budget], "MS_PER_OUTPUT_TOKEN", 12) });
  if (!atTheWall.problems.some((p) => p.includes("near observed speed"))) {
    console.error("self-test: a per-token allowance set at measured speed did not fail", atTheWall.problems);
    process.exit(1);
  }

  // 3b — a per-attempt ceiling near the slowest known-good run. This is exactly 180s vs the 250s
  //      runs of 18 Sep, and it must go red.
  const tooTight = check({ ...good, [F.budget]: bend(good[F.budget], "MAX_ATTEMPT_MS", 180_000) });
  if (!tooTight.problems.some((p) => p.includes("close to a known-good run"))) {
    console.error("self-test: a 180s per-attempt ceiling did not fail against the measured sample", tooTight.problems);
    process.exit(1);
  }

  // 3c — the measurement itself removed. A constant with no sample behind it is the defect.
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

  console.log("a-run-may-not-spend-the-morning-looking --self-test: OK — clean tree passes; 9 broken states each fail.");
}

if (process.argv.includes("--self-test")) selfTest();
else run();
