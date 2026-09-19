# Fund strategy — design spec

**Status:** DESIGN PASS, for owner approval. No application code changed. Branch `design/fund-strategy`, base `main` at `52fccfb` (the deployed Deals redesign). The owner's brief, 19 Sep 2026: *"another design overhaul of the fund strategy page — I don't think we should repeat the same stuff that is on the portfolio page (at least in the same way), and the link to our venture deals dashboard should be bigger and more prominent."*

**The design:** https://claude.ai/artifact/G1p5bFmgosQsxvoBrJymAR — five artboards: the page at 1280 and at 390, the dashboard door in eight states (two controls), the plan-against-reality band in four states, and the construction Amend in eight states. The artboards' `<style>` is `src/client/styles.css` `:root` copied verbatim plus the product's own Deals-section classes; the ~40 lines of new classes are listed in §5. No new hue, no new font, no chart library — inline SVG on `--viz-1` and `--wp-line-control`. Figures are `src/shared/fund/allocation.ts` arithmetic on `scripts/seed/commission-fund.mjs` (the commissioning seed: $30M, fees $5M + expenses $1M, 70/30 of investable, 40% reserve, 20 companies at $500K–$750K, one $10K stand-in position). Values the page reads live and I could not read from the repo are in `[BRACKETS]`, never invented.

**Method.** Hallmark as its verbs say: `hallmark audit` on today's page (§1, no edits), then `hallmark redesign` inside the existing route and component boundaries with the theme LOCKED to `WEST_PEEK_BRAND_SYSTEM.md` + `:root` (`design.md` = `docs/WEST_PEEK_DESIGN_SYSTEM.md`, `designed-as-app`, consistency over variety). References applied: `SKILL.md` disciplines 1–5, `contract.md`, `anti-patterns.md`, `slop-test.md` (pre-emit critique, gates 24–29, 36, 56–66), `responsive.md`, `layout-and-space.md`, `typography.md`, `copy.md`, `verbs/audit.md`, `verbs/redesign.md`; `dataviz` for the pace chart (form: change-over-time → one line, one axis, plan as a reference line; palette already validated in `styles.css`). The same two locked-theme overrides recorded in the Deals spec stand (gate 1 Inter, gate 8 pure white surface).

---

## 1 · What is wrong today — `hallmark audit`

The page is `FundStrategyPage` at `src/client/App.tsx:2994-3055`. It renders, in order: `DeckPanel`, `FundConstruction`, a `<details>` of `STRATEGY_STEPS`, `CockpitPage`, `PortfolioComposition` (= `Composition`), `PortfolioAllocation` (= `FundAllocation`, the plan ring), `ModelingPage`, `AllocationPage`, `FollowOnPage`. Nine components from five files, stacked.

| # | Sev | Tell | Where | Fix |
|---|---|---|---|---|
| 1 | critical | **The dashboard door is buried.** The owner's named link is a `.btn-strong` inside a `.card` in the *seventh* block down, under a `FundPicker` and a paragraph; nothing says what the dashboards answer | `src/client/pages/ModelingPage.tsx:93-113` (`DASHBOARD_URL` at `:30`) | A first band directly under the masthead: what the three dashboards answer, the six mandate figures to carry across, and the page's one `.btn-primary.btn-lg` — a link that says it opens a new tab (§3.1). |
| 2 | critical | **Portfolio, repeated.** `Composition` is rendered here *and* on Portfolio's "What the portfolio is made of" band (same component, same data); `CockpitPage` renders Top risks · Deteriorating · Improving · Stale or missing · Support asks — Portfolio has "What is going wrong right now", "Which way each company is moving", "Who we have not heard from", "Where a company has asked for help" | `App.tsx:3022` (`CockpitPage`), `:3024-3029` (`PortfolioComposition`), `src/client/pages/CockpitPage.tsx:62-156`; Portfolio side `PortfolioPage.tsx:496-604` | Both leave this page. Fund strategy shows deployed only as a distance from the plan (§3.2); monitoring lives on Portfolio alone (§2). |
| 3 | critical | **No answer line.** The page opens on the deck card, then a nine-input editor. The one sentence a partner comes for — how far is the fund from its plan — is nowhere | `App.tsx:3006-3008` | Masthead derived from `planSlices` and `/api/portfolio/allocation`: *"One company in, nineteen to the plan."* |
| 4 | major | **The construction editor is open on every visit**, nine number inputs at reading weight, and its React defaults (25 companies, $250K–$750K, 2%) render before the stored policy arrives — a flash of invented numbers on a page whose whole history is invented numbers | `src/client/pages/FundConstruction.tsx:76-84` (defaults), `:226-265` (inputs) | The policy reads as three sentences; the same inputs open behind **Amend** (`aria-expanded`), seeded from `current`, Save disabled until a reason is typed (§3.3, artboard E). Same move the Thesis design made. |
| 5 | major | **Ten panels, one rank.** `h3` and `h4` alternate as the top rank (`AllocationPage` opens on an `h4`, `CockpitPage` on a `.module-grid` of `h4`s then an `h3`); `FundPicker` is mounted twice on one page | `App.tsx:2561`, `CockpitPage.tsx:172`, `ModelingPage.tsx:88`, `FollowOnPage.tsx:113` | Masthead `h2` · band `h3` (`--text-xl`) · panel `h4` (`--text-lg`); one fund, no picker (one fund exists; the picker returns only if `/api/funds` has more than one). |
| 6 | major | **The scenario form invents figures in the request body's clothing** — `capital` defaults to `"2100000"`, `existingCost` to `"1500000"`; option rows print `<code>` ids; an "Approval receipt" text box asks for a paste | `App.tsx:2547-2548`, `:2799-2830` | Rows (`.deal-row-2`) and an inline form that asks the one thing the system cannot know — investable after fees — prefilled from `sleeve.estimated_investable_usd` ($24M) with the help text saying so (§3.6). |
| 7 | major | **Two fund sizes, no link.** `/api/funds/:id/basis` reads `fund.target_size_minor`, which only the LP page writes (`lpCommitments.ts:147`); the ring, the deck and the construction editor read `mandate_json.target_size_usd`. On a fund commissioned from the seed the basis route returns `ready: false` and the scenario form refuses with "The fund's size has not been recorded" while the ring above it draws $30M | `src/worker/services/funds.ts:383-388`, `src/client/App.tsx:2621-2630` | Basis falls back to the current mandate's `target_size_usd` (source `DERIVED`), so the page cannot contradict itself. **SUSPECTED in production** — confirm by opening a scenario. |
| 8 | major | **The plan ring's own copy sends the reader away** — "what has been spent is drawn against this on Portfolio" — the interesting number (the gap) is never stated on this page | `src/client/pages/FundAllocation.tsx:180-182` | The gap rows and the pace chart state it (§3.2); the ring's caption keeps the sentence because it is true and it is the split rule. |
| 9 | minor | "How this decision runs" — six instructional lines in a `<details>` | `App.tsx:2985-2992`, `:3011-3020` | Removed; the band order *is* the sequence. |
| 10 | minor | `FollowOnPage` "Pulling ahead" duplicates Portfolio's "Pulling ahead" panel | `FollowOnPage.tsx:159-166`, `PortfolioPage.tsx:564` | Fund strategy keeps the reserve budget and the open *reviews*; candidates are Portfolio's (§3.5). |
| 11 | minor | The page's purpose statement claims Portfolio's job: "What the portfolio is made of, what is going wrong in it" | `src/shared/help/pagePurpose.ts:126-135` | Rewrite: "Where the fund is going: the plan, how far reality is from it, the reserves, the deck, and the numbers to model the next cheque with." |
| 12 | minor | "Why the two agree" — three paragraphs on `xirr` convergence at reading weight | `ModelingPage.tsx:163-181` | One line under the door's actions; the xirr note stays in the code comment where it already lives. |

**Verdict:** *ships as slop on the thing she asked for* — 3 critical · 5 major · 4 minor. The arithmetic underneath (`sleeveMath.ts`, `allocation.ts`, the policy versioning) is right; the page is a stack of every fund-shaped component in the repo.

---

## 2 · The split — Portfolio owns what the portfolio IS; Fund strategy owns where the fund is GOING

| Element | Lives on Portfolio | Lives on Fund strategy | How it differs |
|---|---|---|---|
| The ring | **Deployment ring** (`deploymentRingSlices`: deployed · still to deploy · reserves · secondaries · fees), caption "committed" | **Plan ring** (`planRingSlices`: initial · reserves · secondaries · fees) | Same `AllocationRing`, different slices. Fund strategy never draws a *deployed* slice; `validate:portfolio`'s one-ring rule holds. |
| Deployed dollars | The holdings table's Paid column and the ring's deployed slice — a **total** | The masthead answer, the pace chart's single mark, and the "Initial cheques" gap row — a **distance** ("$10.07M still to write") | Never the same drawing; Fund strategy shows it only against the plan. |
| Companies | The rows | "1 in · 19 to find" against `target_positions` | Count vs. plan, not the list. |
| Composition bars (`Composition`) | Yes | **No** | Removed from Fund strategy. |
| Alerts · deteriorating · improving · stale · support asks (`CockpitPage`) | Yes — four bands | **No** | Removed from Fund strategy. |
| Pulling ahead (follow-on candidates) | Yes — panel + "Open a review" | A button to Portfolio | Fund strategy shows the **open reviews** and the reserve **headroom** they draw on. |
| Reserves | Per-company "Reserved" column, "Reserve for it" | Policy % and $, drawn vs. headroom, the rationale sentence | Company vs. fund. |
| Concentration | Measured against `max_single_company_pct` under the table | Set (inside Amend, as the concentration policy's value) | Portfolio measures; Fund strategy sets. |
| Secondaries | — (Secondaries page) | "$0 of $7.2M sleeve" gap row | Target vs. bought, one row. |
| Fees and expenses | Ring slice | Ring slice + "paid to date — not recorded" | Honest placeholder: no fee ledger exists. |
| Book it · Mark it | Yes | No | — |
| The deck (`DeckPanel`) | No | Yes — a band, with the staleness line tied to Amend | — |
| Construction (`FundConstruction`) | No | Yes — sentences at rest, Amend on purpose | — |
| Venture deals dashboards (`ModelingPage`) | No | Yes — the first band, the one orange button | — |
| Scenarios (`AllocationPage`) | No | Yes — rows + inline open form | — |
| Pace over time | No | Yes — the one chart Portfolio does not have | Needs `first_close_on` (§4). |

---

## 3 · The page (artboards A desktop, B phone)

**Purpose line:** Where the fund is going — the plan, how far reality is from it, the reserves, the deck the plan is told in, and the numbers to model the next cheque with.

**Masthead** (the shared `.masthead` pattern): eyebrow `FUND STRATEGY · WEST PEEK VENTURES FUND I · VINTAGE 2026 · MANDATE V1 · SLEEVE V1 · RESERVE V1` (version numbers from `current.version_no`; the seed's are v1, production's may be later — the page reads them). Answer: **"One company in, nineteen to the plan."** — derived from `companies` on `/api/portfolio/allocation` and `mandate.target_positions`. Detail: "$10K of the $10.08M set aside for initial cheques is out. The plan is twenty companies at $500K–$750K over a four-year investment period — five a year, about $2.5M a year." (`planSlices().initial`, `deployment.deployed`, `mandate.investment_period_years`, `check_size_usd`).

### 3.1 Band 1 · Model it — the dashboard door (artboard C)

The owner's ask, answered first. A `.door` card the full width of the surface, directly under the masthead:

- **Left:** head "Model the next cheque in the venture deals dashboards" (`--text-xl`); the lede from `ModelingPage.tsx:9-27` cut to two sentences; the three things the dashboards answer (secondary deals · primary rounds — priced, post-money SAFE, convertible note · fund construction), each one line.
- **Right:** "Your numbers, from mandate v1 — the dashboards open on their own defaults": six `.kv` figures — Fund size $30M · Management fee 2% (a year, 10 years) · Initial cheque $500K–$750K · Target ownership 8% (walk below 5%) · Positions 20 · Reserves 40% of early stage. From `/api/funds/:id/policies/mandate` + `/reserve` `current`, as `ModelingPage.tsx:118-160` already reads them.
- **Actions row:** `<a class="btn-primary btn-lg" href=DASHBOARD_URL target=_blank rel="noreferrer noopener" aria-label="Open the venture deals dashboards — opens … in a new tab">Open the dashboards ↗</a>` — **the page's one orange control.** Beside it `Copy these six figures` (`.btn-strong`, `navigator.clipboard.writeText`) — the one thing a bare link cannot do. One muted line: opens in a new tab, nothing entered there leaves the browser, the arithmetic is the same code as deal packets (`shared/dealmath`); to commit a number, put it on a deal.
- **8 states, both controls** (artboard C): Open — default · hover (`--wp-orange-strong`) · focus-visible (the global ring) · active (`--wp-orange-deep`) · disabled+reason (`aria-disabled`, `DASHBOARD_URL` unset) · loading (the figures are `—` while the mandate loads; the link never waits) · error (mandate 5xx: `.notice-bad`, "The dashboards still open — take the figures from the Thesis page for now") · success (opened; "Nothing entered there comes back here"). Copy — default · hover · focus · active · disabled+reason (no mandate: "Set one on the Thesis page") · loading (`aria-busy`, "Reading the mandate…") · error (`data-state=error`, "Could not copy" + the figures stay on screen) · success (`data-state=success`, label becomes "Copied — paste into the dashboard"; silent, no toast).

Brand check: orange on one control, ≈1.5% of the desktop viewport; black-first everywhere else; `--wp-orange-ink` on the fill (6.2:1).

### 3.2 Band 2 · Where the fund is against its plan (artboard D)

Two cards. **Left — the pace chart:** "Initial-cheque capital — pace against the plan." One axis (dollars, $0 → `planSlices().initial`), x = the four-year investment period from first close; the plan as a dashed `--wp-line-control` reference line to $10.08M at +4 yrs; actual as a `--viz-1` 2px line with an 8px+ marker at today, direct-labelled "today · $10K · 1 company"; `role=img` with a sentence `aria-label`; a two-item key in words. Built version adds the crosshair tooltip (`dataviz` interaction rule); the artboard is static.

- **State 1 — today:** `fund.first_close_on` does not exist, so the plan line has no origin. The band says so in a `.notice-gate` — "The clock starts at first close, which is not on the fund's record yet. Until it is, the plan line has no start date and the pace cannot be judged." — with `Record first close on LP`. Nothing is guessed.
- **State 2 — clock running:** the today marker sits at its real x; a hollow "plan by today" marker on the plan line; a sentence gives the verdict in words ("behind the plan"), not colour.
- **State 3 — overspend:** `deployment.overspend > 0` — the existing copy from `PortfolioAllocation.tsx:53-56` as a `.notice-gate` pointing at Amend.
- **State 4 — no fund size:** `plan.fundSize === 0` — one `.state-empty` sentence; no chart.

**Right — "The gap, pool by pool"** (`.gap-rows`): five rows, each label · bar · figure · delta-in-words: Initial cheques ($10K out · $10.07M still to write) · Companies (1 in · 19 to find) · Reserves ($0 drawn · nothing drawn yet) · Secondaries ($0 bought · sleeve untouched) · Fees and expenses (`paid to date — not recorded` in a dashed grey block · no fee ledger yet). Footnote: what the money bought is on Portfolio; here only the distance from the plan.

### 3.3 Band 3 · How the fund is built (artboard E)

**Left — "Where the $30M goes":** the plan ring (`AllocationRing`, `planRingSlices`, caption "committed"), the existing legend and "The same numbers as a table" disclosure. Copy kept from `FundAllocation.tsx:178-182`.

**Right — "The policy, in one breath":** the three inputs sentences of `FundConstruction.tsx:226-265` rendered as prose with the figures bold — "A **$30M** fund, charging **2%** a year over **10** years, with **$1M** of expenses — **$24M** investable." · "Split **70%** early stage ($16.8M) / **30%** secondaries ($7.2M), with **40%** of the early-stage sleeve held in reserve ($6.72M)." · "**Twenty** companies at **$500K–$750K** each, in AI, future of work, healthcare, education and consumer." Then the affordability line as it exists (`:319-334`, `.notice-ok`/`.notice-gate`): "20 companies at $500K–$750K needs $10M–$15M of initial capital, and there is $10.08M. Affordable at the bottom of the range with $80K to spare, but not at the top of it." Then `Amend the construction` (`.btn-strong`, `aria-expanded`, `aria-controls`) and the `.version-rail` (v1 · current · effective 18 Aug 2026).

**Amend, 8 states** (artboard E): closed · hover · focus-visible · **open** — the tray is the existing editor's three sentence-inputs, sector chips (`.chip[aria-pressed]`), the "What that works out to" `.figs` table recomputed live, the affordability line, "Why you changed it", `Save as a new version` disabled until the reason is typed, `Never mind` · **invalid** — `checkMinK > checkMaxK`: `aria-invalid` on the field, the helper becomes the instruction (the existing copy "The smallest cheque is larger than the largest. Swap them."), the affordability line refuses to cost it · **disabled+reason** — the 403 branch (`:190-201`) as a disabled button with its sentence beside it · **saving** — `aria-busy`, "Saving…" · **error** — the existing partial-save copy (`:176-178`) as `.notice-bad`, plus which write was refused · **success** — the existing copy (`:180`) as `.notice-ok`, the tray closes, the rail gains v2, and the deck band below turns amber naming what moved.

### 3.4 Band 4 · The deck — what the firm sends

`DeckPanel` as a band, its copy kept. Current version row (title · `badge-ok v[N] · [P] pages` · uploaded by · when) with `Preview` and `Open on Documents`; the staleness line (`/api/deck` `staleness.headline`, `.notice-ok`/`.notice-gate` with the drift list); "Waiting on your decision" (proposed versions with `Approve` `.btn-strong` and `Send back` + reason, exactly `DeckPanel.tsx:277-330`; a `.count-pill` on the band head when one waits — the only other orange on the page, and only when a human is waited on); `Upload a PDF` · `Rebuild it from the records` (Preston's card); "Every version" disclosure = the history list. Values are `[TO CONFIRM]` on the artboard: the repo carries no deck version; production does.

### 3.5 Band 5 · What the reserves are for

Three figures (`.kv` at `--text-xl`): Held in reserve $6.72M (`reserveUsd`) · Drawn by follow-ons $0 (`reserve_allocation`, `/api/allocation/reserve-allocations`) · Headroom; a `.bar`; the rationale sentence from `reserve_json.rationale` (the seed's "Pre-seed reserves are how ownership survives the Series A…"). "Follow-on reviews": `/api/follow-on` `reviews` + `pending_count` as rows, or the empty state that points at Portfolio's "Which way each company is moving"; `Pulling ahead → Portfolio`. Footnote: per-company reserves (`position_reserve`, proposed in the Deals spec §6) subtract from the headroom once they exist.

### 3.6 Band 6 · Scenarios — what the next cheque does to the shape

`/api/allocation/scenarios` as `.deal-row-2` rows (name · status · pinned versions · breaches · Open), or the empty state; `Open a scenario` (`.btn-strong`, `aria-expanded`) reveals an inline form with two fields: Name, and *Investable after fees* prefilled from `sleeve.estimated_investable_usd` ($24M) with the help text "The one figure the system will not work out for you — there is no fee model on file." Submit: `Pin the versions and open it` — pins `current` of the four policy kinds, reads `fund_size` and `fund_deployed` from `/basis` (after the §1 #7 fix). The scenario detail (assumptions, options, run, breaches) keeps today's content as the row's open body — out of this pass's artboards, in the build order.

**What is gone:** `CockpitPage`, `Composition`, `STRATEGY_STEPS`, the second `FundPicker`, "Why the two agree", the follow-on candidates list. Nothing is deleted from the repo: `CockpitPage` stays mounted where Portfolio uses its data; `Composition` stays on Portfolio.

---

## 4 · Data, per band (route · table · new)

| Band | Reads today | Would be new |
|---|---|---|
| Masthead | `GET /api/funds` · `GET /api/funds/:id/policies/{mandate,sleeve,reserve}` (`current`) → `planSlices` · `GET /api/portfolio/allocation?fund_id` (`deployment.deployed`, `companies`) | — |
| Door | `DASHBOARD_URL` (`ModelingPage.tsx:30`) · mandate + reserve `current` | — (clipboard is client-side) |
| Plan vs reality | `planSlices` · `/api/portfolio/allocation` · `/api/allocation/reserve-allocations` (drawn) | **`fund.first_close_on`** (one column; written from LP when the first `SIGNED` commitment lands, or typed) · **`deployment.timeline[]`** on `/api/portfolio/allocation` — `(transaction_date, cost_basis)` per executed purchase, for the actual line · **`deployment.secondaries_deployed`** — positions whose transaction is a secondary purchase · fees paid to date has no source: stays "not recorded" until a fee ledger exists |
| Construction | the three policy routes; `POST /api/funds/:id/policies/:kind` (new version) · 403 for non-MP | — |
| Deck | `GET /api/deck` · `POST /api/deck/versions` · `POST /api/deck/versions/:id/decide` | — |
| Reserves | `reserveUsd` · `/api/allocation/reserve-allocations` · `GET /api/follow-on` | `position_reserve` (Deals spec §6) once Portfolio writes it |
| Scenarios | `/api/allocation/scenarios` · `/api/funds/:id/basis` | `basis` falls back to `mandate.target_size_usd` when `fund.target_size_minor` is null (§1 #7) |

---

## 5 · New classes (all tokens; the artboards' `<style>` below the verbatim `:root` is exactly this)

`.door`, `.door-head`, `.door-lede`, `.door-answers`, `.door-actions`, `a.btn-primary`/`a.btn-strong` (the button hierarchy on an anchor — links styled as buttons did not exist), `.figures`, `.pace` + `.pace-key`, `.gap-rows` (+ `.gap-label`, `.gap-delta`, `.to-confirm`), `.policy-lines`, `.construct-line`, `.amend-tray`, `.sector-chips`, `.actions`, `.deck-row`, `.deck-title`, `.headroom`; phone rules under `@media (max-width: 40rem)` for `.door`, `.figures`, `.headroom`, `.gap-rows`, `.deck-row`, `.two-col`. Register them in `design/DEALS_SECTION_CLASSES.json` for `validate:css-classes` and the heading-scale selectors with `scripts/validate/heading-scale-applies.mjs`. Retire nothing until the page stops emitting it (`.construction-inputs`, `.construction-line`, `.construction-why`, `.quiet-hours*` on this page, `.thesis-grid` in `ModelingPage`).

---

## 6 · Pre-emit self-critique (Hallmark axes P·H·E·S·R·V, 1–5; nothing < 3 shipped)

| Artboard | P | H | E | S | R | V | Revised before emit |
|---|---|---|---|---|---|---|---|
| A · page, desktop | 5 | 5 | 4 | 5 | 4 | 4 | "today" label collided with the origin label on the pace chart — lifted onto a tick; two link-buttons at 22px became real buttons |
| B · page, phone | 5 | 5 | 4 | 5 | 4 | 4 | chart given its own 340-unit geometry (12px labels at 390, not 8px); gap rows reordered label → delta → bar; the notice's button stacks under its sentence |
| C · door states | 5 | 5 | 4 | 5 | 5 | 4 | — |
| D · plan band states | 5 | 5 | 4 | 5 | 4 | 5 | — |
| E · Amend states | 5 | 5 | 4 | 5 | 4 | 4 | three labels shortened so no clickable wraps at 320 ("Rebuild it from the records", "Pulling ahead → Portfolio", "Every version") |

E is 4 for the reason the Deals spec records: Inter is not downloaded in the product, so the boards render in the platform face where Inter is absent.

## 7 · Mobile verification (measured, not asserted)

Every board rendered in headless Chromium (Playwright from the worktree's `node_modules`) at its declared width, the phone board again at **320 / 375 / 414 / 768**, and the desktop board's markup at 320/375 to prove the CSS alone holds without the `.phone` helper rules. Assertions: root `scrollWidth ≤ clientWidth`; no element's right edge past the frame (excluding `.table-scroll`/`.figs`, the declared inner scrollers); no `<button>/<a.btn-*>/.chip/summary` whose text spans two line boxes; no control under 24×24. **Result: 11/11 renders — 0 overflow, 0 wrapped clickables, 0 small controls** after the fixes in §6. Heights on the canvas are the measured natural height + 24px.

## 8 · Accessibility

`h2` answer · `h3` band · `h4` panel; every act is a `<button>` or `<a href>`; the door link carries an `aria-label` naming the destination and the new tab; Amend and Open a scenario use `aria-expanded` + `aria-controls`; the invalid cheque range is `aria-invalid` with `role=alert` on the instruction; the chart and the ring are `role=img` with sentence labels and the numbers repeated in words beside them; every colour state has a word (behind the plan · not recorded · sleeve untouched · Copied); focus is the global ring, painted instantly; the only motion is the 90ms colour transition, collapsed by the existing reduced-motion rule; 44px targets on phone (`--touch-min`), 34px controls on desktop.

## 9 · Build order

1. **`styles.css`** — the §5 classes and the register entries (one agent, tokens only).
2. **`FundStrategyPage`** — masthead + band skeleton; drop `CockpitPage`, `Composition`, `STRATEGY_STEPS`, the second `FundPicker`; rewrite `pagePurpose.ts:126-135`.
3. **The door** — `ModelingPage` becomes the band (link + copy + six figures); `Copy` = `navigator.clipboard.writeText`.
4. **Plan vs reality** — new component reading `planSlices` + `/api/portfolio/allocation`; `first_close_on` migration (slot assigned by the coordinator), `timeline[]` + `secondaries_deployed` on the allocation route, LP writes `first_close_on`.
5. **Construction** — `FundConstruction` splits into read view + Amend tray; states as artboard E.
6. **Reserves band**, **Scenarios rows** + basis fallback (§1 #7).
7. **Guards** — extend the Deals Playwright spec to `#/fund-strategy` (0 overflow at four widths, 0 wrapped clickables, 0 targets < 24px; must assert ≥1 element examined); a `validate:*` that fails if `Composition` or `CockpitPage` is mounted under `fund-strategy` (the split is a rule, so something must read it); `validate:portfolio`'s one-ring rule already covers the ring.

## 10 · Approval questions (only she can answer)

1. **Orange goes to the door.** The Deals pattern gives the page's one `.btn-primary` to the human act; on this page the act she named is leaving to model, so `Open the dashboards` is the orange button and the deck's Approve stays black. Yes — or should Approve keep orange and the door be a large black button?
2. **Monitoring leaves Fund strategy entirely.** Top risks, Deteriorating, Improving, Stale or missing, Support asks and the composition bars appear only on Portfolio. Confirm nothing from them should survive here as a summary line.
3. **Record a first-close date.** The pace chart needs one and the fund does not carry it; the design adds `fund.first_close_on` (set from LP when the first signed commitment lands, or typed once). Alternative is to draw the pace from vintage 2026 — honest but blunt. Record it?
