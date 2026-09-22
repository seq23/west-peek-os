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
- `a-duty-has-an-executor.mjs` (`npm run validate:duty-executor`, 20 Sep 2026) — reads the local-job
  registry, the Mac claimer's allowlist, every `scripts/duties/*.mjs` header and the sweep's
  dispatch, and holds them to one list in both directions; hard-fails on zero kinds or scripts;
  `--self-test` plants a missing script, an unregistered duty, a claimer without the kind, a sweep
  without the dispatch, a prompt file without a phase and a script without `run()`.
- `a-switch-is-a-switch-on-both-sides.mjs` (`npm run validate:kind-rule-switches`, 22 Sep 2026) — a
  `work_kind_rule` row that is a switch is a switch in BOTH places that decide. The Work page and
  `handleSetWorkKindRule` each had `"land_on_green"` typed into them separately, so migration 0223's
  editable `done_reply_preview_first` would have rendered as a read-only badge while the API took any
  string for it. The scan requires `ON_OFF_RULE_KEYS` to live in `src/shared/work/localJobs.ts` (a
  worker-only home pushes the page back to a literal), both sides to read it and neither to compare a
  rule key to a literal, every key on the list to be seeded by some migration as `editable = 1` with
  an `on`/`off` value, and — the direction that actually bit — every editable on/off rule any
  migration seeds to be ON the list. Hard-fails on zero switches or zero seeded rules; `--self-test`
  runs 22 Sep's real page and route through it, plus a ghost switch, a dropped rule, a switch seeded
  uneditable, and the list moved out of shared.
- `only-the-script-sets-delivery-config.mjs` (`npm run validate:delivery-config`, 22 Sep 2026) — a
  Pages delivery variable (`EMAIL_FROM`, `LEAD_TO`, `RESEND_API_KEY`) on one of the three West Peek
  projects is set by the DUTY SCRIPT, never by the model and never by a partner. The model may only
  ask for one by name in its BUILD result (`pages_env: [{ project, name }]`). The scan holds the
  allow-list in `scripts/duties/lib/pages-delivery.mjs` to exactly those three projects and three
  variables, runs the real `classify`/`readRequests` over off-list projects, reserved names and
  empty strings and requires each to come back REFUSED AND RECORDED, requires the duty script to
  keep no second copy of a name, to feed the secret through `child.stdin` rather than an argument or
  a shell string, to build the proof only from what it observed, and to build the model's prompt
  without reading the environment — and requires the prompt file to tell Porter this is his, never a
  named stop, and that he may not claim config he did not set. It exists because on 22 Sep 2026
  Porter declared a named stop for a key in this repo's own vault AND reported two variables set
  that he had never touched. Hard-fails on zero projects, variables or checks; `--self-test` plants
  a fourth project, an open gate, a gate that drops refusals, a value on wrangler's command line, a
  value through a shell, a printed value, a second list, an inert BUILD step, a prompt builder that
  reads the environment, and the old named-stop prompt.
- `only-the-script-sets-delivery-config.mjs` (`npm run validate:delivery-config`, 22 Sep 2026) — a
  Pages delivery variable (`EMAIL_FROM`, `LEAD_TO`, `RESEND_API_KEY`) on one of the three West Peek
  projects is set by the DUTY SCRIPT, never by the model and never by a partner. The model may only
  ask for one by name in its BUILD result (`pages_env: [{ project, name }]`). The scan holds the
  allow-list in `scripts/duties/lib/pages-delivery.mjs` to exactly those three projects and three
  variables, runs the real `classify`/`readRequests` over off-list projects, reserved names and
  empty strings and requires each to come back REFUSED AND RECORDED, requires the duty script to
  keep no second copy of a name, to feed the secret through `child.stdin` rather than an argument or
  a shell string, to build the proof only from what it observed, and to build the model's prompt
  without reading the environment — and requires the prompt file to tell Porter this is his, never a
  named stop, and that he may not claim config he did not set. It exists because on 22 Sep 2026
  Porter declared a named stop for a key in this repo's own vault AND reported two variables set
  that he had never touched. Hard-fails on zero projects, variables or checks; `--self-test` plants
  a fourth project, an open gate, a gate that drops refusals, a value on wrangler's command line, a
  value through a shell, a printed value, a second list, an inert BUILD step, a prompt builder that
  reads the environment, and the old named-stop prompt.
- `no-land-without-approval.mjs` (`npm run validate:no-land-without-approval`, 20 Sep 2026) — reads the
  Worker's `parkPhase`, the Mac script's `landGate` and `run()`, and migration 0219's trigger and
  rule seed, and requires each to refuse a landing without a recorded plan approval and a recorded
  green check; `--self-test` removes each check in turn and requires the removal to be caught.
