# West Peek OS — Repo-Local Agent Authority

This file is repo-local written authority for any agent working inside `west-peek-os/`.
It is subordinate to, and implements, the approved consolidated plan:
`../../TASK/APPROVED_TASK.md` (P0–P12 authorized; P13+ deferred).

Parent authorities (IMMUTABLE — never modify, move, or rewrite):

- `../WEST_PEEK_OS_v3_2_14_CANONICAL_MASTER_PLAN.md` — canonical product law (frozen to errata, D11).
- `../WEST_PEEK_OS_ODYSSEUS_AUDIT_AND_IMPLEMENTATION_PLAN_v1_11.md` — cumulative implementation translation.

## Governing law

> AI prepares the decision. The Managing Partners and authorized humans make the decision.

- One authorization choke point: `authorize(actor, action, object, context)` → `ALLOW | REQUIRE_APPROVAL | DENY`.
  Every external effect and every human-reserved action passes through it. No exceptions.
- One governed AI boundary: `run_ai(...)`. No direct provider SDK/API call may exist outside provider adapters.
- One append-only typed event spine feeds Activity, Audit, and Diagnostics (D15).
- One evidence/provenance substrate for claims, contradictions, promotion, source resolution (D16).
- CanonicalCompany-first entity model (D3). No parallel company-shaped pipeline entities.
- Odysseus is reference-only (D2). Never import, fork, or depend on it.
- TypeScript + React/Vite + Cloudflare (Workers/Pages, D1, R2, KV-only-for-ephemeral) + Playwright (D1).
- 45 machines, seeded from ONE versioned registry source (`src/shared/registry/machines.ts`), tested from that source (D14).
- A Managing Partner name may never be an AI employee (D10). MPs: Scooter Taylor, Sequoia Taylor.
- Silence is never approval. Approval target ≤15 human cards/day steady-state (D7).
- Privacy modes: `LOCAL | FRONTIER | LOCKDOWN` (D8). Cost modes: `NORMAL | CHEAPO | CRITICAL_ONLY | STRATEGIC_SURGE`.
- Fail closed for authority, privacy, egress, external effects. Degrade gracefully for AI convenience features.
- Secrets live ONLY in the encrypted vault at `~/.west-peek-os/vault/` (see `scripts/vault/`). Never in this repo,
  logs, artifacts, or receipts. `.env.example` / `docs/ENVIRONMENT_CONTRACT.md` are names-only.

## Layout

- `src/worker/` — Cloudflare Worker API (entry `index.ts`). All server behavior.
- `src/client/` — React/Vite UI (built to `dist/client`).
- `src/shared/` — types, enums, registry reference data shared by worker/client/tests.
- `migrations/` — D1 migrations `0001_…` … `0012_…` per approved plan §9.2. Additive-first.
- `tests/` — vitest unit/integration (miniflare local D1; no credentials needed).
- `e2e/` — Playwright browser tests against local `wrangler dev`.
- `scripts/` — vault, backup/restore, validation, packaging helpers.
- `docs/` — ENVIRONMENT_CONTRACT, RECOVERY, adapter contracts, phase notes.

## Commands

- `npm run typecheck` — strict TS, must be green.
- `npm test` — vitest unit/integration, must be green.
- `npm run e2e` — Playwright (starts local wrangler dev server; no credentials).
- `npm run migrate:local` — apply D1 migrations to local miniflare sqlite.
- `npm run backup:local` / `npm run restore:local` — D1 export/restore proof path.
- `npm run vault:*` — encrypted secret vault operations (values never printed).
- `npm run validate:authority` / `validate:ai-boundary` / `validate:network-boundary` — static boundary
  scans plus their own self-tests and seed-freshness checks.

The e2e suite runs on ONE worker (`playwright.config.ts`): every spec drives the same local D1, so the
isolation boundary is the database, not the file. If specs interleave, journeys corrupt each other's
state. A stale local D1 also fails specs that assume a clean firm — `rm -rf .wrangler` before a full run.

## Validation honesty

- Never claim a test/proof ran when it did not. Never weaken a valid failing test to force green.
- Label every provider/external layer PROVEN or UNPROVEN accurately in `IMPLEMENTATION_LEDGER.md`.
- Forbidden test claims: legal/securities compliance, MNPI sufficiency, LP-marketing permissibility,
  valuation/investment/accounting/fund-performance correctness (approved plan §12.4).
- A financial formula enters the system only with independent hand-worked verification
  (`docs/DEAL_MATH_VERIFICATION.md`, `docs/ALLOCATION_VERIFICATION.md`). Writing that verification is
  engineering work; **accepting** it is the operator's, and until they do, live use stays gated (§7.2).
- Remote Cloudflare deployment, live AI providers, Network OS writeback, email/calendar scopes,
  VDR, and fund-admin sources are UNPROVEN until separately gated and actually exercised.

## Change rules for agents

- Keep changes minimal and scoped to the active phase. Update `IMPLEMENTATION_LEDGER.md` after each phase.
- Record canon deviations as ADRs in `ARCHITECTURAL_DECISIONS.md` (canon stays frozen).
- Do not add dependencies without checking existing usage first; prefer Node/Worker built-ins.
- Do not add Cloudflare products (Durable Objects, Vectorize, Queues…) without a real requirement.
