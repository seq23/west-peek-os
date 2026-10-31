#!/usr/bin/env node
/**
 * THE CODEX LANE CAN PRODUCE A COMMIT — AND CANNOT MERGE ONE (31 Oct 2026). `npm run validate:codex-lane`.
 *
 * The defect (found in boss-os, PR #187; this repo carried the same code): when a web-property-change
 * BUILD fell back to Codex (her ChatGPT seat), the runner named each worktree's `.git` as writable and
 * expected Codex to `git commit`, `git push` and `gh pr create`. Codex's workspace-write sandbox keeps git
 * metadata read-only even inside a named writable root (`index.lock: Operation not permitted`), so the
 * BUILD would have edited the site and opened no PR. Now Codex edits, and the duty script, outside the
 * sandbox, commits, pushes the work branch and opens the PR (`finishCodexBuild` via `finishIfCodex`);
 * `~/bin/land`, through the LAND phase, alone merges.
 *
 * What is asserted, as behaviour:
 *   A. The shipped `finishCodexBuild` is RUN on a scratch repository (bare origin, linked worktree on a work
 *      branch, Codex's uncommitted edit, Codex's own index.lock failure) with real git and a fake gh: it must
 *      leave a commit on the branch, push that branch, open a PR against main — origin/main must not move
 *      and gh must never be asked to merge.
 *   B. It refuses to commit on main, and over a failure that is not the sandbox's git block.
 *   C. The duty is wired to it: every model turn in a job worktree carries its phase and is followed by
 *      `finishIfCodex`; `finishIfCodex` calls `finishCodexBuild`; Codex's BUILD prompt carries the build
 *      note; no git directory is named writable to Codex. Hard-fails on zero worktree turns.
 *
 * `--self-test` runs the same checks over broken copies and fails unless every one is caught.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as seat from "../lib/codex-seat.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DUTY = readFileSync(path.join(ROOT, "scripts/duties/web-property-change.mjs"), "utf8");
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "v", GIT_AUTHOR_EMAIL: "v@v", GIT_COMMITTER_NAME: "v", GIT_COMMITTER_EMAIL: "v@v" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
const BRANCH = "work/wpc-validator";

function scratch() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wpos-codex-lane-")));
  const origin = path.join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const main = path.join(root, "main");
  git(root, "clone", "-q", origin, main);
  git(main, "commit", "-q", "--allow-empty", "-m", "init");
  git(main, "push", "-q", "origin", "HEAD:main");
  const wt = path.join(root, "wt");
  git(main, "worktree", "add", "-q", wt, "-b", BRANCH, "origin/main");
  const gh = [];
  const run = (cmd, args, o) => {
    if (cmd === "gh") {
      gh.push(args);
      if (args[1] === "view") return { status: 1, stdout: "", stderr: "no pull requests found" };
      return { status: 0, stdout: "https://github.com/seq23/probe/pull/9\n", stderr: "" };
    }
    try {
      return { status: 0, stdout: execFileSync(cmd, args, { cwd: o.cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
    } catch (e) {
      return { status: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
    }
  };
  return { root, origin, main, wt, gh, run };
}

/** The duty's model turns in a job worktree: each `runClaude(` call with `cwd: names.worktree` / `p.names.worktree`. */
function worktreeTurns(duty) {
  const lines = duty.split("\n");
  const turns = [];
  lines.forEach((l, i) => {
    if (/await runClaude\(\{/.test(l) && /cwd: (p\.)?names\.worktree/.test(l)) turns.push({ line: i + 1, text: l, next: lines[i + 1] ?? "" });
  });
  return turns;
}

function wiringProblems(duty, finishSource) {
  const problems = [];
  const turns = worktreeTurns(duty);
  if (turns.length === 0) problems.push("C: no model turn in a job worktree was found — the check reads nothing (Rule 0).");
  for (const t of turns) {
    if (!/\bphase \}\)/.test(t.text)) problems.push(`C: the model turn at web-property-change.mjs:${t.line} does not carry its phase, so Codex is not told the runner commits.`);
    if (!/^\s*finishIfCodex\(claude, \{ phase, resultPath, worktree: (p\.)?names\.worktree, branch: (p\.)?names\.branch, jobDir, progress \}\);/.test(t.next)) {
      problems.push(`C: the model turn at web-property-change.mjs:${t.line} is not followed by finishIfCodex — a Codex-served BUILD there opens no PR.`);
    }
  }
  if (!/function finishIfCodex\([^)]*\) \{[\s\S]{0,400}if \(phase !== "BUILD" \|\| claude\?\.servedBy !== "codex"\) return null;[\s\S]{0,400}finishCodexBuild\(\{/.test(duty)) problems.push("C: finishIfCodex no longer runs finishCodexBuild for a Codex-served BUILD.");
  if (!/if \(phase === "BUILD"\) prompt = `\$\{prompt\}\$\{CODEX_BUILD_NOTE\}`;/.test(duty)) problems.push("C: Codex's BUILD prompt no longer carries CODEX_BUILD_NOTE.");
  if (/gitCommonDirs|"--git-common-dir"/.test(duty)) problems.push("C: the duty names a git directory as writable to Codex again.");
  if (/"merge"|gh pr merge|HEAD:main|HEAD:refs\/heads\/main/.test(finishSource)) problems.push("C: finishCodexBuild can merge or push main.");
  return problems;
}

function check({ finish, duty, finishSource }) {
  const problems = [];
  const s = scratch();
  try {
    writeFileSync(path.join(s.wt, "change.txt"), "Codex's edit");
    const out = { phase: "BUILD", status: "failed", reason: "git commit: Unable to create .git/worktrees/wt/index.lock: Operation not permitted", proof: "npm run validate: passed", pr_title: "Validator probe" };
    let fin;
    try {
      fin = finish({ cwd: s.wt, branch: BRANCH, out, run: s.run });
    } catch (e) {
      fin = { ok: false, tag: "THREW", why: e.message };
    }
    if (!fin?.ok) problems.push(`A: a Codex-edited build produced no PR (${fin?.tag}: ${fin?.why}).`);
    else if (!(fin.result.pr_number > 0) || !fin.result.pr_url || fin.result.status !== "ok") problems.push("A: the result is not an ok BUILD carrying pr_url / pr_number.");
    let ahead = 0;
    try { ahead = Number(git(s.wt, "rev-list", "--count", "origin/main..HEAD")); } catch { ahead = 0; }
    if (ahead < 1) problems.push("A: no commit was made on the work branch.");
    let pushed = "";
    try { pushed = git(s.root, "--git-dir", s.origin, "rev-parse", `refs/heads/${BRANCH}`); } catch { pushed = ""; }
    if (!pushed || pushed !== git(s.wt, "rev-parse", "HEAD")) problems.push("A: the work branch was not pushed.");
    if (git(s.root, "--git-dir", s.origin, "log", "--format=%s", "main") !== "init") problems.push("A: origin/main moved — the lane reached main outside ~/bin/land.");
    if (s.gh.some((a) => a.includes("merge"))) problems.push("A: gh was asked to merge.");
    const create = s.gh.find((a) => a[1] === "create");
    if (!create) problems.push("A: no PR was opened.");
    else if (create[create.indexOf("--base") + 1] !== "main") problems.push("A: the PR was not opened against main.");

    writeFileSync(path.join(s.main, "on-main.txt"), "x");
    let onMain;
    try { onMain = finish({ cwd: s.main, branch: "main", out: { phase: "BUILD", status: "ok" }, run: s.run }); } catch { onMain = { ok: false }; }
    if (onMain?.ok) problems.push("B: it committed on main.");
    writeFileSync(path.join(s.wt, "more.txt"), "x");
    let real;
    try { real = finish({ cwd: s.wt, branch: BRANCH, out: { phase: "BUILD", status: "failed", reason: "npm run validate failed" }, run: s.run }); } catch { real = { ok: false }; }
    if (real?.ok) problems.push("B: it committed over Codex's own (non-git) failure.");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
  problems.push(...wiringProblems(duty, finishSource));
  return problems;
}

const realFinish = seat.finishCodexBuild;
const realSource = realFinish.toString();

if (process.argv.includes("--self-test")) {
  const firstTurn = worktreeTurns(DUTY)[0]?.next ?? "";
  const cases = [
    { name: "a finish that never commits", finish: (a) => realFinish({ ...a, run: (c, args, o) => (c === "git" && args[0] === "commit" ? { status: 0, stdout: "", stderr: "" } : a.run(c, args, o)) }), duty: DUTY, finishSource: realSource },
    { name: "a finish that also pushes main and merges", finish: (a) => { const r = realFinish(a); a.run("git", ["push", "-q", "origin", "HEAD:main"], { cwd: a.cwd }); a.run("gh", ["pr", "merge", "9"], { cwd: a.cwd }); return r; }, duty: DUTY, finishSource: realSource },
    { name: "a finish that commits on main", finish: (a) => (a.branch === "main" ? { ok: true, result: {} } : realFinish(a)), duty: DUTY, finishSource: realSource },
    { name: "a finish that commits over a real failure", finish: (a) => realFinish({ ...a, out: a.out && { ...a.out, status: "ok" } }), duty: DUTY, finishSource: realSource },
    { name: "a model turn with no finishIfCodex after it", finish: realFinish, duty: DUTY.replace(firstTurn, "  // removed"), finishSource: realSource },
    { name: "a duty that hands Codex the git dir again", finish: realFinish, duty: `${DUTY}\nconst dirs = gitCommonDirs([cwd], () => null);`, finishSource: realSource },
    { name: "a Codex BUILD prompt without the build note", finish: realFinish, duty: DUTY.replace("if (phase === \"BUILD\") prompt = `${prompt}${CODEX_BUILD_NOTE}`;", ""), finishSource: realSource },
    { name: "a duty with no worktree turns at all", finish: realFinish, duty: DUTY.replace(/await runClaude\(\{/g, "await other({"), finishSource: realSource },
  ];
  let bad = 0;
  for (const c of cases) {
    const p = check(c);
    if (p.length === 0) {
      bad += 1;
      console.error(`SELF-TEST FAILED: ${c.name} was not caught`);
    } else console.log(`caught: ${c.name} — ${p[0]}`);
  }
  if (check({ finish: realFinish, duty: DUTY, finishSource: realSource }).length) {
    bad += 1;
    console.error("SELF-TEST FAILED: the shipped code does not pass");
  }
  if (bad) process.exit(1);
  console.log(`codex-lane self-test: ${cases.length}/${cases.length} breaks caught`);
} else {
  const problems = check({ finish: realFinish, duty: DUTY, finishSource: realSource });
  if (problems.length) {
    for (const p of problems) console.error(`FAIL ${p}`);
    process.exit(1);
  }
  console.log(`codex lane: ${worktreeTurns(DUTY).length} worktree model turns each followed by finishIfCodex; a Codex-edited build becomes a commit, a pushed work branch and a PR; main untouched; landing stays ~/bin/land's`);
}
