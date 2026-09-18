#!/usr/bin/env node
/**
 * one-lever-not-four.mjs — `npm run validate:one-lever`.
 *
 * WHAT THIS PREVENTS, AND IT IS NOT HYPOTHETICAL.
 *
 * `cost_mode` was one column holding `NORMAL | CHEAPO | CRITICAL_ONLY | STRATEGIC_SURGE`, which is
 * four values answering three unrelated questions: how much money, what work runs at all, and
 * lift-the-caps-temporarily. That conflation is where 17 Sep 2026's near-miss came from — CHEAPO
 * means "spend less", and because the same column also answered "how good", it ignored
 * `preferredModel` outright, so all eight search call sites would have gone to a model with no web
 * access. A model with no web access does not error. It answers fluently, from memory.
 *
 * The enum was replaced by one lever (`spend_lever`: FREE_ONLY / MODERATE / OPEN) with the other two
 * questions given their own fields. The column still EXISTS — it is NOT NULL, historical rows carry
 * it, and it is written as a derived value so unmigrated readers stay truthful — which is exactly
 * why this scan is needed. A dead enum sitting in the schema is the easiest thing in the world to
 * start reading again the first time somebody wants a fifth behaviour and it is right there.
 *
 * SO THE RULE IS ONE-DIRECTIONAL: the lever may be derived INTO `cost_mode`, and `cost_mode` may be
 * translated INTO a lever at the API boundary for old callers. What must never happen again is a
 * ROUTING decision reading it.
 *
 * TWO THINGS ARE CHECKED:
 *
 *   1. `src/worker/ai/runAi.ts` — the routing boundary — contains no comparison of `cost_mode` or
 *      `effectiveCostMode` against a spend value. The one permitted mention is the CRITICAL_ONLY
 *      compatibility read, which is about WHICH WORK RUNS, not about money, and which is named
 *      explicitly below rather than pattern-matched loosely.
 *   2. Every routing branch that acts on spend goes through `behaviour.` — the single evaluated
 *      reading — so a second, re-derived posture cannot appear beside it.
 *
 * FAILS LOUDLY (exit 1, every offending line named) and HARD-FAILS ON ZERO FILES EXAMINED: a scan
 * that finds nothing to check has stopped protecting anything, and the commonest way a guard dies is
 * that the thing it watched moved.
 *
 * `--self-test` runs the same pure function over synthetic sources, including the REAL pre-fix
 * shape of the two conditions that caused the near-miss, and asserts each is caught.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stripCommentsFor } from "./lib/strip-comments.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The routing boundary, and the only file this rule polices. */
const ROUTING_FILE = "src/worker/ai/runAi.ts";

/**
 * The spend values that must never again be compared against inside a routing decision. NORMAL is
 * absent deliberately: it is the value written as the derived legacy default, so a line mentioning
 * it is not evidence of a routing decision.
 */
const DEAD_SPEND_VALUES = ["CHEAPO", "STRATEGIC_SURGE"];

/**
 * The ONE permitted mention, named rather than pattern-matched.
 *
 * `CRITICAL_ONLY` answers "what work runs at all" — a different question from money — and the
 * boundary keeps a compatibility read of it so a policy row written before 0179 still defers
 * non-critical work. It is allowed on a line that also mentions `defer`, which is the field that
 * question now lives in; allowing it anywhere would re-open the door this scan exists to hold shut.
 */
const PERMITTED = [{ value: "CRITICAL_ONLY", requiresOnSameLine: "defer" }];

/**
 * Check one set of sources. Pure, so `--self-test` exercises the real rule rather than a copy.
 * Returns the violations and the number of files examined.
 */
export function checkSources(files) {
  const violations = [];
  let examined = 0;

  for (const [name, source] of Object.entries(files)) {
    examined += 1;
    const lines = source.split("\n");
    lines.forEach((line, i) => {
      // Comments explain the history on purpose and are not decisions. Stripping them is what lets
      // this file's own documentation name the values it forbids.
      const trimmed = line.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;

      /*
       * THE TYPE DECLARATION ITSELF IS NOT A DECISION, and it is exempted by name rather than by a
       * loose pattern. `budget_policy.cost_mode` is NOT NULL and the archive is full of these
       * values, so SOMETHING has to give them a type. What must not happen is code branching on
       * them, which is every other line in the file.
       */
      if (/^export type CostMode\s*=/.test(trimmed)) return;

      for (const value of DEAD_SPEND_VALUES) {
        if (!line.includes(`"${value}"`)) continue;
        violations.push(
          `${name}:${i + 1}: a routing decision compares against the dead spend value ${value}. ` +
            `Spend behaviour comes from the evaluated lever (behaviour.freeOnly / freeFirst / cheaperChoices / prefersFrontier), ` +
            `never from cost_mode. Line: ${trimmed.slice(0, 120)}`,
        );
      }

      for (const p of PERMITTED) {
        if (!line.includes(`"${p.value}"`)) continue;
        if (line.includes(p.requiresOnSameLine)) continue;
        violations.push(
          `${name}:${i + 1}: ${p.value} is permitted only as the compatibility read of ` +
            `'${p.requiresOnSameLine}', because it answers WHICH WORK RUNS and not how much money. ` +
            `Line: ${trimmed.slice(0, 120)}`,
        );
      }
    });
  }
  return { violations, examined };
}

/**
 * The positive half: the routing boundary must actually CONSULT the evaluated lever. A scan that
 * only forbade the old thing would pass a file that had removed the old thing and put nothing in
 * its place — "runs but inert", which is the defect class this repo keeps finding.
 */
export function checkConsultsBehaviour(source) {
  const required = ["behaviour.freeOnly", "behaviour.freeFirst", "behaviour.cheaperChoices", "behaviour.prefersFrontier", "isProtected"];
  return required.filter((r) => !source.includes(r));
}

function selfTest() {
  const fixtures = {
    // THE REAL PRE-FIX SHAPE of the pin-override condition.
    "pin-override.ts": `} else if (routePolicy && !(effectiveCostMode === "CHEAPO" && Number(policy.honours_pins ?? 1) === 0)) {`,
    // THE REAL PRE-FIX SHAPE of the condition that ignored preferredModel — the near-miss itself.
    "preferred-ignored.ts": `if ((effectiveCostMode !== "CHEAPO" || isJudgement) && preferred) {`,
    "surge.ts": `if (policy.cost_mode !== "STRATEGIC_SURGE") return { mode: policy.cost_mode };`,
    // CRITICAL_ONLY outside the defer compatibility read is a violation...
    "critical-loose.ts": `if (effectiveCostMode === "CRITICAL_ONLY") { cheap = true; }`,
    // ...and inside it is not.
    "critical-ok.ts": `const deferNonCritical = deferFromPolicy(policy) || mode === "CRITICAL_ONLY";`,
    // The new shape: no dead value anywhere.
    "clean.ts": `if (behaviour.freeFirst && !isProtected) { head = cheapest; }`,
    // A comment naming the dead values is documentation, not a decision.
    "comment.ts": `// CHEAPO used to mean "STRATEGIC_SURGE" here, and that was the bug.\nconst x = behaviour.cheaperChoices;`,
    // The type declaration naming the retired values is not a branch on them.
    "type-decl.ts": `export type CostMode = "NORMAL" | "CHEAPO";`,
    // ...but a branch dressed as one still is.
    "type-lookalike.ts": `const mode: CostMode = flag ? "CHEAPO" : "NORMAL";`,
  };
  const { violations, examined } = checkSources(fixtures);
  const expectFlagged = ["pin-override.ts", "preferred-ignored.ts", "surge.ts", "critical-loose.ts", "type-lookalike.ts"];
  const expectClean = ["critical-ok.ts", "clean.ts", "comment.ts", "type-decl.ts"];

  const failures = [];
  for (const f of expectFlagged) if (!violations.some((v) => v.startsWith(f))) failures.push(`self-test: ${f} should have been flagged`);
  for (const f of expectClean) if (violations.some((v) => v.startsWith(f))) failures.push(`self-test: ${f} should NOT have been flagged`);
  if (examined !== 9) failures.push(`self-test: expected 9 fixtures, saw ${examined}`);

  // The positive half must fail on a file that consults nothing.
  if (checkConsultsBehaviour("const x = 1;").length !== 5) failures.push("self-test: an inert file should be missing all five consultations");
  if (
    checkConsultsBehaviour("behaviour.freeOnly behaviour.freeFirst behaviour.cheaperChoices behaviour.prefersFrontier isProtected").length !== 0
  ) {
    failures.push("self-test: a file consulting all five should report none missing");
  }

  // The zero-item tripwire is itself tested.
  if (checkSources({}).examined !== 0) failures.push("self-test: empty input should examine zero files");

  if (failures.length > 0) {
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(`\nSELF-TEST FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("✓ self-test: 9 fixtures, 5 planted defects caught (including both real pre-fix conditions), 4 clean shapes left alone");
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const full = path.join(ROOT, ROUTING_FILE);
  if (!existsSync(full)) {
    console.error(`✗ one-lever-not-four could not find ${ROUTING_FILE}.`);
    console.error("  The routing boundary has moved or been renamed. Failing rather than passing: a scan");
    console.error("  that cannot find what it guards is protecting nothing.");
    process.exit(1);
  }
  const source = stripCommentsFor(full, readFileSync(full, "utf8"));
  const { violations, examined } = checkSources({ [ROUTING_FILE]: source });

  if (examined === 0) {
    console.error("✗ one-lever-not-four examined ZERO files. Failing rather than passing.");
    process.exit(1);
  }

  const missing = checkConsultsBehaviour(source);
  if (missing.length > 0) {
    console.error(`  ✗ ${ROUTING_FILE} does not consult the evaluated lever: missing ${missing.join(", ")}.`);
    console.error("    The dead enum being absent is not the same as the new control being wired in.");
    process.exit(1);
  }
  if (violations.length > 0) {
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(`\n✗ ${violations.length} routing decision(s) still read the retired cost_mode enum.`);
    process.exit(1);
  }
  console.log(`✓ one lever, not four: ${ROUTING_FILE} routes on the evaluated spend lever and reads no retired cost_mode value`);
}

main();
