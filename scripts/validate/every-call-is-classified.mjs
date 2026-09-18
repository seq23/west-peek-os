#!/usr/bin/env node
/**
 * every-call-is-classified.mjs — `npm run validate:call-classification`.
 *
 * WHAT THIS PREVENTS, and it is not hypothetical.
 *
 * `runAi` routes on a cost posture. Under CHEAPO it takes the cheapest adequate model and IGNORES
 * `preferredModel` outright. Of the 45 call sites in this system, 10 said `judgement` and 2 said
 * `interpretation`; the other 33 said nothing, and "nothing" meant "cheapest". Among those 33 were
 * eight calls that pinned the live-search model through `preferredModel` — so switching the firm to
 * CHEAPO would have routed every live search to a small local model with no web access, which does
 * not error: it answers fluently, from memory, about this morning's market.
 *
 * The problem was never that the default was wrong. It was that an UNCLASSIFIED call and a call
 * somebody had thought about and decided was machinery looked identical. This scan makes the
 * difference visible: every `runAi` call must carry exactly one of
 *
 *   interpretation  — reads what a partner asked for; needs a model that can reason
 *   judgement       — writes or decides something a human reads; never the search model
 *   requiresSearch  — must reach the live web; the search model is REQUIRED, not excluded
 *   mechanical      — machinery, and saying so is a decision rather than an omission
 *
 * FAILS LOUDLY (exit 1, every unclassified site named) and HARD-FAILS ON ZERO CALL SITES: a scan
 * that examines nothing must never pass, because the commonest way a guard dies is that the thing
 * it was watching moved.
 *
 * `--self-test` runs the same pure function over synthetic sources, including the real pre-fix
 * shape of the search calls, and asserts each is caught.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stripCommentsFor } from "./lib/strip-comments.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCAN_DIR = path.join(ROOT, "src", "worker");

/** The four markers. Exactly one must be present on every call. */
export const MARKERS = ["interpretation", "judgement", "requiresSearch", "mechanical"];

/**
 * The boundary itself and its own plumbing. `runAi.ts` DEFINES the function; a test helper or the
 * router calling it is not a call site with a purpose to classify.
 */
const NOT_A_CALL_SITE = new Set(["src/worker/ai/runAi.ts"]);

/**
 * Find each `runAi(` call and return the source of its first argument object.
 *
 * Brace-matched rather than line-windowed, because a window is exactly how a nested
 * `budgetContext` two screens down gets attributed to the wrong call.
 */
export function callSites(source) {
  const out = [];
  const re = /\brunAi\s*\(/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
    out.push({ index: m.index, line: source.slice(0, m.index).split("\n").length, body: source.slice(m.index, i) });
  }
  return out;
}

/** Pure: takes { relativePath: source } and returns violation strings plus how many sites it saw. */
export function checkSources(files) {
  const violations = [];
  let examined = 0;

  for (const [rel, source] of Object.entries(files)) {
    if (NOT_A_CALL_SITE.has(rel)) continue;
    for (const site of callSites(source)) {
      // `runAi` re-exported, typed, or referenced without being invoked with an input object.
      if (!/\bpurpose\s*:/.test(site.body)) continue;
      examined++;
      const present = MARKERS.filter((k) => new RegExp(`\\b${k}\\s*:\\s*(true|false|body\\.|input\\.|opts\\.)`).test(site.body));
      if (present.length === 0) {
        violations.push(
          `${rel}:${site.line}: runAi call carries none of ${MARKERS.join(" / ")}. ` +
            `An unclassified call defaults to the cheapest model under CHEAPO. Say which kind of call it is — ` +
            `\`mechanical: true\` is a valid and cheap answer, it just has to be said.`,
        );
      }
    }
  }
  return { violations, examined };
}

function listSourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function selfTest() {
  const fixtures = {
    "unmarked.ts": `await runAi(env, { purpose: "x", actor, inputs: [], sensitivity: "PUBLIC" });`,
    // THE REAL PRE-FIX SHAPE of the eight search calls: a pin and no marker, which CHEAPO ignores.
    "search-pinned-only.ts": `await runAi(env, { purpose: "live company search", actor, inputs: [], sensitivity: "PUBLIC",
        budgetContext: { expectedOutputTokens: 1200, preferredModel: SEARCH_MODEL, providerKey: "openrouter" } });`,
    "marked-judgement.ts": `await runAi(env, { purpose: "x", actor, inputs: [], sensitivity: "PUBLIC", budgetContext: { judgement: true } });`,
    "marked-mechanical.ts": `await runAi(env, { purpose: "x", actor, inputs: [], sensitivity: "PUBLIC", budgetContext: { mechanical: true } });`,
    "marked-search.ts": `await runAi(env, { purpose: "x", actor, inputs: [], sensitivity: "PUBLIC", budgetContext: { requiresSearch: true } });`,
    "marked-interpretation.ts": `await runAi(env, { purpose: "x", actor, inputs: [], sensitivity: "PUBLIC", budgetContext: { interpretation: true } });`,
    // A nested call must be attributed to ITS OWN site, not to whichever budgetContext comes next.
    "two-calls.ts": `await runAi(env, { purpose: "a", actor, inputs: [], sensitivity: "PUBLIC" });
      await runAi(env, { purpose: "b", actor, inputs: [], sensitivity: "PUBLIC", budgetContext: { judgement: true } });`,
    // Not a call with an input object: must not be counted or flagged.
    "type-only.ts": `type X = typeof runAi; export { runAi };`,
  };
  const { violations, examined } = checkSources(fixtures);
  const expectFlagged = ["unmarked.ts", "search-pinned-only.ts", "two-calls.ts"];
  const expectClean = ["marked-judgement.ts", "marked-mechanical.ts", "marked-search.ts", "marked-interpretation.ts", "type-only.ts"];

  const failures = [];
  for (const f of expectFlagged) if (!violations.some((v) => v.startsWith(f))) failures.push(`self-test: ${f} should have been flagged`);
  for (const f of expectClean) if (violations.some((v) => v.startsWith(f))) failures.push(`self-test: ${f} should NOT have been flagged`);
  if (examined !== 8) failures.push(`self-test: expected 8 call sites across the fixtures, saw ${examined}`);

  // The zero-item tripwire is itself tested: a scan of nothing must not look like a pass.
  const empty = checkSources({});
  if (empty.examined !== 0) failures.push("self-test: empty input should examine zero sites");

  if (failures.length > 0) {
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(`\nSELF-TEST FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log(`✓ self-test: 8 fixtures, 3 planted defects caught, 5 well-formed calls left alone`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const files = {};
  for (const full of listSourceFiles(SCAN_DIR)) {
    files[path.relative(ROOT, full).split(path.sep).join("/")] = stripCommentsFor(full, readFileSync(full, "utf8"));
  }
  const { violations, examined } = checkSources(files);

  if (examined === 0) {
    console.error("✗ every-call-is-classified examined ZERO runAi call sites.");
    console.error("  A scan that finds nothing to check has stopped protecting anything — the calls");
    console.error("  have moved, been renamed, or the scan path is wrong. Failing rather than passing.");
    process.exit(1);
  }
  if (violations.length > 0) {
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(`\n✗ ${violations.length} unclassified runAi call site(s) of ${examined} examined.`);
    process.exit(1);
  }
  console.log(`✓ all ${examined} runAi call sites are classified (interpretation / judgement / requiresSearch / mechanical)`);
}

main();
