# Evidence Model — West Peek OS (P5)

Governing law: **AI prepares the decision. The Managing Partners and authorized humans
make the decision.** P5 builds the one evidence/provenance substrate (D16) so that
unsourced AI output can never become institutional truth. This document describes the
claim vocabulary, the self-promotion ban, the contradiction lifecycle, knowledge
promotion, and the R2/D1 storage split.

> **Real provider extraction is UNPROVEN — CREDENTIAL GATE.** All extraction tests
> run through the deterministic mock-local adapter offline. No live AI credentials
> exist in any environment.

## Tables (migration 0005)

| Table | Role |
|---|---|
| `document` | Metadata/provenance for a governed document. Binary content lives ONLY in R2 (`WP_OS_DOCUMENTS`). |
| `document_version` | Immutable version rows: `r2_key`, `sha256`, `size_bytes`, `content_type`. UPDATE/DELETE rejected by trigger. |
| `diligence_claim` | A claim about a company/subject with provenance: extractor, confidence, status, sources. |
| `claim_source` | Append-only (trigger) provenance rows for a claim. |
| `contradiction_record` + `contradiction_claim_link` | A tracked conflict between claims, with human disposition. |
| `knowledge_promotion_candidate` | A proposal to promote claims into institutional memory. |
| `knowledge_record` | Durable institutional memory with provenance; superseded records stay readable. |
| `source_conflict` + `source_resolution_decision` | Cross-system source-of-truth conflicts; decisions append-only by trigger. |

## Claim status — the six-value enum (ADR-004)

`VERIFIED | FOUNDER_STATED | THIRD_PARTY_SOURCED | AI_INFERRED | UNVERIFIED | MISSING`

This is the ONLY diligence claim status enum. The seven-value Receipts Layer labels
(KNOWN/BELIEVED/…) are out of initial scope (ADR-004).

Every claim also carries: `confidence` (REAL 0..1), `extracted_by_type` (`HUMAN|AI`),
`extracted_by_id`, optional `ai_run_id` (link to the governed run that produced it),
and at least one `claim_source` row with mandatory `source_type`, `source_date`,
`location`, and `method` — creation without them is a 400.

Source types: `DOCUMENT | TRANSCRIPT | WEB | VENDOR | HUMAN_STATEMENT | MODEL_OUTPUT | OTHER`.

## The self-promotion ban (structural)

A claim can NEVER be `VERIFIED` when:

- its extractor is AI — enforced three ways: the service refuses on create and on
  every status transition; the database carries
  `CHECK (NOT (extracted_by_type='AI' AND claim_status='VERIFIED'))`; and there is
  **no generic claim status-update route** (a direct PATCH/POST to `/api/claims/:id`
  is a 404), or
- its only sources are `MODEL_OUTPUT`/`TRANSCRIPT`/`WEB`/`VENDOR`/`OTHER` —
  `POST /api/claims` with `VERIFIED` and `POST /api/claims/:id/verify` both refuse
  with 409 `self_promotion_ban` unless at least one `DOCUMENT` or
  `HUMAN_STATEMENT` source exists.

### The human accept flow (the only way out of AI quarantine)

AI extraction (`POST /api/claims/extract`) runs through the `runAi` boundary (P4)
with the document's `privacy_label` as sensitivity. Candidates land as
`AI_INFERRED`, `extracted_by_type='AI'`, with `ai_run_id` set and a `MODEL_OUTPUT`
source noting the run trace — quarantined from institutional truth.

`POST /api/claims/:id/accept` is human-only and requires the accepting human to
attach a `DOCUMENT` or `HUMAN_STATEMENT` source. On accept, the claim is
**re-attributed** (`extracted_by_type='HUMAN'`, `extracted_by_id` = the accepting
user) and may become `VERIFIED`/`FOUNDER_STATED`/`THIRD_PARTY_SOURCED`. The AI
origin is never erased: `ai_run_id` stays on the row and `claim.accepted` on the
spine records `original_extractor_type: 'AI'`. A human now stands behind the claim
with a real source — AI never promoted itself.

### Supersession

`POST /api/claims/:id/supersede` creates the replacement claim (same provenance
rules as create) and links `superseded_by`. Superseded claims stay readable; the
current claim in a chain is the one with `superseded_by IS NULL`. Double
supersession is refused (409).

## Contradictions

Lifecycle: `OPEN → INVESTIGATING → RESOLVED | ACCEPTED_RISK | INVALID`.

- Anyone may create; **AI proposals enter `OPEN` with `proposed_by_type='AI'` recorded**.
- `INVESTIGATING` assigns a human owner.
- Disposition (`RESOLVED`/`ACCEPTED_RISK`/`INVALID`) is **human-only** at the service
  level, with `resolution_evidence_json` + `human_disposition_by/at`.
- Detection (`GET /api/companies/:id/contradiction-candidates`) is deterministic:
  current claims grouped by company + `metric_key` propose `VALUE` (differing
  values), `PERIOD` (same value, differing periods), or `DEFINITION` (same value and
  period, differing wording) candidates. Detection never writes records — humans decide.

### Downstream visibility (the P6 IC hook)

`GET /api/companies/:id/evidence-summary` returns claims grouped by status plus
**all unresolved material contradictions** (`OPEN`/`INVESTIGATING` at
`HIGH`/`CRITICAL`). That section is structurally un-hidable: no query parameter or
role filters it out. IC packets (P6) consume this endpoint; material contradictions
cannot be silently dropped from downstream surfaces.

## Knowledge promotion

Durable institutional memory requires human approval through the P3 card flow:

1. `POST /api/knowledge/promotion-candidates` — creates a `PENDING` candidate citing
   source claims, plus an approval card for the reserved action `knowledge.promote`
   (MP approver).
2. A human approves the card.
3. `POST /api/knowledge/promotion-candidates/:id/apply` with the receipt →
   `authorize()` verifies it, a `knowledge_record` is created with
   `provenance_json` (source claim ids, candidate id, approval card id, promoter),
   the candidate becomes `APPROVED`, and the receipt is consumed (replay refused).
   No receipt → 409 `approval_required`.
4. Reject path: `POST …/reject` (human) → `REJECTED`; apply is refused.
5. Supersede chain: a candidate payload may carry `supersedes_knowledge_id`; the new
   record increments `version_no` and links `supersedes_id`. Superseded records stay
   readable (traceable).

## Source-of-truth conflicts

`source_conflict` records a field-level disagreement between two systems
(`conflict_key`, systems, record refs, values). Resolution
(`POST /api/source-conflicts/:id/resolve`, human-only) appends a
`source_resolution_decision` (winning source + rationale + decider) — append-only by
database trigger — and marks the conflict `RESOLVED` with resolver identity.

## Documents: R2/D1 split (§9.1)

Binary content goes to the R2 binding `WP_OS_DOCUMENTS`; D1 holds metadata and
provenance only. Upload is **base64 JSON** (`POST /api/documents` with
`content_base64`; 5 MiB decoded cap) — the API is JSON-first and this keeps upload
exercisable from tests and e2e without multipart parsing. Each upload stores the R2
object and a `document_version` row with the SHA-256 of the bytes; downloads
(`GET /api/documents/:id/download`, authenticated, privacy-filtered) return the
bytes with an `x-content-sha256` integrity header. Versions are immutable
(trigger); new content is a new version.

**Degraded mode (§3.5):** when the R2 binding is absent, upload/download/extract
fail visibly with 503 `documents_degraded` — never silently.

## Quarantine interaction (P4)

Two quarantines compose: external-provider run outputs are quarantined in
`ai_run.output_text` until a human accept (P4), and extracted claim candidates are
quarantined as `AI_INFERRED` until a human accept with a qualifying source (P5).
Neither quarantine can be lifted by an AI actor, and neither lifts the other.
