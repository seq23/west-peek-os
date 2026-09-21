#!/usr/bin/env node
/**
 * web-property-change.mjs — the DUTY SCRIPT for card kind: WEB_PROPERTY_CHANGE (20 Sep 2026, Plan A).
 *
 *   imported by scripts/claimer/local-job-claimer.mjs: `run(job, ctx)` → a report
 *   node scripts/duties/web-property-change.mjs --self-test    no network, no repo, the pure parts
 *
 * ── WHAT IT DOES, PHASE BY PHASE ─────────────────────────────────────────────────────────────
 *
 *   PLAN   worktree of the target repo off origin/main · BLOCK if RUNBOOK.md is absent · pull the
 *          Drive folder with the service account (BLOCK naming the folder on zero files) · one
 *          `claude -p` (the plan model) with the prompt file and the job context · read the
 *          result file · report the plan document, DECIDED and ASK.
 *   BUILD  same worktree · `claude -p` (the build model) · then THE SCRIPT, not the model, asks
 *          `gh` for the PR and watches `gh pr checks` to a terminal state · reports GREEN/RED/
 *          PENDING as observed. "Never take an agent's word that CI is green."
 *   LAND   REFUSED unless the job carries a recorded plan approval AND a recorded green check
 *          (`landGate` below; `validate:no-land-without-approval` reads it) · `~/bin/land <pr>`
 *          merges, watches main, deploys · the merge SHA from `gh` · `claude -p` (the land model)
 *          curls the live pages and writes the proof · the worktree is removed.
 *
 * ── WHAT THE MODEL NEVER DECIDES ─────────────────────────────────────────────────────────────
 *
 * The model, the phase, the repo, the worktree path, the ceiling and the result path are all on
 * the job the Worker parked. The model may not land (the script does, behind the gate), may not
 * report a check state (the script observes it), and may not report success without writing the
 * result file (Rule 0: a phase that says nothing has not run).
 *
 * ── SELF-CONTAINED, ON PURPOSE ───────────────────────────────────────────────────────────────
 *
 * No import from src/. The Worker's registry (src/shared/work/localJobs.ts) and this file agree
 * because `validate:duty-executor` holds them to each other, not because one imports the other:
 * a script on her Mac that pulled in the Worker's TypeScript would need a build step to run.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROMPT_FILE = path.join(REPO_ROOT, "scripts", "duties", "web-property-change-prompt.md");
const PULL_SCRIPT = path.join(REPO_ROOT, "scripts", "drive", "pull.mjs");

/** How long the BUILD phase watches the PR's checks before reporting PENDING. */
const CHECK_WATCH_MS = 25 * 60_000;
const CHECK_POLL_MS = 30_000;

// ── Pure parts (self-tested) ─────────────────────────────────────────────────────────────────

/** The branch and worktree for a card. Stable across phases so BUILD resumes what PLAN made. */
export function namesFor(cardId) {
  const short = String(cardId).replace(/^wc_/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toLowerCase() || "card";
  return {
    branch: `work/wpc-${short}`,
    worktree: path.join(homedir(), "GitHub", "wpos-jobs", `wt-${short}`),
  };
}

/**
 * THE LAND GATE. Both facts, recorded on the row by earlier phases and carried on the job:
 * the plan's approval time and the PR's green time. Anything else is refused with the reason.
 * `validate:no-land-without-approval` reads this function's text and requires both checks.
 */
export function landGate(job) {
  if (!job?.plan?.approved_at) return { ok: false, why: "the plan has not been approved by the partner who asked — nothing lands" };
  if (!job?.pr?.url) return { ok: false, why: "there is no PR to land" };
  if (!job?.pr?.check_green_at || job.pr.check_state !== "GREEN") return { ok: false, why: "the PR has no recorded green check — nothing lands" };
  return { ok: true, why: "approved and green" };
}

/** Read a result file strictly. Null with a reason when the phase said nothing usable. */
export function readResult(text, phase) {
  if (!text || !text.trim()) return { result: null, problem: "the phase wrote no result file" };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { result: null, problem: "the result file is not JSON" };
  }
  if (!parsed || typeof parsed !== "object") return { result: null, problem: "the result file is not an object" };
  if (parsed.phase !== phase) return { result: null, problem: `the result names phase "${parsed.phase}", expected ${phase}` };
  if (!["ok", "blocked", "failed"].includes(parsed.status)) return { result: null, problem: `the result has no status (got "${parsed.status}")` };
  if (parsed.status !== "ok" && !(typeof parsed.reason === "string" && parsed.reason.trim())) return { result: null, problem: `a ${parsed.status} result must say why` };
  if (parsed.status === "ok" && phase === "PLAN" && !(typeof parsed.document === "string" && parsed.document.trim().length > 40)) return { result: null, problem: "an ok PLAN must carry a plan document" };
  if (parsed.status === "ok" && phase === "BUILD" && !(typeof parsed.pr_url === "string" && /^https?:\/\//.test(parsed.pr_url))) return { result: null, problem: "an ok BUILD must carry the PR url" };
  if (parsed.status === "ok" && phase === "LAND" && !(typeof parsed.live_proof === "string" && parsed.live_proof.trim())) return { result: null, problem: "an ok LAND must carry the live proof" };
  return { result: parsed, problem: null };
}

/** GREEN when every check passed, RED when any failed, PENDING otherwise. From `gh pr checks --json`. */
export function checkStateOf(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return "PENDING";
  const states = checks.map((c) => String(c.state ?? c.conclusion ?? "").toUpperCase());
  if (states.some((s) => ["FAILURE", "FAILED", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(s))) return "RED";
  if (states.every((s) => ["SUCCESS", "PASS", "PASSED", "NEUTRAL", "SKIPPED", "SKIPPING"].includes(s))) return "GREEN";
  return "PENDING";
}

/** The job context block handed to the model under the prompt file. */
export function renderContext(job, paths) {
  const lines = [
    "",
    "## JOB CONTEXT (from West Peek OS — do not edit these facts)",
    "",
    `PHASE: ${job.phase}`,
    `CARD: ${job.card?.id} — ${job.card?.title}`,
    `ASKED BY: ${job.card?.requested_by ?? "a Managing Partner"}`,
    `PROPERTY: ${job.property_host ?? "(see ask)"}`,
    `TARGET_REPO: ${job.target_repo}`,
    `WORKTREE: ${paths.worktree}`,
    `BRANCH: ${paths.branch}`,
    `PACKAGE_DIR: ${paths.packageDir}`,
    `JOB_DIR: ${paths.jobDir}`,
    `RESULT_PATH: ${paths.resultPath}`,
    `DRIVE_FOLDER: ${job.drive?.folder_url ?? job.drive?.folder_id ?? "(none)"}`,
    "",
    "STANDING RULES OF THIS KIND:",
    ...Object.entries(job.rules ?? {}).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "THE PARTNER'S ASK, verbatim:",
    "```",
    String(job.ask ?? "").trim(),
    "```",
  ];
  if (job.plan) {
    lines.push("", "THE PLAN (already filed as a Document on the card):", "");
    if (paths.planText) lines.push("```markdown", paths.planText, "```");
    lines.push("", `DECIDED: ${JSON.stringify(job.plan.decided ?? [])}`, `ASKED: ${JSON.stringify(job.plan.asks ?? [])}`);
    lines.push(`THE PARTNER'S ANSWERS (these win over the plan): ${JSON.stringify(job.plan.answers ?? [])}`);
    lines.push(`PLAN APPROVED AT: ${job.plan.approved_at ?? "(not yet)"}`);
  }
  if (job.pr) {
    lines.push("", `PR: ${job.pr.url} (#${job.pr.number ?? "?"}) on ${job.pr.branch ?? paths.branch} — checks ${job.pr.check_state ?? "unknown"}${job.pr.check_green_at ? ` (green at ${job.pr.check_green_at})` : ""}`);
  }
  if (paths.landOutput) lines.push("", "WHAT ~/bin/land PRINTED:", "```", paths.landOutput.slice(-6000), "```", `MERGE SHA: ${paths.mergeSha ?? "(unknown)"}`);
  return lines.join("\n");
}

// ── Shell ─────────────────────────────────────────────────────────────────────────────────────

async function sh(cmd, args, opts = {}) {
  const { stdout, stderr } = await execFileAsync(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts });
  return { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
}

async function git(cwd, ...args) {
  return sh("git", args, { cwd });
}

/** Run `claude -p` in the worktree with the prompt, killable by the job's signal. */
function runClaude({ prompt, model, cwd, addDirs, signal, onLine }) {
  return new Promise((resolve) => {
    const args = [
      "-p",
      "--model", model,
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Bash,Read,Edit,Write,Glob,Grep,WebFetch",
      "--output-format", "json",
      ...addDirs.flatMap((d) => ["--add-dir", d]),
    ];
    const child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += String(d);
      onLine?.(`claude: ${out.length} bytes`);
    });
    child.stderr.on("data", (d) => (err += String(d)));
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => resolve({ code: -1, out, err: `${err}\n${e.message}` }));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, out, err });
    });
    child.stdin.end(prompt);
  });
}

function costFrom(claudeJsonOut) {
  try {
    const j = JSON.parse(claudeJsonOut);
    return typeof j.total_cost_usd === "number" ? j.total_cost_usd : null;
  } catch {
    return null;
  }
}

async function ensureWorktree(repoPath, names, phase, progress) {
  await git(repoPath, "fetch", "origin", "--prune", "-q");
  if (!existsSync(names.worktree)) {
    mkdirSync(path.dirname(names.worktree), { recursive: true });
    const remote = await git(repoPath, "ls-remote", "--heads", "origin", names.branch);
    if (remote.stdout.trim()) {
      await git(repoPath, "worktree", "add", names.worktree, "-B", names.branch, `origin/${names.branch}`);
    } else {
      await git(repoPath, "worktree", "add", names.worktree, "-b", names.branch, "origin/main");
    }
    progress(`worktree ${names.worktree} on ${names.branch}`);
  } else if (phase !== "PLAN") {
    // Resume: the branch may have moved (a previous BUILD pushed). Take what origin has.
    await git(names.worktree, "checkout", "-q", names.branch).catch(() => {});
    await git(names.worktree, "pull", "--ff-only", "-q", "origin", names.branch).catch(() => {});
  }
  const nm = path.join(repoPath, "node_modules");
  const wtNm = path.join(names.worktree, "node_modules");
  if (existsSync(nm) && !existsSync(wtNm)) {
    try {
      symlinkSync(nm, wtNm, "dir");
    } catch {
      /* the model can npm ci if it needs to */
    }
  }
}

async function prFor(worktree, branch) {
  const { stdout } = await sh("gh", ["pr", "view", branch, "--json", "url,number,state,headRefName"], { cwd: worktree });
  return JSON.parse(stdout);
}

async function watchChecks(worktree, number, signal, progress) {
  const started = Date.now();
  let last = { state: "PENDING", url: null };
  while (Date.now() - started < CHECK_WATCH_MS && !signal?.aborted) {
    try {
      const { stdout } = await sh("gh", ["pr", "checks", String(number), "--json", "name,state,link"], { cwd: worktree });
      const checks = JSON.parse(stdout);
      last = { state: checkStateOf(checks), url: checks.find((c) => c.link)?.link ?? null };
    } catch (err) {
      // `gh pr checks` exits 8 while checks are pending and 1 when some fail, still printing JSON.
      const text = String(err?.stdout ?? "");
      try {
        const checks = JSON.parse(text);
        last = { state: checkStateOf(checks), url: checks.find((c) => c.link)?.link ?? null };
      } catch {
        last = { state: "PENDING", url: null };
      }
    }
    progress(`checks on #${number}: ${last.state}`);
    if (last.state !== "PENDING") return last;
    await new Promise((r) => setTimeout(r, CHECK_POLL_MS));
  }
  return last;
}

// ── The duty ─────────────────────────────────────────────────────────────────────────────────

/**
 * Run one phase. Always returns a report object; never throws for a job-level failure (the
 * claimer reports what comes back). Throws only when the job itself is malformed.
 */
export async function run(job, ctx) {
  const progress = ctx.progress ?? (() => {});
  const phase = job.phase;
  const repoPath = path.join(homedir(), "GitHub", String(job.target_repo ?? ""));
  if (!job.target_repo || !existsSync(path.join(repoPath, ".git"))) {
    return { phase, status: "failed", reason: `the target repo is not checked out at ${repoPath} on this Mac` };
  }
  const names = namesFor(job.card?.id ?? "card");
  const jobDir = ctx.jobDir;
  mkdirSync(jobDir, { recursive: true });
  const packageDir = path.join(path.dirname(names.worktree), `pkg-${path.basename(names.worktree).replace(/^wt-/, "")}`);
  const resultPath = path.join(jobDir, `result-${phase}.json`);
  if (existsSync(resultPath)) rmSync(resultPath);

  // LAND is gated BEFORE anything runs. Not after the worktree, not after the model.
  if (phase === "LAND") {
    const gate = landGate(job);
    if (!gate.ok) return { phase, status: "failed", reason: `LAND refused: ${gate.why}` };
  }

  await ensureWorktree(repoPath, names, phase, progress);

  // THE RUNBOOK IS THE AUTHORITY FOR THE TARGET REPO. Absent → BLOCK, the prompt says so and so does this line.
  const runbook = path.join(names.worktree, "RUNBOOK.md");
  if (!existsSync(runbook)) {
    return {
      phase,
      status: "blocked",
      reason: `${job.target_repo} has no RUNBOOK.md. Write one (join-west-peek-main/RUNBOOK.md is the model: what the repo is, its standing rules, how to make a change, what each guard pins), land it, then reply "go".`,
    };
  }

  // PLAN pulls the package. Zero files blocks the card naming the folder.
  if (phase === "PLAN") {
    const folder = job.drive?.folder_id;
    if (!folder) return { phase, status: "blocked", reason: "no Drive FOLDER is on the card — send the folder link (a file link is not enough)" };
    if (!ctx.env?.GSC_SERVICE_ACCOUNT_JSON) return { phase, status: "failed", reason: "GSC_SERVICE_ACCOUNT_JSON is not in the environment — the claimer must run under vault.mjs run" };
    rmSync(packageDir, { recursive: true, force: true });
    progress(`pulling Drive folder ${folder}`);
    try {
      const { stdout } = await sh("node", [PULL_SCRIPT, folder, packageDir], { env: ctx.env });
      writeFileSync(path.join(jobDir, "pull.log"), stdout);
      progress(stdout.trim().split("\n").pop() ?? "pulled");
    } catch (err) {
      const msg = `${err?.stderr ?? ""}${err?.stdout ?? ""}`.trim() || (err instanceof Error ? err.message : String(err));
      return { phase, status: "blocked", reason: msg.slice(0, 800) };
    }
  }

  let landOutput = null;
  let mergeSha = null;
  if (phase === "LAND") {
    // THE SCRIPT LANDS, NOT THE MODEL. `~/bin/land` verifies green again, merges, watches main,
    // deploys where the repo needs it, and refuses rather than guesses.
    const land = path.join(homedir(), "bin", "land");
    if (!existsSync(land)) return { phase, status: "failed", reason: `${land} is not on this Mac` };
    progress(`landing #${job.pr.number}`);
    try {
      const { stdout, stderr } = await sh(land, [String(job.pr.number ?? "")], { cwd: names.worktree, env: process.env, timeout: 30 * 60_000 });
      landOutput = `${stdout}\n${stderr}`;
    } catch (err) {
      landOutput = `${err?.stdout ?? ""}\n${err?.stderr ?? ""}`;
      return { phase, status: "failed", reason: `~/bin/land stopped: ${landOutput.trim().split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 700)}` };
    }
    try {
      const { stdout } = await sh("gh", ["pr", "view", String(job.pr.number), "--json", "mergeCommit,state"], { cwd: names.worktree });
      const j = JSON.parse(stdout);
      mergeSha = j.mergeCommit?.oid ?? null;
      if (j.state !== "MERGED" || !mergeSha) return { phase, status: "failed", reason: `after land, gh says the PR is ${j.state} with no merge commit` };
    } catch (err) {
      return { phase, status: "failed", reason: `could not read the merge from gh: ${err instanceof Error ? err.message : String(err)}` };
    }
    writeFileSync(path.join(jobDir, "land.log"), landOutput);
  }

  // The model's turn: one fresh context, the prompt file plus the job context.
  // The plan's text rides on the job from the Worker (the filed Document is the source of truth),
  // so a BUILD on a machine that never ran the PLAN still has it.
  const planText = job.plan?.text ?? null;
  const prompt = `${readFileSync(PROMPT_FILE, "utf8")}\n${renderContext(job, { ...names, packageDir, jobDir, resultPath, planText, landOutput, mergeSha })}`;
  writeFileSync(path.join(jobDir, `prompt-${phase}.md`), prompt);
  progress(`claude -p (${job.model}) for ${phase}`);
  const claude = await runClaude({ prompt, model: job.model, cwd: names.worktree, addDirs: [jobDir, packageDir].filter(existsSync), signal: ctx.signal, onLine: progress });
  writeFileSync(path.join(jobDir, `claude-${phase}.out`), `${claude.out}\n--- stderr ---\n${claude.err}`);
  const cost = costFrom(claude.out);

  const { result, problem } = readResult(existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "", phase);
  if (!result) {
    return { phase, status: "failed", reason: `${phase} ended (claude exit ${claude.code}) but ${problem}${cost !== null ? ` — cost $${cost.toFixed(2)}` : ""}` };
  }
  if (result.status !== "ok") return { phase, status: result.status, reason: String(result.reason).slice(0, 1500) };

  if (phase === "PLAN") {
    writeFileSync(path.join(jobDir, "plan.md"), result.document);
    return { phase, status: "ok", document: result.document, decided: result.decided ?? [], asks: result.asks ?? [], notes: `${result.notes ?? ""}${cost !== null ? ` (cost $${cost.toFixed(2)})` : ""}`.trim() };
  }

  if (phase === "BUILD") {
    // THE SCRIPT OBSERVES THE PR AND ITS CHECKS. The model's pr_url is a claim; gh is the fact.
    let pr;
    try {
      pr = await prFor(names.worktree, names.branch);
    } catch (err) {
      return { phase, status: "failed", reason: `the model reported a PR but gh finds none on ${names.branch}: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}` };
    }
    const checks = await watchChecks(names.worktree, pr.number, ctx.signal, progress);
    return {
      phase,
      status: "ok",
      pr_url: pr.url,
      pr_number: pr.number,
      branch: names.branch,
      check_state: checks.state,
      check_url: checks.url ?? undefined,
      proof: String(result.proof ?? "").slice(0, 8000),
      reason: checks.state === "GREEN" ? undefined : `checks are ${checks.state} on ${pr.url}`,
      notes: `${result.notes ?? ""}${cost !== null ? ` (cost $${cost.toFixed(2)})` : ""}`.trim(),
    };
  }

  // LAND ok: the proof, the merge, and the worktree goes away.
  try {
    await git(repoPath, "worktree", "remove", "--force", names.worktree);
    await git(repoPath, "branch", "-D", names.branch);
  } catch {
    /* a leftover worktree is untidy, not a failure */
  }
  return { phase, status: "ok", merge_sha: mergeSha, live_proof: String(result.live_proof).slice(0, 8000), notes: `${result.notes ?? ""}${cost !== null ? ` (cost $${cost.toFixed(2)})` : ""}`.trim() };
}

// ── Self-test ────────────────────────────────────────────────────────────────────────────────

function selfTest() {
  const approved = { plan: { approved_at: "2026-09-20T10:00:00Z" }, pr: { url: "https://github.com/x/y/pull/1", check_state: "GREEN", check_green_at: "2026-09-20T11:00:00Z" } };
  const cases = [
    ["LAND passes with a recorded approval and a recorded green", () => landGate(approved).ok === true],
    ["LAND refuses without a plan approval", () => landGate({ ...approved, plan: { approved_at: null } }).ok === false],
    ["LAND refuses without a green check", () => landGate({ ...approved, pr: { ...approved.pr, check_green_at: null } }).ok === false],
    ["LAND refuses a RED check even with a green time", () => landGate({ ...approved, pr: { ...approved.pr, check_state: "RED" } }).ok === false],
    ["LAND refuses without a PR", () => landGate({ ...approved, pr: null }).ok === false],
    ["a missing result file is a failure, never ok", () => readResult("", "PLAN").result === null],
    ["a result for the wrong phase is refused", () => readResult(JSON.stringify({ phase: "BUILD", status: "ok", pr_url: "https://x" }), "PLAN").result === null],
    ["an ok PLAN needs a document", () => readResult(JSON.stringify({ phase: "PLAN", status: "ok" }), "PLAN").result === null],
    ["an ok BUILD needs a PR url", () => readResult(JSON.stringify({ phase: "BUILD", status: "ok" }), "BUILD").result === null],
    ["a blocked result needs a reason", () => readResult(JSON.stringify({ phase: "PLAN", status: "blocked" }), "PLAN").result === null],
    ["a good PLAN result reads", () => readResult(JSON.stringify({ phase: "PLAN", status: "ok", document: "# Plan\n".padEnd(60, "x"), asks: ["colour?"] }), "PLAN").result?.asks?.[0] === "colour?"],
    ["all-success checks are GREEN", () => checkStateOf([{ state: "SUCCESS" }, { state: "SKIPPED" }]) === "GREEN"],
    ["one failure makes RED", () => checkStateOf([{ state: "SUCCESS" }, { state: "FAILURE" }]) === "RED"],
    ["a pending check is PENDING", () => checkStateOf([{ state: "SUCCESS" }, { state: "PENDING" }]) === "PENDING"],
    ["no checks is PENDING, not green", () => checkStateOf([]) === "PENDING"],
    ["names are stable and safe", () => namesFor("wc_ABC-123_def").branch === "work/wpc-abc123de" && !namesFor("../x").worktree.includes("..")],
    ["the context names the result path and the ask", () => {
      const t = renderContext({ phase: "PLAN", card: { id: "wc_1", title: "T" }, ask: "add a page", rules: { land_on_green: "on" } }, { worktree: "/w", branch: "b", packageDir: "/p", jobDir: "/j", resultPath: "/j/result-PLAN.json" });
      return t.includes("RESULT_PATH: /j/result-PLAN.json") && t.includes("add a page") && t.includes("land_on_green: on");
    }],
    ["the prompt file exists and names the three phases", () => {
      const p = readFileSync(PROMPT_FILE, "utf8");
      return ["## Phase PLAN", "## Phase BUILD", "## Phase LAND"].every((h) => p.includes(h)) && p.includes("card kind: WEB_PROPERTY_CHANGE");
    }],
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

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}` && process.argv.includes("--self-test")) selfTest();
