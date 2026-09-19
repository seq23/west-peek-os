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

## 21 Aug 2026 — Item 14: a partner can ask whoever runs the page

Item 8 put a named host on 17 pages — picture, title, the machines they are responsible for. A face
with no way to speak to it is a poster. `PageHostChat` mounts inside `PageHostCard`, so all 17 pages
got the panel in one change and none of them can forget it.

**Who answers is not a choice the partner makes.** The host of the page answers. A partner's question
on a page is nearly always about what that page is for, and making them first pick an employee out of
a roster of nineteen asks them to know the org chart before they can ask anything. `pageHosts.ts`
already holds the assignment and a test reads the real nav out of `App.tsx`, so there is no second
list to drift.

**A fourth turn table, which needed defending.** Three already existed and migration `0110` argued
against adding one. That argument was about reusing a table whose SCOPE was wrong — `meeting_chat_turn`
requires a meeting and its seated employees. The same objection applies to all three here: a page is
not a meeting, a course session or a research project, and hanging a page thread off any of them means
inventing a fake parent row per conversation. What is deliberately NOT new is the shape: same three
roles, same OK/FAILED/REFUSED, same rule that a provider failure is a visible turn.

**One thread per partner per page.** Two partners typing into one page thread is a ROOM — presence,
ordering across two clients, the Durable Object machinery `AGENTS.md` forbids without cause. A 1:1
needs none of it, and it is also the honest reading: Scooter did not hear what Sequoia asked.

**A switched-off host declines, in their own name, as a recorded turn.** The card already refuses to
smile over a page nobody is working. A box that answered anyway would teach a partner the status is
decoration.

**Veteran prompting reaches a third call site.** The host is prompted with `guidanceBlock(machineKeys)`
— the firm's own written methods for their machines — plus `pagePurpose` and their persona voice, none
of it duplicated into a prompt string. Item 17's standard still reaches only 3 of 33 `runAi` call
sites; the rest is the item 24 sweep.

**A landmine found on the way.** `ai_run_attribution.category` has a CHECK constraint
(PROACTIVE/RESEARCH/LEGAL/COMPLIANCE/OPERATIONS/INTELLIGENCE/OTHER) and `routing.ts:364` writes that
row with `INSERT OR IGNORE`. A category outside the list is therefore not rejected — it is silently
dropped, and the run goes unattributed forever with nothing saying why. The first draft here used
`ADVISORY` and would have hit exactly that. Changed to `OPERATIONS`; the `INSERT OR IGNORE` itself is
still there and is worth removing.

`tests/pageChat.test.ts` — 5 tests, green: refusal is recorded and named, an unhosted page has no
panel, threads are per partner, turn numbers count past failures so the UNIQUE constraint cannot jam
the thread, and neither an empty question nor a pasted document is accepted.

## 21 Aug 2026 — Item 25: the spine of the layout pass

An audit read all forty-odd surfaces against `LpPage.tsx`. Two findings applied to every page and
were worth more than any individual rebuild.

**`<hr>` was styled and used zero times.** `styles.css` defines the rule; not one page file used it,
LP included. "Sections separated by a rule" existed only as a sentence in the standard. Fixed in CSS
rather than by hand-inserting `<hr>` into forty files — which every new page would then forget: an
`h3` opens a section, so an `h3` that follows something now draws the line above itself. Reset inside
`.card`, `.module-card`, `.panel` and `details`, because a card already draws its own edge and a
second line just inside the first is a box drawn twice.

**The shell skipped `h2`, and that is why ranks drifted everywhere.** `App.tsx` rendered the page
title as `<h3>` — which both skipped a level under the `h1` wordmark and, worse, put the page's own
name at the SAME rank as a section inside it. With no rank left above the sections, pages picked
`h4`, `h5` or `h3` at random and none of them was wrong relative to the others: Governance and the AI
page have no `h3` at all, Rooms nests an `h3` two levels inside another `h3`, Meetings runs h3 → h5 →
h4, and `IntelligencePage` (478 lines), Contradictions, Activity and Documents have no headings
whatsoever.

The stylesheet had already been written for the right markup — `.shell-header h2 { font-size:
var(--text-xl) }` sat there unused while the JSX rendered an `h3` and silently picked up
`--text-lg`. The CSS was right; the markup had drifted. Title is now `h2`, and one rule falls out
that every page can follow: **a section is an `h3`, a thing inside a section is an `h4`.** That is
exactly what `LpPage` already did, which is why it is the page the operator says reads well.

`HomePage`'s greeting was a second `<h1>` competing with the wordmark; now `h2`. The accessibility
suite's "never skips a heading level" check is green again and now guards the rule.

**Nine pages restated their own nav label as their first heading** — Secondaries, Record,
Cross-office, Meetings, Events, University, Weekly review, Tasks and IC portal each opened with a
heading naming the tab you had just clicked. Removed. That is the operator's "space isnt being
wasted" complaint with a precise cause.

## 21 Aug 2026 — Item 13, first half: scenarios stop being modelled against fiction

The worst single defect found in this review, and it was invisible by construction.

Every allocation scenario the client created was hardcoded — `fund_size: 30000000, investable:
24000000, fund_deployed: 10000000, reserve_modeled_need: 8000000`, written straight into the POST
body in `App.tsx`. Not form defaults a partner could see and correct: **numbers no partner ever laid
eyes on.** The constraint engine then answered "does this sleeve fit", "is concentration within
limit" and "is the reserve sufficient" against a thirty-million-dollar fund the firm does not have,
and printed the answers with the confidence of arithmetic. West Peek's real recorded fund is four
orders of magnitude off that figure. Every scenario ever run was a comparison against fiction.

`GET /api/funds/:id/basis` now reads what the fund actually is. Three provenances and no fourth:
RECORDED (a human typed it into the fund record), DERIVED (computed from executed transactions), or
MISSING. There is deliberately no "assumed" — an assumption is what got us here.

- **Deployed is DERIVED from cost basis on open positions**, the only number the system genuinely
  knows: a position exists solely because a transaction was executed against an approval receipt.
  Marks are not used — what a holding is worth now is a judgement; deployed capital is a fact about
  money that left. Zero deployed is reported as DERIVED, not MISSING: a fund that has bought nothing
  has deployed nothing, and calling that MISSING sends the caller hunting a number that does not
  exist to be found.
- **Investable stays MISSING** until somebody records a fee model. Substituting the standard one
  would be the same mistake at a smaller scale.
- **The client refuses rather than substitutes.** The page already declined to open a scenario
  without a pinned policy version; it had no business being stricter about a policy id than about
  the size of the fund. `investable` and `reserve_modeled_need` are now OMITTED rather than zeroed —
  a zero reads as "the fund has nothing set aside" rather than "we were never told", which is how
  the last set of invented numbers came to look like facts.

`tests/fundBasis.test.ts` — 5 tests, green.

**Still open on item 13:** folding Deal Math into Fund strategy. Deferred while another agent is
extracting Portfolio from `App.tsx`; two concurrent rewrites of that file would collide.

## 21 Aug 2026 — Item 24: researching every role found four bugs, not four gaps

The operator asked for the roles to be researched and the machines given another pass, after having
to hand-write a job description herself: *"i should not have had to give u that. u r an ai and llm
and u should figure out what the role is."* The research produced the role work — and, on the way,
four defects that were live and silent.

**1 · The page chat prompted every host with their ENTIRE machine set.** Asking Wyatt a question on
Research arrived with seventeen skills attached — cap-table waterfall methods and opportunity-radar
methods alongside the research ones. Not merely wasteful: worse advice. An employee told to follow
five unrelated disciplines at once follows none of them well. `PAGE_HOSTS` entries now name the
machines the PAGE is about, defaulting to the seat's whole remit when the seat's remit IS the page.

**2 · Three pages were hosted by somebody holding no method for the page's own subject.** Thesis
hosted to Pierce while `investment_mandate_exclusion` sat only on Wyatt. Deal Math hosted to Preston
while `venturedeals_deal_math` — the machine, and the hand-verified arithmetic — sat on Wyatt. So the
one page in the firm devoted to deal arithmetic was chatting to somebody never given a single method
about it. Deal Math re-hosted to Wyatt (the library's own rule is deal-level to Wyatt, fund-level to
Preston, and the page is deal-level); Pierce now genuinely holds the mandate machine he hosts a page
for. `tests/pageHosts.test.ts` now fails the build if a page names a machine its host does not sit on
— the mismatch was silent and had shipped.

**3 · A recurring job targeted "Paige", who is not on the roster and never has been.**
`requiresEmployees` looked her up, never found her, and reported her missing, so
`diligence_ic_preparation` — the firm's only automated route from active diligence to an IC brief —
could never once be proposed. **The test suite passed throughout, because the fixture had invented
her too**: the employed set was a hand-typed list containing her name. A fixture that names people
the system does not have will agree with any bug that shares its imagination. The job is Poppy's, who
is the IC Facilitator and whose stated job is assembling the packet. The fixture is now built from
the real roster, and a new guard rejects any job targeting or requiring a name nobody has.

**4 · The Communications seat's only method belongs to another seat.** Pippa holds one machine,
`marketing_pr_content`, whose single skill is a landing-page conversion rubric written for Percy's
work on portfolio founders' products. So the seat responsible for press, embargoes, financing
announcements and what may be said publicly during a raise has no written method about any of it.
Not yet fixed — it is roster work, filed below with the rest of item 24.

**Also found, not yet acted on:** Piper and Wesley sit on one machine with byte-identical guidance
(two people working the same LP prospect); Pierce and Poppy share `ic_decision` while the firm's own
method says the champion may not write the kill case; and Whitney, the Professor, is seated on
`ic_learning_loop` — the post-mortem machine — so two of her three methods are investment methods and
there is no teaching machine in the registry at all.

## 21 Aug 2026 — 29 class names that styled nothing

Found while rebuilding Events & Rooms, which alone used nine class names the stylesheet had never
heard of. A repo-wide scan found twenty more.

**This is the one front-end mistake with no symptom.** A misspelt or never-written class does not
error, does not fail a test, and does not blank the element — it renders, unstyled, forever. What was
actually broken:

- **`.page`** — the wrapper on NINE pages. No flow, no rhythm; every child spaced only by whatever
  margin it happened to carry.
- **`.tablewrap`** — undefined ON THE LP PAGE, the surface held up as the layout standard. The
  commitment table could push the whole page sideways on a narrow screen.
- **`.lbl`** — used in five files, styled in none, so a label rendered at body weight and competed
  with the value it was labelling.
- **`.pill` / `.pill-*` / `.primary`** on Introductions — status badges rendered as bare shouting
  capitals with no badge around them, and the primary button rendered as default grey. Mapped to
  `help-tag*` and `btn-strong`, which are what this repo actually has.
- **`.deal-company` / `.deal-stage` / `.deal-blocker`** — the four cells of `.deal-row`. Only the
  grid's own `minmax(0, …)` was stopping a long company name blowing the row out: correct by luck
  rather than by intent.
- **`.brief-byline-who`**, **`.work-look`**, **`.card-body`**, **`.host-chat`** — all applied, none
  defined.

Redundant class hooks that merely duplicated a `data-testid` already on the same element were
removed rather than given a decorative rule.

`npm run validate:css-classes` now fails the build on any className with no rule, with eight
self-test cases covering the two traps that make this hard to check honestly: a class name appearing
only inside a CSS comment is NOT a definition, and a literal fragment cut by a `${…}` interpolation
is a prefix rather than a class.

**This is a large part of what the operator has been calling "jumbled".** Not one badly designed
page — dozens of small elements silently rendering with no styling at all, on every surface.

## 22 Aug 2026 — a dead duplicate Work page, carrying the live one's test id

`App.tsx` held a second `WorkCardsPage` — 102 lines, rendered by nothing, importing the real one
alongside it as `WorkSurface`. It carried `data-testid="work-cards-page"`, **the same id as the live
page**, so any test or e2e selector matching that id could have been asserting against a surface no
user can reach. It also rendered `WORK_CARD_STATES` raw into a dropdown, which is the machine
vocabulary the layout pass has been removing everywhere else.

Deleted. This is the third dead duplicate found in this review (the legacy meeting form that filed
everything as FOUNDER, the `MeetingsPage` copy, and now this), and they share a signature worth
naming: **a duplicate that keeps the original's test id is invisible to the test suite**. The suite
cannot tell you which one it exercised.

## 22 Aug 2026 — Item 7 (first half) and item 11's hidden machinery

**"The only way in" was a lie the page told about itself.** Dealflow captioned its Add-a-company
button "the only way in", which stopped being true the day email intake shipped — and it was worse
than saying nothing, because a partner who believes this is the single door stops looking for the
companies that arrived by the other three and does not know to check whether Wyatt has a card
waiting. It now reads "the one you drive yourself" and names the rest: an email to the intake mailbox
carrying one of the trigger tags, a company pushed across from Network OS, and Wyatt's own scouting —
all three of which open a WORK CARD rather than filing themselves, which is the operator's own model.
The tags and the mailbox are read from `shared/intake/emailTriggers.ts` rather than retyped, so the
page cannot drift into printing an address the handler no longer answers. `DEAL_INTAKE_EMPLOYEE` and
`ROUTING_EMPLOYEE` moved to that shared module for the same reason — a client cannot import from
`src/worker`, and a page that states the routes has to name who they land on.

Item 7's consolidation of the four routes themselves is still open.

**Meetings kept half its surface behind a disclosure.** Prep packets, notes, consent, transcripts,
debriefs and close-out sat collapsed under a summary reading "Meeting records and close-out", so the
half of the page that does the work only existed if you guessed to press it. Now a section with a
heading that says what it is for. The list also rendered `<code>FOUNDER</code> <code>SCHEDULED</code>`
beside every meeting; a partner reading their own calendar should not be shown a column value.

The FOUNDER-hardcoding create form named in item 11 was already gone — the note in the issues list
was stale.

## 22 Aug 2026 — `<h5>` no longer exists anywhere in the client

With the shell title corrected to `h2`, one rule covers every page: **a section is `h3`, a thing
inside a section is `h4`, and nothing goes deeper.** Every `h5` in `App.tsx` and every page file is
gone.

Promoting them was the smaller half. Several were machine vocabulary wearing a heading:

- "Unresolved material contradictions (HIGH/CRITICAL, OPEN/INVESTIGATING)" → "Disagreements that
  matter and are still open"
- "Add claim (source provenance required)" → "Record something the firm believes, and where it came
  from"
- "Detect contradictions (deterministic; humans decide)" → "Look for records that disagree"
- "Local fixture sync (no live system)" → "Practice run against sample data"

They were fixed BEFORE the rank change, so the promotion did not simply preserve them one size
larger.

**Contradictions** had no heading of any kind, no explanation, and opened on a bare "Refresh" button
above a list reading `VALUE_DISAGREEMENT · OPEN · HIGH`. A partner arriving there could not tell what
a contradiction was, why one existed, or what pressing anything would do. It now opens with what the
page is for, says these open by themselves and that nothing is deleted to settle one, and the refresh
control sits at the bottom where a thing-you-do-to-the-page belongs.

**Activity** was a table of primary keys shown to a Managing Partner: the Event column printed
`approval.decided` and the Object column printed `{object_type}/{object_id}`. `actionName()` already
existed and already promised never to return a raw dotted key — this surface simply never called it.
The id survives, behind the thing's name rather than as the whole cell, because it is how you find
the row again.

## 22 Aug 2026 — the AI page had no section headings at all

Audit finding #5, closed. The page's top-level headings were `h4` — a rank BELOW the shell's title —
so nothing on it read as a section, and one of those "headings" was a live data readout: `Policy:
BALANCED privacy · NORMAL cost · today $0.0031 / $5`. A heading names a section; a number is not a
name, and a figure that changes every few minutes cannot be one. It is a sentence now, under a real
`h3`.

The other two headings carried their own parenthetical documentation — "Providers (kill switch is
MP-only, logged via approval receipt)" — which is a sentence hiding inside a title. Split: the
heading asks the question ("Who the firm buys thinking from"), the sentence underneath says what a
kill switch does and who may throw one.

**`PRIVACY_CHOICES` was already in this file, sixty lines above the picker that ignored it.** The
sensitivity dropdown hand-typed the seven raw column values — `LP_PRIVATE`, `MNPI_SENSITIVE`,
`BANKING_RESTRICTED` — while a fully worded list of the same seven, each with what it costs you, sat
just up the page. A second copy of a list is a list that drifts, and this one already had. Neither
string reaches the screen any more.

Run rows also printed `<code>{status}</code> · {sensitivity} · {privacy_mode}/{cost_mode}` and
`output QUARANTINED`; they now read as a badge plus a plain sentence, with the trace id kept but no
longer competing with the purpose of the run.

## 21 Aug 2026 — Items 17 and 24: the cull, and what "retire" has to mean here

Four operator decisions, and one rule that governs all of them: **nothing is deleted.**

**The rule first, because it is the part that would have caused the damage.** Machines are seeded
into production D1 and referenced by `work_card`, `ai_run` and `ai_run_attribution`; AI employees are
referenced by those plus meeting seating. Migrations are append-only and both seed generators only
ever INSERT — so removing a row from a TypeScript registry does not remove it from any database that
already exists, it just leaves a row no code will claim again. Deleting instead would be worse: a
work card from June would lose the name of the machine that made it. So a retired machine keeps its
row and gains a `retiredReason`, `MACHINE_REGISTRY` is the historical list (46) and `ACTIVE_MACHINES`
(43) is what may be seated on, scheduled to or routed to. A culled seat goes RETIRED, the lifecycle's
existing word. `MACHINE_REGISTRY_VERSION` is `3.2.14+wp1` — canon is frozen at 3.2.14 and did not
move, so the suffix records West Peek's own revision rather than claiming the canon changed.

**1 · Piper merged into Wesley; the roster is 18.** LP Sourcing and LP Relations both sat on
`lp_fundraising` and NOTHING else, so they read byte-identical guidance and were two seats working
the same prospect at a fund with roughly forty LPs. The half of her worth keeping was a judgement
rather than a task — she would rather rule a name out early than carry it a quarter — and it is now
in Wesley's biography and persona voice. Dangling references found and fixed: `dutyRoster.ts` (the
evening shift, where a stale name would have been SILENT because `resolveDuty` drops unknown names),
`meetingTypes.ts` (the LP meeting suggested both), `aiEmployeePersonas.ts`, `CASTING.json`, and the
portrait test's list of faces the firm keeps for the retired. That silence is the "Paige" failure
again: a job pointed at somebody who does not exist, failing closed, with a fixture that agreed.

**2 · The Professor got a machine for her own subject.** `venture_teaching` is registry row 46 —
West Peek's own, the first row not in canon §5A.2. Whitney had been seated on `ic_learning_loop`,
which is the committee's 3/6/12/24-month post-mortem, so two of the Professor's three methods were
investment methods and the single teaching method in the library was filed under investing. The
post-mortem went back to Poppy, who keeps the committee record. **Deviation, named:** the operator
called this the Learning domain; there is no LEARNING domain and canon §0C fixes fifteen, so it maps
onto KNOWLEDGE_OS where Research and the record already sit.

**3 · Three machines retired.** `prompt_enhancer_intent` duplicated `askToCard.ts`, which turns a
partner's sentence into GO / WORK / TELL / BRIEF and does it better — two front doors is what that
file was written to end. `developer_diagnostics` and `builder_repo_product` assume an engineer on a
roster that has none. Migration `0126` adds `machine.retired_reason`, marks the three, and PAUSES
them: pause already has teeth in two independent places (capture routing 409s, `run_ai` refuses to
spend), so a retired machine stops taking work today rather than only in TypeScript.

**4 · Every remaining unseated machine took a seat, with no new headcount.** `lp_diligence_request`
and `lp_proof_engine` → Wesley; `data_room_control` → Wells, who hosts Documents and had no document
machine under it; `relationship_capital_budget` → Waverly; `meeting_capture_adapter` → Walter;
`external_helper_coordination` → Preston; `governance_center_broadcast` → Pax;
`activity_audit_ledger` → Willow rather than Pax, deliberately — it records what the workforce did
and must not sit under the person who runs it; `approval_center` → Pax for queue-hygiene reporting
ONLY, whose first written line is that nothing in the machine approves anything. After this, all 43
active machines have exactly one accountable seat and a written method, and the skill library's
"nothing to say" test now has to use a RETIRED machine as its example — which is the correct end
state rather than a workaround.

**Two seats also lost a machine on the firm's own method.** Pierce lost `ic_decision`, because the
committee machine's own `dissent` skill says the champion may not write the kill case and this seat
is always the champion. Percy came off `marketing_pr_content` entirely: he was on it only because his
page-conversion rubric happened to be filed there, which left the firm's PRESS machine holding a
method about buttons and the Communications seat with no written method about press, embargoes,
financing announcements or what may be said during a raise. The rubric moved to `taste_layer`, and
Pippa now has three methods that are actually hers — the announcement is the founder's and never
before the round closes; nothing public about the raise while the exemption forbids solicitation, and
anything naming a fund size, a close date or an invitation to invest goes to Compliance first; and
say only what a portfolio company has itself made public, with the date checked.

**Regeneration is owed to the lead, in this order:** `generate-machine-seed.mjs` first (0003's seed
block, now 46 machines; both expected counts in the script were changed deliberately, 46/43), then
`generate-ai-employee-seed.mjs` (0004's seed block, 18 employees; `EXPECTED_ROSTER_SIZE` 19 → 18).
The second will emit its own `_ai_employee_retire.sql`, which is a guarded no-op after 0126 already
retired Piper. `--check` reports STALE for both, as expected.

## 22 Aug 2026 — Governance: a row id handed over as confirmation

"Issue governance update (MP only)" was a sentence hiding inside a title — and it told the one person
who could see the form something they already knew, while telling nobody else anything. The heading
now asks the question and the condition is where it belongs.

Issuing one reported success as **`Issued gov_01H…`** — a primary key, handed to a Managing Partner
as her confirmation. It now says it landed and where to look. The list of what has actually been
issued had no heading at all, so the point of the page sat silently below two explainer cards and a
form.

The non-MP case was already handled correctly and left alone: rather than silently removing the
middle of the page, it says issuing is reserved, names the roles the reader actually holds, and
points at the list below.

## 22 Aug 2026 — Items 17 and 24: the cull, and nothing deleted

Operator decisions, taken directly: merge Piper into Wesley, give Whitney a real teaching machine,
retire three machines.

**Roster 19 → 18. Machines 46 total, 43 active.** Every one of the 43 active machines now has exactly
one accountable seat and at least two written methods — the "19 machines with no methods and 19 with
nobody on them are one fact" gap is closed.

**RETIRED IS A FLAG, NEVER A DELETE, and this is the load-bearing decision.** Machines are referenced
by `work_card`, `ai_run` and `ai_run_attribution`; employees by those plus meeting seating and status
history. Migrations are append-only and the generators only INSERT, so removing a row from the
TypeScript registry does not remove it from any database that already exists — it leaves a ghost no
code will claim again. Deleting instead would be worse: a work card from June would lose the name of
the machine that produced it. So `MACHINE_REGISTRY` keeps all 46 as the historical list,
`ACTIVE_MACHINES` (43) is what anything may be seated on or routed to, and migration `0126` marks the
three retired AND PAUSES them — which gives retirement teeth today (routing 409s, `run_ai` refuses to
spend) without any UI change.

**The seat had the same trap and I had not said so.** The registry said 18 while the lounge, which
reads the database, said 19. Caught by `tests/workforce.test.ts` and corrected mid-flight: Piper's row
is RETIRED, not removed, and the test now asserts the RULE — non-retired rows equal the registry
exactly, and her row is still present and retired.

**The dangling reference that would have gone unnoticed:** `dutyRoster.ts` listed Piper on the EVENING
shift. `resolveDuty` silently drops unknown names, so the shift would simply have got shorter, with
nothing failing and nobody covering the evening. This is the same signature as the phantom "Paige":
a name that no longer resolves, failing quiet.

**Two contradictions with the research, recorded rather than papered over.** There is no LEARNING
domain — canon fixes fifteen and the generator hard-guards the count — so `venture_teaching` sits in
`KNOWLEDGE_OS` beside Research and the record. And `MACHINE_REGISTRY_VERSION` became `3.2.14+wp1`
rather than a bump: canon 3.2.14 did not move, and the suffix records West Peek's own revision.

**Also fixed while passing:** `unretireAdvice.ts` had the roster size hardcoded as "nineteen seats …
a twentieth" INSIDE A LIVE PROMPT — an employee reasoning from a number that had just stopped being
true. Now derived from the roster it is actually given.

## 22 Aug 2026 — compensating for my own swallowed seed

`tests/seededJobs.test.ts` was failing at HEAD, and it was mine. Migrations `0112` and `0113` seeded
`diagnostics_sweep` with `INSERT OR IGNORE` — the exact pattern that had already, twice, reported a
successful migration while silently dropping the row on a CHECK failure. `0113` is literally named
"the diagnostics job actually lands" and used the swallowing form to land it.

Both are applied and cannot be edited, so `0127` compensates: `INSERT … SELECT … WHERE NOT EXISTS`
creates the job on any database where it was silently dropped, and any constraint failure now aborts
the deploy loudly. The two files are grandfathered in the test **on the strength of that file, and
the test now verifies it** — a grandfather list is where bugs go to be forgiven, so the exemption
checks that the compensation genuinely exists and does not itself use the swallowing form.

Also closed: `firmSkills.ts` let a partner draft a firm-written method for a RETIRED machine. Nobody
sits on one, so the method would be read by no employee ever, while costing a model run and appearing
to have been filed. Refused now, with the reason it was retired, and the machine list offers only
active ones.

## 22 Aug 2026 — Item 13: Deal Math folded, and merged addresses that still resolve

Deal Math was a signpost to the VentureDeals dashboards plus the firm's own figures to carry across
— which is the step you take WHILE deciding a cheque, not a separate errand. It is now the section
"What this cheque actually buys", placed BEFORE the scenarios rather than after: you size a cheque by
what it buys, and only then ask whether the fund can afford it.

**`MERGED_ROUTES` — the part worth keeping.** When two tabs merge, the old address has to keep
working; people bookmark, and a link in a note from three weeks ago should land somewhere sensible
rather than dumping the reader on Home. The first version simply rendered Fund strategy's content at
the `deal-math` address — which meant the page was titled Deal Math, signed by Deal Math's host, and
carrying Fund strategy's content: **a page signed by the wrong person.** Resolving the alias before
anything reads the key fixes the title, the host card and the purpose block together. `today` and
`allocation`, both merged earlier, are now resolved the same way instead of each carrying its own
render branch.

## 22 Aug 2026 — DEPLOYED AND VERIFIED

`npm run deploy:production` — eight migrations applied, `067d911e` deployed and verified.

Production, read back after the deploy rather than assumed:

| | |
|---|---|
| Live seats | 18 |
| Retired seats | 13 — every row still present, holding its AI runs, seating and work-card history |
| Machines | 46 |
| Retired machines | 3 — flagged and PAUSED, never deleted |
| `diagnostics_sweep` | present, confirmed by `0127` rather than assumed |

**Test position, stated honestly.** 1,535 tests: 1,452 passed, 82 skipped, 1 failed in the full run.
Seven FILES reported failure with `TypeError: fetch failed` — Miniflare port exhaustion, not
assertions. Every one of the seven was re-run alone and is green (14, 15, 12, 17, 18, 6 and 18 tests
respectively). The single failing test took 178 SECONDS before failing, which is a timeout rather
than a wrong answer, and passes in 18/18 alone.

**E2E REMAINS UNPROVEN and that is not a formality.** Playwright resets the local D1 and could not be
run with seven agents in the tree. Several specs were UPDATED to match new copy — `p51-rooms`,
`p17-machines`, `p16-ai-ops`, `p25-journeys`, `p22-24-integrations`, `p14-mp-home`, `p6-investment`,
`p7-meetings` — and NOT executed. The browser layer of this deploy is reasoned, not watched.

## 22 Aug 2026 — Standing authority, work-card guards, and the notification flow

### Standing authority (ADR-018, `docs/APPROVAL_AND_WORK_DESIGN.md`)

Operator: a way to approve something and stop being asked again for this task, today, or this week,
with the design decided rather than put to her.

**Framed as delegated authority, which decides everything else.** An LPA lets a GP act within stated
limits; a board delegates spend to a threshold; a desk sets a daily limit. Each carries a scope, a
limit and an expiry. Authority is delegable; judgment is not.

**The integration point was wrong at first, and the mistake is the useful part.** The check began
inside `authorize()`, where it was INERT wherever it was safe — only reserved actions and external
effects return REQUIRE_APPROVAL there, and neither is delegable — and DANGEROUS where it was not: it
would have satisfied a role-gated RESTRICTED action for **any identity at all, including the
read-only service account**, which is precisely the gate it was meant to respect. My own test caught
it. Delegating an approval is about the QUEUE, so it moved to `submitApproval`: a covered card is
written, attributed, auto-approved with the grant named in its note, and lands on the spine. It
simply does not sit there waiting. A delegation that made the record disappear would be a blind spot
rather than authority.

**All three bounds are required at creation** — `ends_at` NOT NULL, `max_uses` CHECKed above zero,
scope always an action key. A database trigger refuses to widen a live grant: raising a ceiling after
the fact is how a bounded permission quietly becomes an unbounded one. Uses are append-only and
recorded individually, so a grant can be audited rather than only counted.

**Reserved and external can never be covered**, refused at creation AND unreachable at the seam. A
test plants a forged grant row over `investment.approve` and proves it is still not honoured.

### Work-card guards

**Duplicates JOIN the existing card** rather than failing — an employee told "denied, duplicate"
rewords the title and files it anyway, turning a clean duplicate into a dirty one. Deliberately not a
UNIQUE index, which could only refuse.

**Volume is a health signal, not a permission.** 20 cards per employee per rolling hour, 60 open.
The numbers are not delicate: real work is 5–15 a day and a loop is hundreds an hour, so the
threshold only has to sit in the canyon between them. A permission gate here would have delivered a
runaway to the partners as forty approvals instead of stopping it.

**A long approval queue is now a bug report.** Diagnostics reports a queue over ten as DEGRADED and
names the action keys generating it, because past about ten a queue gets skimmed rather than read and
the fix is to stop those needing a decision — not to get through them faster.

### Notifications

**Acknowledge earns its place and now says why.** Operator: "what is the purpose of acknowledge?"
Dismiss is *seen, take it off my list*. Acknowledge — relabelled **Take responsibility** — puts a
partner's name and the time on the audit trail, which is only worth anything where being able to
show it matters. That is why it appears on CRITICAL and WARNING and nowhere else: offering it on a
routine notice trains a partner to click it unread, destroying the only value it has. The pair is
explained in one line where both buttons appear.

**Quiet hours stored a UTC hour, which is a real bug and not only a usability one.** 02:00 UTC is
9 PM in New York in January and 10 PM in July, so the setting drifted an hour twice a year — and
moved five hours the moment the app was opened in London. Now stored as the reader's own hour plus a
NAMED IANA ZONE she picks, so 9 PM in New York stays 9 PM in New York wherever she is. Rows without a
zone keep their old UTC meaning rather than silently changing.

Two further defects in the same control: the pickers **defaulted to 9 PM–7 AM regardless of what was
saved**, so the page showed a setting that was not the setting and pressing Save overwrote the real
one with the default; and failure read `Refused (HTTP 500)`. Save now moves Save → Saving… → Saved,
and a failure says plainly that nothing changed.

## 22 Aug 2026 — Item 7 (second half): the four routes converge on one door

**"Consolidate before adding" is done.** The Dealflow page stopped claiming to be the only way in
yesterday; the four routes underneath it now share ONE implementation. The entry point is
`openIntoFunnel(env, arrival: FunnelArrival): Promise<FunnelEntry>` in
`src/worker/services/dealIntake.ts`, and every route reaches the funnel through it:

| route | caller | what it does differently, and why that difference is real |
| --- | --- | --- |
| `MANUAL` | `handleCreateOpportunity` (`POST /api/opportunities`) | The only route that WRITES the pipeline, and the only one with an authenticated partner behind it. No work card — raising one would be asking an employee to confirm a decision a Managing Partner just made. |
| `EMAIL` | `intakeDealFromEmail` ← `handleInboundEmail` | A hashtag is a public word: it routes, it never authorises. Lands as a card for Wyatt. Mail whose company nobody can read still goes one rung down to Porter via `openRoutingCard`, which is deliberately NOT a funnel entry — there is no company to open. |
| `NETWORK_OS` | `intakeCompanyFromNetworkOs` / `POST /api/network/dealflow` | Network OS owns PEOPLE; this app owns DEALFLOW. A push is a proposal about our own record, so it gets a card and no mapping row, no cursor, no conflict. Letting it write would make the far system a second writer of a record it does not own. |
| `SCOUT` | `intakeScoutedCompany` / `POST /api/dealflow/scouted` | Identical work, one real difference: nobody outside the firm is waiting, so this list is Wyatt's to cut. The card says so, and says the opposite about inbound. What he drops still shows on the pass pile. |

The differences are declared once, in `ROUTE_POLICY`, rather than living in four functions — who
owns the card, which machine, whether the route may open the record, whether the finder may scrap it,
and the standing instruction. `openIntoFunnel` always does the same four things in the same order:
**match, decide, act, record.** The route only chooses which branch of "act" runs.

**One lookup, used by all four.** `matchFunnelCompany` checks canonical names AND aliases,
case- and punctuation-insensitively, and reports how it matched. Three copies of a matching rule is
three chances for the register to grow a second Sensori, which is the one thing D3 exists to prevent.

**Provenance on every route without exception.** Each arrival appends one `dealflow.arrival` event
carrying route, source, `received_at`, the far system's own key, the match and what came of it; the
manual route additionally stamps `source_channel` on the row. It was previously recorded on the two
machine routes and left blank on the door partners actually use, which makes "is our sourcing
repeatable" unanswerable for most of the pipeline.

**No migration and no new action key.** The routes authorize through the keys that already mean
exactly the right thing — `opportunity.create` for the route that writes, `work_card.create` for the
three that raise work — so `0132` is still the head and `validate:authority` reports seeds up to date
(241 action types). Nothing needs regenerating.

**Found on the way: the work-card duplicate guard was losing inbound deals.** The rule is written as
"at most one live card per (machine, object, owner)" and the query matched only (machine, owner). Every
funnel arrival shares Wyatt and the early-stage deal machine, so the SECOND company emailed in JOINED
THE FIRST COMPANY'S CARD and was never seen again — with a `work_card.duplicate_joined` event
recorded as if that were correct. The object term is now the `capture_id` where there is one and the
title otherwise, which is the only thing a directly-opened card carries that names what it is about.
Two tests hold it: two companies get two cards, the same company twice gets one.

`npx tsc --noEmit` green for every file touched; `tests/dealIntake.test.ts` replaced (25 tests, one
block per route plus a convergence block); `validate:authority` and `validate:network-boundary` both
PASSED with self-tests.

**Not proven, and it is the honest gap: the Dealflow page's own button.** `POST /api/opportunities`
runs through the door, so the manual route converges at the server — but `DealflowPage.tsx` still
creates the company with a separate `POST /api/companies` call first, and that page is owned by
another agent this session. Repointing it at the one door is the remaining step. `validate:sql` was
not run (it hits production); no deploy, no commit.

## 22 Aug 2026 — Steering work in flight, Home reordered, and why cards got wider

### A partner can tell an employee something while the work is running

Operator: "can the MPs give feedback on a work card that we want the ai employee to acknowledge
while they are doing the work?"

**What makes it real is that the note reaches the PROMPT.** `employeeWork.ts` already carried the
rule — *a method displayed on a page and never reaching a prompt is decoration* — and a feedback box
that only rendered would have been exactly that. Unanswered notes are re-read on every step and
placed ABOVE the original brief, because a partner interrupting a job in progress is correcting the
brief rather than adding to it.

**Acknowledgement is not a checkbox.** The employee must say what the note changes — or say plainly
that it changes nothing and why, which is a real answer and more useful than silent compliance. The
table's CHECK makes acknowledged and answered the same event, so a note cannot be marked seen without
a response. A flag alone would let an employee dismiss a partner's instruction without it ever
touching the work, which is the failure the feature exists to prevent.

A note on finished work is refused rather than accepted into a void — nobody re-reads a closed card.

### Home, reordered on operator direction

Ask → Needs your attention → **Waiting on you** → **Prepared for you** → the explainer.

**"Prepared for you" and "From your team" merged.** She asked why they were different and to be told
if the split was right. It was not: one held artifacts (briefs, packets, the weekly review — things
you open and keep), the other held people (each colleague's card). Two headings splitting one
question — *what is new for me* — along an implementation seam rather than anything a partner would
think. Now one section ordered by how finished the thing is: this morning's brief, then everything
else produced for you, then who has something but has not produced a document yet. The colleague
cards stay visible when empty, because silence from a named colleague is information and an absent
card is only a gap.

### Wider cards make a SHORTER page

Operator: "make sure cards are as long and wide as they need to be… without a lot of scrolling. are
[we] going to stack them almost like a deck with the tops exposed and pullable?"

**A deck was refused, with reasons.** It hides content behind a gesture — the same pattern this
review has been removing from Rooms, Machines, Sources & sweeps and Meetings. It fights the ranking
that makes a queue useful: the card three down may be the one that has waited three days. And
pulling is a drag interaction, slow on a trackpad and hostile to keyboard and screen readers.

The real cause was density, and it is counterintuitive: at a 19rem column minimum, `auto-fill` packs
four skinny columns onto a wide screen, so a sentence that sits on two lines at 30rem wraps over four
— every card gets TALLER and the page gets longer. Raised to 26–30rem and switched to `auto-fit`, so
a single card fills the row instead of sitting in a strip beside three empty tracks. No card has a
fixed height and none scrolls inside itself.

### Why there is no brief today

Operator: "my brief was not in my home page today at 7am ET." Diagnosed against production: the
pipeline was healthy, both profiles enabled, America/New_York, 06:15 earliest, weekends OFF — and it
was a Saturday. It behaved exactly as configured.

**The bug is that she had to work that out.** A blank where a brief should be reads as broken, and a
partner who believes the morning brief is broken stops relying on it. Home now carries the reason the
schedule gives — "No brief on a Saturday — weekends are off in your settings" — computed from the
reader's own weekday in her own timezone, because at 02:00 UTC on a Monday it is still Sunday in New
York and the schedule runs on the partner's calendar rather than on UTC's.

## 22 Aug 2026 — Item 7 closed, and a duplicate guard that swallowed real work

**All four routes into the funnel converge on `openIntoFunnel()`** — match, decide, act, record, in
that order. What differs per route is declared once in an exported `ROUTE_POLICY` table rather than
living in four functions: who owns the card, which machine, whether the route may write the pipeline
directly, and whether the finder may cut their own list. `createOpportunity` now has exactly one
production caller.

Only MANUAL writes the pipeline, because it is the only route with an authenticated partner behind
it — raising a work card there would ask an employee to confirm a decision an MP had just made. The
other three open a card and nothing else. Every arrival records a `dealflow.arrival` event with the
route, source, time and how it matched; that had been recorded on the machine routes and left blank
on the door the partners actually use.

### The bug I shipped this morning, found by the agent working the route above

My duplicate guard's own comment said *"at most one live card per (machine, object, owner)"* and the
query matched only **(machine, owner)**. Every funnel arrival shares Wyatt and the early-stage deal
machine — so **the second company emailed in joined the first company's card and was never seen
again**, with a `work_card.duplicate_joined` event recorded as though that were correct.

The class is worth naming because it is the worst kind: **a comment that describes a stricter rule
than the code implements.** The documentation was right, the guard was wrong, and the event log
asserted the wrong behaviour was intended. Anyone reading the file would have believed it worked.
The object term is now `capture_id` where there is one and the title otherwise, with two tests
holding it.

### And a CHECK constraint that did not constrain

`work_card_note` was written with
`CHECK (... OR (acknowledged_at IS NOT NULL AND length(trim(response)) > 0))`. **SQLite passes a
CHECK that evaluates to NULL** — only an explicit FALSE fails it — so against a NULL response the
comparison yielded NULL and the constraint silently allowed a note to be marked acknowledged with no
answer, which is precisely what it existed to prevent. Caught by its own test setting
`acknowledged_at` alone and watching the write succeed. Fixed with `IFNULL(...)`; every three-valued
comparison inside a CHECK needs the same treatment.

## 22 Aug 2026 — The deal record: one record per company, opening when the company is picked

Operator: *"the deal flow tab is still not good enough UI and UX wise. you need to fix it once we
pick a company and all the stuff comes out"*, and before that *"there should be 1 deal record for
every company with all fields in it — price per share and # of shares should be in the deal record
and it should open once u select a company"*, and *"i dont underestand why it cant be simple like
the lp page."*

**Picking a company did not open anything.** The company name on a pipeline row navigated to the
Companies register. The record lived in a SECOND component on the same route (`InvestmentPage`,
rendered under a heading called "Deal records and tooling") whose first control was another company
picker, then a list of that company's deals, then a click to pick one of them. So "pick a company"
meant picking it twice, on two surfaces, and the second one was the only one that showed anything.

**Price per share and the number of shares were on no surface at all.** The columns have existed on
`investment_opportunity` since migration 0006 and the only route to either was the transaction
ladder — which books a position, and is a different act from recording what a round is priced at.
A field marked as a placeholder could be corrected through the placeholder door; a field nobody had
marked could not be entered anywhere.

**What it is now.** `DealflowPage` owns the record. One company, one record, opening from the row
you pressed, laid out as a flat sequence of `h3` sections in the order the questions get asked:
where this stands · the deal itself · what we know and how we know it · what is still open · where
this deal stands with the committee · its history · add a second deal. Every section always renders
with an empty state that says what would fill it. The second deal is the only thing behind a
disclosure, which is what the operator asked for and nothing else got.

`tests/dealRecordLayout.test.ts` holds the shape: the section order, `h3`/`h4` only and no `h5`
anywhere in the client, exactly one `<details>` and which one it is, an empty state per section, no
identifier or enum printed on screen, and money formatted as money.

**Two gaps this leaves, both reported rather than papered over.**

1. `GET /api/companies/:id/history` returns the event key, the actor and the time, and the changed
   fields only for `company.updated`. So a pipeline move reads "Moved along the pipeline" without
   naming the stages, and a pass does not carry its reason into the trail even though the event
   payload holds both. The endpoint would need to pass `from`/`to`/`reason` through.
2. **A deal has no owner.** Nothing in the schema records who is carrying one, so "who owns it"
   is answered with the person who last acted on it, and the record says in as many words that
   that is what it is showing.

**And one capability is temporarily unreachable.** Assembling an IC packet and recording an IC
decision were reachable only from `InvestmentPage`, which this route no longer renders. The
committee section of the record is a commented placeholder for the agent bringing that across from
the meetings side; until it lands there is no UI route to IC assembly. `InvestmentPage` and the
three panels it alone used remain in `App.tsx`, unrendered, so that work has something to read.

## Item 11 — Meetings and the IC flow (ADR-019)

**The page.** `MeetingsPage.tsx` is now the whole surface: five flat `h3` sections, each always
rendered with its own empty state — what is coming up · what happened and what came out of it ·
start a meeting now · where a deal stands with the committee · how a meeting becomes work. The
explainer is last. `App.tsx` used to define a SECOND meetings page and mount it underneath the
first; both emitted `meeting-list` and `meeting-${id}`, so every selector on the surface was
ambiguous and opening a meeting in one had no effect on the other. That block is gone.
`tests/meetingsLayout.test.ts` holds the section order, the rank rule, an empty state per section,
and the one-page property.

**The IC flow, end to end.** `DILIGENCE → IC_READY` on the Dealflow spine now opens an `ic_packet` in
DRAFT and a work card for **Poppy** (owner_type AI, machine 18). The packet's gaps are named as
questions in `ic_open_question` rather than written as prose, each carrying what was looked at and
who owes the answer; the bear case is always one of them and is never owed by the champion. The
committee section shows packet state, the open questions, the derived seats and the decision, and
carries submit + decide because `InvestmentPage` is no longer rendered. A REJECT now sends the deal
to **PASS** with the decision's own rationale — `IC_DECIDED` could only move on to `CLOSED` or
`WITHDRAWN`, so a rejected deal's only forward move said the fund had invested in it.

**Capture — UNPROVEN, and the button says so.** In-browser `MediaRecorder`, a complete recording per
minute, posted to Workers AI Whisper (`@cf/openai/whisper-large-v3-turbo`) on the existing `AI`
binding. **The model has never been called.** There is no `AI` binding under miniflare and nothing
was deployed, so the capability is probed at runtime and the start button is DISABLED with the
reason on screen wherever the binding is absent — never live-looking and inert. What IS proven
offline: the response-shape handling, the refusal when the shape carries no text, the model's own
error passing through unchanged, and every gate refusing in sentences rather than error codes
(`tests/icStage.test.ts`). Transcription minutes sit outside the AI model ledger, which is stated
rather than papered over.

**Consent.** The machinery existed and had never been asked for. The prompt is now in front of
capture, carries the words to say out loud, records both a yes and a no through the existing
append-only `consent_record`, and is re-armed every time recording stops — a remembered consent is a
record of something that did not happen.

**Fireflies — PROVEN as an import, not as an integration.** Paste or upload an export; it parses
into the same transcript turns Whisper produces and lands through the same two gates.
`transcript_import.provider_name` names the vendor, the page says the firm did not make that
recording, and importing writes no consent row. The parser never guesses who spoke: an unattributed
line is kept and marked. The Fireflies **API** route is designed and deferred (credential, network
boundary, vendor decision) — ADR-019.

**Deliberately not built.** The shared live room for both Managing Partners, which is the only thing
here that would justify a Durable Object. Designed in ADR-019 and deferred: it is the one piece that
adds a new coordination primitive and a second failure surface, and shipping it alongside the
rebuild would make every problem on this page ambiguous between the two.

**Needs regenerating, not run here.** `ic_packet.question.raise` and `ic_packet.question.answer`
were added to `src/shared/registry/actionTypes.ts` and are compensated in migration `0131`. The
generated `0003` seed block has NOT been regenerated, so `npm run validate:authority`
(`generate-machine-seed.mjs --check`) will fail until somebody runs the generator.

## 22 Aug 2026 — The Sensori deck, and three bugs of mine found by a live email

Operator: "we got an updated deck for sensori overnight to os@joinwestpeek.com."

It had arrived at 03:29, been logged `inbound_email.rejected` — `too_large`, 7,093,115 bytes — and
been **discarded silently.** She found out by asking. Two defects, both mine:

**The cap contradicted a feature the firm had asked for.** `MAX_BODY_BYTES` was 256KB with the
comment *"real submissions are prose and a link, not megabytes"* — written before `#wpdeck` shipped,
whose entire purpose is megabyte decks. A limit that predated the thing it now blocked.

**And the drop said nothing.** Inbound deal flow vanishing without a word is the worst failure this
mailbox has, because the firm cannot miss what it never learns about.

**The fix rests on an asymmetry: storing is I/O, parsing is CPU.** A Worker gets 10ms of CPU, so
reading seven megabytes is impossible — but `R2.put` takes the stream without decoding it and costs
almost nothing. So an oversized message now streams whole to R2, routes from its HEADERS (already
parsed, free — `#wpdealflow Sensori` in the subject IS the routing decision), and opens a card
saying how big it was, which trigger it carried, and where the bytes are kept.

**Asked whether senders should zip: no.** Any rule depending on outsiders remembering something
fails the first time one forgets, and then the firm loses the deal rather than the attachment.

### Two more of mine, found by `validate:value-shapes` and by a test

**Work-card owners were stored in two formats.** `DEAL_INTAKE_EMPLOYEE` is the display string
"Wyatt", written straight into `owner_id`, while other paths wrote `aie_wyatt`. `runEmployeeWork`
resolves an owner with `ai_employee WHERE id = ?`, so **every card the email intake created answered
"That employee does not exist" and could never be worked** — the whole route from an email to Wyatt
acting on it died at the last step, in silence. Names are now resolved to ids centrally in
`createWorkCardInternal`, so no caller can get it wrong.

**And the fix I wrote for it broke the duplicate guard, in the same way, ten minutes later.** The
resolution ran AFTER the duplicate check, so the check compared a raw "Wyatt" against a stored
"aie_wyatt" and never matched — the guard silently stopped guarding for the exact route it was
written for. Resolution now happens first. Two bugs, one root: **a field with two permitted shapes
will be compared in the wrong one.**

The dedupe rule also became *same capture OR same subject*. Capture alone was too narrow: an intro on
Monday and an updated deck on Thursday are two captures about one company, so a capture-only rule
opened a second card for a company already being worked — which is precisely what happened to
Sensori's first arrival.

## 22 Aug 2026 — A deck now gets read, and every email reaches a person

### The middle of the deck journey was missing entirely

Operator: "the whole point is if we snd a deck the employee extracts all relevant info and fills in
gaps in the deal flow tab's company card. if its a new company they create a new one. if existing
they update it."

`deckReader.ts` could read a PDF and had been able to since it shipped. `#wpdeck` routed mail meaning
*the substance is in the attachment*. **Nothing extracted an attachment.** Wyatt's own prompt told
him to read a deck he was never handed. The only working path was uploading one by hand.

Built: `mimeAttachments.ts` (small and deliberately not a MIME library — a Worker has 10ms of CPU and
a general parser walking a multi-megabyte tree would not finish), `pending_deck` as a queue, and a
`deck_reading` job every fifteen minutes so a deck that arrives overnight is on the record before the
morning brief.

**It writes, and that is a decided change.** `handleReadCompanyDeck` deliberately wrote nothing —
*"a deck is the company's own account of itself; accept what you believe."* That is right about
CLAIMS and wrong about BLANKS: a company with no sector recorded is not protected by staying blank,
it is merely unusable. So blanks are filled and **every filled field is stamped `source: deck,
verified: false`**, which keeps the distinction the original rule protected while giving the operator
the filled-in card she asked for. A field a person typed is KEPT and recorded as kept — a deck is
newer, not more authoritative. Operator's ruling: *"fill blanks auto but stamp them."*

### No inbound email fails silently

Operator: "no inbound emails to os@joinwestpeek.com should silently fail. the employee responsible
for routing should surface that an email came in the needs attention box."

One path still did. A `#wpnetwork` message whose person could not be read, or whose relay was
refused, recorded the failure and told nobody — **so somebody deliberately tagged a person for the
firm's network, the firm quietly did not add them, and it looked exactly like it had worked.**

And the attention count was changed from *untagged emails* to **open routing cards**. Counting the
one failure mode we knew about would keep missing the ones we did not; counting what the handler
hands to a person cannot miss a new one, because handing it over IS opening a card.

### The whole roster is employed

Operator: "letes just turn all employees on to active then to start. all employees on and they can go
on and off duty as you wish with various rotating hours."

Migration `0136`. **Employment and duty were one number.** Employment is whether a seat exists and may
be given work; duty is who is covering the hours. Conflating them meant hiring somebody just to hear
from them and firing them to get quiet — which is why the workforce had exactly one employee who had
ever run anything. `dutyRoster.ts` already modelled shifts; this stops employment competing with it.

RETIRED seats stay retired, and anything already PAUSED is left alone: a partner who paused somebody
yesterday did it on purpose. The migration failed loudly on its first run — `actor_type` must be
HUMAN/AI/SYSTEM and it said `firm_user` — which is exactly why these no longer use `INSERT OR IGNORE`.

## 22 Aug 2026 — Cadence, and the base64 round-trip it exposed

Operator: "are we sure every 15 min is the right cadence to read the email for decks and stuff?"

**Email is not on a cadence.** Cloudflare Email Workers are push: the handler fires the moment a
message lands, so routing, the company match and the work card happen in seconds. The Sensori deck
was SEEN at 03:29 — it was rejected, not missed. The fifteen minutes applies only to the model
reading the PDF, and it is the floor rather than a preference: the cron is `*/15`, chosen in ADR-017
over adding Queues for a workload of a few jobs a day. Nothing blocks on the deck read, and an idle
tick costs one COUNT.

**The question found a real defect.** `deck_reading` was storing the MIME base64, decoding it to
bytes for R2, then re-encoding those bytes to base64 for the model — two conversions over megabytes,
against a **10ms CPU** budget. On a five-megabyte deck the job would have exhausted its budget and
failed **in a way that looked like an unreadable deck rather than a coding mistake**, which is the
same signature as everything else this review has dug out.

MIME hands us base64 and Workers AI wants base64; the bytes in between were nobody's requirement.
Stored as-is, read back as text: one R2 read and one model call, both I/O, no CPU. That is also what
makes three-per-tick safe — the cap exists for the $0.50 AI budget, not for CPU, because an uncapped
loop could spend the day's allowance on one bad night's mail before the partners are awake.

### The link that would have made the deck journey a convincing no-op

Tracing the chain end to end before claiming it worked found `intakeDealFromEmail` — a five-line
adapter between the email handler and `openIntoFunnel` — silently dropping `attachments` and `notes`.
The PDF would have been pulled out of the MIME tree and **discarded one function later**, with every
other link present and correct: extraction built, R2 store built, queue built, job built, blanks-and-
stamping built, and nothing ever stored.

Worth naming because of where it was. **A thin pass-through is the easiest place in a chain to lose
something, because it reads like plumbing rather than logic** — nobody reviews an adapter for missing
fields. The same shape as the duplicate guard whose comment was stricter than its query: the parts
that look too simple to be wrong.

### Two more silent paths, and one claim withdrawn

**A refused job was invisible to the health check.** `runJob` records `job_run.refused` and returns —
no notification — and the `scheduled_work` check looked only for FAILED and DEAD_LETTER, so REFUSED
fell through both. Production holds two from 20 Aug nobody was told about. Now DEGRADED rather than
DOWN, deliberately: a refusal is usually legitimate and transient (a spend ceiling reached, an
employee paused), so **the job is not broken, it is not happening**, and those need different words.

**A claim withdrawn.** The oversized-mail work card told the partner the message "is still in the
inbox". `os@joinwestpeek.com` routes to this Worker and whether a mailbox copy also exists depends on
a routing rule the code cannot see. Telling a partner her deck is somewhere it may not be is worse
than telling her it is gone, so the card now says plainly that this system kept no copy and to get it
from the sender's sent mail.

**On the Sensori deck specifically:** the rejection returned before anything was stored, so nothing of
that message exists here. It has to be sent again once this deploys. The chain up to `readDeck` is
deterministic and testable; the reading itself needs the live AI binding, so the honest proof is
watching it run in production on the real deck — the same "watched working" standard this repo exists
to enforce.

### Overruled on the deck rule, and the operator was right

I had built blanks-only: a deck fills empty fields and never touches one a human typed. Operator,
22 Aug 2026: *"i think the updated deck should overwrite us....coming from the company. overwriting
us is fine. maybe each company card has a field for MP notes that cannot be overwritten."*

**The original rule was split on the wrong axis.** It asked "did a human type it" when the question
is **whose fact is it**. Sector, one-liner and website are things the COMPANY is the authority on —
our copy is a transcription of something they told us earlier, and a newer deck is a more recent
statement from the same source. Keeping a stale transcription because a person typed it is how a
register slowly stops describing reality. What must never be touched is what the FIRM believes, and
that is a different kind of thing entirely; conflating the two produced a rule that protected the
wrong half.

So: a deck corrects the company's own facts, with the previous value carried on the event beside the
new one — an overwrite nobody can undo is not a correction. And `mp_notes` holds the firm's judgement,
guarded by a database TRIGGER rather than by a service remembering: `mp_notes_by` NULL is precisely
what separates a partner from an automatic process, because no job has a `firm_user` to put there. A
rule enforced only in TypeScript survives until somebody adds a service.

## 22 Aug 2026 — What actually arrives in this mailbox

Operator, describing real use: *"most of the emails to this inbox will be forwards and the important
info will be in the original email below since its a fwd or an attachment"*, *"some will have
#wpdeck #wpdealflow #wpnetwork all 3 triggers just b/c we ar busy and moving fast"*, and *"what is
the difference in wpdeck and wpdealflow? i think they should do the same but idk."*

**Forwards were recording the wrong sender.** The envelope is whoever forwarded it, so every
forwarded deck would have entered the register as having come FROM A PARTNER — saying Scooter
introduced Sensori when Scooter forwarded it. That is not cosmetic: Porter's own method is that
provenance is recorded at arrival or never, because deal-flow provenance is the only evidence a
Fund I has that its sourcing is repeatable, and a register where every row says "a partner sent it"
answers nothing at LP diligence. `forwardedOrigin()` recovers the original sender and subject from
the three forward shapes that actually arrive (Gmail, Apple Mail, Outlook), and **both are kept** —
a partner vouching for something is worth knowing, it is just not who it came from.

**`Fwd: FW: Re: Sensori` opened a company called "FW: Re: Sensori".** The subject cleaner stripped a
single `re|fwd` and did not know `FW:` at all. A twice-forwarded deck therefore produced a name that
could never match the company already on the board — exactly how a register grows a second row for a
company the firm has already screened.

**`#wpdeck` and `#wpdealflow` are now synonyms, decided by looking.** The split existed only because
nothing could extract an attachment, so the sender had to say where the substance was. The system
looks now, and asking a busy partner to pick the right word is the same mistake as asking founders to
zip a deck — a rule that depends on a human remembering, which fails the first time one does not.
Both tags keep working; a PDF present means the deck is read whichever was typed. `isDeck` is set
from the attachments ALONE and never OR'd with the tag, because it drives a prompt saying "the
substance is in the attachment" and saying that about a message with none sends the analyst hunting
for something that does not exist.

**Three triggers at once already behaved correctly** and was verified rather than assumed:
`wantsDeal` is an OR, so `#wpdeck` and `#wpdealflow` together open ONE deal, and `#wpnetwork` is
handled separately — one company in the funnel, one person proposed to Network OS, nothing in
Capture. Capture stays the partners' own deliberate list, per the operator's earlier ruling that the
top of the funnel is the Dealflow tab.

**One deck per scheduled tick, and that number came from production.** Three `ai_run` rows there died
with *"abandoned: the invocation ended before this call returned"* — the Worker torn down mid-call,
one of them Scooter's daily brief on 21 Aug. Stacking three model calls into one scheduled invocation
is precisely that failure mode, and the symptom would have been a deck marked FAILED with a reason
that reads as though the PDF were bad.

## 22 Aug 2026 — The operator changes the rota, and the default stays the default

Operator: *"what is dutyroster's flow? i want a default flow and one that i can change in the admin
section ---i should be able to adj hours for an employee"*

**The code default STAYS, and the database holds only differences.** `dutyRoster.ts` warns in its own
docstring that "a second roster is a second source of truth", so copying `SHIFT_PREFERENCE` into D1
was never on the table: two rotas able to disagree, with nothing able to say which is wrong. Storing
only the DIFFERENCES buys four things a copied table would have cost — the default keeps working with
its hand-written `WHY_ON_SHIFT` reasons intact; a newly seated employee inherits a shift with nobody
remembering to add them anywhere; the page can say "this is the default" against "you changed this,
on this date, because"; and **reverting is deleting a row** rather than restoring a remembered value,
which is the failure mode of every save-the-old-value design. The test suite proves the last one by
setting an override, reverting it, and comparing the whole day byte for byte against what it was.

**Precedence is stated once and read once.** `DUTY_PRECEDENCE = [PINNED, CUSTOM_HOURS,
SHIFT_OVERRIDE, CODE_DEFAULT]`, and `decideFor` walks that array — the first source with an opinion
about a person governs them. The same order decides who is listed first, so what a reader sees on the
page IS the rule rather than a second statement of it. Three sources silently competing is how a rota
becomes unarguable, which the module says is the one property it must not have.

**Still pure.** The overrides are passed IN. `src/shared/` cannot import `src/worker/`, and more to
the point the purity is WHY a partner can predict the rota; a resolver that reached for a database
would be predictable only to whoever last looked at the database. `handleDutyPicture` reads rows and
hands them over; it decides nothing.

**Custom hours ask a different question of the day than of the moment.** 6am–8pm does not cover 10pm,
so "on now" is false — but it touches the evening shift, so "covers the evening" is true. Collapsing
the two would have quietly dropped people off the day view; both are tested.

**On AI controls, not on Employees.** She said the admin section, and AI controls is the one Admin
surface whose subject is controls over how the firm's AI behaves rather than a record you read. The
"On duty now" panel stays on Employees as a readout, and now loads the same overrides through the
same resolver — two surfaces that disagree is the exact failure this design exists to prevent.

Migration `0137_the_operator_changes_the_rota.sql`. Action keys `duty_override.set` and
`duty_override.clear` (ordinary, human-only in the service: the rota is the firm's, not an
employee's). **`scripts/seed/generate-machine-seed.mjs` needs re-running** — the 0003 generated block
is stale against the registry, and `validate:authority` reports STALE until it is.

### One email, two records, and the link between them kept

Operator's call, 22 Aug 2026: when a message carries both a company and a person, record that the
founder belongs to that company.

Both records already happened — a company at the top of the funnel, a person proposed to Network OS —
**as two unrelated rows.** The fact that THIS founder belongs to THAT company was thrown away at the
one moment the firm could see it for nothing. The email is the proof; reconstructing it later means
somebody remembering, and "who founded Sensori" is exactly the question nobody can answer six months
on.

`ProposedPerson.company` already existed and was only ever filled from a literal `company:` line in
the body, which almost no real message carries. It now takes the DEAL's matched company name in
preference to anything parsed out of prose — that is the name checked against the register, so it is
the one that will still match tomorrow.

## 22 Aug 2026 — The operator can change the rota

Operator: *"what is dutyroster's flow? i want a default flow and one that i can change in the admin
section — i should be able to adj hours for an employee."*

**The code default stays and the database holds only DIFFERENCES.** `dutyRoster.ts` warns that a
second roster is a second source of truth, so nothing was copied into a table. Storing only overrides
means the default keeps its hand-written reasons, a newly seated employee inherits a sensible shift
with no action, the page can distinguish *default* from *you changed this*, and **reverting is
deleting a row** rather than restoring a remembered value.

**Precedence is stated in exactly one place** — `DUTY_PRECEDENCE = ["PINNED", "CUSTOM_HOURS",
"SHIFT_OVERRIDE", "CODE_DEFAULT"]` — and the resolver walks that array once. The implementations are
keyed off the same union, so a source cannot exist without being in the ordering, and the same order
sorts the list a partner reads: what she sees IS the rule rather than a second statement of it.

**Custom hours ask a different question of the day than of the moment**, and both are tested: 6am–8pm
is off at 10pm but still COVERS the Evening shift. Collapsing those two would have silently dropped
people off the whole-day view.

`resolveDuty` stays pure — overrides are passed in, nothing reaches a database from `src/shared/`,
and a test asserts that against the source text. The rota must remain predictable and arguable, which
is the reason its docstring gives for not letting a model decide it.

**Both surfaces read the same resolver.** The "On duty now" readout on Employees and the control on
AI controls load the same overrides, with a test asserting a change shows in both — two surfaces
disagreeing about who is on duty is the failure the design exists to prevent.

A trigger refuses UPDATE outright: setting again is delete-then-insert, so the reason always
describes the verdict sitting beside it. `CHECK (kind <> 'HOURS' OR IFNULL(from_hour <> to_hour, 0))`
carries the IFNULL for the NULL-passes-a-CHECK trap this repo hit yesterday, and a test plants a
zero-length window and requires the insert to fail.

### Two real arrivals, cancelled by our own test, and unworkable regardless

Auditing production before deploying found four work cards, **all CANCELLED, none open** — including
Helios Grid and Vantage Robotics, which had arrived by email at 01:36 and 01:42 on 22 Aug.

The spine names the actor: `fu_browser_agent` at 01:43, which is the Cloudflare Access service token
— **this project's own review agent, walking the interface.** Nobody at the firm decided those were
not worth working. The companies stayed in the funnel; the cards telling anybody to look at them did
not, so in practice they would have sat unworked with nothing flagging it.

And they could not have been worked anyway: both were owned by the string `Wyatt` rather than
`aie_wyatt`, so `runEmployeeWork` would have answered "that employee does not exist."

Migration `0139` repairs both — owner ids resolved by MATCHING ON NAME rather than hardcoding pairs,
so a seat renamed later still resolves; and the two cards put back to OPEN, scoped to those titles
AND to that one actor. A card a PARTNER cancelled is never reopened underneath her: the whole point
of a visible pass pile is that a decision to stop stays stopped.

**Worth naming as a practice, not just a bug:** an agent testing against PRODUCTION mutates the
firm's real records. The review that found so much this week also cancelled two live deal-flow cards
and nobody noticed for eighteen hours. A read-only identity for review passes would have prevented it.

## 22 Aug 2026 — DEPLOYED. E2E ran for the first time, and found eight defects no unit test could

`npm run deploy:production` — ten migrations applied, **`6ff58052` deployed and verified**. Unit
suite **110 files / 1,682 tests / 0 skipped**, all green. GitHub `main` pushed to match.

### The e2e suite could not start, which is why it was never proven

Every honest "UNPROVEN" label this week understated it. `npm run e2e` **failed to boot**: wrangler
proxies the `[ai]` binding remotely, the proxy session dies on *"west-peek-os.seq-taylor.workers.dev
is behind Cloudflare Access"*, and Playwright reported only `Process from config.webServer was not
able to start`. Fixed with `--local`. With it booting, the real baseline was 38 passed / 37 failed /
3 silently skipped. Final: **95 passed, 0 failed, run twice back to back.**

### Eight defects found by a browser and by nothing else

1. **Every inbound email was lost.** The handler ran inside `ctx.waitUntil`, so `message.raw` was
   already gone — `ReadableStream received over RPC disconnected prematurely`. No event, no card, no
   capture. Now awaited.
2. **Decks were silently dropped.** The MIME boundary escape `/[.*+?^${}()|[\\]\\\\]/` matched
   nothing — the `\\` closed the escape and the `]` closed the class — so boundaries went into
   `new RegExp` unescaped. RFC 2046 permits `( ) + ? .`: a `+` mis-split the message, an unbalanced
   `(` threw and lost the whole email.
3. **My own Sensori fix never worked.** `R2.put(key, message.raw)` throws *"must have a known
   length"* every time and my `catch` swallowed it, so the card would have said "this system did not
   keep a copy" — the exact silent failure the fix existed to end. Now piped through
   `FixedLengthStream(message.rawSize)`.
4. **The whole committee surface 500'd.** `title LIKE ?` with a wildcard-free pattern; D1 caps LIKE
   patterns near 64 characters and `"Assemble the IC packet: " + title` exceeds that for any ordinary
   company. Meetings said *"No deal has reached the committee"* for deals AT the committee.
5. **Two dead links on Home** — `intelligence` and `reporting`, neither a route.
6. **Guided setup called the system broken**: it read `m.machine_key` where the endpoint serves
   `key`, so every recommended role reported machines "not present on the server". All 46 were.
7. **ADR-018 was violated in the interface.** `delegable` arrives from SQL as `0`, and `0 !== false`,
   so reserved actions and external effects both offered "Approve, and don't ask again…" — and
   neither showed the sentence saying why they cannot be delegated. The choke point still refused, so
   nothing was ever delegated; the UI simply lied about it.
8. A missing testid that let a blank-state regression suite point at nothing.

### And three of mine, fixed before deploying

**A deck for a NEW company was thrown away** — `if (!companyId) break;` — which is precisely half of
the operator's sentence ("if its a new company they create a new one"), while the card raised in the
same breath told the analyst to read a deck that had been discarded. `pending_deck.company_id` is now
nullable and the deck is kept against the work card until a company exists. Losing an attachment is
not an acceptable way to respect a boundary.

**No allocation scenario could be opened at all.** `investable` is `NOT NULL` and required by the
schema, and I had deliberately omitted it because no fee model is recorded — so every press answered
`invalid_input`. There were only three options: invent a number (which is what put a $30M fund into
every scenario in the first place), refuse Fund strategy entirely, or ask. The form now asks for the
one figure the system genuinely cannot derive.

**A unit test pinning a dead link** — `cockpit.test.ts` asserted `links.get("intelligence") ===
"intelligence"`, holding defect 5 in place.

### Repairs confirmed in production after the deploy

Helios Grid and Vantage Robotics are **OPEN and owned by `aie_wyatt`** — workable for the first time
since they arrived. The two cards a person cancelled stayed cancelled, exactly as scoped.

### Still open, asserted with `test.fail()` so they cannot be forgotten

- Three governed workflows have **no interface at all** while their routes stay live and enforcing:
  LP marketing claims + the data-room access ledger, the LP reporting packet and its certification
  disclaimer, and the work packet lens gate. Anything with an API client can share LP-private
  material and nothing in the UI shows it.
- "How long have we known them" was dropped from the Dealflow create form, so it became the separate
  errand that page exists to prevent — and `DealProvenance` measures lead time from that field.

### Recommended, not done

`validate:sql` spawns one remote `wrangler d1 execute` per statement — **1,091 statements** is the
10+ minutes, essentially all process spawn and round trip. EXPLAINing all 1,091 against the local
migration-built D1 took **6.3 seconds, 0 rejected**, needs no credentials, and the migrations ARE
production's schema. It could move from a rarely-run remote script into `npm test`.

## 22 Aug 2026 — Verifying e2e rather than trusting the report

The operator asked to hold the deck until the suite genuinely worked. Run directly rather than taken
on report: **95 tests, 94 passed, 1 "failed"** — and the failure was `Expected to fail, but passed`
on *"a deck for a company we have never heard of is still KEPT"*. The fix landed; the marker
asserting it was broken had gone stale. Removed.

That is the good kind of red, and worth naming: a `test.fail()` left on a behaviour somebody has
since fixed reports as a failure, which is exactly right — it forces the claim to be revisited rather
than quietly becoming untrue.

**Two more markers cleared, both mine.**

*A scenario could not be opened from Fund strategy.* The spec pre-dated the fix: `investable` is NOT
NULL and I had deliberately omitted it because no fee model is recorded, so the form now ASKS for the
one figure the system cannot derive — inventing it is what put a $30M fund into every scenario in the
first place. The spec now fills it as a partner would.

*"How long have we known them" was dropped from the Dealflow create form.* It survived only on the
deal's terms or on adding a SECOND deal — i.e. it became the separate errand that form exists to
prevent — and `DealProvenance` measures lead time from exactly that field, so **every deal opened
through the ordinary door contributed nothing to the panel sitting underneath it.** Restored beside
"how we met them", because they are one thought: who introduced us, and how long ago. Blank by
default and sent only when given: a defaulted date would claim every company was met on the day it
happened to be filed, and an absent date is honest where an invented one is not.

### A test that pinned scaffolding

`tests/dealRecordLayout.test.ts` asserted the committee section CONTAINED a placeholder and that the
file still said "PLACEHOLDER, AND NOT MINE TO FILL". Correct while the section was owned by another
agent; wrong the instant it was filled.

**A test that pins scaffolding holds the scaffolding in place.** It went red on the fix and read as
though the fix were the defect — the same shape as the assertion that pinned a dead link, and the
fixture that invented an employee. It now asserts the section does its job: the questions and who
owes them, who is seated, the decision, dissent by name (because `ic.ts`'s rule is that dissent
survives the meeting rather than being smoothed into consensus), and an empty state for a deal that
has not reached the committee.

Three `test.fail()` markers cleared today by fixing the product rather than the test: the thrown-away
deck, the un-openable scenario, and "how long have we known them". Three remain, all LP or
work-packet surfaces whose ROUTES ARE LIVE AND ENFORCING while nothing in the interface shows them.

## 22 Aug 2026 — The committee section is filled, the three remaining gaps are surfaces now, and a meeting can be taken off the record

Operator: *"the meeting tab is not done right? maybe we actually work on the meeting tab and build
that out fully."* Four things, and the first of them had been sitting in a gap between two agents who
were each right to refuse to reach into the other's file.

### The committee section on the deal record was a placeholder, and it could not have been filled from the detail response

`DealflowPage.tsx` carried a section headed "Where this deal stands with the committee" whose whole
body said the information "is being brought across from the meetings side and is not on this record
yet". The comment left in place pointed at `d.ic_packets` as the source. **It is not enough and never
was**: `GET /api/opportunities/:id` returns `{ id, status }` per packet — no questions, no seats, no
decision, and above all **no dissent**. A section built on it would have had to invent the rest on
the client, and a deal record that disagrees with the committee's own surface is worse than a blank
one.

So the endpoint was extended instead. `icDealSurface()` takes an optional opportunity id and
`GET /api/ic/deals/:opportunityId` serves **the same read Meetings renders** — one query, two
surfaces, which is the only arrangement in which they cannot drift. It answers `{ deal: null }`
rather than 404 for a deal the committee has never seen, because "it has not been to the committee"
is an answer and a 404 is a malfunction, and the record draws those differently.

Three things were added to that read, all of which the section needed and none of which existed:

- **`packet_evidence`** — what the committee actually saw, counted: how many claims, how many of
  them with nothing under them, who assembled it and when, whether the arithmetic was attached, and
  **the contradiction count twice** — at assembly and right now. A contradiction raised after the
  packet was written is precisely the one nobody in the room knows about, and a single number hides
  exactly that case.
- **`dissents`** — read for **every** decision on the packet rather than the latest, because a
  deferred deal comes round again and a dissent recorded against the first sitting is the thing
  somebody wants in front of them at the second. Printed whole on both surfaces, never condensed.
- **names instead of ids** — `decided_by`, `drafted_by` and each dissenter resolved through whichever
  roster they are on. The third time this repo has paid for the id/name divergence; resolved in the
  statement so the two cannot be typed apart.

**And dissent had no way in.** `dissent_record` has been append-only, human-only and governed since
P6, and nothing anywhere in the product wrote to it — a rule about a table nobody could reach, which
is to say a committee record that could only ever record agreement. Meetings now carries the control,
against the decision it disagrees with.

### Making the page explain itself, without adding a section

`tests/meetingsLayout.test.ts` pins the five section titles exactly, which is right: the fix for "not
self explanatory" is never a sixth heading. Every section now states what it is for and what can be
done to it in a sentence above its list, and the operator's four IC questions — *who makes the
packet, how does that get done, how do we get thru the pipeline, what happens once a deal is at the
IC stage* — are answered **inside the committee section**, beside the deals they are about, and
render whether or not any deal has got there. The commonest moment somebody needs that answer is when
the list is empty and they cannot tell why.

**One correction made honestly rather than quietly.** Several enum values were rewritten into words
and then put back: `e2e/p7-meetings.spec.ts` reads `ACTIVE`, `NOT ACTIVATED`, `GRANTED`, `REVOKED`,
`IMPORTED`, `REFUSED`, `MANUAL` and `CONVERTED` back off the page, and that spec was not this agent's
to edit. The stored words stayed and a sentence translating them sits beside each, which is the half
a reader was actually missing. Worth naming as a real tension between the no-raw-enum rule and a
spec that asserts on the raw value.

### A meeting can be taken off the record — migration 0140

Operator: *"the call with scooter meeting has no way to delete it. it was a test and some meetings i
want to delete….we need a way to delete them and we can have an audit trail if someone deletes."*

The document pattern (0095), and the argument is stronger here than it was there. A meeting is
referenced by its consent records, its transcript imports, its notes, the employees seated in it, its
commitments and every work card a close-out made out of one. Destroying the row breaks all of that
and erases the trail the audit exists to keep.

- **A reason is required**, human only, and archiving twice is a no-op that says so rather than an
  error — a second press is somebody who could not tell whether the first one worked.
- **The confirm says what stays.** The list read carries four counts per meeting — notes,
  transcripts, promises, and work cards already made from it — and they are on screen *before* the
  press. "Are you sure?" tells a partner nothing; "the 1 note and 2 work cards already made from it
  stay exactly where they are" tells her the thing she actually needs.
- **What was taken off is visible**, on the pass-pile pattern rather than as a second tab. A removal
  nobody can see afterwards is indistinguishable from a deletion, which is the thing this is not.

Proven end to end against local `wrangler dev`: refusal without a reason, the archive, the no-op
second press, disappearance from the list, appearance under `?archived=1` with who/when/why, the
notes still readable on the meeting, and `meeting.archived` on the event spine.

### Three `test.fail()` markers cleared by building the surfaces, not by weakening the tests

All three were the same defect in three places: **a route live and enforcing, with nothing in the
interface able to reach it.**

- **`e2e/p10-lp.spec.ts` — the data-room access ledger.** Granting and revoking LP data-room access
  have been governed since P10 and no partner could see who held a key. LP now carries the ledger:
  who holds access to which document right now, what they may do with it, since when, and a control
  to take it back with a reason. What was closed stays listed underneath — a revocation that
  disappears leaves only the grant, which reads as though the key is still out. **Granting is
  deliberately not offered here**: sharing LP material is a signature against a named document and a
  named recipient, and a one-click share on a summary page is the shape of control that gets pressed
  by accident.
- **`e2e/p12-reporting.spec.ts` — the LP letter and its certification.** The quarterly letter can be
  drafted, put in front of its three named reviewers, reviewed, and sent behind a Managing Partner's
  signature — the four gates shown as steps rather than discovered as refusals. The certification is
  printed as the server states it, on first paint, whether or not a letter exists: a promise that
  only appears once there is something to disclaim is not a promise.
- **`e2e/p18-intent.spec.ts` — the packet a lens is gating.** Removing the packet vocabulary from the
  front of Ask was right; removing every control that could REACH the checks was not. The lens gate
  refuses an adverse verdict AND refuses silence, and no partner could read a verdict, record one, or
  run the work afterwards — a dead end with a rule attached. It is back **inside the section that
  explains what a check is**, not as a second way to ask: what the checks are holding, each check
  with its verdict in a person's words, and the control to run it.

Each marker was removed after the behaviour held, because Playwright reports an unexpected pass as a
failure.

### Needs regenerating, not run here

`meeting.archive` was added to `src/shared/registry/actionTypes.ts` and is compensated in migration
`0140` (`ON CONFLICT DO NOTHING`, following 0131 — `INSERT OR IGNORE` would also swallow a CHECK
failure, which has shipped a bug in this repo twice). The generated `0003` seed block has **not**
been regenerated, so `npm run validate:authority` will fail until somebody runs
`scripts/seed/generate-machine-seed.mjs`.

## 22 Aug 2026 — The bug hunt, and two blockers on the deck the operator was about to send

A hunt aimed at the SHAPES this codebase has already produced, rather than a general review. Seven
fixed with tests, eleven reported. The two that mattered most would both have failed live.

### The 7MB deck could never have been read

`inboundEmail.ts` returns before `pdfAttachments` for anything over `MAX_BODY_BYTES` (256KB), because
walking a multi-megabyte MIME tree does not fit in 10ms of CPU. Base64 is 4/3, so the real ceiling on
a readable deck was about **190KB** — and `MAX_ATTACHMENT_BYTES = 12MB` was unreachable by
construction. The operator's actual deck is 7,093,115 bytes.

The oversize path stored the `.eml` and opened a card and wrote **no `pending_deck` row**: the bytes
were there and nothing pointed a reader at them. Extraction now happens in the scheduled job, which
has its own CPU budget — the same store-now-read-later asymmetry the storage half already used.

### The deck feature was a permanent no-op for any new company

`deckQueue` selects `WHERE company_id IS NOT NULL`, and **nothing ever set it.** `opensRecord` gated
BOTH creating the `canonical_company` row and opening an opportunity, so a company arriving by email
got no register row at all.

**The register is not the pipeline**, and conflating them is what broke this. Recording that the firm
HEARD OF somebody commits nothing and is exactly what an arrival is; opening an opportunity is a
claim on partner attention and still needs a human. The operator asked directly whether everything
heard of should be top-of-funnel — no: portfolio companies, passed companies and names from a market
map all belong in the register and not in the pipeline, and a funnel containing everything tells you
nothing about what needs attention.

And it was invisible: `runDeckReading` hardcoded `skipped: 0`, so the job reported **SUCCEEDED, "no
decks waiting"** while decks waited for ever — a status line true of the query and false about the
firm.

### The fourth instance of the name/id bug, and it disabled a safety control

`rateTrip` counted `WHERE owner_id = ?` against a column holding `aie_wyatt` while every machine route
passes a display name. **Both counts were always zero, so the runaway breaker could not trip for
exactly the unattended callers it exists to stop.** The duplicate guard beside it had been moved above
the name→id resolution when it silently stopped guarding; the rate check two lines below was left
reading the raw input.

### Three more, each silent

A **folded `Content-Type`** — routine from Apple Mail and Outlook — made `boundaryOf` return null, so
the deck was dropped with **no unread note either**, contradicting the file's own promise. Both 1:1
chats ordered history `ASC LIMIT 30`, so past turn 30 the employee re-read the opening of the thread
for ever while the partner saw the whole thread. The research thread computed its next turn number
from OK turns only against a UNIQUE constraint, so **one failed turn killed the thread permanently**.

### And a stray brace nobody could see

`styles.css` carried an extra `}` at line 1877 — a rule deleted with its closing brace left behind
after a comment. esbuild reports that only as a minify WARNING, so the build succeeded and everything
after it parsed at the wrong nesting level. `validate:css-classes` now fails on unbalanced braces,
proven by planting one.

### `sql-against-schema` made real

It was the only validator without a self-test, and it spawned one remote `wrangler d1 execute` per
statement — 1,095 of them, which is where the ten-plus minutes went, essentially none of it in SQLite.
**A validator nobody runs is not in the suite.** The migrations ARE production's schema (the deploy
refuses to ship against a pending migration), so it now builds the schema once in an in-memory
`node:sqlite` database: **0.95 seconds, no credentials**, with a five-case self-test covering all
three bugs that prompted it.

### Standing authority: four holes, all reading as protection

**The flags were never re-checked when a grant was spent.** Migration `0130` states the reason a
grant must be validated at spend time rather than at grant time — *"a key that becomes reserved next
month must immediately stop being coverable by a grant written last month"* — and when the
enforcement moved from `authorize()` to the approval queue, the flag check did not move with it. The
only thing between a reserved action and a stale grant was the moment it was written. Now a join to
`action_type`, with a test that makes a key reserved AFTER granting and proves the grant dies.

**And its test asserted something trivially true.** It checked that `authorize()` never returns the
reason `standing_authority` — which no longer exists there at all, so it would have passed with the
feature deleted. Rewritten to submit a card against a forged grant and prove it still waits.

**Every grant made through the product was a blanket grant.** `object_type` was consulted only inside
the branch requiring a non-null `object_id`, and the delegate control sends type-without-id on every
grant — so a row that read as "companies only" matched every object of every type. **Worse than an
honest blanket grant: the operator could see a scope she did not have.**

**An auto-approved card was approved and permanently unexecutable.** No `approval_decision` row and no
`decided_by`, while this module's own docstring says every decision is appended — so the card came
back decided by nobody, a reopen superseded nothing, and `verifyAuthorizationReceipt` refused it for
want of a decider, with nothing saying why. The decision is now attributed to the partner who GRANTED
the authority, which is the honest answer: she made it in advance, and the grant is named beside it.

**The use limit could be raced past.** The bound was checked in the SELECT that found the grant and
the increment carried no condition, so two submissions between read and write would both spend. The
condition moved into the UPDATE and the result is checked; a card that loses the race takes the
ordinary path rather than riding authority that no longer exists.

---

## 22 Aug 2026 — Network OS connected, and five things that reported success

### Network OS is live, and the page had been lying about it for a month

Operator, reading the Integrations tab: *"the integrations tab is not telling the truth about network
OS."* It said **Not set up · reads only · `NETWORK_OS_API_TOKEN` is not populated · No client is
configured, so live calls fail closed.**

`NETWORK_OS_API_TOKEN` **has never existed** — not in `wrangler.toml`, not in the vault, not in
`env.ts`, not in one line of code. It was a placeholder written into migration `0021` when Network OS
was still a hypothesis, and nothing updated it when the real client landed. The page was checking for
a credential that could never be present and reporting its absence for ever. A test pinned the
placeholder string, so the suite defended it.

The real bindings are `WP_OS_NETWORK_OS_BASE_URL` / `_SESSION_SECRET` / `_USER_EMAIL`, all three set
in production. Fixed in three parts:

- **`0142`** corrects the row: real credential name, `BIDIRECTIONAL` (it pulls a snapshot *and*
  proposes people into Network OS's intake queue), honest gates.
- **Status is derived, never remembered.** `connector.status` was only as fresh as the last time
  somebody pressed a button — which is how the row drifted. Network OS's state is now computed from
  the environment on every read.
- **The check contacts the far end.** New `probeNetworkOs()` mints the session, makes the request,
  reads the status line and **cancels the body before a single contact is parsed** — so it exercises
  no authority a pull would need and brings no data across, which is why it sits behind plain
  `connector.check` rather than `network_sync.pull`. Three distinct answers because they have three
  different fixes: unreachable, 401 (secret or approved-user list), other HTTP (their side).

A check result no longer overwrites the row's description. **Confirmed live by the operator the same
day: "accepted us."** First proof the integration works end to end.

### Five bugs of one shape: machinery that reports success

- **A forwarded deck could open a duplicate company.** `normalise()` stripped suffix words and only
  trimmed the ends, so `Acme Inc Labs` → `acme␣␣labs` while `Acme Labs` → `acme␣labs`. Every existing
  test used `Shared Match Co`, with the suffix *last*, which worked. A suffix is least recognisable
  as a suffix exactly where it is not last.
- **Wyatt could never edit a company** (`0143`). `0125` wrote `{"employees":["Wyatt"]}`; every Actor
  carries `aie_wyatt`. The named half of the rule was false for everybody, for ever, and it failed in
  the SAFE direction — a denial from a rule written to permit him looks identical to the rule
  working. **The test agreed with the bug**, passing `aiEmployeeId: "Wyatt"`, an Actor shape that
  occurs nowhere. Sixth instance of this divergence; names are now canonicalised to seat ids as the
  restriction row is read.
- **Healthy jobs pushed into tomorrow.** The sweep's comment said "ONLY THE JOBS WHOSE RUNS WERE JUST
  REAPED"; the `EXISTS` matched an abandoned run from any point in history. A job that died once
  months ago and was legitimately due now was moved to tomorrow — hitting hardest the jobs most
  likely to have died before. Bounded to rows this call stamped. A job whose schedule yields no
  future time is now **reported** rather than skipped in silence.
- **"Unclear email: Too big to read: Sensori deck."** Two prefixes, the first one wrong; Home's
  counter looked for `title LIKE 'Too big to read:%'`, which the doubled prefix made unmatchable.
- **The forwarding-prefix rule existed twice**, character for character, on the two paths a forwarded
  deck can take — and had already been wrong in both at once. One copy now, in `shared/intake`.

For the two subtlest fixes the source was reverted to confirm the new test actually FAILS against the
bug. The first version of the jobs test did not: the job was not overdue past the 30-minute window,
so it never entered the query and the test passed either way.

### Two features that were built, routed, tested — and unreachable

- **The work-card steering note.** Operator, 22 Aug: *"can the MPs give feedback on a work card that
  we want the ai employee to acknowledge while they are doing the work?"* Built properly: a table,
  two routes, an employee loop re-reading unanswered notes on every step, and a CHECK making
  "acknowledged" and "answered" one event so an instruction cannot be ticked off without saying what
  it changed. **There was no button.** Nothing in `src/client` ever called it.
- **Standing-authority revoke.** The delegate panel promised *"and you can stop it at any time"* and
  the only thing the client ever called was the POST that CREATES a grant.

Both had passing e2e tests. **Both tests asserted only through `request` and never opened a browser**,
so they proved the machine worked and could not tell that nobody could reach it. That is the lesson
worth keeping: an API-only e2e test is worth less than it looks.

Both screens built; both now driven through the browser in `e2e/p55-delegate-and-steer.spec.ts`. The
revoke test immediately caught a third bug — the panel loaded once on mount and never refetched, so
it read "nothing is delegated" **immediately after the partner delegated something**, invisible at
the one moment she would look for it.

---

## 23 Aug 2026 — the suite could not be trusted, and Home answered six of its ten questions

### Two days of "failures" that were never failures

The e2e suite gave 4 passed out of 129, then 129 of 129, then 126, then 6 failed, on an unchanged
tree. Three separate causes, none of them the product:

- **Two runs destroying each other.** `prepare-local.mjs` SIGKILLs the repo's wrangler and deletes
  the local D1 — correct when the previous run is over, catastrophic while one is going. It now
  refuses to start while another Playwright run is in flight, converting the worst failure mode (a
  wall of meaningless red) into the mildest (a sentence saying wait).
- **The schema was sometimes never built.** `wrangler d1 migrations apply` prints its plan and waits
  for confirmation; without a terminal it cannot ask, so it prints the table of pending migrations
  and applies **nothing** — exit 0, empty stderr, and a list that reads like a report of work done.
  `wrangler dev` then served a database with almost no tables and 125 specs failed at once. Wrangler
  skips the prompt only when it believes it is in CI, so `npm run e2e` now sets `CI=true` on the
  apply and **verifies afterwards that nothing is pending**, refusing to run otherwise. The apply is
  done by the shell, not from node: spawned from node the process is killed by a signal part-way
  through (status 143) whatever stdio it is given — and a migration killed half-way is precisely the
  state the check exists to catch.
- **The browser was missing.** Playwright had updated; Chromium was not installed.

The unit suite had the same illness in milder form: three identical runs gave 359 failed, 57 failed,
then 1705 passed. All contention, zero assertions. **112 files, 1708/1708, and two consecutive clean
129/129 e2e runs** now stand behind this deploy.

The principle is worth stating: a green suite is worthless if a red one might mean nothing.

### Home named ten questions and answered six

Operator: *"on the home screen make sure all the items here have a module."* Four of the ten read
"no module enabled for this yet" — what is at risk, what the employees are doing, what is costing
money, what is broken. Two causes:

- **"What is broken?" was answered by RECONCILIATION** — places where the firm's figures and the
  administrator's disagree. A money problem, and a real one, but a partner asking what is broken
  means the system: is the brief running, did anything fail overnight. `health_fault` is what knows
  that — it runs every tick, escalates only what persists across two runs, and announces recoveries
  — and it **had no module at all**. So the one question with a live checking system behind it was
  the one Home could not answer, while a module that merely sounded right occupied the slot.
  Reconciliation now answers "Where is money or execution at risk?", which is what it reports.
- **The default carried seven of twelve modules**, and both partners had saved layouts predating the
  health module, so widening the default alone would have reached neither. `0144` appends the
  missing modules as a NEW VERSION per partner — the table refuses UPDATE by trigger — keeping their
  chosen order and adding what was absent after it.

**`0144` then gave Scooter `portfolio_risk` twice, and my own comment was stricter than my code** —
the exact defect I had spent two days removing from other people's work. The comment claimed
`json_insert` "leaves an existing path alone, so a partner who already has one does not get it
twice"; `json_insert` skips when the PATH exists, and `$[#]` is the append path, which never does.
`0145` rebuilds each list keeping first-appearance order and dropping repeats — guarding the VALUE
rather than the array, so it holds for any layout rather than the two rows that were wrong.

The test that should have caught the original gap counted ten questions and stopped, so a question
whose module was not enabled still counted. **Counting a list is not checking it.** It now asserts
that every question resolves to a module, and that "What is broken?" resolves to `health`.

### Quiet hours were set, stored, described — and applied to almost nothing

`notify()` reads a partner's preferences only when the notification names a recipient, and **six of
the ten call sites never did** — approvals (all three), portfolio alerts, dead-lettered jobs, LP
chasers, employee lifecycle. A notification with no `firm_user_id` is a firm-wide row: it reads
perfectly well on the page and has nobody whose preferences could be consulted. So quiet hours, the
per-kind switches and the minimum-severity rule were all dead for the kinds the operator sees most.

The fix is addressing, not a new rule. `notifyPartners()` writes a notice meant for the partners
**once per partner**, keyed by the recipient so each gets exactly one and neither gets two — reading
`firm_user` through the ROLE JOIN rather than a name list, because a notification needs an id and the
registry holds names. Seventh instance of that divergence.

One claim was trimmed rather than fixed, because it was larger than the truth: the page said quiet
hours "hold everything back". Nothing is removed from the notification centre by holding, and no push
service, VAPID key or subscription exists in this environment — so the only channel that could
actually interrupt her is UNAVAILABLE at every hour. The copy now says what it does.

---

## 3 Sep 2026 — CI had been deleted, not just quiet, and four validators passed on zero items

### Why CI stopped running

`.github/workflows/deploy.yml` was added 12 Aug 2026 (push-to-main → validate → `wrangler deploy
--env production`, run by GitHub Actions). It was deleted 14 Aug 2026 in the same large
"Sync deployed production artifact" commit that brought three days of Rooms/community/intelligence
work into git history — a side effect of that sync, not a decision anyone made about CI. Every
commit after 14 Aug ran no CI at all, including 18+ commits and the 27 Aug "Silent Failures" merge;
`gh workflow list` on this repo returned nothing.

The old workflow is not simply restored. It deployed with bare `wrangler deploy --env production`
on every push — no migration step, no long-lived Cloudflare credential boundary considered. BACKLOG.md
already records the deliberate decision that supersedes it: Cloudflare Workers Builds (the
equivalent auto-deploy-on-push) was connected 14 Aug and switched off 18 Aug on purpose, because
teaching CI to run the safe `npm run deploy:production` sequence needs a Cloudflare API token with
D1 write access sitting in the build environment — real blast radius, for a firm that deploys from
one laptop. "GitHub is source history and backup. It is not the deploy mechanism."

`.github/workflows/ci.yml` replaces it: typecheck, the full vitest suite, all eight static
validators (including `validate:sql`, `validate:design-tokens`, `validate:css-classes`, none of
which need credentials), the client build, and the Playwright suite in a second job — on every push
and PR to `main`, plus `workflow_dispatch`. No deploy step. No production credential in the
environment. Deploying stays exactly what BACKLOG.md says it is: `npm run deploy:production`, run by
a human, from one laptop.

### Four validators passed having examined nothing

Reproduced by pointing each scan's directory constant at an empty directory and re-running the real
(non-self-test) path:

| Validator | Before | After |
|---|---|---|
| `validate:ai-boundary` (`no-direct-provider-calls.mjs`) | `AI BOUNDARY SCAN PASSED` on 0 files | hard `FAILED — examined 0 source files` |
| `validate:network-boundary` (`no-cross-repo-coupling.mjs`) | `NETWORK BOUNDARY SCAN PASSED` on 0 files | hard `FAILED — examined 0 source files` |
| `validate:css-classes` | `CSS CLASS SCAN PASSED` on 0 `.tsx` files | hard `FAILED — examined 0 .tsx files` |
| `validate:sql` | `Checking 0 statements… PASSED` | hard `FAILED — examined 0 statements` |

`validate:value-shapes` was added to the same guard for the same reason one layer up: it queries
production D1 directly, and a bad DB name, a dropped credential, or a connectivity failure that
returns no rows would otherwise print `VALUE SHAPE SCAN PASSED` against zero tables — a false green
against PRODUCTION rather than against a local fixture. `validate:authority`
(`no-unauthorized-effects.mjs`) already failed correctly on the same empty-directory probe, because
it separately asserts specific files exist; it got the same explicit zero-count guard anyway, for a
consistent failure message rather than relying on that as the only line of defence.

Every fixed validator was re-run against the real tree afterward with an unchanged pass and an
unchanged item count (1110 SQL statements, 229 tables, the same file counts as before), and the
empty-directory probe was re-run against the fixed source to confirm the new failure fires. Nothing
was weakened to reach green.

### Two stale claims in the docs

`docs/DEPLOYING.md` still said `validate:sql` "needs network: parses every statement against the
live schema" — true before 22 Aug 2026, false since: the script was rewritten to build the schema
from `migrations/` in an in-memory `node:sqlite` database, specifically so it would need no
credentials and actually get run. `REPO_VALIDATION_MATRIX.md`, the document AGENTS.md names as
authoritative for what each check proves, listed four of the repo's eight validators
(`validate:sql`, `validate:value-shapes`, `validate:design-tokens`, `validate:css-classes` were
absent). Both fixed.

### What was actually deployed vs `main`

Production's last deploy was `2026-08-24T02:30:25Z` (`wrangler deployments list --env production`).
Exactly one commit landed on `main` after that: `4e6fa79` (27 Aug, PR #17, "The Silent Failures") —
the commit that fixes the Network OS connection and makes the deck and community journeys work on
real data. Production was three days behind its own fix. Confirmed live in the browser before
redeploying: Home showed `Degraded — 2 scheduled job(s) recently failed or were refused: Loading the
community from Network OS`, and Community showed 4,712 people pulled but "the firm has formed a view
on 0 of them" — the pre-fix state. Migrations were already fully synced (`No migrations to apply!`
against `--env production --remote`), so the only gap was the Worker/client bundle. Shipped via the
one documented path, `npm run deploy:production` (never bare `wrangler deploy`), and re-verified
live afterward.

### The full suite, run clean

The first full `vitest run` was contaminated by a concurrent `npm run e2e` this session started
against the documented warning not to run anything else heavy alongside it — 80 tests failed with
`fetch failed` / `ECONNRESET` from miniflare's proxy bridge, exactly the resource-contention
signature `docs/ENVIRONMENTS.md` describes. Re-run alone: **112/112 files, 1719/1719 tests.** e2e
itself first failed 111/129 with `Executable doesn't exist at …chrome-headless-shell-mac-arm64` —
this machine's Playwright browser cache was missing, so a manual `npm run e2e` here would have
silently produced 111 believable-looking product failures until someone thought to check for that
line. `npx playwright install chromium`, then **129/129 clean.**

### Merged, deployed, verified

PR #18 merged to `main` (a0a55bc), CI green on the merge commit itself (confirmed the push
trigger fires, not just `pull_request`). While driving it, CI caught two more real, previously
undetected environment-dependent bugs — both fixed and reverified in the same PR before merge:

- **`xirr`'s three-flow fixture** (`src/shared/dealmath/index.ts`): date-only strings parsed in
  the calling machine's local zone, not UTC, so the year-fraction between flows depended on
  whether a DST transition fell between them. Constant recomputed by independent bisection and
  confirmed identical under three different zones.
- **The quiet-hours zone picker** (`src/client/pages/NotificationsPage.tsx`): `zoneChoices()`
  returned its fixed list unchanged whenever the browser's own zone happened to already be in
  it, silently defaulting to `"America/New_York"` for most of the firm and every CI runner
  instead of the reader's real zone. Fixed to always put the reader's zone first.

The e2e job itself crashed twice on GitHub's Linux runners with a message-less `workerd`
internal error (never on macOS, 4/4 clean local runs) — added a whole-suite retry in CI, which
is safe here because `npm run e2e` resets the local D1 on every invocation; a Playwright
per-test retry would not be, given this suite's single shared database.

Deployed via `npm run deploy:production` (the one documented path) — first attempt hit the
transient `migration apply failed` Cloudflare flake `docs/DEPLOYING.md` already names, a plain
retry cleared it. All four steps passed: no pending migrations, build, deploy (version
`d150684f`), and the post-deploy health probe. This shipped `4e6fa79` (the deck/community fix
that had sat undeployed since 24 Aug) plus everything in PR #18.

Verified live in the browser as the operator, not by reading code: the "Loading the community
from Network OS" scheduled job flipped from `Degraded` to `SUCCEEDED` (4,712 contacts now
synced, vs. the pre-fix 250-contact cap), and an open work card ("Deck: Vynlo") showed Wyatt's
actual extracted findings from a real inbound deck — sector, product description, and company
status — confirming both journeys the operator asked about are live and working on real data.

## Parker runs the whole chain — the Room packet as research, judgement and a PDF (15 Sep 2026)

**The verdict.** The first October packet under 0161/0164 ("The Rise of the Black Lawyer Room")
was "sub par": Harvey AI at $10K with no evidence it sponsors anything, two more legal vendors from
memory, five steakhouses, agenda lines. The operator showed the standard she meant (a Gemini
transcript): the named sponsor's actual programme (US Open, three NBA/WNBA teams, PSG, Lavender
Law), the people who run its partnerships by name and title, the fit argued in the sponsor's own
strategic language, three concepts compared and one chosen, a culturally intentional venue, a run of
show to the minute, a line budget with its basis, and the cold email to the named contact.

**What shipped (migration 0166, PR "Parker runs the whole chain").**

- **A chain, not a prompt.** `services/roomPacket.ts` runs six stages — DISCOVER (invite-list
  reality check from the firm's own records + "who pays to be in front of these people", every
  evidence URL liveness-checked), RESEARCH (each sponsor's programme, the partnerships contact read
  off a fetched page that must carry the name, their strategic language; two per tick, up to six),
  CONCEPTS (three, compared on tone / value to the sponsor / who it fits / cost band; one chosen,
  pushback on the brief), VENUES (searched for the chosen concept's direction), PACKET (run of show
  with named roles and the sponsor's minutes, budget lines with basis, a sponsorship structure priced
  so all slots = cost + the firm's keep, ranked sponsors, the pitch email in Sequoia's voice), PDF
  (Browser Rendering, `doc_type ROOM_PACKET`, linked on the packet, emailed to both partners with
  Parker's two-line introduction). State lives on the row (`build_stage`, `build_state_json`); a
  dead tick loses one stage.
- **Inside the sweep.** The request door and the Rooms job only queue a draft and open a
  `ROOM_PACKET` card on Parker's desk; `workSweep` runs one stage per tick and charges no attempt for
  a stage that completed (`progressed`). Nothing per tick is more than one or two model calls and a
  handful of fetches.
- **The money is a target with reasons.** `SPONSORSHIP_RULE` ($10K × up to 4) is gone from the
  prompt, the skill library and `computeEconomics`; `SPONSORSHIP_TARGET.keepUsd` is the fixed point,
  the structure (title / supporting / an exclusive option) is Parker's judgement, and the packet says
  plainly when the structure falls short of the keep.
- **Evidence or nothing.** A sponsor's evidence URL survives only if research verified it; a contact
  only if the page carried the name; an unevidenced prospect ranks last and is flagged; a partner-named
  sponsor with no history is said to have none.
- **Proof.** `tests/roomPacket.test.ts` (45), `tests/roomRequest.test.ts` (9, the chain through
  `sweepOnce` with every dependency injected, the PDF in R2, the two emails), the e2e request journey
  updated for the queued chain. Full suite 1,941 green; every validator in CI green.

### The production passes, and what each one taught (15 Sep 2026, PRs #64, #66, #67, and the fourth pass)

The October request was re-run through the chain three times in production, each packet read in
full (rows, the PDF pulled from R2, the two emails) and the next pass built from what it got wrong:

- **Pass 1 (`rpk_7f5edb14`, "First Counsel, First Look Room")** — concept, pushback grounded in the
  firm's records (6 of 4,712 contacts read as lawyers → widen to the founders who need them), an
  11-line run of show with the sponsor capped at six minutes, a line budget, a real structure. Wrong:
  the sponsors were the audience's own institutions (NAMWOLF, LCLD, a bar foundation) asked for
  $12K each; Harvey's "contact" was the role *Partner Program Lead*; the exclusive option was priced
  below the sum of the cash slots; a $4K in-kind slot counted toward the keep; Cooley was tagged
  "named by you" because its note contained the word *partner*; sections fixed at 11in left sheets
  nine-tenths blank. **#66** guards every one of those.
- **Pass 2 (`rpk_7d961d77`, "Before It's Public: the Deal-Readiness Salon")** — at the standard: the
  Schomburg Center with its published corporate rate and the reason it was chosen, the Apollo as
  fallback, ten lines to the minute under Chatham House rule, Harvey's evidence its own US Open
  announcement, the pitch addressed to "the partnerships team at Harvey" with the honest note that a
  person must be found first, a structure that says plainly it falls $23K short of cost + keep at
  the high case. Wrong: seven sponsor names from one NAMWOLF page; five candidates dropped as
  "dead" without saying who. **#67**: a 401/403/429 page is kept and marked *verify by hand*; the
  dropped are named in the packet; discovery must read several lists.
- **Pass 3 (`rpk_8bab6be3`)** — discovery now spans BANKING / RECRUITING / vendors / employers, but
  all thirteen from NAPABA's 2026 sponsor page, and two candidates carried a URL beside a note
  saying no evidence was found. **Fourth pass**: a second discovery search that is told what it has
  and which hosts not to cite again, a cap of four candidates per page, a "not evidenced" note
  strips its URL, and the six researched are picked round-robin by category, hers first.

Each pass also proved the plumbing end to end: one stage per sweep tick with no attempt charged
for progress (~40 minutes queue-to-inbox), the PDF in R2 as a `ROOM_PACKET` document linked on
the packet, both partners emailed with Parker's introduction and the download link, the Rooms page
showing the stage while it built and the download button when done.

## 17 Sep 2026 — Firmwide notices, and the table that held nothing for a hundred and sixty-seven migrations

`internal_memo` shipped in migration `0014`. It had a create route, a list route, an append-only
`UPDATE` trigger, a permission in the action-type registry, and a privacy-visibility clause added
later when a review found it leaking. It had **zero rows**, and nothing anywhere read it into a
prompt. A noticeboard, in a room nobody walks through, with a lock on the door.

The same was true one surface over and worse: the Governance page's own confirmation said *"Issued.
It is in the list below and every employee reads it."* Nothing feeds `governance_update` into a
prompt — it is written, listed and acknowledged, and never read by a model. That sentence has been
corrected rather than left as the fourth instance this month of a specification no code reads.

**What was added.** No new table and no new section. A firmwide notice IS an `internal_memo` with
`audience='FIRM'` — already a title, a body, an author and a timestamp.

| | |
|---|---|
| `migrations/0181_firmwide_notices.sql` | Twelve notices, every one **descriptive** of how the firm already works. Not one is new policy; each was a code comment, a prompt line or a handler's reasoning that only its author remembered. `author_type='SYSTEM'` because claiming a partner typed them would be the exact fabrication notice 6 forbids. Deliberately excluded: the spend ladder — enforced at the router, not actionable by an employee, so a notice would be decoration. |
| `src/worker/ai/firmNotices.ts` | `firmNoticesBlock(env, firmScope)` — the notices as prompt lines, `""` when there are none. A `DEPARTMENT` memo is not a firmwide notice and is not read here. |
| `src/worker/ai/runAi.ts` | **The one insertion.** Inside the governed AI boundary, for every run carrying an `aiEmployeeId`. Not at the seventeen call sites that name an employee: a rule each caller must remember is a rule the next caller silently skips, which is how `internal_memo` came to hold zero rows in the first place. Prepended inside the boundary, so the scrubber, the budget estimate and the input hash all see what is actually sent. |
| `src/client/App.tsx` | One card under Governance. Honest when empty — no filler rows, and no claim that employees are reading something the firm has not written. |

**Proof — the assertion is on the bytes, not the row.** `tests/firmNotices.test.ts`, 9 tests, asserts
that each notice's own words appear in the request body put on the wire to the provider during an
employee run. Zero-item hard fail: the seeded count is asserted before anything reads it, so a
migration that stopped seeding cannot leave a file of vacuously-true assertions behind it.

**Negative proof, both halves, run rather than described.** (1) In-test: with the notices deleted
the identical employee run stops carrying them, and carries no empty heading either. (2) At the
source: with the one line in `runAi.ts` disabled, 2 of 9 tests go red — the two that assert on the
wire; the rest, correctly, do not move.

Counts: vitest **2236/2236** (was 2227; +9), `tsc --noEmit` green, and `validate:sql`,
`validate:css-classes`, `validate:css-variables`, `validate:brand`, `validate:design-tokens`,
`validate:instructions`, `validate:ai-boundary`, `validate:authority`, `validate:one-lever`,
`validate:blocks` all PASSED with their self-tests.

## 18 Sep 2026 — A one-off is built now; a steer waits for its month

Operator: *"if i make an ask of Parker for next month's proposal or ask for a one-off that is 2 diff
things: a one off should be delivered and acted upon immediately; asking for a specific topic or
angle to next months propoals should come when the month's proposal comes"*.

**The defect, reproduced before anything was written.** Both asks were the same ask. An ask on
18 September naming `2026-11` — "Black lawyers, several distinct name ideas this time", which is a
steer in her words and in `MONTHLY_PLAN` — returned `201 queued:true` with a `work_card` in state
`OPEN` titled *"Parker: build the November 2026 Room packet"*. The sweep would have built and emailed
November's packet that afternoon, six weeks early, with no way for her to know except the email.

**How the two are told apart: declared, never guessed.** No regex and no model reads her prose to
decide what she meant — that approach failed in the sibling system, and being wrong here silently
delivers November's topic today. The ask carries an `intent` of `NOW` or `STEER`. Where none is
given, `classifyAsk` applies ONE calendar comparison: an ask for a month at or before the one being
delivered has nothing to wait for and is built now; an ask for a later month is **ambiguous and the
door refuses**, returning both readings. A click beats a confident guess.

| | |
|---|---|
| `migrations/0194_a_steer_waits_for_its_month.sql` | `evt_month_steer` — her words, keyed by the month they are FOR, append-only, withdrawn by a column rather than a delete. And the Rooms job: `INTERVAL 15 → 60`, `daily_at_tz = 'America/Chicago'`. Guarded by a `CHECK (matched = 1)` so a no-op migration is an error rather than a silent success. |
| `src/shared/events/monthlyPlan.ts` | `deliveryMonth(now, tz?)` — "the 1st of the month prior" is a LOCAL-TIME boundary; read in UTC it minted November's packets on 30 September by her clock. `classifyAsk` and `steerLines`. |
| `src/worker/services/monthSteer.ts` | The runtime half of `MONTHLY_PLAN`: record, withdraw, read-for-the-packet, mark-delivered, and the board. |
| `src/worker/services/roomPacket.ts` | The door forks BEFORE `queueDraft`, so a steer never becomes a thing Parker builds. Both streams read `steerForMonth` at the one moment their topic settles. The hourly tick is a BACKSTOP: a draft whose card was never opened is a defect in the request path, notified to the partners and named in the summary. |
| `src/worker/services/jobs.ts` | Hands the job row's own zone in, and reports a backstop catch as `FAILED` — the card is opened either way, but a run that quietly repairs a defect is how the defect survives a month of green graphs. |
| `src/client/pages/RoomsPage.tsx` | The choice, asked only where the calendar is ambiguous, with both radios unselected and submit disabled. And "What Parker has been told, for months he has not built yet" — her words, the month, when she said them, and *Take it back* beside each. |

**Two steers for one month both survive**, oldest first, with the conflict rule stated. Replacing the
first would discard an instruction she gave with no trace and no way to notice.

**Proof — the words, not the column.** `tests/aSteerWaitsForItsMonth.test.ts`, 14 tests. The concepts
prompt is captured and her sentence is read back out of it on 1 October; the plan's standing steer is
in there beside it. The cadence is pinned across the November clock change in both directions
(`2026-11-01T04:30Z` is 31 October on her clock and must still deliver November).

**Negative proof, run on the real files rather than described.** Five broken states restored one at a
time, each returning its named failure and each restored: the 15-minute poll with no zone; the
concepts prompt fed from the plan's steer alone; a quiet backstop; a regex over her prose inside
`classifyAsk`; the door queueing before it forks. And on the test: the pre-fix door restored turns 3
of 14 red, including the reproduction of the original defect.

**Tests my change made false were rewritten stricter, and their siblings looked for.** Three asks in
`tests/workshops.test.ts` named a month beyond the delivery month with no intent; each now declares
`NOW` **and** pins that the undeclared form is refused and creates nothing. `tests/roomRequest.test.ts`
accepted any wording containing "opened Parker's card" — which a silent backstop would also satisfy —
and now requires the DEFECT report and the partner notification.

Counts: vitest **2447/2447** (was 2433; +14), `tsc --noEmit` green, and all **35** `validate:*`
scripts PASSED with their self-tests, including the new `validate:steer-waits` (18 fixtures).

## 18 Sep 2026 — Every company is in the pipeline; the weekly review is archived

**Owner, on intake:** "all companies should be in the pipeline, no matter how they come in. They are
top of funnel if they are in the system. From email we have to DECIDE on them." **On the weekly
review:** "we don't need it anymore."

**What was wrong.** `ROUTE_POLICY.opensRecord` in `services/dealIntake.ts` was true for MANUAL and
false for EMAIL, NETWORK_OS and SCOUT: the three unattended routes registered the company and raised a
card saying "then open it at the top of the funnel", and nothing checked that the card did. Read from
production: Northwind Robotics (22 Aug, created by Wyatt, no card at all) and Vynlo (24 Aug, by email,
deck read, card DONE) — two companies in the register with no opportunity, one behind a card that
concluded without the thing it governed. The Companies page called each "Not in the pipeline", calmly.

| File | What changed |
|---|---|
| `src/worker/services/dealIntake.ts` | Every route opens an `investment_opportunity` at NEW at arrival. MANUAL under the partner's name, unconditionally (she may open a second). The unattended routes open one only when the company has no live, non-archived opportunity, as the seat that owns the top of the funnel (`aie_wyatt`), with `source_channel` `<channel>:<who>` — `email:` is the board's badge contract — and `relationship_origin` INBOUND / NETWORK / OUTBOUND. `opensRecord` is gone as a concept; `FunnelEntry.opportunity_id` is non-nullable, so TypeScript proves no path returns without one. The card asks for the DECISION, never the admission; the header comment keeps the history of why it was the other way. |
| `migrations/0197_every_company_is_in_the_pipeline.sql` | Backfill: one opportunity at NEW for every non-MERGED company with nothing non-archived on the board, dated to the company's `created_at`, `source_channel` from the `identity.company_created` event's `via` (`email:backfill`, …) else `backfill`, `created_by` `migration:0197`, one event per row saying why. |
| `src/client/pages/CompaniesPage.tsx` | The calm label is gone. A row with no deal renders a fault notice (`company-no-deal-<id>`): not on the board, and it should be. |
| `scripts/validate/every-company-is-in-the-pipeline.mjs` | `validate:companies-in-pipeline`: no switch in the route table, non-nullable return, the exactly-one-per-route pin present and naming every route, no calm label, 0197's shape. Self-tests on the real pre-fix shapes. |
| `migrations/0198_the_weekly_review_is_archived.sql` | `weekly_mp_review` → RETIRED (the table's terminal status: the tick refuses it on every trigger including a hand-run, the status route answers 409, the machinery list omits it), `next_run_at` NULL, the reason on `pause_reason`. Every `weekly_review` row and deliverable is kept. |
| `src/worker/services/jobs.ts` | The `weekly_mp_review` dispatcher branch is a named REFUSED outcome rather than a generator, so a hand-edited row finds a refusal rather than the INTELLIGENCE fallthrough. The generator is still reachable by a human from the page's own button, behind `weekly_review.manage`. |
| `src/client/App.tsx` · `src/shared/help/pagePurpose.ts` · `PagePurposeBlock.tsx` | The nav item is removed with the dated reason; the route stays live; the page says it is archived above its controls. |
| `src/shared/deliverables/deliverable.ts` · `src/worker/services/deliverables.ts` | `archived` on a kind definition; the unfiltered shelf excludes archived kinds via `archivedDeliverableKinds()` (derived, never a second list); `?kind=weekly_review` still returns every row. |
| `scripts/validate/an-archived-lane-stays-archived.mjs` | `validate:weekly-review-archived`: replays every migration's `scheduled_job` status writes (seeds read by shape, UPDATEs by `=` and `IN`) and fails if a retired key is ever set back; reads the dispatcher, the nav, the kind and the shelf. Hard-fails on zero retired jobs. |

**Not changed, and why.** `POST /api/companies` (the identity workbench's "New company" form) and a
capture resolved to a COMPANY still create a register row with no deal. Folding an opportunity into
those would make Dealflow's "add a deal on an existing company" — the flow every partner uses and
`e2e/p6` pins at exactly one opportunity — open a second. The register now says loudly when that
happens, 0197 backfilled every such row, and the four intake routes cannot produce one.

**Tests made false were rewritten stricter.** `tests/dealIntake.test.ts` asserted "nothing has entered
the pipeline" on three routes; it now asserts exactly one live opportunity per route, its channel, its
creator and its origin, that a live one is never doubled, that a PASSed or ARCHIVED one does not strand
the company, and that the route table has no switch under any name. `tests/weeklyReview.test.ts`
pinned generation; it now pins the retirement (tick and hand-run both refused, status route 409, tick
never due, nav absent while the route answers, `weekly_review.manage` proven with a cross-firm
identity, archived kind off the shelf but there by name). `tests/jobs.test.ts` used the review as its
occurrence-key vehicle and now uses `deck_reading`, asserting the premise that the first occurrence
SUCCEEDED. `e2e/p57` asserts all four doors land on the board.

## 18 Sep 2026 — The portfolio shows what the firm owns, once

Operator: *"I think the one company we invested in should go there, and some of the pictorial graphs
in portfolio allocation from the fund strategy page."*

**What was true in production (read-only, `wrangler d1 execute --remote`).** One CLOSED
`investment_opportunity` — Sensori, `opp_ea7463ad…`, `$1 × 10,000` placeholder shares standing in for
a real $10K SPV, `backfill_reason: "$10K SPV that closed before Fund I existed; never went through
West Peek's IC"`, `as_of_date 2025-08-06`. Zero `position` rows, zero `transaction` rows, zero
`position_mark` rows. Portfolio's "What we own" read `/api/funds/:id/performance`, which reads
`position` alone, so it said "The fund holds nothing yet"; Fund strategy's composition read CLOSED
opportunities and drew Sensori at 100%. The Portfolio page's own header comment recorded the
disagreement — as the reason the bars had been removed from it.

**The fix is the query, not a position row.** Booking a pre-fund SPV with stand-in share counts into
Fund I would put it into the fund's cost basis and from there into TVPI and the LP letter. What is
true is that the firm invested in it, and that is what a CLOSED opportunity records.

| File | What |
|---|---|
| `src/worker/services/portfolioHoldings.ts` | ONE list: CLOSED opportunities ∪ OPEN positions, merged per company, each row saying which it is (`booked`), with amount in, vehicle, ownership, current mark, last check-in, open asks, open flags, follow-on reviews. `GET /api/portfolio/holdings`. Composition (`/composition`, moved here from `investment.ts`) and the new deployment view (`/allocation?fund_id=`) are computed from it. Fund performance is deliberately untouched — the fund's ledger stays positions-only. |
| `src/shared/fund/allocation.ts` | `planSlices` — the four plan figures Fund strategy used to work out inline — and `deploymentSlices`, the same plan with deployed / still-to-deploy drawn against it. Both pages call it. Colours are token names; the fifth "still to deploy" segment uses the ring's empty-track colour because the palette holds four separable hues on purpose. |
| `src/client/pages/AllocationRing.tsx` | The ring SVG, legend and table, extracted from `FundAllocation.tsx`. One definition, two hosts. |
| `src/client/pages/PortfolioAllocation.tsx` | Portfolio's host: "Where the money is, against the plan". |
| `src/client/pages/PortfolioPage.tsx` | "What we own" renders from `/api/portfolio/holdings`, hosts `<Composition />` and `<PortfolioAllocation>`. The header comment that recorded the disagreement now records the fix. |
| `src/worker/index.ts` | `// === Phase Portfolio ===` block: holdings, composition, allocation. |

**Proof.** `tests/portfolioHoldings.test.ts` (8): the Sensori-shaped fixture (backfilled CLOSED,
placeholder economics, no position) hard-fails the run if it produced no closed-but-unbooked row, then
must appear with `booked: false`, `$10,000`, `SPV`, `2025-08-06`; a booked position appears with its
cost basis and mark, one row per company; composition's total equals holdings' total; and the plan
figures the server returns are diffed to the cent against `planSlices` over the same fixture
(`$30M − $7M = $23M · 30% = $6.9M · 70% = $16.1M · 40% = $6.44M · initial $9.66M`).
`validate:portfolio` (24-fixture self-test) fails if the closed SELECT joins `position`, if either page
grows its own ring or its own arithmetic, if a route leaves the block, or if the test excuses itself.

**Negative proofs, run.** The join planted on the closed SELECT: validator exits 1 naming it, 5 of 8
tests red. The server's reserve percentage nudged 40 → 35: the diff test alone goes red. A second
`strokeDasharray` file under `src/client`: validator exits 1. Each restored, each green again.

Counts: vitest **2480/2480** (was 2472; +8), `tsc --noEmit` green, `validate:brand`,
`design-tokens`, `css-classes`, `heading-scale`, `css-variables`, `sql`, `scans-read-code` and the new
`validate:portfolio` all PASSED with self-tests.
## Phase Meet — Google Meet, seamless (18 Sep 2026)

Owner-approved. Tiers 1 and 2 built; 3 and 4 scoped in `docs/GOOGLE_MEET.md`, which also carries the
probe table (CONFIRMED / SUSPECTED per row with the exact call), the owner's correction that this
system reads only the firm calendar, and the named stops.

| Where | What |
|---|---|
| `migrations/0202_…` | `meeting` gains `calendar_key`, `google_event_id` (UNIQUE with the key), `meet_conference_id`, `meet_link`, `source`, `type_inference`, `recording_ref`, `transcript_ref`; `google_calendar_sync` (the two-door ledger); `meet_event_inbox` (UNIQUE per conference record — one read per ended call is a property of the schema). |
| `migrations/0203_…` | `meet.recording_policy.firm_default` (reserved, one decision per firm) and `meet_recording_policy`; `calendar.sync`, `meet.ingest`, `meet.consent.platform_announced`; `meet_space_subscription`; jobs `sjb_calendar_sync` / `sjb_meet_ingest` (INTERVAL 60, guarded `CHECK (matched = 2)`). |
| `src/shared/meetings/calendarSources.ts` | The ONE calendar, `sequoia@westpeek.ventures` → `west-peek`. |
| `src/shared/meetings/calendarSync.ts` | Pure: API and iCal events to one shape, identity across doors, the type inference, the plan (create/update/cancel/skip — every event one named action). |
| `src/shared/meetings/meetTranscript.ts` | Pure: entries joined to participants by resource; unattributed stays unattributed; same `turnLine` renderer as Fireflies. |
| `src/worker/effects/googleWorkspaceClient.ts` | The only file that talks to Google as the firm (allowlisted egress with its reason): SA JWT via WebCrypto, Calendar read, iCal, Meet v2 reads, Workspace Events per-space create/renew, Pub/Sub pull/ack. |
| `src/worker/services/calendarSync.ts` | Tier 1: two doors, one ledger, every write authorised. |
| `src/worker/services/meetIngest.ts` | Tier 2: subscriptions, pull, poll, one inbox, the governed read; the firm default; platform-announced consent with its argument and its exclusions. |
| `src/worker/services/meetings.ts` | `importTranscript` admits a SYSTEM actor only with `platform: "GOOGLE_MEET"`; both gates unchanged. |
| `src/client/pages/MeetingsPage.tsx` | "Join on Meet" and "type inferred, check it" on the upcoming card. |
| `scripts/validate/a-calendar-meeting-exists-once.mjs` | `validate:calendar-sync` — one meeting per event through both doors, and the never-blend guard. |
| `scripts/validate/a-meet-call-that-ended-is-read.mjs` | `validate:meet-ingest` — one read per conference, attribution by join only, LP private by construction, the governed path is the only path. |
| `scripts/meet/probe-google.mjs` | The live probe through the Worker's own client. 12 checks, 0 not confirmed, 18 Sep 2026. |

Provider layers: Calendar read, iCal read, Meet scopes, Workspace Events subscribe/renew, Pub/Sub pull
are **PROVEN live** (read-only probe plus two real subscriptions); reading participants / transcript
entries / recordings of an ended call is **UNPROVEN live** (no conference record exists yet under
the grant) and proven against the fake; Pub/Sub push is **CONFIRMED impossible** behind Access.
## 18 Sep 2026 — Phase B: a meeting is one object with three faces

**The design, owner-approved 18 Sep 2026.** A meeting has a BEFORE (the brief), a DURING (capture and
the live room — Phase C) and an AFTER (what came out). P7 built the record and the during-face; P33
extracted firm-side follow-ups; nothing ever wrote down what was SETTLED, what was still UNKNOWN,
what the OTHER side owed us, or what a deal meeting meant for the deal's stage. This phase is the
data model and the Before/After halves, for EVERY meeting type — not only IC.

| Where | What |
|---|---|
| `migrations/0199_a_meeting_has_three_faces.sql` | `meeting_decision`, `meeting_open_question`, `meeting_stage_proposal`, `meeting_artifact`, `meeting_after_draft`; `meeting_commitment` extended (`owed_by`, `honoured_at`, `honoured_note`, `after_draft_id`) rather than superseded; `meeting_prep_packet` generalised into the brief (`brief_json`, `body_md`, `coverage_json`, `prepared_by`); `meeting.lp_record_id`; `work_card.meeting_id`. Artifacts get their own table because `deliverable.kind` is a CHECK D1 cannot widen. |
| `migrations/0200_the_brief_is_written_the_night_before.sql` | The five action keys (P4 compensating block) and `sjb_meeting_brief` — DAILY_AT 22:00 UTC, seeded **ENABLED** at the owner's ask, the loud way. |
| `src/worker/services/meetingAfter.ts` | The AFTER face. `draftMeetingAfter` (idempotent over a fingerprint of the notes; `opts.text` for a rolling caller; every outcome a row), `parseAfterDraft`/`afterDraftPrompt`/`recordAfterDraft` (pure, for Phase C), `approveMeetingAfter` (human-only in code; each object through its own key; the P33 assignment policy for firm commitments), `proposeStageChange`/`decideStageProposal` (ACCEPT calls `transitionOpportunity` under `opportunity.transition` — nothing moves a deal on its own), `saveMeetingArtifact`, `askOfferLedger`. |
| `src/worker/services/meetingBrief.ts` | The BEFORE face. `buildMeetingBrief` (deterministic; throws on zero coverage), `writeWhyLine` (the one model-written line, or a stated reason there is none), `assembleMeetingBrief` (stores on the P7 packet row), `runMeetingBriefs` (the job: CRITICAL on a failure; says how many it examined). LP conversations are declared `confidential` where `runAi` reads it — at the router, not in a prompt. |
| `src/worker/services/meetings.ts` | `assemblePrepPacket` now builds the brief (generalised, not duplicated); the list carries readiness (`brief_ready`, `carried_open_questions`, `we_owe_them`, `they_owe_us`) and outputs (`decision_count`, `commitment_overdue_count`, …); `lp_record_id` on create; `convertCommitment` stamps `meeting_id` on the card. |
| `src/worker/services/jobs.ts` | `job_key === "meeting_brief"` dispatched on the `wednesday_prep` pattern. |
| `src/worker/index.ts` | One contiguous `// === Phase B: meeting model ===` block: `GET …/brief`, `GET …/after`, decisions, open questions (+resolve), commitments honour, stage proposals (+decide), artifacts (list + save), after-draft (+approve/discard), `GET /api/meeting-ledger/ask-offer`. |
| `src/shared/meetings/meetingTypes.ts` | `seatableFor` offers every ACTIVE employee for every type (owner's rule) and carries a `warning` for an internal-only seat in an external room — a warning, never a lock. |
| `src/client/pages/MeetingFacesPanel.tsx`, `MeetingsPage.tsx` | Before and After panels on the record (four objects, artifacts, the draft with the partner's button), readiness/outputs on the lists, the seat warning, the static "How a meeting becomes work" section removed (the committee sequence stays in its section). Phase D redesigns the visuals. |

**Proof.** `tests/meetingModel.test.ts`, 35 tests: the draft refuses an empty page and an off-record
note, is idempotent over its input, and is stored FAILED/REFUSED with a reason; an AI actor cannot
approve or decide; approval writes all four objects, dedupes against hand-typed rows, and moves
nothing; ACCEPT moves the deal through the pipeline's own event; the brief carries both sides'
commitments and open questions forward by company and by LP, marks a resolved question gone, builds
the diligence framework for FOUNDER/DILIGENCE, and lands on the P7 row through the P7 route; the job
briefs the meeting in the window, skips next week's and the archived one, and does not brief twice;
the lists carry the counts; a converted card returns to its meeting; Willow can be seated on a founder
meeting. `tests/meetingTypes.test.ts` and `tests/meetingsLayout.test.ts` rewritten stricter where the
change made them false.

**Two validators, registered, hard-failing on zero, with negative proofs run on the real files:**
`validate:meeting-yield` (approve dropping the stage proposal → caught, restored) and
`validate:meeting-brief` (the job seeded PAUSED → caught; the dispatch key mistyped → "found 0 dispatch
branches", restored). `validate:deliverable-kinds` was reading ANY column called `kind` and took
`meeting_artifact.kind` as the deliverable CHECK; scoped to the deliverable table with a fixture
planting the real 0196+0199 shape.

**Extension points for Phase C (the live room):** `recordAfterDraft`, `draftMeetingAfter(env, actor,
id, { text })`, `afterDraftPrompt`, `parseAfterDraft`, `saveMeetingArtifact` /
`POST /api/meetings/:id/artifacts`, `readMeetingAfter`, `latestBrief` / `GET /api/meetings/:id/brief`;
tables `meeting_artifact` and `meeting_after_draft`. The Google Meet columns on `meeting` belong to
the sibling phase's migrations (0202/0203) and are not touched here.

## 18 Sep 2026 — Phase C: the meeting is a live room

**The design, owner-approved 18 Sep 2026.** Phase B gave a meeting three faces and built BEFORE and
AFTER. This is the DURING face: the room records itself with speaker turns, writes the After draft
while people talk, answers a question asked out loud or typed, builds a table or chart on the spot
from the firm's own record, and pulls an employee in for a task whose result comes back to the room.
**Nothing in the room writes a record from voice.** A question — spoken or typed — produces a saved
block, a preview-first work card, or a DRAFT; a person clicks Phase B's approve route to make any of
it a decision, a commitment, an open question or a stage move.

| Where | What |
|---|---|
| `migrations/0204_the_meeting_is_a_live_room.sql` | `meeting_artifact.asked_text`, `asked_via` (TEXT/VOICE/SYSTEM), `work_card_id` (unique — one card, one block); the `meeting.room.ask` key (P4 compensating block). The Google Meet columns (0202/0203) are not touched. |
| `src/worker/ai/providers/workersAiNova3.ts` | Deepgram Nova-3 on the Workers AI binding, diarised, `mip_opt_out` on every call, words folded into turns; an unattributed word starts an unattributed turn ("Speaker not identified"), never joins its neighbour's. Same place and same argument as Whisper (ADR-019). **Probe CONFIRMED** on the owner's account through the Workers AI REST surface with a spoken fixture: Nova-3 200 with `speaker` on every word; Whisper 200 with none. Cost from the probe: 137 neurons / 17.4 s on Nova-3 (~470 a minute → ~21 free minutes a day, ~$0.31 an hour after) vs 13.5 on Whisper. |
| `src/worker/services/liveTranscription.ts` | `transcribeWithSpeakers`: Nova-3 first, Whisper only when the MODEL is missing (`DiarisationUnavailable`), and the chunk result says which engine wrote the line and why. Each speaker turn becomes its own TRANSCRIPT_DERIVED note through the same two gates. `content_type` travels with the chunk. |
| `src/shared/meetings/roomQuery.ts` | The read-only record query: the model produces a PLAN (table, columns, filters from a closed operator set, one aggregate, one grouping, chart bar/line/pie), the compiler turns it into one parameterised SELECT over a 15-table allowlist with the firm scope, the page's privacy clause, archived rows hidden, and a 50-row cap. **Chosen over validated SQL** because a plan has no surface to widen — safety is a property of the vocabulary, not of a parser that must be right about CTEs, ATTACH and comments on day one. The model never sees a row. No relative imports, so the validator loads it natively. |
| `src/worker/services/meetingRoom.ts` | `roomState` (one read for the During face), `rollSummary` (Phase B's `draftMeetingAfter` — idempotent over the fingerprint, so a five-minute poll costs one run per change), `askRoom` (text or push-to-talk voice → the page host Walter, or the employee addressed by name, who is seated if not; one governed run returns answer / query / task / refuse, checked in code; EVERY outcome is a saved block, including a failure), `buildRoomContext` (the brief, the notes so far, the company/opportunity or LP record, prior meetings' After objects with the same counterparty, what was already asked — this meeting's objects only), `runRecordQuery` (compile → run → block with `cites` and the SQL that ran), `pullInEmployee` (seat, `createWorkCardInternal` with `meeting_id`, `preview_first`, her words on `prompt` for `steerFor`), `returnCardToRoom` (the return address: one block per card, updated to DONE with the finding), `saveRoomArtifact` (wraps Phase B's writer, stamps provenance). `confidential` derived from the meeting exactly as Phase B does, on every `runAi`. |
| `src/worker/services/employeeWork.ts` | On finish, a card with `meeting_id` returns its result to the room; a failure to return is recorded, never swallowed, and cannot un-finish the card. |
| `src/worker/index.ts` | One contiguous `// === Phase C: the live room ===` block after Phase B's: `GET …/room`, `POST …/room/roll`, `POST …/room/ask`. |
| `src/client/pages/RoomPanel.tsx` | The During face: ONE recording status line and ONE button (the consent prompt opens from it, every session, never remembered; the recorder starts only on the server's `can_capture`; the two-gate explanation is the tooltip and a secondary line); the rolling draft with DRAFT/APPROVED chip; ask by text or **hold-to-talk** (the room hears only while the button is held; the microphone is released on release; no wake phrase); the artifacts stream (answers, tables, inline-SVG charts on `--viz-*`, task receipts with working / done / needs-you chips, refusals and failures shown as blocks); seated employees with live task chips. Mounted in the live card in place of the old CapturePanel; SeatingPanel and Phase B's panels untouched. |
| `src/client/App.tsx` | **Tier 3 prep:** `#/room/<meeting id>` renders `RoomStandalone` — the same panel, no shell, behind the same `/api/me` gate. The shape a Meet Add-on side panel hosts later. |

**Proof.** `tests/meetingRoom.test.ts`, 27 tests: a typed question ends in an answer block and the
After face is untouched; a reply that proposes a record is not one of the four modes and is stored
as a failure; a refusal and an unreachable model are both blocks with their reason; "Wyatt, …" seats
Wyatt and answers in his name; an unemployed employee cannot answer; revoked access and an empty
question are refused; a plan produces a table that cites its rows with the SQL that ran, a grouped
plan with a chart type is a chart, a table outside the allowlist and a column outside its table are
refused BY NAME as blocks; a task opens a preview-first card with `meeting_id` and her words on
`prompt`, seats the employee, and its result returns to the SAME block; a blocked card reads "needs
you"; the rolling summary is Phase B's draft and never approves; the context pack carries the record
and prior meetings' After objects for the same company and not another's, and never an off-record
note; Nova-3 turns fold by speaker with an unattributed word kept unattributed, and Whisper is the
named fallback; a spoken question is saved as VOICE; the three routes answer, and answer 401 to
nobody. `tests/meetingsLayout.test.ts` — six pins that moved with the recorder were rewritten
stricter against `RoomPanel.tsx` (the Start button waits on the two gates the prompt cannot open;
the recorder starts only on the server's `can_capture`; no control on the face can approve or move
anything; push-to-talk releases the microphone; the standalone route exists).
`e2e/p71-live-room.spec.ts`: start now → the one button → consent → recording or the named reason →
ask by text → a block appears and stays → nothing in decisions, commitments, questions or proposals
changed → `#/room/<id>` renders the face alone.

**Two validators, registered, hard-failing on zero, with negative proofs run on the real files:**
`validate:voice-is-read-only` (a `recordDecision` wired into an answer → caught by import AND by
call, restored) and `validate:room-answers` (citations dropped → caught; the compiler letting
`firm_user` through → caught with the SQL that would have run, restored).

**Not done, and why.** Wake-phrase listening — the owner chose push-to-talk only. Live transcription
inside Google Meet — Phase Meet (0202/0203). The visuals — Phase D. A real Nova-3 chunk through the
Worker binding is UNPROVEN until deployed (the REST probe proves the model and the account; the
binding's input shape is the documented one).

**What Tier 3 needs.** A Meet Add-on manifest pointing its side panel at `#/room/<id>` on the
deployed origin, Cloudflare Access allowing the add-on's iframe (the same session cookie), and the
Phase Meet `meet_conference_id` on `meeting` so the panel can be opened by conference rather than by
meeting id.

## The morning brief is on demand, on Sonnet, any day (19 Sep 2026)

**What production showed, CONFIRMED from the rows.** Saturday 19 Sep: no `intelligence_report` row
for either partner between 06:15 and 09:29 ET; every scheduled tick read sources, because both
`partner_intelligence_profile` rows carried `weekends = 0` — the column default, never chosen. Her
press at 13:29:30Z gathered and read the market in six seconds, then the write stage's model call
ran INSIDE her HTTP request on `deepseek/deepseek-v4-flash-0731:free`; the request was cut and the
`ai_run` was still RUNNING at 13:45 with the row at GENERATING under a ten-minute lease. Her second
press met that lease ("Another run holds it"). The day before, both briefs FAILED "incomplete" three
times each: twelve calls, all to `@cf/ibm-granite/granite-4.0-h-micro` under the free-first ladder,
every one exactly 256 output tokens; Sonnet — 38 of 38 accepted briefs 20 Aug–17 Sep — was never
reached because a truncated reply is a completed run to the chain.

**The evidence for the delivery model, kept as the record.** 44 weekday briefs owed 20 Aug–18 Sep,
38 arrived (86%); 62 of 67 synthesis calls were the schedule's, 5 a person's press; her three
complaints in 30 days were each about the automatic brief not being there. Cost, measured: $0.12–
$0.30 a brief on Sonnet (mean $0.20, 51 runs); the brief lane was $6.70 of September's $9.61 to the
18th. The agent's call from that evidence was auto + on demand.

**THE OWNER'S DECISION, which overrides it — verbatim:** *"fix why the free tiers are failing! …
Make the briefs on demand and make them use Sonnet — that is the new solution. On demand + Sonnet
for briefs only. On demand any day of the week!"*

**Built.** Migration 0211 (`0211_the_brief_is_on_demand_on_sonnet`): the schedule's retirement
recorded as a RETIRED `scheduled_job` row (`morning_brief_schedule`, the 0198 precedent — refused
on every trigger, 409 on the routes, never re-opened by a seed); `requested_at`, `requested_by`,
`retry_after` on the row; the sweep job renamed for what it does. The every-morning path
(`runDailyForAll`, `briefsOwedToday`, the weekend and earliest-hour gates) is gone; `weekends` and
`earliest_start_local` no longer bear on a brief and are left as they are. The tick — every minute —
ADVANCES only rows with `requested_at`, every ready stage inside one invocation; a press is picked up
within a minute and READY about four minutes later (gather ~2s, market ~10s, write 98–281s measured).
`POST /generate` records the press and returns the named state at once (202; 200 `already: true`
while moving); `GET /status` returns the state from `shared/intelligence/briefRunState.ts` — arrived ·
requested · running · queued · retrying · failed_out · idle · stalled — each with a sentence, what
happens next, elapsed against the MEASURED usual (median of the last 30 completed write calls + 75s),
and the button's label and enabled flag. An idle morning reads "No brief today yet. The last one
arrived Thursday 7:42 AM." A FAILED row carries `retry_after` (+20 min, from the caller's clock);
the clock retries the same press up to three attempts, then "Nothing more is tried automatically.
Press the button to try again now." — with one notice for retrying and one WARNING for failed-out.
The health board reads OK with "last brief N days ago · on demand" for an unrequested morning and
carries no sentinel.

**Sonnet for briefs only.** `budgetContext.requireModel: BRIEF_MODEL` ("anthropic/claude-sonnet-5")
reduces the router's candidates to lanes serving that model before any ordering — no free lane
assembled, no other model as a fallback, the same model at its own vendor as the outage fallback,
a named PREFLIGHT stop if none serves it (FREE_ONLY included). No other caller pins; every other
lane keeps the free-first ladder, and `validate:brief-lands` fails if a second caller pins.

**Why the free tiers were failing — fixed at the router, for every lane.** (a) Every model-lane
adapter maps its vendor's finish reason (`finish_reason: length` / `stop_reason: max_tokens` /
`finishReason: MAX_TOKENS`) through `providers/finishReason.ts`; `executeAttempt` turns a capped
reply — the vendor says so, or the tokens used reached the cap sent — into `truncated_reply:`, a
FAILED attempt that hands on. (b) The cap on the wire is `wireOutputCeiling(expectedOutputTokens)`,
never a platform default — pinned by test. (c) A caller's verifier runs INSIDE the walk
(`RunAiInput.verify`); a refusal is `verifier_rejected:` and the chain moves to the next rung instead
of the caller asking the same lane again; the brief passes its parse-and-verify as `verify`. Both
classes are `isUnservedReply`, engage every fallback, and arm no back-off (the lane is healthy; the
reply is not). (d) A hung rung is aborted on its attempt deadline (450 s for the brief's ask,
`MAX_ATTEMPT_MS`) and the walk moves on — proven with a fake lane that never answers, under a
tests-only deadline override no production caller may set. `expectedOutputTokens` 8,000 → 24,000
(measured median 17,415, p90 22,969, max 27,536). The write lease is derived from `CHAIN_BUDGET_MS`.
`stage_at`, `started_at`, `retry_after` are written from the caller's clock, never SQLite's. A
requested row waiting its turn behind another partner's build is queued, not abandoned.

**Also in this PR (coordinator's addition).** Meetings: a SCHEDULED meeting whose time + 90 min has
passed is never "Coming up"; synced rows settle to HELD ("held, nothing on the record") from the sync
and the list route; one shared split (`shared/meetings/pastMeetings.ts`) for server and page.

**Proof.** `tests/freeTierWalksOn.test.ts` (a capped reply, a cap-by-count reply, a verifier refusal
each walk to the paid lane and say why in one word; a pinned lane with a refused reply STOPS with the
verifier's reason; a hung lane is aborted and the walk moves on; the cap on the wire ≥ the ask),
`tests/briefRunState.test.ts` (224 row combinations, one arrival; idle carries the last brief),
`tests/briefServed.test.ts` (the clock starts nothing on a Saturday; a request is served any day
whatever the profile says; a second press refused from the row; a lane forced to fail → reason,
`retry_after`, notice; third failure → nothing more; the retirement row), `tests/pastMeetings.test.ts`,
`tests/cheapoAndFreeLanes.test.ts` (pin with a control; an unserved pin stops by name); strengthened,
never loosened: `jobs.test.ts`, `briefTick.test.ts`, `dailyIntelligence.test.ts`,
`briefTerminality.test.ts`, `workSweep.test.ts`, `meetingsLayout.test.ts`. `validate:brief-lands`
(542 items; fourteen restored pre-fix shapes), `validate:brief-arrives` and
`validate:brief-ends-stated` strengthened. `e2e/p62` (press → named state → second press refused →
tick → arrived or the stated reason) and `e2e/deals-surfaces.home-brief.spec.ts` (the band on the
shared measured contract at five widths, idle and terminal).

**Not done, and why.** The band's visual design is Phase HOME_DESIGN's (a design agent's canvas
awaits the owner's approval); the band here is functional and on-token. Sonnet's reply is ~75%
reasoning tokens; a smaller thinking budget would cut the per-brief cost 2–3× — a quality decision
for the owner, recorded, not taken.

## Fund strategy — where the fund is going (19 Sep 2026)

**The owner's brief.** *"another design overhaul of the fund strategy page — I don't think we
should repeat the same stuff that is on the portfolio page (at least in the same way), and the link
to our venture deals dashboards should be bigger and more prominent."* The approved design is
`design/FUND_STRATEGY_DESIGN.md` (canvas G1p5bFmgosQsxvoBrJymAR); her three decisions: orange goes
to the dashboard door; monitoring leaves Fund strategy entirely; `first_close_on` is recorded.

**The audit's twelve findings, each closed.** #1 the door is the first band and the page's one
`.btn-primary.btn-lg` anchor (`DashboardDoor.tsx`); #2 `Composition` and `CockpitPage` no longer
mount here (`CockpitPage.tsx` and `FollowOnPage.tsx` are gone — the former's data is Portfolio's
four bands, the latter's candidates form moved to Portfolio's "Pulling ahead" as
`FollowOnCandidates.tsx` and its reviews to the reserves band); #3 a masthead answer derived from
`/api/portfolio/allocation` and the mandate ("One company in, nineteen to the plan."); #4 the
construction reads as three sentences at rest, the editor opens behind Amend seeded from `current`,
painted once seeded (a flash-then-flip was caught by the measured contract mid-transition at
1.6:1); #5 one rank per level — masthead `h2`, band `h3`, panel `h4`, one fund, the picker only
when `/api/funds` has more than one; #6 the scenario form asks one thing (investable after fees,
prefilled from the sleeve's estimate and said to be an estimate), the capital/existing-cost
defaults are gone, no `<code>` ids on the reading line; #7 **CONFIRMED in production**
(`fund.target_size_minor` NULL, mandate $30M): `/api/funds/:id/basis` now falls back to the current
mandate's `target_size_usd` with `fund_size_source: DERIVED` — the recorded size still wins; #8 the
gap rows state the distance pool by pool; #9 `STRATEGY_STEPS` removed; #10 candidates are
Portfolio's, reviews and headroom are here; #11 `pagePurpose` rewritten; #12 the xirr note stays in
the code comment.

**New on the record.** Migration 0212 `fund.first_close_on` — typed behind Amend (`PATCH
/api/funds/:id/size`, `fund.set_size` authority, absent keeps / null clears / malformed 400), or
set by the first SIGNED LP commitment (`committed_on`, else today; never by a SOFT one, never moved
by a later signature; `fund.first_close_recorded` on the spine). `/api/portfolio/allocation` carries
`fund.first_close_on`, `deployment.timeline[]` (executed purchases against the early-stage sleeve,
dated) and `deployment.secondaries_deployed`. Fees paid to date stays "not recorded" — no fee ledger
exists. The pace chart (`shared/fund/pace.ts`, inline SVG on `--viz-1` / `--wp-line-control`) has
four states: no clock (the notice + "Record first close", nothing guessed), running (the verdict in
words), overspend, no size.

**Styles.** §5 classes appended to `styles.css` — `a.btn-primary`/`a.btn-strong` chrome (a link
styled as a button did not exist), `.door*`, `.figures`, `.pace*`, `.gap-*`, `.policy-lines`,
`.construct-line`, `.amend-tray`, `.sector-chips`, `.actions`, `.deck-row`, `.deck-title`,
`.headroom` — registered under `fund-strategy` in `design/DEALS_SECTION_CLASSES.json`, landed.

**Security.** The door is `<a target="_blank" rel="noreferrer noopener">` with an `aria-label`
naming the destination; the clipboard write is client-side, the six figures only; every policy
write is the existing versioned `POST /policies/:kind` (MP-only, 403 kept and shown as the disabled
Amend with its sentence); `first_close_on` is validated (`YYYY-MM-DD`) and authorised the same way
the size is.

**Accessibility.** `h2` answer · `h3` band · `h4` panel; every act a `<button>` or `<a href>`;
Amend and Open a scenario carry `aria-expanded` + `aria-controls`; the invalid cheque range is
`aria-invalid` with `role=alert`; the chart is `role=img` with a sentence label and the verdict
repeated in words; the gap bars carry `aria-label`s; 44 px targets below the phone breakpoint.

**Proof.** `tests/fundStrategyBuild.test.ts` (the pace in every state; the sentences; the six
figures; basis DERIVED then RECORDED; first close typed / cleared / refused; SOFT does not start
the clock, the first SIGNED does, a second never moves it; the split by source),
`tests/portfolioHoldings.test.ts` re-pinned stricter for the two new fields;
`validate:fund-strategy-split` (new, 7 files / 36 mounts, hard-fails under ten items; self-test
restores the audited page); `validate:portfolio` re-pointed at the ring's new host;
`e2e/deals-surfaces.fund-strategy.spec.ts` on the shared measured contract — five widths at rest
(210 text nodes, min 5.29:1, 11 clickables, 0 under the floor, 0 wrapped, 0 overflow) and with
Amend open (289 text nodes, 31 clickables), the no-clock → running journey through Amend, the copy
and the scenario opened against the mandate's size; `p11` and `p64` kept green.

**Not done, and why.** Per-company reserves (`position_reserve`) subtracting from the headroom
wait on Portfolio writing them (Deals spec §6). A crosshair tooltip on the pace chart is a
follow-up; the chart carries its sentence and marker labels.

## Home, rebuilt — what is waiting, what arrived, one count (19 Sep 2026)

**Spec.** `design/HOME_DESIGN.md` (branch `design/home` @ 38c17a8, canvas
https://claude.ai/artifact/BKqKjJN1iwNVhwzkutQdRV), approved by the owner 19 Sep with three picks
decided: no bulk approve (select-many quiets blockers and clears arrivals only); the brief band never
mentions a clock — scheduled/off collapse into idle and the "usually" figure is
`expectations.usualSeconds`, measured, never typed; Ask and Setup move to the foot line (Ask stays in
the nav). Audit findings honoured: 13 (5 critical, 6 major, 2 minor).

**What landed.** One masthead answer in words from ONE count (`shared/home/answerLine.ts`:
`needsHer` = decisions + blockers + previews; the Waiting pill renders the same number; the detail
names the kind — "Not a signature — …"; one sentence of the brief's line). A filter rail under the
masthead — All · Waiting on me · Arrived · Quiet — with `← Home` when a filter is on, remembered per
viewer (`client/lib/homeFilter.ts`, `wp.home.filter:<viewer>`), never opening on an empty band, Esc
returns. Waiting decides inline: Approve (`btn-strong`) · Reject (a reason under the row) · Open on
the row through `POST /api/approvals/:id/decide`; the decided row wears its `approved 7:04 AM` badge
and leaves on the next read; select-many quiets blockers for a week or stops them — the approval
card's checkbox is disabled with "Decided one at a time", and there is no `Approve selected`. Arrived
carries deliverables for the viewer with `daily_brief` excluded (`?exclude_kind=`), `Mark all read`
and select-many `Mark read` / `Put away` as ONE request each (`POST /api/deliverables/acknowledge-many`,
`/dismiss-many`, `POST /api/attention/dismiss-many`; zero ids is a 400; a partial batch is a 207
that names what it could not find) with Undo. The brief is a band with eight named states, a stage
strip, the product's progress track capped at 95% until READY, and the measured usual. One orange
control on the page: the preview's Approve and send. The removals table honoured: the brief's
Show/Hide fold, the quiet roll's toggle, the put-away shelf toggle, the Ask dock, the Connect strip,
Home layout preferences, the Private layer (now its own route, `#/private`, linked from the foot) and
"What this page answers" (Help) are off Home; 31 retired CSS rules removed. Every card she can decide
is a row — `mpHome` no longer hands Home the first eight of them.

**The 7 AM screen.** At 390×844 the shell put 437px of chrome above the answer (the identity line
wrapped to three, the purpose block ran to five). On a phone the identity line drops the address
and the role, the purpose block drops its verb line; the redundant "waiting on you" badge inside the
Waiting band is gone; the masthead carries one sentence of the brief. Masthead at 346px; rail,
Waiting head and the first row whole above the fold; Arrived within one row-height under the rows
(above the fold when one thing waits). `design/home-screens/before-390.png` and `after-390.png`.

**The sign-out race, fixed at its source (coordinator's addition; main run 35457328146 on the
merge of #127, 171/172).** CONFIRMED from the runner's log: after sign-in, Home's children sent
their first reads AFTER Sign out had dropped the identity; they came back 401 `{error}`; four
children read `.length` / `.themes` / `.enabled` / `.map` off that body; one threw and React 18
unmounted the whole tree — `#root` empty, no signed-out page. Reproduced deterministically by
routing any one of those reads to a 401. `useApi` now hands `data` only for a 2xx (the status still
says what happened; `IntegrationsPage`'s one error-body read is keyed on 403), and `SurfaceBoundary`
(keyed on route and identity) keeps a page that still throws inside its own place. `p42` pins the
real sequence — the click, the `/api/me` 401, then the sentence — and a fourth journey forces both
guarantees. Negative proof: with the old `useApi` restored the journey fails at the fault pin.

**Proof.** `tests/homeAnswerLine.test.ts` (the pill and the answer can never disagree, 18 mixes;
one sentence of the brief), `tests/homeFilter.test.ts`, `tests/briefRunState.test.ts` (`slow`,
`stages`), `tests/deliverables.test.ts` (zero ids 400 on three verbs; 200 with every id read; 207
naming the missing id; `exclude_kind` keeps the brief off Arrived and only there),
`tests/homeFreshness.test.ts` (the ninth card renders; the count is the rows). `validate:home`
(eight source pins, 13 planted defects, hard-fails on zero). `e2e/home-overhaul.spec.ts` (the 7 AM
screen; one count; `daily_brief` never in Arrived; reject → reason, approve → badge; Mark all read;
select-many put-away and Undo; the rail remembered, `← Home`, Esc, never empty; no Approve selected;
the measured contract at five widths — 285 text nodes, min 5.02:1, 100 clickables, 0 under the
floor, 0 wrapped, 0 overflow at 320/375/414/768/1280). `d2-home-measured` and `measure.ts` treat the
rail as the one declared inner scroller. Re-pointed stricter: `p14-mp-home`, `p25-journeys`,
`p42-session`. Desk link-buttons meet the 24px floor everywhere.

**Not done, and why.** The shell's status bar still says "N waiting on you" from unread
notifications — a different number from the masthead's, in the masthead's words. It is the
shell's copy on every page, defended in place by a comment, and outside Home's boundary; it is
recorded here for the shell's own pass. `HOME_DESIGN.md` §1 #5's "26.8 min average" is the
production figure; the band shows what the rows measure (`measuredExpectations`, last 30 completed
write calls + 75 s), so the copy carries no number of its own.
## "How does this page work" is answered from the page (19 Sep 2026)

**The owner's report.** *"I asked Walter on the Meetings page how this page works now and I can't
understand anything he said — it's all jumbled. All 'how does this page work' responses need to be
overhauled to be clean, step by step and formatted; also I think he still has the old page
instructions."* Her pasted example was one paragraph with three bolded phrases — "Prepare for a
meeting… Confer with an AI employee during it… Run a close-out…" — the page before #115, #122 and
#123. Two defects, CONFIRMED: `pageChat.ts` prompted the host with `pagePurpose.ts`, whose Meetings
entry was that trio, and `PageHostChat.tsx` rendered every turn as one `<p>`, so a numbered answer
was flattened on its way to the screen. The addition, same day: the Help tab carried a third,
hand-written description of the same pages.

**The source of truth.** `src/shared/help/pageGuide/` — one guide per page (21: Deals ×7, Firm ×5,
Learn ×3, Now ×3, Home, Ask, Capture), each naming purpose · what you see top to bottom (bands, by
testid) · what you can do (acts, by testid and visible label, with does / then / who / primary) ·
what happens on its own (job keys) · where the rest lives (route keys). `pagePurpose.ts` derives a
guided page's purpose block from its guide (`fromGuide`) — no second copy. `render.ts` produces the
one Markdown shape (`renderGuideMarkdown` / `renderGuideAnswer`) and `asksHowThePageWorks` matches
the question deterministically.

**What was stale, per page** (from four read-only inventories of the components on 287ee44):
Meetings — the whole purpose block (the trio; "live help" as a panel; no faces, room, Meet band or
one-card approval); Companies — "See its metrics, claims and history" and "Check where a number came
from" (those live on Dealflow's What we know face); Portfolio — nothing about Book it / Mark it /
Reserve for it / Sell, the holdings or the ring; Secondaries — "See pricing against the last round"
(nothing writes a pricing observation; the page says to confirm); Research — "Export it" (no such
control); Documents — "Download any version" and "See what has been extracted from it" (no version
picker, nothing extracted shown); University — "Be marked honestly" (prose, not a control);
Capture — "Route it to the right machine later" (routing is offered only on the card just kept);
Ask — the checks / lens gate unmentioned; `deal-math` — described the removed "Why the two agree";
`reporting` — "Assemble a reporting packet" (the LP page's labels are Start / Put it in front of its
reviewers / Send it to the investors) and did not say it moved to LP; `browser-tasks` — "Lives
inside Work" (it does not; only its own route); `market-map` — "Sort by how much each has raised"
(pre-sorted, no control). Help tab — "Work → Approvals" and "Work → Scheduled Work" (Approvals is
under Now; jobs are Work's Machinery tab), "New jobs are created PAUSED" (a job is on unless there
is a stated reason), a hard activation cap (the cap is the whole roster; the duty window is what is
small), "More / System → Integrations" (Admin), LP's "evidence gate → publish → share" path (only
revocation is on the page), and OpenRouter audit-era claims. Hosts unchanged; `pageHosts.ts` was
already true.

**The guard.** `validate:page-guides` (`scripts/validate/a-guide-names-what-the-page-emits.mjs`,
in CI): 21 guides, 55 source files, 189 acts examined; fails on a named testid or label the page
does not emit, a primary act the guide omits, a link to no route, a job no migration writes, a
paragraph-shaped answer, or the retired trio anywhere in `pagePurpose.ts` / `HelpCenterPage.tsx`.
Hard-fails on zero. Negative proof: `--self-test` restores 19 Sep's Meetings text as a guide
against the real Meetings sources and it is caught on all three labels and on the omitted primary
acts. `validate:scans-read-code` accepted it (every read is stripped at the read).

**The answer.** `pageChat.ts`: a "how does this page work" question is answered with the guide
verbatim as a recorded HOST turn, `detail = 'GUIDE'`, no `ai_run` — nothing to paraphrase, nothing
to spend. Every other question is prompted with the same guide as the page's only description
("never name a control that is not in it") and a fixed shape: one line, then numbered steps or
bullets, controls in bold, at most twelve lines, no question back. `PageHostChat` paints a host's
turn through `MarkdownLite` (shared parser `shared/help/markdownLite.ts`; headings one weight up,
lists real `<ol>`/`<ul>`, at the thread's own size).

**The Help tab.** `HelpCenterPage.tsx`: THE PAGES first — one section per page from the same guide,
grouped as the rail, host named, `Open <page> →`, searchable by band and control; then HOW THE FIRM
WORKS — the firm-level topics brought current, structured as lists, each pointing at the code that
enforces it (`Where this is enforced`). Page-specific topics that duplicated a guide (intelligence,
investing, LP, portfolio, notifications) removed. `How everything works →` on a page writes
`wpos.help.focus` and Help scrolls to that page's section.

**Proof.** `tests/pageGuide.test.ts` (17: every hosted / Now / pinned page has a guide, no guide
for a dead route, titles are App.tsx's labels, purpose block equals guide, writing rules, the
Meetings guide names the faces / room / Meet / one approval and never the trio, the rendered answer
is one paragraph + one ordered list of bands + bulleted acts every one in bold with the human act
first and no line over 300 characters, question detection both ways, the parser);
`tests/pageChat.test.ts` (+2: over HTTP, Walter's answer on Meetings is the guide, lists, no trio,
recorded as GUIDE with `ai_run_id NULL`; a question about one control still runs the model);
`e2e/p72-how-this-page-works.spec.ts` (ask Walter → real `<ol>` of ≥7 bands, `<ul>` acts, >10
bold controls, <4 paragraphs, current controls present, trio absent, no trailing question; Help →
Meetings section, deep link lands in view, every room's section attached, search narrows on
"hold to talk", the door back). Design-token, css-class, heading-scale and brand scans green.

**Home.** Its guide's purpose and headline acts are written to `design/HOME_DESIGN.md`; its bands
and act testids are the page as it renders today, because the validator holds the file to the
page. When `design/home-overhaul` lands, the validator fails until that branch updates
`pageGuide/home.ts` — the contract working, said in the file's header.

## The room hears the Meet LIVE, and the room beside the call (19 Sep 2026)

**The owner's question:** "If I push Join on Meet what happens? Is it recording? Are my AI
employees there from Join on Meet alone?" Before: no — Join opened a tab, and the room heard
nothing until the call ended and tier 2 read the transcript. Now, tier 4: when a firm-hosted Meet
on the calendar is running, the OS joins it as a participant through the Meet Media API and what
it hears goes down Phase C's own path — a slice a minute → Nova-3 → the governed import → notes —
so the rolling draft, ask-the-room and the seated employees hear the call with no new UI. And
tier 3: `#/meet-panel`, the same During face inside Meet's side panel.

**Where the peer lives** (`ARCHITECTURAL_DECISIONS.md`, 19 Sep 2026): a WebRTC session cannot be
held by a Worker or a Durable Object, and a Container is a new paid product; the peer is headless
Chromium on her Mac (`scripts/meet/live-listener.mjs`, `lib/listener-core.mjs` the loop with every
side effect injected, `lib/meet-media-page.js` the peer; launchd job
`ventures.westpeek.os.meet-listener`, the same vault and Access token as the seat claimer). The
Worker (`services/meetLive.ts`, `meetLiveView.ts`, `meetLiveNotes.ts`) holds every decision.

**Migrations 0215, 0216.** `meeting.meet_live_state / _detail / _updated_at` (eleven named states
and NULL), `meet_live_session` (UNIQUE per conference; the cost ledger: chunks, turns,
seconds_heard, neurons, drafts_rolled), `meet_live_listener` (heartbeats), `transcript_import.
superseded_by`, `action_type meet.live.join`; then `meeting.call_ended_at` — THE END-OF-CALL SIGNAL,
one column both faces read, written by the listener or the ingest, first writer wins.

**The gates, in order, each a state on the row:** a calendar-synced meeting with a conference (a
manual meeting has no live path — NULL); the meeting-type rule; the firm recording default (0203);
platform-announced consent (tier 2's function, recorded once per conference); `meet.live.join`.
**LP and Broker meetings never join live** — the owner's rule the same day, because the Media API
is Pre-GA and term (vi) of the Developer Preview terms lets Google use what passes through it;
enforced in code at the join decision (`liveAllowedForType`), `meet_live_off_lp_policy` on the
row, the GA post-call path unchanged. **Two sources of one call:** the official transcript is
authoritative for After; when it lands the live imports are superseded and the note readers skip
them; the live notes stay as corroboration.

**Routes, one block `// === Meet live ===`:** heartbeat, sessions, sessions/:id/report,
sessions/:id/chunk (the Mac's identity only); live/status, live/resolve, live/adopt (partners).
The Worker refuses any state-changing `/api` request whose `Sec-Fetch-Site` is cross-site, so the
side panel can ride her Access cookie with SameSite=None (the one console step, hers).

**Proof.** `tests/meetLive.test.ts` (24): the states are one vocabulary with the migration; the
heartbeat's door; every gate by name; an LP and a Broker meeting refused with the default on; a
slice through a fake Nova-3 into labelled notes, the room's state and context pack, the draft's
cadence, staleness, cost from the ledger; ended → HELD + the signal; the three named failures with
Google's words; the official transcript superseding three live imports and consent recorded once;
the LISTENER'S REAL LOOP end to end against the fake Meet media server — not started, scope
missing, retry, preview missing, join → slices → end — with every host on the request log Google's
or the Worker's and audio only to `/chunk`; resolve, adopt, the cross-site guard.
`validate:meet-live` (+ 15-fixture self-test + the listener's `--self-test`): five gates before the
INSERT, the type rule against the REAL function with six planted meetings, the network boundary of
the core/page/CLI, both speech adapters on the binding with `mip_opt_out`, state parity, the add-on
deployment's origin. Negative proof on the real file: LP let in → `✗ a planted LP meeting … would
JOIN` exit 1; restored → passes. `validate:meet-ingest` strengthened to the new provider list.
`e2e/p72-meet-panel.spec.ts`: the panel beside an unknown call → Record this meeting now → the room
at 360 px, no shell, no overflow → not firm-hosted, so no live session → the deep link lands on
After.

**Live, 19 Sep 2026 (read-only, the vault):** the Media API scope now MINTS under impersonation
(the owner granted it); the service account's own identity is refused on the space (403); every
`v2beta` call — where the Media API lives — answers `404 Method not found` for every identity:
the project is not in the Developer Preview (applied for; `meet_live_unavailable_preview` until it
lands, retried every five minutes, no redeploy). The listener's real loop against the real Google
and a local Worker: heartbeat, `media_scope: GRANTED`, `spaces.get svf-nzzr-pax`, not started.
The peer page's own `audio/webm;codecs=opus` slices from a spoken fixture, played to Nova-3 over
REST: both 200, the sentence verbatim, 61.5 neurons / 7.9 s → **$0.31 per hour of call**.

**Labels.** The Worker path, the listener's loop, reconciliation, the panel, the guard: PROVEN
(local D1, fake Meet, fake Nova-3, browser). Nova-3 on the peer's real audio: PROVEN (REST). The
live join into a running Meet: UNPROVEN — Google's `v2beta` refusal above is the exact reason.
