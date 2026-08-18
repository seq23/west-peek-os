# Deal Math Verification — West Peek OS (P6, D6 + ADR-005)

Law (D6): **no formula is accepted as correct merely because it exists in the partner
code.** Every function in `src/shared/dealmath/` was restated from first principles,
hand-verified with the worked examples below, and encoded as fixtures in
`tests/dealMath.test.ts` (41 tests). Anything that could not be independently
verified is listed under **UNVERIFIED / NOT PORTED** and stays manual-entry only.

Source: `seq23/secondaries`, **verified against commit `a350ad6`** (8 Aug 2026), deployed at
venturedeals.joinwestpeek.com. Re-checked 18 Aug 2026: the line numbers in the port map still land
on the same functions, and `computeCarry`, `xnpv`, `xirr` and `premiumDiscount` were compared
body-for-body and are unchanged. Record the commit on every future re-check — the original port
noted it as unknown, which made drift impossible to detect.

The dashboards are linked from the Deal maths page rather than rebuilt inside this app. A second
calculator was started and deleted: it covered fewer cases than the original, and two tools that
can disagree about the same deal is a worse outcome than one extra click.

Original source clone path
(`app.js`, 865 lines; the two Playwright specs in `tests/` document intended
behavior). Line numbers below refer to that file. Only pure calculation logic was
ported — no DOM, storage, or UI code.

---

## 1. Primitives

### `yearsBetweenDates(a, b)` — source: `yearsBetween` (app.js L185–188)
**Formula:** `(b − a) / (365.25 days)`, clamped at 0. Actual-days/365.25 convention.
**Worked examples:**
- 2026-01-01 → 2027-01-01: 365 days → 365/365.25 = 0.9993155373.
- 2026-03-26 → 2028-03-26: 731 days (includes 2028-02-29) → 731/365.25 = 2.0013689254.
- Reversed dates (b < a) → 0; null/invalid → 0.
**Fixtures:** `yearsBetweenDates` describe block.

### `safeDiv(a, b)` — source: L194
**Formula:** `b ? a/b : 0`. Examples: 10/4 = 2.5; 10/0 = 0. **Fixtures:** `safeDiv`.

---

## 2. `computeCarry(profit, investedCapital, holdYears, prefPct, carryPct, basis)` — source: L296–302

**Formula restated:**
- `hurdle = investedCapital × (prefPct/100) × holdYears` — **simple** interest, not compounded.
- If `profit ≤ 0` or `carryPct ≤ 0` → 0.
- basis `none` → `profit × carryPct/100`.
- basis `soft` (full catch-up) → `profit > hurdle ? profit × carryPct/100 : 0`.
- basis `hard` (default) → `max(profit − hurdle, 0) × carryPct/100`.

**Worked examples** (invested 10,000; 2 years; pref 8% → hurdle = 10,000 × 0.08 × 2 = 1,600; carry 20%):
1. hard, profit 1,000: 1,000 < 1,600 → **0**.
2. hard, profit 5,000: (5,000 − 1,600) × 0.20 = 3,400 × 0.20 = **680**.
3. soft, profit 5,000: 5,000 > 1,600 → 5,000 × 0.20 = **1,000**.
4. soft, profit exactly 1,600: strictly-greater rule → **0**.
5. none, profit 5,000 → **1,000**; profit 1,000 → **200**.
6. profit −500 → **0** (any basis); carryPct 0 → **0**.

**Fixtures:** `computeCarry` describe block (6 tests).

---

## 3. `xnpv(rate, cashflows)` — source: L303–307

**Formula restated:** base date = date of the **first** element;
`NPV = Σ amountᵢ / (1 + rate)^yearsBetween(base, dateᵢ)`.

**Worked examples:**
1. Single flow −1,000 at base date: exponent 0 → NPV = −1,000 at **any** rate (checked at 0.5 and −0.2).
2. Rate 0: plain sum. −1,000 + 500 + 700 = **200**.
3. −1,000 @2026-01-01, +1,210 @2027-01-01, rate 10%: T = 365/365.25 = 0.9993155373;
   NPV = −1,000 + 1,210 / 1.10^0.9993155373 = −1,000 + 1,100.0717622… = **+100.07176222969406**
   (computed from the closed form, not from either implementation).
4. A flow dated **before** the base date clamps to exponent 0: base 2026-06-01 with a
   2026-01-01 flow → 100 + 50 = **150** at any rate (documented partner behavior).
5. Empty series → NaN.

**Fixtures:** `xnpv` describe block (5 tests).

---

## 4. `xirr(cashflows, guess)` — source: L308–323, **with one deliberate deviation**

**Formula restated:** Newton's method on XNPV:
`rₙ₊₁ = rₙ − NPV(rₙ)/NPV′(rₙ)`, with `NPV′(r) = Σ −yearsᵢ·amountᵢ/(1+r)^(yearsᵢ+1)`,
start at `guess = 0.2`, stop when `|Δr| < 1e-7`, cap 100 iterations.

**Deviation (verified, intentional):** the partner returns the last finite iterate
**even when convergence was never reached**. This port returns `null` unless the
iteration actually converged — an unconverged rate is not a verified number and must
never surface as one. All partner guards are kept: ≥2 flows, at least one positive
and one negative amount (sign-change requirement), non-finite/zero-derivative break,
100-iteration cap (provably no hang).

**Worked examples:**
1. Two flows −1,000 @2026-01-01 / +1,210 @2027-01-01. Closed form: NPV = 0 ⇔
   (1+r)^T = 1.21 with T = 365/365.25 → r = 1.21^(365.25/365) − 1 = **0.2101579902005981**.
2. Three flows −1,000 @2026-01-01 / +500 @2026-07-01 / +700 @2027-01-01. No closed
   form; an independent 200-step bisection on the restated NPV gives
   r = **0.2625189521680761** (NPV at root ≈ 1.1e-13). The Newton implementation must
   land within 1e-6 and its XNPV residual must be < 1e-6 (self-consistency).
3. Sign-change requirement: all-positive, all-negative, single-flow, empty → **null**.
4. Degenerate series (both flows same date): NPV constant, derivative 0 → break →
   **null**, no hang.
5. Absurd guess (50 vs 0.2) on −1,000/+2,000 over 2 years: same root or null — never
   a hang, never an unconverged number presented as a rate.

**Fixtures:** `xirr` describe block (5 tests).

---

## 5. `premiumDiscount(roundPrice, secondaryPrice)` — source: L330–335

**Formula restated:** `pct = (secondary − round)/round × 100`; |pct| < 0.005 → "At par";
round = 0 → pct 0, "No round price entered".

**Worked examples:** (10, 8.5) → (8.5−10)/10 = **−15%** "Discount"; (10, 11) → **+10%**
"Premium"; (10, 10.0004) → 0.004% < 0.005 → "At par"; (0, 8.5) → 0 / "No round price entered".

**Fixtures:** `premiumDiscount` describe block (4 tests).

---

## 6. `computeSecondaryStructure(label, upfrontPct, mgmtPct, carryPct, prefPct, basis, globals)` — source: L348–367

**Formula restated:**
- `upfrontFee = dealSize × upfrontPct/100`
- `mgmtFees = investedCapital × mgmtPct/100 × holdYears` (simple annual accrual)
- `profit = grossExit − investedCapital`; `carry = computeCarry(…)`
- `totalFees = upfrontFee + mgmtFees + carry + legalCost + ongoingCost`
- `netProceeds = grossExit − totalFees`; `netMultiple = netProceeds / investedCapital`
- `payerBurden[p] = Σ feeᵢ × allocationᵢ[p]` per payer (investor/sponsor/client)
- dated flows: entry `−(basePrice + investorBurden)`, non-zero interim flows, exit
  `+netProceeds`; sorted by date; `irr = xirr(flows)`

**Worked example A (partner baseline inputs, arithmetic by hand):**
dealSize = basePrice = invested = $25,000,000; exit multiple 1.75 → grossExit = $43,750,000;
hold 2y (2026-03-26 → 2028-03-26, 731 days); legal $30,000; ongoing (20k + 15k) × 2 = $70,000;
all fees 100% investor-allocated; structure A = 0% upfront / 0% mgmt / 20% carry / 8% pref / hard.
- profit = 43,750,000 − 25,000,000 = 18,750,000; hurdle = 25M × 8% × 2 = 4,000,000
- carry = (18,750,000 − 4,000,000) × 0.20 = **2,950,000**
- totalFees = 0 + 0 + 2,950,000 + 30,000 + 70,000 = **3,050,000**
- netProceeds = 43,750,000 − 3,050,000 = **40,700,000**; netMultiple = 40.7/25 = **1.628**
- payerBurden = { investor: 3,050,000, sponsor: 0, client: 0 }
- dated flows: −28,050,000 @2026-03-26; +40,700,000 @2028-03-26 (the two zero interim
  rows are dropped: `Number(cf.amount)` falsy). T = 731/365.25 = 2.0013689254;
  irr = (40.7/28.05)^(1/T) − 1 = **0.20441313735061617** (two-flow closed form).

**Worked example B:** 5% upfront, no carry → upfrontFee = **1,250,000**; totalFees =
**1,350,000**; netProceeds = **42,400,000**; netMultiple = **1.696**; flows
−26,350,000/+42,400,000 → irr = **0.2682999254818399**.

**Worked example C (payer split):** upfront 50/50 investor/sponsor, carry 75/25, legal
100% sponsor, ongoing 100% client → investor = 625,000 + 2,212,500 = **2,837,500**;
sponsor = 625,000 + 737,500 + 30,000 = **1,392,500**; client = **70,000**; the three
sum exactly to totalFees (conservation check).

**Fixtures:** `computeSecondaryStructure` describe block (3 tests).

---

## 7. `computePrimaryDeal(input)` — source: `recalculatePrimary` economics (L440–555)

**Formulas restated:**
- priced: `post = pre + round`; `ownership% = check/post × 100`
- post-money SAFE: `post = cap`; `ownership% = check/cap × 100`
- convertible note: `effectiveValuation = min(pre, cap, pre×(1−discount%))` (positive
  candidates); `accrued = check × (1 + noteInterest%×nextRoundYears)` (**simple**
  interest); `post = effectiveValuation + round`; `ownership% = accrued/post × 100`
- `exitOwnership% = ownership% × (1 − futureDilution%)`
- `grossCommon = exitValue × exitOwnership%`; `preference = check × liqPrefMultiple`;
  non-participating: `gross = max(preference, grossCommon)`; participating:
  `gross = preference + grossCommon`
- fees: `upfront = check×upfrontFee%`; `mgmt = check×mgmtFee%×holdYears`;
  `carry = computeCarry(gross − check, check, holdYears, pref%, carry%, basis)`
- `net = max(gross − upfront − mgmt − carry, 0)`; `netMoic = net / (check + upfront + mgmt)`
- `annualized% = (netMoic^(1/holdYears) − 1) × 100`; `fundContribution = net / fundSize`
- `proRataNeed = max(round×2.5, 5M) × ownership%`; `conversionBreakpoint = preference ÷ ownership`
- verdict bands (L201–206): ≥1 → "Fund-returning potential"; ≥0.25 → "Meaningful fund
  contributor"; else "Not enough fund impact yet".

**Worked example (the partner's own e2e scenario, recomputed by hand):** check $500,000;
round $3.5M; pre $12M; 35% future dilution; 7y hold; 20% carry basis none; 1×
non-participating preference; fund $25M.
- post = 15,500,000; ownership = 500,000/15,500,000 = **3.2258064516%**
- exit ownership = 3.2258064516 × 0.65 = **2.0967741935%**
- exit $250M: grossCommon = 250M × 0.020967741935 = 5,241,935.48; > 500k pref → gross =
  **5,241,935.48**; carry = (5,241,935.48 − 500,000) × 0.20 = **948,387.10**;
  net = **4,293,548.39**; netMoic = **8.5871**; annualized = 8.5871^(1/7)−1 = **35.9586%**;
  fundContribution = 4,293,548.39/25M = **0.17174** → "Not enough fund impact yet".
  The partner's own spec expects "0.17x of fund" + that verdict — independent cross-check. ✓
- exit $500M → contribution **0.33948** → "Meaningful fund contributor" (spec: "0.34x"). ✓
- exit $1.5B → contribution **1.01045** → "Fund-returning potential" (spec: "1.01x"). ✓

**Further worked examples:**
- post-money SAFE, cap $12M: ownership = 500,000/12,000,000 = **4.1666667%**.
- note: discount 20% → discountedPre = 9.6M < cap = pre = 12M → effective **9.6M**;
  accrued = 500,000 × (1 + 0.06 × 1.5) = **545,000**; post = 13.1M; ownership =
  545,000/13,100,000 = **4.1603053%**.
- participating: gross = 500,000 + 5,241,935.48 = **5,741,935.48**.
- proRataNeed = max(8.75M, 5M) × 3.2258064516% = **282,258.06**; conversionBreakpoint =
  500,000/0.032258064516 = **15,500,000** = post-money (algebraic identity at 1× pref:
  pref ÷ (check/post) = post). ✓

**Fixtures:** `computePrimaryDeal` + `fundReturnVerdict` describe blocks (7 tests).

---

## 8. `computeFollowOn(input)` — source: `recalculateFollowOn` economics (L558–674)

**Formulas restated (share-count math controls):**
- `primaryNewShares = round/primaryPps`; `postFD = fd + primaryNewShares`;
  `existingShares = fd × currentOwn`; `impliedPreMoney = fd × primaryPps`
- `proRataRequired = currentOwn × primaryNewShares × primaryPps`
- `superSharesRequired = max(targetOwn × postFD − existingShares, 0)`;
  `superRequired = superSharesRequired × primaryPps`
- capped by maxAllocation when > 0; shortfall = required − check
- `own(check) = (existingShares + check/primaryPps)/postFD × (1 − extraDilution%)`
- secondary: `shares = secondaryCapital/secondaryPps`; `cost = secondaryCapital × (1 + fees%)`
- per scenario: `exitOwn = own × (1 − futureDilution%)`; `proceeds = exitOwn × exitValue`;
  `incremental = max(proceeds − skipProceeds, 0)`; `incMoic = incremental/capital`;
  `incIRR% = (incMoic^(1/years) − 1) × 100`; `totalMoic = proceeds/(existingCost + capital)`;
  `concentration% = (existingCost + capital)/fundSize × 100`

**Worked example (partner baseline, recomputed by hand):** currentOwn 8%, FD 10M, round
$20M @ $10 pps, secondary $2.8M @ $8.50 + 1% fees, target 10%, allocation cap $4M, 30%
future dilution, exit $1B, 5y, existing cost $1M, fund $25M.
- new shares = 20M/10 = **2,000,000**; postFD = **12,000,000**; existing = **800,000**;
  impliedPre = **$100,000,000**
- proRataRequired = 0.08 × 2M × 10 = **$1,600,000** (partner e2e expects "$1,600,000"). ✓
- superShares = 0.10 × 12M − 800k = **400,000** → superRequired = **$4,000,000**
- secondary spread = 8.5/10 − 1 = **−15%** (partner e2e: "Discount 15.00%"). ✓
- skip own = 800k/12M = **6.6666667%**; skipProceeds = 6.6667% × 0.7 × 1B = **46,666,666.67**
- pro rata own = (800k + 160k)/12M = **8.00%**; proceeds 56M; incremental **9,333,333.33**;
  incMoic = **5.8333**; incIRR = 5.8333^(1/5) − 1 = **42.2929%**; totalMoic =
  56M/2.6M = **21.5385**; concentration = 2.6M/25M = **10.4%**
- super own = (800k + 400k)/12M = **10.00%** — hits target exactly (algebraic identity). ✓
- secondary own = (800k + 329,411.76)/12M = **9.4117647%**; cost **2,828,000**; incIRR =
  (19,215,686.27/2,828,000)^(1/5) − 1 = **46.7018%**; concentration = 3.828M/25M = **15.312%**
- cap $1M → proRataCheck $1,000,000, shortfall **$600,000** (partner e2e: "Allocation
  shortfall $600,000"), pro-rata path inexecutable. ✓

**Fixtures:** `computeFollowOn` describe block (3 tests).

---

## 9. `computeFundModel(input)` — source: `recalculateFund` economics (L676–784)

**Formulas restated:**
- `fees = size × mgmtFee% × feeYears`; `expenses = size × expense%`;
  `investable = max(size − fees − expenses, 0)`
- per stage: `bucket = investable × alloc%`; `fullyLoadedCheck = check × (1 + reserveMultiple)`;
  `companies = floor(bucket ÷ fullyLoadedCheck)`; `initial = companies × check`;
  `reserve = companies × check × reserveMultiple`; `graduated = companies × grad%`;
  `need = graduated × avgFollowRound × ownership%`
- rollups: `avgOwn = Σ(companiesᵢ × ownᵢ)/Σcompanies`; `dealsPerYear = companies/deployYears`;
  `grossNeeded = size × grossTvpi`; `netNeeded = size × netTvpi`; `dpiCash = size × targetDpi`;
  `moicOnInvestable = grossNeeded/investable`; `winnerOwn = max(ownᵢ) × 0.65`;
  `winnerExit = grossNeeded ÷ winnerOwn`; `reserveRatio = reserve/initial`;
  `coverage% = reserve/need × 100`; `unallocated = investable − initial − reserve`

**Worked example (partner fund baseline, recomputed by hand):** $25M fund, 2% mgmt × 10y,
1% expenses, 3y deploy, $12M avg follow-on round, 3.5/3.0/1.0 gross TVPI/net TVPI/DPI;
stages Pre-seed (25%, $250k, 5%, 1.5×, 45%), Seed (55%, $750k, 7%, 1×, 55%), Series A
(20%, $1.5M, 6%, 0.5×, 65%).
- fees = 25M × 0.02 × 10 = **5,000,000**; expenses = **250,000**; investable = **19,750,000**
- Pre-seed: bucket 4,937,500; loaded 625,000 → **floor(7.9) = 7** companies;
  initial 1,750,000; reserve 2,625,000; graduated 3.15; need = 3.15 × 12M × 5% = **1,890,000**
- Seed: bucket 10,862,500; loaded 1.5M → **7**; initial 5,250,000; reserve 5,250,000;
  graduated 3.85; need = **3,234,000**
- Series A: bucket 3,950,000; loaded 2.25M → **floor(1.7556) = 1**; initial 1,500,000;
  reserve 750,000; graduated 0.65; need = **468,000**
- totals: **15** companies; initial **8,500,000**; reserve **8,625,000**; need
  **5,592,000**; follow-ons **7.65**; avgOwn = (35 + 49 + 6)/15 = **6.0%**; pace **5/yr**;
  grossNeeded **87.5M**; moicOnInvestable = 87.5/19.75 = **4.4304**; winnerOwn =
  7 × 0.65 = **4.55%**; winnerExit = 87.5M/0.0455 = **1,923,076,923.08**; reserveRatio
  **1.0147**; coverage = 8,625,000/5,592,000 = **154.24%**; unallocated = **2,625,000**.

**Fixtures:** `computeFundModel` describe block (4 tests).

---

## UNVERIFIED / NOT PORTED (manual-entry only)

The following partner computations are **judgment heuristics, not formulas**, or could
not be independently verified against any external authority. They are NOT in the
verified path; `deal_math_packet` keeps the corresponding metrics manual-entry.

1. **Primary deal 100-point scoring heuristic** (app.js L494–509: penalty points for
   ownership below target, dilution outside stage bands, pool expansion > 8, reserve
   coverage < 75, no pro-rata, netMoic < 5, fund contribution < 0.25, pre/round > 8,
   missing cap, discount > 30, note interest > 12, heavier preference stack) — the
   weights are the partner's underwriting judgment, not verifiable math. NOT PORTED.
2. **Follow-on scenario scoring + "Recommended" selection** (L627–642: base score by
   path, qualitative re-underwrite average × 25, capped incMoic/incIRR bonuses,
   reserve/concentration/executability penalties) — a decision aid; the deterministic
   economics ARE ported (§8). NOT PORTED. (Also: no score may decide anything in this
   system — investment decisions are human-reserved, canon §3.)
3. **Fund-model 100-point scoring heuristic** (L722–734) — judgment bands. NOT PORTED.
4. **`redYellowGreen` signal mapping** (L196–200) — display thresholds for the above.
   NOT PORTED.
5. **`stageBenchmarks` dilution bands** (L435–439) — market-convention assertions
   (e.g. seed dilution 17.5–25%) with no derivable source. NOT PORTED.
6. **TVPI/DPI as *portfolio-realized* metrics.** The fund model computes *target* cash
   values (`size × target`), which ARE ported; realized TVPI/DPI/XIRR over a live
   portfolio require realized cash-flow data the partner tool does not compute.
   `deal_math_packet.tvpi/dpi` stay MANUAL-entry.
7. **`classifySpvLife` / `winnerLabel` / CSV export** — presentational. NOT PORTED.

`fundReturnVerdict` bands (≥1 / ≥0.25) ARE ported: they are simple, stated thresholds,
verified against the partner's own spec expectations (§7) — and they render as an
advisory label only; no verdict auto-approves anything.

## Known limitations of the verified port (documented, accepted)

- Year fractions are **actual-days/365.25**, not ACT/360 or 30/360 — matches the
  partner and is stated wherever XNPV/XIRR surfaces.
- Carry and note interest accrue **simple**, not compounded.
- XNPV discounts from the **first element's** date; pre-base-date flows clamp to
  exponent 0 (partner behavior, fixture-verified).
- SAFE/note conversion math is an approximation (the partner tool itself says "legal
  docs still control"); legal/final terms interpretation stays with humans.
