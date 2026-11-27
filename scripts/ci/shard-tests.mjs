#!/usr/bin/env node
/**
 * shard-tests.mjs — the vitest suite split by MEASURED time, not by file count.
 *
 *   node scripts/ci/shard-tests.mjs --shard 2/4          # the files for shard 2 of 4, one per line
 *   node scripts/ci/shard-tests.mjs --check 4            # Rule 0: the 4 shards are a whole, disjoint
 *                                                        # partition of every test file; prints the plan
 *   node scripts/ci/shard-tests.mjs --from-log a.log …   # rebuild tests/timings.json from vitest logs
 *   node scripts/ci/shard-tests.mjs --from-run [id]      # rebuild it from a CI run's shard logs (gh; default:
 *                                                        # the latest green CI run on main) — `npm run timings:refresh`
 *   node scripts/ci/shard-tests.mjs --drift 2/8 a.log    # after a shard: warn (a ::warning:: on the run) when what
 *                                                        # it measured is far from what timings.json projected
 *
 * WHY. `vitest --shard=n/N` splits the FILE LIST evenly. On the first sharded run (PR #155, 21 Sep
 * 2026) shard 3 finished in 3m18s and shard 4 in 7m04s: 186 files whose durations run from 2ms to
 * 95s, dealt out by count. The gate is as slow as its slowest shard, so the split has to be by
 * time. `tests/timings.json` holds each file's last measured duration (ms, from vitest's own
 * "✓ file (n tests) 1234ms" line); files are assigned longest-first to the emptiest shard (LPT),
 * which lands within a few seconds of the ideal for a list this shape.
 *
 * WHAT KEEPS IT HONEST. A file that is not in the timings map still runs — it takes the median
 * duration for placement — so a new test can never fall out of the gate. `--check N` walks the
 * real tests/ tree and fails unless every file lands in exactly one shard; `validate:shards` runs
 * it in CI and `validate:green-means-something` requires that step to exist. When the map drifts
 * far from reality (a shard twice its projection), rebuild it with `--from-log` from the shard
 * logs of a green run; the projection printed by `--check` says what to expect.
 *
 * TWO LANES (27 Nov 2026, the owner's Open Loops row "West Peek OS: merge check under 5 minutes":
 * "Fast checks before merge, long tests on main after, with a time limit").
 *
 *   node scripts/ci/shard-tests.mjs --shard 2/6 --lane pr --changed-from HEAD^1   # a PR-lane shard
 *   node scripts/ci/shard-tests.mjs --check 6 --lane pr                           # the PR lane's partition
 *
 * The FULL lane (no --lane, or --lane full) is every test file, exactly as before: it runs on every
 * push to main, nightly and on demand, and the deploy waits on it. The PR lane is every test file
 * EXCEPT the ones `tests/lanes.json` lists under `after_merge` (long end-to-end flows, each with its
 * reason) — and an after-merge file still runs on the PR when the PR changes it, or changes a file
 * it imports directly. Files under `pr_always` (the private-data, money and authority guards) can
 * never be listed after merge; `--check` fails if one is. When the PR's changed files cannot be
 * read, or the PR changes what every test stands on (the test helpers, fixtures, vitest or TS
 * config, the dependency lock, lanes.json itself), the PR lane runs EVERY file: unsure is never
 * fewer tests. Nothing is dropped: the PR lane plus the after-merge list is the whole of tests/,
 * and the full lane is all of it again.
 *
 * Paths are relative to the repo root; the script is run from there (`npm run …`).
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const TESTS_DIR = path.join(ROOT, "tests");
const TIMINGS = process.env.SHARD_TIMINGS ?? path.join(ROOT, "tests", "timings.json");
const LANES = process.env.SHARD_LANES ?? path.join(ROOT, "tests", "lanes.json");

/** A change to any of these can move every test, so the PR lane runs all of them. */
const EVERYTHING_RESTS_ON = [/^tests\/helpers\//, /^tests\/fixtures\//, /^tests\/lanes\.json$/, /^vitest\.config\.ts$/, /^tsconfig\.json$/, /^package-lock\.json$/];

export function testFiles(dir = TESTS_DIR, prefix = "tests") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...testFiles(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".test.ts")) out.push(rel);
  }
  return out.sort();
}

export function readTimings(file = TIMINGS) {
  if (!existsSync(file)) return {};
  const j = JSON.parse(readFileSync(file, "utf8"));
  return j && typeof j === "object" ? j : {};
}

/** Longest-first into the emptiest bucket. Deterministic: ties break on the file name. */
export function plan(files, timings, n) {
  const known = files.map((f) => timings[f]).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1000;
  const weighted = files
    .map((f) => ({ f, ms: Number.isFinite(timings[f]) ? timings[f] : median, measured: Number.isFinite(timings[f]) }))
    .sort((a, b) => b.ms - a.ms || a.f.localeCompare(b.f));
  const shards = Array.from({ length: n }, () => ({ files: [], ms: 0 }));
  for (const w of weighted) {
    let best = 0;
    for (let i = 1; i < n; i++) if (shards[i].ms < shards[best].ms) best = i;
    shards[best].files.push(w.f);
    shards[best].ms += w.ms;
  }
  for (const s of shards) s.files.sort();
  return { shards, median, unmeasured: weighted.filter((w) => !w.measured).map((w) => w.f) };
}

/** Rule 0 for the split itself: every file in exactly one shard, no shard empty, nothing invented. */
export function check(files, shards) {
  const bad = [];
  const seen = new Map();
  shards.forEach((s, i) => {
    if (s.files.length === 0) bad.push(`shard ${i + 1} has no files — a shard that runs nothing would still report green`);
    for (const f of s.files) {
      if (seen.has(f)) bad.push(`${f} is in shard ${seen.get(f) + 1} AND shard ${i + 1}`);
      seen.set(f, i);
    }
  });
  for (const f of files) if (!seen.has(f)) bad.push(`${f} is in NO shard — it would never run in CI`);
  for (const f of seen.keys()) if (!files.includes(f)) bad.push(`${f} is planned but does not exist under tests/`);
  return bad;
}

export function fromLogs(logFiles) {
  const timings = {};
  const line = /✓ (tests\/[^\s]+\.test\.ts) \(\d+ tests?[^)]*\) (\d+)ms/g;
  for (const lf of logFiles) {
    const text = readFileSync(lf, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
    for (const m of text.matchAll(line)) timings[m[1]] = Number(m[2]);
  }
  return Object.fromEntries(Object.entries(timings).sort(([a], [b]) => a.localeCompare(b)));
}

/** tests/lanes.json → { afterMerge: Map(file → why), prAlways: Map(file → why) }. A missing file is an error, never "no lanes". */
export function readLanes(file = LANES) {
  const j = JSON.parse(readFileSync(file, "utf8"));
  const map = (o) => new Map(Object.entries(o && typeof o === "object" ? o : {}).filter(([k]) => !k.startsWith("_")));
  return { afterMerge: map(j.after_merge), prAlways: map(j.pr_always) };
}

/** The repo paths a test file imports DIRECTLY (relative specifiers in import / export / import() / vi.mock), resolved. */
export function directImports(testFile, source) {
  const out = new Set();
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.mock\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
  for (const m of source.matchAll(re)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(testFile), m[1]));
    const stem = base.replace(/\.(m?js|ts|tsx|mts)$/, "");
    for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.mjs`, `${stem}.js`, `${stem}.d.mts`, `${base}/index.ts`]) out.add(c);
  }
  return out;
}

/**
 * The PR lane. `changed` is the PR's changed paths, or null when they could not be read.
 * Returns the files to run, the after-merge files pulled back in (with why), and whether everything runs.
 */
export function prLane(files, lanes, changed, sourceOf) {
  const after = new Set([...lanes.afterMerge.keys()].filter((f) => files.includes(f)));
  if (changed === null) return { run: files.slice(), pulledIn: [], everything: "the PR's changed files could not be read" };
  const root = changed.find((c) => EVERYTHING_RESTS_ON.some((r) => r.test(c)));
  if (root) return { run: files.slice(), pulledIn: [], everything: `the PR changes ${root}, which every test stands on` };
  const pulledIn = [];
  for (const f of after) {
    if (changed.includes(f)) { pulledIn.push({ f, why: "the PR changes it" }); continue; }
    const imports = directImports(f, sourceOf(f));
    const hit = changed.find((c) => imports.has(c));
    if (hit) pulledIn.push({ f, why: `it imports ${hit}, which the PR changes` });
  }
  const back = new Set(pulledIn.map((p) => p.f));
  return { run: files.filter((f) => !after.has(f) || back.has(f)), pulledIn, everything: "" };
}

/** Rule 0 for the lanes themselves: real files, a reason each, no guard after merge, and the two halves are the whole. */
export function checkLanes(files, lanes) {
  const bad = [];
  for (const [f, why] of lanes.afterMerge) {
    if (!files.includes(f)) bad.push(`after_merge names ${f}, which is not a test file under tests/`);
    if (String(why).trim().split(/\s+/).length < 4) bad.push(`after_merge ${f} gives no reason (4+ words) why it may wait until after the merge`);
    if (lanes.prAlways.has(f)) bad.push(`${f} is a pr_always guard AND after_merge — a guard never moves after the merge`);
  }
  for (const f of lanes.prAlways.keys()) if (!files.includes(f)) bad.push(`pr_always names ${f}, which is not a test file under tests/`);
  if (lanes.afterMerge.size === 0) bad.push("after_merge is empty — the PR lane is the full suite and lanes.json is doing nothing");
  const lane = prLane(files, lanes, [], () => "");
  if (lane.run.length + lanes.afterMerge.size !== files.length) bad.push(`the PR lane (${lane.run.length}) plus after_merge (${lanes.afterMerge.size}) is not the ${files.length} test files`);
  return bad;
}

/** git diff --name-only <ref> HEAD, or null when git cannot answer (never "nothing changed"). */
export function changedFrom(ref) {
  try {
    return execFileSync("git", ["diff", "--name-only", ref, "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * DRIFT (15 Nov 2026). The map went stale once already: tests/webPropertyChange.test.ts was 61s in
 * timings.json and 311s on main, and 115 files had no timing at all, so one of four shards took
 * 11.5 min against a 5-minute gate. Every shard now compares what it measured with what it was
 * projected and says so on the run (a ::warning:: annotation on the PR) once the shard is over its
 * projection by half and by a minute, or one file is over twice its timing and by 30s. A warning,
 * not a failure: a slow runner must not turn main red; the cure is `npm run timings:refresh`.
 */
export function drift(plannedFiles, timings, measured, median) {
  const projected = plannedFiles.reduce((a, f) => a + (Number.isFinite(timings[f]) ? timings[f] : median), 0);
  const actual = plannedFiles.reduce((a, f) => a + (measured[f] ?? 0), 0);
  const files = plannedFiles
    .filter((f) => Number.isFinite(measured[f]))
    .map((f) => ({ f, was: Number.isFinite(timings[f]) ? timings[f] : null, now: measured[f] }))
    .filter((x) => x.was === null ? x.now > 30_000 : x.now > 2 * x.was && x.now - x.was > 30_000)
    .sort((a, b) => b.now - a.now);
  const over = actual > projected * 1.5 && actual - projected > 60_000;
  return { projected, actual, over, files };
}

function selfTest() {
  const fails = [];
  const t = { "tests/a.test.ts": 90, "tests/b.test.ts": 50, "tests/c.test.ts": 40, "tests/d.test.ts": 10 };
  const p = plan(Object.keys(t), t, 2);
  const totals = p.shards.map((s) => s.ms);
  if (Math.max(...totals) !== 100 || Math.min(...totals) !== 90) fails.push(`LPT split ${JSON.stringify(totals)}, expected 100/90`);
  if (check(Object.keys(t), p.shards).length) fails.push("a clean plan failed check");
  const q = plan(["tests/a.test.ts", "tests/new.test.ts"], { "tests/a.test.ts": 90 }, 2);
  if (!q.unmeasured.includes("tests/new.test.ts") || q.shards.flatMap((s) => s.files).length !== 2) fails.push("an unmeasured file was not placed");
  const dup = check(["tests/a.test.ts", "tests/b.test.ts"], [{ files: ["tests/a.test.ts"] }, { files: ["tests/a.test.ts"] }]);
  if (!dup.some((b) => b.includes("AND shard")) || !dup.some((b) => b.includes("NO shard"))) fails.push("a duplicated and a dropped file were not both caught");
  if (!check(["tests/a.test.ts"], [{ files: ["tests/a.test.ts"] }, { files: [] }]).some((b) => b.includes("no files"))) fails.push("an empty shard was not caught");
  const ghost = check(["tests/a.test.ts"], [{ files: ["tests/a.test.ts", "tests/gone.test.ts"] }]);
  if (!ghost.some((b) => b.includes("does not exist"))) fails.push("a planned file that does not exist was not caught");
  const d = drift(["tests/a.test.ts", "tests/b.test.ts"], { "tests/a.test.ts": 60_000, "tests/b.test.ts": 10_000 }, { "tests/a.test.ts": 300_000, "tests/b.test.ts": 10_000 }, 1000);
  if (!d.over || d.files.length !== 1 || d.files[0].f !== "tests/a.test.ts") fails.push("a file five times its timing was not reported as drift");
  const calm = drift(["tests/a.test.ts"], { "tests/a.test.ts": 60_000 }, { "tests/a.test.ts": 70_000 }, 1000);
  if (calm.over || calm.files.length) fails.push("a shard within its projection was reported as drift");
  // The lanes (27 Nov 2026).
  const F = ["tests/guard.test.ts", "tests/long.test.ts", "tests/other.test.ts", "tests/short.test.ts"];
  const L = { afterMerge: new Map([["tests/long.test.ts", "a long end-to-end flow, no guard"]]), prAlways: new Map([["tests/guard.test.ts", "the LP guard"]]) };
  const SRC = { "tests/long.test.ts": 'import { a } from "../src/worker/services/long";\nvi.mock("../src/worker/ai/runAi", () => ({}));\nimport "./helpers/db";\n' };
  const src = (f) => SRC[f] ?? "";
  const base = prLane(F, L, [], src);
  if (base.run.includes("tests/long.test.ts") || base.run.length !== 3) fails.push(`the base PR lane ran ${JSON.stringify(base.run)} — the after-merge file must wait`);
  if (!prLane(F, L, ["tests/long.test.ts"], src).run.includes("tests/long.test.ts")) fails.push("an after-merge file the PR changes was not run on the PR");
  if (!prLane(F, L, ["src/worker/services/long.ts"], src).run.includes("tests/long.test.ts")) fails.push("an after-merge file importing a changed source file was not run on the PR");
  if (!prLane(F, L, ["src/worker/ai/runAi.ts"], src).run.includes("tests/long.test.ts")) fails.push("an after-merge file mocking a changed source file was not run on the PR");
  if (prLane(F, L, ["src/worker/services/unrelated.ts"], src).run.includes("tests/long.test.ts")) fails.push("an after-merge file was pulled in by a change it does not import");
  const blind = prLane(F, L, null, src);
  if (!blind.everything || blind.run.length !== F.length) fails.push("an unreadable diff did not run every file (unsure must never be fewer tests)");
  for (const root of ["tests/helpers/db.ts", "vitest.config.ts", "package-lock.json", "tests/lanes.json"]) {
    if (prLane(F, L, [root], src).run.length !== F.length) fails.push(`a PR changing ${root} did not run every file`);
  }
  if (checkLanes(F, L).length) fails.push(`clean lanes failed checkLanes: ${checkLanes(F, L).join("; ")}`);
  const guardMoved = { afterMerge: new Map([["tests/guard.test.ts", "moved because it is slow"]]), prAlways: L.prAlways };
  if (!checkLanes(F, guardMoved).some((b) => b.includes("never moves after the merge"))) fails.push("a pr_always guard listed after merge was not caught");
  if (!checkLanes(F, { afterMerge: new Map([["tests/gone.test.ts", "a long flow that left"]]), prAlways: new Map() }).some((b) => b.includes("not a test file"))) fails.push("an after-merge file that does not exist was not caught");
  if (!checkLanes(F, { afterMerge: new Map([["tests/long.test.ts", "slow"]]), prAlways: new Map() }).some((b) => b.includes("no reason"))) fails.push("an after-merge file with no reason was not caught");
  if (!checkLanes(F, { afterMerge: new Map(), prAlways: new Map() }).some((b) => b.includes("empty"))) fails.push("an empty after_merge list was not caught");
  const imps = directImports("tests/long.test.ts", SRC["tests/long.test.ts"]);
  if (!imps.has("src/worker/services/long.ts") || !imps.has("tests/helpers/db.ts")) fails.push(`directImports resolved ${JSON.stringify([...imps].slice(0, 6))}`);
  if (fails.length) { console.error("SHARD-TESTS SELF-TEST FAILED:\n  ✗ " + fails.join("\n  ✗ ")); process.exit(1); }
  console.log("SHARD-TESTS SELF-TEST PASSED: 24 case(s).");
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) return selfTest();
  const at = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
  if (argv.includes("--from-log")) {
    const logs = argv.slice(argv.indexOf("--from-log") + 1);
    const timings = fromLogs(logs);
    if (Object.keys(timings).length === 0) { console.error("SHARD-TESTS: no '✓ tests/… (n tests) Nms' lines in those logs — nothing written."); process.exit(1); }
    writeFileSync(TIMINGS, JSON.stringify(timings, null, 2) + "\n");
    console.log(`wrote ${Object.keys(timings).length} timing(s) to ${path.relative(ROOT, TIMINGS)}`);
    return;
  }
  if (argv.includes("--from-run")) {
    const gh = (...a) => execFileSync("gh", a, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    const id = at("--from-run") ?? gh("run", "list", "-w", "CI", "-b", "main", "-s", "success", "-L", "1", "--json", "databaseId", "-q", ".[0].databaseId").trim();
    const jobs = gh("run", "view", id, "--json", "jobs", "-q", '.jobs[] | select(.name | test("shard")) | .databaseId').split("\n").filter(Boolean);
    if (jobs.length === 0) { console.error(`SHARD-TESTS: run ${id} has no shard jobs — nothing written.`); process.exit(1); }
    const logs = jobs.map((j) => { const f = path.join(process.env.RUNNER_TEMP ?? "/tmp", `shard-log-${j}.log`); writeFileSync(f, gh("run", "view", "--job", j, "--log")); return f; });
    const timings = fromLogs(logs);
    const files = testFiles();
    const missing = files.filter((f) => !(f in timings));
    if (missing.length > files.length / 10) { console.error(`SHARD-TESTS: run ${id} measured ${Object.keys(timings).length} of ${files.length} files — not a whole run, nothing written.`); process.exit(1); }
    writeFileSync(TIMINGS, JSON.stringify(timings, null, 2) + "\n");
    console.log(`wrote ${Object.keys(timings).length} timing(s) from run ${id} (${jobs.length} shards) to ${path.relative(ROOT, TIMINGS)}`);
    return;
  }
  const files = testFiles();
  if (files.length === 0) { console.error("SHARD-TESTS: no *.test.ts under tests/ — Rule 0."); process.exit(1); }
  const timings = readTimings();
  const shardArg = at("--shard");
  const checkArg = at("--check");
  const laneArg = at("--lane") ?? "full";
  if (laneArg !== "full" && laneArg !== "pr") { console.error(`--lane ${laneArg}: wants pr or full`); process.exit(2); }
  // The files this lane plans. full = every test file. pr = see prLane(); --check plans the base PR lane
  // (a PR that changes nothing), a shard or a drift read plans the lane for the PR's own changes.
  let lanes = null;
  let planned = files;
  if (laneArg === "pr") {
    lanes = readLanes();
    const ref = at("--changed-from");
    if (!checkArg && !ref) { console.error("--lane pr needs --changed-from <ref> (the PR's base) for a shard or a drift read"); process.exit(2); }
    const changed = ref ? changedFrom(ref) : [];
    const lane = prLane(files, lanes, changed, (f) => readFileSync(path.join(ROOT, f), "utf8"));
    planned = lane.run;
    console.error(
      `PR lane: ${planned.length} of ${files.length} test files` +
        (lane.everything ? ` — every file, because ${lane.everything}` : `; ${files.length - planned.length} run after the merge (tests/lanes.json)`) +
        (lane.pulledIn.length ? `; pulled back in: ${lane.pulledIn.map((x) => `${x.f} (${x.why})`).join("; ")}` : ""),
    );
  }
  if (shardArg) {
    const m = /^(\d+)\/(\d+)$/.exec(shardArg);
    if (!m) { console.error("--shard wants n/N"); process.exit(2); }
    const [i, n] = [Number(m[1]), Number(m[2])];
    if (i < 1 || i > n) { console.error(`--shard ${shardArg}: n must be 1..N`); process.exit(2); }
    const p = plan(planned, timings, n);
    const bad = check(planned, p.shards);
    if (bad.length) { console.error("SHARD-TESTS: the plan is not a partition:\n  ✗ " + bad.join("\n  ✗ ")); process.exit(1); }
    for (const f of p.shards[i - 1].files) console.log(f);
    return;
  }
  const driftArg = at("--drift");
  if (driftArg) {
    const m = /^(\d+)\/(\d+)$/.exec(driftArg);
    const log = argv[argv.indexOf("--drift") + 2];
    if (!m || !log) { console.error("--drift wants n/N <vitest log>"); process.exit(2); }
    const p = plan(planned, timings, Number(m[2]));
    const d = drift(p.shards[Number(m[1]) - 1].files, timings, fromLogs([log]), p.median);
    const s = (ms) => `${(ms / 1000).toFixed(0)}s`;
    const where = d.files.slice(0, 5).map((x) => `${x.f} ${x.was === null ? "unmeasured" : s(x.was)} → ${s(x.now)}`).join("; ");
    if (d.over || d.files.length) {
      console.log(`::warning title=Shard ${driftArg} is off its timings::measured ${s(d.actual)} against a projection of ${s(d.projected)}${where ? ` — ${where}` : ""}. tests/timings.json is stale: run \`npm run timings:refresh\` and commit it.`);
    } else console.log(`shard ${driftArg}: measured ${s(d.actual)}, projected ${s(d.projected)} — the timings hold.`);
    return;
  }
  if (checkArg) {
    const n = Number(checkArg);
    if (!Number.isInteger(n) || n < 1) { console.error("--check wants N"); process.exit(2); }
    const p = plan(planned, timings, n);
    const bad = [...check(planned, p.shards), ...(lanes ? checkLanes(files, lanes) : [])];
    if (bad.length) { console.error("SHARD-TESTS CHECK FAILED:\n  ✗ " + bad.join("\n  ✗ ")); process.exit(1); }
    const measured = planned.length - p.unmeasured.length;
    if (measured === 0) { console.error("SHARD-TESTS CHECK FAILED: tests/timings.json measures none of the files — the split is a guess. Rebuild it with --from-log."); process.exit(1); }
    const stale = Object.keys(timings).filter((f) => !files.includes(f));
    console.log(
      `SHARD-TESTS CHECK PASSED (${laneArg} lane): ${planned.length} test file(s) in ${n} shard(s), every one exactly once` +
        (lanes ? ` — and ${files.length - planned.length} after the merge, ${files.length} in all, none of the ${lanes.prAlways.size} pr_always guards among them` : "") + "; " +
        `${measured} measured, ${p.unmeasured.length} placed at the median (${p.median}ms)` +
        (p.unmeasured.length ? `: ${p.unmeasured.join(", ")}` : "") +
        (stale.length ? `; ${stale.length} stale timing(s) for files that no longer exist (harmless, prune with --from-log)` : "") +
        `. Projected: ${p.shards.map((s, i) => `shard ${i + 1} ${s.files.length} files ${(s.ms / 1000).toFixed(0)}s`).join(" · ")}.`,
    );
    return;
  }
  console.error("usage: --shard n/N | --check N | --drift n/N <log> (each with --lane pr|full; pr needs --changed-from <ref> to shard or drift) | --from-log <log…> | --from-run [id] | --self-test");
  process.exit(2);
}

main();
