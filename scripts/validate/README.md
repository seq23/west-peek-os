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
- `an-effect-cannot-refetch-itself.mjs` (`npm run validate:effect-refetch`, 22 Sep 2026) — a
  `useEffect` that WRITES may not depend on something a write changes the identity of. Wave F (#163)
  made every accepted mutation call `invalidateAll()` and every `useApi` subscribe to it — the right
  design — and that turned one pre-existing line in `App.tsx` into an unbounded loop:
  `const authed = me.status === 200 && me.data` evaluates to the `/api/me` RESPONSE BODY, not a
  boolean, and it was a dependency of the effect that POSTs `/api/mp-home/visited`. The POST
  invalidated everything, `me.data` came back as a new object, React saw a changed dependency, and
  the effect fired again — 182 writes for one page view, `useApi` holding `loading: true` throughout,
  so EVERY surface in the client sat on its loading text and never settled. Twenty-eight Playwright
  journeys red on `main` across employee lounge, fund strategy, notifications, duty roster and the
  design-state sweeps, none of which had changed. Nothing caught it because every part was correct
  alone; only the combination loops. The scan reads every `useEffect(..., [deps])` under `src/client`
  whose body calls `api(...)` with a non-GET method, and refuses a dependency that is a `useApi`
  response body (`x.data`) or a same-file alias for one whose initialiser mentions `.data` without
  coercing it (`Boolean(…)`, `!== null`, `.length`, a field read). A write keyed on a stable
  primitive — `HomePage.tsx`'s `[home.status]` — passes; the rule is about identity, not about
  writing from an effect. Hard-fails on zero client files or zero writing effects. `--self-test`
  runs the real 22 Sep line through it, plus a bare `me.data` dependency, a ternary alias, a writing
  effect with no dependency array, the shipped boolean form (must pass), `HomePage`'s real shape
  (must pass), a GET-only effect (not its business), and a commented-out copy of the old line.
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
- `no-land-without-approval.mjs` (`npm run validate:no-land-without-approval`, 20 Sep 2026) — reads the
  Worker's `parkPhase`, the Mac script's `landGate` and `run()`, and migration 0219's trigger and
  rule seed, and requires each to refuse a landing without a recorded plan approval and a recorded
  green check; `--self-test` removes each check in turn and requires the removal to be caught.
  Gate 15 (23 Sep 2026, migration 0241): after a hand-off only the card's CURRENT primary approves or
  forces — the 0241 triggers, the pure rules in `shared/work/partnerOwnership.ts` run against a handed
  card, the one writer of `secondary_partner_email`, the unblock button and the reply door.
- `one-employee-one-address.mjs` (`npm run validate:one-employee-one-address`, 22 Sep 2026) — one
  employee has ONE sending address and every path that puts bytes on the wire resolves it through
  the one resolver. It exists because on 22 Sep one card carried TWO senders on two domains in the
  same conversation: Porter's intake notice left as `os@westpeek.ventures` and his finished-work
  email as `Porter · West Peek <porter@joinwestpeek.com>`, which is two correspondents and two
  threads in the partner's mail client. The sibling scan `validate:employee-sender` was green
  throughout and correctly so — nothing was WRONG, something was MISSING: `transport()` in
  `services/execEmail.ts` never set `from` at all, so every employee message fell through to
  `sendViaResend`'s `env.WP_OS_EMAIL_FROM` fallback and signed as the firm. A scan looking for a
  wrong VALUE cannot see an absent KEY. So this one asserts the positive: every file that calls
  `sendViaResend`/`sendViaCloudflare` and is not itself a transport names a sender AND resolves it
  through `employeeSenderHeader()`/`employeeSenderAddress()`; `transport()`'s payload type REQUIRES
  `from: string` rather than accepting an optional one, and every `transport(env, { … })` call
  passes it; no `from` is a literal or an interpolation onto `joinwestpeek.com` or
  `westpeek.ventures` outside the registry (`os@joinwestpeek.com` as REPLY-TO stays legal — it is
  the mailbox the inbound door receives on); and one domain constant, one minting expression, no
  two roster names colliding once lowercased. Hard-fails on zero sources, zero roster names or zero
  send paths. `--self-test` plants thirteen defects including the real omitted-`from` shape, an
  optional `from`, one call of three dropping it, a sender that is named but not resolved, and both
  domains written out as literals.
- `a-kind-has-one-registry.mjs` (`npm run validate:card-kinds`, 22 Sep 2026) — there is exactly one
  list of the values `work_card.kind` can hold, and it is `src/shared/work/cardKinds.ts`. `kind`
  decides which runner the sweep hands a card to; before this its nine values existed only as string
  literals written from eight files and compared in four more, with `preview.ts` and `blocks.ts`
  each keeping a fourth and fifth private copy. Four components, four lists, no link — this repo's
  named defect class. The scan holds seven things: the registry is well formed (SCREAMING_SNAKE key,
  label, a one-line sentence, a door of EMAIL/HAND/JOB, something it requires, unique keys);
  `startableByHand` is DERIVED from the door rather than asserted beside it, so it cannot disagree —
  a job-opened kind must be `false` and must say why in its own sentence, because `duplicateOf()` in
  `services/workCards.ts` would silently join a hand-made one to the job's card and the person who
  wrote it would watch nothing happen; every `INSERT INTO work_card` / `UPDATE work_card SET kind`
  under `src/worker` is in the scan's in-file write-site register and every register entry still
  points at a live site (a stale exemption FAILS); every kind a site can write is registered, with a
  bound site resolved through the SYMBOL it names, read out of the real source rather than restated
  here, and a pass-through site made to prove it really reads the kind back off `work_card`; every
  `card.kind === "…"` comparison names a registered kind; no registry entry is dead; and every
  job-door kind is caught by the "an internal stage or job name" pattern in `shared/work/blocks.ts`,
  so a new recurring kind cannot be added without the guard that keeps it out of the one sentence a
  partner is asked to act on. The write side is the complete guard: a kind cannot be in the database
  unless something put it there. Hard-fails on zero kinds, zero write sites, zero comparisons or
  zero job-door kinds checked; 19-fixture self-test including a job kind offered by hand, a refusal
  with no reason, an unregistered write site, a stale register entry, a symbol whose union has
  drifted, and a job kind the block-sentence guard does not ban.
- `every-door-keeps-the-message.mjs` (`npm run validate:every-door-keeps-the-message`, 22 Sep 2026) —
  every inbound email is kept once, at the entry, and no work card is ever written raw MIME instead
  of the sender's words. On 21 Sep Scooter's reply was read as a new request, 4,000 characters of
  `Received:`/`ARC-Seal:`/DKIM headers went into the card's description, and no `.eml` was stored:
  keeping the message was a PER-DOOR responsibility that one door of five discharged, and
  `raw.slice(0, 4000)` was typed out separately in two more. The scan holds six things: every call
  site of `openRoutingCard`/`openAssignmentCard`/`openPortfolioUpdateCard`/`intakeDealFromEmail`/
  `steerFromReply` is reached with a stored key in hand (named in the call, or set on the variable
  handed to it); no door slices `raw` into what it writes and each reads it through
  `readableMessage`; no `catch` in the inbound path swallows an R2 `put` without appending an event;
  `keepTheMessage` runs in `handleInboundEmailOnce` BEFORE any door, writes its `inbound_message`
  row beside the object, refuses a forged partner message, and is the only place in `src/` that
  mints an `inbound-email/` key; and the request-message routes gate on `getVisibleWorkCard` (scope
  AND privacy label) rather than the notes routes' bare `SELECT id FROM work_card`, with the raw
  route behind `authorize()` on `inbound_message.read_raw`. Hard-fails on zero sources, zero door
  call sites or zero R2 puts; `--self-test` plants twelve bypasses including each real pre-fix
  shape.
- `cc-partners-only.mjs` (`npm run validate:cc-partners-only`, 23 Sep 2026, migration 0239) — a cc
  on an employee's email reaches only a partner, only because the partner who asked for the work
  said so, and only on finished work: one writer of `work_card.cc_emails`, the requester check
  before the write, resolution through the partner registry, and the send and the preview lane
  holding a cc to everything a To already is. Nine planted defects in its self-test.
