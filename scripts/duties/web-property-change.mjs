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
  // A change that previews first (not publish-ready, or the partner said "preview") needs the SECOND approval.
  const needsPreview = job?.plan?.publish_ready === false || job?.plan?.preview_only === true;
  if (needsPreview && !job?.pr?.land_approved_at && !job?.pr?.forced_by) return { ok: false, why: "this change previews first and the partner has not approved the landing after the preview, nor forced it to production — nothing lands" };
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
  // Every ask carries a recommended default — "approved" takes them all, so a bare question is not an ask.
  if (parsed.status === "ok" && phase === "PLAN" && typeof parsed.publish_ready !== "boolean") return { result: null, problem: "an ok PLAN must say publish_ready: true or false" };
  if (parsed.status === "ok" && phase === "PLAN" && parsed.publish_ready === false && !(Array.isArray(parsed.placeholders) && parsed.placeholders.length > 0)) return { result: null, problem: "a PLAN that is not publish-ready must name its placeholders" };
  if (parsed.status === "ok" && phase === "PLAN" && Array.isArray(parsed.asks) && parsed.asks.some((a) => !(a && typeof a === "object" && String(a.question ?? "").trim() && String(a.recommended ?? "").trim()))) {
    return { result: null, problem: "every ask must be { question, recommended } — an ask without a recommended default cannot be approved with one word" };
  }
  if (parsed.status === "ok" && phase === "BUILD" && !(typeof parsed.pr_url === "string" && /^https?:\/\//.test(parsed.pr_url))) return { result: null, problem: "an ok BUILD must carry the PR url" };
  if (parsed.status === "ok" && phase === "LAND" && !(typeof parsed.live_proof === "string" && parsed.live_proof.trim())) return { result: null, problem: "an ok LAND must carry the live proof" };
  return { result: parsed, problem: null };
}

/**
 * THE PREVIEW URL(S) FOR A BRANCH, out of what GitHub holds (21 Sep 2026). Cloudflare Pages posts a
 * Deployment per project with `environment_url` on its status, and a PR comment naming the
 * `*.pages.dev` link. Both are read; a repo with neither (a Worker, not Pages) yields null, and the
 * preview email says so and carries the PR and screenshots instead. Pure, so it is self-tested.
 */
export function previewUrlsFrom(deploymentStatuses, commentBodies) {
  const urls = new Set();
  for (const st of Array.isArray(deploymentStatuses) ? deploymentStatuses : []) {
    const u = String(st?.environment_url ?? "").trim();
    if (/^https?:\/\//.test(u) && /pages\.dev|preview/i.test(u)) urls.add(u.replace(/\/$/, ""));
  }
  for (const body of Array.isArray(commentBodies) ? commentBodies : []) {
    for (const m of String(body ?? "").matchAll(/https?:\/\/[a-z0-9.-]+\.pages\.dev[^\s)>\]]*/gi)) urls.add(m[0].replace(/\/$/, ""));
  }
  return urls.size === 0 ? null : [...urls].join(" · ");
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
    ...(job.pre_approved ? [`PRE-APPROVED: the partner wrote "${job.pre_approved}" — decide everything yourself, asks: []`] : []),
    "",
    "REQUEST (the partner's own words — THE SPECIFICATION; read this first):",
    "```",
    String(job.request ?? job.ask ?? "").trim() || "(the request text is empty — BLOCK and ask what they want)",
    "```",
    "",
    "ASSETS the request may reference:",
    `ATTACHMENTS: ${paths.attachments?.length ? paths.attachments.map((a) => `${a.filename} (${a.media_type}, ${a.bytes} bytes) → ${a.path}`).join("; ") : "none arrived"}`,
    `DRIVE_FOLDERS: ${job.drive?.folder_id ? `${job.drive.folder_url ?? job.drive.folder_id} → pulled into ${paths.packageDir}` : "none in the request"}`,
    "",
    "STANDING RULES OF THIS KIND:",
    ...Object.entries(job.rules ?? {}).map(([k, v]) => `- ${k}: ${v}`),
  ];
  if (job.plan) {
    lines.push("", "THE PLAN (already filed as a Document on the card):", "");
    if (paths.planText) lines.push("```markdown", paths.planText, "```");
    lines.push("", `DECIDED: ${JSON.stringify(job.plan.decided ?? [])}`);
    lines.push(`ASKED (each with the recommended default): ${JSON.stringify(job.plan.asks ?? [])}`);
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

/**
 * THE ENVIRONMENT `claude` RUNS IN — HER SEAT, NEVER A KEY (21 Sep 2026).
 *
 * The claimer runs under `vault.mjs run --`, which injects the whole West Peek vault into the
 * process — and the vault holds ANTHROPIC_API_KEY for the Worker's paid lane. `claude -p` prefers
 * an API key in its environment over the subscription login, so with the key present every job
 * would bill the API and die with "Credit balance is too low" ("claude.ai connectors are disabled
 * because ANTHROPIC_API_KEY … takes precedence"), which is exactly how a sibling lane's two jobs
 * died at 13:00 CT. Reserved env names are never used (her rule); Claude Code runs on her seat.
 * So the child gets a COPY of the environment with every ANTHROPIC_* and CLAUDE_* auth variable
 * removed. `validate:duty-executor` holds this to the spawn and proves the strip negatively.
 */
export function claudeChildEnv(base) {
  const out = {};
  for (const [k, v] of Object.entries(base ?? {})) {
    if (/^(ANTHROPIC_|CLAUDE_(API|AUTH|CODE_OAUTH|CODE_USE|OAUTH|TOKEN)|CLAUDE_CODE_API)/i.test(k)) continue;
    if (k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_BASE_URL" || k === "ANTHROPIC_AUTH_TOKEN") continue;
    out[k] = v;
  }
  return out;
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
    const child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: claudeChildEnv(process.env) });
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

/** Fetch one attached file from the Worker with the Mac's own Access token. Returns the byte count. */
async function fetchAttachment(routePath, target, env) {
  const base = env?.WP_OS_BASE_URL ?? "https://os.joinwestpeek.com";
  const id = env?.WP_OS_MAC_ACCESS_CLIENT_ID;
  const secret = env?.WP_OS_MAC_ACCESS_CLIENT_SECRET;
  if (!id || !secret) throw new Error("WP_OS_MAC_ACCESS_CLIENT_ID / _SECRET are not in the environment");
  const res = await fetch(`${base}${routePath}`, { headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("the file came back empty");
  writeFileSync(target, buf);
  return buf.length;
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

async function previewUrlFor(worktree, number, progress) {
  const statuses = [];
  const comments = [];
  try {
    const { stdout } = await sh("gh", ["pr", "view", String(number), "--json", "headRefOid,comments"], { cwd: worktree });
    const pr = JSON.parse(stdout);
    for (const c of pr.comments ?? []) comments.push(c.body);
    const repo = (await sh("gh", ["repo", "view", "--json", "nameWithOwner"], { cwd: worktree })).stdout;
    const { nameWithOwner } = JSON.parse(repo);
    const deps = JSON.parse((await sh("gh", ["api", `repos/${nameWithOwner}/deployments?sha=${pr.headRefOid}&per_page=20`], { cwd: worktree })).stdout);
    for (const d of Array.isArray(deps) ? deps : []) {
      try {
        const sts = JSON.parse((await sh("gh", ["api", `repos/${nameWithOwner}/deployments/${d.id}/statuses?per_page=5`], { cwd: worktree })).stdout);
        for (const st of Array.isArray(sts) ? sts : []) statuses.push(st);
      } catch {
        /* a deployment with no statuses yet */
      }
    }
  } catch (err) {
    progress(`preview url: could not read deployments (${err instanceof Error ? err.message.slice(0, 120) : String(err)})`);
  }
  const url = previewUrlsFrom(statuses, comments);
  progress(url ? `preview: ${url}` : "preview: none (no Pages deployment on this PR)");
  return url;
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

  // THE ASSETS. The attachments the partner sent, fetched by name from the Worker into the
  // package's attachments dir (every phase — BUILD needs the photo too); the Drive folder, when
  // the request named one, pulled in PLAN. A folder is OPTIONAL: "the photo is attached" is a
  // whole request. Zero files from a named folder blocks the card naming it.
  const attachments = [];
  if (Array.isArray(job.attachments) && job.attachments.length > 0) {
    const attDir = path.join(packageDir, "attachments");
    mkdirSync(attDir, { recursive: true });
    for (const a of job.attachments) {
      const target = path.join(attDir, String(a.filename).replace(/[\\/]/g, "_"));
      try {
        const got = await fetchAttachment(a.path, target, ctx.env);
        attachments.push({ ...a, path: target, bytes: got });
        progress(`attachment ${a.filename} (${got} bytes)`);
      } catch (err) {
        return { phase, status: "failed", reason: `could not fetch the attachment ${a.filename} from the OS: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
      }
    }
  }
  if (phase === "PLAN" && job.drive?.folder_id) {
    const folder = job.drive.folder_id;
    if (!ctx.env?.GSC_SERVICE_ACCOUNT_JSON) return { phase, status: "failed", reason: "GSC_SERVICE_ACCOUNT_JSON is not in the environment — the claimer must run under vault.mjs run" };
    rmSync(path.join(packageDir, "drive"), { recursive: true, force: true });
    progress(`pulling Drive folder ${folder}`);
    try {
      const { stdout } = await sh("node", [PULL_SCRIPT, folder, path.join(packageDir, "drive")], { env: ctx.env });
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
  const prompt = `${readFileSync(PROMPT_FILE, "utf8")}\n${renderContext(job, { ...names, packageDir, jobDir, resultPath, planText, landOutput, mergeSha, attachments })}`;
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
    return { phase, status: "ok", document: result.document, decided: result.decided ?? [], asks: result.asks ?? [], publish_ready: result.publish_ready, placeholders: result.placeholders ?? [], notes: `${result.notes ?? ""}${cost !== null ? ` (cost $${cost.toFixed(2)})` : ""}`.trim() };
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
    // The preview link is read AFTER the checks settle: Pages posts its deployment beside them.
    const previewUrl = checks.state === "GREEN" ? await previewUrlFor(names.worktree, pr.number, progress) : null;
    return {
      phase,
      status: "ok",
      pr_url: pr.url,
      pr_number: pr.number,
      branch: names.branch,
      check_state: checks.state,
      check_url: checks.url ?? undefined,
      preview_url: previewUrl ?? undefined,
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
    ["LAND refuses a not-ready plan without the second approval", () => landGate({ ...approved, plan: { ...approved.plan, publish_ready: false } }).ok === false],
    ["LAND refuses a preview-only plan without the second approval", () => landGate({ ...approved, plan: { ...approved.plan, preview_only: true } }).ok === false],
    ["LAND passes a not-ready plan that was FORCED to production by name", () => landGate({ ...approved, plan: { ...approved.plan, publish_ready: false }, pr: { ...approved.pr, forced_by: "fu_scooter_taylor" } }).ok === true],
    ["LAND passes a not-ready plan WITH the second approval", () => landGate({ ...approved, plan: { ...approved.plan, publish_ready: false }, pr: { ...approved.pr, land_approved_at: "2026-09-21T12:00:00Z" } }).ok === true],
    ["a missing result file is a failure, never ok", () => readResult("", "PLAN").result === null],
    ["a result for the wrong phase is refused", () => readResult(JSON.stringify({ phase: "BUILD", status: "ok", pr_url: "https://x" }), "PLAN").result === null],
    ["an ok PLAN needs a document", () => readResult(JSON.stringify({ phase: "PLAN", status: "ok" }), "PLAN").result === null],
    ["an ok BUILD needs a PR url", () => readResult(JSON.stringify({ phase: "BUILD", status: "ok" }), "BUILD").result === null],
    ["a blocked result needs a reason", () => readResult(JSON.stringify({ phase: "PLAN", status: "blocked" }), "PLAN").result === null],
    ["a good PLAN result reads", () => readResult(JSON.stringify({ phase: "PLAN", status: "ok", document: "# Plan\n".padEnd(60, "x"), asks: [{ question: "colour?", recommended: "black and white" }], publish_ready: true }), "PLAN").result?.asks?.[0]?.recommended === "black and white"],
    ["a PLAN that does not say publish_ready is refused", () => readResult(JSON.stringify({ phase: "PLAN", status: "ok", document: "# Plan\n".padEnd(60, "x") }), "PLAN").result === null],
    ["a not-ready PLAN without named placeholders is refused", () => readResult(JSON.stringify({ phase: "PLAN", status: "ok", document: "# Plan\n".padEnd(60, "x"), publish_ready: false }), "PLAN").result === null],
    ["a not-ready PLAN with placeholders reads", () => readResult(JSON.stringify({ phase: "PLAN", status: "ok", document: "# Plan\n".padEnd(60, "x"), publish_ready: false, placeholders: ["Sengo logo"] }), "PLAN").result?.placeholders?.[0] === "Sengo logo"],
    ["a Pages deployment status yields the preview url", () => previewUrlsFrom([{ environment_url: "https://abc123.join-west-peek.pages.dev/" }], []) === "https://abc123.join-west-peek.pages.dev"],
    ["a Cloudflare PR comment yields the preview url", () => previewUrlsFrom([], ["Deploying with Cloudflare Pages\n| Preview URL | https://def456.ventures.pages.dev |"]) === "https://def456.ventures.pages.dev"],
    ["a repo with no Pages deployment yields null, never a guess", () => previewUrlsFrom([{ environment_url: "" }], ["LGTM"]) === null],
    ["an ask without a recommended default is refused", () => readResult(JSON.stringify({ phase: "PLAN", status: "ok", document: "# Plan\n".padEnd(60, "x"), asks: ["colour?"], publish_ready: true }), "PLAN").result === null],
    ["all-success checks are GREEN", () => checkStateOf([{ state: "SUCCESS" }, { state: "SKIPPED" }]) === "GREEN"],
    ["one failure makes RED", () => checkStateOf([{ state: "SUCCESS" }, { state: "FAILURE" }]) === "RED"],
    ["a pending check is PENDING", () => checkStateOf([{ state: "SUCCESS" }, { state: "PENDING" }]) === "PENDING"],
    ["no checks is PENDING, not green", () => checkStateOf([]) === "PENDING"],
    ["names are stable and safe", () => namesFor("wc_ABC-123_def").branch === "work/wpc-abc123de" && !namesFor("../x").worktree.includes("..")],
    ["the claude child never sees an API key or base url from the vault", () => {
      const e = claudeChildEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_BASE_URL: "https://x", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o", HOME: "/h" });
      return e.PATH === "/bin" && e.HOME === "/h" && !("ANTHROPIC_API_KEY" in e) && !("ANTHROPIC_BASE_URL" in e) && !("ANTHROPIC_AUTH_TOKEN" in e) && !("CLAUDE_CODE_OAUTH_TOKEN" in e);
    }],
    ["a pre-approved job tells the model to decide everything", () => renderContext({ phase: "PLAN", card: { id: "wc_1", title: "T" }, ask: "x", pre_approved: "your call" }, { worktree: "/w", branch: "b", packageDir: "/p", jobDir: "/j", resultPath: "/j/r.json" }).includes('PRE-APPROVED: the partner wrote "your call"')],
    ["the context names the result path and the ask", () => {
      const t = renderContext({ phase: "PLAN", card: { id: "wc_1", title: "T" }, request: "add a page", rules: { land_on_green: "on" } }, { worktree: "/w", branch: "b", packageDir: "/p", jobDir: "/j", resultPath: "/j/result-PLAN.json" });
      return t.includes("RESULT_PATH: /j/result-PLAN.json") && t.includes("REQUEST (the partner's own words") && t.includes("add a page") && t.includes("land_on_green: on");
    }],
    ["the context lists attachments and says when no folder came", () => {
      const t = renderContext({ phase: "PLAN", card: { id: "wc_1", title: "T" }, request: "the photo is attached", rules: {} }, { worktree: "/w", branch: "b", packageDir: "/p", jobDir: "/j", resultPath: "/j/r.json", attachments: [{ filename: "sensori.jpg", media_type: "image/jpeg", bytes: 1234, path: "/p/attachments/sensori.jpg" }] });
      return t.includes("ATTACHMENTS: sensori.jpg (image/jpeg, 1234 bytes) → /p/attachments/sensori.jpg") && t.includes("DRIVE_FOLDERS: none in the request");
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
