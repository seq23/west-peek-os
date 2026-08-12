import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, canAccessPrivacyLabel, privacyVisibilityClause, type Actor } from "./authorize";
import { consumeApprovalCard, requestApproval } from "./approvals";
import {
  ALLOCATION_MODEL_VERSION,
  OPTION_TYPES,
  evaluateOption,
  type OptionType,
  type PinnedPolicy,
} from "../../shared/allocation";
import { computeFollowOn, type FollowOnInput } from "../../shared/dealmath";
import { privacyLabelSchema, type PrivacyLabel } from "../../shared/privacy";

/**
 * Fund construction, cross-sleeve allocation, reserves, and follow-on (P11).
 *
 * Law (plan §8/P11 + §15):
 * - A scenario PINS mandate/sleeve/reserve/concentration policy version ids and the
 *   calculation model version. Policy rows are immutable (0002 triggers), so the
 *   inputs behind a recorded decision can never be rewritten.
 * - A comparison run stores deterministic arithmetic over those pinned inputs and
 *   its violations. It ranks nothing, recommends nothing, and is immutable.
 * - Every option decision is human-reserved and needs the receipt for ITS OWN action:
 *   RESERVE → reserve_allocation.approve, FOLLOW_ON → follow_on.approve, and
 *   INITIAL, both SECONDARY types, and EXIT → capital_allocation_cross_sleeve.approve. An AI may
 *   propose an option (with its run trace) and can never decide one.
 * - NOTHING HERE MOVES CAPITAL. Approving an option records a human decision; the
 *   money movement is a banking act outside this system (capital.move_or_commit and
 *   wire.initiate_or_authorize remain separately reserved).
 * - Modelled outcomes are SCENARIOS, never expected returns, and no output here
 *   claims valuation or investment soundness (§12.4).
 *
 * Formula authority: every number comes from src/shared/allocation (hand-verified in
 * docs/ALLOCATION_VERIFICATION.md) or src/shared/dealmath (hand-verified in
 * docs/DEAL_MATH_VERIFICATION.md). Live allocation use remains gated on the operator
 * accepting that verification (§7.2).
 */

export class AllocationError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

/** The reserved action a decision on each option type must carry a receipt for. */
export const OPTION_DECISION_ACTIONS: Readonly<Record<OptionType, string>> = {
  INITIAL: "capital_allocation_cross_sleeve.approve",
  FOLLOW_ON: "follow_on.approve",
  RESERVE: "reserve_allocation.approve",
  SECONDARY_PURCHASE: "capital_allocation_cross_sleeve.approve",
  SECONDARY_SALE: "capital_allocation_cross_sleeve.approve",
  EXIT: "capital_allocation_cross_sleeve.approve",
};

export interface ScenarioRow {
  id: string;
  fund_id: string;
  name: string;
  status: string;
  mandate_version_id: string;
  sleeve_version_id: string;
  reserve_version_id: string;
  concentration_version_id: string;
  model_version: string;
  fund_size: number;
  investable: number;
  fund_deployed: number;
  reserve_committed: number;
  reserve_modeled_need: number;
  privacy_label: string;
  firm_scope: string;
}

export interface OptionRow {
  id: string;
  scenario_id: string;
  option_type: OptionType;
  label: string;
  company_id: string | null;
  position_id: string | null;
  sleeve_key: string;
  sleeve_target_pct: number;
  sleeve_deployed: number;
  capital: number;
  reserve_draw: number;
  existing_company_cost: number;
  mandate_exclusions_json: string;
  decision: string;
  decided_by: string | null;
  approval_card_id: string | null;
  proposed_by_type: "HUMAN" | "AI";
  firm_scope: string;
}

function eventActor(actor: Actor): { actorType: "firm_user" | "ai_employee" | "system"; actorId: string } {
  return {
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
  };
}

async function mustAuthorize(env: Env, actor: Actor, actionKey: string, objectType: string, objectId?: string, firmScope?: string): Promise<void> {
  const authz = await authorize(env, actor, actionKey, { objectType, objectId, firmScope: firmScope ?? actor.firmScopes[0] ?? "west-peek" });
  if (authz.decision === "DENY") throw new AllocationError(403, "forbidden", authz.reason);
  if (authz.decision === "REQUIRE_APPROVAL") throw new AllocationError(409, "approval_required", authz.reason);
}

export async function getScenario(env: Env, id: string): Promise<ScenarioRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM fund_construction_scenario WHERE id = ?1").bind(id).first<ScenarioRow>();
}

export async function getOption(env: Env, id: string): Promise<OptionRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM capital_allocation_option WHERE id = ?1").bind(id).first<OptionRow>();
}

// ── Scenarios ──

export interface CreateScenarioInput {
  fund_id: string;
  name: string;
  mandate_version_id: string;
  sleeve_version_id: string;
  reserve_version_id: string;
  concentration_version_id: string;
  fund_size: number;
  investable: number;
  fund_deployed?: number;
  reserve_committed?: number;
  reserve_modeled_need?: number;
  notes?: string;
  /** Defaults to CONFIDENTIAL (investment-team work). Raise it when a scenario
   *  carries MNPI or LP-private material; the DECISION is MP-reserved either way. */
  privacy_label?: PrivacyLabel;
}

/** Every pinned version must exist AND belong to the named fund — no cross-fund pins. */
async function assertPolicyVersion(env: Env, table: string, id: string, fundId: string): Promise<void> {
  const row = await env.WP_OS_DB.prepare(`SELECT fund_id FROM ${table} WHERE id = ?1`).bind(id).first<{ fund_id: string }>();
  if (!row) throw new AllocationError(400, "unknown_policy_version", `${table} '${id}' does not exist`);
  if (row.fund_id !== fundId) {
    throw new AllocationError(400, "policy_version_fund_mismatch", `${table} '${id}' belongs to fund '${row.fund_id}', not '${fundId}'`);
  }
}

export async function createScenario(env: Env, actor: Actor, input: CreateScenarioInput): Promise<ScenarioRow> {
  const fund = await env.WP_OS_DB.prepare("SELECT id, firm_scope FROM fund WHERE id = ?1").bind(input.fund_id).first<{ id: string; firm_scope: string }>();
  if (!fund) throw new AllocationError(400, "unknown_fund", `fund '${input.fund_id}' does not exist`);
  await mustAuthorize(env, actor, "fund_scenario.create", "fund_construction_scenario", undefined, fund.firm_scope);

  await assertPolicyVersion(env, "investment_mandate_version", input.mandate_version_id, fund.id);
  await assertPolicyVersion(env, "sleeve_policy_version", input.sleeve_version_id, fund.id);
  await assertPolicyVersion(env, "reserve_policy_version", input.reserve_version_id, fund.id);
  await assertPolicyVersion(env, "concentration_policy_version", input.concentration_version_id, fund.id);

  const id = `fcs_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO fund_construction_scenario
       (id, fund_id, name, mandate_version_id, sleeve_version_id, reserve_version_id, concentration_version_id,
        model_version, fund_size, investable, fund_deployed, reserve_committed, reserve_modeled_need, notes, privacy_label, firm_scope, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
  )
    .bind(
      id,
      fund.id,
      input.name,
      input.mandate_version_id,
      input.sleeve_version_id,
      input.reserve_version_id,
      input.concentration_version_id,
      ALLOCATION_MODEL_VERSION,
      input.fund_size,
      input.investable,
      input.fund_deployed ?? 0,
      input.reserve_committed ?? 0,
      input.reserve_modeled_need ?? 0,
      input.notes ?? null,
      input.privacy_label ?? "CONFIDENTIAL",
      fund.firm_scope,
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    )
    .run();

  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "allocation.scenario_created",
    actorType,
    actorId,
    objectType: "fund_construction_scenario",
    objectId: id,
    firmScope: fund.firm_scope,
    payload: {
      fund_id: fund.id,
      model_version: ALLOCATION_MODEL_VERSION,
      pinned: {
        mandate: input.mandate_version_id,
        sleeve: input.sleeve_version_id,
        reserve: input.reserve_version_id,
        concentration: input.concentration_version_id,
      },
    },
  });
  return (await getScenario(env, id))!;
}

export async function addAssumption(
  env: Env,
  actor: Actor,
  scenarioId: string,
  input: { assumption_key: string; assumption_value: string; basis: string },
) {
  const scenario = await getScenario(env, scenarioId);
  if (!scenario) throw new AllocationError(404, "not_found");
  await mustAuthorize(env, actor, "fund_scenario.add_assumption", "scenario_assumption", scenarioId, scenario.firm_scope);
  const id = `sca_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO scenario_assumption (id, scenario_id, assumption_key, assumption_value, basis, stated_by, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(id, scenarioId, input.assumption_key, input.assumption_value, input.basis, actor.firmUserId ?? actor.aiEmployeeId ?? "system", scenario.firm_scope)
    .run();
  return env.WP_OS_DB.prepare("SELECT * FROM scenario_assumption WHERE id = ?1").bind(id).first();
}

// ── Options ──

export interface CreateOptionInput {
  option_type: OptionType;
  label: string;
  sleeve_key: string;
  sleeve_target_pct: number;
  capital: number;
  sleeve_deployed?: number;
  reserve_draw?: number;
  existing_company_cost?: number;
  company_id?: string;
  position_id?: string;
  mandate_exclusions?: string[];
  ai_run_id?: string;
}

export async function createOption(env: Env, actor: Actor, scenarioId: string, input: CreateOptionInput): Promise<OptionRow> {
  const scenario = await getScenario(env, scenarioId);
  if (!scenario) throw new AllocationError(404, "not_found");
  await mustAuthorize(env, actor, "allocation_option.create", "capital_allocation_option", scenarioId, scenario.firm_scope);
  // An AI may PROPOSE an option, but only with its governed run trace attached.
  if (actor.type === "AI" && !input.ai_run_id) {
    throw new AllocationError(400, "invalid_input", "an AI-proposed allocation option must record its ai_run_id (run_ai trace)");
  }
  if (input.capital < 0) throw new AllocationError(400, "invalid_input", "capital is stated as a positive amount; direction comes from option_type");

  const id = `cao_${crypto.randomUUID()}`;
  const { actorType, actorId } = eventActor(actor);
  await env.WP_OS_DB.prepare(
    `INSERT INTO capital_allocation_option
       (id, scenario_id, option_type, label, company_id, position_id, sleeve_key, sleeve_target_pct, sleeve_deployed,
        capital, reserve_draw, existing_company_cost, mandate_exclusions_json, proposed_by_type, proposed_by_id, ai_run_id, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
  )
    .bind(
      id,
      scenarioId,
      input.option_type,
      input.label,
      input.company_id ?? null,
      input.position_id ?? null,
      input.sleeve_key,
      input.sleeve_target_pct,
      input.sleeve_deployed ?? 0,
      input.capital,
      input.reserve_draw ?? 0,
      input.existing_company_cost ?? 0,
      JSON.stringify(input.mandate_exclusions ?? []),
      actor.type === "AI" ? "AI" : "HUMAN",
      actorId,
      input.ai_run_id ?? null,
      scenario.firm_scope,
    )
    .run();

  await appendEvent(env, {
    eventType: "allocation.option_proposed",
    actorType,
    actorId,
    objectType: "capital_allocation_option",
    objectId: id,
    firmScope: scenario.firm_scope,
    payload: { scenario_id: scenarioId, option_type: input.option_type, capital: input.capital, proposed_by_type: actor.type === "AI" ? "AI" : "HUMAN" },
  });
  return (await getOption(env, id))!;
}

// ── Comparison runs ──

/** Read the pinned policy state a run must be computed against. */
function pinnedPolicyOf(scenario: ScenarioRow, concentrationLimitPct: number | null, reservePct: number): PinnedPolicy {
  return {
    fundSize: scenario.fund_size,
    investable: scenario.investable,
    concentrationLimitPct,
    reservePct,
    reserveCommitted: scenario.reserve_committed,
    reserveModeledNeed: scenario.reserve_modeled_need,
    fundDeployed: scenario.fund_deployed,
  };
}

async function policyNumbers(env: Env, scenario: ScenarioRow): Promise<{ concentrationLimitPct: number | null; reservePct: number }> {
  const concentration = await env.WP_OS_DB.prepare("SELECT concentration_json FROM concentration_policy_version WHERE id = ?1")
    .bind(scenario.concentration_version_id)
    .first<{ concentration_json: string }>();
  const reserve = await env.WP_OS_DB.prepare("SELECT reserve_json FROM reserve_policy_version WHERE id = ?1")
    .bind(scenario.reserve_version_id)
    .first<{ reserve_json: string }>();
  const concentrationPolicy = JSON.parse(concentration?.concentration_json ?? "{}") as { max_single_company_pct?: number };
  const reservePolicy = JSON.parse(reserve?.reserve_json ?? "{}") as { reserve_pct?: number };
  // A policy that does not state a limit produces NO limit — the system never
  // invents a threshold the operator did not set (same rule as P8 severity bands).
  return {
    concentrationLimitPct: typeof concentrationPolicy.max_single_company_pct === "number" ? concentrationPolicy.max_single_company_pct : null,
    reservePct: typeof reservePolicy.reserve_pct === "number" ? reservePolicy.reserve_pct : 0,
  };
}

export interface ComparisonRunResult {
  run: Record<string, unknown>;
  results: Array<Record<string, unknown>>;
  violations: Array<Record<string, unknown>>;
}

/**
 * Compute every option in the scenario against the pinned policy versions and store
 * the run. Reserve draws accumulate across options in the run, so two reserve
 * options that individually fit but jointly overdraw the pool BOTH surface it.
 */
export async function runComparison(env: Env, actor: Actor, scenarioId: string): Promise<ComparisonRunResult> {
  const scenario = await getScenario(env, scenarioId);
  if (!scenario) throw new AllocationError(404, "not_found");
  await mustAuthorize(env, actor, "allocation_comparison.run", "cross_sleeve_comparison_run", scenarioId, scenario.firm_scope);

  const options = await env.WP_OS_DB.prepare("SELECT * FROM capital_allocation_option WHERE scenario_id = ?1 ORDER BY created_at, id")
    .bind(scenarioId)
    .all<OptionRow>();
  const rows = options.results ?? [];
  if (rows.length === 0) throw new AllocationError(409, "no_options", "a comparison run needs at least one capital option");

  const { concentrationLimitPct, reservePct } = await policyNumbers(env, scenario);
  const runId = `csr_${crypto.randomUUID()}`;

  const results: Array<Record<string, unknown>> = [];
  const violations: Array<Record<string, unknown>> = [];
  let breachTotal = 0;
  let reserveCommittedRunning = scenario.reserve_committed;

  for (const option of rows) {
    const policy = pinnedPolicyOf({ ...scenario, reserve_committed: reserveCommittedRunning }, concentrationLimitPct, reservePct);
    const evaluation = evaluateOption(policy, {
      optionType: option.option_type,
      capital: option.capital,
      reserveDraw: option.reserve_draw,
      sleeve: { key: option.sleeve_key, targetPct: option.sleeve_target_pct, deployed: option.sleeve_deployed },
      existingCompanyCost: option.existing_company_cost,
      mandateExclusions: JSON.parse(option.mandate_exclusions_json) as string[],
    });
    reserveCommittedRunning = evaluation.reserve.committedAfter;

    const breaches = evaluation.violations.filter((v) => v.severity === "BREACH").length;
    breachTotal += breaches;
    const resultId = `cor_${crypto.randomUUID()}`;
    results.push({
      id: resultId,
      run_id: runId,
      option_id: option.id,
      option_type: option.option_type,
      label: option.label,
      sleeve_budget: evaluation.capacity.sleeveBudget,
      sleeve_remaining_after: evaluation.capacity.remainingAfter,
      sleeve_fits: evaluation.capacity.fits,
      concentration_pct_before: evaluation.concentration.pctBefore,
      concentration_pct_after: evaluation.concentration.pctAfter,
      concentration_within_limit: evaluation.concentration.withinLimit,
      reserve_uncommitted_after: evaluation.reserve.uncommittedAfter,
      reserve_coverage_pct_after: evaluation.reserve.coveragePctAfter,
      reserve_sufficient: evaluation.reserve.sufficient,
      undeployed_after: evaluation.undeployedAfter,
      breach_count: breaches,
    });
    for (const violation of evaluation.violations) {
      violations.push({ id: `cvi_${crypto.randomUUID()}`, run_id: runId, option_id: option.id, ...violation });
    }
  }

  await env.WP_OS_DB.prepare(
    `INSERT INTO cross_sleeve_comparison_run
       (id, scenario_id, model_version, mandate_version_id, sleeve_version_id, reserve_version_id, concentration_version_id,
        option_count, breach_count, run_by, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      runId,
      scenarioId,
      scenario.model_version,
      scenario.mandate_version_id,
      scenario.sleeve_version_id,
      scenario.reserve_version_id,
      scenario.concentration_version_id,
      rows.length,
      breachTotal,
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
      scenario.firm_scope,
    )
    .run();

  for (const r of results) {
    await env.WP_OS_DB.prepare(
      `INSERT INTO comparison_run_option_result
         (id, run_id, option_id, sleeve_budget, sleeve_remaining_after, sleeve_fits, concentration_pct_before,
          concentration_pct_after, concentration_within_limit, reserve_uncommitted_after, reserve_coverage_pct_after,
          reserve_sufficient, undeployed_after, breach_count, firm_scope)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    )
      .bind(
        r.id as string,
        runId,
        r.option_id as string,
        r.sleeve_budget as number,
        r.sleeve_remaining_after as number,
        r.sleeve_fits ? 1 : 0,
        r.concentration_pct_before as number,
        r.concentration_pct_after as number,
        r.concentration_within_limit ? 1 : 0,
        r.reserve_uncommitted_after as number,
        r.reserve_coverage_pct_after as number,
        r.reserve_sufficient ? 1 : 0,
        r.undeployed_after as number,
        r.breach_count as number,
        scenario.firm_scope,
      )
      .run();
  }
  for (const v of violations) {
    await env.WP_OS_DB.prepare(
      "INSERT INTO constraint_violation (id, run_id, option_id, kind, severity, detail, limit_value, observed, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )
      .bind(v.id as string, runId, v.option_id as string, v.kind as string, v.severity as string, v.detail as string, (v.limit as number | null) ?? null, v.observed as number, scenario.firm_scope)
      .run();
  }

  if (scenario.status === "DRAFT") {
    await env.WP_OS_DB.prepare("UPDATE fund_construction_scenario SET status = 'COMPARED' WHERE id = ?1").bind(scenarioId).run();
  }

  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "allocation.comparison_run",
    actorType,
    actorId,
    objectType: "cross_sleeve_comparison_run",
    objectId: runId,
    firmScope: scenario.firm_scope,
    payload: { scenario_id: scenarioId, option_count: rows.length, breach_count: breachTotal, model_version: scenario.model_version },
  });

  const run = await env.WP_OS_DB.prepare("SELECT * FROM cross_sleeve_comparison_run WHERE id = ?1").bind(runId).first<Record<string, unknown>>();
  return { run: run!, results, violations };
}

// ── Decisions ──

/**
 * Record a human decision on an option. Requires the receipt for the option type's
 * OWN reserved action; a follow-on receipt can never approve a secondary, and so on.
 * A RESERVE approval also writes the reserve_allocation row that commits the pool.
 */
export async function decideOption(
  env: Env,
  actor: Actor,
  optionId: string,
  input: { decision: "APPROVED" | "REJECTED"; approval_receipt_id?: string; note?: string },
) {
  const option = await getOption(env, optionId);
  if (!option) throw new AllocationError(404, "not_found");
  if (actor.type !== "HUMAN") throw new AllocationError(403, "forbidden", "a capital allocation decision is human-reserved; an AI can never decide one");
  if (option.decision !== "UNDECIDED") throw new AllocationError(409, "already_decided", `option is ${option.decision}`);

  const actionKey = OPTION_DECISION_ACTIONS[option.option_type];
  const authz = await authorize(env, actor, actionKey, { objectType: "capital_allocation_option", objectId: optionId, firmScope: option.firm_scope }, { receiptId: input.approval_receipt_id });
  if (authz.decision === "DENY") throw new AllocationError(403, "forbidden", authz.reason);
  if (authz.decision !== "ALLOW") throw new AllocationError(409, "approval_required", `${actionKey}: ${authz.reason}`);

  const scenario = (await getScenario(env, option.scenario_id))!;
  await env.WP_OS_DB.prepare(
    "UPDATE capital_allocation_option SET decision = ?2, decided_by = ?3, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), approval_card_id = ?4 WHERE id = ?1",
  )
    .bind(optionId, input.decision, actor.firmUserId!, authz.receiptId!)
    .run();

  let reserveAllocationId: string | null = null;
  if (input.decision === "APPROVED" && option.option_type === "RESERVE") {
    if (!option.company_id) throw new AllocationError(400, "invalid_input", "a reserve allocation must name the company it is reserved for");
    reserveAllocationId = `rsa_${crypto.randomUUID()}`;
    await env.WP_OS_DB.prepare(
      "INSERT INTO reserve_allocation (id, fund_id, company_id, option_id, reserve_version_id, amount, approval_card_id, committed_by, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )
      .bind(reserveAllocationId, scenario.fund_id, option.company_id, optionId, scenario.reserve_version_id, option.reserve_draw || option.capital, authz.receiptId!, actor.firmUserId!, option.firm_scope)
      .run();
  }

  await consumeApprovalCard(env, authz.receiptId!, { actorId: actor.firmUserId! });
  await appendEvent(env, {
    eventType: "allocation.option_decided",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "capital_allocation_option",
    objectId: optionId,
    firmScope: option.firm_scope,
    payload: {
      decision: input.decision,
      option_type: option.option_type,
      action_key: actionKey,
      receipt_id: authz.receiptId,
      reserve_allocation_id: reserveAllocationId,
      note: input.note ?? null,
      // Explicit: a decision record is not a capital movement.
      capital_moved: false,
    },
  });
  return { option: (await getOption(env, optionId))!, reserve_allocation_id: reserveAllocationId };
}

/** Ask for the approval card an option's decision will need. */
export async function requestOptionApproval(env: Env, actor: Actor, optionId: string) {
  const option = await getOption(env, optionId);
  if (!option) throw new AllocationError(404, "not_found");
  const actionKey = OPTION_DECISION_ACTIONS[option.option_type];
  const card = await requestApproval(env, actor, {
    action_key: actionKey,
    object_type: "capital_allocation_option",
    object_id: optionId,
    title: `${actionKey}: ${option.label}`,
    summary: `${option.option_type} option for ${option.capital} in sleeve '${option.sleeve_key}' — modelled scenario, not an expected return`,
    payload: { option_id: optionId, option_type: option.option_type, capital: option.capital },
    firm_scope: option.firm_scope,
    submit: true,
  });
  return card;
}

// ── Follow-on review ──

export async function createFollowOnReview(
  env: Env,
  actor: Actor,
  scenarioId: string,
  input: { company_id: string; position_id?: string; option_id?: string; path: FollowOnInput },
) {
  const scenario = await getScenario(env, scenarioId);
  if (!scenario) throw new AllocationError(404, "not_found");
  await mustAuthorize(env, actor, "follow_on_review.create", "follow_on_review", scenarioId, scenario.firm_scope);
  // The path economics come from the hand-verified P6 port, never from a second copy.
  const path = computeFollowOn(input.path);
  const id = `for_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO follow_on_review (id, scenario_id, company_id, position_id, option_id, path_json, firm_scope, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(id, scenarioId, input.company_id, input.position_id ?? null, input.option_id ?? null, JSON.stringify({ inputs: input.path, result: path }), scenario.firm_scope, actor.firmUserId ?? actor.aiEmployeeId ?? "system")
    .run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "allocation.follow_on_review_opened",
    actorType,
    actorId,
    objectType: "follow_on_review",
    objectId: id,
    firmScope: scenario.firm_scope,
    payload: { scenario_id: scenarioId, company_id: input.company_id },
  });
  return { ...(await env.WP_OS_DB.prepare("SELECT * FROM follow_on_review WHERE id = ?1").bind(id).first())!, path };
}

export async function reviewFollowOn(env: Env, actor: Actor, reviewId: string, note: string) {
  const review = await env.WP_OS_DB.prepare("SELECT * FROM follow_on_review WHERE id = ?1").bind(reviewId).first<{ id: string; status: string; firm_scope: string }>();
  if (!review) throw new AllocationError(404, "not_found");
  if (actor.type !== "HUMAN") throw new AllocationError(403, "forbidden", "a follow-on review is recorded by a human");
  if (review.status !== "OPEN") throw new AllocationError(409, "already_reviewed");
  await env.WP_OS_DB.prepare(
    "UPDATE follow_on_review SET status = 'REVIEWED', reviewed_by = ?2, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), review_note = ?3 WHERE id = ?1",
  )
    .bind(reviewId, actor.firmUserId!, note)
    .run();
  return env.WP_OS_DB.prepare("SELECT * FROM follow_on_review WHERE id = ?1").bind(reviewId).first();
}

// ── HTTP handlers ──

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof AllocationError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

const scenarioSchema = z.object({
  fund_id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  mandate_version_id: z.string().trim().min(1),
  sleeve_version_id: z.string().trim().min(1),
  reserve_version_id: z.string().trim().min(1),
  concentration_version_id: z.string().trim().min(1),
  fund_size: z.number().positive(),
  investable: z.number().positive(),
  fund_deployed: z.number().min(0).optional(),
  reserve_committed: z.number().min(0).optional(),
  reserve_modeled_need: z.number().min(0).optional(),
  notes: z.string().optional(),
  privacy_label: privacyLabelSchema.optional(),
});

export async function handleCreateScenario(ctx: RouteContext): Promise<Response> {
  const parsed = scenarioSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createScenario(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListScenarios(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const rows = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM fund_construction_scenario WHERE ${visibility} ORDER BY created_at DESC, id LIMIT 200`).all();
  return json({ scenarios: rows.results ?? [] });
}

export async function handleGetScenario(ctx: RouteContext): Promise<Response> {
  const scenario = await getScenario(ctx.env, ctx.params.id!);
  if (!scenario || !canAccessPrivacyLabel(ctx.identity!, scenario.privacy_label)) return json({ error: "not_found" }, { status: 404 });
  const options = await ctx.env.WP_OS_DB.prepare("SELECT * FROM capital_allocation_option WHERE scenario_id = ?1 ORDER BY created_at, id").bind(scenario.id).all();
  const assumptions = await ctx.env.WP_OS_DB.prepare("SELECT * FROM scenario_assumption WHERE scenario_id = ?1 ORDER BY created_at, id").bind(scenario.id).all();
  const runs = await ctx.env.WP_OS_DB.prepare("SELECT * FROM cross_sleeve_comparison_run WHERE scenario_id = ?1 ORDER BY created_at DESC, id").bind(scenario.id).all();
  return json({
    ...scenario,
    options: options.results ?? [],
    // Assumptions ride along with the scenario: a reviewer never has to go looking.
    assumptions: assumptions.results ?? [],
    runs: runs.results ?? [],
    outcome_label: "MODELLED SCENARIO — NOT AN EXPECTED RETURN",
  });
}

const assumptionSchema = z.object({
  assumption_key: z.string().trim().min(1),
  assumption_value: z.string().trim().min(1),
  basis: z.string().trim().min(1),
});

export async function handleAddAssumption(ctx: RouteContext): Promise<Response> {
  const parsed = assumptionSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await addAssumption(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const optionSchema = z.object({
  option_type: z.enum(OPTION_TYPES),
  label: z.string().trim().min(1),
  sleeve_key: z.string().trim().min(1),
  sleeve_target_pct: z.number().min(0).max(100),
  capital: z.number(),
  sleeve_deployed: z.number().min(0).optional(),
  reserve_draw: z.number().min(0).optional(),
  existing_company_cost: z.number().min(0).optional(),
  company_id: z.string().optional(),
  position_id: z.string().optional(),
  mandate_exclusions: z.array(z.string()).optional(),
  ai_run_id: z.string().optional(),
});

export async function handleCreateOption(ctx: RouteContext): Promise<Response> {
  const parsed = optionSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createOption(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleRunComparison(ctx: RouteContext): Promise<Response> {
  try {
    return json(await runComparison(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleGetComparisonRun(ctx: RouteContext): Promise<Response> {
  const run = await ctx.env.WP_OS_DB.prepare("SELECT * FROM cross_sleeve_comparison_run WHERE id = ?1").bind(ctx.params.id!).first();
  if (!run) return json({ error: "not_found" }, { status: 404 });
  const results = await ctx.env.WP_OS_DB.prepare("SELECT * FROM comparison_run_option_result WHERE run_id = ?1 ORDER BY created_at, id").bind(ctx.params.id!).all();
  const violations = await ctx.env.WP_OS_DB.prepare("SELECT * FROM constraint_violation WHERE run_id = ?1 ORDER BY created_at, id").bind(ctx.params.id!).all();
  return json({ ...run, results: results.results ?? [], violations: violations.results ?? [] });
}

export async function handleRequestOptionApproval(ctx: RouteContext): Promise<Response> {
  try {
    return json(await requestOptionApproval(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const decideSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  approval_receipt_id: z.string().trim().min(1).optional(),
  note: z.string().optional(),
});

export async function handleDecideOption(ctx: RouteContext): Promise<Response> {
  const parsed = decideSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await decideOption(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListReserveAllocations(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare("SELECT * FROM reserve_allocation ORDER BY created_at DESC, id LIMIT 200").all();
  return json({ reserve_allocations: rows.results ?? [] });
}

const followOnPathSchema = z.object({
  currentOwnershipPct: z.number(),
  currentFullyDilutedShares: z.number(),
  roundSize: z.number(),
  primaryPps: z.number(),
  secondaryPps: z.number(),
  secondaryCapital: z.number(),
  secondaryFeesPct: z.number(),
  targetOwnershipPct: z.number(),
  maxAllocation: z.number(),
  extraDilutionPct: z.number(),
  futureDilutionPct: z.number(),
  exitValue: z.number(),
  holdYears: z.number(),
  existingCost: z.number(),
  fundSize: z.number(),
});

const followOnSchema = z.object({
  company_id: z.string().trim().min(1),
  position_id: z.string().optional(),
  option_id: z.string().optional(),
  path: followOnPathSchema,
});

export async function handleCreateFollowOnReview(ctx: RouteContext): Promise<Response> {
  const parsed = followOnSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createFollowOnReview(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleReviewFollowOn(ctx: RouteContext): Promise<Response> {
  const parsed = z.object({ review_note: z.string().trim().min(1) }).safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await reviewFollowOn(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.review_note));
  } catch (err) {
    return errorResponse(err);
  }
}
