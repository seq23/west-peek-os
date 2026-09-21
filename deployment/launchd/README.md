# Installing the subscription-seat claimer

The claimer lets work the router marks **Private model only** run on the two subscriptions the firm
already pays for — Claude Code on the Claude Max seat, Codex CLI on the ChatGPT Plus seat — instead
of on a metered model. It is written into this repo but **not installed by it**: loading a launchd
job is an act on the owner's machine, so the owner or the coordinator does it.

**Nothing below is required for the firm to work.** If the claimer is never installed, the seats
never send a heartbeat, the router skips them with no delay, and every run goes down the ladder
exactly as it does today. That is proven by `tests/subscriptionSeats.test.ts`, which completes work
with no claimer present at all.

## Before you start: one Access service token

The claimer authenticates the way the firm's own browser agent does. In the Cloudflare Zero Trust
dashboard, create a service token, give it access to the West Peek OS application, then put both
halves in the vault and the **client id** into the Worker:

```sh
npm run vault:set WP_OS_MAC_ACCESS_CLIENT_ID       # the Mac's OWN token — not the employee browser's
npm run vault:set WP_OS_MAC_ACCESS_CLIENT_SECRET
npm run vault:sync:cloudflare                        # ships the id to the Worker as WP_OS_CLAIMER_CLIENT_ID
```

Done 19 Sep 2026: service token `west-peek-os-mac`, admitted by its own policy on the Worker's Access
application, both halves in the vault, id synced. The employee browser's token (`CF_ACCESS_CLIENT_ID`)
resolves to the browser agent in the Worker, so presenting it here answered 403 — one token cannot
be two identities, which is why the Mac has its own.

`WP_OS_CLAIMER_CLIENT_ID` is a **name, not a secret** — Access verifies both halves at its edge and
forwards only a signed assertion, so the Worker never sees the secret half. Until that name is set,
the claimer's requests resolve to no identity and every route answers 403. That is the correct
default: no token, no agent.

## Check the machine first

```sh
node scripts/vault/vault.mjs run -- node scripts/claimer/subscription-seat-claimer.mjs --doctor
```

It prints the device id, the base URL, whether the token reached the environment, and which seats
are usable. A seat is usable when its CLI is on `PATH` **and**, for Codex, when `~/.codex/auth.json`
still records `auth_mode = "chatgpt"` — if that has become `apikey`, the claimer refuses the seat
rather than billing the API per token while the firm records the lane at $0.

Then try exactly one cycle, in the foreground, and watch it:

```sh
node scripts/vault/vault.mjs run -- node scripts/claimer/subscription-seat-claimer.mjs --once
```

## Install

```sh
cp deployment/launchd/ventures.westpeek.os.seat-claimer.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/ventures.westpeek.os.seat-claimer.plist
launchctl list | grep westpeek.os.seat-claimer
tail -f /tmp/westpeek-os-seat-claimer.log
```

Edit the repo path in the plist first if the checkout is not at `~/GitHub/west-peek-os`.

## Confirm the firm can see it

```sh
curl -s -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" \
  https://os.joinwestpeek.com/api/subscription-seats/status | jq
```

`any_seat_available` should be `true` within thirty seconds of the job loading, and each seat should
carry a `last_seen_at` in the last minute.

## Uninstall

```sh
launchctl unload -w ~/Library/LaunchAgents/ventures.westpeek.os.seat-claimer.plist
rm ~/Library/LaunchAgents/ventures.westpeek.os.seat-claimer.plist
```

Work in flight is not lost. Within five minutes the reaper on the Worker's every-minute tick returns
any claimed run to the pool, and anything nobody takes is closed with a sentence saying so — the
card it belonged to was answered on another lane at the time.

## This is not Boss OS's claimer

Different repository, different script, different launchd label
(`ventures.westpeek.os.seat-claimer`), different log paths, different endpoint. Neither reads,
writes, imports or supervises the other, so a stall in one cannot take the other down. If a label
ever collides, **this** is the one that changes.

## The Meet live listener (tier 4, 19 Sep 2026)

A second job, `ventures.westpeek.os.meet-listener.plist`, same shape, same vault, same Access
token. It is the OS's ears in a firm-hosted Google Meet — see `scripts/meet/live-listener.mjs` for
what it may and may not do, and `docs/GOOGLE_MEET.md` for the two Google-side stops it waits on
(the Media API scope, granted 19 Sep 2026; Developer Preview enrolment of the project, applied for).

```sh
npm run vault:run -- node scripts/meet/live-listener.mjs --doctor    # the machine, the grant, the Worker
cp deployment/launchd/ventures.westpeek.os.meet-listener.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/ventures.westpeek.os.meet-listener.plist
tail -f /tmp/westpeek-os-meet-listener.log
```

Until the job runs, every firm-hosted Meet in its window reads `meet_not_started` with "no
listener has ever checked in from the Mac" on the row — the honest state, not a silent one. While
her Mac sleeps, a live call reads `meet_live_no_listener`.

## The local-job claimer (Plan A, 20 Sep 2026) — Porter's hands for a web property change

A third launchd job, separate from the seat claimer and the Meet listener: it claims `LOCAL_JOB`
runs (migration 0219) and runs the duty script for the card's kind — today
`scripts/duties/web-property-change.mjs` — in a git worktree of the target repo, with `claude -p`,
tools, caffeinate and a hard ceiling. It never creates work and never lands without the recorded
approval and green check the job carries (`validate:no-land-without-approval`).

What it needs on this Mac, all of which `--doctor` checks: `claude`, `gh` (signed in), `git`,
`caffeinate`, `~/bin/land`, the target repo checked out under `~/GitHub/<repo>` (with a
`RUNBOOK.md`), and in the vault `WP_OS_MAC_ACCESS_CLIENT_ID`, `WP_OS_MAC_ACCESS_CLIENT_SECRET`
and `GSC_SERVICE_ACCOUNT_JSON` (the Drive service account, drive.readonly, impersonating
sequoia@westpeek.ventures — the Drive folder must be shared with that account or its domain).

```sh
node scripts/vault/vault.mjs run -- node scripts/claimer/local-job-claimer.mjs --doctor
node scripts/vault/vault.mjs run -- node scripts/claimer/local-job-claimer.mjs --once     # one cycle, foreground
cp deployment/launchd/ventures.westpeek.os.local-jobs.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/ventures.westpeek.os.local-jobs.plist
launchctl list | grep westpeek.os.local-jobs
tail -f /tmp/westpeek-os-local-jobs.log
```

Job working directories live under `~/GitHub/wpos-jobs/` (one worktree `wt-<card>` and one package
directory `pkg-<card>` per card, one run directory per run with the prompt, the CLI output and the
result file). A landed card removes its worktree and branch.
