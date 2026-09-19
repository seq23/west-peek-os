#!/usr/bin/env node
/**
 * a-brief-always-ends-stated.mjs — `npm run validate:brief-ends-stated`.
 *
 * ONE ASSERTION: A BRIEF MAY NEVER REST HOLDING A SPENT ATTEMPT BUDGET IN A NON-TERMINAL STATUS.
 * Whatever happens to it, the day ends with either a brief or a sentence saying why there is none.
 *
 * WHAT WENT WRONG, 18 Sep 2026. At 14:58 the two partners' rows for the day read:
 *
 *   fu_scooter_taylor   FAILED      attempts=3   "the brief was rejected twice: ..."
 *   fu_sequoia_taylor   GENERATING  attempts=3   error_message EMPTY
 *
 * His write stage completed and the quality gate failed it, so the code that records the reason
 * ran. Hers made both its model calls — `ai_run` rows completed at 14:56 and 14:57 — and the row's
 * `stage_at` never moved from 14:41:47: the isolate was evicted between the model returning and the
 * outcome being persisted. No code of ours ran, so nothing failed the row and nothing was caught.
 * One partner's card explained itself and the other's was blank. That asymmetry is the defect.
 *
 * THE STRUCTURAL CAUSE, AND IT IS NOT "IT DID NOT RETRY". `attempts` counts attempt STARTS and
 * nothing counts attempt ENDS — it is incremented in `startReport`, which the tick calls only for a
 * row that is absent or FAILED. The skip guard asked `status === 'FAILED' && attempts >= MAX`, and
 * the two "is this finished?" queries asked the same by hand. A row wedged mid-pipeline with the
 * budget already spent matched NONE of them, so it was neither finished, nor skipped, nor charged:
 * it was advanced again by every tick, two model calls at a time, free. Six calls went to her brief
 * against a three-attempt cap, and the only brake was a thirty-minute staleness timer.
 *
 * WHAT IS CHECKED
 *   1 · EVERY PAIRING RESOLVES, AND STRANDING IS DETECTED. `briefTerminality` is IMPORTED AND RUN
 *       over the full cross-product of every status `intelligence_report.status` accepts — read off
 *       that table's own CHECK constraint — by every attempt count either side of the cap. A spent
 *       budget in a non-terminal status must come back `stranded` and marked for closure; nothing
 *       else may be; and nothing may be both finished and awaiting closure.
 *   2 · ONE DEFINITION OF FINISHED, NOT THREE. Both done-queries and the tick's skip guard use the
 *       shared answer. A hand-written `status = 'READY' OR (status = 'FAILED' AND …)` anywhere in
 *       the service is the drift that caused this and fails the build.
 *   3 · SOMETHING ACTUALLY CLOSES THE STRANDED ROWS, BEFORE THEY ARE ADVANCED. The recovery exists,
 *       uses the shared predicate, is called from the tick, and is called BEFORE any row is
 *       advanced — a stranded row left in place is advanced again by the very tick that found it.
 *   4 · AND THE SENTENCE IS ONE SHE CAN ACT ON: it says the run stopped, that nothing further will
 *       be tried automatically, and what she can do — and leaks no status, error code or column.
 *
 * THE CAP IS NOT CHANGED. The owner: "if the brief doesnt land it should self heal and keep trying
 * (at least 2 additional tries for a total of 3 before it says broken)." Three is asserted here, so
 * a later edit that quietly raises or lowers it fails the build.
 *
 * HARD-FAILS ON ZERO. Zero statuses, zero pairings examined, or an unread service exits 1.
 *
 * `--self-test` restores the real pre-fix shapes — the terminality that has no stranded state, the
 * hand-written skip guard, a recovery that runs after the advance — and requires each to be caught.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVICE = path.join(ROOT, "src", "worker", "services", "dailyIntelligence.ts");
const SCHEMA = path.join(ROOT, "migrations", "0035_daily_intelligence_pipeline.sql");
const MODULE = path.join(ROOT, "src", "shared", "intelligence", "briefTerminality.ts");

const read = (f) => readFileSync(f, "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const fileUrl = (p) => new URL(`file://${p}`).href;

/**
 * Every status the brief's table accepts.
 *
 * ANCHORED TO THE TABLE. The first `CHECK (status IN …)` in that migration belongs to
 * `tracked_narrative`, and reading it reports a confident pass having tested none of the brief's
 * statuses — three is not zero, so a zero-guard does not catch it. The result must also contain the
 * two statuses this check is about, or it is treated as unread.
 */
export function statusesFromSchema(sql) {
  const table = /CREATE TABLE IF NOT EXISTS intelligence_report\s*\(([\s\S]*?)\n\);/.exec(sql);
  if (!table) return [];
  const m = /CHECK \(status IN \(([^)]*)\)\)/.exec(table[1]);
  if (!m) return [];
  const list = m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean);
  if (!list.includes("READY") || !list.includes("FAILED")) return [];
  return list;
}

// ── 1 · Every pairing resolves, and stranding is detected ──────────────────────────────────────

export function checkEveryPairingResolves(briefTerminality, statuses, max) {
  const violations = [];
  let examined = 0;
  for (const status of statuses) {
    for (let attempts = 0; attempts <= max + 2; attempts += 1) {
      examined += 1;
      const t = briefTerminality(status, attempts, max);
      if (!t || typeof t.terminal !== "boolean" || !t.kind) {
        violations.push(`${status}/${attempts} resolves to nothing`);
        continue;
      }
      const spent = attempts >= max;
      const terminalStatus = status === "READY" || status === "FAILED";
      if (spent && !terminalStatus) {
        if (t.kind !== "stranded") {
          violations.push(
            `${status} with its budget spent (${attempts}/${max}) resolves as "${t.kind}", not stranded — ` +
              "that is the pairing that left a partner a blank card with no reason on 18 Sep 2026",
          );
        }
        if (t.mustBeClosed !== true) {
          violations.push(`${status}/${attempts} is stranded but nothing is asked to close it`);
        }
      } else if (t.mustBeClosed === true) {
        violations.push(`${status}/${attempts} is marked for closure but still has somewhere to go`);
      }
      if (t.terminal === true && t.mustBeClosed === true) {
        violations.push(`${status}/${attempts} is reported finished AND needing closure — closing it is what writes the reason`);
      }
    }
  }
  return { violations, examined };
}

/** The owner's number, asserted so a later edit cannot quietly move it. */
export function checkTheCapIsThree(max) {
  return max === 3
    ? { violations: [], examined: 1 }
    : {
        violations: [
          `MAX_BRIEF_ATTEMPTS is ${max}. The owner asked for "at least 2 additional tries for a total of 3 ` +
            'before it says broken". Changing it needs her, not a refactor.',
        ],
        examined: 1,
      };
}

// ── 2 · One definition of finished, not three ──────────────────────────────────────────────────

export function checkOneDefinitionOfFinished(service) {
  const violations = [];
  const body = stripComments(service);
  let examined = 0;

  examined += 1;
  const handWritten = /status = 'READY' OR \(status = 'FAILED' AND attempts >=/;
  if (handWritten.test(body)) {
    violations.push(
      "a hand-written terminal predicate is back in the service. Two of these and a third written as a " +
        "skip guard is how a row ended up matching none of them and being advanced for free",
    );
  }
  /*
   * EVERY SQL done-query uses the shared fragment — and there is exactly the number of them the
   * service has, counted rather than assumed (19 Sep 2026: `briefsOwedToday`, the sweep job's gate,
   * went with the branch it gated; the count went from two to one and "both" stopped being the
   * right word). Stricter than the old `>= 2`: any SQL in the service that names READY and FAILED
   * together in a WHERE must be the fragment, so a second done-query written by hand is caught
   * whatever the count, and the gate that was deleted may not quietly return.
   */
  // Since 19 Sep 2026 (on demand only) the service has NO SQL done-query at all — both of them went
  // with the schedule they served. What must hold: none returns written by hand, and the tick asks
  // `briefTerminality` (checked below). A fragment use, if one ever returns, is fine; a hand-written
  // pair is not.
  const shared = (body.match(/\$\{TERMINAL_SQL\}/g) ?? []).length;
  if (shared > 0 && !/TERMINAL_SQL,/.test(body)) violations.push("a done-query uses the fragment without importing it");
  const byHand = (body.match(/WHERE[^`]*status\s*=\s*'FAILED'\s*AND\s*attempts\s*>=/g) ?? []).length;
  if (byHand > 0) violations.push(`${byHand} done-quer${byHand === 1 ? "y" : "ies"} write${byHand === 1 ? "s" : ""} FAILED-and-spent by hand instead of using the shared fragment`);
  if (/briefsOwedToday/.test(body)) violations.push("briefsOwedToday is back — the brief must not ride inside the sweep job's gate again");

  examined += 1;
  if (!/briefTerminality\(row\.status, row\.attempts\)\.terminal/.test(body)) {
    violations.push("the tick does not ask the shared answer whether a row is finished");
  }
  if (/row\?\.status === "FAILED" && row\.attempts >= MAX_BRIEF_ATTEMPTS/.test(body)) {
    violations.push(
      "the old skip guard is back. It tests FAILED only, so a row wedged mid-pipeline with the budget " +
        "spent is skipped by nothing and advanced by every tick",
    );
  }
  return { violations, examined };
}

// ── 3 · Something closes them, before they are advanced ────────────────────────────────────────

export function checkSomethingClosesThem(service) {
  const violations = [];
  const body = stripComments(service);
  let examined = 1;

  if (!/export async function closeUnfinishableReports/.test(body)) {
    violations.push("nothing closes a stranded report, so it stays blank and reasonless until someone notices");
    return { violations, examined };
  }
  if (!body.includes("${STRANDED_SQL}")) {
    violations.push("the recovery writes its own stranded predicate instead of the shared one");
  }
  const call = body.indexOf("closeUnfinishableReports(env, now)");
  const advance = body.indexOf("const step = await advanceBrief(env, actor, p.id, now, deps)");
  if (call === -1) {
    violations.push("the recovery is never called from the tick — it exists but nothing invokes it");
  } else if (advance !== -1 && call > advance) {
    violations.push(
      "the recovery runs AFTER rows are advanced. A stranded row left in place is advanced again by the " +
        "very tick that found it, spending two more model calls against a budget of nothing",
    );
  }
  return { violations, examined };
}

// ── 4 · The sentence she is left with ──────────────────────────────────────────────────────────

export function checkTheSentence(strandedReason, max) {
  const violations = [];
  const said = strandedReason(max);
  const examined = 1;
  if (!/stopped part-way through/i.test(said)) violations.push("the sentence does not say the run stopped part-way");
  if (!/nothing further will be tried automatically/i.test(said)) {
    violations.push(
      "the sentence does not say the automatic attempts are over. That is the whole difference between a " +
        "card she can act on and one she has to interpret",
    );
  }
  if (!/build it again/i.test(said)) violations.push("the sentence does not tell her what she can do");
  for (const leak of ["GENERATING", "unfinishable", "stage_at", "attempts >="]) {
    if (said.includes(leak)) violations.push(`the sentence leaks "${leak}" at her`);
  }
  return { violations, examined };
}

// ── Self-test ──────────────────────────────────────────────────────────────────────────────────

/** The real pre-fix shape: no stranded state at all — everything non-terminal is "in progress". */
function prefixTerminality(status, attempts, max) {
  if (status === "READY") return { terminal: true, kind: "delivered", mustBeClosed: false };
  if (status === "FAILED" && attempts >= max) return { terminal: true, kind: "failed_out", mustBeClosed: false };
  return { terminal: false, kind: "in_progress", mustBeClosed: false };
}

const PREFIX_SERVICE = `
  const done = \`SELECT firm_user_id FROM intelligence_report
     WHERE status = 'READY' OR (status = 'FAILED' AND attempts >= \${MAX_BRIEF_ATTEMPTS})\`;
  if (row?.status === "READY") continue;
  if (row?.status === "FAILED" && row.attempts >= MAX_BRIEF_ATTEMPTS) continue;
  const step = await advanceBrief(env, actor, p.id, now, deps);
`;

const RECOVERY_TOO_LATE = `
  const step = await advanceBrief(env, actor, p.id, now, deps);
  await closeUnfinishableReports(env, now);
  export async function closeUnfinishableReports(env, now) { \`\${STRANDED_SQL}\` }
`;

async function selfTest() {
  let failed = 0;
  const say = (ok, what) => {
    if (!ok) {
      console.error(`SELF-TEST FAILED — ${what}`);
      failed += 1;
    }
  };

  const statuses = statusesFromSchema(read(SCHEMA));
  say(statuses.length > 1, `read ${statuses.length} statuses out of the schema`);
  say(statuses.includes("GENERATING"), "the schema read did not include GENERATING — the status that stranded");

  // 1 · the pre-fix terminality, which had no stranded state
  const pre = checkEveryPairingResolves(prefixTerminality, statuses, 3);
  say(pre.examined > 10, "the pre-fix terminality was barely examined");
  say(pre.violations.length > 0, "the real pre-fix terminality — GENERATING/3 reported as merely in progress — passed");

  const mod = await import(fileUrl(MODULE));
  const now = checkEveryPairingResolves(mod.briefTerminality, statuses, mod.MAX_BRIEF_ATTEMPTS);
  say(now.violations.length === 0, `the shipped terminality fails its own standard: ${now.violations.join("; ")}`);

  say(checkTheCapIsThree(3).violations.length === 0, "the owner's three was rejected");
  say(checkTheCapIsThree(5).violations.length > 0, "a cap of five passed");

  // 2 · the pre-fix service, with its three separate ideas of finished
  const drift = checkOneDefinitionOfFinished(PREFIX_SERVICE);
  say(drift.violations.length > 0, "the real pre-fix service — a hand-written predicate and the FAILED-only skip guard — passed");
  const shipped = checkOneDefinitionOfFinished(read(SERVICE));
  say(shipped.violations.length === 0, `the shipped service fails its own standard: ${shipped.violations.join("; ")}`);

  // 3 · a recovery that runs too late is as good as none
  const late = checkSomethingClosesThem(RECOVERY_TOO_LATE);
  say(late.violations.length > 0, "a recovery that runs after the advance passed");
  const none = checkSomethingClosesThem("const step = await advanceBrief(env, actor, p.id, now, deps);");
  say(none.violations.length > 0, "a service with no recovery at all passed");
  say(checkSomethingClosesThem(read(SERVICE)).violations.length === 0, "the shipped recovery fails its own standard");

  // 4 · the sentence
  say(checkTheSentence(mod.strandedReason, mod.MAX_BRIEF_ATTEMPTS).violations.length === 0, "the shipped sentence fails its own standard");
  say(checkTheSentence(() => "It failed.", 3).violations.length > 0, "a bare 'It failed.' passed as a sentence she can act on");
  say(
    checkTheSentence(() => "The GENERATING run stopped part-way through. Build it again.", 3).violations.length > 0,
    "a sentence leaking a column value and omitting what happens next passed",
  );

  if (failed > 0) process.exit(1);
  console.log(
    `SELF-TEST PASSED: the pre-fix terminality with no stranded state, the hand-written done-predicate, the ` +
      `FAILED-only skip guard, a missing recovery, one that runs too late, and two inadequate sentences are each ` +
      `caught; the shipped code passes over ${now.examined} status/attempt pairings.`,
  );
}

// ── Run ────────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  const service = read(SERVICE);
  const statuses = statusesFromSchema(read(SCHEMA));
  const mod = await import(fileUrl(MODULE));

  const pairings = checkEveryPairingResolves(mod.briefTerminality, statuses, mod.MAX_BRIEF_ATTEMPTS);
  const cap = checkTheCapIsThree(mod.MAX_BRIEF_ATTEMPTS);
  const definition = checkOneDefinitionOfFinished(service);
  const closes = checkSomethingClosesThem(service);
  const sentence = checkTheSentence(mod.strandedReason, mod.MAX_BRIEF_ATTEMPTS);

  const empty = [
    statuses.length === 0 && "read 0 report statuses out of the schema",
    pairings.examined === 0 && "ran briefTerminality over 0 status/attempt pairings",
    definition.examined === 0 && "read nothing in the brief service",
    closes.examined === 0 && "looked for no recovery",
    sentence.examined === 0 && "checked no sentence",
  ].filter(Boolean);
  if (empty.length > 0) {
    console.error(`BRIEF-ENDS-STATED SCAN FAILED — ${empty.join("; ")}.`);
    console.error("An empty loop reporting success is the defect this repo calls Rule 0.");
    process.exit(1);
  }

  const violations = [
    ...pairings.violations,
    ...cap.violations,
    ...definition.violations,
    ...closes.violations,
    ...sentence.violations,
  ];
  if (violations.length > 0) {
    console.error("BRIEF-ENDS-STATED SCAN FAILED — a brief could spend its whole budget and never say so:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error("\nOn 18 Sep 2026 one partner's row ended FAILED with a reason she could read and the other's sat");
    console.error("in GENERATING with all three attempts spent and error_message empty. Her card was blank.");
    process.exit(1);
  }

  console.log(
    `BRIEF-ENDS-STATED SCAN PASSED: briefTerminality was run over ${pairings.examined} status/attempt pairing(s) ` +
      `across ${statuses.length} schema status(es) and every spent budget in a non-terminal status is detected as ` +
      `stranded and marked for closure; the cap is the owner's ${mod.MAX_BRIEF_ATTEMPTS}; no SQL done-query remains and ` +
      "the tick's skip guard share one definition of finished; the recovery uses it and runs before anything is " +
      "advanced; and a stranded row is left a sentence that says what happened and what she can do.",
  );
}
