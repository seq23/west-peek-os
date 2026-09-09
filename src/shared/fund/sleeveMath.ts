/**
 * Fund construction arithmetic: ONE figure is stored, the other is derived.
 *
 * WHAT THIS FIXES, AND WHY IT IS A DECISION RATHER THAN A SUM. `sleeve_policy_version` v1 stored a
 * percentage AND a dollar figure for each sleeve, and they disagreed:
 *
 *     EARLY_STAGE_PRIMARY   70% of $24.0M = $16.8M, stored as $17.0M
 *     SECONDARY_PURCHASE    30% of $24.0M = $7.2M,  stored as $7.0M
 *
 * Both readings are internally consistent — 16.8 + 7.2 = 24.0 and 17.0 + 7.0 = 24.0 — so the totals
 * agree either way and "correct the mismatch" had two different right answers. What actually
 * disagreed was whether the intended split is 70/30 or 70.83/29.17, and picking whichever needed
 * the smaller edit would have been guessing at a policy decision.
 *
 * THE RECORD SETTLES IT, and it is worth citing because the answer came from evidence rather than
 * preference:
 *
 *   1. The DECK states the split in PERCENTAGE terms. Sleeve v1's own note records the deck as
 *      "call[ing] a $6M secondaries sleeve 30%" — a percentage is what the firm said out loud.
 *   2. The same note says this version "starts from investable capital instead", i.e. the base moved
 *      from the $30M committed to the $24M investable, and the percentages were carried across while
 *      the dollars were recomputed against the new base.
 *   3. Every stored dollar figure is a ROUND MILLION — $17.0M, $7.0M, and the reserve's $7.0M —
 *      while their percentage-derived values are $16.8M, $7.2M and $6.72M. Three figures rounded the
 *      same way is the signature of a presented computation, not of three independent decisions.
 *
 * So the PERCENTAGE is the policy and the dollar figure is a computation over a base that moves
 * whenever fees, expenses or fund size are re-estimated. Storing both is what created the defect;
 * storing the derived one is what would recreate it the next time the base changes. Hence: store the
 * percentage, derive the dollars, here, once.
 *
 * WHAT IT COSTS, SAID PLAINLY BECAUSE IT IS NOT COSMETIC. The early-stage sleeve becomes $16.8M
 * rather than $17.0M, so at 40% reserved it leaves $10.08M for initial cheques rather than $10.2M.
 * Twenty positions at the mandate's $500–750K needs $10.0M–$15.0M, so the target portfolio now
 * clears the very bottom of its own range by $80K instead of $200K. That is a real tightening and
 * the discrepancy register states it.
 *
 * LEGACY VERSIONS STILL READ CORRECTLY. A stored `target_usd` on a version that carries no
 * percentage is still honoured — those are the only rows where the dollar figure IS the decision.
 */

export interface StoredSleeve {
  key: string;
  /** The policy: what share of the investable base this sleeve is. */
  target_pct?: number;
  /** Legacy only. Present on versions written before the percentage became authoritative. */
  target_usd?: number;
  stage?: string;
}

export interface SleeveDoc {
  basis?: string;
  committed_usd?: number;
  estimated_fees_usd?: number;
  estimated_expenses_usd?: number;
  estimated_investable_usd?: number;
  sleeves?: StoredSleeve[];
  note?: string;
}

export interface ReserveDoc {
  reserve_pct?: number;
  basis?: string;
  /** Legacy only, for the same reason as `StoredSleeve.target_usd`. */
  reserve_usd?: number;
}

/**
 * The base every sleeve percentage is a percentage OF.
 *
 * Prefers the stated investable figure and otherwise computes it, so a document that records the
 * inputs but not the result is not silently treated as a fund of zero.
 */
export function investableBase(doc: SleeveDoc): number {
  if (typeof doc.estimated_investable_usd === "number") return doc.estimated_investable_usd;
  const committed = doc.committed_usd ?? 0;
  if (committed === 0) return 0;
  return committed - (doc.estimated_fees_usd ?? 0) - (doc.estimated_expenses_usd ?? 0);
}

/**
 * What this sleeve is actually worth, in dollars.
 *
 * Derived from the percentage wherever there is one. Never rounded: $16.8M is the number, and
 * rounding it to $17.0M here would put the original defect back one layer down.
 */
export function sleeveTargetUsd(doc: SleeveDoc, sleeve: StoredSleeve): number {
  if (typeof sleeve.target_pct === "number") return (sleeve.target_pct / 100) * investableBase(doc);
  return sleeve.target_usd ?? 0;
}

/** Reserves come out of the early-stage sleeve, so they move with it. */
export function reserveUsd(doc: SleeveDoc, reserve: ReserveDoc, sleeveKey = "EARLY_STAGE_PRIMARY"): number {
  const sleeve = (doc.sleeves ?? []).find((s) => s.key === sleeveKey);
  if (typeof reserve.reserve_pct === "number" && sleeve) {
    return (reserve.reserve_pct / 100) * sleeveTargetUsd(doc, sleeve);
  }
  return reserve.reserve_usd ?? 0;
}

/** What is left to write initial cheques with, once reserves are held back. */
export function initialCapitalUsd(doc: SleeveDoc, reserve: ReserveDoc, sleeveKey = "EARLY_STAGE_PRIMARY"): number {
  const sleeve = (doc.sleeves ?? []).find((s) => s.key === sleeveKey);
  if (!sleeve) return 0;
  return sleeveTargetUsd(doc, sleeve) - reserveUsd(doc, reserve, sleeveKey);
}

export interface SleeveMismatch {
  key: string;
  storedUsd: number;
  derivedUsd: number;
  differenceUsd: number;
}

/**
 * Sleeves that carry BOTH a percentage and a dollar figure, disagreeing.
 *
 * The whole defect class in one function, so a validator can assert its absence by computing rather
 * than by reading prose. A dollar figure alone is legitimate (legacy); a percentage alone is the
 * intended shape; both, disagreeing, is the bug — and both AGREEING is still worth avoiding, because
 * it only agrees until the base moves. Tolerance is a dollar: these are integer cents-free figures
 * and floating point should not manufacture a finding.
 */
export function sleeveMismatches(doc: SleeveDoc): SleeveMismatch[] {
  const out: SleeveMismatch[] = [];
  for (const sleeve of doc.sleeves ?? []) {
    if (typeof sleeve.target_pct !== "number" || typeof sleeve.target_usd !== "number") continue;
    const derived = (sleeve.target_pct / 100) * investableBase(doc);
    const difference = Math.abs(derived - sleeve.target_usd);
    if (difference >= 1) {
      out.push({ key: sleeve.key, storedUsd: sleeve.target_usd, derivedUsd: derived, differenceUsd: difference });
    }
  }
  return out;
}

/**
 * The reserve carries the identical defect and was not in the original report.
 *
 * `reserve_policy_version` v1 stores `reserve_pct: 40` against the early-stage sleeve AND
 * `reserve_usd: 7_000_000`. Forty percent of the sleeve's derived $16.8M is $6.72M, so the stored
 * figure is out by $280K — larger than either sleeve mismatch, and found only because the same
 * question was asked of the neighbouring row. Same rule, same function.
 */
export function reserveMismatch(doc: SleeveDoc, reserve: ReserveDoc, sleeveKey = "EARLY_STAGE_PRIMARY"): SleeveMismatch | null {
  if (typeof reserve.reserve_pct !== "number" || typeof reserve.reserve_usd !== "number") return null;
  const sleeve = (doc.sleeves ?? []).find((s) => s.key === sleeveKey);
  if (!sleeve) return null;
  const derived = (reserve.reserve_pct / 100) * sleeveTargetUsd(doc, sleeve);
  const difference = Math.abs(derived - reserve.reserve_usd);
  if (difference < 1) return null;
  return { key: "RESERVE", storedUsd: reserve.reserve_usd, derivedUsd: derived, differenceUsd: difference };
}

/** `$16.8M`, `$10.08M`, `$80K` — the register and the fund page say figures the same way. */
export function usd(amount: number): string {
  if (Math.abs(amount) >= 1e6) {
    const millions = amount / 1e6;
    // Two places only where they carry information, so $17M does not print as $17.00M and $16.8M
    // does not print as $16.80M. Strips every trailing zero and then the orphaned point — the first
    // draft stripped ONE zero and left "$17.0M", which the guard caught.
    const text = millions.toFixed(2).replace(/\.?0+$/, "");
    return `$${text}M`;
  }
  if (Math.abs(amount) >= 1000) return `$${Math.round(amount / 1000)}K`;
  return `$${Math.round(amount)}`;
}
