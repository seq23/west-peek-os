/**
 * LOCAL JOBS — the card kinds that are worked ON HER MAC, and the one place that says how.
 *
 * ─── WHY A REGISTRY ──────────────────────────────────────────────────────────────────────────
 *
 * The Worker cannot run Claude Code, a git worktree, `npm run validate` in another repo, or
 * `~/bin/land`. The Mac can. So a card of one of these kinds is not worked by a model call inside
 * the Worker; it is worked by a RUN the Worker parks in the same queue the subscription seats
 * already use (`subscription_seat_run`, migration 0187, `run_kind = 'LOCAL_JOB'` from 0219), and a
 * launchd job on her machine claims it, runs the duty script named here, and reports back.
 *
 * TWO COMPONENTS EACH KEEPING THEIR OWN LIST is the defect this repo names most often. The Worker
 * parks a run with a card kind on it; a script on the Mac has to know that kind. This file is the
 * one list, and `scripts/validate/a-duty-has-an-executor.mjs` (`validate:duty-executor`) holds
 * both sides to it: every kind here names a script that exists and declares this kind, every
 * duty script declares a kind that is here, and the sweep dispatches every kind here.
 *
 * MODEL PER PHASE IS DECIDED HERE, ONCE. Plan on the strongest model (it reads a package and a
 * RUNBOOK and decides what to ask), build on a mid model (it edits and runs validators), land on
 * the cheapest (it runs a script and writes up curl output). The Managing Partners may override
 * each on the Work page (`work_kind_rule`, editable rows); the values here are the defaults the
 * rows were seeded from, and `phaseModel()` in services/webPropertyChange.ts is the only reader.
 */

import { readAsks, type Ask } from "./approvalReply";
import { readMissingMaterials, type MissingMaterial } from "./missingMaterials";

export const LOCAL_JOB_RUN_KIND = "LOCAL_JOB" as const;

/** The phases of a web property change, in order. */
export const WEB_PROPERTY_CHANGE_PHASES = ["PLAN", "BUILD", "LAND"] as const;
export type WebPropertyChangePhase = (typeof WEB_PROPERTY_CHANGE_PHASES)[number];

/** A model alias the `claude` CLI accepts on `--model`. Kept as aliases so the CLI resolves the current version. */
export type ClaudeModelAlias = "opus" | "sonnet" | "haiku";
export const CLAUDE_MODEL_ALIASES: readonly ClaudeModelAlias[] = ["opus", "sonnet", "haiku"];

export interface PhaseSpec {
  /** Default model alias; the `model_<phase>` rule row overrides it. */
  model: ClaudeModelAlias;
  /** Hard ceiling for the whole phase on the Mac, including caffeinate and the CLI. */
  maxSeconds: number;
  /** One line for the Work page and the prompt file. */
  purpose: string;
}

export interface LocalJobKindSpec {
  /** The `work_card.kind`. */
  kind: string;
  /** Repo-relative path of the Mac-side duty script that runs it. Must declare `card kind: <kind>`. */
  script: string;
  /** Repo-relative path of the prompt file the script hands to `claude -p`. */
  promptFile: string;
  phases: Readonly<Record<WebPropertyChangePhase, PhaseSpec>>;
  /**
   * How long a QUEUED job may wait for a machine before the card is blocked naming the lane. The
   * Mac sleeps; a card is not a run. Twelve hours: a job queued at night is picked up in the
   * morning, and a job nobody picked up by the next evening is a fault to look at.
   */
  queueMaxSeconds: number;
}

export const WEB_PROPERTY_CHANGE_KIND = "WEB_PROPERTY_CHANGE" as const;

/**
 * THE STANDING RULES WHOSE VALUE IS A SWITCH — one list, read by the Work page (which renders a
 * switch for them and a read-only badge for everything else) and by `handleSetWorkKindRule` (which
 * refuses anything but on/off for them). SHARED, not worker-only, because the two sides had a copy
 * each: the page typed `rule.rule_key === "land_on_green"` and the route typed `key ===
 * "land_on_green"`, so migration 0223's `done_reply_preview_first` shipped as a rule a partner
 * could read and not change, while the API would have taken any forty-character string for it.
 * `validate:kind-rule-switches` fails the build if either side grows its own list again.
 */
export const ON_OFF_RULE_KEYS: readonly string[] = ["land_on_green", "done_reply_preview_first"];

export const LOCAL_JOB_KINDS: readonly LocalJobKindSpec[] = [
  {
    kind: WEB_PROPERTY_CHANGE_KIND,
    script: "scripts/duties/web-property-change.mjs",
    promptFile: "scripts/duties/web-property-change-prompt.md",
    phases: {
      PLAN: { model: "opus", maxSeconds: 40 * 60, purpose: "Pull the package, read the RUNBOOK, write the plan: decided and ask." },
      BUILD: { model: "sonnet", maxSeconds: 90 * 60, purpose: "Build it in a worktree, prove it with the repo's validators and screenshots, open the PR." },
      LAND: { model: "haiku", maxSeconds: 40 * 60, purpose: "Land on green with ~/bin/land and prove it live with curl." },
    },
    queueMaxSeconds: 12 * 60 * 60,
  },
];

export function localJobKind(kind: string | null | undefined): LocalJobKindSpec | null {
  return LOCAL_JOB_KINDS.find((k) => k.kind === kind) ?? null;
}

export function isLocalJobKind(kind: string | null | undefined): boolean {
  return localJobKind(kind) !== null;
}

/**
 * What the Worker hands the Mac. Everything the duty script needs, and nothing it may decide:
 * the model, the timeout, the repo and the phase are all settled here before the row exists.
 */
export interface LocalJobPayload {
  card_kind: string;
  phase: WebPropertyChangePhase;
  model: ClaudeModelAlias;
  max_seconds: number;
  prompt_file: string;
  script: string;
  card: { id: string; title: string; requested_by: string | null };
  target_repo: string;
  property_host: string | null;
  /** 0253: owner/name on GitHub, so the Mac can clone a checkout it does not have. */
  github_repo?: string | null;
  /** 0253: the secret NAMES the registry allows for this repo (its RUNBOOK's `## Secrets` + vault vendor matches). Never a value. */
  secret_names?: string[];
  /** 0253: keys an earlier phase found missing from the vault; the build goes ahead without them. */
  missing_secrets?: MissingSecret[];
  /** 0253 (addendum 2): the partner's standing constraints for this repo — obeyed in every job, never restated as asks. */
  constraints?: string[];
  /** 0254 (R7–R23 for every kind): the standing partner-practices block every duty prompt carries, with the partner's constraints register. */
  practices?: string;
  /** 0256: Google Drive files a partner shared onto the card — title, link, who shared it, and the text read through the firm's delegation. */
  drive_files?: Array<{ title: string; url: string; shared_by: string | null; text: string | null }>;
  /** 0253 (addendum 3): the deadline the partner named, ISO UTC, and their words. */
  due?: { due_at: string; due_words: string } | null;
  /** 23 Sep 2026: the site folders of target_repo this job may change (sitesOf(property_host)); [] when unresolved. */
  sites: string[];
  /** 23 Sep 2026: the Pages subdomains those sites preview under — the Mac keeps only preview URLs under these. */
  pages_hosts?: string[];
  drive: { folder_id: string | null; folder_url: string | null };
  ask: string;
  /** From the PLAN phase onward, so BUILD and LAND work from the plan and the partner's answers. */
  plan: { document_id: string | null; text: string | null; decided: string[]; asks: Ask[]; answers: string[]; approved_at: string | null; publish_ready: boolean; placeholders: string[]; preview_only: boolean; assets?: string[] } | null;
  /** 21 Sep 2026: the partner pre-approved in the request — PLAN decides everything, offers no asks. */
  pre_approved: string | null;
  /** 21 Sep 2026: THE SPECIFICATION — the partner's own words, quoted replies stripped. Handed to Porter verbatim under REQUEST:. */
  request: string;
  /** 21 Sep 2026: the files they attached, fetched by the Mac by name through `path` (a Worker route) into the package's attachments dir. */
  attachments: Array<{ id: string; filename: string; media_type: string; bytes: number; path: string }>;
  /** From BUILD onward. */
  pr: { url: string | null; number: number | null; branch: string | null; check_state: string | null; check_green_at: string | null; preview_url: string | null; land_approved_at: string | null; forced_by: string | null; preview_emailed_at?: string | null; publish_approved_at?: string | null } | null;
  /**
   * 0240: a MATERIALS CHECK before this BUILD — she replied, or pressed "I added missing items". The
   * Mac re-maps the folder (documents only), reads the card's files, and reports "unchanged" rather
   * than rebuilding when the set equals `materials_fingerprint`. Absent/false: build as always.
   */
  refresh?: boolean;
  materials_fingerprint?: string | null;
  /**
   * 28 Sep 2026: THIS BUILD IS A REBUILD AFTER A PREVIEW. For CHANGES, `changes` is what the partner
   * asked for, in their words — a remark or a worry about how the site behaves is a design change to
   * make, not a note to acknowledge (Scooter, 27 Sep: "I don't know if people know they can scroll
   * on the flyers" — the Mac built nothing and Porter re-sent the same preview). The script compares
   * the branch head before and after the model's turn and reports `changed`; the Worker treats a
   * CHANGES rebuild that moved nothing as a failed attempt, never a fresh preview.
   */
  rebuild?: { intent: "CHANGES" | "PREVIEW" | "PUBLISH"; changes: string | null; since: string | null } | null;
  rules: Record<string, string>;
  /**
   * 23 Sep 2026: ONE JOB OVER SEVERAL REPOS — one entry per repo (migration 0236), in order. Absent
   * (or fewer than two) for a single-repo job, which runs exactly as before. PLAN writes one plan
   * over all of them; BUILD opens one PR per repo; LAND lands every PR or none.
   */
  parts?: LocalJobPart[] | null;
}

export interface LocalJobPart {
  repo: string;
  property_host: string;
  /** The site folders of this repo the job may change; ["."] is the whole repo. */
  sites: string[];
  /** The Pages subdomains this repo's sites preview under (23 Sep 2026). */
  pages_hosts?: string[];
  /** This repo's slice of the request (the whole request when the email did not separate them). */
  ask: string;
  pr: { url: string | null; number: number | null; branch: string | null; check_state: string | null; check_green_at: string | null; preview_url: string | null } | null;
  merge_sha: string | null;
}

/** One repo's result inside a multi-repo report. */
export interface LocalJobPartReport {
  repo: string;
  pr_url?: string;
  pr_number?: number;
  branch?: string;
  check_state?: "PENDING" | "GREEN" | "RED";
  check_url?: string;
  preview_url?: string;
  /** 9 Oct 2026: the PR's changed files, as gh lists them — the preview email links the changed pages. */
  changed_files?: string[];
  proof?: string;
  merge_sha?: string;
  live_proof?: string;
}

/**
 * What the Mac reports back — one JSON object on `output_text`. The duty script writes it from a
 * result file the model fills in, and CHECKS it before reporting: a phase that produced no result
 * file reports `status: "failed"`, never a guessed success (Rule 0).
 */
/** 0253: a key the vault does not hold. The name, where a partner can create one, and where the duty looked. */
export interface MissingSecret {
  name: string;
  vendor_url?: string | null;
  /** The names the duty searched the vault for (RUNBOOK names, then vendor prefixes). Required beside a missing secret. */
  searched: string[];
}

/** 0253: what the duty looked up in the vault, names only. Carried on every report that names a missing secret. */
export interface VaultLookup {
  searched: string[];
  found: string[];
  missing: string[];
}

/** 0253: the record Cloudflare requires for a custom domain, read from the Pages API — never guessed. */
export interface DnsRecordAsked {
  host: string;
  project: string;
  record_type: "CNAME" | "A" | "AAAA";
  record_name: string;
  record_target: string;
  txt_name?: string | null;
  txt_value?: string | null;
  /** Cloudflare's own status word for the domain (pending, active, …). */
  status: string;
  /** True when the host IS on one of the firm's zones: Cloudflare added the record itself; nothing to email. */
  on_zone: boolean;
}

/** 0253: one RUNBOOK-named script the duty ran for the model. */
export interface DataOpsRun {
  script: string;
  env: "local" | "preview" | "production";
  exit: number;
  line: string;
}

export interface LocalJobReport {
  phase: WebPropertyChangePhase;
  /** 0253: keys the vault does not hold. Carried with `vault_lookup`, or the Worker refuses the report. */
  missing_secrets?: MissingSecret[];
  vault_lookup?: VaultLookup;
  /** 0253: the RUNBOOK-named scripts the SCRIPT ran on the model's request, each with its exit and one line. */
  runs?: DataOpsRun[];
  /** 0253: files the job produced for the partner, already put on the card by the script. Names only. */
  deliverables?: Array<{ filename: string; bytes: number; via: "r2" | "drive"; drive_url?: string | null }>;
  /** 0253: a host outside the firm's Cloudflare zones — the record Cloudflare asked for, read from its API. */
  dns?: DnsRecordAsked[];
  /** 0253: what the repo's own config says — the host it serves, its Pages project, its RUNBOOK's secret names, the package's standing constraints. Never from the email. */
  repo_facts?: { repo: string; host?: string | null; pages_host?: string | null; secret_names?: string[]; github_repo?: string | null; runbook_generated?: boolean; constraints?: string[] } | null;
  /** 0253 (addendum 5): work the partner dated for later ("for next week …") — its own card, leased until its week. */
  deferred?: Array<{ ask: string; due_at: string; words?: string }>;
  /** 0253 (addendum 6): several asks in one email → one done-line per item, partial completion stated per item. */
  items?: Array<{ item: string; state: "done" | "partial" | "not_done"; note?: string }>;
  /**
   * "unchanged" (0240, BUILD only): the job asked for a materials check (`refresh`), the Mac re-mapped
   * the folder and read the card's files, and the set is the same one the last build used — so it
   * built nothing. Written by the SCRIPT, never the model.
   */
  status: "ok" | "blocked" | "failed" | "unchanged";
  /** 0240: the material set this BUILD saw (Drive ids + size + modified time, and the attachments). */
  materials?: string;
  /** Why it stopped, for a partner. Required for blocked and failed. */
  reason?: string;
  /**
   * BOTH SEATS SPENT (1 Oct 2026): on a `failed` report, how many seconds until the earlier of the two subscription
   * plans resets. It is a wait, not a fault — the Worker holds the card until then and charges no attempt.
   */
  waits_seconds?: number;
  /** PLAN: the plan document, markdown. */
  document?: string;
  decided?: string[];
  /** Each a numbered question WITH Porter's recommended default — "approved" takes every default. */
  asks?: Ask[];
  /**
   * PLAN (21 Sep 2026): false whenever any placeholder or TODO would ship, or an ask's default is
   * "placeholder until supplied". A plan that is not ready previews first and lands only on a
   * SECOND approval. Absent means true — unless placeholders are named, which means false.
   */
  publish_ready?: boolean;
  /** PLAN: each open item that would ship as a structured placeholder, named in a few words. */
  placeholders?: string[];
  /** BUILD: the Cloudflare Pages preview URL(s) for the branch, read by the script from gh. Absent when the repo has no preview deployment. */
  preview_url?: string;
  /** BUILD (28 Sep 2026): written by the SCRIPT — did the branch head move during this run, and where is it now. A CHANGES rebuild with `changed` anything but true is a failed attempt. */
  changed?: boolean;
  head_sha?: string;
  /** BUILD: the PR, and what the script observed on it. */
  pr_url?: string;
  pr_number?: number;
  branch?: string;
  check_state?: "PENDING" | "GREEN" | "RED";
  check_url?: string;
  /**
   * BUILD (9 Oct 2026): the PR's changed files, read by the SCRIPT from `gh pr view --json files`.
   * The preview email links each changed public page (`pagePathsFrom`), not only the site root.
   */
  changed_files?: string[];
  /** BUILD: validator output, screenshot names, link checks — the proof, as text. */
  proof?: string;
  /** LAND: the merge and what curl saw. */
  merge_sha?: string;
  live_proof?: string;
  /** Anything the model wants on the card as a finding. */
  notes?: string;
  /** 23 Sep 2026: a multi-repo job's BUILD or LAND reports each repo here (see LocalJobPart). */
  parts?: LocalJobPartReport[];
  /**
   * 0237: what the partner must still send — PLAN's list, or what is STILL missing after a BUILD
   * re-checked the re-mapped package. Absent means "not reported" (the card's list stands); [] means
   * "nothing is missing any more".
   */
  missing_materials?: MissingMaterial[];
  /** 0237, PLAN: the DRIVE_MANIFEST paths the build will use; BUILD fetches them. */
  assets?: string[];
}

const PHASES = new Set<string>(WEB_PROPERTY_CHANGE_PHASES);

/**
 * Read a report strictly. A report the Worker cannot read is a FAILED phase with the parse
 * problem as its reason — never silently `ok`, never silently ignored.
 */
export function readLocalJobReport(text: string | null | undefined): { report: LocalJobReport | null; problem: string | null } {
  if (!text || !text.trim()) return { report: null, problem: "the Mac reported nothing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The CLI may print a line or two before the JSON. Take the last {...} block.
    const m = text.match(/\{[\s\S]*\}\s*$/);
    if (!m) return { report: null, problem: "the report was not JSON" };
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return { report: null, problem: "the report was not JSON" };
    }
  }
  if (!parsed || typeof parsed !== "object") return { report: null, problem: "the report was not an object" };
  const r = parsed as Record<string, unknown>;
  const phase = String(r.phase ?? "");
  const status = String(r.status ?? "");
  if (!PHASES.has(phase)) return { report: null, problem: `the report names no phase (got "${phase}")` };
  if (!["ok", "blocked", "failed", "unchanged"].includes(status)) return { report: null, problem: `the report has no status (got "${status}")` };
  if (status === "unchanged" && phase !== "BUILD") return { report: null, problem: `only a BUILD can report "unchanged" (got ${phase})` };
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter((x) => x.length > 0) : []);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v : undefined);
  const report: LocalJobReport = {
    phase: phase as WebPropertyChangePhase,
    status: status as LocalJobReport["status"],
    reason: str(r.reason),
    document: str(r.document),
    decided: strs(r.decided),
    asks: readAsks(r.asks),
    pr_url: str(r.pr_url),
    pr_number: typeof r.pr_number === "number" && Number.isFinite(r.pr_number) ? r.pr_number : undefined,
    branch: str(r.branch),
    check_state: ["PENDING", "GREEN", "RED"].includes(String(r.check_state)) ? (String(r.check_state) as LocalJobReport["check_state"]) : undefined,
    check_url: str(r.check_url),
    proof: str(r.proof),
    merge_sha: str(r.merge_sha),
    live_proof: str(r.live_proof),
    notes: str(r.notes),
    placeholders: strs(r.placeholders),
    publish_ready: typeof r.publish_ready === "boolean" ? r.publish_ready : strs(r.placeholders).length === 0,
    preview_url: str(r.preview_url),
    ...(Array.isArray(r.changed_files) ? { changed_files: strs(r.changed_files).slice(0, 500) } : {}),
    ...(typeof r.waits_seconds === "number" && Number.isFinite(r.waits_seconds) && r.waits_seconds >= 60
      ? { waits_seconds: Math.min(Math.round(r.waits_seconds), 7 * 24 * 60 * 60) }
      : {}),
    ...(typeof r.changed === "boolean" ? { changed: r.changed } : {}),
    ...(str(r.head_sha) ? { head_sha: str(r.head_sha)!.slice(0, 64) } : {}),
    ...(str(r.materials) ? { materials: str(r.materials)!.slice(0, 200) } : {}),
    ...(Array.isArray(r.parts) ? { parts: readPartReports(r.parts) } : {}),
    ...(Array.isArray(r.missing_materials) ? { missing_materials: readMissingMaterials(r.missing_materials) } : {}),
    ...(Array.isArray(r.assets) ? { assets: strs(r.assets) } : {}),
  };
  // A plan naming placeholders is not publish-ready whatever the flag says: the list is the fact.
  if (report.phase === "PLAN" && (report.placeholders?.length ?? 0) > 0) report.publish_ready = false;
  // "unchanged" is the script's own fact — the material set is the same — so its reason is that.
  if (report.status === "unchanged" && !report.materials) return { report: null, problem: "an unchanged report must carry the material set it compared" };
  if (report.status !== "ok" && report.status !== "unchanged" && !report.reason) return { report: null, problem: `a ${report.status} report must say why` };
  return { report, problem: null };
}

/** A multi-repo report's parts, read as strictly as the report: a part without a repo is dropped. */
function readPartReports(v: unknown[]): LocalJobPartReport[] {
  const str = (x: unknown): string | undefined => (typeof x === "string" && x.trim().length > 0 ? x : undefined);
  const out: LocalJobPartReport[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const repo = str(p.repo);
    if (!repo) continue;
    out.push({
      repo,
      pr_url: str(p.pr_url),
      pr_number: typeof p.pr_number === "number" && Number.isFinite(p.pr_number) ? p.pr_number : undefined,
      branch: str(p.branch),
      check_state: ["PENDING", "GREEN", "RED"].includes(String(p.check_state)) ? (String(p.check_state) as LocalJobPartReport["check_state"]) : undefined,
      check_url: str(p.check_url),
      preview_url: str(p.preview_url),
      ...(Array.isArray(p.changed_files) ? { changed_files: p.changed_files.map((x) => String(x).trim()).filter(Boolean).slice(0, 500) } : {}),
      proof: str(p.proof),
      merge_sha: str(p.merge_sha),
      live_proof: str(p.live_proof),
    });
  }
  return out;
}
