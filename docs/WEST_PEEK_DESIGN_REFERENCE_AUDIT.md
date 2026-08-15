# West Peek Design Reference Audit — D1

Evidence gathered 2026-08-13, before any design mutation, for the approved West Peek OS design
overhaul (`TASK/APPROVED_TASK.md`, phases D1–D5).

This document records **what was measured and read**, not what was hoped for. Every number below
came out of a browser or a file. Where something was not proven, it says so.

---

## 1. What actually ran

| Evidence source | Status | Where |
|---|---|---|
| Hallmark evidence pack (`~/repo-tools/active/run_hallmark_audit.sh` v1.3.0) | **RAN** — `--self-test` PASSED first (5/5), then `--mode full --brand-preserve` against a read-only git mirror of the baseline, with browser capture against local `wrangler dev` | `~/hallmark_audits/west-peek-os_PRE_DESIGN_BASELINE/` · pack SHA-256 `978dc35e8a7479830dabb76e4f5ead14f280b2c8509b3d14252bb12baa81ba49` |
| Hallmark reference authority bundle | **READ** — SKILL.md, `contract.md`, `anti-patterns.md`, `slop-test.md` (69 gates), `color.md`, `typography.md`, `layout-and-space.md`, `interaction-and-states.md`, `responsive.md`, `genres/modern-minimal.md`, `verbs/audit.md` | bundle SHA-256 `5fd8800b92c5df211725642306d0447a3687dd0fbab35b9ce3c9d3346cef4809` |
| Per-surface browser measurement of the live app | **RAN** — all **29** nav surfaces × **3** viewports (1440×900 / 834×1112 / 390×844) = **87 measured surface-states**, authenticated as `scooter@westpeek.ventures` against local `wrangler dev` | `/tmp/wpos-audit/baseline/{measurements,summary,probe}.json` + 87 full-page screenshots |
| `seq23/westpeek-live` | **READ (read-only, `gh api` GET only)** — `WEST_PEEK_BRAND_SYSTEM.md`, `app/globals.css`, `public/brand/wp-mark.svg`, brand validator | no write, no branch, no PR, no issue, no tag |
| `seq23/west-peek-network-os` | **READ (read-only)** — `WEST_PEEK_BRAND_SYSTEM.md`, `src/styles.css` (416 lines), `scripts/validate-west-peek-brand-system.mjs` | as above |
| `seq23/west-peek-community` | **READ (read-only)** — `shared/assets/base.css` (227 lines), site HTML inventory | as above |
| `seq23/west-peek-pitch-lab` | **READ (read-only)** — `WEST_PEEK_BRAND_SYSTEM.md` (canonical brand authority), `src/styles.css` (439 lines) | as above |

**Not proven / not run.** The Hallmark runner's own browser step captured only `/`, because West Peek
OS is a single-route SPA whose 29 surfaces are selected by client state rather than by URL — the
runner navigates by route and there is only one. The per-surface evidence therefore comes from the
purpose-built harness listed above, which drives the real nav in the real browser. No production
West Peek OS instance was contacted; `https://west-peek-os.seq-taylor.workers.dev/` was **not**
opened, and this task does not authorize deployment.

---

## 2. Observed reference patterns — the West Peek family language

All four reference repos carry the same canonical authority file, `WEST_PEEK_BRAND_SYSTEM.md`,
marked **CANONICAL / LOCKED**. Three of the four ship a `validate-west-peek-brand-system.mjs` that
enforces it in CI. The family is not a mood; it is a written, validated contract.

### 2.1 The locked palette (from `WEST_PEEK_BRAND_SYSTEM.md`)

| Token | Value | Approved use |
|---|---|---|
| West Peek Orange | `#F05A1A` | primary CTAs, active states, key metrics, selected controls, accent borders, small emphasis |
| Black / near-black | `#050505` / `#171717` | navigation, high-authority shells, strong-contrast areas |
| White | `#FFFFFF` | primary content surfaces, cards, inputs, tables |
| Warm off-white | `#F7F2EA` | page backgrounds, section separation, reduced visual fatigue |
| Soft orange tint | `#FFF1E9` | selected states, notices, focus treatment |

Governing rule, quoted: **"Orange is an accent, not the entire interface."** The document also
states the product "must remain black/white first", bans large orange fills and promotional
gradients, requires status semantics to keep accessible red/amber/green, and explicitly bans
"generic blue, purple, indigo, violet, or cyan" as a primary brand colour.

### 2.2 What the two operating apps actually implement

`west-peek-network-os/src/styles.css` and `west-peek-pitch-lab/src/styles.css` are the closest
family analogues to West Peek OS — real authenticated operating apps, not marketing pages. Both
converge on the same concrete decisions:

| Decision | Network OS | Pitch Lab | westpeek-live |
|---|---|---|---|
| Accent | `--wp-orange: #f05a1a` | `#f05a1a` | `--brand-orange: #f05a1a` |
| Accent for small text | `--wp-orange-dark: #b84412` | `#a93e0c` | — |
| Shell / nav surface | `--wp-black: #070707` (black sidebar) | `--wp-black: #050505` | `#050505` |
| Body ink | `--wp-ink: #16130f` (warm near-black) | `#15120f` | `#050505` |
| Page background | warm paper `#fbf3ea` | `#f5efe6` → `#fffaf4` | `--brand-ash: #f5f3ef` |
| Content surface | white / near-white card | white | white |
| Muted text | `#756d64` | `#6a625b` | `--brand-muted: #73706a` |
| Hairline | `#e3d8cc` | `rgba(21,18,15,0.12)` | `--brand-line: #e7e3dc` |
| Semantic triad | good `#207348` · warn `#965500` · danger `#9c241b` | — | — |
| Typeface | Inter, then system fallbacks | Inter, then system fallbacks | Inter |
| Active nav state | `background: rgba(240,90,26,.16)` + `box-shadow: inset 3px 0 0 var(--wp-orange)` | orange-tinted hover/active | — |
| Eyebrow / kicker | uppercase, `letter-spacing: .14–.18em`, 12px, orange-dark | uppercase, `.15em`, `.72rem`, orange-dark | — |
| Focus ring | — | `outline: 3px solid rgba(240,90,26,0.38); outline-offset: 3px` | — |
| Primary button | black fill, white text (`.btn.dark`) / orange fill for attention | black fill, white text | — |
| Secondary button | white fill, hairline border | white fill, hairline border | — |

The recurring, load-bearing family signature is therefore: **a black shell around warm-paper content,
white surfaces, warm near-black ink, one orange, an orange left-rail on the active nav item, an
uppercase orange-dark eyebrow, and Inter.**

`west-peek-community/shared/assets/base.css` is the public marketing property and inverts the
surface (near-black `#0b0b0c` page, white text, white primary buttons). It is the same brand in a
different register. Note one honest discrepancy: it uses `#ff7a00` / `#ff8500`, which the family's
own brand validator lists as a **stale** orange token. Canonical is `#F05A1A`; the marketing repo is
the outlier, so it was not treated as authority for the accent value.

### 2.3 The approved brand mark

`seq23/westpeek-live/public/brand/wp-mark.svg` is the approved repository asset: a `#050505`
rounded square, white `WP` monogram in Inter 900, and a single `#f05a1a` dot. The brand authority
says do not fabricate a substitute mark, so this asset is adopted **byte-identical** rather than
redrawn.

---

## 3. Target-app problems — measured, not asserted

Baseline = West Peek OS as it stood before this task: `src/client/styles.css` (341 lines),
`src/client/App.tsx` (3,146 lines), 11 page modules, 29 nav surfaces.

### 3.1 The palette is off-brand

| Baseline value | Where | Problem |
|---|---|---|
| `#101418` body background (measured `rgb(16, 20, 24)`) | `styles.css:8` | blue-slate, not black. Not a West Peek surface. |
| `#161c22` card, `#2a323b` line, `#22303c` button/active-nav | `styles.css` throughout | a cool blue-grey ramp — the "gray-card soup" the task names |
| `#7fa8c9` link colour | `styles.css:146` | **generic blue as the interactive colour** — explicitly banned by the family brand authority |
| `#6b5b95` private-panel rail | `styles.css:241` | purple — also explicitly banned |
| `#F05A1A` | **absent** | the canonical West Peek orange appears **nowhere** in the product |

The product currently has **no brand relationship to the West Peek family at all**. That, not
polish, is the headline finding.

### 3.2 Navigation does not survive its own length

Measured on desktop at 1440×900: the primary nav is **29 items in one flat ungrouped list**,
`217px` wide and **`1624px` tall inside a `900px` viewport**, and the nav element does **not** scroll
independently (`scrollHeight === clientHeight`; the *document* scrolls instead).

Consequences, all reproducible: twelve destinations sit below the fold; scrolling a long surface
scrolls the operator's own wayfinding off-screen; and there is no grouping to tell an operator that
"Approvals" and "Work Cards" are the same job while "LP" and "Reporting" are another.

### 3.3 Responsive: six real overflow failures

`document.documentElement.scrollWidth − window.innerWidth`, measured per surface:

| Viewport | Surface | Overflow |
|---|---|---|
| tablet (834) | **Activity** | **+287px** (document 1121px wide) |
| tablet (834) | AI Ops | +53px |
| mobile (390) | LP | +45px |
| mobile (390) | Reporting | +42px |
| mobile (390) | Research | +41px |
| mobile (390) | Allocation | +3px |

The tablet failures are a gap in an earlier repair: the generation-2 review fixed wide-table
overflow inside `@media (max-width: 720px)` only, so at 834px the institutional tables still push
the whole document sideways. Tablet was never measured before this audit.

### 3.4 Touch targets are unusable one-handed

At 390×844, **1,212** interactive elements across the 29 surfaces fall below the 44px touch floor —
on several surfaces that is *every* control (Machines 80/80, Notifications 65/65, Work Cards 48/48).
The smallest are 13–17px: the `.link-button` pattern (`Sign out`, `15 unread`, per-row drill-through
links) is bare underlined text with no padding at all. The task names mobile capture, approve/reject,
and notifications as critical flows; they are currently thumb-hostile.

### 3.5 No focus treatment exists

`styles.css` contains **no `:focus`, `:focus-visible`, `:hover` beyond nav, `:active`, or
`:disabled` rule for any control other than `button:disabled { opacity }`**. Tabbing through the
shell, the browser paints its user-agent default: `outline: 1px auto rgb(153, 200, 255)` with
`outline-offset: 0` — a 1px light-blue system ring, off-brand and easy to lose on a dark surface.
Hallmark slop-test gate 28 (eight states) and gates 41–45 (input states) fail outright: no input has
a designed focus, error, or disabled treatment, and `disabled` is signalled by opacity alone.

### 3.6 There is no type scale, spacing scale, or radius scale

Measured on Home: **13 distinct computed font sizes** (`11.52 · 12.48 · 13.12 · 13.33 · 13.6 · 14.4 ·
15.2 · 15.68 · 16.8 · 16 · 18.72 · 20 · 24 px`). These are not a scale — they are em-multiplication
accidents from nested `font-size: 0.82rem` declarations. `h1` (20px) is *smaller* than `h2` (24px).
Four ad-hoc radii (4 · 6 · 8 · 10px). Padding values are hand-picked per rule
(`0.35rem 0.5rem`, `0.75rem 1rem`, `0.5rem 0.75rem`). Hallmark gate 26 (off-scale spacing) and gate
58 (token improvisation) both fail: every colour in the file is a raw hex, and there is no token
block at all.

### 3.7 Measure and density

`.shell-main` has `max-width: none`. On a 1440px display, prose and definition text run the full
~1,200px content width — far outside the 45–75ch band Hallmark gate 27 requires, and hard to read in
the long explanatory paragraphs these governance surfaces depend on.

### 3.8 What is already right (and must not be broken)

Honest counterweight — the baseline is not bad work, it is *unstyled* work:

- **Contrast passes.** Across all 87 measured surface-states, **zero** text nodes fell below WCAG AA
  for their size. The dark theme is legible; it is simply not West Peek.
- **Semantics are sound.** Nav is a real `<nav aria-label="Primary">` with a `<ul>` of real
  `<button>`s; tables are real `<table>` elements; the login is a real `<form>`.
- **State honesty is already a discipline.** `stateMessage()` in `lib/api.ts` gives every surface an
  explicit loading / error / empty string rather than an ambiguous blank. That convention is a design
  asset and the overhaul should amplify it, not replace it.
- **No fabricated data.** Gate 56 passes: the surfaces show real governed state or say plainly that a
  layer is UNPROVEN behind a named gate. Nothing invented a KPI to look impressive.
- **Zero console errors** were recorded at any viewport.

---

## 4. Hallmark slop-test disposition for an operating shell

The 69 gates were written primarily for pages. Applying them honestly to an authenticated OS means
naming which bind and which do not:

**Binding, and failing at baseline:** 24/26 (off-scale spacing, no tokens), 27 (measure), 28 (eight
states), 36 (horizontal scroll — six failures), 41–45 (input states), 46–50 verified *passing*, 58
(token improvisation — every colour is a raw hex), 59 (clickable text wrapping), 60 (verified
passing — no emoji icons), 62 (`overflow-x: clip` absent).

**Binding and already passing:** 1 (display font — the baseline uses a system stack, which the gate
flags; resolved in D2 by adopting the family's Inter with a system fallback), 2/5 (no gradients), 4
(no nested cards), 11–15 (no transitions or hover-scales exist at all), 20 (no placeholder names),
56 (no invented metrics), 57 (no re-drawn chrome).

**Page-scope, not applicable to an authenticated operating shell:** 3, 6–10, 21–23, 30–35, 37,
51–55, 66–69 (hero enrichment, macrostructure diversification, footer archetypes, marketing nav
fingerprints, `study` DNA). An OS has one shell and one nav; rotating its macrostructure between
releases would be a defect, not variety. This is recorded rather than silently skipped.

Genre, for the record: **modern-minimal** (enterprise / dashboard / B2B), with the catalog theme
displaced by the locked West Peek family DNA — per SKILL.md §2.6, an externally-supplied system
overrides catalog rotation.

---

## 5. Proposed design principles for West Peek OS

Derived from §2 (family) and §3 (measured defects), in the task's own source hierarchy order.

1. **Black shell, warm-paper work surface, one orange.** The chrome (rail, header) is West Peek
   black; the work surface is warm paper with white panels. Orange is reserved for: the active nav
   rail, the single primary action on a surface, focus, and selected state. Nothing else.
2. **Orange never carries meaning that safety needs.** Approved / blocked / breached / gated keep
   green, red, amber, and neutral. Orange means *attend to this*, never *this is fine* or *this is
   broken*.
3. **Grouped, always-visible navigation.** 29 destinations become labelled groups that fit a laptop
   viewport, in a rail that scrolls independently of the work surface. Every label stays a visible
   button — grouping must not hide a destination behind a disclosure.
4. **Governance state is visual, not textual-only.** Approval gates, UNPROVEN layers, privacy
   labels, and reserved actions are the product's reason to exist; they get a consistent, legible
   badge vocabulary instead of being buried in sentence text.
5. **Density is a feature; illegibility is not.** Institutional tables stay dense (tabular numerals,
   right-aligned money, uppercase micro-headers) but scroll *within themselves* at every width below
   the desktop breakpoint — never sideways-scrolling the document.
6. **Every control has eight states.** default · hover · focus-visible · active · disabled · loading ·
   error · success, from tokens, with an instant (never animated) 2px orange focus ring.
7. **Mobile is a different job, not a smaller desktop.** 44px minimum target, single-column, the
   critical flows (capture, approve/reject/defer, notifications) reachable without horizontal
   movement.
8. **Tokens are the only source of colour, type, space, and radius.** No raw hex outside the token
   block — enforced by a validator, in the family's own convention.
9. **Honest states stay honest.** The existing loading / error / empty discipline is kept and given a
   designed treatment; empty states say what the operator can do next.

---

## 6. Patterns intentionally NOT copied

Read in the references, deliberately rejected for the OS, with the reason:

| Pattern seen in family | Where | Why it is not carried into the OS |
|---|---|---|
| Marketing display type — `h1: clamp(3rem, 6.8vw, 6.7rem)`, `clamp(44px,7vw,82px)` | pitch-lab, network-os | oversized marketing typography inside operating screens is named in the task's avoid-list; an OS header is wayfinding, not a headline |
| `backdrop-filter: blur(12–18px)` on cards and headers | network-os, pitch-lab | glassmorphism — banned by the task, by Hallmark modern-minimal, and it costs legibility over dense tables |
| `radial-gradient(circle at top left, rgba(240,90,26,.12) …)` page washes | network-os, pitch-lab, westpeek-live | gratuitous gradient; also pushes accent footprint past Hallmark gate 25's ~5% and makes orange ambient rather than meaningful |
| 22–30px card radii, `999px` pill buttons everywhere | network-os, pitch-lab | "excessive rounded pills" in the task's avoid-list; large radii waste horizontal room in dense tables. The OS uses a 2/4/6/10px scale |
| `box-shadow: 0 22px 60px …`, `0 28px 80px …` | network-os, pitch-lab | excessive shadows; the OS separates surfaces with hairlines and one 1px-lift shadow for overlays only |
| `.btn:hover { transform: translateY(-1px) }` on every button | pitch-lab | Hallmark gate 14 (multiple simultaneous hover effects) and 12 (uniform hover-motion); a lift on a dense table row reads as instability |
| Dark marketing surface (`#0b0b0c` page, white text) | community | that register belongs to the public site; the OS follows the *operating-app* half of the family (black shell / paper work surface), which the brand authority names as the product rule |
| `#ff7a00` / `#ff8500` orange | community | stale token per the family's own validator; canonical is `#F05A1A` |
| `font-weight: 800–900` on body labels, forms, and nav | network-os, community | at operating density this reads as shouting; the OS caps UI weight at 600 and uses 700 only for headings and numerals |
| Business logic, data models, routes, components | all four | out of scope by the task; only visual language was taken |

---

## 7. What this audit does not claim

- No production instance was inspected. No deployment occurred.
- No reference repository was modified in any way — reads were `gh api` GETs against
  `repos/…/contents` and `…/git/trees`; no commit, branch, PR, issue, tag, release, or workflow was
  created in any of the four.
- The Hallmark **runner** produced an evidence pack and pinned the authority; it did not, and by its
  own truth-boundary statement cannot, perform the review. The findings in §3 are measurements plus
  a review conducted against the bundled authority.
- Accessibility here means measured contrast, focus, and target size. It is **not** a claim of WCAG
  conformance, and no assistive-technology testing was performed.
