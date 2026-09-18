import type { Env } from "../env";
import { appendEvent } from "../events";
import type { Actor } from "../services/authorize";
import type { PrivacyLabel } from "../../shared/privacy";
import { isSearchGrounded } from "../../shared/ai/models";
import { createMockLocalAdapter, MOCK_LOCAL_MODEL } from "./providers/mockLocal";
import type { ProviderAdapter } from "./providers/types";
import { firmNoticesBlock } from "./firmNotices";
import { redactInputs, scrubInputs } from "./scrub";
import {
  adapterFor,
  checkScopedBudgets,
  latestRoutingPolicy,
  orderByPolicy,
  raiseCostAlert,
  recordAttribution,
  recordRouting,
  type RoutingCandidate,
} from "./routing";
import { checkFirmBudgets, currentSpendBehaviour, firmSpend } from "./spend";
import {
  deferNonCriticalFromPolicy,
  legacyCostModeFor,
  leverFromPolicy,
  protectedFromSpendPressure,
  taskKindOf,
  type SpendBehaviour,
  type TaskKind,
} from "../../shared/ai/spendLever";
import { evidenceForTaskKind, orderByEvidence, recordModelJobOutcome } from "./modelLearning";
import { directVendorRouteFor } from "../../shared/ai/directVendorRoute";
import { credentialConfigured } from "../../shared/ai/providerCredentials";
import { classifyContent, type ContentClassVerdict } from "../../shared/ai/contentClass";
import { MACHINE_REGISTRY } from "../../shared/registry/machines";
import { isProviderOutage, outageKind } from "../../shared/ai/providerFailure";
import {
  isCoolingDown,
  laneHealth,
  orderByLaneHealth,
  recordLaneCompleted,
  recordLaneOutage,
  type LaneHealthRow,
} from "./laneHealth";

/**
 * runAi — THE governed AI boundary (P4). No other module may call a provider
 * (enforced by scripts/validate/no-direct-provider-calls.mjs).
 *
 * Pipeline (fail closed at every step; EVERY run — including blocked ones —
 * lands in ai_run with a trace_id, a cost estimate, and a visible reason):
 *
 *   1. cost-mode gate (CRITICAL_ONLY defers non-critical purposes),
 *   2. credential scrub (secret-shaped input → EGRESS_BLOCKED; nothing with
 *      credentials ever enters LLM context, local or external),
 *   3. privacy-mode resolution (D8): LOCKDOWN/LOCAL → deterministic local
 *      adapter only; FRONTIER → external allowed only for labels the
 *      provider_data_policy allows (default-deny),
 *   4. provider availability: globally disabled → PROVIDER_DISABLED;
 *      kill-switched → KILL_SWITCHED,
 *   5. cost preflight against provider_pricing_snapshot + budget_policy caps
 *      (per-run and daily; STRATEGIC_SURGE lifts caps only inside an unexpired,
 *      fully-specified surge record; expired/invalid surge → NORMAL),
 *   6. adapter call (mockLocal | httpExternal — never a real vendor in tests),
 *   7. output quarantine: external outputs land quarantined until a human
 *      accept step; local outputs are unquarantined,
 *   8. provider failure → BLOCKED_DEFERRED with the reason visible (never
 *      silently discarded); the deterministic app is unaffected.
 */

export const AI_RUN_STATUSES = [
  "PREFLIGHT_BLOCKED",
  "BUDGET_BLOCKED",
  "EGRESS_BLOCKED",
  "KILL_SWITCHED",
  "PROVIDER_DISABLED",
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "BLOCKED_DEFERRED",
] as const;

export type AIRunStatus = (typeof AI_RUN_STATUSES)[number];

export type PrivacyMode = "LOCAL" | "FRONTIER" | "LOCKDOWN";
/**
 * THE RETIRED ENUM, narrowed to the two values anything still WRITES.
 *
 * `budget_policy.cost_mode` is NOT NULL and historical rows carry all four values, so the column
 * cannot go; what can go is the pretence that it is a control. It is now derived from the lever by
 * `legacyCostModeFor`, which emits only these two, and nothing about routing reads it.
 * CRITICAL_ONLY and STRATEGIC_SURGE are absent from the type because nothing writes them any more —
 * they are read, where they appear in history, through `translateLegacyCostMode`.
 */
export type CostMode = "NORMAL" | "CHEAPO";

export interface AIRunRow {
  id: string;
  purpose: string;
  actor_type: string;
  actor_id: string;
  ai_employee_id: string | null;
  capability_requirement: string | null;
  sensitivity: string;
  privacy_mode: string;
  cost_mode: string;
  provider_id: string | null;
  model: string | null;
  status: AIRunStatus;
  cost_estimate_json: string;
  actual_usage_json: string | null;
  input_hash: string;
  output_quarantine: number;
  output_text: string | null;
  trace_id: string;
  failure_reason: string | null;
  firm_scope: string;
  /** Which of the four job kinds this call declared. Null on runs made before migration 0179. */
  task_kind: TaskKind | null;
  created_at: string;
  completed_at: string | null;
}

export interface RunAiBudgetContext {
  /** Marks the purpose critical (risk/deadline/LP/IC/deal/compliance class work). */
  critical?: boolean;
  expectedInputTokens?: number;
  expectedOutputTokens?: number;
  /** NORMAL-mode model preference (CHEAPO overrides with cheapest adequate). */
  preferredModel?: string;
  /**
   * THIS CALL IS JUDGEMENT, NOT MACHINERY (16 Sep 2026).
   *
   * Set it when the call INTERPRETS what a partner meant, DECIDES what is worth keeping, or DRAFTS
   * something she will send. Two consequences, and both exist because of a specific failure:
   *
   *   1. A SEARCH-GROUNDED MODEL IS NEVER A CANDIDATE. Parker's Workshop packet blocked three times
   *      because the judge was routed to `perplexity/sonar` — the cheapest priced model on the
   *      account since 0158 — and refused its own answer. Callers said "must not be the search
   *      model" in an if-statement AFTER the run; now they say it to the router before one.
   *   2. A COST POSTURE CANNOT DOWNGRADE IT. CHEAPO exists so the firm can get to nearly nothing,
   *      and it should: a URL check, a format pass, a dedupe. Writing the packet Sequoia forwards
   *      to Scooter is not the place to save two dollars, and the difference between those two
   *      kinds of call was implicit in whoever remembered to pass `preferredModel`. It is explicit
   *      here.
   *
   * Mechanical steps leave it off and stay cheap. That is the whole distinction.
   */
  judgement?: boolean;
  /**
   * THIS CALL IS READING WHAT THE OWNER ASKED FOR (16 Sep 2026). Stricter than `judgement`, and
   * the difference is worth stating because `judgement` was not enough.
   *
   * `judgement` says "do not send this to the search model, and do not let a cost posture make it
   * worse". Both of those are true here. What `judgement` still allows is the thing that actually
   * went wrong once already: when nothing is pinned it picks the DEAREST PRICED candidate, and
   * price is the only quality signal the model registry holds. Migration 0158 gave
   * `perplexity/sonar` a price of $1/$1 and by that single row it became "cheapest adequate" for
   * every unpinned call in the firm. A pricing row is configuration. Configuration must not be
   * able to decide which model reads a partner's instruction.
   *
   * So interpretation asks the catalogue a question about CAPABILITY rather than price: the model
   * must be one `provider_model` records as `supports_reasoning = 1`, and it must not be
   * search-grounded. Only among models that pass BOTH is price used to order them. A mispriced row
   * can then make an interpretation dearer or cheaper; it cannot make it stupid.
   *
   * IT ALSO OVERRIDES A ROUTING POLICY THAT NAMES NO SUCH MODEL. A pin is somebody's quality
   * decision and normally stands — but a pin that would hand this call a model the catalogue says
   * cannot reason is a quality decision made before this rule existed, and the explanation on the
   * run says so rather than silently obeying it.
   *
   * Implies `judgement`; callers need not set both.
   */
  interpretation?: boolean;
  /**
   * THIS CALL HAS TO REACH THE LIVE WEB (17 Sep 2026).
   *
   * The third kind of call, and it exists because the other two get it exactly wrong.
   *
   * `judgement` REMOVES search-grounded models from the candidates — correctly, because a search
   * model once refused its own judgement and blocked Parker's packet three times. But the eight
   * calls that exist TO SEARCH pinned `preferredModel: SEARCH_MODEL` and marked nothing, and under
   * CHEAPO a `preferredModel` is simply ignored. So switching the firm to CHEAPO would have sent
   * every live search to the cheapest model in the catalogue — a 3-billion-parameter local model
   * with no web access at all — which would have answered fluently, from memory, about the market
   * this morning. Marking them `judgement` instead would have been worse: that removes the search
   * model on purpose.
   *
   * So this flag says the opposite thing to `judgement`, and says it to the router rather than
   * leaving it to whoever remembered a pin:
   *   1. A SEARCH-GROUNDED MODEL IS REQUIRED, not excluded.
   *   2. A COST POSTURE CANNOT DOWNGRADE IT, exactly as judgement cannot be downgraded.
   *   3. IF THE CATALOGUE HAS NO SEARCH MODEL AVAILABLE, THE RUN FAILS LOUDLY. There is no honest
   *      cheap version of "what happened in the market today", and a confident answer from memory
   *      is worse than no answer, because it gets believed.
   */
  requiresSearch?: boolean;
  /**
   * THIS CALL IS MACHINERY, and saying so is the point (17 Sep 2026).
   *
   * A URL check, a format pass, a dedupe, an extraction whose output another stage consumes. It is
   * cheap and should stay cheap. Setting it changes NOTHING about how the call is routed — it is a
   * declaration, not a lever.
   *
   * It exists so that an UNMARKED call site is impossible. Before this, the 33 calls nobody had
   * classified were indistinguishable from the ones somebody had thought about and decided were
   * mechanical, and the default was "cheapest". `scripts/validate/every-call-is-classified.mjs`
   * fails on a `runAi` call carrying none of the four markers, so a new call site is a decision
   * somebody made rather than a default nobody noticed.
   */
  mechanical?: boolean;
  /**
   * THIS CALL CARRIES LP NAMES OR DEAL TERMS (17 Sep 2026).
   *
   * The owner's line, in her words: "yes LP names and deal terms are confidential." A free model
   * route is generally free because the provider may train on what it is sent, so confidential
   * content must never reach one however good the model is — and that has to be enforced at the
   * router, before a request is formed, not remembered by a caller.
   *
   * Setting it forbids every training-permitting lane for this run, in every cost posture,
   * including CHEAPO. See `trainingPermitted` in shared/ai/freeLanes.ts.
   */
  confidential?: boolean;
  /**
   * THE OTHER HALF OF THE SAME QUESTION, and it exists because one column was answering two.
   *
   * "ITS NOT DEAL TERMS OR LP INFORMATION SO IT DOESNT MATTER IF ITS USING THIS DATA TO TRAIN. WHO
   * CARES ABOUT HIRING SEARCH AND EVENT KITS AND ROOM KITS. THEY ARE NOT PRIVATE INFO." — the
   * owner, 17 Sep 2026.
   *
   * `sensitivity: "INTERNAL"` says the work is ADDRESSED TO A PARTNER. It was being read as "too
   * private to train on", which it never meant, and since every training-permitting lane is capped
   * at PUBLIC that left one legal lane in the catalogue — the dearest model on the account — for a
   * hire search. Setting this says the CONTENT carries no LP names, deal terms, fund figures or
   * diligence material, and it lets the free reasoning lanes serve the run without moving any cap
   * and without touching the recipient label, which still drives preview and approval elsewhere.
   *
   * PRIVATE_MODEL_ONLY always wins — `confidential: true` is the legacy spelling of it and still
   * works, so the five call sites that already carry LP and deal material need no change. A caller
   * asserting both has a bug, and the safe reading of a bug is the restrictive one. See
   * shared/ai/contentClass.ts.
   */
  publicModelApproved?: boolean;
  /** Pin a specific provider by provider_key. */
  providerKey?: string;
}

/**
 * P16 routing/attribution context. All optional: a call that supplies none of it behaves
 * exactly as it did at P4 — cheapest priced capable model, one attempt, no fallback.
 */
export interface RunAiRoutingContext {
  /** Names a routing policy (`routing_policy.task_class`). Absent → legacy selection. */
  taskClass?: string;
  /** Machine this work belongs to — drives machine model policy and machine budgets. */
  machineId?: number;
  /** Work card this run serves, for cost attribution. */
  workCardId?: string;
  /** Spend category for category budgets and the cost centre's breakdown. */
  category?: "PROACTIVE" | "RESEARCH" | "LEGAL" | "COMPLIANCE" | "OPERATIONS" | "INTELLIGENCE" | "OTHER";
}

export interface RunAiInput {
  purpose: string;
  actor: Actor;
  inputs: string[];
  /**
   * Images for vision work. Optional, and deliberately routed through this boundary rather than
   * around it — see the gate in the pipeline below for why that is not a formality.
   */
  images?: RunAiImage[];
  /**
   * Documents for a model to read. Routed through this boundary for the same reason images are:
   * the budget check, the credential scrubber and the model gate all have to see it.
   */
  documents?: RunAiDocument[];
  sensitivity: PrivacyLabel;
  capabilityRequirement?: string;
  budgetContext?: RunAiBudgetContext;
  /** AI employee id when an AI employee is the actor (later phases). */
  aiEmployeeId?: string;
  /** P16 routing/attribution. Optional; absence preserves P4 behaviour exactly. */
  routing?: RunAiRoutingContext;
  /**
   * What to do when the input looks like it contains a credential.
   *
   * "block" is the default and the behaviour everything had before this existed: the run is
   * refused. Use "redact" ONLY for input the firm did not author and cannot correct — gathered
   * third-party text, where a false positive costs a day's output and fixing the source is not
   * available to anybody here. The secret never reaches a provider under either setting; what
   * differs is whether a suspicious span or the whole run is discarded.
   */
  onCredentialLike?: "block" | "redact";
}

export interface RunAiImage {
  mediaType: string;
  dataBase64: string;
  label: string;
}

/**
 * A document for a model to read — a pitch deck, a term sheet, a report.
 *
 * SEPARATE FROM AN IMAGE and not a special case of one. A provider sends a picture as an image
 * block and a PDF as a file block, and the difference is not cosmetic: sent as an image, a
 * twenty-page deck is one unreadable thumbnail. Most decks the firm receives are PDFs, so a deck
 * pipeline that only handled images would work on the rare case and fail on the common one.
 */
export interface RunAiDocument {
  /** `application/pdf` and nothing else for now — see DOCUMENT_CAPABLE_MODELS. */
  mediaType: string;
  dataBase64: string;
  /** Sent as the filename, which is what a model quotes back when it cites a page. */
  label: string;
}

/**
 * A document is bigger than an image and the estimate has to reflect that.
 *
 * A deck runs to twenty pages of text and diagrams. Under-counting it would let exactly the run the
 * budget check exists to stop go through, so this is deliberately generous — the cost of over-
 * estimating is a refusal somebody can override, and of under-estimating is a bill nobody expected.
 */
export const TOKENS_PER_DOCUMENT = 12_000;

/** One per run. A deck is a deck; wanting four of them is a different job than this. */
export const MAX_DOCUMENTS_PER_RUN = 1;

/**
 * Models known to actually read a PDF, kept apart from the vision list for the same reason the
 * types are apart: seeing a picture and reading a document are different capabilities, and a model
 * that does one does not necessarily do the other.
 */
const DOCUMENT_CAPABLE_MODELS: ReadonlySet<string> = new Set([
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-4",
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
]);

/**
 * Images cost tokens, and a lot of them.
 *
 * A screenshot at 1440×900 runs to roughly this many input tokens on the models that can see. It is
 * an approximation and it is deliberately generous: the budget check exists to stop a run that
 * would be expensive, and under-estimating an image would let exactly that run through.
 */
const TOKENS_PER_IMAGE = 1_200;

/**
 * The most images one run may carry.
 *
 * Two viewports of one page is the real case. A run trying to send twenty screenshots is either a
 * mistake or a way to spend a lot of money in one call, and neither should be possible by accident.
 */
const MAX_IMAGES_PER_RUN = 4;

/**
 * Models known to actually accept images.
 *
 * Maintained by hand and deliberately so. The provider registry has no vision concept — every model
 * in it declares `text-completion` and nothing else — so there is nothing to derive this from, and
 * inferring it from the model name would let anything through that happened to be spelled right.
 *
 * The consequence of an omission is a blocked run with the model named in the reason, which is the
 * right direction to fail: a missing entry is a five-second fix, and a wrong entry is a design
 * review of a page the model never saw.
 */
const VISION_CAPABLE_MODELS: ReadonlySet<string> = new Set([
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-4",
  "openai/gpt-5",
  "openai/gpt-4o",
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
]);

export interface RunAiDeps {
  /** Injected into the external adapter — tests ALWAYS pass a stub. */
  fetchImpl?: typeof fetch;
  /** Clock override for surge-expiry testing. */
  now?: Date;
}

export interface AIRunResult {
  run: AIRunRow;
}

export class RunAiError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

// ── Policy loading ──

export interface BudgetPolicyRow {
  id: string;
  firm_scope: string;
  cost_mode: CostMode;
  /**
   * Whether a routing pin survives CHEAPO. 0 only under the "free only" posture, which is the one
   * setting allowed to override the brief's frontier pin — see the routing branch below.
   */
  honours_pins?: number;
  /**
   * Which way UNPINNED work leans. 1 only under "best available", which is the posture that was
   * indistinguishable from "balanced" until there was somewhere to record this.
   */
  prefers_frontier?: number;
  privacy_mode: PrivacyMode;
  daily_cap_usd: number;
  per_run_cap_usd: number;
  strategic_surge_json: string | null;
  set_by: string;
  created_at: string;
}

/** Fail-closed default when no policy row exists: LOCKDOWN, zero caps. */
const FAIL_CLOSED_POLICY: Omit<BudgetPolicyRow, "id" | "firm_scope" | "set_by" | "created_at"> = {
  cost_mode: "NORMAL",
  privacy_mode: "LOCKDOWN",
  daily_cap_usd: 0,
  per_run_cap_usd: 0,
  strategic_surge_json: null,
};

export async function getLatestBudgetPolicy(env: Env, firmScope: string): Promise<BudgetPolicyRow> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT * FROM budget_policy WHERE firm_scope = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1",
  )
    .bind(firmScope)
    .first<BudgetPolicyRow>();
  if (row) return row;
  return {
    id: "bp_fail_closed",
    firm_scope: firmScope,
    set_by: "system",
    created_at: "",
    ...FAIL_CLOSED_POLICY,
  };
}


/**
 * ── STRATEGIC_SURGE IS RETIRED, AND THIS IS WHAT REPLACED IT ────────────────────────────────
 *
 * It was a LEVER POSITION meaning "lift the caps for a while", which is the wrong shape for that
 * idea in three ways, and all three bit:
 *
 *   · it sat in the same enum as NORMAL and CHEAPO, so "spend more temporarily" and "spend less"
 *     were mutually exclusive settings of one control, and choosing either was choosing both;
 *   · it was a STATE somebody could leave the firm in by forgetting about it, since a lever stays
 *     where it was put;
 *   · its expiry, owner and budget lived in a JSON blob that had to be re-validated on every single
 *     call, with a malformed one silently degrading to NORMAL — a safety feature whose failure mode
 *     was indistinguishable from its success.
 *
 * A bypass is now a `spend_bypass` ROW: a decision taken at a moment, for a reason, by a named
 * person, until a time. It lapses on its own, it is consulted only on the path where a ceiling
 * would actually bite (see `checkFirmBudgets`), and it cannot be confused with how much the firm
 * wants to spend in general, which is what the lever is for.
 *
 * `resolveEffectiveCostMode` and the `StrategicSurge` interface are gone with it. A policy row
 * still carrying `strategic_surge_json` is simply not read: the column stays for the history, and
 * `scripts/validate/one-lever-not-four.mjs` fails the build if any routing decision reads it again.
 */

const CRITICAL_PURPOSE = /critical|risk|deadline|\blp\b|\bic\b|deal|compliance/i;

export function isCriticalPurpose(purpose: string, budgetContext?: RunAiBudgetContext): boolean {
  return budgetContext?.critical === true || CRITICAL_PURPOSE.test(purpose);
}

// ── Provider selection ──

interface ProviderRow {
  id: string;
  provider_key: string;
  display_name: string;
  enabled: number;
  kill_switched: number;
  capabilities_json: string;
  cost_metadata_json: string;
  base_url: string | null;
  /** 1 when this lane's terms permit the vendor to train on what it is sent. See migration 0178. */
  training_permitted?: number;
}

interface PricingRow {
  provider_id: string;
  model: string;
  input_per_mtok_usd: number;
  output_per_mtok_usd: number;
  /** Per-request fee on top of tokens. Search-grounded models charge one; most models do not. */
  request_usd: number;
  /** SOURCED | STALE | ILLUSTRATIVE | UNKNOWN — the provenance of the two numbers above. */
  pricing_state: string;
  supports_reasoning: number;
}

interface ModelOption {
  provider: ProviderRow;
  pricing: PricingRow;
}

async function dataPolicyAllows(env: Env, providerId: string, label: string): Promise<boolean> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT allowed FROM provider_data_policy WHERE provider_id = ?1 AND privacy_label = ?2",
  )
    .bind(providerId, label)
    .first<{ allowed: number }>();
  // DEFAULT DENY: no allowing row → denied.
  return row?.allowed === 1;
}

/**
 * THE CATALOGUE DECIDES WHAT IS SELECTABLE. A PRICE ONLY ORDERS WHAT ALREADY IS.
 *
 * This query used to read `provider_pricing_snapshot` alone. `provider_model.status` — the column
 * whose whole job is to say which models this firm has decided to use — was never consulted, so
 * inserting a pricing row was sufficient to put a model in front of a partner. That is not a
 * hypothetical: migration 0158 added one snapshot for `perplexity/sonar` and by that single row a
 * search model became "cheapest adequate" for every unpinned call in the firm; migration 0088
 * recorded that Workers AI's three BENCH models were being routed to for the same reason, and
 * nothing acted on it.
 *
 * Joining `provider_model` and requiring ACTIVE closes it structurally. Becoming ACTIVE requires a
 * recorded evaluation and an authorised human (`handlePromoteModel`) or a reviewed migration. A
 * number can no longer elect anything; it can only order models somebody already approved. That is
 * the doctrine this file already applies to interpretation — "a mispriced row can make this dearer
 * or cheaper; it cannot make it stupid" — generalised to every selection.
 */
async function latestPricing(env: Env, providerIds: string[]): Promise<PricingRow[]> {
  if (providerIds.length === 0) return [];
  const placeholders = providerIds.map((_, i) => `?${i + 1}`).join(", ");
  const rows = await env.WP_OS_DB.prepare(
    `SELECT p.provider_id, p.model, p.input_per_mtok_usd, p.output_per_mtok_usd, p.request_usd,
            m.pricing_state, m.supports_reasoning
       FROM provider_pricing_snapshot p
       JOIN provider_model m ON m.provider_id = p.provider_id AND m.model = p.model
      WHERE p.provider_id IN (${placeholders})
        AND m.status = 'ACTIVE'
        AND p.captured_at = (
          SELECT MAX(p2.captured_at) FROM provider_pricing_snapshot p2
           WHERE p2.provider_id = p.provider_id AND p2.model = p.model
        )`,
  )
    .bind(...providerIds)
    .all<PricingRow>();
  return rows.results ?? [];
}

// ── Spend accounting ──

interface CostEstimate {
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  provider_key: string | null;
  model: string | null;
  input_per_mtok_usd: number | null;
  output_per_mtok_usd: number | null;
  surge_applied: boolean;
}

/**
 * Today's committed spend for a firm scope.
 *
 * This function used to carry its own copy of the definition — and its own day boundary,
 * `date(created_at) = date('now')`, while the scoped budgets next to it used a UTC midnight ISO
 * bound. Two of the three figures the operator found disagreeing came from exactly that. It is now
 * one line over `ai/spend.ts`, which every other reader of "what has this cost" also goes through.
 *
 * It now includes vendor spend as well as model spend, because the daily cap is the firm's ceiling
 * on what it spends, and an image bought outside the model boundary is money the firm spent.
 */
export async function dailySpendUsd(env: Env, firmScope: string): Promise<number> {
  return (await firmSpend(env, firmScope, "TODAY")).total_usd;
}

// ── Run recording ──

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function actorTypeForEvent(actor: Actor): "firm_user" | "ai_employee" | "system" {
  return actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system";
}

function actorIdOf(actor: Actor): string {
  return actor.firmUserId ?? actor.aiEmployeeId ?? "system";
}

interface RunRecordInput {
  input: RunAiInput;
  firmScope: string;
  privacyMode: PrivacyMode;
  costMode: CostMode;
  /**
   * WHICH JOB THIS WAS, stored on the run so that an outcome recorded later — at the moment a human
   * accepts or throws the output away — knows which (task kind, model) cell it belongs to. Without
   * it the learning table could only ever be populated by guessing at a purpose string.
   */
  taskKind: TaskKind;
  providerId: string | null;
  /** Provider key for the routing record; the run row itself stores provider_id. */
  providerKey?: string | null;
  model: string | null;
  status: AIRunStatus;
  estimate: CostEstimate;
  inputHash: string;
  traceId: string;
  runId: string;
  failureReason?: string;
}

async function insertRun(env: Env, rec: RunRecordInput): Promise<AIRunRow> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO ai_run
       (id, purpose, actor_type, actor_id, ai_employee_id, capability_requirement, sensitivity,
        privacy_mode, cost_mode, provider_id, model, status, cost_estimate_json, input_hash,
        trace_id, failure_reason, firm_scope, task_kind)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
  )
    .bind(
      rec.runId,
      rec.input.purpose,
      rec.input.actor.type,
      actorIdOf(rec.input.actor),
      rec.input.aiEmployeeId ?? null,
      rec.input.capabilityRequirement ?? null,
      rec.input.sensitivity,
      rec.privacyMode,
      rec.costMode,
      rec.providerId,
      rec.model,
      rec.status,
      JSON.stringify(rec.estimate),
      rec.inputHash,
      rec.traceId,
      rec.failureReason ?? null,
      rec.firmScope,
      rec.taskKind,
    )
  .run();
  return (await env.WP_OS_DB.prepare("SELECT * FROM ai_run WHERE id = ?1").bind(rec.runId).first<AIRunRow>())!;
}

async function recordBlockedRun(env: Env, rec: RunRecordInput): Promise<AIRunRow> {
  const row = await insertRun(env, rec);
  await appendEvent(env, {
    eventType: "ai_run.blocked",
    actorType: actorTypeForEvent(rec.input.actor),
    actorId: actorIdOf(rec.input.actor),
    objectType: "ai_run",
    objectId: row.id,
    firmScope: rec.firmScope,
    payload: { status: rec.status, reason: rec.failureReason ?? null, trace_id: rec.traceId, purpose: rec.input.purpose },
  });
  return row;
}

/**
 * One candidate the run may fall back to, and what it engages on.
 *
 * "ANY" is the existing policy fallback: a routing policy that sets allow_fallback has said it
 * wants the next candidate tried whatever went wrong. "OUTAGE" is the direct-vendor lane, and it
 * engages ONLY when the failure was the provider's — see shared/ai/providerFailure.ts. The
 * distinction is the difference between resilience and quietly asking a second vendor to repeat a
 * mistake: a model that refused a PDF because it cannot read one will refuse it again, and a
 * failover there would find a vendor willing to answer without having seen the file.
 */
export interface FallbackOption {
  candidate: RoutingCandidate;
  adapter: ProviderAdapter;
  engageOn: "ANY" | "OUTAGE";
  /**
   * THE RATES THIS CANDIDATE IS PRICED AT, so a run that falls over is billed at what it actually
   * used. The comment in `executeAttempt` admitted the old behaviour as "a knowable inaccuracy":
   * a run that fell back priced its tokens at the PLANNED model's rate. That was tolerable when a
   * fallback was the same price class; it is not tolerable now that a free lane can hand work to a
   * paid one, where the difference between the two rates is the entire point.
   */
  estimate?: CostEstimate;
}

/**
 * Execute one or more candidate providers for a run already decided as executable.
 *
 * One `ai_run` row is written regardless of how many candidates are tried: a run is one unit of
 * governed work, and the attempts are recorded on `ai_run_routing` instead of multiplying runs.
 * Candidates after the first are only supplied when a routing policy explicitly allows fallback.
 */
async function executeRun(
  env: Env,
  rec: RunRecordInput,
  adapter: ProviderAdapter,
  quarantine: boolean,
  fallbacks: FallbackOption[] = [],
  attempts: Array<{ provider_key: string; model: string; outcome: string; detail?: string }> = [],
): Promise<AIRunRow> {
  const running = await insertRun(env, { ...rec, status: "RUNNING" });
  return executeAttempt(env, rec, running.id, adapter, quarantine, fallbacks, attempts);
}

/** One provider attempt against an ai_run row that already exists. */
async function executeAttempt(
  env: Env,
  rec: RunRecordInput,
  runId: string,
  adapter: ProviderAdapter,
  quarantine: boolean,
  fallbacks: FallbackOption[] = [],
  attempts: Array<{ provider_key: string; model: string; outcome: string; detail?: string }> = [],
): Promise<AIRunRow> {
  const running = { id: runId };
  try {
    const response = await adapter.complete({
      purpose: rec.input.purpose,
      inputs: rec.input.inputs,
      ...(rec.input.images?.length ? { images: rec.input.images } : {}),
      ...(rec.input.documents?.length ? { documents: rec.input.documents } : {}),
      model: rec.model,
      capabilityRequirement: rec.input.capabilityRequirement,
    });
    // WHAT THE RUN ACTUALLY COST, priced locally when the provider will not say.
    //
    // Every completed run was recording cost_usd: 0, because OpenRouter only returns a cost when
    // asked and nobody was asking. The consequence was not cosmetic: spend-to-date is summed from
    // this field, so "spent today" was permanently zero and the firm's daily cap could never fire.
    // The only ceiling actually in force was the per-run one.
    //
    // The provider's own figure is preferred — it is the real bill. Falling back to the catalogue
    // rate on the planned model is an approximation, and on a run that fell back to a DIFFERENT
    // model it prices the tokens at the planned model's rate. That is a knowable inaccuracy and it
    // is still far better than recording nothing spent, because no run is free.
    const pricedLocally =
      (response.usage.inputTokens * (rec.estimate.input_per_mtok_usd ?? 0) +
        response.usage.outputTokens * (rec.estimate.output_per_mtok_usd ?? 0)) /
      1_000_000;
    const costUsd = response.usage.costUsd > 0 ? response.usage.costUsd : pricedLocally;

    const actualUsage = {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
      cost_usd: costUsd,
      /** Whether the number above is the provider's bill or our own arithmetic. */
      cost_source: response.usage.costUsd > 0 ? "provider" : "catalogue_rate",
      model: response.model,
    };
    await env.WP_OS_DB.prepare(
      `UPDATE ai_run
          SET status = 'COMPLETED', actual_usage_json = ?2, output_text = ?3,
              output_quarantine = ?4, completed_at = ?5
        WHERE id = ?1`,
    )
      .bind(running.id, JSON.stringify(actualUsage), response.text, quarantine ? 1 : 0, new Date().toISOString())
      .run();
    attempts.push({ provider_key: rec.providerKey ?? "local", model: response.model, outcome: "COMPLETED" });
    /*
     * THIS LANE WORKS. Recorded at the boundary itself, on the model the run was PLANNED on rather
     * than the one the vendor echoed back — `rec.model` is the id selection will look up next time,
     * and an alias resolving to a dated snapshot in `response.model` would file the credit under a
     * lane nothing can ever choose. Clears any back-off outright: a completion is a definitive
     * answer to "is this lane failing right now".
     */
    await recordLaneCompleted(env, rec.providerId, rec.model);
    await appendEvent(env, {
      eventType: "ai_run.completed",
      actorType: actorTypeForEvent(rec.input.actor),
      actorId: actorIdOf(rec.input.actor),
      objectType: "ai_run",
      objectId: running.id,
      firmScope: rec.firmScope,
      payload: {
        trace_id: rec.traceId,
        purpose: rec.input.purpose,
        provider_id: rec.providerId,
        model: response.model,
        output_quarantine: quarantine,
        cost_usd: costUsd,
      },
    });
  } catch (err) {
    // Manual fallback: provider failure is visible, never silently discarded (§3.5).
    const reason = err instanceof Error ? err.message : String(err);
    attempts.push({ provider_key: rec.providerKey ?? "unknown", model: rec.model ?? "unknown", outcome: "FAILED", detail: reason });

    // Policy-authorized fallback: retry the NEXT candidate against the same run row, so one unit
    // of governed work stays one run. The failed attempt is preserved in the routing record —
    // a fallback never hides a provider failure.
    /*
     * WHICH FALLBACKS MAY ENGAGE FOR *THIS* FAILURE.
     *
     * A policy fallback engages on anything — that is what allow_fallback has always meant. The
     * direct-vendor lane engages only on a provider outage, so a capability refusal
     * (`provider_cannot_read_documents:…`) stops here with a visible reason instead of being
     * passed to a second vendor that will answer it without the attachment.
     */
    const outage = isProviderOutage(reason);
    /*
     * ARM THE BACK-OFF, but only for an outage. A capability refusal or a genuinely malformed
     * request is OUR fault and would follow us to the next vendor; cooling a working lane for it
     * would take capacity away for a bug that is not the lane's.
     */
    if (outage) await recordLaneOutage(env, rec.providerId, rec.model, reason);

    /*
     * ── FALL BACK TO ONE THAT IS WORKING ─────────────────────────────────────────────────────
     *
     * The owner's words, and the emphasis is hers: "make it fallback to one that is working". Not
     * merely the next name on a list. So two things happen here that did not before.
     *
     * FIRST, lanes in outage back-off are skipped rather than attempted. Handing the work to a
     * vendor we already know is unfunded spends the chain's remaining options on a certainty.
     *
     * SECOND — and this is the recursion, a few lines below — a fallback that ALSO fails hands on
     * to the one after it, with the ones already tried removed. The chain only stops when nothing
     * is left, which is the difference between "the work continued" and "the card deferred and
     * somebody retried it fourteen minutes later".
     *
     * DEGRADES RATHER THAN REFUSES: if back-off would leave no option at all, the cooling lanes are
     * tried anyway. A stale cooldown must never be the reason a partner gets nothing.
     */
    const health = await laneHealth(env);
    const notCooling = (f: FallbackOption): boolean =>
      !isCoolingDown(health.get(`${f.candidate.providerId} ${f.candidate.model}`), new Date());
    const engaging = fallbacks.filter((f) => f.engageOn === "ANY" || outage);
    const warm = engaging.filter(notCooling);
    const eligible = warm.length > 0 ? warm : engaging;
    const next = eligible[0];
    if (next) {
      // Say WHAT kind of failure caused the handover, on the attempt itself, so the routing record
      // answers "did we fail over, and why" without anyone parsing an error string later.
      attempts[attempts.length - 1]!.outcome = "FAILED_OVER";
      attempts[attempts.length - 1]!.detail = `${outageKind(reason)}: ${reason}`;
    }
    if (next) {
      await env.WP_OS_DB.prepare("UPDATE ai_run SET provider_id = ?2, model = ?3 WHERE id = ?1")
        .bind(running.id, next.candidate.providerId, next.candidate.model)
        .run();
      return executeAttempt(
        env,
        {
          ...rec,
          providerId: next.candidate.providerId,
          providerKey: next.candidate.providerKey,
          model: next.candidate.model,
          estimate: next.estimate ?? rec.estimate,
        },
        running.id,
        next.adapter,
        quarantine,
        eligible.slice(1),
        attempts,
      );
    }

    await env.WP_OS_DB.prepare(
      "UPDATE ai_run SET status = 'BLOCKED_DEFERRED', failure_reason = ?2, completed_at = ?3 WHERE id = ?1",
    )
      .bind(running.id, `provider_failure:${reason}`, new Date().toISOString())
      .run();
    await appendEvent(env, {
      eventType: "ai_run.blocked",
      actorType: actorTypeForEvent(rec.input.actor),
      actorId: actorIdOf(rec.input.actor),
      objectType: "ai_run",
      objectId: running.id,
      firmScope: rec.firmScope,
      payload: { status: "BLOCKED_DEFERRED", reason: `provider_failure:${reason}`, trace_id: rec.traceId, purpose: rec.input.purpose },
    });
  }
  return (await env.WP_OS_DB.prepare("SELECT * FROM ai_run WHERE id = ?1").bind(running.id).first<AIRunRow>())!;
}

// ── The boundary ──

/** True when the platform gave this Worker the Workers AI binding — the near-free tier. */
export function workersAiConfigured(env: Env): boolean {
  return Boolean((env as unknown as { AI?: unknown }).AI);
}

export async function runAi(env: Env, runInput: RunAiInput, deps: RunAiDeps = {}): Promise<AIRunResult> {
  if (!runInput.purpose || runInput.purpose.trim().length === 0) {
    throw new RunAiError(400, "invalid_input", "purpose is required");
  }
  if (!Array.isArray(runInput.inputs) || runInput.inputs.length === 0) {
    throw new RunAiError(400, "invalid_input", "at least one input is required");
  }

  const now = deps.now ?? new Date();
  const firmScope = runInput.actor.firmScopes[0] ?? "west-peek";

  /*
   * ── FIRMWIDE NOTICES ────────────────────────────────────────────────────────────────────────
   *
   * THE ONE PLACE the firm's notices enter an employee prompt. Here, and not at the seventeen call
   * sites that name an employee, because a rule that each caller has to remember is a rule that a
   * new caller silently skips — which is precisely how `internal_memo` came to hold zero rows and
   * reach nothing. An employee run is a run that names an `aiEmployeeId`; a run with no employee
   * behind it (a mechanical extraction, a transcription) is not somebody the firm is instructing,
   * and is left exactly as it was.
   *
   * Prepended, so it is read before the task, and inside the boundary, so the scrubber, the budget
   * estimate and the input hash all see the text that is actually sent.
   *
   * Guarded by tests/firmNotices.test.ts.
   */
  const noticesBlock = runInput.aiEmployeeId ? await firmNoticesBlock(env, firmScope) : "";
  const input: RunAiInput = noticesBlock === "" ? runInput : { ...runInput, inputs: [noticesBlock, ...runInput.inputs] };

  const policy = await getLatestBudgetPolicy(env, firmScope);

  /*
   * ── WHERE THE FIRM IS, AND WHAT KIND OF CALL THIS IS ────────────────────────────────────────
   *
   * Two independent readings, and keeping them independent is the entire point of this change.
   *
   * `behaviour` is HOW MUCH MONEY: the lever she set, plus — inside MODERATE only — where this
   * month's spend against this month's ELAPSED TIME has put the gradient. Computed once, here, so
   * every branch below reads the same answer and none of them re-derives a posture from a mode
   * name and two booleans, which is how `cost_mode` came to mean four things.
   *
   * `isProtected` is HOW GOOD, and it comes from the CALL SITE's own marker, never from money.
   * This is the guarantee that makes the gradient safe to run automatically: no threshold, no
   * month-end pressure and no lever position may downgrade a call marked judgement, interpretation
   * or requiresSearch. Every gradient branch below asks `isProtected` first.
   *
   * The lever never moves the mode and the mode never moves the lever. They are two controls here
   * for that reason and must never be merged.
   */
  const spendLever = leverFromPolicy(policy as unknown as Parameters<typeof leverFromPolicy>[0]);
  const behaviour: SpendBehaviour = await currentSpendBehaviour(env, firmScope, spendLever, now);
  const isProtected = protectedFromSpendPressure(input.budgetContext ?? {});
  const taskKind: TaskKind = taskKindOf(input.budgetContext ?? {});

  const traceId = `trc_${crypto.randomUUID()}`;
  const runId = `air_${crypto.randomUUID()}`;
  const inputHash = await sha256Hex(input.inputs.join("\n"));

  const expectedInputTokens =
    input.budgetContext?.expectedInputTokens ??
    // Images are the expensive half of a vision run, and a budget check that cannot see them is
    // checking the cheap part.
    Math.max(1, Math.ceil(input.inputs.join("\n").length / 4)) +
    (input.images?.length ?? 0) * TOKENS_PER_IMAGE +
    (input.documents?.length ?? 0) * TOKENS_PER_DOCUMENT;
  const expectedOutputTokens = input.budgetContext?.expectedOutputTokens ?? 512;

  const baseEstimate: CostEstimate = {
    input_tokens: expectedInputTokens,
    output_tokens: expectedOutputTokens,
    estimated_cost_usd: 0,
    provider_key: null,
    model: null,
    input_per_mtok_usd: null,
    output_per_mtok_usd: null,
    /*
     * Always false now. The field stays because `cost_estimate_json` is written on every historical
     * run and a reader of the archive must still find the key it expects; a surge is no longer a
     * thing a run can be inside. Cap lifting is a `spend_bypass` row, checked against the firmwide
     * ceiling rather than folded into a per-run estimate.
     */
    surge_applied: false,
  };

  /*
   * MUTABLE BECAUSE REDACTION HAPPENS AFTER THIS IS BUILT. The record carries the input that is
   * handed to the provider adapter, and the credential scrub runs further down; leaving this
   * `const` meant a redacting run would have redacted a local copy and sent the original — a
   * safety feature that reported success while doing nothing. It is rebuilt in place there, and
   * `blocked()` closes over the binding rather than the value so it always sees the current one.
   */
  let baseRec: Omit<RunRecordInput, "status" | "estimate" | "failureReason" | "providerId" | "model"> = {
    input,
    firmScope,
    privacyMode: policy.privacy_mode,
    // DERIVED FROM THE LEVER, never consulted by it. `ai_run.cost_mode` is NOT NULL and every
    // archived run carries it, so it keeps being written — as a description of the lever position,
    // which is the only honest thing it can now say.
    costMode: legacyCostModeFor(spendLever),
    taskKind,
    inputHash,
    traceId,
    runId,
  };

  const attribution = {
    machineId: input.routing?.machineId ?? null,
    workCardId: input.routing?.workCardId ?? null,
    category: input.routing?.category ?? "OTHER",
  };

  const blocked = async (
    status: AIRunStatus,
    reason: string,
    estimate: CostEstimate = baseEstimate,
    providerId: string | null = null,
    model: string | null = null,
  ) => {
    const row = await recordBlockedRun(env, { ...baseRec, providerId, model, status, estimate, failureReason: reason });
    // Attribution is recorded for BLOCKED runs too: a run that was refused still tells the cost
    // centre which machine/category is generating refused work.
    await recordAttribution(env, row.id, attribution);
    return row;
  };

  /*
   * 0a. IMAGES — the gate, and it is not a formality.
   *
   * Every control in this pipeline was written for text. The credential scrubber reads strings; a
   * screenshot of a page displaying an API key is, to that scrubber, an opaque blob. So an image
   * cannot be cleared the way a paragraph can, and the only honest position is that images ride the
   * DECLARED sensitivity and nothing else.
   *
   * PUBLIC and INTERNAL only, checked here rather than left to the data policy alone. The data
   * policy would already deny RESTRICTED and above to OpenRouter, and this is the same answer
   * arrived at twice on purpose: a future provider permitted a higher label for text would silently
   * inherit that permission for images, and a screenshot of an LP portal is not the same risk as a
   * sentence about one. Refusing here means adding such a provider cannot quietly widen this.
   *
   * The count cap is a spend control. Two viewports of one page is the real case; twenty
   * screenshots in one call is either a mistake or an expensive accident.
   */
  if (input.images?.length) {
    if (input.sensitivity !== "PUBLIC" && input.sensitivity !== "INTERNAL") {
      return {
        run: await blocked("EGRESS_BLOCKED", `images_not_permitted_at_label:${input.sensitivity}`),
      };
    }
    if (input.images.length > MAX_IMAGES_PER_RUN) {
      return {
        run: await blocked("PREFLIGHT_BLOCKED", `too_many_images:${input.images.length}>${MAX_IMAGES_PER_RUN}`),
      };
    }
    const badType = input.images.find((i) => i.mediaType !== "image/jpeg" && i.mediaType !== "image/png");
    if (badType) {
      return { run: await blocked("PREFLIGHT_BLOCKED", `unsupported_image_type:${badType.mediaType}`) };
    }
  }

  /*
   * Documents get the same three guards as images, for the same reasons.
   *
   * A deck leaves the building when it is sent, so the label gate is the important one: a document
   * a partner marked confidential does not go to a third-party model because somebody pressed
   * "read the deck".
   */
  if (input.documents?.length) {
    if (input.sensitivity !== "PUBLIC" && input.sensitivity !== "INTERNAL") {
      return {
        run: await blocked("EGRESS_BLOCKED", `documents_not_permitted_at_label:${input.sensitivity}`),
      };
    }
    if (input.documents.length > MAX_DOCUMENTS_PER_RUN) {
      return {
        run: await blocked("PREFLIGHT_BLOCKED", `too_many_documents:${input.documents.length}>${MAX_DOCUMENTS_PER_RUN}`),
      };
    }
    const badDoc = input.documents.find((d) => d.mediaType !== "application/pdf");
    if (badDoc) {
      return { run: await blocked("PREFLIGHT_BLOCKED", `unsupported_document_type:${badDoc.mediaType}`) };
    }
  }

  // 0. Machine pause (P17): a paused machine cannot spend AI budget. Checked before anything
  //    else so a paused machine costs nothing, not even an estimate.
  if (attribution.machineId !== null) {
    const machineState = await env.WP_OS_DB.prepare("SELECT status, pause_reason FROM machine_state WHERE machine_id = ?1")
      .bind(attribution.machineId)
      .first<{ status: string; pause_reason: string | null }>();
    if (machineState?.status === "PAUSED") {
      return {
        run: await blocked(
          "PREFLIGHT_BLOCKED",
          `machine_paused:${attribution.machineId}:${machineState.pause_reason ?? "no reason recorded"}`,
        ),
      };
    }
  }

  /*
   * 1. "WHAT WORK RUNS AT ALL" — its own question, and now its own column.
   *
   * This was `cost_mode = 'CRITICAL_ONLY'`, sitting in the same enum as NORMAL and CHEAPO as though
   * "run less work" were a spend level. It is not: it composes with every lever position, and a
   * firm can perfectly well want MODERATE spending AND only critical work, or FREE_ONLY spending
   * and all of it. Merging them meant choosing either was choosing both.
   *
   * `defer_non_critical` is read directly rather than through the lever, and the old value still
   * works: migration 0179 set this flag on every historical CRITICAL_ONLY row, and
   * `translateLegacyCostMode` sets it for any caller still sending that value.
   */
  const deferNonCritical = deferNonCriticalFromPolicy(policy as unknown as Parameters<typeof deferNonCriticalFromPolicy>[0]);
  if (deferNonCritical && !isCriticalPurpose(input.purpose, input.budgetContext)) {
    return { run: await blocked("BLOCKED_DEFERRED", "defer_non_critical:non_critical_purpose") };
  }

  // 2. Credential scrub: no credentials in LLM context, ever.
  //
  // Two ways to honour that. Blocking refuses the run; redacting removes the span and proceeds.
  // Neither lets the matched text reach a provider, and redaction is available only to callers
  // that asked for it — see RunAiInput.onCredentialLike for when that is the right trade.
  let effectiveInputs = input.inputs;
  const scrub = scrubInputs(input.inputs);
  if (scrub.blocked) {
    if (input.onCredentialLike !== "redact") {
      return { run: await blocked("EGRESS_BLOCKED", `credential_like_content:${scrub.matches.join(",")}`) };
    }
    const cut = redactInputs(input.inputs);
    effectiveInputs = cut.inputs;
    // The record is what reaches the adapter. Rebuilding it here is the entire point of redacting.
    baseRec = { ...baseRec, input: { ...input, inputs: effectiveInputs } };
    // Recorded, because altering what a model was shown and not saying so would make the run
    // record a description of a call that did not happen.
    await appendEvent(env, {
      eventType: "ai.input_redacted",
      actorType: "system",
      actorId: "system",
      objectType: "ai_run",
      objectId: input.purpose,
      payload: { purpose: input.purpose, patterns: cut.redacted, spans: cut.count },
    });
    /*
     * BELT AND BRACES. If redaction somehow left something matching, the run is refused as it
     * would have been before. Redaction is a narrowing of the blast radius, never a way past
     * the gate.
     */
    if (scrubInputs(effectiveInputs).blocked) {
      return { run: await blocked("EGRESS_BLOCKED", `credential_like_content:${scrub.matches.join(",")}`) };
    }
  }

  /*
   * 2b. NO MODEL THAT RUNS LOCALLY CAN SEE.
   *
   * LOCKDOWN and LOCAL route to the deterministic offline adapter, which returns canned text. Hand
   * it screenshots and it does not fail — it answers from the prompt, exactly as a text-only
   * frontier model would, and a design review comes back fluent and entirely invented.
   *
   * This is the same failure the vision-capability check below guards against, arriving one step
   * earlier and by a different door: the privacy short-circuit returns before that check is ever
   * reached. Caught by instrumenting the guard and finding it was never executed in a test that
   * completed a run with images attached.
   *
   * REFUSED RATHER THAN DEGRADED. There is no honest text-only version of "look at this page and
   * tell me what is wrong with it", so the run stops and says why. Anyone who needs it can take the
   * firm out of lockdown deliberately.
   */
  if (input.images?.length && (policy.privacy_mode === "LOCKDOWN" || policy.privacy_mode === "LOCAL")) {
    return {
      run: await blocked("PREFLIGHT_BLOCKED", `images_need_a_frontier_model:privacy_mode_${policy.privacy_mode}`),
    };
  }

  // 3. Privacy-mode resolution (D8).
  if (policy.privacy_mode === "LOCKDOWN" || policy.privacy_mode === "LOCAL") {
    // Local/manual path: the deterministic local adapter always works offline.
    const adapter = createMockLocalAdapter();
    const attempts: Array<{ provider_key: string; model: string; outcome: string; detail?: string }> = [];
    const run = await executeRun(
      env,
      { ...baseRec, providerId: null, providerKey: "local", model: MOCK_LOCAL_MODEL, status: "RUNNING", estimate: baseEstimate },
      adapter,
      false,
      [],
      attempts,
    );
    await recordAttribution(env, run.id, attribution);
    await recordRouting(env, {
      runId: run.id,
      taskClass: input.routing?.taskClass,
      selectedProviderKey: "local",
      selectedModel: MOCK_LOCAL_MODEL,
      attempts,
      fallbackUsed: false,
      explanation: `privacy mode ${policy.privacy_mode}: no external provider may be used, so the deterministic local adapter ran. No data left this system.`,
    });
    return { run };
  }

  // ── FRONTIER: external path ──

  // 4. Provider availability (kill switch / disabled).
  const pinnedKey = input.budgetContext?.providerKey;
  let candidates: ProviderRow[];
  if (pinnedKey) {
    const pinned = await env.WP_OS_DB.prepare("SELECT * FROM provider_registry WHERE provider_key = ?1")
      .bind(pinnedKey)
      .first<ProviderRow>();
    if (!pinned || pinned.enabled !== 1) {
      return { run: await blocked("PROVIDER_DISABLED", `provider_disabled:${pinnedKey}`) };
    }
    if (pinned.kill_switched === 1) {
      return { run: await blocked("KILL_SWITCHED", `provider_kill_switched:${pinnedKey}`) };
    }
    candidates = [pinned];
  } else {
    const enabled = await env.WP_OS_DB.prepare("SELECT * FROM provider_registry WHERE enabled = 1").all<ProviderRow>();
    const all = enabled.results ?? [];
    candidates = all.filter((p) => p.kill_switched !== 1);
    if (candidates.length === 0) {
      if (all.some((p) => p.kill_switched === 1)) {
        return { run: await blocked("KILL_SWITCHED", "provider_kill_switched:all_enabled_providers") };
      }
      return { run: await blocked("PROVIDER_DISABLED", "provider_disabled:no_enabled_providers") };
    }
  }

  /*
   * 4b. NOTHING CONFIDENTIAL GOES ANYWHERE THAT MAY TRAIN ON IT.
   *
   * The owner's line, in her words: "yes LP names and deal terms are confidential." A free route is
   * generally free BECAUSE the provider may use what you send it to improve their models — Google
   * says so in terms, verbatim: "Do not submit sensitive, confidential, or personal information to
   * the Unpaid Services."
   *
   * Two independent things stop it, because one would be enough right up until it wasn't:
   *   · the data class. Every training-permitting lane allows PUBLIC and nothing else, so anything
   *     labelled INTERNAL or above is refused by the egress gate below without this line existing.
   *   · this line. A caller marks the CALL confidential, which is a fact about the words rather
   *     than about the label — a PUBLIC-labelled summary of a deal still contains the terms.
   *
   * Refused HERE, before a request is formed, and not checked by the caller afterwards. That is the
   * sonar lesson: callers used to say "must not be the search model" in an if-statement after the
   * run, which is not a rule, it is a hope.
   */
  if (input.budgetContext?.confidential === true) {
    candidates = candidates.filter((p) => Number((p as unknown as { training_permitted?: number }).training_permitted ?? 0) !== 1);
    if (candidates.length === 0) {
      return {
        run: await blocked(
          "EGRESS_BLOCKED",
          "confidential_call_has_no_lane_that_does_not_train:LP names and deal terms may not reach a route whose terms permit training",
        ),
      };
    }
  }

  /*
   * ── 4c. WHO IT GOES TO, AND WHAT IS IN IT, ARE TWO DIFFERENT QUESTIONS ────────────────────────
   *
   * "WHY IS INTERNAL STUFF COSTING A LOT? THAT IS BACKWARDS." — the owner, 17 Sep 2026, on finding
   * that a hire search ran on `anthropic/claude-sonnet-5`.
   *
   * She was right, and the router was not at fault. `sensitivity: "INTERNAL"` means the work is
   * ADDRESSED TO A PARTNER — her own rule, settled: "ITS INTERNAL IF IT GOES TO ME SEQUOIA OR
   * SCOOTER". It had come to be read as "too private to train on", which it never meant. Every
   * training-permitting lane is capped at PUBLIC — correctly, and that cap does not move — so an
   * INTERNAL label made both free reasoning models ineligible and left exactly ONE legal lane in
   * the entire catalogue: the dearest model on the account. One legal choice is not a choice.
   *
   * So the content class is decided here, separately, and it decides ONE thing: whether a route
   * whose terms permit training may serve this run. It is declared — by the work card's own
   * `confidential` flag, or by a named machine — never inferred from the recipient, and it is
   * revoked by any LP or deal-term marker actually present in the text.
   */
  const contentClass: ContentClassVerdict = classifyContent({
    declaredPublicModelApproved: input.budgetContext?.publicModelApproved,
    // `confidential` is the legacy spelling of PRIVATE_MODEL_ONLY and is still honoured verbatim.
    declaredPrivateModelOnly: input.budgetContext?.confidential,
    machineKey: input.routing?.machineId
      ? (MACHINE_REGISTRY.find((m) => m.id === input.routing!.machineId)?.key ?? null)
      : null,
    inputs: input.inputs,
  });

  // 5. Egress check (D9 default-deny): the sensitivity label must be explicitly
  //    allowed for the provider. Restricted labels can never leave.
  /*
   * ONE EXCEPTION, AND IT IS NOT A LOOSENING OF THE GATE — it is the gate finally being asked the
   * question it was always meant to answer.
   *
   * A training-permitting lane's PUBLIC cap is a statement about CONTENT: do not send this route
   * anything private, because its terms let it train on what it receives. Checking that cap against
   * a label that describes the RECIPIENT answered a different question and answered it wrongly in
   * one direction only — a room packet for Sequoia was refused a free model it was perfectly
   * entitled to use.
   *
   * So for a training-permitting provider, and ONLY where the content class says this run carries
   * no LP or deal material, the cap is evaluated against PUBLIC. Every other provider, and every
   * run whose content is not declared safe, is evaluated against the run's own label exactly as
   * before. No cap moved, no label was rewritten, and nothing confidential gained a route: step 4b
   * has already removed every training-permitting lane from a call marked confidential, and
   * `classifyContent` refuses the declaration outright for such a call as well.
   */
  const egressLabelFor = (provider: ProviderRow): string =>
    Number((provider as unknown as { training_permitted?: number }).training_permitted ?? 0) === 1 && contentClass.publicModelApproved
      ? "PUBLIC"
      : input.sensitivity;
  const egressAllowed: ProviderRow[] = [];
  for (const provider of candidates) {
    if (await dataPolicyAllows(env, provider.id, egressLabelFor(provider))) egressAllowed.push(provider);
  }
  if (egressAllowed.length === 0) {
    return { run: await blocked("EGRESS_BLOCKED", `data_policy_denies_label:${input.sensitivity}`) };
  }

  // 6. Model selection from the latest pricing snapshots.
  const capability = input.capabilityRequirement ?? "text-completion";
  const capable = egressAllowed.filter((p) => {
    try {
      return (JSON.parse(p.capabilities_json) as string[]).includes(capability);
    } catch {
      return false;
    }
  });
  /*
   * A PROVIDER THAT CANNOT BE CALLED IS NOT A CANDIDATE — but only where that is knowable.
   *
   * HTTP providers are excluded from this check on purpose. A missing key there produces a run that
   * lands BLOCKED_DEFERRED with an honest reason, and the tests inject a fetch stub precisely so
   * that path stays exercisable; filtering on key presence would quietly change what they cover.
   *
   * Workers AI is different in kind. It is a BINDING: absent means there is no object to call at
   * all, it cannot be stubbed through fetch, and it is the cheapest thing in the catalogue — so it
   * wins every unpinned selection and then fails every one of them. Adding it broke every routing
   * test in exactly that way, which is the same thing that would have happened in any environment
   * where the binding was not granted.
   *
   * So: skipped when unbound, considered when bound. Narrow, and for a reason that does not
   * generalise to the others.
   */
  const bindingAbsent = !workersAiConfigured(env);
  const selectable = bindingAbsent ? capable.filter((p) => p.provider_key !== "workers_ai") : capable;

  const pricing = await latestPricing(env, selectable.map((p) => p.id));
  const options: ModelOption[] = pricing.flatMap((price) => {
    const provider = selectable.find((p) => p.id === price.provider_id);
    return provider ? [{ provider, pricing: price }] : [];
  });
  if (options.length === 0) {
    return { run: await blocked("PREFLIGHT_BLOCKED", "no_active_priced_model") };
  }

  /*
   * A PRICE NOBODY READ MAY NOT DECIDE ANYTHING.
   *
   * `pricing_state` records where a number came from. SOURCED means somebody read it from the
   * vendor and wrote down when. STALE means they did, a while ago. ILLUSTRATIVE and UNKNOWN mean
   * nobody ever did — the P4 seed's own words are "placeholder pricing seeded at P4; no vendor
   * price has been read".
   *
   * Every branch below ranks candidates BY PRICE, cheapest or dearest. Ranking on a number nobody
   * read is how migration 0158 elected a search model for every judgement call in the firm. So a
   * model whose price has never been read is removed from the ranking outright.
   *
   * WHY NOT "treat an unknown price as expensive", the obvious alternative. Because the dearest
   * candidate WINS the 'best available' and judgement branches. Scoring an unread price high would
   * hand exactly those branches — the ones that matter most — to the invented number. It is 0158
   * again with the sign flipped.
   *
   * THIS IS NOT INERT. Every price in this catalogue was ILLUSTRATIVE until migration 0177 read the
   * real ones from OpenRouter's public feed and Cloudflare's published list, so the guard has real
   * teeth today: all five ACTIVE models pass it, `openrouter/auto` (whose price the feed reports as
   * -1, i.e. there isn't one) does not. If a future row arrives priced by guesswork it is inert for
   * selection, whatever the number says.
   *
   * DEGRADES ONLY WHERE REFUSING WOULD BE WORSE: when NOTHING has a read price the ranking falls
   * back to the whole set and the run says so, because a firm whose catalogue is entirely
   * placeholders should get its work done and an explanation an operator can act on, not a blocked
   * run it cannot interpret.
   */
  const priceWasRead = (o: ModelOption): boolean =>
    o.pricing.pricing_state === "SOURCED" || o.pricing.pricing_state === "STALE";
  const READ_PRICE = new Set(options.filter(priceWasRead).map((o) => `${o.provider.id} ${o.pricing.model}`));
  /*
   * Narrow a list to the candidates a COST COMPARISON is allowed to decide between.
   *
   * Applied at each cheapest/dearest reduction and nowhere else, because that is precisely where
   * price decides. A routing policy or a machine pin NAMES a model: that is somebody's decision and
   * it stands whatever the provenance of the price beside it, so pins are ordered from the full
   * ACTIVE set and never pass through here.
   */
  const costRanked = (list: RoutingCandidate[]): RoutingCandidate[] => {
    const read = list.filter((c) => READ_PRICE.has(`${c.providerId} ${c.model}`));
    return read.length > 0 ? read : list;
  };
  const anyReadPrice = READ_PRICE.size > 0;
  const provenanceNote = anyReadPrice
    ? READ_PRICE.size < options.length
      ? " Models whose price has never been read from the vendor took no part in the cost comparison."
      : ""
    : " No candidate carries a price anybody has read from a vendor, so the cost ordering here rests on placeholder numbers and is not evidence of anything.";

  // The per-request fee is part of the price. Search-grounded models charge one — perplexity/sonar
  // is $0.005 a request, which on a short call is several times the token cost — and this system
  // modelled it as zero until migration 0177 added the column.
  const estimateFor = (option: ModelOption): number =>
    option.pricing.request_usd +
    (expectedInputTokens * option.pricing.input_per_mtok_usd + expectedOutputTokens * option.pricing.output_per_mtok_usd) / 1_000_000;

  // ── P16 routing ──
  // Precedence, most specific first: machine model policy → task routing policy →
  // explicit preferred model → cheapest adequate. Every step is recorded in the
  // explanation, so "why this model?" is answerable from stored fact.
  /*
   * A FREE LANE NEVER WINS AN ORDINARY SELECTION, and it took a test suite going quiet to notice
   * why that matters.
   *
   * A free model's price is $0, so the moment the lanes existed they became the cheapest thing in
   * the catalogue and started taking every PUBLIC-labelled call in the firm — including mechanical
   * work that had been going to a paid or platform lane. That is a widening nobody asked for: it
   * moves the DEFAULT destination for public content onto routes whose terms permit training,
   * silently, on the strength of a zero.
   *
   * Free capacity is opt-in, for quality-critical public-facing work, through the free-first path
   * at step 8a — where it is chosen deliberately and said out loud on the run. Everything else
   * keeps going where it went, and mechanical work stays on Workers AI, which is nearly free AND
   * carries no training rights at all.
   */
  const paidOptions = options.filter((o) => Number(o.provider.training_permitted ?? 0) !== 1);
  const everyCandidate: RoutingCandidate[] = paidOptions.map((o) => ({
    providerId: o.provider.id,
    providerKey: o.provider.provider_key,
    model: o.pricing.model,
    estimatedCostUsd: estimateFor(o),
    baseUrl: o.provider.base_url,
  }));

  /*
   * ── OPENROUTER FIRST AND FOREMOST; THE DIRECT LANES ARE FALLBACKS ─────────────────────────────
   *
   * The owner's intended order, and until now it held only because the direct vendors happened to
   * hold no ACTIVE catalogue rows. `directVendorRoute.ts` says so in as many words — "they exist on
   * this path only, and only after the primary has actually failed" — but that was a property of
   * the DATA, and on 17 Sep 2026 production had a `prov_anthropic / claude-sonnet-5` row that could
   * win an ordinary selection. It priced BELOW the OpenRouter lane for the identical model, because
   * it carries no margin, so it did win. It had never completed a run, and it answered "Your credit
   * balance is too low". The card deferred three times in fourteen minutes.
   *
   * A doctrine that depends on nobody adding a row is not a doctrine. So it is enforced here: where
   * the SAME MODEL is reachable both through OpenRouter and through its own vendor, the direct lane
   * is removed from ordinary selection. Nothing is lost — it is rebuilt a few hundred lines below as
   * an OUTAGE fallback, engaging only when OpenRouter actually fails, which is precisely the role
   * the owner described for it.
   *
   * NARROW ON PURPOSE. Only a lane that is a direct peer OF A PRESENT OPENROUTER CANDIDATE is
   * demoted. A vendor serving a model OpenRouter does not carry keeps its ordinary candidacy, so
   * this can never shrink the firm's real choice — it only refuses to let the same model be counted
   * twice at two prices and elected on the cheaper of them.
   */
  const viaOpenRouter = new Map<string, RoutingCandidate>();
  for (const c of everyCandidate) {
    if (c.providerKey !== "openrouter" && c.providerKey !== "openrouter_free") continue;
    const direct = directVendorRouteFor(c.model);
    if (direct) viaOpenRouter.set(`${direct.providerKey} ${direct.model}`, c);
  }
  const demotedDirectLanes = everyCandidate.filter((c) => viaOpenRouter.has(`${c.providerKey} ${c.model}`));
  const allCandidates: RoutingCandidate[] =
    demotedDirectLanes.length > 0 ? everyCandidate.filter((c) => !demotedDirectLanes.includes(c)) : everyCandidate;
  const directLaneNote =
    demotedDirectLanes.length === 0
      ? ""
      : ` ${demotedDirectLanes.map((c) => `${c.providerKey}/${c.model}`).join(", ")} ` +
        `${demotedDirectLanes.length === 1 ? "is the same model" : "are the same models"} OpenRouter already serves for this call, so ` +
        `${demotedDirectLanes.length === 1 ? "it was" : "they were"} not ranked against it on price: OpenRouter leads and a direct vendor lane ` +
        `is reached only when OpenRouter cannot serve.`;

  /*
   * JUDGEMENT WORK DOES NOT GO TO A SEARCH MODEL, and the filter happens here rather than in the
   * caller's if-statement afterwards. Falls back to the whole list when filtering would leave
   * nothing: a firm with only a search model registered should get a worse answer and an
   * explanation on the run, not a refusal it cannot act on.
   */
  const isInterpretation = input.budgetContext?.interpretation === true;
  const isJudgement = isInterpretation || input.budgetContext?.judgement === true;
  /*
   * A CALL THAT EXISTS TO SEARCH MUST REACH A MODEL THAT CAN SEARCH — the mirror image of the rule
   * below it, and the reason it exists is CHEAPO.
   *
   * Eight call sites pin `preferredModel: SEARCH_MODEL` and marked nothing else. CHEAPO ignores a
   * `preferredModel` outright, so switching the firm to CHEAPO would have routed every live search
   * to the cheapest model in the catalogue — a small local model with no web access — which would
   * have answered fluently, from memory, about this morning's market. Marking them `judgement`
   * would have been worse: judgement REMOVES search models on purpose.
   *
   * REFUSES RATHER THAN DEGRADES, and this is the one place in this function that does. Everywhere
   * else a missing capability produces the best available plus an explanation, because a worse
   * answer is still an answer. There is no worse-but-honest version of "what happened today": a
   * model answering from memory produces something indistinguishable from research, and it gets
   * believed.
   */
  const requiresSearch = input.budgetContext?.requiresSearch === true;
  if (requiresSearch) {
    const searchCapable = allCandidates.filter((c) => isSearchGrounded(c.model));
    if (searchCapable.length === 0) {
      return {
        run: await blocked(
          "PREFLIGHT_BLOCKED",
          "no_search_grounded_model_available:this call has to reach the live web and no model that can is available; a confident answer from memory would be worse than none",
        ),
      };
    }
  }
  const notSearch = allCandidates.filter((c) => !isSearchGrounded(c.model));
  const judged: RoutingCandidate[] = requiresSearch
    ? allCandidates.filter((c) => isSearchGrounded(c.model))
    : isJudgement && notSearch.length > 0
      ? notSearch
      : allCandidates;
  const searchExcluded = !requiresSearch && isJudgement && notSearch.length > 0 && notSearch.length < allCandidates.length;

  /*
   * READING AN OWNER'S INSTRUCTION ASKS THE CATALOGUE ABOUT CAPABILITY, NOT PRICE.
   *
   * `judgement` below orders unpinned candidates by cost and takes the dearest, because price is
   * the only quality signal `provider_model` holds. That proxy was good enough until a single
   * pricing row (0158, `perplexity/sonar` at $1/$1) re-elected an unsuitable model for every
   * unpinned call in the firm. Price is configuration; which model reads what a partner meant must
   * not be decided by configuration.
   *
   * `supports_reasoning` is a recorded property of the model rather than of its price, so this
   * filter cannot be moved by a pricing snapshot. Among the models that pass it, price still
   * orders them — a mispriced row can make this dearer, never weaker.
   *
   * DEGRADES RATHER THAN REFUSES, and says so on the run. A firm whose catalogue records no
   * reasoning model at all should get the best it has and an explanation an operator can act on,
   * not a blocked run it cannot interpret.
   */
  let reasoningOnly: RoutingCandidate[] = judged;
  let reasoningFilterApplied = false;
  if (isInterpretation) {
    const rows = await env.WP_OS_DB.prepare(
      "SELECT provider_id, model FROM provider_model WHERE supports_reasoning = 1 AND status <> 'DEPRECATED'",
    ).all<{ provider_id: string; model: string }>();
    const canReason = new Set((rows.results ?? []).map((r) => `${r.provider_id} ${r.model}`));
    const filtered = judged.filter((c) => canReason.has(`${c.providerId} ${c.model}`));
    if (filtered.length > 0) {
      reasoningOnly = filtered;
      reasoningFilterApplied = filtered.length < judged.length;
    }
  }
  /*
   * ── FREE_ONLY: NOTHING PAID, AT ALL — AND THE ONE COLLISION, WHICH FAILS LOUDLY ─────────────
   *
   * At this lever position the head of the run must cost $0. That means the free lanes are eligible
   * to WIN a selection here, which they deliberately are not anywhere else (a $0 price would
   * otherwise make them the cheapest thing in the catalogue and quietly capture every public call
   * in the firm). Here it is not a side effect of a zero; it is the instruction.
   *
   * They arrive already filtered for confidentiality — step 4b removed every training-permitting
   * lane from `options` when the call is marked confidential — and they must clear the SAME
   * adequacy bar the paid head would have cleared. A free model does not get to read a partner's
   * instruction just because it costs nothing.
   *
   * THE COLLISION, AND SHE HAS DECIDED IT: FAIL LOUDLY.
   *
   * Protected work at FREE_ONLY that has no adequate free model STOPS and says so, naming the work
   * and naming the lever. It never quietly takes a weaker model. She understands this can stop her
   * morning brief; that is the intended behaviour, and it is the only honest resolution of two
   * instructions that genuinely conflict — "nothing paid" and "never downgrade this". The
   * alternative, silently using a weaker model, is the failure mode this whole file exists to
   * prevent: the cheap tier once produced "the 30-year U.S. tax at 19 year high" and shipped it as
   * fact, on the page the partners read first.
   */
  let routingCandidates: RoutingCandidate[] = reasoningOnly;
  let freeOnlyNote = "";
  if (behaviour.freeOnly) {
    const freeAdequate = options
      .filter((o) => estimateFor(o) === 0)
      .filter((o) => credentialConfigured(env, o.provider.provider_key))
      // The same bar, expressed against `options` because the free lanes are not in `allCandidates`.
      .filter((o) => (requiresSearch ? isSearchGrounded(o.pricing.model) : !(isJudgement && isSearchGrounded(o.pricing.model))))
      .filter((o) => !isInterpretation || o.pricing.supports_reasoning === 1);

    if (freeAdequate.length === 0) {
      if (isProtected) {
        return {
          run: await blocked(
            "PREFLIGHT_BLOCKED",
            `free_only_cannot_serve_protected_work:this call is marked '${taskKind}' and needs a paid model, ` +
              `and the lever is set to FREE_ONLY. Purpose: ${input.purpose}. It has been stopped rather than ` +
              `quietly given a weaker model. Move the lever to MODERATE to let it run.`,
          ),
        };
      }
      return {
        run: await blocked(
          "PREFLIGHT_BLOCKED",
          `free_only_no_free_model_available:the lever is set to FREE_ONLY and no free model is available and adequate for this call`,
        ),
      };
    }
    routingCandidates = freeAdequate.map((o) => ({
      providerId: o.provider.id,
      providerKey: o.provider.provider_key,
      model: o.pricing.model,
      estimatedCostUsd: 0,
      baseUrl: o.provider.base_url,
    }));
    freeOnlyNote =
      ` The lever is set to Free only, so only models costing nothing were candidates` +
      (isProtected ? `, and this protected call found one — had it not, the run would have stopped rather than been downgraded.` : `.`);
  }
  const interpretationNote = !isInterpretation
    ? ""
    : reasoningFilterApplied
      ? " This call reads what a partner asked for, so only models the catalogue records as able to reason were candidates; price ordered those, it did not choose them."
      : reasoningOnly === judged && judged.length > 0
        ? " This call reads what a partner asked for. The catalogue records no model that can reason and is not search-grounded, so the best available was used and this run is weaker than it should be."
        : " This call reads what a partner asked for, and every available model is recorded as able to reason.";
  const judgementNote =
    (searchExcluded
      ? " This call interprets or drafts, so the search-grounded models were not candidates."
      : isJudgement && notSearch.length === 0
        ? " This call interprets or drafts, but every available model is search-grounded, so one was used anyway."
        : "") + interpretationNote;

  const machinePolicy = input.routing?.machineId
    ? await env.WP_OS_DB.prepare("SELECT * FROM machine_model_policy WHERE machine_id = ?1")
        .bind(input.routing.machineId)
        .first<{ preferred_provider_key: string | null; preferred_model: string | null }>()
    : null;
  const routePolicy = await latestRoutingPolicy(env, input.routing?.taskClass);

  let ordered: RoutingCandidate[] = [];
  let explanation: string;
  if (machinePolicy?.preferred_provider_key && machinePolicy.preferred_model) {
    const pinned = routingCandidates.find(
      (c) => c.providerKey === machinePolicy.preferred_provider_key && c.model === machinePolicy.preferred_model,
    );
    if (pinned) {
      ordered = [pinned];
      explanation = `machine ${input.routing!.machineId} pins ${pinned.providerKey}/${pinned.model}`;
    } else {
      ordered = [];
      explanation = `machine ${input.routing!.machineId} pins ${machinePolicy.preferred_provider_key}/${machinePolicy.preferred_model}, which is not available (disabled, egress-denied, or unpriced)`;
    }
  /*
   * DOES A ROUTING PIN SURVIVE THE MONEY? Exactly one condition, in one place.
   *
   * A pin is somebody's per-task quality decision, and it stands unless the firm is genuinely
   * economising AND this call is not protected. `behaviour.freeFirst` is true at FREE_ONLY and at
   * the CAUTIOUS end of the gradient — the two positions where the owner said paid models are kept
   * for protected work — and `isProtected` is the guarantee that keeps judgement, interpretation
   * and search work out of reach of any of it.
   *
   * This used to read `cost_mode === "CHEAPO" && honours_pins === 0`: two columns, in two different
   * vocabularies, expressing one idea that neither of them named.
   */
  } else if (routePolicy && !(behaviour.freeFirst && !isProtected)) {
    ordered = orderByPolicy(routePolicy, routingCandidates);
    explanation =
      ordered.length > 0
        ? `routing policy '${routePolicy.task_class}' v${routePolicy.version_no}: ${ordered.map((c) => `${c.providerKey}/${c.model}`).join(" → ")}${routePolicy.allow_fallback ? " (fallback allowed)" : " (no fallback)"}`
        : `routing policy '${routePolicy.task_class}' v${routePolicy.version_no} names no available candidate`;
  } else if (routePolicy && isProtected) {
    /*
     * UNREACHABLE BY CONSTRUCTION, AND KEPT AS THE PROOF OF THAT.
     *
     * The branch above already admits every protected call, because `!(freeFirst && !isProtected)`
     * is true whenever `isProtected` is. This exists so that if anybody ever loosens that condition,
     * protected work still lands on its pin rather than falling through to the cheapest-available
     * branch below — the guarantee has a second floor under it rather than resting on one boolean.
     */
    ordered = orderByPolicy(routePolicy, routingCandidates);
    explanation =
      `the firm is economising, but routing policy '${routePolicy.task_class}' v${routePolicy.version_no} stands: ` +
      `this call is marked '${taskKind}' and is not downgradeable by a spend position.${judgementNote}`;
  } else if (routePolicy) {
    /*
     * THE ONE POSTURE THAT OVERRIDES A PIN, and it says so on the record.
     *
     * "Free only" exists because the operator asked for a lever that gets the firm to $0, and a
     * lever that stops at the two things which actually run is not a lever. Both the morning brief
     * and employee work are pinned, so honouring pins meant CHEAPO changed nothing at all.
     *
     * Overriding is stated rather than silent for a specific reason: the brief is pinned BECAUSE
     * the cheap tier once produced "the 30-year U.S. tax at 19 year high" and shipped it as fact.
     * Anyone reading a thin brief later can find this explanation on the run and know why.
     */
    const cheapest = costRanked(routingCandidates).reduce((a, b) => (a.estimatedCostUsd <= b.estimatedCostUsd ? a : b));
    ordered = [cheapest];
    explanation =
      `${behaviour.why} That overrides routing policy '${routePolicy.task_class}' ` +
      `v${routePolicy.version_no} (pinned ${orderByPolicy(routePolicy, routingCandidates)[0]?.model ?? "nothing available"}) ` +
      `for this call, which is marked '${taskKind}' and is therefore not protected. ` +
      `Cheapest available used instead: ${cheapest.providerKey}/${cheapest.model}. Quality on this pinned work is lower by design.${freeOnlyNote}`;
  } else {
    const preferred = input.budgetContext?.preferredModel;
    /*
     * THE EXPENSIVE END OF THE LEVER, and this branch is the whole of it.
     *
     * "Best available" and "Balanced" wrote identical policy rows and therefore behaved identically:
     * unpinned work took the cheapest adequate model under both. A partner who chose to spend more
     * got exactly what the cheap setting gave them, and the page told them they were on Balanced.
     *
     * PRICE IS THE ONLY QUALITY SIGNAL THIS SYSTEM HAS, and that is worth saying rather than
     * dressing up. `provider_model` records a context window and two capability booleans; nothing
     * records "is this model better". So "best available" means "most expensive priced candidate
     * that can do the job", which is a proxy — a good one at current catalogue prices, where the
     * frontier models genuinely are the dear ones, and a proxy that would need revisiting the day
     * a cheap strong model lands. It is not a benchmark and the explanation on the run says so.
     *
     * Only reached when nothing is pinned. A pin is somebody's per-task quality decision and this
     * posture must never be able to make pinned work worse.
     */
    /*
     * WHICH WAY UNPINNED WORK LEANS.
     *
     * Two independent reasons to take the dearest capable model, and they compose rather than
     * override each other:
     *   · she set the lever to OPEN, and the gradient is not tightening (it never tightens at OPEN,
     *     so `cheaperChoices` is false there by construction — the second clause is the belt);
     *   · the call is protected, which reads as "best available" whatever the money says.
     *
     * `isProtected` is on the right of the OR, alone, deliberately: it is sufficient by itself and
     * depends on nothing about spend. That is the guarantee, written as an expression.
     */
    const prefersFrontier = (behaviour.prefersFrontier && !behaviour.cheaperChoices) || isProtected;

    /*
     * ── WHAT THESE MODELS HAVE ACTUALLY DONE, AS OPPOSED TO WHAT THEIR SPECS SAY ────────────────
     *
     * Reached only here, in the unpinned branch, and that scope is deliberate twice over. A machine
     * pin or a routing policy NAMES a model: that is a person's decision and a thin outcome table
     * does not get to overrule it. And this branch is exactly where the failure happened — migration
     * 0158 priced `perplexity/sonar` at $1/$1, which made it the cheapest priced model on the
     * account, and by that single configuration row it became the answer for every unpinned call in
     * the firm. It then refused its own answer three times.
     *
     * Evidence can only REORDER candidates that have already passed every capability and privacy
     * filter. It can never widen the set, and it can never promote a model past one the catalogue
     * says cannot do the job. That constraint is what makes a few hundred runs of history safe to
     * consult at all: the worst a wrong call here can do is pick a differently-adequate model.
     *
     * AND IT USUALLY DOES NOTHING, WHICH IS THE HONEST STATE. A cell needs 20 decided outcomes
     * before it says anything; below that it reports INSUFFICIENT_EVIDENCE, the ordering is
     * returned untouched, and the run says so in as many words rather than implying a judgement
     * nobody has earned. An unproven model is unknown, not good.
     */
    const evidence = await evidenceForTaskKind(env, taskKind);
    const learned = orderByEvidence(costRanked(routingCandidates), evidence, taskKind);
    const learnedNote = learned.note;

    /*
     * A MEASURED FAILURE IS DISQUALIFYING EVEN AT THE EXPENSIVE END. `orderByEvidence` puts POOR
     * cells last, so dropping them here stops "dearest capable" from handing protected work to a
     * model that has demonstrably not done this job — which is the sonar case exactly, since sonar
     * is not cheap once its $0.005 per-request fee is counted.
     */
    const notPoor = learned.applied
      ? learned.ordered.filter((c) => evidence.get(`${c.providerId} ${c.model}`)?.verdict !== "POOR")
      : learned.ordered;
    /*
     * ── A PRICE ON PAPER IS NOT A COST ────────────────────────────────────────────────────────
     *
     * The third instance of one shape, and the reason this line exists rather than a patch for the
     * third case. `perplexity/sonar` won a judging job on price; migration 0158 mispriced a model
     * into "cheapest adequate"; and on 17 Sep 2026 `prov_anthropic / claude-sonnet-5` — a lane with
     * ZERO completed runs, ever — undercut `prov_openrouter / anthropic/claude-sonnet-5`, which had
     * hundreds, because the direct lane carries no OpenRouter margin. It then answered "Your credit
     * balance is too low" and the partner's card deferred.
     *
     * Every one of those is the same mistake: a NUMBER beat a FACT. So the cost comparison is now
     * made on effective cost — a lane in outage back-off cannot serve, so it is infinite; a lane
     * that has never completed anything is unknown, not cheap — and cheaper-on-paper can no longer
     * beat working-in-practice.
     *
     * IT ONLY EVER DEMOTES. Lane health cannot widen the candidate set, cannot promote past the
     * capability or privacy filters, and cannot overrule `orderByEvidence` — it runs AFTER it and
     * preserves its order within each tier. And with no history at all every lane ties, which is
     * exactly today's behaviour: this is how a newly registered model still gets its first run.
     */
    const health = await laneHealth(env);
    const laneRanked = orderByLaneHealth(notPoor.length > 0 ? notPoor : learned.ordered, health, now);
    const rankable = laneRanked.ordered;
    // Both facts about which LANE, rather than which model, so they travel together on the run.
    const laneNote = laneRanked.note + directLaneNote;

    // The cheapest PROVEN model where evidence exists, and the cheapest outright where it does not:
    // `learned.ordered` is already proven-first and price-sorted within each tier.
    /*
     * `rankable` arrives already tiered — proven-first by evidence, then working-before-untried by
     * lane health, price-ordered inside each tier. Taking its head IS "cheapest effective cost", and
     * re-reducing over `estimatedCostUsd` here would throw both tierings away and re-elect the
     * untried lane on its paper price. That reduction is kept for exactly one case: nothing tiered
     * anything, so the head is whatever order the rows arrived in and price must still decide.
     */
    const tiered = learned.applied || laneRanked.applied;
    const cheapest = tiered ? rankable[0]! : rankable.reduce((a, b) => (a.estimatedCostUsd <= b.estimatedCostUsd ? a : b));
    /*
     * The dearest is still the dearest — "best available" is a quality posture and a lane's history
     * does not make it a better model. What lane health DOES remove from this reduction is a lane in
     * back-off, because the dearest lane that cannot answer is not the best available, it is nothing.
     */
    const dearest = rankable.reduce((a, b) => (a.estimatedCostUsd >= b.estimatedCostUsd ? a : b));
    let head: RoutingCandidate;
    // `requiresSearch` joins `isJudgement` here: CHEAPO is a lever for volume, and neither the model
    // that reads a partner's instruction nor the one that has to reach the web is downgradeable by
    // a cost posture.
    /*
     * A CALLER'S `preferredModel` IS HONOURED UNLESS THE FIRM IS ECONOMISING AND THIS CALL IS NOT
     * PROTECTED — and getting this condition wrong is the whole of this morning's near-miss.
     *
     * CHEAPO ignored `preferredModel` outright. Eight call sites pinned the live-search model that
     * way and marked nothing, so flipping the firm to CHEAPO would have sent every live search to a
     * model with no web access, which does not error: it answers fluently, from memory, about this
     * morning's market. Those eight now carry `requiresSearch`, which makes them protected, which
     * makes this condition true for them at every position on the gradient.
     */
    if ((!behaviour.cheaperChoices || isProtected) && preferred) {
      head = routingCandidates.find((c) => c.model === preferred) ?? (prefersFrontier ? dearest : cheapest);
      explanation =
        head.model === preferred
          ? `no routing policy for this task; caller preferred ${preferred}`
          : `no routing policy for this task; preferred model ${preferred} unavailable, fell to ${prefersFrontier ? "the dearest available (spend posture 'best available')" : "cheapest adequate"}`;
      explanation += judgementNote + provenanceNote + learnedNote + laneNote;
    } else if (prefersFrontier) {
      head = dearest;
      explanation =
        (isJudgement
          ? `this call interprets or drafts, so it takes the dearest priced capable model rather than the cheapest: `
          : `spend posture is 'best available', so unpinned work takes the dearest priced capable model rather than the cheapest: `) +
        `${head.providerKey}/${head.model}. Price is the only quality signal ` +
        `in the model registry, so this is a proxy for capability and not a benchmark result.${judgementNote}${provenanceNote}${learnedNote}${laneNote}`;
    } else {
      head = cheapest;
      explanation =
        (behaviour.cheaperChoices
          ? `${behaviour.why} So this unpinned, unprotected call took the cheapest adequate priced model`
          : "no routing policy for this task; cheapest adequate priced model") +
        judgementNote +
        provenanceNote +
        freeOnlyNote +
        learnedNote +
        laneNote;
    }
    // No policy → no fallback. Behaviour is exactly P4's.
    ordered = [head];
  }

  /*
   * A PIN MADE BEFORE THIS RULE EXISTED DOES NOT GET TO HAND AN INSTRUCTION TO A WEAK MODEL.
   *
   * Every branch above orders `routingCandidates`, which for an interpretation already holds only
   * the models the catalogue says can reason. So a machine pin or a routing policy naming nothing
   * in that set lands here with an empty list — and refusing the run would be the wrong answer: a
   * stale pin is not a reason to stop reading what a partner asked for. It falls to the dearest
   * reasoning-capable model instead, and the run records that the pin was not honoured and why, so
   * "which model read my words" stays answerable and the stale pin is visible rather than silent.
   */
  if (ordered.length === 0 && isInterpretation && routingCandidates.length > 0) {
    const fallback = costRanked(routingCandidates).reduce((a, b) => (a.estimatedCostUsd >= b.estimatedCostUsd ? a : b));
    ordered = [fallback];
    explanation =
      `${explanation}. That pin names no model the catalogue records as able to reason, and this call reads what a ` +
      `partner asked for, so it was not honoured: ${fallback.providerKey}/${fallback.model} was used instead.`;
  }

  if (ordered.length === 0) {
    return { run: await blocked("PREFLIGHT_BLOCKED", `routing_no_candidate:${explanation}`) };
  }

  const head = ordered[0]!;
  const selected = options.find((o) => o.provider.id === head.providerId && o.pricing.model === head.model)!;

  const estimate: CostEstimate = {
    ...baseEstimate,
    estimated_cost_usd: estimateFor(selected),
    provider_key: selected.provider.provider_key,
    model: selected.pricing.model,
    input_per_mtok_usd: selected.pricing.input_per_mtok_usd,
    output_per_mtok_usd: selected.pricing.output_per_mtok_usd,
  };

  /*
   * 6b. A VISION RUN MUST REACH A MODEL THAT CAN SEE.
   *
   * The capability filter above works at PROVIDER level, and every model in the registry declares
   * only "text-completion" — there is no concept of vision anywhere in the routing data. So today a
   * run carrying screenshots resolves to whatever the task class pins, and the fact that it happens
   * to be a model with eyes is luck rather than design.
   *
   * The failure that makes this worth blocking rather than warning: a text-only model handed a
   * multimodal message does not error. It ignores the images and answers from the prompt — which
   * for a design review means a fluent, confident, entirely invented critique of a page nobody
   * looked at. That is precisely the failure `look_at` exists to prevent, and it would arrive
   * looking exactly like success.
   *
   * A NAMED LIST, not a heuristic. Guessing from a model string is how a text-only model with
   * "vision" in its name gets through. Anything not on this list is refused, loudly, naming the
   * model — adding a model here is a deliberate act, and the cost of forgetting is a blocked run
   * rather than a fabricated review.
   */
  if (input.documents?.length && !DOCUMENT_CAPABLE_MODELS.has(selected.pricing.model)) {
    // Same reasoning as the vision gate below: a named list, because guessing from a model string
    // is how a model that cannot read a PDF is handed one and answers about nothing.
    return {
      run: await blocked(
        "PREFLIGHT_BLOCKED",
        `model_cannot_read_documents:${selected.pricing.model}`,
        estimate,
        selected.provider.id,
        selected.pricing.model,
      ),
    };
  }

  if (input.images?.length) {
    if (!VISION_CAPABLE_MODELS.has(selected.pricing.model)) {
      return {
        run: await blocked(
          "PREFLIGHT_BLOCKED",
          `model_cannot_see_images:${selected.pricing.model}`,
          estimate,
          selected.provider.id,
          selected.pricing.model,
        ),
      };
    }
  }

  /*
   * 7. Cost preflight: per-run and daily caps, as the owner set them — $0.75 and $2.50.
   *
   * NOTHING LIFTS THESE ANY MORE, and that is a deliberate narrowing. A surge used to raise both to
   * its own budget, which meant one JSON blob could quietly turn a $0.75 per-run cap into a $200
   * one for every call in the firm. These are operational throttles on a SINGLE run and a SINGLE
   * day; the thing a person actually wants to lift when a quarter needs closing is the monthly
   * ceiling, and that is what a `spend_bypass` lifts — one number, named, with an expiry.
   */
  const perRunCap = policy.per_run_cap_usd;
  const dailyCap = policy.daily_cap_usd;
  if (estimate.estimated_cost_usd > perRunCap) {
    return {
      run: await blocked(
        "BUDGET_BLOCKED",
        `per_run_cap_exceeded:${estimate.estimated_cost_usd.toFixed(6)}>${perRunCap}`,
        estimate,
        selected.provider.id,
        selected.pricing.model,
      ),
    };
  }
  const spentToday = await dailySpendUsd(env, firmScope);
  if (spentToday + estimate.estimated_cost_usd > dailyCap) {
    return {
      run: await blocked(
        "BUDGET_BLOCKED",
        `daily_cap_exceeded:${(spentToday + estimate.estimated_cost_usd).toFixed(6)}>${dailyCap}`,
        estimate,
        selected.provider.id,
        selected.pricing.model,
      ),
    };
  }

  /*
   * 7a. The firmwide ceilings the operator set: this month, and ever.
   *
   * "Persist is the operative word... a budget that displays but does not bind is worse than none"
   * — item 23. So the ceiling is read here, before the money moves, from the same function that
   * draws it on the page. No ceiling set means no ceiling applied; nothing is invented.
   *
   * THIS is where a bypass applies, and the only place one does. `checkFirmBudgets` consults
   * `spend_bypass` on the failing path: an unexpired, unrevoked row naming a higher ceiling and the
   * person who granted it lets the run through, and the refusal names the bypass when even that is
   * exceeded. The $75 stop is automatic; stepping over it is a decision with a name on it.
   */
  const firmCeiling = await checkFirmBudgets(env, firmScope, estimate.estimated_cost_usd, now);
  if (!firmCeiling.ok) {
    return {
      run: await blocked("BUDGET_BLOCKED", firmCeiling.reason!, estimate, selected.provider.id, selected.pricing.model),
    };
  }

  // 7b. Scoped budgets (P16): employee / machine / provider / model / category ceilings on top
  //     of the firmwide caps. A run must satisfy EVERY scope it falls inside; the first
  //     violation blocks and is named exactly.
  const scoped = await checkScopedBudgets(
    env,
    {
      employeeId: input.aiEmployeeId ?? null,
      machineId: attribution.machineId,
      providerKey: selected.provider.provider_key,
      model: selected.pricing.model,
      category: attribution.category,
    },
    estimate.estimated_cost_usd,
    firmScope,
    now,
  );
  if (!scoped.ok && scoped.violation) {
    const v = scoped.violation;
    await raiseCostAlert(env, v.scope, v.would_be, "BREACH", now);
    return {
      run: await blocked(
        "BUDGET_BLOCKED",
        `scoped_cap_exceeded:${v.scope.scope_type}:${v.scope.scope_id}:${v.scope.period}:${v.would_be.toFixed(6)}>${v.scope.cap_usd}`,
        estimate,
        selected.provider.id,
        selected.pricing.model,
      ),
    };
  }
  for (const warn of scoped.warnings) {
    await raiseCostAlert(env, warn.scope, warn.would_be, "WARNING", now);
  }

  // 8. External call through the provider's adapter (OpenRouter, Fireworks, or the generic
  //    HTTPS shape). No live credentials exist in any current environment, so a real call
  //    fails closed with `credential_missing:<provider>` — UNPROVEN, CREDENTIAL GATE.
  //    Output is quarantined until a human accepts it.
  /*
   * ── 8a. FREE FRONTIER CAPACITY FIRST, WHERE IT IS SAFE AND ADEQUATE ────────────────────────
   *
   * "i want to be cheapo for everything except the important stuff and with the important stuff u
   * should find a way to use my freemium aspect of the models."
   *
   * The important stuff splits two ways and they pull opposite. Important-because-public-facing —
   * a workshop angle, a room packet, blog help, market research — wants the best model available
   * and is delighted if that model is free. Important-because-confidential — LP names, deal terms —
   * must not go near a free tier at any quality, because free is usually free in exchange for
   * training rights.
   *
   * So the free lanes are tried FIRST for quality-critical work, and the confidentiality filter at
   * step 4b has already removed them from `candidates` when the call is marked confidential. They
   * also carry a PUBLIC-only data policy, so an INTERNAL-labelled run never got here either. Two
   * independent gates, both upstream of this line.
   *
   * WHY THIS IS SAFE ON COST AS WELL. The budget checks above all ran against the PAID head, not
   * against the free lane — "could the firm afford this if the free tier fails?" is the question
   * worth asking, and it is asked before a free run that might have to be repaid is started.
   *
   * WHY QUOTA EXHAUSTION IS VISIBLE RATHER THAN SILENT. A free tier that has run out answers HTTP
   * 429. That is an outage, the paid head is the outage fallback, and every such handover lands in
   * `ai_run_routing` with `fallback_used = 1` and a RATE_LIMITED label, which the Cockpit reads
   * back as `recent_fallbacks`. "We started paying at 11am on the 9th" is a query, not a guess.
   *
   * MECHANICAL WORK DOES NOT COME HERE, and that is deliberate: it is already going to Workers AI
   * at $0.017 per Mtok, which is free capacity that is ALSO safe for INTERNAL content. Sending it
   * through a training-permitting lane to save a fraction of a cent would trade confidentiality
   * for nothing.
   */
  const freeFirstEligible =
    isJudgement &&
    /*
     * THE NORMAL CASE, and the owner's instruction is that it should be: "MOST WORK IS INTERNAL AND
     * NOT-CONFIDENTIAL SO CAN USE FREE TRAINING MODELS WITH REASONING AND CLOSE TO $0." A card that
     * carries no LP or deal material leads on a free reasoning lane; the paid head stands behind it
     * as an outage fallback, so quality is not at risk and the bill is.
     */
    contentClass.publicModelApproved &&
    // A free lane cannot reach the web, so a search call is not a candidate for one.
    !requiresSearch &&
    input.budgetContext?.confidential !== true &&
    // Nor can one be trusted with a picture or a deck: the vision and document gates above verified
    // the model the RUN was planned on, and a free substitute has not passed them.
    !input.images?.length &&
    !input.documents?.length;

  const freeLanes: FallbackOption[] = [];
  if (freeFirstEligible) {
    const freeOptions = options
      .filter((o) => Number(o.provider.training_permitted ?? 0) === 1)
      .filter((o) => credentialConfigured(env, o.provider.provider_key))
      // A free lane must clear the SAME bar the paid head cleared. `judged`/`routingCandidates`
      // already encode "not search-grounded" and, for an interpretation, "records supports_reasoning".
      // Reusing that set is what makes "never silently downgrade" structural rather than a promise.
      /*
       * THE SAME BAR THE PAID HEAD CLEARED, stated explicitly because the free lanes are no longer
       * in `routingCandidates` — they are excluded from ordinary ranking so a zero cannot win a
       * selection. Inheriting the bar is what makes "never silently downgrade" structural: a free
       * model that cannot reason does not get to read a partner's instruction just because it costs
       * nothing, and a search-grounded one does not get to judge.
       */
      .filter((o) => !isSearchGrounded(o.pricing.model))
      .filter((o) => !isInterpretation || o.pricing.supports_reasoning === 1);
    /*
     * A DETERMINISTIC ORDER, because both lanes cost $0 and price therefore cannot choose between
     * them — and "whatever the database returned first" is not an order, it is a coin toss that
     * looks stable until it isn't.
     *
     * OpenRouter's :free tier first: it is already connected, needs no second credential, and the
     * model behind it is 550B with a million-token window. Gemini's unpaid quota second. Anything
     * else after, in catalogue order.
     */
    const FREE_LANE_ORDER = ["openrouter_free", "google_free"];
    freeOptions.sort((a, b) => {
      const ai = FREE_LANE_ORDER.indexOf(a.provider.provider_key);
      const bi = FREE_LANE_ORDER.indexOf(b.provider.provider_key);
      return (ai < 0 ? FREE_LANE_ORDER.length : ai) - (bi < 0 ? FREE_LANE_ORDER.length : bi);
    });
    for (const o of freeOptions) {
      const candidate: RoutingCandidate = {
        providerId: o.provider.id,
        providerKey: o.provider.provider_key,
        model: o.pricing.model,
        estimatedCostUsd: 0,
        baseUrl: o.provider.base_url,
      };
      freeLanes.push({
        candidate,
        adapter: adapterFor(env, candidate, deps.fetchImpl).adapter,
        engageOn: "OUTAGE",
        estimate: {
          ...estimate,
          estimated_cost_usd: 0,
          provider_key: candidate.providerKey,
          model: candidate.model,
          input_per_mtok_usd: o.pricing.input_per_mtok_usd,
          output_per_mtok_usd: o.pricing.output_per_mtok_usd,
        },
      });
    }
  }

  const { adapter } = adapterFor(env, head, deps.fetchImpl);
  const allowFallback = routePolicy?.allow_fallback === 1;
  /*
   * ── A FALLBACK THAT IS ACTUALLY THERE ─────────────────────────────────────────────────────
   *
   * Two kinds, and they engage on different things.
   *
   * POLICY FALLBACK (existing): the remaining candidates a routing policy named, used only when
   * that policy sets allow_fallback. Opt-in per task class, engages on ANY failure, unchanged.
   *
   * OUTAGE FALLBACK (new): the same model at its own vendor, when the vendor is one this system
   * holds a key for. Always present, engages ONLY on a provider outage — a dead key, a 403, a 429,
   * a 5xx, a timeout, a model this host no longer serves. It exists because every ACTIVE model in
   * this firm sits behind OpenRouter, so one company having a bad hour stopped the entire firm
   * thinking. The owner already had the keys; nothing was wired to them.
   *
   * IT CANNOT DOWNGRADE QUALITY, by construction rather than by a rule somebody has to maintain.
   * The peer is the IDENTICAL MODEL — `anthropic/claude-sonnet-5` at OpenRouter is
   * `claude-sonnet-5` at Anthropic — so the capability bar, the reasoning filter and the price
   * class are all satisfied automatically. There is no registered "equivalent" to age into
   * something cheaper and weaker. If no direct lane exists for the model, or its vendor has no key,
   * there is NO fallback and the run fails loudly: a worse answer nobody asked for is not a
   * recovery.
   *
   * AND IT CANNOT LEAK DATA SIDEWAYS: the peer's own provider_data_policy must allow this run's
   * sensitivity label, checked here, default-deny, exactly as the primary was.
   */
  const outageFallbacks: FallbackOption[] = [];
  for (const source of ordered) {
    const direct = directVendorRouteFor(source.model);
    if (!direct) continue;
    if (!credentialConfigured(env, direct.providerKey)) continue;
    const peerProvider = await env.WP_OS_DB.prepare(
      "SELECT id, provider_key, enabled, kill_switched, base_url FROM provider_registry WHERE provider_key = ?1",
    )
      .bind(direct.providerKey)
      .first<{ id: string; provider_key: string; enabled: number; kill_switched: number; base_url: string | null }>();
    if (!peerProvider || peerProvider.enabled !== 1 || peerProvider.kill_switched === 1) continue;
    if (!(await dataPolicyAllows(env, peerProvider.id, input.sensitivity))) continue;
    const candidate: RoutingCandidate = {
      providerId: peerProvider.id,
      providerKey: peerProvider.provider_key,
      model: direct.model,
      // The same model, so the same price. No second pricing row to be wrong, and the run's
      // approved cost estimate stays the one the budget gates already passed.
      estimatedCostUsd: source.estimatedCostUsd,
      baseUrl: peerProvider.base_url,
    };
    outageFallbacks.push({
      candidate,
      adapter: adapterFor(env, candidate, deps.fetchImpl).adapter,
      engageOn: "OUTAGE",
      // The same model, so the same rates. Only the provider key differs.
      estimate: { ...estimate, provider_key: candidate.providerKey, model: candidate.model },
    });
  }

  const policyFallbacks: FallbackOption[] = allowFallback
    ? ordered.slice(1).map((c) => ({
        candidate: c,
        adapter: adapterFor(env, c, deps.fetchImpl).adapter,
        engageOn: "ANY" as const,
      }))
    : [];

  /*
   * ── AND THEN ANY OTHER LANE THAT IS ACTUALLY WORKING ──────────────────────────────────────────
   *
   * "fall back to one that is working" — the owner, 17 Sep 2026, and the emphasis is hers. Not
   * merely to the next name on a list.
   *
   * THE GAP THIS CLOSES, CONFIRMED FROM PRODUCTION. Every routing policy in this firm names exactly
   * one candidate, so `policyFallbacks` is empty; the only fallback that existed was the direct
   * vendor peer of the head. When that peer was the unfunded Anthropic account, the chain had
   * nowhere left to go and the run landed BLOCKED_DEFERRED — with other lanes sitting idle, funded,
   * and perfectly able to answer. Retrying the whole card fourteen minutes later found the same
   * dead end twice more.
   *
   * So the chain does not end at the named candidates. Every OTHER adequate lane — already through
   * the capability, reasoning, search and privacy filters, so none of them is a downgrade the
   * caller did not accept — stands behind them, working lanes first, and the run only stops when
   * nothing at all is left.
   *
   * ENGAGES ON OUTAGE ONLY. A request the vendors are right to refuse must not be sprayed across
   * the whole catalogue looking for one that will answer it anyway; that is how a model that
   * silently drops an attachment ends up writing confidently about a file it never saw.
   *
   * CHEAPEST-EFFECTIVE FIRST, not cheapest-on-paper: the same `orderByLaneHealth` the selection
   * used, so the lane that has actually completed work leads even when a never-tried lane prices
   * lower. This is the recovery path — the one place where "it answers at all" outranks everything.
   */
  const alreadyInChain = new Set<string>(
    [head, ...ordered, ...policyFallbacks.map((f) => f.candidate), ...outageFallbacks.map((f) => f.candidate)].map(
      (c) => `${c.providerId} ${c.model}`,
    ),
  );
  const lastResortRanked = orderByLaneHealth(
    routingCandidates.filter((c) => !alreadyInChain.has(`${c.providerId} ${c.model}`)),
    await laneHealth(env),
    now,
  );
  const lastResortFallbacks: FallbackOption[] = lastResortRanked.ordered.map((c) => {
    const option = options.find((o) => o.provider.id === c.providerId && o.pricing.model === c.model);
    return {
      candidate: c,
      adapter: adapterFor(env, c, deps.fetchImpl).adapter,
      engageOn: "OUTAGE" as const,
      // Priced at ITS OWN rates, never the head's. A recovery that bills the partner for the model
      // that failed is a second defect wearing the first one's clothes.
      estimate: option
        ? {
            ...estimate,
            estimated_cost_usd: estimateFor(option),
            provider_key: c.providerKey,
            model: c.model,
            input_per_mtok_usd: option.pricing.input_per_mtok_usd,
            output_per_mtok_usd: option.pricing.output_per_mtok_usd,
          }
        : { ...estimate, provider_key: c.providerKey, model: c.model },
    };
  });

  /*
   * THE PAID HEAD IS THE LAST RESORT WHEN A FREE LANE LEADS, and it is an OUTAGE fallback: a free
   * model that refuses the request on its merits does not get quietly repaid for at frontier
   * prices, while a free tier that has run out (429) does.
   */
  const paidHeadAsFallback: FallbackOption[] =
    freeLanes.length > 0 ? [{ candidate: head, adapter, engageOn: "OUTAGE", estimate }] : [];

  /*
   * THE ORDER OF LAST RESORT, and each step is a smaller concession than the one after it:
   * another free lane → the paid head → the policy's own next choice → THE SAME MODEL at its own
   * vendor → any other adequate lane that is working. Quality is surrendered as late as possible,
   * and the direct vendor lanes sit behind OpenRouter here exactly as they do in selection.
   */
  const fallbacks: FallbackOption[] = [
    ...freeLanes.slice(1),
    ...paidHeadAsFallback,
    ...policyFallbacks,
    ...outageFallbacks,
    ...lastResortFallbacks,
  ];

  /** What actually runs first: a free lane where one is eligible, the chosen model otherwise. */
  const lead = freeLanes[0];
  if (outageFallbacks.length > 0) {
    explanation +=
      ` Direct-vendor fallback is available for this call (${outageFallbacks
        .map((f) => `${f.candidate.providerKey}/${f.candidate.model}`)
        .join(", ")}) and engages only if the provider itself fails.`;
  }
  if (lastResortFallbacks.length > 0) {
    explanation +=
      ` Behind those, ${lastResortFallbacks.length} further adequate lane${lastResortFallbacks.length === 1 ? "" : "s"} ` +
      `(${lastResortFallbacks.map((f) => `${f.candidate.providerKey}/${f.candidate.model}`).join(", ")}) ` +
      `stand ready on a provider outage, so this run falls back to one that is working rather than stopping.${lastResortRanked.note}`;
  }
  const attempts: Array<{ provider_key: string; model: string; outcome: string; detail?: string }> = [];

  if (lead) {
    explanation +=
      ` Free frontier capacity is tried first for this call (${lead.candidate.providerKey}/${lead.candidate.model}); ` +
      `it carries no LP names or deal terms and is labelled ${input.sensitivity}, so a lane whose terms permit training is allowed to serve it. ` +
      `If the free quota is exhausted the run falls through to ${head.providerKey}/${head.model} and the handover is recorded.`;
  }

  const run = await executeRun(
    env,
    {
      ...baseRec,
      providerId: lead ? lead.candidate.providerId : selected.provider.id,
      providerKey: lead ? lead.candidate.providerKey : selected.provider.provider_key,
      model: lead ? lead.candidate.model : selected.pricing.model,
      status: "RUNNING",
      estimate: lead?.estimate ?? estimate,
    },
    lead ? lead.adapter : adapter,
    true,
    fallbacks,
    attempts,
  );

  await recordAttribution(env, run.id, attribution);
  await recordRouting(env, {
    runId: run.id,
    taskClass: input.routing?.taskClass,
    policyId: routePolicy?.id ?? null,
    selectedProviderKey: attempts.find((a) => a.outcome === "COMPLETED")?.provider_key ?? selected.provider.provider_key,
    selectedModel: run.model,
    attempts,
    // FAILED_OVER is an attempt that handed the work on. Counting only "FAILED" missed every
    // successful failover, which is precisely the event the Cockpit needs to be able to show.
    fallbackUsed: attempts.some((a) => a.outcome === "FAILED_OVER"),
    explanation,
  });

  /*
   * THE THIRD OUTCOME: REWORKED.
   *
   * A model that handed the work on did not do the job — something else finished it. That is a
   * weaker signal than a human rejection and it is counted as a weaker one: REWORKED sits in the
   * denominator of the acceptance rate without being a rejection, so a model is neither punished as
   * though a person refused its output nor credited as though it had succeeded.
   *
   * Recorded against the model that FAILED OVER, not against the one that finished. The one that
   * finished gets its own outcome when a human decides about the output, which is the accept path.
   */
  for (const a of attempts.filter((x) => x.outcome === "FAILED_OVER")) {
    const failedOver = options.find((o) => o.provider.provider_key === a.provider_key && o.pricing.model === a.model);
    await recordModelJobOutcome(env, {
      taskKind,
      providerId: failedOver?.provider.id ?? null,
      model: a.model,
      outcome: "REWORKED",
      aiRunId: run.id,
      firmScope,
    });
  }
  return { run };
}
