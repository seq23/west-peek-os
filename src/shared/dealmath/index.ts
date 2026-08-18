/**
 * Deal math (P6, D6 + ADR-005) — pure calculation functions ported from the
 * read-only integration partner `seq23/secondaries` (app.js). NO DOM, no storage,
 * no network. Every function here is INDEPENDENTLY hand-verified in
 * docs/DEAL_MATH_VERIFICATION.md with worked examples encoded as fixtures in
 * tests/dealMath.test.ts. Anything not independently verified is NOT here — it
 * stays manual-entry only.
 *
 * Source-to-port map (partner app.js line numbers).
 *
 * RE-VERIFIED 18 Aug 2026 against partner commit a350ad6 ("chore: add repo agent bootstrap",
 * 8 Aug 2026), deployed at venturedeals.joinwestpeek.com. Every mapped line number below still
 * lands on the same function, and the primitives were compared body-for-body: computeCarry, xnpv,
 * xirr and premiumDiscount are unchanged. The one deviation noted at the bottom of this comment is
 * still the only difference. The commit is recorded because the original port said "partner commit
 * unknown", which made drift undetectable — a future check starts by diffing against a350ad6.
 *   yearsBetween (L185-188)            → yearsBetweenDates
 *   safeDiv (L194)                     → safeDiv
 *   computeCarry (L296-302)            → computeCarry
 *   xnpv (L303-307)                    → xnpv
 *   xirr (L308-323)                    → xirr (one deliberate deviation, see below)
 *   premiumDiscount (L330-335)         → premiumDiscount
 *   computeSecondaryStructure (L348-367) → computeSecondaryStructure
 *   recalculatePrimary economics (L440-555, scoring excluded)
 *                                      → computePrimaryDeal + fundReturnVerdict
 *   recalculateFollowOn economics (L558-674, scoring/recommendation excluded)
 *                                      → computeFollowOnScenarios
 *   recalculateFund economics (L676-784, scoring excluded)
 *                                      → computeFundModel
 *
 * Deliberate deviation (documented in DEAL_MATH_VERIFICATION.md §xirr):
 * the partner's xirr returns the last finite Newton iterate even when it never
 * converged within tolerance. This port returns null unless the iteration
 * actually converged (|Δrate| < 1e-7 within 100 iterations) — an unconverged
 * rate is not a verified number and must not surface as one. Sign-change
 * requirement, iteration cap, and non-finite guards are unchanged (no hangs).
 */

// ── Primitives ──

/** Division that never throws/NaNs on a zero denominator (partner L194). */
export function safeDiv(a: number, b: number): number {
  return b ? a / b : 0;
}

export const DAYS_PER_YEAR = 365.25;

function toTime(date: Date | string): number | null {
  const d = typeof date === "string" ? new Date(`${date}T00:00:00`) : date;
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Whole-fractional years between two dates, actual-days/365.25, clamped ≥ 0
 * (partner yearsBetween, L185-188). A flow dated BEFORE the first flow gets
 * exponent 0 (documented partner behavior).
 */
export function yearsBetweenDates(a: Date | string | null, b: Date | string | null): number {
  if (!a || !b) return 0;
  const ta = toTime(a);
  const tb = toTime(b);
  if (ta === null || tb === null) return 0;
  return Math.max((tb - ta) / (DAYS_PER_YEAR * 24 * 3600 * 1000), 0);
}

// ── Carry ──

export type CarryBasis = "none" | "soft" | "hard";

/**
 * Carried interest (partner computeCarry, L296-302).
 * hurdle = investedCapital × (prefPct/100) × holdYears  (simple, NOT compounded).
 * - basis 'none': carry on full profit.
 * - basis 'soft': full catch-up — carry on the entire profit once profit > hurdle.
 * - basis 'hard' (default): carry only on profit above the hurdle.
 */
export function computeCarry(
  profit: number,
  investedCapital: number,
  holdYears: number,
  prefPct: number,
  carryPct: number,
  basis: CarryBasis | string,
): number {
  const hurdleProfit = investedCapital * (prefPct / 100) * holdYears;
  if (profit <= 0 || carryPct <= 0) return 0;
  if (basis === "none") return (profit * carryPct) / 100;
  if (basis === "soft") return profit > hurdleProfit ? (profit * carryPct) / 100 : 0;
  return (Math.max(profit - hurdleProfit, 0) * carryPct) / 100;
}

// ── Dated cash flows: XNPV / XIRR ──

export interface DatedCashFlow {
  date: Date | string;
  amount: number;
}

/** XNPV over actual-day/365.25 year fractions from the FIRST flow's date (partner L303-307). */
export function xnpv(rate: number, cashflows: DatedCashFlow[]): number {
  const firstDate = cashflows[0]?.date;
  if (!firstDate) return NaN;
  return cashflows.reduce(
    (acc, cf) => acc + cf.amount / Math.pow(1 + rate, yearsBetweenDates(firstDate, cf.date)),
    0,
  );
}

export const XIRR_TOLERANCE = 1e-7;
export const XIRR_MAX_ITERATIONS = 100;

/**
 * XIRR by Newton's method on XNPV (partner L308-323), with the deviation noted in
 * the module header: null unless convergence is actually reached. Guards:
 * - requires ≥2 flows with at least one positive and one negative amount
 *   (no sign change → no meaningful rate → null),
 * - 100-iteration cap and non-finite/zero-derivative break (never hangs),
 * - non-converged or non-finite result → null (NOT the last iterate).
 */
export function xirr(cashflows: DatedCashFlow[], guess = 0.2): number | null {
  if (cashflows.length < 2 || !cashflows.some((cf) => cf.amount > 0) || !cashflows.some((cf) => cf.amount < 0)) {
    return null;
  }
  let rate = guess;
  for (let i = 0; i < XIRR_MAX_ITERATIONS; i += 1) {
    const npv = xnpv(rate, cashflows);
    const derivative = cashflows.reduce((acc, cf) => {
      const years = yearsBetweenDates(cashflows[0]!.date, cf.date);
      return acc - (years * cf.amount) / Math.pow(1 + rate, years + 1);
    }, 0);
    if (!Number.isFinite(npv) || !Number.isFinite(derivative) || derivative === 0) break;
    const newRate = rate - npv / derivative;
    if (Math.abs(newRate - rate) < XIRR_TOLERANCE) return newRate;
    rate = newRate;
  }
  return null; // deviation: partner returned a possibly-unconverged finite rate
}

// ── Secondary pricing vs last round ──

export interface PremiumDiscountResult {
  pct: number;
  label: string;
}

/**
 * Premium/discount of a secondary price vs the last round price
 * (partner premiumDiscount, L330-335). pct = (secondary − round)/round × 100.
 */
export function premiumDiscount(roundPrice: number, secondaryPrice: number): PremiumDiscountResult {
  if (!roundPrice) return { pct: 0, label: "No round price entered" };
  const pct = ((secondaryPrice - roundPrice) / roundPrice) * 100;
  if (Math.abs(pct) < 0.005) return { pct, label: "At par" };
  return { pct, label: pct > 0 ? "Premium" : "Discount" };
}

// ── Secondary SPV structure economics ──

export interface SecondaryPayerAllocation {
  investor: number; // fractions 0..1
  sponsor: number;
  client: number;
}

export interface SecondaryStructureGlobals {
  dealSize: number;
  basePrice: number;
  investedCapital: number;
  grossExit: number;
  holdYears: number;
  entryDate: Date | string | null;
  exitDate: Date | string | null;
  legalCost: number;
  ongoingCost: number;
  allocations: {
    upfront: SecondaryPayerAllocation;
    mgmt: SecondaryPayerAllocation;
    carry: SecondaryPayerAllocation;
    legal: SecondaryPayerAllocation;
    ongoing: SecondaryPayerAllocation;
  };
  interimFlows: Array<{ date: Date | string | null; amount: number }>;
}

export interface SecondaryStructureResult {
  label: string;
  upfrontFee: number;
  mgmtFees: number;
  carry: number;
  totalFees: number;
  netProceeds: number;
  netMultiple: number;
  payerBurden: { investor: number; sponsor: number; client: number };
  datedFlows: Array<{ date: Date | string; amount: number }>;
  irr: number | null;
}

/**
 * Full economics of one secondary SPV fee structure (partner computeSecondaryStructure,
 * L348-367): fees, carry, net proceeds/multiple to the investor, per-payer burden,
 * and the dated cash-flow series (+ its XIRR) the investor actually experiences.
 */
export function computeSecondaryStructure(
  label: string,
  upfrontPct: number,
  mgmtPct: number,
  carryPct: number,
  prefPct: number,
  basis: CarryBasis | string,
  globals: SecondaryStructureGlobals,
): SecondaryStructureResult {
  const upfrontFee = globals.dealSize * (upfrontPct / 100);
  const mgmtFees = globals.investedCapital * (mgmtPct / 100) * globals.holdYears;
  const profit = globals.grossExit - globals.investedCapital;
  const carry = computeCarry(profit, globals.investedCapital, globals.holdYears, prefPct, carryPct, basis);
  const totalFees = upfrontFee + mgmtFees + carry + globals.legalCost + globals.ongoingCost;
  const netProceeds = globals.grossExit - totalFees;
  const netMultiple = safeDiv(netProceeds, globals.investedCapital);
  const payerBurden = {
    investor:
      upfrontFee * globals.allocations.upfront.investor +
      mgmtFees * globals.allocations.mgmt.investor +
      carry * globals.allocations.carry.investor +
      globals.legalCost * globals.allocations.legal.investor +
      globals.ongoingCost * globals.allocations.ongoing.investor,
    sponsor:
      upfrontFee * globals.allocations.upfront.sponsor +
      mgmtFees * globals.allocations.mgmt.sponsor +
      carry * globals.allocations.carry.sponsor +
      globals.legalCost * globals.allocations.legal.sponsor +
      globals.ongoingCost * globals.allocations.ongoing.sponsor,
    client:
      upfrontFee * globals.allocations.upfront.client +
      mgmtFees * globals.allocations.mgmt.client +
      carry * globals.allocations.carry.client +
      globals.legalCost * globals.allocations.legal.client +
      globals.ongoingCost * globals.allocations.ongoing.client,
  };
  const datedFlows: Array<{ date: Date | string; amount: number }> = [];
  if (globals.entryDate) datedFlows.push({ date: globals.entryDate, amount: -(globals.basePrice + payerBurden.investor) });
  globals.interimFlows.forEach((cf) => {
    if (cf.date && Number(cf.amount)) datedFlows.push({ date: cf.date, amount: Number(cf.amount) });
  });
  if (globals.exitDate) datedFlows.push({ date: globals.exitDate, amount: netProceeds });
  datedFlows.sort((a, b) => (toTime(a.date) ?? 0) - (toTime(b.date) ?? 0));
  return { label, upfrontFee, mgmtFees, carry, totalFees, netProceeds, netMultiple, payerBurden, datedFlows, irr: xirr(datedFlows) };
}

// ── Primary deal economics ──

export type PrimaryInstrument = "priced" | "post-money-safe" | "convertible-note";
export type PreferenceType = "non-participating" | "participating";

export interface PrimaryDealInput {
  instrument: PrimaryInstrument;
  checkSize: number;
  roundSize: number;
  preMoney: number;
  valuationCap?: number;
  discountPct?: number;
  noteInterestPct?: number;
  nextRoundYears?: number;
  futureDilutionPct: number;
  exitValue: number;
  holdYears: number;
  upfrontFeePct?: number;
  mgmtFeePct?: number;
  carryPct?: number;
  prefPct?: number;
  carryBasis?: CarryBasis | string;
  liqPrefMultiple?: number;
  preferenceType?: PreferenceType;
  fundSize: number;
  nextRoundSize?: number;
}

export interface PrimaryDealResult {
  postMoney: number;
  effectiveValuation: number;
  ownershipPct: number;
  roundDilutionPct: number;
  convertedInvestment: number;
  exitOwnershipPct: number;
  grossProceeds: number;
  upfrontFee: number;
  mgmtFees: number;
  carry: number;
  netProceeds: number;
  netMoic: number;
  annualizedPct: number;
  fundContribution: number;
  fundVerdict: string;
  proRataNeed: number;
  conversionBreakpoint: number;
}

/** Fund-return verdict bands (partner fundReturnVerdict, L201-206). */
export function fundReturnVerdict(fundContribution: number): string {
  if (fundContribution >= 1) return "Fund-returning potential";
  if (fundContribution >= 0.25) return "Meaningful fund contributor";
  return "Not enough fund impact yet";
}

/**
 * Primary-deal economics (partner recalculatePrimary, L440-555 — the pure math only;
 * the partner's 100-point scoring heuristic is a judgment aid and is NOT ported,
 * see DEAL_MATH_VERIFICATION.md §UNVERIFIED).
 *
 * Ownership basis by instrument:
 * - priced:            check ÷ (pre + round)
 * - post-money SAFE:   check ÷ cap
 * - convertible note:  accrued check ÷ (min(pre, cap, discountedPre) + round),
 *                      accrued = check × (1 + noteInterestPct/100 × nextRoundYears) (simple interest)
 */
export function computePrimaryDeal(input: PrimaryDealInput): PrimaryDealResult {
  const check = input.checkSize;
  const round = input.roundSize;
  const pre = input.preMoney;
  const cap = input.valuationCap || pre;
  const discountPct = input.discountPct ?? 0;
  const noteInterestPct = input.noteInterestPct ?? 0;
  const nextRoundYears = input.nextRoundYears ?? 0;

  let post = pre + round;
  let ownership = safeDiv(check, post) * 100;
  let roundDilution = safeDiv(round, post) * 100;
  let effectiveValuation = pre;
  let convertedInvestment = check;

  if (input.instrument === "post-money-safe") {
    post = cap || post;
    effectiveValuation = post;
    ownership = safeDiv(check, post) * 100;
    roundDilution = safeDiv(round, post) * 100;
  } else if (input.instrument === "convertible-note") {
    const discountedPre = pre * Math.max(0, 1 - discountPct / 100);
    const candidates = [pre, cap, discountedPre].filter((value) => value > 0);
    effectiveValuation = candidates.length ? Math.min(...candidates) : pre;
    convertedInvestment = check * (1 + (noteInterestPct / 100) * nextRoundYears);
    post = effectiveValuation + round;
    ownership = safeDiv(convertedInvestment, post) * 100;
    roundDilution = safeDiv(round, post) * 100;
  }

  const holdYears = input.holdYears;
  const exitOwnership = ownership * (1 - input.futureDilutionPct / 100);
  const grossProceedsCommon = (input.exitValue * exitOwnership) / 100;
  const preference = check * (input.liqPrefMultiple ?? 1);
  const grossProceeds =
    input.preferenceType === "participating" ? preference + grossProceedsCommon : Math.max(preference, grossProceedsCommon);
  const upfrontFee = (check * (input.upfrontFeePct ?? 0)) / 100;
  const mgmtFees = ((check * (input.mgmtFeePct ?? 0)) / 100) * holdYears;
  const carry = computeCarry(
    grossProceeds - check,
    check,
    holdYears,
    input.prefPct ?? 0,
    input.carryPct ?? 0,
    input.carryBasis ?? "none",
  );
  const netProceeds = Math.max(grossProceeds - upfrontFee - mgmtFees - carry, 0);
  const netMoic = safeDiv(netProceeds, check + upfrontFee + mgmtFees);
  const annualized = holdYears > 0 && netMoic > 0 ? (Math.pow(netMoic, 1 / holdYears) - 1) * 100 : 0;
  const fundContribution = safeDiv(netProceeds, input.fundSize);
  const nextRoundSize = input.nextRoundSize ?? Math.max(round * 2.5, 5000000);
  const proRataNeed = (nextRoundSize * ownership) / 100;
  const conversionBreakpoint = ownership > 0 ? preference / (ownership / 100) : 0;

  return {
    postMoney: post,
    effectiveValuation,
    ownershipPct: ownership,
    roundDilutionPct: roundDilution,
    convertedInvestment,
    exitOwnershipPct: exitOwnership,
    grossProceeds,
    upfrontFee,
    mgmtFees,
    carry,
    netProceeds,
    netMoic,
    annualizedPct: annualized,
    fundContribution,
    fundVerdict: fundReturnVerdict(fundContribution),
    proRataNeed,
    conversionBreakpoint,
  };
}

// ── Follow-on scenario economics ──

export interface FollowOnInput {
  currentOwnershipPct: number;
  currentFullyDilutedShares: number;
  roundSize: number;
  primaryPps: number;
  secondaryPps: number;
  secondaryCapital: number;
  secondaryFeesPct: number;
  targetOwnershipPct: number;
  maxAllocation: number; // 0 = uncapped
  extraDilutionPct: number;
  futureDilutionPct: number;
  exitValue: number;
  holdYears: number;
  existingCost: number;
  fundSize: number;
}

export interface FollowOnScenario {
  key: "skip" | "pro_rata" | "super_pro_rata" | "secondary";
  capital: number;
  ownershipPct: number; // fraction ×100, post-round pre-exit
  exitOwnershipPct: number;
  proceeds: number;
  incrementalProceeds: number;
  incrementalMoic: number;
  incrementalIrrPct: number;
  totalMoic: number;
  concentrationPct: number;
  executable: boolean;
}

export interface FollowOnResult {
  primaryNewShares: number;
  postFullyDilutedShares: number;
  existingShares: number;
  impliedPreMoney: number;
  proRataRequired: number;
  proRataCheck: number;
  proRataShortfall: number;
  superSharesRequired: number;
  superRequired: number;
  superCheck: number;
  superShortfall: number;
  secondaryCost: number;
  secondarySpreadPct: number;
  scenarios: FollowOnScenario[];
}

/**
 * Follow-on path economics (partner recalculateFollowOn, L558-674 — pure math only;
 * the partner's scenario-scoring/recommendation heuristic is a judgment aid and is
 * NOT ported). Share-count math controls ownership: post-money FD shares =
 * current FD + round/primaryPps; ownership = (existing + new shares)/postFD,
 * scaled by extra dilution; exit ownership scaled by future dilution.
 */
export function computeFollowOn(input: FollowOnInput): FollowOnResult {
  const currentOwn = input.currentOwnershipPct / 100;
  const fd = input.currentFullyDilutedShares;
  const primaryPps = input.primaryPps;
  const extraFactor = Math.max(1 - input.extraDilutionPct / 100, 0);
  const futureFactor = Math.max(1 - input.futureDilutionPct / 100, 0);
  const years = Math.max(input.holdYears, 0.01);

  const primaryNewShares = primaryPps > 0 ? input.roundSize / primaryPps : 0;
  const postFd = fd + primaryNewShares;
  const existingShares = fd * currentOwn;
  const impliedPreMoney = fd * primaryPps;

  const proRataRequired = currentOwn * primaryNewShares * primaryPps;
  const proRataCheck = input.maxAllocation > 0 ? Math.min(proRataRequired, input.maxAllocation) : proRataRequired;
  const proRataShortfall = Math.max(proRataRequired - proRataCheck, 0);
  const superSharesRequired = Math.max((input.targetOwnershipPct / 100) * postFd - existingShares, 0);
  const superRequired = superSharesRequired * primaryPps;
  const superCheck = input.maxAllocation > 0 ? Math.min(superRequired, input.maxAllocation) : superRequired;
  const superShortfall = Math.max(superRequired - superCheck, 0);

  const primaryOwnership = (check: number): number => {
    if (primaryPps <= 0 || postFd <= 0) return 0;
    return ((existingShares + check / primaryPps) / postFd) * extraFactor;
  };

  const skipOwn = postFd > 0 ? (existingShares / postFd) * extraFactor : 0;
  const secondaryShares = input.secondaryPps > 0 ? input.secondaryCapital / input.secondaryPps : 0;
  const secondaryOwn = postFd > 0 ? ((existingShares + secondaryShares) / postFd) * extraFactor : skipOwn;
  const secondaryCost = input.secondaryCapital * (1 + input.secondaryFeesPct / 100);

  const skipProceeds = skipOwn * futureFactor * input.exitValue;

  const build = (
    key: FollowOnScenario["key"],
    capital: number,
    own: number,
    executable: boolean,
  ): FollowOnScenario => {
    const exitOwn = own * futureFactor;
    const proceeds = exitOwn * input.exitValue;
    const incrementalProceeds = Math.max(proceeds - skipProceeds, 0);
    const incMoic = capital > 0 ? incrementalProceeds / capital : 0;
    const incIrr = capital > 0 && incMoic > 0 ? (Math.pow(incMoic, 1 / years) - 1) * 100 : 0;
    const totalMoic = input.existingCost + capital > 0 ? proceeds / (input.existingCost + capital) : 0;
    const concentration = input.fundSize > 0 ? ((input.existingCost + capital) / input.fundSize) * 100 : 0;
    return {
      key,
      capital,
      ownershipPct: own * 100,
      exitOwnershipPct: exitOwn * 100,
      proceeds,
      incrementalProceeds,
      incrementalMoic: incMoic,
      incrementalIrrPct: incIrr,
      totalMoic,
      concentrationPct: concentration,
      executable,
    };
  };

  return {
    primaryNewShares,
    postFullyDilutedShares: postFd,
    existingShares,
    impliedPreMoney,
    proRataRequired,
    proRataCheck,
    proRataShortfall,
    superSharesRequired,
    superRequired,
    superCheck,
    superShortfall,
    secondaryCost,
    secondarySpreadPct: primaryPps > 0 ? (input.secondaryPps / primaryPps - 1) * 100 : 0,
    scenarios: [
      build("skip", 0, skipOwn, true),
      build("pro_rata", proRataCheck, primaryOwnership(proRataCheck), proRataShortfall <= 0.01),
      build("super_pro_rata", superCheck, primaryOwnership(superCheck), superShortfall <= 0.01),
      build("secondary", secondaryCost, secondaryOwn, input.secondaryPps > 0 && input.secondaryCapital > 0),
    ],
  };
}

// ── Fund model economics ──

export interface FundStageInput {
  key: string;
  allocPct: number;
  check: number;
  ownershipPct: number;
  reserveMultiple: number;
  graduationPct: number;
}

export interface FundModelInput {
  fundSize: number;
  mgmtFeePct: number;
  feeYears: number;
  expensePct: number;
  deployYears: number;
  avgFollowRound: number;
  grossTvpi: number;
  netTvpi: number;
  targetDpi: number;
  stages: FundStageInput[];
}

export interface FundStageResult {
  key: string;
  bucket: number;
  fullyLoadedCheck: number;
  companies: number;
  initialCapital: number;
  reserveCapital: number;
  graduatedCompanies: number;
  modeledReserveNeed: number;
}

export interface FundModelResult {
  fees: number;
  expenses: number;
  investable: number;
  stages: FundStageResult[];
  totalCompanies: number;
  initialCapital: number;
  reserveCapital: number;
  modeledReserveNeed: number;
  expectedFollowOnCompanies: number;
  avgOwnershipPct: number;
  dealsPerYear: number;
  grossValueNeeded: number;
  netValueNeeded: number;
  dpiCashNeeded: number;
  moicOnInvestable: number;
  winnerOwnershipPct: number;
  winnerExit: number;
  reserveRatio: number;
  reserveCoveragePct: number;
  unallocated: number;
  totalAllocPct: number;
}

/**
 * Fund-construction economics (partner recalculateFund, L676-784 — pure math only;
 * the partner's scoring heuristic is NOT ported). Investable = size − fees − expenses;
 * per stage, companies = floor(bucket ÷ fully-loaded check); modeled reserve need
 * sums graduated companies × avg follow-on round × stage ownership.
 */
export function computeFundModel(input: FundModelInput): FundModelResult {
  const fees = (input.fundSize * input.mgmtFeePct) / 100 * input.feeYears;
  const expenses = (input.fundSize * input.expensePct) / 100;
  const investable = Math.max(input.fundSize - fees - expenses, 0);

  let totalCompanies = 0;
  let initialCapital = 0;
  let reserveCapital = 0;
  let modeledReserveNeed = 0;
  let expectedFollowOnCompanies = 0;
  let weightedOwnership = 0;
  let winnerOwnership = 0;

  const stages: FundStageResult[] = input.stages.map((s) => {
    const bucket = (investable * s.allocPct) / 100;
    const fullyLoadedCheck = s.check * (1 + s.reserveMultiple);
    const companies = fullyLoadedCheck > 0 ? Math.floor(bucket / fullyLoadedCheck) : 0;
    const initial = companies * s.check;
    const reserve = companies * s.check * s.reserveMultiple;
    const graduated = (companies * s.graduationPct) / 100;
    const need = (graduated * input.avgFollowRound * s.ownershipPct) / 100;
    totalCompanies += companies;
    initialCapital += initial;
    reserveCapital += reserve;
    modeledReserveNeed += need;
    expectedFollowOnCompanies += graduated;
    weightedOwnership += companies * s.ownershipPct;
    winnerOwnership = Math.max(winnerOwnership, s.ownershipPct * 0.65);
    return {
      key: s.key,
      bucket,
      fullyLoadedCheck,
      companies,
      initialCapital: initial,
      reserveCapital: reserve,
      graduatedCompanies: graduated,
      modeledReserveNeed: need,
    };
  });

  const grossValueNeeded = input.fundSize * input.grossTvpi;
  return {
    fees,
    expenses,
    investable,
    stages,
    totalCompanies,
    initialCapital,
    reserveCapital,
    modeledReserveNeed,
    expectedFollowOnCompanies,
    avgOwnershipPct: safeDiv(weightedOwnership, totalCompanies),
    dealsPerYear: safeDiv(totalCompanies, input.deployYears),
    grossValueNeeded,
    netValueNeeded: input.fundSize * input.netTvpi,
    dpiCashNeeded: input.fundSize * input.targetDpi,
    moicOnInvestable: safeDiv(grossValueNeeded, investable),
    winnerOwnershipPct: winnerOwnership,
    winnerExit: winnerOwnership > 0 ? grossValueNeeded / (winnerOwnership / 100) : 0,
    reserveRatio: safeDiv(reserveCapital, initialCapital),
    reserveCoveragePct: safeDiv(reserveCapital, modeledReserveNeed) * 100,
    unallocated: investable - initialCapital - reserveCapital,
    totalAllocPct: input.stages.reduce((sum, s) => sum + s.allocPct, 0),
  };
}
