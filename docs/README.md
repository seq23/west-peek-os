# Documentation index

Start with the [repository README](../README.md) — it covers running the app, the six rules that
will bite you, and how to add a feature. Everything here is reference for when you need depth on
one subject.

## What is not finished

[../BACKLOG.md](../BACKLOG.md) — every deferral, switched-off capability and API-without-a-UI, with
why. Read it before planning work; several items are a page away from done.

## The governance model

These four describe how the system decides what is allowed. Read them in this order if you are new;
most surprising behaviour in the codebase traces back to one of them.

| | |
|---|---|
| [AUTHORITY_MODEL.md](AUTHORITY_MODEL.md) | Who may do what. Action keys, roles, receipts, and why an unknown key is denied rather than allowed. |
| [AI_GOVERNANCE.md](AI_GOVERNANCE.md) | Privacy modes, sensitivity labels, egress control, kill switches, the model ledger. |
| [EVIDENCE_MODEL.md](EVIDENCE_MODEL.md) | Claims and sources, and the structural ban on AI-sourced claims promoting themselves to verified. |
| [IDENTITY_MODEL.md](IDENTITY_MODEL.md) | Firm users, roles, AI employees, and the boundary between them. |

## Running it

| | |
|---|---|
| [ENVIRONMENTS.md](ENVIRONMENTS.md) | local / preview / production and how identity differs in each. |
| [ENVIRONMENT_CONTRACT.md](ENVIRONMENT_CONTRACT.md) | Every binding and secret, and what it is for. |
| [RECOVERY.md](RECOVERY.md) | Backup and restore. §6 is the production restore drill, proven against live data. |
| [PROVIDER_READINESS_AUDIT.md](PROVIDER_READINESS_AUDIT.md) | Which AI providers are configured, and what is still gated. |

## Domain reference

| | |
|---|---|
| [DEAL_MATH_VERIFICATION.md](DEAL_MATH_VERIFICATION.md) | Ownership, dilution and the arithmetic behind deal packets. |
| [ALLOCATION_VERIFICATION.md](ALLOCATION_VERIFICATION.md) | Cross-sleeve capital allocation. |
| [IMPORT_CONTRACTS.md](IMPORT_CONTRACTS.md) | Dry-run import contracts. Imports never persist on a first pass. |
| [WORKSHOPS.md](WORKSHOPS.md) | How the monthly Rooms and Workshops are planned: one topic a month with several angles on it, who sets the topic, adjacency, the cadence, the two emails, deciding by reply, and the plan on the record. Read by `tests/workshopsDocument.test.ts`. |
| [PARTNER_EMAIL_AND_BLOG_HELP.md](PARTNER_EMAIL_AND_BLOG_HELP.md) | The one shape every employee email to a partner takes, and how a blog ask becomes an outline, a draft or a phrase. |

## Design

| | |
|---|---|
| [WEST_PEEK_DESIGN_SYSTEM.md](WEST_PEEK_DESIGN_SYSTEM.md) | Tokens, spacing, components. |
| [../WEST_PEEK_BRAND_SYSTEM.md](../WEST_PEEK_BRAND_SYSTEM.md) | The brand rules the `validate:brand` scanner enforces. |
| [WEST_PEEK_DESIGN_REFERENCE_AUDIT.md](WEST_PEEK_DESIGN_REFERENCE_AUDIT.md) | Audit of the built surfaces against the design reference. |

## Build history

| | |
|---|---|
| [../IMPLEMENTATION_LEDGER.md](../IMPLEMENTATION_LEDGER.md) | What was built, phase by phase. |
| [../ARCHITECTURAL_DECISIONS.md](../ARCHITECTURAL_DECISIONS.md) | The D-numbered decisions the code cites — D15 for append-only, D16 for evidence, and the rest. |
| [WEST_PEEK_BLUEPRINT_COMPLIANCE_LEDGER.md](WEST_PEEK_BLUEPRINT_COMPLIANCE_LEDGER.md) | Canon section → implementation. |
| [WEST_PEEK_COMPLETION_BLUEPRINT_v2.md](WEST_PEEK_COMPLETION_BLUEPRINT_v2.md) | The completion blueprint. |
| [../REPO_VALIDATION_MATRIX.md](../REPO_VALIDATION_MATRIX.md) | What each validator checks. |
| [../ARTIFACT_MANIFEST.md](../ARTIFACT_MANIFEST.md) | Packaging manifest. |
| [../AGENTS.md](../AGENTS.md) | Conventions for agents working in this repo. |

---

**A note on citations.** Code comments reference the canonical plan by section — `§28.6`, `§12A.2`,
`canon §24.2`. Those are load-bearing. When a rule looks arbitrary, the citation is how you find out
why it exists before removing it. The plan lives one directory up as
`WEST_PEEK_OS_v3_2_14_CANONICAL_MASTER_PLAN.md`.
