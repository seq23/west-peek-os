# Outbound Email Map — West Peek

West Peek only; Boss OS keeps its own map. The two businesses never share a repo, so every West Peek
sending path that used to sit in Boss OS's map lives here now, wherever its code runs.

Last verified 12 Oct 2026 (rows moved from Boss OS's map that day, plus a fresh read of this repo's
own transports). Same day, `lgcv-search-outcomes-weekly` and `industryguides-lead-notification` left
this map: both now send as `The Industry Guides <hello@theindustryguides.com>` through The Industry
Guides' own Resend account (local-guides-citation-velocity PRs #190 and #191), so nothing West Peek
is left in either path; Boss OS's map carries them, and the test refuses an Industry Guides row here
unless it sends from a West Peek address.

**Read by code.** `tests/outboundEmailMap.test.ts` parses the table below: ids must be unique, every
west-peek-os file a row cites must exist, zero rows is a failure, and any file in this repo that
reaches a mail transport (Resend, Gmail send, the Cloudflare `send_email` binding, or a caller of one
of those helpers) must be cited by a row, and the Summary counts must add up to the rows. Adding a sender means adding a row in the same PR.

**Confidentiality.** This repo may be public. No LP, investor or partner identity goes in this file:
addresses are given by role ("a managing partner's westpeek.ventures address", "the owner's personal
inbox"), and LP rows keep counts and dates only.

## How to read a row

- **Code location**: `west-peek-os:` followed by backticked paths in this repo (checked by the
  test), or `other repo (…)` for code in boss-os, west-peek-network-os, westpeek-live, the site
  repos, `~/bin`, or nowhere at all (skipped by the file-exists check, kept so the map is whole).
- **Status**: CONFIRMED = code and trigger read; SUSPECTED = part of the chain could not be read.
- **Ids are stable.** Boss OS's map dropped these ids on 12 Oct 2026; they are never returned there.

## Summary

| Runs where | Paths |
|---|---|
| Cloudflare cron (west-peek-os Worker) | 1 |
| Cloudflare on event (approved effect, form, sign-in, vote) | 4 |
| Mac launchd | 8 |
| External SaaS | 1 |
| Inert | 1 |

Not senders: HeyReach (via 8raise) is LinkedIn, not email.

## Inventory

| Id | What (to whom) | From | Transport | Trigger and where it runs | Footer / company line | Human review | How to pause | Code location | Status | Owner seat | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `porter-partner-email` | Every employee email to a partner: Porter replies, previews, approved previews released to their recipient, deliverables, PARTNER_MESSAGE cards, Walker's monthly note. To the two managing partners' westpeek.ventures addresses only (code-enforced); a firm user's registered address for copies | os@westpeek.ventures; employees as `<name>@joinwestpeek.com` | Resend (Cloudflare `send_email` binding instead when bound; it is not bound in production) | west-peek-os Worker cron `* * * * *` plus inbound os@ mail and card actions; Cloudflare cron | Exec-email footer naming os@joinwestpeek.com | None for partner mail (WP_OS_AI_EMAIL_PARTNERS = enabled); external mail is off | wrangler.toml env.production: WP_OS_EMAIL_SEND to anything but "enabled", or WP_OS_AI_EMAIL_PARTNERS = "off"; then `npm run deploy:production` | west-peek-os: `src/worker/services/execEmail.ts`, `src/worker/services/partnerMessage.ts`, `src/worker/services/previewApproval.ts`, `src/worker/effects/emailTransport.ts`, `src/worker/effects/resendClient.ts`, `src/worker/effects/cloudflareEmailClient.ts` | CONFIRMED | Porter (West Peek OS) | Some work behind these emails is done by the Mac claimer (ventures.westpeek.os.local-jobs), so a sleeping Mac delays the email; the send itself is in the cloud. |
| `governed-effect-email` | An approved `email.send` external effect: a human's own message sent as them, or an AI employee's message signed with its own @joinwestpeek.com address. To the effect's destination | The requesting partner's address (through their own Gmail when they granted gmail.send), else the employee's address, else WP_OS_EMAIL_FROM | Gmail API gmail.send (partner's own OAuth), falling back to Resend or the Cloudflare binding | `executeExternalEffect` after `authorize()` returns ALLOW on an approved, unconsumed receipt; Cloudflare on event | Whatever the approved body says | Yes: every send needs an approved receipt (silence is never approval); AI mail to non-partners also needs WP_OS_AI_EMAIL_EXTERNAL = "enabled", which is "off" | Same switches as above (WP_OS_EMAIL_SEND); a partner can revoke gmail.send in Settings | west-peek-os: `src/worker/effects/executor.ts`, `src/worker/services/googleConnect.ts`, `src/worker/effects/googleClient.ts`, `src/worker/services/effects.ts` | CONFIRMED | Porter (West Peek OS) | Added 12 Oct 2026 from a read of this repo; it was not in Boss OS's map. Unapproved or switched-off requests record "Approved and recorded, NOT sent". |
| `scooter-watch-report` | Partner-tail fix reports, Monday digest, final report. To a managing partner's westpeek.ventures address | os@westpeek.ventures | Resend | launchd com.seq.scooter-watch every 15 min (on a new partner → os@ email) and com.seq.scooter-watch-digest Mon 08:00/09:00; ends 4 Jan 2027; Mac launchd | None (internal) | None | launchctl bootout gui/501/com.seq.scooter-watch; same for com.seq.scooter-watch-digest | other repo (~/bin: scooter-watch.sh, scooter-watch-report.mjs, scooter-watch-digest.sh) | CONFIRMED | Porter (West Peek OS) | Also opens one west-peek-os GitHub issue per fix. |
| `capital-interest-match` | Daily interest matches and ledger hunt (brokerage), mailed to the owner's personal inbox | Monique (Boss OS employee address) | Resend | launchd com.seq.boss-capital daily 07:45 (capital:match --send --pointer; capital:ledger-hunt --send); Mac launchd | None (internal) | None | launchctl bootout gui/501/com.seq.boss-capital | other repo (boss-os scripts/ops/interest-match.mjs, ledger-hunt.mjs; chassis copy) | CONFIRMED | Monique | Reads a brokerage mailbox by service account (read-only); never sends from it. |
| `capital-nudge` | Monthly ask for the live book, to the owner's personal inbox | Monique (Boss OS employee address) | Resend | launchd com.seq.boss-capital-nudge, 1st of month 07:30; Mac launchd | None (internal) | None | launchctl bootout gui/501/com.seq.boss-capital-nudge | other repo (boss-os scripts/ops/interest-match.mjs --nudge --send; chassis copy) | CONFIRMED | Monique |  |
| `capital-buyer-hunt` | Weekly buyer and holdings hunt report, to the owner's personal inbox | Monique (Boss OS employee address) | Resend | launchd com.seq.boss-capital-buyers Tue 07:00 (capital:hunts --send, capital:buyers --send); Mac launchd | None (internal) | None | launchctl bootout gui/501/com.seq.boss-capital-buyers | other repo (boss-os scripts/ops/buyer-hunt.mjs; chassis copy) | CONFIRMED | Monique |  |
| `buyer-hunt-ondemand` | Buyer hunt for a task opened in Boss OS, to the owner's personal inbox | Monique (Boss OS employee address) | Resend | launchd com.seq.boss-hunt-ondemand every 5 min; sends only when an open task carries input.hunt; Mac launchd | None (internal) | None | launchctl bootout gui/501/com.seq.boss-hunt-ondemand | other repo (boss-os scripts/ops/buyer-hunt.mjs --from-boss --send; chassis copy) | CONFIRMED | Monique |  |
| `people-worth-a-call` | Weekly people worth a call, to the owner's personal inbox, then her westpeek.ventures address as fallback | Monique (Boss OS employee address) | Resend | launchd com.seq.boss-people Mon 07:15; Mac launchd | None (internal) | None | launchctl bootout gui/501/com.seq.boss-people | other repo (boss-os scripts/ops/people-worth-a-call.mjs; chassis copy) | CONFIRMED | Monique |  |
| `lp-positive` | LPs who replied positively, before the Wednesday sync, to the owner's westpeek.ventures address (LP_POSITIVE_TO) | Monique (Boss OS employee address) | Resend | launchd com.seq.boss-lp-positive Tue 08:15; Mac launchd | None (internal) | None | launchctl bootout gui/501/com.seq.boss-lp-positive | other repo (boss-os scripts/ops/lp-positive.mjs --email; chassis copy) | CONFIRMED | Monique | Body carries LP identities; goes only to the owner's own inboxes. None are recorded here. |
| `lp-outcomes` | What happened to every Twin LP email (opt-outs first), to the owner's personal inbox, fallback her westpeek.ventures address | Monique (Boss OS employee address) | Resend | launchd com.seq.boss-scooter-sheet Tue 07:15 (lp:outcomes --commit); Mac launchd | None (internal) | None | launchctl bootout gui/501/com.seq.boss-scooter-sheet | other repo (boss-os scripts/ops/lp-outcomes.mjs; chassis copy) | SUSPECTED | Monique | Send code read; not confirmed that --commit sends on every run (an --email-only flag exists). |
| `topbarz-verification` | Top Barz vote verification code, to the voter | Top Barz Voting <topbarz@joinwestpeek.com> | Resend | Pages Function on vote; Cloudflare on event | None | None (transactional) | Remove RESEND_API_KEY from the topbarz-voting project | other repo (topbarz-voting functions/_lib/config.js, verify.js) | CONFIRMED | Porter (West Peek OS) |  |
| `westpeek-live-mail` | West Peek Live sign-in and event-request emails, to the user | notifications@events.westpeek.live (forced to the verified domain) | Resend | Server actions on sign-in / event request; Cloudflare on event | Brand reply-to | None (transactional) | Remove its RESEND_API_KEY | other repo (westpeek-live services/email/emailService.ts, lib/auth/actions.ts, lib/actions/requestEventActions.ts) | CONFIRMED | Porter (West Peek OS) |  |
| `community-lead` | joinwestpeek.com site-form lead, to a managing partner's westpeek.ventures address (LEAD_TO / COMMUNITY_ASSESSMENT_TO) and the Network OS sheet | EMAIL_FROM (project variable) | Resend | Pages Function /api/lead on submit; Cloudflare on event | None (internal) | None | Unset EMAIL_FROM on the join-west-peek-main Pages project | other repo (join-west-peek-main functions/api/lead.js) | CONFIRMED | Porter (West Peek OS) |  |
| `network-os-introductions` | West Peek Network OS double-opt-in introductions, to the introduced contacts | Gmail account behind the OAuth token | Gmail API gmail.send | POST /api/introductions/send; Cloudflare (inert) | n/a | Human-initiated | Introductions retired 27 Sep 2026; delegation excludes gmail.send | other repo (west-peek-network-os functions/api/introductions/send.ts) | SUSPECTED | Porter (West Peek OS) | Route still in code; not called by any schedule. |
| `twin-lp-outreach` | LP outreach campaign (571 sent Aug to Sep 2026), to LPs | The owner's westpeek.ventures address | Twin (external agent service) | Twin's own schedule; External SaaS | Unknown | Unknown | Twin dashboard only | other repo (none in any repo) | SUSPECTED | Monique | Current state not verifiable from the repos; its discovery engine is paused (11 Oct 2026). |
