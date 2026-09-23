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
 *   BUILD  same worktree · `claude -p` (the build model) · then THE SCRIPT, not the model, sets any
 *          delivery config the model REQUESTED BY NAME (`pages_env`, against the allow-list in
 *          `lib/pages-delivery.mjs`), asks `gh` for the PR and watches `gh pr checks` to a terminal
 *          state · reports GREEN/RED/PENDING as observed. "Never take an agent's word that CI is
 *          green" — and never that it set a variable either.
 *   LAND   REFUSED unless the job carries a recorded plan approval AND a recorded green check
 *          (`landGate` below; `validate:no-land-without-approval` reads it) · `~/bin/land <pr>`
 *          merges, watches main, deploys · the merge SHA from `gh` · `claude -p` (the land model)
 *          curls the live pages and writes the proof · the worktree is removed.
 *
 * ── WHAT THE MODEL NEVER DECIDES ─────────────────────────────────────────────────────────────
 *
 * The model, the phase, the repo, the worktree path, the ceiling and the result path are all on
 * the job the Worker parked. The model may not land (the script does, behind the gate), may not
 * report a check state (the script observes it), may not set or report DELIVERY CONFIG (it asks by
 * name in `pages_env`; the script sets what is on the allow-list and records what it observed), and
 * may not report success without writing the result file (Rule 0: a phase that says nothing has
 * not run).
 *
 * ── DELIVERY CONFIG IS THE SCRIPT'S, NEVER A NAMED STOP (22 Sep 2026) ─────────────────────────
 *
 * The three Pages projects and the three variables are in `lib/pages-delivery.mjs` — one list, read
 * here and by `scripts/validate/only-the-script-sets-delivery-config.mjs`. A plain variable goes
 * through the Cloudflare API with the vault's CLOUDFLARE_API_TOKEN; the secret goes through
 * `wrangler pages secret put` with the value written to the child's STDIN. A value is never an
 * argument, never printed, never in the prompt, never in the report. What is recorded is the
 * project, the variable NAME and one of set / already set / failed / refused.
 *
 * ── ONE JOB, SEVERAL REPOS (23 Sep 2026, migration 0236) ─────────────────────────────────────
 *
 * A job whose `parts` names two or more repos is one card over all of them. ONE run per phase:
 *   PLAN   a worktree per repo, a RUNBOOK.md in EVERY repo (BLOCK naming the ones without), one
 *          `claude -p` over all the worktrees → one plan covering every repo, one approval.
 *   BUILD  per repo, in its own worktree: `claude -p` for that repo alone (its sites, its slice of
 *          the request, its own validators), then gh observes its PR and checks. A repo already
 *          GREEN is only re-observed, never rebuilt. The report carries one entry per repo.
 *   LAND   ALL OR NOTHING. `landGate` refuses unless every part is recorded green; then
 *          `liveLandGate` re-reads `gh pr checks` on EVERY PR and refuses unless all are green NOW;
 *          only then does `~/bin/land` run, repo by repo. A later repo that refuses is reported
 *          with what already merged, so the next attempt resumes and never lands a PR twice.
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
import { CLOUDFLARE_ACCOUNT_ID, classify, proofLine, readRequests } from "./lib/pages-delivery.mjs";
import { VAULT_INJECTED_VAR, claudeChildEnv, strippedNote } from "../lib/vault-env.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROMPT_FILE = path.join(REPO_ROOT, "scripts", "duties", "web-property-change-prompt.md");
const PULL_SCRIPT = path.join(REPO_ROOT, "scripts", "drive", "pull.mjs");

/** How long the BUILD phase watches the PR's checks before reporting PENDING. */
const CHECK_WATCH_MS = 25 * 60_000;
const CHECK_POLL_MS = 30_000;

// ── Pure parts (self-tested) ─────────────────────────────────────────────────────────────────

/** The branch and worktree for a card. Stable across phases so BUILD resumes what PLAN made. */
export function namesFor(cardId, repo = null) {
  const short = String(cardId).replace(/^wc_/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toLowerCase() || "card";
  // A multi-repo job has one worktree PER REPO; the branch name is the same in each repo.
  const repoSlug = repo ? `-${String(repo).replace(/[^A-Za-z0-9-]/g, "").slice(0, 40).toLowerCase()}` : "";
  return {
    branch: `work/wpc-${short}`,
    worktree: path.join(homedir(), "GitHub", "wpos-jobs", `wt-${short}${repoSlug}`),
  };
}

/** A job over several repos (0236). One repo, or none, is the single-repo road, unchanged. */
export function isSeveral(job) {
  return Array.isArray(job?.parts) && job.parts.length > 1;
}

/**
 * THE LAND GATE. Both facts, recorded on the row by earlier phases and carried on the job:
 * the plan's approval time and the PR's green time. Anything else is refused with the reason.
 * `validate:no-land-without-approval` reads this function's text and requires both checks.
 */
export function landGate(job) {
  if (!job?.plan?.approved_at) return { ok: false, why: "the plan has not been approved by the partner who asked — nothing lands" };
  if (!job?.pr?.url) return { ok: false, why: "there is no PR to land" };
  if (isSeveral(job)) {
    // ALL OR NOTHING (0236): every repo's PR recorded green with a number, or not one of them lands.
    const notGreen = job.parts.filter((p) => !(p?.pr?.url && Number.isInteger(p.pr.number) && p.pr.number > 0 && p.pr.check_green_at && p.pr.check_state === "GREEN"));
    if (notGreen.length) return { ok: false, why: `not every PR is recorded green — ${notGreen.map((p) => `${p?.repo ?? "?"} ${p?.pr?.check_state ?? "no PR"}`).join(", ")}; nothing lands, not even the green ones`, blocking: notGreen.map((p) => p?.repo) };
  } else {
    // The number is what `land` takes; a URL alone is not a PR this script can land (21 Sep 2026: `land ""`).
    if (!Number.isInteger(job?.pr?.number) || job.pr.number <= 0) return { ok: false, why: "the LAND job carries no PR number — the Worker parked it from a row without one; nothing lands" };
    if (!job?.pr?.check_green_at || job.pr.check_state !== "GREEN") return { ok: false, why: "the PR has no recorded green check — nothing lands" };
  }
  // A change that previews first (not publish-ready, or the partner said "preview") needs the SECOND approval.
  const needsPreview = job?.plan?.publish_ready === false || job?.plan?.preview_only === true;
  if (needsPreview && !job?.pr?.land_approved_at && !job?.pr?.forced_by) return { ok: false, why: "this change previews first and the partner has not approved the landing after the preview, nor forced it to production — nothing lands" };
  // THE APPROVAL BINDS TO THE LATEST PREVIEW (0240): never a stale "approved"; "publish" only a build green after it.
  if (needsPreview && !job?.pr?.forced_by && job?.pr?.land_approved_at && job?.pr?.preview_emailed_at && job.pr.land_approved_at < job.pr.preview_emailed_at) return { ok: false, why: "the landing approval predates the latest preview — a stale approval never lands" };
  if (job?.pr?.publish_approved_at && !(job?.pr?.check_green_at && job.pr.check_green_at > job.pr.publish_approved_at)) return { ok: false, why: "\"publish\" was approved but no build with the new materials has gone green since — nothing lands" };
  return { ok: true, why: "approved and green" };
}

/**
 * THE LIVE GATE FOR SEVERAL REPOS, read from `gh pr checks` the moment before landing (0236). The
 * recorded green is hours old by the time a partner says "approved"; a PR that went red since holds
 * every repo. `states` is [{ repo, state, merged }]; a part already merged by an earlier attempt is
 * not re-checked. Pure, so it is self-tested.
 */
export function liveLandGate(states) {
  if (!Array.isArray(states) || states.length === 0) return { ok: false, why: "no PRs were checked — nothing lands" };
  const notGreen = states.filter((s) => !s.merged && s.state !== "GREEN");
  if (notGreen.length) return { ok: false, why: `not every PR is green right now — ${notGreen.map((s) => `${s.repo} ${s.state}`).join(", ")}; nothing landed`, blocking: notGreen.map((s) => s.repo) };
  return { ok: true, why: "every PR is green right now" };
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
  /*
   * `pages_env` IS A REQUEST, AND ONLY A REQUEST (22 Sep 2026). A name and a project, nothing else.
   * A value here would be the model carrying a credential, so an entry that has one is refused
   * outright rather than ignored — a result that tried is a result that was written wrong.
   */
  if (parsed.pages_env !== undefined) {
    if (!Array.isArray(parsed.pages_env)) return { result: null, problem: "pages_env must be a list of { project, name }" };
    for (const e of parsed.pages_env) {
      if (!e || typeof e !== "object" || !String(e.project ?? "").trim() || !String(e.name ?? "").trim()) {
        return { result: null, problem: "every pages_env entry is { project, name } — both named, both non-empty" };
      }
      if (Object.keys(e).some((k) => !["project", "name"].includes(k))) {
        return { result: null, problem: "a pages_env entry carries ONLY project and name — never a value; the script holds the values" };
      }
    }
  }
  if (parsed.status === "ok" && phase === "LAND" && !(typeof parsed.live_proof === "string" && parsed.live_proof.trim())) return { result: null, problem: "an ok LAND must carry the live proof" };
  // 0237: what is missing is a list of { item, where } — the thing, and where it goes on the site.
  if (parsed.missing_materials !== undefined) {
    if (!Array.isArray(parsed.missing_materials) || parsed.missing_materials.some((m) => !(m && typeof m === "object" && String(m.item ?? "").trim() && String(m.where ?? "").trim()))) {
      return { result: null, problem: "missing_materials must be a list of { item, where } — both named, so the partner knows what to send and where it goes" };
    }
  }
  if (parsed.assets !== undefined && !(Array.isArray(parsed.assets) && parsed.assets.every((a) => typeof a === "string" && a.trim()))) return { result: null, problem: "assets must be a list of DRIVE_MANIFEST paths" };
  if (parsed.fetch !== undefined && !(Array.isArray(parsed.fetch) && parsed.fetch.every((a) => typeof a === "string" && a.trim()))) return { result: null, problem: "fetch must be a list of DRIVE_MANIFEST paths" };
  return { result: parsed, problem: null };
}

/**
 * THE PREVIEW URL(S) FOR A BRANCH, out of what GitHub holds (21 Sep 2026). Cloudflare Pages posts a
 * Deployment per project with `environment_url` on its status, and a PR comment naming the
 * `*.pages.dev` link. Both are read; a repo with neither (a Worker, not Pages) yields null, and the
 * preview email says so and carries the PR and screenshots instead. Pure, so it is self-tested.
 */
/**
 * THE PREVIEW LINK, READ STRICTLY (23 Sep 2026). The community PR's preview email carried six URLs
 * joined with " · " — HTML fragments captured (…pages.dev' and …pages.dev&lt;/a), and the ventures
 * and productions previews too, because the Pages bot comments on every project the repo builds.
 * Now: a URL stops at a quote, an angle bracket, an ampersand or whitespace; only hosts under this
 * job's `pagesHosts` (the site's own Pages subdomain) are kept; duplicates collapse to the origin;
 * and the BRANCH ALIAS (`work-wpc-….west-peek-community.pages.dev`) wins over a per-commit hash,
 * because it always shows the latest build of the PR. Pure, so it is self-tested with the real
 * comment's shape. Workers Builds version URLs (westpeek-live) are read the same strict way.
 */
/** Cloudflare Pages' branch alias: lower-case, every run of non-alphanumerics one "-", at most 28 characters. Pure. */
export function branchAlias(branch) {
  return String(branch ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28).replace(/-+$/, "");
}

export function previewUrlsFrom(deploymentStatuses, commentBodies, pagesHosts = [], branch = "") {
  const found = [];
  const add = (raw) => {
    let u;
    try {
      u = new URL(String(raw).trim());
    } catch {
      return;
    }
    if (!/^https?:$/.test(u.protocol)) return;
    const host = u.hostname.toLowerCase();
    const isPages = host.endsWith(".pages.dev");
    const isWorkerVersion = /^[a-f0-9]{8}-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(host);
    if (!isPages && !isWorkerVersion) return;
    if (isPages) {
      const under = pagesHosts.length === 0 ? host.split(".").length > 3 : pagesHosts.some((h) => host.endsWith(`.${String(h).toLowerCase()}`));
      if (!under) return;
    }
    found.push(`${u.protocol}//${host}`);
  };
  const URLS = /https?:\/\/[^\s"'<>&|)\]`]+/gi;
  for (const st of Array.isArray(deploymentStatuses) ? deploymentStatuses : []) for (const m of String(st?.environment_url ?? "").matchAll(URLS)) add(m[0]);
  for (const body of Array.isArray(commentBodies) ? commentBodies : []) for (const m of String(body ?? "").matchAll(URLS)) add(m[0]);
  const unique = [...new Set(found)];
  if (unique.length === 0) return null;
  const alias = branchAlias(branch);
  // THE BRANCH ALIAS, ONE PER SITE THIS CARD CHANGES (owner, 23 Sep 2026: "the only link … the stuff
  // he just worked on"): when the site's Pages project is known, a deployment seen under it means its
  // branch alias exists — that is the link, never a per-commit hash, never another site's.
  if (alias && pagesHosts.length > 0) {
    const links = pagesHosts.map((h) => String(h).toLowerCase()).filter((h) => unique.some((u) => new URL(u).hostname.endsWith(`.${h}`))).map((h) => `https://${alias}.${h}`);
    if (links.length) return links.join(" · ");
  }
  // Unknown project: one link per Pages project, its alias when present, else its first hash URL.
  const byProject = new Map();
  for (const u of unique) {
    const host = new URL(u).hostname;
    const project = host.split(".").slice(1).join(".");
    const isAlias = alias.length > 0 && host.split(".")[0] === alias;
    if (!byProject.has(project) || isAlias) byProject.set(project, u);
  }
  return [...byProject.values()].join(" · ");
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
    // 23 Sep 2026: the folders this job may change. One site or several in the same repo, and
    // nothing else: a community redesign never touches sites/ventures.
    `SITES: ${sitesLine(job.sites)}`,
    `TARGET_REPO: ${job.target_repo}`,
    `WORKTREE: ${paths.worktree}`,
    `BRANCH: ${paths.branch}`,
    `PACKAGE_DIR: ${paths.packageDir}`,
    `JOB_DIR: ${paths.jobDir}`,
    `RESULT_PATH: ${paths.resultPath}`,
    ...(isSeveral(job) ? reposBlock(job, paths) : []),
    ...(job.pre_approved ? [`PRE-APPROVED: the partner wrote "${job.pre_approved}" — decide everything yourself, asks: []`] : []),
    "",
    "REQUEST (the partner's own words — THE SPECIFICATION; read this first):",
    "```",
    String(job.request ?? job.ask ?? "").trim() || "(the request text is empty — BLOCK and ask what they want)",
    "```",
    "",
    "ASSETS the request may reference:",
    `ATTACHMENTS: ${paths.attachments?.length ? paths.attachments.map((a) => `${a.filename} (${a.media_type}, ${a.bytes} bytes) → ${a.path}`).join("; ") : "none arrived"}`,
    `DRIVE_FOLDERS: ${job.drive?.folder_id ? `${job.drive.folder_url ?? job.drive.folder_id} → mapped into ${paths.packageDir}/drive` : "none in the request"}`,
    ...(job.drive?.folder_id ? driveLines(job, paths) : []),
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

/** The rule for reading a package, the same words in every prompt that reads one. */
export const PACKAGE_TRUTH_RULE =
  "PACKAGE TRUTH: before you list anything as missing or ask about it, check DRIVE_MANIFEST.json (and fetch the file if you need to see it). A file that is present outweighs any document saying it is absent. When two package documents conflict, follow the one that declares precedence (\"this README controls\") and name the conflict in the plan — never ask the partner about it.";

/** How the model reaches Drive: the manifest, the documents already here, and assets by name through the script. */
function driveLines(job, paths) {
  const driveDir = `${paths.packageDir}/drive`;
  return [
    `DRIVE_MANIFEST: ${driveDir}/DRIVE_MANIFEST.json — every file in the folder (path, size, fetched). Re-read for THIS run: a file added since the plan is listed.`,
    `DOCUMENTS: every document (fetched: true) is already in ${driveDir}. Assets — images, logos, fonts, audio, video — stay in Drive until named.`,
    `ASSETS: you do not hold the Drive credential and never fetch yourself. ${job.phase === "PLAN" ? "List every manifest path the build will use in `assets` in your result; the script fetches them before BUILD." : `The plan's assets are fetched into ${driveDir} before you start. If you need another, finish with status "failed", reason "needs assets" and \`fetch: ["<manifest path>", …]\`; the script fetches them and runs you once more.`}`,
    PACKAGE_TRUTH_RULE,
  ];
}

/** The SITES line: folders of TARGET_REPO, or the whole repo when the site IS the repo (".") . */
export function sitesLine(sites) {
  if (!sites?.length) return "(unresolved — see ask; BLOCK and ask which site before changing anything)";
  if (sites.every((x) => x === ".")) return ". (the repo root — this site IS the repo; the whole of TARGET_REPO is in scope, and nothing outside it)";
  return `${sites.join(", ")} — change files ONLY under these folders of TARGET_REPO. A shared file outside them only when the request cannot be done without it, named in the plan with the reason.`;
}

/**
 * THE REPOS OF A MULTI-REPO JOB, for the prompt (0236). PLAN sees every repo and writes ONE plan
 * over all of them; BUILD sees them all but is told which ONE it is working (THIS RUN).
 */
function reposBlock(job, paths) {
  const lines = ["", `REPOS: this ONE job spans ${job.parts.length} repos — one plan covering all of them, one PR in each, landed together or not at all.`];
  for (const p of job.parts) {
    const n = namesFor(job.card?.id ?? "card", p.repo);
    lines.push(`- ${p.repo} (${p.property_host}) · worktree ${n.worktree} · branch ${n.branch} · SITES: ${sitesLine(p.sites)}`);
    lines.push(`  ITS PART OF THE REQUEST: ${String(p.ask ?? "").replace(/\s+/g, " ").slice(0, 1500)}`);
  }
  if (paths.thisPart) {
    lines.push("", `THIS RUN: BUILD ${paths.thisPart} ONLY. Change files only in its worktree, open its PR on its branch, and write RESULT_PATH for this repo alone. The other repos are built in their own runs.`);
  } else if (job.phase === "PLAN") {
    lines.push("", "THIS RUN: PLAN every repo above in ONE plan document, a section per repo; decided and asks cover the whole job.");
  }
  return lines;
}

// ── Shell ─────────────────────────────────────────────────────────────────────────────────────

async function sh(cmd, args, opts = {}) {
  const { stdout, stderr } = await execFileAsync(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts });
  return { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
}

async function git(cwd, ...args) {
  return sh("git", args, { cwd });
}

/*
 * THE ENVIRONMENT `claude` RUNS IN — HER SEAT, NEVER A KEY (21 Sep 2026), AND NOTHING FROM THE VAULT
 * (23 Sep 2026). `claudeChildEnv` lives in scripts/lib/vault-env.mjs, shared with the seat claimer:
 * the Mac's own environment minus every ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / CLAUDE_* auth
 * variable and minus every name the vault injected (read from the vault, never a list here). The
 * job log names what was withheld. Drive, land, Pages config and the Worker calls stay on this
 * script's own process.env. `validate:duty-executor` holds the spawn to it.
 */
export { claudeChildEnv };

/*
 * THE MODEL MAY NOT OPEN THE VAULT ITSELF. It runs as her macOS user, so it could run `vault.mjs`
 * or read the Keychain with `security`; both are denied on its Bash tool. A deny rule is not a
 * sandbox (a script it writes could still shell out) — it closes the obvious door, nothing more.
 */
const MODEL_DENIED_TOOLS = ["Bash(*vault.mjs*)", "Bash(security:*)", "Bash(*west-peek-os/vault*)"];

/** Run `claude -p` in the worktree with the prompt, killable by the job's signal. */
function runClaude({ prompt, model, cwd, addDirs, signal, onLine }) {
  return new Promise((resolve) => {
    const args = [
      "-p",
      "--model", model,
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Bash,Read,Edit,Write,Glob,Grep,WebFetch",
      "--disallowedTools", ...MODEL_DENIED_TOOLS,
      "--output-format", "json",
      ...addDirs.flatMap((d) => ["--add-dir", d]),
    ];
    let withheld = [];
    const child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: claudeChildEnv(process.env, (names) => (withheld = names)) });
    onLine?.(strippedNote(withheld));
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += String(d);
      onLine?.(`claude: ${out.length} bytes`);
    });
    child.stderr.on("data", (d) => (err += String(d)));
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => resolve({ code: -1, out, err: `${err}\n${e.message}\n${strippedNote(withheld)}` }));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      // A failure names what the model was not given, so a missing variable is never a mystery.
      resolve({ code, out, err: code === 0 ? err : `${err}\n${strippedNote(withheld)}` });
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

async function previewUrlFor(worktree, number, progress, pagesHosts = [], branch = "") {
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
  const url = previewUrlsFrom(statuses, comments, pagesHosts, branch);
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

// ── Delivery config: the SCRIPT sets it, the model only asks by name ─────────────────────────

const CF_API = "https://api.cloudflare.com/client/v4";

/** The production env vars a Pages project already has: name → type (+ value when it is plain). */
async function pagesEnvTypes(project, token) {
  const res = await fetch(`${CF_API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${encodeURIComponent(project)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) throw new Error(`Cloudflare answered ${res.status} for ${project}`);
  const vars = body.result?.deployment_configs?.production?.env_vars ?? {};
  const out = {};
  for (const [k, v] of Object.entries(vars)) {
    const type = v?.type ?? "plain_text";
    out[k] = { type, value: type === "secret_text" ? null : (v?.value ?? null) };
  }
  return out;
}

/**
 * A PLAIN delivery variable, through the Cloudflare API. The value comes from the allow-list, not
 * from the model and not from the environment, so what gets written is knowable by reading the list.
 */
async function setPagesPlain(entry, token, existing) {
  const already = existing[entry.name];
  if (already && already.type !== "secret_text" && already.value === entry.value) return "already set";
  const res = await fetch(`${CF_API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${encodeURIComponent(entry.project)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ deployment_configs: { production: { env_vars: { [entry.name]: { type: "plain_text", value: entry.value } } } } }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) throw new Error(`Cloudflare answered ${res.status}`);
  return "set";
}

/**
 * A delivery SECRET, through `wrangler pages secret put`, with the value written to the child's
 * STDIN. It is never an argument (a command line is readable by every other process on the
 * machine), never interpolated into a string, and the child's own output never reaches the report —
 * only its exit code becomes a word.
 */
function setPagesSecret(entry, env) {
  return new Promise((resolve) => {
    const value = env?.[entry.vaultKey];
    if (typeof value !== "string" || value.length === 0) {
      resolve({ outcome: "failed", why: `${entry.vaultKey} is not in the environment — the claimer must run under vault.mjs run` });
      return;
    }
    const child = spawn("npx", ["wrangler", "pages", "secret", "put", entry.name, "--project-name", entry.project], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...env, CI: "1" },
    });
    child.on("error", () => resolve({ outcome: "failed", why: "wrangler could not be started" }));
    child.on("close", (code) => resolve(code === 0 ? { outcome: "set", why: null } : { outcome: "failed", why: `wrangler exited ${code ?? -1}` }));
    // THE ONLY PLACE THE VALUE EXISTS in this function, and it goes straight down the pipe.
    child.stdin.end(value);
  });
}

/**
 * Every allowed request, performed. Returns the proof LINES — project, variable NAME, outcome —
 * and nothing that could carry a value. Refusals are recorded, never dropped: a model that asked
 * for something off the list must be able to see that it was refused and why.
 */
export async function applyPagesEnv(pagesEnv, env, progress) {
  const { allowed, refused } = readRequests(pagesEnv);
  const lines = [];
  for (const r of refused) {
    lines.push(proofLine(r.project || "(no project)", r.name || "(no name)", "refused", r.why));
    progress?.(lines[lines.length - 1]);
  }
  if (allowed.length === 0) return lines;
  const token = env?.CLOUDFLARE_API_TOKEN;
  if (!token) {
    for (const a of allowed) lines.push(proofLine(a.project, a.name, "failed", "CLOUDFLARE_API_TOKEN is not in the environment"));
    return lines;
  }
  const seen = new Map();
  for (const a of allowed) {
    let outcome = "failed";
    let why = null;
    try {
      if (!seen.has(a.project)) seen.set(a.project, await pagesEnvTypes(a.project, token));
      const existing = seen.get(a.project);
      if (a.kind === "plain") {
        outcome = await setPagesPlain(a, token, existing);
      } else if (existing[a.name]?.type === "secret_text") {
        outcome = "already set";
      } else {
        const out = await setPagesSecret(a, env);
        outcome = out.outcome;
        why = out.why;
      }
    } catch (err) {
      outcome = "failed";
      why = err instanceof Error ? err.message.slice(0, 160) : "the call did not complete";
    }
    lines.push(proofLine(a.project, a.name, outcome, why));
    progress?.(lines[lines.length - 1]);
  }
  return lines;
}

// ── The duty ─────────────────────────────────────────────────────────────────────────────────

/**
 * Run one phase. Always returns a report object; never throws for a job-level failure (the
 * claimer reports what comes back). Throws only when the job itself is malformed.
 */
export async function run(job, ctx) {
  const progress = ctx.progress ?? (() => {});
  const phase = job.phase;
  // LAND is gated BEFORE anything runs. Not after the worktree, not after the model — and before a
  // job over several repos is handed on, so one gate governs both roads.
  if (phase === "LAND") {
    const gate = landGate(job);
    if (!gate.ok) return { phase, status: "failed", reason: `LAND refused: ${gate.why}` };
  }
  if (isSeveral(job)) return runSeveral(job, ctx);
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

  // THE ASSETS — one gatherer for both roads (see gatherAssets): the attachments every phase, the
  // Drive folder MAPPED on every phase that needs materials, and the plan's assets fetched for BUILD.
  // 0240: a materials check maps the folder (documents only) FIRST — cheap — and fetches the plan's
  // assets only once it knows something changed.
  const assets = await gatherAssets(job, ctx, packageDir, jobDir, phase, progress, { mapOnly: job.refresh === true });
  if (assets.report) return assets.report;
  const attachments = assets.attachments;
  // 0240: what this build sees, and — when she asked for a materials check — nothing built if it is the same set.
  const manifestPath = path.join(packageDir, "drive", "DRIVE_MANIFEST.json");
  const materials = materialsFingerprint(existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null, attachments);
  if (unchangedMaterials(job, materials)) {
    progress("materials check: nothing new in the folder or attached — not rebuilding");
    return { phase, status: "unchanged", materials };
  }
  if (job.refresh === true) {
    const wantedAssets = driveStepFor(job, phase).fetch;
    if (wantedAssets.length) {
      const out = await fetchDriveAssets(path.join(packageDir, "drive"), wantedAssets, ctx, jobDir, progress);
      if (!out.ok) return { phase, status: "failed", reason: out.reason };
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
      const { stdout, stderr } = await sh(land, [String(job.pr.number ?? "")], { cwd: names.worktree, env: process.env, timeout: 30 * 60_000, signal: ctx.signal });
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
  let claude = await runClaude({ prompt, model: job.model, cwd: names.worktree, addDirs: [jobDir, packageDir].filter(existsSync), signal: ctx.signal, onLine: progress });
  writeFileSync(path.join(jobDir, `claude-${phase}.out`), `${claude.out}\n--- stderr ---\n${claude.err}`);
  let cost = costFrom(claude.out);

  let { result, problem } = readResult(existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "", phase);
  // A BUILD that needs another Drive asset names it; the script fetches it and runs the model ONCE more.
  const wanted = phase === "BUILD" && job.drive?.folder_id ? assetsRequested(result) : [];
  if (wanted.length) {
    const fetched = await fetchDriveAssets(path.join(packageDir, "drive"), wanted, ctx, jobDir, progress);
    if (!fetched.ok) return { phase, status: "failed", reason: fetched.reason };
    rmSync(resultPath, { force: true });
    claude = await runClaude({ prompt: `${prompt}\n\nFETCHED FOR YOU SINCE YOUR LAST TRY: ${wanted.join(", ")} — now in ${path.join(packageDir, "drive")}.`, model: job.model, cwd: names.worktree, addDirs: [jobDir, packageDir].filter(existsSync), signal: ctx.signal, onLine: progress });
    writeFileSync(path.join(jobDir, `claude-${phase}-2.out`), `${claude.out}\n--- stderr ---\n${claude.err}`);
    cost = (cost ?? 0) + (costFrom(claude.out) ?? 0);
    ({ result, problem } = readResult(existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "", phase));
  }
  if (!result) {
    return { phase, status: "failed", reason: `${phase} ended (claude exit ${claude.code}) but ${problem}${cost !== null ? ` — cost $${cost.toFixed(2)}` : ""}` };
  }
  if (result.status !== "ok") return { phase, status: result.status, reason: String(result.reason).slice(0, 1500) };

  if (phase === "PLAN") {
    writeFileSync(path.join(jobDir, "plan.md"), result.document);
    return { phase, status: "ok", document: result.document, decided: result.decided ?? [], asks: result.asks ?? [], publish_ready: result.publish_ready, placeholders: result.placeholders ?? [], missing_materials: result.missing_materials ?? [], assets: result.assets ?? [], notes: `${result.notes ?? ""}${cost !== null ? ` (cost $${cost.toFixed(2)})` : ""}`.trim() };
  }

  if (phase === "BUILD") {
    /*
     * DELIVERY CONFIG, BEFORE THE PR IS READ. The model asked by name; the script is what acts, and
     * what it observed is what goes in the proof. Nothing the model wrote about env vars is carried
     * forward — `configLines` is built entirely from `applyPagesEnv`'s return.
     */
    const configLines = await applyPagesEnv(result.pages_env, ctx.env, progress);
    // THE SCRIPT OBSERVES THE PR AND ITS CHECKS. The model's pr_url is a claim; gh is the fact.
    let pr;
    try {
      pr = await prFor(names.worktree, names.branch);
    } catch (err) {
      return { phase, status: "failed", reason: `the model reported a PR but gh finds none on ${names.branch}: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}` };
    }
    const checks = await watchChecks(names.worktree, pr.number, ctx.signal, progress);
    // The preview link is read AFTER the checks settle: Pages posts its deployment beside them.
    const previewUrl = checks.state === "GREEN" ? await previewUrlFor(names.worktree, pr.number, progress, job.pages_hosts ?? [], names.branch) : null;
    return {
      phase,
      status: "ok",
      pr_url: pr.url,
      pr_number: pr.number,
      branch: names.branch,
      materials,
      check_state: checks.state,
      check_url: checks.url ?? undefined,
      preview_url: previewUrl ?? undefined,
      // The model's own proof, then what the SCRIPT did about delivery config — in that order, so
      // a reader sees the claim and the observation side by side and can tell which is which.
      proof: [String(result.proof ?? "").slice(0, 8000), ...configLines].filter(Boolean).join("\n"),
      pages_env_proof: configLines,
      // What is still missing after this rebuild, re-checked against the re-mapped package (0237).
      ...(Array.isArray(result.missing_materials) ? { missing_materials: result.missing_materials } : {}),
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

// ── Several repos (0236) ─────────────────────────────────────────────────────────────────────

/** Attachments and the Drive folder, into the shared package dir. Returns { attachments } or { report }. */
async function gatherAssets(job, ctx, packageDir, jobDir, phase, progress, opts = {}) {
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
        return { report: { phase, status: "failed", reason: `could not fetch the attachment ${a.filename} from the OS: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` } };
      }
    }
  }
  const step = driveStepFor(job, phase);
  if (step.map) {
    if (!ctx.env?.GSC_SERVICE_ACCOUNT_JSON) return { report: { phase, status: "failed", reason: "GSC_SERVICE_ACCOUNT_JSON is not in the environment — the claimer must run under vault.mjs run" } };
    const driveDir = path.join(packageDir, "drive");
    progress(`mapping Drive folder ${job.drive.folder_id}`);
    try {
      // MAP, NEVER A WHOLE-FOLDER DOWNLOAD (owner, 23 Sep 2026): the manifest and the documents.
      const { stdout } = await sh("node", [PULL_SCRIPT, "--map", job.drive.folder_id, driveDir], { env: ctx.env, signal: ctx.signal });
      writeFileSync(path.join(jobDir, `drive-map-${phase}.log`), stdout);
      progress(stdout.trim().split("\n").pop() ?? "mapped");
    } catch (err) {
      const msg = `${err?.stderr ?? ""}${err?.stdout ?? ""}`.trim() || (err instanceof Error ? err.message : String(err));
      return { report: { phase, status: "blocked", reason: msg.slice(0, 800) } };
    }
    if (step.fetch.length && !opts.mapOnly) {
      const out = await fetchDriveAssets(driveDir, step.fetch, ctx, jobDir, progress);
      if (!out.ok) return { report: { phase, status: "failed", reason: out.reason } };
    }
  }
  return { attachments };
}

/**
 * WHAT DRIVE WORK A PHASE DOES (23 Sep 2026). A folder is RE-READ on every phase that needs the
 * materials — PLAN and BUILD — so a file she added after the plan is seen by the build. LAND needs
 * none. BUILD also fetches the assets the approved plan named. Pure, so it is self-tested.
 */
export function driveStepFor(job, phase) {
  const map = Boolean(job?.drive?.folder_id) && (phase === "PLAN" || phase === "BUILD");
  const fetch = map && phase === "BUILD" ? [...new Set((Array.isArray(job?.plan?.assets) ? job.plan.assets : []).map((a) => String(a).trim()).filter(Boolean))] : [];
  return { map, fetch };
}

/**
 * FETCH NAMED ASSETS ON THE MODEL'S BEHALF. The model never holds the Drive credential
 * (`claudeChildEnv` removes every vaulted name): it names what it needs, and this runs `pull.mjs --fetch` from the
 * duty script's own environment. A name the manifest does not know, or a file over the ceiling, is
 * refused by pull.mjs by name — and that refusal is the reason reported.
 */
async function fetchDriveAssets(driveDir, wanted, ctx, jobDir, progress) {
  progress(`fetching ${wanted.length} asset(s) from Drive`);
  try {
    const { stdout } = await sh("node", [PULL_SCRIPT, "--fetch", driveDir, ...wanted], { env: ctx.env, signal: ctx.signal });
    writeFileSync(path.join(jobDir, `drive-fetch-${Date.now()}.log`), stdout);
    return { ok: true };
  } catch (err) {
    const msg = `${err?.stderr ?? ""}${err?.stdout ?? ""}`.trim() || (err instanceof Error ? err.message : String(err));
    return { ok: false, reason: `could not fetch the Drive asset(s) ${wanted.join(", ")}: ${msg.slice(0, 600)}` };
  }
}

/**
 * A BUILD MAY ASK FOR MORE ASSETS, ONCE (23 Sep 2026). The plan named what it expected; a build that
 * finds it needs another file ends with `fetch: [paths]`. The script fetches them and runs the model
 * one more time — never a loop. Returns the list to fetch, or [] when the result is not asking.
 */
/**
 * THE MATERIAL SET, AS ONE STRING (0240): every Drive file's id, size and modified time from the
 * manifest, and every attachment on the card by id and size. Two builds that saw the same set have
 * the same fingerprint; a file added, replaced or attached changes it. Pure, so it is self-tested.
 */
export function materialsFingerprint(manifest, attachments) {
  const files = (Array.isArray(manifest?.files) ? manifest.files : []).map((f) => `d:${f.id}:${f.size ?? ""}:${f.modified ?? ""}`);
  const atts = (Array.isArray(attachments) ? attachments : []).map((a) => `a:${a.id ?? a.filename}:${a.bytes ?? ""}`);
  const all = [...files, ...atts].sort();
  let h = 0x811c9dc5;
  for (const ch of all.join("|")) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${all.length}:${h.toString(16).padStart(8, "0")}`;
}

/** A materials check she asked for that found the same set: build nothing (0240). Pure. */
export function unchangedMaterials(job, fingerprint) {
  return job?.phase === "BUILD" && job?.refresh === true && typeof job?.materials_fingerprint === "string" && job.materials_fingerprint.length > 0 && job.materials_fingerprint === fingerprint;
}

export function assetsRequested(result) {
  if (!result || result.status === "ok" || !Array.isArray(result.fetch)) return [];
  return [...new Set(result.fetch.map((x) => String(x ?? "").trim()).filter(Boolean))].slice(0, 40);
}

const costNote = (notes, cost) => `${notes ?? ""}${cost !== null ? ` (cost $${cost.toFixed(2)})` : ""}`.trim();

/**
 * ONE PHASE OF A MULTI-REPO JOB. Called by run() only after the LAND gate for a LAND job. Never
 * throws for a job-level failure; reports per repo what it did, so a partial LAND is resumable.
 */
async function runSeveral(job, ctx) {
  const progress = ctx.progress ?? (() => {});
  const phase = job.phase;
  const cardId = job.card?.id ?? "card";
  const parts = job.parts.map((p) => ({ ...p, repoPath: path.join(homedir(), "GitHub", String(p.repo ?? "")), names: namesFor(cardId, p.repo) }));
  const missing = parts.filter((p) => !p.repo || !existsSync(path.join(p.repoPath, ".git"))).map((p) => p.repoPath);
  if (missing.length) return { phase, status: "failed", reason: `not checked out on this Mac: ${missing.join(", ")}` };
  const jobDir = ctx.jobDir;
  mkdirSync(jobDir, { recursive: true });
  const packageDir = path.join(path.dirname(parts[0].names.worktree), `pkg-${namesFor(cardId).worktree.split("wt-").pop()}`);
  for (const p of parts) await ensureWorktree(p.repoPath, p.names, phase, progress);

  // EVERY REPO NEEDS ITS RUNBOOK. One missing is a block that names it; nothing is planned half.
  const noRunbook = parts.filter((p) => !existsSync(path.join(p.names.worktree, "RUNBOOK.md"))).map((p) => p.repo);
  if (noRunbook.length) {
    return { phase, status: "blocked", reason: `${noRunbook.join(" and ")} ${noRunbook.length === 1 ? "has" : "have"} no RUNBOOK.md. Write one (join-west-peek-main/RUNBOOK.md is the model), land it, then reply "go".` };
  }
  const assets = await gatherAssets(job, ctx, packageDir, jobDir, phase, progress, { mapOnly: job.refresh === true });
  if (assets.report) return assets.report;
  const worktrees = parts.map((p) => p.names.worktree);
  // 0240: the same materials check as one repo — one folder, one set, one answer for every repo.
  const manifestPath = path.join(packageDir, "drive", "DRIVE_MANIFEST.json");
  const materials = materialsFingerprint(existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null, assets.attachments);
  if (unchangedMaterials(job, materials)) return { phase, status: "unchanged", materials };
  if (job.refresh === true && driveStepFor(job, phase).fetch.length) {
    const out = await fetchDriveAssets(path.join(packageDir, "drive"), driveStepFor(job, phase).fetch, ctx, jobDir, progress);
    if (!out.ok) return { phase, status: "failed", reason: out.reason };
  }

  if (phase === "PLAN") {
    const resultPath = path.join(jobDir, "result-PLAN.json");
    if (existsSync(resultPath)) rmSync(resultPath);
    const prompt = `${readFileSync(PROMPT_FILE, "utf8")}\n${renderContext({ ...job, target_repo: parts.map((p) => p.repo).join(" + ") }, { ...parts[0].names, packageDir, jobDir, resultPath, planText: null, attachments: assets.attachments })}`;
    writeFileSync(path.join(jobDir, "prompt-PLAN.md"), prompt);
    progress(`claude -p (${job.model}) for PLAN over ${parts.length} repos`);
    const claude = await runClaude({ prompt, model: job.model, cwd: worktrees[0], addDirs: [...worktrees.slice(1), jobDir, packageDir].filter(existsSync), signal: ctx.signal, onLine: progress });
    writeFileSync(path.join(jobDir, "claude-PLAN.out"), `${claude.out}\n--- stderr ---\n${claude.err}`);
    const cost = costFrom(claude.out);
    const { result, problem } = readResult(existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "", "PLAN");
    if (!result) return { phase, status: "failed", reason: `PLAN ended (claude exit ${claude.code}) but ${problem}` };
    if (result.status !== "ok") return { phase, status: result.status, reason: String(result.reason).slice(0, 1500) };
    writeFileSync(path.join(jobDir, "plan.md"), result.document);
    return { phase, status: "ok", document: result.document, decided: result.decided ?? [], asks: result.asks ?? [], publish_ready: result.publish_ready, placeholders: result.placeholders ?? [], missing_materials: result.missing_materials ?? [], assets: result.assets ?? [], notes: costNote(result.notes, cost) };
  }

  if (phase === "BUILD") {
    const reports = [];
    const stillMissing = [];
    let anyRebuilt = false;
    for (const p of parts) {
      let proof = "";
      // A repo whose PR is already recorded GREEN is re-observed, never rebuilt.
      if (!(p.pr?.url && p.pr.check_state === "GREEN")) {
        const resultPath = path.join(jobDir, `result-BUILD-${p.repo}.json`);
        if (existsSync(resultPath)) rmSync(resultPath);
        const partJob = { ...job, target_repo: p.repo, property_host: p.property_host, sites: p.sites, request: `${job.request ?? job.ask ?? ""}\n\n(${p.repo}'s part: ${p.ask})` };
        const prompt = `${readFileSync(PROMPT_FILE, "utf8")}\n${renderContext(partJob, { ...p.names, packageDir, jobDir, resultPath, planText: job.plan?.text ?? null, attachments: assets.attachments, thisPart: p.repo })}`;
        writeFileSync(path.join(jobDir, `prompt-BUILD-${p.repo}.md`), prompt);
        progress(`claude -p (${job.model}) for BUILD of ${p.repo}`);
        let claude = await runClaude({ prompt, model: job.model, cwd: p.names.worktree, addDirs: [jobDir, packageDir].filter(existsSync), signal: ctx.signal, onLine: progress });
        writeFileSync(path.join(jobDir, `claude-BUILD-${p.repo}.out`), `${claude.out}\n--- stderr ---\n${claude.err}`);
        let { result, problem } = readResult(existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "", "BUILD");
        const wanted = job.drive?.folder_id ? assetsRequested(result) : [];
        if (wanted.length) {
          const fetched = await fetchDriveAssets(path.join(packageDir, "drive"), wanted, ctx, jobDir, progress);
          if (!fetched.ok) return { phase, status: "failed", reason: `${p.repo}: ${fetched.reason}`, parts: reports };
          rmSync(resultPath, { force: true });
          claude = await runClaude({ prompt: `${prompt}\n\nFETCHED FOR YOU SINCE YOUR LAST TRY: ${wanted.join(", ")} — now in ${path.join(packageDir, "drive")}.`, model: job.model, cwd: p.names.worktree, addDirs: [jobDir, packageDir].filter(existsSync), signal: ctx.signal, onLine: progress });
          ({ result, problem } = readResult(existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "", "BUILD"));
        }
        if (Array.isArray(result?.missing_materials)) stillMissing.push(...result.missing_materials);
        if (!result) return { phase, status: "failed", reason: `BUILD of ${p.repo} ended (claude exit ${claude.code}) but ${problem}`, parts: reports };
        if (result.status !== "ok") return { phase, status: result.status, reason: `${p.repo}: ${String(result.reason).slice(0, 1400)}`, parts: reports };
        const configLines = await applyPagesEnv(result.pages_env, ctx.env, progress);
        proof = [String(result.proof ?? "").slice(0, 6000), ...configLines].filter(Boolean).join("\n");
        anyRebuilt = true;
      }
      let pr;
      try {
        pr = await prFor(p.names.worktree, p.names.branch);
      } catch (err) {
        return { phase, status: "failed", reason: `gh finds no PR on ${p.names.branch} in ${p.repo}: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`, parts: reports };
      }
      const checks = await watchChecks(p.names.worktree, pr.number, ctx.signal, progress);
      const previewUrl = checks.state === "GREEN" ? await previewUrlFor(p.names.worktree, pr.number, progress, p.pages_hosts ?? [], p.names.branch) : null;
      reports.push({ repo: p.repo, pr_url: pr.url, pr_number: pr.number, branch: p.names.branch, check_state: checks.state, check_url: checks.url ?? undefined, preview_url: previewUrl ?? undefined, proof: proof || undefined });
    }
    const red = reports.filter((r) => r.check_state !== "GREEN");
    return {
      phase,
      status: "ok",
      pr_url: reports.map((r) => r.pr_url).join(" · "),
      materials,
      check_state: red.some((r) => r.check_state === "RED") ? "RED" : red.length ? "PENDING" : "GREEN",
      proof: reports.map((r) => `── ${r.repo} ──\n${r.proof ?? "(re-observed; built in an earlier run)"}`).join("\n\n"),
      parts: reports,
      // What is still missing after THIS rebuild, across every repo rebuilt (absent when none was).
      ...(anyRebuilt ? { missing_materials: stillMissing } : {}),
      reason: red.length ? `not every PR is green: ${red.map((r) => `${r.repo} ${r.check_state} (${r.pr_url})`).join(", ")}` : undefined,
    };
  }

  // LAND. The recorded gate passed in run(); now EVERY PR's checks are read again, live, and one
  // that is not green holds every repo. Only then does ~/bin/land run, one repo after another.
  const land = path.join(homedir(), "bin", "land");
  if (!existsSync(land)) return { phase, status: "failed", reason: `${land} is not on this Mac` };
  const states = [];
  for (const p of parts) {
    let merged = Boolean(p.merge_sha);
    if (!merged) {
      try {
        const j = JSON.parse((await sh("gh", ["pr", "view", String(p.pr.number), "--json", "state"], { cwd: p.names.worktree })).stdout);
        merged = j.state === "MERGED";
      } catch {
        /* unreadable is not merged */
      }
    }
    const checks = merged ? { state: "GREEN" } : await readChecksOnce(p.names.worktree, p.pr.number);
    states.push({ repo: p.repo, state: checks.state, merged });
  }
  const live = liveLandGate(states);
  if (!live.ok) return { phase, status: "failed", reason: `LAND refused: ${live.why}` };
  const landed = [];
  const outputs = [];
  for (const p of parts) {
    let mergeSha = p.merge_sha ?? null;
    if (!mergeSha) {
      progress(`landing ${p.repo}#${p.pr.number}`);
      try {
        const { stdout, stderr } = await sh(land, [String(p.pr.number)], { cwd: p.names.worktree, env: process.env, timeout: 30 * 60_000, signal: ctx.signal });
        outputs.push(`── ${p.repo} ──\n${stdout}\n${stderr}`);
      } catch (err) {
        const out = `${err?.stdout ?? ""}\n${err?.stderr ?? ""}`;
        return { phase, status: "failed", reason: `~/bin/land stopped on ${p.repo}${landed.length ? ` after ${landed.map((l) => l.repo).join(", ")} landed` : ""}: ${out.trim().split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 600)}`, parts: landed };
      }
      try {
        const j = JSON.parse((await sh("gh", ["pr", "view", String(p.pr.number), "--json", "mergeCommit,state"], { cwd: p.names.worktree })).stdout);
        mergeSha = j.mergeCommit?.oid ?? null;
        if (j.state !== "MERGED" || !mergeSha) return { phase, status: "failed", reason: `after land, gh says ${p.repo}#${p.pr.number} is ${j.state} with no merge commit`, parts: landed };
      } catch (err) {
        return { phase, status: "failed", reason: `could not read the merge of ${p.repo} from gh: ${err instanceof Error ? err.message : String(err)}`, parts: landed };
      }
    }
    landed.push({ repo: p.repo, merge_sha: mergeSha });
  }
  writeFileSync(path.join(jobDir, "land.log"), outputs.join("\n\n"));
  const resultPath = path.join(jobDir, "result-LAND.json");
  if (existsSync(resultPath)) rmSync(resultPath);
  const prompt = `${readFileSync(PROMPT_FILE, "utf8")}\n${renderContext({ ...job, target_repo: parts.map((p) => p.repo).join(" + ") }, { ...parts[0].names, packageDir, jobDir, resultPath, landOutput: outputs.join("\n\n"), mergeSha: landed.map((l) => `${l.repo}@${l.merge_sha}`).join(", "), attachments: assets.attachments })}`;
  writeFileSync(path.join(jobDir, "prompt-LAND.md"), prompt);
  const claude = await runClaude({ prompt, model: job.model, cwd: worktrees[0], addDirs: [...worktrees.slice(1), jobDir].filter(existsSync), signal: ctx.signal, onLine: progress });
  writeFileSync(path.join(jobDir, "claude-LAND.out"), `${claude.out}\n--- stderr ---\n${claude.err}`);
  const { result, problem } = readResult(existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "", "LAND");
  // Every PR merged either way; the proof is what is missing, and that is recorded as such.
  if (!result || result.status !== "ok") return { phase, status: "failed", reason: `every repo landed but the live proof did not come back: ${problem ?? result?.reason ?? "no result"}`, parts: landed };
  const perRepo = Array.isArray(result.parts) ? result.parts : [];
  for (const l of landed) l.live_proof = String(perRepo.find((x) => x?.repo === l.repo)?.live_proof ?? "").slice(0, 4000) || undefined;
  for (const p of parts) {
    try {
      await git(p.repoPath, "worktree", "remove", "--force", p.names.worktree);
      await git(p.repoPath, "branch", "-D", p.names.branch);
    } catch {
      /* a leftover worktree is untidy, not a failure */
    }
  }
  return { phase, status: "ok", merge_sha: landed.map((l) => `${l.repo}@${l.merge_sha}`).join(", "), live_proof: String(result.live_proof).slice(0, 8000), parts: landed, notes: costNote(result.notes, costFrom(claude.out)) };
}

/** One read of a PR's checks (no waiting): GREEN / RED / PENDING, as `gh` says it now. */
async function readChecksOnce(worktree, number) {
  try {
    const { stdout } = await sh("gh", ["pr", "checks", String(number), "--json", "name,state,link"], { cwd: worktree });
    return { state: checkStateOf(JSON.parse(stdout)) };
  } catch (err) {
    try {
      return { state: checkStateOf(JSON.parse(String(err?.stdout ?? ""))) };
    } catch {
      return { state: "PENDING" };
    }
  }
}

// ── Self-test ────────────────────────────────────────────────────────────────────────────────

function selfTest() {
  const approved = { plan: { approved_at: "2026-09-20T10:00:00Z" }, pr: { url: "https://github.com/x/y/pull/1", number: 1, check_state: "GREEN", check_green_at: "2026-09-20T11:00:00Z" } };
  const cases = [
    // 23 Sep 2026: the job names the exact site folders it may change; none known -> stop and ask.
    ...(() => {
      const paths = { worktree: "/w", branch: "b", packageDir: "/p", jobDir: "/j", resultPath: "/r", attachments: [] };
      const ctx = (property_host, sites) => renderContext({ phase: "PLAN", card: { id: "wc", title: "t" }, property_host, sites, target_repo: "join-west-peek-main", request: "r", drive: {}, rules: {} }, paths);
      return [
        ["SITES: one site -> only that folder, and ventures is not in a community job's scope", () => /SITES: sites\/community — change files ONLY under these folders/.test(ctx("joinwestpeek.com", ["sites/community"])) && !ctx("joinwestpeek.com", ["sites/community"]).includes("sites/ventures")],
        ["SITES: several sites in one repo -> one job over every folder", () => ctx("westpeekproductions.com, joinwestpeek.com", ["sites/productions", "sites/community"]).includes("SITES: sites/productions, sites/community — change files ONLY")],
        ["SITES: none known -> BLOCK and ask which site", () => /SITES: \(unresolved .*BLOCK and ask which site/.test(ctx(null, []))],
      ];
    })(),
    // 23 Sep 2026 (0236): ONE JOB OVER SEVERAL REPOS lands all or nothing.
    ...(() => {
      const part = (repo, n, state = "GREEN", green = "2026-09-23T11:00:00Z") => ({ repo, property_host: repo, sites: ["."], ask: "x", pr: { url: `https://github.com/seq23/${repo}/pull/${n}`, number: n, check_state: state, check_green_at: green }, merge_sha: null });
      const multi = { plan: { approved_at: "2026-09-23T10:00:00Z" }, pr: { url: "a · b", number: null, check_state: "GREEN", check_green_at: "2026-09-23T11:00:00Z" }, parts: [part("join-west-peek-main", 7), part("westpeek-live", 84)] };
      const t = renderContext({ phase: "PLAN", card: { id: "wc_abc12345", title: "t" }, target_repo: "join-west-peek-main + westpeek-live", sites: ["sites/community", "."], parts: multi.parts, request: "r", drive: {}, rules: {} }, { worktree: "/w", branch: "b", packageDir: "/p", jobDir: "/j", resultPath: "/r", attachments: [] });
      return [
        ["MULTI LAND passes when every repo's PR is recorded green (no top-level PR number needed)", () => landGate(multi).ok === true],
        ["MULTI LAND refuses when ONE repo is RED — and names it; nothing lands, not even the green one", () => {
          const g = landGate({ ...multi, parts: [part("join-west-peek-main", 7), part("westpeek-live", 84, "RED", null)] });
          return g.ok === false && /westpeek-live RED/.test(g.why) && g.blocking.length === 1 && g.blocking[0] === "westpeek-live";
        }],
        ["MULTI LAND refuses a repo with no PR number", () => landGate({ ...multi, parts: [part("join-west-peek-main", 7), { ...part("westpeek-live", 84), pr: { ...part("westpeek-live", 84).pr, number: null } }] }).ok === false],
        ["MULTI LAND refuses a repo with a GREEN state but no recorded green time", () => landGate({ ...multi, parts: [part("join-west-peek-main", 7), part("westpeek-live", 84, "GREEN", null)] }).ok === false],
        ["MULTI LAND still refuses without the plan approval", () => landGate({ ...multi, plan: { approved_at: null } }).ok === false],
        ["MULTI LAND still needs the second approval when it previews first", () => landGate({ ...multi, plan: { ...multi.plan, preview_only: true } }).ok === false && landGate({ ...multi, plan: { ...multi.plan, preview_only: true }, pr: { ...multi.pr, land_approved_at: "2026-09-23T12:00:00Z" } }).ok === true],
        ["the LIVE gate: every PR green right now → lands", () => liveLandGate([{ repo: "a", state: "GREEN", merged: false }, { repo: "b", state: "GREEN", merged: false }]).ok === true],
        ["the LIVE gate: one PR went red since it was recorded → none lands, and it is named", () => {
          const g = liveLandGate([{ repo: "a", state: "GREEN", merged: false }, { repo: "b", state: "RED", merged: false }]);
          return g.ok === false && g.blocking[0] === "b" && /b RED/.test(g.why);
        }],
        ["the LIVE gate: a PENDING check holds them all too", () => liveLandGate([{ repo: "a", state: "PENDING", merged: false }, { repo: "b", state: "GREEN", merged: false }]).ok === false],
        ["the LIVE gate: a repo merged by an earlier attempt is not re-checked (a resumed LAND never lands twice)", () => liveLandGate([{ repo: "a", state: "RED", merged: true }, { repo: "b", state: "GREEN", merged: false }]).ok === true],
        ["the LIVE gate: nothing checked is never ok", () => liveLandGate([]).ok === false],
        ["one worktree per repo, same branch name", () => namesFor("wc_abc12345", "westpeek-live").worktree !== namesFor("wc_abc12345", "join-west-peek-main").worktree && namesFor("wc_abc12345", "westpeek-live").branch === namesFor("wc_abc12345").branch && namesFor("wc_abc12345").worktree.endsWith("wt-abc12345")],
        ["a multi-repo PLAN prompt lists every repo, its worktree and its part, and asks for ONE plan", () => t.includes("REPOS: this ONE job spans 2 repos") && t.includes("- westpeek-live (westpeek-live)") && t.includes("wt-abc12345-westpeek-live") && t.includes("PLAN every repo above in ONE plan document")],
        ["a single-repo prompt has no REPOS block", () => !renderContext({ phase: "PLAN", card: { id: "wc", title: "t" }, sites: ["sites/community"], request: "r", rules: {} }, { worktree: "/w", branch: "b", packageDir: "/p", jobDir: "/j", resultPath: "/r" }).includes("REPOS:")],
        ["a site that IS its repo says so on the SITES line", () => /^\. \(the repo root/.test(sitesLine(["."]))],
      ];
    })(),
    ["LAND passes with a recorded approval and a recorded green", () => landGate(approved).ok === true],
    ["LAND refuses without a plan approval", () => landGate({ ...approved, plan: { approved_at: null } }).ok === false],
    ["LAND refuses without a green check", () => landGate({ ...approved, pr: { ...approved.pr, check_green_at: null } }).ok === false],
    ["LAND refuses a job whose PR has no number — `land \"\"` is never run", () => landGate({ ...approved, pr: { ...approved.pr, number: null } }).ok === false],
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
    ["THE REAL BOT COMMENT (wc_c9e36e8b, 23 Sep 2026): one clean link — the community project's branch alias — never HTML fragments or the other sites' previews", () => {
      const comment = [
        "## Deploying with &nbsp;<a href=\"https://pages.dev\"><img alt=\"Cloudflare workers\" src=\"x\" width=\"16\"></a> &nbsp;Cloudflare Pages",
        "<table><tr><td><strong>Latest commit:</strong> </td><td><code>3f2a1b9</code></td></tr>",
        "<tr><td><strong>Status:</strong></td><td>&nbsp;✅&nbsp; Deploy successful!</td></tr>",
        "<tr><td><strong>Preview URL:</strong></td><td><a href='https://3f2a1b9c.west-peek-community.pages.dev'>https://3f2a1b9c.west-peek-community.pages.dev</a></td></tr>",
        "<tr><td><strong>Branch Preview URL:</strong></td><td><a href='https://work-wpc-c9e36e8b.west-peek-community.pages.dev'>https://work-wpc-c9e36e8b.west-peek-community.pages.dev&lt;/a></td></tr></table>",
      ].join("\n");
      const ventures = comment.replaceAll("west-peek-community", "west-peek-ventures").replace("3f2a1b9c", "11aa22bb");
      const productions = comment.replaceAll("west-peek-community", "west-peek-productions").replace("3f2a1b9c", "33cc44dd");
      const got = previewUrlsFrom([], [comment, ventures, productions], ["west-peek-community.pages.dev"], "work/wpc-c9e36e8b");
      return got === "https://work-wpc-c9e36e8b.west-peek-community.pages.dev";
    }],
    ["only the hash URL in the comment: still the branch alias for the site's project, never the hash", () => previewUrlsFrom([], ["<a href='https://3f2a1b9c.west-peek-community.pages.dev'>https://3f2a1b9c.west-peek-community.pages.dev</a>"], ["west-peek-community.pages.dev"], "work/wpc-c9e36e8b") === "https://work-wpc-c9e36e8b.west-peek-community.pages.dev"],
    ["with no project known, a hash URL is kept once, with no trailing fragment", () => previewUrlsFrom([], ["<a href='https://3f2a1b9c.west-peek-community.pages.dev'>https://3f2a1b9c.west-peek-community.pages.dev&lt;/a>"], [], "") === "https://3f2a1b9c.west-peek-community.pages.dev"],
    ["a preview under another site's Pages project is never this job's preview", () => previewUrlsFrom([], ["https://11aa22bb.west-peek-ventures.pages.dev"], ["west-peek-community.pages.dev"], "b") === null],
    ["a Cloudflare PR comment yields the preview url", () => previewUrlsFrom([], ["Deploying with Cloudflare Pages\n| Preview URL | https://def456.ventures.pages.dev |"]) === "https://def456.ventures.pages.dev"],
    ["a Workers Builds PR comment yields the version preview url", () => previewUrlsFrom([], ["| Preview URL | https://3f9a1c2e-west-peek-live.seq-taylor.workers.dev |"]) === "https://3f9a1c2e-west-peek-live.seq-taylor.workers.dev"],
    ["the production workers.dev host is never read as a preview", () => previewUrlsFrom([], ["deployed to https://west-peek-live.seq-taylor.workers.dev"]) === null],
    ["a repo with no Pages deployment yields null, never a guess", () => previewUrlsFrom([{ environment_url: "" }], ["LGTM"]) === null],
    ["an ask without a recommended default is refused", () => readResult(JSON.stringify({ phase: "PLAN", status: "ok", document: "# Plan\n".padEnd(60, "x"), asks: ["colour?"], publish_ready: true }), "PLAN").result === null],
    ["all-success checks are GREEN", () => checkStateOf([{ state: "SUCCESS" }, { state: "SKIPPED" }]) === "GREEN"],
    ["one failure makes RED", () => checkStateOf([{ state: "SUCCESS" }, { state: "FAILURE" }]) === "RED"],
    ["a pending check is PENDING", () => checkStateOf([{ state: "SUCCESS" }, { state: "PENDING" }]) === "PENDING"],
    ["no checks is PENDING, not green", () => checkStateOf([]) === "PENDING"],
    ["names are stable and safe", () => namesFor("wc_ABC-123_def").branch === "work/wpc-abc123de" && !namesFor("../x").worktree.includes("..")],
    ["the claude child never sees a vaulted secret or an API key, keeps the ordinary environment, and the NAMES withheld are reported", () => {
      let told = [];
      const e = claudeChildEnv({ PATH: "/bin", HOME: "/h", SSH_AUTH_SOCK: "/s", [VAULT_INJECTED_VAR]: "CLOUDFLARE_API_TOKEN,RESEND_API_KEY", CLOUDFLARE_API_TOKEN: "cf", RESEND_API_KEY: "re", ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_BASE_URL: "https://x", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o" }, (n) => (told = n), new Set());
      return Object.keys(e).sort().join() === "HOME,PATH,SSH_AUTH_SOCK" && told.join() === "ANTHROPIC_API_KEY,ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL,CLAUDE_CODE_OAUTH_TOKEN,CLOUDFLARE_API_TOKEN,RESEND_API_KEY" && !strippedNote(told).includes("cf");
    }],
    ["the model's Bash may not run vault.mjs or read the Keychain", () => MODEL_DENIED_TOOLS.includes("Bash(*vault.mjs*)") && MODEL_DENIED_TOOLS.includes("Bash(security:*)") && /"--disallowedTools", \.\.\.MODEL_DENIED_TOOLS/.test(readFileSync(fileURLToPath(import.meta.url), "utf8"))],
    ["a pre-approved job tells the model to decide everything", () => renderContext({ phase: "PLAN", card: { id: "wc_1", title: "T" }, ask: "x", pre_approved: "your call" }, { worktree: "/w", branch: "b", packageDir: "/p", jobDir: "/j", resultPath: "/j/r.json" }).includes('PRE-APPROVED: the partner wrote "your call"')],
    ["the context names the result path and the ask", () => {
      const t = renderContext({ phase: "PLAN", card: { id: "wc_1", title: "T" }, request: "add a page", rules: { land_on_green: "on" } }, { worktree: "/w", branch: "b", packageDir: "/p", jobDir: "/j", resultPath: "/j/result-PLAN.json" });
      return t.includes("RESULT_PATH: /j/result-PLAN.json") && t.includes("REQUEST (the partner's own words") && t.includes("add a page") && t.includes("land_on_green: on");
    }],
    ["the context lists attachments and says when no folder came", () => {
      const t = renderContext({ phase: "PLAN", card: { id: "wc_1", title: "T" }, request: "the photo is attached", rules: {} }, { worktree: "/w", branch: "b", packageDir: "/p", jobDir: "/j", resultPath: "/j/r.json", attachments: [{ filename: "sensori.jpg", media_type: "image/jpeg", bytes: 1234, path: "/p/attachments/sensori.jpg" }] });
      return t.includes("ATTACHMENTS: sensori.jpg (image/jpeg, 1234 bytes) → /p/attachments/sensori.jpg") && t.includes("DRIVE_FOLDERS: none in the request");
    }],
    ["a BUILD may request delivery config BY NAME", () => {
      const r = readResult(JSON.stringify({ phase: "BUILD", status: "ok", pr_url: "https://x/pull/1", pages_env: [{ project: "west-peek-ventures", name: "RESEND_API_KEY" }] }), "BUILD").result;
      return r?.pages_env?.[0]?.name === "RESEND_API_KEY";
    }],
    ["a pages_env entry carrying a VALUE is refused outright", () => readResult(JSON.stringify({ phase: "BUILD", status: "ok", pr_url: "https://x/pull/1", pages_env: [{ project: "west-peek-ventures", name: "RESEND_API_KEY", value: "re_live" }] }), "BUILD").result === null],
    ["a pages_env that is not a list is refused", () => readResult(JSON.stringify({ phase: "BUILD", status: "ok", pr_url: "https://x/pull/1", pages_env: "all of them" }), "BUILD").result === null],
    ["a pages_env entry without a project is refused", () => readResult(JSON.stringify({ phase: "BUILD", status: "ok", pr_url: "https://x/pull/1", pages_env: [{ name: "LEAD_TO" }] }), "BUILD").result === null],
    ["the allow-list accepts only the three projects and the three variables", () => {
      return (
        classify("west-peek-ventures", "RESEND_API_KEY").kind === "secret" &&
        classify("join-west-peek-main", "EMAIL_FROM").kind === "plain" &&
        classify("west-peek-productions", "LEAD_TO").kind === "plain" &&
        classify("some-other-site", "LEAD_TO").ok === false &&
        classify("west-peek-ventures", "ANTHROPIC_API_KEY").ok === false &&
        classify("west-peek-ventures", "").ok === false
      );
    }],
    ["an off-list request is REFUSED and recorded, never silently dropped", () => {
      const { allowed, refused } = readRequests([{ project: "someone-elses-site", name: "EMAIL_FROM" }, { project: "west-peek-ventures", name: "LEAD_TO" }]);
      return allowed.length === 1 && allowed[0].name === "LEAD_TO" && refused.length === 1 && refused[0].project === "someone-elses-site";
    }],
    ["a proof line carries the project, the NAME and an outcome — and has no room for a value", () => {
      const line = proofLine("west-peek-ventures", "RESEND_API_KEY", "set");
      return line === "pages-env: west-peek-ventures · RESEND_API_KEY · set" && proofLine("x", "y", "pwned").includes("· failed");
    }],
    // 23 Sep 2026 (0237): Drive is MAPPED on every phase that needs materials, assets are fetched
    // on the model's behalf, and the package's own files outrank its stale checklists.
    ["PLAN maps the folder and fetches nothing yet", () => { const d = driveStepFor({ drive: { folder_id: "F" } }, "PLAN"); return d.map === true && d.fetch.length === 0; }],
    ["BUILD RE-MAPS the folder (a file added after the plan is seen) and fetches the plan's assets, once each", () => { const d = driveStepFor({ drive: { folder_id: "F" }, plan: { assets: ["logos/sengo.svg", " logos/sengo.svg", "fonts/maax.otf"] } }, "BUILD"); return d.map === true && d.fetch.join("|") === "logos/sengo.svg|fonts/maax.otf"; }],
    ["LAND reads no Drive; no folder means no Drive work at all", () => !driveStepFor({ drive: { folder_id: "F" } }, "LAND").map && !driveStepFor({ drive: {} }, "BUILD").map && driveStepFor({ drive: {} }, "BUILD").fetch.length === 0],
    ["the material set changes when a Drive file is added, replaced or modified, or a file is attached — and not otherwise", () => {
      const m = { files: [{ id: "a", size: 10, modified: "t1" }, { id: "b", size: 20, modified: "t1" }] };
      const base = materialsFingerprint(m, []);
      return base === materialsFingerprint({ files: [...m.files].reverse() }, []) &&
        base !== materialsFingerprint({ files: [...m.files, { id: "c", size: 1, modified: "t2" }] }, []) &&
        base !== materialsFingerprint({ files: [{ id: "a", size: 10, modified: "t2" }, m.files[1]] }, []) &&
        base !== materialsFingerprint(m, [{ id: "att_1", bytes: 5 }]);
    }],
    ["a materials check that finds the same set builds nothing; without a check, or with a new set, it builds", () =>
      unchangedMaterials({ phase: "BUILD", refresh: true, materials_fingerprint: "2:abc" }, "2:abc") &&
      !unchangedMaterials({ phase: "BUILD", refresh: false, materials_fingerprint: "2:abc" }, "2:abc") &&
      !unchangedMaterials({ phase: "BUILD", refresh: true, materials_fingerprint: "2:abc" }, "3:def") &&
      !unchangedMaterials({ phase: "BUILD", refresh: true, materials_fingerprint: null }, "2:abc") &&
      !unchangedMaterials({ phase: "LAND", refresh: true, materials_fingerprint: "2:abc" }, "2:abc")],
    ["a stale approval never lands on the Mac: approved before the latest preview, or publish with no green build after it", () => {
      const job = { plan: { approved_at: "t0", publish_ready: false }, pr: { url: "u", number: 1, check_state: "GREEN", check_green_at: "2026-09-23T12:00:00Z", land_approved_at: "2026-09-23T12:05:00Z", preview_emailed_at: "2026-09-23T12:01:00Z" } };
      const stale = { ...job, pr: { ...job.pr, preview_emailed_at: "2026-09-23T12:10:00Z" } };
      const publishNoBuild = { ...job, pr: { ...job.pr, publish_approved_at: "2026-09-23T12:05:00Z" } };
      const publishBuilt = { ...job, pr: { ...job.pr, publish_approved_at: "2026-09-23T12:05:00Z", check_green_at: "2026-09-23T12:30:00Z" } };
      return landGate(job).ok && !landGate(stale).ok && !landGate(publishNoBuild).ok && landGate(publishBuilt).ok;
    }],
    ["a BUILD asking for more assets is read; an ok result is never a fetch request", () => assetsRequested({ status: "failed", reason: "needs assets", fetch: ["ep1/headshot.jpg", "ep1/headshot.jpg", ""] }).join() === "ep1/headshot.jpg" && assetsRequested({ status: "ok", fetch: ["x"] }).length === 0 && assetsRequested(null).length === 0],
    ["the model's child never holds the Drive credential", () => !("GSC_SERVICE_ACCOUNT_JSON" in claudeChildEnv({ PATH: "/bin", GSC_SERVICE_ACCOUNT_JSON: "{}", [VAULT_INJECTED_VAR]: "GSC_SERVICE_ACCOUNT_JSON" }, undefined, new Set())) && claudeChildEnv({ PATH: "/bin" }, undefined, new Set()).PATH === "/bin"],
    ["a job with a folder tells the model the manifest, that documents are here, how assets arrive, and the PACKAGE TRUTH rule", () => {
      const paths = { worktree: "/w", branch: "b", packageDir: "/p", jobDir: "/j", resultPath: "/r", attachments: [] };
      const plan = renderContext({ phase: "PLAN", card: { id: "wc", title: "t" }, drive: { folder_id: "F", folder_url: "https://drive.google.com/drive/folders/F" }, request: "r", rules: {} }, paths);
      const build = renderContext({ phase: "BUILD", card: { id: "wc", title: "t" }, drive: { folder_id: "F" }, request: "r", rules: {}, plan: { decided: [], asks: [], answers: [] } }, paths);
      return plan.includes("DRIVE_MANIFEST: /p/drive/DRIVE_MANIFEST.json") && plan.includes("DOCUMENTS: every document (fetched: true) is already in /p/drive") && plan.includes("List every manifest path the build will use in `assets`") && plan.includes(PACKAGE_TRUTH_RULE) && build.includes('`fetch: ["<manifest path>"') && build.includes(PACKAGE_TRUTH_RULE) && !build.includes("pulled into");
    }],
    ["a job with no folder says so and carries no manifest lines", () => { const t = renderContext({ phase: "PLAN", card: { id: "wc", title: "t" }, drive: {}, request: "r", rules: {} }, { worktree: "/w", branch: "b", packageDir: "/p", jobDir: "/j", resultPath: "/r" }); return t.includes("DRIVE_FOLDERS: none in the request") && !t.includes("DRIVE_MANIFEST"); }],
    ["the PACKAGE TRUTH rule says: check the manifest, files outweigh documents, follow the one that declares precedence", () => /check DRIVE_MANIFEST\.json/.test(PACKAGE_TRUTH_RULE) && /present outweighs any document saying it is absent/.test(PACKAGE_TRUTH_RULE) && /declares precedence/.test(PACKAGE_TRUTH_RULE) && /never ask/.test(PACKAGE_TRUTH_RULE)],
    ["the prompt file carries the PACKAGE TRUTH rule and the missing-materials and assets fields", () => { const p = readFileSync(PROMPT_FILE, "utf8"); return p.includes("**PACKAGE TRUTH:**") && p.includes("outweighs any document saying it is absent") && p.includes('"missing_materials"') && p.includes('"assets"') && p.includes("RE-MAPPED for this"); }],
    ["missing_materials must name the item AND where it goes; assets and fetch must be paths", () =>
      readResult(JSON.stringify({ phase: "PLAN", status: "ok", document: "# Plan\n".padEnd(60, "x"), publish_ready: true, missing_materials: [{ item: "Sengo logo" }] }), "PLAN").result === null &&
      readResult(JSON.stringify({ phase: "PLAN", status: "ok", document: "# Plan\n".padEnd(60, "x"), publish_ready: true, missing_materials: [{ item: "Sengo logo", where: "portfolio grid" }], assets: ["logos/a.svg"] }), "PLAN").result?.missing_materials?.[0]?.where === "portfolio grid" &&
      readResult(JSON.stringify({ phase: "PLAN", status: "ok", document: "# Plan\n".padEnd(60, "x"), publish_ready: true, assets: [3] }), "PLAN").result === null &&
      readResult(JSON.stringify({ phase: "BUILD", status: "failed", reason: "needs assets", fetch: "all" }), "BUILD").result === null],
    ["Drive is only ever MAPPED or FETCHED by name — never a whole-folder download", () => {
      const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
      const calls = [...src.matchAll(/\[PULL_SCRIPT,\s*("[^"]*"|[A-Za-z_.?]+)/g)].map((m) => m[1]);
      return calls.length >= 2 && calls.every((a) => a === '"--map"' || a === '"--fetch"');
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
