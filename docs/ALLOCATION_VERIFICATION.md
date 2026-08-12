# Allocation Formula Verification — West Peek OS (P11)

Law (plan §8/P11 + §7.2): **no formula used for a live allocation decision is
accepted because prior code or planning prose contained it.** Every function in
`src/shared/allocation/` is restated from first principles below, hand-worked with
arithmetic a reviewer can check without running anything, and encoded as fixtures in
`tests/allocation.test.ts`.

Model version: `wpos-allocation-1.0.0` (`ALLOCATION_MODEL_VERSION`). Every scenario
pins this string, so a decision recorded under one model can never be silently
re-explained by a later one.

**This document is engineering verification of arithmetic. It is NOT acceptance.**
Live allocation use remains blocked until the operator or a designated reviewer
accepts this verification (§7.2 formula-verification gate). Nothing here claims
valuation correctness, investment soundness, or fund-performance correctness (§12.4).

---

## 0. What P11 does NOT re-derive

Fund-construction economics (`computeFundModel`) and follow-on path economics
(`computeFollowOn`) already exist in `src/shared/dealmath/`, ported under D6 and
hand-verified in `docs/DEAL_MATH_VERIFICATION.md`. P11 **calls** them. It does not
grow a second copy, because a second copy is a second thing to verify and a second
thing to drift.

---

## 1. `signedCapitalEffect(optionType, capital)`

**Restated:** capital is always stated as a positive magnitude; direction comes from
the option type. `INITIAL`, `FOLLOW_ON`, `RESERVE`, and `SECONDARY_PURCHASE` deploy
capital (`+capital`). `SECONDARY_SALE` and `EXIT` return capital (`−capital`).

**Why signed rather than two fields:** one signed number keeps every downstream
formula (capacity, concentration, undeployed) identical for every option type, so a
sale cannot accidentally be measured with buy-side arithmetic.

**Worked examples:**
- `INITIAL`, 2,000,000 → **+2,000,000**
- `SECONDARY_PURCHASE`, 500,000 → **+500,000**
- `EXIT`, 750,000 → **−750,000**
- `SECONDARY_SALE`, 250,000 → **−250,000**

**Fixtures:** `signedCapitalEffect` describe block.

---

## 2. `sleeveCapacity(investable, sleeve, optionType, capital)`

**Restated:**
```
sleeveBudget    = investable × targetPct / 100
remainingBefore = max(sleeveBudget − deployed, 0)
remainingAfter  = sleeveBudget − (deployed + signedEffect)
overBy          = max(−remainingAfter, 0)
fits            = remainingAfter ≥ 0
```

Two deliberate asymmetries:
- `remainingBefore` is floored at 0: a sleeve already over budget has no capacity to
  offer, and reporting negative "available" capital would be nonsense.
- `remainingAfter` is **not** floored: the size of a breach is the thing a reviewer
  needs, and clamping it to 0 would hide how badly an option overshoots.

**Worked examples** (investable 24,000,000):

1. Sleeve `early` target 60% → budget = 24,000,000 × 0.60 = **14,400,000**.
   Deployed 10,000,000 → remainingBefore = **4,400,000**.
   `INITIAL` of 2,000,000 → after = 14,400,000 − 12,000,000 = **2,400,000**, overBy **0**, fits **true**.
2. Same sleeve, `INITIAL` of 5,000,000 → after = 14,400,000 − 15,000,000 = **−600,000**,
   overBy **600,000**, fits **false**.
3. Same sleeve, `EXIT` of 3,000,000 → deployed + (−3,000,000) = 7,000,000 →
   after = **7,400,000**, fits **true** (a realisation frees capacity).
4. Over-deployed sleeve: budget 14,400,000, deployed 15,000,000 →
   remainingBefore = max(−600,000, 0) = **0**; a 100,000 `INITIAL` → after = **−700,000**, overBy **700,000**.
5. Target 0% → budget **0**; any deployment breaches; an `EXIT` of 500,000 against
   deployed 500,000 → after = 0 − 0 = **0**, fits **true** (exactly at the limit is not a breach).

**Fixtures:** `sleeveCapacity` describe block.

---

## 3. `concentrationAfter(fundSize, existingCost, optionType, capital, limitPct)`

**Restated:**
```
costAfter = max(existingCost + signedEffect, 0)
pct(c)    = fundSize > 0 ? c / fundSize × 100 : 0
deltaPct  = pctAfter − pctBefore
overByPct = limitPct === null ? 0 : max(pctAfter − limitPct, 0)
withinLimit = limitPct === null ? true : pctAfter ≤ limitPct
```

**Two decisions that matter:**
- Concentration is measured on **cost basis**, not marked value. A mark is an
  opinion; letting an unrealised write-up create headroom would mean the fund could
  breach a concentration limit by believing in itself.
- A concentration policy that states no `max_single_company_pct` produces
  `limitPct = null` and therefore **no breach** — the system never invents a
  threshold the operator did not set (same rule as P8 severity bands).

**Worked examples** (fund 30,000,000; limit 10%):

1. Existing cost 1,500,000 → pctBefore = 1,500,000/30,000,000 = **5%**.
   `FOLLOW_ON` of 900,000 → costAfter = 2,400,000 → pctAfter = **8%**, delta **+3 points**,
   withinLimit **true**, overBy **0**.
2. Same, `FOLLOW_ON` of 2,100,000 → costAfter = 3,600,000 → pctAfter = **12%**,
   overByPct = 12 − 10 = **2**, withinLimit **false**.
3. Exactly at the limit: existing 1,500,000 + 1,500,000 = 3,000,000 → **10%** →
   withinLimit **true** (`≤`, not `<`).
4. `EXIT` of 1,000,000 from existing 1,500,000 → costAfter = 500,000 → pctAfter ≈ **1.6667%**,
   delta ≈ **−3.3333 points**.
5. Over-exit floor: `EXIT` of 2,000,000 from existing 1,500,000 → costAfter = max(−500,000, 0) = **0** → **0%**.
6. `limitPct = null` with pctAfter 40% → withinLimit **true**, overByPct **0**.
7. `fundSize = 0` → every pct is **0** by definition (no division by zero, no NaN).

**Fixtures:** `concentrationAfter` describe block.

---

## 4. `reserveEffect(investable, reservePct, committedBefore, modeledNeed, reserveDraw)`

**Restated:**
```
reservePool      = investable × reservePct / 100
committedAfter   = committedBefore + reserveDraw
uncommittedAfter = reservePool − committedAfter
remainingNeed(c) = max(modeledNeed − c, 0)
coverage(u, c)   = remainingNeed(c) ≤ 0 ? (u ≥ 0 ? 100 : 0) : u / remainingNeed(c) × 100
sufficient       = uncommittedAfter ≥ 0
```

**The one non-obvious choice:** coverage is measured against **remaining** modelled
need — need not already covered by commitments — rather than against total need.
Measuring against total need would make coverage fall every time reserve is committed
to a company, which reads as the portfolio getting riskier at the exact moment it got
safer. Measuring against remaining need answers the question a reviewer is actually
asking: *can the reserve still cover what has not yet been reserved for?*

When remaining need is 0 the ratio is undefined; coverage reports **100** if any
uncommitted reserve remains (nothing left to cover, and there is money) and **0** if
the pool is overdrawn.

**Worked examples** (investable 24,000,000; reservePct 40% → pool = **9,600,000**):

1. committedBefore 0, modeledNeed 8,000,000, draw 0:
   uncommittedAfter = **9,600,000**; remainingNeed = 8,000,000;
   coverage = 9,600,000/8,000,000 × 100 = **120%**; sufficient **true**.
2. Same, draw 2,000,000: committedAfter **2,000,000**; uncommitted **7,600,000**;
   remainingNeed = 8,000,000 − 2,000,000 = 6,000,000;
   coverage = 7,600,000/6,000,000 × 100 = **126.6667%**.
   (Coverage *rises*: a commitment retired part of the need it was meant to cover.)
3. Draw 10,000,000 against pool 9,600,000: uncommitted = **−400,000**,
   sufficient **false**; remainingNeed = max(8,000,000 − 10,000,000, 0) = 0 →
   coverage = **0** (overdrawn).
4. modeledNeed 0, draw 0 → remainingNeed 0, uncommitted 9,600,000 ≥ 0 → coverage **100%**.
5. reservePct 0 → pool **0**; draw 0, need 5,000,000 → uncommitted 0 →
   coverage = 0/5,000,000 = **0%**, sufficient **true** (0 is not negative — an
   empty reserve is a coverage problem, not an overdraft).

**Fixtures:** `reserveEffect` describe block.

---

## 5. `evaluateOption(policy, input)`

**Restated:** run §2, §3, §4 against the pinned policy, compute
`undeployedAfter = investable − (fundDeployed + signedEffect)`, and emit one
`ConstraintViolation` per failed check:

| Check | Emits | Severity |
|---|---|---|
| `capacity.fits === false` | `SLEEVE_CAPACITY` | BREACH |
| `concentration.withinLimit === false` | `CONCENTRATION_LIMIT` | BREACH |
| `reserve.sufficient === false` | `RESERVE_SHORTFALL` | BREACH |
| each `mandateExclusions[i]` | `MANDATE_EXCLUSION` | BREACH |
| `undeployedAfter < 0` | `UNDEPLOYED_CAPITAL` | BREACH |

**Worked example — an option that breaches three ways at once**
(fund 30,000,000; investable 24,000,000; fundDeployed 23,000,000; concentration limit
10%; reservePct 40% → pool 9,600,000; reserveCommitted 9,000,000; modeledNeed 8,000,000;
sleeve `early` target 60% → budget 14,400,000, deployed 14,000,000):

`INITIAL` of 2,000,000 with existing company cost 2,500,000 and reserveDraw 1,000,000:
- capacity: 14,400,000 − 16,000,000 = **−1,600,000** → SLEEVE_CAPACITY breach.
- concentration: (2,500,000 + 2,000,000)/30,000,000 = **15%** > 10% → CONCENTRATION_LIMIT breach.
- reserve: committedAfter = 10,000,000 > pool 9,600,000 → uncommitted **−400,000** → RESERVE_SHORTFALL breach.
- undeployed: 24,000,000 − 25,000,000 = **−1,000,000** → UNDEPLOYED_CAPITAL breach.

→ **4 BREACH violations**, all recorded with their limit and observed values. The run
stores every one of them; `constraint_violation` rows are immutable, so a breach is
never edited away before a reviewer sees it.

**A clean option in the same fund** (`INITIAL` 300,000, existing cost 0, reserveDraw 0,
sleeve deployed 10,000,000): capacity after 4,100,000 ✓, concentration 1% ✓, reserve
uncommitted 600,000 ✓, undeployed 700,000 ✓ → **0 violations**.

**Fixtures:** `evaluateOption` describe block.

---

## 6. Run-level accumulation

`runComparison` carries `reserve_committed` forward across options **within a run**,
so two reserve options that each fit individually but jointly overdraw the pool both
surface the shortfall. Worked example (pool 9,600,000, committedBefore 0):
draw 6,000,000 → uncommitted 3,600,000 ✓; then draw 5,000,000 → committedAfter
11,000,000 → uncommitted **−1,400,000** → RESERVE_SHORTFALL on the second option.

Nothing else accumulates: sleeve deployment and existing company cost are stated per
option, because two options in one scenario are usually *alternatives*, not a
sequence. Treating them as a sequence would silently make option B look worse for
existing beside option A that nobody approved.

**Fixtures:** the joint-overdraw case in the service-level tests.

---

## 7. UNVERIFIED / NOT MODELLED

These are deliberately absent, and the system must not be read as providing them:

- **Expected returns, probabilities, or rankings.** A comparison run reports
  arithmetic. It does not order options, score them, or recommend one.
- **Time value across options.** Options are compared at stated capital, not
  discounted. Any IRR/NPV comparison would need dated flows per option and its own
  verification pass.
- **Portfolio-level correlation, reserve optimisation, or pacing models.** No such
  model exists here; none should be inferred from a coverage percentage.
- **Marked valuations.** Concentration is cost-based (§3). The system holds no
  authoritative mark and certifies no valuation (§12.4, D12).
- **Any capital movement.** Approving an option records a human decision.
  `capital.move_or_commit` and `wire.initiate_or_authorize` remain separately
  reserved actions, and no P11 code path touches them.
