# Operations — how West Peek OS behaves in production

Repo how-tos that are not obvious from the code, each with the file that owns it. Deploying is
[DEPLOYING.md](DEPLOYING.md); Meet and calendars are [GOOGLE_MEET.md](GOOGLE_MEET.md); outbound mail
is [OUTBOUND_EMAIL_MAP.md](OUTBOUND_EMAIL_MAP.md). Business facts (who the firm sells to, deadlines,
rulings) are not kept here: they live in the West Peek Ventures company brain in Boss OS.

## The Mac's identity

- The Mac (Meet listener and seat claimer) has its own Cloudflare Access service token,
  `WP_OS_MAC_ACCESS_CLIENT_ID` / `_SECRET`. Its id is synced to the Worker as
  `WP_OS_CLAIMER_CLIENT_ID` through `scripts/vault/cloudflare-mapping.json`.
- `auth.ts` resolves `CF_ACCESS_CLIENT_ID` to the browser agent first, so one token can never be
  both. **If the listener heartbeat returns 403, check those three places before the code.** The
  listener runs on the Mac as the launchd job `ventures.westpeek.os.meet-listener`.
- The three Mac pieces (`local-jobs`, `seat-claimer`, `meet-listener`) are always on (KeepAlive).
  When the Mac is offline they log `fetch failed` cycles: that means running without a network,
  not dead. Check `launchctl list | grep westpeek` before treating them as down.

- **How landed code reaches the Mac (#355).** When idle, `local-job-claimer.mjs` (`pullMainIfClean`)
  puts a clean checkout back on `main` and fast-forwards it; all three pieces then restart
  themselves on the new HEAD (the listener only with no call open). A checkout it cannot update
  (uncommitted changes, a diverged main) rides on its heartbeat as `code-stuck:<why>` and shows as
  the `mac_code` health check, DOWN, which the escalation sends to both partners.

## How work moves

- **The sweep.** `employee_work_sweep` (every 5 minutes, `src/worker/services/workSweep.ts`) claims
  the oldest waiting AI-owned card (the lease is the lock) and ends it DONE or BLOCKED; three failed
  attempts end it BLOCKED. The cron runs one due job per tick (`runDueJobs`, `limit` 1).
- **A scheduled duty** is a `scheduled_job` row of kind `EMPLOYEE_TASK` targeting an employee, plus a
  `job.job_key === "…"` branch in `services/jobs.ts` that opens the period's card (title-unique per
  week or month); the sweep works the card. Seed it with `INSERT … SELECT … WHERE NOT EXISTS`
  (`tests/seededJobs.test.ts`) and describe it in `JOB_FACTS` (`src/shared/work/scheduledWork.ts`).
- **A duty on her clock.** A `scheduled_job` row with `daily_at_tz = 'America/Chicago'` reads
  `daily_at_utc` as a Chicago wall clock (and `day_of_week` as the Chicago weekday), so the clock
  change never moves it (`computeNextRun` → `nextInZone`, 0193). Use it for anything she chose by her
  clock; a bare UTC hour is 08:00 in winter and 09:00 in summer.
- **The Monday/Tuesday schedule (rebalanced 1 Nov 2026, migration 0288):** Wynn's TLC brand batch
  Monday 08:00 Central; Wynn's Monday roundup from 08:30 Central (`ROUNDUP_LOCAL` in
  `services/tlcRoundup.ts`, sent by the first drip tick after it); Walker's West Peek Productions hire
  search Tuesday 09:00 Central. All three on the Chicago clock.
- **Retiring an employee** is removing them from `src/shared/registry/aiEmployees.ts`, changing
  `EXPECTED_ROSTER_SIZE`, and running `node scripts/seed/generate-ai-employee-seed.mjs`, which
  writes the `NNNN_ai_employee_retire.sql` migration. Rows are set RETIRED, never deleted.
- **"Employee, tell a partner …"** is the `PARTNER_MESSAGE` card kind
  (`src/shared/intake/partnerMessage.ts`, `src/worker/services/partnerMessage.ts`): "Porter, tell
  Scooter: …". Never a hand-written Resend script. Search `git log --all` before deciding a
  mechanism does not exist.
- **Porter's website cards.** A partner's new-subject email about a site joins their open
  WEB_PROPERTY_CHANGE card for that property (`openSiteCardFor`: one open card per partner per
  property), and a follow-up answers any block. A closed-lid Mac is a wait, never "Blocked". A
  CHANGES rebuild must move the branch head (`changed: true`) or it counts as a failed attempt, so
  the same preview is never sent twice.
- **Reply matching.** Gmail replies carry only the SES Message-ID, so the `Re:`-subject fallback is
  the path that actually matches them.
- **Wynn never drops a brand's thread** (13 Nov 2026; `services/tlcBrandThread.ts`). Every brand
  email after the first is a reply on that brand's conversation in her mailbox: an answer on the
  thread of the brand message it answers, a follow-up on the thread of the last email we sent that
  address (answering the Message-ID Gmail really gave it; Gmail replaces the one we supply). No
  conversation found means `NAMED STOP [TLC_BRAND_THREAD_NOT_FOUND]` and nothing goes out; the last
  door (`brandMailAsOwner` in `effects/executor.ts`) refuses any such email without Gmail's thread
  id and an In-Reply-To (`TLC_BRAND_THREAD_REQUIRED`).
- **The same email again after 7 quiet days** (`resendUnanswered` in `services/tlcBrandReply.ts`).
  Armed one answer at a time, on her word only: one `tlc_setting` row, key
  `brand_reply_resend:<tlc_brand_reply id>`, value `{"state":"ARMED","due":"<ISO>","note":"<her
  words>"}`. Each drip pass: any message from the brand cancels it; never before 7 full days after
  the answer went; then once, the sent request's own subject, words, copies and PDF, on the brand's
  thread. The run summary carries `pricing follow-ups: OUTPUT <n> resend_sent (...)`; the row keeps
  what happened; a stop only a person can clear is `STOPPED` there and emailed to her.
- **"Show me first"** preview is off firm-wide (migration 0258). A held email on Home means a
  per-card tick, not the firm setting.

## The health board

- Willow's "X is down" comes from `/api/diagnostics/health` (`services/health.ts`,
  `services/healthEscalation.ts`). Read the check's query and its rule before the machine: the fault
  may be in the judgement. Partner briefs are on demand only, never scheduled.

## Forms on the West Peek sites

- Forms on joinwestpeek.com and westpeek.ventures post to `/api/lead` with a `lead_type`. Each
  submission goes to Network OS `/api/intake/site-form` and lands in the master network sheet's
  `contacts` tab, deduped by email. The register and its check live in the site repo
  (`join-west-peek-main`: `shared/forms-register.json`, rule FORM-10 in `scripts/validate_forms.mjs`).
  Client-service properties (West Peek Productions, westpeek.live) never feed it.
- The community Pages project is `join-west-peek-main` (alias `west-peek-community.pages.dev`);
  only its production environment carries the Network OS intake variables. Network OS health is
  `https://network.joinwestpeek.com/api/health` (`siteFormIntake.ready`).

## Calendars and Meet

- West Peek OS impersonates only the West Peek mailbox and calendar and never reads the spry.vc
  calendar; LP and broker meetings never join the live Meet media stream. Both are guarded in code;
  the detail and the validators are in [GOOGLE_MEET.md](GOOGLE_MEET.md).

## Tests

- **Wall-clock fixtures.** `inQuietHours` (`services/notifications.ts`) treats `end` as exclusive,
  so a "whole clock" `{ start: 0, end: 23 }` fixture goes red only between 23:00 and 23:59 UTC.
  Check the fixture before blaming whatever merged that hour.
- **Test that the product has content, not only behaviour.** In August 2026, 959 green tests sat
  beside zero rows in production.

## Model routing

- `perplexity/sonar` needs a pricing row before it is routable, and `liveSearch` refuses an answer
  from a model that cannot search (`tests/modelRegistry.test.ts`).
