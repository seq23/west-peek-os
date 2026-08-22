# Implementation Ledger — West Peek OS

Tracks phase status against the approved plan (P0–P12 authorized; P13+ deferred/unauthorized).
Status vocabulary follows approved plan §20.3. Nothing here may claim proof that did not run.

## Current status (2026-08-13)

`P0–P25 IMPLEMENTED LOCALLY + D1–D4 DESIGN OVERHAUL APPLIED AND INDEPENDENTLY REVIEWED — NAMED EXTERNAL GATES REMAIN`

A separately approved task (`TASK/APPROVED_TASK.md`, 2026-08-13) authorized a **visual / interaction
design overhaul only** (phases D1–D5) over this preserved P0–P25 baseline. It is recorded in its own
section at the end of this file. It added no product capability, changed no API contract, no
migration, no authority, and no worker code — every number in the P0–P25 sections below still holds,
re-run after the overhaul.

P0 through P12 built the governed substrate; the approved continuation (2026-08-12) authorized
P13–P25, which built the operating product on top of it. Every phase in both sections below is
`LOCAL VALIDATION PASSED`. Suite-wide, on a clean local D1: `tsc --noEmit` green ·
vitest **506/506** · Playwright **45/45** · `validate:authority`, `validate:ai-boundary`,
`validate:network-boundary` all PASSED · `migrate:local` idempotent · `prove-restore.mjs` PASSED
against the full 0001–0023 schema · parent authority SHA-256 unchanged.

The P0–P12 numbers recorded below (vitest 315/315, Playwright 16/16) were true at that gate and are
left as written; the continuation's own counts are in the P13–P25 section at the end of this file.

This is **not** a claim that the system is complete, production ready, compliant, or fully validated
(§18.4). Every external and provider-dependent layer remains UNPROVEN behind a named human or
credential gate — see the table at the end of this file. In particular: nothing has been deployed,
no live AI provider has ever been called, no specialist vendor (Harvey/Norm) has ever been called,
no external intelligence feed has ever been read, no calendar or mailbox is connected, no LP
material has been sent, no capital has moved, no administrator system has been read or written, no
push notification has been delivered, no Cloudflare cron trigger has fired, and no financial formula
has been *accepted* by the operator (writing the verification is engineering; accepting it is the
§7.2 gate).

**P13–P25 are now authorized** by the approved continuation task (`TASK/APPROVED_TASK.md`,
2026-08-12) and are tracked in their own section at the end of this file. P0–P12 above are the
preserved baseline and were not rewritten.

| Phase | Scope | Status | Proof actually run | Unproven / gated |
|---|---|---|---|---|
| P0 | App root + governance + configs | LOCAL VALIDATION PASSED | required files exist; `tsc --noEmit` green; `npm install` resolves; secret scan clean; parent authority SHA-256 re-verified unchanged; registry reference data codified (45 machines / 31 AI employees / reserved-action register) | remote deployment (approval gate) |
| Vault | Encrypted vault plumbing | LOCAL VALIDATION PASSED | `vault:init` + `doctor` (AES-256-GCM round-trip, Keychain custody, manifest consistency) + import/status/remove cycle with throwaway self-test key (since removed) | Cloudflare sync (credential gate); no real secrets imported yet |
| P1 | Runtime/persistence/auth/delivery | LOCAL VALIDATION PASSED | `tsc --noEmit` green; vitest 14/14 (schema/seeds, append-only triggers reject UPDATE+DELETE, auth denial matrix, `/api/me` identity+roles+scopes, health degradation, migration idempotency); Playwright 5/5 against local `wrangler dev` (401 unauthenticated, dev-header 200 Scooter Taylor, open `/api/health`, UI shell renders); `migrate:local` idempotent ("No migrations to apply" on re-run); `prove-restore.mjs` PASSED (seed → backup → wipe → restore → record readable, `evt_backup_proof_1786395025741`); parent authority SHA-256 re-verified unchanged | remote Cloudflare (credential gate); preview/production environments (do not exist — approval gate) |
| P2 | Identity + fund/policy core | LOCAL VALIDATION PASSED | `tsc --noEmit` green; vitest 45/45 (duplicate prevention across name/alias/external-identity entry points with 409+existing; alias resolution to the one canonical company + alias-add never creates a company; similar-name companies and fund entities stay distinct; candidate accept/reject without merge; merge 403 for non-MP / 201 for MP with complete receipt — moved refs, pre-merge snapshot, SHA-256 verified; reversal deep-compares all affected rows equal to pre-merge state; double-merge, double-reversal, and post-merge-drift reversals refused 409; UPDATE+DELETE rejected by triggers on all four policy version tables with v1 preserved after v2; FK violations error, nothing persisted; migration idempotency; import dry-run valid→report-only zero rows written / invalid→400); Playwright 5/5 regression against local `wrangler dev`; `migrate:local` idempotent ("No migrations to apply" on re-run); parent authority SHA-256 re-verified unchanged | live imports (human approval gate); merge/reverse still behind interim MP role check — formal `authorize()` choke point + approval card is P3 (TODO in `services/companies.ts`) |
| P3 | Work spine + authorize() + approvals + event spine | LOCAL VALIDATION PASSED | `tsc --noEmit` green; vitest 65/65 incl. adversarial authority suite (401 on all 23 P3 routes unauthenticated; cross-firm-scope DENY + list/read isolation; AI can request but NEVER decide and is DENIED reserved actions outright; COUNSEL cannot approve `investment.approve` while MP can; unknown action DENY; executor refuses no-receipt / wrong-object / wrong-action / consumed-receipt replay / re-execution, executes only with valid receipt and records simulated delivery + receipt id on the spine; approval_decision + event_record UPDATE/DELETE rejected by triggers; RESTRICTED/LP_PRIVATE/MNPI_SENSITIVE rows invisible to unscoped users, visible to MP; illegal approval + work-card transitions 409; 45 machines / 15 domains / 49 reserved actions seeded from the one TS registry, no MP name in the AI roster; approval-volume counts fixture days and flags >15; capture → route → work card → approval chain leaves typed spine events; merge/reverse now require approved approval cards through authorize() with receipts consumed on execution — P2 merge behavioral assertions kept, setup adjusted); Playwright 7/7 against local `wrangler dev` (P1 regression + browser journey: dev login → +Capture → route to work card → request approval → approve with note → Activity shows typed events incl. approval decision; second identity without roles: 401s, RESTRICTED capture hidden, decide 403); `npm run validate:authority` PASSED (static scan + 4-fixture self-test + seed freshness); `migrate:local` idempotent ("No migrations to apply" on re-run); parent authority SHA-256 re-verified unchanged | external-effect adapters are LOCAL SIMULATIONS (no real sends — provider/credential gate); AI-actor API identity does not exist yet (AI actors are service-level only until P4); remote Cloudflare (credential gate) |
| P4 | Governed AI layer | LOCAL VALIDATION PASSED | `tsc --noEmit` green; vitest 94/94 (29 new P4 tests: 401s on all 14 P4 routes; architectural scan + planted-violation self-test; egress default-deny — RESTRICTED/LP_PRIVATE/MNPI_SENSITIVE/BANKING_RESTRICTED/CONFIDENTIAL EGRESS_BLOCKED with zero provider calls in every privacy mode; LOCKDOWN local-only / FRONTIER PUBLIC+INTERNAL-only / LOCAL local adapter; credential-shaped input (fake API key, vault key name, wire instructions) blocked pre-call with pattern-class-only reasons; per-run + daily cap BUDGET_BLOCKED with zero provider calls; CRITICAL_ONLY defers non-critical and runs critical; CHEAPO picks cheapest adequate model, NORMAL honors preference; STRATEGIC_SURGE lifts caps inside the window, expired/incomplete surge falls back to NORMAL; kill-switch via governance.policy_change receipt + non-MP 403 + consumed-receipt replay 409 + KILL_SWITCHED run refusal + audit event; global disable → PROVIDER_DISABLED; every run row has unique trace_id + cost estimate, completed runs record actual usage; 31 seeded employees all INACTIVE, activation only via approved receipt with history + event, MP-name activation refused 409, 6th ACTIVE refused 409 with receipt unconsumed, AI self-grant of tool scope 403, no direct status route (404), status history append-only by trigger; external output quarantined until human accept, quarantined text absent from event spine/approvals/captures/work cards, AI accept 403; provider failure → BLOCKED_DEFERRED with visible reason while work cards still serve; budget GET + versioned POST behind receipt with immutable-row triggers); Playwright 8/8 against local `wrangler dev` (P1+P3 regression + P4 journey: mock-local run COMPLETED with trace in run list, credential-shaped run EGRESS_BLOCKED with visible reason, provider kill-switch as MP via approval receipt with spine event); `npm run validate:authority` PASSED (scan + self-test + seed freshness); `npm run validate:ai-boundary` PASSED (scan + 4-fixture self-test + AI-roster seed freshness); `migrate:local` idempotent ("No migrations to apply" on re-run); parent authority SHA-256 re-verified unchanged | live AI providers UNPROVEN — CREDENTIAL GATE (httpExternal exercised only against injected stub fetch; no real vendor call has ever been made); provider pricing is ILLUSTRATIVE placeholder config (operator-maintained); remote Cloudflare (credential gate) |
| P5 | Evidence/provenance/contradiction | LOCAL VALIDATION PASSED | `tsc --noEmit` green; vitest 112/112 (18 new P5 tests: 401s on all 29 P5 routes; contradiction creation across VALUE/PERIOD/DEFINITION via deterministic candidates + AI proposal enters OPEN with proposed-by recorded and AI resolve 403; supersession chain A→B→C all readable with current pointer correct and double-supersede 409; create without source/date/location/method/confidence → 400; unresolved HIGH/CRITICAL contradictions always in evidence-summary, unaffected by query params, LOW/RESOLVED excluded, INVESTIGATING still surfaces; self-promotion ban — direct create VERIFIED with MODEL_OUTPUT/TRANSCRIPT/WEB/VENDOR-only sources 409, AI-actor service create VERIFIED 409, D1 CHECK rejects direct SQL flip of an AI claim, verify 409 for AI-extracted and source-poor claims, no generic status route (404); human VERIFIED via DOCUMENT source at create + verify-upgrade + accept-extraction flow (re-attributes to human, ai_run_id preserved, double-accept 409); knowledge promotion 409 without receipt → approved receipt creates knowledge_record with full provenance + receipt consumed + replay 409, reject path, supersede chain v1→v2 with v1 still readable; document round-trip upload→R2→sha256 match→byte-identical download incl. older versions, document_version UPDATE/DELETE rejected by trigger, R2-absent clean 503 documents_degraded on upload/download/extract; source conflict resolve records append-only decision with resolver identity, double-resolve 409, decision UPDATE/DELETE rejected by trigger; extraction fixture proof end-to-end offline via mock-local — candidates land AI_INFERRED with ai_run_id + MODEL_OUTPUT source naming the trace); Playwright 9/9 against local `wrangler dev` (P1+P3+P4 regression + P5 journey: upload document as Scooter → company → sourced claim → conflicting claim → deterministic detection → contradiction visible in evidence summary → human resolve → typed spine events document.uploaded/claim.created/contradiction.created/contradiction.resolved; first run showed a transient p4 internal_error + p1 schema-pin failures — pins updated to 0005, re-run fully green); `npm run validate:authority` PASSED (scan + self-test + seed freshness: 50 reserved actions / 76 action types incl. P5 keys); `npm run validate:ai-boundary` PASSED (scan + self-test + seed freshness); `migrate:local` idempotent ("No migrations to apply" on re-run); parent authority SHA-256 re-verified unchanged | real provider extraction UNPROVEN — CREDENTIAL GATE (fixture proof only, mock-local adapter); remote R2/D1 (credential gate) |
| P6 | Investment/IC/transactions/positions | LOCAL VALIDATION PASSED | `tsc --noEmit` green; vitest 184/184 (31 new P6 tests: 401s on all 35 P6 routes; one canonical company carrying many opportunities/transactions/positions with per-share-class position rows that never blend, second buy in the same class adding to the existing row; secondaries provenance — seller/broker/share class/fees/carry/terms/source channel all preserved on the row; duplicate blocks LINKED not merged with idempotent re-scan, both rows surviving a CONFIRMED link intact, deterministic detector producing no candidate for unrelated or cross-issuer blocks, AI able to propose but 403 on decide; pricing BID/ASK/INDICATION/EXECUTED_TRANSACTION/PRIMARY_ROUND/INTERNAL_ESTIMATE stay distinct and MNPI_SENSITIVE observations invisible to a non-MP; execution refused with no receipt / wrong action / wrong object / non-MP approver, executed once then replay 409, secondary_purchase.approve vs follow_on.approve vs exit.approve each required for their own type, sell-side pro-rata basis relief + CLOSED at zero, oversell refused, MP-reserved void reversing the recorded position effect while preserving the row, transaction parties preserving seller/broker/fund-entity; deal math manual entry with INPUTS_MISSING, CALCULATED filling only verified-formula metrics with tvpi/dpi left null, unsupported deal type refused, review→IC_READY then any edit dropping ic_ready, assumption_ledger UPDATE/DELETE rejected by trigger; IC packet showing a contradiction opened AFTER assembly, APPROVE refused without a receipt then recorded + receipt consumed + replay 409, REJECT by MP resolving the pending card, non-MP 403, AI drafting only with an ai_run_id and 403 on decide/dissent, DEFER returning the packet to DRAFT, ic_decision/dissent_record UPDATE+DELETE rejected by trigger; illegal lifecycle transitions 409; typed spine events for the whole journey; no P6 table carries a compliance/legal conclusion column); Playwright 10/10 against local `wrangler dev` (P1+P3+P4+P5 regression + P6 journey: company → conflicting claims → contradiction → opportunity → manual packet → CALCULATED → IC packet showing the unresolved contradiction → APPROVE refused without receipt → submit → MP approves the card → receipted APPROVE → replay 409 → ic.* spine events → company 360); `npm run validate:authority` PASSED (scan + self-test + seed freshness: 51 reserved actions / 94 action types); `npm run validate:ai-boundary` PASSED; `migrate:local` idempotent; parent authority SHA-256 re-verified unchanged | real MNPI/secondaries data (counsel/compliance gate); historical deal walkthrough (operator data authorization); `seq23/secondaries` source access (formulas verified by hand in docs/DEAL_MATH_VERIFICATION.md, not by reading that repo); no brokerage/fund, MNPI, valuation, or investment-soundness conclusion is claimed (§12.4) |
| P7 | Meetings | LOCAL VALIDATION PASSED | `tsc --noEmit` green; vitest 24 new P7 tests (401s on all 14 P7 routes; consent REQUESTED→GRANTED→REVOKED with full history, GRANTED refused without a named grantor, AI actor 403 on recording consent, consent_record UPDATE+DELETE rejected by trigger; transcript refused + refusal ROW RECORDED when the recording policy is not activated, refused when consent was never recorded, imported only with BOTH gates, refused again after REVOKE, recording gate needs a valid receipt (wrong object refused, replay 409) and a non-MP/non-compliance human cannot activate it; transcript-derived notes require an IMPORTED transcript; manual + off-record path works with no consent and no recording, off-record can NEVER be promoted; transcript-derived candidate lands TRANSCRIPT-sourced UNVERIFIED and `/verify` 409s, debrief candidate lands HUMAN_STATEMENT UNVERIFIED, AI promotion requires a real run trace and lands AI_INFERRED + attributed to the AI + unverifiable, company-less meeting 400; commitment → work card exactly once (second convert 409) and an email follow-up still 409s without the P3 effect receipt; prep packet carries the evidence summary + unresolved CRITICAL contradiction, AI prep/debrief refused without ai_run_id; with every provider disabled and the firm moved to FRONTIER through the governed policy route, run_ai is PROVIDER_DISABLED/KILL_SWITCHED while the entire meeting journey still completes manually; illegal lifecycle transitions 409; MNPI_SENSITIVE meeting invisible to a non-MP in both list and read; 8 typed spine event types recorded); Playwright P7 journey against local `wrangler dev` (transcript refused → consent granted → still refused → MP approves the recording-policy card → import succeeds → manual note → commitment → converted work card visible in Work Cards → consent revoked → refused again); `npm run validate:authority` PASSED (52 reserved actions / 106 action types); `migrate:local` idempotent | live transcription/recording providers UNPROVEN — CREDENTIAL GATE (no transcription engine is called; import records an operator-supplied artifact); calendar/email scopes UNPROVEN — CREDENTIAL GATE; consent policy sufficiency is a human/legal question, not a technical claim (§12.4) |
| P8 | Portfolio | LOCAL VALIDATION PASSED | `tsc --noEmit` green; vitest 18 new P8 tests (401s on all 16 P8 routes; pure `assessDeterioration` proven direction-aware for HIGHER_IS_BETTER and LOWER_IS_BETTER with operator bands and with none; deterioration alert carries both dated values, the change percent, and an honest `severity_source` of `operator_bands` or `severity_unconfigured`; improvement raises nothing; STALE_UPDATE fires only past the operator window and MISSING_METRIC only for monitored metrics, an unmonitored metric raising neither; de-duplication folds a same-severity repeat into occurrence_count but a WORSE severity opens a NEW alert linked by escalated_from with the prior row RESOLVED-by-supersession and its severity never rewritten; a suppression rule silences at/below its cap and a CRITICAL still surfaces OPEN; alert disposition human-only (AI 403, double-resolve 409); AI support match requires a real run trace, cannot be self-accepted, and a human ACCEPT only opens the MP-reserved `introduction.relationship_sensitive` card which the accepting non-MP cannot approve — zero external effects executed; outcomes append-only by trigger with value + relationship notes preserved, AI 403; snapshot for an undefined metric 400; MNPI_SENSITIVE snapshot invisible to a non-MP; typed spine events) plus Playwright P8 journey (dated snapshots → HIGH deterioration alert → support request → proposed match → ACCEPT → pending MP introduction card, no effect requests); `npm run validate:authority` PASSED | alert QUALITY (precision / false-positive rate) UNPROVEN — requires real use and operator feedback; the `/api/diagnostics/alert-volume` endpoint reports counts only and says so; operator severity bands and stale windows are configuration, not defaults invented by the system |
| P9 | Network OS integration | LOCAL VALIDATION PASSED (fixture only) | `tsc --noEmit` green; vitest 19 new P9 tests (401s on all 8 P9 routes; an incomplete adapter contract is refused naming every missing clause, a complete one activates exactly one version, versions are immutable by trigger, AI 403; inbound applies once and records a repeat delivery as DUPLICATE_IGNORED with no second mapping row; a divergence opens a network_conflict AND a HIGH-priority resolver WORK CARD while the stored snapshot keeps the pre-conflict value, KEEP_EXTERNAL adopts the owner system value, KEEP_INTERNAL does not, double-resolve 409, AI 403; adapter failure records FAILED + reason on the cursor with prior mappings still readable and the rest of the app unaffected; the HTTP route with no configured client answers 503 `adapter_unconfigured` with an UNPROVEN detail and records the refusal; writeback refuses without a receipt (refusal recorded), executes once with an MP receipt that is then consumed (replay 409), a non-MP cannot obtain the authorization, an AI can never write back, and a FAILED delivery preserves the approval for retry; sync receipts append-only by trigger; six typed network.* spine event types; the boundary scanner catches partner-repo paths, foreign bindings and hosts while treating a provenance COMMENT as clean; no contact/relationship/touch/gmail_thread table exists in the WP OS schema) plus Playwright P9 journey (declare contract → live pull fails closed → LOCAL_FIXTURE pull → divergent pull opens conflict + resolver card → human KEEP_EXTERNAL resolution); `npm run validate:network-boundary` PASSED (scan + 5-fixture self-test) | LIVE Network OS integration UNPROVEN — INTEGRATION APPROVAL GATE: no client is configured, every live call fails closed, and all behaviour above is proven against an injected in-memory fixture (local-only, stamped LOCAL_FIXTURE) — never against the real system |
| P10 | LP/fundraising/data-room | LOCAL VALIDATION PASSED | `tsc --noEmit` green; vitest 22 P10 tests (401s on all 18 P10 routes; a claim with NO evidence and a claim whose only evidence is UNVERIFIED are both refused `unsubstantiated_claim` at submit, before any reviewer sees them; publish refused `approval_required` even with approved evidence when no receipt is presented — `authorize()` never goes looking for a card that happens to match; publish succeeds only with approved evidence AND an `lp_marketing_claim.approve` receipt decided by a COMPLIANCE_OFFICER, then the replay is refused 409; evidence that DECAYS between review and publication — the supporting diligence claim superseded — blocks the publish `unsubstantiated_claim`; an AI must present a real `run_ai` trace to draft and is 403 on submit and publish, and `lp.promise` is DENY for AI and for a non-MP human while an MP still only gets REQUIRE_APPROVAL; an unpublished claim cannot be attached to shared material 409 `unpublished_claim`; a grant records recipient/artifact VERSION/permission/time/expiry/receipt, v1 and v2 are shared as separate rows that never blur, the ledger computes ACTIVE, an expired grant reads EXPIRED with nobody editing the row, revocation is a new append-only record that flips effective status, double-revoke 409, and `data_room_access_record` UPDATE+DELETE are rejected by trigger; DRAFT material cannot be shared at all; no route serves data-room bytes (404) and `vdr_state` is labelled UNPROVEN; LP records are LP_PRIVATE and invisible to a firm user without the scope; an actual send still needs the P3 effect receipt and zero effects executed; typed `lp.*` events on the ONE spine); Playwright 14/14 against local `wrangler dev` including the new P10 journey (human-verify a diligence claim → draft LP claim → submit refused unsubstantiated → link VERIFIED evidence → submit → publish refused without receipt → MP approves the marketing-claim card → receipted publish → PUBLISHED → register artifact carrying the published claim → grant refused without the send receipt → receipted grant → revoke → `lp.*` spine events, zero executed effects); `npm run validate:authority` PASSED (45 machines / 15 domains / 53 reserved actions / 130 action types) | live LP use UNPROVEN — COUNSEL/COMPLIANCE GATE (no marketing, securities-law, or compliance sufficiency is claimed, §12.4); external VDR UNPROVEN — PROVIDER NOT SELECTED (West Peek OS records what was shared; it never delivers it); no LP outreach is automated and none was sent |
| P11 | Allocation | LOCAL VALIDATION PASSED | `tsc --noEmit` green; vitest 30 new P11 tests (401s on all 12 P11 routes; every pure formula checked against the hand-worked examples in `docs/ALLOCATION_VERIFICATION.md` — signed capital effect by option type, sleeve budget/remaining with the breach SIZE left unclamped while `remainingBefore` floors at 0, an exit freeing capacity, exactly-at-budget passing, cost-based concentration with `≤` at the limit and cost floored at 0 on an over-exit, an unstated limit meaning NO limit and a zero fund size never dividing, reserve coverage measured against REMAINING need so committing reserve raises coverage, overdraft vs no-need vs empty-pool each distinct, and one option breaching all four policies at once with each violation named; a scenario pins mandate/sleeve/reserve/concentration version ids plus `wpos-allocation-1.0.0`, a cross-fund pin is refused 400, and a LATER concentration version never changes what a stored run was computed against — the run keeps pointing at v1 with `limit_value` 10 while v1 itself stays immutable at the DB layer; assumptions ride on the scenario and are append-only by trigger; all six option types compare in one framework with no rank/score/recommendation field anywhere; reserve draws accumulate WITHIN a run so a joint overdraw surfaces on the second option; an empty scenario refuses to run 409 and runs/results/violations are all immutable by trigger; each option type routes to its OWN reserved action, a reserve receipt cannot approve a follow-on (`receipt_action_mismatch`), another option's receipt is refused (`receipt_object_mismatch`), no receipt is 409, the right receipt approves once then replay 409, a non-MP is 403 and an AI is 403 even holding a valid MP receipt; an AI may PROPOSE only with its `run_ai` trace; an approved RESERVE writes the `reserve_allocation` row with the receipt and still creates ZERO external effects with `capital_moved:false` on the spine event; REJECTED is recorded and stays; a follow-on review stores the hand-verified `computeFollowOn` path (pro-rata 2,000,000 on the worked fixture) and only a human closes it, twice is 409; CONFIDENTIAL scenarios are investment-team work while an MNPI_SENSITIVE one is hidden from a member in both read and list and a member still cannot decide; `authorize()` DENYs all three allocation actions to AI and to non-MP humans while an MP gets REQUIRE_APPROVAL); Playwright P11 journey against local `wrangler dev` (open scenario pinning current policy versions → pins + "NOT AN EXPECTED RETURN" label visible → state assumption → add a follow-on breaching the pinned 10% limit → run comparison → `CONCENTRATION_LIMIT` BREACH at 12.0000% visible → APPROVED refused without receipt → request reserved approval → MP approves the card in Approvals → receipted decision → APPROVED, zero executed effects, typed `allocation.*` spine events); `npm run validate:authority` PASSED (45 machines / 15 domains / 53 reserved actions / 135 action types) | real allocation use UNPROVEN — FORMULA-VERIFICATION ACCEPTANCE GATE: `docs/ALLOCATION_VERIFICATION.md` is engineering verification of arithmetic, NOT operator acceptance (§7.2); no expected return, ranking, correlation, pacing model, or marked valuation exists and none may be inferred; no code path moves capital — `capital.move_or_commit` and `wire.initiate_or_authorize` remain separately reserved |
| P12 | Reporting/reconciliation | LOCAL VALIDATION PASSED | `tsc --noEmit` green; vitest 17 new P12 tests (401s on all 12 P12 routes; submitting a packet opens one PENDING row per required review and distribution names exactly which are outstanding — a VALID send receipt does NOT stand in for a missing review and zero distribution receipts are written; a reviewer must hold the function they sign off for, so COMPLIANCE cannot cover FINANCE (403 `wrong_reviewer_role`), an INVESTMENT_TEAM member can cover none of the three, and the same review cannot be recorded twice; all three complete moves the packet to APPROVED but `distributed_at` stays null and distribution is still refused `approval_required` without the reserved receipt; with BOTH gates it distributes once, recording recipient + packet VERSION + receipt per recipient, refuses the replay, and `distribution_receipt` UPDATE+DELETE are rejected by trigger; an AI may draft with its `run_ai` trace but is 403 on review and distribute; `compareRecords` raises nothing on equal values, reports the SIGNED numeric gap (internal − administrator = −500,000) on a mismatch, reports NO difference rather than a misleading 0 for non-numeric values, and classifies MISSING_INTERNAL vs MISSING_ADMINISTRATOR distinctly; a run stores every exception, stamps `source_mode` LOCAL_FIXTURE, labels the source UNPROVEN, records `administrator_records_written: 0` on the spine, and is itself immutable; NO ROLE can overwrite what the administrator reported — direct SQL UPDATE of `administrator_value`, `internal_value`, `record_key`, and `field` are each rejected by trigger and DELETE is refused, while `status` alone still moves; ESCALATE needs no receipt while ACCEPT_ADMINISTRATOR is refused 409 then succeeds only with an `official_valuation_or_capital_account.change` receipt, resolutions are append-only and an exception resolves once, and the spine records `administrator_record_overwritten: false`; an AI can never resolve and a non-MP cannot restate an official figure; exceptions are BANKING_RESTRICTED and invisible without the scope; `authorize()` DENYs AI and non-MP humans on all 8 capital/banking/fund-admin reserved actions while an MP only ever gets REQUIRE_APPROVAL; no P12 table carries a certified/audited/gaap_compliant column and the packet listing states plainly that no financial, accounting, or valuation correctness is certified); Playwright P12 journey against local `wrangler dev` (open period + draft packet → distribution refused `reviews_incomplete` before AND after a partial review → all three reviews → APPROVED but still refused `approval_required` → MP approves the send card in Approvals → receipted distribution → DISTRIBUTED → administrator import disagreeing on NAV → VALUE_MISMATCH exception showing BOTH figures and `difference -500000` → human escalation → ESCALATED with the administrator's value unchanged → typed `reporting.*` / `reconciliation.*` spine events); full-suite regression green (vitest 309/309, Playwright 16/16 on a clean local D1); `npm run validate:authority` PASSED (45 machines / 15 domains / 53 reserved actions / 141 action types); `validate:ai-boundary` and `validate:network-boundary` PASSED; `migrate:local` idempotent ("No migrations to apply" on re-run); parent authority SHA-256 re-verified unchanged | live reconciliation UNPROVEN — FUND-ADMIN SOURCE CONTRACT GATE: no real administrator system has been read, no export format has been agreed, every run is stamped LOCAL_FIXTURE, and West Peek OS has no code path that writes to an administrator or accounting system; LP distribution proves ROUTING and REVIEW only — actual delivery is a P3 external effect or an external system and no real send occurred; no accounting, valuation, or financial correctness is certified (§12.4) |

A final review pass over P10–P12 found and fixed two real defects, and a following repair pass
found the first of those fixes was itself incomplete (ADR-016). All three are listed with the
other cross-phase fixes below.

## Cross-phase regression fixes made during P10–P12

| Fix | What was wrong | Proof |
|---|---|---|
| `restore.mjs` drops and re-creates append-only triggers (ADR-015) | The restore path was proven at P1 and then silently broke as immutability triggers spread past `event_record`: the seed-wipe DELETE hit `budget_policy` (P4) and could not proceed. `prove-restore.mjs` failed with "seed wipe made no progress". | `node scripts/backup/prove-restore.mjs` PASSED against the full 0001–0012 schema (`evt_backup_proof_1786541550570` readable after wipe+restore); the restore now re-creates every dropped trigger from its own recorded SQL and FAILS HARD if any is missing |
| Playwright pinned to one worker | All specs drive the SAME local D1 through one `wrangler dev`; parallel workers interleaved writes and corrupted each other's journeys (p5 failed only in a full run, passed alone). The isolation boundary is the database, not the file. | `npx playwright test` 16/16 green serially on a clean local D1; a stale `.wrangler` also fails clean-firm assumptions, so full runs start from `rm -rf .wrangler` |
| P10 `checkEvidence` rejects superseded diligence claims | A superseded claim stays VERIFIED and readable by P5 design, so an LP claim could be published on a figure that had already been restated. | `tests/lp.test.ts` "evidence that decays between review and publication blocks the publish" |
| P10 `rejectLpClaim` + `POST /api/lp/claims/:id/reject` (ADR-016) | Found in final review: `REJECTED` was READ by `submitLpClaim` but never WRITTEN. A claim whose marketing-claim card was rejected kept a stale `PENDING_REVIEW` status and could not be resubmitted (`illegal_state`). (Severity corrected by probing: publish gates on the RECEIPT, not on claim status, so the claim was never actually unpublishable — see ADR-016.) | `tests/lp.test.ts` "a reviewer can REFUSE the language, and the claim stays revisable" (card resolved to `rejected`, rejected receipt cannot publish, resubmit issues a NEW card) + "an AI can never refuse an LP claim either" |
| P10 `submitLpClaim` honours the CARD's disposition (ADR-016 correction) | Found in the repair pass: the `/reject` route above fixed the LP-specific path but left the ORDINARY one open — a reviewer works in the generic Approvals surface, which rejects the card via `/api/approvals/:id/decide` and knows nothing about `lp_claim`, leaving the claim stranded in PENDING_REVIEW exactly as before. A claim whose linked card is `rejected`/`revise_requested` is now revisable however the refusal was expressed; a card still `pending_review` is not. | `tests/lp.test.ts` "refusing the CARD on the generic Approvals surface leaves the claim revisable too" (incl. resubmission refused while the card is genuinely pending, and the stale rejected receipt still cannot publish) + "revise_requested on the card is also treated as review being over" |
| P12 rejected review withdraws the packet (ADR-016) | Found in final review: the same defect. A REJECTED review made `all_complete` permanently false while the review could not be re-recorded and submit accepted only DRAFT — an unreachable state with no exit. | `tests/reporting.test.ts` "a REJECTED review withdraws the packet instead of stranding it" (WITHDRAWN, distribution refused by name `packet_withdrawn`, rejection row preserved, corrected v2 submits cleanly) |

## P6 repair made at the finalization gate

**A P6 transaction whose execute approval card is rejected kept `status = 'PENDING_APPROVAL'`
forever.** `submitTransactionForApproval` accepted only `DRAFT`, so no fresh approval card could be
requested through the transaction surface. Measured before the fix:
`409 illegal_state — transaction is PENDING_APPROVAL, not DRAFT`.

Found by probing during final validation, after the same defect class was fixed in P10 and P12. It
was initially deferred as an operator decision; the finalization protocol requires locally
implementable failure-path gaps to be repaired rather than deferred, so it is now fixed.

**Fix:** `submitTransactionForApproval` treats the linked card's own disposition as the authority on
whether review is over — a transaction in `PENDING_APPROVAL` whose card is `rejected` or
`revise_requested` may be resubmitted, which issues a NEW card. A card still `pending_review` may
not, so nobody resubmits around a live review. Identical rule to `submitLpClaim` (ADR-016).

**Deliberately NOT auto-VOID.** `VOID` means "reverse a booked transaction", carries position
effects, and is MP-reserved via `transaction.void`. A refused submission booked nothing, so voiding
it would overstate what happened.

Proof: `tests/investment.test.ts` "a transaction whose approval card is refused can be resubmitted,
and is never auto-VOIDed" — resubmission refused while the card is genuinely pending, allowed once
refused, a NEW card issued, status still `PENDING_APPROVAL` (not VOID), and the stale rejected
receipt still cannot execute.

## Global external/provider layers

| Layer | State |
|---|---|
| Cloudflare remote deployment | UNPROVEN — CREDENTIAL/APPROVAL GATE (local miniflare only) |
| AI model providers | UNPROVEN — CREDENTIAL GATE (adapter + fixture tests only) |
| Encrypted vault | LOCAL VALIDATION PASSED (operator Mac): init/doctor/import/status/remove all exercised; Keychain entry `west-peek-os-vault` |
| Network OS | UNPROVEN — INTEGRATION APPROVAL GATE |
| Email/Calendar scopes | UNPROVEN — CREDENTIAL/APPROVAL GATE |
| VDR | UNPROVEN — PROVIDER NOT SELECTED (P10 records what was shared; it never delivers it) |
| Fund administrator export | UNPROVEN — SOURCE CONTRACT GATE (contract written: `docs/IMPORT_CONTRACTS.md` §fund-admin; every run stamped LOCAL_FIXTURE) |
| `seq23/secondaries` source access | UNPROVEN — SOURCE ACCESS GATE |
| Allocation formula acceptance | UNPROVEN — FORMULA-VERIFICATION ACCEPTANCE GATE (§7.2): `docs/ALLOCATION_VERIFICATION.md` and `docs/DEAL_MATH_VERIFICATION.md` are engineering verification; operator/reviewer acceptance has NOT occurred |

## Parent authority preservation

Baseline SHA-256 recorded at P0 (see `ARTIFACT_MANIFEST.md`). Re-verified at every snapshot boundary.
Any mismatch = stop and report.

---

# P13–P25 continuation

Authorized by `TASK/APPROVED_TASK.md` (2026-08-12). Scope: verify the supplied gap audit, then
build the operating product on top of the preserved P0–P12 substrate. Companion documents:
`docs/WEST_PEEK_BLUEPRINT_COMPLIANCE_LEDGER.md` (per-requirement classification, updated every
phase) and `docs/WEST_PEEK_COMPLETION_BLUEPRINT_v2.md` (the build contract).

Nothing in this section claims proof that did not run.

| Phase | Scope | Status | Proof actually run | Unproven / gated |
|---|---|---|---|---|
| P13 | Blueprint compliance verification + completion contract | COMPLETE (documentation phase) | Independent verification of all 24 audit claims against the real route table (`src/worker/index.ts`), the real schema (`migrations/0001`–`0012`), the real nav (`NAV_ITEMS`), and the real suites. Findings: 18 audit claims TRUE, 2 materially overstated (GAP-13 allocation math *is* implemented and verified; GAP-16 the Network OS adapter contract *is* implemented), 4 understate existing substrate (GAP-12/14/17/18). `eval_record` and `value_outcome` were found to be dead tables — no worker code reads or writes them — so GAP-11 is a true missing requirement rather than a partial one. Deliverables: `docs/WEST_PEEK_BLUEPRINT_COMPLIANCE_LEDGER.md`, `docs/WEST_PEEK_COMPLETION_BLUEPRINT_v2.md` | none — P13 is a verification phase and mutates only documentation |
| P14 | MP Command Center + Daily Intelligence Engine (GAP-04, GAP-05, GAP-23 opened) | LOCAL VALIDATION PASSED | `migrations/0013_intelligence_command.sql` (11 tables: sources, watchlists + append-only change log, versioned home/briefing preferences, home view state, runs, items, append-only citations, append-only feedback, briefings, owner-private personal profile + append-only entries). Services `intelligence.ts`, `mpHome.ts`, `personalIntelligence.ts`; 24 new routes; client `pages/HomePage.tsx` + `pages/IntelligencePage.tsx` and shared `lib/api.ts`. `tsc --noEmit` green; **vitest 349/349** including 34 new P14 tests (relevance is a stated heuristic that names each rule it fired and scores 0 on no match; dedupe treats case/punctuation/protocol/trailing-slash/query-string as noise but keeps different stories distinct; a replayed idempotency key returns the ORIGINAL run and acquires nothing twice; the same story under a NEW key counts as duplicate, not kept; an HTTP_FEED source with no egress client fails CLOSED — source EGRESS_GATED, run PARTIAL, zero items, and the report says so; INTERNAL acquisition reads governed firm state and carries a `investment_opportunity/…` citation; **the engine never writes into `diligence_claim` or `knowledge_record`** — asserted by count; a watchlisted story outranks an unwatched one in the same run and says why; one user cannot deactivate another's watchlist entry; a non-canonical watchlist company is refused 404; synthesis through `run_ai` writes why-it-matters ONLY from an unquarantined run and **never copies a quarantined external output**; archive removes an item from the active set while preserving the record and refuses a second archive 409; feedback UPDATE is rejected by trigger; a briefing is one artifact per (date, user) and differs per user; home preferences write a new version per change and UPDATE is rejected by trigger; MP home answers ten questions, states the *rule* behind "one thing to watch", **omits rather than empties** LP/banking modules for a user without the scope, and turns "what changed" into a real diff after the visit is marked; the private personal layer starts UNPROVEN_NO_SOURCE, refuses entries until its owner enables it, records MANUAL_ENTRY only, **is invisible to the other Managing Partner**, is append-only, and leaks no content into the event spine); Playwright `e2e/p14-mp-home.spec.ts` 4/4 against local `wrangler dev` (run engine → ranked item with stated reason → provenance → governed synthesis → Home surfaces it → drill-through returns to the owning surface; configurable layout saved as a new version; private layer disclaimed and honest) | live external feeds: **UNPROVEN — EGRESS/CREDENTIAL GATE** (no outbound feed client is configured; registered feeds are stored EGRESS_GATED and never read). Astrology/ephemeris calculation: **UNPROVEN — NO SOURCE** (nothing computes planetary positions; the governed interface exists and operator entries are labelled MANUAL_ENTRY). Scheduled (rather than manual) runs land at P19. AI synthesis quality is not claimed — the offline path uses the deterministic local adapter |
| P15 | Employee Lounge + Digital Office + Performance Management (GAP-01, GAP-10, GAP-11) | LOCAL VALIDATION PASSED | `migrations/0014_workforce.sql` (employee profile seeded from the roster layer, machine assignment, one department room per real department, append-only room messages with a DB-level CHECK that only an ANNOUNCEMENT may lack a work/run/handoff reference, handoffs, append-only memos and governance acknowledgements, immutable performance snapshots, append-only reviews). `services/workforce.ts` + 16 routes + `pages/EmployeesPage.tsx`. `tsc --noEmit` green; **vitest 31 new P15 tests** (the lounge returns all 31 employees with department/manager/machines/tool scope/current work/30-day runs and cost; every department has a room; the D10 law survives — the lifecycle route REFUSES `ACTIVE` outright, a lowering move writes to the SAME `ai_employee_status_history` spine with a null receipt, the same state twice is 409, and RETIRED is terminal on this path; an AI actor can never change a lifecycle, decide a handoff, compute a scorecard, or post an unreferenced firm announcement; a room message naming a non-existent work card is 404 and one with no reference is 400; an accepted handoff actually MOVES the work card's owner while a rejected one leaves it untouched; work cannot be handed to a non-ACTIVE employee (409 `target_not_active`); scorecards count real runs, name recurring failure causes by reason prefix, store the definition used, return null cost-per-output when nothing was accepted, and the table carries **no** `value_generated`/`value_usd` column; a RESTRICT review applies the restriction so record and state cannot disagree; room messages, memos, reviews, and snapshots all reject UPDATE/DELETE at the DB layer; one acknowledgement per actor per governance update); Playwright `e2e/p15-workforce.spec.ts` 3/3 (roster + cap + department filter; compute scorecard → lower lifecycle → history shows `INACTIVE → PAUSED`; department room announcement with members listed) | AI employees do not yet RUN on a schedule — that is P19. Live model execution per employee remains UNPROVEN — CREDENTIAL GATE. "Value generated" is deliberately not measured |
| P16 | Provider/model router + AI Cost Command Center (GAP-02, GAP-03) | LOCAL VALIDATION PASSED | `migrations/0015_provider_cost.sql` (model catalogue with `pricing_state` provenance, append-only health checks stamped LOCAL_FIXTURE/LIVE, append-only evaluations carrying their METHOD, versioned/immutable routing policies, machine model policy, per-run routing explanation, run attribution, versioned/immutable scoped budgets, deduped cost alerts; Fireworks registered as configuration — disabled, unpriced-for-egress, default-deny). New adapters `ai/providers/openRouter.ts` + `ai/providers/fireworks.ts`; router `ai/routing.ts`; `run_ai` extended with routing, policy fallback, scoped-budget preflight, and attribution; services `providerRouter.ts` + `costCenter.ts`; 13 routes; `pages/AiOpsPage.tsx`. `tsc --noEmit` green; **vitest 403/403** including 23 new P16 tests (the catalogue reports credential presence by NAME and the payload contains no secret-shaped value; the seeded catalogue is ILLUSTRATIVE and says no vendor price has been read; a SOURCED price with no date is refused 400; a health check is LOCAL_FIXTURE and its own text says "No request was made"; a LIVE evaluation is REFUSED 409 because recording one would be false; promotion to ACTIVE requires a recorded evaluation 409→200; both new adapters throw `credential_missing:<vendor>` BEFORE any fetch, proven by asserting the injected fetch was never called; a run against a credential-less provider records the reason on `ai_run_routing` instead of failing silently; **with no policy the router behaves exactly as P4** — cheapest capable model, one attempt, `policy_id` null; a policy naming an uncatalogued model is 404; a policy orders candidates so the dearer first choice wins and the explanation names the policy and version; fallback fires ONLY when the policy allows it and both attempts stay visible with the failure first; a machine model policy outranks the task policy and the attribution records the machine; period boundaries are computed from the clock; a scope applies only to runs inside it; a budget for a non-existent target is 404; a scoped cap blocks a run with `scoped_cap_exceeded:CATEGORY:RESEARCH:DAILY` and raises exactly ONE deduped BREACH alert; budget versions are immutable; alerts acknowledge once; the cost surface breaks spend down by employee/provider/model/machine/category and ships its definitions); Playwright `e2e/p16-ai-ops.spec.ts` 3/3; `validate:authority`, `validate:ai-boundary`, `validate:network-boundary` all PASSED after two validator refinements (below) | **Every live provider call remains UNPROVEN — CREDENTIAL GATE.** No OpenRouter, Fireworks, or other vendor key exists in any environment; adapters are exercised only against injected stubs. All seeded pricing is ILLUSTRATIVE — no vendor price has ever been read. Health is LOCAL_FIXTURE only: configuration coherence, never reachability. LIVE evaluations are refused by design until a real provider call is possible |

## Validator refinements made during P16

Both scans kept their teeth: each refinement added a NEW self-test fixture proving the narrowed
rule still catches the thing it exists to catch.

| Validator | Why it needed narrowing | What now proves it still works |
|---|---|---|
| `no-direct-provider-calls.mjs` | `ai/routing.ts` imports our OWN adapter factories (`./providers/openRouter`), and the vendor-name regex could not tell that from `import OpenAI from "openai"`. Relative specifiers into `providers/` are now stripped before the SDK test. | New fixture "real SDK import alongside a legitimate adapter import" — a genuine `import OpenAI from "openai"` in the same file is still caught. Self-test now reports its own case count (5) so a silently dropped case fails the pinned assertion in `tests/ai.test.ts`. |
| `no-cross-repo-coupling.mjs` | The scan forbade every `env.X` that was not `WP_OS_*`, which caught the P16 provider-credential secrets. Those are credentials for the governed AI boundary, not another system's storage — which is what the scan exists to prevent. A named allowlist (`ASSETS`, `OPENROUTER_API_KEY`, `FIREWORKS_API_KEY`, `AI_PROVIDER_API_KEY`) is now stripped before the foreign-binding test. | New fixture "foreign storage binding alongside a declared credential binding" — `env.PARTNER_DB` in a file that also reads `env.OPENROUTER_API_KEY` is still caught. Self-test case count now 6. |
| P17 | Machine Control Center + Capability Intelligence (GAP-06, GAP-07) | LOCAL VALIDATION PASSED | `migrations/0016_machines_capabilities.sql` (per-machine operating state seeded ACTIVE for all 45 registry rows, append-only state-change log, dependencies with a self-dependency CHECK, append-only machine memory, capability registry keeping `maturity` and `tested_state` as separate columns, assignments, append-only after-action records, append-only build-vs-buy decisions). Services `machines.ts` + `capabilities.ts`; 12 routes; `pages/MachinesPage.tsx`. **Pause is enforced in two independent services**: `handleRouteCapture` refuses a paused machine 409 `machine_paused`, and `run_ai` blocks before any estimate with `machine_paused:<id>`. `tsc --noEmit` green; **17 new P17 tests** (all 45 machines return with state/queue/spend/failures; a configuration change appends a CONFIG_CHANGE row to the machine's own memory; machine memory rejects UPDATE and DELETE; self-dependency 400 and unknown dependency 404; pause records from/to on the change log and refuses a redundant pause 409; **a paused machine refuses capture routing AND refuses to spend any AI budget, while still recording which machine caused the blocked run**; resuming restores both paths; a capability registers to the BENCH; `PROVEN_LIVE` is refused 409 because no live provider access exists; a cost estimate with no stated basis is refused 400; an UNTESTED capability cannot be made ACTIVE 409; assignment targets must exist; the recommended stack includes only ACTIVE capabilities with recorded after-action evidence, ranks by observed success rate (66.7% over 3 uses) and states that it is arithmetic rather than a model opinion; a capability with no evidence reports a NULL success rate rather than assuming success; a BUY decision without a vendor is refused 400; after-action and build-vs-buy records reject UPDATE); Playwright `e2e/p17-machines.spec.ts` 2/2 (fleet → memory → pause → API routing refused 409 → resume → routing succeeds; capability registers UNTESTED on the bench) | Scheduled/recurring machine work arrives at P19. `PROVEN_LIVE` capability proof and live per-machine model execution remain UNPROVEN — CREDENTIAL GATE |
| P18 | Intent-to-Execution work packets + Institutional Lens Bench (GAP-08, GAP-09) | LOCAL VALIDATION PASSED | `migrations/0017_work_packets.sql` (work packet with `original_text` made IMMUTABLE by trigger, append-only revisions, append-only lens outputs with **no column a reasoning trace could be written to**); `src/shared/registry/lenses.ts` (6 lenses: Lead, Supporting, Counter, Hostile Reviewer, Truth/Compliance Gate — blocking — and No Pedestal Law); `services/workPackets.ts`; 7 routes; `pages/IntentPage.tsx`. `tsc --noEmit` green; **18 new P18 tests** (enhancement is deterministic — identical input gives identical output; it names vagueness, a missing deadline, and an unnamed deliverable; reserved-authority words in the text surface as risks AND add the "prepares a decision; does not make one" acceptance criterion; DEEP adds hostile-review criteria while NONE derives nothing; **the operator's text is stored verbatim and a direct SQL UPDATE of `original_text` is rejected by trigger**; the default lens stack is applied and a first revision recorded; routing recommends a machine whose own declared purpose overlaps the intent and explains the match, returns null rather than guessing when nothing overlaps, and **never recommends a PAUSED machine**; the lens bench publishes its storage rule; `PRAGMA table_info(lens_output)` proves the schema has no `reasoning`/`chain_of_thought`/`scratchpad`/`trace` column; a lens outside the stack is refused 409 and a lens cannot be re-run; lens findings reject UPDATE and DELETE; **execution is refused while a blocking lens has not run — silence is not a pass**; an ADVERSE gate moves the packet to BLOCKED_BY_LENS and keeps execution refused; a passing gate executes, opening a real OPEN work card and a governed run recorded on the packet with cost attribution, and a second execution is refused; a COMPLETE packet cannot be revised; revisions accumulate append-only); Playwright `e2e/p18-intent.spec.ts` 2/2 (rough thought → verbatim text beside derived fields → execution refused by the unrun gate → gate recorded → executed) | AI-drafted lens critiques run through `run_ai`, so their quality is bounded by the offline local adapter; live model drafting remains UNPROVEN — CREDENTIAL GATE. Cost ESTIMATE per packet is recorded as a routing basis, not a quoted price |
| P19 | Governed orchestration + scheduled AI employees (GAP-21, GAP-22) | LOCAL VALIDATION PASSED | `migrations/0018_orchestration.sql` (scheduled jobs with schedule/target/capability/budget/data-class/retry policy, runs with a UNIQUE idempotency key and a REFUSED status distinct from FAILED, append-only run artifacts; the seeded Daily Intelligence job ships **PAUSED**). `services/jobs.ts`; worker `scheduled()` handler; `[triggers] crons = ["*/15 * * * *"]` in `wrangler.toml`; **ADR-017** written; 7 routes; `pages/JobsPage.tsx`. `tsc --noEmit` green; **16 new P19 tests** (INTERVAL and DAILY_AT arithmetic including the roll to tomorrow; every trigger inside one window yields the SAME occurrence key; the seeded job and every new job are created PAUSED with the reason recorded; duplicate job key 409 and unknown employee target 404; **a PAUSED job that is run anyway records a REFUSED run instead of doing the work**; **a job targeting a non-ACTIVE employee is REFUSED with a message naming D10, and the employee is still INACTIVE afterwards** — GAP-22's exact claim; the same job runs only after activation through the reserved receipt path, and its governed run is attributed to that employee; a job whose target machine is PAUSED is REFUSED; an intelligence job run records INTELLIGENCE_RUN and INTELLIGENCE_ITEM artifacts; **a second tick inside the same window replays instead of running twice** (one row for `daily_intelligence:2026-08-12`); `runDueJobs` is the same function the cron handler calls; the operator tick route states that it does not prove Cloudflare fired anything; a repeatedly failing job retries to `max_attempts` and then lands in DEAD_LETTER, counted on the job listing; a finished run cannot be cancelled 409); Playwright `e2e/p19-jobs.spec.ts` 1/1 (paused → refused → switched on → SUCCEEDED with its outcome in the job's history) | **Remote cron firing is UNPROVEN — DEPLOYMENT GATE.** A Cloudflare Cron Trigger cannot fire under local `wrangler dev`; the handler and the job path are proven, Cloudflare invoking them is not. Job kinds are limited to the three that can run honestly offline (INTELLIGENCE, PORTFOLIO_EVALUATION, EMPLOYEE_TASK); a fund-admin reconciliation job would need the source contract gate |
| P20 | Notifications + mobile/PWA command surface (GAP-19, GAP-20) | LOCAL VALIDATION PASSED | `migrations/0019_notifications.sql` (all ten notification kinds, severity, UNIQUE dedupe key, delivery status distinguishing DELIVERED_IN_APP / HELD_QUIET_HOURS / SUPPRESSED_BY_PREFERENCE, per-user preferences, append-only per-channel delivery log). `services/notifications.ts` + 6 routes + `pages/NotificationsPage.tsx`; emitters wired into approvals, portfolio alerts, scheduled-job dead-letters, employee lifecycle changes, and briefing assembly. PWA: `public/manifest.webmanifest`, `public/icon.svg`, `public/sw.js`, manifest/viewport/theme in `index.html`, worker registration in `main.tsx`, offline capture queue `lib/offlineQueue.ts`, and a shell status bar showing unread/critical, connection state, and any held captures. `tsc --noEmit` green; **12 new P20 tests** (quiet-hours arithmetic across midnight; in-app delivery works with no credential while **push is recorded UNAVAILABLE with the credential gate named** on every notification; the same fact dedupes to one row; the centre orders by severity and counts critical unread; a WARNING is HELD during quiet hours yet **stays readable with the reason attached**, and a CRITICAL is never held; a switched-off kind is suppressed except at CRITICAL; read and acknowledge are distinct, acknowledgement is once-only and lands on the event spine; **submitting a real approval card raises a real notification**, and **a dead-lettered scheduled job raises a CRITICAL one**; the manifest is installable; the service worker refuses to cache `/api/*` and contains no fake push handler; the HTML links the manifest and the entry registers the worker); Playwright `e2e/p20-notifications.spec.ts` 3/3 (approval → notification → acknowledge; quiet hours; manifest + service worker served and the shell usable at 390×844 — note: generation 1 asserted only that elements were *visible* at that width, which the generation-2 review found insufficient; see the P20 row correction below) | **Web push is UNPROVEN — CREDENTIAL GATE**: no push service, VAPID key, or subscription exists, so every push delivery row records UNAVAILABLE and no push handler is registered. Installability was exercised at phone viewport in a browser, **not on a physical device**. Biometrics and native-app behaviour are NOT implemented and NOT claimed. Offline support is deliberately capture-only: a held capture is labelled NOT saved, and no institutional state is ever served from cache |
| P21 | Research / Analyst Workstation (GAP-14) | LOCAL VALIDATION PASSED | `migrations/0020_research.sql` (projects, questions, sources carrying a stated reliability AND its basis, findings with an immutable statement and a single `promoted_claim_id` link into P5, market maps, immutable packets). `services/research.ts`; 10 routes; `pages/ResearchPage.tsx`. **No second evidence store**: promotion runs the existing `createClaim` path. `tsc --noEmit` green; **13 new P21 tests** (each research source kind maps onto the existing P5 claim vocabulary; a project opens with its question already recorded OPEN; a non-canonical company is refused 404 (D3); the API states plainly that it holds no separate evidence store; a reliability judgement above UNKNOWN without a stated basis is refused 400; a DOCUMENT source must name its version; a finding citing another project's source is refused 404; **promotion creates a real UNVERIFIED `diligence_claim` with a real `claim_source` row carrying source type, location, date, and the researcher's stated reliability — and the evidence substrate holds nothing for that company before promotion**; a finding cannot be promoted twice; the finding statement is immutable so research and evidence cannot drift apart; **packet IC-readiness is COMPUTED** — it refuses readiness while a question is open or a finding is unpromoted and names which, then reports ready once both are closed and moves the project to PACKAGED; unresolved contradictions from the firm's own P5 record travel with the packet rather than being filtered; packets are immutable); Playwright `e2e/p21-research.spec.ts` 1/1 (launch → source with basis → finding labelled "research only — not evidence" → promote → governed claim → packet explains why it is not IC-ready) | Live external source retrieval remains UNPROVEN — EGRESS GATE (the same gate as the intelligence engine): sources are recorded by an operator or drawn from internal records. AI-assisted research drafting runs through `run_ai` and is bounded by the offline local adapter |
| P22 | Live relationship + meeting integrations (GAP-16, GAP-17) | LOCAL VALIDATION PASSED | `migrations/0021_connectors.sql` (all six external systems registered as configuration — Network OS, calendar, email, transcription, VDR, fund administrator — each NOT_CONFIGURED, naming its credential, scopes, direction, ownership, and the human gate in front of it; append-only connector checks). `services/connectors.ts`; 3 routes; `pages/IntegrationsPage.tsx`. **This surface performs no external write of any kind.** Proof is in `tests/integrations.test.ts` (see P24 row for the shared count): six connectors NOT_CONFIGURED with no credential populated; transcription carries `consent_required` and names consent as a second independent gate; Network OS authority ("never overwrites it") is restated and its P9 facts — contract, cursors, conflicts, mappings — are read rather than mirrored; a LOCAL_FIXTURE check names every missing precondition (`NETWORK_OS_API_TOKEN is not populated`, `no adapter contract has been declared`) and its own detail says "Nothing was contacted"; the meeting prep queue reports needs-prep, participant count, and recording state as facts from P7 ("no recording policy activated"), and says plainly that no calendar is connected. Playwright `e2e/p22-24-integrations.spec.ts` 1/1 | **Network OS live integration: UNPROVEN — INTEGRATION APPROVAL + CREDENTIAL GATE** (unchanged from P9). **Calendar, email, transcription: UNPROVEN — CREDENTIAL/OAUTH + CONSENT GATE.** No external system has been contacted. The prep queue reflects meetings the firm entered by hand, not an external diary |
| P23 | Specialist AI provider lane — Harvey / Norm (GAP-15) | LOCAL VALIDATION PASSED | `migrations/0022_specialist_providers.sql` (both vendors registered as configuration (D9): disabled, unpriced, **no `provider_data_policy` row at all**, so default-deny means nothing may egress; `specialist_engagement` with **no `conclusion` column**). `ai/providers/specialist.ts`; specialist lane in `ai/routing.ts`; `services/specialist.ts`; 3 routes. **Requirement-verification note recorded in the migration**: this environment has no network access, no vendor account, and no published API contract for either vendor, so the adapter implements the generic governed shape and does NOT claim to match a real vendor endpoint. Proof: both vendors report disabled / 0 allowed labels / no credential / no endpoint; the adapter throws `vendor_endpoint_unknown` and `credential_missing` **before any fetch**, proven by asserting the injected fetch was never called; an engagement runs through `run_ai` and lands BLOCKED with `provider_disabled:harvey` recorded on the engagement and the run in the ordinary `ai_run` ledger; enabling Norm still blocks with `data_policy_denies_label:CONFIDENTIAL`; `PRAGMA table_info` proves there is no `conclusion`/`legal_opinion`/`advice`/`determination` column; accepting an output that never came back is refused 409 | **UNPROVEN — VENDOR ACCESS GATE.** No Harvey or Norm account, contract, credential, endpoint, or published API contract exists. Neither vendor has ever been called. Legal and compliance conclusions remain human-reserved (`legal.final_conclusion`, `compliance.act_as_officer`) and the schema has no place to store one |
| P24 | LP / fund-admin / VDR operating integration (GAP-18) | LOCAL VALIDATION PASSED | `migrations/0023_lp_ops.sql` (administrator/accounting/VDR sources with a three-state contract model where **LIVE is reachable only by an actual import**, reconciliation schedules, LP engagement state with an append-only change log). `services/lpOps.ts`; 4 routes; LP section of `pages/IntegrationsPage.tsx`. `tsc --noEmit` green; **16 new tests across P22–P24** (`tests/integrations.test.ts`), of which the P24 group proves: both seeded sources ship NO_CONTRACT with computed `NEVER_IMPORTED` freshness and the source-contract and VDR gates named; **a user without LP_PRIVATE scope is refused the whole surface (403) rather than shown an empty page**; `contract_state: LIVE` is refused from a caller and the response says it cannot be set by hand; FORMAT_AGREED without a named format is refused 400; a reconciliation schedule can be set and states plainly that running it still needs a source contract that does not exist; LP engagement transitions write an append-only change row (UPDATE rejected) and an AWAITING_DECISION move raises an LP_PRIVATE `LP_ISSUE` notification. Playwright `e2e/p22-24-integrations.spec.ts` 1/1 | **Fund administrator: UNPROVEN — SOURCE CONTRACT GATE** (no administrator system read, no export format agreed; every reconciliation run stays LOCAL_FIXTURE). **VDR: UNPROVEN — PROVIDER NOT SELECTED** (West Peek OS records what was shared and revoked; it has never delivered a document). LP distribution proves routing and review only |
| P25 | Institutional UX completion + cross-system journeys (GAP-12, GAP-13, GAP-23, GAP-24) | LOCAL VALIDATION PASSED | No new migration — both new surfaces are READ-ONLY aggregations over substrate that already exists. `services/cockpit.ts` (portfolio cockpit + allocation decision view), the `employees` module added to `services/mpHome.ts` to close the tenth MP question, 2 routes, `pages/CockpitPage.tsx`. Shared UI vocabulary (module cards, status badges, muted secondary text, mobile breakpoint) applied across all eleven new pages. `tsc --noEmit` green; **11 new P25 tests** (trend arithmetic reads each metric's DECLARED direction, so a fall in a higher-is-better metric is DETERIORATING and the same fall in a lower-is-better metric is IMPROVING — the same comparison P8 alerting uses, so cockpit and alert list cannot disagree; a single snapshot yields no trend rather than a guess; a real deteriorating metric appears with its −30% and window, and a metric past its own staleness rule is reported as a finding with "never as a blank" in the definitions; runway is only shown when the firm defined and recorded it; **the allocation view returns `comparison_run: null` and says "none are invented" when no comparison has been run**, states that a scenario is not a forecast, that West Peek OS never moves capital, and that the formula-verification gate is NOT accepted; it names the human-reserved action for every option type; an unknown scenario is 404 rather than an empty shell; **MP Home answers all ten §4 questions with zero unanswered once the workforce and reconciliation modules are enabled**; the workforce module says plainly that activation is an MP decision when nothing is ACTIVE; every module links to the surface that owns its records); Playwright `e2e/p25-journeys.spec.ts` **9/9 cross-system journeys** | Journeys 7 (meeting prep → transcript) and 8 (LP reconciliation) are driven to their external boundary and the unproven step is asserted as unproven — the calendar/transcription connectors and the fund-admin source contract do not exist. Allocation figures remain behind the FORMULA-VERIFICATION ACCEPTANCE GATE (§7.2) |

## P13–P25 suite-wide validation (2026-08-13)

Run on a clean local D1 (`rm -rf .wrangler` before the Playwright run):

| Check | Result |
|---|---|
| `tsc --noEmit` | green |
| `npx vitest run` | **513/513** across 26 suites (was 315/315 across 17 at the P12 gate) |
| `npx playwright test` | **45/45** across 21 specs (was 16/16 across 11) |
| `npm run validate:authority` | PASSED — 45 machines / 15 domains / 53 reserved actions / **204 action types**; self-test 4/4 |
| `npm run validate:ai-boundary` | PASSED; self-test **5/5** (one fixture added at P16); 31 employees, all seeded INACTIVE, no MP names |
| `npm run validate:network-boundary` | PASSED; self-test **6/6** (one fixture added at P16) |
| `wrangler d1 migrations apply --local` | idempotent — "No migrations to apply!" on re-run |
| `node scripts/backup/prove-restore.mjs` | PASSED against the full **0001–0023** schema (`evt_backup_proof_1786591360494` readable after wipe + restore) |
| Parent authority SHA-256 | both files byte-identical to the P0 baseline |

Artifact shape after the continuation: **23 migrations**, **312 API routes**, **26 vitest suites**,
**21 Playwright specs**, **11 new client pages**, ~30,250 lines of TypeScript under `src/`.

Re-verified at the generation-2 review boundary (2026-08-13): `tsc --noEmit` green · vitest
**513/513** · Playwright **45/45** on a clean local D1 · all three validators PASSED with their
self-tests · parent authority SHA-256 unchanged.

## Final review pass — generation 1 (implementer's own review, 2026-08-13)

An independent review of the continuation against the completion gate (§15.9) probed authority
coverage, secret handling, privacy enforcement, schema conventions, chain-of-thought storage, and
route collisions. Findings and what was done:

| Finding | Severity | Disposition |
|---|---|---|
| **Privacy labels were not enforced on three new list/read surfaces.** `work_packet` carries an operator-set `privacy_label`, `specialist_engagement` carries a `data_class`, and `room_message`/`internal_memo` carry labels — but their list and read handlers returned rows without the SQL visibility clause every P3-era surface applies. A RESTRICTED work packet was readable by any authenticated user. | REAL — the exact defect class P3 exists to prevent (privacy enforced server-side, never by UI hiding) | **FIXED.** `privacyVisibilityClause` now gates `GET /api/work-packets`, `GET /api/work-packets/:id` (404, not 403 — existence is not disclosed), `GET /api/specialist/engagements`, room messages, and memos. Proof: `tests/workPackets.test.ts` "hides a RESTRICTED packet from a user without the scope, on both list and read" |
| `connector`, `admin_source`, `reconciliation_schedule`, and `lp_engagement` lacked `firm_scope` | MINOR — convention drift (§11.7) | **FIXED.** Columns added; the rule is now written down in `AGENTS.md`: firm_scope lives on the aggregate ROOT and child rows inherit it through their foreign key rather than duplicating it |
| Route collision: `GET /api/meetings/prep-queue` was shadowed by the P7 `GET /api/meetings/:id` | REAL (found by test, not by reading) | **FIXED** during P22 — the route is `GET /api/meeting-prep/queue`. The hand-rolled router matches in registration order and has no literal-over-parameter precedence; new literal routes under an existing `:id` prefix must avoid the collision |
| Vitest exhausted ephemeral ports at 26 suites (EADDRNOTAVAIL) | REAL (infrastructure) | **FIXED.** `maxWorkers: 4` in `vitest.config.ts`, with the reason recorded there and in `AGENTS.md` |
| Every new service calls `authorize()`; no provider credential is returned by any handler; no chain-of-thought column exists anywhere; no route is registered twice | — | verified, no action |

## Independent final review — generation 2 (2026-08-13)

The host handed the run to a fresh `claude:final_review` worker. That review deliberately probed
differently from the implementer's own pass: mechanically, by enumerating every route and every
privacy-labelled table, and empirically, by writing a failing test BEFORE each fix and then
reverting the fix to confirm the test actually catches the defect.

**It found that generation 1's own review had stopped one step short.** Generation 1 fixed privacy
enforcement on three READ surfaces and concluded the class was closed. It was not: the same class
was still open on the corresponding WRITE paths and on the briefing.

| Finding | Severity | Evidence | Disposition |
|---|---|---|---|
| **The daily briefing ignored privacy labels entirely.** `assembleBriefing` selected `intelligence_item WHERE archived = 0` with no visibility clause, and re-read stored briefings the same way. An item at any of the four SENSITIVE labels (RESTRICTED / LP_PRIVATE / MNPI_SENSITIVE / BANKING_RESTRICTED) reached the briefing of a user with no scope for it. Reachable in one step: register a source at `data_class: RESTRICTED`, run the engine, read `/api/briefings/current` as an unscoped user. | **REAL — privacy leak** | `tests/intelligence.test.ts` "keeps a RESTRICTED item out of the briefing of a user without the scope". Verified by reverting the repair: the test fails. | **FIXED.** `assembleBriefing` now takes the identity and applies `privacyVisibilityClause` to both selection and stored-briefing re-read. The archived briefing row is immutable; the VIEW of it is filtered per reader. |
| **A record you cannot READ was still one you could ACT ON.** Mutation paths resolved their object by id with no visibility clause: work-packet lens/revise/execute, intelligence archive/feedback/synthesize, research question/source/finding/market-map/packet/answer/promote, and specialist accept. An unscoped user could run a lens on, execute, or promote evidence from a RESTRICTED record they could not see. | **REAL — authority/privacy** | `tests/workPackets.test.ts` "a packet they cannot read is a packet they cannot act on"; `tests/research.test.ts` two cases including "refuses to promote a finding on a project the caller cannot read" (asserting nothing entered the evidence substrate). | **FIXED** uniformly, via a `getVisible*` helper per service rather than a scattering of one-off checks. |
| **Acting on another user's notification.** `read` and `acknowledge` resolved the notification by id alone, so any authenticated user could put their own name on `read_by`/`acked_by` for a notification addressed to someone else — a false claim that the audit spine then carries permanently. Delivery rows were readable the same way. | **REAL — evidence truthfulness** | `tests/notifications.test.ts` "refuses to let one user read or acknowledge another user's targeted notification" (asserts `read_by`/`acked_by` stay null) and "hides delivery rows behind the notification's own visibility". | **FIXED** with a single `actionableNotification` helper enforcing visibility AND addressing. |
| **The mobile claim was overstated.** Generation 1 recorded "mobile layout proven at 390×844", but the Playwright check only asserted that certain elements were visible. Measured properly, the AI Ops page **overflowed the viewport by 315px** at 390px wide — the wide institutional tables pushed the whole document sideways. | **REAL — the claim exceeded the evidence** | `e2e/p25-journeys.spec.ts` journey 10 now measures `document.documentElement.scrollWidth - window.innerWidth` on AI Ops, Machines, and Cockpit. Verified by reverting the CSS: the assertion fails with "AI Ops overflows the viewport by 315px". | **FIXED.** Wide tables scroll within themselves below 720px instead of scrolling the document. The claim is now backed by a measurement rather than a visibility check. |
| Route shadowing across all 312 routes (the class that bit once at P22) | — | mechanical audit: every route checked against every earlier same-method route of equal segment count | none found |
| Correction to a review finding of my own: the first draft of the briefing test used a CONFIDENTIAL item. CONFIDENTIAL is **not** one of the four SENSITIVE labels — it is visible firm-wide by the P3 model — so that test proved nothing. It was rewritten against RESTRICTED before the fix was accepted. | — | — | recorded here rather than quietly corrected |

Net effect of generation 2: **six new tests**, four real defects fixed, one overstated claim in this
ledger corrected. Suite after the review: vitest **513/513**, Playwright **45/45**, all validators
PASSED.

---

# D1–D5 — Hallmark + Claude Design overhaul (2026-08-13)

Authorized by `TASK/APPROVED_TASK.md` (2026-08-13). Scope: **visual / interaction design only**,
over the preserved P0–P25 baseline. Companion documents:
`docs/WEST_PEEK_DESIGN_REFERENCE_AUDIT.md` (D1 evidence) and `docs/WEST_PEEK_DESIGN_SYSTEM.md`
(what was actually built).

**What this phase did NOT touch**, verified by diff against a pre-overhaul mirror of the baseline:
no migration, no `src/worker/**` file, no `src/shared/**` file, no route, no API contract, no
`authorize()` path, no privacy clause, no test in `tests/`, and no product capability. The only
non-client changes are two Playwright specs (mobile navigation changed, so the specs that drive it
had to change), `package.json` (one script), `AGENTS.md`, this ledger, and three new documents.

Nothing here claims proof that did not run.

| Phase | Scope | Status | Proof actually run | Unproven / gated |
|---|---|---|---|---|
| D1 | Hallmark evidence + design audit | COMPLETE (evidence phase) | `run_hallmark_audit.sh --self-test` PASSED 5/5, then `--mode full --brand-preserve` against a read-only git mirror with browser capture — pack `~/hallmark_audits/west-peek-os_PRE_DESIGN_BASELINE`, SHA-256 `978dc35e8a7479830dabb76e4f5ead14f280b2c8509b3d14252bb12baa81ba49`, Hallmark authority SHA-256 `5fd8800b92c5df211725642306d0447a3687dd0fbab35b9ce3c9d3346cef4809`. All four reference repos inspected READ-ONLY over `gh api` GETs (`WEST_PEEK_BRAND_SYSTEM.md` — identical SHA-256 `6b8e3c0a…` in three of them — plus `app/globals.css`, `src/styles.css` ×2, `shared/assets/base.css`, `public/brand/wp-mark.svg`, and two brand validators). Baseline measured in a real browser across **29 surfaces × 3 viewports = 87 surface-states**: 6 overflow failures (worst: Activity **+287px** at 834px), **1,212** mobile targets under the 44px floor, nav **1,624px tall in a 900px viewport** and not independently scrollable, **13** accidental font sizes, browser-default `1px auto rgb(153,200,255)` focus ring, `#7fa8c9` blue and `#6b5b95` purple as product colours, canonical `#F05A1A` absent. Deliverable: `docs/WEST_PEEK_DESIGN_REFERENCE_AUDIT.md` | The Hallmark runner's own browser step reached only `/` — West Peek OS is a single-route SPA whose surfaces are client state. Per-surface evidence came from a purpose-built harness driving the real nav. **No production instance was contacted.** The runner prepares evidence; by its own truth boundary it does not perform the review |
| D2 | Design system + shell overhaul | LOCAL VALIDATION PASSED | `src/client/styles.css` rewritten as a token system: brand / shell / surface / semantic colour, an 8-step type scale, a 4pt space scale, 5 radii, a two-level elevation policy, one focus treatment, two durations and one easing. Shell rebuilt: black `#050505` rail beside a warm-paper work surface, **29 destinations grouped into 7 labelled groups with no destination hidden**, rail scrolling independently of the work, sticky surface header carrying group eyebrow + title + identity + status. The approved West Peek mark installed **byte-identical** (`bf90a100c0e71687426763798f0ad6912bdec579dc2ae1d51b095b8bede3d78c`) from `seq23/westpeek-live`, replacing a fabricated placeholder icon; PWA manifest, theme colour, and service-worker shell updated with it. `WEST_PEEK_BRAND_SYSTEM.md` propagated into the repo root byte-identical to the family copy. Measured after: nav **900px in a 900px viewport** (was 1,624), **9** distinct font sizes (was 13), 6 radii all on scale, focus ring `2px solid rgb(240,90,26)` at every tab stop walked | Inter is named first and **not downloaded** — the platform UI face renders where Inter is absent. No webfont, no icon library, and no new dependency was added |
| D3 | Full product-surface redesign | LOCAL VALIDATION PASSED | Applied across `App.tsx` and all 11 page modules, covering every one of the 29 materially reachable surfaces. Button hierarchy: `.btn-primary` (orange) reserved for the strongest action of a decision region, `.btn-strong` (ink) on all **39** form commits, `.btn-danger` on the refusing action, default outline for secondary — orange appears on exactly **3** actions in the whole client (Approve, Capture, Sign in) plus the focus ring, the active-nav rail, and inline drill-through links. `ApprovalCard` rebuilt — Approve / Request revision / Reject with the destructive action fenced off, state as a toned badge via one `approvalStateBadge()`, and **a disabled decision now names the authority it is missing** (`decision-blocked-<id>`) instead of being a dead button. All **6** client tables wrapped in `.table-wrap` (scrolls inside itself, with a scroll-shadow affordance); **24** numeric columns right-aligned with tabular numerals. **69** empty-state slots given an honest treatment (`.state-empty` ×69, `.state-message` ×1 on Approvals), **13** of the highest-traffic ones rewritten to say what the operator can do next. All **24** `*-message` result elements given the `.notice` treatment. Four inline `minWidth` sizings replaced by a responsive token class | Copy on the remaining 56 low-traffic empty slots keeps its baseline wording — they were re-styled, not rewritten |
| D4 | Hostile post-build QA + repair | LOCAL VALIDATION PASSED | Post-build Hallmark pack `~/hallmark_audits/west-peek-os_POST_DESIGN_OVERHAUL` (SHA-256 `b98c491e4035a4ca4dcbbaa99b3aa9999fa044c46278628026016a404ef4a49f`) run in `regression` mode with `--brand-contract` pinned to the brand authority; browser capture succeeded. Two real findings from the hostile pass were fixed and re-measured (below). Final measurement over the same **87 surface-states**: **0** horizontal overflow · **0** text nodes below WCAG AA for their size · exactly **1** target below the 44px touch floor at 390px — the 20×20 `show read` checkbox on Notifications, whose 44px label row is the real target (bounded exception, below); every other one of the 1,212 baseline failures is gone · `2px solid rgb(240,90,26)` focus ring, offset 2px, on every stop. Suite re-run after every change: `tsc --noEmit` green · vitest **513/513** · Playwright **45/45** on a clean local D1 at the D4 gate (**48/48** after the generation-2 review added `e2e/d1-design-states.spec.ts`) · `validate:authority`, `validate:ai-boundary`, `validate:network-boundary`, and the new `validate:brand` all PASSED with their self-tests · `migrate:local` idempotent · parent authority SHA-256 both byte-identical | **No WCAG conformance is claimed.** No assistive technology, screen reader, 400% zoom, or colour-vision simulation was used. What is claimed is exactly what the browser measured. Reduced-motion and ARIA landmark behaviour are implemented but not exercised by an automated check |
| D5 | Packaging / handoff | HOST-OWNED | The Repo Operator execution contract for this run assigns cumulative snapshot ZIP creation and structural verification to the host, after the implementation session. This session did not create the delivery ZIP | ZIP integrity, root check, and SHA-256 are the host's deterministic step |
| D6 | Deployment | NOT AUTHORIZED | — | separate approval boundary |

## Hostile post-build findings and repairs (D4)

| Finding | Severity | Evidence | Disposition |
|---|---|---|---|
| **A clipped institutional table gave no sign it was clipped.** With tables scrolling inside `.table-wrap`, the model catalogue at 834px lost its `PRICING STATE` and `STATUS` columns off the right edge with no affordance — the fix for overflow had created a discoverability defect. | REAL — the repair introduced it | tablet AI Ops capture before/after | **FIXED.** Two tokenised scroll-shadow layers, pinned per side via `background-attachment: local/scroll`, so the shadow appears only on a side that actually has hidden columns. These are the only gradients in the system and they carry information. |
| **An empty slot read as a disabled input.** `.state-empty` was a rounded dashed box on a tinted background; beside real inputs of the same shape (AI Ops provider panels, Machines capability columns) it looked like a form field the operator could not type into. | REAL — ambiguous affordance | tablet AI Ops capture | **FIXED.** `.state-empty` is now a dashed left rule with italic muted text and no box — unmistakably "nothing here", never a control. |
| **Mobile navigation behaviour changed, so two specs had to change.** `p20` and `p25` journey 10 clicked nav buttons directly at 390px; below 900px the rail is now a sheet. | expected consequence, not a defect | — | **UPDATED**, not weakened: `e2e/support/nav.ts` opens the sheet, and `p20` now additionally asserts `aria-expanded` toggles, that the toggle and a nav row each clear 44px by measured bounding box, and that the sheet closes behind a choice. Net: the mobile spec proves more than it did before. |
| Every other Playwright selector and every `data-testid` | — | 45/45 pass with no other spec touched | no action — grouping the nav changed no label and hid no destination |

## Bounded exception recorded rather than reported as a pass

Checkbox and radio inputs render 20×20, below the WCAG 2.5.8 24px floor. Their `<label>` is the real
target and is 44px tall on touch, which is the standard's "enclosed target" exception. Recorded here
and in `docs/WEST_PEEK_DESIGN_SYSTEM.md` §9 rather than counted as a clean pass.

## Deliberate deviation from a Hallmark gate

Hallmark slop-test gate 62 requires `html, body { overflow-x: clip }`. **Declined.** It suppresses
horizontal scroll rather than fixing it, and it would make this repo's own overflow assertion
(`e2e/p25-journeys.spec.ts` journey 10) pass trivially by construction. The six real overflow causes
were fixed instead and the measurement kept meaningful. Recorded rather than silently skipped.

## Design-routing receipt

- **Hallmark: RAN.** The user's installed runner (`~/repo-tools/active/run_hallmark_audit.sh`
  v1.3.0), self-tested first, then twice — pre-baseline and post-build — against read-only git
  mirrors, never against the working tree. The bundled authority (SKILL.md, `contract.md`,
  `anti-patterns.md`, the 69-gate `slop-test.md`, `color.md`, `typography.md`,
  `layout-and-space.md`, `interaction-and-states.md`, `responsive.md`,
  `genres/modern-minimal.md`, `verbs/audit.md`) was read and applied. The runner states plainly
  that it prepares evidence and does not perform the review; the review was performed against that
  authority and its findings are above.
- **Claude Design / design routing: REACHABLE, NO PROJECT.** `DesignSync.list_projects` authenticated
  and returned **zero** design-system projects, so there was no remote system to sync against and no
  component library was pushed. Creating a cloud design-system project would publish repo material
  to an external service and was not authorized by this task. The design-router discipline (use the
  existing code and design system as source material) was followed against the West Peek family
  repos. This is **not** a claim that a Claude Design generation step ran.
- **Design source hierarchy actually used**, in the task's own order: the user-locked brand direction
  → the family's own `WEST_PEEK_BRAND_SYSTEM.md` and the two operating apps' stylesheets → the OS's
  existing information architecture → measured accessibility and overflow → Hallmark evidence →
  design judgement.

## Reference-repo mutation

**None.** Every read was a `gh api` GET against `repos/…/contents` or `…/git/trees`. No commit,
branch, PR, issue, tag, release, workflow, or setting was created or changed in
`seq23/westpeek-live`, `seq23/west-peek-network-os`, `seq23/west-peek-community`, or
`seq23/west-peek-pitch-lab`.

## Design measurement — baseline vs after

Both columns are browser measurements over the same 29 surfaces × 3 viewports (1440×900 / 834×1112 /
390×844), authenticated as a Managing Partner against local `wrangler dev`.

| Measure | Baseline | After | 
|---|---|---|
| Surfaces with horizontal document overflow | 6 (worst +287px) | **0** |
| Text nodes below WCAG AA for their size | 0 | **0** |
| Interactive targets below 44px at 390px | 1,212 | **1** — the 20×20 checkbox inside its 44px label row |
| Interactive targets below the WCAG 2.5.8 24px floor at 390px | not measured | **1** — the same checkbox |
| Focus treatment | browser default `1px auto rgb(153,200,255)` | `2px solid rgb(240,90,26)`, offset 2px, on every tab stop walked |
| Primary nav height in a 900px viewport | 1,624px, document-scrolled | 900px, rail-scrolled |
| Nav groups | 1 flat list of 29 | 7 labelled groups, 29 destinations, none hidden |
| Distinct computed font sizes on a surface | 13 | 9 |
| Colour declared outside a token block | every value | **0** (enforced by `validate:brand`) |
| Canonical West Peek orange `#F05A1A` present | no | yes, and it is the only accent |
| Console errors at any viewport | 0 | 0 |

## Independent final review — generation 2 (2026-08-13)

The host handed the run to a fresh `claude:final_review` worker. That review deliberately probed
where the implementer's own verification could not have looked: the entire D1–D4 browser
verification ran **as a Managing Partner**, at rest, on the data that happened to be in the local
D1. So this pass drove a **low-authority identity**, drove **hover and disabled states** (which a
screenshot never renders), **injected** the long labels, long IDs, and long financial values the
task names, emulated `prefers-reduced-motion`, and cross-checked every CSS class and token against
what the markup actually references.

Evidence: `~/hallmark_audits/west-peek-os_GEN2_FINAL_REVIEW` (SHA-256
`24bab02e14b202549eb3d3d6e158539195b19b821f75dc2d83973f9d13add0cc`), plus a live DOM walk of all
29 surfaces × 2 identities and a driven-state contrast probe.

| Finding | Severity | Evidence | Disposition |
|---|---|---|---|
| **A governed surface rendered nothing at all.** Read as an `INVESTMENT_TEAM` member with no governance updates issued, `Governance` produced **zero characters** in the surface body: the issue form is MP-only, the update list was empty, and there was no empty state. Playwright reports the section as `hidden`, because it had no content to give it a box. The operator could not tell "you may not do this" from "this is broken" — the exact failure the design system's own principle 5 exists to prevent. Invisible to the first pass, which only ever read as a Managing Partner. | **REAL — ambiguous blank on a governance surface** | `e2e/d1-design-states.spec.ts` "no surface renders an ambiguous blank for a reader who holds no Managing Partner role". Verified by reverting the repair: the test fails on `governance-page` being hidden. | **FIXED.** `governance-reserved` states that issuing is MP-reserved and names the roles the reader does hold; `governance-empty` says what puts an update in the list. Both are asserted, plus a floor on the surface's own rendered character count. |
| **`Reporting` had the same shape.** `period-list` rendered zero rows with nothing to explain them. | REAL — same class | same spec: `period-list-empty` | **FIXED** with an empty state that names what opening a period does. |
| **The one orange action failed WCAG AA on hover.** Resting, `--wp-orange-ink` on `--wp-orange` measures 5.83:1. On hover the fill darkened to `#d24a0f` and the label dropped to **4.46:1** — under the 4.5 floor for a 13px/600 label. A static capture never renders hover, so the D4 sweep could not have caught it. | **REAL — accessibility** | `e2e/d1-design-states.spec.ts` "the one orange action, the focus ring, and the hover state all clear WCAG AA". Verified by reverting the token: the test fails with `hovered primary action`. | **FIXED.** `--wp-orange-strong` is now `#d64e10`, measured **4.67:1**. |
| **Hovering a link made it lighter, not darker.** The same token was doing double duty as link-hover *text*, where `#d24a0f` on white measures 4.44:1 — worse than the resting `--wp-orange-deep` at 5.71:1. Hover was actively degrading legibility. | **REAL — accessibility** | driven-state probe: resting 5.71:1 → hover now 7.19:1 | **FIXED.** Split into a second token, `--wp-orange-deeper` `#8f3309`, used only for hovered orange text. |
| **The header's own links had no hover state at all.** `.shell-header button.link-button` (0,2,1) out-specified the bare `.link-button:hover` (0,2,0), so `Sign out`, the unread count, and `Send now` never responded to the pointer — a silent hole in the eight-state rule. | REAL — interaction | driven-state probe: `changedOnHover: false` before, `true` after | **FIXED** by repeating the header selector in the hover rule, with the specificity reason written next to it. |
| **The design-system document described components that did not exist.** Twelve class rules (`.badge-accent`, `.field-help`, `.field-help-error`, `.notice-ok`, `.notice-bad`, `.state-message-error`, `.measure`, `.mono`, `.nav-count`, `.panel-actions`, `.sr-only`, and a `.btn` base alias) and two policy tokens (`--shadow-overlay`, `--dur-base`) were defined, documented, and referenced by **nothing** in the markup. The task's §9 requires the document to describe what was actually built. | **REAL — the document exceeded the implementation** | mechanical cross-check of every class selector and token against every `className` in the client | **RESOLVED both ways, deliberately.** `.btn-ghost` was wired into the four Refresh controls and `.mono` onto the Activity identifier columns, because both genuinely improve the surface. The other ten classes and both tokens were **deleted**, and the document rewritten to say what ships: elevation is one level (flat) because the product has no overlays; motion is one duration; there is no per-field helper slot; and notice tones are `.notice` + `.notice-gate` only — success/failure tints were removed rather than driven by sniffing message text, which would mis-tone silently. |
| Long labels, long IDs, long financial values (task §6) | — | injected a 94-character entity name, a 76-character composite ID, and `$1,284,559,203,441.7788` into a live table at 1440px and 390px | none — document overflow stayed **0** at both widths; the values wrap inside their cells, which is what `overflow-wrap: anywhere` on cell content is for |
| `prefers-reduced-motion: reduce` | — | emulated in the browser: computed `transition-duration` and `animation-duration` both `1e-05s` | none — previously implemented-but-unverified, now measured |
| Focus ring visibility, not just presence | — | probed whether the ring is clipped by the rail's scroll container or covered by the sticky header: `insideScroller: true`, `inViewport: true`, `coveredByStickyHeader: false`, and focusing an out-of-view rail item scrolls it in (`scrollTop` 0 → 444) | none found |
| Correction to a finding of my own: a first throwaway probe reported link contrast as 3.68:1. That was a bug in the probe — it parsed `rgba(0, 0, 0, 0)` as opaque black instead of walking to the painted ancestor. Re-measured properly: 5.71:1 resting. Recorded here rather than quietly dropped. | — | — | no product defect |
| `.ACTIVE` / `.BREACH` reported as undefined classes by the first cross-check | — | they are the comparison literals inside `className={x === "ACTIVE" ? … }` ternaries, not emitted class names | false positive of my own extractor; no action |

Net effect of generation 2: **five real defects fixed** (one ambiguous blank on a governance
surface, one on Reporting, two hover-contrast failures, one missing hover state), **twelve dead
class rules and two dead tokens removed**, **three new browser tests** that each fail when their fix
is reverted, and the design-system document corrected in seven places where it described more than
the code delivered.

### Suite after the review

| Check | Result |
|---|---|
| `tsc --noEmit` | green |
| `npx vitest run` | **513/513** across 26 suites — unchanged, as expected: no worker, shared, migration, or test-suite file was touched |
| `npx playwright test` | **48/48** across 22 specs on a clean local D1 (was 45/45 across 21; `e2e/d1-design-states.spec.ts` adds 3) |
| `validate:authority` / `:ai-boundary` / `:network-boundary` / `:brand` | all PASSED with self-tests (4/4, 5/5, 6/6, 9/9) |
| `wrangler d1 migrations apply --local` | idempotent — "No migrations to apply!" |
| Full-surface design sweep, 29 × 3 = 87 states | 0 horizontal overflow · 0 text nodes below AA · 1 target below 44px (the documented 20×20 checkbox) · `2px solid rgb(240, 90, 26)` focus ring at every viewport |
| Ambiguous-blank sweep, 29 surfaces × 2 identities | 0 blank surfaces · 0 unexplained empty lists (was 1 blank surface and 3 unexplained lists) |
| Parent authority SHA-256 | both byte-identical |

## Finalization-gate repair — the e2e entrypoint was not re-runnable (2026-08-13)

The host finalization gate independently re-ran the repo's own documented validation commands and
`npm run e2e` returned **1**, having passed minutes earlier in this session. That is not flakiness
and it was not a host bookkeeping problem: it is a real, long-standing defect in this repo's
validation surface, surfaced only because something finally ran the command twice.

**Cause.** Every e2e spec drives the same local D1 and several journeys assume a firm that starts
empty. `AGENTS.md` recorded that precondition as a *manual* instruction — "`rm -rf .wrangler` before
a full run" — so `npm run e2e` was only correct when a human happened to remember. Reproduced
deterministically here: with the local D1 left as a previous green run leaves it, the suite fails
**6 of 48** specs (`p4-ai`, `p9-network`, `p25-journeys` journey 3, and three others) with assertion
errors that read like product defects and are not. `reuseExistingServer: !process.env.CI` made it
worse: a second runner could silently attach to a server started against a different build.

**Repair.** The precondition is now part of the command instead of part of the folklore.

- `scripts/e2e/prepare-local.mjs` — stops any stale listener on the e2e port (scoped to that port
  via `lsof -sTCP:LISTEN`, nothing else is touched), then deletes `.wrangler/`, `test-results/`, and
  `playwright-report/`. It prints what it did.
- `package.json` — `"e2e": "node scripts/e2e/prepare-local.mjs && playwright test"`.
- `playwright.config.ts` — `reuseExistingServer: false`, so the suite can never attach to a server
  holding the database it just reset or serving an older build; port is `WPOS_E2E_PORT` (8787).

**This weakens no test.** It enforces the precondition the specs already documented; the suite still
has to pass against a firm that starts empty. What changed is that failing to meet that precondition
is now impossible rather than silent.

**A second defect, found in the repair itself before shipping it.** The first version of the
prepare script killed the PID holding the port and stopped there. Tested against a deliberately
planted stale `wrangler dev`, it did not converge: `wrangler dev` **supervises** its `workerd`
child and respawns it the instant it dies, so the port stayed LISTENing — bound but answering
nothing — and Playwright hung against its own 240s webServer timeout with no useful error. Five
kill passes could not win a race against a supervisor. The fix is to stop the supervisor first,
matched precisely to this repo's own `node_modules` so a wrangler serving a different project is
never touched, and then to **fail loudly** with an actionable message (and `WPOS_E2E_PORT`) if the
port still cannot be freed, rather than hand Playwright a server that can never bind.

**Proof — all three scenarios measured after the repair.**

| Scenario | Before repair | After repair |
|---|---|---|
| `npm run e2e` on a clean local D1 | 48/48, rc=0 | 48/48, rc=0 |
| `npm run e2e` immediately again, no cleanup — *the sequence that failed the gate* | **6 failed, rc=1** | **48/48, rc=0** |
| `npm run e2e` with a stale `wrangler dev` holding the port | Playwright silently reused it, against a possibly older build | 6 stale processes stopped, fresh server, **48/48, rc=0** |


# Production deployment profile admitted through Repo Operator (2026-08-14)

Approved task: `TASK/APPROVED_TASK.md` — *WEST PEEK OS — PRODUCTION ARTIFACT ADMISSION*, run
`20260814T230132Z-42955` (CONTINUATION over the preserved P0–P25 + D1–D5 baseline). Scope was
deployment configuration and its documentation only. **Nothing was deployed.**

## What was wrong

The artifact declared only a top-level deployment profile carrying `vars.WP_OS_ENV = "local"`.
`src/worker/auth.ts` selects the `x-wpos-dev-user` dev identity header exactly when
`WP_OS_ENV === "local"`, so deploying the only deployable profile would have run the production
Worker on the dev-header identity path. The same profile also carried the ADR-007 placeholder D1
`database_id` and KV `id`, so it could not address the real provisioned resources either.
`wrangler deploy --dry-run` did not catch this: dry-run validates configuration and bundling, not
environment safety, and it succeeded against the unsafe profile.

## What changed — 3 files, no application code

| File | Change |
|---|---|
| `wrangler.toml` | Added an explicit `[env.production]` profile — `name`, `assets`, D1, R2, KV, `vars`, `observability` — plus header comments stating which profile is which. Top-level (local) profile values are unchanged. |
| `docs/ENVIRONMENTS.md` | preview/production section amended: it no longer claims the config ships only placeholders and no production profile. Still states production is UNPROVEN and undeployed; `preview` still has no profile. |
| `ARCHITECTURAL_DECISIONS.md` | ADR-007 amended: placeholders remain the **local** profile's contract; real non-secret ids live only under `[env.production]`. |

`src/`, `migrations/`, and `tests/` are byte-identical to the pre-change baseline; `src/worker/auth.ts`
verified unchanged by SHA-256. No secret, key, token, `.dev.vars`, or credential value was added — the
D1/KV/R2 identifiers are non-secret resource ids. No Cloudflare resource was created, and Cloudflare
Access was not touched.

Named environments do **not** inherit bindings or vars from the top level, so `assets`,
`d1_databases`, `r2_buckets`, `kv_namespaces`, `vars`, and `name` are each restated under
`[env.production]` deliberately. `main`, `compatibility_date`, and the ADR-017 `[triggers]` cron *are*
inherited. `name` is restated because a named environment would otherwise target
`west-peek-os-production` rather than the existing `west-peek-os` Worker.

## Proof actually run (2026-08-14, this machine — node v26.4.0 / npm 11.17.0)

| Check | Command | Result |
|---|---|---|
| Frozen install | `npm ci --ignore-scripts --no-audit --no-fund` | rc=0, 144 packages |
| Typecheck | `npm run typecheck` | rc=0 |
| Unit/integration | `npm run test` | rc=0 — **513/513** across 26 suites |
| Build | `rm -rf dist && npm run build` | rc=0 |
| Build output | `dist/client` | present, `index.html` + assets |
| Authority scan | `npm run validate:authority` | PASS + self-test 4/4 + seeds fresh |
| AI boundary | `npm run validate:ai-boundary` | PASS + self-test 5/5 + seeds fresh |
| Network boundary | `npm run validate:network-boundary` | PASS + self-test 6/6 |
| Brand | `npm run validate:brand` | PASS + self-test 9/9 |
| E2E | `npm run e2e` | rc=0 — **48/48** on a clean local D1 |
| Production profile | `wrangler deploy --dry-run --env production` (wrangler 4.120.1) | rc=0, **not deployed**. Bindings reported: `WP_OS_KV (bf0750e8…)`, `WP_OS_DB (west-peek-os-db)`, `WP_OS_DOCUMENTS (west-peek-os-documents)`, `ASSETS`, `WP_OS_ENV ("production")` |
| Local profile preserved | `wrangler deploy --dry-run` (top level) | rc=0, reports `WP_OS_ENV ("local")` and the placeholder KV id — unchanged |
| Secret scan | credential-shaped scan over the tree | only the pre-existing credential-scrub test fixtures (`tests/ai.test.ts`, `tests/workforce.test.ts`, `e2e/p4-ai.spec.ts`) |

The two dry-runs together are the security proof: production resolves `WP_OS_ENV` to `"production"`,
so the dev-header branch in `auth.ts` is unreachable under `--env production`, and the local profile
is still local, so local validation never addresses a production resource.

## Independent re-validation — worker generation 2, same run `20260814T230132Z-42955`

A second implementation worker in the same run inspected the tree before mutating, found the three
approved changes above already applied, added no further change to `wrangler.toml`,
`docs/ENVIRONMENTS.md`, or `ARCHITECTURAL_DECISIONS.md`, and re-ran the whole proof set itself rather
than inheriting the table above. Same machine, node v26.4.0 / npm 11.17.0, wrangler 4.120.1.

| Check | Result (re-run) |
|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund` | rc=0, 144 packages |
| `npm run typecheck` | rc=0 |
| `npm run test` | rc=0 — **513/513**, 26 suites |
| `rm -rf dist && npm run build` | rc=0; `dist/client` regenerated (`index.html`, `assets/`, `sw.js`, manifest, marks) |
| `npm run validate:authority` | PASS + self-test 4/4 + seeds fresh |
| `npm run validate:ai-boundary` | PASS + self-test 5/5 + seeds fresh |
| `npm run validate:network-boundary` | PASS + self-test 6/6 |
| `npm run validate:brand` | PASS + self-test 9/9 |
| `npm run e2e` | rc=0 — **48/48** |
| `wrangler deploy --dry-run --env production` | rc=0, **not deployed** — `WP_OS_ENV ("production")`, `WP_OS_KV (bf0750e8…)`, `WP_OS_DB (west-peek-os-db)`, `WP_OS_DOCUMENTS (west-peek-os-documents)`, `ASSETS` |
| `wrangler deploy --dry-run` (top level) | rc=0 — still `WP_OS_ENV ("local")` and the placeholder KV id |
| Credential-shaped scan | only the same three pre-existing scrub fixtures; no `.dev.vars`, `.env`, `*.key`, or `*.pem` anywhere in the tree |
| Scope containment | only `wrangler.toml`, `docs/ENVIRONMENTS.md`, `ARCHITECTURAL_DECISIONS.md` carry the 2026-08-14 change timestamp; every file under `src/` predates it and is untouched by this task |

Nothing was deployed, migrated, or configured remotely during this re-validation either.

## Still UNPROVEN — do not read this section as deployment readiness

- **Nothing has been deployed.** Declaring a profile is configuration, not a deploy.
- Cloudflare Access policy behaviour is operator configuration and is not exercised here; the
  production identity path depends on Access injecting `Cf-Access-Authenticated-User-Email`.
- Remote D1 migration apply against production — never run.
- The deployed Worker name binding is config-proven (`name = "west-peek-os"`), not deploy-proven.
- `preview` still has no profile and remains entirely unconfigured.
- Every other external/provider gate in the table above this section is unchanged and still UNPROVEN.

Deployment remains a separate, already-authorized human-gated Phase D action.

## P5 — mandatory final senior review, worker generation 3 (2026-08-14)

Run `20260814T230132Z-42955`, role `claude:final_review`. This pass did not inherit either table
above: it re-ran the whole proof set and, more usefully, checked the thing neither earlier generation
could check about itself — whether the tree actually *reproduces* the externally validated
production-ready snapshot the approved task names as the source of scope, rather than merely
resembling it.

**Reproduction proof (the decisive check).** `ARTIFACTS/WEST_PEEK_OS_PRODUCTION_READY_v1.zip`
(SHA-256 `1195e25c…`) was extracted and diffed recursively against this tree:

| Comparison | Result |
|---|---|
| `wrangler.toml` vs the approved reference | **byte-identical** |
| `docs/ENVIRONMENTS.md`, `ARCHITECTURAL_DECISIONS.md` vs the reference | **byte-identical** |
| Whole `west-peek-os/` tree (excl. `node_modules`, `dist`, `.wrangler`, `test-results`) | identical except `IMPLEMENTATION_LEDGER.md` (this run's own record) and `.env.example` |
| `.env.example` | pre-existing unrelated user work dated 2026-08-12, *before* this task; names-only, every value empty. Deliberately **not** reverted — the task forbids reverting unrelated user work |

So the approved scope is reproduced exactly, not approximated. No repair was required and none was
invented; no file was changed by this pass except this ledger section.

**A claim checked rather than trusted.** Both earlier sections assert that `[triggers]` is inherited
into `[env.production]`, which matters because ADR-017 makes the cron the only scheduling primitive —
if it were not inherited, production would silently never run a scheduled job, and neither dry-run
prints trigger information, so the claim was unfalsified. Verified against the resolved config
parser in the pinned wrangler 4.120.1 itself (`triggers: inheritable(diagnostics, topLevelEnv,
rawEnv, "triggers", …)`): `triggers` is an inheritable key, so the named environment takes the
top-level `*/15 * * * *` cron. The claim holds.

**Resource-id provenance.** The D1 and KV identifiers under `[env.production]` are not asserted from
nowhere: they match the ids recorded in this project's own prior deployment receipts
(`DEPLOYMENTS/20260814T121242Z`, `…T130050Z`) and in `ARTIFACTS/WEST_PEEK_OS_PRODUCTION_READY_v1_RECEIPT.json`.
They are real, non-secret, already-provisioned resources — not fabricated placeholders dressed up as
real ones.

**Proof re-run independently by this pass** (same machine, wrangler 4.120.1):

| Check | Command | Result |
|---|---|---|
| Frozen install | `npm ci --ignore-scripts --no-audit --no-fund` | rc=0, 144 packages |
| Typecheck | `npm run typecheck` | rc=0 |
| Unit/integration | `npm run test` | rc=0 — **513/513**, 26 suites |
| Clean build | `npm run build` after `rm -rf dist` | rc=0 |
| Build output | `dist/client` | present — `index.html`, `assets/`, `sw.js`, manifest, marks |
| Authority / AI / network / brand validators | the four `validate:*` scripts | all rc=0, PASS + self-tests 4/4, 5/5, 6/6, 9/9 |
| E2E | `npm run e2e` | rc=0 — **48/48** |
| Production profile resolves as production | `wrangler deploy --dry-run --env production` | rc=0, **not deployed** — `WP_OS_ENV ("production")`, `WP_OS_KV (bf0750e8…)`, `WP_OS_DB (west-peek-os-db)`, `WP_OS_DOCUMENTS`, `ASSETS` |
| Local profile preserved | `wrangler deploy --dry-run` | rc=0 — still `WP_OS_ENV ("local")` and the placeholder KV id |
| No secrets packaged | credential-shaped scan over the tree | one hit: `tests/workforce.test.ts:323`, the pre-existing fixture that asserts secrets get **scrubbed**. No `.dev.vars`, `.env`, `*.key`, `*.pem` anywhere |
| Scope containment | mtime sweep for 2026-08-14 changes | only `wrangler.toml`, `docs/ENVIRONMENTS.md`, `ARCHITECTURAL_DECISIONS.md`, and this ledger. All of `src/`, `migrations/`, `tests/` untouched |

**Accepted residual, recorded so it is not mistaken for an oversight.** The top-level profile is
still deployable, and a bare `wrangler deploy` (no `--env production`) would ship `WP_OS_ENV = "local"`.
No guard was added, deliberately: the approved task requires the top-level profile be *preserved
unchanged* and confines this run to three files, and the externally validated reference artifact
makes the same choice. The risk is bounded by documentation (`wrangler.toml` header, ADR-007,
docs/ENVIRONMENTS.md all state the top-level profile must never be deployed) and by the fact that
deployment is a separate human-gated Phase D action. If a mechanical guard is wanted, it is new
scope and needs its own approval.

Nothing was deployed, migrated, or configured remotely by this pass. Every UNPROVEN item listed in
the section above remains UNPROVEN and unchanged.

---

## Re-admission pass, worker generation 1 (2026-08-16)

Run `20260816T223337Z-508`, role `claude:opening`, CONTINUATION over the same preserved baseline,
against the same approved task (`TASK/APPROVED_TASK.md`, SHA-256 `e323bce3…`). This pass exists
because a *new* Repo Operator snapshot is being produced: the proof tables above belong to run
`20260814T230132Z-42955`, and a snapshot may not be packaged on validation that another run
performed. Nothing here is inherited — every row below was executed in this session.

**P1–P2 — state established, contract compared.** The tree is unchanged since the 2026-08-14 final
review: a full mtime sweep of `west-peek-os/` (excluding `node_modules/`, `dist/`, `.wrangler/`,
`test-results/`) returned **no file modified after 2026-08-14 23:30**, so this run began on exactly
the tree the previous pass proved byte-identical to `ARTIFACTS/WEST_PEEK_OS_PRODUCTION_READY_v1.zip`.
Each clause of approved scope §2 was re-read against the file rather than against the ledger:

| Approved requirement | State found |
|---|---|
| Top-level/local Wrangler profile preserved unchanged | present, `WP_OS_ENV = "local"`, ADR-007 placeholder D1/KV ids intact |
| Explicit `[env.production]` for the existing `west-peek-os` Worker | present, `name = "west-peek-os"` restated so the named env does not become `west-peek-os-production` |
| `WP_OS_ENV = "production"` | present under `[env.production.vars]` |
| D1 binding/name/id | `WP_OS_DB` / `west-peek-os-db` / `1d7c242b-…` |
| KV namespace | `WP_OS_KV` / `bf0750e8…` |
| R2 bucket | `WP_OS_DOCUMENTS` / `west-peek-os-documents` |
| `./dist/client`, `ASSETS`, SPA behavior | all three present under `[env.production.assets]` |
| Observability enabled | `[env.production.observability] enabled = true` |
| Production/ADR documentation | `docs/ENVIRONMENTS.md` preview/production section and ADR-007 amendment both present and accurate |

**P3 — no repair required, and none was invented.** Every approved clause was already satisfied, so
this pass changed no file except this ledger section. Producing a change merely to have produced one
would have moved the artifact away from the externally validated reference it is required to
reproduce.

**Proof actually run (2026-08-16, this machine — node v26.4.0 / npm 11.17.0 / wrangler 4.120.1):**

| Check | Command | Result |
|---|---|---|
| Frozen install | `npm ci --ignore-scripts --no-audit --no-fund` | rc=0, 144 packages |
| Typecheck | `npm run typecheck` | rc=0 |
| Unit/integration | `npm run test` | rc=0 — **513/513**, 26 suites |
| Clean build | `rm -rf dist && npm run build` | rc=0 |
| Build output | `dist/client` | present — `index.html`, `assets/`, `sw.js`, `manifest.webmanifest`, `icon.svg`, `wp-mark.svg` |
| Authority scan | `npm run validate:authority` | PASS + self-test 4/4 + seeds fresh (45 machines / 15 domains / 53 reserved actions / 204 action types) |
| AI boundary | `npm run validate:ai-boundary` | PASS + self-test 5/5 + seeds fresh (31 employees, all INACTIVE, no MP names) |
| Network boundary | `npm run validate:network-boundary` | PASS + self-test 6/6 |
| Brand | `npm run validate:brand` | PASS + self-test 9/9 |
| E2E | `npm run e2e` | rc=0 — **48/48** on a clean local D1 |
| Migration idempotency | `npm run migrate:local` after the e2e reset applied 0001–0023 | "No migrations to apply!" |
| Production profile resolves as production | `wrangler deploy --dry-run --env production` | rc=0, **not deployed** — `WP_OS_ENV ("production")`, `WP_OS_KV (bf0750e8…)`, `WP_OS_DB (west-peek-os-db)`, `WP_OS_DOCUMENTS (west-peek-os-documents)`, `ASSETS` |
| Local profile preserved | `wrangler deploy --dry-run` (top level) | rc=0 — still `WP_OS_ENV ("local")` and the placeholder KV id `0000…0000` |
| No application/auth source changed | mtime sweep over `src/`, `migrations/`, `tests/`, `e2e/`, `scripts/` | nothing modified since before 2026-08-14; no file anywhere in the tree modified after this run started except this ledger |
| Parent authority preserved | SHA-256 re-hash | `WEST_PEEK_OS_v3_2_14_CANONICAL_MASTER_PLAN.md` = `01d94450…`, `…ODYSSEUS_AUDIT_AND_IMPLEMENTATION_PLAN_v1_11.md` = `a7681dc0…` — both match the P0 baseline in `ARTIFACT_MANIFEST.md` |
| Brand authority preserved | SHA-256 re-hash | `WEST_PEEK_BRAND_SYSTEM.md` = `6b8e3c0a…`, `src/client/public/wp-mark.svg` = `bf90a100…` — both match |
| No secrets packaged | credential-shaped file + content scan | no `.dev.vars`, `.env`, `*.key`, `*.pem`, `*.p12`, `id_rsa*` anywhere; one content hit, `tests/workforce.test.ts:323`, the pre-existing fixture that asserts secrets get **scrubbed**; `.env.example` is names-only with every value empty |

**P5 — the load-bearing inheritance claim re-checked against the freshly installed wrangler.** The
sections above depend on `[triggers]` being inherited into `[env.production]`; if it were not, the
ADR-017 cron — the only scheduling primitive this system has — would silently never fire in
production, and no dry-run prints trigger information, so the claim cannot falsify itself. Re-checked
against the config parser inside the wrangler that *this run's* `npm ci` installed
(`node_modules/wrangler/wrangler-dist/cli.js:35789`): `triggers: inheritable(`. The named environment
therefore takes the top-level `*/15 * * * *` cron. The claim holds on the pinned toolchain as
installed today, not merely as recorded earlier.

**One environmental failure, diagnosed rather than papered over.** The first `npm run e2e` of this
session failed 42 of 48 specs with `browserType.launch: Executable doesn't exist … chrome-headless-shell`.
The cause is the frozen install itself: `npm ci` reinstalls `@playwright/test`, and the machine's
browser cache (`~/Library/Caches/ms-playwright/`) held no build for the reinstalled version. It is a
toolchain-provisioning gap, not a product defect — no application code, config, or test was touched
to resolve it. `npx playwright install chromium` fetched the matching build and the suite then passed
**48/48**. Recorded because the failure is real and will recur on any machine that runs `npm ci`
without a matching browser cache.

**Accepted residual, restated deliberately.** The top-level profile remains deployable and a bare
`wrangler deploy` would still ship `WP_OS_ENV = "local"`. The reasoning in the section above stands
unchanged and this pass did not quietly revise it: adding a mechanical guard is new scope requiring
its own approval, and inventing it here would break the reproduction the approved task depends on.

Nothing was deployed, migrated, or configured remotely by this pass. No Cloudflare resource was
created or mutated; the only wrangler commands run were `--dry-run` and `--local`. Every UNPROVEN
item in every table above remains UNPROVEN and unchanged, including remote deployment, Cloudflare
Access behavior, and remote migration apply.

---

## Re-admission pass, worker generation 2 (2026-08-16)

Run `20260816T232103Z-91568`, role `claude:opening/primary implementation`, CONTINUATION over the
same preserved baseline and the same approved task (`TASK/APPROVED_TASK.md`, SHA-256 `e323bce3…`).

**Why this section exists rather than an inheritance of the one above it.** The generation-1 pass in
run `20260816T223337Z-508` completed P1–P5 and recorded them, but that run then ended
`FAILED_TERMINAL` — its implementation-role session could not be resumed (`No conversation found
with session ID: d0cbbe1c-…`, engine rc=1) — and it never reached host packaging. Its proof
therefore belongs to a run that produced no snapshot. The rule that section itself invoked applies
to it in turn: a snapshot may not be packaged on validation another run performed. Every row below
was executed in *this* session. Nothing is inherited.

**P1 — state established.** The mtime sweep over `west-peek-os/` (excluding `node_modules/`,
`dist/`, `.wrangler/`, `test-results/`) for anything newer than 2026-08-14 23:30 returned exactly
one path: `IMPLEMENTATION_LEDGER.md`. Every other file is the tree the 2026-08-14 final review
proved byte-identical to the approved reference artifact. Nothing was lost when the previous run
died.

**P2 — reproduction re-proven against the reference, not against the ledger.**
`ARTIFACTS/WEST_PEEK_OS_PRODUCTION_READY_v1.zip` re-hashed to SHA-256
`1195e25c03e887ff21ad290770600a3ae37cc54f56b9ee82b06a831e2e7b002d`, was extracted fresh and diffed
recursively against this tree:

| Comparison | Result |
|---|---|
| `wrangler.toml` | **byte-identical** to the approved reference |
| `docs/ENVIRONMENTS.md` | **byte-identical** |
| `ARCHITECTURAL_DECISIONS.md` | **byte-identical** |
| Whole `west-peek-os/` tree (excl. `node_modules`, `dist`, `.wrangler`, `test-results`, `.DS_Store`) | identical except `IMPLEMENTATION_LEDGER.md` (this run's own record) and `.env.example` |

`.env.example` is present here and absent from the reference. It is dated 2026-08-12 22:47 —
pre-existing unrelated user work from *before* this task — and was deliberately not reverted, as the
approved task forbids reverting unrelated user work. Re-read in full this pass rather than assumed
from the earlier ledger entry: it is a names-only contract, every credential name has an empty
value, and its one assigned value is `WP_OS_ENV=local`, a runtime-mode name, not a credential. The
earlier ledger's phrasing "every value empty" was very slightly loose; the accurate statement is
"no credential name carries a value."

**P3 — no repair required, and none was invented.** Each clause of approved scope §2 was checked
against `wrangler.toml` directly: top-level profile preserved with `WP_OS_ENV = "local"` and the
ADR-007 placeholder ids intact; `[env.production]` present with `name = "west-peek-os"` restated so
the named environment does not become `west-peek-os-production`; `WP_OS_ENV = "production"`;
`WP_OS_DB` / `west-peek-os-db` / `1d7c242b-…`; `WP_OS_KV` / `bf0750e8…`; `WP_OS_DOCUMENTS` /
`west-peek-os-documents`; `./dist/client` + `ASSETS` + `single-page-application`;
`[env.production.observability] enabled = true`. All already satisfied, so this pass changed no file
except this ledger section. Manufacturing a change would move the artifact away from the reference
it is required to reproduce.

**P4 — proof actually run in this session** (node v26.4.0 / npm 11.17.0 / wrangler 4.120.1):

| Check | Command | Result |
|---|---|---|
| Frozen install | `npm ci --ignore-scripts --no-audit --no-fund` | rc=0, 144 packages |
| Typecheck | `npm run typecheck` | rc=0 |
| Unit/integration | `npm run test` | rc=0 — **513/513**, 26 suites |
| Clean build | `rm -rf dist && npm run build` | rc=0, 44 modules |
| Build output | `dist/client` | present — `index.html`, `assets/`, `sw.js`, `manifest.webmanifest`, `icon.svg`, `wp-mark.svg` |
| Authority scan | `npm run validate:authority` | PASS + self-test 4/4 + seeds fresh (45 machines / 15 domains / 53 reserved actions / 204 action types) |
| AI boundary | `npm run validate:ai-boundary` | PASS + self-test 5/5 + seeds fresh (31 employees, all INACTIVE, no MP names) |
| Network boundary | `npm run validate:network-boundary` | PASS + self-test 6/6 |
| Brand | `npm run validate:brand` | PASS + self-test 9/9 |
| E2E | `npm run e2e` | rc=0 — **48/48** |
| Migration idempotency | `npm run migrate:local` after the e2e reset | "No migrations to apply!" |
| Production profile resolves as production | `wrangler deploy --dry-run --env production` | rc=0, **not deployed** — `WP_OS_ENV ("production")`, `WP_OS_KV (bf0750e8…)`, `WP_OS_DB (west-peek-os-db)`, `WP_OS_DOCUMENTS (west-peek-os-documents)`, `ASSETS` |
| Local profile preserved | `wrangler deploy --dry-run` (top level) | rc=0 — still `WP_OS_ENV ("local")` and the placeholder KV id `0000…0000` |
| Parent authority preserved | SHA-256 re-hash | `…CANONICAL_MASTER_PLAN.md` = `01d94450…`, `…ODYSSEUS_AUDIT_AND_IMPLEMENTATION_PLAN_v1_11.md` = `a7681dc0…` — both match `ARTIFACT_MANIFEST.md` |
| Brand authority preserved | SHA-256 re-hash | `WEST_PEEK_BRAND_SYSTEM.md` = `6b8e3c0a…`, `src/client/public/wp-mark.svg` = `bf90a100…` — both match |
| No application/auth source changed | mtime sweep over the whole tree | nothing modified since this run started except this ledger; `src/`, `migrations/`, `tests/`, `e2e/`, `scripts/` all untouched |
| No secrets packaged | credential-shaped file scan + content scan | no `.dev.vars`, `.env`, `*.key`, `*.pem`, `*.p12`, `id_rsa*` anywhere; the content scan for assigned credential-shaped values across `src`, `scripts`, `tests`, `e2e`, `migrations`, `wrangler.toml`, `package.json` returned **nothing** |

The playwright browser-cache failure the generation-1 pass diagnosed did **not** recur: the machine's
`~/Library/Caches/ms-playwright/` already held the build matching the version `npm ci` reinstalled,
so the suite passed 48/48 on the first attempt. The underlying gap it recorded is unchanged and will
still recur on a machine without a matching browser cache.

**P5 — the load-bearing inheritance claim re-checked on the wrangler this run installed.** Every
section of this ledger depends on `[triggers]` being inherited into `[env.production]`; if it were
not, the ADR-017 cron — this system's only scheduling primitive — would silently never fire in
production, and no dry-run prints trigger information, so the claim cannot falsify itself. Confirmed
again in `node_modules/wrangler/wrangler-dist/cli.js` as installed by this session's `npm ci`:
`triggers: inheritable`. The named environment takes the top-level `*/15 * * * *` cron.

**Accepted residual, restated without quiet revision.** The top-level profile remains deployable and
a bare `wrangler deploy` would still ship `WP_OS_ENV = "local"`. Wrangler 4.120.1 does now warn when
multiple environments are defined and none is selected, which narrows the failure mode but does not
close it. No guard was added: the approved task requires the top-level profile be preserved
unchanged, and adding a mechanical guard is new scope needing its own approval.

**Still UNPROVEN, unchanged by this pass.** Nothing has been deployed — declaring a profile is
configuration, not a deploy. Cloudflare Access policy behaviour is operator configuration and is not
exercised here. Remote D1 migration apply has never been run. The deployed Worker name is
config-proven, not deploy-proven. `preview` still has no profile. Nothing was deployed, migrated, or
configured remotely by this pass; no Cloudflare resource was created or mutated; the only wrangler
commands run were `--dry-run` and `--local`.

Approved scope is complete and re-proven in this run. Host packaging and `LOCAL_ARTIFACT_VERIFIED`
finalization (P6) remain the host's, as the execution contract requires.

---

## Implementation-role pass (2026-08-16)

Run `20260816T232103Z-91568`, role `claude:implementation`, CONTINUATION over the same preserved
baseline and the same approved task (`TASK/APPROVED_TASK.md`, SHA-256 `e323bce3…`).

**Why this section exists rather than an inheritance of the one above it.** The section above was
written by this run's *opening* session (`d6f2f29f-…`). This is a distinct session in the
implementation role, and the execution contract binds this role to "run the repo-authorized
validation you actually rely on" and to never claim validation that did not run. Reading a proof
table is not running it. Every row below was executed in *this* session; nothing is inherited, and
nothing above was rewritten or quietly revised.

**P1 — state established before any mutation.** An mtime sweep over `src/`, `migrations/`, `tests/`,
`e2e/`, `scripts/`, `docs/`, `wrangler.toml`, `package.json` and `ARCHITECTURAL_DECISIONS.md` for
anything newer than 2026-08-14 returned **nothing**. The tree is the one the 2026-08-14 final review
proved byte-identical to the approved reference. No work from any prior pass was lost.

**P2 — reproduction re-proven against the reference artifact, not against this ledger.**
`ARTIFACTS/WEST_PEEK_OS_PRODUCTION_READY_v1.zip` re-hashed to SHA-256
`1195e25c03e887ff21ad290770600a3ae37cc54f56b9ee82b06a831e2e7b002d`, was extracted fresh to a
scratch directory and diffed recursively against this tree:

| Comparison | Result |
|---|---|
| `wrangler.toml` | **byte-identical** to the approved reference (`cmp`) |
| `docs/ENVIRONMENTS.md` | **byte-identical** (`cmp`) |
| `ARCHITECTURAL_DECISIONS.md` | **byte-identical** (`cmp`) |
| Whole `west-peek-os/` tree (excl. `node_modules`, `dist`, `.wrangler`, `test-results`, `.DS_Store`) | identical except `IMPLEMENTATION_LEDGER.md` (this run's own record) and `.env.example` |

`.env.example` is present here and absent from the reference. It is dated 2026-08-12 22:47 —
pre-existing unrelated user work from before this task — and was deliberately **not** reverted, as
the approved task forbids reverting unrelated user work. Re-read in full this pass: it is a
names-only contract; the only assigned value is `WP_OS_ENV=local`, a runtime-mode name, and every
credential name (`OPENROUTER_API_KEY`, `HARVEY_API_KEY`, `FUND_ADMIN_SFTP_KEY`, and the rest) carries
an empty value.

**P3 — no repair required, and none was invented.** Each clause of approved scope §2 was checked
against `wrangler.toml` directly rather than against the ledger: top-level profile preserved with
`WP_OS_ENV = "local"` and the ADR-007 placeholder D1/KV ids intact; `[env.production]` present with
`name = "west-peek-os"` restated so the named environment does not deploy to
`west-peek-os-production`; `WP_OS_ENV = "production"`; `WP_OS_DB` / `west-peek-os-db` /
`1d7c242b-…`; `WP_OS_KV` / `bf0750e8…`; `WP_OS_DOCUMENTS` / `west-peek-os-documents`;
`./dist/client` + `ASSETS` + `single-page-application`; `[env.production.observability] enabled =
true`. All eight clauses already satisfied, so this pass changed no file except this ledger section.
Manufacturing a change would move the artifact away from the reference it is required to reproduce.

**P4 — proof actually run in this session** (node v26.4.0 / npm 11.17.0 / wrangler 4.120.1):

| Check | Command | Result |
|---|---|---|
| Frozen install | `npm ci --ignore-scripts --no-audit --no-fund` | rc=0, 144 packages |
| Typecheck | `npm run typecheck` | rc=0 |
| Unit/integration | `npm run test` | rc=0 — **513/513**, 26 suites, 76.3s |
| Clean build | `rm -rf dist && npm run build` | rc=0 |
| Build output | `dist/client` | present — `index.html`, `assets/`, `sw.js`, `manifest.webmanifest`, `icon.svg`, `wp-mark.svg` |
| Authority scan | `npm run validate:authority` | rc=0 — PASS + self-test 4/4 + seeds fresh (45 machines / 15 domains / 53 reserved actions / 204 action types) |
| AI boundary | `npm run validate:ai-boundary` | rc=0 — PASS + self-test 5/5 + seeds fresh (31 employees, all INACTIVE, no MP names) |
| Network boundary | `npm run validate:network-boundary` | rc=0 — PASS + self-test 6/6 |
| Brand | `npm run validate:brand` | rc=0 — PASS + self-test 9/9 |
| E2E | `npm run e2e` | rc=0 — **48/48** chromium, 36.3s, first attempt |
| Migration idempotency | `npm run migrate:local` after the e2e reset applied 0001–0023 | "No migrations to apply!" |
| Production profile resolves as production | `wrangler deploy --dry-run --env production` | rc=0, **not deployed** — `WP_OS_ENV ("production")`, `WP_OS_KV (bf0750e8e9a648758a5de978088c97da)`, `WP_OS_DB (west-peek-os-db)`, `WP_OS_DOCUMENTS (west-peek-os-documents)`, `ASSETS` |
| Local profile preserved | `wrangler deploy --dry-run` (top level) | rc=0 — still `WP_OS_ENV ("local")` and the placeholder KV id `0000…0000` |
| Parent authority preserved | SHA-256 re-hash | `…CANONICAL_MASTER_PLAN.md` = `01d94450…`, `…ODYSSEUS_AUDIT_AND_IMPLEMENTATION_PLAN_v1_11.md` = `a7681dc0…` — both match `ARTIFACT_MANIFEST.md` |
| Brand authority preserved | SHA-256 re-hash | `WEST_PEEK_BRAND_SYSTEM.md` = `6b8e3c0a…`, `src/client/public/wp-mark.svg` = `bf90a100…` — both match |
| No application/auth source changed | mtime sweep | `src/`, `migrations/`, `tests/`, `e2e/`, `scripts/`, `docs/`, `wrangler.toml`, `package.json`, `ARCHITECTURAL_DECISIONS.md` — nothing newer than 2026-08-14 |
| No secrets packaged | credential-shaped file scan + assigned-value content scan | no `.dev.vars`, `.env`, `*.key`, `*.pem`, `*.p12`, `*.pfx`, `id_rsa*` anywhere; the content scan for assigned credential-shaped values across `src`, `scripts`, `tests`, `e2e`, `migrations`, `wrangler.toml`, `package.json`, `.env.example` returned **nothing** |

The playwright browser-cache failure the generation-1 pass diagnosed did not recur: the machine's
`~/Library/Caches/ms-playwright/` already held the build matching the version `npm ci` reinstalled.
The gap that entry recorded is unchanged and will still recur on a machine without a matching cache.

**P5 — the load-bearing inheritance claim re-checked on the wrangler this session installed.** Every
pass of this ledger depends on `[triggers]` being inherited into `[env.production]`; if it were not,
the ADR-017 cron — this system's only scheduling primitive — would silently never fire in
production, and no dry-run prints trigger information, so the claim cannot falsify itself. Confirmed
again in `node_modules/wrangler/wrangler-dist/cli.js` as installed by *this* session's `npm ci`:
`triggers: inheritable`. The named environment takes the top-level `*/15 * * * *` cron.

**Accepted residual, restated without quiet revision.** The top-level profile remains deployable and
a bare `wrangler deploy` would still ship `WP_OS_ENV = "local"`. Wrangler 4.120.1 emits a warning
when multiple environments are defined and none is selected — observed again in this session's
top-level dry-run — which narrows the failure mode but does not close it. No guard was added: the
approved task requires the top-level profile be preserved unchanged, and adding a mechanical guard
is new scope needing its own approval.

**Still UNPROVEN, unchanged by this pass.** Nothing has been deployed — declaring a profile is
configuration, not a deploy. Cloudflare Access policy behaviour is operator configuration and is not
exercised here. Remote D1 migration apply has never been run. The deployed Worker name is
config-proven, not deploy-proven. `preview` still has no profile. No Cloudflare resource was created
or mutated; the only wrangler commands run were `--dry-run` and `--local`.

Approved scope P1–P4 is complete and independently re-proven by the implementation role. P5 (final
senior review) and P6 (host packaging / `LOCAL_ARTIFACT_VERIFIED` finalization) remain outside this
role, as the execution contract requires.

---

## P5 — final senior review pass (2026-08-16)

Run `20260816T232103Z-91568`, role `claude:final-review`, worker generation 2, over the same approved
task (`TASK/APPROVED_TASK.md`, SHA-256 `e323bce3…`) and handoff checkpoint
(`HANDOFF_CHECKPOINT.json`, SHA-256 `7c9a7aae…`). This is the mandatory P5 gate the section above
correctly declined to perform on itself.

**Method.** Nothing below is inherited. Every clause of approved scope §2 was checked against
`wrangler.toml` and against wrangler's own resolved binding output, not against any ledger prose, and
every validator was executed in *this* session. Reading a proof table is not running it.

**Scope conformance — all eight clauses of §2, verified directly.**

| Approved clause | Verified how | Result |
|---|---|---|
| §2.1 top-level/local profile preserved unchanged | `wrangler deploy --dry-run` (no `--env`) + byte-compare to the approved reference | `WP_OS_ENV ("local")`, placeholder KV id `0000…0000`, ADR-007 placeholder `database_id` intact; file byte-identical to reference |
| §2.2 explicit `[env.production]` for the existing `west-peek-os` Worker | `wrangler.toml` read directly | present; `name = "west-peek-os"` restated so the named env does not become `west-peek-os-production` |
| §2.3 `WP_OS_ENV="production"` | production dry-run resolved bindings | `env.WP_OS_ENV ("production")` |
| §2.4 D1 | production dry-run | `env.WP_OS_DB (west-peek-os-db)`, id `1d7c242b-fddc-41f1-843c-03dd2db6fbef` |
| §2.4 KV | production dry-run | `env.WP_OS_KV (bf0750e8e9a648758a5de978088c97da)` |
| §2.4 R2 | production dry-run | `env.WP_OS_DOCUMENTS (west-peek-os-documents)` |
| §2.4 `./dist/client` + `ASSETS` + SPA | production dry-run + `wrangler.toml` | `env.ASSETS` bound; "Read 8 files from the assets directory …/dist/client"; `not_found_handling = "single-page-application"` |
| §2.4 observability enabled | `wrangler.toml` | `[env.production.observability] enabled = true` |
| §2.5 production/ADR documentation | `docs/ENVIRONMENTS.md` preview/production section + ADR-007 read in full | both present, accurate, and still label production UNPROVEN/undeployed |

**Reproduction re-proven independently, whole-tree.** `ARTIFACTS/WEST_PEEK_OS_PRODUCTION_READY_v1.zip`
re-hashed to SHA-256 `1195e25c03e887ff21ad290770600a3ae37cc54f56b9ee82b06a831e2e7b002d`. Every
member file was streamed from the archive and SHA-256-compared against this tree (excluding
`node_modules/`, `dist/`, `.wrangler/`, `test-results/`, `backups/`, `.DS_Store` per the
`ARTIFACT_MANIFEST.md` snapshot rules). Result: **zero files present only in the reference, one file
present only here (`.env.example`), and exactly one content difference (`IMPLEMENTATION_LEDGER.md`,
this run's own record)**. `wrangler.toml`, `docs/ENVIRONMENTS.md`, `ARCHITECTURAL_DECISIONS.md`,
`src/worker/auth.ts`, `src/worker/env.ts`, `src/worker/index.ts`, `package.json` and
`package-lock.json` are each byte-identical to the approved reference. The two exceptions the
implementation pass declared are the only two that exist — that claim is true, not merely asserted.

**Security law re-checked at the source, not at the config.** `src/worker/auth.ts` selects the
identity header on `env.WP_OS_ENV === "local"` — strict equality — so every non-`local` value,
production included, reads `Cf-Access-Authenticated-User-Email` and the `x-wpos-dev-user` dev header
is unreachable. Combined with the production dry-run resolving `WP_OS_ENV` to `"production"`, the
§3 law "production must never run under `WP_OS_ENV=local`" holds at both the configuration and the
code layer. `auth.ts` is byte-identical to the reference: no authentication code was changed.

**Proof actually run in this session** (node v26.4.0 / npm 11.17.0 / wrangler 4.120.1):

| Check | Command | Result |
|---|---|---|
| Frozen install | `npm ci --ignore-scripts --no-audit --no-fund` | rc=0, 144 packages |
| Typecheck | `npm run typecheck` | rc=0 |
| Unit/integration | `npm run test` | rc=0 — **513/513**, 26 suites, 74.0s |
| Clean build | `rm -rf dist && npm run build` | rc=0, 44 modules |
| Build output | `dist/client` | present — `index.html`, `assets/`, `sw.js`, `manifest.webmanifest`, `icon.svg`, `wp-mark.svg` |
| Authority scan | `npm run validate:authority` | rc=0 — PASS + self-test 4/4 + seeds fresh (45 machines / 15 domains / 53 reserved actions / 204 action types) |
| AI boundary | `npm run validate:ai-boundary` | rc=0 — PASS + self-test 5/5 + seeds fresh (31 employees, all INACTIVE, no MP names) |
| Network boundary | `npm run validate:network-boundary` | rc=0 — PASS + self-test 6/6 |
| Brand | `npm run validate:brand` | rc=0 — PASS + self-test 9/9 |
| E2E | `npm run e2e` | rc=0 — **48/48** chromium, 35.6s, first attempt |
| Migration idempotency | `npm run migrate:local` after the e2e reset | "No migrations to apply!" |
| Production profile resolves as production | `npx wrangler deploy --dry-run --env production` | rc=0, **not deployed** — bindings as tabled above |
| Local profile preserved | `npx wrangler deploy --dry-run` | rc=0 — `WP_OS_ENV ("local")`, KV id `0000…0000` |
| Parent authority preserved | SHA-256 re-hash vs `ARTIFACT_MANIFEST.md` | `…CANONICAL_MASTER_PLAN.md` = `01d94450…` ✓, `…ODYSSEUS_AUDIT_AND_IMPLEMENTATION_PLAN_v1_11.md` = `a7681dc0…` ✓ |
| Brand authority preserved | SHA-256 re-hash vs `ARTIFACT_MANIFEST.md` | `WEST_PEEK_BRAND_SYSTEM.md` = `6b8e3c0a…` ✓, `src/client/public/wp-mark.svg` = `bf90a100…` ✓ |
| No secrets packaged | credential-shaped file scan + assigned-value content scan | no `.dev.vars`, `.env`, `*.key`, `*.pem`, `*.p12`, `*.pfx`, `id_rsa*` anywhere in the tree; the assigned-value scan across `src`, `scripts`, `tests`, `e2e`, `migrations`, `wrangler.toml`, `package.json`, `.env.example` returned nothing |
| Validation itself mutated nothing | whole-tree reference diff re-run *after* all of the above | still exactly the two declared exceptions |

**`.env.example` re-adjudicated rather than accepted on report.** Read in full: 998 bytes, mtime
2026-08-12 22:47 — pre-existing user work predating this task. The only assigned value in the entire
file is `WP_OS_ENV=local`, a runtime-mode name; every credential name
(`OPENROUTER_API_KEY`, `HARVEY_API_KEY`, `FUND_ADMIN_SFTP_KEY`, …) carries an empty value. It is not a
secret and §6 forbids reverting unrelated user work, so it stays. `.gitignore` ignores `.env` and
`.env.*` while explicitly re-including `!.env.example`, so the names-only file is the intended
artifact and no real env file can follow it in.

**Documentation re-checked for false or stale claims.** A scan across `docs/` and the root markdown
for now-false statements ("no production profile", "placeholders only", "profile does not exist")
found none outside the ledger's own change table, where they appear as descriptions of what was
amended. `docs/ENVIRONMENT_CONTRACT.md` remains names-only and lists `WP_OS_ENV` as PRESENT, which is
true of both profiles. `AGENTS.md` still lists remote Cloudflare deployment as UNPROVEN — consistent,
because declaring a profile is not deploying one.

**The load-bearing inheritance claim re-verified once more.** Every pass depends on `[triggers]` being
inherited into `[env.production]`; if it were not, the ADR-017 cron — this system's only scheduling
primitive — would silently never fire in production, and no dry-run prints trigger information, so
the claim cannot falsify itself. Re-confirmed in `node_modules/wrangler/wrangler-dist/cli.js` as
installed by this session's own `npm ci`: `triggers: inheritable`.

**Repairs applied by this pass: none, and none were manufactured.** The full approved scope was
inspected and no material omission, stub, drift, regression, auth/security gap, failure-path gap, or
false completion claim was found. Every quantitative claim the implementation pass made was
re-executed here and reproduced. Changing a file merely to demonstrate activity would move the
artifact away from the reference §2 requires it to reproduce.

**Accepted residual, restated without quiet revision.** The top-level profile remains deployable and a
bare `wrangler deploy` would still ship `WP_OS_ENV = "local"`. Wrangler 4.120.1 emits a warning when
multiple environments are defined and none is selected — observed again in this session's top-level
dry-run — which narrows the failure mode without closing it. This is deliberately NOT repaired: §2.1
requires the top-level profile be preserved unchanged and §5 excludes work beyond the enumerated
changes, so a mechanical guard is new scope needing its own approval. Separately observed, and offered
as configuration fact rather than proof: that profile still carries the ADR-007 placeholder D1
`database_id` and KV `id`, which do not name real provisioned resources.

**Still UNPROVEN, unchanged by this pass.** Nothing has been deployed — declaring a profile is
configuration, not a deploy. Cloudflare Access policy behaviour is operator configuration and was not
exercised; the production identity path depends on Access injecting
`Cf-Access-Authenticated-User-Email`. Remote D1 migration apply has never been run. The deployed
Worker name is config-proven, not deploy-proven. `preview` still has no profile. No Cloudflare,
GitHub, Boss OS, or partner repository was mutated; no Cloudflare resource was created; the only
wrangler commands run in this session were `--dry-run` and `--local`.

Approved scope P1–P5 is complete and independently verified. P6 (host packaging and
`LOCAL_ARTIFACT_VERIFIED` finalization) remains the host's, as the execution contract requires.

### P5 addendum — host finalization gate rejection and the substituted production proof

The host gate rejected this pass's first evidence record on two procedural grounds: more than eight
validation commands were declared, and `wrangler deploy --dry-run --env production` carries a
forbidden proof token (`wrangler deploy`) regardless of `--dry-run`. Neither finding concerned the
artifact. The dry-runs recorded in the table above **did run in this session and their results stand**;
they simply may not be declared as commands the host re-executes.

Replacing them required a production-profile proof that needs no wrangler subcommand. The first
attempt was a whole-file substring check over `wrangler.toml`, and self-testing it against planted
violations exposed a defect serious enough to record: **it passed a `wrangler.toml` whose production
profile had been flipped to `WP_OS_ENV = "local"`.** The header comment on line 10 contains the
literal text `WP_OS_ENV = "production"` while documenting the profile, so a whole-file substring match
was satisfied by prose rather than by configuration. The same contamination made the top-level-profile
and profile-header checks false-pass. Had that check been declared, it would have certified the exact
§3 security-law breach this run exists to prevent.

The declared check is therefore section-scoped: it strips comment lines, folds `wrangler.toml` into
its TOML sections, and asserts 17 clauses **within their own sections** — the top-level `[vars]`
staying `local` with both ADR-007 placeholder ids intact and never containing `production`, and
`[env.production]` carrying the restated worker name, `WP_OS_ENV = "production"`, the assets
directory/binding/SPA handling, the real D1/KV/R2 bindings and identifiers, and observability enabled.

Self-test of the replacement, harness corrected after an initial `$OLDPWD` reuse bug made the first
matrix read the wrong file:

| Planted violation | Caught |
|---|---|
| production profile forced to `WP_OS_ENV = "local"` (§3 security law) | yes |
| top-level local profile mutated to `production` | yes |
| `[env.production.observability]` removed | yes |
| `name = "west-peek-os"` restatement removed | yes |
| SPA asset handling removed | yes |
| production D1 id downgraded to the placeholder | yes |
| production KV id altered | yes |
| assets directory repointed away from `./dist/client` | yes |
| local profile repointed at the production D1 | yes |
| production R2 binding removed | yes |
| *negative control:* comment text changed, configuration untouched | correctly passes |

10/10 violations caught, positive control passes, no false failure on comment-only edits. All eight
declared commands were then re-run in order from the locked target root: typecheck, `test`
(513/513), `build`, the four boundary/brand validators, and this contract assertion — every one rc=0.

This addendum changed no configuration or application file; the artifact is unchanged from the state
proven in the table above.

### P5 addendum 2 — second gate rejection, and why the production proof stays in-session

The host gate then rejected the replacement command itself. Its scanner accepts only simple declared
commands; an inline `node -e` program is refused regardless of what it asserts (the rejection quoted
the command and named no other fault). Every command it has accepted is of the form
`npm --prefix west-peek-os run <script>`.

That leaves two ways to declare a host-rerunnable production-profile check, and **both are refused by
approved scope**: adding a `scripts/validate/*.mjs` validator plus a `package.json` entry would breach
§2, which limits target changes to the wrangler production profile and the documentation describing
it, and §6, which directs this run to "use the repository's existing validation surfaces appropriate
to this narrow change." Manufacturing a new validation surface to satisfy a gate's command-format
preference would also break the byte-level reproduction of the approved reference artifact that §2
exists to preserve — the artifact would no longer match `WEST_PEEK_OS_PRODUCTION_READY_v1.zip`.

So the declared command set is the seven existing repo scripts, and the production-profile proof
remains what it has always been in this pass: **evidence actually executed in this session and
recorded above** — the wrangler production dry-run resolving `WP_OS_ENV ("production")` with the real
D1/KV/R2 bindings and not publishing, the top-level dry-run still resolving `"local"` with both
placeholder ids, the byte-identical comparison of `wrangler.toml` against the approved reference, and
the section-scoped contract assertion self-tested against 10 planted violations. None of that is
withdrawn or weakened; it simply is not expressible in the format the host will re-execute.

Recorded plainly so no later reader mistakes the declared command list for the whole proof: the seven
declared scripts prove the repository is healthy (typecheck, 513/513 unit/integration, clean build,
authority/AI/network/brand boundary validators). They do **not** themselves re-verify the production
profile. That verification is in this ledger, and the host's own packaging re-hashes the artifact it
describes.

## P26 phase 1 — operator experience: navigation, contextual help, Help Center

Scope delivered in this pass is **phase 1 of the P26 upgrade**, not the whole of it. What follows is
what was actually built and actually validated; §§4–9 of the P26 brief (guided setup, employee→work
connection, recurring-work guidance, provider/credential wiring, Home command surface) are **not
started**, and nothing in this entry should be read as covering them.

### Implemented

| Change | File |
|---|---|
| Two-tier navigation: 6 everyday groups + Help; 8 admin destinations behind one disclosure | `src/client/App.tsx` |
| Disclosure auto-opens when a system destination becomes current; never auto-collapses | `src/client/App.tsx` |
| `HowThisWorks` — the reusable 7-question contextual-help primitive | `src/client/pages/HowThisWorks.tsx` |
| Help Center: 18 topics, maturity-tagged, searchable, reachable signed-out | `src/client/pages/HelpCenterPage.tsx` |
| Help facts derived from the registry, activation cap pinned by test | `src/client/lib/helpFacts.ts`, `tests/help-facts.test.ts` |
| Contextual help on Scheduled Work | `src/client/pages/JobsPage.tsx` |
| Nav helper extended to both tiers at any viewport | `e2e/support/nav.ts` |
| P26 browser journey: tiering, keyboard, deep-link, phone, Help | `e2e/p26-operator-experience.spec.ts` |

**All 29 original destinations kept their key and their exact label.** Twelve moved tier; none was
removed or renamed, so existing deep links and selectors still resolve.

### Honesty constraints observed

The Help Center **refuses to state whether any integration is working**. Integration, intelligence,
investing, LP and portfolio topics are tagged `AUDIT_PENDING` and defer to the readiness surface,
because their true configured/connected status has not been audited. A help page that guesses is
worse than one that admits the gap, since the operator acts on it.

### Locally validated — full matrix, no test weakened

```
typecheck                  PASS
unit/integration           515/515 PASS  (513 before; +2 help-facts pins)
validate:authority         rc=0
validate:ai-boundary       rc=0
validate:network-boundary  rc=0
validate:brand             PASS (9/9 planted violations caught)
build                      PASS (335.70 kB js / 24.91 kB css)
e2e (Playwright)           55/55 PASS
```

Three E2E specs failed on the first run and were **fixed at the source, not silenced**:
`p1-shell` encoded the old flat-nav contract and now asserts both halves of the new one (everyday
visible, admin hidden-then-reachable); `d1-design-states` and `p25-journeys` broke because a
pre-existing `e2e/support/nav.ts` helper — which this pass had duplicated by mistake — did not know
about the second tier. The duplicate was deleted and the existing helper extended, so there is one
navigation helper, not two.

### Not deployed

`repo deploy` selects the latest **verified artifact** from run/state authority and never the
mutable WORK tree. The current selection is `06040f94…` from run `20260816T232103Z-91568`, which
predates this work. Deploying now would ship the pre-P26 build. A governed run must package WORK
into a new verified artifact before phase 1 can reach production.

## P26 phase 2 — provider & credential truth audit; OpenRouter enabled

**Audit.** `docs/PROVIDER_READINESS_AUDIT.md` maps West Peek's five credential demands against both
vaults and the live Worker. Finding at audit time: the production Worker secret list was empty, so
no AI path could work at all.

**Decision and change (Managing Partner, 2026-08-17).** All AI work flows through OpenRouter; West
Peek may share Repo Operator credentials.

- `migrations/0024_enable_openrouter.sql` — `enabled = 1` for `openrouter`, nothing else. `base_url`
  and the data-class policy were already correct from `0004` and were left untouched.
- `OPENROUTER_API_KEY` bound as a production Worker secret (Keychain → pipe → `wrangler` stdin;
  never echoed, never on disk, never in argv).
- **Egress not widened.** `CONFIDENTIAL` / `RESTRICTED` / `LP_PRIVATE` / `MNPI_SENSITIVE` /
  `BANKING_RESTRICTED` still cannot reach OpenRouter. Only `PUBLIC` and `INTERNAL`.
- Status is **configured, not externally verified** — no model call has been made.

## P26 phase 3 (partial) — guided setup and the recommended team

### Implemented

| Change | File |
|---|---|
| Pure, testable recommendation engine derived from the live 31-role roster | `src/shared/setup/recommendedTeam.ts` |
| "Set Up West Peek OS" surface — derives slots and status from the workforce API | `src/client/pages/SetupPage.tsx` |
| Nav entry under Home; contextual help on the page | `src/client/App.tsx` |
| 6 unit tests incl. cap, roster drift, purity, visible trade-off | `tests/recommended-team.test.ts` |

The engine holds **no roster of its own** — it reads `AI_EMPLOYEE_ROSTER` and returns a reason per
person, so it cannot drift from the registry. It has no database or network access, so it
*structurally cannot* activate anyone. Activation stays on Employees behind the
`ai_employee.activate` receipt and the server-side cap of five.

Six stated priorities, five slots: the uncovered priority and the person who would cover it are
both rendered, so the cap's cost is visible rather than silently dropped.

### Not done in this phase

§5 (connect employees to capabilities, integrations, dependencies and recurring assignments) is
**not started**. The Setup page recommends and explains; it does not yet show per-employee
capability or dependency status. There is also **no E2E coverage for the Setup page** — it is
covered by unit tests and typecheck only.

### Validated

```
typecheck 0 · tests 521/521 (28 files) · build 0
authority 0 · ai-boundary 0 · network-boundary 0 · brand 0 · e2e 55/55
```

### P26 phase 3 completion — §5 employee→work dependencies, and the missing E2E

| Change | File |
|---|---|
| Readiness engine: employee status → assigned machines → configured provider | `src/shared/setup/employeeReadiness.ts` |
| Per-role dependency + blocker rendering on the setup surface | `src/client/pages/SetupPage.tsx` |
| 8 unit tests incl. the partially-paused case | `tests/employee-readiness.test.ts` |
| 5 browser tests incl. "setup cannot activate anyone" | `e2e/p27-guided-setup.spec.ts` |

**The dependency that matters.** An employee may be `ACTIVE` while their only machine is `PAUSED`,
and the server refuses to route work to a paused machine (`p17-machines.spec.ts` proves the API
returns a refusal). Reporting that employee as ready would assert something the server rejects, so
all-machines-paused is fatal while some-machines-paused is not — the role is narrowed, not stopped.

**Every blocker carries the one action that clears it.** A bare "blocked" with no next step is the
failure mode this replaces, and the E2E asserts blockers are non-empty whenever a role is not ready.

**Governance pinned by test.** `p27` asserts the setup surface has zero controls matching
`/activate/i`, names the approval-receipt requirement, and repeats the law in its contextual help.
A setup wizard able to activate would be a route around both the cap and the receipt.

**Deliberately the weaker claim.** The client can see a provider is `enabled` and not
`kill_switched`, but cannot see whether its credential is bound — that is Worker-side. So
`aiProviderConfigured` asserts only what the client can actually know, and says so in a comment.

**Not done in §5:** recommended recurring assignments per employee. That overlaps §6 and is better
built once against the real job architecture than twice.

```
typecheck 0 · tests 529/529 (29 files) · build 0
authority 0 · ai-boundary 0 · network-boundary 0 · brand 0 · e2e 60/60
```

## P26 phase 4 (partial) — §6 recurring work guidance

### Implemented

| Change | File |
|---|---|
| Recurring-work proposals shaped to the real `scheduled_job` contract | `src/shared/setup/recommendedJobs.ts` |
| "Recommended recurring work" section with per-job blockers | `src/client/pages/SetupPage.tsx` |
| 10 unit tests that read the migration and assert schema conformance | `tests/recommended-jobs.test.ts` |
| Browser test: proposals are PAUSED and cannot be created here | `e2e/p27-guided-setup.spec.ts` |

**Not a second scheduler.** This produces *proposals* shaped to `scheduled_job` and nothing else. No
job is created, enabled or run from the setup surface; the E2E asserts zero controls matching
`/switch on|enable|create job/i`.

**The tests read the schema rather than restating it.** `allowedFromSchema()` parses the `CHECK`
constraints out of `migrations/0018_orchestration.sql`, so the allowed `kind`, `schedule_kind`,
`target_kind` and `status` values are derived. A proposal the database would reject fails in CI
instead of in the operator's hands, and adding a job kind to the schema without updating the
proposals breaks the test.

**Honest about what the product supports.** The brief lists ten desirable recurring jobs; seven are
proposed. The table has three job kinds, not ten — inventing an `LP_PIPELINE` kind to appear
complete would produce a row the database refuses. The three not proposed are the ones with no
honest home in the current schema.

**Egress stays inside the policy.** Every proposal is `PUBLIC` or `INTERNAL`, asserted by test,
because the one enabled provider lane may receive nothing above `INTERNAL`. A `CONFIDENTIAL`
proposal would be proposing work the egress policy refuses.

### Not done

§8 — Home as an operator command surface — is **not started**. Phase 4 is half complete.

```
typecheck 0 · tests 539/539 (30 files) · build 0
authority 0 · ai-boundary 0 · network-boundary 0 · brand 0 · e2e 61/61
```

### P26 phase 4 completion — §8 Home as an operator command surface

Home was **not** rebuilt. It already answers most of the brief's questions through twelve
server-driven modules (approvals, what changed, my work, LP signals, meetings, IC priorities,
portfolio risk, allocation, reconciliation, AI spend, employees, intelligence). Replacing that with
a fresh surface would have destroyed working behaviour to re-earn it.

Four of the brief's questions had no answer anywhere, and those are what was added:

| Question | Answer added |
|---|---|
| What is blocked? | `home-attention` strip, above the fold |
| Is scheduled work healthy? | dead-letter, refusal/failure and paused-job detection |
| Is AI failing? | provider-unconfigured detection |
| Is setup incomplete? | unactivated recommendation count |

| Change | File |
|---|---|
| Attention engine — pure, derives from live state only | `src/shared/setup/operatorAttention.ts` |
| "Needs your attention" strip rendered above *one thing to watch* | `src/client/pages/HomePage.tsx` |
| 7 unit tests | `tests/operator-attention.test.ts` |
| Browser test: answers, or is honestly silent | `e2e/p27-guided-setup.spec.ts` |

**It invents nothing.** Every input is passed in; the module has no data source of its own. An
absent source yields `undefined`, and only an explicit `false` is treated as a finding — so a
provider endpoint that did not answer produces silence, not a false alarm. Asserted by test.

**Silence is a valid answer, and the test proves it is earned.** When the strip is absent the E2E
opens Scheduled Work and fails if any dead letter exists — so "nothing to report" cannot be a bug
masquerading as calm.

**Ordered by consequence, not category.** A dead-lettered job (`BLOCKING` — that work stopped and
will not retry) outranks an unactivated recommendation (`INFO` — a gap, not a fault). Every item
carries its next action and the surface that resolves it.

```
typecheck 0 · tests 546/546 (31 files) · build 0
authority 0 · ai-boundary 0 · network-boundary 0 · brand 0 · e2e 62/62
```

## Production artifact admission — re-verification over the post-P26 WORK tree

Run `20260817T013912Z-11185`, CONTINUATION, against the same approved task
(`TASK/APPROVED_TASK.md`, SHA-256 `e323bce3…`) as the four passes recorded above.

**Why this pass exists.** The previous pass (`20260816T232103Z-91568`) reached
`LOCAL_ARTIFACT_VERIFIED` and produced artifact `06040f94…`. WORK then legitimately advanced —
P26 phases 1–4 landed after that artifact was sealed. So the approved production-readiness
contract needed re-proving against the tree as it now stands, not as it stood then.

### P3 — no change was required, and none was invented

All five clauses of approved scope §2 were already satisfied. `wrangler.toml` was not edited by
this pass; it is **byte-identical to the approved reference**
(`ARTIFACTS/WEST_PEEK_OS_PRODUCTION_READY_v1.zip`), as are `docs/ENVIRONMENTS.md`,
`ARCHITECTURAL_DECISIONS.md`, and `src/worker/auth.ts`:

| File | SHA-256 (first 16) | vs approved reference |
|---|---|---|
| `wrangler.toml` | `8d66dcee0d6d1ae9` | identical |
| `docs/ENVIRONMENTS.md` | `d78dbbaa3988022c` | identical |
| `ARCHITECTURAL_DECISIONS.md` | `21a723721624b95c` | identical |
| `src/worker/auth.ts` | `13bc20a1207654f1` | identical |

### P4 — validation actually executed in this session

| Check | Command | Result |
|---|---|---|
| Frozen dependency install | `npm ci` | rc=0 |
| Typecheck | `npm run typecheck` | rc=0 |
| Unit/integration | `npm test` | **546/546** (31 files), rc=0 |
| Build | `npm run build` | rc=0; `dist/client` present (8 files, 357.24 kB js / 24.91 kB css) |
| Authority boundary | `npm run validate:authority` | rc=0, self-test 4/4, seeds fresh |
| AI boundary | `npm run validate:ai-boundary` | rc=0, self-test 5/5, seeds fresh |
| Network boundary | `npm run validate:network-boundary` | rc=0, self-test 6/6 |
| Brand | `npm run validate:brand` | rc=0, self-test 9/9 |
| Browser journeys | `npm run e2e` | **62/62** passed, rc=0 |
| Migrations | `npm run migrate:local` | idempotent — "No migrations to apply" |
| **Production profile resolves as production** | `npx wrangler deploy --dry-run --env production` (4.120.1) | rc=0, **not deployed** — `WP_OS_ENV ("production")`, `WP_OS_KV (bf0750e8e9a648758a5de978088c97da)`, `WP_OS_DB (west-peek-os-db)`, `WP_OS_DOCUMENTS (west-peek-os-documents)`, `ASSETS` |
| **Top-level profile stays local** | `npx wrangler deploy --dry-run` | rc=0, **not deployed** — `WP_OS_ENV ("local")`, placeholder KV `0000…0000` |

Both dry-runs exited at `--dry-run: exiting now.` Nothing was published, migrated, or configured
remotely. No Cloudflare resource was created or altered by this run.

### The tree really did move, and this states exactly how

Whole-tree diff against the approved reference (excluding `node_modules`, `dist`, `.wrangler`,
`test-results`, `playwright-report`, `backups`):

- **`src/worker/` is byte-identical in full** — zero differences. No application or authentication
  source file changed, which is approved scope §6's requirement and §3's security law at source.
  `auth.ts` still gates the dev identity header on strict `env.WP_OS_ENV === "local"`, so that
  branch is unreachable under `--env production`.
- **Changed:** `src/client/App.tsx`, `HomePage.tsx`, `JobsPage.tsx`, `styles.css`, 13 `e2e/` specs
  and `e2e/support/nav.ts`, `scripts/vault/cloudflare-mapping.json`, this ledger.
- **Added:** `docs/PROVIDER_READINESS_AUDIT.md`, `migrations/0024_enable_openrouter.sql`,
  `src/client/lib/helpFacts.ts`, three client pages, `src/shared/setup/`, five test files, two e2e
  specs, `.env.example`.

Every one of those is **pre-existing unrelated user work** (P26 phases 1–4, and `.env.example`
dated 2026-08-12). Approved scope §6 forbids reverting unrelated user work, so none was reverted.
`migrations/0024` adds a migration; it rewrites none, which keeps the additive-first rule.

**Secrets: none packaged.** The scan for key/token/private-key material across the tree is clean.
`scripts/vault/cloudflare-mapping.json` gained `"OPENROUTER_API_KEY"` — a secret **name**, not a
value — which is exactly what the names-only contract permits. `.env.example` is names-only with
every value empty. No `.dev.vars`, `.env`, key, or certificate file exists in the tree.

### Stated plainly rather than left for a reader to discover

**This snapshot will contain more than the approved scope.** The approved scope is the production
profile and its documentation, and that part is unchanged and re-proven above. But the artifact the
host packages from this WORK also carries P26 phases 1–4, because that is what WORK now contains.
Those changes were not reviewed against *this* task — they were validated by the repository's own
full suite, which this pass re-ran green in its entirety. A reader must not read
`LOCAL_ARTIFACT_VERIFIED` on this run as an approval of the P26 work's design.

**A Cloudflare mutation happened outside this run.** P26 phase 2 records OpenRouter being enabled
and `OPENROUTER_API_KEY` bound as a production Worker secret. This run did not perform, repeat, or
verify any of that, and made no provider call of any kind. Whether `0024` has been applied to
remote D1 is not observable from here and is not claimed.

### Unchanged residuals, carried forward not silently dropped

- A bare `wrangler deploy` with no `--env production` still selects the top-level profile and would
  ship `WP_OS_ENV = "local"`. Approved scope §2.1 requires that profile be preserved unchanged, so
  this is not repairable here. Deployment must specify `--env production`.
- Remote publish, Cloudflare Access behaviour, and remote D1 migration apply remain **UNPROVEN** —
  declaring `[env.production]` is configuration, never a deployment.
- `preview` still has no profile.

```
npm ci 0 · typecheck 0 · tests 546/546 (31 files) · build 0 · dist/client present
authority 0 · ai-boundary 0 · network-boundary 0 · brand 0 · e2e 62/62 · migrate:local idempotent
--env production → WP_OS_ENV "production" (not deployed) · top-level → WP_OS_ENV "local" (not deployed)
```

## P5 — final senior review pass, worker generation 3 (2026-08-17)

Run `20260817T013912Z-11185`, role `claude:final-review`, over the same approved task
(`TASK/APPROVED_TASK.md`, SHA-256 `e323bce3…`) and handoff checkpoint (`HANDOFF_CHECKPOINT.json`,
SHA-256 `d4fe37f9…`). This is the mandatory P5 gate for the implementation pass recorded directly
above, which correctly declined to perform it on itself.

**Method.** Nothing was inherited from the section above. Every clause of approved scope §2 was
re-checked against `wrangler.toml` and wrangler's own resolved binding output, the "byte-identical
to the approved reference" claims were re-hashed against the reference archive rather than read,
and every validator was executed in *this* session.

### Scope conformance — re-verified, not accepted

| Approved clause | Verified how | Result |
|---|---|---|
| §2.1 top-level/local profile preserved | `npx wrangler deploy --dry-run` (no `--env`) | rc=0, not deployed — `WP_OS_ENV ("local")`, placeholder KV `0000…0000`, ADR-007 placeholder `database_id` intact |
| §2.2 explicit `[env.production]` for the existing Worker | `wrangler.toml:72` | present; `name = "west-peek-os"` restated so the named env is not deployed as `west-peek-os-production` |
| §2.3 `WP_OS_ENV="production"` | production dry-run | `env.WP_OS_ENV ("production")` |
| §2.4 D1 / KV / R2 / assets / SPA / observability | production dry-run + `wrangler.toml` | `WP_OS_DB (west-peek-os-db)` id `1d7c242b…`, `WP_OS_KV (bf0750e8…)`, `WP_OS_DOCUMENTS (west-peek-os-documents)`, `ASSETS` over 8 files from `./dist/client`, `not_found_handling = "single-page-application"`, `[env.production.observability] enabled = true` |
| §2.5 production/ADR documentation | `docs/ENVIRONMENTS.md` + ADR-007 read in full | both describe the contract and both still label production UNPROVEN/undeployed |

**The "identical to the approved reference" claims are true.** Re-hashed in this session:
`wrangler.toml` `8d66dcee0d6d1ae9…`, `docs/ENVIRONMENTS.md` `d78dbbaa3988022c…`,
`ARCHITECTURAL_DECISIONS.md` `21a723721624b95c…`, `src/worker/auth.ts` `13bc20a1207654f1…` — and
`wrangler.toml` streamed out of `ARTIFACTS/WEST_PEEK_OS_PRODUCTION_READY_v1.zip` hashes to the same
`8d66dcee…`. `diff -r` of the whole `src/worker/` tree against the reference archive reports **zero
differences**, so §3's "do not change application authentication code" holds at the source, not
merely in prose. `auth.ts:28` selects the identity header on strict `env.WP_OS_ENV === "local"`, so
under `--env production` the `x-wpos-dev-user` branch is unreachable.

**No secrets packaged.** No `.dev.vars`, `.env`, `*.pem`, `*.key` or `*.p12` file exists anywhere in
the tree. A value-shaped scan (`sk-…`, `sk-or-v1-…`, `AKIA…`, `ghp_…`, `xox…`, JWT, PEM headers)
across the tree returns four hits, all of them deliberate test fixtures that prove credential-shaped
input is *blocked* (`tests/ai.test.ts`, `tests/workforce.test.ts`, `e2e/p4-ai.spec.ts`). `.wrangler/`
and `backups/` are clean too. `scripts/vault/cloudflare-mapping.json` holds a secret **name** only.

### Repair applied — the e2e suite's D1 provisioning was racy

**Found by running it, not by reading about it.** `npm run e2e` failed: rc=1, 59 passed, **1 failed,
2 did not run**. `e2e/d1-design-states.spec.ts` died in `beforeAll` with
`✘ [ERROR] internal error; reference = dkdae7obnj73j826o0q9r58c` after 8.4s, while
`e2e/p3-governed-work.spec.ts` — the identical statement through the identical pattern — succeeded
in the same run. The section above records this same command as `62/62 passed`; that was true when
it ran, but the entrypoint was not reliably re-runnable.

**Cause.** Both specs provision their extra identity with `wrangler d1 execute --local`, which opens
the miniflare SQLite in a SECOND workerd process while `wrangler dev` still holds it. The two
contend. Nothing in West Peek OS ran and no assertion was reached — the failure is in the CLI's
access to the file.

**Fix.** New `e2e/support/provision.ts` exposes `provisionLocalD1(sql)`: the same write, passed as an
argv array (so the SQL is never re-parsed by a shell), retried up to 5 times with linear back-off.
Both specs now call it. **Retrying weakens nothing** — a genuinely bad statement fails every attempt
and still fails the spec with wrangler's own output attached, verified directly:
`wrangler d1 execute --local --command "INSERT INTO no_such_table (a) VALUES (1);"` → rc=1,
`no such table: no_such_table: SQLITE_ERROR`. No application, worker, or product file was touched.

**A second, environmental cause was found and removed rather than papered over.** The rerun failed
worse — the dev server's esbuild child died mid-suite (`fatal error: all goroutines are asleep -
deadlock!`) and everything after `p10-lp` failed. The machine was carrying **four orphaned `vitest`
worker processes** (pids 13216/13221/13228/13274, parent 1, ~780 MB RSS, ~9% CPU each) left behind
by this session's first `npm test`; load average was 17.6 with 55 MB of free pages. Those orphans —
not the suite — are also the best explanation for that first `npm test` reporting one failure
(`tests/meetings.test.ts`, `TypeError: fetch failed … other side closed`) that passed on its own
immediately afterwards. After killing the orphans, the same commands ran clean and fast: vitest
546/546 in **64s** (it had taken 308–428s under load) and e2e 62/62 in **39.9s** (7.5m and a crash
under load). Recorded here because a reader deserves to know the difference between a flaky suite
and a saturated machine.

### Validation actually executed in this session (node v26.4.0 / npm 11.17.0 / wrangler 4.120.1)

| Check | Command | Result |
|---|---|---|
| Frozen dependency install | `npm ci` | rc=0 |
| Typecheck (covers `src`, `tests`, `e2e`) | `npm --prefix west-peek-os run typecheck` | rc=0 |
| Unit/integration | `npm --prefix west-peek-os run test` | rc=0 — **546/546**, 31 files, 64.1s |
| Build | `npm --prefix west-peek-os run build` | rc=0; `dist/client` present (index.html, assets/, sw.js, manifest.webmanifest, icon.svg, wp-mark.svg) |
| Authority boundary | `npm --prefix west-peek-os run validate:authority` | rc=0 — PASS + self-test 4/4 + seeds fresh (45 machines / 15 domains / 53 reserved actions / 204 action types) |
| AI boundary | `npm --prefix west-peek-os run validate:ai-boundary` | rc=0 — PASS + self-test 5/5 + seeds fresh (31 employees, all INACTIVE) |
| Network boundary | `npm --prefix west-peek-os run validate:network-boundary` | rc=0 — PASS + self-test 6/6 |
| Brand | `npm --prefix west-peek-os run validate:brand` | rc=0 — PASS + self-test 9/9 |
| Browser journeys | `npm run e2e` | rc=0 — **62/62** chromium, 39.9s, after the repair above |
| Migrations | `npm run migrate:local` | rc=0 — "No migrations to apply!" (idempotent) |
| **Production profile resolves as production** | `npx wrangler deploy --dry-run --env production` | rc=0, **not deployed** — `WP_OS_ENV ("production")`, `WP_OS_KV (bf0750e8…)`, `WP_OS_DB`, `WP_OS_DOCUMENTS`, `ASSETS` |
| **Top-level profile stays local** | `npx wrangler deploy --dry-run` | rc=0, **not deployed** — `WP_OS_ENV ("local")`, placeholder KV |

Both dry-runs ended at `--dry-run: exiting now.` Nothing was published, migrated, or configured
remotely; no Cloudflare resource was created or altered; no provider was called.

### Files this pass changed

`e2e/support/provision.ts` (new), `e2e/d1-design-states.spec.ts`, `e2e/p3-governed-work.spec.ts`,
and this ledger. Nothing else. No application, worker, migration, or configuration file was touched,
and no unrelated user work was reverted.

### Still UNPROVEN — this section is not deployment readiness

- Remote publish, Cloudflare Access behaviour, and remote D1 migration apply remain **UNPROVEN**.
  Declaring `[env.production]` is configuration; a dry-run is not a deployment.
- A bare `wrangler deploy` with no `--env production` still selects the top-level profile and would
  ship `WP_OS_ENV = "local"`. Approved scope §2.1 requires that profile be preserved unchanged, so
  this is not repairable here: **deployment must specify `--env production`**.
- `preview` still has no profile.
- Every provider/vendor/integration gate listed in the tables above is unchanged and still closed.
- **The snapshot carries more than the approved scope.** P26 phases 1–4 landed in WORK after the
  previous artifact was sealed. They pass the repository's own full suite, which this pass re-ran
  green in its entirety, but they were not reviewed against *this* task. `LOCAL_ARTIFACT_VERIFIED`
  on this run must not be read as approval of the P26 work's design. A Cloudflare mutation recorded
  by P26 phase 2 (OpenRouter enabled, `OPENROUTER_API_KEY` bound as a Worker secret) happened
  **outside** this run; this run neither performed, repeated, nor verified it, and whether
  `migrations/0024` has been applied to remote D1 is not observable from here and is not claimed.

## Production artifact admission — re-verification over the post-P28 WORK tree (2026-08-17)

Run `20260817T025459Z-23440`, role `claude:opening`, worker generation 1, `RUN SEMANTICS:
CONTINUATION`, over the same approved task (`TASK/APPROVED_TASK.md`, SHA-256 `e323bce3…`). The
previous run `20260817T013912Z-11185` reached `LOCAL_ARTIFACT_VERIFIED` at 02:38:59Z and sealed
`ARTIFACTS/west-peek-os-odysseus_FULL_SNAPSHOT_20260817T023859Z_aebf5e1c9bee.zip`
(SHA-256 `1b963fa0…`). This run opened 16 minutes later against the same preserved WORK.

**WORK did not stand still in between, so this is not a rerun of an unchanged tree.** Four source
files were written between that seal (21:38:59 local) and this run's start (21:54:59 local). They
are enumerated below rather than absorbed silently, because the snapshot this run produces carries
them.

### Approved scope — already satisfied, and re-proven rather than assumed

Nothing in approved scope §2 was missing, so **P3 applied no change to the production contract**.
That is a verified finding, not an inherited one:

| Approved clause | Verified how | Result |
|---|---|---|
| §2.1 top-level/local profile preserved | `npx wrangler deploy --dry-run` (no `--env`) | rc=0, not deployed — `WP_OS_ENV ("local")`, placeholder KV `0000…0000` |
| §2.2 explicit `[env.production]` for the existing Worker | `wrangler.toml:72` | present; `name = "west-peek-os"` restated so the named env does not deploy as `west-peek-os-production` |
| §2.3 `WP_OS_ENV="production"` | production dry-run | `env.WP_OS_ENV ("production")` |
| §2.4 D1 / KV / R2 / assets / SPA / observability | production dry-run + `wrangler.toml` | `WP_OS_DB (west-peek-os-db)`, `WP_OS_KV (bf0750e8…)`, `WP_OS_DOCUMENTS (west-peek-os-documents)`, `ASSETS` over 8 files from `./dist/client`, `not_found_handling = "single-page-application"`, `[env.production.observability] enabled = true` |
| §2.5 production/ADR documentation | hashes below | unchanged |

Re-hashed in **this** session: `wrangler.toml` `8d66dcee0d6d1ae9…`, `docs/ENVIRONMENTS.md`
`d78dbbaa3988022c…`, `ARCHITECTURAL_DECISIONS.md` `21a72372…`, `src/worker/auth.ts` `13bc20a1…` —
each identical to the approved reference. `wrangler.toml` extracted from
`ARTIFACTS/WEST_PEEK_OS_PRODUCTION_READY_v1.zip` hashes to the same `8d66dcee…`, and `diff -r` of
the entire `src/worker/` tree against that reference archive reports **zero differences**. §3's "do
not change application authentication code" therefore holds at the source, not merely in prose.
Both dry-runs ended at `--dry-run: exiting now.` — nothing was published, migrated, or configured,
and no Cloudflare API call was made in this run.

### The post-seal delta — unrelated user work, preserved not reverted

`diff -rq` of the whole tree against the sealed snapshot (excluding `node_modules`, `.wrangler`,
`dist`, `test-results`, `backups`) returns exactly four differences:

- `src/client/pages/EmployeesPage.tsx` — adds an "Activate (approved)" button that consumes an
  already-approved `ai_employee.activate` receipt. It closes a chain that previously stopped one
  link short: a request could be approved and the employee still stayed INACTIVE.
- `e2e/p28-activation-chain.spec.ts` (new, 117 lines) — browser proof of that chain.
- `src/client/pages/HelpCenterPage.tsx` — four Help topics move from `AUDIT_PENDING` to
  `IMPLEMENTED_LOCAL_ONLY` with specific claims replacing the placeholder prose.
- `e2e/p26-operator-experience.spec.ts` — asserts no topic is left `AUDIT_PENDING` and that each of
  the four now states falsifiable evidence.

`.env.example` shows as "only in WORK" because host packaging excludes `.env*`; it is not a change.

**This is pre-existing unrelated user work from this run's perspective**, written after the previous
artifact was sealed and before this run began. Approved scope §6 forbids reverting unrelated user
work, so none was reverted, and §2 gave no authority to extend it. **This run neither designed nor
reviewed that work against this task** — it validated it, and it passes the repository's own full
suite, re-run green here in its entirety. `LOCAL_ARTIFACT_VERIFIED` on this run must not be read as
design approval of the P26/P28 work. Notably, no worker/API change accompanies the activation
button: `src/worker/` is byte-identical to the approved reference, so the receipt and cap remain
enforced server-side and the button cannot invent authorization.

The e2e count moved **62 → 66** for this reason: the new specs, not a change in what was already
proven.

### Validation actually executed in this session (node v26.4.0 / npm 11.17.0 / wrangler 4.120.1)

| Check | Command | Result |
|---|---|---|
| Frozen dependency install | `npm ci` | rc=0 |
| Typecheck (`src`, `tests`, `e2e`) | `npm run typecheck` | rc=0 |
| Unit/integration | `npm run test` | rc=0 — **546/546**, 31 files, 66.9s |
| Build | `npm run build` | rc=0; `dist/client` present (index.html, assets/, sw.js, manifest.webmanifest, icon.svg, wp-mark.svg) |
| Authority boundary | `npm run validate:authority` | rc=0 — PASS + self-test 4/4 + seeds fresh (45 machines / 15 domains / 53 reserved actions / 204 action types) |
| AI boundary | `npm run validate:ai-boundary` | rc=0 — PASS + self-test 5/5 + seeds fresh (31 employees, all INACTIVE) |
| Network boundary | `npm run validate:network-boundary` | rc=0 — PASS + self-test 6/6 |
| Brand | `npm run validate:brand` | rc=0 — PASS + self-test 9/9 |
| Browser journeys | `npm run e2e` | rc=0 — **66/66** chromium, 38.9s |
| Migrations | `npm run migrate:local` | rc=0 — "No migrations to apply!" (idempotent) |
| **Production profile resolves as production** | `npx wrangler deploy --dry-run --env production` | rc=0, **not deployed** |
| **Top-level profile stays local** | `npx wrangler deploy --dry-run` | rc=0, **not deployed** |

The e2e entrypoint ran clean on the first attempt this session — the D1 provisioning repair from the
previous run (`e2e/support/provision.ts`) held, and no orphaned `vitest` worker was present before
or after `npm run test` (checked explicitly, since machine saturation was the previous run's second
failure cause). Load average at start: 2.47.

**No secrets packaged.** No `.dev.vars`, `.env`, `*.pem`, `*.key`, `*.p12`, `*.pfx` or `id_rsa*`
file exists anywhere in the package, including `backups/` and `.wrangler/`. A value-shaped scan
(`sk-…`, `sk-or-v1-…`, `AKIA…`, `ghp_…`, `xox…`, JWT, PEM headers) returns four hits, all deliberate
test fixtures proving credential-shaped input is *blocked* (`tests/workforce.test.ts`,
`tests/ai.test.ts` ×2, `e2e/p4-ai.spec.ts`). `scripts/vault/cloudflare-mapping.json` holds a secret
**name** only (`OPENROUTER_API_KEY`) with no value. `.env.example` is names-only apart from
`WP_OS_ENV=local`, which is not a secret.

### Files this pass changed

This ledger, and nothing else. No application, worker, client, test, migration, or configuration
file was touched, and no unrelated user work was reverted.

### P5 not performed here

This worker implemented and validated; it does not review itself. The mandatory final senior review
gate (`final_review_satisfied`) is owed by a separate worker before host packaging.

### Still UNPROVEN — this section is not deployment readiness

- Remote publish, Cloudflare Access behaviour, and remote D1 migration apply remain **UNPROVEN**.
  Declaring `[env.production]` is configuration; a dry-run is not a deployment.
- A bare `wrangler deploy` with no `--env production` still selects the top-level profile and would
  ship `WP_OS_ENV = "local"`. Approved scope §2.1 requires that profile be preserved unchanged, so
  this is not repairable here: **deployment must specify `--env production`**. Wrangler itself now
  warns about the unspecified environment on every bare invocation.
- `preview` still has no profile.
- No AI/vendor provider was called; every provider credential is absent and adapters fail closed.
- The P26 phase 2 Cloudflare mutation (OpenRouter enabled, `OPENROUTER_API_KEY` bound as a Worker
  secret) happened **outside** this run and was neither performed nor verified here. Whether
  `migrations/0024` is applied to remote D1 is not observable locally and is not claimed.
- **The snapshot carries more than the approved scope** — the four post-seal files above.

## Production artifact admission — implementation worker, generation 2 (2026-08-17)

Same run `20260817T025459Z-23440`, same approved task (`TASK/APPROVED_TASK.md`, SHA-256
`e323bce3…`), `RUN SEMANTICS: CONTINUATION`. The section immediately above was written by this run's
**opening** role (worker generation 1, session `7d2c7355…`). This section is written by the
**implementation** role (worker generation 2) that the handoff checkpoint routed to at 03:01:47Z.

The preceding pass had already carried P1–P4 to green. That is a record, not a proof this worker may
sign. So **no validation result below is inherited** — every command in the table was re-executed in
this session, and the scope findings were re-derived from the tree rather than read out of the
section above.

### WORK was unchanged between the two passes

`IMPLEMENTATION_LEDGER.md` (written 22:01 local by the previous role) is the only file modified
between generation 1's validation and this session's start. `src/client/pages/EmployeesPage.tsx` and
`e2e/p28-activation-chain.spec.ts` carry ~21:50 mtimes — before this run opened at 21:54:59 — and
are the pre-existing unrelated user work already enumerated above. Nothing else in `src`, `tests`,
`e2e`, `migrations`, `scripts`, `docs`, or the configuration files moved.

### Approved scope — re-verified independently, still requiring no change

**P3 applied no change to the production contract in this pass either**, because nothing in approved
scope §2 was missing. Verified in this session:

| Approved clause | Verified how | Result |
|---|---|---|
| §2.1 top-level/local profile preserved | `npx wrangler deploy --dry-run` (no `--env`) | rc=0, not deployed — `env.WP_OS_ENV ("local")`, placeholder KV `0000…0000` |
| §2.2 explicit `[env.production]` for the existing Worker | `wrangler.toml:72–73` | present; `name = "west-peek-os"` restated, so the named env does not deploy as `west-peek-os-production` |
| §2.3 `WP_OS_ENV="production"` | production dry-run | `env.WP_OS_ENV ("production")` |
| §2.4 D1 / KV / R2 / assets / SPA / observability | production dry-run + `wrangler.toml:75–100` | `WP_OS_DB (west-peek-os-db)` id `1d7c242b…`, `WP_OS_KV (bf0750e8e9a648758a5de978088c97da)`, `WP_OS_DOCUMENTS (west-peek-os-documents)`, `ASSETS` from `./dist/client`, `not_found_handling = "single-page-application"`, `[env.production.observability] enabled = true` |
| §2.5 production/ADR documentation | byte diff vs approved reference | `docs/ENVIRONMENTS.md` and `ARCHITECTURAL_DECISIONS.md` identical |

Re-hashed in **this** session: `wrangler.toml` `8d66dcee0d6d1ae9…`, `docs/ENVIRONMENTS.md`
`d78dbbaa3988022c…`, `ARCHITECTURAL_DECISIONS.md` `21a72372…`, `src/worker/auth.ts` `13bc20a1…`.
`wrangler.toml` extracted from `ARTIFACTS/WEST_PEEK_OS_PRODUCTION_READY_v1.zip` hashes to the same
`8d66dcee…`, and `diff -r` of the entire `src/worker/` tree against that reference archive reports
**zero differences** — re-run here, not quoted. §3's "do not change application authentication code"
therefore holds at the source. §4's "do not change auth code" and §6's "no application/auth source
files changed" are satisfied by the same diff.

### Validation actually executed in this session (node v26.4.0 / npm 11.17.0 / wrangler 4.120.1)

| Check | Command | Result |
|---|---|---|
| Frozen dependency install | `npm ci` | rc=0 |
| Typecheck (`src`, `tests`, `e2e`) | `npm run typecheck` | rc=0 |
| Unit/integration | `npm run test` | rc=0 — **546/546**, 31 files, 69.17s |
| Build | `npm run build` | rc=0; `dist/client` present (index.html, assets/, sw.js, manifest.webmanifest, icon.svg, wp-mark.svg) |
| Authority boundary | `npm run validate:authority` | rc=0 — PASS + self-test 4/4 + seeds fresh (45 machines / 15 domains / 53 reserved actions / 204 action types) |
| AI boundary | `npm run validate:ai-boundary` | rc=0 — PASS + self-test 5/5 + seeds fresh (31 employees, all INACTIVE) |
| Network boundary | `npm run validate:network-boundary` | rc=0 — PASS + self-test 6/6 |
| Brand | `npm run validate:brand` | rc=0 — PASS + self-test 9/9 |
| Browser journeys | `npm run e2e` | rc=0 — **66/66** chromium, 38.8s, clean on first attempt |
| Migrations | `npm run migrate:local` | rc=0 — "No migrations to apply!" (idempotent) |
| **Production profile resolves as production** | `npx wrangler deploy --dry-run --env production` | rc=0, **not deployed** |
| **Top-level profile stays local** | `npx wrangler deploy --dry-run` | rc=0, **not deployed** |

Both dry-runs ended at `--dry-run: exiting now.`, and neither log contains an `Uploaded`,
`Deployed`, or `Published` line (checked, not assumed). Nothing was published, migrated, or
configured remotely; no Cloudflare resource was created or altered; **no Cloudflare API call was
made in this session**. Load average at start: 4.36 — higher than the previous pass's 2.47, which is
why `test` took 69.17s against 66.9s. Both suites were green regardless.

**No secrets packaged.** No `.dev.vars`, `.env`, `*.pem`, `*.key`, `*.p12`, `*.pfx` or `id_rsa*`
file exists anywhere in the package, including `backups/` and `.wrangler/`. A value-shaped scan
(`sk-…`, `sk-or-v1-…`, `AKIA…`, `ghp_…`, `xox…`, JWT, PEM headers) returns four hits, each a
deliberate fixture proving credential-shaped input is *blocked* or *redacted*:
`tests/workforce.test.ts:323`, `tests/ai.test.ts:245` and `:257`, `e2e/p4-ai.spec.ts:43`.
`scripts/vault/cloudflare-mapping.json` holds a secret **name** only (`OPENROUTER_API_KEY`) with no
value. `.env.example` is names-only apart from `WP_OS_ENV=local`, which is not a secret.

### Files this pass changed

This ledger, and nothing else. A `find` for files modified since this session began — excluding
`node_modules`, `.wrangler`, `dist`, `test-results`, `backups` — returns empty. No application,
worker, client, test, migration, or configuration file was touched, and **no unrelated user work was
reverted**.

### P5 not performed here

This worker implemented and validated; it does not review itself. The mandatory final senior review
gate (`final_review_satisfied`) is owed by a separate worker before host packaging. This worker did
not create the snapshot ZIP, did not commit, push, deploy, or migrate remotely, and did not edit
`STATE.json`, `EXECUTION_IDENTITY.json`, or any artifact-eligibility metadata.

### Still UNPROVEN — this section is not deployment readiness

- Remote publish, Cloudflare Access behaviour, and remote D1 migration apply remain **UNPROVEN**.
  Declaring `[env.production]` is configuration; a dry-run is not a deployment.
- A bare `wrangler deploy` with no `--env production` still selects the top-level profile and would
  ship `WP_OS_ENV = "local"`. Approved scope §2.1 requires that profile be preserved unchanged, so
  this is not repairable here: **deployment must specify `--env production`**.
- `preview` still has no profile.
- No AI/vendor provider was called; every provider credential is absent and adapters fail closed.
- The P26 phase 2 Cloudflare mutation (OpenRouter enabled, `OPENROUTER_API_KEY` bound as a Worker
  secret) happened **outside** this run and was neither performed nor verified here. Whether
  `migrations/0024` is applied to remote D1 is not observable locally and is not claimed.
- **The snapshot carries more than the approved scope** — the four post-seal files enumerated in the
  section above are in the tree this run packages. They pass the repository's own full suite, re-run
  green here in its entirety, but they were not designed or reviewed against *this* task.
  `LOCAL_ARTIFACT_VERIFIED` on this run must not be read as design approval of that work.

## P5 — mandatory final senior review, worker generation 3 (2026-08-17)

Same run `20260817T025459Z-23440`, same approved task (SHA-256 `e323bce3…`), handoff checkpoint
SHA-256 `fc109f32…`, `previous_worker: claude`, `reason: claude_implementation_complete`. This is the
P5 gate the implementation worker (generation 2) correctly declined to sign for itself.

**No result was inherited.** Every command below was re-executed in this session, and every approved
clause was re-derived from the tree rather than read out of the section above. Toolchain: node
v26.4.0 / npm 11.17.0 / wrangler 4.120.1 — same as generation 2.

### WORK was unchanged between generation 2 and this review

`wrangler.toml` `8d66dcee…`, `docs/ENVIRONMENTS.md` `d78dbbaa…` (pre-repair),
`ARCHITECTURAL_DECISIONS.md` `21a72372…` and `src/worker/auth.ts` `13bc20a1…` all re-hashed in this
session to the values generation 2 recorded. A `find` for non-generated files modified since the run
opened (21:54:59) returned `IMPLEMENTATION_LEDGER.md` and nothing else — confirming generation 2's
"this ledger, and nothing else" claim rather than accepting it.

### Approved scope §2 — re-verified independently, and by a self-tested assertion

Read clause by clause out of `wrangler.toml`, then re-checked mechanically by a **section-scoped**
contract assertion (comments stripped, file folded into TOML sections, 21 clauses asserted inside
their own sections). Section scoping matters: generation 1 recorded that a whole-file substring check
false-passed a `wrangler.toml` whose production profile had been flipped to `WP_OS_ENV = "local"`,
because the header comment contains that literal text in prose. This assertion was run from `/tmp`
against copies, added no file to the artifact, and was self-tested against planted violations:

| Planted violation | Caught |
|---|---|
| production profile flipped to `WP_OS_ENV = "local"` (§3 security law) | yes |
| top-level local profile flipped to `production` | yes |
| `[env.production.observability]` removed | yes |
| production SPA `not_found_handling` removed | yes |
| production D1 id downgraded to the ADR-007 placeholder | yes |
| production KV id altered | yes |
| assets directory repointed off `./dist/client` | yes |
| local profile repointed at the production D1 | yes |
| production R2 binding removed | yes |
| `name = "west-peek-os"` restatement removed from `[env.production]` | yes |
| secret-shaped value planted in the file | yes |
| *negative control:* comment text changed, configuration untouched | correctly passes |

11/11 caught, negative control passes, then 21/21 clauses PASS against the real file.

| Approved clause | Verified how | Result |
|---|---|---|
| §2.1 top-level/local profile preserved | `npx wrangler deploy --dry-run` (no `--env`) | rc=0, not deployed — `env.WP_OS_ENV ("local")`, placeholder KV `0000…0000` |
| §2.2 explicit `[env.production]` for the existing Worker | `wrangler.toml:72–73` | present; `name = "west-peek-os"` restated |
| §2.3 `WP_OS_ENV="production"` | production dry-run | `env.WP_OS_ENV ("production")` |
| §2.4 D1 / KV / R2 / assets / SPA / observability | production dry-run + `wrangler.toml:75–100` | `WP_OS_DB (west-peek-os-db)` id `1d7c242b…`, `WP_OS_KV (bf0750e8e9a648758a5de978088c97da)`, `WP_OS_DOCUMENTS (west-peek-os-documents)`, `ASSETS` over 8 files from `./dist/client`, SPA handling, observability enabled |
| §2.5 production/ADR documentation | read in full; one defect found and repaired (below) | ADR-007 accurate as written; `docs/ENVIRONMENTS.md` repaired |

### The one defect this review found and repaired

`docs/ENVIRONMENTS.md` claimed of the production profile that **"it cannot be selected by accident,
and `WP_OS_ENV` can no longer arrive as `local` in a deployed Worker."** That is false, and it is
false on the exact axis §3 exists to protect. Measured in this session: `npx wrangler deploy
--dry-run` with no `--env` resolves `env.WP_OS_ENV ("local")` against the top-level `name =
"west-peek-os"` — the same Worker. Wrangler 4.120.1 emits a WARNING that environments are defined
and none was specified; it does **not** refuse. So a bare `wrangler deploy` would publish the local
profile to the production Worker, and the operator-facing environment document said that was
impossible.

Both prior sections of this ledger record the accurate fact in their "still UNPROVEN" lists, so the
run knew it — but a deployer reads `docs/ENVIRONMENTS.md`, not this ledger's footnotes. A false
safety claim in the production environment document is a false-completion claim, which the
finalization protocol requires repairing rather than reporting.

**Repair (documentation only, within approved scope §2.5):** the overstatement is replaced with what
the profile actually buys, followed by an explicit statement that `--env production` is a *required
part of the deploy procedure, not a convenience*, that a bare deploy still ships `WP_OS_ENV =
"local"`, and that wrangler's warning is the only guard. Both dry-run resolutions are quoted as the
evidence. `docs/ENVIRONMENTS.md` `d78dbbaa…` → `a24dc13b528214f250c9da2dab5917f8781e23f2a889d924bd9fcfb75e458a4c`.

**Deliberately NOT repaired in `wrangler.toml`.** The clean fix — making the top-level profile
unusable for deployment — would mutate the local profile, which approved scope §2.1 requires be
preserved unchanged. The defect is therefore corrected where scope allows: in the documentation that
describes the contract. Deployment remains procedurally gated on `--env production`.

### Validation actually executed in this session

| Check | Command | Result |
|---|---|---|
| Frozen dependency install | `npm ci` | rc=0 |
| Typecheck (`src`, `tests`, `e2e`) | `npm run typecheck` | rc=0 |
| Unit/integration | `npm run test` | rc=0 — **546/546**, 31 files |
| Build | `npm run build` | rc=0; `dist/client` present (index.html, assets/, sw.js, manifest.webmanifest, icon.svg, wp-mark.svg) |
| Authority boundary | `npm run validate:authority` | rc=0 — PASS + self-test 4/4 + seeds fresh (45 machines / 15 domains / 53 reserved actions / 204 action types) |
| AI boundary | `npm run validate:ai-boundary` | rc=0 — PASS + self-test 5/5 + seeds fresh (31 employees, all INACTIVE) |
| Network boundary | `npm run validate:network-boundary` | rc=0 — PASS + self-test 6/6 |
| Brand | `npm run validate:brand` | rc=0 — PASS + self-test 9/9 |
| Browser journeys | `npm run e2e` | rc=0 — **66/66** chromium, 38.9s, clean on first attempt |
| Migrations | `npm run migrate:local` | rc=0 — "No migrations to apply!" (idempotent) |
| **Production profile resolves as production** | `npx wrangler deploy --dry-run --env production` | rc=0, **not deployed** |
| **Top-level profile stays local** | `npx wrangler deploy --dry-run` | rc=0, **not deployed** |
| Production contract clauses | section-scoped assertion, self-tested 11/11 | 21/21 PASS |

After the documentation repair, the seven declared scripts (typecheck, test, build, and the four
boundary/brand validators) were **re-run from the locked target root** as
`npm --prefix west-peek-os run <script>` — all seven rc=0, 546/546 again. Both dry-runs used
`--outdir /tmp/...` so no bundle output entered the artifact; both ended at `--dry-run: exiting now.`
and neither log contains an `Uploaded`, `Deployed`, `Published`, or `Current Version ID` line
(grepped, not assumed). **No Cloudflare API call was made in this session**; nothing was published,
migrated, or configured remotely, and no Cloudflare resource was created or altered.

**No secrets packaged** (re-scanned here, not inherited). No `.dev.vars`, `.env`, `*.pem`, `*.key`,
`*.p12`, `*.pfx`, `*.jks`, `id_rsa*`, or `credentials.json` exists anywhere in the package outside
`node_modules`. A value-shaped scan (`sk-…`, `AKIA…`, `ghp_…`, `xox…`, JWT, PEM headers) over `src`,
`tests`, `e2e`, `scripts`, `docs`, `migrations` and the config files returns four hits, each a
deliberate fixture proving credential-shaped input is *blocked* or *redacted*
(`tests/workforce.test.ts:323`, `tests/ai.test.ts:245` and `:257`, `e2e/p4-ai.spec.ts:43`). The same
scan over `backups/`, `.wrangler/`, `dist/` and `test-results/` returns nothing.
`scripts/vault/cloudflare-mapping.json` holds a secret **name** only; `.env.example` is names-only
apart from `WP_OS_ENV=local`, which is not a secret. `wrangler.toml` carries no secret value — only
the non-secret D1/KV/R2 identifiers.

**No application or auth source file changed.** Every file under `src/worker/` carries an Aug 10–12
mtime, well before this run opened, and `src/worker/auth.ts` re-hashes to `13bc20a1…`. The dev
identity header is still gated on `env.WP_OS_ENV === "local"` (`src/worker/auth.ts:28`), so under
`--env production` that branch is unreachable. No unrelated user work was reverted.

### Files this pass changed

`docs/ENVIRONMENTS.md` (the repair above) and this ledger. Nothing else — no application, worker,
client, test, migration, or configuration file was touched. `wrangler.toml` is byte-unchanged at
`8d66dcee…`. This worker did not commit, push, deploy, migrate remotely, create the snapshot ZIP, or
edit `STATE.json`, `EXECUTION_IDENTITY.json`, or any artifact-eligibility metadata.

### Still UNPROVEN after this review

- Remote publish, Cloudflare Access behaviour, and remote D1 migration apply remain **UNPROVEN**.
  Declaring `[env.production]` is configuration; a dry-run is not a deployment. Nothing in this run
  touched the live Worker, and `west-peek-os.seq-taylor.workers.dev` was never contacted.
- **Deployment must specify `--env production`.** A bare `wrangler deploy` still ships the local
  profile; §2.1 forbids repairing that in the top-level profile, so it stays a procedural gate,
  now stated plainly in `docs/ENVIRONMENTS.md`.
- `preview` still has no profile.
- No AI/vendor provider was called; every provider credential is absent and adapters fail closed.
  Whether `migrations/0024` is applied to remote D1 is not observable locally and is not claimed.
- The P26 phase 2 Cloudflare mutation (OpenRouter enabled, `OPENROUTER_API_KEY` bound as a Worker
  secret) happened **outside** this run and was neither performed nor verified here.
- **The snapshot carries more than the approved scope** — the post-seal P26 files are in the tree
  this run packages. They pass the repository's own full suite, re-run green here in its entirety,
  but they were not designed or reviewed against *this* task. `LOCAL_ARTIFACT_VERIFIED` must not be
  read as design approval of that work.

Approved scope §2.1–§2.5 is satisfied, §3's security law holds at the configuration and at the
source, §6's validation surfaces all pass, and the one material defect found was repaired and
re-validated. **This artifact is ready for host packaging.**

## Run `20260817T120811Z-32641` — CONTINUATION, opening worker, generation 1 (2026-08-17)

Same approved task, SHA-256 `e323bce3…`. `RUN SEMANTICS: CONTINUATION`, continuation reason
`prior_implementation_run_exists_for_same_preserved_target;progress_ledger_present`. The prior run
`20260817T025459Z-23440` already reached `LOCAL_ARTIFACT_VERIFIED`
(artifact `…_FULL_SNAPSHOT_20260817T031654Z_a4de7b6fcb6f.zip`, sha256 `bafe3729…`). Per the execution
contract, completed phases were preserved and nothing was restarted from phase zero.
Toolchain: node v26.4.0 / npm 11.17.0 / wrangler 4.120.1.

### Why this run still had real work to do

**The tree changed after the prior run sealed it.** The prior artifact was packaged at 22:16 local;
a `find` for non-generated files modified since that moment returns five files, all written between
22:30 and 22:36 — *after* the seal:

| File | mtime |
|---|---|
| `src/client/styles.css` | Aug 16 22:30 |
| `src/client/pages/EmployeesPage.tsx` | Aug 16 22:30 |
| `e2e/p28-activation-chain.spec.ts` | Aug 16 22:30 |
| `src/worker/services/intelligence.ts` | Aug 16 22:33 |
| `tests/intelligence.test.ts` | Aug 16 22:36 |

This is unrelated user work (P28), not this task's scope. Approved scope §6 forbids reverting it, so
it is preserved — but it means **the tree this run packages is not the tree the prior run
validated**, and a `LOCAL_ARTIFACT_VERIFIED` inherited from that run would be a false-completion
claim. Re-running §6 against the current tree was therefore the substantive work of this run, and
every command below was executed in this session. No result was inherited.

### The approved-scope surface is byte-unchanged

Re-hashed in this session, not read out of the prior section:

- `wrangler.toml` → `8d66dcee0d6d1ae94cee991a9790746e847209b043119af0ffd7472ca396ae82` (unchanged)
- `docs/ENVIRONMENTS.md` → `a24dc13b528214f250c9da2dab5917f8781e23f2a889d924bd9fcfb75e458a4c` (prior run's repair intact)
- `ARCHITECTURAL_DECISIONS.md` → `21a723721624b95c8da896a53f3af7ba67375bead64a74b8c88d61ba573e47f8` (unchanged)
- `src/worker/auth.ts` → `13bc20a1207654f15a026b52466535582aca2a01f416d19e2c3feb86fdfcffc6` (unchanged, mtime Aug 10)

**No approved-scope change was needed or made in this run.** §2.1–§2.5 were already satisfied by the
prior run; this generation verified them rather than reapplying them.

### The post-seal work does not touch the auth or environment contract

Checked rather than assumed. Of the five changed files, only one (`src/worker/services/intelligence.ts`)
is under `src/worker/`, and it is application code, not auth code: it *consumes* the authorization
boundary (`authorize(...)` gates every mutation path, `decision !== "ALLOW"` → 403) and imports the
identity type, but defines no identity behavior. Grepping all five for `WP_OS_ENV`, `Cf-Access`, and
`x-wpos-dev-user` returns no hit in any source file; the only `x-wpos-dev-user` occurrence is in the
e2e spec, which is local-profile-only and where the header is refused outside `WP_OS_ENV=local`
anyway. `src/worker/auth.ts` is byte-unchanged with an Aug 10 mtime, and the dev-identity branch is
still gated at `src/worker/auth.ts:28`. The authority validator — which independently proves the new
code routes through `authorize()` and adds no outbound fetch — passes over the changed tree.

### §2/§3 contract assertion — independently rebuilt and self-tested

A section-scoped assertion was written fresh in this session (in `/tmp`, run against a copy, adding
no file to the artifact). Section scoping is required: a whole-file substring check false-passes,
because the header comment contains `WP_OS_ENV = "local"` in prose.

The self-test found a genuine gap in the assertion's own clause set and it was fixed rather than
waved through. A "production R2 binding removed" mutation went **undetected** on the first pass: the
mutation used an unanchored `replace()`, which hit the *first* `[[r2_buckets]]` — the top-level one —
and no clause asserted that the **local** profile's bindings survive, even though §2.1 requires that
profile preserved. Fix: anchor the mutation to the production section, and add six §2.1 clauses
covering the local D1/KV/R2/assets bindings. Result: **13/13 planted violations caught** (including
production-flipped-to-local, local-flipped-to-production, observability removed, SPA handling
removed, D1 id downgraded to placeholder, KV id altered, assets repointed, both R2 removals, local
assets binding removed, `name` restatement removed, planted secret value, local D1 repointed at the
production database), negative control (comments rewritten, configuration untouched) correctly
passes, then **25/25 clauses PASS** against the real file.

### Validation actually executed in this session

| Check | Command | Result |
|---|---|---|
| Frozen dependency install | `npm ci` | rc=0 (platform binaries for esbuild/workerd present despite npm's allow-scripts warning) |
| Typecheck (`src`, `tests`, `e2e`) | `npm run typecheck` | rc=0 |
| Unit/integration | `npm run test` | rc=0 — **547/547**, 31 files |
| Build | `npm run build` | rc=0; `dist/client` present (index.html, assets/, sw.js, manifest.webmanifest, icon.svg, wp-mark.svg) |
| Authority boundary | `npm run validate:authority` | rc=0 — PASS + self-test 4/4 + seeds fresh (45 machines / 15 domains / 53 reserved actions / 204 action types) |
| AI boundary | `npm run validate:ai-boundary` | rc=0 — PASS + self-test 5/5 + seeds fresh (31 employees, all INACTIVE) |
| Network boundary | `npm run validate:network-boundary` | rc=0 — PASS + self-test 6/6 |
| Brand | `npm run validate:brand` | rc=0 — PASS + self-test 9/9 |
| Browser journeys | `npm run e2e` | rc=0 — **67/67** chromium, 43.2s, clean on first attempt |
| Migrations | `npm run migrate:local` | rc=0 — "No migrations to apply!" (idempotent) |
| **Production profile resolves as production** | `npx wrangler deploy --dry-run --env production` | rc=0, **not deployed** |
| **Top-level profile stays local** | `npx wrangler deploy --dry-run` | rc=0, **not deployed** |
| Production contract clauses | section-scoped assertion, self-tested 13/13 | 25/25 PASS |

Counts moved with the post-seal work exactly as expected: unit 546 → **547**, e2e 66 → **67**. Both
increases come from the user's P28 files, and both suites are green.

Production dry-run resolved `env.WP_OS_ENV ("production")`, `env.WP_OS_DB (west-peek-os-db)` id
`1d7c242b…`, `env.WP_OS_KV (bf0750e8e9a648758a5de978088c97da)`,
`env.WP_OS_DOCUMENTS (west-peek-os-documents)`, and `env.ASSETS` over 8 files from `./dist/client`.
The top-level dry-run resolved `env.WP_OS_ENV ("local")` with the placeholder KV `0000…0000`,
confirming §2.1 preservation.

**Nothing was deployed and no Cloudflare API call was made.** Both dry-runs used
`--outdir /tmp/...` so no bundle entered the artifact, both ended at `--dry-run: exiting now.`, and
a grep of both logs for `Uploaded`, `Deployed`, `Published`, `Current Version ID`, and the production
hostname returns **no hit** (grepped, not assumed). `west-peek-os.seq-taylor.workers.dev` was never
contacted. No Cloudflare resource was created, altered, or configured; no remote migration was
applied; Cloudflare Access was not touched.

### No secrets packaged (re-scanned here, not inherited)

No `.dev.vars`, `.env`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `id_rsa*`, or `credentials.json`
exists anywhere in the package outside `node_modules`. A value-shaped scan (`sk-…`, `AKIA…`, `ghp_…`,
`xox…`, JWT, PEM headers) over `src`, `tests`, `e2e`, `scripts`, `docs`, `migrations` and the config
files returns the same four hits as the prior run, each re-read in this session and each a deliberate
fixture proving credential-shaped input is *blocked or redacted* — `tests/workforce.test.ts:323`,
`tests/ai.test.ts:245` and `:257` (asserts `EGRESS_BLOCKED`, `credential_like_content`, and that the
failure reason never contains the secret itself), `e2e/p4-ai.spec.ts:43`. The same scan over
`backups/`, `.wrangler/`, `dist/` and `test-results/` returns nothing. `.env.example` is names-only
apart from `WP_OS_ENV=local`, which is not a secret; `scripts/vault/cloudflare-mapping.json` holds a
secret **name** only; `wrangler.toml` carries only the non-secret D1/KV/R2 identifiers.

### §2.5 documentation re-checked for accuracy, not just presence

`docs/ENVIRONMENTS.md` claims a bare `wrangler deploy` still publishes `WP_OS_ENV = "local"` to the
`west-peek-os` Worker, that wrangler warns but does **not** refuse, and that `--env production` is a
required part of the deploy procedure rather than a convenience. Both dry-runs executed in *this*
session reproduce exactly that, so the document is accurate as written. ADR-007's placeholder
rationale still matches the top-level profile.

### Files this pass changed

**This ledger, and nothing else.** No application, worker, client, test, migration, configuration, or
documentation file was touched in this run — `wrangler.toml` remains `8d66dcee…` and
`docs/ENVIRONMENTS.md` remains `a24dc13b…`. This worker did not commit, push, deploy, migrate
remotely, create the snapshot ZIP, or edit `STATE.json`, `EXECUTION_IDENTITY.json`, deployment
history, or artifact-eligibility metadata.

### Review independence — stated plainly

This generation both ran the verification and wrote this record. Because **no approved-scope mutation
was made in this run**, there is no new implementation change for an independent P5 reviewer to
review; the substantive claim here is a validation result, and every command backing it is named
above so it can be re-executed. The prior run's independent P5 (generation 3) remains the last review
of an actual change. Whether to run a separate final-review worker is the host's gate, not this
worker's to sign — `final_review_satisfied` is left as the host set it.

### Still UNPROVEN after this run

- Remote publish, Cloudflare Access behaviour, and remote D1 migration apply remain **UNPROVEN**.
  Declaring `[env.production]` is configuration; a dry-run is not a deployment.
- **Deployment must specify `--env production`.** A bare `wrangler deploy` still ships the local
  profile; §2.1 forbids repairing that in the top-level profile, so it stays a procedural gate.
- `preview` still has no profile.
- No AI/vendor provider was called; every provider credential is absent and adapters fail closed.
  Whether `migrations/0024` is applied to remote D1 is not observable locally and is not claimed.
- The P26 phase 2 Cloudflare mutation (OpenRouter enabled, `OPENROUTER_API_KEY` bound as a Worker
  secret) happened **outside** this run and was neither performed nor verified here.
- **The snapshot carries more than the approved scope.** Beyond the earlier post-seal P26 files, this
  run's tree also carries the five P28 files listed at the top of this section. They pass the
  repository's full suite, re-run green here in its entirety, but they were not designed or reviewed
  against *this* task. `LOCAL_ARTIFACT_VERIFIED` on this run must not be read as design approval of
  that work.

Approved scope §2.1–§2.5 is satisfied and byte-unchanged, §3's security law holds at the
configuration and at the source, and §6's validation surfaces all pass against the **current** tree
including the post-seal user work. **This artifact is ready for host packaging.**

## Run `20260817T120811Z-32641` — CONTINUATION, implementation worker, generation 2 (2026-08-17)

Same approved task, SHA-256 `e323bce3…`, same run as the generation-1 section above. Handoff
checkpoint `previous_role: opening`, `reason: claude_planning_complete`, `next_worker:
capacity_routed_implementation`, `open_gaps: []`. Per the execution contract, intake and planning
were not redone and no completed phase was restarted.
Toolchain confirmed in this session: node v26.4.0 / npm 11.17.0 / wrangler 4.120.1.

### Remaining approved implementation scope: none — verified, not assumed

`wrangler.toml` already carries the full §2 contract. Re-hashed at the start of this session, before
any command was run:

| File | sha256 | State |
|---|---|---|
| `wrangler.toml` | `8d66dcee0d6d1ae94cee991a9790746e847209b043119af0ffd7472ca396ae82` | unchanged |
| `docs/ENVIRONMENTS.md` | `a24dc13b528214f250c9da2dab5917f8781e23f2a889d924bd9fcfb75e458a4c` | unchanged |
| `ARCHITECTURAL_DECISIONS.md` | `21a723721624b95c8da896a53f3af7ba67375bead64a74b8c88d61ba573e47f8` | unchanged |
| `src/worker/auth.ts` | `13bc20a1207654f15a026b52466535582aca2a01f416d19e2c3feb86fdfcffc6` | unchanged, mtime Aug 10 |

A `find` for non-generated files modified since the generation-1 seal (12:16:50Z) returns
`IMPLEMENTATION_LEDGER.md` and nothing else. **No approved-scope mutation was required and none was
made.** §2.1–§2.5 were satisfied before this generation started.

### Why the generation-1 validation was re-run rather than inherited

The contract forbids claiming validation that did not run, and generation 1 was a different worker.
The tree was materially unchanged between the two generations, so inheriting would have been
defensible — but the claim would then have been generation 1's, not this worker's. Every command
below was executed in this session, and all counts are read from this session's output.

### Validation actually executed in this session

| Check | Command | Result |
|---|---|---|
| Frozen dependency install | `npm ci` | rc=0 (npm's `allow-scripts` warning is informational; `@esbuild/darwin-arm64` and `@cloudflare/workerd-darwin-arm64` are present and every downstream step that needs them succeeded) |
| Typecheck (`src`, `tests`, `e2e`) | `npm run typecheck` | rc=0 |
| Unit/integration | `npm run test` | rc=0 — **547/547**, 31 files, 70.1s |
| Build | `npm run build` | rc=0 — 53 modules; `dist/client` rebuilt with all 6 artifacts (`index.html`, `assets/`, `sw.js`, `manifest.webmanifest`, `icon.svg`, `wp-mark.svg`) |
| Authority boundary | `npm run validate:authority` | rc=0 — PASS + self-test 4/4 + seeds fresh (45 machines / 15 domains / 53 reserved actions / 204 action types) |
| AI boundary | `npm run validate:ai-boundary` | rc=0 — PASS + self-test 5/5 + seeds fresh (31 employees, all INACTIVE) |
| Network boundary | `npm run validate:network-boundary` | rc=0 — PASS + self-test 6/6 |
| Brand | `npm run validate:brand` | rc=0 — PASS + self-test 9/9 |
| Migrations | `npm run migrate:local` | rc=0 — "No migrations to apply!" (idempotent) |
| Browser journeys | `npm run e2e` | rc=0 — **67/67** chromium, 44.2s, clean on first attempt |
| **Production profile resolves as production** | `npx wrangler deploy --dry-run --env production` | rc=0, **not deployed** |
| **Top-level profile stays local** | `npx wrangler deploy --dry-run` | rc=0, **not deployed** |
| §2/§3 contract clauses | independent section-scoped assertion, self-tested 16/16 | **29/29 PASS** |

Counts match generation 1 exactly (547 unit, 67 e2e), which is the expected result for an unchanged
tree and is stated here as a this-session measurement, not as agreement inherited from that section.

### Dry-run resolution — the two facts §6 actually requires

- `--env production` resolved `env.WP_OS_ENV ("production")`, `env.WP_OS_DB (west-peek-os-db)`,
  `env.WP_OS_KV (bf0750e8e9a648758a5de978088c97da)`,
  `env.WP_OS_DOCUMENTS (west-peek-os-documents)` and `env.ASSETS` over 8 files from `./dist/client`.
- Bare `wrangler deploy --dry-run` resolved `env.WP_OS_ENV ("local")` with the placeholder KV
  `00000000000000000000000000000000`, confirming §2.1 preservation. Wrangler emitted its
  multiple-environments warning and proceeded — it warns, it does not refuse.

**Nothing was deployed and no Cloudflare API call was made.** Both dry-runs wrote their bundle to
`/tmp/wpos-dryrun-{prod,local}-g2` so no build output entered the artifact, both ended at
`--dry-run: exiting now.`, and a grep of both logs for `Uploaded`, `Deployed`, `Published`,
`Current Version ID` and `west-peek-os.seq-taylor.workers.dev` returns **no hit** (grepped, exit 1).
No Cloudflare resource was created or altered, no remote migration was applied, Cloudflare Access was
not touched.

### §2/§3 contract assertion — rebuilt independently, and its self-test caught a harness bug

A section-scoped assertion (29 clauses) was written fresh in this session at
`/tmp/wpos-contract-g2.mjs` — in `/tmp`, run against copies, adding no file to the artifact. Section
scoping plus comment-stripping is required: the file's header comment quotes both
`WP_OS_ENV = "local"` and `WP_OS_ENV = "production"` in prose, so a whole-file substring check
false-passes in both directions.

The first self-test reported only **8/13** caught, and the failure was in the *test harness*, not in
the assertion. The harness split the file with `src.indexOf("[env.production]")`, which matched the
backticked mention inside the header comment at byte ~700 rather than the real section header at byte
3387. Consequences: `head` was 12 comment lines, so three local-profile mutations silently no-oped,
and the two `WP_OS_ENV` flips rewrote comment prose that the assertion correctly ignores. A "MISSED"
line there meant "the mutation never reached any configuration", not "a real violation would ship".

Fixed by anchoring the split to `/^\[env\.production\]$/m`, and the mutation set was widened from 13
to 16 while re-running. Result: **16/16 planted violations caught** — production flipped to local,
local flipped to production, production observability removed, production SPA handling removed,
production D1 id downgraded to the placeholder, production KV id altered, production assets
repointed, production R2 removed, local R2 removed, local assets binding removed, local SPA handling
removed, local D1 repointed at the production database, local KV repointed at the production KV,
local cron trigger removed, production `name` restatement removed, and a planted secret value. The
negative control (every comment rewritten, configuration untouched) correctly still passes, proving
the clauses bind to configuration rather than to prose. Against the real file: **29/29 PASS**.

### §2.5 documentation checked for accuracy, not just presence

`docs/ENVIRONMENTS.md:29–37` asserts that a bare `wrangler deploy` still selects the top-level LOCAL
profile and would publish `WP_OS_ENV = "local"` to the `west-peek-os` Worker, that wrangler warns but
does not refuse, and that `--env production` is therefore a required part of the deploy procedure
rather than a convenience. Both dry-runs executed in *this* session reproduce that behaviour exactly,
including the warning text, so the document is accurate as written. `ARCHITECTURAL_DECISIONS.md`
ADR-007 (amended) records the placeholder/real-id separation and ADR-006 records the
`WP_OS_ENV=local`-gated dev header; both match the file and the code. §2.5 needs no update.

### No secrets packaged (re-scanned here, not inherited)

No `.dev.vars*`, `.env`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `id_rsa*` or `credentials.json`
exists anywhere in the package outside `node_modules`. A value-shaped scan (`sk-…`, `AKIA…`, `ghp_…`,
`xox…`, JWT, PEM headers) over `src`, `tests`, `e2e`, `scripts`, `docs`, `migrations`, `wrangler.toml`,
`package.json` and `.env.example` returns four hits, each re-read in this session and each a
deliberate synthetic fixture proving credential-shaped input is blocked or redacted:
`tests/workforce.test.ts:323`, `tests/ai.test.ts:245` and `:257` (which asserts the failure reason
never contains the secret), `e2e/p4-ai.spec.ts:43`. The assertion's own no-secret clause passes over
`wrangler.toml`, which carries only the non-secret D1/KV/R2 identifiers.

### Files this pass changed

**This ledger, and nothing else.** No application, worker, client, test, migration, configuration or
documentation file was touched — the four approved-scope hashes above re-hash identically *after* the
full validation run. Regenerated-only paths (`node_modules/`, `dist/client/`, `.wrangler/`,
`test-results/`) were rebuilt by the validation itself. This worker did not commit, push, deploy,
migrate remotely, create the snapshot ZIP, or edit `STATE.json`, `EXECUTION_IDENTITY.json`,
deployment history, or artifact-eligibility metadata.

### Review independence — stated plainly

This generation independently re-executed the validation that generation 1 recorded, which is a real
second observation of the same tree. It is **not** a substitute for P5: no approved-scope change was
made in this run, so there is no new implementation change for an independent senior reviewer to
review, and the last review of an actual change remains the prior run's generation-3 P5.
`final_review_satisfied` is left exactly as the host set it — that gate is the host's to sign.

### Still UNPROVEN after this run

- Remote publish, Cloudflare Access behaviour, and remote D1 migration apply remain **UNPROVEN**.
  Declaring `[env.production]` is configuration; a dry-run is not a deployment.
- **Deployment must specify `--env production`.** A bare `wrangler deploy` still ships the local
  profile — reconfirmed by dry-run here. §2.1 forbids repairing that in the top-level profile, so it
  stays a procedural gate.
- `preview` still has no profile.
- No AI/vendor provider was called; provider credentials are absent and adapters fail closed.
  Whether `migrations/0024` is applied to remote D1 is not observable locally and is not claimed.
- The P26 phase 2 Cloudflare mutation (OpenRouter enabled, `OPENROUTER_API_KEY` bound as a Worker
  secret) happened **outside** this run and was neither performed nor verified here.
- **The snapshot carries more than the approved scope** — the post-seal P26 and P28 user files
  described in the generation-1 section above. They re-run green across the entire suite here, but
  they were not designed or reviewed against *this* task. `LOCAL_ARTIFACT_VERIFIED` on this run must
  not be read as design approval of that work.

Approved scope §2.1–§2.5 is satisfied and byte-unchanged, §3's security law holds at the
configuration and at the source, and every §6 validation surface passes against the current tree as
executed by this worker. **This artifact is ready for host packaging (P6).**

## Run `20260817T120811Z-32641` — P5 mandatory final senior review, generation 3 (2026-08-17)

Same approved task, SHA-256 `e323bce3…`, same run as the two sections above. Handoff checkpoint
`previous_role: implementation`, `reason: claude_implementation_complete`, `next_worker: claude`,
`open_gaps: []`, checkpoint sha256 `18845e2c…`. Repair-capable finalization pass: nothing was
restarted and no completed phase was rebuilt. Toolchain confirmed in this session: node v26.4.0 /
npm 11.17.0 / wrangler 4.120.1.

### Scope surface re-hashed before any command ran

| File | sha256 | State |
|---|---|---|
| `wrangler.toml` | `8d66dcee0d6d1ae94cee991a9790746e847209b043119af0ffd7472ca396ae82` | matches generations 1–2 |
| `docs/ENVIRONMENTS.md` | `a24dc13b528214f250c9da2dab5917f8781e23f2a889d924bd9fcfb75e458a4c` | matches |
| `ARCHITECTURAL_DECISIONS.md` | `21a723721624b95c8da896a53f3af7ba67375bead64a74b8c88d61ba573e47f8` | matches |
| `src/worker/auth.ts` | `13bc20a1207654f15a026b52466535582aca2a01f416d19e2c3feb86fdfcffc6` | matches, mtime Aug 10 |

A `find` for non-generated files modified since the generation-2 seal returns
`IMPLEMENTATION_LEDGER.md` and nothing else.

### §2 read clause by clause against the file, not against the prior record

`wrangler.toml` was read in full in this session and each approved-scope requirement was checked
directly rather than inherited:

- **§2.1** top level is the LOCAL profile — `WP_OS_ENV = "local"` (`[vars]`), D1 `database_id`
  `00000000-0000-0000-0000-000000000000`, KV `id` `0000…0000`, its own assets/R2 bindings and the
  ADR-017 cron all intact. Unchanged.
- **§2.2** `[env.production]` exists and restates `name = "west-peek-os"`, so the named environment
  targets the existing proven Worker rather than `west-peek-os-production`.
- **§2.3** `[env.production.vars] WP_OS_ENV = "production"`.
- **§2.4** `[[env.production.d1_databases]]` `west-peek-os-db` / `1d7c242b-fddc-41f1-843c-03dd2db6fbef`
  with `migrations_dir`; `[[env.production.kv_namespaces]]` `bf0750e8e9a648758a5de978088c97da`;
  `[[env.production.r2_buckets]]` `west-peek-os-documents`; `[env.production.assets]`
  `directory = "./dist/client"`, `binding = "ASSETS"`,
  `not_found_handling = "single-page-application"`; `[env.production.observability] enabled = true`.
- **§2.5** `docs/ENVIRONMENTS.md` and `ARCHITECTURAL_DECISIONS.md` (ADR-006, ADR-007 amended) were
  read and checked for *accuracy*, not presence — see below.

### §3 security law checked at the source, not only at the config

`src/worker/auth.ts` selects the identity header by environment at line 28: `x-wpos-dev-user` only
when `WP_OS_ENV === "local"`, otherwise `Cf-Access-Authenticated-User-Email`. Outside local the dev
header is never read at all, so there is no dev-identity path to bypass. Both branches then require a
known, `ACTIVE` `firm_user` or resolve to null → 401; unauthenticated is denied in every environment.
The file is byte-unchanged from the approved baseline, and no application/auth source file was
modified by this pass.

### Validation actually executed in this session

Every command below was run by this worker; no result is inherited. All commands were additionally
re-run in the form recorded in the finalization evidence — invoked **from the locked target root**
(`npm --prefix west-peek-os …`, `npx … --config west-peek-os/wrangler.toml`) — so the host can rerun
them verbatim from the target it locked.

| Check | Command | Result |
|---|---|---|
| Frozen dependency install | `npm ci` | rc=0 (npm's `allow-scripts` warning is informational; `@esbuild/darwin-arm64` and `@cloudflare/workerd-darwin-arm64` present, every downstream step needing them succeeded) |
| Typecheck (`src`, `tests`, `e2e`) | `npm run typecheck` | rc=0 |
| Build | `npm run build` | rc=0; `dist/client` present with all 6 artifacts |
| Unit/integration | `npm run test` | rc=0 — **547/547**, 31 files, 67.4s |
| Authority boundary | `npm run validate:authority` | rc=0 — PASS + self-test 4/4 + seeds fresh (45 machines / 15 domains / 53 reserved actions / 204 action types) |
| AI boundary | `npm run validate:ai-boundary` | rc=0 — PASS + self-test 5/5 + 31 employees, all INACTIVE |
| Network boundary | `npm run validate:network-boundary` | rc=0 — PASS + self-test 6/6 |
| Brand | `npm run validate:brand` | rc=0 — PASS + self-test 9/9 |
| Migrations | `npm run migrate:local` | rc=0 — "No migrations to apply!" (idempotent) |
| Browser journeys | `npm run e2e` | rc=0 — **67/67** chromium, 42.7s, clean first attempt |
| **Production profile resolves as production** | `wrangler deploy --dry-run --env production` | rc=0, **not deployed** |
| **Top-level profile stays local** | `wrangler deploy --dry-run` | rc=0, **not deployed** |

Counts match generations 1 and 2 exactly (547 unit, 67 e2e) on an unchanged tree, stated here as this
session's own measurement.

### The two dry-run facts §6 requires

- `--env production` resolved `env.WP_OS_ENV ("production")`, `env.WP_OS_DB (west-peek-os-db)`,
  `env.WP_OS_KV (bf0750e8e9a648758a5de978088c97da)`,
  `env.WP_OS_DOCUMENTS (west-peek-os-documents)` and `env.ASSETS`.
- Bare `wrangler deploy --dry-run` resolved `env.WP_OS_ENV ("local")` with the placeholder KV
  `00000000000000000000000000000000` — §2.1 preservation confirmed behaviourally, not just textually.

**Nothing was deployed and no Cloudflare API call was made.** Every dry-run wrote its bundle to a
`/tmp` outdir so no build output entered the artifact, each ended at `--dry-run: exiting now.`, and a
grep of all four dry-run logs for `Uploaded`, `Deployed`, `Published`, `Current Version ID` and
`seq-taylor.workers.dev` returns no hit (grepped, exit 1). `west-peek-os.seq-taylor.workers.dev` was
never contacted. No Cloudflare resource was created or altered, no remote migration was applied,
Cloudflare Access was not touched.

### §2.5 documentation checked for accuracy

`docs/ENVIRONMENTS.md:29–37` claims a bare `wrangler deploy` still selects the top-level LOCAL profile
and would publish `WP_OS_ENV = "local"`, that wrangler warns but does not refuse, and that
`--env production` is therefore a required part of the deploy procedure rather than a convenience.
The dry-runs executed in *this* session reproduce exactly that. ADR-006 matches `auth.ts:28`; ADR-007
(amended) matches the placeholder/real-id split actually present in the file. §2.5 needs no update.

### No secrets packaged (re-scanned here)

No `.dev.vars*`, `.env`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `id_rsa*` or `credentials.json`
exists anywhere in the package outside `node_modules`. A value-shaped scan (`sk-…`, `AKIA…`, `ghp_…`,
`xox…`, JWT, PEM headers) over `src`, `tests`, `e2e`, `scripts`, `docs`, `migrations`,
`wrangler.toml`, `package.json` and `.env.example` returns four hits, each re-read in this session and
each a synthetic fixture asserting that credential-shaped input is blocked or redacted:
`tests/workforce.test.ts:323`, `tests/ai.test.ts:245` and `:257` (which asserts the failure reason
never contains the secret), `e2e/p4-ai.spec.ts:43`. The same scan over `backups/`, `.wrangler/`,
`dist/` and `test-results/` returns nothing. `wrangler.toml` carries only the non-secret D1/KV/R2
identifiers.

### Defects found by this review: none requiring repair

The full approved scope was inspected, not a coherent subset. No omission, stub, TODO, architectural
drift, regression, auth/security gap, failure-path gap, broken migration, invalid validator, or
false-completion claim was found within approved scope. `repairs_applied: false` is therefore a
finding, not an omission — the two prior generations' records were checked against the files and the
re-executed commands and every claim in them held.

One item was considered for repair and deliberately not repaired: a bare `wrangler deploy` would ship
the LOCAL profile to the `west-peek-os` Worker, which §3 forbids. Fixing that in the top-level profile
is prohibited by §2.1 (preserve it unchanged) and fixing it in application code is prohibited by §3
and §5. It is correctly carried as a documented procedural gate in `docs/ENVIRONMENTS.md` rather than
silently repaired outside approved scope.

### Files this pass changed

**This ledger, and nothing else.** The four approved-scope hashes re-hash identically *after* the full
validation run. Regenerated-only paths (`node_modules/`, `dist/client/`, `.wrangler/`,
`test-results/`) were rebuilt by the validation itself. This worker did not commit, push, deploy,
migrate remotely, move or rename WORK, create the snapshot ZIP, or edit `STATE.json`,
`EXECUTION_IDENTITY.json`, deployment history, or artifact-eligibility metadata.

### Still UNPROVEN after this run — external only

- Remote publish, Cloudflare Access behaviour, and remote D1 migration apply remain **UNPROVEN**.
  Declaring `[env.production]` is configuration; a dry-run is not a deployment.
- **Deployment must specify `--env production`.** Procedural gate, per the paragraph above.
- `preview` still has no profile.
- No AI/vendor provider was called; provider credentials are absent and adapters fail closed. Whether
  `migrations/0024` is applied to remote D1 is not observable locally and is not claimed.
- The P26 phase 2 Cloudflare mutation (OpenRouter enabled, `OPENROUTER_API_KEY` bound as a Worker
  secret) happened **outside** this run and was neither performed nor verified here.
- **The snapshot carries more than the approved scope** — the post-seal P26 and P28 user files
  described in the generation-1 section. §6 forbids reverting unrelated user work, so they are
  preserved. They re-run green across the entire suite here, but they were not designed or reviewed
  against *this* task, and `LOCAL_ARTIFACT_VERIFIED` must not be read as design approval of them.

Approved scope §2.1–§2.5 is satisfied, §3's security law holds at the configuration and at the
source, and every §6 validation surface passes against the current tree as executed by this reviewer.
**P5 complete — ACCEPT. Ready for host packaging (P6).**

### Host gate rejection and correction (evidence declaration only)

The first finalization evidence record for this pass was rejected by the host gate with a single
error: `at most eight validation commands may be declared`. Twelve were declared. **No validation
failed and no defect was found** — the rejection was a declaration-format violation, so no file in
the artifact changed and nothing was re-run in response.

The declaration was trimmed to the eight commands that decide the approved scope: frozen install,
typecheck, build (which is what puts `dist/client` in place), the unit/integration suite, the browser
suite, the authority-boundary validator (the §3-relevant one), and the two dry-runs that prove the
production profile resolves as production while the top-level profile stays local.

`validate:ai-boundary`, `validate:network-boundary`, `validate:brand` and `migrate:local` are **not**
dropped from the review — all four were executed in this session from the locked target root and all
four returned rc=0, as recorded in the validation table above. They are omitted from the declared
eight only because of the host cap, and the table remains the record that they ran.

### Second host gate rejection — `wrangler deploy` is not an allowed proof token

The host gate rejected the trimmed evidence for a second, different reason: both declared dry-run
commands carry the forbidden proof token `wrangler deploy`, even with `--dry-run`. The host will not
rerun a deploy-shaped command at all. **No validation failed here either** — this is a constraint on
what may be *declared* for host re-execution, not a finding against the artifact.

`npx wrangler check startup --env production` was evaluated as a non-deploy substitute and rejected
on the merits: it returns rc=0 but prints only bundle/CPU-profile data, never the resolved
environment vars or bindings, so it does not prove either §6 fact. It also wrote
`worker-startup.cpuprofile` into the package; that file was deleted immediately and a `find` for
`*.cpuprofile` outside `node_modules` now returns nothing.

**What replaced them.** Two standalone, read-only `node -e` assertions that prove the same two §6
facts directly from `wrangler.toml`, and which the host can safely rerun from the locked target:

- *production profile resolves as production* — asserts, scoped to the `[env.production]` section
  only: `name` restated as `west-peek-os`, `WP_OS_ENV = "production"` with no `local` anywhere in the
  section, D1 `west-peek-os-db` / `1d7c242b…` (explicitly not the placeholder), KV `bf0750e8…`, R2
  `west-peek-os-documents`, assets `./dist/client` bound as `ASSETS` with
  `not_found_handling = "single-page-application"`, and `observability enabled = true`; plus a
  whole-file secret-shaped-value scan.
- *top-level local profile remains preserved* — asserts, scoped to everything **before**
  `[env.production]`: `WP_OS_ENV = "local"` and never `production`, the ADR-007 placeholder D1 and KV
  ids, that neither production identifier appears in the local profile at all, and that the local R2
  and `ASSETS` bindings, SPA handling and the ADR-017 cron all survive.

Both strip comment lines before matching and anchor the section split to `/^\[env\.production\]$/m`.
Both precautions are load-bearing: `wrangler.toml` quotes `WP_OS_ENV = "local"` in prose at line 4 and
mentions `[env.production]` in the header comment, so an unscoped check false-passes.

**Self-tested, and the self-test caught a harness bug before it could flatter the result.** The first
run reported 16/17, with `local flipped to production` MISSED. The assertion was not at fault: the
mutation used an unanchored `replace()`, which hit the line-4 *comment* rather than the real `[vars]`
line 49, so the mutated file's configuration was never actually changed — the same harness-bug class
generation 2 hit. Anchoring the mutation to `/^WP_OS_ENV = "local"$/m` and adding two further
mutations gives **19/19 planted violations caught**: production flipped to local, production
observability / SPA handling / R2 / `ASSETS` binding / `name` restatement removed, production D1 id
downgraded to the placeholder, production KV id altered, production assets repointed, a planted
secret value, the whole `[env.production]` section deleted, local flipped to production, local
`WP_OS_ENV` deleted, local D1 and KV repointed at the production resources, and local R2 / `ASSETS` /
SPA handling / cron removed. The negative control — every comment rewritten, configuration untouched —
correctly still passes, proving the clauses bind to configuration rather than prose. The harness lives
in `/tmp` and runs against copies; **no file was added to the artifact**.

**The behavioural dry-run evidence is not withdrawn.** `wrangler deploy --dry-run --env production`
and the bare equivalent were both executed in this session (rc=0, bundles written to `/tmp` outdirs,
each ending at `--dry-run: exiting now.`, no `Uploaded`/`Deployed`/`Published`/`Current Version ID`
and no contact with `west-peek-os.seq-taylor.workers.dev`), and they resolved
`env.WP_OS_ENV ("production")` with the real bindings and `env.WP_OS_ENV ("local")` with the
placeholder KV respectively. That remains this reviewer's strongest proof of §6 and is recorded in
the validation table above; it is simply not declarable for host re-execution.

### Third host gate rejection — inline `node -e` proofs are not accepted either

The host rejected both replacement assertions as proof commands. Combined with the second rejection,
the host accepts neither `wrangler deploy --dry-run` (forbidden token) nor an inline `node -e`
program. Across all three rejections the host has never objected to the
`npm --prefix west-peek-os …` shape, so that is the only demonstrably accepted command form and the
declaration is now confined to it.

**There is no existing repo surface that validates `wrangler.toml`.** Checked, not assumed: grepping
`scripts/validate/` and `tests/` for `wrangler.toml` returns nothing, and none of the 21 npm scripts
inspects the deployment profiles. Approved scope §2 limits target changes to the wrangler profile and
the §2.5 documentation, and §6 directs the run to "the repository's **existing** validation
surfaces" — so adding a profile validator to the repo to make this declarable would itself be an
out-of-scope target change. It was therefore not added, matching the precedent set by generations 1
and 2, which also kept their assertions in `/tmp`.

**Consequence, stated plainly rather than papered over.** The two §6 profile facts — *production
profile resolves as production* and *top-level local profile remains preserved* — are **proven, but
not host-declarable**. They were each established twice in this session:

1. **Behaviourally**, by `wrangler deploy --dry-run --env production` resolving
   `env.WP_OS_ENV ("production")` with D1 `west-peek-os-db`/`1d7c242b…`, KV `bf0750e8…`, R2
   `west-peek-os-documents` and `ASSETS`, and by the bare dry-run resolving `env.WP_OS_ENV ("local")`
   with the placeholder KV `0000…0000`. Both rc=0, bundles written to `/tmp` outdirs, both ending at
   `--dry-run: exiting now.`, with no `Uploaded`/`Deployed`/`Published`/`Current Version ID` in either
   log and no contact with `west-peek-os.seq-taylor.workers.dev`.
2. **Statically**, by the two section-scoped assertions described in the previous section, self-tested
   to **19/19** planted violations caught with a passing comments-only negative control.

Neither can be handed to the host for re-execution. That is a limitation of what may be *declared*,
not a gap in what was *verified*, and it is recorded here and in the evidence record rather than
being allowed to read as an unproven scope item.

### Final declared validation — all re-run from the locked target root after the last `npm ci`

| # | Declared command | Result |
|---|---|---|
| 1 | `npm --prefix west-peek-os ci` | rc=0 |
| 2 | `npm --prefix west-peek-os run typecheck` | rc=0 |
| 3 | `npm --prefix west-peek-os run build` | rc=0 — `dist/client` present with all 6 artifacts |
| 4 | `npm --prefix west-peek-os run test` | rc=0 — 547/547, 31 files |
| 5 | `npm --prefix west-peek-os run e2e` | rc=0 — 67/67 chromium |
| 6 | `npm --prefix west-peek-os run validate:authority` | rc=0 — PASS + self-test 4/4 + seeds fresh |
| 7 | `npm --prefix west-peek-os run validate:ai-boundary` | rc=0 — PASS + self-test 5/5 |
| 8 | `npm --prefix west-peek-os run validate:network-boundary` | rc=0 — PASS + self-test 6/6 |

`npm --prefix west-peek-os run validate:brand` (rc=0, self-test 9/9) and
`npm --prefix west-peek-os run migrate:local` (rc=0, "No migrations to apply!") also passed in this
session and are omitted only because of the host's eight-command cap.

The approved-scope files are byte-unchanged after all of the above: `wrangler.toml`
`8d66dcee…`, `docs/ENVIRONMENTS.md` `a24dc13b…`, `ARCHITECTURAL_DECISIONS.md` `21a72372…`,
`src/worker/auth.ts` `13bc20a1…`. Across all three gate rejections **no artifact file was changed in
response to any of them** — every rejection concerned the form of the evidence declaration, not the
state of the work. This ledger remains the only file this reviewer touched.

## Run `20260817T152307Z-47114` — CONTINUATION, opening worker, generation 1 (2026-08-17)

**Run semantics:** CONTINUATION. Task SHA256 `e323bce362ec868e20f229bb8c2501b962916b9dbab580072bea5e27ac266964`
— byte-identical to the task the immediately prior run `20260817T120811Z-32641` executed. That run
sealed at `LOCAL_ARTIFACT_VERIFIED` with P5 ACCEPT. Per the execution contract's continuation clause,
this pass treats the existing WORK and this ledger as authoritative, preserves completed phases, and
does not restart from intake zero.

### P1–P2 — current state established, then compared against the approved contract

The four approved-scope files were hashed **before** any command was run and match the hashes the
prior run recorded at its seal, byte for byte:

| File | SHA256 | vs. prior seal |
|---|---|---|
| `wrangler.toml` | `8d66dcee0d6d1ae94cee991a9790746e847209b043119af0ffd7472ca396ae82` | identical |
| `docs/ENVIRONMENTS.md` | `a24dc13b528214f250c9da2dab5917f8781e23f2a889d924bd9fcfb75e458a4c` | identical |
| `ARCHITECTURAL_DECISIONS.md` | `21a723721624b95c8da896a53f3af7ba67375bead64a74b8c88d61ba573e47f8` | identical |
| `src/worker/auth.ts` | `13bc20a1207654f15a026b52466535582aca2a01f416d19e2c3feb86fdfcffc6` | identical |

Approved scope §2.1–§2.5 was re-read clause-by-clause against `wrangler.toml` rather than inferred
from the prior ledger:

- §2.1 top-level/local profile preserved — `name = "west-peek-os"`, `WP_OS_ENV = "local"`, ADR-007
  placeholder D1 `0000…0000` and KV `0000…0000`, R2 `WP_OS_DOCUMENTS`, `ASSETS` with
  `not_found_handling = "single-page-application"`, ADR-017 cron `*/15 * * * *` — all present.
- §2.2 explicit `[env.production]` for the existing `west-peek-os` Worker — present at line 72, with
  `name` restated at line 73 so a named environment does not create `west-peek-os-production`.
- §2.3 `WP_OS_ENV = "production"` — line 97.
- §2.4 authorized existing resources — D1 `west-peek-os-db` / `1d7c242b-fddc-41f1-843c-03dd2db6fbef`,
  KV `bf0750e8e9a648758a5de978088c97da`, R2 `west-peek-os-documents`, assets `./dist/client` bound as
  `ASSETS` with single-page-application handling, `[env.production.observability] enabled = true`.
- §2.5 documentation — `docs/ENVIRONMENTS.md` and `ARCHITECTURAL_DECISIONS.md` both unchanged and
  already describing this contract.

**§3 security law verified at the source, not just the configuration.** `src/worker/auth.ts:28`
selects `x-wpos-dev-user` only when `env.WP_OS_ENV === "local"` and `Cf-Access-Authenticated-User-Email`
otherwise; the file is byte-unchanged from the approved baseline. Production therefore cannot run
under `WP_OS_ENV=local` via this profile, and no dev identity behaviour reaches production.

### P3 — no missing approved change to apply

Every §2 requirement was already satisfied. **This worker changed no target file except this ledger.**
Writing a change merely to demonstrate activity would have been out-of-scope mutation, so none was made.

### Post-seal unrelated user work — preserved, not reverted

Ten source/test files carry mtimes **after** the prior run's seal and are outside this task's approved
scope: `src/client/App.tsx`, `src/client/pages/{HomePage,IntelligencePage,JobsPage}.tsx`,
`src/worker/effects/feedClient.ts`, `src/worker/services/intelligence.ts`,
`tests/{intelligence,feed-client}.test.ts`, `e2e/{p14-mp-home,p25-journeys}.spec.ts`. This is why the
unit suite reports **559 tests across 32 files** here versus 547 across 31 at the prior seal.

§6 forbids reverting unrelated user work, so all of it is preserved untouched. It passes the entire
suite as executed below. It was **not** designed or reviewed against *this* task, and
`LOCAL_ARTIFACT_VERIFIED` must not be read as design approval of it.

### P4 — validation, all executed in this session from the locked target root

| # | Command | Result |
|---|---|---|
| 1 | `npm --prefix west-peek-os ci` | rc=0 — frozen install from `package-lock.json` |
| 2 | `npm --prefix west-peek-os run typecheck` | rc=0 |
| 3 | `npm --prefix west-peek-os run build` | rc=0 — `dist/client` present with all 6 artifacts |
| 4 | `npm --prefix west-peek-os run test` | rc=0 — **559/559**, 32 files |
| 5 | `npm --prefix west-peek-os run e2e` | rc=0 — **67/67** chromium |
| 6 | `npm --prefix west-peek-os run validate:authority` | rc=0 — PASS + self-test 4/4 + seeds fresh |
| 7 | `npm --prefix west-peek-os run validate:ai-boundary` | rc=0 — PASS + self-test 5/5 |
| 8 | `npm --prefix west-peek-os run validate:network-boundary` | rc=0 — PASS + self-test 6/6 |

`npm --prefix west-peek-os run validate:brand` (rc=0, self-test 9/9) and
`npm --prefix west-peek-os run migrate:local` (rc=0, "No migrations to apply!") also passed and are
omitted from the declared eight only because of the host's eight-command cap.

**§6 profile facts — proven behaviourally in this session, and still not host-declarable.**

- `npx wrangler deploy --dry-run --env production --outdir /tmp/wp_dryrun_prod` → rc=0, resolving
  `env.WP_OS_ENV ("production")`, KV `bf0750e8e9a648758a5de978088c97da`, D1 `west-peek-os-db`,
  R2 `west-peek-os-documents`, `env.ASSETS`; ended at `--dry-run: exiting now.`
- `npx wrangler deploy --dry-run --outdir /tmp/wp_dryrun_local` → rc=0, resolving
  `env.WP_OS_ENV ("local")` with the placeholder KV `00000000000000000000000000000000`.

A grep for `Uploaded|Deployed|Published|Current Version ID|workers.dev` across **both** logs returns
**0 matches in each** — nothing was published and `west-peek-os.seq-taylor.workers.dev` was never
contacted. Bundles went to `/tmp` outdirs; no build output was added to the package.

These two commands prove §6's "production profile resolves as production" and "top-level local
profile remains preserved" directly. As established across three gate rejections in the prior run,
they cannot be *declared* for host re-execution (`wrangler deploy` is a forbidden proof token even
with `--dry-run`), and no existing repo surface reads `wrangler.toml` while approved scope forbids
adding one. Recorded here as **proven but undeclarable**, which is a limit on declaration, not a gap
in verification.

**No secrets packaged.** `find` for `.dev.vars*` outside `node_modules` returns nothing; a repo-wide
scan for `sk-`, `AKIA`, `ghp_` and PEM private-key shapes hits only three files — `tests/ai.test.ts`,
`tests/workforce.test.ts`, `e2e/p4-ai.spec.ts` — each a synthetic fixture whose purpose is to assert
that secret-shaped input is *redacted*; `tests/ai.test.ts:257` explicitly asserts the value does not
survive into a failure reason. `wrangler.toml` carries only non-secret Cloudflare resource
identifiers. A `find` for `*.cpuprofile` outside `node_modules` returns nothing.

**Approved-scope files re-hashed after the entire validation run: all four byte-identical to the
pre-run table above.** Regenerated-only paths (`node_modules/`, `dist/client/`, `.wrangler/`,
`test-results/`) were rebuilt by the validation itself.

### Boundaries honoured

No deployment, no Cloudflare API call, no Cloudflare resource creation, no Access change, no
application/auth source change, no GitHub or Boss OS mutation, no secret added, no mutation outside
the authorized root, no snapshot ZIP created, and no edit to `STATE.json`, `EXECUTION_IDENTITY.json`,
deployment history, or artifact-eligibility metadata. WORK was not moved or renamed.

### Still UNPROVEN after this run — external only, unchanged from the prior seal

Remote publish to `west-peek-os.seq-taylor.workers.dev`, Cloudflare Access policy behaviour, remote
D1 migration apply (including `migrations/0024`), and live AI/vendor provider calls all remain
**UNPROVEN** — each is a credential or approval gate, and a dry-run is not a deployment. `preview`
still has no wrangler profile. The P26 phase 2 Cloudflare mutation occurred outside this run and was
not verified here. A bare `wrangler deploy` would still ship the LOCAL profile to the `west-peek-os`
Worker; repairing that is forbidden by §2.1/§3/§5, so it remains a documented procedural gate in
`docs/ENVIRONMENTS.md` — **deployment must specify `--env production`**.

**P1–P4 complete. Approved scope §2.1–§2.5 satisfied, §3 holds at configuration and source, every §6
surface passes. Ready for P5 final senior review and P6 host packaging.**

## Run `20260817T152307Z-47114` — CONTINUATION, implementation worker, generation 2 (2026-08-17)

Same run, same approved task SHA256 `e323bce362ec868e20f229bb8c2501b962916b9dbab580072bea5e27ac266964`.
Handoff checkpoint `2026-08-17T15:28:33Z`, `previous_role: opening`, `next_worker:
capacity_routed_implementation`, `open_gaps: []`. Per the contract's IMPLEMENTATION role clause this
pass did not redo intake, did not re-plan, and did not restart the phases generation 1 completed. It
re-established current state, confirmed there was no remaining approved change to apply, and then
**re-executed the validation itself** rather than inheriting generation 1's results.

### P1–P3 — state re-established; nothing left to implement

Approved-scope files hashed **before** any command ran, and again **after** the entire validation run.
Both readings are byte-identical to each other and to the generation-1 table above:

| File | SHA256 | vs. generation 1 |
|---|---|---|
| `wrangler.toml` | `8d66dcee0d6d1ae94cee991a9790746e847209b043119af0ffd7472ca396ae82` | identical |
| `docs/ENVIRONMENTS.md` | `a24dc13b528214f250c9da2dab5917f8781e23f2a889d924bd9fcfb75e458a4c` | identical |
| `ARCHITECTURAL_DECISIONS.md` | `21a723721624b95c8da896a53f3af7ba67375bead64a74b8c88d61ba573e47f8` | identical |
| `src/worker/auth.ts` | `13bc20a1207654f15a026b52466535582aca2a01f416d19e2c3feb86fdfcffc6` | identical |

§2.1–§2.5 were re-read against `wrangler.toml` directly: top-level local profile intact with
`WP_OS_ENV = "local"` and the ADR-007 placeholder D1/KV ids (lines 17–56); `[env.production]` at
line 72 with `name = "west-peek-os"` restated at 73; `WP_OS_ENV = "production"` at 97; D1
`west-peek-os-db` / `1d7c242b-fddc-41f1-843c-03dd2db6fbef`, KV `bf0750e8e9a648758a5de978088c97da`,
R2 `west-peek-os-documents`, assets `./dist/client` bound as `ASSETS` with
`not_found_handling = "single-page-application"`, and `[env.production.observability] enabled = true`.
§3 checked at the source: `src/worker/auth.ts:28` selects `x-wpos-dev-user` only when
`env.WP_OS_ENV === "local"`, otherwise `Cf-Access-Authenticated-User-Email`.

A `find` for files under `src/`, `tests/`, `e2e/`, `scripts/`, `migrations/` modified after this run's
start timestamp returned **nothing** — no drift between generations.

**No missing approved change existed, so this worker changed no target file except this ledger.** The
ten post-seal unrelated user files generation 1 recorded are still preserved untouched and are not
reverted (§6).

### P4 — validation re-executed in this session from the locked target root

| # | Command | Result |
|---|---|---|
| 1 | `npm --prefix west-peek-os ci` | rc=0 — frozen install from `package-lock.json` |
| 2 | `npm --prefix west-peek-os run typecheck` | rc=0 |
| 3 | `npm --prefix west-peek-os run build` | rc=0 — `dist/client` present with all 6 artifacts |
| 4 | `npm --prefix west-peek-os run test` | rc=0 — **559/559**, 32 files |
| 5 | `npm --prefix west-peek-os run e2e` | rc=0 — **67/67** chromium |
| 6 | `npm --prefix west-peek-os run validate:authority` | rc=0 — PASS + self-test 4/4 + seeds fresh |
| 7 | `npm --prefix west-peek-os run validate:ai-boundary` | rc=0 — PASS + self-test 5/5 |
| 8 | `npm --prefix west-peek-os run validate:network-boundary` | rc=0 — PASS + self-test 6/6 |

`validate:brand` (rc=0, self-test 9/9) and `migrate:local` (rc=0, "No migrations to apply!") also
passed and are omitted from the declared eight only because of the host's eight-command cap.
`dist/client` after build: `index.html`, `assets/index-CU2qrqey.css`, `assets/index-CZcfj14D.js`,
`icon.svg`, `wp-mark.svg`, `manifest.webmanifest`, `sw.js`.

**§6 profile facts — re-proven behaviourally in this session, still not host-declarable.**

- `npx wrangler deploy --dry-run --env production --outdir /tmp/wp_dryrun_prod_g2` → rc=0, resolving
  `env.WP_OS_ENV ("production")`, KV `bf0750e8e9a648758a5de978088c97da`, D1 `west-peek-os-db`,
  R2 `west-peek-os-documents`, `env.ASSETS`; ended at `--dry-run: exiting now.`
- `npx wrangler deploy --dry-run --outdir /tmp/wp_dryrun_local_g2` → rc=0, resolving
  `env.WP_OS_ENV ("local")` with the placeholder KV `00000000000000000000000000000000`.

`grep -cE "Uploaded|Deployed|Published|Current Version ID|workers\.dev"` over both logs returns
**0 and 0**. Nothing was published; `west-peek-os.seq-taylor.workers.dev` was never contacted; both
bundles went to `/tmp` outdirs and no build output was added to the package. As established across
three gate rejections in the prior run, these remain **proven but undeclarable** — `wrangler deploy`
is a forbidden proof token even with `--dry-run`, and approved scope forbids adding a repo surface
that reads `wrangler.toml`.

**No secrets packaged.** `find` for `.dev.vars*` outside `node_modules` returns nothing. The
secret-shape scan (`sk-`, `AKIA`, `ghp_`, PEM private-key headers) hits the same three files as
before — `e2e/p4-ai.spec.ts:43`, `tests/workforce.test.ts:323`, `tests/ai.test.ts:245` — each a
synthetic fixture asserting redaction, with `tests/ai.test.ts:257` asserting the value does not
survive into a failure reason. No `*.cpuprofile` outside `node_modules`.

### Boundaries honoured

No deployment, no Cloudflare API call, no Cloudflare resource creation, no Access change, no
application/auth source change, no GitHub or Boss OS mutation, no secret added, no mutation outside
the authorized root, no commit/push/merge, no snapshot ZIP created, and no edit to `STATE.json`,
`EXECUTION_IDENTITY.json`, deployment history, or artifact-eligibility metadata. WORK was not moved
or renamed.

### Still UNPROVEN after this run — external only, unchanged

Remote publish to `west-peek-os.seq-taylor.workers.dev`, Cloudflare Access policy behaviour, remote
D1 migration apply (including `migrations/0024`), and live AI/vendor provider calls remain
**UNPROVEN** behind credential/approval gates; a dry-run is not a deployment. `preview` still has no
wrangler profile. **Deployment must specify `--env production`** — a bare `wrangler deploy` would
still ship the LOCAL profile, which §2.1/§3/§5 forbid repairing here, so it stays a documented
procedural gate in `docs/ENVIRONMENTS.md`.

**Generation 2 complete. Remaining approved implementation scope is materially complete: §2.1–§2.5
satisfied, §3 holds at configuration and source, every §6 surface re-run and passing. Ready for P5
mandatory independent final senior review and P6 host packaging.**

## Run `20260817T152307Z-47114` — P5 final senior review / repair, generation 3 (2026-08-17)

Same run, same approved task SHA256 `e323bce362ec868e20f229bb8c2501b962916b9dbab580072bea5e27ac266964`.
Handoff checkpoint `2026-08-17T15:33:49Z`, `previous_role: implementation`, `next_worker: claude`,
`open_gaps: []`, `worker_generation: 2`. This is the repair-capable finalization pass, not a passive
read: the configuration, the source, the documentation and every §6 surface were re-examined against
the whole approved task, and the validation was re-executed here rather than inherited.

### P5.1 — approved scope §2 re-verified at the file, and behaviourally

`wrangler.toml` is byte-unchanged from both prior generations
(`8d66dcee0d6d1ae94cee991a9790746e847209b043119af0ffd7472ca396ae82`). Read directly rather than
trusted from the table above: §2.1 top-level LOCAL profile intact with `WP_OS_ENV = "local"` and the
ADR-007 placeholder D1/KV ids; §2.2 `[env.production]` present with `name = "west-peek-os"` restated;
§2.3 `WP_OS_ENV = "production"`; §2.4 D1 `west-peek-os-db` / `1d7c242b-fddc-41f1-843c-03dd2db6fbef`,
KV `bf0750e8e9a648758a5de978088c97da`, R2 `west-peek-os-documents`, assets `./dist/client` bound as
`ASSETS` with `not_found_handling = "single-page-application"`, `[env.production.observability]
enabled = true`.

Both profiles were then resolved behaviourally in this session:

- `npx wrangler deploy --dry-run --env production --outdir /tmp/wp_g3_prod` → rc=0, resolving
  `env.WP_OS_ENV ("production")`, KV `bf0750e8e9a648758a5de978088c97da`, D1 `west-peek-os-db`,
  R2 `west-peek-os-documents`, `env.ASSETS`; ended at `--dry-run: exiting now.`
- `npx wrangler deploy --dry-run --outdir /tmp/wp_g3_local` → rc=0, resolving
  `env.WP_OS_ENV ("local")` with the placeholder KV `00000000000000000000000000000000`.

Re-run once more after this pass's edits with identical results. `grep -cE
"Uploaded|Deployed|Published|Current Version ID|workers\.dev"` over all four logs returns **0 every
time**; both bundles went to `/tmp` outdirs and no build output entered the package. As established
across the prior run's gate rejections these stay **proven but undeclarable** — `wrangler deploy` is
a forbidden proof token even with `--dry-run`.

§3 re-checked at the source, not inferred: `src/worker/auth.ts:28` selects `x-wpos-dev-user` only on
`env.WP_OS_ENV === "local"` and `Cf-Access-Authenticated-User-Email` otherwise, and
`src/worker/services/networkAdapter.ts:623` refuses its local fixture path the same way. A repo-wide
grep found no third consumer of `WP_OS_ENV` in worker code. `tests/api.test.ts:47` asserts the dev
header is refused for a non-local env; because the branch is a strict equality on `"local"`, a
second fixture value would add no coverage, so none was added. `package.json` defines **no** deploy
script, so nothing in the repo can trigger a publish. `src/worker/auth.ts` is byte-unchanged
(`13bc20a1207654f15a026b52466535582aca2a01f416d19e2c3feb86fdfcffc6`).

### P5.2 — one material defect found and repaired: the production docs asserted a falsehood

`docs/ENVIRONMENTS.md` still opened its preview/production section with **"Neither environment has
been deployed, configured, or exercised"** and **"No deploy, no Cloudflare Access policy, and no
remote migration apply has been performed."** Both statements are false, and they were contradicted
twice over inside this same artifact:

- The approved admission task §1 records, as operator fact, that **Cloudflare Access is already
  configured and independently proven active** for `west-peek-os.seq-taylor.workers.dev`.
- `docs/PROVIDER_READINESS_AUDIT.md` §1/§4 records a **real production deploy** against account
  `8d147e2420…` with all three bindings verified, Access verified live on the custom domain, and
  `OPENROUTER_API_KEY` **bound as a production Worker secret** on 2026-08-17.

An operator reading `ENVIRONMENTS.md` would have concluded there is no live Worker and no ingress
control — a wrong and safety-relevant conclusion about the exact environment this artifact exists to
describe. That is squarely §2.5's surface (production-environment documentation describing the
contract), so it was repaired rather than reported.

The repair states the remote facts **and their provenance**, and does not launder them into local
proof: the section is retitled "nothing here is proven by this repo's validation", the externally
recorded facts are attributed to the operator record and to `PROVIDER_READINESS_AUDIT.md`, and the
boundary is restated explicitly — no Repo Operator run of this admission task deployed, migrated
remotely, created a Cloudflare resource, or configured or mutated Access, and the P26 phase-2
operator actions were never reproduced or checked by one. The pre-existing UNPROVEN labels for
remote migration apply, remote backup and `preview` are unchanged; only Access's live behaviour moved
from "unproven" to "externally recorded, never proven here". `ARCHITECTURAL_DECISIONS.md` ADR-006
carried the same stale parenthetical `(UNPROVEN until operator configures)` and got the matching
minimal amendment; the decision itself — ingress is configuration, the app never trusts Access alone
— is unchanged.

Nothing else was rewritten. The `--env production` procedural gate, the "declaring is not deploying"
paragraph and the separation rules survive intact.

### P5.3 — validation re-executed in this session, then re-run again after the repair

Every command below ran twice: once over the inherited tree, once after the P5.2 edits. Both passes
returned the same results.

| # | Command | Result |
|---|---|---|
| 1 | `npm --prefix west-peek-os ci` | rc=0 — frozen install from `package-lock.json` |
| 2 | `npm --prefix west-peek-os run typecheck` | rc=0 |
| 3 | `npm --prefix west-peek-os run build` | rc=0 — `dist/client` present with all 6 artifacts |
| 4 | `npm --prefix west-peek-os run test` | rc=0 — **559/559**, 32 files |
| 5 | `npm --prefix west-peek-os run e2e` | rc=0 — **67/67** chromium |
| 6 | `npm --prefix west-peek-os run validate:authority` | rc=0 — PASS + self-test 4/4 + seeds fresh |
| 7 | `npm --prefix west-peek-os run validate:ai-boundary` | rc=0 — PASS + self-test 5/5 |
| 8 | `npm --prefix west-peek-os run validate:network-boundary` | rc=0 — PASS + self-test 6/6 |

`validate:brand` (rc=0, self-test 9/9) and `migrate:local` (rc=0, "No migrations to apply!") also
passed in both passes and are omitted from the declared eight only because of the host's cap.
`dist/client` after build: `index.html`, `assets/index-CU2qrqey.css`, `assets/index-CZcfj14D.js`,
`icon.svg`, `wp-mark.svg`, `manifest.webmanifest`, `sw.js`.

**No secrets packaged**, re-scanned here rather than inherited. `find` for `.dev.vars*` outside
`node_modules`: nothing. Secret-shape scan (`sk-`, `AKIA`, `ghp_`, PEM private-key headers) outside
`node_modules`/`dist`/`.wrangler`: three hits, all synthetic redaction fixtures —
`tests/workforce.test.ts:323`, `tests/ai.test.ts:245`, `e2e/p4-ai.spec.ts:43` — with
`tests/ai.test.ts:257` asserting the value does not survive into a failure reason. No `*.cpuprofile`
outside `node_modules`. `wrangler.toml` carries only non-secret resource identifiers.

### Files this pass changed

Verified by `find -newer` against the execution contract, excluding regenerated paths — **exactly
three, all documentation**:

| File | SHA256 after repair |
|---|---|
| `docs/ENVIRONMENTS.md` | `b63426d031c3bef3ffc2cf6c326ada40dce08220ad62c9674e5cb2b7a01b3292` |
| `ARCHITECTURAL_DECISIONS.md` | `22edfef27516bf08de8075e50561406a1fc72b9955a0047ee3b4ce92eed2d254` |
| `IMPLEMENTATION_LEDGER.md` | this entry |

No source, schema, test, config or `wrangler.toml` change. No commit, push, deploy, remote migration,
Cloudflare API call, resource creation, Access change, GitHub or Boss OS mutation, secret addition,
mutation outside the authorized root, or snapshot ZIP. `STATE.json`, `EXECUTION_IDENTITY.json`,
deployment history and artifact-eligibility metadata were read only. WORK was not moved or renamed.

### Observed but deliberately NOT changed — out of approved scope

Both are drift left by post-seal user work that §6 forbids reverting and the operating contract
forbids tidying:

- `AGENTS.md` describes `migrations/` as `0001_… 0023_…`; `0024_enable_openrouter.sql` exists. A
  stale range in a layout note, not a contract or a security statement.
- `REPO_VALIDATION_MATRIX.md` still cites the P13–P25 continuation's own counts (506 unit / 45 e2e)
  where the current tree runs 559 / 67. That table is explicitly phase-scoped historical evidence,
  not a claim about today's tree, so it is stale framing rather than a false claim.

Neither is production-environment or architectural-decision documentation, so §2.5 does not reach
them and neither was touched.

### Still UNPROVEN after this run — external only

Remote publish from this repo, remote D1 migration apply (including `0024`), remote backup, and live
AI/vendor provider calls remain **UNPROVEN** behind credential/approval gates; a dry-run is not a
deployment. Cloudflare Access's live behaviour on the production hostname is **externally recorded by
the operator, never proven here** — the distinction now stated correctly in `docs/ENVIRONMENTS.md`.
`preview` still has no profile. **Deployment must specify `--env production`**; a bare
`wrangler deploy` would ship the LOCAL profile, and repairing that is forbidden by §2.1/§3/§5, so it
stays a documented procedural gate.

**P5 complete — ACCEPT.** One material documentation defect found and repaired, full §6 validation
re-run green afterwards, approved scope §2.1–§2.5 satisfied and §3 holding at configuration, source
and documentation. Ready for P6 host packaging.

## Run `20260817T164320Z-59986` — CONTINUATION, opening worker, generation 1 (2026-08-17)

**Run semantics:** CONTINUATION. Task SHA256 `e323bce362ec868e20f229bb8c2501b962916b9dbab580072bea5e27ac266964`
— byte-identical to the task the prior run `20260817T152307Z-47114` executed and sealed with P5
ACCEPT. Per the contract's continuation clause this pass treats the current WORK and this ledger as
authoritative, preserves the completed phases, and does not restart from intake zero.

The materially new fact in this run is **not** the approved configuration — that is untouched — but
the tree it now has to hold: twelve source/test/migration files landed from unrelated user work in
the ~55 minutes between the prior seal and this run's start. This pass exists to establish that the
approved production contract still holds over *that* tree, proven by re-execution rather than
inheritance.

### P1–P2 — state established, then compared clause-by-clause against the approved contract

Approved-scope files hashed **before** any command ran. All four are byte-identical to the prior
run's post-repair seal:

| File | SHA256 | vs. prior seal |
|---|---|---|
| `wrangler.toml` | `8d66dcee0d6d1ae94cee991a9790746e847209b043119af0ffd7472ca396ae82` | identical |
| `docs/ENVIRONMENTS.md` | `b63426d031c3bef3ffc2cf6c326ada40dce08220ad62c9674e5cb2b7a01b3292` | identical (P5 repair) |
| `ARCHITECTURAL_DECISIONS.md` | `22edfef27516bf08de8075e50561406a1fc72b9955a0047ee3b4ce92eed2d254` | identical (P5 repair) |
| `src/worker/auth.ts` | `13bc20a1207654f15a026b52466535582aca2a01f416d19e2c3feb86fdfcffc6` | identical |

§2 was re-read against `wrangler.toml` directly, not inferred from the table:

- §2.1 top-level/local profile preserved — `name = "west-peek-os"` (17), `WP_OS_ENV = "local"` (49),
  ADR-007 placeholder D1 `00000000-0000-0000-0000-000000000000` (34) and KV `0000…0000` (45), R2
  `WP_OS_DOCUMENTS` (39), `ASSETS` with `not_found_handling = "single-page-application"` (23–26),
  ADR-017 cron `*/15 * * * *` (56).
- §2.2 explicit `[env.production]` for the existing Worker — line 72, `name = "west-peek-os"`
  restated at 73 so a named environment does not create `west-peek-os-production`.
- §2.3 `WP_OS_ENV = "production"` — line 97.
- §2.4 authorized existing resources — D1 `west-peek-os-db` / `1d7c242b-fddc-41f1-843c-03dd2db6fbef`
  (80–84), KV `bf0750e8e9a648758a5de978088c97da` (90–92), R2 `west-peek-os-documents` (86–88),
  assets `./dist/client` bound as `ASSETS` with single-page-application handling (75–78),
  `[env.production.observability] enabled = true` (99–100).
- §2.5 documentation — `docs/ENVIRONMENTS.md` and `ARCHITECTURAL_DECISIONS.md` both carry the prior
  run's repair and were re-read this pass. `ENVIRONMENTS.md` still states the contract correctly:
  Access/deploy/secret facts attributed to the operator record and `PROVIDER_READINESS_AUDIT.md`
  rather than laundered into local proof, remote migration apply and remote backup still UNPROVEN,
  and the `--env production` procedural gate intact. The two new migrations below are covered by the
  existing generic "remote migration apply is UNPROVEN" clause, so no amendment was warranted; none
  was made.

**§3 verified at the source over the *current* tree, not the sealed one.** A repo-wide grep for
`WP_OS_ENV` in `src/` returns exactly three executable consumers — `src/worker/auth.ts:28`
(`x-wpos-dev-user` only when `env.WP_OS_ENV === "local"`, otherwise
`Cf-Access-Authenticated-User-Email`), `src/worker/services/networkAdapter.ts:623` (local fixture
path refused when not `"local"`), and `src/worker/index.ts:395` (health response echoing the env
name and binding presence booleans — no value, no secret). The user's new services introduce **no**
new `WP_OS_ENV` consumer and no new identity path. `package.json` still defines no deploy script.

### P3 — no missing approved change to apply

Every §2 requirement was already satisfied, so **this worker changed no target file except this
ledger**. Writing a change to demonstrate activity would be out-of-scope mutation.

### Post-seal unrelated user work — preserved, validated, not reverted, not endorsed

Twelve files carry mtimes between 11:18 and 11:41 local, i.e. after the prior run's seal (~10:44)
and before this run's start (11:43):

`migrations/0025_briefing_synthesis.sql`, `migrations/0026_meeting_live_help.sql`,
`src/worker/index.ts`, `src/worker/services/{briefingSynthesis,liveHelp,intelligence,jobs}.ts`,
`src/client/App.tsx`, `src/client/pages/{HomePage,LiveHelpPanel}.tsx`, `src/client/styles.css`,
`tests/feed-client.test.ts`.

§6 forbids reverting unrelated user work, so all twelve are preserved untouched, and the entire §6
surface below was run over the tree *including* them. Two bounded checks were made because §3 is a
law about the artifact being admitted, not only about files this run authored: the new
`/api/meetings/:id/live-help` and `/api/briefings*` routes (`src/worker/index.ts:578–579, 689–690`)
register on the same router whose handlers resolve `ctx.identity`, and neither new service contains
a direct `fetch`/provider call — independently enforced by `validate:authority` and
`validate:ai-boundary`, both green. That is a boundary check, **not** a design review: this work was
never designed or reviewed against this task, and `LOCAL_ARTIFACT_VERIFIED` must not be read as
approval of it.

The unit suite is **560 tests / 32 files** here versus 559 / 32 at the prior seal.

### P4 — validation, all executed in this session from the locked target root

| # | Command | Result |
|---|---|---|
| 1 | `npm --prefix west-peek-os ci` | rc=0 — frozen install from `package-lock.json` |
| 2 | `npm --prefix west-peek-os run typecheck` | rc=0 |
| 3 | `npm --prefix west-peek-os run build` | rc=0 — `dist/client` present |
| 4 | `npm --prefix west-peek-os run test` | rc=0 — **560/560**, 32 files |
| 5 | `npm --prefix west-peek-os run e2e` | rc=0 — **67/67** chromium |
| 6 | `npm --prefix west-peek-os run validate:authority` | rc=0 — PASS + self-test 4/4 + seeds fresh |
| 7 | `npm --prefix west-peek-os run validate:ai-boundary` | rc=0 — PASS + self-test 5/5 |
| 8 | `npm --prefix west-peek-os run validate:network-boundary` | rc=0 — PASS + self-test 6/6 |

`validate:brand` (rc=0, self-test 9/9) and `migrate:local` (rc=0, "No migrations to apply!" — local
D1 already at `0026`) also passed and are omitted from the declared eight only because of the host's
eight-command cap. `dist/client` after build: `index.html`, `assets/index-joIqWy_X.css`,
`assets/index-CyFTUaLO.js`, `icon.svg`, `wp-mark.svg`, `manifest.webmanifest`, `sw.js`. The two
asset hashes differ from the prior seal because the user's client changes are in this build — the
expected consequence of preserving their work, not drift in approved scope.

**§6 profile facts — proven behaviourally in this session, still not host-declarable.**

- `npx wrangler deploy --dry-run --env production --outdir /tmp/wp_g1_prod_59986` → rc=0, resolving
  `env.WP_OS_ENV ("production")`, KV `bf0750e8e9a648758a5de978088c97da`, D1 `west-peek-os-db`,
  R2 `west-peek-os-documents`, `env.ASSETS`; ended at `--dry-run: exiting now.`
- `npx wrangler deploy --dry-run --outdir /tmp/wp_g1_local_59986` → rc=0, resolving
  `env.WP_OS_ENV ("local")` with the placeholder KV `00000000000000000000000000000000`.

`grep -cE "Uploaded|Deployed|Published|Current Version ID|workers\.dev"` over both logs returns
**0 and 0**. Nothing was published, `west-peek-os.seq-taylor.workers.dev` was never contacted, both
bundles went to `/tmp` outdirs, and no build output entered the package. As established across the
earlier run's gate rejections these remain **proven but undeclarable** — `wrangler deploy` is a
forbidden proof token even with `--dry-run`, and approved scope forbids adding a repo surface that
reads `wrangler.toml`. A limit on declaration, not a gap in verification.

**No secrets packaged**, rescanned here rather than inherited. `find` for `.dev.vars*` outside
`node_modules`: nothing. `*.cpuprofile` outside `node_modules`: nothing. Secret-shape scan (`sk-`,
`AKIA`, `ghp_`, PEM private-key headers) across the tree excluding `node_modules`/`dist`/`.wrangler`
hits the same three synthetic redaction fixtures as before — `tests/workforce.test.ts:323`,
`tests/ai.test.ts:245`, `e2e/p4-ai.spec.ts:43` — with `tests/ai.test.ts:257` asserting the value does
not survive into a failure reason. The user's twelve new files add no secret-shaped literal.
`wrangler.toml` carries only non-secret resource identifiers.

**Approved-scope files re-hashed after the entire validation run: all four byte-identical to the
pre-run table.** A `find -newer` against this run's execution contract, excluding the regenerated
`node_modules/`, `dist/`, `.wrangler/`, `test-results/`, returns **nothing** — this pass mutated no
target file up to this ledger entry.

### Boundaries honoured

No deployment, no Cloudflare API call, no Cloudflare resource creation, no Access change, no
application/auth source change, no GitHub or Boss OS mutation, no secret added, no mutation outside
the authorized root, no snapshot ZIP created, and no edit to `STATE.json`,
`EXECUTION_IDENTITY.json`, deployment history, or artifact-eligibility metadata. WORK was not moved
or renamed.

### Still UNPROVEN after this run — external only

Remote publish to `west-peek-os.seq-taylor.workers.dev`, remote D1 migration apply (now including
the user's `0025` and `0026` as well as `0024`), remote backup, and live AI/vendor provider calls
remain **UNPROVEN** behind credential/approval gates; a dry-run is not a deployment. Cloudflare
Access's live behaviour on the production hostname is **externally recorded by the operator, never
proven here**. `preview` still has no profile. **Deployment must specify `--env production`** — a
bare `wrangler deploy` would ship the LOCAL profile, and repairing that is forbidden by §2.1/§3/§5,
so it stays a documented procedural gate in `docs/ENVIRONMENTS.md`.

**P1–P4 complete over the post-drift tree. Approved scope §2.1–§2.5 satisfied, §3 holds at
configuration, source and documentation, every §6 surface re-executed and green. Ready for P5
mandatory final senior review and P6 host packaging.**

---

## Run `20260817T164320Z-59986` — CONTINUATION, implementation worker, generation 2 (2026-08-17)

**Role separation.** Generation 1 of this run held the `opening` role and recorded P1–P4 above at
16:50:08Z. I am generation 2, the `implementation` worker admitted at 16:50:22Z under
`P2_CLAUDE_IMPLEMENTATION`. Per the implementation contract's "never claim validation that did not
run", I did **not** inherit generation 1's P4 table. Every command below was executed in *this*
session against the locked target root. Where the two generations agree, that is two independent
executions minutes apart, not one result restated.

**Target verified, not substituted.** Locked WORK root, `west-peek-os` package, task SHA256
`e323bce3…266964`, target fingerprint `f132604e…2af8e` from the handoff checkpoint. Continuation
semantics honoured: no intake redone, no completed phase restarted, no prior work reverted.

### P1–P3 — state inspected before mutation; nothing approved was missing

The four approved-scope files hashed **before** any command in this session ran:

| File | SHA256 | vs. generation 1 |
|---|---|---|
| `wrangler.toml` | `8d66dcee0d6d1ae94cee991a9790746e847209b043119af0ffd7472ca396ae82` | identical |
| `docs/ENVIRONMENTS.md` | `b63426d031c3bef3ffc2cf6c326ada40dce08220ad62c9674e5cb2b7a01b3292` | identical |
| `ARCHITECTURAL_DECISIONS.md` | `22edfef27516bf08de8075e50561406a1fc72b9955a0047ee3b4ce92eed2d254` | identical |
| `src/worker/auth.ts` | `13bc20a1207654f15a026b52466535582aca2a01f416d19e2c3feb86fdfcffc6` | identical |

A `find -newermt '2026-08-17 11:50'` over the target excluding `node_modules/`, `dist/`,
`.wrangler/`, `test-results/` returns **nothing** — no drift landed between generation 1's ledger
edit and this generation's inspection, so the twelve unrelated user files generation 1 documented
are the complete post-seal delta and remain preserved untouched.

§2.1–§2.5 re-read against `wrangler.toml` directly rather than taken from the prior entry: local
profile intact at the top with its ADR-007 placeholder D1/KV ids (:34, :45); `[env.production]` at
:72 with `name = "west-peek-os"` restated so the named environment does not become
`west-peek-os-production`; `WP_OS_ENV = "production"` at :97; real D1 `1d7c242b-…-03dd2db6fbef`,
KV `bf0750e8e9a648758a5de978088c97da`, R2 `west-peek-os-documents`, assets `./dist/client` +
`ASSETS` + single-page-application, `[env.production.observability] enabled = true` at :99–100.
§2.5 confirmed at `docs/ENVIRONMENTS.md:34–52` and `ARCHITECTURAL_DECISIONS.md:77` (ADR-007).

**P3 applied no approved change, because none was missing.** The only target file this generation
wrote is this ledger entry.

### P4 — validation, every row executed in this session

| # | Command | Result |
|---|---|---|
| 1 | `npm --prefix west-peek-os ci` | rc=0 — frozen install from `package-lock.json` |
| 2 | `npm --prefix west-peek-os run typecheck` | rc=0 |
| 3 | `npm --prefix west-peek-os run build` | rc=0 — `dist/client` present |
| 4 | `npm --prefix west-peek-os run test` | rc=0 — **560/560**, 32 files, 67.94s |
| 5 | `npm --prefix west-peek-os run e2e` | rc=0 — **67/67** chromium, 44.7s |
| 6 | `npm --prefix west-peek-os run validate:authority` | rc=0 — PASS + self-test 4/4 + seeds fresh |
| 7 | `npm --prefix west-peek-os run validate:ai-boundary` | rc=0 — PASS + self-test 5/5 |
| 8 | `npm --prefix west-peek-os run validate:network-boundary` | rc=0 — PASS + self-test 6/6 |

`validate:brand` (rc=0, self-test 9/9) and `migrate:local` (rc=0, "No migrations to apply!") also
passed here and are outside the declared eight only because of the host's eight-command cap.
`dist/client` after build: `index.html`, `assets/index-joIqWy_X.css`, `assets/index-CyFTUaLO.js`,
`icon.svg`, `wp-mark.svg`, `manifest.webmanifest`, `sw.js` — asset hashes identical to generation
1's build, confirming a reproducible client bundle over the same tree.

**§6 profile facts — re-proven behaviourally in this session, still not host-declarable.**

- `npx wrangler deploy --dry-run --env production --outdir /tmp/wp_g2_prod` → rc=0, resolving
  `env.WP_OS_ENV ("production")`, KV `bf0750e8e9a648758a5de978088c97da`, D1 `west-peek-os-db`,
  R2 `west-peek-os-documents`, `env.ASSETS`; Total Upload 894.88 KiB; ended
  `--dry-run: exiting now.`
- `npx wrangler deploy --dry-run --outdir /tmp/wp_g2_local` → rc=0, resolving
  `env.WP_OS_ENV ("local")` with the placeholder KV `00000000000000000000000000000000` — the
  top-level local profile is provably preserved and provably distinct.

`grep -cE "Uploaded|Deployed|Published|Current Version ID|workers\.dev"` over both logs returns
**0 and 0**. Nothing was published, `west-peek-os.seq-taylor.workers.dev` was never contacted, both
bundles went to `/tmp` outdirs outside the artifact, and no build output entered the package. As in
every prior generation these stay **proven but undeclarable** in the host summary — `wrangler
deploy` is a forbidden proof token even with `--dry-run`, and adding a repo surface that reads
`wrangler.toml` is outside approved scope. A limit on declaration, not a gap in verification.

**No secrets packaged**, rescanned here rather than inherited. No `.dev.vars*` and no `*.cpuprofile`
outside `node_modules`. The secret-shape scan (`sk-`, `AKIA`, `ghp_`, PEM private-key headers)
across the tree excluding `node_modules`/`dist`/`.wrangler` hits only the same three synthetic
redaction fixtures — `tests/workforce.test.ts:323`, `tests/ai.test.ts:245`, `e2e/p4-ai.spec.ts:43`,
plus the `tests/ai.test.ts:257` assertion that the value does not survive into a failure reason.
`wrangler.toml` carries only non-secret resource identifiers.

**Approved-scope files re-hashed after the full validation run: all four byte-identical to the
pre-run table above.** A `find -newer` against this run's implementation contract, excluding the
regenerated `node_modules/`, `dist/`, `.wrangler/`, `test-results/`, returns **nothing** up to this
ledger entry.

### Boundaries honoured

No deployment, no Cloudflare API call, no Cloudflare resource creation, no Access change, no
application/auth source change, no GitHub or Boss OS mutation, no secret added, no mutation outside
the authorized root, no snapshot ZIP created, and no edit to `STATE.json`,
`EXECUTION_IDENTITY.json`, deployment history, or artifact-eligibility metadata. WORK was not moved
or renamed. The unrelated user work in the tree was preserved, not reverted (§6).

### Still UNPROVEN after this generation — external only

Remote publish to `west-peek-os.seq-taylor.workers.dev`, remote D1 migration apply (`0024`–`0026`),
remote backup, and live AI/vendor provider calls remain **UNPROVEN** behind credential/approval
gates; a dry-run is not a deployment. Cloudflare Access's live behaviour on the production hostname
is **externally recorded by the operator, never proven here**. `preview` still has no profile.
**Deployment must specify `--env production`** — a bare `wrangler deploy` would ship the LOCAL
profile, and repairing that is forbidden by §2.1/§3/§5, so it stays a documented procedural gate in
`docs/ENVIRONMENTS.md`. This entry is not a design review of the unrelated user work, which was
never scoped to this task; `LOCAL_ARTIFACT_VERIFIED` must not be read as approval of it.

**Remaining approved implementation scope is materially complete and independently re-validated at
generation 2. Ready for P5 mandatory final senior review and P6 host packaging.**

---

## Run `20260817T164320Z-59986` — P5 MANDATORY FINAL SENIOR REVIEW, generation 3 (2026-08-17)

**Role.** Final review / repair. Generation 1 (`opening`) recorded P1–P4 and generation 2
(`implementation`) re-executed them independently. I am generation 3 under
`EXECUTION_CONTRACT_FINAL_REVIEW.md`, checkpoint SHA256
`ba93510cb64e19b9928587c179211848b075e3d0d649ac58708f53c430c3219e`, task SHA256
`e323bce362ec868e20f229bb8c2501b962916b9dbab580072bea5e27ac266964`. Nothing was rebuilt, reset, or
reverted. **No prior generation's validation table was inherited** — every command below ran in this
session from the locked target root.

### Pre-repair state — approved-scope files hashed before any command

| File | SHA256 | vs. generation 2 |
|---|---|---|
| `wrangler.toml` | `8d66dcee0d6d1ae94cee991a9790746e847209b043119af0ffd7472ca396ae82` | identical |
| `docs/ENVIRONMENTS.md` | `b63426d031c3bef3ffc2cf6c326ada40dce08220ad62c9674e5cb2b7a01b3292` | identical |
| `ARCHITECTURAL_DECISIONS.md` | `22edfef27516bf08de8075e50561406a1fc72b9955a0047ee3b4ce92eed2d254` | identical |
| `src/worker/auth.ts` | `13bc20a1207654f15a026b52466535582aca2a01f416d19e2c3feb86fdfcffc6` | identical |

### §2 re-read against `wrangler.toml` itself, not against the prior entries

- §2.1 local profile preserved — `name = "west-peek-os"` (:17), `WP_OS_ENV = "local"` (:49), ADR-007
  placeholder D1 `00000000-0000-0000-0000-000000000000` (:34) and KV `0000…0000` (:45), R2
  `WP_OS_DOCUMENTS` (:39), `ASSETS` + `not_found_handling = "single-page-application"` (:23–26),
  ADR-017 cron (:56).
- §2.2 `[env.production]` at :72 with `name = "west-peek-os"` restated at :73 — a named environment
  would otherwise target `west-peek-os-production`, not the proven Worker.
- §2.3 `WP_OS_ENV = "production"` at :97.
- §2.4 D1 `west-peek-os-db` / `1d7c242b-fddc-41f1-843c-03dd2db6fbef` (:80–84), KV
  `bf0750e8e9a648758a5de978088c97da` (:90–92), R2 `west-peek-os-documents` (:86–88), assets
  `./dist/client` bound `ASSETS` single-page-application (:75–78), observability enabled (:99–100).
- §2.5 documentation — both files read in full, not sampled. One defect found and repaired (below).

### §3 verified at the source over the current tree

`grep -rn WP_OS_ENV src/` returns three executable consumers and no others: `auth.ts:28`
(`x-wpos-dev-user` **only** when `env.WP_OS_ENV === "local"`, otherwise
`Cf-Access-Authenticated-User-Email`), `services/networkAdapter.ts:623` (local fixture path refused
when not `"local"`), `index.ts:395` (health echoes the env name and binding-presence booleans — no
value, no secret). `resolveFirmUser` fails closed: missing header, unknown email and non-`ACTIVE`
status all resolve `null` → 401.

Router auth default independently confirmed: `router.ts:32` is `auth: opts.auth ?? true`, and
`/api/health` (`index.ts:419`) is the **only** route in the tree declaring `auth: false`. Unmatched
`/api/*` paths resolve identity before answering 404 (`index.ts:811–814`), so an unauthenticated
probe cannot enumerate routes. The unrelated user work's new routes — `/api/meetings/:id/live-help`
(:578–579) and `/api/briefings*` (:689–690) — carry no `auth: false` and are therefore authenticated
by that default. A boundary check, **not** a design review of work this task never scoped.

### Material defect found and repaired — `docs/ENVIRONMENTS.md`

The heading at :5 still read **"local (the only environment that exists)"**. That was true when it
was written and is now false, and it is contradicted twice inside the same file: :21–28 records an
externally verified prior production deploy of the `west-peek-os` Worker plus a bound production
Worker secret, and :34–39 describes the `[env.production]` profile this task admits. A production
environment demonstrably exists; what is true is that this repository never exercises it.

Repaired to **"local (the only environment this repository exercises)"** — one heading, no body
change, preserving every UNPROVEN label and the `--env production` procedural gate verbatim. This is
§2.5 production-environment documentation, so the repair is inside approved scope, and it removes a
false claim rather than adding one. Post-repair hash: `docs/ENVIRONMENTS.md`
`211c3ecd04901a41a4c8451f2d871e4021cab92151b1b4b000bde6d38bc7c50d`.

### P4/§6 validation — every row executed in this session, all rc=0; rows 2–4 re-run after the repair

| # | Command | Result |
|---|---|---|
| 1 | `npm --prefix west-peek-os ci` | rc=0 — frozen install from `package-lock.json` |
| 2 | `npm --prefix west-peek-os run typecheck` | rc=0 |
| 3 | `npm --prefix west-peek-os run build` | rc=0 — `dist/client` present |
| 4 | `npm --prefix west-peek-os run test` | rc=0 — **560/560**, 32 files |
| 5 | `npm --prefix west-peek-os run e2e` | rc=0 — **67/67** chromium, 43.9s |
| 6 | `npm --prefix west-peek-os run validate:authority` | rc=0 — PASS + self-test 4/4 + seeds fresh |
| 7 | `npm --prefix west-peek-os run validate:ai-boundary` | rc=0 — PASS + self-test 5/5 |
| 8 | `npm --prefix west-peek-os run validate:network-boundary` | rc=0 — PASS + self-test 6/6 |

`validate:brand` (rc=0, self-test 9/9) and `migrate:local` (rc=0, "No migrations to apply!") also
passed here; they sit outside the declared eight only because of the host's eight-command cap.
`dist/client` after build: `index.html`, `assets/`, `icon.svg`, `wp-mark.svg`,
`manifest.webmanifest`, `sw.js`.

**§6 profile facts — proven behaviourally in this session, still not host-declarable.**

- `npx wrangler deploy --dry-run --env production --outdir /tmp/wp_g3/prod` → rc=0, resolving
  `env.WP_OS_ENV ("production")`, KV `bf0750e8e9a648758a5de978088c97da`, D1 `west-peek-os-db`, R2
  `west-peek-os-documents`, `env.ASSETS`; Total Upload 894.88 KiB; ended `--dry-run: exiting now.`
- `npx wrangler deploy --dry-run --outdir /tmp/wp_g3/local` → rc=0, resolving
  `env.WP_OS_ENV ("local")` with placeholder KV `00000000000000000000000000000000` — the local
  profile is provably preserved **and** provably distinct from production.

`grep -cE "Uploaded|Deployed|Published|Current Version ID|workers\.dev"` over both logs returns
**0 and 0**. Nothing was published, `west-peek-os.seq-taylor.workers.dev` was never contacted, both
bundles went to `/tmp` outdirs outside the artifact. These stay **proven but undeclarable** in the
host evidence record — `wrangler deploy` is a forbidden proof token even with `--dry-run`, and
adding a repo surface that reads `wrangler.toml` is outside §2. A limit on declaration, not a gap in
verification.

**No secrets packaged**, rescanned here rather than inherited. No `.dev.vars*`, `.env`, `*.pem`,
`*.key` or `*.cpuprofile` outside `node_modules`. The secret-shape scan (`sk-`, `AKIA`, `ghp_`, PEM
private-key headers) across the tree excluding `node_modules`/`dist`/`.wrangler`/`test-results`
returns exactly **4** hits, all the known synthetic redaction fixtures —
`tests/workforce.test.ts:323`, `tests/ai.test.ts:245`, `e2e/p4-ai.spec.ts:43`, and the
`tests/ai.test.ts:257` assertion that the value does not survive into a failure reason. `backups/`
and `.wrangler/` were scanned separately and hold no secret-shaped value. `wrangler.toml` carries
only non-secret resource identifiers; the vault lives at `~/.west-peek-os/vault`, outside the
artifact. `docs/PROVIDER_READINESS_AUDIT.md` was re-read in full — names, counts and readiness
metadata only, no credential value.

**Post-run containment.** `find -newer EXECUTION_CONTRACT_FINAL_REVIEW.md`, excluding regenerated
`node_modules/`, `dist/`, `.wrangler/`, `test-results/`, returns exactly one file:
`docs/ENVIRONMENTS.md`. `wrangler.toml`, `ARCHITECTURAL_DECISIONS.md` and `src/worker/auth.ts` are
byte-identical to the pre-repair table. This generation mutated one documentation file and this
ledger, nothing else.

### Observed, deliberately NOT changed — outside approved scope

- **Production identity has no positive test.** `tests/api.test.ts:47` proves the dev header is
  *refused* when `WP_OS_ENV` is not `local`, and that is the security-critical direction. There is no
  test proving `Cf-Access-Authenticated-User-Email` *resolves* a `firm_user` under
  `WP_OS_ENV="production"`. The branch is two lines and is covered negatively; the positive path is
  unexercised. This is a pre-existing property of the approved baseline `auth.ts`, not a defect this
  run's change introduced, and §2 states required target changes are **limited to** the
  configuration and documentation items — so adding a test surface here would be scope expansion,
  not repair. Recorded rather than silently fixed or silently omitted.
- `AGENTS.md:46` still describes `migrations/` as `0001_… 0023_…` while `0024`–`0026` exist. The
  staleness is caused by unrelated user work §6 forbids reverting; the line is a layout note, not a
  contract or security statement, and is not §2.5 documentation.
- `REPO_VALIDATION_MATRIX.md:46–47,71` cites the P13–P25 continuation's own counts under the heading
  "What the continuation's own checks add". Explicitly phase-scoped historical evidence, not a claim
  about today's tree.

### Boundaries honoured

No deployment, no Cloudflare API call, no Cloudflare resource creation, no Access change, no
application/auth source change, no schema change, no GitHub or Boss OS mutation, no secret added, no
mutation outside the authorized root, no commit/push/merge, no snapshot ZIP, and no edit to
`STATE.json`, `EXECUTION_IDENTITY.json`, deployment history or artifact-eligibility metadata. WORK
was not moved or renamed. The unrelated user work in the tree was preserved, not reverted (§6).

### Still UNPROVEN after this run — external only

Remote publish to `west-peek-os.seq-taylor.workers.dev`, remote D1 migration apply (`0024`–`0026`),
remote backup, and live AI/vendor provider calls remain **UNPROVEN** behind credential/approval
gates; a dry-run is not a deployment. Cloudflare Access's live behaviour on the production hostname
is **externally recorded by the operator, never proven here**. `preview` still has no profile.
**Deployment must specify `--env production`** — a bare `wrangler deploy` would ship the LOCAL
profile; repairing that is forbidden by §2.1/§3/§5, so it stays a documented procedural gate.

**P5 complete — ACCEPT.** Full approved scope §2.1–§2.5 reviewed clause by clause against the files
themselves, one material documentation defect found and repaired, §3 verified at the source, the
entire §6 surface re-executed green in this session after the repair, no secrets packaged, no
out-of-scope mutation. Ready for P6 host packaging. `LOCAL_ARTIFACT_VERIFIED` attests the approved
production-readiness contract and this repository's local proof surface — it is not approval of the
unrelated user work carried in the tree, which this task never scoped.

## Run `20260817T172455Z-70422` — CONTINUATION, opening worker, generation 1 (2026-08-17)

**Run semantics:** CONTINUATION under `EXECUTION_CONTRACT_OPENING.md`. Task SHA256
`e323bce362ec868e20f229bb8c2501b962916b9dbab580072bea5e27ac266964` — byte-identical to the task the
prior run `20260817T164320Z-59986` executed, verified by hashing `TASK/APPROVED_TASK.md` in this
session. Prior phases were preserved, not restarted: nothing was rebuilt from intake, reset, or
reverted. **No prior generation's validation table was inherited** — every command below ran in this
session from the locked target root.

### P1 — current state established by hashing, before any command ran

| File | SHA256 | vs. prior run's post-repair seal |
|---|---|---|
| `wrangler.toml` | `8d66dcee0d6d1ae94cee991a9790746e847209b043119af0ffd7472ca396ae82` | identical |
| `docs/ENVIRONMENTS.md` | `211c3ecd04901a41a4c8451f2d871e4021cab92151b1b4b000bde6d38bc7c50d` | identical |
| `ARCHITECTURAL_DECISIONS.md` | `22edfef27516bf08de8075e50561406a1fc72b9955a0047ee3b4ce92eed2d254` | identical |
| `src/worker/auth.ts` | `13bc20a1207654f15a026b52466535582aca2a01f416d19e2c3feb86fdfcffc6` | identical |

### P2 — §2 compared against `wrangler.toml` itself, not against the prior entries

- §2.1 local profile preserved — `name = "west-peek-os"` (:17), `WP_OS_ENV = "local"` (:49), ADR-007
  placeholder D1 `00000000-0000-0000-0000-000000000000` (:34) and KV `0000…0000` (:45), R2
  `WP_OS_DOCUMENTS` (:38–40), `[assets]` `./dist/client` bound `ASSETS` with
  `not_found_handling = "single-page-application"` (:23–26), ADR-017 cron `*/15 * * * *` (:55–56).
- §2.2 `[env.production]` at :72, with `name = "west-peek-os"` restated at :73 — without that
  restatement a named environment resolves `west-peek-os-production`, not the proven Worker.
- §2.3 `WP_OS_ENV = "production"` at :97 under `[env.production.vars]`.
- §2.4 authorized resources only — D1 `west-peek-os-db` / `1d7c242b-fddc-41f1-843c-03dd2db6fbef`
  (:80–84), KV `bf0750e8e9a648758a5de978088c97da` (:90–92), R2 `west-peek-os-documents` (:86–88),
  assets `./dist/client` bound `ASSETS` single-page-application (:75–78), observability
  `enabled = true` (:99–100).
- §2.5 both documentation files read in full, not sampled. `docs/ENVIRONMENTS.md` still carries the
  prior generation's repaired heading ("the only environment this repository exercises"), every
  UNPROVEN label, and the `--env production` procedural gate. `ARCHITECTURAL_DECISIONS.md:77` still
  records the profile behind the deployment approval gate. Both accurate against the current file —
  no defect found, so nothing was rewritten to manufacture a repair.

### P3 — no missing approved change to apply

Every §2.1–§2.5 clause was already satisfied by the preserved WORK. §2 states required target changes
are **limited to** those items, so there was nothing to add and nothing was invented. This generation
mutated no artifact file except this ledger.

### Post-seal unrelated user work — preserved, validated, not reverted, not endorsed

`find -newer` against the prior run's contracts shows five files changed **after** that run sealed
(12:00–12:20, outside any Repo Operator generation): `src/client/pages/IntentPage.tsx`,
`src/client/App.tsx`, `src/client/styles.css`, `e2e/p18-intent.spec.ts`, `e2e/p25-journeys.spec.ts`.
§6 forbids reverting unrelated user work, so it was preserved untouched and the full validation
surface below was re-run **over the tree containing it** rather than over the prior seal's tree.

Boundary-checked, not design-reviewed: the change set is client + e2e only — no `src/worker/` file,
no `migrations/` file, no `wrangler.toml`, no `auth.ts`. `App.tsx:1411` sends `x-wpos-dev-user` from
localStorage, which is pre-existing client behaviour the worker refuses whenever `WP_OS_ENV` is not
`"local"`; it adds no server-side identity path. No external host, credential, or token literal
appears in any of the five files.

### §3 security law verified at the source over the current tree

`grep -rn WP_OS_ENV src/` returns three executable consumers and no others: `auth.ts:28` (dev header
**only** when `env.WP_OS_ENV === "local"`, otherwise `Cf-Access-Authenticated-User-Email`),
`services/networkAdapter.ts:623` (local fixture path refused when not `"local"`), and `index.ts:395`
(health echoes the env name only — no value, no secret). `router.ts:32` is `auth: opts.auth ?? true`,
and `/api/health` (`index.ts:419`) remains the **only** route in the entire tree declaring
`auth: false` — the post-seal user work introduced none. No auth code changed, no Access weakening,
no development identity behaviour added, no Cloudflare resource created, no secret added.

### P4 / §6 — validation, every row executed in this session from the locked target root

| # | Command | Result |
|---|---|---|
| 1 | `npm --prefix west-peek-os ci` | rc=0 — frozen install from `package-lock.json` |
| 2 | `npm --prefix west-peek-os run typecheck` | rc=0 |
| 3 | `npm --prefix west-peek-os run build` | rc=0 — `dist/client` present |
| 4 | `npm --prefix west-peek-os run test` | rc=0 — **560/560**, 32 files |
| 5 | `npm --prefix west-peek-os run e2e` | rc=0 — **67/67** chromium, 44.6s |
| 6 | `npm --prefix west-peek-os run validate:authority` | rc=0 — PASS + self-test 4/4 + seeds fresh |
| 7 | `npm --prefix west-peek-os run validate:ai-boundary` | rc=0 — PASS + self-test 5/5 |
| 8 | `npm --prefix west-peek-os run validate:network-boundary` | rc=0 — PASS + self-test 6/6 |

`validate:brand` (rc=0, self-test 9/9) and `migrate:local` (rc=0, "No migrations to apply!") also
passed here; they sit outside the declared eight only because of the host's eight-command cap, and
this table is the record that they ran. `dist/client` after build: `index.html`, `assets/`,
`icon.svg`, `wp-mark.svg`, `manifest.webmanifest`, `sw.js`.

**§6 profile facts — proven behaviourally in this session, still not host-declarable.**

- `npx wrangler deploy --dry-run --env production --outdir /tmp/wp_g1_70422/prod` → rc=0, resolving
  `env.WP_OS_ENV ("production")`, KV `bf0750e8e9a648758a5de978088c97da`, D1 `west-peek-os-db`, R2
  `west-peek-os-documents`, `env.ASSETS`; Total Upload 894.88 KiB; ended `--dry-run: exiting now.`
- `npx wrangler deploy --dry-run --outdir /tmp/wp_g1_70422/local` → rc=0, resolving
  `env.WP_OS_ENV ("local")` with the placeholder KV `00000000000000000000000000000000` — the local
  profile is provably preserved **and** provably distinct from production.

`grep -cE "Uploaded|Deployed|Published|Current Version ID|workers\.dev"` over both logs returns
**0 and 0**. Nothing was published, `west-peek-os.seq-taylor.workers.dev` was never contacted, and
both bundles were written to `/tmp` outdirs outside the artifact. As in every prior generation these
two facts stay **proven but undeclarable**: `wrangler deploy` is a forbidden proof token even with
`--dry-run`, inline `node -e` proofs were rejected, and no existing repo surface reads `wrangler.toml`
— adding one would be an out-of-scope §2 target change. A limit on declaration, not a gap in
verification.

**No secrets packaged**, rescanned here rather than inherited. No `.dev.vars*`, `.env`, `*.pem`,
`*.key` or `*.cpuprofile` outside `node_modules`. The secret-shape scan (`sk-`, `AKIA`, `ghp_`, PEM
private-key headers) across the tree excluding `node_modules`/`dist`/`.wrangler`/`test-results`
returns exactly **4** hits, all the known synthetic redaction fixtures —
`tests/workforce.test.ts:323`, `tests/ai.test.ts:245`, `e2e/p4-ai.spec.ts:43`, and the
`tests/ai.test.ts:257` assertion that the value does not survive into a failure reason. The post-seal
user work introduced no new hit. `wrangler.toml` carries only non-secret resource identifiers; the
vault lives at `~/.west-peek-os/vault`, outside the artifact.

**Post-run containment.** `find -newer EXECUTION_CONTRACT_OPENING.md`, excluding regenerated
`node_modules/`, `dist/`, `.wrangler/`, `test-results/`, `backups/`, returns **no artifact file**.
All four approved-scope files re-hash byte-identical to the P1 table after the entire validation
surface ran. This generation changed only this ledger.

### Boundaries honoured

No deployment, no Cloudflare API call, no Cloudflare resource creation, no Access change, no
application/auth source change, no schema change, no GitHub or Boss OS mutation, no secret added, no
mutation outside the authorized root, no commit/push/merge, no snapshot ZIP, and no edit to
`STATE.json`, `EXECUTION_IDENTITY.json`, deployment history or artifact-eligibility metadata. WORK
was not moved or renamed.

### Still UNPROVEN after this run — external only, unchanged

Remote publish to `west-peek-os.seq-taylor.workers.dev`, remote D1 migration apply (`0024`–`0026`),
remote backup, and live AI/vendor provider calls remain **UNPROVEN** behind credential/approval
gates; a dry-run is not a deployment. Cloudflare Access's live behaviour on the production hostname is
**externally recorded by the operator, never proven here**. `preview` still has no profile.
**Deployment must specify `--env production`** — a bare `wrangler deploy` would ship the LOCAL
profile; repairing that is forbidden by §2.1/§3/§5, so it remains a documented procedural gate.

Approved scope §2.1–§2.5 is complete and re-verified against the files themselves; §3 holds at the
source; the whole §6 surface is green in this session over the tree that includes the post-seal user
work. Ready for P5 final senior review and P6 host packaging. `LOCAL_ARTIFACT_VERIFIED` attests the
approved production-readiness contract and this repository's local proof surface — it is not approval
of the unrelated user work carried in the tree, which this task never scoped.

## Run `20260817T172455Z-70422` — CONTINUATION, implementation worker, generation 2 (2026-08-17)

**Role:** IMPLEMENTATION under `EXECUTION_CONTRACT_IMPLEMENTATION.md`, handoff at 2026-08-17T17:31:08Z
from the opening worker (`reason: claude_planning_complete`, `open_gaps: []`, no locked plan text
recorded). Continuation semantics honoured: the opening worker's generation-1 section above was
treated as authoritative prior progress, nothing was restarted from intake, no completed phase was
reset, and no file was reverted. Task SHA256 rehashed in this session —
`e323bce362ec868e20f229bb8c2501b962916b9dbab580072bea5e27ac266964`, matching the contract.

**Inherited nothing.** Generation 1's validation table was read for context but not carried forward.
Every command in the P4 table below was executed in this session from the locked target root.

### P1 — current state, hashed before any command ran

| File | SHA256 | vs. generation 1's P1 table |
|---|---|---|
| `wrangler.toml` | `8d66dcee0d6d1ae94cee991a9790746e847209b043119af0ffd7472ca396ae82` | identical |
| `docs/ENVIRONMENTS.md` | `211c3ecd04901a41a4c8451f2d871e4021cab92151b1b4b000bde6d38bc7c50d` | identical |
| `ARCHITECTURAL_DECISIONS.md` | `22edfef27516bf08de8075e50561406a1fc72b9955a0047ee3b4ce92eed2d254` | identical |
| `src/worker/auth.ts` | `13bc20a1207654f15a026b52466535582aca2a01f416d19e2c3feb86fdfcffc6` | identical |

`find -newer EXECUTION_CONTRACT_IMPLEMENTATION.md`, excluding `node_modules/`, `dist/`, `.wrangler/`,
`test-results/`, `backups/`, returned **no artifact file** at session start: nothing moved between the
opening worker sealing and this generation beginning, so the tree this generation validated is the
same tree generation 1 described — including the five post-seal user-work files it recorded.

### P2 — §2 re-compared against `wrangler.toml` read in full in this session

Not accepted from the prior entry; re-read line by line.

- §2.1 local profile preserved — top level still `name = "west-peek-os"` (:17), `main` (:18),
  `compatibility_date = "2025-10-01"` (:19), `[assets] ./dist/client` / `ASSETS` /
  `single-page-application` (:23–26), ADR-007 placeholder D1 `00000000-0000-0000-0000-000000000000`
  (:34), R2 `west-peek-os-documents` (:38–40), placeholder KV `00000000000000000000000000000000`
  (:45), `WP_OS_ENV = "local"` (:49), ADR-017 cron `*/15 * * * *` (:55–56).
- §2.2 `[env.production]` present (:72) with `name = "west-peek-os"` restated (:73) — required, since
  a named environment would otherwise resolve `west-peek-os-production` rather than the proven Worker.
- §2.3 `WP_OS_ENV = "production"` (:97) under `[env.production.vars]`.
- §2.4 authorized existing resources only — D1 `west-peek-os-db` /
  `1d7c242b-fddc-41f1-843c-03dd2db6fbef` (:80–84), R2 `west-peek-os-documents` (:86–88), KV
  `bf0750e8e9a648758a5de978088c97da` (:90–92), assets `./dist/client` bound `ASSETS` with
  `not_found_handling = "single-page-application"` (:75–78), `[env.production.observability] enabled
  = true` (:99–100). No new binding, resource, or identifier was introduced.
- §2.5 documentation re-read, not sampled. `docs/ENVIRONMENTS.md` carries the `[env.production]`
  contract (:34–52), the explicit statement that declaring a profile is not deploying it (:40–43),
  the hard `--env production` procedural gate with its dry-run evidence (:44–52), and the
  externally-recorded-not-proven framing for Access and the prior deploy (:21–33).
  `ARCHITECTURAL_DECISIONS.md` ADR-007 (:72–81) records the amendment: real ids live only in the
  production profile, remain non-secret operator configuration behind the deployment approval gate,
  and remote deploy / Access / remote migration apply stay UNPROVEN. Both accurate against the
  current `wrangler.toml`.

### P3 — no remaining approved change to apply

All of §2.1–§2.5 were already satisfied by the preserved WORK. §2 limits required target changes to
those clauses, so the correct implementation action was to add nothing. No documentation was rewritten
to manufacture a repair, and no defect was invented to justify a mutation. This generation mutated no
artifact file except this ledger.

### §3 security law re-verified at the source over the current tree

`grep -rn WP_OS_ENV src/` returns two executable gates and one echo, and no others: `auth.ts:28`
selects `x-wpos-dev-user` **only** when `env.WP_OS_ENV === "local"` and otherwise
`Cf-Access-Authenticated-User-Email`; `services/networkAdapter.ts:623` returns `null` — refusing the
local fixture path — whenever the env is not `"local"`; `index.ts:395` echoes the env *name* on
health, no value. `grep -rn "auth: *false" src/` returns exactly one route, `/api/health`
(`index.ts:419`). `auth.ts` re-hashes byte-identical to its pre-run value. No auth code changed, no
Access weakening, no development identity behaviour added, no Cloudflare resource created, no secret
added. Production can never run `WP_OS_ENV=local` through the production profile, which pins
`"production"` — while a *bare* deploy would still ship the local profile, which is why the
`--env production` gate below stays documented rather than "fixed" (fixing it would be an
out-of-scope §2 target change).

### P4 / §6 — validation, every row executed in this session

| # | Command | Result |
|---|---|---|
| 1 | `npm --prefix west-peek-os ci` | rc=0 — frozen install from `package-lock.json` |
| 2 | `npm --prefix west-peek-os run typecheck` | rc=0 |
| 3 | `npm --prefix west-peek-os run build` | rc=0 — built in 408ms, `dist/client` present |
| 4 | `npm --prefix west-peek-os run test` | rc=0 — **560/560** passed, 32 files, 69.3s |
| 5 | `npm --prefix west-peek-os run e2e` | rc=0 — **67/67** passed, chromium, 44.8s |
| 6 | `npm --prefix west-peek-os run validate:authority` | rc=0 — PASS, self-test 4/4, seeds fresh (45 machines / 15 domains / 53 reserved actions / 204 action types) |
| 7 | `npm --prefix west-peek-os run validate:ai-boundary` | rc=0 — PASS, self-test 5/5, 31 employees all INACTIVE |
| 8 | `npm --prefix west-peek-os run validate:network-boundary` | rc=0 — PASS, self-test 6/6 |

`validate:brand` (rc=0, self-test 9/9) and `migrate:local` (rc=0, "No migrations to apply!") also ran
green in this session; they sit outside the declared eight only because of the host's eight-command
cap, and this line is the record that they executed. `dist/client` after build:
`index.html`, `assets/` (`index-DCvpkPLp.css`, `index-DmGL_tOx.js`), `icon.svg`, `wp-mark.svg`,
`manifest.webmanifest`, `sw.js`.

**Observation, not a failure:** `npm ci` emitted `allow-scripts` warnings — `workerd`, `esbuild` and
`fsevents` postinstall scripts are pending approval under this npm's script policy. rc was still 0 and
the toolchain is provably functional afterwards: `vite build`, `vitest`, the Playwright suite (which
boots `wrangler dev`/miniflare, so `workerd` resolved) and both profile resolutions all succeeded. No
approval was granted and no install policy was changed — out of scope.

**§6 profile facts — proven behaviourally here, still not host-declarable.**

- Production profile, bundle-only resolution with `--outdir /tmp/wp_g2_70422/prod`: rc=0, resolving
  `env.WP_OS_ENV ("production")`, KV `bf0750e8e9a648758a5de978088c97da`, D1 `west-peek-os-db`, R2
  `west-peek-os-documents`, `env.ASSETS`; Total Upload 894.88 KiB / gzip 165.44 KiB; terminated
  `--dry-run: exiting now.`
- Local profile, same form with no `--env`, `--outdir /tmp/wp_g2_70422/local`: rc=0, resolving
  `env.WP_OS_ENV ("local")` with placeholder KV `00000000000000000000000000000000`, plus wrangler's
  warning that environments exist and none was targeted. The local profile is provably **preserved**
  and provably **distinct** from production.
- `grep -cE "Uploaded|Deployed|Published|Current Version ID|workers\.dev"` over both logs returns
  **0 and 0**. Nothing was published, `west-peek-os.seq-taylor.workers.dev` was never contacted, and
  both bundles were written to `/tmp` outdirs outside the artifact.

As in every prior generation these two rows stay **proven but undeclarable** in the host's structured
command list: the wrangler subcommand involved is a forbidden proof token even under `--dry-run`,
inline `node -e` proofs were rejected, and no existing repo script reads `wrangler.toml` — adding one
would itself be an out-of-scope §2 target change. That is a limit on declaration, not a gap in
verification.

**No secrets packaged**, rescanned in this session rather than inherited. No `.dev.vars*`, `.env`,
`*.pem`, `*.key` or `*.cpuprofile` anywhere outside `node_modules`. The secret-shape scan (`sk-`,
`AKIA`, `ghp_`, PEM private-key headers) across the tree excluding
`node_modules`/`dist`/`.wrangler`/`test-results`/`backups` returns exactly **4** hits, all the known
synthetic redaction fixtures: `tests/workforce.test.ts:323`, `tests/ai.test.ts:245`,
`e2e/p4-ai.spec.ts:43`, and the `tests/ai.test.ts:257` assertion that the value does *not* survive
into a failure reason. `wrangler.toml` carries only non-secret resource identifiers; the vault stays
at `~/.west-peek-os/vault`, outside the artifact.

### Post-run containment

`find -newer EXECUTION_CONTRACT_IMPLEMENTATION.md`, excluding regenerated `node_modules/`, `dist/`,
`.wrangler/`, `test-results/`, `backups/`, returned **no artifact file** after the entire validation
surface had run, and all four approved-scope files re-hash byte-identical to the P1 table above. This
generation changed only this ledger.

### Boundaries honoured

No deployment, no Cloudflare API call, no Cloudflare resource creation, no Access change, no
application/auth source change, no schema change, no unrelated cleanup, no GitHub or Boss OS or
partner/reference-repo mutation, no secret added, no mutation outside the authorized root, no
commit/push/merge, no snapshot ZIP, and no edit to `STATE.json`, `EXECUTION_IDENTITY.json`, deployment
history or artifact-eligibility metadata. WORK was not moved or renamed. The five post-seal user-work
files (`src/client/pages/IntentPage.tsx`, `src/client/App.tsx`, `src/client/styles.css`,
`e2e/p18-intent.spec.ts`, `e2e/p25-journeys.spec.ts`) were preserved untouched and validated in place,
per §6's prohibition on reverting unrelated user work.

### Still UNPROVEN after this generation — external only, unchanged

Remote publish to `west-peek-os.seq-taylor.workers.dev`, remote D1 migration apply, remote backup, and
live AI/vendor provider calls remain **UNPROVEN** behind credential/approval gates — a dry-run is not
a deployment. Cloudflare Access's live behaviour on the production hostname is **externally recorded
by the operator, never proven here**. `preview` still has no profile. **Deployment must specify
`--env production`**; a bare `wrangler deploy` would ship the LOCAL profile, and repairing that is
forbidden by §2.1/§3/§5, so it remains a documented procedural gate.

Approved scope §2.1–§2.5 is complete and independently re-verified against the files themselves; §3
holds at the source; the full §6 validation surface is green in this session over the tree that
carries the post-seal user work. Remaining approved implementation scope is materially complete —
ready for P5 mandatory independent final senior review, then P6 host packaging.
`LOCAL_ARTIFACT_VERIFIED` would attest the approved production-readiness contract and this
repository's local proof surface; it is not an endorsement of the unrelated user work carried in the
tree, which this task never scoped.

## Run `20260817T172455Z-70422` — CONTINUATION, final review / repair worker, generation 3 (2026-08-17)

**Role:** FINAL REVIEW under `EXECUTION_CONTRACT_FINAL_REVIEW.md`, handoff at 2026-08-17T17:37:36Z
(`reason: claude_implementation_complete`, `open_gaps: []`, `previous_role: implementation`,
`worker_generation: 2`). This is P5. Continuation honoured: generation 1 and generation 2 above were
treated as authoritative prior progress; no phase was reset, nothing was rebuilt, nothing was reverted.
Nothing in generation 2's entry was accepted on its word — every load-bearing claim below was
re-derived in this session from the files and from commands run here.

### Findings — approved scope §2, re-verified independently against `wrangler.toml`

- §2.1 local profile preserved. Top level: `name = "west-peek-os"` (:17), `main` (:18),
  `compatibility_date = "2025-10-01"` (:19), `[assets] ./dist/client` / `ASSETS` /
  `single-page-application` (:23–26), ADR-007 placeholder D1 `00000000-0000-0000-0000-000000000000`
  (:34), R2 `west-peek-os-documents` (:38–40), placeholder KV `00000000000000000000000000000000`
  (:45), `WP_OS_ENV = "local"` (:49), ADR-017 cron `*/15 * * * *` (:55–56). Untouched.
- §2.2 `[env.production]` present (:72), `name = "west-peek-os"` restated (:73).
- §2.3 `WP_OS_ENV = "production"` (:97).
- §2.4 authorized existing resources only — D1 `west-peek-os-db` / `1d7c242b-fddc-41f1-843c-03dd2db6fbef`
  (:80–84), R2 `west-peek-os-documents` (:86–88), KV `bf0750e8e9a648758a5de978088c97da` (:90–92),
  assets `./dist/client` bound `ASSETS` with `not_found_handling = "single-page-application"` (:75–78),
  `[env.production.observability] enabled = true` (:99–100). Nothing new introduced.
- §2.5 documentation accurate. `docs/ENVIRONMENTS.md:34–52` states the `[env.production]` contract,
  that declaring a profile is not deploying it, and the hard `--env production` procedural gate;
  `:21–33` keeps Access and the prior deploy framed as externally recorded, never proven here.
  `ARCHITECTURAL_DECISIONS.md` ADR-007 (:72–81) records the deployment-profile separation, the ids as
  non-secret operator configuration behind the approval gate, and remote deploy / Access / remote
  migration apply as UNPROVEN. Both read true against the current `wrangler.toml`.

**No material defect was found inside the approved scope, so no repair was applied.** §2 limits
required target changes to §2.1–§2.5; all five already held. Nothing was rewritten to manufacture a
repair, and no defect was invented to justify a mutation. This generation mutated only this ledger.

### Worker-name resolution — settled empirically this session, not assumed

Generation 2 asserted that restating `name` under `[env.production]` prevents wrangler from deploying
to `west-peek-os-production`. That claim is load-bearing (a wrong Worker name would miss the proven
target), so it was tested rather than trusted, in a throwaway `/tmp` project touching nothing here:
a config whose `[env.production]` sets `name = "Bad Name!"` fails validation with
`"env.production" environment configuration - Expected "name" ... but got "Bad Name!"` — the raw
string, with no `-production` suffix appended. An explicit environment-level `name` is therefore the
environment's name verbatim, so this repository's `[env.production]` resolves to the Worker
`west-peek-os`. The temp project was deleted.

### §3 security law re-verified at the source

`grep -rn WP_OS_ENV src/` returns exactly three call sites and no others: `auth.ts:28` selects
`x-wpos-dev-user` **only** when `env.WP_OS_ENV === "local"` and otherwise
`Cf-Access-Authenticated-User-Email`; `services/networkAdapter.ts:623` refuses the local fixture path
whenever the env is not `"local"`; `index.ts:395` echoes the env *name* on health. `auth.ts` re-hashes
`13bc20a1207654f15a026b52466535582aca2a01f416d19e2c3feb86fdfcffc6`, byte-identical to the pre-run
value in both prior generations' tables — no auth code changed. Production cannot run
`WP_OS_ENV=local` through the production profile, which pins `"production"`. No Access weakening, no
development identity behaviour added, no Cloudflare resource created, no secret added.

### §6 validation — every row executed in this final-review session

| # | Command | Result |
|---|---|---|
| 1 | `npm --prefix west-peek-os ci` | rc=0 — frozen install from `package-lock.json` |
| 2 | `npm --prefix west-peek-os run typecheck` | rc=0 |
| 3 | `npm --prefix west-peek-os run build` | rc=0 — `dist/client` present after build |
| 4 | `npm --prefix west-peek-os run test` | rc=0 — **560/560** passed, 32 files, 75.5s |
| 5 | `npm --prefix west-peek-os run e2e` | rc=0 — **67/67** passed, chromium, 44.8s |
| 6 | `npm --prefix west-peek-os run validate:authority` | rc=0 |
| 7 | `npm --prefix west-peek-os run validate:ai-boundary` | rc=0 |
| 8 | `npm --prefix west-peek-os run validate:network-boundary` | rc=0 |

`validate:brand` (rc=0) and `migrate:local` (rc=0, "No migrations to apply!") also ran green here; they
sit outside the declared eight only because of the host's eight-command cap, and this line is the
record that they executed. `dist/client` after build: `index.html`, `assets/` (`index-DCvpkPLp.css`,
`index-DmGL_tOx.js`), `icon.svg`, `wp-mark.svg`, `manifest.webmanifest`, `sw.js`.

`npm ci` again emitted `allow-scripts` warnings (`workerd`, `esbuild`, `fsevents` postinstall pending
approval). rc was 0 and the toolchain is provably functional afterwards — `vite build`, `vitest`, and
the Playwright suite, which boots `wrangler dev`/miniflare and so resolved `workerd`, all succeeded.
No approval was granted and no install policy was changed; that would be out of scope.

**Profile dry-runs re-executed in this session** (bundle-only, `--outdir` under `/tmp`, nothing
written into the artifact):

- `--env production`: rc=0, resolving `env.WP_OS_ENV ("production")`, KV
  `bf0750e8e9a648758a5de978088c97da`, D1 `west-peek-os-db`, R2 `west-peek-os-documents`, `env.ASSETS`;
  Total Upload 894.88 KiB / gzip 165.44 KiB; terminated `--dry-run: exiting now.`
- no `--env`: rc=0, resolving `env.WP_OS_ENV ("local")` with placeholder KV
  `00000000000000000000000000000000`, plus wrangler's warning that environments exist and none was
  targeted. The local profile is provably preserved and provably distinct from production.
- `grep -cE "Uploaded|Deployed|Published|Current Version ID|workers\.dev"` over both logs returns
  **0 and 0**. Nothing was published and `west-peek-os.seq-taylor.workers.dev` was never contacted.

These two rows remain **proven here but undeclarable** in the host's structured command list: the
wrangler subcommand is a forbidden proof token even under `--dry-run`, and no existing repo script
reads `wrangler.toml` — adding one would itself be an out-of-scope §2 target change. That is a limit
on declaration, not on verification.

**No secrets packaged**, rescanned in this session. No `.dev.vars*`, `.env`, `*.pem` or `*.key`
anywhere outside `node_modules`; `.env.example` is names-only with every value blank. The secret-shape
scan (`sk-`, `AKIA`, `ghp_`, PEM private-key headers) over the tree excluding
`node_modules`/`dist`/`.wrangler`/`test-results`/`backups` returns exactly **4** hits, all known
synthetic redaction fixtures: `tests/workforce.test.ts:323`, `tests/ai.test.ts:245`,
`e2e/p4-ai.spec.ts:43`, and the `tests/ai.test.ts:257` assertion that the value does *not* survive into
a failure reason. `wrangler.toml` carries only non-secret resource identifiers.

`grep -rIn "TODO|FIXME|not implemented"` over `src/` and `scripts/` returns **nothing** — no stub or
deferred-work marker anywhere in the implementation surface.

### Out-of-scope observation, deliberately not "repaired"

`REPO_VALIDATION_MATRIX.md` still states "26 suites, 506 tests" and "21 specs, 45 tests" against the
current actual 32 files / 560 tests and 67 e2e tests. The counts drifted low because of unrelated
post-seal user work, so the document understates coverage rather than overstating it. It is not
production-environment or architectural-decision documentation, so §2.5 does not reach it and §5
forbids the unrelated cleanup. Recorded here rather than silently changed.

### Post-run containment

`find -newer EXECUTION_CONTRACT_FINAL_REVIEW.md`, excluding regenerated `node_modules/`, `dist/`,
`.wrangler/`, `test-results/`, `backups/`, returned **no artifact file** after the entire validation
surface had run, and all four scope files re-hash byte-identical to both prior generations' tables:
`wrangler.toml` `8d66dcee0d6d1ae94cee991a9790746e847209b043119af0ffd7472ca396ae82`,
`docs/ENVIRONMENTS.md` `211c3ecd04901a41a4c8451f2d871e4021cab92151b1b4b000bde6d38bc7c50d`,
`ARCHITECTURAL_DECISIONS.md` `22edfef27516bf08de8075e50561406a1fc72b9955a0047ee3b4ce92eed2d254`,
`src/worker/auth.ts` `13bc20a1207654f15a026b52466535582aca2a01f416d19e2c3feb86fdfcffc6`. This
generation changed only this ledger.

### Boundaries honoured

No deployment, no Cloudflare API call, no Cloudflare resource creation, no Access change, no
application/auth source change, no schema change, no unrelated cleanup, no GitHub or Boss OS or
partner/reference-repo mutation, no secret added, no mutation outside the authorized root, no
commit/push/merge, no snapshot ZIP, and no edit to `STATE.json`, `EXECUTION_IDENTITY.json`, deployment
history or artifact-eligibility metadata. WORK was not moved or renamed. The post-seal user-work
client/e2e files were preserved untouched and validated in place, per §6.

### Still UNPROVEN after this generation — external only, unchanged

Remote publish to `west-peek-os.seq-taylor.workers.dev`, remote D1 migration apply, remote backup, and
live AI/vendor provider calls remain **UNPROVEN** behind credential/approval gates — a dry-run is not
a deployment. Cloudflare Access's live behaviour on the production hostname is **externally recorded by
the operator, never proven here**. `preview` still has no profile. **Deployment must specify
`--env production`**; a bare `wrangler deploy` would ship the LOCAL profile, and repairing that is
forbidden by §2.1/§3/§5, so it remains a documented procedural gate.

**P5 verdict: ACCEPT.** Approved scope §2.1–§2.5 is complete and independently re-verified against the
files themselves; §3 holds at the source; the full §6 validation surface is green in this session. No
locally implementable gap remains open. Ready for P6 host packaging. `LOCAL_ARTIFACT_VERIFIED` attests
the approved production-readiness contract and this repository's local proof surface — it is not
approval of the unrelated user work carried in the tree, which this task never scoped, and it is not a
deployment.

---

## 21 Aug 2026 — The cheap tier had never once worked

Opened from the operator's 22-item issues list, item 19: "The university tab doesnt work. It says
'university instructor couldn't respond.'"

### What it actually was

Not University. `src/worker/services/university.ts:125` shows the operator a fixed message and
stores the real reason on the turn, so production answered the question directly:
`provider_failure:provider_malformed_response`, twice, both University attempts.

Both hypotheses carried into the investigation were wrong, and are recorded because being wrong
cheaply is the point of checking. (1) The credential was NOT missing — `OPENROUTER_API_KEY` is bound
to the production Worker. (2) The spend gate was NOT refusing — `ai_run` shows 70 COMPLETED runs.
AI worked in production; one provider did not.

**Root cause.** Workers AI models answer in two different shapes. The older ones return
`{ response }`. The newer ones return the OpenAI chat-completion shape, `{ choices: [{ message:
{ content } }] }`, with no `response` field at all. `providers/workersAi.ts` read only `response`.

Of the three models registered by `0081_workers_ai_cheap_tier.sql`:

| model | shape | outcome |
|---|---|---|
| `granite-4.0-h-micro` | OpenAI only | failed 100% |
| `qwen3-30b-a3b-fp8` | both | worked |
| `llama-3.2-11b-vision-instruct` | n/a | error 5016, licence never accepted |

Routing selects the cheapest capable model. Granite is the cheapest. So **every run that reached
Workers AI failed, from the day the tier was added until this fix** — two runs, two failures, zero
successes. The migration's own header asks "did we survey the best open source models?" The survey
registered 3 of the 24 free models that actually work, and defaulted to the broken one.

The adapter had **no test of any kind** anywhere in the repo. That is how a 100%-failure bug shipped.

### What changed

- `providers/workersAi.ts` reads both shapes, and separates "the field never arrived"
  (`provider_malformed_response`) from "the model returned nothing" (`provider_empty_response`).
  Collapsing those cost a production database query to tell apart.
- Vision is supported for models that can see, instead of refused for the whole provider. The guard
  survives as a per-model allowlist, so a catalogue entry without an allowlist entry refuses images
  rather than sending them where they are ignored.
- `tests/router.test.ts` gains 6 tests built from shapes RECORDED from live calls, not invented.

### Proven, not asserted

Every claim here was checked against the live service, not inferred:

- Granite and Qwen both return correct text through the fixed adapter (`wrangler dev`, real `AI` binding).
- All 31 text and vision models on the account were scanned. One is licence-gated; five are blocked
  by the Workers **Free** plan (`deepseek-v4-flash`, `deepseek-v4-pro`, `kimi-k2.6`,
  `kimi-k2.7-code`, `glm-5.2`); one (`llava-1.5`) needs a different input form; 24 work today.
- `@cf/meta/llama-3.2-11b-vision-instruct`: **a Managing Partner accepted Meta's Llama 3.2 Community
  License and Acceptable Use Policy on 21 Aug 2026**, including the representation that the firm is
  not domiciled in, and has no principal place of business in, the European Union. Cloudflare
  confirmed. The model then described a generated test image correctly through the real adapter.
- Full surface green: `tsc --noEmit`, 1271 tests across 85 files, and all four validators with their
  self-tests.

### Still UNPROVEN

Not deployed. This fix is on branch `fix/workers-ai-cheap-tier` and has not reached production, so
University in production is still broken until it ships. The re-survey of the 24 working free models,
and surfacing unusable models to the partners, are recorded in `BACKLOG.md` rather than done here.

## 21 Aug 2026 — The follow-on discrepancy, settled

**The discrepancy.** "Follow-on candidate" named two unrelated populations. `/api/follow-on`
(Follow-on page) meant a held position whose latest metric reading beat its previous one — a
detected signal. `/api/cockpit` meant undecided `capital_allocation_option` rows inside an
allocation scenario — a queue of cheques somebody typed — and it included `RESERVE` options, which
are not follow-ons at all. The two pages could report different counts of "candidates" and both be
telling the truth, which is the worst kind of wrong number: unfalsifiable from either surface.

**Settled: detection owns the word.** A CANDIDATE is a company the system spotted. The Cockpit
panel is renamed for what it actually holds — `undecided_capital_options`, "Capital options nobody
has decided" — and its empty state now points at Follow-on rather than implying the list is
exhaustive. Nothing was deleted; the two lists were always distinct and both are wanted.

**The four stages are now stated once, on the Follow-on page**, because four words were in use for
one path and no surface connected them:

| Stage | Means | Lives |
|---|---|---|
| Candidate | a holding whose latest reading beat its previous one | Follow-on (detected) |
| Option | a cheque modelled inside an allocation scenario | Fund strategy |
| Review | the path economics, decided by a partner | Follow-on |
| Booked | an executed `FOLLOW_ON` transaction | the only stage where money moved |

Typecheck, `tests/cockpit.test.ts` (11), `validate:brand` and `validate:design-tokens` green.
