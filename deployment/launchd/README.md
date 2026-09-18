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
npm run vault:set CF_ACCESS_CLIENT_ID
npm run vault:set CF_ACCESS_CLIENT_SECRET
npx wrangler secret put WP_OS_CLAIMER_CLIENT_ID --env production   # the client id, again
```

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
