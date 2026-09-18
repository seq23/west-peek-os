#!/usr/bin/env node
/**
 * a-green-run-means-something.mjs — `npm run validate:green-means-something`.
 *
 * ONE ASSERTION: NOTHING IN THIS REPO MAY MAKE A RED PLAYWRIGHT RUN LOOK GREEN.
 *
 * WHAT WENT WRONG, 18 Sep 2026. Eleven pull requests merged that day on the strength of
 * `gh pr checks` being green, each one verified by hand. On the same day an agent measured the
 * suite on an untouched `origin/main` and found it failing 2 runs in 5 — the same two assertions
 * every time, on code nobody had touched. Two product races were behind it and are fixed in the
 * commit this file arrives with. What is NOT fixed by fixing them is the thing that let a lying
 * suite run for weeks without anybody noticing:
 *
 *     - name: Playwright journeys
 *       run: npm run e2e || (echo "::warning::… retrying the whole suite once" && npm run e2e)
 *
 * The comment above that line said it tolerated `workerd` crashing and never a wrong assertion.
 * A shell `||` cannot tell those apart. It retries on ANY non-zero exit, so every intermittent
 * assertion in the suite was given a free second attempt and the step went green — which is
 * precisely what happened when the reporting agent's second CI run "passed all three". A suite that
 * fails one run in three still shows green nearly nine times in ten behind that `||`, and the ninth
 * gets dismissed as "probably the flake". That is how a real regression ships.
 *
 * WHY A VALIDATOR AND NOT A COMMENT. This repo's own rules already forbid weakening a test and
 * forbid taking an agent's word that CI is green. Neither rule could be enforced while the
 * enforcement surface itself was laundering red runs, and nothing failed when the `||` landed. A
 * rule written in prose governs nothing until something fails when it is broken.
 *
 * WHAT IS CHECKED:
 *   1 · THE CONFIG'S ISOLATION CONTRACT HOLDS. `retries: 0` — the suite may not paper over a race
 *       by replaying it — and `workers: 1`, because the isolation boundary here is one shared D1
 *       and parallel workers would interleave writes into the firm's institutional state.
 *   2 · NO SPEC PAPERS OVER ITSELF. No `test.skip`, `test.fixme`, `test.only`, `describe.only`,
 *       no per-test or per-describe `retries`, no `test.setTimeout`, no `.toPass(`.
 *   3 · NO CI STEP LAUNDERS A RED E2E RUN. No `npm run e2e ||`, no `continue-on-error`, no
 *       `if: always()` anywhere in the job that runs the journeys.
 *   4 · THE SUITE IS RUN TWICE AND BOTH MUST PASS. The old step passed if EITHER of two runs was
 *       green. The job must now run the whole suite from a clean database twice, joined so that
 *       both have to succeed — the same wall-clock the old retry already spent on a red run, with
 *       the meaning inverted. One green run says almost nothing about a one-in-three failure.
 *   5 · SLEEPS DO NOT GROW. `page.waitForTimeout` is synchronisation by duration: fine on an idle
 *       laptop, not fine on a loaded runner, and the commonest way a race gets re-introduced. The
 *       six that exist are inventoried per file below and the inventory must match EXACTLY — a new
 *       sleep fails this check, and so does swapping one file's sleep for another's.
 *   6 · NO SPEC CAN PASS WITHOUT ASSERTING ANYTHING. Every spec file must contain at least one
 *       `expect(`, and none may assert a tautology (`expect(true)`, `expect(1).toBe(1)`).
 *   7 · HARD-FAILS ON ZERO. Zero spec files read, no Playwright config found, or no e2e job found
 *       in the workflow all exit 1. This scan going blind must look like a failure, not a clean
 *       board — the defect class this repo keeps producing is "runs but inert".
 *
 * `--self-test` feeds the REAL pre-fix workflow line and a set of hand-built violations through the
 * same functions and requires every one to be caught, alongside the shipped versions, which must
 * pass. A checker that cannot be shown to fail is not evidence of anything.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const E2E_DIR = path.join(ROOT, "e2e");
const CONFIG = path.join(ROOT, "playwright.config.ts");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "ci.yml");
const CLIENT_DIR = path.join(ROOT, "src", "client");

/**
 * THE SLEEP INVENTORY — file → how many `page.waitForTimeout` calls it is allowed.
 *
 * Not a cap on the total, which could be satisfied by moving a sleep somewhere worse. Each of these
 * is a place where a spec waits out a duration instead of a condition, and each is a latent flake
 * on a loaded runner. The inventory exists so the number can only go DOWN: removing one means
 * deleting its line here, and adding one anywhere fails.
 */
const SLEEP_BUDGET = new Map([
  ["d1-design-states.spec.ts", 1],
  ["d2-home-measured.spec.ts", 2],
  ["d3-work-measured.spec.ts", 1],
  ["p25-journeys.spec.ts", 1],
  ["support/surfaces.ts", 1],
]);

/** Ways a spec can excuse itself from having to pass. */
const SELF_EXCUSES = [
  { re: /\btest\.skip\s*\(/, what: "test.skip — a spec that is inconvenient is still a spec" },
  { re: /\btest\.fixme\s*\(/, what: "test.fixme — a known break that stops being reported is a break nobody fixes" },
  { re: /\btest\.only\s*\(/, what: "test.only — this silently stops running every other journey" },
  { re: /\btest\.describe\.only\s*\(/, what: "test.describe.only — the same, one level up" },
  { re: /\btest\.describe\.skip\s*\(/, what: "test.describe.skip — a whole file excused at once" },
  { re: /\btest\.setTimeout\s*\(/, what: "test.setTimeout — a longer deadline is not a fix for a race" },
  { re: /\.toPass\s*\(/, what: ".toPass( — retrying a block until it happens to work IS the papering over" },
  { re: /\btest\.describe\.configure\s*\(\s*\{[^}]*\bretries\s*:/s, what: "describe-level retries" },
  { re: /^\s*retries\s*:\s*[1-9]/m, what: "a non-zero `retries` — a race replayed is a race hidden" },
];

/** Assertions that cannot fail. */
const TAUTOLOGIES = [
  { re: /expect\s*\(\s*true\s*\)/, what: "expect(true)" },
  { re: /expect\s*\(\s*(\d+)\s*\)\s*\.toBe\s*\(\s*\1\s*\)/, what: "expect(n).toBe(n)" },
  { re: /\.toContainText\s*\(\s*(["'`])\1\s*\)/, what: '.toContainText("") — every element contains the empty string' },
];

/** Every `.ts` under `e2e/`, spec files and their shared support alike. */
function e2eFiles(dir = E2E_DIR, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...e2eFiles(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts")) out.push({ rel, abs: path.join(dir, entry.name) });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Rule 1 — the config's own isolation contract. */
export function checkConfig(source) {
  const bad = [];
  if (!/^\s*retries\s*:\s*0\s*,/m.test(source)) {
    bad.push("playwright.config.ts does not set `retries: 0` — a replayed race is a hidden race");
  }
  if (!/^\s*workers\s*:\s*1\s*,/m.test(source)) {
    bad.push(
      "playwright.config.ts does not set `workers: 1` — every spec drives ONE local D1, so parallel " +
        "workers interleave writes into the same institutional state and the suite stops being able to " +
        "tell a product break from a collision",
    );
  }
  return bad;
}

/** Rules 2 and 6 — what one file is allowed to contain. */
export function checkFile(rel, source) {
  const bad = [];
  for (const { re, what } of SELF_EXCUSES) {
    if (re.test(source)) bad.push(`${rel}: ${what}`);
  }
  for (const { re, what } of TAUTOLOGIES) {
    if (re.test(source)) bad.push(`${rel}: ${what} — an assertion that cannot fail is worse than a flaky one`);
  }
  const isSpec = rel.endsWith(".spec.ts");
  if (isSpec && !/\bexpect\s*\(/.test(source)) {
    bad.push(`${rel}: a spec file with no \`expect(\` in it — it runs, it goes green, and it checks nothing`);
  }
  const sleeps = (source.match(/\bwaitForTimeout\s*\(/g) ?? []).length;
  const allowed = SLEEP_BUDGET.get(rel) ?? 0;
  if (sleeps > allowed) {
    bad.push(
      `${rel}: ${sleeps} \`waitForTimeout\` call(s), ${allowed} allowed by the inventory in this script — ` +
        "waiting out a duration is fine on an idle laptop and is the commonest way a race comes back on a " +
        "loaded runner. Wait on a condition, or add the line here and say why it cannot be one",
    );
  }
  if (sleeps < allowed) {
    bad.push(
      `${rel}: ${sleeps} \`waitForTimeout\` call(s) but the inventory still reserves ${allowed} — ` +
        "a sleep was removed and the budget was not. Delete its line so the number can only go down",
    );
  }
  return bad;
}

/**
 * Comment lines are stripped before the workflow is read.
 *
 * This file, and the step it guards, both QUOTE the `npm run e2e || …` line they exist to forbid —
 * a checker that matched its own explanation would fail the repo for describing the defect it fixed,
 * and the obvious way out of that is to delete the explanation, which is the wrong trade. Only what
 * the runner actually executes is scanned.
 */
function withoutComments(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/**
 * Rule 8 — A LIST MAY NOT RENDER NOTHING WHILE IT LOADS.
 *
 * `{!x.loading && rows.length === 0 && <li className="state-empty">…}` draws the empty row only
 * once the fetch is done, so for the width of that fetch the list is a blank with no explanation —
 * the exact thing WEST_PEEK_DESIGN_SYSTEM.md §7 forbids ("loading and empty share one slot, told
 * apart by tone, never a blank"), and a live flake source: `d1-design-states` sweeps every surface
 * for unexplained blanks and caught two of these 1 run in 8 on 18 Sep 2026. The sweep now waits any
 * blank out, so a new one of these would not fail loudly — it would just quietly go back to being
 * an ambiguous blank for a reader on a slow connection. This is what fails instead.
 *
 * The partner must be within a few lines, which is where the reviewer will look for it.
 */
export function checkLoadingBlanks(rel, source) {
  const bad = [];
  let examined = 0;
  const lines = source.split("\n");
  lines.forEach((line, i) => {
    const m = /!\s*([A-Za-z_$][\w$]*)\.loading/.exec(line);
    if (!m || !/state-empty/.test(line)) return;
    examined += 1;
    const near = lines.slice(Math.max(0, i - 3), i).join("\n");
    const partner = new RegExp(`\\b${m[1]}\\.loading\\s*&&\\s*<li className="state-empty"`);
    if (!partner.test(near)) {
      bad.push(
        `${rel}:${i + 1}: this empty row is drawn only once \`${m[1]}\` has loaded, so the list is a ` +
          "blank with nothing in it until then. Put a loading row in the same slot — " +
          `\`{${m[1]}.loading && <li className="state-empty">Reading …</li>}\` — within the three ` +
          "lines above it",
      );
    }
  });
  return { bad, examined };
}

/** Every `.ts`/`.tsx` under `src/client/`. */
function clientFiles(dir = CLIENT_DIR, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...clientFiles(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push({ rel, abs: path.join(dir, entry.name) });
  }
  return out;
}

/** Rules 3 and 4 — what the workflow is allowed to do with a red run. */
export function checkWorkflow(raw) {
  const bad = [];
  const source = withoutComments(raw);
  const jobStart = source.indexOf("\n  e2e:");
  if (jobStart === -1) {
    return ["ci.yml has no `e2e:` job — the journeys are not run by CI at all, which is Rule 0"];
  }
  // The job runs to the next top-level job key (two-space indent) or to the end of the file.
  const rest = source.slice(jobStart + 1);
  const nextJob = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\s*\n/);
  const job = nextJob === -1 ? rest : rest.slice(0, nextJob + 1);

  if (/npm run e2e\s*\|\|/.test(job)) {
    bad.push(
      "the e2e job runs `npm run e2e ||` — a shell `||` cannot tell a `workerd` crash from a wrong " +
        "assertion, so it hands every intermittent failure in the suite a free second attempt and reports " +
        "green. This is the exact line that hid a suite failing 2 runs in 5 on 18 Sep 2026",
    );
  }
  if (/continue-on-error\s*:\s*true/.test(job)) {
    bad.push("the e2e job sets `continue-on-error: true` — the journeys then cannot fail the build");
  }
  /*
   * `if: always()` is CORRECT on the step that uploads the Playwright report — a failed run is
   * exactly when somebody needs the trace. It is never correct on a step that RUNS the suite, which
   * would let a second invocation report success over the first one's failure. So the rule is
   * scoped to steps that invoke the suite, not to the word.
   */
  for (const step of job.split(/\n(?=\s*- )/)) {
    if (/npm run e2e\b/.test(step) && /if\s*:\s*(\$\{\{\s*)?always\(\)/.test(step)) {
      bad.push("a step that runs the journeys is conditioned on `always()` — it would report over an earlier failure");
    }
  }
  const runs = (job.match(/npm run e2e\b/g) ?? []).length;
  if (runs < 2) {
    bad.push(
      `the e2e job invokes \`npm run e2e\` ${runs} time(s) — it must run the whole suite from a clean ` +
        "database TWICE, joined so both have to pass. One green run says almost nothing about a one-in-three " +
        "failure, and the previous step spent the same wall clock proving the opposite",
    );
  }
  return bad;
}

function selfTest() {
  const failures = [];
  const expectCaught = (label, bad) => {
    if (bad.length === 0) failures.push(`NOT CAUGHT: ${label}`);
  };
  const expectClean = (label, bad) => {
    if (bad.length > 0) failures.push(`FALSE POSITIVE on ${label}: ${bad.join(" / ")}`);
  };

  // The real line, as it stood on origin/main before this change.
  expectCaught(
    "the shipped `npm run e2e || retry` step",
    checkWorkflow(
      "\n  e2e:\n    name: Playwright journeys\n    steps:\n      - name: Playwright journeys\n" +
        '        run: npm run e2e || (echo "::warning::wrangler dev crashed or a journey failed — retrying the whole suite once" && npm run e2e)\n',
    ),
  );
  expectCaught(
    "a single run with no second pass",
    checkWorkflow("\n  e2e:\n    steps:\n      - name: Playwright journeys\n        run: npm run e2e\n"),
  );
  expectCaught(
    "continue-on-error on the journeys",
    checkWorkflow(
      "\n  e2e:\n    continue-on-error: true\n    steps:\n      - run: npm run e2e\n      - run: npm run e2e\n",
    ),
  );
  expectCaught("no e2e job at all", checkWorkflow("\n  build:\n    steps:\n      - run: npm run build\n"));
  expectClean(
    "two runs that both have to pass",
    checkWorkflow("\n  e2e:\n    steps:\n      - name: Playwright journeys\n        run: npm run e2e && npm run e2e\n"),
  );
  expectClean(
    "a report upload conditioned on always(), which is where always() belongs",
    checkWorkflow(
      "\n  e2e:\n    steps:\n      - run: npm run e2e\n      - run: npm run e2e\n" +
        "      - name: Upload the report\n        if: always()\n        uses: actions/upload-artifact@v4\n",
    ),
  );
  expectCaught(
    "a second suite run conditioned on always(), which is not",
    checkWorkflow(
      "\n  e2e:\n    steps:\n      - run: npm run e2e\n      - name: Again\n        if: always()\n        run: npm run e2e\n",
    ),
  );
  expectClean(
    "a job whose COMMENTS quote the forbidden line while its commands do not",
    checkWorkflow(
      "\n  e2e:\n    steps:\n      # this used to be `npm run e2e || (… && npm run e2e)` and `if: always()`\n" +
        "      - run: npm run e2e && npm run e2e\n",
    ),
  );

  expectCaught("retries: 1 in the config", checkConfig("export default defineConfig({\n  retries: 1,\n  workers: 1,\n"));
  expectCaught("parallel workers over one D1", checkConfig("export default defineConfig({\n  retries: 0,\n  workers: 4,\n"));
  expectClean("the shipped config shape", checkConfig("export default defineConfig({\n  retries: 0,\n  workers: 1,\n"));

  expectCaught("a skipped spec", checkFile("x.spec.ts", 'test.skip("flaky", async () => { expect(1).toBe(2); });'));
  expectCaught("a .only spec", checkFile("x.spec.ts", 'test.only("just this", async () => { expect(a).toBe(b); });'));
  expectCaught("a .toPass retry block", checkFile("x.spec.ts", "await expect(async () => { expect(a).toBe(b); }).toPass();"));
  expectCaught("a bumped per-test timeout", checkFile("x.spec.ts", "test.setTimeout(120_000);\nexpect(a).toBe(b);"));
  expectCaught("a tautology", checkFile("x.spec.ts", "expect(true).toBeTruthy();"));
  expectCaught("a spec that asserts nothing", checkFile("x.spec.ts", 'test("walks the page", async ({ page }) => { await page.goto("/"); });'));
  expectCaught("a new sleep in a file with no budget", checkFile("p1-shell.spec.ts", "expect(a).toBe(b);\nawait page.waitForTimeout(500);"));
  expectCaught("a sleep the inventory no longer needs", checkFile("d1-design-states.spec.ts", "expect(a).toBe(b);"));
  expectClean("a file spending exactly its inventoried sleep", checkFile("d1-design-states.spec.ts", "expect(a).toBe(b);\nawait page.waitForTimeout(200);"));

  const LOADING_BAD = '        {!rooms.loading && rows.length === 0 && <li className="state-empty">No rooms.</li>}';
  const LOADING_GOOD =
    '        {rooms.loading && <li className="state-empty">Reading the rooms\u2026</li>}\n' + LOADING_BAD;
  expectCaught("an empty row drawn only after loading, with no loading row", checkLoadingBlanks("X.tsx", LOADING_BAD).bad);
  expectClean("the same row with its loading partner above it", checkLoadingBlanks("X.tsx", LOADING_GOOD).bad);
  expectCaught(
    "a loading partner for a DIFFERENT list",
    checkLoadingBlanks("X.tsx", '        {jobs.loading && <li className="state-empty">Reading\u2026</li>}\n' + LOADING_BAD).bad,
  );

  if (failures.length > 0) {
    console.error("A-GREEN-RUN-MEANS-SOMETHING SELF-TEST FAILED — this checker cannot see what it claims to see:");
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(
    "A-GREEN-RUN-MEANS-SOMETHING SELF-TEST PASSED: 24 case(s), including the real `npm run e2e || retry` " +
      "line as it stood on origin/main, every one caught or cleared as intended.",
  );
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const bad = [];

  if (!existsSync(CONFIG)) {
    console.error("A-GREEN-RUN-MEANS-SOMETHING SCAN FAILED — no playwright.config.ts. Rule 0: this scan found nothing to check.");
    process.exit(1);
  }
  bad.push(...checkConfig(readFileSync(CONFIG, "utf8")));

  const files = e2eFiles();
  const specs = files.filter((f) => f.rel.endsWith(".spec.ts"));
  if (specs.length === 0) {
    console.error(
      `A-GREEN-RUN-MEANS-SOMETHING SCAN FAILED — read ${files.length} file(s) under e2e/ and none of them is a ` +
        "spec. Either the suite stopped existing or this scan lost its target; both are failures. Rule 0.",
    );
    process.exit(1);
  }
  let expectations = 0;
  for (const f of files) {
    const source = readFileSync(f.abs, "utf8");
    expectations += (source.match(/\bexpect\s*[.(]/g) ?? []).length;
    bad.push(...checkFile(f.rel, source));
  }
  if (expectations === 0) {
    console.error("A-GREEN-RUN-MEANS-SOMETHING SCAN FAILED — not one `expect` in the whole suite. Rule 0.");
    process.exit(1);
  }

  // An inventoried file that has been deleted would otherwise never be visited.
  for (const rel of SLEEP_BUDGET.keys()) {
    if (!files.some((f) => f.rel === rel)) {
      bad.push(`the sleep inventory reserves ${SLEEP_BUDGET.get(rel)} for ${rel}, which no longer exists — delete its line`);
    }
  }

  let loadingRowsExamined = 0;
  for (const f of clientFiles()) {
    const r = checkLoadingBlanks(f.rel, readFileSync(f.abs, "utf8"));
    loadingRowsExamined += r.examined;
    bad.push(...r.bad);
  }
  if (loadingRowsExamined === 0) {
    console.error(
      "A-GREEN-RUN-MEANS-SOMETHING SCAN FAILED — found no `!x.loading` empty rows anywhere in src/client. " +
        "Either the client stopped drawing empty states or this scan lost its target; both are failures. Rule 0.",
    );
    process.exit(1);
  }

  if (!existsSync(WORKFLOW)) {
    console.error("A-GREEN-RUN-MEANS-SOMETHING SCAN FAILED — no .github/workflows/ci.yml to check. Rule 0.");
    process.exit(1);
  }
  bad.push(...checkWorkflow(readFileSync(WORKFLOW, "utf8")));

  if (bad.length > 0) {
    console.error("A-GREEN-RUN-MEANS-SOMETHING SCAN FAILED — something here lets a red run look green:");
    for (const b of bad) console.error(`  ✗ ${b}`);
    console.error(
      "\nOn 18 Sep 2026 eleven pull requests merged on the strength of `gh pr checks` being green, each one\n" +
        "verified by hand, while the suite was failing 2 runs in 5 on untouched main. Nothing in the repo\n" +
        "failed when the line that hid it was added. Do not weaken a journey to get past this: fix the race,\n" +
        "or wait on a condition instead of a duration.",
    );
    process.exit(1);
  }

  const sleeps = [...SLEEP_BUDGET.values()].reduce((a, b) => a + b, 0);
  console.log(
    `A-GREEN-RUN-MEANS-SOMETHING SCAN PASSED: ${specs.length} spec file(s) and ${files.length - specs.length} ` +
      `support file(s) under e2e/, ${expectations} assertion(s), 0 excused; retries 0 and workers 1; ` +
      `${sleeps} inventoried sleep(s) and no new ones; ${loadingRowsExamined} list(s) that draw an empty ` +
      "row after loading, every one with a loading row in the same slot; the CI job runs the whole suite " +
      "twice and needs both.",
  );
}

main();
