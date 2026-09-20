import { z } from "zod";
import type { Env } from "../env";
import type { FirmUserIdentity } from "../auth";
import { SUBSCRIPTION_CLAIMER_EMAIL } from "../auth";
import { appendEvent } from "../events";
import { json } from "../router";
import type { RouteContext } from "../router";
import { authorize, canAccessPrivacyLabel, type Actor } from "./authorize";
import { importTranscript, transitionMeeting, type MeetingRow } from "./meetings";
import { ingestTranscript } from "./captureAdapter";
import { firmRecordingPolicy, recordPlatformAnnouncedConsent, MeetIngestError } from "./meetIngest";
import { transcribeWithSpeakers, type ChunkResult } from "./liveTranscription";
import { TranscriptionUnavailable } from "../ai/providers/workersAiWhisper";
import { ROLL_EVERY_MS, rollSummary } from "./meetingRoom";
import { AUDIO_CONTENT_TYPE } from "./meetingRoom";

/**
 * Tier 4 — the room hears the Meet LIVE (Phase Meet; owner-approved 19 Sep 2026).
 *
 * "If I push Join on Meet what happens? Is it recording? Are my AI employees there from Join on
 * Meet alone?" This module is the answer. When a firm-hosted Meet on the calendar is running, the
 * OS joins it as a participant through the Meet Media API and what it hears goes down the SAME
 * path the laptop microphone uses in Phase C: a slice of audio → `transcribeWithSpeakers`
 * (Nova-3, Whisper when the model is not there) → `ingestTranscript` → `importTranscript`, the
 * two gates every transcript passes. So the rolling draft, ask-the-room and the seated employees
 * hear the call with nothing new on the screen.
 *
 * WHO HOLDS THE CALL, and why it is not this Worker. A Media API session is a WebRTC peer — ICE
 * over UDP, DTLS, SRTP, Opus at 48 kHz, three virtual audio streams, held for the length of the
 * call. A Worker has `fetch`; a Durable Object has the same runtime; a Container could do it and
 * would be a new paid product with a browser image inside it. Google's reference client runs in
 * Chrome. So the peer is `scripts/meet/live-listener.mjs` on the owner's Mac — headless Chromium
 * through the Playwright the repo already carries — and THIS module is everything that decides:
 * which meetings are due, whether a session may open, what the consent record says, what the
 * meeting row tells the During face, and the import of every slice. The listener is a pair of
 * ears that presents the same Access service token the seat claimer does (`auth.ts`); it can open
 * nothing this module refuses.
 *
 * THE GATES, in the order they are checked, each a named state on the meeting:
 *   1 · the meeting was created by the calendar sync and carries a Meet conference — a manual
 *       meeting has no live path at all (409 `not_firm_hosted`; its state stays NULL);
 *   2 · the meeting's TYPE may join the media stream — LP and Broker meetings never do (the
 *       owner's rule, 19 Sep 2026; the reason is term (vi) of the Developer Preview terms, written
 *       above `liveAllowedForType` in meetLiveView.ts) — else `meet_live_off_lp_policy`;
 *   3 · the firm's Meet recording default is on (0203) — else `meet_live_unavailable_policy`;
 *   4 · consent is recorded on the platform's announcement (`recordPlatformAnnouncedConsent`,
 *       the same basis and the same exclusions as the ended-call ingest);
 *   5 · `meet.live.join` is authorised for the SYSTEM actor in the meeting's firm scope.
 * Only then is a session row written, and only against that row may audio arrive.
 *
 * NOTHING WRITES FROM VOICE, still. A slice becomes TRANSCRIPT_DERIVED notes through the governed
 * import and, every `ROLL_EVERY_MS`, the After DRAFT through Phase B's drafter — the same two
 * writes the During face makes, and a partner still clicks to make any of it a record.
 *
 * TWO SOURCES OF ONE CALL. The official Meet transcript (tier 2, `GOOGLE_MEET`) is authoritative
 * for the After face; the live notes (`GOOGLE_MEET_LIVE`) are corroboration. When the official
 * transcript lands, `supersedeLiveImports` marks every live import for the meeting and the note
 * readers that feed the draft and the room's context skip them — kept on the record, read once.
 *
 * LP MEETINGS STAY ON PRIVATE LANES because every derived note inherits the meeting's label and
 * the drafter derives `confidential` from the meeting; the audio itself goes only to Workers AI
 * with `mip_opt_out`. `validate:meet-live` reads this file and the listener and fails the build
 * if audio can reach any other host.
 */

export class MeetLiveError extends Error {
  constructor(public status: number, public code: string, detail?: string, public state?: MeetLiveState | null) {
    super(detail ?? code);
  }
}

export { LIVE_PROVIDER, NOT_SUPERSEDED_NOTE_CLAUSE } from "./meetLiveNotes";
export { MEET_LIVE_STATES, LISTENER_STALE_MS, DUE_BEFORE_MS, DUE_AFTER_MS, LIVE_EXCLUDED_MEETING_TYPES, isFirmHostedMeet, liveAllowedForType, meetLiveView, type MeetLiveState, type MeetLiveView } from "./meetLiveView";
import { LIVE_PROVIDER } from "./meetLiveNotes";
import { MEET_LIVE_STATES, LISTENER_STALE_MS, DUE_BEFORE_MS, DUE_AFTER_MS, LP_POLICY_DETAIL, isFirmHostedMeet, liveAllowedForType, type MeetLiveState } from "./meetLiveView";

/** What the join costs to speak, for the ledger: Nova-3 ≈ 470 neurons a minute (probed 18 Sep 2026), $0.011 per 1,000 after the free 10,000/day. */
export const USD_PER_NEURON = 0.011 / 1000;

export interface LiveSessionRow {
  id: string;
  meeting_id: string;
  conference_record: string;
  meeting_code: string;
  listener_device: string;
  state: "JOINING" | "LISTENING" | "ENDED" | "FAILED" | "REFUSED";
  detail: string | null;
  join_identity: string | null;
  consent_transcription_id: string | null;
  consent_recording_id: string | null;
  chunks: number;
  turns: number;
  seconds_heard: number;
  neurons: number;
  drafts_rolled: number;
  last_draft_at: string | null;
  official_import_id: string | null;
  joined_at: string | null;
  ended_at: string | null;
  firm_scope: string;
  created_at: string;
  updated_at: string;
}

export interface ListenerRow {
  device_id: string;
  last_seen_at: string;
  version: string | null;
  media_scope: "UNKNOWN" | "GRANTED" | "SCOPE_MISSING" | "PREVIEW_MISSING" | "REFUSED";
  detail: string | null;
  firm_scope: string;
}

function systemActor(firmScope: string): Actor {
  return { type: "SYSTEM", roles: [], firmScopes: [firmScope] };
}

/** The listener is the Mac's service-token identity. Nobody else may open, feed or end a session. */
export function isListener(identity: FirmUserIdentity): boolean {
  return identity.email.toLowerCase() === SUBSCRIPTION_CLAIMER_EMAIL;
}

async function requireMeeting(env: Env, meetingId: string): Promise<MeetingRow> {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM meeting WHERE id = ?1").bind(meetingId).first<MeetingRow>();
  if (!row) throw new MeetLiveError(404, "not_found", "meeting not found");
  return row;
}

export async function setMeetLiveState(env: Env, meetingId: string, state: MeetLiveState | null, detail: string | null, now = new Date()): Promise<void> {
  await env.WP_OS_DB.prepare("UPDATE meeting SET meet_live_state = ?2, meet_live_detail = ?3, meet_live_updated_at = ?4 WHERE id = ?1")
    .bind(meetingId, state, detail, now.toISOString())
    .run();
}

// ── The listener says it is awake, and asks what is due ─────────────────────

export const heartbeatSchema = z.object({
  device_id: z.string().trim().min(1).max(120),
  version: z.string().trim().max(40).optional(),
  /** What the listener found when it minted a Media API token this cycle. */
  media_scope: z.enum(["UNKNOWN", "GRANTED", "SCOPE_MISSING", "PREVIEW_MISSING", "REFUSED"]).default("UNKNOWN"),
  detail: z.string().trim().max(500).optional(),
});

export interface DueMeeting {
  meeting_id: string;
  meeting_code: string;
  title: string;
  scheduled_at: string;
  meeting_type: string;
  confidential: boolean;
  policy_active: boolean;
  meet_live_state: MeetLiveState | null;
  /** False for an LP or Broker meeting: the listener reads nothing for it, and the row already says why. */
  live_allowed: boolean;
  session: { id: string; state: LiveSessionRow["state"]; conference_record: string } | null;
}

export interface HeartbeatResult {
  listener: ListenerRow;
  /** Calendar meetings with a Meet conference in the window: the listener checks each space for an active conference. */
  due: DueMeeting[];
  poll_every_ms: number;
  chunk_ms: number;
}

/** The listener posts a slice every minute, the same cadence as the laptop recorder. */
export const CHUNK_MS = 60_000;
export const POLL_EVERY_MS = 30_000;

export async function heartbeat(env: Env, identity: FirmUserIdentity, input: z.infer<typeof heartbeatSchema>, now = new Date()): Promise<HeartbeatResult> {
  if (!isListener(identity)) throw new MeetLiveError(403, "forbidden", "only the listener on the owner's Mac may heartbeat");
  const firmScope = "west-peek";
  await env.WP_OS_DB.prepare(
    `INSERT INTO meet_live_listener (device_id, last_seen_at, version, media_scope, detail, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, version = excluded.version, media_scope = excluded.media_scope, detail = excluded.detail`,
  ).bind(input.device_id, now.toISOString(), input.version ?? null, input.media_scope, input.detail ?? null, firmScope).run();
  const listener = (await env.WP_OS_DB.prepare("SELECT * FROM meet_live_listener WHERE device_id = ?1").bind(input.device_id).first<ListenerRow>())!;

  const policy = await firmRecordingPolicy(env, firmScope);
  const rows = (await env.WP_OS_DB.prepare(
    `SELECT m.id, m.meet_conference_id, m.title, m.scheduled_at, m.meeting_type, m.lp_record_id, m.meet_live_state
       FROM meeting m
      WHERE m.source = 'google_calendar' AND m.meet_conference_id IS NOT NULL AND m.status <> 'CANCELLED' AND m.archived_at IS NULL
        AND m.scheduled_at IS NOT NULL AND m.scheduled_at >= ?1 AND m.scheduled_at <= ?2
      ORDER BY m.scheduled_at ASC LIMIT 20`,
  ).bind(new Date(now.getTime() - DUE_AFTER_MS).toISOString(), new Date(now.getTime() + DUE_BEFORE_MS).toISOString())
    .all<{ id: string; meet_conference_id: string; title: string; scheduled_at: string; meeting_type: string; lp_record_id: string | null; meet_live_state: MeetLiveState | null }>()).results ?? [];

  const due: DueMeeting[] = [];
  for (const m of rows) {
    const session = await env.WP_OS_DB.prepare(
      "SELECT id, state, conference_record FROM meet_live_session WHERE meeting_id = ?1 ORDER BY created_at DESC LIMIT 1",
    ).bind(m.id).first<{ id: string; state: LiveSessionRow["state"]; conference_record: string }>();
    const allowed = liveAllowedForType(m.meeting_type);
    if (!allowed && m.meet_live_state !== "meet_live_off_lp_policy") {
      // The owner's rule, said on the row before the call even starts, so the During face never
      // shows an LP meeting as "waiting to be joined".
      await setMeetLiveState(env, m.id, "meet_live_off_lp_policy", LP_POLICY_DETAIL, now);
      m.meet_live_state = "meet_live_off_lp_policy";
    } else if (allowed && !m.meet_live_state) {
      // A firm-hosted Meet in its window with nothing said about it yet is "not started" — a state
      // the During face can render, rather than a blank that reads as "nothing will happen".
      await setMeetLiveState(env, m.id, "meet_not_started", "The Meet conference has not started; the OS joins when it does.", now);
      m.meet_live_state = "meet_not_started";
    }
    due.push({
      meeting_id: m.id, meeting_code: m.meet_conference_id, title: m.title, scheduled_at: m.scheduled_at, meeting_type: m.meeting_type,
      confidential: m.meeting_type === "LP" || m.lp_record_id !== null,
      policy_active: policy?.active === 1,
      meet_live_state: m.meet_live_state,
      live_allowed: allowed,
      session: session ?? null,
    });
  }
  return { listener, due, poll_every_ms: POLL_EVERY_MS, chunk_ms: CHUNK_MS };
}

// ── Opening a session: the gates ─────────────────────────────────────────────

export const openSessionSchema = z.object({
  meeting_id: z.string().trim().min(1).max(80),
  /** Google's conferenceRecords/{id} for the running call, read from `spaces.get().activeConference`. */
  conference_record: z.string().trim().regex(/^conferenceRecords\/[A-Za-z0-9_-]+$/, "conference_record must be conferenceRecords/{id}"),
  listener_device: z.string().trim().min(1).max(120),
  /** Which identity the peer joins as — the impersonated partner mailbox or the service account. A name, never a token. */
  join_identity: z.string().trim().max(200).optional(),
});

export async function openSession(env: Env, identity: FirmUserIdentity, input: z.infer<typeof openSessionSchema>, now = new Date()): Promise<{ session: LiveSessionRow; created: boolean }> {
  if (!isListener(identity)) throw new MeetLiveError(403, "forbidden", "only the listener on the owner's Mac may open a live session");
  const meeting = await requireMeeting(env, input.meeting_id);

  // Gate 1 — a firm-hosted Meet, or no live path at all. A manual meeting keeps a NULL state:
  // "not applicable" is not a failure to render.
  if (!isFirmHostedMeet(meeting)) {
    throw new MeetLiveError(409, "not_firm_hosted", "the live path exists only for a meeting the calendar sync created with a Meet conference; this one was typed in, or has no Meet link", null);
  }

  // Gate 2 — the meeting's type. THE OWNER'S RULE (19 Sep 2026): LP and Broker meetings NEVER
  // join the live media stream, because the Meet Media API is Pre-GA and term (vi) of the
  // Developer Preview terms lets Google use what passes through it. Enforced here, at the join
  // decision, before anything is written; the row says so; the post-call transcript still runs.
  if (!liveAllowedForType(meeting.meeting_type)) {
    await setMeetLiveState(env, meeting.id, "meet_live_off_lp_policy", LP_POLICY_DETAIL, now);
    throw new MeetLiveError(409, "lp_policy", LP_POLICY_DETAIL, "meet_live_off_lp_policy");
  }

  const existing = await env.WP_OS_DB.prepare("SELECT * FROM meet_live_session WHERE conference_record = ?1").bind(input.conference_record).first<LiveSessionRow>();
  if (existing && existing.state !== "REFUSED") return { session: existing, created: false };

  // Gate 3 — the firm's Meet recording default, the one reserved decision (0203).
  const policy = await firmRecordingPolicy(env, meeting.firm_scope);
  if (policy?.active !== 1) {
    const detail = "The firm's Meet recording default is off, so the OS does not join. Approve the meet.recording_policy.firm_default card and turn it on from the Meetings page.";
    await setMeetLiveState(env, meeting.id, "meet_live_unavailable_policy", detail, now);
    await writeRefusedSession(env, meeting, input, detail, now);
    throw new MeetLiveError(409, "recording_policy_off", detail, "meet_live_unavailable_policy");
  }
  if (meeting.recording_enabled !== 1) {
    await env.WP_OS_DB.prepare("UPDATE meeting SET recording_enabled = 1, recording_policy_receipt_id = ?2 WHERE id = ?1").bind(meeting.id, policy.receipt_id).run();
    await appendEvent(env, {
      eventType: "meeting.recording_policy_activated",
      actorType: "system", actorId: "system",
      objectType: "meeting", objectId: meeting.id, firmScope: meeting.firm_scope,
      payload: { receipt_id: policy.receipt_id, via: "meet_recording_policy.firm_default", at: "meet_live.join" },
    });
    meeting.recording_enabled = 1;
  }

  // Gate 5 — authorised as the SYSTEM actor, in the meeting's scope.
  const actor = systemActor(meeting.firm_scope);
  const authz = await authorize(env, actor, "meet.live.join", { objectType: "meeting", objectId: meeting.id, firmScope: meeting.firm_scope });
  if (authz.decision !== "ALLOW") {
    await setMeetLiveState(env, meeting.id, "meet_live_failed", `join not authorised: ${authz.reason}`, now);
    throw new MeetLiveError(403, "forbidden", authz.reason, "meet_live_failed");
  }

  // Gate 4 — consent on the platform's announcement. Same function, same basis, same exclusions
  // as the ended-call ingest; it refuses a meeting the calendar did not create.
  let consent: { transcription: string; recording: string };
  try {
    consent = await recordPlatformAnnouncedConsent(env, actor, meeting, input.conference_record);
  } catch (err) {
    if (err instanceof MeetIngestError) throw new MeetLiveError(err.status, err.code, err.message, null);
    throw err;
  }

  const id = `mls_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO meet_live_session (id, meeting_id, conference_record, meeting_code, listener_device, state, detail, join_identity, consent_transcription_id, consent_recording_id, firm_scope, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'JOINING', ?6, ?7, ?8, ?9, ?10, ?11, ?11)
     ON CONFLICT (conference_record) DO UPDATE SET state = 'JOINING', detail = excluded.detail, listener_device = excluded.listener_device, join_identity = excluded.join_identity,
       consent_transcription_id = excluded.consent_transcription_id, consent_recording_id = excluded.consent_recording_id, updated_at = excluded.updated_at`,
  ).bind(id, meeting.id, input.conference_record, meeting.meet_conference_id!, input.listener_device, "The listener is connecting to the call.", input.join_identity ?? null, consent.transcription, consent.recording, meeting.firm_scope, now.toISOString()).run();
  await setMeetLiveState(env, meeting.id, "meet_live_joining", "The OS is joining the call.", now);
  await appendEvent(env, {
    eventType: "meet.live_session_opened",
    actorType: "system", actorId: "system",
    objectType: "meeting", objectId: meeting.id, firmScope: meeting.firm_scope,
    payload: { conference_record: input.conference_record, listener_device: input.listener_device, join_identity: input.join_identity ?? null, consent_basis: "google_meet_announced", receipt_id: policy.receipt_id },
  });
  const session = (await env.WP_OS_DB.prepare("SELECT * FROM meet_live_session WHERE conference_record = ?1").bind(input.conference_record).first<LiveSessionRow>())!;
  return { session, created: true };
}

async function writeRefusedSession(env: Env, meeting: MeetingRow, input: z.infer<typeof openSessionSchema>, detail: string, now: Date): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO meet_live_session (id, meeting_id, conference_record, meeting_code, listener_device, state, detail, join_identity, firm_scope, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'REFUSED', ?6, ?7, ?8, ?9, ?9)
     ON CONFLICT (conference_record) DO UPDATE SET state = 'REFUSED', detail = excluded.detail, updated_at = excluded.updated_at`,
  ).bind(`mls_${crypto.randomUUID()}`, meeting.id, input.conference_record, meeting.meet_conference_id!, input.listener_device, detail, input.join_identity ?? null, meeting.firm_scope, now.toISOString()).run();
}

// ── The peer reports: connected, ended, or why not ───────────────────────────

export const reportSchema = z.object({
  state: z.enum(["LISTENING", "ENDED", "FAILED"]),
  detail: z.string().trim().max(1000).optional(),
  /** The Google client's error code when the join failed — `scope_missing`, `preview_missing`, `forbidden`, `unauthorised`, … */
  google_error_code: z.string().trim().max(40).optional(),
});

/** Which meeting state a failed join becomes. The exact Google message rides in the detail. */
export function stateForJoinFailure(code: string | undefined): MeetLiveState {
  if (code === "scope_missing") return "meet_live_unavailable_scope";
  if (code === "preview_missing") return "meet_live_unavailable_preview";
  if (code === "forbidden" || code === "unauthorised") return "meet_live_unavailable_edition";
  return "meet_live_failed";
}

export async function reportSession(env: Env, identity: FirmUserIdentity, sessionId: string, input: z.infer<typeof reportSchema>, now = new Date()): Promise<LiveSessionRow> {
  if (!isListener(identity)) throw new MeetLiveError(403, "forbidden", "only the listener may report on a live session");
  const session = await env.WP_OS_DB.prepare("SELECT * FROM meet_live_session WHERE id = ?1").bind(sessionId).first<LiveSessionRow>();
  if (!session) throw new MeetLiveError(404, "not_found", "live session not found");
  const ts = now.toISOString();
  if (input.state === "LISTENING") {
    if (session.state === "ENDED") throw new MeetLiveError(409, "ended", "the session has ended");
    await env.WP_OS_DB.prepare("UPDATE meet_live_session SET state = 'LISTENING', detail = ?2, joined_at = COALESCE(joined_at, ?3), updated_at = ?3 WHERE id = ?1")
      .bind(session.id, input.detail ?? "Joined; listening.", ts).run();
    await setMeetLiveState(env, session.meeting_id, "meet_live_listening", input.detail ?? "The OS is in the call and listening.", now);
  } else if (input.state === "ENDED") {
    await env.WP_OS_DB.prepare("UPDATE meet_live_session SET state = 'ENDED', detail = ?2, ended_at = COALESCE(ended_at, ?3), updated_at = ?3 WHERE id = ?1")
      .bind(session.id, input.detail ?? "The call ended.", ts).run();
    await setMeetLiveState(env, session.meeting_id, "meet_live_ended", `${input.detail ?? "The call ended."} ${session.turns} turn(s) heard live; the official transcript is read in after the call.`, now);
    // THE END-OF-CALL SIGNAL (migration 0216): one column both faces read. First writer wins.
    await env.WP_OS_DB.prepare("UPDATE meeting SET call_ended_at = COALESCE(call_ended_at, ?2) WHERE id = ?1").bind(session.meeting_id, ts).run();
    const meeting = await requireMeeting(env, session.meeting_id);
    if (meeting.status === "SCHEDULED") await transitionMeeting(env, systemActor(meeting.firm_scope), meeting.id, "HELD", session.joined_at ?? undefined);
  } else {
    const state = stateForJoinFailure(input.google_error_code);
    const detail = input.detail ?? "The listener could not join.";
    await env.WP_OS_DB.prepare("UPDATE meet_live_session SET state = 'FAILED', detail = ?2, ended_at = COALESCE(ended_at, ?3), updated_at = ?3 WHERE id = ?1")
      .bind(session.id, `${input.google_error_code ? `${input.google_error_code}: ` : ""}${detail}`, ts).run();
    await setMeetLiveState(env, session.meeting_id, state, detail, now);
  }
  await appendEvent(env, {
    eventType: "meet.live_session_reported",
    actorType: "system", actorId: "system",
    objectType: "meet_live_session", objectId: session.id, firmScope: session.firm_scope,
    payload: { meeting_id: session.meeting_id, state: input.state, google_error_code: input.google_error_code ?? null, detail: input.detail ?? null },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM meet_live_session WHERE id = ?1").bind(session.id).first<LiveSessionRow>())!;
}

// ── A slice of the call ──────────────────────────────────────────────────────

export const liveChunkSchema = z.object({
  audio_base64: z.string().min(1).max(9_000_000).regex(/^[A-Za-z0-9+/=\s]+$/, "audio must be base64"),
  sequence: z.number().int().min(0).max(10_000),
  content_type: z.string().trim().max(80).regex(AUDIO_CONTENT_TYPE, "content_type must be an audio type").optional(),
  /** How many seconds of the call this slice covers, for the cost ledger. */
  seconds: z.number().min(0).max(600).optional(),
});

export interface LiveChunkResult extends ChunkResult {
  session: Pick<LiveSessionRow, "id" | "state" | "chunks" | "turns" | "seconds_heard" | "neurons" | "drafts_rolled">;
  /** Whether this slice rolled the After draft. */
  draft_rolled: boolean;
}

/**
 * One slice → the words → the governed import → (every ROLL_EVERY_MS) the After draft.
 *
 * ORDER, AS IN PHASE C: transcribe first, then hand the words to the import; a refusal there
 * (consent revoked mid-call, policy switched off) drops the words and records the refusal. The
 * session counters are the cost ledger — `neurons` is what the platform reported, never
 * estimated, and `seconds_heard` is what the listener said it sent.
 */
export async function liveChunk(env: Env, identity: FirmUserIdentity, sessionId: string, input: z.infer<typeof liveChunkSchema>, now = new Date()): Promise<LiveChunkResult> {
  if (!isListener(identity)) throw new MeetLiveError(403, "forbidden", "only the listener may post audio to a live session");
  const session = await env.WP_OS_DB.prepare("SELECT * FROM meet_live_session WHERE id = ?1").bind(sessionId).first<LiveSessionRow>();
  if (!session) throw new MeetLiveError(404, "not_found", "live session not found");
  if (session.state !== "JOINING" && session.state !== "LISTENING") throw new MeetLiveError(409, "not_listening", `the session is ${session.state.toLowerCase()}; no audio is accepted`);
  const meeting = await requireMeeting(env, session.meeting_id);
  const actor = systemActor(meeting.firm_scope);

  let heard: Awaited<ReturnType<typeof transcribeWithSpeakers>>;
  try {
    heard = await transcribeWithSpeakers(env, input.audio_base64, input.content_type);
  } catch (err) {
    if (err instanceof TranscriptionUnavailable) throw new MeetLiveError(503, "transcription_unavailable", err.reason);
    throw err;
  }

  let turnsWritten = 0;
  if (heard.text) {
    try {
      const out = await ingestTranscript(env, actor, meeting.id, { source: "NATIVE", text: heard.text, platform: LIVE_PROVIDER }, importTranscript as never);
      turnsWritten = out.notes_created;
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      throw new MeetLiveError(e.status ?? 409, e.code ?? "refused", `the slice was heard and not written down: ${e.message ?? e.code ?? "refused"}`);
    }
  }

  const ts = now.toISOString();
  await env.WP_OS_DB.prepare(
    `UPDATE meet_live_session SET state = 'LISTENING', joined_at = COALESCE(joined_at, ?2), chunks = chunks + 1, turns = turns + ?3,
       seconds_heard = seconds_heard + ?4, neurons = neurons + ?5, updated_at = ?2 WHERE id = ?1`,
  ).bind(session.id, ts, turnsWritten, input.seconds ?? 0, heard.neurons ?? 0).run();
  if (session.state === "JOINING") await setMeetLiveState(env, meeting.id, "meet_live_listening", "The OS is in the call and listening.", now);

  // The rolling draft rides the ladder, on the same cadence as the During face's poll, and only
  // when something new was written — the drafter is idempotent over the fingerprint anyway.
  let rolled = false;
  const lastDraft = session.last_draft_at ? Date.parse(session.last_draft_at) : 0;
  if (turnsWritten > 0 && now.getTime() - lastDraft >= ROLL_EVERY_MS) {
    try {
      const r = await rollSummary(env, actor, meeting.id);
      rolled = !r.reused;
    } catch {
      // A draft that could not be written is recorded by the drafter as a row with its reason;
      // the slice itself was written down, which is the part that must not be lost.
    }
    await env.WP_OS_DB.prepare("UPDATE meet_live_session SET drafts_rolled = drafts_rolled + ?2, last_draft_at = ?3 WHERE id = ?1").bind(session.id, rolled ? 1 : 0, ts).run();
  }

  const after = (await env.WP_OS_DB.prepare("SELECT id, state, chunks, turns, seconds_heard, neurons, drafts_rolled FROM meet_live_session WHERE id = ?1").bind(session.id).first<LiveChunkResult["session"]>())!;
  return { sequence: input.sequence, text: heard.text, turns_written: turnsWritten, engine: heard.engine, speakers: heard.speakers, fallback_reason: heard.fallback_reason, neurons: heard.neurons, session: after, draft_rolled: rolled };
}

// ── Reconciling with the official transcript ─────────────────────────────────

/**
 * The official Meet transcript landed: every live import for the meeting is now corroboration.
 * Called by `meetIngest.readConference` after its own import. Returns how many were superseded.
 */
export async function supersedeLiveImports(env: Env, meetingId: string, officialImportId: string): Promise<number> {
  const r = await env.WP_OS_DB.prepare(
    `UPDATE transcript_import SET superseded_by = ?2
      WHERE meeting_id = ?1 AND provider_name = ?3 AND status = 'IMPORTED' AND superseded_by IS NULL AND id <> ?2`,
  ).bind(meetingId, officialImportId, LIVE_PROVIDER).run();
  await env.WP_OS_DB.prepare("UPDATE meet_live_session SET official_import_id = ?2 WHERE meeting_id = ?1 AND official_import_id IS NULL").bind(meetingId, officialImportId).run();
  return r.meta.changes ?? 0;
}

/** Cost per hour of call, from the ledger: what was actually reported, never a rate card guess. */
export function costPerHour(session: Pick<LiveSessionRow, "seconds_heard" | "neurons">): { neurons_per_hour: number | null; usd_per_hour: number | null } {
  if (session.seconds_heard <= 0) return { neurons_per_hour: null, usd_per_hour: null };
  const perHour = (session.neurons / session.seconds_heard) * 3600;
  return { neurons_per_hour: Math.round(perHour), usd_per_hour: Math.round(perHour * USD_PER_NEURON * 1000) / 1000 };
}

// ── Routes ───────────────────────────────────────────────────────────────────

function fail(err: unknown): Response {
  if (err instanceof MeetLiveError) return json({ error: err.code, detail: err.message, meet_live_state: err.state ?? null }, { status: err.status });
  const e = err as { status?: number; code?: string; message?: string };
  if (typeof e.status === "number") return json({ error: e.code ?? "refused", detail: e.message }, { status: e.status });
  throw err;
}

/** POST /api/meet/live/heartbeat — the listener is awake; here is what is due. */
export async function handleLiveHeartbeat(ctx: RouteContext): Promise<Response> {
  const parsed = heartbeatSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await heartbeat(ctx.env, ctx.identity!, parsed.data));
  } catch (err) {
    return fail(err);
  }
}

/** POST /api/meet/live/sessions — open a session on a running firm-hosted Meet, through the gates. */
export async function handleOpenLiveSession(ctx: RouteContext): Promise<Response> {
  const parsed = openSessionSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const out = await openSession(ctx.env, ctx.identity!, parsed.data);
    return json(out, { status: out.created ? 201 : 200 });
  } catch (err) {
    return fail(err);
  }
}

/** POST /api/meet/live/sessions/:id/report — connected, ended, or why the join failed. */
export async function handleReportLiveSession(ctx: RouteContext): Promise<Response> {
  const parsed = reportSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!ctx.params.id || !parsed.success) return json({ error: "invalid_input", issues: parsed.success ? undefined : parsed.error.issues }, { status: 400 });
  try {
    return json(await reportSession(ctx.env, ctx.identity!, ctx.params.id, parsed.data));
  } catch (err) {
    return fail(err);
  }
}

/** POST /api/meet/live/sessions/:id/chunk — one slice of the call becomes transcript turns. */
export async function handleLiveChunk(ctx: RouteContext): Promise<Response> {
  const parsed = liveChunkSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!ctx.params.id || !parsed.success) return json({ error: "invalid_input", issues: parsed.success ? undefined : parsed.error.issues }, { status: 400 });
  try {
    return json(await liveChunk(ctx.env, ctx.identity!, ctx.params.id, parsed.data), { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

/** GET /api/meet/live/status — listeners, recent sessions, cost per hour. What a partner reads. */
export async function handleLiveStatus(ctx: RouteContext): Promise<Response> {
  const now = new Date();
  const listeners = (await ctx.env.WP_OS_DB.prepare("SELECT * FROM meet_live_listener ORDER BY last_seen_at DESC LIMIT 10").all<ListenerRow>()).results ?? [];
  const sessions = (await ctx.env.WP_OS_DB.prepare(
    `SELECT s.*, m.title, m.privacy_label FROM meet_live_session s JOIN meeting m ON m.id = s.meeting_id ORDER BY s.created_at DESC LIMIT 50`,
  ).all<LiveSessionRow & { title: string; privacy_label: string }>()).results ?? [];
  const visible = sessions.filter((s) => canAccessPrivacyLabel(ctx.identity!, s.privacy_label)).map(({ privacy_label: _p, ...s }) => ({ ...s, cost: costPerHour(s) }));
  return json({
    listeners: listeners.map((l) => ({ ...l, awake: now.getTime() - Date.parse(l.last_seen_at) <= LISTENER_STALE_MS })),
    sessions: visible,
    states: MEET_LIVE_STATES,
    listener_stale_ms: LISTENER_STALE_MS,
  });
}

/**
 * GET /api/meet/live/resolve?code=xxx-yyyy-zzz — the meeting a Meet code is (tier 3). The add-on
 * side panel knows the meeting code from Meet and nothing else; this turns it into the meeting
 * the room renders — the occurrence nearest now, visible to the reader.
 */
export async function handleResolveMeetCode(ctx: RouteContext): Promise<Response> {
  const code = new URL(ctx.request.url).searchParams.get("code")?.trim().toLowerCase() ?? "";
  if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code)) return json({ error: "invalid_input", detail: "code must look like abc-defg-hij" }, { status: 400 });
  // A calendar-synced meeting first; failing that, one a partner adopted from the panel
  // (`handleAdoptMeetCode`) — either way the nearest occurrence the reader may see.
  const rows = (await ctx.env.WP_OS_DB.prepare(
    "SELECT id, title, scheduled_at, privacy_label, meet_live_state, call_ended_at, source FROM meeting WHERE meet_conference_id = ?1 AND status <> 'CANCELLED' AND archived_at IS NULL",
  ).bind(code).all<{ id: string; title: string; scheduled_at: string | null; privacy_label: string; meet_live_state: MeetLiveState | null; call_ended_at: string | null; source: string }>()).results ?? [];
  const visible = rows.filter((r) => canAccessPrivacyLabel(ctx.identity!, r.privacy_label));
  if (visible.length === 0) return json({ error: "not_found", detail: `no meeting on the record carries Meet code ${code}` }, { status: 404 });
  const t = Date.now();
  visible.sort((a, b) => Math.abs((a.scheduled_at ? Date.parse(a.scheduled_at) : 0) - t) - Math.abs((b.scheduled_at ? Date.parse(b.scheduled_at) : 0) - t));
  const m = visible[0]!;
  return json({ meeting_id: m.id, title: m.title, scheduled_at: m.scheduled_at, meet_live_state: m.meet_live_state, call_ended_at: m.call_ended_at, source: m.source, candidates: visible.length });
}

const adoptSchema = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/, "code must look like abc-defg-hij"),
  title: z.string().trim().min(1).max(200).optional(),
});

/**
 * POST /api/meet/live/adopt — "Record this meeting now" (tier 3). A Meet the calendar does not
 * know, adopted from inside the call by a partner: an ordinary meeting through `createMeeting`
 * (the same authority as the Meetings page), carrying the Meet code so the panel finds it again.
 *
 * WHAT IT IS NOT. Not a firm-hosted calendar Meet: `source` stays 'manual', so the live path does
 * not apply (the OS cannot announce itself into a call it does not host) and the room records the
 * way Phase C does — the laptop microphone, the consent prompt asked out loud. The type is FOUNDER
 * with `type_inference = 'UNKNOWN_CHECK_IT'`, the calendar sync's own word for "a person should
 * look", never LP by guess.
 */
export async function handleAdoptMeetCode(ctx: RouteContext): Promise<Response> {
  const parsed = adoptSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const { createMeeting } = await import("./meetings");
  const { actorFromIdentity } = await import("./authorize");
  try {
    const meeting = await createMeeting(ctx.env, actorFromIdentity(ctx.identity!), {
      title: parsed.data.title ?? `Meet call ${parsed.data.code}`,
      meeting_type: "FOUNDER",
      scheduled_at: new Date().toISOString(),
      location: `https://meet.google.com/${parsed.data.code}`,
    });
    await ctx.env.WP_OS_DB.prepare("UPDATE meeting SET meet_conference_id = ?2, meet_link = ?3, type_inference = 'UNKNOWN_CHECK_IT' WHERE id = ?1")
      .bind(meeting.id, parsed.data.code, `https://meet.google.com/${parsed.data.code}`).run();
    return json({ meeting_id: meeting.id, title: meeting.title, adopted: true }, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}
