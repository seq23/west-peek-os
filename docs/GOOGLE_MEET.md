# Google Meet, seamless — Phase Meet (18 Sep 2026)

Owner-approved 18 Sep 2026: make Google Meet seamless. Tiers 1 and 2 are built and proven here;
tiers 3 and 4 are scoped at the end with what the probe found about eligibility.

**Owner correction, 18 Sep 2026, verbatim intent:** *"West Peek OS does NOT read the spry.vc
calendar for anything — Boss OS reads that one, never West Peek OS."* So the one calendar this
system reads is `sequoia@westpeek.ventures`; every synced meeting carries `firm_scope = 'west-peek'`;
the spry.vc grant was deliberately NOT made; and `npm run validate:calendar-sync` hard-fails if a
spry.vc address, a `staylor@` mailbox or the spry iCal key appears in any calendar or Meet code
path. The two businesses never blend, and that validator is the guard that keeps it so.

## The probe (read-only, via `npm run vault:run`, 18 Sep 2026)

Every row was run against Google with the firm's service account
(`gsc-bot@gsc-automation-493801.iam.gserviceaccount.com`, client id `109529914046573753934`)
impersonating `sequoia@westpeek.ventures` under domain-wide delegation. "The exact call" is what
proved it; `scripts/meet/probe-google.mjs` re-runs the whole table through the Worker's own client.

**Who reads a conference record (found 20 Sep 2026).** Meet releases a record only to the room's
owner or someone who was in the call — `conferenceRecords.list` omits the rest, `get` answers 403.
Both firm rooms (`svf-nzzr-pax`, `okf-vjho-uqc`) are Scooter's events, so as `sequoia@` the job
listed **0 records in either room** for a day and failed hourly on the first Pub/Sub event
(`google_forbidden`, 10 attempts); as `scooter@` the same record read and four records were visible.
The ingest now tries every partner in turn (`meetReaders` in `meetIngest.ts`, from the partner
registry), refuses a record no partner may read, and refuses any row at `MEET_READ_ATTEMPTS_CAP`
attempts. Pinned in `tests/meetIngest.test.ts`; `scripts/meet/probe-record.mjs <record>` asks Google
the same question live, as each partner.

| Question | Finding | The exact call that proved it |
|---|---|---|
| Can the firm read the partner calendar as the firm? | **CONFIRMED.** 10 events ±30d, all with a Meet link; `conferenceData.conferenceId` is the meeting code | `GET calendar/v3/calendars/primary/events?conferenceDataVersion=1&singleEvents=true` → 200 |
| Which Workspace edition? | **SUSPECTED Business Standard or above** on westpeek.ventures: Drive quota reports a 20 TB pooled limit, which is not a Starter allowance. Not read from the Admin SDK (no directory scope) | `GET drive/v3/about?fields=storageQuota` → `limit 21990232555520` |
| Are `meet.googleapis.com`, `workspaceevents.googleapis.com`, `pubsub.googleapis.com` enabled? | **CONFIRMED enabled** — all three were disabled and were enabled by the project owner's account (authorised) | `gcloud services enable … --project=gsc-automation-493801` → "finished successfully"; `gcloud services list --enabled` lists all three |
| Is the Meet REST API v2 reachable at all? | **CONFIRMED.** The API answers; the first probe under impersonation failed at the TOKEN endpoint, not the API | plain service-account token, `GET meet/v2/conferenceRecords` → 200 |
| Were the Meet scopes delegated? | **Was a STOP; now CONFIRMED.** First probe: all three Meet scopes → `401 unauthorized_client` at `oauth2.googleapis.com/token` (the grant, not the API). Owner added them in the westpeek.ventures admin console the same day; re-probe: all three mint | `POST oauth2.googleapis.com/token` with `sub=sequoia@…` and each of `meetings.space.readonly`, `meetings.space.created`, `meetings.space.settings` → 200 |
| Can conferenceRecords / participants / transcripts / recordings be read for firm-hosted meetings? | **CONFIRMED for the list; UNPROVEN for the children** — 0 records are visible yet (no call has been held under the grant), so participants/transcripts/recordings have not been read live. The Worker's read path is proven against a fake Google (`tests/meetIngest.test.ts`) and the first real call proves it live | `GET meet/v2/conferenceRecords?pageSize=25` → 200, `[]`; `GET meet/v2/spaces/svf-nzzr-pax` → 200 `spaces/94r-Po-Zd7MB` |
| Does Workspace Events accept a subscription for Meet events? | **CONFIRMED, per SPACE.** A user-target subscription (`//cloudidentity.googleapis.com/users/{email\|me}`) is refused `TARGET_RESOURCE_ACCESS_DENIED` — it wants the account's numeric id, which no delegated scope reveals (`openid` → `unauthorized_client`). A space-target subscription is created and ACTIVE for seven days | `POST workspaceevents/v1/subscriptions {targetResource: "//meet.googleapis.com/spaces/94r-Po-Zd7MB", …, pubsubTopic}` → 200, `subscriptions/meet-spaces-0c46b0b8-…` ACTIVE until 2026-09-26; renew via `PATCH …?updateMask=ttl` → 200 |
| Can the Worker receive a Pub/Sub PUSH? | **CONFIRMED NO.** Both hosts sit behind Cloudflare Access and answer an unauthenticated POST with a 302 to the login page. A push endpoint here would receive nothing and say nothing | `curl -X POST https://os.joinwestpeek.com/api/meet/events` → 302; same on `west-peek-os.seq-taylor.workers.dev` |
| Can the Worker PULL from Pub/Sub? | **CONFIRMED.** Topic `meet-events` (publisher: `meet-api-event-push@system.gserviceaccount.com`) and pull subscription `meet-events-wpos` (subscriber: the service account) created by the project owner | `POST pubsub/v1/projects/gsc-automation-493801/subscriptions/meet-events-wpos:pull` as the service account → 200 |
| Is auto-transcription a settable admin policy? | **CONFIRMED (owner's console, reported by the coordinator 18 Sep 2026):** Recording ON, Meeting transcripts ON, *Automatic transcription ON* for westpeek.ventures. Not readable through any granted API, so from this side it is proven by the first ended call that carries a `FILE_GENERATED` transcript | Admin console › Apps › Google Workspace › Google Meet › Meet video settings |
| Can auto-transcription be set per space via the API? | **SUSPECTED.** `meetings.space.settings` mints (CONFIRMED) and `spaces.patch` accepts `config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration`, but a GET of a calendar-created space returns no `config`, so there is nothing to read back, and a PATCH is a write to Google that this phase does not make. The admin policy covers it; the API path is left unbuilt on purpose | `GET meet/v2/spaces/svf-nzzr-pax` → 200 with no `config` field |
| Is the Meet Media API available? | **CONFIRMED eligible (owner's console: "Media API ON")**; not exercised — it is tier 4 | Admin console setting, reported 18 Sep 2026 |
| Are Meet add-ons allowed? | **CONFIRMED (owner's console: "Supplemental add-ons ON")**; not exercised — it is tier 3 | Admin console setting, reported 18 Sep 2026 |
| Does the private iCal door work? | **CONFIRMED.** 147 VEVENTs from the vault's `CAL_ICS_WESTPEEK` | `GET <private ics url>` → 200 `BEGIN:VCALENDAR` |

## What was built

### Tier 1 — the calendar becomes meetings (`sjb_calendar_sync`, hourly)

- **One meeting per Meet event**, keyed by `(calendar_key, google_event_id)` with a UNIQUE index
  (migration 0202). Recurring series arrive expanded, one meeting per occurrence. Cancelled events
  become CANCELLED meetings. Events without a Meet link are skipped by name.
- **Two doors, one ledger.** Calendar API under delegation first; the private iCal URL when the API
  fails, and `google_calendar_sync.last_via = 'ics'` says so. The iCal UID is normalised to the API
  id so the doors agree on identity — found and fixed by the validator's own fixture.
- **Type inferred once, then a person's.** Only firm addresses → INTERNAL; a known LP contact → LP
  (privacy `LP_PRIVATE`); a known company domain (`canonical_company.website`) → FOUNDER, linked; else
  FOUNDER with `type_inference = 'UNKNOWN_CHECK_IT'` and the card says "type inferred, check it".
  Title, time and attendees follow the calendar on every sync; the type never flips back.
- **Join affordance** on the upcoming card (`data-testid="join-<id>"`). Phase D redesigns the card.
- **Every write authorised**: `calendar.sync` (ordinary), participants through `meeting.participant.add`,
  cancellations through `meeting.update`. Actor is SYSTEM in `west-peek`.
- Routes: `GET /api/meet/calendar` (the ledger), `POST /api/meet/calendar/sync` (run now).

### Tier 2 — after the call (`sjb_meet_ingest`, hourly)

- **Hears two ways, reads once.** Each tick: keep one Workspace Events subscription per Meet space
  the calendar knows (`meet_space_subscription`, renewed inside 24h of expiry); pull the firm's
  Pub/Sub subscription; poll `conferenceRecords` for every calendar meeting whose start has passed
  and has no inbox row. All three land in `meet_event_inbox`, UNIQUE on `conference_record`, so
  however many times a conference is heard about it is one row and one read.
- **Reading a row:** participants (added to the meeting by display name), transcript entries
  joined to participants BY RESOURCE NAME — an entry Meet did not attribute, or attributed to a
  participant not in the list, is kept with `speaker: null` and renders as "Speaker not named in
  the export", exactly as the Fireflies parser does. The recording's Drive file id and the
  transcript's Docs id go on the meeting (`recording_ref`, `transcript_ref`); the bytes stay in Drive.
- **The two gates are not relaxed.** `importTranscript` still requires an activated recording policy
  and GRANTED transcription consent, and records a REFUSED row when either fails. What changed is
  WHO presses the button: a SYSTEM actor may import when — and only when — `platform: "GOOGLE_MEET"`
  is set, and that field is not on any request schema (`validate:meet-ingest` proves it).
- **The recording policy is the firm's default, decided once.** `meeting.recording_policy.activate`
  is reserved per meeting and cannot be delegated to a job. The owner's decision was one decision:
  transcription on by policy for every firm-hosted Meet. So `meet.recording_policy.firm_default` is
  ONE reserved action with ONE approval card, recorded in `meet_recording_policy`, and every meeting
  the ingest reads points its `recording_policy_receipt_id` at that card. Until it is on, every ingest
  is REFUSED as a row that names the door: `POST /api/meet/recording-policy {action:"activate",
  approval_receipt_id}`. Rows refused for that reason are read once it turns on.
- **Consent is recorded on the platform's announcement.** Google Meet announces recording and
  transcription to every participant and shows the indicator throughout; a participant who remains
  has been told, in the room, before any words were captured. `recordPlatformAnnouncedConsent`
  writes GRANTED rows for TRANSCRIPTION and RECORDING with basis `google_meet_announced`, recorded by
  `system`. Where it does NOT apply, and the code refuses: a transcript pasted or uploaded by hand
  (Fireflies, a file — the firm did not witness the announcement); a meeting not created by the
  calendar sync (not a firm-hosted call under the firm's own policy); and the recording policy gate,
  which it never touches. The argument is written above the function in `meetIngest.ts`.
- **LP meetings stay on private lanes** because the meeting is labelled `LP_PRIVATE` at creation and
  every derived note inherits the meeting's label; the router's default-deny `provider_data_policy`
  admits that label on no training-permitting provider (`tests/meetIngest.test.ts` proves it against
  the real catalogue). Router-enforced, never a prompt-side check.
- Routes: `GET /api/meet/status`, `GET /api/meet/inbox`, `POST /api/meet/ingest` (run now),
  `POST /api/meet/recording-policy`.

### Why pull and not push

The Worker is behind Cloudflare Access; a Pub/Sub push cannot carry an Access service token and is
answered with a 302. A push route would be a webhook that never arrives — silence that looks like
success. Pulling from inside the hourly tick needs no inbound door, and the same tick polls
conference records as the fallback regardless, so the subscription is an accelerant and never the
only path.

## Named stops (for the owner)

1. **Sync the two secrets into the Worker** (one command, values never displayed):
   `npm run vault:sync:cloudflare` — the mapping now aliases `GSC_SERVICE_ACCOUNT_JSON →
   WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON` and `CAL_ICS_WESTPEEK → WP_OS_CAL_ICS_WESTPEEK`. Until then the
   two jobs report `not configured` by name.
2. **Turn the firm default on, once, in the product:** open Approvals, approve the
   `meet.recording_policy.firm_default` card for `meet_recording_policy / west-peek`, then
   `POST /api/meet/recording-policy {"action":"activate","approval_receipt_id":"<card id>"}` (or the
   button Phase D puts on the Meetings page). Until then every ended call is a REFUSED row saying so.
3. **Nothing else.** The three scopes are granted, auto-transcription is on, Pub/Sub exists, the
   two spaces on the calendar are subscribed (live, 18 Sep 2026).

## Tier 4 — the room hears the Meet LIVE (built 19 Sep 2026)

**The owner's question:** "If I push Join on Meet what happens? Is it recording? Are my AI
employees there from Join on Meet alone?" Now: when a firm-hosted Meet on the calendar is running,
the OS joins it as a participant through the Meet Media API and what it hears goes down the SAME
path the laptop microphone uses in Phase C — a slice a minute → Nova-3 (Whisper when the model is
not there) → the governed import → TRANSCRIPT_DERIVED notes — so the rolling draft, ask-the-room
and the seated employees hear the call with no new UI. `ARCHITECTURAL_DECISIONS.md` (19 Sep 2026)
records why the WebRTC peer is on her Mac and not in the Worker.

### The probe, continued (read-only, 19 Sep 2026)

| Question | Finding | The exact call |
|---|---|---|
| Is the Media API scope delegated? | **Was a STOP; now CONFIRMED** — the owner added it the same day; the token mints under impersonation | `POST oauth2.googleapis.com/token` with `sub=sequoia@…`, scope `meetings.conference.media.readonly` → 200 |
| Does the service account's own identity see the space? | **CONFIRMED NO** — the join must impersonate the partner; the bot alone is refused on the space | `GET v2/spaces/svf-nzzr-pax` without `sub` → 403 PERMISSION_DENIED; with `sub` → 200 |
| Is the Media API surface (`v2beta`) served to the project? | **CONFIRMED NO — the second STOP.** Every identity and scope combination gets Google's `404 "Method not found."` on `v2beta`, while `v2` answers 200; the `v2beta` discovery document is not served either. That is the Developer Preview gate: the project, the OAuth principal and the participants must be enrolled | `GET v2beta/spaces/svf-nzzr-pax` → 404 `Method not found`; `POST v2beta/spaces/svf-nzzr-pax:connectActiveConference` → 404 `Method not found` |
| Does the peer page's audio decode on Nova-3? | **CONFIRMED.** The exact `audio/webm;codecs=opus` slices headless Chromium produced from a spoken fixture (`tests/fixtures/meet-live-fixture.wav`) were played to Nova-3 over the Workers AI REST surface: both 200, the sentence back verbatim, 61.5 neurons for 7.9 s | `POST accounts/…/ai/run/@cf/deepgram/nova-3` ×2 → "We agreed to send the term sheet by Friday. The founder said their runway is" / "Fourteen months. Olive will confirm the commitment amount next week." |
| Does the listener's loop run against the real Google? | **CONFIRMED up to the wall** — heartbeat, `media_scope: GRANTED`, real `spaces.get` on `svf-nzzr-pax`, no active conference → `meet_not_started` on the row | `npm run vault:run -- node scripts/meet/live-listener.mjs --once --base http://127.0.0.1:9631` → `{"due":1,"active":0,"media_scope":"GRANTED"}` |

### Named stops (for the owner)

1. **Developer Preview enrolment** of project `gsc-automation-493801` (number `156361797325`) with
   `sequoia@westpeek.ventures` as the OAuth principal — applied for 19 Sep 2026; acceptance takes
   days. Until it lands every attempted join reads `meet_live_unavailable_preview` on the row with
   Google's exact message, and the listener retries every five minutes while the call is running,
   so it lights up on the first successful `v2beta` call with no redeploy.
2. **Run the listener on the Mac**: `deployment/launchd/README.md` — one plist, the same vault, the
   same Access token as the seat claimer. `--doctor` first.

### How it works

- **The listener** (`scripts/meet/live-listener.mjs`; the loop in `lib/listener-core.mjs`, the peer
  in `lib/meet-media-page.js`) heartbeats the Worker every 30 s and is told which calendar Meets
  are in their window (15 min before start to 3 h after). For each it reads the space; an
  `activeConference` means the call is running. It asks the Worker to open a session, mints the
  Media API token, creates a headless-Chromium peer (three receive-only audio transceivers, the
  `session-control` and `media-stats` channels the API requires, `media-entries` and
  `participants`), hands the SDP offer to `spaces.connectActiveConference` and the answer back.
  The three virtual streams are mixed into one track; a MediaRecorder is stopped and restarted
  every minute (each slice a complete container, as the During face's recorder does) and each
  slice is posted, in sequence, to the Worker. The conference ending — `session-control` says
  `STATE_DISCONNECTED`, or the space no longer has that active conference — leaves and reports.
- **The Worker** (`services/meetLive.ts`) holds the gates, in order, each a named state on the
  row: a calendar-synced meeting with a conference (a manual meeting has no live path; state NULL);
  the meeting-type rule; the firm recording default (0203); platform-announced consent (the same
  function and basis as tier 2, recorded once per conference); `meet.live.join` for the SYSTEM
  actor. Only then a `meet_live_session` row exists, and only against it may audio arrive.
- **LP and Broker meetings never join live** — the owner's rule, 19 Sep 2026. The Media API is
  Pre-GA and term (vi) of the Developer Preview terms lets Google use what passes through it; an LP
  conversation must never go there. Enforced at the join decision in code
  (`liveAllowedForType`, `meetLiveView.ts`), on the row as `meet_live_off_lp_policy`; those
  meetings keep the GA post-call transcript path. `validate:meet-live` plants an LP meeting and
  requires the refusal.
- **Every slice** → `transcribeWithSpeakers` → `ingestTranscript` with `platform: GOOGLE_MEET_LIVE`
  (a SYSTEM-actor import under the platform-announced consent, exactly like tier 2's
  `GOOGLE_MEET`; the field is on no request schema) → notes carrying the meeting's label. Every
  `ROLL_EVERY_MS` with new words, the After DRAFT rolls through Phase B's drafter — a draft, never
  a record; `validate:voice-is-read-only` still holds.
- **Two sources of one call.** The official transcript is authoritative for After; when tier 2
  reads it, every live import for the meeting gets `superseded_by` and the note readers that feed
  the draft and the room's context skip them. The live notes stay on the record as corroboration.
- **The end-of-call signal** is one column, `meeting.call_ended_at` (0216), written by the
  listener or the ingest, whichever learns it first. The During face and the side panel read it.
- **States on the row** (`meeting.meet_live_state`, detail in `meet_live_detail`; `GET
  /api/meetings/:id/room` returns them as `meet_live`): `meet_not_started`, `meet_live_joining`,
  `meet_live_listening`, `meet_live_ended`, `meet_live_no_listener`, `meet_live_unavailable_scope`,
  `meet_live_unavailable_preview`, `meet_live_unavailable_edition` (Google's exact error in the
  detail), `meet_live_unavailable_policy`, `meet_live_off_lp_policy`, `meet_live_failed`, and NULL
  for a meeting the live path does not apply to.
- **Cost per hour of call**, measured: Nova-3 at 7.8 neurons/s on the peer's real slices →
  ~28,000 neurons/hour → **$0.31/hour** after the free 10,000 neurons/day (~21 minutes free).
  The rolling draft: at most one run per five minutes with new words, on the ladder's free-first
  lanes; the session row carries `neurons`, `seconds_heard` and `drafts_rolled`, and
  `GET /api/meet/live/status` reports `cost.usd_per_hour` from what the platform actually billed.
- Routes, one block `// === Meet live ===`: `POST /api/meet/live/heartbeat`,
  `POST /api/meet/live/sessions`, `POST /api/meet/live/sessions/:id/report`,
  `POST /api/meet/live/sessions/:id/chunk` (listener identity only); `GET /api/meet/live/status`,
  `GET /api/meet/live/resolve?code=`, `POST /api/meet/live/adopt` (partners).

## Tier 3 — the Meet Add-on side panel (built 19 Sep 2026)

- **`#/meet-panel`** (`src/client/pages/MeetPanel.tsx`) is the During face beside the call: inside
  Meet the Add-ons SDK (`https://www.gstatic.com/meetjs/addons/1.1.0/meet.addons.js`,
  `createAddonSession({ cloudProjectNumber })` → `createSidePanelClient()` → `getMeetingInfo()`)
  names the call; `GET /api/meet/live/resolve?code=` turns the code into the meeting the calendar
  sync created (the nearest occurrence); the same `RoomPanel` as `#/room/<id>` renders, narrow.
  Not on the record → "This call is not on the record" with one action, **Record this meeting
  now** (`POST /api/meet/live/adopt`: an ordinary meeting carrying the code, FOUNDER /
  `UNKNOWN_CHECK_IT`, `source = 'manual'` — so the live path does not apply and the room records
  the way Phase C does). Once `call_ended_at` is set → **Open what came out of it** → the full After
  face in the main app (`#/meetings?open=<id>&face=after`).
- **Auth inside the iframe, decided: her own session cookie.** Cloudflare Access answers an iframe
  on meet.google.com only if the application sends `CF_Authorization` with `SameSite=None` — it
  was unset on both Access applications (probed 19 Sep 2026, read-only), so the panel would have
  loaded as the login page, which cannot be framed. A service token cannot live in a browser page;
  an Access application "for the add-on origin" has nothing to verify. **Set the same day** on the
  os.joinwestpeek.com application (AUD `3ee619ef…`) through the Cloudflare API with the vault
  token, verified on the response: `SameSite=None`, `HttpOnly` kept. The cost — a cross-site form could POST with her cookie — is closed
  in the Worker: a state-changing `/api` request whose `Sec-Fetch-Site` is not `same-origin`/`none`
  is refused 403 before any handler (`index.ts`, pinned in `tests/meetLive.test.ts`). If the cookie
  is absent the panel offers "Open West Peek OS" (a tab to sign in) and "Try again".
- **Registration.** The service account cannot: the Google Workspace Add-ons API is not enabled on
  the project and `cloud-platform` is not delegated (probed). The deployment file is
  `deployment/meet-addon/deployment.json` (checked against `src/shared/meetings/meetAddon.ts`);
  the four commands are in its `_README` — enable `gsuiteaddons.googleapis.com`, `gcloud
  workspace-add-ons deployments create west-peek-os-meet --deployment-file=…`, `… install
  west-peek-os-meet`. Org-wide is a private Marketplace listing, optional.
- Proven in the browser: `e2e/p73-meet-panel.spec.ts`.

## The doors onto a call, and the hooks the live path wires (19 Sep 2026, PR #130)

- **One room per meeting, several doors.** `CallDoors.tsx` renders, beneath "Go to this meeting":
  `Join on Meet` two ways remembered per viewer — *Inside the call* (the Tier 3 add-on; until
  `meetAddonInstalled()` is true it says so and falls back) and *Beside the call* (the Meet in a new
  tab, the narrow room `#/room/<id>` in this one) — and `Use my laptop mic for this Meet call`
  (`#/room/<id>?mic=1`: the room's own consent prompt opens on arrival; chunks are stamped
  `provider_name = 'LAPTOP_MIC'`). Every press posts `POST /api/meetings/:id/started` so the row is
  in progress from the event (migration 0214, `markMeetingStarted`).
- **Named hooks in `src/shared/meetings/meetJoin.ts`** for `feat/meet-media-live`:
  `meetAddonInstalled()`, `liveMeetPathAvailable(meeting)` (the laptop-mic control yields to it and
  says so), and `CALL_ENDED_SIGNAL = meeting.call_ended_at` — #131's column (ISO, null until the
  call ends; first writer wins between the live listener's ENDED report and the ended-call ingest
  from Google's end time), served as `facts.call_ended_at` by `GET /api/meetings/:id/hearing`. On
  this head the column does not exist, so the field is served null and Google's end time on the
  inbox row (`facts.meet.conference_ended_at`) stands in — `callIsOver` reads both. The narrow room
  shows "Open what came out of it" (back to `#/meetings?open=<id>&face=after`; an unknown `face`
  lands on Before) once the call is over or the meeting is HELD. The live path calls
  `markMeetingStarted(env, actor, id, "conference_started", at)` when it sees it start. The add-on
  panel renders `<RoomPanel meetingId standalone />` — the same component as `#/room/<id>` — so the
  narrow layout applies inside its 360px shell with no further wiring.
- **`howTheRoomHears.ts` keeps its shape** — facts in, one named state with one sentence and one
  chip out — so the live path's `MEET_LIVE_*` states are added as rows, not as a rewrite.

## What Phase C should call

- `meeting.meet_conference_id` / `meeting.meet_link` — the space the During face is inside.
- `GET /api/meet/status` — is the door open (policy on, subscriptions live, inbox counts).
- `captureChunk` (`services/liveTranscription.ts`) for anything captured live; `ingestTranscript`
  with `platform: "GOOGLE_MEET"` only from `meetIngest.ts` and `"GOOGLE_MEET_LIVE"` only from
  `meetLive.ts`, never from a request.
- `meet_event_inbox` rows for "what came of the call": `state`, `turns`, `unattributed_turns`,
  `transcript_ref`, `recording_ref`, `transcript_import_id`.
- `PLATFORM_CONSENT_BASIS` and `MEET_PROVIDER` from `services/meetIngest.ts`; `provider_name =
  'GOOGLE_MEET'` on `transcript_import` is how the After face knows a transcript is Meet-native.

## Proof

- `tests/calendarSync.test.ts` (12), `tests/meetIngest.test.ts` (11) and `tests/meetLive.test.ts`
  (24 — the listener's real loop against a fake Meet media server and a fake Nova-3) against a fake
  Google whose service account carries a real RSA key, so the JWT path runs for real.
- `npm run validate:calendar-sync`, `npm run validate:meet-ingest` and `npm run validate:meet-live`,
  each with a self-test and a negative proof recorded in the PR (a planted spry mailbox; a join that
  guesses; an LP meeting let into the live stream).
- `npm run vault:run -- node scripts/meet/probe-google.mjs [--subscribe]` — the live table above,
  12 checks, 0 not confirmed on 18 Sep 2026 (one UNPROVEN until the first real call ends).
