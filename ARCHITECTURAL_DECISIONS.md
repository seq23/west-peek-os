# Architectural Decisions — West Peek OS Initial Implementation

Canon v3.2.14 is frozen to errata during implementation (D11). Corrections are recorded here as ADRs;
no new cumulative canon version is produced.

## Locked decisions (from approved plan §5) — restated for implementers

| ID | Decision |
|---|---|
| D1 | TypeScript + React/Vite + Cloudflare Workers/Pages + D1 + R2 + KV(ephemeral only) + Playwright. |
| D2 | Odysseus is reference-only. No fork, no dependency, no code import. |
| D3 | CanonicalCompany-first entity model. Parallel pipeline entities superseded. |
| D4 | Approved plan §8 phase order is the single implementation sequence. |
| D5 | Network OS stays authoritative for relationship/contact/touch/Gmail records; adapter-only crossings. |
| D6 | VentureDeals/secondaries math is ported only after independent formula verification; manual DealMathPacket entry allowed until then. |
| D7 | ≤15 human approval cards/day steady-state design target; batching/digests preferred; silence ≠ approval. |
| D8 | Privacy modes: `LOCAL`, `FRONTIER`, `LOCKDOWN`. Historical four-mode language folds into these three. |
| D9 | Providers are configuration, not architecture: registry, per-data-class allowlist, cost/capability metadata, manual fallback, default-deny sensitive, kill switch. |
| D10 | Seed full AI registry as reference data; ≤5 active employees, only after explicit human selection; MP names never AI employees. |
| D11 | Canon v3.2.14 frozen to errata. |
| D12 | Engineering builds process controls only; no technical test claims legal/compliance/fund-admin correctness. |
| D13 | West Peek Productions, sponsorship machinery, Market Intelligence Academy are separate future products. |
| D14 | Machine registry count = **45**, from one versioned source artifact, tested from that source. |
| D15 | One append-only typed event spine feeds Activity Feed, Audit Ledger, Diagnostics. |
| D16 | One evidence/provenance substrate for claims, contradictions, promotion, source-of-truth resolution. |

## Implementation ADRs / errata

### ADR-001 — Machine registry source of truth
Canon §5A.2 (v3.2.14) lists machines 1–45. The v1.11 implementation plan's "44 machines" requirement is stale
and superseded (approved plan §2.3, D14). Versioned source: `src/shared/registry/machines.ts`
(`MACHINE_REGISTRY_VERSION = "3.2.14"`). A test asserts exactly 45 entries from that single source.

### ADR-002 — AI employee roster version
Canon contains two rosters (§"Named AI Employee Roster" ~line 10316, and "Revised v3.0 AI Employee Roster"
~line 20545). The v3.0 roster explicitly supersedes prior conflicting names. We seed the v3.0 roster
(30 rows; `Willow` holds two distinct role rows) plus `Whitney — Market Intelligence Coach` (canon line ~20626),
for **31 AI-employee rows**, all `INACTIVE` by default. Names approved-renamed by v3.0 (Petra→Willa etc.) use
the new names only.

### ADR-003 — "Sequoia" in machine owner columns is a human owner, not an AI employee
Canon machine registry row 16 and the §5A.7 department map list `Sequoia` in "Primary AI employees / owners".
No roster row makes a Managing Partner an AI employee, and the approved plan forbids it (D10).
Implementation records this as human ownership metadata only; guard tests assert neither
`Scooter Taylor` nor `Sequoia Taylor` (nor first-name collisions `Scooter`/`Sequoia`) appears as an AI employee name.

### ADR-004 — Diligence claim status enum
Two canon-adjacent enums exist: the Receipts Layer external-content labels
(`KNOWN/BELIEVED/ASSUMED/ESTIMATED/ASPIRATIONAL/STORYTELLING-ADJUSTED/UNVERIFIED`) and the diligence claim
statuses (`VERIFIED/FOUNDER_STATED/THIRD_PARTY_SOURCED/AI_INFERRED/UNVERIFIED/MISSING`). The approved plan §P5
mandates the six-value diligence enum for `DiligenceClaim`. The seven-value labels are out of initial scope
(LP/external-content tooling may adopt them later). No second enum is implemented for diligence claims.

### ADR-005 — Deal math formulas
Neither source document contains numeric fee/discount formulas (only fields and underwriting questions).
Per D6, formulas enter the system only with independent hand-worked verification fixtures
(`tests/**/dealMath*` / `docs/DEAL_MATH_VERIFICATION.md`). Until a formula is verified, `DealMathPacket`
supports manual entry and derived-metric fields stay computed only by verified functions.
The `seq23/secondaries` repo is a read-only integration partner; if it is not locally accessible during P6,
the port is recorded as `UNPROVEN — SOURCE ACCESS GATE` and manual entry remains the path.

### ADR-006 — Authentication
Private ingress is Cloudflare Access (or equivalent) in deployed environments — configuration, not code.
The operator has since configured it: Access is recorded as active on the production hostname
`west-peek-os.seq-taylor.workers.dev`, established and verified entirely outside this repository, so no
check here proves it and none ever will (docs/ENVIRONMENTS.md). The decision is unchanged either way —
the application never implements ingress, and it never trusts Access alone.
App-level `FirmUser` + `Role` + `AuthorityScope` records are always
enforced server-side. Local development uses an explicit dev-identity header honored only when
`WP_OS_ENV=local`; unauthenticated requests are denied everywhere, including local.

### ADR-007 — Remote Cloudflare identifiers
The **top-level (local) profile** of `wrangler.toml` ships placeholder `database_id` / KV `id`. Local dev
and all local validation run offline via miniflare and never need real ids.

**Amended (deployment-profile separation).** Real remote ids are still operator-supplied configuration
behind the deployment approval gate — they are now recorded in the explicit `[env.production]` profile
only, never in the local profile. This keeps the two profiles from sharing state (docs/ENVIRONMENTS.md)
and means the local profile can never accidentally address a production resource. The ids are non-secret.
Recording them is configuration, not deployment: remote deploy, Cloudflare Access, and remote migration
apply remain human-gated and UNPROVEN.

### ADR-008 — Approval volume metric
Approval cards carry creation timestamps; a diagnostics rollup exposes daily/weekly counts against the
≤15/day design target (D7). The metric is observational; it never auto-approves.

### ADR-009 — P3 authority implementation notes
- **Merge reversal shares the merge's reserved key.** The canon reserved-action register contains
  `identity_merge.execute` but no separate reversal key. Reversal carries the same destructive-authority
  character as merge, so both route through `authorize()` with `identity_merge.execute`: merge is keyed
  on the source company (`object_type='canonical_company'`), reversal on the merge receipt
  (`object_type='identity_merge_receipt'`). The register itself is unchanged.
- **Action vocabulary source.** `action_type` is seeded from two registry sources: the canon reserved
  register (`reservedActions.ts`) and the implementation-defined `actionTypes.ts` (ordinary internal
  actions + per-effect-type external-effect keys `effect.email.send` / `effect.message.send` /
  `effect.webhook.post`). Non-register approval cards default to `["MANAGING_PARTNER"]` required
  approver roles. Unknown action keys are DENIED.
- **External-effect execution is simulated.** All executor adapters are local simulations (no egress);
  a static scan (`scripts/validate/no-unauthorized-effects.mjs`, `npm run validate:authority`) proves
  confinement of execution to `effects/executor.ts` and absence of outbound fetch in worker code.
- **Privacy visibility is server-side.** `RESTRICTED`/`LP_PRIVATE`/`MNPI_SENSITIVE`/`BANKING_RESTRICTED`
  rows require the MP role or an `authority_scope` grant (`scope_key='privacy_label'`); filtering happens
  in SQL, not in the client.
- **Human self-approval is permitted.** A human holding a required approver role may decide a card they
  requested (the MPs operate solo at this stage). AI/SYSTEM actors can never decide, requested or not.

### ADR-010 — P4 governed-AI implementation notes
- **Privacy mode lives on `budget_policy`.** The approved plan described firmwide privacy mode as
  "budget_policy/kv config". KV is ephemeral-only (D1), and the privacy mode is institutional policy,
  so `budget_policy` carries both `cost_mode` and `privacy_mode` in one versioned, immutable row.
- **Seeded default policy is LOCKDOWN.** Fail closed: no external egress until an MP changes policy
  through the reserved `governance.policy_change` approval path. Placeholder caps ($25/day, $2/run)
  are operator-maintained config, not a cost claim.
- **Kill switch uses the governance path.** Per the approved P4 plan, provider kill-switch and enable
  both route through `authorize()` with `governance.policy_change` + an approved receipt. MP
  self-approval (ADR-009) keeps the emergency brake one human gesture: create card → approve → call
  with receipt. Every toggle appends `provider.kill_switched` / `provider.enabled` to the spine.
- **Boundary scan scope.** `scripts/validate/no-direct-provider-calls.mjs` scans `src/**` (executable
  code). Provider hostnames legitimately appear in `migrations/` and `scripts/seed/` as seeded
  CONFIG DATA (provider_registry rows, D9); they can perform no calls there.
- **P4 action keys.** `ai.run`, `ai_employee.tool_scope.grant`, and `ai_output.accept` were added to
  the registry source (`actionTypes.ts`); migration 0004 carries compensating `INSERT OR IGNORE`
  rows for databases that applied 0003 before P4 existed.
- **No AI→effects path exists in P4.** `runAi` never touches `effects/executor.ts`, so
  `no-unauthorized-effects.mjs` needed no extension; any future AI-requested external effect must
  create an approval card like any other actor.

### ADR-011 — P5 evidence/provenance implementation notes
- **`knowledge.promote` joins the reserved register.** Promoting evidence into durable
  institutional memory is human-reserved (governing law applied to D16); the canon register has
  no key for it, so it was added to `reservedActions.ts` under the same "implied by the approved
  plan" section as `identity_merge.execute`/`governance.policy_change`/`ai_employee.activate`,
  approver role `MANAGING_PARTNER`. Register semantics are unchanged.
- **Self-promotion ban is three-layer.** (1) Service level: `createClaim` refuses VERIFIED without
  a HUMAN extractor + a DOCUMENT/HUMAN_STATEMENT source; `verifyClaim` refuses AI-extracted claims
  and source-poor claims (409 `self_promotion_ban`). (2) Database:
  `CHECK (NOT (extracted_by_type='AI' AND claim_status='VERIFIED'))` on `diligence_claim`.
  (3) Route level: there is no generic claim status-update route at all (404).
- **Human accept re-attributes, never erases.** The only path from AI_INFERRED to VERIFIED is
  `POST /api/claims/:id/accept`: a human attaches a DOCUMENT/HUMAN_STATEMENT source and takes
  authorship (`extracted_by` becomes the human); `ai_run_id` and a `claim.accepted` spine event
  keep the AI origin traceable. AI never promotes itself; a human stands behind every VERIFIED claim.
- **Document upload encoding is base64 JSON.** The API is JSON-first; base64 keeps upload
  exercisable from vitest/Playwright without multipart parsing. 5 MiB decoded cap per upload.
  Binary content lives only in R2 (`WP_OS_DOCUMENTS`); D1 holds metadata/provenance (§9.1).
- **Extraction candidate parsing is deterministic and local.** In LOCKDOWN/LOCAL the mock-local
  adapter returns unstructured text, so `parseClaimCandidates` structures `metric: value` lines
  from the source document. A real provider's structured output would replace this parser;
  real provider extraction is UNPROVEN — CREDENTIAL GATE.
- **Extra provenance columns.** `claim_source.created_by` and `contradiction_record.proposed_by_*`
  were added beyond the plan's column list: provenance of who attached a source and who proposed
  a contradiction is required by the phase's own rules (AI proposals record proposed-by).

### ADR-012 — P10 LP / data-room implementation notes
- **Evidence must be CURRENT, not merely VERIFIED.** `checkEvidence` refuses a diligence claim that
  carries `superseded_by`, even though P5 correctly leaves such a claim VERIFIED and readable. A
  superseded figure is exactly the kind of stale number an LP claim must not rest on, so LP
  substantiation asks a narrower question than P5's status enum answers. Substantiation is re-checked
  at PUBLISH time, not only at submit: evidence can decay between review and publication.
- **Publication needs two independent gates.** Approved evidence and an approved
  `lp_marketing_claim.approve` receipt (MP or COMPLIANCE_OFFICER, per the canon register). Both are
  checked in the service, so no route can satisfy one and skip the other.
- **The receipt is presented, never discovered.** `authorize()` does not search for an approved card
  that happens to match the action and object; the caller supplies `approval_receipt_id`. This is
  deliberate — auto-discovery would let an unrelated approval authorize a later act.
- **No native VDR, and no bytes on the LP surface.** `data_room_artifact.provider_ref` points at the
  EXTERNAL room; there is no download/content route under `/api/lp/**` (404 by absence), and
  `vdr_state` is labelled `UNPROVEN — PROVIDER NOT SELECTED` on the listing itself.
- **Revocation is a new row, not an edit.** `data_room_access_record` is append-only by trigger;
  `data_room_revocation` is a separate append-only table and effective status (ACTIVE / EXPIRED /
  REVOKED) is COMPUTED at read time. Nothing rewrites a grant that actually happened.

### ADR-013 — P11 allocation implementation notes
- **New arithmetic gets its own verification pass.** `src/shared/allocation/` holds only formulas that
  did not already exist: capacity, concentration, reserve coverage, and constraint evaluation. Each is
  hand-worked in `docs/ALLOCATION_VERIFICATION.md` with fixtures in `tests/allocation.test.ts`.
  Fund-construction and follow-on path economics are NOT re-derived — P11 calls the D6-verified
  `computeFundModel` / `computeFollowOn`, because a second copy is a second thing to verify and a
  second thing to drift.
- **Verification is not acceptance.** `docs/ALLOCATION_VERIFICATION.md` is engineering verification of
  arithmetic. The §7.2 formula-verification gate is the operator (or a designated reviewer) accepting
  it, and that has not happened. The ledger says so.
- **Concentration is cost-based.** Measuring on marked value would let an unrealised write-up create
  concentration headroom — the fund could breach a limit by believing in itself. A policy that states
  no limit produces NO limit rather than an invented threshold (same rule as P8 severity bands).
- **Each option type routes to its own reserved key.** `OPTION_DECISION_ACTIONS` maps RESERVE →
  `reserve_allocation.approve`, FOLLOW_ON → `follow_on.approve`, and the rest →
  `capital_allocation_cross_sleeve.approve`. All three already exist in the canon register; a receipt
  for one can never decide another.
- **A decision is not a capital movement.** Approving an option records a human decision and, for
  RESERVE, writes a `reserve_allocation` reservation. No P11 code path moves money;
  `capital.move_or_commit` and `wire.initiate_or_authorize` remain separately reserved, and the
  `allocation.option_decided` spine event records `capital_moved: false` explicitly.
- **Runs are immutable and rank nothing.** `cross_sleeve_comparison_run`, its per-option results, and
  `constraint_violation` are all UPDATE/DELETE-rejected by trigger, and no result column carries a
  rank, score, or recommendation. Modelled outcomes are labelled `MODELLED SCENARIO — NOT AN
  EXPECTED RETURN` on both the run row and the scenario read.

### ADR-014 — P12 reporting / reconciliation implementation notes
- **Required reviews are ROWS, not a flag.** Submitting a packet opens one PENDING `reporting_review`
  per required function (FINANCE, COMPLIANCE, MANAGING_PARTNER). Distribution reads those rows, and a
  reviewer must actually hold the function they sign off for — compliance cannot cover finance.
- **The review gate is checked BEFORE the receipt.** An unreviewed packet is refused before any
  authorization receipt is read, so a valid send receipt can never stand in for a missing review.
  Distribution then needs the reserved `lp_sensitive_communication.send` receipt as a second,
  independent gate (P10 law: LP-facing material is human-gated).
- **No-overwrite is enforced in the database, not the service.** A trigger on
  `fund_reconciliation_exception` rejects any UPDATE that touches `administrator_value`,
  `internal_value`, `record_key`, `field`, `run_id`, or `exception_kind`; only `status` may move.
  This holds for every actor — including a Managing Partner, including direct SQL — because "the
  administrator remains authoritative" is a property of the data, not a promise made by a code path.
- **Restating an official figure is reserved; escalating is not.** `ACCEPT_ADMINISTRATOR` and
  `CORRECT_INTERNAL` change what our books say and need an
  `official_valuation_or_capital_account.change` receipt. `ESCALATE_TO_ADMINISTRATOR` and `NO_ACTION`
  change no number and need none.
- **West Peek OS never writes to an administrator system.** The import is read-only by construction:
  it accepts supplied records and compares them. Runs are stamped `LOCAL_FIXTURE` until a real
  administrator source contract exists (§7.2), and `reconciliation.run_completed` records
  `administrator_records_written: 0`.
- **Certification is absent by design.** No P12 table carries a `certified` / `audited` /
  `gaap_compliant` column, and a test asserts their absence. The packet listing states plainly that
  no financial, accounting, or valuation correctness is certified (§12.4).

### ADR-016 — Every review state needs an exit (final-review finding)
A final review pass over P10/P12 found the same defect in both: a **negative** disposition was
recordable but nothing consumed it, leaving the object in a stale state with no way back into
review through its own surface.

- **P10.** `lp_claim.status` included `REJECTED`, and `submitLpClaim` accepted it as a revisable
  starting state — but nothing ever *set* it. A claim whose `lp_marketing_claim.approve` card was
  rejected stayed `PENDING_REVIEW` and could not be resubmitted (`illegal_state`). Fixed with
  `rejectLpClaim` / `POST /api/lp/claims/:id/reject`, which resolves the dangling card through
  `decideApproval` and sets `REJECTED`, closing the loop the enum already implied.
- **P12.** A `REJECTED` reporting review made `all_complete` permanently false while
  `recordReview` refused to re-record it and `submitPacket` accepted only `DRAFT` — an unreachable
  state. Fixed by moving the packet to `WITHDRAWN` (already in the schema, previously unused).

**P6 carries the same rule (finalization gate).** Probing found the identical shape in
`submitTransactionForApproval`: a transaction whose card was rejected kept `PENDING_APPROVAL` with no
way to request a new card. It now applies the same card-disposition rule. It is deliberately NOT
auto-VOIDed — `VOID` means "reverse a booked transaction", carries position effects, and is
MP-reserved via `transaction.void`; a refused submission booked nothing.

**Severity correction (measured, not assumed).** Earlier revisions of this ADR and the ledger
described the P10 case as leaving the claim "unpublishable" and "bricked". That was an over-claim,
and probing disproved it: `publishLpClaim` gates on the *receipt*, not on `lp_claim.status`, so a
`PENDING_REVIEW` claim publishes normally once any valid `lp_marketing_claim.approve` receipt is
presented — including one minted through the generic `/api/approvals` surface. The real defect was
narrower and still worth fixing: a **stale, misleading status** plus **no path back into review
through the LP surface**. The P12 case is genuinely blocking, because distribution reads the review
rows themselves rather than a receipt.

**Why the two fixes differ.** An LP claim is *language*: it is revised and re-reviewed, and the
prior rejected card survives as history, so returning to `REJECTED` loses nothing. A reporting
packet is a *published financial statement*: you do not un-reject one, you issue a corrected
version. `WITHDRAWN` is therefore terminal, the rejection row is preserved verbatim, and the path
forward is a new version of the same period — the same supersession rule the rest of the system
follows.

Refusing needs the approver ROLE but no receipt (P6 precedent, `ic.ts`): declining to authorise is
not itself a reserved act. `authorize()` still DENYs anyone who could not have approved, and AI
actors are refused outright.

**Correction (final repair pass).** The first version of this fix was incomplete. It added a correct
LP-specific path (`POST /api/lp/claims/:id/reject`) but left the *ordinary* path open: a reviewer
works in the generic **Approvals** surface, which rejects the approval CARD through
`/api/approvals/:id/decide` and knows nothing about `lp_claim`. That route left the claim in
`PENDING_REVIEW` — the exact dead-end the ADR claimed to have closed, still reachable by the path
most reviewers actually take.

`submitLpClaim` now treats **the card's own disposition** as the authority on whether review is
over: a claim in `PENDING_REVIEW` whose linked card is `rejected` or `revise_requested` is
revisable, however that refusal was expressed. A card still in `pending_review` is not — nobody gets
to resubmit around a live review. The lesson generalises: when object state mirrors approval state,
the object must read the card rather than trust that every writer remembered to update it.

### ADR-015 — Restore drops and re-creates append-only triggers
The append-only/immutability triggers stop the APPLICATION from rewriting institutional history — and
they also reject the DELETEs a faithful reload needs, which broke `restore.mjs` as soon as immutable
tables spread beyond `event_record`. A restore is a privileged administrative rebuild, not an
application flow, and it is already gated behind `--force`, so `restore.mjs` now records every trigger's
own `CREATE` SQL from `sqlite_master`, drops them for the load, re-creates them, and **verifies the full
set is back** before reporting success. A restored database that silently lost its append-only
enforcement would be worse than a failed restore, so that verification is a hard failure, not a warning.

### ADR-017 — Scheduling is a Cron Trigger over D1 state; no Queues, no Durable Objects
GAP-21 asks for the *smallest* architecture that satisfies the firm's real recurring workload. That
workload, enumerated honestly, is: a daily intelligence brief, a periodic portfolio-alert
evaluation, and occasional scheduled employee tasks. Coarse-grained, low-frequency, and needing
durable history far more than throughput.

D1 already gives durable state with append-only history and transactions. The only thing missing was
a clock, and Cloudflare Cron Triggers are exactly a clock. So: **one cron trigger** calls the
Worker's `scheduled()` handler, which selects due `scheduled_job` rows and runs each through the
same governed path an operator uses by hand.

**Queues and Durable Objects are refused.** A queue would add at-least-once delivery semantics,
consumer concurrency, and a second failure surface to a workload that runs a handful of jobs a day;
a Durable Object would add a coordination primitive where a `next_run_at` column and a UNIQUE
idempotency key already prevent double execution. AGENTS.md is explicit that Cloudflare products are
not added because they exist, and neither earns its complexity here. If a future workload genuinely
needs fan-out or per-item retry at volume, that is the moment to revisit this — and it will be a
visible change, not a silent one.

Three consequences worth stating plainly:

1. **A cron trigger cannot fire under local `wrangler dev`.** The same function is therefore
   reachable at `POST /api/jobs/tick` and is called directly in tests, which is how the scheduled
   path is proven offline. Remote *firing* stays UNPROVEN until deployment — the code path is
   proven; Cloudflare calling it is not.
2. **Governance refusals are outcomes, not errors.** A job whose employee is not ACTIVE, whose
   machine is paused, or which is itself paused records a `REFUSED` run with the reason, and is not
   retried. Retrying a governance refusal would be trying to wear it down.
3. **Genuine failures retry to the job's own limit and then stop** in `DEAD_LETTER`, where a human
   can see them. Nothing loops silently.

### ADR-018 — Standing authority is a third tier, bounded three ways, and can never reach a reserved action
Operator ask, 22 Aug 2026: a way to approve something and stop being asked about it again for this
task, today, or this week — with the design decided rather than put to her.

**The frame is delegated authority, not dismissal.** An LPA lets the GP act within stated limits
without returning to the LPs; a board delegates spend up to a threshold; a desk sets a daily limit.
Each carries a scope, a limit and an expiry, and each is revocable. Authority is delegable; judgment
is not. That distinction is what makes the tier safe rather than what makes it convenient.

`authorize()` gained one tier, checked in a deliberate position:

    receipt → reserved → external effect → RESTRICTED (role gate) → STANDING (delegated) → ordinary

**After reserved and external, never before.** A standing grant therefore *cannot* cover the 53
human-reserved actions or the 4 external effects, and that is enforced in the choke point rather
than in the interface — an interface rule is a suggestion, and this one protects the operator's own
standing line that no AI employee emails anybody yet. `grantStandingAuthority()` refuses such a grant
at creation as well, so the impossible state cannot be recorded even briefly.

**All three bounds are required at creation.** Scope (one action key, optionally one object), a use
limit, and an expiry — end of this task, end of today, or end of this week. There is no unbounded
option, and `ends_at` is NOT NULL.

**Expiry-by-default is the safety property, not the convenience.** A grant that never expires becomes
permanent through neglect: revoking it requires first remembering it exists, and the reason it was
granted was to stop thinking about the thing. Expiry inverts the default so authority returns
without anybody acting. "Until this work card closes" is the recommended option because its lifetime
is bounded by a real event rather than by a clock that runs overnight.

**Refused, deliberately:** a blanket "approve everything today"; a silent "remember my choice"
checkbox; any grant without a written reason. The first is abdication rather than delegation; the
second creates authority nobody can find later; the third is unreviewable.

Work-card volume is handled in the same change and is deliberately NOT part of this tier. Duplicate
suppression is a uniqueness rule that is always on and joins the existing card rather than refusing.
Rate limits (20 per employee per rolling hour, 60 open) are a HEALTH SIGNAL routed through
`healthEscalation.ts`, not a permission — a permission gate on volume would deliver a runaway to the
partners as forty approvals instead of stopping it. Full reasoning in `docs/APPROVAL_AND_WORK_DESIGN.md`.

### ADR-019 — A meeting is captured in the browser, and a deal reaches the committee by moving one stage
Operator, 22 Aug 2026: "the meeting tab is not good enough it is not self explanatory from looking
at the page what im able to do. and the IC flow ----who makes the packet how does that get done? how
do we get thru the pipeline and what happens to the page once a deal is at the IC stage?"

Four questions, and the honest answer to all four before this change was that nobody had decided.
The machinery existed — consent records, transcript gates, close-out extraction, a diligence
framework, an append-only decision — and none of it had an owner, a trigger, or a page that said so.
This ADR decides the whole shape, including the two parts it deliberately does not build.

**Poppy makes the packet, and the packet's missing half is a list of questions rather than prose.**
She is the IC Facilitator; she already holds `ic_decision` and `ic_learning_loop`; assembling the
packet is literally her stated job. The packet is DRAFTED from what the firm already holds —
verified claims, diligence answers, portfolio metrics, deal math — and **every gap becomes a named
question owed by a named person** instead of a paragraph. A packet that invents its missing half is
worse than a short one: it reads as complete, so nobody goes looking. `ic_open_question` (migration
0131) is where those gaps live, each carrying what the firm looked at and did not find.

**Pierce is always the champion, so Pierce may never write the kill case.** That rule already
existed in `icPortal.ts` and is now also what decides who a question is addressed to: the bear-case
questions are owed by a partner who is not carrying the deal, and the ordinary diligence questions
are owed by the champion. Otherwise IC becomes a sales meeting for the investment, which is the
firm's own stated reason for the rule.

**A deal reaches IC by a stage transition, not by anybody remembering.** `DILIGENCE → IC_READY` on
the Dealflow spine now creates an `ic_packet` in DRAFT and opens a WORK CARD for Poppy to assemble
it. Nothing auto-decides and nothing auto-answers; the card is the mechanism, exactly as inbound
email opens a card for Wyatt rather than quietly creating a company. Re-entering the stage does not
mint a second packet — an open packet is found and left alone.

**An IC rejection sends the deal to the pass pile, and that is a bug fix as much as a decision.**
`IC_DECIDED` could only move on to `CLOSED` or `WITHDRAWN`, so a deal the committee rejected was
stranded in a state whose only forward move said the fund invested. REJECT now transitions the
opportunity to `PASS` carrying the decision's own rationale as the reason, which is why a REJECT
requires a rationale in a sentence: for a fund the record of what it declined is half the value of
the pipeline, and the reason is the whole of that half. Nothing is deleted; PASS already reopens at
SCREENING when a company comes back.

**Capture is in-browser, chunked to Workers AI Whisper on the existing `AI` binding.** No new
vendor, no new credential, nothing added to the egress allowlist — the same argument that made
Workers AI the cheap text tier and Browser Rendering a binding rather than an HTTP client. The
alternative everyone reaches for is a recording bot that joins the call, and it was refused for a
product reason rather than a cost one: **the firm's employees have to be able to talk to the
partners DURING the meeting.** Live Help is already built, seated, capped and revocable, and a bot
sitting in the call cannot be conferred with — it can only hand back a transcript afterwards. A
capture that runs in the same page as the conversation keeps the seated employee reachable while the
meeting is still happening, which is the entire point of having seated an employee at all.

**Consent is prompted and logged before capture starts, every time.** California is a two-party
state; New York and Georgia are not. A firm whose partners sit in one and whose founders sit in the
others cannot run on "usually fine". The consent machinery was already correct and already unused:
`consent_record` is append-only, human-only, revocable, the current state is the latest row per
(meeting, consent type), and `importTranscript` refuses and RECORDS the refusal when consent is
missing — so "we did not record" is auditable. What did not exist was the PROMPT. Capture now cannot
start without one, the prompt is shown every time rather than remembered, and both gates it depends
on — the activated recording policy and granted consent — are named on screen in plain words before
anybody presses anything. A remembered consent is the failure mode here: consent is given by a
person in a room on a day, and a checkbox that carries it forward to the next meeting is a record of
something that did not happen.

**Whisper is UNPROVEN and the button says so.** The transcription path is written, governed and
reachable, and it has never run against a real model: the `AI` binding does not exist under local
miniflare, there is no offline fixture that would prove anything, and this change deploys nothing.
So the capability is probed at runtime and the button is DISABLED with the reason on screen wherever
the binding is absent. It is never rendered as live and inert. When a chunk fails to transcribe the
page says which chunk and why, rather than dropping it — a transcript with a silent hole in it is
worse than a short one, for the same reason a packet with an invented middle is.

**A shared live room for both Managing Partners at once is designed here and DELIBERATELY NOT
BUILT.** It is also the one thing in this whole design that would genuinely justify a Durable
Object, which ADR-017 refused and AGENTS.md forbids without cause. The cause would be real: two
partners typing into one meeting room needs presence ("Sequoia is here"), ordering (whose line came
first when both typed in the same second), and a single authority both browsers agree with — and a
`next_run_at` column, a UNIQUE key and polling give none of those. Every other coordination problem
in this system is coarse and low-frequency; this one is per-keystroke and inherently multi-client,
which is exactly the boundary ADR-017 said would be the moment to revisit the decision.

It is deferred anyway, and the reason is not doubt about the design. Everything else in this change
is D1 rows written through the existing choke point — it can fail, but it fails the way the rest of
the system already fails, and a partner sees a refusal. A Durable Object adds a second coordination
primitive and a second failure surface: a room that is up while the Worker is down, or down while
the Worker is up, and a class of bug ("the other partner's line never arrived") that is invisible in
D1 and cannot be reconstructed from the event spine. Both partners in one room is worth that price
one day. It is not worth it in the same change that first makes the page legible, and shipping it
alongside would make every problem in the page ambiguous between the two. **Designed, written down,
not built** — and when it is built it will be a visible change with its own ADR, not a silent one.

**The page is flat and always renders every section, LP-shaped.** Five sections in the order a
partner asks in: what is coming up; what happened and what came out of it; start a meeting now;
where a deal stands with the committee; and last, how a meeting becomes work. An empty section
states that it is empty and why, because "nothing has reached this yet" and "this is broken" look
identical otherwise — the same defect the IC sequence block was written to fix, applied to the whole
surface. The explainer goes last: a page that explains itself before showing anything is a page you
have to read before you can use.

**A transcript the firm did not record comes in by paste or file, not by API.** Operator, same day:
"i sometimes have fireflies meeting notes so the meetings should have fireflies and whisper
capabilities to transfer those notes and transcripts." Both paths land in the same place — turns on
the meeting, through the same two gates — and they are reached differently on purpose. A Fireflies
API integration needs a credential, a declared network boundary and a vendor decision, and
`validate:network-boundary` exists precisely to stop an outbound host appearing outside a declared
adapter. An export the operator already has in her hand needs none of that and works today. **The
API route is designed and deferred on the same terms as the shared room**: it is a second vendor
relationship for a convenience the paste box already delivers, and the day it is built it will be a
visible change with its own credential in the vault.

Three rules govern what an imported transcript IS, and each exists because getting it wrong is
silent:

1. **Importing is never consent.** The firm did not ask anybody anything by pressing a button;
   somebody else made that recording under conditions nobody here witnessed. Nothing in the import
   path writes a GRANTED consent row. The two existing gates still apply — taking custody of a
   recording of a conversation is the governed act, not the button used to do it — so an import
   without an activated policy and granted consent is refused and the refusal is recorded.
2. **The source travels with the transcript.** `source` already said PROVIDER / NATIVE / MANUAL /
   UPLOAD, which is the right shape at the wrong resolution: "PROVIDER" does not tell a reader who
   recorded this. `transcript_import.provider_name` names the vendor, and the record says in words
   that the firm cannot vouch for the permission the recording was made under. A turn West Peek
   captured and a turn out of somebody else's export are both usable and are not the same evidence.
3. **The parser never guesses who spoke.** Exports vary — speaker labels, timestamps, both, neither.
   A line that cannot be attributed with confidence is kept and marked as unattributed rather than
   handed to the nearest name above it, because close-out extracts commitments from these turns and
   an invented attribution becomes a task assigned to somebody who was never in the room. The one
   place a line inherits a speaker is a wrapped continuation directly beneath one, with nothing in
   between. A stop-list keeps "Note:" and "Action items:" from being read as people — that failure
   is silent, looks exactly like a transcript, and poisons every line beneath it.

Fireflies' own summary and action items are filed as **theirs**, clearly labelled, and never as
speech: their model wrote those words and nobody in the room said them. The action items are
deliberately NOT turned into commitments on import. Close-out reads the notes and PROPOSES
commitments a person accepts, and a second path that assigned work straight out of a vendor's
bullet list would go around the only step in the chain with a human in it.

**Addendum, 19 Sep 2026 — the Fireflies import is retired.** Owner, verbatim: "we will use Whisper in lieu of Fireflies — it's better." Two capture paths remain and are the only two: the room's recording
switch (this laptop's microphone → Nova-3, Whisper as the fallback; a yes asked every session; live,
a minute at a time) and Google Meet's own transcription read in after the call (`meetIngest.ts`).
The paste-or-upload door is gone from the During face and the meeting record; its route answers
**410 `fireflies_import_retired`** with the owner's words and the two paths named, never a 404
(the 0198 precedent). The parser (`firefliesTranscript.ts`) stays because `meetTranscript.ts` and
Nova-3's `diarisedLine` render every turn through its `turnLine` shape — it is a line shape now,
not a door. `npm run validate:whisper-not-fireflies` holds all of this. Rows already stamped
`FIREFLIES` are history and still read as what they were.

## A link that SENDS mail is a credential; a link that STEERS work is not (17 Sep 2026)

**Both decisions were made on the same day, deliberately in opposite directions, and the reason is
worth having written down where the next person adding an emailed button will hit it.**

Scooter's steering replies were given **no token at all**. Recognising an authenticated sender was
judged sufficient, because the worst a forged steer can do is waste a week of one employee's
attention, and the next note makes it visible. Cheap to detect, cheap to undo, and a token would
have been ceremony on a mechanism whose whole value is that answering costs nothing.

**"Send it" on a preview is the opposite kind of link**, and the bar moves for three reasons:

| | A steering reply | A preview approval |
|---|---|---|
| **What it does** | Changes what an employee does next | Puts a message in front of somebody outside the firm |
| **Reversible?** | Yes — the next run corrects it | **No.** There is no unsend |
| **Who sees the damage** | The firm | A founder, an LP, a journalist — in the firm's voice |
| **Visible if forged?** | Yes, in the next note | **No.** It looks exactly like a real send in every log |
| **Arrives as** | Mail, with SPF/DKIM/DMARC to check | **An HTTP request**, where there is no envelope at all |

That last row is the one that settles it. **Recognising the sender is not sufficient here because
there is no sender to recognise** — a click from a phone carries no `From`, no signature and no
domain to verify. So the link itself is the credential, and it is built like one: per preview,
26 symbols of a 31-symbol alphabet (≈2^128) from `crypto.getRandomValues`, **stored only as a
SHA-256 hash** so a database read or a backup yields nothing usable, single use (claimed by the
UPDATE, not checked before it), expiring, and **bound to one recipient** — the send boundary
compares the approved address against the message's own, so a yes for one person cannot carry a
different message to another.

**And the link does not itself send.** The unauthenticated route is a GET that renders the draft and
three buttons which POST back. A GET that sent mail would be sent by the first link scanner, mail
client or corporate proxy that prefetched the URL, and that is standard behaviour in several of
them rather than a theoretical actor.

The contract is in `src/shared/work/previewLane.ts`, the enforcement in `assertPreviewLane` beside
`applyPreviewBoundary`, and `npm run validate:preview-lane` fails the build if a future transport,
route or handler gets round any of it.

## The WebRTC peer for a Google Meet runs on the owner's Mac, not in the Worker (19 Sep 2026)

Owner, 19 Sep 2026: "If I push Join on Meet what happens? Is it recording? Are my AI employees
there from Join on Meet alone?" The honest answer was no — the room heard nothing until the call
ended and tier 2 read the official transcript. The approved plan makes the room hear the Meet live
through the Meet Media API, and the first decision is where the media session can live.

**The Meet Media API is a WebRTC session.** `spaces.connectActiveConference` takes an SDP offer and
returns an SDP answer; everything after that is ICE over UDP, DTLS, SRTP, three virtual Opus
streams at 48 kHz, and four data channels, for as long as the call lasts. A Cloudflare Worker has
`fetch` and a request lifetime — no `RTCPeerConnection`, no UDP socket — and a Durable Object is
the same runtime with a mailbox. Neither can hold the session, and this ADR refuses to pretend
otherwise. A Cloudflare Container could, with a Chromium or libwebrtc image inside it and a bill for
every hour it waits for a call; AGENTS.md admits a new Cloudflare product only for a real
requirement, and there is a cheaper runtime that is also the one Google built the API for.

**The peer is headless Chromium on the owner's Mac**, driven by the Playwright this repo already
installs for e2e (`scripts/meet/live-listener.mjs`, launchd job
`ventures.westpeek.os.meet-listener`). Google's reference client runs in Chrome; Chrome carries the
codecs the API requires; and the Mac already runs the seat claimer under launchd with an Access
service token in the vault, so the pattern, the identity and the credential path all exist. It
costs nothing. Its honest limit is that her Mac must be awake, and the meeting row says
`meet_live_no_listener` when it is not, rather than silence.

**Every decision stays in the Worker.** The listener may say it is awake, learn which firm-hosted
Meets are in their window, read a space to see whether its conference is running, ask the Worker
to open a session, join, post each minute of audio to the Worker's chunk route, and say how it
ended. The Worker holds the gates (`meetLive.ts`: a calendar-synced meeting with a conference, the
meeting-type rule, the firm recording default, platform-announced consent, `meet.live.join`), the
consent record, the import, the states on the row, and the rolling draft. Audio goes only to the
Worker and from there only to the Workers AI binding with `mip_opt_out`; `validate:meet-live`
reads the service, the listener and the peer page and fails the build otherwise.

**LP and Broker meetings never join live** (owner's rule the same day). The Media API is Pre-GA
under the Workspace Developer Preview Program, whose term (vi) lets Google use data sent through
Pre-GA APIs to improve them. An LP conversation names limited partners and terms, and the rule
this repo already enforces for models — never a route whose terms permit that — applies to a media
route too. Enforced at the join decision in code (`liveAllowedForType`), recorded on the row as
`meet_live_off_lp_policy`, with the GA post-call transcript path unchanged for those meetings.

**Two sources of one call, one authoritative.** The live notes (`GOOGLE_MEET_LIVE`) exist so the
room can hear DURING; the official transcript (`GOOGLE_MEET`) is complete and attributed by name.
When the official one lands it supersedes the live imports (`transcript_import.superseded_by`), and
the After draft and the room's context read one conversation once. The live notes stay on the
record as corroboration.
