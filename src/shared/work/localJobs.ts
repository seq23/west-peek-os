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
  /** 23 Sep 2026: the site folders of target_repo this job may change (sitesOf(property_host)); [] when unresolved. */
  sites: string[];
  drive: { folder_id: string | null; folder_url: string | null };
  ask: string;
  /** From the PLAN phase onward, so BUILD and LAND work from the plan and the partner's answers. */
  plan: { document_id: string | null; text: string | null; decided: string[]; asks: Ask[]; answers: string[]; approved_at: string | null; publish_ready: boolean; placeholders: string[]; preview_only: boolean } | null;
  /** 21 Sep 2026: the partner pre-approved in the request — PLAN decides everything, offers no asks. */
  pre_approved: string | null;
  /** 21 Sep 2026: THE SPECIFICATION — the partner's own words, quoted replies stripped. Handed to Porter verbatim under REQUEST:. */
  request: string;
  /** 21 Sep 2026: the files they attached, fetched by the Mac by name through `path` (a Worker route) into the package's attachments dir. */
  attachments: Array<{ id: string; filename: string; media_type: string; bytes: number; path: string }>;
  /** From BUILD onward. */
  pr: { url: string | null; number: number | null; branch: string | null; check_state: string | null; check_green_at: string | null; preview_url: string | null; land_approved_at: string | null; forced_by: string | null } | null;
  rules: Record<string, string>;
}

/**
 * What the Mac reports back — one JSON object on `output_text`. The duty script writes it from a
 * result file the model fills in, and CHECKS it before reporting: a phase that produced no result
 * file reports `status: "failed"`, never a guessed success (Rule 0).
 */
export interface LocalJobReport {
  phase: WebPropertyChangePhase;
  status: "ok" | "blocked" | "failed";
  /** Why it stopped, for a partner. Required for blocked and failed. */
  reason?: string;
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
  /** BUILD: the PR, and what the script observed on it. */
  pr_url?: string;
  pr_number?: number;
  branch?: string;
  check_state?: "PENDING" | "GREEN" | "RED";
  check_url?: string;
  /** BUILD: validator output, screenshot names, link checks — the proof, as text. */
  proof?: string;
  /** LAND: the merge and what curl saw. */
  merge_sha?: string;
  live_proof?: string;
  /** Anything the model wants on the card as a finding. */
  notes?: string;
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
  if (!["ok", "blocked", "failed"].includes(status)) return { report: null, problem: `the report has no status (got "${status}")` };
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
  };
  // A plan naming placeholders is not publish-ready whatever the flag says: the list is the fact.
  if (report.phase === "PLAN" && (report.placeholders?.length ?? 0) > 0) report.publish_ready = false;
  if (report.status !== "ok" && !report.reason) return { report: null, problem: `a ${report.status} report must say why` };
  return { report, problem: null };
}
