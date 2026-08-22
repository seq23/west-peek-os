# e2e

Playwright browser journeys against a local `wrangler dev` (`npm run e2e`). The webServer command
builds the client, applies local migrations (idempotent), and serves worker + SPA on :8787.
`scripts/e2e/prepare-local.mjs` runs first and resets the local D1, so every run starts from an
empty firm — which is what the journeys assume. No credentials, nothing remote.

## The two things that make or break a run

**`--local` on `wrangler dev` is load-bearing.** Wrangler treats some bindings as REMOTE by default
now, `[ai]` among them, so plain `wrangler dev` opens a remote proxy session before it will serve
anything. On this account that session dies against Cloudflare Access and the server exits 1 —
Playwright then reports `Process from config.webServer was not able to start` and **nothing runs at
all**. See the comment on `webServer.command` in `playwright.config.ts` before changing it.

**One worker, one database.** Every spec drives the same local D1, so the isolation boundary is the
database and not the file. Two consequences: markers (`E2E-P6-${Date.now()}`) rather than fixed
names, and anything a spec switches off is switched off for everything after it. A spec that depends
on a starting state should establish it — see `p28-activation-chain.spec.ts`, which puts one seat
back to `INACTIVE` in `beforeEach` because migration 0136 employed the whole roster and the file had
silently skipped itself out of existence.

## Writing an assertion that survives next week

This suite has been broken repeatedly by copy edits, and every repair in it is a copy edit that a
spec pinned. Prefer, in order:

1. **A role or a testid.** `getByTestId("route-form")` proves the capture is unrouted better than
   asserting the string `NEW`, because the form only renders while it is.
2. **The shared module the page renders from.** `approvalStateWords("pending_review").label`,
   `stateMeaning("OPEN")!.label`, `AI_EMPLOYEE_ROSTER` — one place decides the wording, and a
   rewording moves the assertion with it instead of breaking it.
3. **A short distinctive phrase**, only when the phrase IS the property (an honesty caveat, a
   refusal that must name its alternative).

Never assert a raw enum that the interface no longer prints. `PAUSED`, `pending_review`,
`METRIC_DETERIORATION` and `NOT_CONFIGURED` all came off the surfaces deliberately; asserting them
back tests the database's vocabulary rather than the operator's.

## Helpers

- `support/nav.ts` — `gotoSurface(page, label)` reaches any destination at any viewport and in
  either nav tier. Below 900px the rail is a sheet; above it the rail is always on screen.
  `openDisclosure(page, testId)` opens a `<details>` — several workflows now live inside one
  (`company-identity`, `notifications-settings`), and everything under a closed `<details>` is in
  the DOM and NOT visible, which fails as "element is not visible" and reads like a missing control.
- `support/provision.ts` — `provisionLocalD1(sql)` writes fixture rows the API deliberately has no
  route for (a second firm user, an unemployed seat). `queryLocalD1(sql)` reads back the handful of
  facts no route serves — `pending_deck` above all, where the REASON a deck could not be read is
  stored and nothing exposes it.
- `support/mail.ts` — delivers a real RFC822 message to the Worker's `email()` handler through
  miniflare's `/cdn-cgi/handler/email`. The inbound mailbox is the one surface the firm does not
  control the input of, and it is where this system has already lost a real deck.
- `support/surfaces.ts` — walks EVERY destination in the rail and asks the same three questions of
  each: does it render readable prose, does it say what it is for, and is any visible list empty
  with nothing in it. Written as a sweep rather than a list of testids because the `*-empty` testids
  cover about a third of the empty slots in this product, and the defect this exists to catch was on
  a page with no testid at all. Used by `d0-empty-firm.spec.ts` (no data) and
  `d1-design-states.spec.ts` (no authority) — the two states in which a surface is most likely to
  render an ambiguous blank, and the two the product's own verification kept missing.

## Two files whose NAMES are load-bearing

`d0-empty-firm.spec.ts` runs FIRST. Playwright walks spec files in order and `prepare-local.mjs`
deletes the local D1 before the suite starts, so `d0-` is the only chance the suite gets to see the
firm the way it looks on the day somebody first opens it. Renaming it costs that coverage silently.

Three specs establish a starting state in `beforeAll`, and each says why on the spot:
`p28-activation-chain.spec.ts` puts one seat back to INACTIVE; `p57-deal-intake-and-pipeline.spec.ts`
and `p64-edge-cases.spec.ts` move the CLOCK on the intake seat's existing cards, because three of the
four doors into the funnel open a card for one seat and that seat trips a real breaker at twenty
cards an hour. Nothing is deleted in either case, and the breaker itself is deliberately tripped and
asserted in `p57`.

## What is asserted only up to a boundary

Local runs have no provider credential and privacy mode is LOCKDOWN, so `run_ai` routes to the
deterministic `mock-local` model. Journeys that end in a model's words assert the whole chain up to
the boundary and say so on the test — `p54-inbound-deck.spec.ts` proves a deck is stored, queued,
picked up and attempted by the right employee with the reason written down, and does not claim which
fields a real model would fill.

Two boundaries are worth knowing before writing a new journey, because both look like product bugs
and are neither:

- **A monetary spend ceiling cannot be made to block a run here.** The firmwide ceiling and the daily
  cap are enforced at step 7 of `runAi`, after step 3 short-circuits LOCKDOWN and LOCAL to the free
  local adapter and returns. Local runs never reach the money gates and never should. What IS
  drivable is the cost MODE (`CRITICAL_ONLY`), which is checked before the short-circuit and
  genuinely refuses a run with a named reason — `p62-truthful-system.spec.ts` asserts that and states
  the limit on the test rather than papering over it.
- **A partner's steering note reaching the employee's next prompt is not provable here.** The prompt
  is never persisted (`ai_run` stores a hash of its inputs) and the local model would not produce the
  acknowledgement line, so `p55-delegate-and-steer.spec.ts` proves the note is stored, unanswered and
  refused on finished work, and stops there.

`test.fail()` is the tool for a gap that must stay open: leave the assertion stating the behaviour
that should hold, and a comment naming what must change. There are none in the suite today — the four
that were here (LP claims and the data-room ledger in `p10`, the reporting packet in `p12`, the work
packet and its lens gate in `p18`, opening an allocation scenario in `p11`) all closed when those
surfaces were built, and the specs now drive them in the browser.

## Journeys, and where each one lives

The suite is organised by what would cost the firm a deal, money, or an LP relationship:

| What breaks | Where it is proved |
|---|---|
| A company enters the funnel by each of four routes, with its provenance | `p57` |
| A deck arrives by email and updates the record | `p54` |
| A deal moves the full length of the pipeline to a decision | `p57` |
| A pass is recorded with its reason and stays visible | `p57` |
| An investment is booked and a `position` exists | `p59` |
| A follow-on candidate → review → a partner's decision | `p63` |
| An LP commits; signed and soft are never summed | `p61` |
| A quarterly letter is drafted, reviewed by three, sent behind a signature | `p61`, gates in `p12` |
| Who holds LP material can be seen and revoked | `p10` |
| An employee is employed, works a card, and the run is attributed | `p63` |
| A partner steers work in flight | `p55` |
| A delegated approval means the next one does not wait | `p55` |
| A reserved action can never be delegated | `p55` |
| A meeting produces commitments that become work a partner decides | `p7` |
| An IC packet, its questions, a decision — and dissent | `p60` |
| A meeting is archived with a reason and its work cards survive | `p66` |
| The morning brief arrives, or says why not | `p62` |
| Diagnostics escalates once to both partners, then announces recovery | `p62` |
| A spending decision stops a run and says so | `p62` |
| No inbound email, and no refused arrival, fails silently | `p54`, `p57` |
| An empty firm is legible everywhere | `d0` |
| A reader with no roles sees refusals, never blanks | `d1` |
| A duplicate arrival joins; a different one never does | `p64` |
| A reopened decision supersedes and the original stays | `p64` |
| A retired employee's rows still resolve and read as retired | `p63` |
