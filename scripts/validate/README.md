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
- `a-guide-names-what-the-page-emits.mjs` (`npm run validate:page-guides`, 19 Sep 2026) — every
  page guide in `src/shared/help/pageGuide/` describes the page as it renders today, and nothing
  else. Against the comment-stripped source of the components each guide names: every band and act
  testid is one the page emits, every act label is verbatim on the page, every primary control
  (`btn-strong` / `btn-primary` with a testid) is one of the guide's acts or in `notActs` with a
  reason, every `elsewhere` link is a route App.tsx renders, every `auto.job` is a `job_key` some
  migration writes, the rendered answer carries every act in bold as a numbered band list and
  bulleted acts (never a paragraph), and the retired Meetings trio ("Prepare for a meeting ·
  Confer with an AI employee · Run a close-out") may not return to `pagePurpose.ts` or the Help
  tab. Hard-fails on zero guides, files or acts. `--self-test` restores 19 Sep's stale Meetings
  text as a guide against the real Meetings sources and proves it is caught, plus a missing
  primary act, a ghost testid, a link to no page, a job no migration writes, a missing file, and a
  paragraph-shaped answer.
