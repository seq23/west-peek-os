import { describe, expect, it } from "vitest";
import {
  initialCapitalUsd, investableBase, reserveMismatch, reserveUsd, sleeveMismatches,
  sleeveTargetUsd, usd, type ReserveDoc, type SleeveDoc,
} from "../src/shared/fund/sleeveMath";

/**
 * ONE FIGURE STORED, THE OTHER DERIVED — the guard that stops this whole class recurring.
 *
 * `sleeve_policy_version` v1 stored a percentage AND a dollar figure for each sleeve and they
 * disagreed: 70% of $24.0M is $16.8M against a stored $17.0M; 30% is $7.2M against $7.0M. Both
 * readings summed to $24.0M, so the totals agreed either way — which is what made this a DECISION
 * (70/30 or 70.83/29.17) rather than an arithmetic slip, and why picking the smaller edit would
 * have been guessing at policy.
 *
 * The operator settled it on 9 Sep 2026: "70/30 is the intent, use the percentages."
 *
 * Fixing the two rows without this file would just reset the clock. These tests assert the property
 * — that no document can carry two independently-stored numbers able to disagree — computed from
 * the document rather than asserted about it.
 */

/** Exactly the shape production carried, so the reproduction is the real one. */
const V1: SleeveDoc = {
  basis: "investable capital after fees and expenses",
  committed_usd: 30_000_000,
  estimated_fees_usd: 5_000_000,
  estimated_expenses_usd: 1_000_000,
  estimated_investable_usd: 24_000_000,
  sleeves: [
    { key: "EARLY_STAGE_PRIMARY", target_pct: 70, target_usd: 17_000_000, stage: "PRE_SEED" },
    { key: "SECONDARY_PURCHASE", target_pct: 30, target_usd: 7_000_000, stage: "SERIES_B_C" },
  ],
};

/** The shape after the decision: the percentage alone. */
const V2: SleeveDoc = {
  basis: "investable capital after fees and expenses",
  committed_usd: 30_000_000,
  estimated_fees_usd: 5_000_000,
  estimated_expenses_usd: 1_000_000,
  estimated_investable_usd: 24_000_000,
  sleeves: [
    { key: "EARLY_STAGE_PRIMARY", target_pct: 70, stage: "PRE_SEED" },
    { key: "SECONDARY_PURCHASE", target_pct: 30, stage: "SERIES_B_C" },
  ],
};

const RESERVE_V1: ReserveDoc = { reserve_pct: 40, basis: "early-stage sleeve", reserve_usd: 7_000_000 };
const RESERVE_V2: ReserveDoc = { reserve_pct: 40, basis: "early-stage sleeve" };

describe("the mismatch this exists to prevent", () => {
  it("reproduces both sleeve divergences from the version that actually shipped", () => {
    const found = sleeveMismatches(V1);
    // Hard-fails on nothing to examine: an empty result here would make every assertion vacuous.
    expect(found.length, "no mismatch was detected in the document that definitely had two").toBe(2);

    const early = found.find((m) => m.key === "EARLY_STAGE_PRIMARY")!;
    expect(early.derivedUsd).toBe(16_800_000);
    expect(early.storedUsd).toBe(17_000_000);
    expect(early.differenceUsd).toBe(200_000);

    const secondary = found.find((m) => m.key === "SECONDARY_PURCHASE")!;
    expect(secondary.derivedUsd).toBeCloseTo(7_200_000, 6);
    expect(secondary.storedUsd).toBe(7_000_000);
    expect(secondary.differenceUsd).toBeCloseTo(200_000, 6);
  });

  it("finds the reserve's divergence too, which was larger and was not in the original report", () => {
    // 40% of the sleeve's DERIVED $16.8M is $6.72M, against a stored $7.0M.
    const m = reserveMismatch(V1, RESERVE_V1);
    expect(m, "the reserve mismatch was not detected").toBeTruthy();
    expect(m!.derivedUsd).toBeCloseTo(6_720_000, 6);
    expect(m!.storedUsd).toBe(7_000_000);
    expect(m!.differenceUsd).toBeCloseTo(280_000, 6);
  });

  it("reports NOTHING once the document stores the percentage alone", () => {
    expect(sleeveMismatches(V2)).toEqual([]);
    expect(reserveMismatch(V2, RESERVE_V2)).toBeNull();
  });

  it("cannot diverge after the base moves, which is the actual point", () => {
    /*
     * The reason storing the derived figure is wrong even when it currently agrees. Re-estimate
     * fees and v1's stored dollars are stale immediately; v2's simply follow.
     */
    const rebased: SleeveDoc = { ...V2, estimated_investable_usd: 22_000_000 };
    expect(sleeveTargetUsd(rebased, rebased.sleeves![0]!)).toBeCloseTo(15_400_000, 6);
    expect(sleeveMismatches(rebased)).toEqual([]);

    const staleV1: SleeveDoc = { ...V1, estimated_investable_usd: 22_000_000 };
    expect(sleeveMismatches(staleV1).length, "a stored dollar figure survived a base change intact").toBe(2);
  });
});

describe("the 70/30 split the operator decided", () => {
  it("splits the investable base exactly, with no remainder", () => {
    const base = investableBase(V2);
    expect(base).toBe(24_000_000);
    const total = (V2.sleeves ?? []).reduce((sum, s) => sum + sleeveTargetUsd(V2, s), 0);
    expect(total).toBeCloseTo(base, 6);
  });

  it("derives the base from its own inputs when the total is absent", () => {
    const { estimated_investable_usd: _omitted, ...withoutTotal } = V2;
    expect(investableBase(withoutTotal)).toBe(24_000_000);
  });

  it("states the consequence the operator was told before deciding", () => {
    /*
     * NOT COSMETIC, and this is the assertion that keeps it honest. At the old $17.0M the sleeve
     * left $10.2M for initial cheques; at the decided 70% it leaves $10.08M. Twenty positions at
     * the mandate's $500K minimum needs $10.0M, so the portfolio clears the bottom of its own range
     * by $80K instead of $200K.
     */
    expect(reserveUsd(V2, RESERVE_V2)).toBeCloseTo(6_720_000, 6);
    const forInitials = initialCapitalUsd(V2, RESERVE_V2);
    expect(forInitials).toBeCloseTo(10_080_000, 6);

    const twentyAtMinimum = 20 * 500_000;
    expect(forInitials - twentyAtMinimum).toBeCloseTo(80_000, 6);

    /*
     * And the OLD reading, computed the way the register used to compute it — off the STORED
     * dollars — so the movement is pinned rather than described. Note that `initialCapitalUsd`
     * deliberately no longer produces this number for v1: it prefers the percentage even on a
     * document that also carries dollars, which is the whole change. The old figure therefore has
     * to be derived here from the stored fields, and that is the point.
     */
    const storedSleeveUsd = V1.sleeves!.find((s) => s.key === "EARLY_STAGE_PRIMARY")!.target_usd!;
    const oldForInitials = storedSleeveUsd * (1 - RESERVE_V1.reserve_pct! / 100);
    expect(oldForInitials).toBeCloseTo(10_200_000, 6);
    expect(oldForInitials - twentyAtMinimum).toBeCloseTo(200_000, 6);

    // The tightening, stated as a number: $120K less to write cheques with.
    expect(oldForInitials - forInitials).toBeCloseTo(120_000, 6);
  });
});

describe("legacy documents still read correctly", () => {
  it("honours a stored dollar figure only where there is no percentage to derive from", () => {
    // Those are the rows where the dollar figure genuinely IS the decision.
    const legacy: SleeveDoc = {
      estimated_investable_usd: 24_000_000,
      sleeves: [{ key: "EARLY_STAGE_PRIMARY", target_usd: 17_000_000 }],
    };
    expect(sleeveTargetUsd(legacy, legacy.sleeves![0]!)).toBe(17_000_000);
    expect(sleeveMismatches(legacy), "a document with no percentage cannot disagree with itself").toEqual([]);
  });
});

describe("figures are said the same way everywhere", () => {
  it("prints millions without inventing precision", () => {
    expect(usd(16_800_000)).toBe("$16.8M");
    expect(usd(10_080_000)).toBe("$10.08M");
    expect(usd(17_000_000)).toBe("$17M");
    expect(usd(80_000)).toBe("$80K");
  });
});
