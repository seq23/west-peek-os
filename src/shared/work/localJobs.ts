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
 * NO PHASE IS TIED TO A MODEL HERE (owner, 13 Nov 2026). Which route does a phase is its job class in the
 * one rule table (shared/ai/modelOrder.json; the Mac reads it through scripts/lib/model-roles.mjs). The
 * `model` on a phase is only what the Claude seat is started with, the seat's own value in that table;
 * `phaseModel()` in services/webPropertyChange.ts is the only reader.
 */

import ORDER_TABLE from "../ai/modelOrder.json";
import { readAsks, type Ask } from "./approvalReply";
import { readMissingMaterials, type MissingMaterial } from "./missingMaterials";

export const LOCAL_JOB_RUN_KIND = "LOCAL_JOB" as const;

/** The phases of a web property change, in order. */
export const WEB_PROPERTY_CHANGE_PHASES = ["PLAN", "BUILD", "LAND"] as const;
export type WebPropertyChangePhase = (typeof WEB_PROPERTY_CHANGE_PHASES)[number];
/**
 * A PARTNER SESSION HAS ONE PHASE (14 Nov 2026, "emailing the OS feels like typing to Claude"): the whole email is
 * worked in one full session on the Mac, the way a person would work it with Claude Code. No plan/build/land split.
 */
export const PARTNER_SESSION_PHASE = "SESSION" as const;
export type LocalJobPhase = WebPropertyChangePhase | typeof PARTNER_SESSION_PHASE;

/** A model alias the `claude` CLI accepts on `--model`. Kept as aliases so the CLI resolves the current version. */
export type ClaudeModelAlias = "opus" | "sonnet" | "haiku";
export const CLAUDE_MODEL_ALIASES: readonly ClaudeModelAlias[] = ["opus", "sonnet", "haiku"];
/**
 * WHAT THE CLAUDE SEAT IS STARTED WITH for a local job: the seat's own value in the one rule table
 * (`seat_invocation` in shared/ai/modelOrder.json). Data about the seat, not a rule about a job (owner, 13 Nov 2026:
 * no standing rule about any model). Which ROUTE does a phase is the phase's job class in that table; a hard phase
 * leads on the Claude seat and what Codex does in its place waits for Claude's check.
 */
export const CLAUDE_SEAT_START = ORDER_TABLE.seat_invocation.claude_code.model as ClaudeModelAlias;

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
  /** Each kind names its own phases; a web property change has PLAN, BUILD and LAND, a partner session has SESSION. */
  phases: Readonly<Partial<Record<LocalJobPhase, PhaseSpec>>>;
  /**
   * How long a QUEUED job may wait for a machine before the card is blocked naming the lane. The
   * Mac sleeps; a card is not a run. EIGHTEEN HOURS (22 Nov 2026, the Mac's day): the claimer claims
   * only 10:00-21:59 CT, so a job queued at 21:59 waits twelve closed hours before anyone can take it,
   * and twelve was exactly the old ceiling: it would have been closed at 09:59, a minute before the
   * window opened. Eighteen leaves the day's first six hours to work down a queue (a build can hold
   * the claimer three). A job nobody picked up by the next afternoon is a fault to look at.
   */
  queueMaxSeconds: number;
}

export const WEB_PROPERTY_CHANGE_KIND = "WEB_PROPERTY_CHANGE" as const;
/**
 * A PARTNER'S EMAIL WORKED AS ONE SESSION (14 Nov 2026). An email no fixed door claims (not a relay, not a named site
 * or repo, not a build, not a named employee) used to sit on the chief of staff's desk for the general loop, a fixed
 * step machine under the router's stopwatch. It now runs as a full Claude Code session on the Mac (Claude, then Codex
 * checked by Claude; private work waits for Claude; never a free lane), with no per-call deadline: the claimer's
 * one-minute ping keeps it alive under the phase ceiling. See services/partnerSession.ts.
 */
export const PARTNER_SESSION_KIND = "PARTNER_SESSION" as const;

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

/** A site BUILD: the build turn, then the review loop (up to 3 reviews and 2 fixes), then the first run. */
export const BUILD_CEILING_SECONDS = 3 * 60 * 60;

/** See `queueMaxSeconds`: the closed hours (22:00-10:00 CT) plus six hours of the next day's window. */
export const LOCAL_JOB_QUEUE_SECONDS = 18 * 60 * 60;

/**
 * THE MAC'S DAY, AS A PARTNER IS TOLD IT (22 Nov 2026). Builds and partner sessions need the Mac, and its claimer
 * claims only inside `~/bin/mac-window`'s LIGHT class: 10:00-21:59 Central. Every partner-facing line about when
 * Mac work happens is written from these numbers (`macDayWords`), so the promise and the guard cannot drift apart.
 * Waits that need no Mac (DNS, Drive) run on the Worker's cron, day and night, and never cite this.
 */
export const MAC_DAY = { opensHour: 10, closesHour: 22, zone: "America/Chicago" } as const;

function centralMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: MAC_DAY.zone, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  return hour * 60 + Number(parts.find((p) => p.type === "minute")?.value ?? 0);
}

/** Is the Mac taking work now? Pure. */
export function macDayOpen(now: Date): boolean {
  const m = centralMinutes(now);
  return m >= MAC_DAY.opensHour * 60 && m < MAC_DAY.closesHour * 60;
}

/** When today's window opened, if it is open now; null outside it. Idle time is counted from here, never through the night. */
export function macDayOpenedAt(now: Date): Date | null {
  if (!macDayOpen(now)) return null;
  const since = centralMinutes(now) - MAC_DAY.opensHour * 60;
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000 - since * 60_000);
}

const clock = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 || h === 24 ? "am" : "pm"}`;

/** "between 10am and 10pm Central" — the one way a partner hears when Mac work runs. */
export function macDayWords(): string {
  return `between ${clock(MAC_DAY.opensHour)} and ${clock(MAC_DAY.closesHour)} Central`;
}

export const LOCAL_JOB_KINDS: readonly LocalJobKindSpec[] = [
  {
    kind: WEB_PROPERTY_CHANGE_KIND,
    script: "scripts/duties/web-property-change.mjs",
    promptFile: "scripts/duties/web-property-change-prompt.md",
    phases: {
      PLAN: { model: CLAUDE_SEAT_START, maxSeconds: 40 * 60, purpose: "Pull the package, read the RUNBOOK, write the plan: decided and ask." },
      /*
       * THREE HOURS, NOT NINETY MINUTES (17 Nov 2026, wc_76e6d7ff). The 90-minute ceiling predates the fresh-eyes review
       * (13 Nov), which adds up to three review turns and two fix turns AFTER the build turn. Scooter's six-item rebuild
       * took 70 minutes to build, 2 to review, and was cut 18 minutes into the first fix: twice in one day the whole
       * run was thrown away at the cap and his preview waited another round. The ceiling now covers build + review loop.
       */
      BUILD: { model: CLAUDE_SEAT_START, maxSeconds: BUILD_CEILING_SECONDS, purpose: "Build it in a worktree, prove it with the repo's validators and screenshots, open the PR." },
      LAND: { model: CLAUDE_SEAT_START, maxSeconds: 40 * 60, purpose: "Land on green with ~/bin/land and prove it live with curl." },
    },
    queueMaxSeconds: LOCAL_JOB_QUEUE_SECONDS,
  },
  {
    kind: PARTNER_SESSION_KIND,
    script: "scripts/duties/partner-session.mjs",
    promptFile: "scripts/duties/partner-session-prompt.md",
    phases: {
      SESSION: { model: CLAUDE_SEAT_START, maxSeconds: 2 * 60 * 60, purpose: "Work the partner request or scheduled wake in one session. Report what was completed and which decisions remain open." },
    },
    queueMaxSeconds: LOCAL_JOB_QUEUE_SECONDS,
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
  /** 13 Nov 2026: the door registered this repo for something new; the Mac creates it (public, seq23) and its free Pages project when missing. */
  new_repo?: boolean;
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
  /**
   * 5 Nov 2026 (owner ruling, 4 Nov): true when the job's text names an LP who has COMMITTED to a West Peek fund,
   * read by the Worker from the commitment records. The Mac then treats the job as private: hard phases wait for
   * Claude and never go to Codex; any other phase runs on Claude with Codex as its backup. Never a free lane.
   * Absent or false otherwise; deal terms and fund figures are still caught by the Mac's own markers.
   */
  private_model_only?: boolean;
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
  rebuild?: { intent: "CHANGES" | "PREVIEW" | "PUBLISH"; changes: string | null; since: string | null; stage?: boolean } | null;
  rules: Record<string, string>;
  /** 14 Nov 2026: why the last attempt of this phase was refused, so the retry fixes it first. */
  last_refusal?: string | null;
  /** 18 Nov 2026: a BUILD hears the other open website jobs on its repo, with their PR and branch, so "ship it together" can be built. */
  other_open_jobs?: Array<{ card_id: string; title: string; pr_url: string | null; branch: string | null }>;
  /** #611 (28 Nov 2026), BUILD: the card's missing list as the partner was last told it, so the builder names what it filled word for word. */
  missing_before?: MissingMaterial[];
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
  /** 15 Nov 2026: the keys the Mac could not judge (the deploy target was unreadable): a note on the card, never an alarm. */
  keys_check?: string;
  /** 0253: the RUNBOOK-named scripts the SCRIPT ran on the model's request, each with its exit and one line. */
  runs?: DataOpsRun[];
  /** 0253: files the job produced for the partner, already put on the card by the script. Names only. */
  deliverables?: Array<{ filename: string; bytes: number; via: "r2" | "drive"; drive_url?: string | null }>;
  /** 0253: a host outside the firm's Cloudflare zones — the record Cloudflare asked for, read from its API. */
  dns?: DnsRecordAsked[];
  /** 0253: what the repo's own config says — the host it serves, its Pages project, its RUNBOOK's secret names, the package's standing constraints. Never from the email. */
  repo_facts?: { repo: string; host?: string | null; pages_host?: string | null; secret_names?: string[]; github_repo?: string | null; runbook_generated?: boolean; constraints?: string[] } | null;
  /** 0253 (addendum 5): work the partner dated for later ("for next week …") — its own card, leased until its week. */
  /**
   * `site_change` (#363, 13 Nov 2026): true only when the later work is a change to THIS job's own
   * site and repo; then it becomes a site job there. Anything else (work in another system, for
   * another employee) is a plain dated card, never forced into a site job on the source repo.
   */
  deferred?: Array<{ ask: string; due_at: string; words?: string; site_change?: boolean }>;
  /** #363: PLAN only. One line per thing the partner asked for: built in this job, a question, or (partner-dated) later. */
  accounting?: Array<{ ask: string; how: string; done_when?: string[] }>;
  /** 0253 (addendum 6): several asks in one email → one done-line per item, partial completion stated per item. */
  /** v1.0 bar (13 Nov 2026): each item reports its plan line's `done_when` checks; `blocked_by` names what holds an unmet one. */
  items?: Array<{ item: string; state: "done" | "partial" | "not_done"; note?: string; done_when?: Array<{ check: string; met: boolean; note?: string }>; blocked_by?: string }>;
  /** 28 Nov 2026 (wc_9f7312e4): each question the partner put to us, answered in plain words: the preview leads with them. */
  answers?: Array<{ question: string; answer: string }>;
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
  /**
   * #611 (28 Nov 2026), BUILD: what the builder says THIS build filled in, each item worded as `missing_before`
   * and naming the file or the partner's words it came from. The Worker checks each claim; nothing else is "filled".
   */
  filled_materials?: Array<{ item: string; from: string }>;
  /** 15 Nov 2026: placeholder text the built pages still show ("Photo to come"), read by the Mac from the page text. */
  visible_placeholders?: string[];
  /** 0237, PLAN: the DRIVE_MANIFEST paths the build will use; BUILD fetches them. */
  assets?: string[];
  /**
   * #510 (19 Nov 2026), BUILD: the other open jobs (`other_open_jobs`) whose branch head this PR now
   * contains, read by the SCRIPT with `git merge-base --is-ancestor`, never the model's word. The
   * Worker folds each into this card, so the partner is never asked to approve a PR this one carries.
   */
  carried_jobs?: string[];
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
    ...(Array.isArray(r.filled_materials)
      ? {
          filled_materials: r.filled_materials
            .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object")
            .map((m) => ({ item: String(m.item ?? "").trim().slice(0, 300), from: String(m.from ?? "").trim().slice(0, 600) }))
            .filter((m) => m.item && m.from)
            .slice(0, 50),
        }
      : {}),
    ...(Array.isArray(r.visible_placeholders) ? { visible_placeholders: strs(r.visible_placeholders).slice(0, 50) } : {}),
    ...(Array.isArray(r.assets) ? { assets: strs(r.assets) } : {}),
    ...(Array.isArray(r.carried_jobs) ? { carried_jobs: strs(r.carried_jobs).filter((id) => /^wc_[A-Za-z0-9-]+$/.test(id)).slice(0, 5) } : {}),
    /*
     * #363: THIS READER IS AN ALLOW-LIST, AND `deferred` WAS NEVER ON IT. From 0253 to 13 Nov 2026 the
     * Mac wrote the partner's dated later work into the report, the plan email told him it was "its
     * own card", and the field was dropped right here, so `deferWork` never ran: no card, no trace.
     * EVERY entry is carried, even a malformed one, so `deferWork` can fail loudly on the source card
     * instead of this reader thinning the list in silence.
     */
    ...(Array.isArray(r.deferred) ? { deferred: readDeferred(r.deferred) } : {}),
    // #363: the plan's per-ask accounting (`shared/work/everyAsk.ts` holds the plan to it).
    ...(Array.isArray(r.accounting)
      ? { accounting: r.accounting.slice(0, 40).map((a) => { const l = (a && typeof a === "object" ? a : {}) as Record<string, unknown>; return { ask: typeof l.ask === "string" ? l.ask.trim().slice(0, 300) : "", how: typeof l.how === "string" ? l.how.trim().toLowerCase().slice(0, 40) : "", ...(Array.isArray(l.done_when) ? { done_when: strs(l.done_when).slice(0, 20).map((c) => c.slice(0, 200)) } : {}) }; }) }
      : {}),
    /*
     * v1.0 bar (13 Nov 2026): THIS READER DROPPED `items` UNTIL NOW, so the per-item done-lines the Mac carried never
     * reached the card. Every entry is carried; `buildProblems` judges them.
     */
    ...(Array.isArray(r.items) ? { items: readItems(r.items) } : {}),
    ...(Array.isArray(r.answers) ? { answers: readAnswers(r.answers) } : {}),
    /*
     * 14 Nov 2026: THIS READER DROPPED `missing_secrets` AND `vault_lookup` TOO. So the Worker never recorded which keys a
     * build waits on, and the v1.0 bar's exemption ("held by a key only the partner can supply") could never apply: a
     * dashboard waiting only on the partner's own OAuth app keys was refused as unfinished (wc_c548d043). Carried as the
     * Mac writes them; `absorbRepoReport` still refuses a missing key named without a vault lookup.
     */
    ...(Array.isArray(r.missing_secrets) ? { missing_secrets: readMissingSecrets(r.missing_secrets) } : {}),
    ...(typeof r.keys_check === "string" && r.keys_check.trim() ? { keys_check: r.keys_check.slice(0, 600) } : {}),
    ...(r.vault_lookup && typeof r.vault_lookup === "object"
      ? { vault_lookup: { searched: strs((r.vault_lookup as Record<string, unknown>).searched).slice(0, 200), found: strs((r.vault_lookup as Record<string, unknown>).found).slice(0, 200), missing: strs((r.vault_lookup as Record<string, unknown>).missing).slice(0, 200) } }
      : {}),
  };
  // A plan naming placeholders is not publish-ready whatever the flag says: the list is the fact.
  if (report.phase === "PLAN" && (report.placeholders?.length ?? 0) > 0) report.publish_ready = false;
  // "unchanged" is the script's own fact — the material set is the same — so its reason is that.
  if (report.status === "unchanged" && !report.materials) return { report: null, problem: "an unchanged report must carry the material set it compared" };
  if (report.status !== "ok" && report.status !== "unchanged" && !report.reason) return { report: null, problem: `a ${report.status} report must say why` };
  return { report, problem: null };
}

/** The keys a run says the vault does not hold: a bare name or `{ name, vendor_url, searched }`, entry for entry. */
function readMissingSecrets(v: unknown[]): MissingSecret[] {
  return v.slice(0, 40).flatMap((raw) => {
    const o = (raw && typeof raw === "object" ? raw : { name: raw }) as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim().slice(0, 120) : "";
    if (!name) return [];
    const searched = Array.isArray(o.searched) ? o.searched.map((x) => String(x).trim()).filter(Boolean).slice(0, 200) : [];
    return [{ name, vendor_url: typeof o.vendor_url === "string" ? o.vendor_url.slice(0, 300) : null, searched }];
  });
}

/** The BUILD's per-item done-lines, entry for entry, with each done-when check as reported. */
function readItems(v: unknown[]): NonNullable<LocalJobReport["items"]> {
  return v.slice(0, 40).map((raw) => {
    const i = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const state = ["done", "partial", "not_done"].includes(String(i.state)) ? (String(i.state) as "done" | "partial" | "not_done") : "not_done";
    const checks = Array.isArray(i.done_when)
      ? i.done_when.slice(0, 20).map((c) => { const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>; return { check: typeof o.check === "string" ? o.check.slice(0, 200) : "", met: o.met === true, ...(typeof o.note === "string" ? { note: o.note.slice(0, 300) } : {}) }; })
      : undefined;
    return {
      item: typeof i.item === "string" ? i.item.trim().slice(0, 200) : "",
      state,
      ...(typeof i.note === "string" ? { note: i.note.slice(0, 700) } : {}),
      ...(checks ? { done_when: checks } : {}),
      ...(typeof i.blocked_by === "string" && i.blocked_by.trim() ? { blocked_by: i.blocked_by.trim().slice(0, 40) } : {}),
    };
  });
}

/** His questions and the build's answers, each whole; a row missing either half is no answer and is dropped. */
function readAnswers(v: unknown[]): NonNullable<LocalJobReport["answers"]> {
  return v.slice(0, 20).flatMap((raw) => {
    const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const question = typeof a.question === "string" ? a.question.trim().slice(0, 400) : "";
    const answer = typeof a.answer === "string" ? a.answer.trim().slice(0, 1500) : "";
    return question && answer ? [{ question, answer }] : [];
  });
}

/** The report's dated later work, entry for entry: nothing is dropped here (see the reader). */
function readDeferred(v: unknown[]): NonNullable<LocalJobReport["deferred"]> {
  return v.slice(0, 5).map((raw) => {
    const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const words = typeof d.words === "string" && d.words.trim() ? d.words.slice(0, 200) : undefined;
    return {
      ask: typeof d.ask === "string" ? d.ask.trim().slice(0, 1200) : "",
      due_at: typeof d.due_at === "string" ? d.due_at.trim() : "",
      ...(words ? { words } : {}),
      ...(typeof d.site_change === "boolean" ? { site_change: d.site_change } : {}),
    };
  });
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

// ── A partner session's report (14 Nov 2026) ─────────────────────────────────────────────────────

/** Where one ask of the partner's email stands after a session. */
export type SessionAskStatus = "DONE" | "IN_PROGRESS" | "QUESTION" | "NOT_DONE";
export const SESSION_ASK_STATUSES: readonly SessionAskStatus[] = ["DONE", "IN_PROGRESS", "QUESTION", "NOT_DONE"];

export interface SessionAsk {
  /** The ask in the partner's own words. For a QUESTION, the exact words that are unclear. */
  words: string;
  status: SessionAskStatus;
  /** What was done, what is still running, why it was not done, or what is unclear about the words. */
  why: string;
  /** A QUESTION's likely readings, two or three, each one the partner could answer with. */
  options: string[];
}

export interface PartnerSessionReport {
  phase: typeof PARTNER_SESSION_PHASE;
  status: "ok" | "failed";
  reason?: string;
  /** One entry per ask in the email, none dropped. */
  asks: SessionAsk[];
  /** The answer to the partner, in plain words, for the final email. */
  reply?: string;
  /** "Remember …" lines the session wants kept on the partner's profile; filtered by the Worker before any is kept. */
  remember: string[];
  /** A spent plan is a wait: seconds until the earlier reset. */
  waits_seconds?: number;
}

/**
 * Read a session's report strictly. An ok report must account for at least one ask, and a QUESTION must name its
 * unclear words and carry two or three options; anything else is a problem, never a guessed success (Rule 0).
 */
export function readPartnerSessionReport(text: string | null | undefined): { report: PartnerSessionReport | null; problem: string | null } {
  if (!text || !text.trim()) return { report: null, problem: "the Mac reported nothing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}\s*$/);
    try {
      parsed = m ? JSON.parse(m[0]) : null;
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object") return { report: null, problem: "the report was not JSON" };
  const r = parsed as Record<string, unknown>;
  if (r.phase !== PARTNER_SESSION_PHASE) return { report: null, problem: `the report names no SESSION phase (got "${String(r.phase ?? "")}")` };
  const status = r.status === "ok" || r.status === "failed" ? r.status : null;
  if (!status) return { report: null, problem: `the report has no status (got "${String(r.status ?? "")}")` };
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const asks: SessionAsk[] = (Array.isArray(r.asks) ? r.asks : []).slice(0, 40).map((raw) => {
    const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const st = String(a.status ?? "").toUpperCase();
    return {
      words: str(a.words, 600),
      status: (SESSION_ASK_STATUSES as readonly string[]).includes(st) ? (st as SessionAskStatus) : "NOT_DONE",
      why: str(a.why, 900),
      options: (Array.isArray(a.options) ? a.options : []).map((o) => str(o, 300)).filter(Boolean).slice(0, 3),
    };
  });
  const report: PartnerSessionReport = {
    phase: PARTNER_SESSION_PHASE,
    status,
    ...(str(r.reason, 900) ? { reason: str(r.reason, 900) } : {}),
    asks,
    ...(str(r.reply, 12000) ? { reply: str(r.reply, 12000) } : {}),
    remember: (Array.isArray(r.remember) ? r.remember : []).map((x) => str(x, 600)).filter(Boolean).slice(0, 10),
    ...(typeof r.waits_seconds === "number" && Number.isFinite(r.waits_seconds) && r.waits_seconds >= 60 ? { waits_seconds: Math.min(Math.round(r.waits_seconds), 7 * 24 * 60 * 60) } : {}),
  };
  if (status === "failed") return report.reason ? { report, problem: null } : { report: null, problem: "a failed report must say why" };
  if (asks.length === 0) return { report: null, problem: "an ok session report must account for every ask, and it named none" };
  const bad = asks.find((a) => !a.words);
  if (bad) return { report: null, problem: "an ask in the report has no words" };
  const vague = asks.find((a) => a.status === "QUESTION" && a.options.length < 2);
  if (vague) return { report: null, problem: `the question on "${vague.words.slice(0, 80)}" offers fewer than two options` };
  return { report, problem: null };
}
