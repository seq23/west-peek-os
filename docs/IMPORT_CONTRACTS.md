# Import Contracts (P2) — Contracts Only, No Live Import

`src/worker/import/contracts.ts` defines the **typed payload contracts** for two future
imports. These are contracts and dry-run reporting ONLY.

> **A live, destructive import requires explicit human approval** (approved plan §P2;
> ledger keeps the live-import gate noted as NOT RUN). No code path in this repo
> executes one.

## Contracts

### (a) Network OS person/contact reference import — `kind: "network_os_person"`

Network OS stays authoritative for relationship records (D5). This import creates
**firm-side reference rows only** (`person`); it never writes back to Network OS and
never becomes the relationship system of record.

```json
{
  "kind": "network_os_person",
  "records": [
    {
      "source_system": "network_os",
      "external_key": "nos-contact-123",
      "full_name": "Ada Founder",
      "email": "ada@example.com",
      "organization": "Acme Corp",
      "title": "CEO",
      "privacy_label": "INTERNAL"
    }
  ]
}
```

Required per record: `source_system` (literal `"network_os"`), `external_key`,
`full_name`. Optional: `email`, `organization`, `title`, `privacy_label` (§11.3 enum).

### (b) VentureDeals/secondaries opportunity import — `kind: "venturedeals_opportunity"`

Company references resolve against the canonical identity substrate (docs/IDENTITY_MODEL.md);
**opportunity objects themselves are P6 scope** and are not created by this contract.

```json
{
  "kind": "venturedeals_opportunity",
  "records": [
    {
      "source_system": "venturedeals",
      "external_key": "vd-opp-456",
      "company": {
        "canonical_name": "Acme Corp",
        "legal_name": "Acme Corporation, Inc.",
        "website": "acme.example.com",
        "aliases": ["Acme"],
        "external_identities": [{ "system": "venturedeals", "external_key": "vd-co-1" }]
      },
      "opportunity": {
        "name": "Series B secondary block",
        "opportunity_type": "SECONDARY",
        "source": "broker-x",
        "received_at": "2026-08-01",
        "notes": "free text"
      }
    }
  ]
}
```

Required per record: `source_system` (literal `"venturedeals"`), `external_key`,
`company.canonical_name`, `opportunity.name`, `opportunity.opportunity_type`
(`EARLY_STAGE | FOLLOW_ON | SECONDARY`).

## Dry-run endpoint

`POST /api/import/dry-run` (authenticated) validates the payload against the contract
and reports, per record, what **WOULD** happen:

- `would_create` — no conflict found;
- `conflict` — the record resolves to an existing row (person by email; company by
  external identity → canonical name → alias, in that order), with `existing_id`.

**It persists nothing** — no company, person, alias, or event rows are written
(asserted in `tests/import.test.ts` by row-count comparison). Invalid payloads are 400.

## Path to live import (gated)

Executing a real import against these contracts is a future, separately approved action:
it requires explicit human approval, will route through `authorize()` (P3), and will be
recorded in the event spine with full per-record outcomes.

---

# Fund-Administrator Export Contract (P12)

`ADMINISTRATOR_EXPORT_CONTRACT_VERSION = "wpos-fundadmin-export-1.0.0"`
(`src/worker/services/reporting.ts`).

The approved plan requires the **reconciliation import contract first** (§6, P12 row). This is
that contract. It is deliberately minimal, because the shape that matters is not ours: the real
administrator's export format is an unresolved decision (§6), and a contract that guessed at it
would have to be rewritten the moment a real one arrived.

## Direction and authority

**Read-only, one way, always.** The administrator/accountant is authoritative for their domain.
West Peek OS imports their figures as evidence and has **no code path that writes to an
administrator or accounting system**. `reconciliation.run_completed` records
`administrator_records_written: 0` on every run.

## Payload

`POST /api/reconciliation/runs` (authenticated, human actor only):

```json
{
  "fund_id": "fnd_...",
  "period_id": "lrp_...",
  "source_system": "example_fund_administrator",
  "source_reference": "Q1-2026 statement export",
  "administrator_records": [
    { "record_kind": "NAV", "record_key": "fund", "field": "nav", "value": "31500000" }
  ],
  "internal_records": [
    { "record_kind": "NAV", "record_key": "fund", "field": "nav", "value": "31000000" }
  ]
}
```

- `record_kind`: `POSITION | CAPITAL_ACCOUNT | DISTRIBUTION | CAPITAL_CALL | NAV | OTHER`.
- `record_key`: the **administrator's** stable key for the record, not ours.
- `value`: a **string**, always. Numbers are not coerced on the way in — a figure that arrives as
  `"1,250,000.00"` must not silently become `1250000` before a human has seen the difference.
  Comparison parses numerically only when both sides parse finitely, and reports no difference
  rather than a misleading `0` when they do not.

Records are matched on `(record_kind, record_key, field)`. Each mismatch becomes one
`fund_reconciliation_exception`:

| Situation | `exception_kind` |
|---|---|
| Both sides present, values differ | `VALUE_MISMATCH` (with signed `difference` = internal − administrator when numeric) |
| Administrator reported it, we have nothing | `MISSING_INTERNAL` |
| We have it, the administrator did not report it | `MISSING_ADMINISTRATOR` |

Identical values raise nothing.

## What a resolution may and may not do

A resolution records a human disposition and moves the exception's `status`. It **cannot** change
either recorded value: a database trigger rejects any UPDATE touching `administrator_value`,
`internal_value`, `record_key`, `field`, `run_id`, or `exception_kind`, for every actor including a
Managing Partner and including direct SQL.

| Resolution | Changes an official figure? | Reserved receipt required |
|---|---|---|
| `ACCEPT_ADMINISTRATOR` | yes (our books move to theirs) | `official_valuation_or_capital_account.change` |
| `CORRECT_INTERNAL` | yes | `official_valuation_or_capital_account.change` |
| `ESCALATE_TO_ADMINISTRATOR` | no | none |
| `NO_ACTION` | no | none |

## Gate

Every run is stamped `source_mode = 'LOCAL_FIXTURE'`. **Live reconciliation is
`UNPROVEN — FUND-ADMIN SOURCE CONTRACT GATE`**: no real administrator system has been read, no
export format has been agreed, and the plan requires a real source contract plus human
authorization before one is (§7.2, §6). Nothing in this contract certifies accounting correctness.
