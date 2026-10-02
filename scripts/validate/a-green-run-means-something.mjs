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
// THE JOURNEYS MOVED (21 Sep 2026). `ci.yml` is the merge gate — typecheck, the vitest suite in
// shards, the validators, the build — and the Playwright journeys run out of the gate's path in
// `playwright.yml`: post-merge from 21 Sep, monthly + on demand from 23 Sep, and ON DEMAND ONLY
// (`workflow_dispatch`, no schedule) from 2 Oct 2026. `deploy.yml` fires on the gate alone. All
// three are read here, because the shape is a set of promises that can each drift on its own: a
// cron could creep back into the journeys, the gate could quietly grow them back, a shard could
// be dropped, the deploy could start waiting on the journeys again (or on nothing).
const WORKFLOW = path.join(ROOT, ".github", "workflows", "playwright.yml");
const GATE = path.join(ROOT, ".github", "workflows", "ci.yml");
const DEPLOY = path.join(ROOT, ".github", "workflows", "deploy.yml");
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
  // ONE CONNECTION PER REQUEST (23 Sep 2026). p3 and p7 died on "socket hang up": Playwright's
  // process-wide keep-alive agent reused a socket `workerd` closes at 5000ms idle. A
  // `connection: close` header was the first fix and was inert. The guard is a module the config
  // must load, because only the config is evaluated in every worker; the behaviour itself is
  // counted in tests/e2e-one-connection-per-request.test.ts and e2e/zz-one-connection-per-request.spec.ts.
  if (!/^import\s+["']\.\/e2e\/support\/one-connection-per-request(\.ts)?["'];?\s*$/m.test(source)) {
    bad.push(
      "playwright.config.ts does not import ./e2e/support/one-connection-per-request — without it every " +
        "journey worker pools sockets to `wrangler dev`, and a request that lands on one at ~5s idle dies " +
        "as \"socket hang up\" (p7-meetings, 23 Sep 2026). A `connection: close` header does NOT do this",
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
  // The trigger block: from `on:` to the next top-level key.
  const onStart = source.search(/^on:\s*$/m);
  if (onStart === -1) {
    bad.push("playwright.yml has no `on:` block — nothing triggers the journeys, which is Rule 0");
  } else {
    const afterOn = source.slice(onStart + 3);
    const nextKey = afterOn.search(/\n[a-z][a-z0-9-]*:/);
    const on = nextKey === -1 ? afterOn : afterOn.slice(0, nextKey);
    // 2 Oct 2026, the owner: ON DEMAND ONLY. `workflow_dispatch` is the one trigger. This supersedes
    // 23 Sep's "once a month and on demand": any `schedule` — monthly, weekly, nightly, hourly, or
    // a bare `schedule:` with no cron — fails, and so does anything else beside the dispatch.
    const schedule = /^\s*schedule\s*:/m.exec(on);
    if (schedule) {
      const crons = [...on.matchAll(/^\s*-\s*cron\s*:\s*["']?([^"'\n]+?)["']?\s*$/gm)].map((m) => m[1].trim());
      const named = crons.length ? ` (${crons.map((c) => `\`${c}\``).join(", ")})` : " with no cron under it";
      bad.push(
        `playwright.yml has a \`schedule\` trigger${named} — the journeys run ON DEMAND ONLY (owner, 2 Oct 2026): ` +
          "only a person dispatches them (`gh workflow run playwright.yml --ref main`); `land` has no browser-suite route for this repo. " +
          "No cron at any cadence; the monthly `30 10 1 * *` of 23 Sep is retired",
      );
    }
    if (!/^\s*workflow_dispatch\s*:/m.test(on)) {
      bad.push("playwright.yml has no `workflow_dispatch` — she cannot run the journeys on demand, and nothing else may run them, which is Rule 0");
    }
    if (/^\s*push\s*:/m.test(on)) {
      bad.push("playwright.yml runs on `push` — ~20 minutes after every merge is what the owner removed on 23 Sep 2026; on demand only since 2 Oct 2026");
    }
    const others = [...on.matchAll(/^  ([a-z_]+)\s*:/gm)].map((m) => m[1]).filter((t) => !["workflow_dispatch", "schedule", "push", "pull_request", "pull_request_target"].includes(t));
    if (others.length) {
      bad.push(`playwright.yml also triggers on ${others.map((t) => `\`${t}\``).join(", ")} — the trigger list is exactly [workflow_dispatch]; the journeys run only when asked for`);
    }
    if (/^\s*pull_request(_target)?\s*:/m.test(on)) {
      bad.push(
        "playwright.yml is triggered by `pull_request` — the journeys are post-merge by the owner's decision of " +
          "21 Sep 2026 (a ~5-minute gate, long suites on main); running them on every PR is the ~9 minutes " +
          "per PR that decision removed",
      );
    }
  }
  const jobStart = source.indexOf("\n  e2e:");
  if (jobStart === -1) {
    bad.push(...["playwright.yml has no `e2e:` job — the journeys are not run by CI at all, which is Rule 0"]);
    return bad;
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
  if (/^\s+if\s*:\s*.*\bpull_request\b/m.test(job) || /^\s+if\s*:\s*github\.event_name\s*[!=]=/m.test(job)) {
    bad.push("the e2e job is conditioned on the event that triggered it — a job that runs only sometimes is a gate only sometimes");
  }
  for (const step of job.split(/\n(?=\s*- )/)) {
    if (/npm run e2e\b/.test(step) && /if\s*:\s*(\$\{\{\s*)?always\(\)/.test(step)) {
      bad.push("a step that runs the journeys is conditioned on `always()` — it would report over an earlier failure");
    }
  }
  // NO PASS IS GUARDED ANY MORE. Until 21 Sep 2026 the second pass was allowed to skip on
  // `pull_request`; there is no pull-request run now, so a guard on any pass is either dead code
  // (a guard that cannot reach what it governs) or a way to skip the claim. Either is a defect.
  for (const m of job.matchAll(/\bif\s*\[[^\n]*\n([\s\S]*?)\n\s*fi\b/g)) {
    if (/npm run e2e\b/.test(m[1])) {
      bad.push(
        "a `npm run e2e` sits inside a shell `if [ … ]` — every run of this workflow is the claim about what " +
          "shipped, and both passes run unconditionally. (The `workerd` crash re-run is `if grep`, on the " +
          "crash's own signature, and is the one retry allowed.)",
      );
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

/**
 * The merge gate (`ci.yml`). What can go wrong here is quieter than a lying journey: the
 * journeys can creep back in (every PR pays them again, and the deploy that waits on CI waits on
 * them again); the suite can be sharded `/4` against a three-entry matrix and a quarter of the
 * files never run anywhere; a shard can exit 0 having found no files; a job can lose its
 * ceiling and hang for six hours. None of those goes red on its own.
 */
export function checkGate(raw) {
  const bad = [];
  const source = withoutComments(raw);
  if (/npm run e2e\b/.test(source)) {
    bad.push(
      "ci.yml runs `npm run e2e` — the journeys are back in the merge gate. They run post-merge in " +
        "playwright.yml (owner, 21 Sep 2026); here they cost every PR ~9 minutes and make the deploy wait",
    );
  }
  const matrix = /^\s+shard:\s*\[([^\]]*)\]/m.exec(source);
  // `--shard=n/N` was vitest's count split; `shard-tests.mjs --shard n/N` is the measured one.
  const divisors = [...source.matchAll(/--shard[= ]\$\{\{\s*matrix\.shard\s*\}\}\/(\d+)/g)].map((m) => Number(m[1]));
  if (!matrix || divisors.length === 0) {
    bad.push(
      "ci.yml no longer shards the vitest suite (no `shard: [..]` matrix with a `--shard ${{ matrix.shard }}/N` " +
        "step) — the 16-minute serial suite is back in the gate",
    );
  } else {
    if (!/shard-tests\.mjs --shard/.test(source)) {
      bad.push(
        "the tests step splits by file count (`vitest --shard`) instead of by measured time " +
          "(`scripts/ci/shard-tests.mjs --shard`) — on PR #155 that made shard 4 twice as long as shard 3",
      );
    }
    if (!/npm run validate:shards/.test(source)) {
      bad.push("no job runs `validate:shards` — nothing in CI proves the four shards are a whole partition of tests/");
    }
    const entries = matrix[1].split(",").map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x));
    const expected = entries.length;
    const ok = entries.every((v, i) => v === i + 1);
    if (!ok) {
      bad.push(`the shard matrix is [${matrix[1].trim()}] — it must be exactly 1..${expected}, or some slice of the suite never runs`);
    }
    for (const n of divisors) {
      if (n !== expected) {
        bad.push(
          `the tests step splits the suite \`/${n}\` but the matrix has ${expected} entr${expected === 1 ? "y" : "ies"} — ` +
            `${n > expected ? "some files run NOWHERE" : "some files run twice and the split is a lie"}`,
        );
      }
    }
  }
  if (!source.includes("Test Files +[0-9]+ passed")) {
    bad.push(
      "the tests step no longer reads vitest's `Test Files N passed` line back — a shard that ran no files " +
        "would exit 0 and count as green (Rule 0)",
    );
  }
  // Every job carries a ceiling. Jobs are the two-space-indented keys under `jobs:`.
  const jobsStart = source.search(/^jobs:\s*$/m);
  const jobsBlock = jobsStart === -1 ? "" : source.slice(jobsStart);
  const jobBlocks = jobsBlock.split(/\n(?= {2}[a-z][a-z0-9-]*:\s*\n)/).slice(1);
  if (jobBlocks.length === 0) bad.push("ci.yml has no jobs — Rule 0");
  for (const block of jobBlocks) {
    const name = block.trim().split(":")[0];
    if (!/^\s+timeout-minutes:\s*\d+/m.test(block)) {
      bad.push(`job \`${name}\` has no \`timeout-minutes\` — a hang there is reported after GitHub's six-hour default`);
    }
  }
  return bad;
}

/** How many shards ci.yml's matrix declares, or 0. */
export function shardCount(raw) {
  const m = /^\s+shard:\s*\[([^\]]*)\]/m.exec(withoutComments(raw));
  return m ? m[1].split(",").filter((x) => x.trim()).length : 0;
}

/** `validate:shards` must check the SAME shard count the matrix runs — the two are in different files. */
export function checkShardScript(packageJson, ciRaw) {
  const m = /shard-tests\.mjs --check (\d+)/.exec(packageJson);
  if (!m) return ["package.json has no `validate:shards` running `shard-tests.mjs --check N` — the partition is never proven"];
  const n = shardCount(ciRaw);
  if (Number(m[1]) !== n) return [`\`validate:shards\` checks ${m[1]} shard(s) but ci.yml's matrix runs ${n} — the proof is about a different split`];
  return [];
}

/** The deploy fires on the gate, and only the gate. */
export function checkDeploy(raw) {
  const bad = [];
  const source = withoutComments(raw);
  const m = /workflow_run:\s*\n\s+workflows:\s*\[([^\]]*)\]/.exec(source);
  if (!m) {
    bad.push("deploy.yml has no `workflow_run: workflows: [..]` trigger — nothing deploys a green main");
    return bad;
  }
  const names = m[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, ""));
  if (!names.includes("CI")) bad.push(`deploy.yml waits on [${names.join(", ")}] — it must fire on the merge gate, \`CI\``);
  if (names.includes("Playwright")) {
    bad.push("deploy.yml waits on `Playwright` — the deploy does not wait the journeys out (owner, 21 Sep 2026)");
  }
  return bad;
}

function selfTest() {
  const failures = [];
  let cases = 0;
  const expectCaught = (label, bad) => {
    cases += 1;
    if (bad.length === 0) failures.push(`NOT CAUGHT: ${label}`);
  };
  const expectClean = (label, bad) => {
    cases += 1;
    if (bad.length > 0) failures.push(`FALSE POSITIVE on ${label}: ${bad.join(" / ")}`);
  };
  // The shipped trigger block since 2 Oct 2026: dispatch only, no schedule.
  const PW_ON = "name: Playwright\non:\n  workflow_dispatch:\n\njobs:";

  // The real line, as it stood on origin/main before 18 Sep 2026.
  expectCaught(
    "the shipped `npm run e2e || retry` step",
    checkWorkflow(
      PW_ON + "\n  e2e:\n    name: Playwright journeys\n    steps:\n      - name: Playwright journeys\n" +
        '        run: npm run e2e || (echo "::warning::wrangler dev crashed or a journey failed — retrying the whole suite once" && npm run e2e)\n',
    ),
  );
  expectCaught(
    "a single run with no second pass",
    checkWorkflow(PW_ON + "\n  e2e:\n    steps:\n      - name: Playwright journeys\n        run: npm run e2e\n"),
  );
  expectCaught(
    "continue-on-error on the journeys",
    checkWorkflow(PW_ON + "\n  e2e:\n    continue-on-error: true\n    steps:\n      - run: npm run e2e\n      - run: npm run e2e\n"),
  );
  expectCaught("no e2e job at all", checkWorkflow(PW_ON + "\n  build:\n    steps:\n      - run: npm run build\n"));
  expectClean(
    "two runs that both have to pass",
    checkWorkflow(PW_ON + "\n  e2e:\n    steps:\n      - name: Playwright journeys\n        run: npm run e2e && npm run e2e\n"),
  );
  expectClean(
    "a report upload conditioned on always(), which is where always() belongs",
    checkWorkflow(
      PW_ON + "\n  e2e:\n    steps:\n      - run: npm run e2e\n      - run: npm run e2e\n" +
        "      - name: Upload the report\n        if: always()\n        uses: actions/upload-artifact@v4\n",
    ),
  );
  expectCaught(
    "a second suite run conditioned on always(), which is not",
    checkWorkflow(PW_ON + "\n  e2e:\n    steps:\n      - run: npm run e2e\n      - name: Again\n        if: always()\n        run: npm run e2e\n"),
  );
  expectClean(
    "a job whose COMMENTS quote the forbidden line while its commands do not",
    checkWorkflow(
      PW_ON + "\n  e2e:\n    steps:\n      # this used to be `npm run e2e || (… && npm run e2e)` and `if: always()`\n" +
        "      - run: npm run e2e && npm run e2e\n",
    ),
  );
  expectCaught(
    "a second pass guarded on a branch name",
    checkWorkflow(
      PW_ON + "\n  e2e:\n    steps:\n      - run: |\n          npm run e2e\n          if [ \"$GITHUB_REF\" = \"refs/heads/main\" ]; then\n            npm run e2e\n          fi\n",
    ),
  );
  // Allowed until 21 Sep 2026, when the journeys still ran on pull requests. Not any more: there
  // is no pull-request run, so this guard is dead code around the claim that matters.
  expectCaught(
    "the old second pass skipped on pull_request",
    checkWorkflow(
      PW_ON + "\n  e2e:\n    steps:\n      - run: |\n          npm run e2e\n          if [ \"${GITHUB_EVENT_NAME:-}\" = \"pull_request\" ]; then\n            echo skipped\n          else\n            npm run e2e\n          fi\n",
    ),
  );
  expectClean(
    "the crash re-run under `if grep` on workerd's own signature, then the second pass",
    checkWorkflow(
      PW_ON + "\n  e2e:\n    steps:\n      - run: |\n          if ! npm run e2e 2>&1 | tee log; then\n" +
        "            if grep -qiE 'workers-sdk' log; then\n              npm run e2e\n            else\n              exit 1\n            fi\n          fi\n          npm run e2e\n",
    ),
  );
  const E2E = "\n  e2e:\n    steps:\n      - run: npm run e2e && npm run e2e\n";
  expectCaught(
    "the journeys triggered by pull_request",
    checkWorkflow("name: Playwright\non:\n  workflow_dispatch:\n  pull_request:\n    branches: [main]\n\njobs:" + E2E),
  );
  expectCaught(
    "the journeys triggered by pull_request_target",
    checkWorkflow("name: Playwright\non:\n  workflow_dispatch:\n  pull_request_target:\n\njobs:" + E2E),
  );
  expectCaught(
    "the journeys back on every push to main (the 20-minute tax she removed)",
    checkWorkflow("name: Playwright\non:\n  push:\n    branches: [main]\n  workflow_dispatch:\n\njobs:" + E2E),
  );
  expectClean(
    "no schedule, dispatch only — the shipped shape since 2 Oct 2026",
    checkWorkflow("name: Playwright\non:\n  workflow_dispatch:\n\njobs:" + E2E),
  );
  expectCaught(
    "the journeys scheduled monthly (the 23 Sep shape this supersedes)",
    checkWorkflow("name: Playwright\non:\n  schedule:\n    - cron: \"30 10 1 * *\"\n  workflow_dispatch:\n\njobs:" + E2E),
  );
  expectCaught(
    "the journeys scheduled weekly",
    checkWorkflow("name: Playwright\non:\n  schedule:\n    - cron: \"30 10 * * 1\"\n  workflow_dispatch:\n\njobs:" + E2E),
  );
  expectCaught(
    "the journeys scheduled nightly",
    checkWorkflow("name: Playwright\non:\n  schedule:\n    - cron: \"0 7 * * *\"\n  workflow_dispatch:\n\njobs:" + E2E),
  );
  expectCaught(
    "a bare `schedule:` with no cron under it",
    checkWorkflow("name: Playwright\non:\n  schedule:\n  workflow_dispatch:\n\njobs:" + E2E),
  );
  expectCaught(
    "the journeys with no way to run them on demand (a schedule alone)",
    checkWorkflow("name: Playwright\non:\n  schedule:\n    - cron: \"30 10 1 * *\"\n\njobs:" + E2E),
  );
  expectCaught(
    "the journeys with no triggers at all",
    checkWorkflow("name: Playwright\non:\n\njobs:" + E2E),
  );
  expectCaught(
    "the journeys also on workflow_run (started by another workflow, not by a person)",
    checkWorkflow("name: Playwright\non:\n  workflow_dispatch:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n\njobs:" + E2E),
  );
  expectCaught(
    "the e2e job conditioned on the event name (boss-os's shape, where the journeys share the gate's run)",
    checkWorkflow(PW_ON + "\n  e2e:\n    if: github.event_name != 'pull_request'\n    steps:\n      - run: npm run e2e && npm run e2e\n"),
  );
  const GATE_OK =
    "name: CI\non:\n  push:\n    branches: [main]\njobs:\n  typecheck:\n    timeout-minutes: 5\n    steps:\n      - run: npm run typecheck\n" +
    "  tests:\n    timeout-minutes: 20\n    strategy:\n      matrix:\n        shard: [1, 2, 3, 4]\n    steps:\n      - run: |\n" +
    "          files=\"$(node scripts/ci/shard-tests.mjs --shard ${{ matrix.shard }}/4)\"\n" +
    "          npx vitest run --no-file-parallelism $files 2>&1 | tee log\n" +
    "          files=\"$(grep -oE 'Test Files +[0-9]+ passed' log | grep -oE '[0-9]+' | head -1)\"\n" +
    "  validators:\n    timeout-minutes: 12\n    steps:\n      - run: npm run validate:shards\n" +
    "  gate:\n    needs: [typecheck, tests]\n    timeout-minutes: 2\n    steps:\n      - run: echo ok\n";
  expectClean("the shipped gate shape", checkGate(GATE_OK));
  expectCaught("the count split back in place of the measured one", checkGate(GATE_OK.replace("node scripts/ci/shard-tests.mjs --shard ${{ matrix.shard }}/4", "echo").replace("$files", "--shard=${{ matrix.shard }}/4")));
  expectClean("validate:shards checking the matrix's count", checkShardScript('"validate:shards": "node scripts/ci/shard-tests.mjs --check 4"', GATE_OK));
  expectCaught("validate:shards checking a different count than the matrix", checkShardScript('"validate:shards": "node scripts/ci/shard-tests.mjs --check 3"', GATE_OK));
  expectCaught("no validate:shards script at all", checkShardScript('"validate:x": "node x.mjs"', GATE_OK));
  expectCaught("no job proving the partition", checkGate(GATE_OK.replace("npm run validate:shards", "npm run build")));
  expectCaught("the journeys back in the gate", checkGate(GATE_OK + "  e2e:\n    timeout-minutes: 45\n    steps:\n      - run: npm run e2e && npm run e2e\n"));
  expectCaught("a /4 split over a three-entry matrix (a quarter of the suite runs nowhere)", checkGate(GATE_OK.replace("shard: [1, 2, 3, 4]", "shard: [1, 2, 3]")));
  expectCaught("a /3 split over a four-entry matrix (files run twice, the split is a lie)", checkGate(GATE_OK.replace("}}/4", "}}/3")));
  expectCaught("a matrix that is not 1..N", checkGate(GATE_OK.replace("shard: [1, 2, 3, 4]", "shard: [1, 2, 4, 4]")));
  expectCaught("the suite unsharded again", checkGate(GATE_OK.replace("shard: [1, 2, 3, 4]", "os: [ubuntu]").replace(" --shard=${{ matrix.shard }}/4", "")));
  expectCaught("a shard that no longer proves it ran a file", checkGate(GATE_OK.replace("Test Files +[0-9]+ passed", "Tests +[0-9]+")));
  expectCaught("a job without a ceiling", checkGate(GATE_OK.replace("  gate:\n    needs: [typecheck, tests]\n    timeout-minutes: 2\n", "  gate:\n    needs: [typecheck, tests]\n")));
  expectCaught("a shard count only ever mentioned in a comment", checkGate(GATE_OK.replace("shard: [1, 2, 3, 4]", "# shard: [1, 2, 3, 4]")));
  expectClean("the shipped deploy trigger", checkDeploy("name: Deploy\non:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n"));
  expectCaught("a deploy that waits on the journeys", checkDeploy("name: Deploy\non:\n  workflow_run:\n    workflows: [CI, Playwright]\n    types: [completed]\n"));
  expectCaught("a deploy that waits on nothing", checkDeploy("name: Deploy\non:\n  workflow_dispatch:\n"));
  expectCaught("a deploy that waits on the wrong workflow", checkDeploy("name: Deploy\non:\n  workflow_run:\n    workflows: [Playwright]\n"));
  const GUARD = 'import "./e2e/support/one-connection-per-request";\n';
  expectCaught("retries: 1 in the config", checkConfig(GUARD + "export default defineConfig({\n  retries: 1,\n  workers: 1,\n"));
  expectCaught("parallel workers over one D1", checkConfig(GUARD + "export default defineConfig({\n  retries: 0,\n  workers: 4,\n"));
  expectCaught(
    "the transport guard dropped from the config",
    checkConfig("export default defineConfig({\n  retries: 0,\n  workers: 1,\n"),
  );
  expectCaught(
    "the transport guard commented out",
    checkConfig('// import "./e2e/support/one-connection-per-request";\nexport default defineConfig({\n  retries: 0,\n  workers: 1,\n'),
  );
  expectCaught(
    "the inert 19 Sep header standing in for the guard",
    checkConfig('export default defineConfig({\n  retries: 0,\n  workers: 1,\n  use: { extraHTTPHeaders: { connection: "close" } },\n'),
  );
  expectClean("the shipped config shape", checkConfig(GUARD + "export default defineConfig({\n  retries: 0,\n  workers: 1,\n"));

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
    `A-GREEN-RUN-MEANS-SOMETHING SELF-TEST PASSED: ${cases} case(s), including the real \`npm run e2e || retry\` ` +
      "line as it stood on origin/main and the shard/matrix mismatches that would run a quarter of the suite " +
      "nowhere, every one caught or cleared as intended.",
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

  for (const [file, label] of [
    [WORKFLOW, "playwright.yml (the journeys)"],
    [GATE, "ci.yml (the merge gate)"],
    [DEPLOY, "deploy.yml (the deploy)"],
  ]) {
    if (!existsSync(file)) {
      console.error(`A-GREEN-RUN-MEANS-SOMETHING SCAN FAILED — no .github/workflows/${label} to check. Rule 0.`);
      process.exit(1);
    }
  }
  bad.push(...checkWorkflow(readFileSync(WORKFLOW, "utf8")));
  bad.push(...checkGate(readFileSync(GATE, "utf8")));
  bad.push(...checkShardScript(readFileSync(path.join(ROOT, "package.json"), "utf8"), readFileSync(GATE, "utf8")));
  bad.push(...checkDeploy(readFileSync(DEPLOY, "utf8")));

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
      "row after loading, every one with a loading row in the same slot; the config loads the one-connection-" +
      "per-request transport guard; playwright.yml runs the whole suite twice, on demand only (workflow_dispatch, " +
      "no schedule), and needs both passes; ci.yml is the gate, sharded to its matrix, every shard proving " +
      "it ran files and every job under a ceiling; deploy.yml fires on the gate alone.",
  );
}

main();
