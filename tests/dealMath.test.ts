import { describe, expect, it } from "vitest";
import {
  computeCarry,
  computeFollowOn,
  computeFundModel,
  computePrimaryDeal,
  computeSecondaryStructure,
  fundReturnVerdict,
  premiumDiscount,
  safeDiv,
  xirr,
  xnpv,
  yearsBetweenDates,
  type SecondaryStructureGlobals,
} from "../src/shared/dealmath";

/**
 * P6 deal-math fixture suite (D6 + ADR-005). Every expectation below is a
 * HAND-WORKED value derived independently of the partner implementation — the
 * arithmetic for each fixture is shown in docs/DEAL_MATH_VERIFICATION.md.
 * Nothing here was copied from partner output; the partner code was read only
 * to know WHICH formulas to verify.
 */

const REL = 1e-9; // relative tolerance for exact-arithmetic fixtures
const IRR_TOL = 1e-6; // absolute tolerance for iterative-irr fixtures

function expectClose(actual: number, expected: number, rel = REL): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(Math.abs(expected) * rel, 1e-9));
}

// ── primitives ──

describe("yearsBetweenDates (act/365.25, clamped ≥ 0)", () => {
  it("365 calendar days = 365/365.25 years", () => {
    expectClose(yearsBetweenDates("2026-01-01", "2027-01-01"), 365 / 365.25);
  });
  it("731 days across a leap day = 731/365.25 years", () => {
    expectClose(yearsBetweenDates("2026-03-26", "2028-03-26"), 731 / 365.25);
  });
  it("reverse-ordered dates clamp to 0; nulls are 0", () => {
    expect(yearsBetweenDates("2027-01-01", "2026-01-01")).toBe(0);
    expect(yearsBetweenDates(null, "2026-01-01")).toBe(0);
    expect(yearsBetweenDates("not-a-date", "2026-01-01")).toBe(0);
  });
});

describe("safeDiv", () => {
  it("divides normally and returns 0 on a zero denominator", () => {
    expect(safeDiv(10, 4)).toBe(2.5);
    expect(safeDiv(10, 0)).toBe(0);
  });
});

// ── computeCarry ──

describe("computeCarry (hurdle = invested × pref × years, simple)", () => {
  // Worked set: invested 10,000, hold 2y, pref 8% → hurdle = 1,600; carry 20%.
  it("hard basis: no carry when profit is below the hurdle", () => {
    expect(computeCarry(1000, 10000, 2, 8, 20, "hard")).toBe(0);
  });
  it("hard basis: carry only on profit above the hurdle", () => {
    // (5000 − 1600) × 0.20 = 680
    expect(computeCarry(5000, 10000, 2, 8, 20, "hard")).toBe(680);
  });
  it("soft basis: full catch-up once profit exceeds the hurdle", () => {
    // 5000 > 1600 → 5000 × 0.20 = 1000
    expect(computeCarry(5000, 10000, 2, 8, 20, "soft")).toBe(1000);
  });
  it("soft basis: profit exactly at the hurdle earns nothing (strictly-greater rule)", () => {
    expect(computeCarry(1600, 10000, 2, 8, 20, "soft")).toBe(0);
  });
  it("none basis: carry on the full profit regardless of hurdle", () => {
    expect(computeCarry(5000, 10000, 2, 8, 20, "none")).toBe(1000);
    expect(computeCarry(1000, 10000, 2, 8, 20, "none")).toBe(200);
  });
  it("non-positive profit or zero carry rate earns nothing", () => {
    expect(computeCarry(-500, 10000, 2, 8, 20, "hard")).toBe(0);
    expect(computeCarry(0, 10000, 2, 8, 20, "none")).toBe(0);
    expect(computeCarry(5000, 10000, 2, 8, 0, "none")).toBe(0);
  });
});

// ── xnpv ──

describe("xnpv", () => {
  it("a flow dated at the base date is undiscounted at any rate", () => {
    expect(xnpv(0.5, [{ date: "2026-01-01", amount: -1000 }])).toBe(-1000);
    expect(xnpv(-0.2, [{ date: "2026-01-01", amount: -1000 }])).toBe(-1000);
  });
  it("rate 0 is the plain sum of amounts", () => {
    expect(
      xnpv(0, [
        { date: "2026-01-01", amount: -1000 },
        { date: "2027-06-30", amount: 500 },
        { date: "2028-01-01", amount: 700 },
      ]),
    ).toBe(200);
  });
  it("discounts by act/365.25 year fractions (365-day span at 10%)", () => {
    // −1000 + 1210 / 1.10^(365/365.25) = +100.07176222969406 (bisection-free closed form)
    const value = xnpv(0.1, [
      { date: "2026-01-01", amount: -1000 },
      { date: "2027-01-01", amount: 1210 },
    ]);
    expectClose(value, 100.07176222969406, 1e-12);
  });
  it("flows dated before the base date get exponent 0 (clamped)", () => {
    // base date is the FIRST element; the 2026-01-01 flow precedes it → undiscounted
    expect(
      xnpv(0.25, [
        { date: "2026-06-01", amount: 100 },
        { date: "2026-01-01", amount: 50 },
      ]),
    ).toBe(150);
  });
  it("empty series is NaN", () => {
    expect(Number.isNaN(xnpv(0.1, []))).toBe(true);
  });
});

// ── xirr ──

describe("xirr", () => {
  it("two-flow closed form: r = (out/in)^(365.25/days) − 1", () => {
    // −1000 @2026-01-01, +1210 @2027-01-01 → 1.21^(365.25/365) − 1 = 0.2101579902005981
    const r = xirr([
      { date: "2026-01-01", amount: -1000 },
      { date: "2027-01-01", amount: 1210 },
    ]);
    expect(r).not.toBeNull();
    expectClose(r!, 0.2101579902005981, IRR_TOL);
  });
  it("three-flow series matches an independent bisection root", () => {
    // −1000 @2026-01-01, +500 @2026-07-01, +700 @2027-01-01 → 0.26249965247425011
    // (200-step bisection, UTC-anchored dates — see src/shared/dealmath/index.ts toTime()).
    //
    // CONFIRMED 3 Sep 2026: this fixture passed on a CDT machine and missed by ~1.93e-5 on a
    // UTC CI runner. Jan → Jul → Jan crosses exactly one US DST transition; a date-only string
    // parsed without an explicit "Z" resolves to LOCAL midnight, so the year-fraction between
    // the Jul flow and the others shifted by an hour depending on where the code ran. Fixed at
    // the source (toTime anchors date-only strings to UTC); this constant is the bisection root
    // recomputed under that fix and is now timezone-invariant.
    const flows = [
      { date: "2026-01-01", amount: -1000 },
      { date: "2026-07-01", amount: 500 },
      { date: "2027-01-01", amount: 700 },
    ];
    const r = xirr(flows);
    expect(r).not.toBeNull();
    expectClose(r!, 0.26249965247425011, IRR_TOL);
    expect(Math.abs(xnpv(r!, flows))).toBeLessThan(1e-6);
  });
  it("sign-change requirement: all-positive, all-negative, and single-flow series return null", () => {
    expect(
      xirr([
        { date: "2026-01-01", amount: 100 },
        { date: "2027-01-01", amount: 100 },
      ]),
    ).toBeNull();
    expect(
      xirr([
        { date: "2026-01-01", amount: -100 },
        { date: "2027-01-01", amount: -50 },
      ]),
    ).toBeNull();
    expect(xirr([{ date: "2026-01-01", amount: -100 }])).toBeNull();
    expect(xirr([])).toBeNull();
  });
  it("zero-derivative / degenerate series exit cleanly as null (never hang)", () => {
    // both flows on the same date → NPV constant 1, derivative 0 → break → null
    const r = xirr([
      { date: "2026-01-01", amount: -1 },
      { date: "2026-01-01", amount: 2 },
    ]);
    expect(r).toBeNull();
  });
  it("an absurd initial guess still converges to the same root (or null, never a hang)", () => {
    const flows = [
      { date: "2026-01-01", amount: -1000 },
      { date: "2028-01-01", amount: 2000 },
    ];
    const a = xirr(flows, 0.2);
    const b = xirr(flows, 50);
    expect(a).not.toBeNull();
    expect(b === null || Math.abs(b - a!) < 1e-6).toBe(true);
  });
});

// ── premiumDiscount ──

describe("premiumDiscount", () => {
  it("discount: (8.50 vs 10.00) → −15%", () => {
    const r = premiumDiscount(10, 8.5);
    expectClose(r.pct, -15);
    expect(r.label).toBe("Discount");
  });
  it("premium: (11.00 vs 10.00) → +10%", () => {
    const r = premiumDiscount(10, 11);
    expectClose(r.pct, 10);
    expect(r.label).toBe("Premium");
  });
  it("at par within half a basis point", () => {
    expect(premiumDiscount(10, 10).label).toBe("At par");
    expect(premiumDiscount(10, 10.0004).label).toBe("At par");
  });
  it("no round price → pct 0 with an explicit label", () => {
    const r = premiumDiscount(0, 8.5);
    expect(r.pct).toBe(0);
    expect(r.label).toBe("No round price entered");
  });
});

// ── computeSecondaryStructure ──

const SECONDARY_GLOBALS: SecondaryStructureGlobals = {
  dealSize: 25_000_000,
  basePrice: 25_000_000,
  investedCapital: 25_000_000,
  grossExit: 43_750_000, // 25M × 1.75
  holdYears: 2,
  entryDate: "2026-03-26",
  exitDate: "2028-03-26",
  legalCost: 30_000,
  ongoingCost: 70_000, // (20k compliance + 15k audit/tax) × 2y SPV life
  allocations: {
    upfront: { investor: 1, sponsor: 0, client: 0 },
    mgmt: { investor: 1, sponsor: 0, client: 0 },
    carry: { investor: 1, sponsor: 0, client: 0 },
    legal: { investor: 1, sponsor: 0, client: 0 },
    ongoing: { investor: 1, sponsor: 0, client: 0 },
  },
  interimFlows: [
    { date: "2027-03-26", amount: 0 },
    { date: "2027-09-26", amount: 0 },
  ],
};

describe("computeSecondaryStructure", () => {
  it("Structure A: 0/0 fees + 20% carry over 8% pref (hard basis)", () => {
    // profit = 43.75M − 25M = 18.75M; hurdle = 25M × 8% × 2 = 4M;
    // carry = (18.75M − 4M) × 20% = 2,950,000
    const a = computeSecondaryStructure("A", 0, 0, 20, 8, "hard", SECONDARY_GLOBALS);
    expect(a.upfrontFee).toBe(0);
    expect(a.mgmtFees).toBe(0);
    expect(a.carry).toBe(2_950_000);
    expect(a.totalFees).toBe(3_050_000); // + 30k legal + 70k ongoing
    expect(a.netProceeds).toBe(40_700_000);
    expectClose(a.netMultiple, 1.628);
    expect(a.payerBurden).toEqual({ investor: 3_050_000, sponsor: 0, client: 0 });
    // investor dated flows: −(25M base + 3.05M burden) at entry, +40.7M at exit
    expect(a.datedFlows).toEqual([
      { date: "2026-03-26", amount: -28_050_000 },
      { date: "2028-03-26", amount: 40_700_000 },
    ]);
    // T = 731/365.25 → (40.7/28.05)^(1/T) − 1 = 0.20441313735061617
    expect(a.irr).not.toBeNull();
    expectClose(a.irr!, 0.20441313735061617, IRR_TOL);
    expect(Math.abs(xnpv(a.irr!, a.datedFlows))).toBeLessThan(1); // $1 on $28M flows
  });
  it("Structure B: 5% upfront, no carry", () => {
    const b = computeSecondaryStructure("B", 5, 0, 0, 0, "hard", SECONDARY_GLOBALS);
    expect(b.upfrontFee).toBe(1_250_000);
    expect(b.carry).toBe(0);
    expect(b.totalFees).toBe(1_350_000);
    expect(b.netProceeds).toBe(42_400_000);
    expectClose(b.netMultiple, 1.696);
    expectClose(b.irr!, 0.2682999254818399, IRR_TOL);
  });
  it("per-payer allocation splits the burden exactly", () => {
    const globals: SecondaryStructureGlobals = {
      ...SECONDARY_GLOBALS,
      allocations: {
        upfront: { investor: 0.5, sponsor: 0.5, client: 0 },
        mgmt: { investor: 1, sponsor: 0, client: 0 },
        carry: { investor: 0.75, sponsor: 0.25, client: 0 },
        legal: { investor: 0, sponsor: 1, client: 0 },
        ongoing: { investor: 0, sponsor: 0, client: 1 },
      },
    };
    const s = computeSecondaryStructure("Split", 5, 0, 20, 8, "hard", globals);
    // upfront 1.25M×0.5 = 625,000; carry 2.95M×0.75 = 2,212,500; legal 0; ongoing 0
    expect(s.payerBurden.investor).toBe(625_000 + 2_212_500);
    expect(s.payerBurden.sponsor).toBe(625_000 + 737_500 + 30_000);
    expect(s.payerBurden.client).toBe(70_000);
    expect(s.payerBurden.investor + s.payerBurden.sponsor + s.payerBurden.client).toBe(s.totalFees);
  });
});

// ── computePrimaryDeal ──

const PRIMARY_BASE = {
  instrument: "priced" as const,
  checkSize: 500_000,
  roundSize: 3_500_000,
  preMoney: 12_000_000,
  futureDilutionPct: 35,
  holdYears: 7,
  carryPct: 20,
  prefPct: 0,
  carryBasis: "none",
  liqPrefMultiple: 1,
  preferenceType: "non-participating" as const,
  fundSize: 25_000_000,
};

describe("computePrimaryDeal", () => {
  it("priced round waterfall at a $250M exit (cross-checked against the partner spec)", () => {
    // post = 15.5M; ownership = 500k/15.5M = 3.2258064516%; exit ownership = ×0.65 = 2.0967741935%;
    // gross common = 250M × 2.0967741935% = 5,241,935.48; non-participating → max(500k pref, common);
    // carry = (5,241,935.48 − 500k) × 20% = 948,387.10; net = 4,293,548.39; of fund = 0.17174 → "0.17x"
    const r = computePrimaryDeal({ ...PRIMARY_BASE, exitValue: 250_000_000 });
    expect(r.postMoney).toBe(15_500_000);
    expectClose(r.ownershipPct, 3.2258064516, 1e-6);
    expectClose(r.exitOwnershipPct, 2.0967741935, 1e-6);
    expectClose(r.grossProceeds, 5_241_935.483870968);
    expectClose(r.carry, 948_387.0967741936);
    expectClose(r.netProceeds, 4_293_548.387096775);
    expectClose(r.netMoic, 8.587096774193549);
    expectClose(r.annualizedPct, 35.958580771410475);
    expectClose(r.fundContribution, 0.17174193548387098);
    expect(r.fundVerdict).toBe("Not enough fund impact yet");
  });
  it("verdict bands track fund contribution (0.34x and 1.01x exits)", () => {
    const mid = computePrimaryDeal({ ...PRIMARY_BASE, exitValue: 500_000_000 });
    expectClose(mid.fundContribution, 0.33948387096774196);
    expect(mid.fundVerdict).toBe("Meaningful fund contributor");
    const big = computePrimaryDeal({ ...PRIMARY_BASE, exitValue: 1_500_000_000 });
    expectClose(big.fundContribution, 1.010451612903226);
    expect(big.fundVerdict).toBe("Fund-returning potential");
  });
  it("post-money SAFE: ownership = check ÷ cap", () => {
    const r = computePrimaryDeal({ ...PRIMARY_BASE, instrument: "post-money-safe", valuationCap: 12_000_000, exitValue: 250_000_000 });
    expect(r.effectiveValuation).toBe(12_000_000);
    expectClose(r.ownershipPct, (500_000 / 12_000_000) * 100);
  });
  it("convertible note: min(pre, cap, discounted pre) + simple-interest accrual", () => {
    // discountedPre = 12M × 0.8 = 9.6M < cap 12M = pre → effective 9.6M;
    // accrued = 500k × (1 + 6% × 1.5) = 545,000; post = 9.6M + 3.5M = 13.1M
    const r = computePrimaryDeal({
      ...PRIMARY_BASE,
      instrument: "convertible-note",
      valuationCap: 12_000_000,
      discountPct: 20,
      noteInterestPct: 6,
      nextRoundYears: 1.5,
      exitValue: 250_000_000,
    });
    expect(r.effectiveValuation).toBe(9_600_000);
    expect(r.convertedInvestment).toBe(545_000);
    expect(r.postMoney).toBe(13_100_000);
    expectClose(r.ownershipPct, (545_000 / 13_100_000) * 100);
  });
  it("participating preference stacks on top of common proceeds", () => {
    const r = computePrimaryDeal({ ...PRIMARY_BASE, preferenceType: "participating", exitValue: 250_000_000 });
    expectClose(r.grossProceeds, 500_000 + 5_241_935.483870968);
  });
  it("pro-rata need and conversion breakpoint (algebraic identity: breakpoint = post at 1x pref)", () => {
    const r = computePrimaryDeal({ ...PRIMARY_BASE, exitValue: 250_000_000 });
    // next round = max(3.5M × 2.5, 5M) = 8.75M; need = 8.75M × 3.2258064516% = 282,258.06
    expectClose(r.proRataNeed, 282_258.064516, 1e-6);
    // breakpoint = preference ÷ ownership fraction = 500k / 0.032258064516 = 15.5M = post-money
    expectClose(r.conversionBreakpoint, 15_500_000);
  });
});

// ── fundReturnVerdict bands ──

describe("fundReturnVerdict", () => {
  it("band boundaries: ≥1 fund-returning, ≥0.25 meaningful, else not enough", () => {
    expect(fundReturnVerdict(1)).toBe("Fund-returning potential");
    expect(fundReturnVerdict(0.999)).toBe("Meaningful fund contributor");
    expect(fundReturnVerdict(0.25)).toBe("Meaningful fund contributor");
    expect(fundReturnVerdict(0.249)).toBe("Not enough fund impact yet");
  });
});

// ── computeFollowOn ──

const FOLLOW_ON_BASE = {
  currentOwnershipPct: 8,
  currentFullyDilutedShares: 10_000_000,
  roundSize: 20_000_000,
  primaryPps: 10,
  secondaryPps: 8.5,
  secondaryCapital: 2_800_000,
  secondaryFeesPct: 1,
  targetOwnershipPct: 10,
  maxAllocation: 4_000_000,
  extraDilutionPct: 0,
  futureDilutionPct: 30,
  exitValue: 1_000_000_000,
  holdYears: 5,
  existingCost: 1_000_000,
  fundSize: 25_000_000,
};

describe("computeFollowOn", () => {
  it("share-count math drives pro-rata and super-pro-rata requirements", () => {
    // new shares = 20M ÷ 10 = 2M; postFD = 12M; existing = 8% × 10M = 800k
    // pro rata = 8% × 2M × $10 = $1,600,000 (matches the partner's own e2e expectation)
    // super: 10% × 12M − 800k = 400k shares → $4,000,000
    const r = computeFollowOn(FOLLOW_ON_BASE);
    expect(r.primaryNewShares).toBe(2_000_000);
    expect(r.postFullyDilutedShares).toBe(12_000_000);
    expect(r.existingShares).toBe(800_000);
    expect(r.impliedPreMoney).toBe(100_000_000);
    expect(r.proRataRequired).toBe(1_600_000);
    expect(r.proRataCheck).toBe(1_600_000);
    expect(r.proRataShortfall).toBe(0);
    expect(r.superSharesRequired).toBe(400_000);
    expect(r.superRequired).toBe(4_000_000);
    expectClose(r.secondaryCost, 2_828_000);
    expectClose(r.secondarySpreadPct, -15);
  });
  it("scenario ownership and incremental economics (skip / pro rata / super / secondary)", () => {
    const r = computeFollowOn(FOLLOW_ON_BASE);
    const [skip, pro, sup, sec] = r.scenarios;
    // skip: 800k/12M = 6.66667%; proceeds = 6.66667% × 0.7 × 1B = 46,666,666.67
    expectClose(skip!.ownershipPct, 6.6666666667, 1e-6);
    expectClose(skip!.proceeds, 46_666_666.6667, 1e-6);
    expect(skip!.capital).toBe(0);
    // pro rata: (800k + 160k)/12M = 8.00%; proceeds 56M; incremental 9,333,333.33;
    // incMoic = 9,333,333.33/1.6M = 5.8333; incIrr = 5.8333^(1/5) − 1 = 42.2929%
    expectClose(pro!.ownershipPct, 8, 1e-6);
    expectClose(pro!.incrementalProceeds, 9_333_333.3333, 1e-6);
    expectClose(pro!.incrementalMoic, 5.8333333333, 1e-6);
    expectClose(pro!.incrementalIrrPct, 42.29294200177147, 1e-6);
    expectClose(pro!.totalMoic, 56_000_000 / 2_600_000);
    expectClose(pro!.concentrationPct, 10.4);
    // super pro rata hits the 10% target exactly (algebraic identity)
    expectClose(sup!.ownershipPct, 10, 1e-6);
    // secondary: (800k + 2.8M/8.5)/12M = 9.41176%; cost 2.828M; incIrr 46.7018%
    expectClose(sec!.ownershipPct, 9.4117647059, 1e-6);
    expectClose(sec!.incrementalIrrPct, 46.70175146474047, 1e-6);
    expectClose(sec!.concentrationPct, 15.312);
  });
  it("a capped allocation produces the exact shortfall and marks the path inexecutable", () => {
    // cap 1M → pro-rata check 1M, shortfall 600k (matches the partner's e2e expectation)
    const r = computeFollowOn({ ...FOLLOW_ON_BASE, maxAllocation: 1_000_000 });
    expect(r.proRataCheck).toBe(1_000_000);
    expect(r.proRataShortfall).toBe(600_000);
    expect(r.scenarios.find((s) => s.key === "pro_rata")!.executable).toBe(false);
    expect(r.scenarios.find((s) => s.key === "skip")!.executable).toBe(true);
  });
});

// ── computeFundModel ──

describe("computeFundModel", () => {
  const r = computeFundModel({
    fundSize: 25_000_000,
    mgmtFeePct: 2,
    feeYears: 10,
    expensePct: 1,
    deployYears: 3,
    avgFollowRound: 12_000_000,
    grossTvpi: 3.5,
    netTvpi: 3,
    targetDpi: 1,
    stages: [
      { key: "PreSeed", allocPct: 25, check: 250_000, ownershipPct: 5, reserveMultiple: 1.5, graduationPct: 45 },
      { key: "Seed", allocPct: 55, check: 750_000, ownershipPct: 7, reserveMultiple: 1, graduationPct: 55 },
      { key: "SeriesA", allocPct: 20, check: 1_500_000, ownershipPct: 6, reserveMultiple: 0.5, graduationPct: 65 },
    ],
  });

  it("capital budget: fees, expenses, investable", () => {
    // fees = 25M × 2% × 10 = 5M; expenses = 250k; investable = 19.75M
    expect(r.fees).toBe(5_000_000);
    expect(r.expenses).toBe(250_000);
    expect(r.investable).toBe(19_750_000);
  });
  it("stage buckets: floor(bucket ÷ fully-loaded check) companies each", () => {
    // PreSeed: bucket 4,937,500; loaded 625k → floor(7.9) = 7
    // Seed:    bucket 10,862,500; loaded 1.5M → floor(7.2417) = 7
    // SeriesA: bucket 3,950,000;  loaded 2.25M → floor(1.7556) = 1
    expect(r.stages.map((s) => s.companies)).toEqual([7, 7, 1]);
    expect(r.totalCompanies).toBe(15);
    expect(r.initialCapital).toBe(8_500_000);
    expect(r.reserveCapital).toBe(8_625_000);
  });
  it("modeled reserve need sums graduated × avg follow-on round × ownership", () => {
    // 3.15×12M×5% + 3.85×12M×7% + 0.65×12M×6% = 1,890,000 + 3,234,000 + 468,000 = 5,592,000
    expect(r.modeledReserveNeed).toBe(5_592_000);
    expectClose(r.expectedFollowOnCompanies, 7.65);
    expectClose(r.reserveCoveragePct, (8_625_000 / 5_592_000) * 100);
    expectClose(r.reserveRatio, 8_625_000 / 8_500_000);
  });
  it("return requirements: TVPI/DPI targets, winner exit, pace, allocation", () => {
    expect(r.grossValueNeeded).toBe(87_500_000);
    expect(r.netValueNeeded).toBe(75_000_000);
    expect(r.dpiCashNeeded).toBe(25_000_000);
    expectClose(r.moicOnInvestable, 87_500_000 / 19_750_000);
    // winner ownership = max stage ownership × 0.65 = 7 × 0.65 = 4.55%
    expectClose(r.winnerOwnershipPct, 4.55);
    expectClose(r.winnerExit, 87_500_000 / 0.0455);
    // avg ownership = (7×5 + 7×7 + 1×6) / 15 = 6.0%
    expectClose(r.avgOwnershipPct, 6);
    expect(r.dealsPerYear).toBe(5);
    expect(r.unallocated).toBe(19_750_000 - 8_500_000 - 8_625_000);
    expect(r.totalAllocPct).toBe(100);
  });
});
