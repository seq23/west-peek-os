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

## Tier 3 — scope: a Meet Add-on hosting the During face

- **Eligibility: CONFIRMED** — "Supplemental add-ons ON" in the westpeek.ventures admin console.
- **What it is.** A Meet Add-on is a web app rendered in Meet's side panel (and optionally the main
  stage), declared in a Google Cloud project's add-on manifest and installed for the org. The side
  panel would host Phase C's During face: the live prompts, the seated employee, the running notes,
  reading and writing through this Worker's existing `/api/meetings/:id/*` routes.
- **What it needs.** (a) The Add-ons SDK (`@googleworkspace/meet-addons`) loaded in a page this
  Worker serves; (b) an add-on deployment in project `gsc-automation-493801` with a manifest naming
  the side-panel URL; (c) the page must be reachable from inside Meet's iframe — which means an
  Access policy for that path or a signed, short-lived link, because Access answers the iframe with
  a 302 today (the same wall the push endpoint hit); (d) the meeting id: the add-on can read the
  Meet meeting code (`meetingInfo`) and this Worker resolves it through `meeting.meet_conference_id`,
  which tier 1 already fills.
- **Not built** because the During face is Phase C's, and the Access decision (c) is the owner's.

## Tier 4 — scope: the Meet Media API live path

- **Eligibility: CONFIRMED** — "Media API ON" in the admin console (it is a Developer Preview
  feature gated per org).
- **What it is.** A WebRTC client that joins a conference as a participant and receives audio
  (and video) streams in real time, plus a metadata channel of who is speaking. It is the only
  Google-native way to get words DURING the call rather than after it.
- **What it needs.** A long-lived WebRTC peer — not a Cloudflare Worker request. The realistic
  host is the seat already on her Mac (`scripts/claimer/`), joining as the firm with the
  service-account grant (`meetings.space.readonly` plus the Media API scope
  `meetings.conference.media.readonly`, not yet delegated — one more scope string to paste), and
  feeding audio to the existing `captureChunk` path, which already transcribes slices and files
  them through the same two gates as everything else.
- **Consent.** A Media API participant is visible in the call as a participant and Meet announces
  it; the same `google_meet_announced` basis applies, and the same exclusions.
- **Not built** because it is a live room, which is Phase C's, and it depends on a preview API whose
  terms should be read before the firm joins calls with it.

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
  with `platform: "GOOGLE_MEET"` only from `meetIngest.ts`, never from a request.
- `meet_event_inbox` rows for "what came of the call": `state`, `turns`, `unattributed_turns`,
  `transcript_ref`, `recording_ref`, `transcript_import_id`.
- `PLATFORM_CONSENT_BASIS` and `MEET_PROVIDER` from `services/meetIngest.ts`; `provider_name =
  'GOOGLE_MEET'` on `transcript_import` is how the After face knows a transcript is Meet-native.

## Proof

- `tests/calendarSync.test.ts` (12) and `tests/meetIngest.test.ts` (11) against a fake Google whose
  service account carries a real RSA key, so the JWT path runs for real.
- `npm run validate:calendar-sync` and `npm run validate:meet-ingest`, each with a self-test and a
  negative proof recorded in the PR (a planted spry mailbox; a join that guesses).
- `npm run vault:run -- node scripts/meet/probe-google.mjs [--subscribe]` — the live table above,
  12 checks, 0 not confirmed on 18 Sep 2026 (one UNPROVEN until the first real call ends).
