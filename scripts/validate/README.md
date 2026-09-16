# scripts/validate

Static validation scans, wired to npm scripts. Each must FAIL loudly (exit 1, named
violations) on breach and proves its own detection with a self-test fixture run.

- `no-unauthorized-effects.mjs` (P3, `npm run validate:authority`) — proves (a) only
  `src/worker/effects/executor.ts` performs external-effect execution (no other worker
  file marks `external_effect_request` EXECUTED; no outbound fetch to non-localhost
  anywhere in worker code) and (b) merge/reverse + executor call sites route through
  `authorize()` and consume receipts. `--self-test` feeds synthetic violating sources
  through the same checks and asserts they are caught. The npm script also runs the
  seed generator's `--check` (registry-seed freshness) — see `scripts/seed/`.
- `partner-email-boundary.mjs` (`npm run validate:partner-email`, 16 Sep 2026) — every email
  an employee sends a partner leaves through `src/worker/services/execEmail.ts`, which lays it
  out in the busy-executive format (TL;DR first, labelled sections as bullets, the details
  under a rule, the employee's footer) and lints it before any transport sees it. A transport
  (`sendViaResend`, `sendViaCloudflare`, `sendViaGmail`) called from any other service file
  fails the build; so does a door that forgets to lint or one that nothing calls. `--self-test`
  runs the real defect — a service composing prose and calling the transport itself — through
  the same check.
