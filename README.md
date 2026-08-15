# West Peek OS — Repo-Local Agent Authority

This file is repo-local written authority for any agent working inside `west-peek-os/`.
It is subordinate to, and implements, the approved task at `../../TASK/APPROVED_TASK.md`.
P0–P12 built the governed substrate; the approved continuation task (2026-08-12) authorized
**P13–P25**, which built the operating product on top of it. Both are implemented — see
`IMPLEMENTATION_LEDGER.md` and `docs/WEST_PEEK_BLUEPRINT_COMPLIANCE_LEDGER.md`.
Everything in §17 of that task (Productions, sponsorship, Market Intelligence Academy, external
agent runtimes, self-modification, automatic capital/banking/legal action, mass workforce
activation) remains OUT of scope and unbuilt.

Parent authorities (IMMUTABLE — never modify, move, or rewrite):

- `../WEST_PEEK_OS_v3_2_14_CANONICAL_MASTER_PLAN.md` — canonical product law (frozen to errata, D11).
- `../WEST_PEEK_OS_ODYSSEUS_AUDIT_AND_IMPLEMENTATION_PLAN_v1_11.md` — cumulative implementation translation.
- `WEST_PEEK_BRAND_SYSTEM.md` — the West Peek family brand contract, marked CANONICAL / LOCKED.
  Byte-identical to the copy every other West Peek repo carries. Changing the canonical orange,
  the parent-logo treatment, or the black/white-first rule requires owner approval **and** the same
  change in every West Peek repo. Do not edit it locally.

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
- `migrations/` — D1 migrations `0001_…` … `0023_…`. Additive-first; applied migrations are never
  rewritten. **firm_scope lives on the aggregate ROOT** (`intelligence_run`, `work_packet`,
  `scheduled_job`, `notification`, `research_project`, `capability`, `connector`, `admin_source`,
  `lp_engagement`, …); child rows inherit it through their foreign key rather than duplicating it,
  so a scope can never disagree with itself. New action-type keys go in the TS registry, are emitted into the `0003` generated seed
  block by `scripts/seed/generate-machine-seed.mjs`, AND are repeated as compensating
  `INSERT OR IGNORE` in the new phase migration (the P4 convention).
- `tests/` — vitest unit/integration (miniflare local D1; no credentials needed).
- `e2e/` — Playwright browser tests against local `wrangler dev`.
- `scripts/` — vault, backup/restore, validation, e2e preparation, packaging helpers.
- `docs/` — ENVIRONMENT_CONTRACT, RECOVERY, adapter contracts, phase notes, and the design system.
- `src/client/styles.css` — the design system. Its `:root` block is the ONLY place a colour, type
  size, space, radius, duration, or easing is declared. Components consume `var(--wp-*)` tokens and
  never declare colour; `npm run validate:brand` fails the build if they do. Read
  `docs/WEST_PEEK_DESIGN_SYSTEM.md` before changing any UI, and
  `docs/WEST_PEEK_DESIGN_REFERENCE_AUDIT.md` for why each rule exists.

## Commands

- `npm run typecheck` — strict TS, must be green.
- `npm test` — vitest unit/integration, must be green.
- `npm run e2e` — Playwright (resets the local D1, then starts its own `wrangler dev`; no
  credentials). Safe to re-run back to back; that is a hard requirement, not a nicety.
- `npm run migrate:local` — apply D1 migrations to local miniflare sqlite.
- `npm run backup:local` / `npm run restore:local` — D1 export/restore proof path.
- `npm run vault:*` — encrypted secret vault operations (values never printed).
- `npm run validate:brand` — West Peek brand-system scan plus its 9-fixture self-test: the authority
  document is intact, colour is declared only in the token block, no stale orange, no blue/purple/cyan
  product colour, and the approved mark is wired into the shell. The family convention — every other
  West Peek repo ships the same scan.
- `npm run validate:authority` / `validate:ai-boundary` / `validate:network-boundary` — static boundary
  scans plus their own self-tests and seed-freshness checks. If a scan legitimately needs narrowing,
  narrow it precisely AND add a self-test fixture proving it still catches what it exists to catch
  (see the two P16 refinements in `IMPLEMENTATION_LEDGER.md`).
- Scheduling: ONE Cloudflare Cron Trigger calls the Worker's `scheduled()` handler (ADR-017). A
  trigger cannot fire in local `wrangler dev`, so the same path is reachable at `POST /api/jobs/tick`
  and is called directly in tests. Remote firing is UNPROVEN until deployment.

`vitest.config.ts` caps `maxWorkers` at 4: each suite stands up its own miniflare instance and binds
a port, and past ~8 in flight the machine runs out of ephemeral ports (EADDRNOTAVAIL — a resource
limit, not a test failure).

`e2e/d1-design-states.spec.ts` is the design system's own regression suite: it measures hover
contrast, the focus ring, and the rule that no surface may render an ambiguous blank for a reader
who lacks the authority to act on it. It provisions its own low-authority identity — read it before
changing `styles.css`, an empty state, or a reserved control.

Below 900px the primary nav is a sheet behind `data-testid="nav-toggle"`, so a Playwright spec that
drives navigation at a phone width must go through `e2e/support/nav.ts` (`gotoSurface` /
`openNavIfCollapsed`) rather than clicking a nav button directly. At laptop widths the rail is always
on screen and every existing selector resolves unchanged.

The e2e suite runs on ONE worker (`playwright.config.ts`): every spec drives the same local D1, so the
isolation boundary is the database, not the file. If specs interleave, journeys corrupt each other's
state.

Several journeys also assume a **clean firm**. That precondition used to be a manual instruction here
("`rm -rf .wrangler` before a full run"), which left `npm run e2e` non-idempotent: running it twice in
a row failed six specs the second time, with assertion errors that look like product defects and are
not. The precondition is now part of the command — `scripts/e2e/prepare-local.mjs` stops any stale
listener on the e2e port and deletes the local D1 before Playwright starts, and
`reuseExistingServer` is `false` so the suite can never attach to a server holding the database it
just reset or serving an older build. Do not re-introduce the manual step, and do not set
`reuseExistingServer` back to true. Override the port with `WPOS_E2E_PORT` if 8787 is taken.

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
