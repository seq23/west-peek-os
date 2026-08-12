/**
 * Allocation math (P11) — pure comparison functions. NO DOM, no storage, no network.
 *
 * Law (plan §8/P11 + §12.2): every financial formula used for a live allocation
 * decision must be INDEPENDENTLY hand-verified. Each function below is restated from
 * first principles and hand-worked in docs/ALLOCATION_VERIFICATION.md, with the
 * worked examples encoded as fixtures in tests/allocation.test.ts. Nothing here was
 * accepted because prior code or planning prose contained it.
 *
 * Fund-construction and follow-on path economics are NOT re-derived here: they are
 * `computeFundModel` and `computeFollowOn` in src/shared/dealmath/, already ported
 * and hand-verified under D6 (docs/DEAL_MATH_VERIFICATION.md). P11 reuses them
 * rather than growing a second, unverified copy.
 *
 * What these functions are: deterministic arithmetic over stated inputs. What they
 * are NOT: expected returns, forecasts, or a recommendation. A comparison run ranks
 * nothing and approves nothing — humans decide (§12.4).
 */

export const ALLOCATION_MODEL_VERSION = "wpos-allocation-1.0.0";

export const OPTION_TYPES = ["INITIAL", "FOLLOW_ON", "RESERVE", "SECONDARY_PURCHASE", "SECONDARY_SALE", "EXIT"] as const;
export type OptionType = (typeof OPTION_TYPES)[number];

/** Options that draw capital OUT of the fund. EXIT and SECONDARY_SALE return capital. */
export const CAPITAL_DEPLOYING_OPTIONS: readonly OptionType[] = ["INITIAL", "FOLLOW_ON", "RESERVE", "SECONDARY_PURCHASE"];

/**
 * Signed capital effect of an option on deployed capital, in fund currency.
 * A sale or exit is modelled as a NEGATIVE deployment (capital comes back); it never
 * becomes "income" and it never moves money — no allocation function transfers value.
 */
export function signedCapitalEffect(optionType: OptionType, capital: number): number {
  return CAPITAL_DEPLOYING_OPTIONS.includes(optionType) ? capital : -capital;
}

// ── Capacity ──

export interface SleeveState {
  /** Sleeve key as named by the pinned sleeve policy version. */
  key: string;
  /** Target share of investable capital for this sleeve, in percent. */
  targetPct: number;
  /** Capital already deployed into this sleeve, in fund currency. */
  deployed: number;
}

export interface CapacityResult {
  sleeveKey: string;
  /** targetPct% of investable capital. */
  sleeveBudget: number;
  deployed: number;
  /** Capacity before this option. Never negative — an over-deployed sleeve has 0 left. */
  remainingBefore: number;
  /** Capacity after this option's signed effect. MAY be negative: that is the breach. */
  remainingAfter: number;
  /** How much this option exceeds the sleeve budget, 0 when it fits. */
  overBy: number;
  fits: boolean;
}

/**
 * Sleeve capacity under a pinned sleeve policy.
 *
 *   sleeveBudget    = investable × targetPct/100
 *   remainingBefore = max(sleeveBudget − deployed, 0)
 *   remainingAfter  = sleeveBudget − (deployed + signedEffect)
 *   overBy          = max(−remainingAfter, 0)
 *
 * `remainingBefore` is floored at 0 because a sleeve that is already over budget has
 * no capacity to offer; `remainingAfter` is deliberately NOT floored, so the size of
 * a breach stays visible instead of being clamped away.
 */
export function sleeveCapacity(investable: number, sleeve: SleeveState, optionType: OptionType, capital: number): CapacityResult {
  const sleeveBudget = (investable * sleeve.targetPct) / 100;
  const remainingBefore = Math.max(sleeveBudget - sleeve.deployed, 0);
  const remainingAfter = sleeveBudget - (sleeve.deployed + signedCapitalEffect(optionType, capital));
  return {
    sleeveKey: sleeve.key,
    sleeveBudget,
    deployed: sleeve.deployed,
    remainingBefore,
    remainingAfter,
    overBy: Math.max(-remainingAfter, 0),
    fits: remainingAfter >= 0,
  };
}

// ── Concentration ──

export interface ConcentrationResult {
  costBefore: number;
  costAfter: number;
  pctBefore: number;
  pctAfter: number;
  /** Percentage POINTS added to the position's share of the fund. */
  deltaPct: number;
  limitPct: number | null;
  overByPct: number;
  withinLimit: boolean;
}

/**
 * Single-company concentration under a pinned concentration policy.
 *
 *   costAfter = max(existingCost + signedEffect, 0)
 *   pct       = cost ÷ fundSize × 100            (0 when fundSize ≤ 0)
 *   overByPct = max(pctAfter − limitPct, 0)
 *
 * Concentration is measured on COST BASIS, not on marked value: a mark is an opinion
 * and would let an unrealised write-up silently create headroom. `costAfter` is
 * floored at 0 because a company cannot hold negative cost after a full exit.
 */
export function concentrationAfter(
  fundSize: number,
  existingCost: number,
  optionType: OptionType,
  capital: number,
  limitPct: number | null,
): ConcentrationResult {
  const costAfter = Math.max(existingCost + signedCapitalEffect(optionType, capital), 0);
  const pct = (cost: number): number => (fundSize > 0 ? (cost / fundSize) * 100 : 0);
  const pctBefore = pct(existingCost);
  const pctAfter = pct(costAfter);
  return {
    costBefore: existingCost,
    costAfter,
    pctBefore,
    pctAfter,
    deltaPct: pctAfter - pctBefore,
    limitPct,
    overByPct: limitPct === null ? 0 : Math.max(pctAfter - limitPct, 0),
    withinLimit: limitPct === null ? true : pctAfter <= limitPct,
  };
}

// ── Reserves ──

export interface ReserveResult {
  reservePool: number;
  committedBefore: number;
  committedAfter: number;
  uncommittedAfter: number;
  modeledNeed: number;
  /** Uncommitted reserve ÷ remaining modelled need × 100. */
  coveragePctBefore: number;
  coveragePctAfter: number;
  sufficient: boolean;
}

/**
 * Reserve effect of an option under a pinned reserve policy.
 *
 *   reservePool     = investable × reservePct/100
 *   committedAfter  = committedBefore + reserveDraw
 *   uncommittedAfter= reservePool − committedAfter          (may be negative)
 *   coveragePct     = uncommitted ÷ max(modeledNeed − committed, 0) × 100
 *
 * Coverage is measured against REMAINING modelled need (need not yet covered by
 * commitments), so committing reserve to a company does not flatter coverage for the
 * rest of the portfolio. When remaining need is 0 the ratio is undefined; coverage is
 * reported as 100 only if uncommitted reserve is non-negative, else 0.
 */
export function reserveEffect(investable: number, reservePct: number, committedBefore: number, modeledNeed: number, reserveDraw: number): ReserveResult {
  const reservePool = (investable * reservePct) / 100;
  const committedAfter = committedBefore + reserveDraw;
  const coverage = (uncommitted: number, committed: number): number => {
    const remainingNeed = Math.max(modeledNeed - committed, 0);
    if (remainingNeed <= 0) return uncommitted >= 0 ? 100 : 0;
    return (uncommitted / remainingNeed) * 100;
  };
  const uncommittedAfter = reservePool - committedAfter;
  return {
    reservePool,
    committedBefore,
    committedAfter,
    uncommittedAfter,
    modeledNeed,
    coveragePctBefore: coverage(reservePool - committedBefore, committedBefore),
    coveragePctAfter: coverage(uncommittedAfter, committedAfter),
    sufficient: uncommittedAfter >= 0,
  };
}

// ── Constraint evaluation ──

export const CONSTRAINT_KINDS = ["SLEEVE_CAPACITY", "CONCENTRATION_LIMIT", "RESERVE_SHORTFALL", "MANDATE_EXCLUSION", "UNDEPLOYED_CAPITAL"] as const;
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

export interface ConstraintViolation {
  kind: ConstraintKind;
  /** BREACH = the option violates a pinned policy. WARNING = it does not, but the state is worth seeing. */
  severity: "BREACH" | "WARNING";
  detail: string;
  /** The policy value the option was measured against, when there is one. */
  limit: number | null;
  observed: number;
}

export interface OptionEvaluationInput {
  optionType: OptionType;
  capital: number;
  /** Reserve capital this option commits, when it draws on the reserve pool. */
  reserveDraw?: number;
  /** Sleeve this option consumes, as named by the pinned sleeve policy. */
  sleeve: SleeveState;
  existingCompanyCost: number;
  /** Mandate exclusion keys the option matches (e.g. an excluded sector/stage). */
  mandateExclusions?: string[];
}

export interface PinnedPolicy {
  fundSize: number;
  investable: number;
  concentrationLimitPct: number | null;
  reservePct: number;
  reserveCommitted: number;
  reserveModeledNeed: number;
  /** Capital deployed across the whole fund, all sleeves. */
  fundDeployed: number;
}

export interface OptionEvaluation {
  capacity: CapacityResult;
  concentration: ConcentrationResult;
  reserve: ReserveResult;
  violations: ConstraintViolation[];
  /** Undeployed investable capital after the option. */
  undeployedAfter: number;
}

/**
 * Deterministic evaluation of one capital option against the PINNED policy versions.
 * It reports; it does not rank, score, or recommend, and it never decides.
 */
export function evaluateOption(policy: PinnedPolicy, input: OptionEvaluationInput): OptionEvaluation {
  const capacity = sleeveCapacity(policy.investable, input.sleeve, input.optionType, input.capital);
  const concentration = concentrationAfter(policy.fundSize, input.existingCompanyCost, input.optionType, input.capital, policy.concentrationLimitPct);
  const reserve = reserveEffect(policy.investable, policy.reservePct, policy.reserveCommitted, policy.reserveModeledNeed, input.reserveDraw ?? 0);
  const undeployedAfter = policy.investable - (policy.fundDeployed + signedCapitalEffect(input.optionType, input.capital));

  const violations: ConstraintViolation[] = [];
  if (!capacity.fits) {
    violations.push({
      kind: "SLEEVE_CAPACITY",
      severity: "BREACH",
      detail: `sleeve '${input.sleeve.key}' exceeds its policy budget by ${capacity.overBy}`,
      limit: capacity.sleeveBudget,
      observed: input.sleeve.deployed + signedCapitalEffect(input.optionType, input.capital),
    });
  }
  if (!concentration.withinLimit) {
    violations.push({
      kind: "CONCENTRATION_LIMIT",
      severity: "BREACH",
      detail: `position reaches ${concentration.pctAfter.toFixed(4)}% of the fund against a ${concentration.limitPct}% limit`,
      limit: concentration.limitPct,
      observed: concentration.pctAfter,
    });
  }
  if (!reserve.sufficient) {
    violations.push({
      kind: "RESERVE_SHORTFALL",
      severity: "BREACH",
      detail: `reserve commitments exceed the reserve pool by ${-reserve.uncommittedAfter}`,
      limit: reserve.reservePool,
      observed: reserve.committedAfter,
    });
  }
  for (const exclusion of input.mandateExclusions ?? []) {
    violations.push({
      kind: "MANDATE_EXCLUSION",
      severity: "BREACH",
      detail: `option matches a mandate exclusion: ${exclusion}`,
      limit: null,
      observed: 0,
    });
  }
  if (undeployedAfter < 0) {
    violations.push({
      kind: "UNDEPLOYED_CAPITAL",
      severity: "BREACH",
      detail: `option deploys ${-undeployedAfter} more than the fund's investable capital`,
      limit: policy.investable,
      observed: policy.fundDeployed + signedCapitalEffect(input.optionType, input.capital),
    });
  }

  return { capacity, concentration, reserve, violations, undeployedAfter };
}
