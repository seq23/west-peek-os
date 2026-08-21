# Backlog

What is not finished, why, and what finishing it means. Written 17 Aug 2026, verified against the
code rather than from memory.

Every V1 commitment in canon §32 is closed. Everything below is either a deliberate deferral, a
capability that is switched off, or a feature whose backend works and whose front end does not.

**Status vocabulary**

| | |
|---|---|
| **Switched off** | Built and tested. One flag or credential away from live. |
| **API only** | Backend works and is tested. No way to reach it from the UI. |
| **Scaffold** | Schema and a thin surface. Agreed as thin at the time. |
| **Not built** | Nothing exists. |
| **Deferred** | A decision was taken not to build it yet. |

---

## Blocked on a decision or a credential

### Outbound email — switched off
Resend is wired into the governed effect path and tested. Sending needs **both** `RESEND_API_KEY`
and `WP_OS_EMAIL_SEND=enabled`; today an approved email is recorded as
`"Approved and recorded, NOT sent"`. Two switches on purpose — a credential arriving in the
environment is not a decision to start emailing people.

Five things stay partial until this is on: functional inboxes, LP outreach, event invitations,
Walter's external follow-ups, and reporting distribution.

### Functional inbox — deferred
Canon #36. Deferred 17 Aug 2026 in favour of a different shape the operator preferred: an inbox the
partners write **to**, where AI employees pick up tasks, rather than an inbox the world writes to.

That inversion removes the hard problem. Inbound mail from anyone means untrusted text becomes AI
input; mail from the partners does not. It also reuses the meeting close-out delegation almost
entirely — extraction, assignment to AI employees, human-recommended tiers, the digest — so it is a
new entry point into existing machinery rather than a new system.

**If the world-facing version is ever revisited:** a hashtag trigger inside the email cannot
authorise anything, because the sender controls it. Authorisation has to come from an authenticated
partner, and a `From:` header is not authentication.

### ~~Browser tasks — no runner~~ · DONE 17 Aug 2026
Request → approve → run → record, with human-only approval. Refusals and failures are recorded on
the task rather than thrown away, and results are stored already fenced as untrusted.

Still open: no UI. The lifecycle is reachable only by API.

### R2 document restore — unproven
The production restore drill (`docs/RECOVERY.md` §6) covered D1 thoroughly: 4,330 rows, triggers and
indexes intact, append-only enforcement verified. **Documents in R2 are not in a D1 dump**, so full
disaster recovery is not proven end to end. Needs an R2 export/restore path and a drill of its own.

---

## ~~Backend works, no way to reach it~~ · ALL DONE 17 Aug 2026

### ~~Approval Centre evidence and comments~~
Risk, impact, recommended approver, staleness, evidence and an append-only question thread now render
on every card. Risk is shown but not editable — it is derived from the action key.

### ~~IC Decision Portal placeholders~~
Company, Memo, Market, People and Decision pull real records through one endpoint. Live Help stays a
pointer deliberately: it belongs to the meeting workspace where seating, the ≤5 cap and Revoke All
already govern it, and duplicating it would create two places to revoke access from.

### ~~Daily Intelligence — not scheduled~~
The backlog entry was wrong in a useful way. `daily_intelligence` was ALREADY an active daily job —
but it runs the SWEEP. The BRIEFING had no schedule. It is now chained after the sweep in the same
run, because the brief reads what the sweep just gathered; two independent jobs could fire in either
order and a brief that ran first would brief on yesterday. A failed brief does not fail the sweep.

### ~~Weekly MP review — not scheduled~~
Registered as `weekly_mp_review`, daily at 12:00 UTC, generating idempotently per ISO week. **Starts
paused** — recurring work is opt-in.

Both are switched on from Scheduled Work.

---

## Thin by agreement

### ~~Event OS — scaffold~~ · REBUILT AROUND ROOMS 17 Aug 2026
Rebuilt against the operator's community model, now recorded at `docs/COMMUNITY.md`. Rooms are the
flagship: Parker proposes one monthly with venues, pricing, booking contacts, guest ideas and
economics; Wynn works a sponsor pipeline; a partner approves. See migrations 0044–0048.

Three things from canon §15 were deliberately **cut**: ticketing (membership is free and Rooms are
curated), general budgets (per-Room economics only), and run-of-show (a checklist at most). What
replaced them is the packet and the close-out, which is where the value actually is.

Close-out shipped 17 Aug 2026 (migration 0049): after a Room, attendance becomes `com_act` evidence
and West Peek's follow-ups run through the **same** `delegationPolicy` as a meeting, so the
assignment rule lives in one place. Attendance is written before extraction and survives a model
failure — it is the half nobody can reconstruct a week later.

Commitments members made to each other are deliberately not captured, and there is nowhere in the
schema to put them.

Still thin: run-of-show, and the Mastermind's breakout structure.

### Community OS — acts, not segments
`com_act` records what West Peek witnessed a member do; Council is a human decision with a reason.
There is deliberately **no member stage field and no participation score** — see `acts.ts`, which
has a test that fails if a score is added.

Still thin: cohorts and programming. Note that the member-facing surface is **undecided** (possibly
a white-labelled platform), so until it exists the community is event-based rather than continuous.

Note for whoever picks this up: the `west-peek-community` repository is the **marketing site**
(joinwestpeek.com) and is unrelated.

---

## Would improve what exists

### What cannot actually run — no way to see it · API only
Added 21 Aug 2026, queued for the Home/attention work.

The catalogue can list a model, price it, and present it as available while it cannot run at all.
That is not hypothetical: `@cf/meta/llama-3.2-11b-vision-instruct` was registered in
`0081_workers_ai_cheap_tier.sql` with a price and a context window, and answers every call with
error 5016 because Meta's licence was never accepted. Nothing anywhere told the operator. The same
blindness covers a connector with no credential and a provider whose key has lapsed.

`operatorAttention()` in `src/shared/setup/operatorAttention.ts` is the right surface and already
has the shape for it, but it computes only from inputs the caller holds and deliberately invents
nothing — so this needs a **model-level block record** first: an append-only row written when a run
or health check comes back with a licence refusal, a missing credential, or an unsupported
capability, carrying the human action that resolves it.

`provider_health_check` cannot carry this as it stands: it is keyed to `provider_id`, and the
failure here is per-model. Workers AI the provider is healthy; one model on it is gated.

**Deferred deliberately** so it is designed alongside the other "Needs your attention" items rather
than bolted on, per the review-first sequencing agreed 21 Aug 2026.

### A second vision model — moondream needs a third shape · deferred
Added 21 Aug 2026.

`@cf/moondream/moondream3.1-9B-A2B` runs on this account, needs no licence, and would give routing
a second pair of eyes. It is not wired, and the reason is shape: it answers the OpenAI content-array
form with an **empty object**, and its own `prompt` + `image` form wants raw image bytes rather than
a data URI. Supporting it means a third input and output shape in one adapter.

`@cf/meta/llama-3.2-11b-vision-instruct` works, was licensed by a Managing Partner on 21 Aug 2026,
and is proven end to end against a real image. One working vision model is enough until something
needs a fallback.

### Meeting capture — the recording bot is not ours
Added 21 Aug 2026.

In-browser capture was chosen for meetings because employees need to talk to the partners during
the meeting, and it needs no vendor: chunks go to Workers AI Whisper on the binding this Worker
already has. Its limits are real, though — the tab must stay open, audio quality is whatever the
laptop hears, and nothing appears in the call for the counterparty to see, so consent rests
entirely on the partner asking for it.

Later, in this order: a purpose-built West Peek recording bot that joins Zoom and Meet as a visible
participant, and true streaming transcription so employees can react mid-sentence rather than
per chunk.

### Deal provenance — capture is live, history is empty
`relationship_origin` and `relationship_started_at` are captured on the opportunity create form and
backfillable from the Investment page. **Existing opportunities are all UNRECORDED** and the panel
says so rather than drawing conclusions from a thin sample.

The measurement only becomes meaningful once deals accumulate. If nothing traces back to a Room
after eighteen months, that is the answer, and it should be visible rather than explained away.

### ~~Market mapping — no live discovery~~ · DONE 17 Aug 2026
Perplexity Sonar is registered and wired as the fourth pass. Search finds companies; funding figures
still come only from filings and swept news, because a search result's number has no provenance.

Crunchbase deliberately not integrated: several hundred dollars a month, and worth deciding after a
month of using the free version. `funding_source` is an enum — adding it later is one adapter and
one trust value.

### ~~Research packets — corpus only~~ · DONE 17 Aug 2026
Live search runs alongside the corpus rather than instead of it, and its answer becomes one more
grounded item with real citations.

### Network OS — two of four resources
`contact`, `relationship` and `touch` map to the snapshot. `gmail_thread` returns empty because the
snapshot endpoint does not carry it. Writeback is deliberately unimplemented — canon §12A.5 governs
it separately and a read integration should not grow a write path by accident.

### Network OS session secret — coupling
West Peek OS holds Network OS's `APP_SESSION_SECRET` to mint its own session. It works and is
rotated, but the cleaner shape is a dedicated service token in Network OS so this system never holds
that secret. About an hour, and it removes a shared secret between two deployed systems.

---

## Known sharp edges

### The suite is flaky under parallel execution
Observed repeatedly on 18 Aug 2026: `npx vitest run` intermittently reports one to six failed
FILES with zero or a handful of failed tests and a pile of skips, and a re-run passes. The same
command with `--no-file-parallelism` passes every time — 67 files, 1004 tests, no failures.

So it is miniflare contention between concurrent workers, not product code. It still matters: a
suite that fails randomly is a suite people stop reading, and the next real regression arrives
looking exactly like the noise. Worth pinning down the contended resource — most likely each
file's D1 instance — and either isolating it or capping worker concurrency in `vitest.config.ts`.

**Until then, `--no-file-parallelism` is the trustworthy run.** It takes about six minutes instead
of ninety seconds, which is the actual cost of the bug.

### INSERT OR IGNORE hides constraint failures
Migration 0046 seeded a scheduled job, omitted a NOT NULL column, and `INSERT OR IGNORE` turned the
violation into a no-op. The migration reported success, `schema_version` advanced, and the job
existed in no database — found by querying production by hand, not by any test.

**Do not use `INSERT OR IGNORE` for seeding.** Use `INSERT … SELECT … WHERE NOT EXISTS`: idempotent,
and a real constraint violation still fails the migration. `tests/seededJobs.test.ts` now enforces
this and asserts a row exists for every job the dispatcher handles. Second time this idiom has bitten.

### There is exactly ONE deploy path, on purpose
`npm run deploy:production`. Nothing else.

Cloudflare Workers Builds was connected to this repository on 14 Aug 2026 and **the GitHub build
trigger was switched off on 18 Aug 2026**. That was a decision, not an oversight — do not reconnect
it without reading this.

Two paths deployed into the same Worker and they did not do the same thing:

| | applies D1 migrations | refuses if any pending | probes the Worker after |
|---|---|---|---|
| `npm run deploy:production` | yes | yes | yes |
| Workers Builds on push | no | no | no |

A push containing a new migration would therefore have shipped code against an un-migrated
database — the exact failure that happened twice on 17 Aug. The alternative, teaching CI to run the
safe sequence, needs a Cloudflare API token with D1 write access living in the build environment;
that is a long-lived secret with real blast radius bought to save one command, for a firm that
deploys from one laptop.

GitHub is source history and backup. It is not the deploy mechanism.

### The action-type generator
Fixed, but worth understanding. `scripts/seed/generate-machine-seed.mjs` writes the registry into
migration `0003`, which every existing database applied long ago. Adding a key used to reach new
databases only — three keys shipped in August 2026 that were absent in production while passing
every test.

The generator now emits a numbered backfill migration and `--check` fails without one. **Do not
hand-edit `0003`.**

### ~~Deploy does not mean migrated~~ · FIXED 17 Aug 2026
`npm run deploy:production` now does it in the safe order and refuses to continue if migrations are
still pending after applying. Use it rather than running the commands by hand — this shipped code
against absent tables twice in one day, and the fix is a script, not discipline.

---

## Not planned

Listed so nobody assumes they are coming.

- **Badges, points, certificates, mastery scores** in West Peek University — explicitly out of scope
  for v1 and only worth revisiting if usage justifies them.
- **A lesson catalogue.** The teaching engine is a prompt precisely so any topic works; a catalogue
  would cap it at whatever was seeded.
- **Browserbase.** Registered but disabled, kept as a documented alternative to the platform
  browser. Its x402 autonomous-payment lane is not wanted: an agent that can answer HTTP 402 by
  itself can spend without asking.
