# West Peek OS — Design System

**The implementation is authoritative.** Everything below describes what `src/client/styles.css`
and the client actually do. Where a rule is aspirational or unenforced, it says so. Where a
Hallmark or accessibility guideline was deliberately declined, the reason is recorded rather than
quietly skipped.

Parent authority: `WEST_PEEK_BRAND_SYSTEM.md` at the repo root — the CANONICAL / LOCKED West Peek
brand contract, byte-identical (SHA-256 `6b8e3c0a33b6ff22c34a5713181f28066d0255006c9d24b4e66b33936125f589`)
to the copy carried by `seq23/westpeek-live`, `seq23/west-peek-network-os`, and
`seq23/west-peek-pitch-lab`. Evidence and reasoning: `docs/WEST_PEEK_DESIGN_REFERENCE_AUDIT.md`.
Enforcement: `npm run validate:brand`.

---

## 1 · Brand principles

1. **Black shell, warm-paper work surface, one orange.** Authority is black. Work happens on warm
   paper with white panels. Orange is the accent and never the field.
2. **Orange is reserved.** It appears in exactly five places: the active-nav rail, the single
   primary action of a decision region, the focus ring, inline drill-through links, and the skip
   link. It is never a page wash, never a card fill, never a status. A sixth — a branded
   `.badge-accent` for a selected state — was written and then removed: no surface in this product
   has a selection that needed it, and an unused accent is an invitation to spend the accent.
3. **Orange never carries safety meaning.** Approved, blocked, gated, and breached keep green,
   red, amber, and neutral. An operator must never have to ask whether orange means "good".
4. **Density is a feature.** These are institutional screens. Tables stay dense, numerals are
   tabular, money is right-aligned. Legibility is bought with hierarchy and rules, not with air.
5. **Governance state is visible.** Approval state, gate state, privacy label, and UNPROVEN layers
   get a consistent badge vocabulary. The product's reason to exist is not buried in prose.
6. **Every control has eight states.** default · hover · focus-visible · active · disabled ·
   loading · error · success — from tokens, never improvised.
7. **Mobile is a different job.** Not a squeezed desktop. Grouped sheet navigation, 44px targets,
   single column, no sideways scrolling of the document.
8. **Tokens are the only source of colour, type, space, and radius**, and a validator enforces it.

---

## 2 · Colour tokens

Every value below is declared in the `:root` block of `src/client/styles.css`. Nothing else in the
client declares a colour — `validate:brand` fails the build if it does.

### Brand

| Token | Value | Use |
|---|---|---|
| `--wp-orange` | `#f05a1a` | the one accent: active nav rail, primary action, focus ring, selected |
| `--wp-orange-strong` | `#d64e10` | hover / pressed on an orange **fill** — measured 4.67:1 against `--wp-orange-ink` |
| `--wp-orange-deep` | `#b4400f` | orange as **text** — measured 5.71:1 on white, 5.12:1 on paper |
| `--wp-orange-deeper` | `#8f3309` | hover on orange **text** — measured 7.19:1 on the tint |
| `--wp-orange-ink` | `#0a0a0a` | text **on** an orange fill — 6.2:1 |
| `--wp-tint` | `#fff1e9` | soft orange tint: selected rows, the one-thing-to-watch banner |
| `--wp-tint-line` | `#f4d3bf` | border of a tinted surface |

**`--wp-orange-ink` is near-black, not white, and that is load-bearing.** White on `#f05a1a`
measures 3.40:1 — below the 4.5:1 body-text floor. Near-black measures 6.2:1. Hallmark slop-test
gates 48 and 49 exist for exactly this mistake; the family's own operating apps make the same
choice (`.btn.primary { background: var(--wp-orange); color: var(--wp-black) }`).

**Fill-hover and text-hover are separate tokens, and that is also load-bearing.** One token did both
jobs at first, and it was wrong in both directions: as a fill it measured 4.46:1 against the button
label (below the 4.5 floor), and as link text it made a hovered link *lighter* — 4.44:1 on white,
worse than its resting 5.71:1. A hovered fill darkens just enough to stay legible
(`--wp-orange-strong`); hovered text darkens properly (`--wp-orange-deeper`). Both are measured by
`e2e/d1-design-states.spec.ts`, not asserted here.

### Shell (black)

| Token | Value | Use |
|---|---|---|
| `--wp-shell` | `#050505` | the rail and the mobile top bar. Nothing else. |
| `--wp-shell-2` | `#141110` | raised surface inside the shell (nav hover, active row) |
| `--wp-shell-3` | `#221d19` | pressed inside the shell |
| `--wp-shell-ink` | `#f6f1ea` | primary text on the shell |
| `--wp-shell-ink-max` | `#ffffff` | the shell's brightest ink — active nav label only |
| `--wp-shell-ink-2` | `#b9b0a5` | secondary text on the shell (group labels, identity) |
| `--wp-shell-line` | `#2b2521` | divider inside the shell |

### Work surface

| Token | Value | Use | Measured contrast |
|---|---|---|---|
| `--wp-paper` | `#f7f2ea` | page background | — |
| `--wp-surface` | `#ffffff` | panels, cards, tables, inputs | — |
| `--wp-surface-2` | `#fbf8f3` | table head, row hover, inset blocks | — |
| `--wp-surface-3` | `#f1ece4` | pressed / disabled fill | — |
| `--wp-ink` | `#15120f` | primary text | 18.7:1 on white |
| `--wp-ink-2` | `#4a443e` | secondary text, labels, table head | 9.6:1 on white |
| `--wp-ink-hover` | `#2c2620` | hover on an ink fill | — |
| `--wp-muted` | `#6b635b` | captions, empty states | 5.9:1 on white |
| `--wp-line` | `#e4ddd2` | hairline between rows and panels | decorative |
| `--wp-line-strong` | `#cdc4b7` | emphasis divider, dashed empty rule | decorative |
| `--wp-line-control` | `#9a9086` | the border of a real control | 3.1:1 on white |

`--wp-line-control` is deliberately darker than the hairline: WCAG 1.4.11 requires 3:1 for the
boundary that identifies a control. `--wp-line` and `--wp-line-strong` are decorative separators and
are not held to that floor.

### Semantics — and the orange rule

| Token | Value | Meaning |
|---|---|---|
| `--wp-good` / `--wp-good-tint` / `--wp-good-line` | `#1f6b45` / `#e9f2ec` / `#b9d5c6` | approved · active · executed · healthy |
| `--wp-warn` / `--wp-warn-tint` / `--wp-warn-line` | `#8a5200` / `#fdf2df` / `#e7cf9f` | **a named gate stands in front of this** — pending review, UNPROVEN, credential gate |
| `--wp-danger` / `--wp-danger-tint` / `--wp-danger-line` | `#97231b` / `#fbebe9` / `#e7bdb8` | rejected · blocked · breach · destructive |
| `--wp-neutral-tint` | `#f1ede7` | a fact with no valence |

Green 6.5:1, amber 6.4:1, red 8.2:1 against white. Orange is **not** in this table and never
substitutes for a member of it.

### Scroll affordance

`--scroll-shadow-cover` and `--scroll-shadow-edge` are the only gradients in the system. They are
functional: they are the only signal that a clipped institutional table has more columns to the
right. They are pinned per side, so the shadow shows only where content is actually hidden.

### Banned

Generic blue, cyan, indigo, violet, and purple may not be product colours. `validate:brand` computes
the hue of every token and fails any hue in 175–330° with real chroma — the rule that would have
caught this repo's own pre-overhaul `#7fa8c9` link colour and `#6b5b95` panel rail. Stale West Peek
oranges (`#ff6a00`, `#f26a21`, `#ff7a00`, `#ff8500`, `#ff8a00`) fail anywhere, including assets.

---

## 3 · Typography

Two families, per Hallmark's 2+1 rule (gates 39–40):

- `--font-ui`: `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
- `--font-mono`: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` — identifiers, action keys, trace ids, hashes

**Inter is not downloaded.** The family's repos name Inter first and fall back to the platform UI
face; this app does the same and adds no webfont request, because an authenticated
Cloudflare-Access app should not add a third-party font dependency for aesthetics. Inter renders
where it is installed; elsewhere the platform face does. That is a real limitation, stated rather
than hidden.

### Scale

| Token | px | Use |
|---|---|---|
| `--text-2xs` | 11 | uppercase micro-labels: table heads, eyebrows, nav group labels, badges |
| `--text-xs` | 12 | captions, status bar, identity line |
| `--text-sm` | 13 | dense table body, secondary rows, buttons |
| `--text-base` | 14 | the UI default |
| `--text-md` | 16 | prose; also the mobile input size (below 16px iOS zooms the viewport) |
| `--text-lg` | 18 | panel titles (`h3`) |
| `--text-xl` | 22 | surface title (`h2`) |
| `--text-2xl` | 28 | the ceiling |

Measured on the built app: **9 distinct computed sizes** across a surface, down from **13 accidental
ones** at baseline. Line heights: `--lh-tight` 1.2 (headings), `--lh-snug` 1.35 (dense lists),
`--lh-normal` 1.55 (body).

**`h1` is 14px and `h2` is 22px, on purpose.** The `h1` is the product wordmark in the rail — a
persistent brand anchor, not a page title. The surface title (`h2`) is what the operator is looking
at and it dominates. This is a deliberate inversion of visual and document hierarchy, recorded here
because it looks like a defect and is not one.

`--text-2xl` at 28px is the ceiling. Marketing-scale display type — the family's public properties
run `clamp(3rem, 6.8vw, 6.7rem)` — is rejected inside operating screens.

---

## 4 · Spacing, radius, elevation, motion

**Spacing** — a 4pt scale, `--space-3xs` (2px) through `--space-3xl` (48px). No padding, gap, or
margin in the stylesheet is off-scale (Hallmark gate 26). Inline `style={{ minWidth: "24rem" }}`
sizing was removed from four components; the `.field-wide` class (`flex: 1 1 22rem; min-width: 0`)
replaces it and collapses correctly on a phone.

**Radius** — `--radius-xs` 2px · `--radius-sm` 4px · `--radius-md` 6px · `--radius-lg` 10px ·
`--radius-pill` 999px (status badges and the nav count only). Small on purpose: at institutional
density, large corners eat column width. The family's 22–30px card radii and universal pill buttons
are rejected.

**Elevation — one level: flat.** `--shadow-none` is the default for every panel, card, and table,
and surfaces are separated by hairlines rather than shadows. An overlay token was declared at first
and then removed: the product has no overlays, so a second level would have been a policy the code
never rendered. The family's `0 22px 60px` / `0 28px 80px` card shadows and `backdrop-filter: blur()`
glass are rejected.

**Motion** — one duration (`--dur-fast` 90ms) and one easing
(`--ease-out: cubic-bezier(0.2, 0, 0, 1)`). A second duration was declared and never used; it was
removed rather than left as decoration. Only `background`, `border-color`, and `color` are
transitioned, and only on nav links, buttons, and inputs. Nothing scales, lifts, bounces, or
overshoots. `transition: all` appears nowhere. `@media (prefers-reduced-motion: reduce)` collapses
every transition and animation to 0.01ms.

---

## 5 · Layout and grid

- `--rail-width` 15.5rem · `--topbar-height` 3.25rem · `--touch-min` 44px · `--measure` 72ch.
- The shell is a flex row: a `position: sticky; top: 0; height: 100vh` rail beside a `min-width: 0`
  work column. **The rail scrolls independently** (`.rail-scroll { overflow-y: auto }`) so that
  scrolling a long surface never scrolls the operator's wayfinding away. Measured: the rail is 900px
  in a 900px viewport, down from 1624px at baseline.
- The surface header is `position: sticky; top: 0` inside the work column. There is exactly one
  sticky-at-top element per column, so nothing bleeds over anything (Hallmark gate 68).
- `p { max-width: var(--measure) }` keeps prose inside the 45–75ch band (gate 27). Tables, tinted
  banners, and panels are exempt — they are data, not prose.
- Above 1600px the header and body cap at 118rem so measure does not degrade on a large display.
- `.module-grid` is `repeat(auto-fill, minmax(min(20rem, 100%), 1fr))` — the `min()` is what stops a
  fixed track minimum from overflowing a 390px phone.

---

## 6 · Navigation

Twenty-nine destinations, seven groups, one rail:

`Command` (Home · Today · Cockpit · Notifications) · `Capture & work` (+Capture · Intent → Execution ·
Work Cards · Approvals) · `Intelligence` (Intelligence · Research · Companies · Contradictions ·
Documents) · `Investing` (Investment · Portfolio · Allocation · Meetings) · `Institutional` (LP ·
Reporting · Network OS · Integrations) · `Workforce` (Employees · Machines · Scheduled Work) ·
`Governance` (Activity · Governance · AI · AI Ops · Diagnostics)

Rules:

- **Grouping labels the navigation; it never hides a destination.** No group collapses, no route
  sits behind a disclosure. Every label is a visible `<button>` — which is also why no existing
  Playwright selector had to change on desktop.
- The active item carries a 3px orange left rail plus `--wp-shell-2` and `aria-current="page"`.
- `NAV_GROUPS` in `App.tsx` is the single source; `NAV_ITEMS` is derived from it. The surface header
  shows the group as its eyebrow, so the operator always knows which part of the OS they are in.
- Below 900px the rail becomes a full-height sheet opened from the black top bar
  (`data-testid="nav-toggle"`, `aria-expanded`, `aria-controls`). Choosing a destination closes it.

---

## 7 · Components

### Buttons — four levels, one primary per decision region

| Class | Treatment | When |
|---|---|---|
| `.btn-primary` | orange fill, near-black text | the single strongest action of a decision region — Approve, Capture, Sign in, the watch banner |
| `.btn-strong` | ink fill, paper text | form commits: issue, record, register, run, set |
| *(default)* | white fill, `--wp-line-control` border | secondary and row actions — Refresh, Request revision |
| `.btn-danger` | white fill, danger border and text; danger tint on hover | Reject and every refusing or destructive action |
| `.btn-ghost` | transparent until hover | tertiary — the four Refresh controls, which only re-read what is already on screen |
| `.link-button` | orange-deep underlined text | inline drill-through inside dense rows |

Destructive actions are visually fenced from the primary: the two never share a fill treatment, and
`Reject` sits at the far end of the row from `Approve`.

All eight states ship: hover and active change `background`/`border-color`; `:focus-visible` paints
the ring; `:disabled` combines `--wp-surface-3` fill, muted text, `opacity: 0.6`, and
`cursor: not-allowed` — three independent signals, not opacity alone (Hallmark gate 45).

**No dead buttons.** Where a control is disabled because the operator lacks the authority, the
surface says so. `ApprovalCard` renders `decision-blocked-<id>`: *"It is reserved for
MANAGING_PARTNER; you hold INVESTMENT_TEAM."*

### Forms

- `.form-row` is a wrapping flex row of `<label>` columns; each label stacks its text above its
  control. Checkbox and radio labels flip to a row and take a 44px minimum height.
- Controls share one 34px base height on desktop and 44px on touch, so an input and its submit
  button are never mismatched (gate 43).
- **Border width never changes between states** (gate 41). Hover moves `border-color`; focus is an
  `outline`, never a border (gate 42); error sets `aria-invalid="true"` → danger border plus danger
  tint.
- **There is no per-field helper slot.** A `.field-help` reservation was written for Hallmark gate
  44 and then removed, because no form in this product renders per-field validation text — results
  are surfaced once, in the surface's own `.notice`. The gate is recorded as not applicable here
  rather than satisfied by a class nothing uses.
- At ≤900px `.form-row` becomes a single stretched column and inputs go to `--text-md` (16px), which
  is what stops iOS from zooming the viewport on focus.

### Panels

`.card` and `.module-card` are white, hairline-bordered, `--radius-lg`, **flat**. Cards are never
nested inside cards. `.panel-head` puts a title and its actions on one baseline; when an eyebrow is
present it stacks directly above the title in the same column, never beside it (gate 66).

`.watch-banner` is the one place a panel takes the orange tint: the single highest-signal item on
Home. `.private-panel` uses an ink left rule — owner-private material reads as a locked drawer, not
as a status.

### Tables and data display

Every `<table>` in the client sits inside `.table-wrap`, which scrolls horizontally within itself
and carries the scroll-shadow affordance. **The document never scrolls sideways.**

- Head cells: `--text-2xs`, uppercase, `--tracking-label`, `--wp-ink-2`, on `--wp-surface-2`, with a
  `--wp-line-strong` bottom rule and `white-space: nowrap`.
- Body cells: `--text-sm`, `vertical-align: top`, hairline row rules, `--wp-surface-2` on row hover.
- `font-variant-numeric: tabular-nums` on the whole table, so figures line up down the column.
- `.num` right-aligns and `nowrap`s a numeric column — applied to money, counts, ids, context
  windows, concentration percentages, and breach counts.
- `.mono` renders identifiers in the mono face at `--text-xs`.
- A row action never wraps: `white-space: nowrap` on buttons inside cells, because a narrow last
  column had squeezed `Open` into a 20px-wide vertical stack at 390px.

### Status vocabulary

`.badge` (neutral) · `.badge-ok` (approved / active / healthy) · `.badge-gate` (**a named gate stands
in front of this**) · `.badge-bad` (rejected / blocked / breach). Four tones, no more: every badge
in the client resolves to one of them. Pill radius, `--text-2xs`, 700 weight, `nowrap`, tinted background with a matching
border so the tone survives on any surface.

`approvalStateBadge()` in `App.tsx` maps approval state to tone, so cockpit, list, and card can never
disagree about what `pending_review` looks like.

### Notices and honest states

- `.notice` and `.notice-gate` — the result of an action, and the statement that a named human or
  credential gate stands in front of a capability. Every `data-testid="*-message"` element carries
  `.notice`; `.notice-gate` carries the VDR/meeting-prep/LP gate statements, the sign-in prompt,
  the MP-reserved governance notice, and the blocked-decision reason. Success and failure tones
  (`.notice-ok` / `.notice-bad`) were written and then removed: the codebase composes its result
  strings inline with no consistent success/failure marker, and sniffing the text to pick a colour
  would mis-tone silently. Neutral and honest beat coloured and wrong.
- `.state-message` — a surface with nothing in it. Dashed box, and the copy says what would put
  something there.
- `.state-empty` — an empty list slot. A dashed left rule and italic muted text, deliberately
  **not** a rounded box: in review it read as a disabled input, and was changed.
- Loading is `Loading…` in the same slot; an error states the HTTP status. A blank is never an
  acceptable state.

Forty-four list empty-states and every surface-level empty got this treatment. Twelve of the
highest-traffic ones were rewritten to say what the operator can do next, e.g. Approvals:
*"Cards arrive here when a reserved action is requested — from a work card, a transaction, an LP
claim, an allocation option, or a policy change. Nothing executes without one."*

---

## 8 · Focus and keyboard

One ring, everywhere: `outline: 2px solid var(--wp-orange); outline-offset: 2px`, on
`:focus-visible` only, **never transitioned** (gate 16). Measured 3.4:1 against paper and 6.0:1
against the black shell — above the 3:1 floor on both.

A `.skip-link` is the first tab stop, jumps to `#wp-surface`, and is 44px tall when revealed. The
rail is a real `<nav aria-label="Primary">` of real `<button>`s; the mobile toggle carries
`aria-expanded` and `aria-controls`. Measured tab order on the built app: skip link → nav (in group
order) → surface header → surface content.

---

## 9 · Accessibility rules — and what is actually proven

| Rule | Status |
|---|---|
| Body text ≥ 4.5:1, large text ≥ 3:1 | **MEASURED** — 0 failing text nodes across 87 surface-states |
| Hover / disabled / placeholder states ≥ 4.5:1 | **MEASURED** — placeholder 5.9:1, primary fill 5.83:1 resting and 4.67:1 hovered, danger 8.16:1 resting and 7.06:1 hovered, link 5.71:1 resting and 7.19:1 hovered, nav hover 16.73:1. Static screenshots never render these; they were driven |
| `:focus-visible` on every interactive element | **MEASURED** — 2px orange ring on every tab stop walked |
| Control borders ≥ 3:1 | by token construction (`--wp-line-control` 3.1:1); not measured per instance |
| No horizontal document scroll, 390–1440px | **MEASURED** — 0 overflow across 87 surface-states |
| Target size ≥ 24px (WCAG 2.5.8 AA) | **MEASURED** — exactly 1 across 87 surface-states: the 20×20 checkbox noted below |
| Target size ≥ 44px on touch | **MEASURED** — exactly 1 at 390px: the same checkbox. 1,212 at baseline |
| Reduced motion honoured | **MEASURED** — under `prefers-reduced-motion: reduce` the nav link's computed `transition-duration` and `animation-duration` are both `1e-05s`. The rule is a `*` selector, so it covers every element |
| Semantic landmarks, roles, `aria-current` | implemented; not exercised by an automated check |

**The 20×20 checkbox exception.** Checkbox and radio inputs render at 20×20, below the 24px floor.
Their `<label>` is the real target and is 44px tall on touch, which is the WCAG 2.5.8 "enclosed"
exception. This is recorded as an accepted, bounded exception rather than reported as a pass.

**This is not a WCAG conformance claim.** No assistive technology was used. No screen-reader,
zoom-to-400%, or colour-blindness simulation was run. What is claimed is exactly what was measured
in a real browser by `/tmp/wpos-audit/capture.mjs` and recorded in the ledger.

---

## 10 · Responsive rules

| Breakpoint | Behaviour |
|---|---|
| ≥ 1600px | header and body cap at 118rem |
| default (desktop / laptop) | 15.5rem black rail + work column; 34px controls; dense tables |
| ≤ 900px (tablet and phone) | rail → full-height sheet behind the top bar; single-column form rows; 44px controls; 16px inputs; `.module-grid` → one column; panel heads stack |
| ≤ 420px | surface and card padding tighten by one step |

The 900px breakpoint is deliberately above the old 720px one. At baseline, tablet was never
measured, and at 834px the wide tables pushed the Activity document 287px sideways.

Critical mobile flows, all exercised at 390×844 in Playwright: capture · approve / request revision
/ reject · notifications · quick intelligence review · employee, machine and job status · portfolio
and LP exception surfaces.

---

## 11 · Interaction rules

- **Strongest action first.** One `.btn-primary` per decision region; commits are `.btn-strong`;
  everything else is secondary. Destructive actions are `.btn-danger` and sit apart.
- **Say why, not just no.** A disabled control that depends on authority names the authority.
- **Predictable placement.** Filters and the refresh control sit in a `.form-row` at the top of a
  surface; row actions sit in the last column; the primary commit ends its form.
- **Progressive disclosure by grouping, not hiding.** The nav groups; the surface header carries the
  group; panels carry their own heads. Nothing material is behind a toggle.
- **Silent success.** Results appear in the surface's own `.notice`; there are no toasts, and no
  celebratory confirmation for an effect the operator can already see.
- **Honesty over polish.** Where a layer is UNPROVEN behind a named gate, the surface says so in a
  `.badge-gate` and in words. No placeholder data, no fabricated metric, no lorem ipsum.

---

## 12 · Examples from the implementation

| Rule | Where it actually lives |
|---|---|
| One primary per decision region | `ApprovalCard` — orange `Approve`, plain `Request revision`, danger `Reject` |
| Disabled controls explain themselves | `ApprovalCard` → `decision-blocked-<id>` |
| Approval state has one tone everywhere | `approvalStateBadge()` in `App.tsx` |
| Tables scroll inside themselves | `.table-wrap` around all six client tables |
| Money and counts read down the column | `.num` in `MachinesPage`, `AiOpsPage`, `CockpitPage` |
| Grouped rail, nothing hidden | `NAV_GROUPS` in `App.tsx` |
| Mobile sheet navigation | `.shell-topbar` + `nav-toggle` + `e2e/support/nav.ts` |
| Empty states that say what happens next | `approvals-empty`, Research, Jobs, Intent, Documents, LP |
| Brand anchor | `src/client/public/wp-mark.svg`, byte-identical to `seq23/westpeek-live` |
| Token discipline enforced | `scripts/validate/west-peek-brand-system.mjs` (9/9 planted violations caught) |
| A reserved surface explains itself | `GovernancePage` → `governance-reserved` + `governance-empty` |
| Hover, focus, and blank-surface rules are tested, not asserted | `e2e/d1-design-states.spec.ts` (3 tests, each verified by reverting its fix) |
| Long raw identifiers in the mono face | `.mono` on the Activity actor and object columns |

---

## 13 · Patterns intentionally rejected

| Rejected | Why |
|---|---|
| Marketing display type inside operating screens | wayfinding, not headlines; `--text-2xl` (28px) is the ceiling |
| `backdrop-filter` glass on cards and headers | glassmorphism; costs legibility over dense tables |
| Radial orange page washes | makes orange ambient rather than meaningful; blows past the ~5% accent footprint |
| 22–30px radii and universal pill buttons | eat column width at institutional density |
| `0 22px 60px` card shadows | decorative depth; hairlines separate surfaces here |
| `transform: translateY(-1px)` hover lift | reads as instability on a dense table row |
| A dark marketing surface (`#0b0b0c`) | that register belongs to the public site; the OS follows the operating-app half of the family |
| `#ff7a00` / `#ff8500` | stale per the family's own validator; canonical is `#F05A1A` |
| 800–900 weight on body labels and nav | shouting at operating density; UI caps at 600, headings at 700 |
| Icon library | none is installed and none was added; hierarchy is typographic. No emoji is used as an icon (gate 60) |
| Rainbow status colours | four tones, each with a meaning |
| Toasts | silent success; results appear in the surface |
| `html, body { overflow-x: clip }` (Hallmark gate 62) | **deliberately declined.** It would suppress horizontal scroll rather than fix it, and would make the repo's own overflow assertion (`p25-journeys` journey 10) pass trivially. The causes were fixed instead and the measurement kept honest. |
| Macrostructure rotation between releases (gates 21–23, 34) | an OS has one shell; rotating it between releases is a defect, not variety. Page-scope gates are recorded as N/A in the audit rather than silently skipped. |

---

## 14 · Change control

Any change to the canonical orange, the parent-logo treatment, or the black/white-first rule
requires owner approval and an update to `WEST_PEEK_BRAND_SYSTEM.md` **in every West Peek repo** —
that is the parent authority's own clause, not a local rule.

Locally: `npm run validate:brand` must pass, its self-test must keep catching all nine planted
violations, and `e2e/d1-design-states.spec.ts` must stay green — it is the only check that measures
hover contrast and the no-ambiguous-blank rule in a real browser. If a scan is ever narrowed, add a fixture proving it still catches what it exists to
catch (the repo convention in `AGENTS.md`).
