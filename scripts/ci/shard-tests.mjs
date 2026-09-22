#!/usr/bin/env node
/**
 * shard-tests.mjs — the vitest suite split by MEASURED time, not by file count.
 *
 *   node scripts/ci/shard-tests.mjs --shard 2/4          # the files for shard 2 of 4, one per line
 *   node scripts/ci/shard-tests.mjs --check 4            # Rule 0: the 4 shards are a whole, disjoint
 *                                                        # partition of every test file; prints the plan
 *   node scripts/ci/shard-tests.mjs --from-log a.log …   # rebuild tests/timings.json from vitest logs
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
 * Paths are relative to the repo root; the script is run from there (`npm run …`).
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TESTS_DIR = path.join(ROOT, "tests");
const TIMINGS = process.env.SHARD_TIMINGS ?? path.join(ROOT, "tests", "timings.json");

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
  if (fails.length) { console.error("SHARD-TESTS SELF-TEST FAILED:\n  ✗ " + fails.join("\n  ✗ ")); process.exit(1); }
  console.log("SHARD-TESTS SELF-TEST PASSED: 6 case(s).");
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
  const files = testFiles();
  if (files.length === 0) { console.error("SHARD-TESTS: no *.test.ts under tests/ — Rule 0."); process.exit(1); }
  const timings = readTimings();
  const shardArg = at("--shard");
  const checkArg = at("--check");
  if (shardArg) {
    const m = /^(\d+)\/(\d+)$/.exec(shardArg);
    if (!m) { console.error("--shard wants n/N"); process.exit(2); }
    const [i, n] = [Number(m[1]), Number(m[2])];
    if (i < 1 || i > n) { console.error(`--shard ${shardArg}: n must be 1..N`); process.exit(2); }
    const p = plan(files, timings, n);
    const bad = check(files, p.shards);
    if (bad.length) { console.error("SHARD-TESTS: the plan is not a partition:\n  ✗ " + bad.join("\n  ✗ ")); process.exit(1); }
    for (const f of p.shards[i - 1].files) console.log(f);
    return;
  }
  if (checkArg) {
    const n = Number(checkArg);
    if (!Number.isInteger(n) || n < 1) { console.error("--check wants N"); process.exit(2); }
    const p = plan(files, timings, n);
    const bad = check(files, p.shards);
    if (bad.length) { console.error("SHARD-TESTS CHECK FAILED:\n  ✗ " + bad.join("\n  ✗ ")); process.exit(1); }
    const measured = files.length - p.unmeasured.length;
    if (measured === 0) { console.error("SHARD-TESTS CHECK FAILED: tests/timings.json measures none of the files — the split is a guess. Rebuild it with --from-log."); process.exit(1); }
    const stale = Object.keys(timings).filter((f) => !files.includes(f));
    console.log(
      `SHARD-TESTS CHECK PASSED: ${files.length} test file(s) in ${n} shard(s), every one exactly once; ` +
        `${measured} measured, ${p.unmeasured.length} placed at the median (${p.median}ms)` +
        (p.unmeasured.length ? `: ${p.unmeasured.join(", ")}` : "") +
        (stale.length ? `; ${stale.length} stale timing(s) for files that no longer exist (harmless, prune with --from-log)` : "") +
        `. Projected: ${p.shards.map((s, i) => `shard ${i + 1} ${s.files.length} files ${(s.ms / 1000).toFixed(0)}s`).join(" · ")}.`,
    );
    return;
  }
  console.error("usage: --shard n/N | --check N | --from-log <log…> | --self-test");
  process.exit(2);
}

main();
