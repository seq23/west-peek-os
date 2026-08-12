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
Private ingress is Cloudflare Access (or equivalent) in deployed environments — configuration, not code
(UNPROVEN until operator configures). App-level `FirmUser` + `Role` + `AuthorityScope` records are always
enforced server-side. Local development uses an explicit dev-identity header honored only when
`WP_OS_ENV=local`; unauthenticated requests are denied everywhere, including local.

### ADR-007 — Remote Cloudflare identifiers
`wrangler.toml` ships placeholder `database_id` / KV `id`. Local dev and all local validation run offline
via miniflare. Real remote IDs are operator-supplied configuration gated behind the deployment approval;
they are non-secret but intentionally absent.

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
