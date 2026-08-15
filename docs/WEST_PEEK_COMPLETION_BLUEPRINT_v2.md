# West Peek OS — Completion Blueprint v2 (P13–P25)

The build contract produced by P13. It states what the P13–P25 continuation adds on top of the
preserved P0–P12 system, how it attaches to existing law, and what it deliberately does not do.

Companion: `docs/WEST_PEEK_BLUEPRINT_COMPLIANCE_LEDGER.md` (per-requirement classification).

## 1. What this continuation is

P0–P12 built a governed **substrate**: identity, authority, approvals, events, AI boundary,
evidence, investment, meetings, portfolio, Network OS contract, LP, allocation, reporting.

P13–P25 builds the **operating product** on top of it: the surfaces a Managing Partner actually
uses daily, and the recurring machinery that makes the firm's AI workforce do work rather than
merely exist.

Everything new attaches to the existing spines. It does not fork them.

| Existing spine | Continuation rule |
|---|---|
| `authorize()` | every new mutating action has an `action_type` key and passes through it |
| `run_ai()` | every new AI call routes through it; no new provider call sites |
| `event_record` | every new subsystem appends typed events; no second event log |
| `diligence_claim` / `knowledge_record` | research and intelligence write **into** this substrate |
| `canonical_company` | intelligence/research/portfolio surfaces reference company ids; no second company store |
| Network OS | remains authoritative for relationship truth; we add status, never a mirror |
| `approval_card` | every reserved/external action still needs a receipt |

## 2. Architecture decisions taken at P13

**A. Migrations are additive, `0013`+.** `0001`–`0012` are not edited. New action-type keys follow
the P4 convention: added to the TypeScript registry (`src/shared/registry/actionTypes.ts`), emitted
into the `0003` generated seed block by `scripts/seed/generate-machine-seed.mjs` (so fresh databases
get them), **and** repeated as compensating `INSERT OR IGNORE` in the new phase migration (so
databases that already applied `0003` get them too).

**B. No new Cloudflare product except Cron Triggers.** GAP-21 asks for the smallest architecture
that satisfies the real recurring workload. That workload is: a handful of scheduled intelligence /
reconciliation / portfolio-evaluation jobs, at minute-or-coarser granularity, with durable run
history. D1 already gives durable state; a Cron Trigger gives the clock. Queues and Durable Objects
are refused (ADR-017). A manual `POST /api/jobs/:id/run` gives a locally provable execution path,
because a cron trigger cannot fire in `wrangler dev` offline.

**C. Personal intelligence is a separate authorization domain, not a privacy label variant.** GAP-04
requires a private-to-one-MP layer. It gets its own tables, its own owner column, an
owner-only read path, and default-deny for everyone else including the other Managing Partner. It
is never mixed into `diligence_claim`, `knowledge_record`, or any firm evidence table, and is
labelled explicitly as not institutional truth.

**D. No chain-of-thought persistence.** The lens bench (GAP-09) stores structured products only:
lens key, verdict, critique text authored as an output, evidence references, summary. The schema
has no column for reasoning traces and the service has no path to write one.

**E. Cost/pricing provenance is a first-class column.** Every model price row carries a
`pricing_state` of `SOURCED | ILLUSTRATIVE | STALE` with `sourced_at` and `source_note`. The UI
prints the state next to the number. Placeholder prices are never presented as current facts
(task §8 GAP-03).

**F. Credential presence, never credential values.** Connector and provider status surfaces report
whether a binding/secret name is configured — a boolean derived from the environment — and never
read, log, echo, or package a value (task §3.4, AGENTS.md).

## 3. Phase → deliverable map

| Phase | Gaps | Migration | Services | Client | Tests |
|---|---|---|---|---|---|
| P13 | all | — | — | — | verification only |
| P14 | 04, 05, 23 | `0013` registry, `0014_intelligence` | `intelligence.ts`, `mpHome.ts`, `personalIntelligence.ts` | Home, Intelligence | `tests/intelligence.test.ts`, `e2e/p14-mp-home.spec.ts` |
| P15 | 01, 10, 11 | `0015_workforce` | `workforce.ts` | Employees, rooms | `tests/workforce.test.ts`, `e2e/p15-workforce.spec.ts` |
| P16 | 02, 03 | `0016_provider_cost` | `providerRouter.ts`, `costCenter.ts`, adapters | Providers, Cost | `tests/router.test.ts`, `tests/cost.test.ts`, `e2e/p16-ai-ops.spec.ts` |
| P17 | 06, 07 | `0017_machines_capabilities` | `machines.ts`, `capabilities.ts` | Machines, Capabilities | `tests/machines.test.ts`, `e2e/p17-machines.spec.ts` |
| P18 | 08, 09 | `0018_work_packets` | `workPackets.ts`, `lenses.ts` | upgraded Capture | `tests/workPackets.test.ts`, `e2e/p18-intent.spec.ts` |
| P19 | 21, 22 | `0019_orchestration` | `jobs.ts`, worker `scheduled()` | Jobs | `tests/jobs.test.ts`, `e2e/p19-jobs.spec.ts` |
| P20 | 19, 20 | `0020_notifications` | `notifications.ts` | Notification center, PWA | `tests/notifications.test.ts`, `e2e/p20-notifications.spec.ts` |
| P21 | 14 | `0021_research` | `research.ts` | Research | `tests/research.test.ts`, `e2e/p21-research.spec.ts` |
| P22 | 16, 17 | `0022_connectors` | `connectors.ts`, meeting prep queue | Connector status | `tests/connectors.test.ts` |
| P23 | 15 | `0023_specialist` | specialist adapters + lane | Provider page lane | `tests/specialist.test.ts` |
| P24 | 18 | `0024_lp_ops` | `lpOps.ts` | LP ops surface | `tests/lpOps.test.ts` |
| P25 | 12, 13, 23, 24 | — | `cockpit.ts` | Portfolio cockpit, allocation strategy view, polish | `e2e/p25-journeys.spec.ts` |

(Exact file names may shift during implementation; the ledger records what was actually built.)

## 4. The ten MP questions → where each answer comes from

| Question | Source of the answer |
|---|---|
| What do I need to know? | daily intelligence brief items (P14) ranked by relevance |
| What needs my decision? | `approval_card` pending for my roles (P3) |
| What changed? | typed `event_record` diff since last visit + intelligence "what changed" (P14) |
| Where is money or execution at risk? | `portfolio_alert`, `constraint_violation`, budget threshold state (P8/P11/P16) |
| What are the AI employees doing? | employee current work + last runs (P15) |
| What opportunities surfaced? | intelligence items typed OPPORTUNITY + `investment_opportunity` NEW (P14/P6) |
| What is costing money? | scoped spend rollup over `ai_run` (P16) |
| What is broken? | job dead-letters, provider health, connector status, failed runs (P19/P16/P22) |
| What should I look at today? | ranked composite: approvals + severity-ordered alerts + one intelligence item |
| What should the firm do next? | explicitly a *recommendation*, evidence-linked, never an autonomous decision |

Each home module links to the surface that owns the record. The home never becomes a second store.

## 5. Non-goals for this continuation (task §17)

Not built, not stubbed, not implied by any surface: West Peek Productions, sponsorship product,
Market Intelligence Academy, MyClaw/Twin/OpenClaw runtimes, protected self-modification,
autonomous source-code mutation, mass workforce activation, unsupervised investment approval,
automatic banking/wires/capital calls/distributions, automated legal or compliance certification,
silent overwrite of Network OS or fund-admin authority, partner-repo mutation.

The ≤5 active AI employee cap (D10) is preserved exactly. Scheduled jobs cannot activate an
employee; a job assigned to a non-ACTIVE employee refuses to run.

## 6. Honesty rules carried into every new surface

1. A surface that depends on an unavailable credential says so in the UI and fails closed.
2. Estimated cost is labelled estimated; actual cost appears only when a provider reported it.
3. Fixture/local data is labelled `LOCAL_FIXTURE`; it never renders as live.
4. Heuristic scores (relevance, effectiveness, value) are labelled heuristic and their definition
   is shown.
5. Nothing is marked complete in the ledger without a test that ran.
