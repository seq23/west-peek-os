# Identity Model — CanonicalCompany-First (P2)

Canon D3: the **CanonicalCompany** is the single company-shaped entity. No parallel
company-shaped pipeline entities exist or may be created. This document is the
authoritative statement of the P2 identity rules; enforcement lives in
`migrations/0002_company_fund_policy.sql` and `src/worker/services/companies.ts`.

## Core rules

1. **One canonical identity per real-world company.** The same issuer may carry many
   opportunities, transactions, and blocks over time — all attach to the one
   `canonical_company` row. (Opportunity/transaction objects themselves arrive in P6.)
2. **Share classes, sellers, and blocks stay distinct.** They are never collapsed into
   the company or into each other. Those objects arrive in P6; the identity substrate
   here is designed so they reference the canonical company without merging economics.
3. **Aliases never create companies.** A `company_alias` row only resolves a name string
   to an existing canonical company (`GET /api/companies/resolve?name=…`). Adding an
   alias is an insert into `company_alias` only — company count is unchanged, and tests
   assert this.
4. **Affiliated legal entities stay separate.** `fund_entity` rows (LP, GP, management
   company, SPVs) and similarly-named companies (e.g. "Acme Holdings LLC" vs
   "Acme Holdings Inc") remain distinct rows. No dedup logic collapses them.
5. **External identities are dedup anchors, not creators.** `company_external_identity`
   has `UNIQUE(system, external_key)`; a second attempt to use the same pair is a
   duplicate (409), never a second company.
6. **Merge requires a human.** Merge is a Managing-Partner-reserved action
   (`identity_merge.execute` in the reserved-action register). Since P3, both merge and
   reversal route through the `authorize()` choke point: execution requires an approved
   approval card matching action + object (source company for merge, merge receipt for
   reversal — ADR-009), and execution consumes the card so it cannot be replayed.
   Non-MP actors receive 403; an MP without a receipt receives 409 `approval_required`
   (see `docs/AUTHORITY_MODEL.md`).
7. **Merge never deletes.** The source company is retired (`status='MERGED'`); all row
   history is preserved.
8. **Reversal restores provenance.** `identity_merge_receipt` captures every moved
   reference (`table, row_id, column, old_value, new_value`) plus a full pre-merge
   snapshot and its SHA-256 hash. `POST /api/identity/merges/:receiptId/reverse`
   verifies each moved reference still sits at its post-merge value, replays the receipt
   to restore exact pre-merge state (including the source company's status and
   `updated_at`), and writes an `identity_split_receipt`. If any reference drifted since
   the merge — exact restoration cannot be proven — reversal **refuses** (409) and
   changes nothing. Tests deep-compare all affected rows before/after.

## Duplicate prevention (create-time, three entry points)

`POST /api/companies` rejects (409, with the existing company in the response) on:

- exact `canonical_name` match (case-insensitive, trimmed);
- exact alias match — the new name or any supplied alias colliding with an existing
  alias or canonical name;
- same `(system, external_key)` external identity.

## Identity resolution candidates

`identity_resolution_candidate` rows (PENDING → ACCEPTED/REJECTED) record suspected
duplicates with `match_basis` and `score`. **Accepting a candidate does NOT merge** —
it marks the review outcome only. Merge remains the separate human-reserved action.

## Person records

`person` is a **firm-side reference only**. Network OS stays authoritative for
relationship/contact/touch/Gmail records (D5); crossings are adapter-only (P9). Rows
here support `organization_relationship` links to canonical companies and import
dry-run conflict detection — they are never the relationship system of record.

## Privacy labels

Identity rows carry `privacy_label` from the §11.3 vocabulary
(`src/shared/privacy.ts`): `PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED, LP_PRIVATE,
MNPI_SENSITIVE, BANKING_RESTRICTED` (default `INTERNAL`). Labels gate provider/egress
handling in later phases (D8/D9); recording them now means sensitivity is never lost.

## Events

Material mutations append to the P1 `event_record` spine (D15) via
`src/worker/events.ts` (`appendEvent`): `identity.company_created`,
`identity.company_merged`, `identity.company_split`, `fund.created`,
`fund.entity_created`, `policy.version_created`. No second event system exists.
