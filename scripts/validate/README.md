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
- `every-company-is-in-the-pipeline.mjs` (`npm run validate:companies-in-pipeline`, 18 Sep 2026) —
  every company in the system is at the top of the funnel the moment it arrives, whichever door it
  came through; the human act is the decision, not the admission. Reads the route table for any
  switch that could let a route skip the pipeline, the door's return type for a nullable
  opportunity, the exactly-one-per-route pin in `tests/dealIntake.test.ts`, the Companies page for
  the calm "Not in the pipeline" label, and migration 0197's backfill shape. `--self-test` runs the
  real pre-fix shapes (the `opensRecord` switch, the nullable return, the calm label) through it.
- `an-archived-lane-stays-archived.mjs` (`npm run validate:weekly-review-archived`, 18 Sep 2026) —
  the weekly MP review is archived: its job `weekly_mp_review` is RETIRED and no migration or seed
  after 0198 may set it ACTIVE or PAUSED again; the nav does not list it; the tick cannot reach the
  generator; the finished-work shelf hides the kind by default. Hard-fails if it examines zero
  jobs. `--self-test` runs a re-enabling migration and a restored nav item through it.
