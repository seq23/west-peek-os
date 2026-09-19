import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { canAccessPrivacyLabel } from "./authorize";
import { captureReadiness, CaptureRefused } from "./liveTranscription";
import { firmRecordingPolicy, MEET_PROVIDER } from "./meetIngest";
import type { HearingFacts, MaterialSource, MeetInboxState } from "../../shared/meetings/howTheRoomHears";
import { meetLiveView } from "./meetLiveView";

/**
 * HOW THE ROOM HEARS — the facts, served (owner, 19 Sep 2026).
 *
 * The During face says, in one line, how this meeting's words reach its record: a Google Meet call
 * Google transcribes and the hourly ingest reads in, or the laptop microphone behind two gates. The
 * sentence is chosen in `shared/meetings/howTheRoomHears.ts` from named states; THIS module only
 * gathers the facts those states are chosen from, each from the row that owns it:
 *
 *   · the meeting's `source` and `meet_link` (migration 0202)
 *   · the firm default, `meet_recording_policy` (0203)
 *   · the ingest cadence, `scheduled_job.interval_minutes` for `meet_ingest` (0203) — the real
 *     number, so "within ~60 min" can never drift from the job that makes it true
 *   · the Meet inbox row for this meeting (0202): state, turns, participants, when it was read
 *   · the capture gates, exactly as the recording switch reads them (`captureReadiness`)
 *
 * The After face asks the same route for WHERE ITS MATERIAL CAME FROM — every transcript import on
 * the meeting by origin (Meet · laptop capture · a Fireflies export · a file), the notes typed by
 * hand and the blocks saved from the room, each with its times — so a partner reading the draft
 * knows whether it was written from Google's transcript, from the laptop, or from three typed lines.
 */

export interface HearingResponse {
  facts: HearingFacts;
  sources: MaterialSource[];
}

interface MeetingHearingRow {
  id: string;
  source: "manual" | "google_calendar" | null;
  meet_link: string | null;
  meet_conference_id: string | null;
  firm_scope: string;
  privacy_label: string;
  /** THE END-OF-CALL SIGNAL: `meeting.call_ended_at` (migration 0216). */
  call_ended_at: string | null;
}

interface InboxRowSlim {
  state: MeetInboxState;
  conference_ended_at: string | null;
  turns: number;
  participants_json: string;
  updated_at: string;
  detail: string | null;
}

interface ImportAgg {
  source: string;
  provider_name: string | null;
  n: number;
  first_at: string | null;
  last_at: string | null;
  turns: number;
}

function participantsIn(raw: string): number {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}

/** Every fact the states are chosen from, read from the rows that own them. */
export async function hearingFacts(env: Env, meeting: MeetingHearingRow): Promise<HearingFacts> {
  const [policy, job, inbox, capture, typed, live] = await Promise.all([
    firmRecordingPolicy(env, meeting.firm_scope),
    env.WP_OS_DB.prepare("SELECT interval_minutes FROM scheduled_job WHERE job_key = 'meet_ingest'").first<{ interval_minutes: number | null }>(),
    env.WP_OS_DB.prepare(
      "SELECT state, conference_ended_at, turns, participants_json, updated_at, detail FROM meet_event_inbox WHERE meeting_id = ?1 ORDER BY updated_at DESC LIMIT 1",
    ).bind(meeting.id).first<InboxRowSlim>(),
    captureReadiness(env, meeting.id),
    env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM meeting_note WHERE meeting_id = ?1 AND note_type = 'MANUAL'").bind(meeting.id).first<{ n: number }>(),
    // The live path (tier 4): the state the listener wrote on the row, staleness applied.
    meetLiveView(env, { id: meeting.id, source: meeting.source === "google_calendar" ? "google_calendar" : "manual", meet_conference_id: meeting.meet_conference_id }),
  ]);
  return {
    // THE END-OF-CALL SIGNAL: the column itself (migration 0216); Google's end time on the inbox
    // row stands in only for a call the listener never heard — `callIsOver` reads both.
    call_ended_at: meeting.call_ended_at,
    meet_live: { state: live.state, detail: live.detail, turns: live.live_turns },
    source: meeting.source === "google_calendar" ? "google_calendar" : "manual",
    meet_link: meeting.meet_link ?? null,
    firm_default_on: policy?.active === 1,
    ingest_every_minutes: typeof job?.interval_minutes === "number" ? job.interval_minutes : null,
    meet: inbox
      ? {
          state: inbox.state,
          conference_ended_at: inbox.conference_ended_at,
          turns: inbox.turns,
          participants: participantsIn(inbox.participants_json),
          read_at: inbox.updated_at,
          detail: inbox.detail,
        }
      : null,
    transcription_available: capture.transcription_available,
    recording_policy_active: capture.recording_policy_active,
    consent: { transcription: capture.consent.TRANSCRIPTION ?? "NOT_RECORDED", recording: capture.consent.RECORDING ?? "NOT_RECORDED" },
    turns_captured: capture.turns,
    notes_typed: Number(typed?.n ?? 0),
  };
}

/** Where the After face's material came from, by origin, with times. */
export async function materialSources(env: Env, meetingId: string): Promise<MaterialSource[]> {
  const imports = (
    await env.WP_OS_DB.prepare(
      `SELECT t.source, t.provider_name, COUNT(*) AS n, MIN(t.created_at) AS first_at, MAX(t.created_at) AS last_at,
              SUM((SELECT COUNT(*) FROM meeting_note mn WHERE mn.transcript_import_id = t.id)) AS turns
         FROM transcript_import t WHERE t.meeting_id = ?1 AND t.status = 'IMPORTED'
        GROUP BY t.source, t.provider_name`,
    ).bind(meetingId).all<ImportAgg>()
  ).results ?? [];
  const out: MaterialSource[] = [];
  for (const i of imports) {
    if (i.provider_name === MEET_PROVIDER) out.push({ kind: "meet_transcript", label: "Meet transcript", count: i.n, first_at: i.first_at, last_at: i.last_at, turns: i.turns });
    else if (i.source === "NATIVE" || i.provider_name === "LAPTOP_MIC") out.push({ kind: "laptop_capture", label: "Laptop capture", count: i.n, first_at: i.first_at, last_at: i.last_at, turns: i.turns });
    else if (i.provider_name === "FIREFLIES") out.push({ kind: "fireflies_export", label: "Fireflies export", count: i.n, first_at: i.first_at, last_at: i.last_at, turns: i.turns });
    else out.push({ kind: "other_import", label: "A transcript brought in", count: i.n, first_at: i.first_at, last_at: i.last_at, turns: i.turns });
  }
  const notes = await env.WP_OS_DB.prepare(
    "SELECT COUNT(*) AS n, MIN(created_at) AS first_at, MAX(created_at) AS last_at FROM meeting_note WHERE meeting_id = ?1 AND note_type = 'MANUAL'",
  ).bind(meetingId).first<{ n: number; first_at: string | null; last_at: string | null }>();
  if ((notes?.n ?? 0) > 0) out.push({ kind: "typed_notes", label: "Notes typed by hand", count: Number(notes!.n), first_at: notes!.first_at, last_at: notes!.last_at, turns: null });
  const blocks = await env.WP_OS_DB.prepare(
    "SELECT COUNT(*) AS n, MIN(created_at) AS first_at, MAX(created_at) AS last_at FROM meeting_artifact WHERE meeting_id = ?1",
  ).bind(meetingId).first<{ n: number; first_at: string | null; last_at: string | null }>();
  if ((blocks?.n ?? 0) > 0) out.push({ kind: "room_blocks", label: "Saved from the room", count: Number(blocks!.n), first_at: blocks!.first_at, last_at: blocks!.last_at, turns: null });
  return out;
}

/** GET /api/meetings/:id/hearing — how this room hears, and where After's material came from. */
export async function handleHearing(ctx: RouteContext): Promise<Response> {
  const meeting = await ctx.env.WP_OS_DB.prepare("SELECT id, source, meet_link, meet_conference_id, firm_scope, privacy_label, call_ended_at FROM meeting WHERE id = ?1")
    .bind(ctx.params.id!)
    .first<MeetingHearingRow>();
  if (!meeting || !canAccessPrivacyLabel(ctx.identity!, meeting.privacy_label)) return json({ error: "not_found" }, { status: 404 });
  try {
    const [facts, sources] = await Promise.all([hearingFacts(ctx.env, meeting), materialSources(ctx.env, meeting.id)]);
    const body: HearingResponse = { facts, sources };
    return json(body);
  } catch (err) {
    if (err instanceof CaptureRefused) return json({ error: err.code, detail: err.message }, { status: err.status });
    throw err;
  }
}
