import { reserveUsd, sleeveTargetUsd, type ReserveDoc, type SleeveDoc } from "./sleeveMath";

/**
 * The fund's allocation, as ONE computation both pages read.
 *
 * WHY THIS FILE EXISTS. Fund strategy drew "Where the fund goes" from four figures it worked out
 * inline inside `FundAllocation.tsx` — fees, secondaries, reserves, and "whatever is left". The
 * Portfolio page now needs the same four figures to say what has actually been deployed against
 * them, and the operator asked for "the pictorial graphs in portfolio allocation from the fund
 * strategy page" on Portfolio. Two pages computing the same split from the same policies is the
 * shape that put $200K between two readings of this fund in August, so the arithmetic moves here
 * and both pages import it. A test feeds one fixture to both surfaces and diffs the numbers.
 *
 * WHAT IS PLAN AND WHAT IS ACTUAL, kept apart on purpose:
 *   `planSlices`       — where the firm DECIDED the money goes. Policy only. No database read.
 *   `deploymentSlices` — the same plan with what has actually gone out drawn against it. The one
 *                        figure that comes from the ledger is `deployedUsd`; everything else is
 *                        the plan, so the two views can never disagree about fees or reserves.
 */

export interface PlanSlices {
  fundSize: number;
  /** Management fees plus expenses, off the top before anything is invested. */
  fees: number;
  /** The secondaries sleeve, derived from its percentage of the investable base. */
  secondaries: number;
  /** Reserves held inside the early-stage sleeve for follow-ons. */
  reserves: number;
  /** What is left to write initial cheques with. Derived, so the four always sum to the fund. */
  initial: number;
}

export function planSlices(fundSize: number, sleeve: SleeveDoc, reserve: ReserveDoc): PlanSlices {
  const fees = (sleeve.estimated_fees_usd ?? 0) + (sleeve.estimated_expenses_usd ?? 0);
  const secondarySleeve = (sleeve.sleeves ?? []).find((x) => x.key === "SECONDARY_PURCHASE");
  const secondaries = secondarySleeve ? sleeveTargetUsd(sleeve, secondarySleeve) : 0;
  const reserves = reserveUsd(sleeve, reserve);
  const initial = Math.max(0, fundSize - fees - secondaries - reserves);
  return { fundSize, fees, secondaries, reserves, initial };
}

export interface DeploymentSlices extends PlanSlices {
  /** What has actually gone into companies: booked cost plus closed-but-unbooked amounts. */
  deployed: number;
  /** Initial-cheque capital not yet deployed. Never negative; overspend is reported separately. */
  remaining: number;
  /** How far deployed exceeds the initial-cheque plan, if it does. Zero otherwise. */
  overspend: number;
}

export function deploymentSlices(plan: PlanSlices, deployedUsd: number): DeploymentSlices {
  const deployed = Math.max(0, deployedUsd);
  return {
    ...plan,
    deployed,
    remaining: Math.max(0, plan.initial - deployed),
    overspend: Math.max(0, deployed - plan.initial),
  };
}

/** A ring segment: what the shared `AllocationRing` draws. Colour is a token name, never a hex. */
export interface RingSlice {
  key: string;
  label: string;
  usd: number;
  color: string;
  note: string;
}

/** The plan as ring segments — the exact list Fund strategy has always drawn. */
export function planRingSlices(plan: PlanSlices): RingSlice[] {
  return [
    { key: "initial", label: "Initial cheques", usd: plan.initial, color: "var(--viz-1)", note: "What actually buys ownership" },
    { key: "reserves", label: "Reserves", usd: plan.reserves, color: "var(--viz-2)", note: "Defending ownership through the Series A" },
    { key: "secondaries", label: "Secondaries", usd: plan.secondaries, color: "var(--viz-3)", note: "The J-curve answer" },
    { key: "fees", label: "Fees and expenses", usd: plan.fees, color: "var(--viz-4)", note: "Off the top, before anything is invested" },
  ].filter((s) => s.usd > 0);
}

/**
 * The portfolio's view of the same plan: initial cheques split into deployed and remaining.
 *
 * Reserves, secondaries and fees are the plan's own figures, unchanged and in the SAME colours the
 * plan ring gives them, so a reader moving between the two pages sees one identity per part. The
 * initial-cheque slice keeps its colour for the part that has been spent; the part still to write
 * is drawn in the ring's own empty-track colour, because "not yet" is the absence of a series, not a
 * fifth one — the palette holds four separable hues on purpose (styles.css, `--viz-*`).
 */
export function deploymentRingSlices(d: DeploymentSlices): RingSlice[] {
  return [
    { key: "deployed", label: "Deployed", usd: d.deployed, color: "var(--viz-1)", note: "In companies today, at what was paid" },
    { key: "remaining", label: "Still to deploy", usd: d.remaining, color: "var(--wp-line)", note: "Initial-cheque capital not yet written" },
    { key: "reserves", label: "Reserves", usd: d.reserves, color: "var(--viz-2)", note: "Held back for follow-ons" },
    { key: "secondaries", label: "Secondaries", usd: d.secondaries, color: "var(--viz-3)", note: "The secondaries sleeve, untouched by initial cheques" },
    { key: "fees", label: "Fees and expenses", usd: d.fees, color: "var(--viz-4)", note: "Off the top" },
  ].filter((s) => s.usd > 0);
}
