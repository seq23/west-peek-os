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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CLOUDFLARE_ACCOUNT_ID, classify, proofLine, readRequests } from "./lib/pages-delivery.mjs";
import { VAULT_INJECTED_VAR, claudeChildEnv, envForRepoRun, strippedNote, vaultLookup } from "../lib/vault-env.mjs";
import { constraintsIn, generateRunbook, hostFromRoutes, likelySecrets, porterMayRun, readWranglerJson, readWranglerToml, runbookSecretNames, secretNamesInSource, vendorPageFor } from "./lib/runbook.mjs";
import { detectUsageLimit } from "../lib/seat-usage-limit.mjs";
import { codexExecArgs, codexSeatUsable, gitCommonDirs, helpMentions, runWithCodexFallback } from "../lib/codex-seat.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROMPT_FILE = path.join(REPO_ROOT, "scripts", "duties", "web-property-change-prompt.md");
const PULL_SCRIPT = path.join(REPO_ROOT, "scripts", "drive", "pull.mjs");
const PUSH_SCRIPT = path.join(REPO_ROOT, "scripts", "drive", "push.mjs");
/** The script's own platform credentials, passed to a RUNBOOK-named script that targets preview or production (never to the model). */
const PLATFORM_RUN_NAMES = Object.freeze(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
/** A file for the partner bigger than this is shared from Drive, not attached (the Worker's cap, mirrored). */
const ATTACH_MAX_BYTES = 10 * 1024 * 1024;

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
  if (!["ok", "blocked", "failed", "needs_runs"].includes(parsed.status)) return { result: null, problem: `the result has no status (got "${parsed.status}")` };
  if (parsed.status !== "ok" && parsed.status !== "needs_runs" && !(typeof parsed.reason === "string" && parsed.reason.trim())) return { result: null, problem: `a ${parsed.status} result must say why` };
  // 0253: the model asks the SCRIPT to run the repo's own scripts — name, env and plain args; never a shell line.
  if (parsed.status === "needs_runs" || parsed.runs !== undefined) {
    if (!Array.isArray(parsed.runs) || parsed.runs.length === 0) return { result: null, problem: "needs_runs must carry runs: [{ script, env, args }]" };
    for (const r of parsed.runs) {
      if (!r || typeof r !== "object" || !String(r.script ?? "").trim()) return { result: null, problem: "every run names a script from the RUNBOOK's ## Porter may run" };
      if (!["local", "preview", "production"].includes(r.env)) return { result: null, problem: "every run says env: local, preview or production" };
      if (r.args !== undefined && !(Array.isArray(r.args) && r.args.every((a) => typeof a === "string"))) return { result: null, problem: "a run's args is a list of strings" };
      if (/[;&|`$<>\n]/.test(`${r.script}${(r.args ?? []).join("")}`)) return { result: null, problem: "a run carries no shell characters" };
    }
  }
  if (parsed.deliverables !== undefined && !(Array.isArray(parsed.deliverables) && parsed.deliverables.every((d) => (typeof d === "string" && d.trim()) || (d && typeof d === "object" && String(d.path ?? "").trim())))) return { result: null, problem: "deliverables is a list of file paths (or { path, filename })" };
  if (parsed.missing_secrets !== undefined && !(Array.isArray(parsed.missing_secrets) && parsed.missing_secrets.every((n) => typeof n === "string" && /^[A-Z][A-Z0-9_]{2,}$/.test(n)))) return { result: null, problem: "missing_secrets is a list of SCREAMING_SNAKE names — never a value" };
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
    ...(job.due?.due_at ? [`DUE: ${job.due.due_at} (the partner's words: "${job.due.due_words ?? ""}") — plan the fastest safe path; if the whole ask cannot land by then, build what can, ship it, and say per item what is realistic`] : []),
    ...(Array.isArray(job.constraints) && job.constraints.length ? [`REGISTERED_CONSTRAINTS (from earlier jobs on this repo; standing): ${job.constraints.map((c) => `· ${c}`).join(" ")}`] : []),
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
    // 0253: what the script read from the repo and the registry — the scripts the model may ask for,
    // the keys by NAME and whether each is held, where to put files for the partner, what already ran.
    ...(Array.isArray(paths.extraLines) ? ["", ...paths.extraLines] : []),
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
  lines.push(...rebuildBlock(job));
  if (paths.landOutput) lines.push("", "WHAT ~/bin/land PRINTED:", "```", paths.landOutput.slice(-6000), "```", `MERGE SHA: ${paths.mergeSha ?? "(unknown)"}`);
  return lines.join("\n");
}

/**
 * A REBUILD AFTER THE PREVIEW IS THE CHANGE, NOT A RE-CHECK (28 Sep 2026). Scooter looked at the
 * preview and wrote "I don't know if people know they can scroll on the flyers to kinda make that
 * thing". The Worker read it as a change and queued a BUILD; this script's prompt listed it as one
 * answer among five, the model found a branch that already had commits, "verified it is real
 * rather than re-doing it", changed nothing and reported ok — and Porter re-sent the same preview.
 * The block below puts the partner's words at the front as THIS RUN'S WHOLE JOB, and the script
 * fails the run if the branch head did not move (`inertRebuild`). Pure, self-tested.
 */
export function rebuildBlock(job) {
  if (job?.phase !== "BUILD" || job?.rebuild?.intent !== "CHANGES") return [];
  const words = String(job.rebuild.changes ?? "").trim() || "(the partner's words did not come through — read THE PARTNER'S ANSWERS, the last one is the change)";
  return [
    "",
    "REBUILD AFTER THE PREVIEW — THIS RUN'S WHOLE JOB IS THE CHANGE BELOW.",
    `The partner looked at the preview${job.rebuild.since ? ` sent ${job.rebuild.since}` : ""} and wrote this. A remark, a worry or a question about how the site behaves IS a design change to make (e.g. "I don't know if people know they can scroll on the flyers" = make the scrolling discoverable: a cue, arrows, a peek). It is not a note to acknowledge and not a reason to re-verify the last build. The PR and branch already exist: make the change on top of them, commit, push, prove it. The script compares the branch head before and after your turn — a run that ends with no new commit FAILS.`,
    "```",
    words,
    "```",
  ];
}

/** True when a CHANGES rebuild ended with the branch head where it started: nothing was built for the partner's words. Pure. */
export function inertRebuild(job, headBefore, headAfter) {
  return job?.phase === "BUILD" && job?.rebuild?.intent === "CHANGES" && typeof headBefore === "string" && headBefore.length > 0 && headBefore === headAfter;
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

/**
 * THE LINES THE MODEL READS ABOUT THE REPO (0253): the scripts it may ask the script to run, every key
 * by NAME and whether the firm holds it, where to put files for the partner, what already ran. Held
 * outside renderContext on purpose: the prompt is built from the job and from what the SCRIPT read,
 * never from the environment.
 */
function repoLines(book, secrets, outDir, runsDone) {
  const held = [...secrets.lookup.found, ...Object.entries(secrets.lookup.by_vendor).map(([want, have]) => `${want} → ${have.join("/")}`)];
  return [
    `RUNBOOK: ${book.file}${book.generated ? " (GENERATED this run from package.json/wrangler and committed on the branch — read it, improve it if the repo tells you more)" : ""}`,
    `PORTER_MAY_RUN (ask the script with status "needs_runs" and runs: [{ script, env, args }]; it runs \`npm run <script> -- <args>\` and records each): ${book.mayRun.length ? book.mayRun.join(", ") : "nothing is listed under ## Porter may run"}`,
    `SECRETS_HELD (by name; the firm holds a value and injects it where the RUNBOOK says — never ask a partner for these): ${held.length ? held.join(", ") : "none of the names the repo reads"}`,
    `SECRETS_MISSING (the firm holds NO value; do NOT block — build everything else, keep the feature behind it ready, and list each name in missing_secrets; the partner is told how to email it): ${secrets.missing.length ? secrets.missing.map((m) => m.name).join(", ") : "none"}`,
    `SEARCHED: ${secrets.lookup.searched.join(", ") || "nothing (the RUNBOOK lists no secrets and the source reads none)"}`,
    `DELIVERABLES_DIR: ${outDir} — write any file the partner should receive (an export, a QR code) here and list it in "deliverables"; the script puts it on the card and the email attaches it (≤ 10 MB) or links it; mark one { "path", "private": true } when it carries personal data (voter emails, an export) and it goes to the partner's Drive only`,
    `PARTNER_CONSTRAINTS (standing, from this repo's README/PRD and the registry — obey every one without restating it or asking about it): ${(book.constraints ?? []).length ? (book.constraints ?? []).map((c) => `· ${c}`).join(" ") : "none recorded yet"}`,
    ...(runsDone.length ? [`RUNS_DONE: ${runsDone.map((r) => `${r.script} (${r.env}) → exit ${r.exit}: ${r.line}`).join("; ")}`] : []),
  ];
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

/**
 * Run the phase's model in the worktree: Claude Code, and — ONLY when Claude Code reports its plan is
 * out of usage — Codex on her ChatGPT Plus seat, in the same worktree with the same prompt (29 Sep
 * 2026). The phase reads its result from a FILE the model writes, so which model wrote it does not
 * change how the phase is judged. Any other Claude failure is the phase's failure, unchanged.
 */
async function runClaude(opts) {
  return runWithCodexFallback({
    runClaude: () => spawnClaude(opts),
    runCodex: () => spawnCodex(opts),
    limited: claudeSpentUsage,
    codexLimited: codexSpentUsage,
    usable: () => codexSeatUsable(homedir()),
    supports: codexLacks,
    addDirs: opts.addDirs ?? [],
    onLine: opts.onLine,
  });
}

/**
 * BOTH SEATS SPENT IS A WAIT, NOT A FAILURE (1 Oct 2026). When Claude Code and Codex both report a spent plan the
 * phase did nothing wrong and no attempt should be charged to it: the report says how long until the earlier plan
 * resets (`waits_seconds`) and the Worker holds the card until then. Null when the run was anything else.
 */
export function spentReport(phase, claude) {
  if (!claude?.bothSpent) return null;
  const waits = Number.isFinite(claude.resetsInSeconds) && claude.resetsInSeconds > 0 ? Math.round(claude.resetsInSeconds) : 3600;
  return { phase, status: "failed", reason: String(claude.err ?? "Both subscription seats are out of usage.").split("\n").filter((l) => /Both subscription seats/.test(l)).join(" ").slice(0, 900) || "Both subscription seats are out of usage.", waits_seconds: waits };
}

/**
 * Did Codex stop because its plan's usage is spent? The words, or null. `codex exec` prints its final
 * message on stdout and may exit 0 while telling you the plan is out, so a short stdout is read as well
 * as stderr; long output is an answer and is never inspected (see detectUsageLimit).
 */
export function codexSpentUsage({ out, err }) {
  const hit = detectUsageLimit({ stdout: out, stderr: err });
  return hit.limited ? hit.snippet : null;
}

/**
 * Did Claude Code stop because its plan's usage is spent? Returns the notice's own words, or null.
 * A run whose JSON says `is_error: false` is a success whatever it printed; only a failed or
 * unreadable run is inspected, and `detectUsageLimit` never inspects long output.
 */
export function claudeSpentUsage({ out, err }) {
  try {
    const j = JSON.parse(out);
    if (j && j.is_error === false) return null;
    const hit = detectUsageLimit({ stdout: typeof j?.result === "string" ? j.result : "", stderr: err });
    return hit.limited ? hit.snippet : null;
  } catch {
    const hit = detectUsageLimit({ stdout: out, stderr: err });
    return hit.limited ? hit.snippet : null;
  }
}

/** The first flag the installed `codex exec --help` does not mention, or null when it supports them all. */
async function codexLacks(flags) {
  let help = "";
  try {
    const r = await execFileAsync("codex", ["exec", "--help"], { maxBuffer: 4 * 1024 * 1024, timeout: 20_000, env: claudeChildEnv(process.env) });
    help = `${r.stdout}\n${r.stderr}`;
  } catch (e) {
    help = `${e?.stdout ?? ""}\n${e?.stderr ?? ""}`;
  }
  if (!help.trim()) return "`codex exec` (the codex command could not be run)";
  return flags.find((f) => !helpMentions(help, f)) ?? null;
}

/** `git rev-parse --git-common-dir` for a directory, or null when it is not inside a repository. */
async function gitCommonDirOf(dir) {
  try {
    const r = await execFileAsync("git", ["-C", dir, "rev-parse", "--git-common-dir"], { timeout: 15_000 });
    return String(r.stdout).trim() || null;
  } catch {
    return null;
  }
}

/** Run `codex exec` in the worktree with the same prompt on stdin, killable by the job's signal. */
async function spawnCodex({ prompt, cwd, addDirs, signal, onLine }) {
  // The worktree's commits are written into the ORIGINAL repository's .git, outside every folder the
  // sandbox would otherwise let Codex write — so each repository's git directory is named too.
  const dirs = [cwd, ...(addDirs ?? [])];
  const found = await Promise.all(dirs.map((d) => gitCommonDirOf(d)));
  const gitDirs = gitCommonDirs(dirs, (d) => found[dirs.indexOf(d)]);
  const writable = [...new Set([...(addDirs ?? []), ...gitDirs])];
  return new Promise((resolve) => {
    let withheld = [];
    const child = spawn("codex", codexExecArgs(writable), { cwd, stdio: ["pipe", "pipe", "pipe"], env: claudeChildEnv(process.env, (names) => (withheld = names)) });
    onLine?.(strippedNote(withheld));
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += String(d);
      onLine?.(`codex: ${out.length} bytes`);
    });
    child.stderr.on("data", (d) => (err += String(d)));
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => resolve({ code: -1, out, err: `${err}\n${e.message}\n${strippedNote(withheld)}` }));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, out, err: code === 0 ? err : `${err}\n${strippedNote(withheld)}` });
    });
    child.stdin.end(prompt);
  });
}

/** Run `claude -p` in the worktree with the prompt, killable by the job's signal. */
function spawnClaude({ prompt, model, cwd, addDirs, signal, onLine }) {
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

/** The branch head in the worktree, or null when git cannot say (a failed read never fakes "changed"). */
async function headOf(worktree) {
  try {
    const { stdout } = await sh("git", ["rev-parse", "HEAD"], { cwd: worktree });
    return stdout.trim() || null;
  } catch {
    return null;
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
export async function applyPagesEnv(pagesEnv, env, progress, registry = null) {
  const { allowed, refused } = readRequests(pagesEnv, registry);
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
  if (!job.target_repo) return { phase, status: "failed", reason: "the job names no target repo" };
  // 0253: a repo the registry knows but this Mac does not have yet is cloned, never refused.
  const checkout = await ensureCheckout(repoPath, job.github_repo ?? null, progress);
  if (!checkout.ok) return { phase, status: "failed", reason: checkout.why };
  const names = namesFor(job.card?.id ?? "card");
  const jobDir = ctx.jobDir;
  mkdirSync(jobDir, { recursive: true });
  const packageDir = path.join(path.dirname(names.worktree), `pkg-${path.basename(names.worktree).replace(/^wt-/, "")}`);
  const resultPath = path.join(jobDir, `result-${phase}.json`);
  if (existsSync(resultPath)) rmSync(resultPath);

  await ensureWorktree(repoPath, names, phase, progress);

  // THE RUNBOOK IS THE AUTHORITY FOR THE TARGET REPO. Absent → GENERATED from the repo's own
  // package.json and wrangler config and committed on the job's branch (0253) — never a block.
  const book = await ensureRunbook(names.worktree, job.target_repo, job.github_repo ?? null, progress);
  // THE VAULT IS CHECKED FIRST (0253): every name the RUNBOOK lists or the source reads, by name then by vendor.
  const secrets = secretsFor(book, job);

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
  // 28 Sep 2026: where the branch stands before the model's turn — a CHANGES rebuild must move it.
  const headBefore = phase === "BUILD" ? await headOf(names.worktree) : null;
  const outDir = path.join(jobDir, "out");
  mkdirSync(outDir, { recursive: true });
  const runsDone = [];
  const extraLines = repoLines(book, secrets, outDir, runsDone);
  const prompt = `${readFileSync(PROMPT_FILE, "utf8")}\n${renderContext(job, { ...names, packageDir, jobDir, resultPath, planText, landOutput, mergeSha, attachments, extraLines })}`;
  writeFileSync(path.join(jobDir, `prompt-${phase}.md`), prompt);
  progress(`claude -p (${job.model}) for ${phase}`);
  let claude = await runClaude({ prompt, model: job.model, cwd: names.worktree, addDirs: [jobDir, packageDir].filter(existsSync), signal: ctx.signal, onLine: progress });
  writeFileSync(path.join(jobDir, `claude-${phase}.out`), `${claude.out}\n--- stderr ---\n${claude.err}`);
  let cost = costFrom(claude.out);

  let { result, problem } = readResult(existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "", phase);
  // 0253: THE SCRIPT RUNS THE REPO'S OWN SCRIPTS FOR THE MODEL — RUNBOOK-named only, recorded, bounded.
  for (let round = 0; round < 3 && result?.status === "needs_runs"; round += 1) {
    const done = await applyRuns(result.runs, book.mayRun, names.worktree, ctx.env, secrets.allowed, progress);
    runsDone.push(...done);
    rmSync(resultPath, { force: true });
    const again = `${readFileSync(PROMPT_FILE, "utf8")}\n${renderContext(job, { ...names, packageDir, jobDir, resultPath, planText, landOutput, mergeSha, attachments, extraLines: repoLines(book, secrets, outDir, runsDone) })}\n\nRUNS DONE FOR YOU SINCE YOUR LAST TRY: ${done.map((d) => `${d.script} (${d.env}) → exit ${d.exit}: ${d.line}`).join("; ")}`;
    claude = await runClaude({ prompt: again, model: job.model, cwd: names.worktree, addDirs: [jobDir, packageDir].filter(existsSync), signal: ctx.signal, onLine: progress });
    writeFileSync(path.join(jobDir, `claude-${phase}-runs${round + 1}.out`), `${claude.out}\n--- stderr ---\n${claude.err}`);
    cost = (cost ?? 0) + (costFrom(claude.out) ?? 0);
    ({ result, problem } = readResult(existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "", phase));
  }
  if (result?.status === "needs_runs") result = { ...result, status: "failed", reason: "asked for runs three times without finishing" };
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
  const spent = !result ? spentReport(phase, claude) : null;
  if (spent) return spent;
  if (!result) {
    return { phase, status: "failed", reason: `${phase} ended (claude exit ${claude.code}) but ${problem}${cost !== null ? ` — cost $${cost.toFixed(2)}` : ""}` };
  }
  // 0253: what every report carries — the repo's facts, the vault lookup (names), the keys still
  // missing, the runs, the files put on the card. Composed by the SCRIPT from what it observed.
  const carried = await carriedFacts({ book, secrets, result, runsDone, job, outDir, worktree: names.worktree, env: ctx.env, progress, phase });
  if (result.status !== "ok") return { phase, status: result.status, reason: String(result.reason).slice(0, 1500), ...carried };

  if (phase === "PLAN") {
    writeFileSync(path.join(jobDir, "plan.md"), result.document);
    return { phase, status: "ok", document: result.document, decided: result.decided ?? [], asks: result.asks ?? [], publish_ready: result.publish_ready, placeholders: result.placeholders ?? [], missing_materials: result.missing_materials ?? [], assets: result.assets ?? [], ...carried, notes: `${result.notes ?? ""}${cost !== null ? ` (cost $${cost.toFixed(2)})` : ""}`.trim() };
  }

  if (phase === "BUILD") {
    // A REBUILD THAT MOVED NOTHING FAILS HERE, before any PR is read or any preview is sent.
    const headAfter = await headOf(names.worktree);
    if (inertRebuild(job, headBefore, headAfter)) {
      return { phase, status: "failed", reason: `the rebuild made no commit for the partner's words: "${String(job.rebuild.changes ?? "").slice(0, 200)}" — the branch head is still ${headBefore.slice(0, 12)}. A remark about the site is a change to make, not a note to acknowledge.` };
    }
    /*
     * DELIVERY CONFIG, BEFORE THE PR IS READ. The model asked by name; the script is what acts, and
     * what it observed is what goes in the proof. Nothing the model wrote about env vars is carried
     * forward — `configLines` is built entirely from `applyPagesEnv`'s return.
     */
    const configLines = await applyPagesEnv(result.pages_env, ctx.env, progress, registryAllowance(book, secrets));
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
      // 28 Sep 2026: the script's own observation — did this run move the branch, and to where.
      changed: headBefore !== null && headAfter !== null && headBefore !== headAfter,
      head_sha: headAfter ?? undefined,
      check_state: checks.state,
      check_url: checks.url ?? undefined,
      preview_url: previewUrl ?? undefined,
      // The model's own proof, then what the SCRIPT did about delivery config — in that order, so
      // a reader sees the claim and the observation side by side and can tell which is which.
      proof: [String(result.proof ?? "").slice(0, 8000), ...configLines, ...runLines(runsDone), ...(carried.dns_proof ?? [])].filter(Boolean).join("\n"),
      pages_env_proof: configLines,
      // What is still missing after this rebuild, re-checked against the re-mapped package (0237).
      ...(Array.isArray(result.missing_materials) ? { missing_materials: result.missing_materials } : {}),
      ...carried,
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
  return { phase, status: "ok", merge_sha: mergeSha, live_proof: [String(result.live_proof).slice(0, 8000), ...runLines(runsDone), ...(carried.dns_proof ?? [])].filter(Boolean).join("\n"), ...carried, notes: `${result.notes ?? ""}${cost !== null ? ` (cost $${cost.toFixed(2)})` : ""}`.trim() };
}

// ── Any repo she names (0253) ────────────────────────────────────────────────────────────────

/** A checkout under ~/GitHub, cloned from GitHub when this Mac does not have it. */
async function ensureCheckout(repoPath, githubRepo, progress) {
  if (existsSync(path.join(repoPath, ".git"))) return { ok: true, cloned: false };
  if (!githubRepo) return { ok: false, why: `${repoPath} is not checked out and the registry names no GitHub repo to clone it from` };
  progress(`cloning ${githubRepo} → ${repoPath}`);
  try {
    mkdirSync(path.dirname(repoPath), { recursive: true });
    await sh("gh", ["repo", "clone", githubRepo, repoPath, "--", "-q"], { timeout: 15 * 60_000 });
  } catch (err) {
    return { ok: false, why: `gh repo clone ${githubRepo} failed: ${String(err?.stderr ?? err?.message ?? err).trim().split("\n").slice(-2).join(" | ").slice(0, 300)}` };
  }
  if (!existsSync(path.join(repoPath, ".git"))) return { ok: false, why: `gh repo clone ${githubRepo} left no checkout at ${repoPath}` };
  return { ok: true, cloned: true };
}

/** Source files whose `env.X` reads name the repo's secrets — bounded walk, text files only. */
function sourceTexts(root, max = 400) {
  const out = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", ".wrangler", "coverage", "public", "assets", "vendor"]);
  const walk = (dir, depth) => {
    if (out.length >= max || depth > 5) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.isDirectory()) {
        if (!skip.has(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name), depth + 1);
      } else if (/\.(m?js|ts|tsx|jsx|toml|json)$/.test(e.name) && !/lock/.test(e.name)) {
        try {
          const st = statSync(path.join(dir, e.name));
          if (st.size <= 512 * 1024) out.push(readFileSync(path.join(dir, e.name), "utf8"));
        } catch {
          /* unreadable: skipped */
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

/** What the repo declares about itself: package.json, wrangler config, the names its source reads. */
function repoFactsOf(worktree) {
  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(path.join(worktree, "package.json"), "utf8"));
  } catch {
    pkg = null;
  }
  let wrangler = null;
  if (existsSync(path.join(worktree, "wrangler.toml"))) wrangler = readWranglerToml(readFileSync(path.join(worktree, "wrangler.toml"), "utf8"));
  else if (existsSync(path.join(worktree, "wrangler.jsonc"))) wrangler = readWranglerJson(readFileSync(path.join(worktree, "wrangler.jsonc"), "utf8"));
  else if (existsSync(path.join(worktree, "wrangler.json"))) wrangler = readWranglerJson(readFileSync(path.join(worktree, "wrangler.json"), "utf8"));
  const sourceNames = secretNamesInSource(sourceTexts(worktree));
  // Addendum 2: the partner's standing constraints, from the package's README / PRD / RUNBOOK prose.
  const docs = [];
  for (const name of readdirSafe(worktree).filter((n) => /^(readme|prd|runbook|brief|spec)[^/]*\.(md|txt)$/i.test(n))) {
    try {
      docs.push(readFileSync(path.join(worktree, name), "utf8"));
    } catch {
      /* unreadable: skipped */
    }
  }
  const constraints = constraintsIn(docs);
  const host = hostFromRoutes(wrangler?.routes ?? []);
  const pagesProject = wrangler?.pages_build_output_dir ? wrangler.name ?? null : null;
  return { pkg, wrangler, sourceNames, host, pagesProject, pagesHost: pagesProject ? `${pagesProject}.pages.dev` : null, constraints };
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * THE RUNBOOK, read — or generated from the repo's own config and committed on the job's branch when
 * there is none (0253). Returns what the duty needs from it: the scripts a job may run, the secret
 * NAMES it lists, and the repo's facts for the registry.
 */
async function ensureRunbook(worktree, repo, githubRepo, progress) {
  const file = path.join(worktree, "RUNBOOK.md");
  const facts = repoFactsOf(worktree);
  let generated = false;
  if (!existsSync(file)) {
    const gen = generateRunbook({ repo, githubRepo, pkg: facts.pkg, wrangler: facts.wrangler, sourceNames: sourceTexts(worktree), hostHint: facts.host });
    writeFileSync(file, gen.text);
    try {
      await git(worktree, "add", "RUNBOOK.md");
      await git(worktree, "commit", "-q", "-m", `RUNBOOK.md: generated by Porter from package.json and wrangler config (deploy: ${gen.route.kind})`);
      generated = true;
      progress(`RUNBOOK.md generated for ${repo} (deploy route: ${gen.route.kind}) and committed on the branch`);
    } catch (err) {
      progress(`RUNBOOK.md generated for ${repo} but not committed: ${String(err?.message ?? err).slice(0, 160)}`);
    }
  }
  const text = readFileSync(file, "utf8");
  return { file, text, generated, mayRun: porterMayRun(text), secretNames: runbookSecretNames(text), facts, repo, githubRepo, constraints: facts.constraints ?? [] };
}

/**
 * THE VAULT, FIRST (0253). Every name the RUNBOOK lists under ## Secrets, every secret-shaped name the
 * source reads, and anything the model named as missing — looked up by exact name, then by vendor
 * prefix. `allowed` is what a run or a Pages secret may inject; `missing` is what the next partner
 * email names with the SECRET line that sends it. Names only, never a value.
 */
function secretsFor(book, job, extraNames = []) {
  const wanted = [...new Set([...(book?.secretNames ?? []), ...likelySecrets(book?.facts?.sourceNames ?? []), ...(Array.isArray(job?.secret_names) ? job.secret_names : []), ...extraNames])];
  const lookup = vaultLookup(wanted);
  return {
    lookup,
    allowed: lookup.allowed,
    missing: lookup.missing.map((name) => ({ name, vendor_url: vendorPageFor(name), searched: lookup.searched })),
  };
}

/** The registry's allowance for `applyPagesEnv`: the repo's own Pages project and the names it may set. */
function registryAllowance(book, secrets) {
  const project = book?.facts?.pagesProject ?? null;
  return project ? { project, names: secrets?.allowed ?? [] } : null;
}

/** One proof line per run — script, env, exit, one line of output. Never an environment value. */
function runLines(runsDone) {
  return (runsDone ?? []).map((r) => `run: ${r.script} · ${r.env} · exit ${r.exit}${r.line ? ` · ${r.line.slice(0, 200)}` : ""}`);
}

/**
 * RUN THE REPO'S OWN SCRIPTS FOR THE MODEL. Only a name under the RUNBOOK's ## Porter may run; only
 * `npm run <name> -- <plain args>`; never a shell; the environment is the model's plus the registry's
 * allowed names (and the platform token for preview/production). Each run is recorded whatever
 * happened; a refusal is recorded too, so the model can see it and say so.
 */
async function applyRuns(requests, mayRun, worktree, env, allowedNames, progress) {
  const done = [];
  for (const r of Array.isArray(requests) ? requests : []) {
    const script = String(r?.script ?? "").trim();
    const runEnv = ["local", "preview", "production"].includes(r?.env) ? r.env : "local";
    const args = Array.isArray(r?.args) ? r.args.map(String) : [];
    if (!mayRun.includes(script)) {
      done.push({ script, env: runEnv, exit: -1, line: "refused: not listed under ## Porter may run in RUNBOOK.md" });
      progress(`run refused: ${script} (not under ## Porter may run)`);
      continue;
    }
    if (args.some((a) => /[;&|`$<>\n]/.test(a))) {
      done.push({ script, env: runEnv, exit: -1, line: "refused: shell characters in args" });
      continue;
    }
    progress(`npm run ${script} -- ${args.join(" ")} (${runEnv})`);
    const names = runEnv === "local" ? allowedNames : [...new Set([...allowedNames, ...PLATFORM_RUN_NAMES])];
    try {
      const { stdout, stderr } = await execFileAsync("npm", ["run", script, "--", ...args], { cwd: worktree, env: { ...envForRepoRun(env, names), CI: "1" }, timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 });
      done.push({ script, env: runEnv, exit: 0, line: lastLine(`${stdout}\n${stderr}`) });
    } catch (err) {
      done.push({ script, env: runEnv, exit: typeof err?.code === "number" ? err.code : 1, line: lastLine(`${err?.stdout ?? ""}\n${err?.stderr ?? ""}\n${err?.message ?? ""}`) });
    }
  }
  return done;
}

function lastLine(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !/^npm (warn|notice)/i.test(l) && !/^> /.test(l));
  return (lines.at(-1) ?? "").slice(0, 300);
}

const MEDIA_TYPES = { csv: "text/csv", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", pdf: "application/pdf", json: "application/json", txt: "text/plain", md: "text/markdown", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", zip: "application/zip", svg: "image/svg+xml", html: "text/html" };

/**
 * FILES FOR THE PARTNER, put on the card (0253). Each named deliverable under JOB_DIR/out or the
 * worktree is PUT to the Worker (raw bytes) when it fits the attachment cap, or pushed to Drive and
 * shared with the partner as reader and recorded as a link when it does not. Never a path outside
 * those two directories.
 */
async function putDeliverables(result, job, outDir, worktree, env, progress) {
  const out = [];
  const base = env?.WP_OS_BASE_URL ?? "https://os.joinwestpeek.com";
  const id = env?.WP_OS_MAC_ACCESS_CLIENT_ID;
  const secret = env?.WP_OS_MAC_ACCESS_CLIENT_SECRET;
  for (const d of Array.isArray(result?.deliverables) ? result.deliverables : []) {
    const given = typeof d === "string" ? d : String(d?.path ?? "");
    const file = path.isAbsolute(given) ? given : existsSync(path.join(outDir, given)) ? path.join(outDir, given) : path.join(worktree, given);
    const inside = [outDir, worktree].some((root) => path.resolve(file).startsWith(path.resolve(root) + path.sep));
    if (!inside || !existsSync(file)) {
      out.push({ filename: path.basename(given), bytes: 0, via: "refused", drive_url: null, why: inside ? "no such file" : "outside the job's directories" });
      continue;
    }
    const filename = String((typeof d === "object" && d?.filename) || path.basename(file)).slice(0, 200);
    const bytes = statSync(file).size;
    // Addendum 8: a file with personal data (voter emails, an export) is shared from Drive to the requesting partner only — never the store, never an attachment.
    const privateOnly = typeof d === "object" && d?.private === true;
    const mediaType = MEDIA_TYPES[path.extname(filename).slice(1).toLowerCase()] ?? "application/octet-stream";
    if (!id || !secret) {
      out.push({ filename, bytes, via: "refused", drive_url: null, why: "the Mac's Access token is not in the environment" });
      continue;
    }
    const headers = { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret, "x-wp-filename": encodeURIComponent(filename) };
    try {
      if (bytes <= ATTACH_MAX_BYTES && !privateOnly) {
        const res = await fetch(`${base}/api/work-cards/${job.card?.id}/files`, { method: "POST", headers: { ...headers, "content-type": mediaType }, body: readFileSync(file), signal: AbortSignal.timeout(180_000) });
        if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
        out.push({ filename, bytes, via: "r2", drive_url: null });
        progress(`file on the card: ${filename} (${bytes} bytes)`);
      } else {
        const { stdout } = await execFileAsync("node", [PUSH_SCRIPT, "--file", file, "--name", filename, "--share", String(job.card?.requested_by ?? "")], { env, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 });
        const link = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}").url;
        if (!link) throw new Error("push.mjs returned no link");
        const res = await fetch(`${base}/api/work-cards/${job.card?.id}/files`, { method: "POST", headers: { ...headers, "content-type": "application/json", "x-wp-drive": "1" }, body: JSON.stringify({ drive_url: link, bytes }), signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
        out.push({ filename, bytes, via: "drive", drive_url: link });
        progress(`file shared from Drive: ${filename} (${bytes} bytes)`);
      }
    } catch (err) {
      out.push({ filename, bytes, via: "refused", drive_url: null, why: String(err?.message ?? err).slice(0, 200) });
      progress(`file NOT delivered: ${filename} — ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }
  return out;
}

/**
 * A HOST OUTSIDE HER ZONES (0253). For a repo whose config names a Pages project and whose host the
 * registry or the config names: is the apex a zone in the firm's account? If so Cloudflare adds the
 * record itself when the domain is attached. If not: the project is created when missing, the custom
 * domain is attached through the API, and the record Cloudflare requires is READ BACK — the project's
 * own `subdomain` is the CNAME target, `validation_data` carries any TXT — never composed from a
 * template. Returns [] when there is nothing to do; a failed API call is one proof line, never a stop.
 */
async function ensurePagesDomain(book, job, env, progress) {
  const project = book?.facts?.pagesProject;
  const hosts = [...new Set([String(job.property_host ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)), book?.facts?.host].flat().filter(Boolean))];
  const token = env?.CLOUDFLARE_API_TOKEN;
  if (!project || !hosts.length || !token) return { dns: [], lines: [] };
  const api = async (pathname, init = {}) => {
    const res = await fetch(`${CF_API}${pathname}`, { ...init, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(60_000) });
    const body = await res.json().catch(() => null);
    return { ok: res.ok && body?.success !== false, status: res.status, result: body?.result ?? null, errors: body?.errors ?? [] };
  };
  const dns = [];
  const lines = [];
  for (const host of hosts) {
    try {
      const apex = host.split(".").slice(-2).join(".");
      const zone = await api(`/zones?name=${encodeURIComponent(apex)}&per_page=1`);
      const onZone = Boolean(zone.ok && Array.isArray(zone.result) && zone.result.length);
      let proj = await api(`/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${encodeURIComponent(project)}`);
      if (!proj.ok && proj.status === 404) {
        proj = await api(`/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects`, { method: "POST", body: JSON.stringify({ name: project, production_branch: "main" }) });
        lines.push(`pages-project: ${project} · ${proj.ok ? "created" : "could not be created"}`);
      }
      if (!proj.ok) {
        lines.push(`pages-domain: ${host} · failed (project ${project}: ${proj.errors?.[0]?.message ?? proj.status})`);
        continue;
      }
      const subdomain = String(proj.result?.subdomain ?? "");
      const existing = (await api(`/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${encodeURIComponent(project)}/domains`)).result ?? [];
      let dom = Array.isArray(existing) ? existing.find((d) => String(d?.name ?? "").toLowerCase() === host) ?? null : null;
      if (!dom) {
        const added = await api(`/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${encodeURIComponent(project)}/domains`, { method: "POST", body: JSON.stringify({ name: host }) });
        if (!added.ok) {
          lines.push(`pages-domain: ${host} · failed (${added.errors?.[0]?.message ?? added.status})`);
          continue;
        }
        dom = added.result;
      }
      // THE RECORD, FROM THE ANSWER: a CNAME at the host's label to the project's own subdomain, and the TXT if Cloudflare asked for one.
      const label = host.endsWith(`.${apex}`) ? host.slice(0, -(apex.length + 1)) : "@";
      const validation = dom?.validation_data ?? {};
      const record = {
        host,
        project,
        record_type: "CNAME",
        record_name: label,
        record_target: subdomain,
        txt_name: validation?.method === "txt" ? validation?.txt_name ?? null : null,
        txt_value: validation?.method === "txt" ? validation?.txt_value ?? null : null,
        status: String(dom?.status ?? "pending"),
        on_zone: onZone,
      };
      if (!record.record_target) {
        lines.push(`pages-domain: ${host} · failed (Cloudflare returned no subdomain for ${project}; nothing emailed)`);
        continue;
      }
      dns.push(record);
      lines.push(`pages-domain: ${host} · ${onZone ? "on a firm zone — Cloudflare holds the record" : `outside the firm's zones — CNAME ${label} → ${subdomain}${record.txt_name ? ` + TXT ${record.txt_name}` : ""}`} · ${record.status}`);
      progress?.(lines.at(-1));
    } catch (err) {
      lines.push(`pages-domain: ${host} · failed (${String(err?.message ?? err).slice(0, 160)})`);
    }
  }
  return { dns, lines };
}

/** The 0253 fields every report carries, composed from what the script read and did — never from the model's claims. */
async function carriedFacts({ book, secrets, result, runsDone, job, outDir, worktree, env, progress, phase }) {
  const more = Array.isArray(result?.missing_secrets) ? result.missing_secrets : [];
  const all = more.length ? secretsFor(book, job, more) : secrets;
  const deliverables = phase === "PLAN" ? [] : await putDeliverables(result, job, outDir, worktree, env, progress);
  const domain = phase === "PLAN" || result?.status !== "ok" ? { dns: [], lines: [] } : await ensurePagesDomain(book, job, env, progress);
  return {
    vault_lookup: { searched: all.lookup.searched, found: all.lookup.found, missing: all.lookup.missing },
    missing_secrets: all.missing,
    ...(domain.dns.length ? { dns: domain.dns } : {}),
    ...(domain.lines.length ? { dns_proof: domain.lines } : {}),
    ...(runsDone.length ? { runs: runsDone } : {}),
    ...(deliverables.length ? { deliverables: deliverables.map((d) => ({ filename: d.filename, bytes: d.bytes, via: d.via, drive_url: d.drive_url ?? null })) } : {}),
    repo_facts: { repo: book.repo, host: book.facts.host, pages_host: book.facts.pagesHost, secret_names: all.allowed, github_repo: book.githubRepo ?? null, runbook_generated: book.generated, constraints: book.facts.constraints ?? [] },
    // Addenda 5 + 6: dated deferred work and per-item done-lines, as the model wrote them (validated shapes).
    ...(Array.isArray(result?.deferred) ? { deferred: result.deferred.filter((d) => d && typeof d === "object" && String(d.ask ?? "").trim() && /^\d{4}-\d{2}-\d{2}/.test(String(d.due_at ?? ""))).map((d) => ({ ask: String(d.ask).slice(0, 1200), due_at: String(d.due_at), words: d.words ? String(d.words).slice(0, 200) : undefined })) } : {}),
    ...(Array.isArray(result?.items) ? { items: result.items.filter((i) => i && typeof i === "object" && String(i.item ?? "").trim() && ["done", "partial", "not_done"].includes(i.state)).map((i) => ({ item: String(i.item).slice(0, 200), state: i.state, note: i.note ? String(i.note).slice(0, 300) : undefined })) } : {}),
  };
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
  for (const p of parts) {
    if (!p.repo) return { phase, status: "failed", reason: "a part names no repo" };
    const checkout = await ensureCheckout(p.repoPath, p.github_repo ?? null, progress);
    if (!checkout.ok) return { phase, status: "failed", reason: checkout.why };
  }
  const jobDir = ctx.jobDir;
  mkdirSync(jobDir, { recursive: true });
  const packageDir = path.join(path.dirname(parts[0].names.worktree), `pkg-${namesFor(cardId).worktree.split("wt-").pop()}`);
  for (const p of parts) await ensureWorktree(p.repoPath, p.names, phase, progress);

  // EVERY REPO READS ITS RUNBOOK; one without is generated from its own config (0253), never a block.
  for (const p of parts) {
    p.book = await ensureRunbook(p.names.worktree, p.repo, p.github_repo ?? null, progress);
    p.secrets = secretsFor(p.book, job);
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
    const prompt = `${readFileSync(PROMPT_FILE, "utf8")}\n${renderContext({ ...job, target_repo: parts.map((p) => p.repo).join(" + ") }, { ...parts[0].names, packageDir, jobDir, resultPath, planText: null, attachments: assets.attachments, extraLines: parts.flatMap((p) => [`--- ${p.repo} ---`, ...repoLines(p.book, p.secrets, path.join(jobDir, "out"), [])]) })}`;
    writeFileSync(path.join(jobDir, "prompt-PLAN.md"), prompt);
    progress(`claude -p (${job.model}) for PLAN over ${parts.length} repos`);
    const claude = await runClaude({ prompt, model: job.model, cwd: worktrees[0], addDirs: [...worktrees.slice(1), jobDir, packageDir].filter(existsSync), signal: ctx.signal, onLine: progress });
    writeFileSync(path.join(jobDir, "claude-PLAN.out"), `${claude.out}\n--- stderr ---\n${claude.err}`);
    const cost = costFrom(claude.out);
    const { result, problem } = readResult(existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "", "PLAN");
    if (!result && spentReport(phase, claude)) return spentReport(phase, claude);
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
        const prompt = `${readFileSync(PROMPT_FILE, "utf8")}\n${renderContext(partJob, { ...p.names, packageDir, jobDir, resultPath, planText: job.plan?.text ?? null, attachments: assets.attachments, thisPart: p.repo, extraLines: repoLines(p.book, p.secrets, path.join(jobDir, "out"), []) })}`;
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
        if (!result && spentReport(phase, claude)) return { ...spentReport(phase, claude), parts: reports };
        if (!result) return { phase, status: "failed", reason: `BUILD of ${p.repo} ended (claude exit ${claude.code}) but ${problem}`, parts: reports };
        if (result.status !== "ok") return { phase, status: result.status, reason: `${p.repo}: ${String(result.reason).slice(0, 1400)}`, parts: reports };
        const configLines = await applyPagesEnv(result.pages_env, ctx.env, progress, registryAllowance(p.book, p.secrets));
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
    // 28 Sep 2026: a rebuild after the preview is the change, not a re-check.
    ["a CHANGES rebuild puts the partner's words at the front as THIS RUN'S WHOLE JOB", () => {
      const paths = { worktree: "/w", branch: "b", packageDir: "/p", jobDir: "/j", resultPath: "/r", attachments: [] };
      const job = { phase: "BUILD", card: { id: "wc", title: "t" }, target_repo: "join-west-peek-main", request: "r", drive: {}, rules: {}, plan: { decided: [], asks: [], answers: ["a", "I don't know if people know they can scroll on the flyers"] }, pr: { url: "https://x/pull/24", number: 24 }, rebuild: { intent: "CHANGES", changes: "I don't know if people know they can scroll on the flyers", since: "2026-09-28T00:34:58Z" } };
      const t = renderContext(job, paths);
      return t.includes("REBUILD AFTER THE PREVIEW — THIS RUN'S WHOLE JOB IS THE CHANGE BELOW.") && t.includes("scroll on the flyers") && t.includes("a run that ends with no new commit FAILS");
    }],
    ["a plain BUILD, a materials check, and a PLAN carry no rebuild block", () =>
      rebuildBlock({ phase: "BUILD", rebuild: null }).length === 0 && rebuildBlock({ phase: "BUILD", rebuild: { intent: "PREVIEW", changes: null } }).length === 0 && rebuildBlock({ phase: "PLAN", rebuild: { intent: "CHANGES", changes: "x" } }).length === 0],
    ["inertRebuild: a CHANGES rebuild whose head did not move is inert; a moved head, a plain build, or an unreadable head is not", () =>
      inertRebuild({ phase: "BUILD", rebuild: { intent: "CHANGES", changes: "x" } }, "abc", "abc") &&
      !inertRebuild({ phase: "BUILD", rebuild: { intent: "CHANGES", changes: "x" } }, "abc", "def") &&
      !inertRebuild({ phase: "BUILD", rebuild: null }, "abc", "abc") &&
      !inertRebuild({ phase: "BUILD", rebuild: { intent: "PREVIEW", changes: null } }, "abc", "abc") &&
      !inertRebuild({ phase: "BUILD", rebuild: { intent: "CHANGES", changes: "x" } }, null, null) &&
      !inertRebuild({ phase: "LAND", rebuild: { intent: "CHANGES", changes: "x" } }, "abc", "abc")],
    ["the prompt tells the model a rebuild after the preview is the change, never a re-check", () => {
      const p = readFileSync(PROMPT_FILE, "utf8");
      return p.includes("A rebuild after the preview") && p.includes("REBUILD AFTER THE PREVIEW") && p.includes("no new commit is FAILED");
    }],
    // ── 0253: any repo she names, the vault first, runs for the model, no secret shown ──
    ["readResult accepts needs_runs only with well-formed runs, and refuses a shell line", () => {
      const ok = readResult(JSON.stringify({ phase: "BUILD", status: "needs_runs", runs: [{ script: "load-beats", env: "production", args: ["--env", "production"] }] }), "BUILD");
      const noRuns = readResult(JSON.stringify({ phase: "BUILD", status: "needs_runs" }), "BUILD");
      const shell = readResult(JSON.stringify({ phase: "BUILD", status: "needs_runs", runs: [{ script: "load-beats; rm -rf /", env: "local" }] }), "BUILD");
      const badEnv = readResult(JSON.stringify({ phase: "BUILD", status: "needs_runs", runs: [{ script: "x", env: "prod" }] }), "BUILD");
      return ok.result?.status === "needs_runs" && noRuns.result === null && shell.result === null && badEnv.result === null;
    }],
    ["readResult refuses a missing_secrets entry that is not a NAME", () => readResult(JSON.stringify({ phase: "PLAN", status: "ok", document: "x".repeat(50), publish_ready: true, missing_secrets: ["GIPHY_API_KEY=abc"] }), "PLAN").result === null && readResult(JSON.stringify({ phase: "PLAN", status: "ok", document: "x".repeat(50), publish_ready: true, missing_secrets: ["GIPHY_API_KEY"] }), "PLAN").result !== null],
    ["the vault is looked up by name then by vendor, and the search is recorded", () => {
      const l = vaultLookup(["RESEND_API_KEY", "GIPHY_KEY", "STRIPE_SECRET"], new Set(["RESEND_API_KEY", "GIPHY_API_KEY"]));
      return l.found.join() === "RESEND_API_KEY" && l.by_vendor.GIPHY_KEY?.join() === "GIPHY_API_KEY" && l.missing.join() === "STRIPE_SECRET" && l.searched.includes("GIPHY_*") && l.searched.includes("STRIPE_*") && l.allowed.join() === "GIPHY_API_KEY,RESEND_API_KEY";
    }],
    ["a repo's run gets only its allowed names, never the model's auth or an unlisted vault name", () => {
      const e = envForRepoRun({ PATH: "/bin", GIPHY_API_KEY: "g", RESEND_API_KEY: "r", ANTHROPIC_API_KEY: "sk", [VAULT_INJECTED_VAR]: "GIPHY_API_KEY,RESEND_API_KEY,ANTHROPIC_API_KEY" }, ["GIPHY_API_KEY"], new Set());
      return e.PATH === "/bin" && e.GIPHY_API_KEY === "g" && !("RESEND_API_KEY" in e) && !("ANTHROPIC_API_KEY" in e);
    }],
    ["the RUNBOOK generator writes the deploy route it was given and lists runnable scripts and secret names", () => {
      const g = generateRunbook({ repo: "topbarz-voting", githubRepo: "seq23/topbarz-voting", pkg: { scripts: { "deploy:production": "wrangler pages deploy public", "load-beats": "node x", dev: "wrangler pages dev" } }, wrangler: { name: "topbarz-voting", pages_build_output_dir: "public", routes: [], envs: [], vars: ["PUBLIC_FLAG"] }, sourceNames: ["env.GIPHY_API_KEY", "env.PUBLIC_FLAG"], today: "2026-10-06" });
      return g.route.kind === "npm" && g.text.includes("`npm run deploy:production`") && porterMayRun(g.text).join() === "load-beats" && runbookSecretNames(g.text).join() === "GIPHY_API_KEY" && !porterMayRun(g.text).includes("dev");
    }],
    ["a repo with no deploy route gets 'not declared', never a guess", () => { const g = generateRunbook({ repo: "r", githubRepo: null, pkg: { scripts: {} }, wrangler: null, sourceNames: [], today: "2026-10-06" }); return g.route.kind === "none" && /not declared/.test(g.text) && !/(?<!nothing is |never )\bguess/i.test(g.text); }],
    ["the constraints extractor reads a partner's standing rules out of a README and skips commands", () => { const c = constraintsIn(["- Scooter's own track is never in the vote.\n- Run `npm run dev`.\n- Voter emails are private.\n"]); return c.length === 2 && c.every((x) => !/npm/.test(x)); }],
    ["a TOML wrangler config yields the name, the Pages output dir and the routes", () => { const w = readWranglerToml('name = "topbarz-voting"\npages_build_output_dir = "public"\n[env.production]\nroutes = ["voting.topbarz.xyz/*"]\n'); return w.name === "topbarz-voting" && w.pages_build_output_dir === "public" && w.routes.join() === "voting.topbarz.xyz/*" && hostFromRoutes(w.routes) === "voting.topbarz.xyz"; }],
    ["the context carries the repo lines and the DUE line from the job, never from the environment", () => {
      const lines = repoLines({ file: "/w/RUNBOOK.md", generated: true, mayRun: ["load-beats"], constraints: ["Scooter's track never in the vote"] }, { lookup: { found: ["RESEND_API_KEY"], by_vendor: { GIPHY_KEY: ["GIPHY_API_KEY"] }, searched: ["RESEND_API_KEY", "GIPHY_KEY", "GIPHY_*"], missing: [] }, allowed: [], missing: [{ name: "STRIPE_KEY" }] }, "/j/out", []);
      const t = renderContext({ phase: "BUILD", card: { id: "wc_1", title: "T" }, request: "r", rules: {}, due: { due_at: "2026-10-12T14:00:00.000Z", due_words: "by Monday morning" }, constraints: ["Test data is preview-only"] }, { worktree: "/w", branch: "b", packageDir: "/p", jobDir: "/j", resultPath: "/r", attachments: [], extraLines: lines });
      return t.includes("DUE: 2026-10-12T14:00:00.000Z") && t.includes("REGISTERED_CONSTRAINTS") && t.includes("PORTER_MAY_RUN") && t.includes("GIPHY_KEY → GIPHY_API_KEY") && t.includes("SECRETS_MISSING") && t.includes("STRIPE_KEY") && t.includes("PARTNER_CONSTRAINTS") && t.includes("GENERATED this run");
    }],
    ["the prompt no longer blocks for a login, a RUNBOOK or an odd ask, and tells the model how to ask for runs, files and keys", () => {
      const p = readFileSync(PROMPT_FILE, "utf8");
      return /do NOT block for it/.test(p) && /needs_runs/.test(p) && /DELIVERABLES_DIR/.test(p) && /missing_secrets/.test(p) && /Never ask for a login/.test(p) && !/BLOCK with a plain question/.test(p) && /Standing partner practices/.test(p);
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
