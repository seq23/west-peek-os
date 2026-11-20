#!/usr/bin/env node
/**
 * `npm run check:changed` — THE PRE-PUSH CHECK, SCOPED TO THE WORK (15 Nov 2026).
 *
 * One change took seven PRs (#460–#466) because each push found the next fault only in CI, ten
 * minutes later. This runs, before the push, the part of the gate that the change can break:
 *
 *   (a) the typecheck (incremental, so the second run on a clone is a couple of seconds);
 *   (b) the changed test files, then the tests that import what changed, at most TEST_CAP files in all;
 *   (c) the boundary validators CI runs (the `npm run validate:*` lines in .github/workflows/ci.yml,
 *       which is the registry), minus the slow ones whose inputs the change does not touch.
 *
 * Scoping the validators: every validator under ~2s runs ALWAYS (they are static scans of the tree
 * and all of them together, in parallel, cost less than working out which apply). The slow ones
 * are scoped by the paths they read, in SCOPED below; a validator not listed there runs always,
 * so a new validator is covered by default. A validator also runs when its own script changes, and
 * all of them run when package.json, the lockfile, the CI workflow or scripts/validate/lib changes.
 *
 * Never the full suite: CI runs that. Exit 0 = every step passed; exit 1 = a step failed, with its
 * output and one closing line. The pre-push hook (.githooks/pre-push) runs this; `git push
 * --no-verify` is the human escape hatch only.
 *
 * Flags: `--base <ref>` (default: merge-base with origin/main), `--list` (print the plan, run nothing).
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const LIST_ONLY = argv.includes("--list");

/** Validators over ~2s, scoped by the path prefixes they read (from each script's own reads). */
export const SCOPED = {
  "validate:outside-email": ["src/", "wrangler.toml", "migrations/"],
  "validate:meeting-brief": ["migrations/", "src/worker/services/jobs.ts", "src/worker/services/meetingBrief.ts", "src/worker/services/meetings.ts", "src/shared/meetings/"],
  "validate:meeting-yield": ["migrations/", "src/worker/services/meetingAfter.ts", "src/worker/services/meetings.ts", "src/client/pages/MeetingsPage.tsx", "src/shared/registry/", "src/shared/meetings/"],
  "validate:partner-service-rules": ["src/", "scripts/duties/", "docs/PARTNER_SERVICE_RULES.md"],
  "validate:codex-lane": ["scripts/duties/", "scripts/lib/", "scripts/probes/"],
  "validate:sql": ["src/worker/", "migrations/"],
  "validate:room-answers": ["migrations/", "src/shared/", "src/worker/services/meetingRoom.ts"],
  "validate:deck-fit": ["src/shared/deck/"],
};
/** Any of these changing runs every validator. */
const RUN_ALL = ["package.json", "package-lock.json", ".github/workflows/ci.yml", "scripts/validate/lib/"];

const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();

export function changedFiles(base) {
  const committed = git("diff", "--name-only", `${base}`, "HEAD");
  return committed.split("\n").filter(Boolean);
}

export function registeredValidators(ciYml, scripts) {
  const names = [...new Set([...ciYml.matchAll(/npm run (validate:[\w-]+)/g)].map((m) => m[1]))];
  return names.filter((n) => scripts[n]);
}

/** Which validators this change can affect. Pure, so the test can pin it. */
export function planValidators(changed, validators, scripts) {
  const hit = (prefixes) => changed.some((f) => prefixes.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)));
  const all = hit(RUN_ALL);
  const run = [], skipped = [];
  for (const v of validators) {
    const own = (scripts[v].match(/[\w./-]+\.mjs/g) ?? []);
    if (all || !SCOPED[v] || hit(SCOPED[v]) || hit(own)) run.push(v);
    else skipped.push(v);
  }
  return { run, skipped };
}

/*
 * WHICH TESTS. `vitest related` follows the whole import graph, and this repo's services reach each other: on #465's
 * diff it picked 192 of ~300 files (partnerProfile.ts is three hops from most of the worker), ~20 minutes of
 * Miniflare. The direct importers alone can be as wide: emailThread.ts and workSweep.ts are entry points that ~70
 * test files import, so a change to either ran 77 Miniflare files and timed out under load (20 Nov 2026, 34 min).
 * So, at most TEST_CAP files: every changed test file always, then the direct importers that import the MOST changed
 * files, then the transitive set only if it all still fits. The rest is said in the summary line; CI's shards run it.
 */
export const TEST_CAP = 20;

/*
 * A SUITE THAT CRASHED IS NOT A TEST THAT FAILED (20 Nov 2026, this Mac at load 25-35): 17 of 20 suites died at start
 * with "fetch failed" / ECONNRESET / "other side closed" from their miniflare worker, and not one test failed. Those
 * suites are named here so they run once more, one at a time; a run where any test failed is never retried. Pure.
 */
const CRASH = /fetch failed|ECONNRESET|other side closed|EADDRNOTAVAIL|Timeout calling "fetch"/;
export function crashedSuites(out) {
  const text = String(out ?? "");
  if (/Tests\s+\d+ failed/.test(text) || !CRASH.test(text)) return [];
  return [...new Set([...text.matchAll(/FAIL\s+(tests\/\S+\.test\.ts)\s+\[\s*\1\s*\]/g)].map((m) => m[1]))];
}

/** Pure, so the test can pin it. `direct` maps each importing test to how many changed files it imports. */
export function capTests(changedTests, direct, transitive, cap = TEST_CAP) {
  const own = [...new Set(changedTests)];
  const rest = [...direct.entries()].filter(([t]) => !own.includes(t)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  const room = Math.max(0, cap - own.length);
  const picked = [...own, ...rest.slice(0, room)];
  const takeTransitive = picked.length + transitive.length <= cap ? transitive : [];
  return { run: [...picked, ...takeTransitive].sort(), left: rest.length - Math.min(rest.length, room) + transitive.length - takeTransitive.length };
}
const ALIAS = { "@shared/": "src/shared/", "@worker/": "src/worker/" };
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
function resolveSpec(from, spec) {
  let p = null;
  for (const [a, t] of Object.entries(ALIAS)) if (spec.startsWith(a)) p = path.join(ROOT, t, spec.slice(a.length));
  if (!p) { if (!spec.startsWith(".")) return null; p = path.resolve(path.dirname(from), spec); }
  for (const c of [p, `${p}.ts`, `${p}.tsx`, `${p}.mjs`, `${p}.js`, p.replace(/\.js$/, ".ts"), path.join(p, "index.ts")]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}
const depCache = new Map();
function depsOf(file) {
  if (!depCache.has(file)) {
    const out = [];
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) { if (m[1]) continue; const r = resolveSpec(file, m[2] ?? m[3]); if (r) out.push(r); }
    depCache.set(file, out);
  }
  return depCache.get(file);
}
export function selectTests(changed) {
  const targets = new Set(changed.filter((f) => existsSync(path.join(ROOT, f))).map((f) => path.join(ROOT, f)));
  const all = readdirSync(path.join(ROOT, "tests"), { recursive: true }).filter((f) => String(f).endsWith(".test.ts")).map((f) => path.join(ROOT, "tests", String(f)));
  const changedTests = [], direct = new Map(), transitive = [];
  for (const t of all) {
    if (targets.has(t)) { changedTests.push(t); continue; }
    const hits = depsOf(t).filter((d) => targets.has(d)).length;
    if (hits) { direct.set(t, hits); continue; }
    const seen = new Set([t]), stack = [...depsOf(t)];
    while (stack.length) {
      const d = stack.pop();
      if (seen.has(d)) continue;
      seen.add(d);
      if (targets.has(d)) { transitive.push(t); break; }
      stack.push(...depsOf(d));
    }
  }
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
  const { run, left } = capTests(changedTests, direct, transitive);
  return { run: run.map(rel).sort(), left };
}

/*
 * A git hook runs with GIT_DIR (and friends) set to this repo. A validator that builds its own scratch repo
 * (validate:codex-lane) then ran its `git worktree add` against OURS and failed under the hook only. Children get none.
 */
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|OBJECT_DIRECTORY|COMMON_DIR|ALTERNATE_OBJECT_DIRECTORIES|QUARANTINE_PATH)$/.test(k)));

function run(label, cmd, args) {
  return new Promise((resolve) => {
    const t = Date.now();
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...CHILD_ENV, NO_COLOR: "1", FORCE_COLOR: "0" } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ label, code, out, secs: (Date.now() - t) / 1000 }));
  });
}

async function pool(items, size, fn) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const it = items[i++]; results.push(await fn(it)); } }));
  return results;
}

async function main() {
  const started = Date.now();
  let base = flag("--base");
  if (!base) {
    try { base = git("merge-base", "HEAD", "origin/main"); }
    catch { console.error("check:changed: no origin/main to compare against — run `git fetch origin` first"); process.exit(1); }
  }
  const scripts = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
  const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const changed = changedFiles(base);
  const validators = registeredValidators(ci, scripts);
  // Rule 0: a registry read that found nothing is a broken check, never a pass.
  if (validators.length < 10) { console.error(`check:changed: read only ${validators.length} validators from ci.yml — the registry read is broken`); process.exit(1); }
  const { run: vRun, skipped } = planValidators(changed, validators, scripts);
  const tests = selectTests(changed);

  if (LIST_ONLY) {
    console.log(JSON.stringify({ base, changed, tests_run: tests.run, tests_left_to_ci: tests.left, validators_run: vRun, validators_skipped: skipped }, null, 2));
    return;
  }
  if (changed.length === 0) { console.log("check:changed: nothing changed against origin/main — nothing to check"); return; }

  const cpus = Math.max(2, os.availableParallelism?.() ?? os.cpus().length);
  const steps = [run("typecheck", "npx", ["tsc", "--noEmit", "--incremental", "--tsBuildInfoFile", "node_modules/.cache/check-changed.tsbuildinfo"])];
  if (tests.run.length) steps.push(run("tests", "npx", ["vitest", "run", ...tests.run]));
  steps.push(pool(vRun, Math.max(2, Math.floor(cpus / 2)), (v) => run(v, "npm", ["run", "-s", v])));
  const results = (await Promise.all(steps)).flat();

  let testRun = results.find((r) => r.label === "tests");
  // A suite whose miniflare died under load (no test failed) is run once more, alone, after everything else is done.
  const crashed = testRun && testRun.code !== 0 ? crashedSuites(testRun.out) : [];
  if (crashed.length) {
    const again = await run("tests", "npx", ["vitest", "run", "--no-file-parallelism", "--maxWorkers=1", ...crashed]);
    const firstPassed = Number((testRun.out.match(/Test Files\s+(?:\d+ failed \| )?(\d+) passed/) ?? [])[1] ?? 0);
    const againPassed = Number((again.out.match(/Test Files\s+(?:\d+ failed \| )?(\d+) passed/) ?? [])[1] ?? 0);
    again.out = `${crashed.length} suite(s) crashed under load (no test failed) and were run again, one at a time:\n${again.out}\nTest Files  ${firstPassed + againPassed} passed`;
    results[results.indexOf(testRun)] = again;
    testRun = again;
  }
  const testFiles = testRun ? Number((testRun.out.match(/Test Files\s+(?:\d+ failed \| )?(\d+) passed/) ?? [])[1] ?? 0) : 0;
  // Rule 0: tests were planned and none passed is a failure, never a quiet pass.
  if (testRun && testRun.code === 0 && testFiles === 0) { testRun.code = 1; testRun.out += "\nplanned test files but none passed (Rule 0)"; }
  const failed = results.filter((r) => r.code !== 0);
  for (const f of failed) {
    let hint = "";
    if (f.label === "validate:deck-fit" && /Executable doesn't exist|playwright install/i.test(f.out)) hint = "\n(needs the browser once: npx playwright install --only-shell chromium)";
    console.error(`\n── ${f.label} FAILED (${f.secs.toFixed(1)}s) ──\n${f.out.trim().split("\n").slice(-40).join("\n")}${hint}`);
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const summary = `${changed.length} files changed · typecheck · ${testRun ? `${testFiles} test file(s)` : "no test reaches the change"}${tests.left ? ` (${tests.left} more reach it indirectly; CI runs them)` : ""} · ${vRun.length} validators (${skipped.length} scoped out) · ${secs}s`;
  if (failed.length) {
    console.error(`\ncheck:changed FAILED: ${failed.map((f) => f.label).join(", ")} — ${summary}. Fix and push again (git push --no-verify is for humans only).`);
    process.exit(1);
  }
  console.log(`check:changed OK — ${summary}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
