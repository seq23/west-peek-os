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

## What is asserted only up to a boundary

Local runs have no provider credential and privacy mode is LOCKDOWN, so `run_ai` routes to the
deterministic `mock-local` model. Journeys that end in a model's words assert the whole chain up to
the boundary and say so on the test — `p54-inbound-deck.spec.ts` proves a deck is stored, queued,
picked up and attempted by the right employee with the reason written down, and does not claim which
fields a real model would fill.

Several specs drive part of a journey through the API because the surface that used to drive it was
removed while the governed routes stayed live. Each one says which surface is missing and carries a
`test.fail()` test holding the gap open: LP claims and the data-room ledger (`p10`), the reporting
packet (`p12`), the work packet and its lens gate (`p18`), opening an allocation scenario (`p11`).
