# Repo Validation Matrix — West Peek OS

What each check proves — and what it does not prove. Run order matters; all run locally without credentials.

| Command | Proves | Does NOT prove |
|---|---|---|
| `npm run typecheck` | strict TS compiles across worker/client/shared/tests | runtime behavior |
| `npm test` | unit + integration behavior against local miniflare D1 (schema, services, authority rules, state machines, calculations with verified fixtures) | live Cloudflare, live providers, legal/compliance correctness |
| `npm run e2e` | real-browser journeys against local `wrangler dev` (auth denial, capture → work card → approval → audit, and later-phase journeys) | deployed-environment behavior |
| `npm run migrate:local` | migrations apply cleanly, in order, to a fresh local D1 | remote D1 |
| `npm run backup:local` + `restore:local` | export → wipe → restore → seeded record readable, with every append-only trigger re-created and counted back (ADR-015) | offsite/disaster recovery |
| `npm run vault:doctor` | vault encryption round-trip + Keychain key custody on this machine, without exposing values | any secret's actual presence/correctness |
| `scripts/validate/no-direct-provider-calls` (P4) | no provider SDK/HTTP call exists outside provider adapters | provider success |
| `scripts/validate/no-unauthorized-effects` (P3) | external-effect call sites route through `authorize()` | — |
| `scripts/validate/no-cross-repo-coupling` (P9) | no partner-repo paths, foreign bindings, or Network OS hosts outside the declared adapter | live Network OS behavior |

## Phase proof mapping (approved plan §12.2)

P0 structural checks · P1 typecheck/build, auth E2E, migration, backup-restore · P2 identity
duplicate/merge/split/policy-version tests · P3 adversarial authority suite + browser E2E ·
P4 provider-boundary scan, egress, budget, kill-switch · P5 contradiction/supersession/source tests ·
P6 identity/diligence/secondary/IC tests + verified calc fixtures · P7 consent/promotion/follow-up ·
P8 delta/stale/severity/support-gate · P9 conflict/idempotency/degradation/writeback-audit ·
P10 claim-block + access/revocation · P11 constraint/policy-version + formula verification ·
P12 review gates + exception/no-overwrite.

## Formula verification is not formula acceptance

`docs/DEAL_MATH_VERIFICATION.md` (P6) and `docs/ALLOCATION_VERIFICATION.md` (P11) are **engineering**
verification: each formula restated from first principles, hand-worked, and encoded as fixtures. The
approved plan's §7.2 gate is the *operator or a designated reviewer accepting* that verification. That
acceptance has not happened, so no live allocation use is authorized regardless of test results.

## Forbidden claims (approved plan §12.4)

No test here may be described as proving: securities-law compliance, brokerage/fund legal sufficiency,
MNPI treatment, permissible LP marketing, valuation correctness, investment soundness, accounting
correctness, or fund performance correctness.
