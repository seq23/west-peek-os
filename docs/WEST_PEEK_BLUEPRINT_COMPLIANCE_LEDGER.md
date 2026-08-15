# West Peek Blueprint Compliance Ledger

**Living completion contract for the P13–P25 continuation.** Opened at P13 by independent
verification of the supplied gap audit against the code actually present in this tree.
Updated at the end of every phase (task §14).

Authority: `TASK/APPROVED_TASK.md` §6 (this ledger), §5 (capability state model), §8 (the audit).
Preserved baseline: P0–P12 (migrations `0001`–`0012`, `IMPLEMENTATION_LEDGER.md`).

## Capability state vocabulary (task §5)

`ABSENT` · `STRUCTURAL` · `FIXTURE_ONLY` · `DRY_RUN_PROVEN` · `INTEGRATED_UNPROVEN` ·
`PRODUCTION_READY_PARTIAL` · `PRODUCTION_READY_FULL`

A state is never raised above its proof. "Artifact exists" is not a capability.

## How P13 verification was performed

1. Enumerated every `/api/*` route actually registered in `src/worker/index.ts` (routes are the
   real backend surface, not the docs).
2. Enumerated every table actually created by `migrations/0001`–`0012` (persistence truth).
3. Enumerated every page actually reachable from `NAV_ITEMS` in `src/client/App.tsx` (the real
   operator surface — a service with no page is `BACKEND_ONLY` by definition).
4. Enumerated the vitest suites (`tests/*.test.ts`) and Playwright journeys (`e2e/*.spec.ts`).
5. Classified each audit claim against that evidence, not against filenames.

Verified pre-continuation inventory (P0–P12 baseline):

- 12 migrations, ~100 tables; `event_record`, `approval_card`, `ai_run`, `diligence_claim`,
  `canonical_company`, `meeting`, `portfolio_alert`, `lp_claim`, `fund_construction_scenario`,
  `lp_reporting_packet`, `fund_reconciliation_run` present and exercised.
- 18 nav pages: Today, +Capture, Work Cards, Approvals, Companies, Investment, Meetings,
  Portfolio, Network OS, LP, Allocation, Reporting, Documents, Contradictions, Activity,
  Governance, AI, Diagnostics.
- 17 vitest suites (309 tests at the P12 gate), 11 Playwright specs (16 tests).
- **No** table, route, or page named notification, briefing, watchlist, intelligence, work packet,
  lens, capability, scheduled job, research project, machine state, or provider model existed
  before this continuation (verified by tree-wide search, P13).

---

## GAP-01 — Employee Lounge / Workforce Command Center

| Field | Content |
|---|---|
| Requirement ID | REQ-WORKFORCE-01 |
| Requirement | An operable governed surface for the 31 AI employees: identity, department, manager, machines, lifecycle, current work, outputs, cost, performance, permissions, talk-to/assign entry, activate/deactivate/reassign, team rooms |
| Blueprint authority | Task §8 GAP-01; canon D10 workforce law; machine 41 (AI Employee Performance + Cost Ledger + Lifecycle Control) |
| Audit claim | 31 employees exist as registry/reference data, no real employee operating UX |
| Current UI (P13) | **None.** `NAV_ITEMS` has no employees page; `AiPage` renders runs/providers/budget only |
| Current backend (P13) | `GET /api/ai/employees`, `GET /api/ai/employees/:id`, request-activation, activate, tools (`services/aiEmployees.ts`) |
| Persistence (P13) | `ai_employee` (31 seeded rows), `ai_employee_status_history`, `ai_employee_tool_scope` (0004) |
| Tests (P13) | `tests/ai.test.ts` activation cap/receipt tests |
| Deployed/live proof | none |
| Classification | **BACKEND_ONLY** — the audit claim is TRUE |
| Capability state (P13) | `STRUCTURAL` |
| Required build | Lounge + employee detail + department rooms + assignment/handoff + scorecards + lifecycle controls, all through `authorize()` |
| Phase | P15 |
| Final evidence | see "Phase close-out" below |
| Remaining external gate | live model execution per employee remains CREDENTIAL-gated |

## GAP-02 — AI Cost Command Center

| Field | Content |
|---|---|
| Requirement ID | REQ-COST-02 |
| Requirement | Operating cost controls: period budgets, scoped budgets, categories, surge windows, alerts, history, attribution, estimated-vs-actual, wasted cost, forecast, kill switches |
| Blueprint authority | Task §8 GAP-02; canon D8 cost modes; machine 40/41 |
| Audit claim | backend cost modes/caps exist, operating controls/analysis thin |
| Current UI (P13) | `AiPage` shows one line: privacy mode, cost mode, today spend vs daily cap |
| Current backend (P13) | `GET/POST /api/ai/budget` (firm-wide `budget_policy` only), `dailySpendUsd()` in `runAi.ts` |
| Persistence (P13) | `budget_policy` (firm-scope, versioned, append-only), `ai_run.cost_estimate_json` / `actual_usage_json` |
| Tests (P13) | `tests/ai.test.ts` per-run + daily cap, surge expiry |
| Deployed/live proof | none — no live provider spend has ever occurred |
| Classification | **PARTIAL_UX** — claim TRUE: enforcement is real, operator analysis/scoping is not |
| Capability state (P13) | `PRODUCTION_READY_PARTIAL` (firm-wide caps) / `ABSENT` (scoped budgets, attribution, forecast) |
| Required build | scoped budget records with authority + change history, spend attribution, waste accounting, alerts, forecast, category budgets |
| Phase | P16 |
| Final evidence | see "Phase close-out" |
| Remaining external gate | actual (not estimated) provider cost requires live provider usage |

## GAP-03 — Live provider / model router

| Field | Content |
|---|---|
| Requirement ID | REQ-ROUTER-03 |
| Requirement | Provider registry UI, OpenRouter + Fireworks adapters, credential-presence status, model catalog with capability/context/cost/privacy metadata, task routing, fallback, health, benchmarks, promotion/demotion, routing explanation, per-task and per-machine override |
| Blueprint authority | Task §8 GAP-03, §12; canon D9 providers-as-configuration |
| Audit claim | provider policy exists; product is not a live multi-model operating system |
| Current UI (P13) | provider list with enable/kill-switch only |
| Current backend (P13) | `GET /api/ai/providers`, kill-switch, enable; `runAi()` selects cheapest priced capable model |
| Persistence (P13) | `provider_registry`, `provider_pricing_snapshot`, `provider_data_policy` (0004); one generic `httpExternal` adapter + `mockLocal` |
| Tests (P13) | `tests/ai.test.ts` egress default-deny, kill switch, model selection |
| Deployed/live proof | none — `UNPROVEN — CREDENTIAL GATE` in `IMPLEMENTATION_LEDGER.md` |
| Classification | **PARTIAL_UX + TRUE_MISSING_REQUIREMENT** (no model catalog, no routing policy, no health, no benchmarks, no named vendor adapters) |
| Capability state (P13) | `STRUCTURAL` |
| Required build | model catalog with pricing provenance state, routing policy + fallback + explanation, health checks, evaluations, promotion/demotion, named adapters |
| Phase | P16 (+ P23 specialist lane) |
| Final evidence | see "Phase close-out" |
| Remaining external gate | every live provider call — no vendor credential exists in this environment |

## GAP-04 — MP Home / Executive Command Center

| Field | Content |
|---|---|
| Requirement ID | REQ-MPHOME-04 |
| Requirement | Configurable MP command surface: brief, markets, secondaries, funding/M&A, watchlist, AI/tech, regulatory, portfolio, competitor, LP signals, meetings, IC priorities, alerts, approvals digest, spend, "one thing to watch", what changed; plus a private personal-intelligence layer |
| Blueprint authority | Task §8 GAP-04, §4 ten MP questions; machine 1 (Command Center) |
| Audit claim | Today page is useful but not the intended MP command surface |
| Current UI (P13) | `TodayPage`: my open work cards, pending-approval count, last 10 events. Three sections, no configuration, no cross-system synthesis |
| Current backend (P13) | `/api/work-cards`, `/api/approvals`, `/api/activity` — no aggregation endpoint |
| Persistence (P13) | none specific to home |
| Tests (P13) | `e2e/p1-shell.spec.ts` renders Today |
| Deployed/live proof | none |
| Classification | **PARTIAL_UX** — claim TRUE |
| Capability state (P13) | `STRUCTURAL` |
| Required build | module registry + per-user module preferences, one aggregation service answering the ten questions, private MP layer with default-deny |
| Phase | P14 (+ coherence closed at P25) |
| Final evidence | see "Phase close-out" |
| Remaining external gate | astrology/ephemeris calculation source |

## GAP-05 — Daily Intelligence Engine

| Field | Content |
|---|---|
| Requirement ID | REQ-INTEL-05 |
| Requirement | schedule → retrieval → dedupe → relevance → synthesis → citations → archive → notification → feedback, with preferences, watchlists, source registry, follow-up research, failure/retry/idempotency |
| Blueprint authority | Task §8 GAP-05; machine 23/45 |
| Audit claim | absent |
| Current UI (P13) | none |
| Current backend (P13) | none |
| Persistence (P13) | none |
| Tests (P13) | none |
| Deployed/live proof | none |
| Classification | **TRUE_MISSING_REQUIREMENT / NEWLY_AUTHORIZED_SCOPE** |
| Capability state (P13) | `ABSENT` |
| Required build | full engine as specified |
| Phase | P14 (scheduling wired at P19; research follow-up at P21) |
| Final evidence | see "Phase close-out" |
| Remaining external gate | live external news/market feeds (network egress + subscriptions) |

## GAP-06 — Machine Control Center

| Field | Content |
|---|---|
| Requirement ID | REQ-MACHINE-06 |
| Requirement | Machines page: domain, purpose, owner, assigned employees, workflows, queue, loops, outputs, health, spend, failures, SLA, dependencies, data access, tools, model policy, pause/resume, configuration, memory |
| Blueprint authority | Task §8 GAP-06; canon §5A.2 45-machine registry (D14) |
| Audit claim | 45 machines exist in registry form but are not operable |
| Current UI (P13) | none — machines appear only as a `<select>` of routing targets on +Capture |
| Current backend (P13) | `GET /api/machines`, `GET /api/domains` (read-only reference data) |
| Persistence (P13) | `machine` (45 rows), `domain` (15 rows) — reference only, no operational state columns |
| Tests (P13) | `tests/api.test.ts` registry count 45 |
| Deployed/live proof | none |
| Classification | **BACKEND_ONLY** — claim TRUE |
| Capability state (P13) | `STRUCTURAL` |
| Required build | operational machine state (owner/SLA/priority/tools/data access/model policy/pause), assignments, dependencies, memory, run + spend + failure rollups, control surface |
| Phase | P17 |
| Final evidence | see "Phase close-out" |
| Remaining external gate | none locally |

## GAP-07 — Capability Intelligence Center

| Field | Content |
|---|---|
| Requirement ID | REQ-CAPABILITY-07 |
| Requirement | Capability cards, Active/Bench/Archive, confidence/maturity, model+tool dependencies, cost, tested state, employee/machine assignment, after-action performance, build-vs-buy record, recommended stack |
| Blueprint authority | Task §8 GAP-07; machine 38 (Vendor Risk + Build-vs-Buy) |
| Audit claim | absent |
| Current UI (P13) | none |
| Current backend (P13) | `ai_run.capability_requirement` is a free-text string with no registry behind it |
| Persistence (P13) | none |
| Tests (P13) | none |
| Deployed/live proof | none |
| Classification | **TRUE_MISSING_REQUIREMENT / NEWLY_AUTHORIZED_SCOPE** |
| Capability state (P13) | `ABSENT` |
| Required build | internal capability registry + assignments + after-action records + build-vs-buy decisions |
| Phase | P17 |
| Final evidence | see "Phase close-out" |
| Remaining external gate | none locally |

## GAP-08 — Intent-to-Execution / Work Packet UX

| Field | Content |
|---|---|
| Requirement ID | REQ-INTENT-08 |
| Requirement | rough thought → interpretation → ambiguity → assumptions → risks → output definition → acceptance criteria → lens stack → employee → machine → capability → model → cost estimate → Work Packet → execution, with adjustable enhancement strength that never hides the original text |
| Blueprint authority | Task §8 GAP-08; machine 42 (Prompt Enhancer + Intent-to-Execution) |
| Audit claim | Capture is text + manual machine selection |
| Current UI (P13) | `CapturePage`: capture_type, source_channel, raw text, privacy label, then a machine `<select>` — exactly as the audit claims |
| Current backend (P13) | `POST /api/captures`, `POST /api/captures/:id/route` (creates a work card) |
| Persistence (P13) | `capture`, `work_card` |
| Tests (P13) | `e2e/p3-governed-work.spec.ts` |
| Classification | **PARTIAL_UX** — claim TRUE |
| Capability state (P13) | `STRUCTURAL` |
| Required build | work packet record + revisions + enhancement + routing recommendation + governed execution |
| Phase | P18 |
| Final evidence | see "Phase close-out" |
| Remaining external gate | live model enhancement quality (local deterministic adapter proves the pipeline only) |

## GAP-09 — Institutional Lens Bench

| Field | Content |
|---|---|
| Requirement ID | REQ-LENS-09 |
| Requirement | Selectable Lead / Supporting / Counter / Hostile Reviewer / Truth-Compliance Gate / No Pedestal lenses; UI shows which ran; store decisions/critiques/evidence/summaries, never hidden chain-of-thought |
| Blueprint authority | Task §8 GAP-09, §12 |
| Audit claim | absent |
| Current UI/backend/persistence (P13) | none |
| Classification | **TRUE_MISSING_REQUIREMENT / NEWLY_AUTHORIZED_SCOPE** |
| Capability state (P13) | `ABSENT` |
| Required build | lens registry + per-packet lens outputs with a structural ban on reasoning-trace persistence |
| Phase | P18 |
| Final evidence | see "Phase close-out" |
| Remaining external gate | none locally |

## GAP-10 — Digital Office / Employee Collaboration

| Field | Content |
|---|---|
| Requirement ID | REQ-OFFICE-10 |
| Requirement | Departments/rooms, status, manager relationships, governed conversations, handoffs, chains, mentions, briefs, memos, delegation, manager review, announcements, governance acknowledgements |
| Blueprint authority | Task §8 GAP-10 |
| Audit claim | absent |
| Current UI/backend (P13) | `governance_update` (MP broadcast) exists; no rooms, no handoffs, no acknowledgements |
| Persistence (P13) | `governance_update` only |
| Classification | **TRUE_MISSING_REQUIREMENT** (partially served by governance updates) |
| Capability state (P13) | `ABSENT` |
| Required build | rooms + messages tied to work/evidence + handoffs + memos + acknowledgements; no autonomous chatter |
| Phase | P15 |
| Final evidence | see "Phase close-out" |
| Remaining external gate | none locally |

## GAP-11 — Employee Performance Management

| Field | Content |
|---|---|
| Requirement ID | REQ-PERF-11 |
| Requirement | Scorecards, success/failure, revision/rejection rates, cost per accepted output, failure patterns, PIP/retraining/restricted/retired lifecycle, transparent value measures, manager review |
| Blueprint authority | Task §8 GAP-11; machine 41 |
| Audit claim | absent |
| Current backend (P13) | `eval_record` and `value_outcome` tables exist (0004) but **no route writes or reads them** — verified: neither identifier appears in `src/worker/**` |
| Persistence (P13) | `eval_record`, `value_outcome` (unused), `ai_employee_status_history` |
| Classification | **TRUE_MISSING_REQUIREMENT** — the tables are a schema stub, not a capability |
| Capability state (P13) | `ABSENT` (computed scorecards) |
| Required build | deterministic scorecard computation over `ai_run` + approvals, lifecycle controls with authority + history, manager review |
| Phase | P15 |
| Final evidence | see "Phase close-out" |
| Remaining external gate | "value generated" stays labelled heuristic, never money |

## GAP-12 — Portfolio Intelligence Cockpit

| Field | Content |
|---|---|
| Requirement ID | REQ-PORTCOCKPIT-12 |
| Requirement | MP view: top risks, improving/deteriorating, runway, next financing, events, support asks, follow-on candidates, secondary opportunities, stale updates, ownership changes, reserve demand, what changed this week |
| Blueprint authority | Task §8 GAP-12 |
| Audit claim | substrate exists, MP view does not |
| Current UI (P13) | `PortfolioPage`: metric definitions, snapshots, evaluate, alert list, support requests |
| Current backend (P13) | full P8 substrate (`portfolio_alert`, `portfolio_metric_snapshot`, `support_request`) |
| Persistence (P13) | 0008 tables |
| Tests (P13) | `tests/portfolio.test.ts`, `e2e/p8-portfolio.spec.ts` |
| Classification | **PARTIAL_UX** — substrate `ALREADY_IMPLEMENTED`, cockpit missing |
| Capability state (P13) | `PRODUCTION_READY_PARTIAL` (substrate) / `ABSENT` (cockpit) |
| Required build | one cockpit aggregation over existing tables — no second truth store |
| Phase | P25 |
| Final evidence | see "Phase close-out" |
| Remaining external gate | none locally |

## GAP-13 — Allocation Decision Visualization

| Field | Content |
|---|---|
| Requirement ID | REQ-ALLOCVIZ-13 |
| Requirement | Strategic comparison across new seed / follow-on / pro rata / super pro rata / secondary / reserve / partial + full exit with capacity, concentration, ownership, reserve coverage, scenario MOIC/IRR, downside, liquidity timing, opportunity cost, constraints, visible assumptions |
| Blueprint authority | Task §8 GAP-13 |
| Audit claim | governed calculations exist; strategic comparison view does not |
| Current UI (P13) | `AllocationPage`: scenario create, options, run comparison, per-option results, approval routing |
| Current backend (P13) | `services/allocation.ts` (792 lines) + `shared/allocation` (290 lines): constraint/concentration/reserve math, `constraint_violation`, option approval routing |
| Persistence (P13) | 0011 tables |
| Tests (P13) | `tests/allocation.test.ts`, `e2e/p11-allocation.spec.ts`, `docs/ALLOCATION_VERIFICATION.md` |
| Classification | **PARTIAL_UX** — calculations `ALREADY_IMPLEMENTED`; the audit's implication that allocation math is missing is FALSE |
| Capability state (P13) | `PRODUCTION_READY_PARTIAL` (gated on formula acceptance) |
| Required build | comparison presentation layer with visible assumptions and explicit "scenarios are not predictions" |
| Phase | P25 |
| Final evidence | see "Phase close-out" |
| Remaining external gate | FORMULA-VERIFICATION ACCEPTANCE GATE (§7.2) — unchanged, operator has not accepted |

## GAP-14 — Research / Analyst Workstation

| Field | Content |
|---|---|
| Requirement ID | REQ-RESEARCH-14 |
| Requirement | Launch research, define questions, inspect sources/claims, compare contradictions, market maps, research packets, evidence saving, company-intelligence proposals, knowledge promotion, IC-ready output |
| Blueprint authority | Task §8 GAP-14; machine 23 |
| Audit claim | absent |
| Current UI (P13) | `ContradictionsPage`, `DocumentsPage`, company evidence panel — evidence review exists; research *initiation* does not |
| Current backend (P13) | full P5 evidence substrate (claims, sources, contradictions, knowledge promotion) |
| Classification | **TRUE_MISSING_REQUIREMENT** on the console; **ALREADY_IMPLEMENTED** on the evidence substrate it must feed |
| Capability state (P13) | `ABSENT` (console) |
| Required build | research projects/questions/findings that write into the EXISTING claim/knowledge substrate |
| Phase | P21 |
| Final evidence | see "Phase close-out" |
| Remaining external gate | live source retrieval (network egress) |

## GAP-15 — Harvey / Norm specialist lane

| Field | Content |
|---|---|
| Requirement ID | REQ-SPECIALIST-15 |
| Requirement | Bounded specialist-provider adapters with status/routing/quarantine/cost/privacy, never bypassing the governed AI boundary |
| Blueprint authority | Task §8 GAP-15, §9 P23 (newly authorized) |
| Audit claim | absent |
| Current state (P13) | absent — no vendor named Harvey or Norm appears anywhere in the tree |
| Classification | **NEWLY_AUTHORIZED_SCOPE** |
| Capability state (P13) | `ABSENT` |
| Required build | registry entries + adapters + lane routing + engagement records; fail closed without credentials |
| Phase | P23 |
| Final evidence | see "Phase close-out" |
| Remaining external gate | **VENDOR ACCESS GATE** — no Harvey/Norm account, contract, credential, or published API contract is available in this environment. Live behaviour cannot be proven and is not claimed |

## GAP-16 — Network OS live integration

| Field | Content |
|---|---|
| Requirement ID | REQ-NETWORK-16 |
| Requirement | Adapter contract + operator status: direction/ownership, cursors, idempotency, conflict detection, audited writeback proposals, failure handling, external status, no silent overwrite |
| Blueprint authority | Task §8 GAP-16; canon D5 |
| Audit claim | integration incomplete |
| Current UI (P13) | `NetworkPage`: declare contract, pull, sync state, mappings, conflicts, resolve, writeback |
| Current backend (P13) | `services/networkAdapter.ts` (748 lines): contract, cursors, idempotent receipts, conflict rows, reserved writeback |
| Persistence (P13) | 0009 tables |
| Tests (P13) | `tests/network.test.ts`, `e2e/p9-network.spec.ts` |
| Classification | **EXTERNALLY_UNPROVEN** — the audit's "not built" reading is FALSE; the contract layer is `ALREADY_IMPLEMENTED`. What is missing is a *connector status* surface |
| Capability state (P13) | `INTEGRATED_UNPROVEN` |
| Required build | connector/credential-presence status surface + doctor; no partner-repo mutation |
| Phase | P22 |
| Final evidence | see "Phase close-out" |
| Remaining external gate | INTEGRATION APPROVAL + CREDENTIAL GATE (unchanged) |

## GAP-17 — Meeting Intelligence live experience

| Field | Content |
|---|---|
| Requirement ID | REQ-MEETING-17 |
| Requirement | Upcoming-meeting prep, calendar awareness, transcript/import status, consent state, summaries, commitments, follow-ups, relationship proposals, debrief, live-provider status |
| Blueprint authority | Task §8 GAP-17 |
| Audit claim | substrate exists, live experience does not |
| Current UI (P13) | `MeetingsPage` + `MeetingDetail`: create, transition, consent, recording policy, prep, transcript, notes, commitments, convert, debrief |
| Current backend (P13) | `services/meetings.ts` (893 lines) |
| Persistence (P13) | 0007 tables |
| Tests (P13) | `tests/meetings.test.ts`, `e2e/p7-meetings.spec.ts` |
| Classification | **EXTERNALLY_UNPROVEN + PARTIAL_UX** — substrate `ALREADY_IMPLEMENTED`; upcoming-prep queue and connector status missing |
| Capability state (P13) | `PRODUCTION_READY_PARTIAL` locally / `ABSENT` for calendar+transcription connectors |
| Required build | prep queue over scheduled meetings + connector status + consent-aware gating surface |
| Phase | P22 |
| Final evidence | see "Phase close-out" |
| Remaining external gate | CALENDAR / EMAIL / TRANSCRIPTION CREDENTIAL + CONSENT GATE |

## GAP-18 — LP / reporting live operating surface

| Field | Content |
|---|---|
| Requirement ID | REQ-LPOPS-18 |
| Requirement | Administrator-source status, scheduled reconciliation, discrepancies, packet workflow, diligence workflow, VDR artifact/access/revocation state, engagement tracking, source freshness |
| Blueprint authority | Task §8 GAP-18 |
| Audit claim | substrate exists, operating surface does not |
| Current UI (P13) | `LpPage`, `ReportingPage` (periods, packets, reviews, distribute, reconciliation run, exceptions) |
| Current backend (P13) | `services/lp.ts` (848), `services/reporting.ts` (709) |
| Persistence (P13) | 0010, 0012 tables |
| Tests (P13) | `tests/lp.test.ts`, `tests/reporting.test.ts`, `e2e/p10-lp.spec.ts`, `e2e/p12-reporting.spec.ts` |
| Classification | **PARTIAL_UX** — workflows `ALREADY_IMPLEMENTED`; source registry/freshness/schedule/engagement missing |
| Capability state (P13) | `PRODUCTION_READY_PARTIAL` (local, fixture sources) |
| Required build | administrator source registry with freshness + reconciliation schedule + engagement state + VDR provider status |
| Phase | P24 |
| Final evidence | see "Phase close-out" |
| Remaining external gate | FUND-ADMIN SOURCE CONTRACT GATE; VDR PROVIDER NOT SELECTED |

## GAP-19 — Notifications

| Field | Content |
|---|---|
| Requirement ID | REQ-NOTIFY-19 |
| Requirement | First-class notifications across ten event classes with in-app center, severity, dedupe, read/ack, quiet hours, delivery status, push where proven |
| Blueprint authority | Task §8 GAP-19 |
| Audit claim | absent |
| Current state (P13) | absent — no notification table, route, or UI anywhere in the tree |
| Classification | **TRUE_MISSING_REQUIREMENT / NEWLY_AUTHORIZED_SCOPE** |
| Capability state (P13) | `ABSENT` |
| Required build | notification substrate + preferences + center; in-app must work without any external channel |
| Phase | P20 |
| Final evidence | see "Phase close-out" |
| Remaining external gate | web-push (VAPID keys / push service) |

## GAP-20 — Mobile / PWA command surface

| Field | Content |
|---|---|
| Requirement ID | REQ-PWA-20 |
| Requirement | Installable PWA, manifest + service worker, safe offline capture, approval-first mobile layouts, one-handed nav, evidence cards, home-screen behaviour, push integration, offline truthfulness |
| Blueprint authority | Task §8 GAP-20 |
| Audit claim | responsive web only |
| Current state (P13) | no manifest, no service worker, no offline path; the shell is a desktop nav strip |
| Classification | **TRUE_MISSING_REQUIREMENT** |
| Capability state (P13) | `ABSENT` |
| Required build | manifest, service worker, offline capture queue with honest sync state, mobile-first approval layout |
| Phase | P20 |
| Final evidence | see "Phase close-out" |
| Remaining external gate | installability on a real device; iOS push; biometrics (NOT claimed) |

## GAP-21 — Governed orchestration fabric

| Field | Content |
|---|---|
| Requirement ID | REQ-ORCH-21 |
| Requirement | Scheduled jobs, recurring loops, retry, dead-letter, worker routing, cancellation, idempotency, execution state, artifacts, notification output, observability — smallest architecture that satisfies real workloads |
| Blueprint authority | Task §8 GAP-21; AGENTS.md "do not add Cloudflare products without a real requirement" |
| Audit claim | absent |
| Current state (P13) | absent — no scheduled handler, no cron trigger in `wrangler.toml`, no job tables |
| Classification | **TRUE_MISSING_REQUIREMENT / NEWLY_AUTHORIZED_SCOPE** |
| Capability state (P13) | `ABSENT` |
| Required build | D1-backed job/run state + Cloudflare Cron Trigger + manual run path; **no** Queues, **no** Durable Objects (ADR required) |
| Phase | P19 |
| Final evidence | see "Phase close-out" |
| Remaining external gate | remote cron firing (requires deployment) |

## GAP-22 — Scheduled AI employees / recurring loops

| Field | Content |
|---|---|
| Requirement ID | REQ-SCHEDEMP-22 |
| Requirement | Governed recurring employee jobs with schedule, assignment, capability, budget, model/data policy, retry, run history, artifacts, exception path, pause/resume, operator visibility — without breaking activation law |
| Blueprint authority | Task §8 GAP-22; D10 ≤5 active |
| Audit claim | absent |
| Current state (P13) | absent |
| Classification | **TRUE_MISSING_REQUIREMENT / NEWLY_AUTHORIZED_SCOPE** |
| Capability state (P13) | `ABSENT` |
| Required build | employee/machine-assigned jobs that refuse to run for a non-ACTIVE employee |
| Phase | P19 |
| Final evidence | see "Phase close-out" |
| Remaining external gate | remote scheduler execution |

## GAP-23 — Full MP command coherence

| Field | Content |
|---|---|
| Requirement ID | REQ-COHERENCE-23 |
| Requirement | The home surface coherently answers the ten §4 MP questions from live/persisted state |
| Blueprint authority | Task §4, §8 GAP-23 |
| Audit claim | absent |
| Current state (P13) | Today answers roughly two of ten ("what needs my decision", partially "what should I look at") |
| Classification | **PARTIAL_UX** |
| Capability state (P13) | `STRUCTURAL` |
| Required build | one aggregation answering all ten with drill-through to the owning surface |
| Phase | P14 opens it, P25 closes it |
| Final evidence | see "Phase close-out" |
| Remaining external gate | none locally |

## GAP-24 — Institutional product polish

| Field | Content |
|---|---|
| Requirement ID | REQ-POLISH-24 |
| Requirement | Remove skeletal admin feel, preserve institutional tone, information hierarchy, legible status/proof/gates, obvious primary actions, empty/loading/error states, mobile usability |
| Blueprint authority | Task §8 GAP-24, §11 |
| Audit claim | product feels skeletal |
| Current state (P13) | one 3,086-line `App.tsx`, plain unstyled lists/forms, minimal CSS, no shared component vocabulary |
| Classification | **PARTIAL_UX** — claim TRUE |
| Capability state (P13) | `STRUCTURAL` |
| Required build | shared UI primitives, status/gate legibility, empty/loading/error states, mobile layout — without destroying working navigation |
| Phase | P25 (applied incrementally from P14 onward) |
| Final evidence | see "Phase close-out" |
| Remaining external gate | none |

---

## P13 verification verdicts, in one line each

| Gap | Audit claim verdict | Classification |
|---|---|---|
| GAP-01 | TRUE | BACKEND_ONLY |
| GAP-02 | TRUE (enforcement real, analysis thin) | PARTIAL_UX |
| GAP-03 | TRUE | PARTIAL_UX + TRUE_MISSING_REQUIREMENT |
| GAP-04 | TRUE | PARTIAL_UX |
| GAP-05 | TRUE | TRUE_MISSING_REQUIREMENT |
| GAP-06 | TRUE | BACKEND_ONLY |
| GAP-07 | TRUE | TRUE_MISSING_REQUIREMENT |
| GAP-08 | TRUE | PARTIAL_UX |
| GAP-09 | TRUE | TRUE_MISSING_REQUIREMENT |
| GAP-10 | TRUE | TRUE_MISSING_REQUIREMENT |
| GAP-11 | TRUE (tables exist but are dead code) | TRUE_MISSING_REQUIREMENT |
| GAP-12 | PARTIAL — substrate already implemented | PARTIAL_UX |
| GAP-13 | **PARTIALLY FALSE** — allocation math is implemented and verified | PARTIAL_UX |
| GAP-14 | PARTIAL — evidence substrate already implemented | TRUE_MISSING_REQUIREMENT (console only) |
| GAP-15 | TRUE | NEWLY_AUTHORIZED_SCOPE |
| GAP-16 | **PARTIALLY FALSE** — adapter contract implemented, live proof absent | EXTERNALLY_UNPROVEN |
| GAP-17 | PARTIAL — substrate already implemented | EXTERNALLY_UNPROVEN + PARTIAL_UX |
| GAP-18 | PARTIAL — workflows already implemented | PARTIAL_UX |
| GAP-19 | TRUE | TRUE_MISSING_REQUIREMENT |
| GAP-20 | TRUE | TRUE_MISSING_REQUIREMENT |
| GAP-21 | TRUE | TRUE_MISSING_REQUIREMENT |
| GAP-22 | TRUE | TRUE_MISSING_REQUIREMENT |
| GAP-23 | TRUE | PARTIAL_UX |
| GAP-24 | TRUE | PARTIAL_UX |

Two audit claims are materially overstated (GAP-13, GAP-16) and four more understate existing
substrate (GAP-12, GAP-14, GAP-17, GAP-18). Per task §6 rule 7, none of that already-correct
capability is rewritten; the continuation adds the missing operator layer on top of it.

---

## Phase close-out

Updated at the end of each phase (task §14). Each row states what was actually built and what was
actually run — never more.

| Phase | Gaps | Status | Evidence |
|---|---|---|---|
| P13 | all | COMPLETE | this ledger + `docs/WEST_PEEK_COMPLETION_BLUEPRINT_v2.md`; verification method above |
| P14 | 04, 05, 23 (opened) | COMPLETE (local) | `migrations/0013_intelligence_command.sql`; `services/intelligence.ts`, `services/mpHome.ts`, `services/personalIntelligence.ts`; 24 routes; `pages/HomePage.tsx`, `pages/IntelligencePage.tsx`. Proof: vitest 349/349 incl. 34 new P14 tests; Playwright `e2e/p14-mp-home.spec.ts` 4/4. **GAP-04** capability state → `PRODUCTION_READY_PARTIAL` (modules, preferences, one-thing-to-watch, what-changed diff, private layer); the private layer's live calculation is `ABSENT — NO SOURCE` and labelled. **GAP-05** → `PRODUCTION_READY_PARTIAL` for MANUAL + INTERNAL acquisition, `INTEGRATED_UNPROVEN` for HTTP feeds (fails closed, EGRESS_GATED), scheduling deferred to P19. **GAP-23** → opened, closes at P25 |
| P15 | 01, 10, 11 | COMPLETE (local) | `migrations/0014_workforce.sql`; `services/workforce.ts`; 16 routes; `pages/EmployeesPage.tsx`. Proof: 31 new vitest tests; Playwright `e2e/p15-workforce.spec.ts` 3/3. **GAP-01** → `PRODUCTION_READY_PARTIAL` (identity, department, manager, machines, scope, current work, runs, cost, lifecycle controls, activation request — live per-employee model execution stays credential-gated). **GAP-10** → `PRODUCTION_READY_PARTIAL` (rooms, referenced messages, handoffs, memos, acknowledgements; no autonomous chatter is possible by construction). **GAP-11** → `PRODUCTION_READY_FULL` for what is measurable (deterministic counts + failure patterns + cost per accepted output + PIP/retrain/restrict/retire lifecycle + manager review); subjective value is deliberately `ABSENT` and documented as such |
| P16 | 02, 03 | COMPLETE (local) | `migrations/0015_provider_cost.sql`; `ai/routing.ts`; `ai/providers/openRouter.ts`, `ai/providers/fireworks.ts`; `services/providerRouter.ts`, `services/costCenter.ts`; 13 routes; `pages/AiOpsPage.tsx`. Proof: 23 new vitest tests (403/403 suite-wide); Playwright `e2e/p16-ai-ops.spec.ts` 3/3. **GAP-02** → `PRODUCTION_READY_PARTIAL`: scoped budgets (firm/employee/machine/provider/model/category × daily/weekly/monthly) are enforced inside `run_ai` with versioned authority and change history, spend is attributed and broken down, rework cost and forecast are computed with stated definitions, kill switches and alerts work. Actual (rather than estimated) cost stays `INTEGRATED_UNPROVEN` until a provider bills something. **GAP-03** → `INTEGRATED_UNPROVEN`: catalogue, capability/context/latency metadata, pricing provenance, task routing with ordered candidates and explanation, policy-gated fallback, per-machine model policy, health checks, evaluations, promotion/demotion, and named OpenRouter/Fireworks adapters all exist and are tested — **no live vendor call has ever occurred** |
| P17 | 06, 07 | COMPLETE (local) | `migrations/0016_machines_capabilities.sql`; `services/machines.ts`, `services/capabilities.ts`; 12 routes; `pages/MachinesPage.tsx`. Proof: 17 new vitest tests; Playwright `e2e/p17-machines.spec.ts` 2/2. **GAP-06** → `PRODUCTION_READY_PARTIAL`: owner, SLA, priority, tools, data access, evidence expectation, dependencies, durable memory, assigned employees, live queue, 30-day spend and failures, model policy, and a pause that is enforced in BOTH the routing service and the AI boundary. Scheduled loops land at P19. **GAP-07** → `PRODUCTION_READY_PARTIAL`: capability cards with Active/Bench/Archive, maturity separated from tested state, model/tool dependencies, costed with a stated basis, employee and machine assignment, after-action records, build-vs-buy decisions, and a deterministic recommended stack. `PROVEN_LIVE` is structurally refused while no live provider exists |
| P18 | 08, 09 | COMPLETE (local) | `migrations/0017_work_packets.sql`; `shared/registry/lenses.ts`; `services/workPackets.ts`; 7 routes; `pages/IntentPage.tsx`. Proof: 18 new vitest tests; Playwright `e2e/p18-intent.spec.ts` 2/2. **GAP-08** → `PRODUCTION_READY_PARTIAL`: the full rough-thought→execution flow with adjustable enhancement strength, and the original text structurally protected from being overwritten. **GAP-09** → `PRODUCTION_READY_PARTIAL`: all six lenses visible and selectable, findings stored as verdict/critique/evidence/summary, the Truth-Compliance Gate genuinely blocking, and the absence of a chain-of-thought column asserted against the live schema |
| P19 | 21, 22 | COMPLETE (local) | `migrations/0018_orchestration.sql`; `services/jobs.ts`; worker `scheduled()`; cron trigger; ADR-017; 7 routes; `pages/JobsPage.tsx`. Proof: 16 new vitest tests; Playwright `e2e/p19-jobs.spec.ts` 1/1. **GAP-21** → `PRODUCTION_READY_PARTIAL`: scheduled jobs, run history, retry to a per-job limit, dead-letter, cancellation, idempotency by occurrence window, durable artifacts, and observability — built on D1 + one cron trigger, with Queues and Durable Objects explicitly refused in ADR-017. Remote firing is `INTEGRATED_UNPROVEN`. **GAP-22** → `PRODUCTION_READY_PARTIAL`: employee/machine-assigned recurring jobs with capability, budget, data policy, retry, run history, artifacts, exception path, pause/resume — and a job can never activate an employee, proven by test |
| P20 | 19, 20 | COMPLETE (local) | `migrations/0019_notifications.sql`; `services/notifications.ts`; 6 routes; `pages/NotificationsPage.tsx`; PWA manifest/icon/service worker; `lib/offlineQueue.ts`; shell status bar. Proof: 12 new vitest tests; Playwright `e2e/p20-notifications.spec.ts` 3/3. **GAP-19** → `PRODUCTION_READY_PARTIAL`: in-app centre, all ten kinds, severity ordering, dedupe, read/ack, quiet hours, per-kind preferences, and per-channel delivery status — with five real subsystems emitting. Push is `ABSENT` and recorded as such. **GAP-20** → `PRODUCTION_READY_PARTIAL`: installable manifest, service worker that never caches institutional state, offline capture with explicit not-saved labelling, and a mobile layout proven at 390×844. Device installability, push, and biometrics remain unproven and unclaimed |
| P21 | 14 | COMPLETE (local) | `migrations/0020_research.sql`; `services/research.ts`; 10 routes; `pages/ResearchPage.tsx`. Proof: 13 new vitest tests; Playwright `e2e/p21-research.spec.ts` 1/1. **GAP-14** → `PRODUCTION_READY_PARTIAL`: launch research, define questions, inspect sources with stated reliability, compare contradictory sources through the firm's own contradiction record, market maps, research packets with computed IC readiness, evidence saving, and knowledge promotion — all writing into the EXISTING P5 substrate, proven by asserting the claim and claim_source rows that promotion creates. Live source retrieval stays `INTEGRATED_UNPROVEN` behind the egress gate |
| P22 | 16, 17 | COMPLETE (local) | `migrations/0021_connectors.sql`; `services/connectors.ts`; 3 routes; `pages/IntegrationsPage.tsx`. Proof: P22 group of `tests/integrations.test.ts`; Playwright `e2e/p22-24-integrations.spec.ts`. **GAP-16** → `INTEGRATED_UNPROVEN` (unchanged substrate, new operator status surface): direction/ownership, cursors, idempotency, conflict detection, audited writeback proposals, failure handling, and external status all present; Network OS is never mutated and never mirrored. **GAP-17** → `PRODUCTION_READY_PARTIAL` locally: prep queue over scheduled meetings with consent and recording-policy state as facts; calendar/transcription connectors remain `ABSENT` and are labelled so |
| P23 | 15 | COMPLETE (local) | `migrations/0022_specialist_providers.sql`; `ai/providers/specialist.ts`; specialist lane in `ai/routing.ts`; `services/specialist.ts`; 3 routes. Proof: P23 group of `tests/integrations.test.ts`. **GAP-15** → `INTEGRATED_UNPROVEN`: adapter, status, routing lane, quarantine, cost, and privacy architecture are implemented and tested; both vendors are disabled with zero egress allowance and no endpoint or credential, so **no vendor has ever been called**. The schema cannot store a legal or compliance conclusion |
| P24 | 18 | COMPLETE (local) | `migrations/0023_lp_ops.sql`; `services/lpOps.ts`; 4 routes; LP section of `pages/IntegrationsPage.tsx`. Proof: P24 group of `tests/integrations.test.ts`; Playwright `e2e/p22-24-integrations.spec.ts`. **GAP-18** → `PRODUCTION_READY_PARTIAL`: administrator-source status with a contract model that cannot be faked, computed freshness, reconciliation schedule, discrepancy/exception view, packet and diligence workflow state, VDR artifact/access/revocation state, and LP engagement tracking. The fund-admin source contract and VDR provider gates are unchanged and stated in the payload |
| P25 | 12, 13, 23, 24 | COMPLETE (local) | `services/cockpit.ts`; `employees` module in `services/mpHome.ts`; 2 routes; `pages/CockpitPage.tsx`; shared UI vocabulary across all eleven new pages. Proof: 11 new vitest tests; Playwright `e2e/p25-journeys.spec.ts` **9/9 cross-system journeys**. **GAP-12** → `PRODUCTION_READY_PARTIAL`: top risks, improving/deteriorating with window and direction, stale-or-missing as a finding, support asks, follow-on candidates, secondary opportunities, ownership changes, what changed this week. **GAP-13** → `PRODUCTION_READY_PARTIAL`: all six option types compared with sleeve fit, concentration, reserve sufficiency, breach count, stated assumptions, and the human-reserved action per type — reading P11's recorded results, recomputing nothing; still behind the formula-acceptance gate. **GAP-23** → `PRODUCTION_READY_PARTIAL`: all ten questions answered with drill-through. **GAP-24** → `PRODUCTION_READY_PARTIAL`: shared component vocabulary, legible gate/proof status, empty/loading/error states, mobile layout proven at 390×844; existing navigation and journeys preserved |

## Final capability states (2026-08-13)

| Gap | Final capability state | The gate that remains |
|---|---|---|
| GAP-01 Employee lounge | `PRODUCTION_READY_PARTIAL` | live per-employee model execution — CREDENTIAL |
| GAP-02 AI cost centre | `PRODUCTION_READY_PARTIAL` | actual (vs estimated) provider cost — no provider has billed anything |
| GAP-03 Provider router | `INTEGRATED_UNPROVEN` | every live vendor call — CREDENTIAL |
| GAP-04 MP home | `PRODUCTION_READY_PARTIAL` | astrology/ephemeris calculation — NO SOURCE (interface built, nothing fabricated) |
| GAP-05 Daily intelligence | `PRODUCTION_READY_PARTIAL` (MANUAL + INTERNAL) / `INTEGRATED_UNPROVEN` (HTTP feeds) | external feed egress |
| GAP-06 Machine control | `PRODUCTION_READY_PARTIAL` | none locally |
| GAP-07 Capability registry | `PRODUCTION_READY_PARTIAL` | `PROVEN_LIVE` capability proof — structurally refused until a live provider exists |
| GAP-08 Intent to execution | `PRODUCTION_READY_PARTIAL` | live model enhancement quality |
| GAP-09 Lens bench | `PRODUCTION_READY_PARTIAL` | none locally |
| GAP-10 Digital office | `PRODUCTION_READY_PARTIAL` | none locally |
| GAP-11 Performance | `PRODUCTION_READY_FULL` for what is measurable; subjective value deliberately `ABSENT` | none |
| GAP-12 Portfolio cockpit | `PRODUCTION_READY_PARTIAL` | none locally |
| GAP-13 Allocation view | `PRODUCTION_READY_PARTIAL` | FORMULA-VERIFICATION ACCEPTANCE (§7.2) |
| GAP-14 Research console | `PRODUCTION_READY_PARTIAL` | live source retrieval — EGRESS |
| GAP-15 Specialist lane | `INTEGRATED_UNPROVEN` | VENDOR ACCESS — no account, contract, credential, or endpoint |
| GAP-16 Network OS | `INTEGRATED_UNPROVEN` | INTEGRATION APPROVAL + CREDENTIAL |
| GAP-17 Meetings | `PRODUCTION_READY_PARTIAL` locally / connectors `ABSENT` | CALENDAR + TRANSCRIPTION CREDENTIAL + CONSENT |
| GAP-18 LP operations | `PRODUCTION_READY_PARTIAL` | FUND-ADMIN SOURCE CONTRACT; VDR PROVIDER NOT SELECTED |
| GAP-19 Notifications | `PRODUCTION_READY_PARTIAL`; push `ABSENT` | web push — CREDENTIAL |
| GAP-20 Mobile/PWA | `PRODUCTION_READY_PARTIAL` | device installability, push, biometrics (not implemented, not claimed). Layout is now proven by MEASUREMENT at 390px (no document overflow on the table-bearing surfaces), not merely by element visibility |
| GAP-21 Orchestration | `PRODUCTION_READY_PARTIAL` | remote cron firing — DEPLOYMENT |
| GAP-22 Scheduled employees | `PRODUCTION_READY_PARTIAL` | remote cron firing — DEPLOYMENT |
| GAP-23 MP coherence | `PRODUCTION_READY_PARTIAL` | none locally |
| GAP-24 Institutional polish | `PRODUCTION_READY_PARTIAL` | none |

No gap is `PRODUCTION_READY_FULL` except GAP-11's measurable half, because "full" would require
live external proof that this environment cannot produce. Nothing above is raised past what ran.

## Completion gate (task §15), assessed honestly

| Gate | Status |
|---|---|
| 1. All 24 gaps classified with evidence | MET — P13 classification above, updated after every phase |
| 2. Every locally implementable P13–P25 requirement implemented | MET — see the per-phase rows in `IMPLEMENTATION_LEDGER.md` |
| 3. P0–P12 behaviour intact | MET — all pre-existing suites still green (507/507 total, 45/45 Playwright); the only P0–P12 files touched were `runAi.ts` (extended, legacy path preserved and asserted), `captures.ts` (machine-pause check added), and two validators (narrowed with new self-test fixtures) |
| 4. No known locally-fixable blocker remains | MET — the final review found four issues and all four were fixed, not deferred |
| 5. No named capability is a stub/TODO/fake-success surface | MET — every unavailable path fails closed with a named reason, and the surfaces say so |
| 6. Cross-system journeys have real evidence | MET — `e2e/p25-journeys.spec.ts`, 9 journeys; journeys 7 and 8 are driven to their external boundary and the unproven step is asserted as unproven |
| 7. External/human-gated items labelled | MET — the table above, and every affected API response carries its gate in the payload |
| 8. Validation suite green or every red documented | MET — nothing is red |
| 9. Final Claude review | DONE — TWO passes. The implementer's own review (generation 1) found and fixed 4 issues; an independent `claude:final_review` worker (generation 2) then found 4 more, including a real privacy leak in the daily briefing and a whole class of ungated mutation paths, and corrected one overstated mobile claim in the ledger. Both passes are recorded in `IMPLEMENTATION_LEDGER.md` |
| 10. Cumulative snapshot packaged | HOST — Repo Operator packaging is deterministic and runs after this session |
