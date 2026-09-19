# Home — design spec

**Status:** DESIGN PASS, for owner approval. No application code changed. Branch `design/home`, base `main` at `52fccfb` (the deployed Deals redesign), read against `fix/the-morning-brief-arrives` (the brief's named states). The owner's brief, 19 Sep 2026: *"the Home page UX is annoying, not intuitive and clunky. The show / put away is stupid and clunky and should be some kind of filter that is easy to return to home state. The open things below have to be opened one by one and can't all be dismissed. And obviously the brief section and its UX is wrong — we need to see completion state and progress."* Rule for what Home is for: at 7 AM on her phone it answers **what is waiting on me** and **what arrived overnight** above the fold at 390px; briefs are on demand only, built on Sonnet, with one button whose states she can see.

**The design:** https://claude.ai/artifact/BKqKjJN1iwNVhwzkutQdRV — seven artboards: Home at 390 as production stood at 10:02 AM on Sat 19 Sep (the primary), Home at 390 on a busy morning, the same at 1280, then the filter rail, the Waiting band with inline acts and select-many, the Arrived band with Mark all read, and the brief band in eight states. The boards' `<style>` is `src/client/styles.css` `:root` copied verbatim plus the product's own classes; the ~30 lines this design adds are listed in §5. No new hue, no new font. Bracketed values `[like this]` are shapes the repo defines that production has no row for yet; every other count, time and title is from production.

**Method.** Hallmark as its verbs say: `hallmark audit` of Home as deployed (§1, no edits), then `hallmark redesign` inside the existing route and component boundaries with the theme LOCKED (`design.md` = `docs/WEST_PEEK_DESIGN_SYSTEM.md`, `designed-as-app`, consistency over variety). References applied: `SKILL.md` disciplines 1–5 and the component-scope 8-state rule, `contract.md`, `anti-patterns.md`, `slop-test.md` (pre-emit critique; gates 24–29, 36, 46–50, 56–66), `responsive.md`, `interaction-and-states.md`, `layout-and-space.md`, `copy.md`, `verbs/audit.md`, `verbs/redesign.md`. Hallmark evidence pack `~/repo-tools/active/run_hallmark_audit.sh` v1.3.0 is the read-only scaffold the Deals spec used; its findings file is empty by design, and the findings are §1. The two locked-theme overrides recorded in the Deals spec stand (gate 1 Inter, gate 8 pure-white surface). **Production evidence** is read-only D1 (`west-peek-os-db`, `--env production`), SELECTs only, taken 19 Sep 2026 ≈ 15:00Z; every figure below names its table.

---

## 1 · What is wrong today — `hallmark audit` of `src/client/pages/HomePage.tsx` (873 lines) and what it mounts

Severity: **critical** fails the page's own law · **major** hides the act or reads generated · **minor** taste.

| # | Sev | Tell | Where | Fix |
|---|---|---|---|---|
| 1 | critical | **Show/put-away toggles are the page's navigation.** Four separate collapse controls, each remembering (or not) its own state: the brief's "Hide the brief / Show the brief" (per-viewer in `briefCollapse.ts`), the quiet roll's "Show each / Hide them" (`useState`, forgotten on reload), `DeliverableList`'s "Show what I put away / ← Back to current", and `ConnectPanel`'s strip. None is a filter, none returns to a home state in one tap, and two of them forget | `HomePage.tsx:395-400`, `:817-843` (`showQuiet`), `DailyBriefPanel.tsx:516-527` (`brief-fold`), `DeliverableList.tsx:120-135` | One **filter rail** under the masthead — All · Waiting on me · Arrived · Quiet — with a dashed `← Home` chip when a filter is on, remembered per viewer, never opening on an empty filter (§3.2, artboard Rail). All four toggles go. |
| 2 | critical | **Everything is cleared one at a time.** Deliverables: `Put it away` per row; attention: `I know` per row; modules: `Open anyway` per name. Production: **34 `deliverable.dismissed` events against 4 `deliverable.acknowledged`**; 24 of 57 deliverables put away by hand, 4 read (7%). She clears, and the page makes her do it 24 times | `DeliverableList.tsx:246-262`, `HomePage.tsx:623-645`, `:169-175` | `Mark all read` on the Arrived head; a checkbox per row with `Put away selected` / `Mark selected read` / `I know — quiet selected`; silent success with one `Undo` line (§3.4, §3.5). |
| 3 | critical | **The brief's collapsed state hides whether it ran, and its running state is one of five words.** Folded, the panel is a strip whose only line is `collapsedBriefLine`; open, `generate()` walks stages inside her request and shows "Reading everything…". On 19 Sep she pressed twice and saw "Another run holds it…". No elapsed, no expectation, no progress, no last-brief age | `DailyBriefPanel.tsx:445-475` (main), fixed at the data layer on `fix/the-morning-brief-arrives` (`briefRunState.ts`, `briefBand.ts`) but rendered there as a `.notice` inside the same card with the same fold | The brief is a **band** with one button whose label is `run.button.label`, a stage strip (read 48h · ranked · writing · checked), the product's `.progress-track` for elapsed against the measured usual, and the last brief's age when none today (§3.6, artboard Brief). No fold: the rail is the fold. |
| 4 | critical | **The masthead contradicts the band under it.** `answerLine` keys on decisions alone ("Nothing is waiting on your signature.") while the band head says "Waiting on you **1**" from `needsHer` (decisions + blockers + previews) | `answerLine.ts:53-57`, `HomePage.tsx:525-534`, `:592-606` | One count for both: the answer is `needsHer` in words; the detail says what kind ("Not a signature — Scooter's brief failed and Willow has it."). Real snapshot on artboard Main. |
| 5 | critical | **"Usually 4–5 minutes" is not what production measures.** Last 8 READY builds average **1,607 s (26.8 min)**; 15–17 Sep ran 32–37 min; 8–14 Sep ran 3–5 min. 18 and 19 Sep FAILED (31 and 36 min to fail) | `intelligence_report.started_at/completed_at`; the branch's `BriefExpectations` computes this live — the copy must never carry the number | The band shows `expectations.usualSeconds` in words with `measuredFrom`; the running state past the usual turns to `.notice-gate` and says "the slow end is 37 min"; the track caps at 95% until the row says READY. |
| 6 | major | **The brief is on Home twice.** `DailyBriefPanel` renders the report; `DeliverableList` (`mine`) also lists "Morning brief — 16 September" as a `daily_brief` deliverable with its own Open / Read / Put away. 39 of 57 deliverables are `daily_brief` — the largest thing she puts away by hand is a copy | `HomePage.tsx:731-793`, `deliverables.ts` (`kind = daily_brief`) | The brief band is the brief's one home; the Arrived band excludes `kind = daily_brief`. |
| 7 | major | **The brief's failure is said twice too.** The health fault "Sequoia's brief · 2026-09-19 · failed" is an `operatorAttention` blocker in Waiting, and the brief panel says the same thing under it | `health_fault` (2 open rows, both briefs), `operatorAttention.ts`, `HomePage.tsx:623-660` | The viewer's own brief fault is folded into the brief band's failed state; the other partner's stays a blocker (it is not hers to fix, and the row says so). |
| 8 | major | **Approvals need three screens.** A waiting row's act is `Decide`, which navigates to Approvals, where the card must be opened, then Approve. Every card ever raised was decided within minutes of being raised — by her, on that page — so Home has never decided one | `HomePage.tsx:607-620`; `approval_card`: 18 cards ever, 17 executed, 0 pending, all `risk_level = RESERVED` | Approve · Reject · Open inline on the row (`POST /api/approvals/:id/decide`); Reject opens a reason field under the row. One press instead of three. |
| 9 | major | **"Stop telling me, for good" is used as a snooze, then regretted.** `attention.dismissed` 21 · `attention.acknowledged` 8 · `attention.unsilenced` 11 — she brought silenced items back eleven times | `attention_dismissal`, `event_record`; `HomePage.tsx:640-660` | `I know — quiet for a week` is the row's visible act; `Stop telling me` stays but only inside the select bar, after a tick — deliberate, not reflexive. |
| 10 | major | **The Ask dock and the Connect strip sit above the answer on a phone.** ~150px of the 390 first screen is an invitation and a setup status before the page says what is waiting | `HomePage.tsx:556-587`, `ConnectPanel.tsx` (reserved height) | Both move to one line at the foot: `Ask for anything → · Choose what Home shows · Setup — [N of M] connected`. Ask stays findable (17 Aug direction) and is one nav item away. |
| 11 | major | **"The rest" is a shelf nobody opens.** Home layout preferences: 5 versions, last saved **23 Aug** (27 days). Private layer: **0 profiles, 0 entries** ever. "What this page answers": no telemetry, and `pagePurpose.ts` already answers it in Help | `mp_home_preference`, `personal_intelligence_*`; `HomePage.tsx:845-871` | Off Home (§2). |
| 12 | minor | The quiet roll's names include one colleague twice when two modules share an author (Wren: employees + my_work; Preston: allocation + reconciliation) | `HomePage.tsx:539-544` | Dedupe names; count colleagues, not modules. |
| 13 | minor | `Face` sizes swing 36 → 28 between fresh and quiet rows; quiet rows at `opacity: .7` dim the name with the fact | `HomePage.tsx:152`, `styles.css:2489` | `.deal-row-out` on the facts; the name at full ink (the Deals rule for passed deals). |

**Verdict:** *ships as slop on the two things she asked for* — 5 critical · 6 major · 2 minor. The data underneath (module seen-marks, deliverable acknowledgement, the branch's named brief states) is right; the page is four toggles and a scroll of one-by-one cards.

### 1.1 What is actually read on Home — production, 20 Aug → 19 Sep

| Band today | Rows delivered | Read (`acknowledged_at`) | Put away by hand | Note |
|---|---|---|---|---|
| Brief (`daily_brief` deliverable rows) | 39 | 3 (8%) | 17 | the panel itself has no read event; the deliverable copy is what she touches |
| Weekly review (`weekly_review`) | 8 | 0 | 3 | |
| Discrepancy list | 4 | 0 | 2 | |
| Meeting prep | 4 | 1 | 2 | |
| Event kit · Ask brief | 2 | 0 | 2 | |
| **All deliverables** | **57** | **4 (7%)** | **24 (42%)** | 30 in the last 14 days: 3 read, 10 put away |
| Attention (blockers) | — | 8 acknowledged | 21 dismissed | 11 `unsilenced` — brought back |
| Approvals from Home | 18 cards ever | 17 executed | — | 0 pending now; 1 raised in 14 days; all RESERVED |
| Previews (`preview_approval`) | 0 ever | — | — | the lane has never rendered |
| Meeting After drafts · Meet ingests | 0 · 0 | — | — | tables exist (0199, 0202); no rows yet |
| Modules (quiet roll) | 12 | — | — | `mp_home_module_seen` holds only the latest open: 11 modules opened on 19 Sep alone; `intelligence` last opened 16 Sep |
| Home layout · Private layer · Questions | — | — | — | 5 versions (last 23 Aug) · 0 · no telemetry |

---

## 2 · What moves, and where — with the read rate as the reason

| Element on Home today | Where it goes | Because |
|---|---|---|
| Brief panel's Show/Hide fold (`brief-fold`, `briefCollapse.ts`) | **Retired.** The rail is the fold | one of four toggles; hid whether it ran |
| Quiet roll "Show each / Hide them" | **Retired.** Rail chip `Quiet` shows the colleagues as dimmed rows | forgotten on reload; the roll stays as one line |
| `DeliverableList` "Show what I put away" | **Kept as a link** in the Arrived empty state and the Undo line | "where did it go" is still the question dismissing creates |
| `daily_brief` rows in `DeliverableList` | **Brief band** only | 39 of 57 deliverables were a copy of the panel above them |
| `Decide` → Approvals | **Inline** Approve · Reject · Open on the row | three screens → one press; 0 cards decided from Home ever |
| `Open anyway` on quiet modules | **Retired.** Quiet rows have one door | 11 opens in one day, one by one |
| `Stop telling me, for good` per row | **Select bar only** | 11 unsilence events: it was being used as a snooze |
| Ask dock (`ask-dock`) | **Foot line** `Ask for anything →`; Ask is also in the nav | ~150px above the answer on a phone |
| `ConnectPanel` strip | **Foot line** `Setup — [N of M] connected` opening the same panel | setup is not what 7 AM is for |
| "What this page answers" (`home-questions`) | **Help Center** (`pagePurpose.ts` already carries it) | no telemetry; reference, not news |
| `ModuleSettings` ("Home layout") | **Foot link** `Choose what Home shows` → the same component, opened on request | 5 saves, last 23 Aug |
| `PersonalIntelligencePanel` | **Off Home** → its own route (`#/private`), owner-only as today | 0 profiles, 0 entries in 30 days |
| Blocker for the viewer's own brief | **Brief band** (failed state) | said twice today |
| Modules with something new (`freshDeliveries`) | **Arrived band** as rows | they are arrivals; a colleague with news is the same shape as a packet |
| Nothing goes to Work or Portfolio | — | Work's three addresses and Portfolio's bands already hold what they own; Home links, never duplicates |

---

## 3 · The page (artboards Main · Busy · Desktop)

**Purpose line** (`pagePurpose.ts` `home`, rewritten): *What is waiting on you, what arrived since you last looked, and today's brief — on demand.*

### 3.1 Masthead (the shared `.masthead`)

Eyebrow `SATURDAY 19 SEPTEMBER · GOOD MORNING, SEQUOIA`. Answer at `--text-2xl` from **one** count, `needsHer = decisions + blockers + previews`: *"One thing is waiting on you."* / *"Three things are waiting on you."* / *"Nothing is waiting on you."* Detail names the kinds and the other two questions: *"Not a signature — Scooter's brief failed and Willow has it. One arrived since you last looked. Today's brief failed — the last one is Thursday's."* All three clauses come from counts the page already loads (`/api/mp-home`, `/api/attention/silenced`, `/api/deliverables?mine=1`, `/api/daily-intelligence/status`). `answerLine.ts` keeps its grammar and gains the `needsHer` key; `secondLine` gains the arrived and brief clauses. Nothing rounds.

### 3.2 The filter rail (artboard Rail)

`nav.rail[aria-label="Show on Home"]` of `button.rail-chip[aria-pressed]`: **All** · **Waiting on me** *n* · **Arrived** *n* · **Quiet** *n*. Counts are in the chip and in the accessible name. Pressing a chip shows only that band (the brief band stays on every filter — it is the one thing built on request); a dashed `← Home` chip appears first as the one-tap return; `Esc` also returns. **Remembered per viewer** in `localStorage` keyed on `firm_user.id` (the `briefCollapse.ts` mechanism, generalised to `homeFilter.ts`), and Home opens on it next time — **but never on an empty filter**: a remembered filter with zero rows this morning opens on All with a one-line note ("You had Waiting on me on — nothing is waiting this morning, so this is All."). Toolbar keyboard model: arrows move, Space presses. 8 states on artboard Rail: default · hover · focus-visible · active · disabled + reason ("nobody is quiet — every colleague has something new") · loading (`aria-busy`, count slot dotted) · error (`data-state=error`, "counts did not load (HTTP 502) — the rows below still show") · selected. Orange is the selected chip and nowhere else on the rail.

### 3.3 Waiting on you (artboard Waiting)

Always renders; when empty it is one line ("Waiting on you · no decision is blocked on your signature") and no card. Three kinds of row, one `.deal-row` shape (name + badge · what it is and why it is here · who/when · the act):

- **Approval card** — badge from `risk_level` (`Human-reserved` `.badge-bad`, `High`/`Medium` `.badge-gate`/`.badge`), the risk reason as the row's sentence, `Walker raised it · 6:12 AM · expires in 3 days`. Acts: **Approve** (`.btn-strong`), **Reject** (`.btn-danger`, opens the inline reason field — `decideSchema.note`, optional), **Open**. `POST /api/approvals/:id/decide`. Blocked cards show Approve disabled with the `waiting_on` sentence and `Release the block`.
- **Stage proposal** (`meeting_stage_proposal`, Phase B) — **Move it** (`.btn-strong`) / **Leave it** / **Open**. A click, not a card (Deals spec §3).
- **Preview** (`preview_approval`) — first in the band because it decays; **Approve and send** is the page's **one** `.btn-primary`; **Send back** · **Open**.
- **Blocker** (`operatorAttention`) — badge `Blocked`/`Degraded`/`Setup`, the headline, the action sentence, the owner. Acts: **Open** · **I know — quiet for a week** (`POST /api/attention/:key/dismiss {kind: ACKNOWLEDGED}`).

**Select-many** (`Select…` on the band head → a checkbox per row, `.select-bar` under the head): `I know — quiet selected for a week` · `Stop telling me` · `Cancel`. **Approval rows cannot be ticked** — the checkbox is disabled with `aria-describedby` "Decided one at a time — a human-reserved action is never approved in a batch." **There is no `Approve selected`.** The repo's rules: every one of the 18 cards production has ever raised is `RESERVED` (`ai_employee.activate`, `meet.recording_policy.firm_default`); `assertMayAct` decides one card per call; ADR-018 refused a blanket "approve everything today" and forbids standing authority from reaching the 53 reserved and 4 external actions. A batch approve would have applied to zero real cards and would sit against the letter of ADR-018. Done state: silent, one `.notice-ok` line "2 quieted until Sat 26 Sep … Undo"; no toast.

**Approvals law:** unchanged card count; one click per card instead of three. Inline Approve in 8 states on the artboard (default · hover · focus · active · disabled + reason · loading "Approving…" · error "Not approved — it is no longer pending (somebody decided it at 7:02 AM)" · success `approved 7:04 AM` badge, row leaves on next read).

### 3.4 Arrived (artboard Arrived)

Deliverables for the viewer (`/api/deliverables?mine=1`, `kind ≠ daily_brief`, not acknowledged, not dismissed, within `put_away_after_days`), **meeting After drafts** (`meeting_after_draft` awaiting approval — the row says "approve on the After face"), **Meet ingests** (`meet_event_inbox` → the meeting record; `type_inference = UNKNOWN_CHECK_IT` → `.badge-gate` "type inferred, check it"), and modules with something new (`freshDeliveries`) as rows with the colleague's headline. Head: `Mark all read` (`.btn-ghost`) · `Select…` · when. Row: name · `who · kind · when · unread` · acts **Open** (`.btn-strong`) · **Read** (`/acknowledge`) · **Put away** (`/dismiss`). A read row shows `.badge-quiet read` and drops Read. Select bar: `Mark selected read` · `Put away selected` · `Cancel`. Done: "2 put away. They are under what I put away. Undo". Empty: one `.state-empty` line with the put-away link. `Mark all read` in 8 states on the artboard; its error state is honest about partial success ("2 of 3 marked; the transcript was not (HTTP 409)").

### 3.5 Today's brief (artboard Brief) — on demand only

Reads `GET /api/daily-intelligence/status` (the branch's route; `briefRunState()` on the row) every 5 s while moving; reloads the report when a moving state stops. **Under the on-demand rule the branch's `scheduled` and `off` kinds collapse into one `idle` state** — "No brief today. The last one is Thursday's — 2 days ago." with the last brief's edition, counts and model, and `Open Thursday's`. Nothing on the band mentions a clock; `migration 0211`'s weekend default and `nextStartAt` become irrelevant to the band (the server may keep them; the band never shows them). Built on Sonnet: `report.model` is shown in the examined line, as today.

The one button's label is `run.button.label`, never client-derived. Eight states, each on the artboard with its notice tone:

| # | kind | line | button | track |
|---|---|---|---|---|
| 1 | idle | No brief today. The last one is Thursday's — 2 days ago. | `Build today's brief` | — |
| 2 | requested | Requested. It starts within a minute. | disabled `Requested — starting` | 2%, stage strip empty |
| 3 | running | Building — writing it. Started 6 minutes ago; usually about 27 minutes. | disabled `Already building — started 6m ago` | elapsed ÷ usual, ink fill, live dot, stage strip `read 48h · ranked · writing · checked` |
| 4 | running, past usual | Still building — checking every claim… 31 minutes in; usually about 27. | disabled | 95% cap, `.notice-gate`, warn fill, "the slow end is 37 min" |
| 5 | arrived | Today's brief arrived at 7:26 AM. | `Rebuild` (ghost) | — ; the one-minute version opens under it with Read the full report · Mark as read · Email it to me |
| 6 | retrying | No brief yet — attempt 1 of 3 failed: … tries again by itself at 7:49 AM | `Try again now` | — |
| 7 | failed_out | No brief this morning. It was tried 3 times and failed each time; the last reason: … | `Try again` | — ; last brief's age and `Open it` |
| 8 | stalled | The brief stopped while writing it, 34 minutes ago … | `Start over now` | — |

The button's own 8 visual states are the last block of the artboard (success = the 202 from `POST /generate`, label becomes `Requested — starting`). Orange is on the live dot only; the fill is ink so a bar never reads as a call to action. `prefers-reduced-motion` stops the dot and the width transition (existing rules).

### 3.6 Quiet

One `.quiet-roll` line naming the colleagues (deduped) with "Filter by Quiet above to see each." Under the Quiet chip, each is a `.deal-row-out` with the face, the `whenEmpty` sentence, "nothing new since {seen_at}" and one door (`Open Portfolio`). No "Open anyway".

### 3.7 Foot

`Ask for anything → · Choose what Home shows · Setup — [N of M] connected` — one `rail-note` line. `Choose what Home shows` opens `ModuleSettings` in place; Setup opens the `ConnectPanel` body.

### 3.8 Desktop (artboard Desktop)

The same content in the product's shell: the black rail (Home active with the orange left rule), the paper header, one column at `max-width: 960px`. Rows keep two cells (facts · acts); nothing gains a column the phone does not have — consistency over variety.

---

## 4 · Data, per band (route · table · what would be new)

| Band | Reads today | Would be new |
|---|---|---|
| Masthead | `/api/mp-home` (`modules[approvals].items`), `/api/attention/silenced` + `operatorAttention`, `/api/preview-approvals`, `/api/deliverables?mine=1`, `/api/daily-intelligence/status` | `answerLine.ts`: `needsHer` key + arrived and brief clauses; a `quiet` count of colleagues not modules |
| Rail | the same counts | `client/lib/homeFilter.ts` (per-viewer memory, `briefCollapse.ts` pattern); the "empty filter → All" rule as a pure function with a test |
| Waiting | `approval_card` (`state = pending_review`, `risk_level`, `blocked_waiting_on`, `expires_at`), `preview_approval`, `meeting_stage_proposal WHERE state='PROPOSED'` (**new feed** — the Deals spec §4 `GET /api/dealflow/proposals`, or folded into `/api/mp-home`), `operatorAttention` | inline decide from Home = existing `POST /api/approvals/:id/decide`; select-many acknowledge = N × `POST /api/attention/:key/dismiss` or **one batch route** `POST /api/attention/dismiss-many {items:[{key,signature}], kind}`; dedupe rule: drop the attention item whose `check_key` is the viewer's own brief |
| Arrived | `/api/deliverables?mine=1` (exclude `kind = daily_brief`), `meeting_after_draft` awaiting approval (new query on Phase B table), `meet_event_inbox` (Phase Meet), `mp_home_module_seen` for fresh modules | **`POST /api/deliverables/acknowledge-many`** and **`/dismiss-many`** `{ids}` (or N calls — the batch route is preferred so partial failure is one honest answer); `deliverable_feedback` untouched |
| Brief | `GET /api/daily-intelligence/status` + `GET /api/daily-intelligence` + `POST /api/daily-intelligence/generate` (branch) | the `idle` collapse of `scheduled`/`off` in `briefRunState()` (one branch, one test); `expectations` already measured; nothing else |
| Quiet | `/api/mp-home` modules with `has_new = false`, `seen_at` | — |
| Foot | `/api/me/connections`, `/api/mp-home/preferences` | — |

Read events that would tell the next designer more: a `home.filter_changed` and a `home.mark_all_read` event on `event_record`, and a per-module open count (today `mp_home_module_seen` overwrites). Not required to build; named so the next audit has them.

---

## 5 · Classes this design adds to `styles.css` (tokens only; register in `design/DEALS_SECTION_CLASSES.json` or a sibling `HOME_CLASSES.json` for `validate:css-classes`)

`.rail`, `.rail-chip` (+ `[aria-pressed]`, `[aria-busy]`, `[data-state]`, `:disabled`, `.rail-home`), `.rail-note`, `.row-select`, `.check`, `.select-bar`, `.band-act`, `.brief-state`, `.brief-line`, `.brief-meta`, `.brief-stage`, `.brief-stage-words`. Retired once nothing emits them: `.brief-fold`, `.daily-brief-collapsed`, `.ask-dock`, `.ask-open`, `.ask-label`, `.ask-note`, `.home-band*` (→ `.band*`), `.home-section-head` on Home, `.delivery*`, `.quiet-roll` toggle button. `.masthead*`, `.band*`, `.deal-row*`, `.count-pill`, `.badge*`, `.notice*`, `.progress-track`, `.live-dot`, `.state-empty` are reused as they are.

---

## 6 · Pre-emit self-critique (Hallmark axes P·H·E·S·R·V, 1–5; nothing < 3 shipped)

| Artboard | P | H | E | S | R | V | Revised before emit |
|---|---|---|---|---|---|---|---|
| Main · 390 real | 5 | 5 | 4 | 5 | 5 | 4 | masthead said "Nothing is waiting" over a band saying 1 — the same contradiction the live page has; answer re-keyed on `needsHer` |
| Busy · 390 | 5 | 4 | 4 | 5 | 4 | 4 | two orange Approve buttons plus the orange chip and pills in one screen: row Approve demoted to `.btn-strong`; the preview's Approve and send is the one primary |
| Desktop · 1280 | 5 | 5 | 4 | 5 | 5 | 4 | — |
| Rail | 5 | 5 | 4 | 5 | 5 | 4 | a "opened 4 times this week" count removed — `mp_home_module_seen` cannot say it |
| Waiting | 5 | 5 | 4 | 5 | 4 | 4 | reject help text said "three characters or more" — that is the reopen/block rule, not `decideSchema`; corrected |
| Arrived | 5 | 5 | 4 | 5 | 5 | 4 | — |
| Brief | 5 | 5 | 4 | 5 | 5 | 4 | — |

E is 4 throughout for the reason the Deals spec recorded: Inter is not downloaded in the product, so boards render in the platform face wherever it is absent.

## 7 · Mobile verification (measured, not asserted)

Every board rendered in headless Chromium (Playwright from the worktree's `node_modules`) at its declared width; the two phone boards re-rendered at **320 / 375 / 414 / 768**. Assertions: root `scrollWidth ≤ clientWidth`; no descendant's right edge past the frame (the rail is the one declared inner scroller); no `<button>`/`.rail-chip` whose text spans two line boxes; no control under 24px; every checkbox's hit area ≥ 44×44. **Result: 7/7 boards clean at declared width; 2/2 phone boards clean at all four widths; zero wrapped clickables; zero small controls.** Heights on the canvas are the measured natural height + 24px. First screen at 390×844 on the real snapshot: masthead, rail, the Waiting head and its one row, and the Arrived head — both of the owner's questions are answered above the fold; on the busy morning the three waiting rows fill the first screen and Arrived is the first thing below it.

## 8 · Accessibility, per band

| Check | Masthead + rail | Waiting | Arrived | Brief | Quiet |
|---|---|---|---|---|---|
| Structure | `header.masthead` → `h2`; `nav[aria-label]` of buttons with `aria-pressed`; each band a `section[aria-labelledby]` with `h3` | `ul.deal-list > li`; badge words precede the name so the kind is read first | same; checkbox `label.check` wraps a real `input` with an `aria-label` naming the row | `div[role=status][aria-live=polite]`; `role=progressbar` with `aria-valuenow/min/max`; stage words `aria-hidden` (the line says the stage) | `p.quiet-roll`; rows `li` |
| Keyboard | rail = toolbar: `←`/`→` move, Space presses, `Esc` → All; the `← Home` chip is a real button | every act a `<button>`; Reject is `aria-expanded` over the inline field; first field takes focus; `Esc` = Never mind | select bar `role=toolbar`; `Select…` toggles checkboxes into the tab order | the one button; disabled carries `aria-disabled` and the reason is its label | one door per row |
| Focus | global ring (`--wp-orange` 2px, offset 2; inset on the rail chips so the scroller never clips it); never transitioned | same | same | same | same |
| Non-colour cues | selected chip also says so via `aria-pressed`; counts are digits | badge words (`Human-reserved`, `Degraded`, `Setup`); disabled checkbox has `aria-describedby` saying why | `read` badge word; select bar count in words | tone + the sentence; live dot is `aria-hidden` and the line says "Building"; the 95% cap is stated in words | dimmed facts, full-ink names |
| Contrast | ink 18.7:1, ink-2 9.6:1, muted 5.9:1 on white; `--wp-orange-ink` on orange fills 6.2:1; warn/danger text on their tints as the product measures them | same | same | same | same |
| Touch | 44px chips, buttons and checkbox hit areas on the phone boards; 34px desktop buttons keep 44px chips | same | same | same | same |
| Reduced motion | none | none | none | dot and fill transition off | none |
| Loading / error / empty | rail chips `aria-busy` / `data-state=error` with words; masthead never says a count it has not loaded | one-line empty band; error strings state the HTTP status | `.state-empty` with the put-away link | every state named; the failed state names the reason from the row | — |

## 9 · Build order

1. **Classes and shared pieces** (one agent, `styles.css` + `answerLine.ts` + `homeFilter.ts`): §5 classes; `answerLine` re-keyed on `needsHer` with the arrived/brief clauses (strengthen `tests/answerLine.test.ts` — the "keyed on decisions alone" pin becomes "keyed on needsHer, and the detail names the kind"); the filter-memory module with its empty-filter rule and test.
2. **Brief band** (after `fix/the-morning-brief-arrives` lands): `DailyBriefPanel` loses `compact/collapsed/onToggleCollapsed`; the band renders the eight states from `run`; `briefRunState()` gains the `idle` collapse; `validate:brief-lands` drives `idle`. Remove `briefCollapse.ts` and the `daily_brief` rows from Home's `DeliverableList`.
3. **Home page**: masthead + rail + the four bands; `Waiting` rows with inline decide (reuse `ApprovalsPage`'s `decide()` and reason field); select-many with the two batch routes (`acknowledge-many`, `dismiss-many`, `attention/dismiss-many`) — each hard-fails when given zero ids; stage proposals from the Deals spec's proposals feed once it exists (row hidden until then, never a placeholder).
4. **Moves**: Ask dock, Connect strip, ModuleSettings, questions, private layer to their §2 homes; `pagePurpose.home` rewritten.
5. **Guards**: extend `e2e/d2-home-measured` (0 overflow at 320/375/414/768, 0 wrapped clickables, 0 targets < 24px, ≥ 1 element per band examined — Rule 0); a spec that the masthead count equals the Waiting pill; a spec that `daily_brief` never renders in Arrived; `validate:heading-scale` for `.masthead h2` / `.band-head h3` on Home.

## 10 · Approval questions (only she can answer)

1. **No `Approve selected`, by the rules.** Every card production has ever raised is human-reserved, and ADR-018 refused a blanket approve; the design gives one-press inline Approve per card and select-many only for quieting blockers and clearing arrivals. Confirm — or say that LOW/MEDIUM, non-reserved, non-external cards may be ticked and approved together (N recorded decisions), which the choke point would allow.
2. **The brief band never mentions a clock.** On demand only means the branch's scheduled/weekend states collapse into "No brief today — the last one is Thursday's". Confirm the 06:15 schedule and migration 0211's weekend default are retired from the band (the server may keep the tick as the worker that builds what she requests).
3. **Ask and Setup move to the foot.** Ask stays in the nav and as the foot link; the Connect strip opens from the foot. Confirm Ask no longer sits under the masthead (the 17 Aug direction was "findable on Home", which the foot line and the nav item meet).
