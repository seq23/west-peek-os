#!/usr/bin/env node
/**
 * THE LOCAL-JOB CLAIMER — the pair of hands that runs a DUTY on the owner's own Mac (20 Sep 2026, Plan A).
 *
 *   node scripts/claimer/local-job-claimer.mjs            run until killed
 *   node scripts/claimer/local-job-claimer.mjs --once     one cycle, then exit
 *   node scripts/claimer/local-job-claimer.mjs --doctor   check the machine, run nothing
 *   node scripts/claimer/local-job-claimer.mjs --self-test no network, no jobs, pure logic
 *
 * ── WHAT IT IS, AND WHAT IT IS NOT ───────────────────────────────────────────────────────────
 *
 * The subscription-seat claimer beside this file answers QUESTIONS: `claude -p <prompt>`, no
 * tools, a paragraph back. This one runs JOBS: a duty script from `scripts/duties/`, with a git
 * worktree, the repo's validators, `gh`, `curl`, screenshots and `~/bin/land` — the things a
 * Claude Code session did by hand on 20 Sep for the westpeek.ventures package, done by Porter.
 *
 * IT IS THE SAME CLAIM MECHANISM, not a second one. Same heartbeat, same claim, same report
 * routes (0187), same Access service token, same reaper. What is different is one word on the
 * claim — `kinds: ["LOCAL_JOB"]` — so this process is never handed a question and the question
 * claimer is never handed a job (0219). Two launchd labels, two logs, so a hung build can never
 * stall an answer and `launchctl unload` on one never touches the other.
 *
 * ── WHAT THIS PROCESS MAY AND MAY NOT DO ─────────────────────────────────────────────────────
 *
 * It may: say it is awake, take a job the Worker parked, run THE DUTY SCRIPT THIS FILE NAMES for
 * that card kind, keep the Mac awake while it runs, say "still here" every minute, stop the job
 * at its ceiling, and report what the script returned. It may NOT create work, choose a model, a
 * phase or a repo (all on the job the Worker parked), run a script the job names that this file
 * does not (the allowlist below), or decide to land anything — the LAND gate is the Worker's and
 * the duty script's, and both refuse without a recorded approval and a recorded green check.
 *
 * ── THE ALLOWLIST IS THE OTHER HALF OF A REGISTRY ────────────────────────────────────────────
 *
 * `src/shared/work/localJobs.ts` says which card kinds run on the Mac and which script each
 * runs. This file says the same thing from the Mac's side. `validate:duty-executor` holds the
 * two to each other, so a kind added on one side without the other fails the build rather than
 * sitting in a queue nobody claims.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

/**
 * THE DUTY MODULE IS RELOADED WHEN THE REPO MOVES. This claimer is a launchd daemon that lives for
 * days, and ESM caches a module for the life of the process — so on 21 Sep 2026 a claimer started
 * before #149 and #150 landed ran Porter's first real job with the duty code of #144: it blocked
 * Scooter's photo card with "no Drive FOLDER is on the card", a stop that had been deleted from the
 * repo eight hours earlier. A deploy that the Mac never picks up is a deploy that did not happen
 * here. The import URL carries the repo's HEAD, so a new commit is a new DUTY module.
 *
 * THAT WAS NOT ENOUGH, AND THE CLAIMER NOW RESTARTS ITSELF (23 Sep 2026). The per-HEAD URL reloads
 * the duty file only: everything the duty imports keeps its plain URL and stays cached, and this
 * file's own code — the reload itself, the allowlist, the wire — can never be reloaded at all. The
 * proof: a claimer started Mon 21 Sep 17:52, before the per-HEAD reload (#152) and before Drive was
 * mapped (#186), ran today's community job on the 20 Sep duty and began copying the whole Drive
 * folder, a 14.6 GB recording included. So the process remembers the HEAD it started on
 * (`STARTED_HEAD`), and between jobs — only when idle, never mid-job — `restartIfRepoMoved` exits
 * with EXIT_NEW_CODE when HEAD has moved. launchd's `KeepAlive` (true: restart on ANY exit) starts
 * it again on the new code within one ThrottleInterval. `--self-test` pins both halves.
 */
export function repoHead(repoRoot = REPO_ROOT) {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

export function dutyModuleUrl(script, repoRoot = REPO_ROOT) {
  return `${pathToFileURL(path.join(repoRoot, script)).href}?head=${repoHead(repoRoot) ?? "unknown"}`;
}

/** Non-zero, so the log reads as a restart and not a clean stop; KeepAlive restarts on any exit. */
export const EXIT_NEW_CODE = 75;

/** True only when both HEADs are known and differ — a missing git never restarts anything. */
export function headMoved(startedHead, currentHead) {
  return Boolean(startedHead) && Boolean(currentHead) && startedHead !== currentHead;
}

/** Called only when idle. Exits so launchd starts this claimer again on the code now checked out. */
export function restartIfRepoMoved(startedHead, currentHead = repoHead(), exit = process.exit) {
  if (!headMoved(startedHead, currentHead)) return false;
  console.log(`the repo moved from ${String(startedHead).slice(0, 10)} to ${String(currentHead).slice(0, 10)} since this claimer started; exiting ${EXIT_NEW_CODE} so launchd restarts it on the new code`);
  exit(EXIT_NEW_CODE);
  return true;
}

/**
 * THE CHECKOUT KEEPS ITSELF CURRENT (23 Sep 2026). `land` run from a worktree fetches but never
 * moves ~/GitHub/west-peek-os, which is the checkout launchd runs this claimer from — so the HEAD
 * check above never saw new code until someone pulled by hand (confirmed that afternoon: a manual
 * pull, then "repo moved … exiting 75"). So, when idle, the claimer fetches origin/main and, ONLY
 * if its checkout is on main, clean, and a fast-forward behind, runs `git merge --ff-only`; the HEAD
 * check then restarts it on the new code. A dirty or non-main checkout, or one that has diverged, is
 * never touched — it is said once in the log, not every minute. `git` is injectable for the tests.
 */
function runGit(repoRoot, args) {
  try {
    return { ok: true, out: execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).trim() };
  } catch (err) {
    return { ok: false, out: String(err?.stderr ?? err?.message ?? err).trim() };
  }
}

const saidOnce = new Set();
function onceLog(key, line, log) {
  if (saidOnce.has(key)) return;
  saidOnce.add(key);
  log(line);
}

export function pullMainIfClean(repoRoot = REPO_ROOT, git = (args) => runGit(repoRoot, args), log = console.log) {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.ok) return { updated: false, reason: "no_git" };
  if (branch.out !== "main") {
    onceLog(`branch:${branch.out}`, `the checkout at ${repoRoot} is on ${branch.out}, not main; not updating it — new code reaches this claimer only from main`, log);
    return { updated: false, reason: "not_main" };
  }
  const status = git(["status", "--porcelain", "--untracked-files=no"]);
  if (!status.ok || status.out !== "") {
    onceLog("dirty", `the checkout at ${repoRoot} has uncommitted changes; not updating it until it is clean`, log);
    return { updated: false, reason: "dirty" };
  }
  const fetched = git(["fetch", "--quiet", "origin", "main"]);
  if (!fetched.ok) {
    onceLog("fetch", `could not fetch origin main (${fetched.out.split("\n")[0]}); will try again when idle`, log);
    return { updated: false, reason: "fetch_failed" };
  }
  const head = git(["rev-parse", "HEAD"]);
  const remote = git(["rev-parse", "origin/main"]);
  if (!head.ok || !remote.ok) return { updated: false, reason: "no_git" };
  if (head.out === remote.out) return { updated: false, reason: "current" };
  const ff = git(["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
  if (!ff.ok) {
    onceLog(`diverged:${head.out}`, `the checkout at ${repoRoot} has commits origin/main does not; not updating it — a fast-forward is the only move this claimer makes`, log);
    return { updated: false, reason: "diverged" };
  }
  const merged = git(["merge", "--ff-only", "--quiet", "origin/main"]);
  if (!merged.ok) {
    onceLog(`merge:${remote.out}`, `could not fast-forward to ${remote.out.slice(0, 10)} (${merged.out.split("\n")[0]})`, log);
    return { updated: false, reason: "merge_failed" };
  }
  log(`fast-forwarded ${repoRoot} from ${head.out.slice(0, 10)} to ${remote.out.slice(0, 10)}`);
  return { updated: true, reason: "fast_forwarded" };
}

const execFileAsync = promisify(execFile);
const ARGS = new Set(process.argv.slice(2));
const ONCE = ARGS.has("--once");
const DOCTOR = ARGS.has("--doctor");
const SELF_TEST = ARGS.has("--self-test");

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Must match HEARTBEAT_INTERVAL_S in src/worker/ai/subscriptionSeats.ts. */
const HEARTBEAT_INTERVAL_S = 30;
/** Must be well inside JOB_SILENCE_MS (10 min) in src/worker/ai/subscriptionSeats.ts. */
const PROGRESS_INTERVAL_S = 60;
/** The seat this machine runs jobs on. Jobs run Claude Code; Codex is not a job runner here. */
const SEAT = "claude_code";
const RUN_KIND = "LOCAL_JOB";

/**
 * card kind → duty script. THE MAC'S HALF OF THE REGISTRY. A job naming a kind not here, or a
 * script that differs from this, is refused and reported — never run.
 */
export const DUTIES = {
  WEB_PROPERTY_CHANGE: "scripts/duties/web-property-change.mjs",
};

/** Where jobs get their working directory: one per run, under ~/GitHub/wpos-jobs. */
export function jobDirFor(runId) {
  return path.join(homedir(), "GitHub", "wpos-jobs", String(runId).replace(/[^A-Za-z0-9_-]/g, "_"));
}

/** Refuse anything the registry does not name. Pure, so it is self-tested. */
export function dutyFor(job) {
  if (!job || typeof job !== "object") return { ok: false, why: "the run carried no job" };
  const kind = String(job.card_kind ?? "");
  const script = DUTIES[kind];
  if (!script) return { ok: false, why: `this claimer runs no duty for card kind "${kind || "(none)"}"` };
  if (job.script && job.script !== script) return { ok: false, why: `the job names ${job.script} but this claimer runs ${script} for ${kind}` };
  if (!["PLAN", "BUILD", "LAND"].includes(String(job.phase))) return { ok: false, why: `the job names no phase (got "${job.phase}")` };
  if (!["opus", "sonnet", "haiku"].includes(String(job.model))) return { ok: false, why: `the job names no model alias (got "${job.model}")` };
  if (!(Number(job.max_seconds) > 0)) return { ok: false, why: "the job carries no ceiling" };
  return { ok: true, script, kind };
}

// ── The wire ─────────────────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.WP_OS_BASE_URL ?? "https://os.joinwestpeek.com";
const DEVICE_ID = process.env.WP_OS_JOBS_DEVICE_ID ?? `mac-${hostname()}-jobs`;

function accessHeaders() {
  // NEVER CF_ACCESS_CLIENT_ID: that token is the browser agent and answers 403 here (see memory
  // west-peek-os-mac-identity). The Mac's own token, from the vault.
  const id = process.env.WP_OS_MAC_ACCESS_CLIENT_ID;
  const secret = process.env.WP_OS_MAC_ACCESS_CLIENT_SECRET;
  if (!id || !secret) return null;
  return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret, "content-type": "application/json" };
}

async function call(pathname, body) {
  const headers = accessHeaders();
  if (!headers) throw new Error("WP_OS_MAC_ACCESS_CLIENT_ID / WP_OS_MAC_ACCESS_CLIENT_SECRET are not in the environment");
  const res = await fetch(`${BASE_URL}${pathname}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON: reported by status */
  }
  return { status: res.status, body: parsed, raw: text.slice(0, 400) };
}

// ── Running one job ──────────────────────────────────────────────────────────────────────────

/** Keep the Mac awake for the job. Killed when the job ends, whatever way it ends. */
function keepAwake() {
  try {
    const c = spawn("caffeinate", ["-dimsu"], { stdio: "ignore" });
    return () => {
      try {
        c.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    };
  } catch {
    return () => {};
  }
}

async function runJob(run) {
  const job = run.job;
  const duty = dutyFor(job);
  if (!duty.ok) return { ok: false, error: duty.why };

  const jobDir = jobDirFor(run.id);
  mkdirSync(jobDir, { recursive: true });
  const controller = new AbortController();
  const ceilingMs = Math.round(Number(job.max_seconds) * 1000);
  const stopAwake = keepAwake();

  // STILL HERE, every minute. A rejected ping means the run was taken from us: stop the job.
  let lastNote = `${job.phase} started`;
  const pulse = setInterval(async () => {
    try {
      const r = await call("/api/subscription-seats/progress", { device_id: DEVICE_ID, run_id: run.id, note: lastNote });
      if (r.status === 409) {
        console.error(`run ${run.id} is no longer ours (${r.body?.detail ?? r.status}); stopping the job`);
        controller.abort(new Error("the run was returned to the pool or closed while this machine held it"));
      }
    } catch (err) {
      console.error(`progress ping failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, PROGRESS_INTERVAL_S * 1000);

  const timer = setTimeout(() => controller.abort(new Error(`the ${job.phase} phase did not finish within ${Math.round(ceilingMs / 1000)}s and was stopped`)), ceilingMs);

  try {
    const mod = await import(dutyModuleUrl(duty.script));
    if (typeof mod.run !== "function") return { ok: false, error: `${duty.script} exports no run()` };
    const report = await mod.run(job, {
      repoRoot: REPO_ROOT,
      jobDir,
      signal: controller.signal,
      progress: (note) => {
        lastNote = String(note ?? "").slice(0, 400);
        console.log(`[${run.id}] ${lastNote}`);
      },
      env: process.env,
    });
    if (!report || typeof report !== "object" || !report.phase || !report.status) {
      return { ok: false, error: `${duty.script} returned no report for ${job.phase} — a phase that says nothing has not run (Rule 0)` };
    }
    return { ok: true, output: JSON.stringify(report) };
  } catch (err) {
    const why = controller.signal.aborted ? (controller.signal.reason?.message ?? "stopped") : err instanceof Error ? err.message : String(err);
    return { ok: false, error: `${job.phase} on ${job.target_repo ?? "the repo"}: ${why}`.slice(0, 1900) };
  } finally {
    clearTimeout(timer);
    clearInterval(pulse);
    stopAwake();
  }
}

async function cycle() {
  await call("/api/subscription-seats/heartbeat", {
    device_id: DEVICE_ID,
    hostname: hostname(),
    agent_version: "jobs-1",
    seats: [SEAT],
    capabilities: ["local_job", ...Object.keys(DUTIES).map((k) => k.toLowerCase())],
  });
  const claimed = await call("/api/subscription-seats/claim", { device_id: DEVICE_ID, seats: [SEAT], kinds: [RUN_KIND] });
  const run = claimed.body?.run;
  if (!run) return { worked: false };
  if (run.run_kind !== RUN_KIND) {
    await call("/api/subscription-seats/report", { device_id: DEVICE_ID, run_id: run.id, error: `this claimer runs ${RUN_KIND} only and was handed ${run.run_kind}` });
    return { worked: true };
  }
  console.log(`claimed ${run.id}: ${run.purpose}`);
  const result = await runJob(run);
  const reported = await call("/api/subscription-seats/report", {
    device_id: DEVICE_ID,
    run_id: run.id,
    ...(result.ok ? { output_text: result.output } : { error: result.error }),
  });
  console.log(`reported ${run.id}: ${result.ok ? "ok" : `FAILED — ${result.error}`} (${reported.status} ${reported.body?.detail ?? ""})`);
  return { worked: true };
}

async function toolPresent(bin) {
  try {
    await execFileAsync("/bin/sh", ["-c", `command -v ${bin}`]);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (SELF_TEST) return selfTest();
  const tools = { claude: await toolPresent("claude"), gh: await toolPresent("gh"), git: await toolPresent("git"), caffeinate: await toolPresent("caffeinate"), land: existsSync(path.join(homedir(), "bin", "land")) };
  const missing = Object.entries(tools).filter(([, ok]) => !ok).map(([k]) => k);
  const service = Boolean(process.env.GSC_SERVICE_ACCOUNT_JSON);
  if (DOCTOR) {
    console.log(`device: ${DEVICE_ID}`);
    console.log(`base url: ${BASE_URL}`);
    console.log(`access token in environment: ${accessHeaders() ? "yes" : "NO — the claimer cannot authenticate"}`);
    console.log(`drive service account in environment: ${service ? "yes" : "NO — the PLAN phase cannot pull a folder"}`);
    console.log(`tools: ${Object.entries(tools).map(([k, ok]) => `${k}=${ok ? "ok" : "MISSING"}`).join(" ")}`);
    console.log(`duties: ${Object.entries(DUTIES).map(([k, s]) => `${k} → ${s}${existsSync(path.join(REPO_ROOT, s)) ? "" : " (MISSING)"}`).join(", ")}`);
    process.exit(missing.length === 0 && accessHeaders() && service ? 0 : 1);
  }
  if (missing.length > 0) {
    // Absence is a clean exit, like the seat claimer: the Worker never hears a heartbeat and the
    // card says the lane is away. A launchd KeepAlive with ThrottleInterval makes this one quiet
    // line every five minutes rather than a spin.
    console.log(`This machine cannot run jobs: missing ${missing.join(", ")}. Exiting quietly.`);
    return;
  }
  const STARTED_HEAD = repoHead();
  console.log(`claiming ${RUN_KIND} runs as ${DEVICE_ID} on ${STARTED_HEAD ?? "an unknown HEAD"}`);
  for (;;) {
    let worked = false;
    try {
      ({ worked } = await cycle());
    } catch (err) {
      console.error(`cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (ONCE) return;
    // IDLE: nothing is running, so this is the one safe moment to pick up new code.
    if (!worked) {
      pullMainIfClean();
      restartIfRepoMoved(STARTED_HEAD);
      await new Promise((r) => setTimeout(r, HEARTBEAT_INTERVAL_S * 1000));
    }
  }
}

function selfTest() {
  const good = { card_kind: "WEB_PROPERTY_CHANGE", script: DUTIES.WEB_PROPERTY_CHANGE, phase: "PLAN", model: "opus", max_seconds: 600 };
  const cases = [
    ["the duty module URL carries the repo's HEAD, so a landed change is a fresh load", () => {
      const u = dutyModuleUrl("scripts/duties/web-property-change.mjs");
      return /\?head=[0-9a-f]{40}$/.test(u) && u.includes("scripts/duties/web-property-change.mjs");
    }],
    ["a repo with no git still yields a loadable URL", () => dutyModuleUrl("scripts/duties/web-property-change.mjs", "/nonexistent-repo").endsWith("?head=unknown")],
    ["a moved HEAD restarts the claimer with a non-zero exit; the same HEAD, or an unknown one, never does", () => {
      const exits = [];
      const exit = (code) => exits.push(code);
      const a = "a".repeat(40), b = "b".repeat(40);
      return restartIfRepoMoved(a, b, exit) === true && exits[0] === EXIT_NEW_CODE && EXIT_NEW_CODE !== 0 &&
        restartIfRepoMoved(a, a, exit) === false && restartIfRepoMoved(null, b, exit) === false && restartIfRepoMoved(a, null, exit) === false && exits.length === 1;
    }],
    ["the idle branch of the loop — and only it — checks for new code, against the HEAD recorded at start", () => {
      const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
      const loop = src.slice(src.indexOf("const STARTED_HEAD = repoHead();"), src.indexOf("function selfTest("));
      // The pull comes first, so a fast-forward in this idle moment is seen by the HEAD check right after it.
      return /const STARTED_HEAD = repoHead\(\);/.test(loop) && /if \(!worked\) \{\s*pullMainIfClean\(\);\s*restartIfRepoMoved\(STARTED_HEAD\);/.test(loop) && (loop.match(/restartIfRepoMoved\(/g) ?? []).length === 1 && (loop.match(/pullMainIfClean\(/g) ?? []).length === 1;
    }],
    ["idle self-update: only a clean main that is a fast-forward behind is merged; anything else is left alone and said once", () => {
      const fake = (state) => (args) => {
        const k = args.join(" ");
        if (k === "rev-parse --abbrev-ref HEAD") return { ok: true, out: state.branch };
        if (k.startsWith("status")) return { ok: true, out: state.dirty ? " M x" : "" };
        if (k.startsWith("fetch")) return { ok: true, out: "" };
        if (k === "rev-parse HEAD") return { ok: true, out: state.head };
        if (k === "rev-parse origin/main") return { ok: true, out: state.remote };
        if (k.startsWith("merge-base")) return { ok: state.ff, out: "" };
        if (k.startsWith("merge --ff-only")) { state.merged = true; return { ok: true, out: "" }; }
        return { ok: false, out: k };
      };
      const lines = [];
      const log = (l) => lines.push(l);
      const clean = { branch: "main", dirty: false, head: "a", remote: "b", ff: true };
      const dirty = { branch: "main", dirty: true, head: "a", remote: "b", ff: true };
      const other = { branch: "fix/x", dirty: false, head: "a", remote: "b", ff: true };
      const diverged = { branch: "main", dirty: false, head: "a", remote: "b", ff: false };
      const ok = pullMainIfClean("/r", fake(clean), log).updated === true && clean.merged === true;
      const leftAlone = [dirty, other, diverged].every((st) => pullMainIfClean("/r", fake(st), log).updated === false && !st.merged);
      const before = lines.length;
      pullMainIfClean("/r", fake(dirty), log);
      return ok && leftAlone && lines.length === before;
    }],
    ["launchd restarts the claimer on ANY exit (KeepAlive true), so a restart-for-new-code really restarts", () => {
      const plist = readFileSync(path.join(REPO_ROOT, "deployment", "launchd", "ventures.westpeek.os.local-jobs.plist"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
      return /<key>KeepAlive<\/key>\s*<true\/>/.test(plist) && /local-job-claimer\.mjs/.test(plist);
    }],
    ["a registered kind with its own script is accepted", () => dutyFor(good).ok === true],
    ["a kind this claimer does not run is refused", () => dutyFor({ ...good, card_kind: "ROOM_PACKET" }).ok === false],
    ["a job naming a different script is refused", () => dutyFor({ ...good, script: "scripts/duties/other.mjs" }).ok === false],
    ["a job with no phase is refused", () => dutyFor({ ...good, phase: "SHIP" }).ok === false],
    ["a job with no model alias is refused", () => dutyFor({ ...good, model: "gpt-9" }).ok === false],
    ["a job with no ceiling is refused", () => dutyFor({ ...good, max_seconds: 0 }).ok === false],
    ["no job at all is refused", () => dutyFor(null).ok === false],
    ["a job dir cannot escape ~/GitHub/wpos-jobs", () => !jobDirFor("../../etc").includes("..")],
    ["every duty script named here exists", () => Object.values(DUTIES).every((s) => existsSync(path.join(REPO_ROOT, s)))],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try {
      ok = fn() === true;
    } catch {
      ok = false;
    }
    console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
    if (!ok) failed += 1;
  }
  if (cases.length === 0 || failed > 0) {
    console.error(`SELF-TEST FAILED: ${failed} of ${cases.length}`);
    process.exit(1);
  }
  console.log(`SELF-TEST PASSED: ${cases.length} cases`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
