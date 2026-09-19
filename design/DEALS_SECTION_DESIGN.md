# Deals section — design spec

**Status:** DESIGN PASS, for owner approval. No application code changed. Branch `design/deals-section`, base `origin/main` at the time of writing, read against `feat/a-pipeline-and-weekly-review`, `feat/b-meeting-model`, `feat/c-live-room`, `feat/meet-integration`, `feat/portfolio-page`.

**The design:** https://claude.ai/artifact/VTSmCscXYPBDiZC6z8jXBV — 25 artboards (desktop and phone for every tab; the During face also as a 360px standalone panel). Every value on every artboard is a token from `src/client/styles.css` `:root`; the artboards' `<style>` block is that token block copied verbatim plus the product's own class names. No new hue, no new font, no chart library — inline SVG on `--viz-1…4` and `--wp-line`.

**Method.** Hallmark, applied as its verbs say, not approximated: `hallmark audit` on the six current pages first (§1, no edits), then `hallmark redesign` inside the existing implementation boundaries (§2 onward) with the theme LOCKED to `WEST_PEEK_BRAND_SYSTEM.md` + the `:root` tokens. References applied: `SKILL.md` (the five cross-verb disciplines, component-scope 8-state rule), `references/contract.md`, `anti-patterns.md`, `slop-test.md` (pre-emit critique + gates 24–29, 36, 39–50, 56–66), `responsive.md`, `interaction-and-states.md`, `layout-and-space.md`, `typography.md`, `component-cookbook.md` (index only — this is an app, N/Ft archetypes do not apply), `copy.md`, `verbs/audit.md`, `verbs/redesign.md` (multi-page flow: consistency wins, `design.md` is `docs/WEST_PEEK_DESIGN_SYSTEM.md`). Hallmark evidence pack: `~/repo-tools/active/run_hallmark_audit.sh` v1.3.0, run id `hallmark_20260919T021212Z_3813`, mode full, `--no-browser`, brand contract SHA-256 `6b8e3c0a…5f89`, Hallmark authority SHA-256 `5fd8800b…4809`, source modified NO. The pack is an evidence scaffold — its `HALLMARK_FINDINGS.json` is `findings: []` by design ("did not perform or fabricate the expert review"); the findings are §1 below, produced by reading the six pages against the bundled authority.

**Two Hallmark gates are overridden by the locked theme, on the record:** gate 1 / "Inter-everywhere" (the brand system pins `--font-ui: Inter…` + `--font-serif` + `--font-mono`, the 2+1 pairing is the serif thesis statement and the mono identifiers — the display face is a weight and a scale, not a second family) and gate 8 (`--wp-surface: #ffffff` is the locked white; the paper is warm `#f7f2ea`). Both are recorded in `docs/WEST_PEEK_DESIGN_SYSTEM.md` and are INTENTIONAL — NO CHANGE.

---

## 1 · What is wrong today — `hallmark audit`, per page

Severity: **critical** ships as slop / fails the product's own law · **major** looks generated or hides the act · **minor** taste. `[BRAND-CONSTRAINED]` = right by the brand contract, not a defect. Verdict per page at the end.

### 1.1 Meetings (`src/client/pages/MeetingsPage.tsx`, Phase C version, 1573 lines on main)

| # | Sev | Tell | Where | Fix |
|---|---|---|---|---|
| 1 | critical | **Two objects on one page.** IC governance ("Where a deal stands with the committee", packets, dissent, decide buttons) sits under the meetings list | `MeetingsPage.tsx:1016-1319` (section 4), `:1209-1490` | Move to Dealflow, where the stage lives (§4). Meetings keeps one object: the meeting. |
| 2 | critical | **No rank 0.** The page opens on a purpose block and a list; the one line a partner came for ("is a brief ready / is anything waiting on me") is scattered across readiness strings on rows | `:811-818`, `:74-91` | Masthead answer line derived from the same counts (`brief_ready`, `stage_proposal_pending_count`, `draft_waiting_count`) — the Home/Work pattern of #95/#98. |
| 3 | major | **The record is a scroll of every panel always rendered** — status line, four buttons, BeforePanel, notes, Fireflies import, promised, seating, LiveHelpPanel, CloseoutPanel, AfterPanel, one under the other | `:430-639` (`MeetingRecord`) | Three faces as a tab strip (`.faces`); LiveHelpPanel and CloseoutPanel fold into During and After (their data already does — `meeting_after_draft`, `meeting_artifact`). |
| 4 | major | **Sort order is creation time, not calendar time** — "What is coming up" is newest-created first | `src/worker/services/meetings.ts:719-720` (`ORDER BY m.created_at DESC`) | Upcoming `ORDER BY scheduled_at ASC`; past `occurred_at DESC`. |
| 5 | major | **Four buttons on the record head** ("Record that they agreed", "They took it back", "Record that a transcript exists elsewhere", "Prepare for it") compete at the same weight | `:430-639` | One recording line with the switch; consent is asked inside it (Phase C already has the prompt at `RoomPanel.tsx:304-336`). "Prepare for it" lives on the Before face only. |
| 6 | major | **Hover-free, focus-free tab strip** — `.ic-tabs` reused for sub-tabs carries an orange underline but no focus-visible rule of its own | `styles.css:1771-1773` | `.faces`/`.face-tab` with `:focus-visible` from the global ring, `aria-selected`, roving tabindex. |
| 7 | minor | Straight quotes in the ask placeholder copy on one branch line (`"Wyatt, …"`) | `RoomPanel.tsx:431-535` (placeholder uses curly on the branch; the helper line does not) | Curly throughout (`copy.md`). |
| 8 | minor | Meet "Join" is a `.link-button` at row end, visually identical to "Open its record" | meet-integration diff of `MeetingsPage.tsx` | `.btn` with the external glyph; "Open the room" is the row's strong action. |

**Verdict:** *reads as AI-generated* — 2 critical · 4 major · 2 minor. The data model (Phase B/C) is right; the page shape is a stack of panels.

### 1.2 Dealflow (`src/client/pages/DealflowPage.tsx`, 2388 lines, byte-identical on Phase A)

| # | Sev | Tell | Where | Fix |
|---|---|---|---|---|
| 1 | critical | **Stale copy contradicts Phase A.** "all three open a work card for Wyatt rather than filing themselves" — after 0197 every route files at NEW | `:2175-2180` | Rewrite: "every company the firm records enters at New, however it arrived" (on the rail's exit line, artboard E1). |
| 2 | critical | **The human act is buried.** Nothing on the page says "one thing is waiting on you"; proposals from meetings (`meeting_stage_proposal`) surface nowhere here | whole page; `App.tsx` route table | A "Waiting on you" band above the pipeline with the proposal card and the one `.btn-primary` on the page. |
| 3 | major | **The funnel mouth is a marketing paragraph above the data** — a 3-sentence lede, a link, and a `btn-lg` in a bordered box | `:2157-2181` (`.funnel-mouth`, `styles.css:4254-4281`) | Delete the box; "Add a company" becomes the row-band's action; the sentence moves into the masthead detail. |
| 4 | major | **The deal record is seven always-open `<h3>` sections** ("Where this stands" … "Add a second deal") — 1,100 lines rendered as one scroll | `:823-1951` | The record takes the faces strip (Where this stands · The deal itself · What we know · The committee · History); the compact rail (`.stage-rail-compact`) replaces the fact-grid's "Where it is". |
| 5 | major | **`.stage-chip-screening/-diligence/-ic_ready` paint three stages orange** — orange as a status, against §2 of the design system ("never a status") | `styles.css:2241-2243` | One `.stage-chip-live` for the stage the firm is acting in; New/Decided neutral; Invested green. |
| 6 | major | **`window.prompt()` for the pass reason and the archive reason** — no label, no error slot, no focus ring, invisible on a phone keyboard | `:493-752` (`DealRow`, "Pass on this", "Remove this record") | Inline reason field under the row (`.field` + `.field-help.err`), min-12 error as an instruction. |
| 7 | major | **The record picker `<select>` duplicates "press a company"** and adds an orange-left tinted box (`.deal-record-step`) | `:2337-2361`, `styles.css:4759` | Remove; the row's name is the door. |
| 8 | minor | `DealProvenance` is a second `<h3>` card with its own table and inline "Set an origin" form | `DealProvenance.tsx` | Keep as the last band ("Where deals come from"); origin-setting moves onto the row's blocker slot when origin is missing. |
| 9 | minor | Filter chips right-aligned in `.deal-filters`, disconnected from the list head | `styles.css:4290` | Chips left, "Add a company" right, one row. |

**Verdict:** *reads as AI-generated* — 2 critical · 5 major · 2 minor.

### 1.3 Companies (`src/client/pages/CompaniesPage.tsx`, 417 lines; Phase A adds the fault notice)

| # | Sev | Tell | Where | Fix |
|---|---|---|---|---|
| 1 | major | **The four facts do not include the thing the row is for now** — Stage is a word; no rail, no clock, no "looked at" | `:233-248` (`dl.company-facts`) | Compact rail on every card (`.stage-rail-compact`) with the clock; facts: In it · Met via · Meetings · one contextual slot (Booked / Looked at / Open). |
| 2 | major | **Phase A's fault is a `.notice.notice-bad.small` inside the card** — same size as the one-liner, easy to read as a caption | Phase A `CompaniesPage.tsx:233-248` | A `.fault` strip above the grid naming the company (artboard F); the card also carries it. |
| 3 | major | **Passed cards use `opacity: .72` on the whole card** — the reason (the point of keeping them) is dimmed with everything else | `:210`, `styles.css:2211` | Dim the facts, not the reason; `We said no on {date} — {reason}` at full ink. |
| 4 | minor | Intro sentence renders the operator's first name into prose ("…, Sequoia — 6 in all") | `:314-318` | Masthead answer line; the name is in the header already. |
| 5 | minor | Register note is a 3-line paragraph with an inline link-button | `:346-353` | One line in the masthead detail + "Add one on Dealflow →". |

**Verdict:** *close, fix the majors* — 0 critical · 3 major · 2 minor.

### 1.4 Portfolio (`src/client/pages/PortfolioPage.tsx`, Phase Portfolio version, 1188 lines)

| # | Sev | Tell | Where | Fix |
|---|---|---|---|---|
| 1 | critical | **"Book it" does not exist.** The holdings notice says "Book the transaction on the company's own record, under Dealflow" — three screens and a receipt id to paste (`RecordInvestment.tsx:388-393` "Book it" wants `apc_…`) | `:465-474`, `portfolioHoldings.ts:326-329`, `RecordInvestment.tsx:331-414` | Inline Book-it on the row (§7), draft → one partner card → executed on approval. Owner's words, 18 Sep. |
| 2 | critical | **Marking is a separate form with a `<select>` of holdings** | `:527-586` ("Say what a holding is worth now") | Inline mark on the row ("Mark it"); the select disappears. |
| 3 | major | **Two sub-tabs on `.ic-tabs`** ("How the companies are doing" / "What they have reported") split one object | `:218-235` | One page; reporting is a band ("What they have reported") below alerts. |
| 4 | major | **Holdings are a `card-list` of sentences** — "Sensori — Early stage via SPV, 2025-08-06 · Consumer / Paid $10,000 (stand-in figures) · ownership not recorded · …" — nine facts in one wrapped line | `:479-511` | A table: Company · Stage · Paid · Owned · Held at · Reserved · Standing · act. Numbers right-aligned, tabular. |
| 5 | major | **Concentration, per-company reserves, stage: absent** | whole page | Columns on the row; concentration line under the table against `max_single_company_pct` (§7 data). |
| 6 | minor | `.cohort-grid` totals (Companies / Invested / Held at) repeat what the masthead now says | `:443-461` | Fold into the masthead. |
| 7 | minor | Ring caption "committed" at 7px inside the SVG | `AllocationRing.tsx`, `styles.css:2311` | Kept (token-exempt, recorded) — the legend carries the words. |

**Verdict:** *ships as slop on the one thing she asked for* — 2 critical · 3 major · 2 minor.

### 1.5 Thesis (`src/client/pages/ThesisPage.tsx`, 610 lines)

| # | Sev | Tell | Where | Fix |
|---|---|---|---|---|
| 1 | major | **The inputs card is always open under the document** — nine fields and two buttons at reading weight, on every visit | `:288-420` | Collapsed to "Amend the thesis"; the document is the page. |
| 2 | major | **The numbers are a definition list of eight cells** at equal weight; nothing says the order Wyatt checks them in | `:246-269` (`dl.thesis-grid`) | The stage rail carries the fit test in order: Stage → Sector → Filter → Cheque → Ownership → Shape (artboard H). |
| 3 | minor | `.thesis-banner` is the one orange field in the product | `styles.css:3786-3792` | `[BRAND-CONSTRAINED — INTENTIONAL, NO CHANGE]` recorded in the code comment `:207-219`; kept. Area ≈ 12% of the desktop viewport — over Hallmark gate 25's ~5% and recorded as the deliberate exception. |
| 4 | minor | `ConstructionCard` uses `.module-card-head` + link-button "Edit"; the thesis uses "Amend" | `:532-545` | One verb: Amend. |

**Verdict:** *close, fix the majors* — 0 critical · 2 major · 2 minor.

### 1.6 Secondaries (`src/client/pages/SecondariesPage.tsx`, 122 lines)

| # | Sev | Tell | Where | Fix |
|---|---|---|---|---|
| 1 | major | **Two empty cards and a rule** — "None yet." twice, with no shape of what a row would be and no sleeve budget | `:29-38`, `:105-111` | The sleeve's rail (all zero), the sleeve budget line ($0 of $7.2M), and one dashed row-shape with bracketed placeholders (artboard I). |
| 2 | major | Rows, when present, are one wrapped string of ` · `-joined facts | `:44-54` | `.deal-row-2` with readiness: last-round price, discount, implied ownership. |
| 3 | minor | `HowThisWorks` at the foot repeats the separation rule a third time | `:89-119` | Once, in the header identity line. |

**Verdict:** *close, fix the majors* — 0 critical · 2 major · 1 minor.

**Cross-page:** the `.home-section-head h2,h3,h4` one-size rule (#95) is why every one of these pages has three ranks of meaning at one rank of type. The design gives each page the three-rank scale Home and Work now have: `--text-2xl` answer · `--text-xl` band head · `--text-lg` panel head.

---

## 2 · The shared pattern (artboard A)

| Element | Class (existing → new) | Rule |
|---|---|---|
| Masthead | `.home-masthead` pattern → `.masthead`, `.masthead-date`, `.masthead-second` | Eyebrow (date · counts) at `--text-2xs` uppercase; the **answer** at `--text-2xl` 700, ≤26ch; the detail at `--text-md` `--wp-ink-2`. One per page. Derived from counts the page already loads. |
| Band | `.home-band` pattern → `.band`, `.band-head`, `.band-when` | Full-bleed `--wp-line-strong` hairline above; `h3` at `--text-xl`; a muted "when/how" on the right. Orange count-pill only when something waits on a human. |
| Stage rail | `.spine*` → `.stage-rail`, `.stage-rail-line`, `.stage-node`, `-filled`, `-current`, `-done`, `.stage-label`, `.stage-q`, `.stage-rail-exits` | Nodes are `<button>`s (filter the list); ink = has companies, **orange = where the human act is (one node at most)**, green = done. Phone: the rail stands up (`.phone .stage-rail` column) — measured, no overlap. |
| Compact rail | new `.stage-rail-compact`, `.stage-dot`, `-done`, `-current`, `-closed`, `.stage-seg` | On a row, a card, a record head. Never interactive. |
| Faces | `.ic-tabs` → `.faces` (role=tablist), `.face-tab` (role=tab, `aria-selected`) | Orange 3px underline on the selected face only; a `.badge` says what the face holds (live · draft · empty). Scrolls inside itself on phone; the document never scrolls sideways. |
| Row | `.deal-row` (kept) + `.deal-row-3`, `.deal-row-2`, `.deal-row-out`, `.deal-row-selected`, `.deal-name`, `.deal-sub`, `.deal-sub-stalled`, `.deal-blocker`, `.deal-actions` | Four cells: name+sub · stage+clock · what is stopping it · the act. Meetings drop the stage cell for `.readiness`. Passed = `.deal-row-out` on the facts only. Selected = `--wp-tint` (the one selection colour). |
| Readiness / outputs | new `.readiness` (+`.dot`) | "Brief ready · 3 to find out · 2 we owe them · 1 they owe us" / "1 decision · 2 still open · 1 stage move waiting on you". Counts come from `MeetingRow` (branch B). |
| Status | `.badge`, `-ok`, `-gate`, `-bad`, `.badge-attention`, `.count-pill`, `.stage-chip`, new `.stage-chip-live`, `.task-chip`, `-live` | Four tones, orange is not one. `.stage-chip-screening/-diligence/-ic_ready` retire into `.stage-chip-live`. |
| Fault | new `.fault` | Danger-tinted strip with a left rule; the only left-rule strip in the section, because it is the one thing that must not read as decoration. |

---

## 3 · Meetings (artboards B, C1–C3, D)

- **Purpose line:** Preparation, live help and what came out of each meeting — one object, three faces.
- **The object:** `meeting` (Phase B: `meeting_prep_packet`, `meeting_artifact`, `meeting_after_draft`, `meeting_decision`, `meeting_commitment`, `meeting_open_question`, `meeting_stage_proposal`; Phase Meet: `meet_link`, `source`, `type_inference`, `meet_event_inbox`).
- **The list (B):** masthead answer from `brief_ready`/`stage_proposal_pending_count`/`draft_waiting_count`; bands *Coming up* (`status=SCHEDULED`, `scheduled_at ASC`) · *On the record* (`occurred_at DESC`) · *Start a meeting now* (the existing form, one row). Rows are `.deal-row-3`: name+kind+when+source · `.readiness` · actions. Upcoming: `Join on Meet` (`.btn`, `meet_link`, `target=_blank`, aria-label says it opens Meet) + `Open the room` (`.btn-strong`). Past: `Open what came out of it`. `type_inference=UNKNOWN_CHECK_IT` → `.badge-gate "type inferred, check it"`.
- **Before (C1):** the brief as written by `meetingBrief.ts` — the why-line becomes the masthead answer (it is the only model-written line; the eyebrow says who wrote it and what it examined, `coverage_json`); *What we need to find out* (`meeting_open_question` carried + brief questions, owed-by); *What we said last time* two columns from `meeting_commitment` with standing tags; *The record* from the deal (`GET /api/opportunities/:id`); *Diligence framework* scorecard from `ic_diligence_answer` (kept as the checkbox list, "ask today" gate badge on the one the questions point at); *Who is in the room* (seating, suggested per `meetingTypes.ts`); one `.btn-strong.btn-lg` "Open the room".
- **During (C2):** `.rec-line` = switch (`role=switch`, `aria-checked`) + live dot + status string + consent line (Phase C strings verbatim) + Stop. Consent prompt (`RoomPanel.tsx:304-336`) opens inside the line when the switch is turned on with no yes on file. Left: rolling draft (`meeting_after_draft`, `ROLL_EVERY_MS`), Ask the room (`.ask`: input + Ask + `.ptt` hold-to-talk, `aria-pressed`), the artifacts stream (`.artifact`, `.artifact-kind`; kinds answer/table/chart/packet/summary; charts inline SVG on `--viz-*`). Right: `.seat` rows with `.task-chip` (`work_card` state via `meeting_artifact.work_card_id`), *Pull in an employee* (select + button; internal-only seat warning text from `meetingTypes.ts`), the question checklist, "We are done — open the record".
- **After (C3):** masthead answer is the draft's sentence ("Two decisions, three commitments, two open questions, and a move to Diligence."); the stage proposal is a `.watch-banner` card with the page's one `.btn-primary` "Move it" (`POST /api/meeting-stage-proposals/:id/decide`) and "Leave it where it is"; Decided · Still unknown ("Answer it" inline) · Owed — both sides ("It was delivered" → `/honour`) · Saved from the room · "Approve — make these the record" (`.btn-strong.btn-lg`, `POST /api/meeting-after-drafts/:id/approve`) + "Set it aside". **Approvals law:** approving the draft is one human card; the stage move is an inline click that is not a card; LiveHelp/Closeout no longer add their own. Net cards per meeting: 1 (was up to 3).
- **Standalone panel (D):** `#/room/:id` (Phase C `RoomStandalone`) at 360px: the same During face in one column, ask box and hold-to-talk full width, seats as chips. Root `.room-standalone` max-width stays 720; the artboard is the 360 case a Meet side-panel will hold.
- **Data that would be new:** none for B/C/D — every element reads a Phase B/C/Meet column. *Nice-to-have, not required:* `meeting.scheduled_at` index for the sort.
- **8 states designed:** recording switch (off · on · focus · disabled+reason · loading "Reading the room…" · error "Minute N was not written down" · success consent line) and Ask the room (default · focus · held · loading · error "Nobody called … works here" · revoked) — artboard A, blocks F.

## 4 · Dealflow (artboards E1, E2)

- **Purpose line:** Where every company stands and what is stopping the next decision; the committee lives here now.
- **The object:** `investment_opportunity` on the stage vocabulary `pipeline.ts:51-122` (NEW 7d · SCREENING 14d · DILIGENCE 42d · IC_READY 7d · IC_DECIDED 21d · CLOSED; exits PASS, WITHDRAWN).
- **E1:** masthead answer from `stage_proposal PROPOSED` count + `unreviewed` count; the rail card (counts from `/api/dealflow/board`, node buttons set the filter; exits line carries the Phase A sentence); *Waiting on you* band (proposal cards from `meeting_stage_proposal WHERE state='PROPOSED'` — **new route** `GET /api/dealflow/proposals` or folded into `/board`; Move it = the existing `/decide {ACCEPT}`; IC packets awaiting a decision also land here); *The pipeline* (chips + "Add a company" `.btn-strong` opening the existing form inline; rows as today's `DealRow` with the reason field inline instead of `window.prompt`); *The committee* band (moved from Meetings: `GET /api/ic/deals`, empty state as designed); *Where deals come from* (`DealProvenance`, last).
- **E2 — a deal at the committee:** the record head with `.stage-rail-compact`; faces strip (Where this stands · The deal itself · What we know · **The committee** · History) reusing the seven existing sections' data; committee face = *What the packet does not know* (`ic_open_question`, Answer it / We do not need this → `/api/ic/questions/:id/resolve`), *Diligence framework* with the champion lock notice (`IcPortalPage.tsx` copy, `ic_diligence_answer`), *Who disagreed* (`dissent_record`), *Who is in the room* (`committeeSeats`, "decides" gate badge), *Record what the committee decided* (Why field; `The firm is investing` `.btn-primary` → `investment.approve` receipt path; `The firm passes` `.btn-danger` min-12; `Not yet`). `IcPortalPage.tsx` (dead-mounted, `App.tsx:2817`) is retired; its Diligence/Memo/Market/People/Audit tabs become the packet's own faces reachable from "Open the packet".
- **Data that would be new:** the proposals feed on the board response (Phase B table, new query); `stage-chip-live` mapping; nothing else.
- **8 states designed:** stage-change accept (proposed · hover · focus · disabled+reason "Moving a deal is a person's decision…" · loading · error "no longer in Screening" · done · declined) and the stage rail node (filled · current · hover · focus · disabled · done) — artboard A, blocks B and G.

## 5 · Companies (artboard F)

- **Purpose line:** Every company the firm has a record of — the register; nothing is created here.
- **The object:** `canonical_company` + its latest non-archived deal (`/api/companies/register`).
- **Shape:** masthead answer (counts: all · owned · passed); Find + Sector on one row with "Add one on Dealflow →"; `.fault` strip for any register row with `deal_id IS NULL` (Phase A's notice, promoted to page level and named); the grid of `.company-card` each with the compact rail + clock, the one-liner, four facts (In it · Met via · Meetings · a contextual fourth: Booked / Looked at / Open), and Edit · History as today; *Who did we turn down, and why?* band with `.deal-row-out` cards whose reason stays full-ink and an "Add the reason" link when `exit_reason IS NULL`.
- **"Not in the pipeline" is gone** (Phase A already changed the `dd` fallback to "—"; the fault strip is what replaces the phrase).
- **Data that would be new:** `left_pipeline_at` is already on the register row; a `looked_at` flag = the board's `unreviewed`, needs adding to `/api/companies/register` (one join).

## 6 · Portfolio (artboards G1, G2)

- **Purpose line:** How portfolio companies are doing, what the firm owns, and whether each holding is booked.
- **The object:** a holding = closed `investment_opportunity` ∪ open `position` with its latest `position_mark` (`portfolioHoldings.ts`, Phase Portfolio).
- **G1:** masthead answer from `totals.booked/unbooked`; *What we own* table (Company · Stage chip · Paid · Owned · Held at · Reserved · Standing · act) — Standing is the booked-or-not signal (`badge-gate "not yet booked"` / `badge-ok "booked to Fund I"`); concentration line under the table against `concentration_policy_version.max_single_company_pct` × committed (amber ≥ 80% of cap, red at cap — non-colour cue is the words); *What the portfolio is made of* (Composition bars, `FundAllocation.tsx:50-124`) beside *Where the money is, against the plan* (the **deployment ring** from `allocation.ts deploymentSlices`, `--viz-1` deployed, `--wp-line` still-to-deploy, `--viz-2/3/4` reserves/secondaries/fees; the plan ring stays on Fund strategy — `validate:portfolio` forbids a second ring and this is the same one hosted, not a second); *What is going wrong right now*; *Where a company has asked for help*; *What they have reported* (the old second tab, as a band). Ring figures on the artboard are `allocation.ts` arithmetic on the commissioning seed: fees $6.0M, secondaries $7.2M, reserves $6.72M, initial $10.08M, deployed $10K (stand-in).
- **G2 — Book it, four states:** on any unbooked row, `Book it` (`.btn-primary`, MP only) opens `.holding-form` under the row (`.holding-row.is-open`): Share class (`security_class` for the company, "add a class"), Price per share, Share count, Date, Vehicle, Fund; cost basis computed live; "Save and send to Scooter" (`.btn-strong`) = `createTransaction` DRAFT + `submitTransactionForApproval` in one call (**new composite route** `POST /api/holdings/:company_id/book`), which also writes the two figures onto the deal's `placeholder_fields` so the stand-ins heal. States on the row: **unbooked** (gate badge) → **draft** (`transaction.status=DRAFT`, author sees Send/Edit) → **awaiting a partner** (`PENDING_APPROVAL`, one `approval_card` under `investment.approve`, Book it disabled with the reason, "Open the card") → **booked** (`EXECUTED`, `position` opened by `applyPositionEffect` **on card approval** — the receipt-paste rung in `RecordInvestment.tsx:388-393` goes away: approval executes). Then inline **Mark it** (`POST /api/positions/:id/mark`, `position_mark`) and **Reserve for it**.
- **Approvals law:** one human card per booking (was: draft, send, paste receipt, book = two human steps plus a card). Marks and reserves are MP writes, not cards, as today.
- **Data that would be new:** `vehicle` as a column on `transaction` (today only `terms_json.vehicle` on the opportunity); a per-company reserve — **new table** `position_reserve(position_id, amount_minor, set_by, as_of, note)` read by Fund strategy's follow-on; the composite book route; `approval → execute` hook on `investment.approve` cards whose object is a transaction. Everything else exists (`security_class`, `transaction.price_per_share/quantity/transaction_date`, `position.cost_basis`, `position_mark`, `ownership_snapshot`, `concentration_policy_version`).
- **8 states designed:** the Book-it button (artboard G2, last block) and the money inputs (`.in-focus/.in-error/.in-disabled/.in-success`, border width constant, outline focus, helper slot `min-height: 1lh`).

## 7 · Thesis (artboard H)

- **Purpose line:** What the firm is looking for, and the cheque and ownership it looks for it at.
- **The object:** `investment_mandate_version` (+ `reserve_policy_version`, `concentration_policy_version`, `sleeve_policy_version`), append-only.
- **Shape:** masthead; the document card = the orange statement banner (kept, INTENTIONAL) + a version stamp + **the fit rail**: the six checks in the order Wyatt applies them (Stage · Sector · Filter · Cheque · Ownership · Shape) on `.stage-rail` with the filter node orange because it is the one judgement call; the returner sentence; the open question as a `.notice`; then *Construction* (reserves, max single, sleeves, fees — values from the policy versions with the computed dollars) beside *Versions* (a `.version-rail` of `version_no`, the history list, Amend · Write it for me · Print).
- **No faces** — the object has no lifecycle beyond versions, and inventing draft/adopted would need an approval that does not exist. The rail is the pattern's contribution here.
- **Data that would be new:** none. `[DATE TO CONFIRM]` on the artboard is `effective_from` of v1, which the page reads and I did not fabricate.

## 8 · Secondaries (artboard I)

- **Purpose line:** The secondary sleeve — purchases and sales, kept apart from primaries on purpose.
- **The object:** `investment_opportunity WHERE opportunity_type IN (SECONDARY_PURCHASE, SECONDARY_SALE)` — the same object as Dealflow, filtered.
- **Shape:** masthead with the sleeve budget (`sleeveTargetUsd(SECONDARY_PURCHASE)` = $7.2M, deployed from booked secondary positions); the same six-stage rail filtered to the sleeve (the questions re-worded for a block: "Price against the last round", "Seller, broker, block size", "Its own approval key"); *What have we bought* / *What have we sold* as `.deal-row-2` rows with a readiness line (last-round price + date from `pricing_observation`, discount, implied ownership after the block); one dashed row-shape with bracketed values while empty — honest, not invented.
- **Data that would be needed:** `pricing_observation` rows against the company (table exists, no writer on this page today); a `sleeve` on the deployment arithmetic (`position` has no sleeve column — infer from `transaction.transaction_type IN (PURCHASE, SALE)`); the SALE path starting from a Portfolio row ("a sale begins on the holding's row") is a **new door** — `POST /api/opportunities` with `SECONDARY_SALE` prefilled.

---

## 9 · Pre-emit self-critique, per artboard (Hallmark axes P·H·E·S·R·V, 1–5; nothing <3 shipped)

| Artboard | P | H | E | S | R | V | Revised before emit |
|---|---|---|---|---|---|---|---|
| A · pattern (+phone) | 5 | 5 | 4 | 5 | 4 | 4 | rec-line rewritten as a grid after the first render wrapped "Stop" to a second line |
| B · Meetings (+phone) | 5 | 5 | 4 | 5 | 5 | 4 | — |
| C1 · Before (+phone) | 5 | 5 | 4 | 5 | 4 | 4 | — |
| C2 · During (+phone) | 5 | 5 | 4 | 5 | 4 | 5 | artifact meta un-uppercased (it read as a second eyebrow) |
| C3 · After (+phone) | 5 | 5 | 4 | 5 | 5 | 4 | — |
| D · panel | 5 | 5 | 4 | 5 | 5 | 5 | — |
| E1 · Dealflow (+phone) | 5 | 5 | 4 | 5 | 4 | 4 | phone rail stood up (labels overlapped in the first render) |
| E2 · Committee (+phone) | 5 | 4 | 4 | 5 | 4 | 4 | faces strip made an inner scroller (five tabs overflowed 390) |
| F · Companies (+phone) | 5 | 4 | 4 | 5 | 4 | 4 | Find field lost its fixed width (overflowed 320) |
| G1 · Portfolio (+phone) | 5 | 5 | 4 | 5 | 4 | 4 | — |
| G2 · Book it (+phone) | 5 | 5 | 5 | 5 | 4 | 4 | form moved from `.form-row` to `.book-grid` (six fields wrapped unevenly) |
| H · Thesis (+phone) | 5 | 5 | 4 | 5 | 4 | 4 | — |
| I · Secondaries (+phone) | 4 | 5 | 4 | 4 | 5 | 4 | — (P4/S4: the page has no data; the shape is proposed, not proven) |

E is 4 across the board for one reason: Inter is not downloaded in the product, so the artboards render in the platform face wherever Inter is absent — the same limitation the design system records.

## 10 · Mobile verification (measured, not asserted)

- **Method:** every board rendered in headless Chromium (Playwright from the worktree's `node_modules`) at its declared width; every phone board and the panel re-rendered at **320 / 375 / 414 / 768**. Assertions: root `scrollWidth ≤ clientWidth`; no descendant's right edge past the frame (excluding the two declared inner scrollers, `.faces` and `.table-wrap`); no `<button>/<a.btn>/.chip/.face-tab` whose text spans two line boxes; no control under 24px in either dimension.
- **Result:** 25/25 boards no horizontal overflow at declared width; 13/13 phone-width boards clean at all four widths after two fixes (Companies Find field at 320; committee faces at 390). Zero wrapped clickables (the measurer flagged the six face-tabs that carry a badge — inspected, the badge sits on the same line; baseline offset, not a wrap). Zero small controls. Heights on the canvas are the measured natural height + 24px, so nothing is clipped.
- **Rules carried:** 16px gutters on phone (`.phone .surface-body` = `--space-lg`); `--touch-min` 44px on every phone control and the desktop face tabs; `overflow-wrap: anywhere; min-width: 0` on names and headings; section heads collapse to one column (`.phone .shell-header .row.between`); `.form-row` labels go full-width; the rail stands up; grids go to one column via `minmax(0,1fr)` tracks only.

## 11 · Accessibility and UI review — how each tab meets the checklist

| Check | Meetings / Room | Dealflow | Companies | Portfolio | Thesis | Secondaries |
|---|---|---|---|---|---|---|
| Semantic structure | `h2` page · `h3` band · `h4` panel; faces `role=tablist/tab` + `aria-selected`; lists are `ul/ol`; the brief's questions an `ol` | rail is `ul>li>button`; rows `ul.deal-list>li`; table for provenance with `th` | `article` per card, `dl` facts | `table` with `thead`, `.num` right-aligned; `form` for Book it | `article`, `dl`, `ul` | as Dealflow |
| Keyboard | every act is a `<button>`/`<a href>`; switch is a button with `role=switch`; PTT is `aria-pressed` and also works on Space-hold; tabs roving-tabindex, arrows move, Enter/Space select | rail nodes are buttons; no `window.prompt` — inline field | Edit/History are buttons | Book it expands (`aria-expanded`) an inline form; first field takes focus; Esc = Never mind | Amend expands | same |
| Focus behaviour | global `:focus-visible` ring (`--wp-orange`, 2px, offset 2 — 3:1 on paper and on ink/orange fills); painted instantly, never transitioned; inputs reserve `outline: 2px transparent` so focus never shifts layout | same | same | same | same | same |
| Labels and errors | visible `<label>`s (the ask box has an sr-only label + placeholder that shows format); error text replaces the helper in place; `aria-invalid` + danger border + words | reason field: label "Why", error is an instruction | search has a visible label | six labelled fields, helper `min-height: 1lh`, error names the field | number fields labelled with units | — |
| Contrast, non-colour cues | ink 18.7:1, ink-2 9.6:1, muted 5.9:1 on white; orange fill text is `--wp-orange-ink` 6.2:1; every state has a word beside its colour (live · draft · overdue · stalled); the rail's current node also says "the act is here" in the label column | stalled = red **and** "— stalled"; email badge = words | fault = strip **and** sentence | booked/unbooked = badge words; concentration = words + colour | — | — |
| Reduced motion | the only motion is the live dot and the 90ms colour transitions; `prefers-reduced-motion` collapses both (existing rule) | none | none | none | none | none |
| Responsive | §10 | §10 | §10 | table scrolls inside `.table-wrap`; Book it grid → 2 columns | rail stands up | rail stands up |
| Touch targets | 44px on phone for every control incl. the switch's hit area (`::before` inset) and face tabs; desktop 34px controls keep 44px tabs | same | same | same | same | same |
| Screen-reader names | icon-only: none — every button has words; external Join has `aria-label` naming Meet; charts are `role=img` with a sentence `aria-label`; the ring likewise | rail nodes "New, 2 companies" | "Stage" on each compact rail | ring `aria-label` carries the five figures | — | dashed row-shape is `aria-hidden` |
| Loading / error / empty | every list has the product's `.state-empty`/`.state-message` copy (quoted from the branch); loading is "Loading…" in the slot; errors state the HTTP status | same | same | same | same | the empty state is the page |

## 12 · Build order for the implementation agents

1. **Tokens and classes first** (one agent, `styles.css` only): add `.masthead*`, `.band*`, `.stage-rail*`, `.stage-rail-compact*`, `.faces/.face-tab`, `.deal-row-2/-3/-selected`, `.readiness`, `.fault`, `.rec-line/.rec-text`, `.switch`, `.ask/.ptt`, `.artifact*`, `.seat/.task-chip*`, `.holding-row/.holding-form/.book-grid/.kv`, `.version-rail`, `.stage-chip-live`; retire `.stage-chip-screening/-diligence/-ic_ready`, `.funnel-mouth*`, `.deal-record-step`. Register the heading-scale selectors with `scripts/validate/heading-scale-applies.mjs`. Everything from the artboards' `<style>` block below the `:root` copy is this list.
2. **Meetings** (after B/C/Meet land): list bands + sort; faces strip over the record; fold LiveHelpPanel/CloseoutPanel into During/After; move section 4 (IC) out.
3. **Dealflow**: Waiting-on-you band + proposals feed; rail node buttons; inline reason field; committee band (the moved section 4) + the record's faces; retire `IcPortalPage` mount.
4. **Portfolio** (after Phase Portfolio lands): holdings table; composite book route + approval-executes hook + `vehicle` column + `position_reserve` (migration slot to be assigned by the coordinator — three branches collided on `0033` before); inline mark.
5. **Companies**: compact rail, fault strip, `looked_at` on the register row.
6. **Thesis**, then **Secondaries** (SALE door from Portfolio last).
7. **Guards**: `validate:brand` and `validate:design-tokens` already cover colour/type; add a Playwright spec on the Deals surfaces mirroring the Home one (0 overflow at four widths, 0 wrapped clickables, 0 targets <24px, contrast sweep) — Rule 0: it must assert it examined ≥1 element per page.

## 13 · Approval questions (only she can answer)

1. **Approval executes the booking?** Design says: approving the `investment.approve` card opens the position — no receipt paste, no third click. That removes a rung that exists today (`RecordInvestment.tsx` "Book it" with `apc_…`). Yes, or keep the explicit execute step?
2. **The stage move from a meeting is a click, not a card.** "Move it" on the After face or on Dealflow's Waiting-on-you band moves the deal immediately (it is `transitionOpportunity`, already a person's click). Confirm it should not become an approval card.
3. **The thesis banner stays orange.** It is the product's one orange field and over Hallmark's 5% accent area; kept as the deliberate exception. Keep, or move to the top-rule treatment the artboards' CSS also carries (`.thesis-statement`)?
4. **IC Portal's tabs (Memo · Market · People · Audit) become faces of the packet inside Dealflow**, reachable from "Open the packet" on the committee face. Confirm they are wanted at all — they are dead-mounted today and nobody has reached them since the Investment page was superseded.
5. **A sale starts from the Portfolio row.** "Sell" on a booked holding opens a `SECONDARY_SALE` deal on Dealflow and it shows on Secondaries. Confirm Portfolio is the door, not Secondaries.
