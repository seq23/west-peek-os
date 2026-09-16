# Repo Validation Matrix — West Peek OS

What each check proves — and what it does not prove. Run order matters; all run locally without
credentials except `validate:value-shapes`, noted below.

| Command | Proves | Does NOT prove |
|---|---|---|
| `npm run typecheck` | strict TS compiles across worker/client/shared/tests | runtime behavior |
| `npm test` | unit + integration behavior against local miniflare D1 (schema, services, authority rules, state machines, calculations with verified fixtures) | live Cloudflare, live providers, legal/compliance correctness |
| `npm run e2e` | real-browser journeys against local `wrangler dev` (auth denial, capture → work card → approval → audit, and later-phase journeys), from an empty firm every time — the command resets the local D1 itself and is safe to re-run back to back | deployed-environment behavior |
| `npm run migrate:local` | migrations apply cleanly, in order, to a fresh local D1 | remote D1 |
| `npm run backup:local` + `restore:local` | export → wipe → restore → seeded record readable, with every append-only trigger re-created and counted back (ADR-015) | offsite/disaster recovery |
| `npm run vault:doctor` | vault encryption round-trip + Keychain key custody on this machine, without exposing values | any secret's actual presence/correctness |
| `scripts/validate/no-direct-provider-calls` (P4) | no provider SDK/HTTP call exists outside provider adapters | provider success |
| `scripts/validate/no-unauthorized-effects` (P3) | external-effect call sites route through `authorize()` | — |
| `scripts/validate/no-cross-repo-coupling` (P9) | no partner-repo paths, foreign bindings, or Network OS hosts outside the declared adapter | live Network OS behavior |
| `npm run validate:brand` (D2) | the West Peek brand authority is intact, colour is declared only in the `:root` token block, no stale orange, no blue/purple/cyan product colour, and the approved mark is wired into the shell — with a 9-fixture self-test | that the result looks good, or that it meets WCAG. Visual quality and accessibility are measured in a browser, not by this scan |
| `npm run validate:design-tokens` | every font-size, spacing value, border-radius and line-height in `styles.css` is on the scale the token block declares, and no component sets two adjacent type steps on text of the same register — with a 12-fixture self-test | that a component's chosen step is the RIGHT one, only that it is ON-scale |
| `npm run validate:css-classes` | every `className` used in `src/client` has a rule in `styles.css`, and the stylesheet's braces balance — with an 8-fixture self-test | that a defined rule renders correctly, only that it exists |
| `npm run validate:partner-email` | every email an employee sends a partner leaves through `src/worker/services/execEmail.ts`, which lays it out (TL;DR, labelled bullets, details under a rule, footer) and lints it before any transport sees it; a transport called from any other service file, a door that forgets to lint, or a door nothing calls all fail — with a 7-fixture self-test including the real defect | that the email is good, only that it is in the shape; the content rules are `tests/execEmail.test.ts` |
| `npm run validate:sql` | every statement in `src/worker` parses (via `EXPLAIN`) against the schema the migrations build, in an in-memory `node:sqlite` database — local only since 22 Aug 2026, no credentials, no network — with a 5-fixture self-test covering the three bugs that prompted it | that a statement returns the right ROWS, or that the migrations match what is actually deployed |
| `npm run validate:value-shapes` | **needs production credentials (`wrangler` auth) and reads live `WP_OS_DB` over the network** — TS constants against their column's CHECK constraint, SQL literals against the owning table, orphaned foreign-key references, and pinned polymorphic references, all against the real production schema and data | that a value is semantically correct, only that it is shaped like what its column and its references declare. Stays an operator-run pre-deploy check (`docs/DEPLOYING.md`), not part of CI — the same reason `npm run deploy:production` itself is never run from CI (`BACKLOG.md`, "There is exactly ONE deploy path") |

## Phase proof mapping (approved plan §12.2)

P0 structural checks · P1 typecheck/build, auth E2E, migration, backup-restore · P2 identity
duplicate/merge/split/policy-version tests · P3 adversarial authority suite + browser E2E ·
P4 provider-boundary scan, egress, budget, kill-switch · P5 contradiction/supersession/source tests ·
P6 identity/diligence/secondary/IC tests + verified calc fixtures · P7 consent/promotion/follow-up ·
P8 delta/stale/severity/support-gate · P9 conflict/idempotency/degradation/writeback-audit ·
P10 claim-block + access/revocation · P11 constraint/policy-version + formula verification ·
P12 review gates + exception/no-overwrite.

**P13–P25 continuation (approved 2026-08-12).** P13 verification-only ledger · P14 relevance
determinism, dedupe, idempotent runs, citation-mandatory items, quarantine-respecting synthesis,
owner-only personal layer · P15 activation-law preservation, referenced-only collaboration,
deterministic scorecards · P16 credential-presence-not-values, pricing provenance, routing
explanation, policy-gated fallback, scoped-budget blocks · P17 pause enforced in BOTH the routing
service and the AI boundary, maturity separate from tested state · P18 immutable original text,
no chain-of-thought column, blocking lens gate · P19 refusal-vs-failure, occurrence idempotency,
dead-letter · P20 in-app floor with push recorded UNAVAILABLE, quiet hours hold delivery not the
record, service worker never caches `/api/*` · P21 promotion is the only path from research to
evidence · P22 connectors are configuration with LOCAL_FIXTURE checks · P23 specialist vendor is a
provider behind `run_ai()` with no conclusion column · P24 administrator source cannot be declared
LIVE by hand · P25 cockpit trends match P8's comparison, allocation view recomputes nothing, ten MP
questions answered, nine cross-system journeys.

## What the continuation's own checks add

| Command | Proves | Does NOT prove |
|---|---|---|
| `npx vitest run` (26 suites, 506 tests) | every rule above, against local miniflare D1 | anything external |
| `npx playwright test` (21 specs, 45 tests) | the operator journeys in a real browser, including 9 cross-system journeys and a 390×844 mobile pass | a physical device, an installed PWA, or a delivered push |
| `POST /api/jobs/tick` | the scheduled-work code path end to end | that Cloudflare's cron trigger fired it |
| connector / provider `check` routes | configuration coherence, stamped LOCAL_FIXTURE | that any external system is reachable |

## Formula verification is not formula acceptance

`docs/DEAL_MATH_VERIFICATION.md` (P6) and `docs/ALLOCATION_VERIFICATION.md` (P11) are **engineering**
verification: each formula restated from first principles, hand-worked, and encoded as fixtures. The
approved plan's §7.2 gate is the *operator or a designated reviewer accepting* that verification. That
acceptance has not happened, so no live allocation use is authorized regardless of test results.

## Forbidden claims (approved plan §12.4)

No test here may be described as proving: securities-law compliance, brokerage/fund legal sufficiency,
MNPI treatment, permissible LP marketing, valuation correctness, investment soundness, accounting
correctness, or fund performance correctness.

**D1–D5 design overhaul (approved 2026-08-13).** Visual/interaction only, over the preserved P0–P25
baseline. What the design work proves and does not prove:

| Evidence | Proves | Does NOT prove |
|---|---|---|
| `run_hallmark_audit.sh` pre- and post-build packs | the user's installed Hallmark authority was pinned by SHA-256 and applied, over a read-only mirror, with browser capture | that Hallmark reviewed anything — the runner's own truth boundary says it prepares evidence only |
| Browser measurement over 29 surfaces × 3 viewports | 0 horizontal overflow · 0 text nodes below WCAG AA for their size · 1 target below 44px (a checkbox inside its 44px label) · a 2px orange focus ring at every tab stop walked | WCAG conformance. No assistive technology, screen reader, 400% zoom, or colour-vision simulation was used |
| vitest 513/513 · Playwright 45/45 · four boundary validators | every governed behaviour, route, contract, and authority rule survived the overhaul unchanged | anything about deployed behaviour |
| diff against a pre-overhaul mirror | `src/worker/`, `src/shared/`, `migrations/`, and `tests/` are byte-identical — the overhaul touched no backend, no schema, and no product capability | — |
| `e2e/d1-design-states.spec.ts` (generation-2 review) | hover contrast on the one orange action, the focus ring's colour and instant paint, the blocked-decision reason, and that no surface renders an ambiguous blank for a low-authority reader — each verified by reverting its fix | that every surface is well designed; it locks three specific rules, not taste |

