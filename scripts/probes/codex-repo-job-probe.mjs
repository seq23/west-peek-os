#!/usr/bin/env node
/**
 * THE FIRST SUPERVISED CODEX REPO JOB — a probe for the owner's Mac (1 Oct 2026).
 *
 *   node scripts/probes/codex-repo-job-probe.mjs                      throwaway repo, local remote
 *   node scripts/probes/codex-repo-job-probe.mjs --remote <git-url>   also test a READ of a real remote
 *   node scripts/probes/codex-repo-job-probe.mjs --keep               keep the temp directory to inspect
 *   node scripts/probes/codex-repo-job-probe.mjs --self-test          no CLIs, no network
 *
 * WHY. Repo work on cards falls from Claude Code to Codex when Claude Code's plan is spent (#213). That
 * path has never run for real. The ledger names four unknowns, and a person should watch the first one
 * rather than find out from a half-built branch at 2am:
 *
 *   1. does the installed Codex accept the flag set the fallback uses (`--sandbox`, `--add-dir`, …)?
 *   2. can it EDIT in a linked worktree?
 *   3. can it COMMIT — i.e. write into the ORIGINAL repo's `.git/worktrees/…` (some versions protect .git)?
 *   4. can it PUSH, and does the network work inside the sandbox?
 *
 * HOW IT JUDGES. The script verifies each outcome ITSELF, from git, never from what the model says:
 * the file is on disk, the commit is in the worktree's log, the commit arrived in the local bare remote.
 * The optional --remote check asks Codex to run `git ls-remote <url> HEAD` inside the sandbox and write
 * the result to a file, then compares it with the same read done outside the sandbox: equal hashes mean
 * the sandbox's network and credentials really worked.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never pushes to a real remote, never touches your repositories
 * (everything is under a temporary directory; --remote is read-only), and does not test `gh` or GitHub
 * pull-request creation — an authenticated push to GitHub is the one thing it cannot prove safely, so a
 * PROVEN here still leaves that to the first real, supervised job. Nothing here changes the repo.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { codexExecArgs, codexSeatUsable, gitCommonDirs, helpMentions } from "../lib/codex-seat.mjs";
import { detectUsageLimit } from "../lib/seat-usage-limit.mjs";
import { claudeChildEnv } from "../lib/vault-env.mjs";

const execFileAsync = promisify(execFile);
const RUN_TIMEOUT_MS = 300_000;
export const COMMIT_SUBJECT = "probe: codex commit";

// ── Pure parts ───────────────────────────────────────────────────────────────────────────────

/** The instruction Codex is given. Every step is something the script then verifies independently. */
export function probePrompt({ branch, remoteUrl }) {
  return [
    "This is a connectivity probe, not real work. Do exactly these steps in the current directory, in order, and nothing else.",
    "1. Create a file named PROBE.txt whose entire content is the single line: codex-probe",
    `2. Run: git add PROBE.txt && git commit -m "${COMMIT_SUBJECT}"`,
    `3. Run: git push origin HEAD:refs/heads/${branch}`,
    ...(remoteUrl ? [`4. Run: git ls-remote ${remoteUrl} HEAD > LSREMOTE.txt   (write its output to that file; do not commit it)`] : []),
    "When done, reply with the word DONE. If any step fails, reply with the failing command and its error.",
  ].join("\n");
}

/** A `git ls-remote … HEAD` line is a 40-hex hash, whitespace, then HEAD. Returns the hash or null. */
export function lsRemoteHash(text) {
  const m = /^([0-9a-f]{40})\s+HEAD\s*$/m.exec(String(text ?? ""));
  return m ? m[1] : null;
}

/** One verdict per question. `evidence` says what the script itself observed. */
export function verdicts(o) {
  const rows = [];
  rows.push({ q: "the installed Codex supports the flags the fallback uses", status: o.lacks ? "FAILED" : "PROVEN", evidence: o.lacks ? `codex exec --help does not mention ${o.lacks}` : "--sandbox and --add-dir are both documented by the installed binary" });
  if (o.untested) {
    rows.push({ q: "(everything below)", status: "UNTESTED", evidence: o.untested });
    return rows;
  }
  rows.push({ q: "Codex can EDIT a file in a linked worktree", status: o.fileText?.trim() === "codex-probe" ? "PROVEN" : "FAILED", evidence: o.fileText == null ? "PROBE.txt does not exist in the worktree" : `PROBE.txt contains: ${JSON.stringify(o.fileText.trim().slice(0, 60))}` });
  rows.push({ q: "Codex can COMMIT (write into the original repo's .git/worktrees/…)", status: o.commitSubject === COMMIT_SUBJECT ? "PROVEN" : "FAILED", evidence: o.commitSubject ? `worktree's latest commit: ${JSON.stringify(o.commitSubject)}` : "no probe commit in the worktree's log" });
  rows.push({ q: "Codex can PUSH (to a local bare remote)", status: o.remoteHasCommit ? "PROVEN" : "FAILED", evidence: o.remoteHasCommit ? "the commit arrived in the local remote" : "the commit never reached the local remote" });
  if (o.remoteChecked) {
    const same = o.sandboxHash && o.sandboxHash === o.outsideHash;
    rows.push({ q: "the sandbox's network and credentials can READ the real remote", status: same ? "PROVEN" : "FAILED", evidence: same ? `inside and outside the sandbox both saw ${o.outsideHash.slice(0, 10)}…` : `inside: ${o.sandboxHash ?? "nothing"}; outside: ${o.outsideHash ?? "nothing"}` });
  }
  return rows;
}

// ── The run ──────────────────────────────────────────────────────────────────────────────────

async function git(cwd, args) {
  const r = await execFileAsync("git", ["-C", cwd, ...args], { timeout: 60_000 });
  return String(r.stdout).trim();
}

async function gitCommonDirOf(dir) {
  try {
    return String((await execFileAsync("git", ["-C", dir, "rev-parse", "--git-common-dir"], { timeout: 15_000 })).stdout).trim() || null;
  } catch {
    return null;
  }
}

function spawnCodex({ bin, args, cwd, prompt }) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: claudeChildEnv(process.env) });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      resolve({ timedOut: true, out, err });
    }, RUN_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, out, err: `${err}${e.message}` }); } });
    child.on("close", (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out, err }); } });
    child.stdin.end(prompt);
  });
}

/**
 * Run the probe. Everything environmental is a parameter so the test can drive it with a fake `codex`.
 * @returns {Promise<{ rows: Array<{q:string,status:string,evidence:string}>, dir: string }>}
 */
export async function runProbe({ codexBin = "codex", home = homedir(), remoteUrl = null, keep = false } = {}) {
  const seat = codexSeatUsable(home);
  let help = "";
  try {
    const r = await execFileAsync(codexBin, ["exec", "--help"], { maxBuffer: 4 * 1024 * 1024, timeout: 20_000 });
    help = `${r.stdout}\n${r.stderr}`;
  } catch (e) {
    help = `${e?.stdout ?? ""}\n${e?.stderr ?? ""}`;
  }
  const lacks = !help.trim() ? "`codex exec` (the codex command could not be run)" : ["--sandbox", "--add-dir"].find((f) => !helpMentions(help, f)) ?? null;
  const dir = mkdtempSync(path.join(tmpdir(), "wp-codex-repo-probe-"));
  try {
    if (!seat.ok) return { rows: verdicts({ lacks, untested: `the Codex seat is not usable here: ${seat.why}` }), dir };
    if (lacks) return { rows: verdicts({ lacks, untested: "the flag check failed, so no run was attempted" }), dir };

    // A bare "remote", an "original" repository cloned from it, and a LINKED worktree — the shape a real job has.
    const bare = path.join(dir, "origin.git");
    const repo = path.join(dir, "repo");
    const wt = path.join(dir, "wt");
    mkdirSync(bare);
    await execFileAsync("git", ["init", "--bare", "-q", "-b", "main", bare]);
    await execFileAsync("git", ["clone", "-q", bare, repo]);
    await git(repo, ["config", "user.email", "probe@example.invalid"]);
    await git(repo, ["config", "user.name", "probe"]);
    writeFileSync(path.join(repo, "README.md"), "probe\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-q", "-m", "init"]);
    await git(repo, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    const branch = "probe-branch";
    await git(repo, ["worktree", "add", "-q", "-b", branch, wt]);

    // Exactly what the fallback does: the worktree's git common dir is named as a writable folder.
    const dirs = [wt];
    const found = await Promise.all(dirs.map((d) => gitCommonDirOf(d)));
    const writable = gitCommonDirs(dirs, (d) => found[dirs.indexOf(d)]);
    const args = codexExecArgs(writable);
    const run = await spawnCodex({ bin: codexBin, args, cwd: wt, prompt: probePrompt({ branch, remoteUrl }) });
    const limit = detectUsageLimit({ stdout: run.out, stderr: run.err });
    if (limit.limited) return { rows: verdicts({ lacks, untested: `the plan is out of usage: ${limit.snippet}` }), dir };
    if (run.timedOut) return { rows: verdicts({ lacks, untested: "Codex did not finish within the time limit, so nothing is concluded" }), dir };

    // THE SCRIPT LOOKS; THE MODEL IS NOT BELIEVED.
    const fileText = existsSync(path.join(wt, "PROBE.txt")) ? readFileSync(path.join(wt, "PROBE.txt"), "utf8") : null;
    let commitSubject = null;
    try { commitSubject = await git(wt, ["log", "-1", "--format=%s"]); } catch { /* none */ }
    let remoteHasCommit = false;
    try { remoteHasCommit = (await git(bare, ["log", "--format=%s", branch])).split("\n").includes(COMMIT_SUBJECT); } catch { /* the branch never arrived */ }
    let sandboxHash = null;
    let outsideHash = null;
    if (remoteUrl) {
      const lsFile = path.join(wt, "LSREMOTE.txt");
      sandboxHash = existsSync(lsFile) ? lsRemoteHash(readFileSync(lsFile, "utf8")) : null;
      try { outsideHash = lsRemoteHash(String((await execFileAsync("git", ["ls-remote", remoteUrl, "HEAD"], { timeout: 60_000 })).stdout)); } catch { outsideHash = null; }
    }
    return { rows: verdicts({ lacks, fileText, commitSubject, remoteHasCommit, remoteChecked: Boolean(remoteUrl), sandboxHash, outsideHash }), dir };
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

function selfTest() {
  const all = (o) => verdicts(o);
  const proven = all({ lacks: null, fileText: "codex-probe\n", commitSubject: COMMIT_SUBJECT, remoteHasCommit: true });
  const cases = [
    ["everything observed means everything PROVEN", () => proven.every((r) => r.status === "PROVEN") && proven.length === 4],
    ["a commit that never happened is FAILED even if the file exists", () => all({ lacks: null, fileText: "codex-probe", commitSubject: "init", remoteHasCommit: false }).filter((r) => r.status === "FAILED").length === 2],
    ["a missing flag is FAILED and stops the rest", () => { const r = all({ lacks: "--add-dir", untested: "x" }); return r[0].status === "FAILED" && r[1].status === "UNTESTED"; }],
    ["a model that claims it read the remote is not believed unless the hashes match", () => { const h = "a".repeat(40); const r = all({ lacks: null, fileText: "codex-probe", commitSubject: COMMIT_SUBJECT, remoteHasCommit: true, remoteChecked: true, sandboxHash: "b".repeat(40), outsideHash: h }); return r.at(-1).status === "FAILED"; }],
    ["matching hashes inside and outside the sandbox are PROVEN", () => { const h = "a".repeat(40); const r = all({ lacks: null, fileText: "codex-probe", commitSubject: COMMIT_SUBJECT, remoteHasCommit: true, remoteChecked: true, sandboxHash: h, outsideHash: h }); return r.at(-1).status === "PROVEN"; }],
    ["lsRemoteHash reads a real ls-remote line and refuses anything else", () => lsRemoteHash(`${"c".repeat(40)}\tHEAD\n`) === "c".repeat(40) && lsRemoteHash("fatal: could not read Username") === null],
    ["the prompt asks for the ls-remote step only when a remote was given", () => !probePrompt({ branch: "b", remoteUrl: null }).includes("ls-remote") && probePrompt({ branch: "b", remoteUrl: "https://x/y.git" }).includes("ls-remote https://x/y.git HEAD")],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try { ok = fn() === true; } catch { ok = false; }
    console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
    if (!ok) failed += 1;
  }
  if (failed > 0) { console.error(`SELF-TEST FAILED: ${failed} of ${cases.length}`); process.exit(1); }
  console.log(`SELF-TEST PASSED: ${cases.length} cases`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) selfTest();
  else {
    const remote = process.argv.includes("--remote") ? process.argv[process.argv.indexOf("--remote") + 1] : null;
    runProbe({ remoteUrl: remote, keep: process.argv.includes("--keep") })
      .then(({ rows, dir }) => {
        for (const r of rows) console.log(`${r.status.padEnd(8)} ${r.q}\n         ${r.evidence}`);
        const bad = rows.filter((r) => r.status !== "PROVEN").length;
        console.log(`\n${rows.length - bad} of ${rows.length} PROVEN.${process.argv.includes("--keep") ? ` Kept: ${dir}` : ""}`);
        console.log("Not tested here: an authenticated push to GitHub and pull-request creation. Watch the first real Codex-served job.");
        process.exit(bad === 0 ? 0 : 1);
      })
      .catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
  }
}
