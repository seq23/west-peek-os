import type { Env } from "../env";
import type { MeetingRow } from "./meetings";
import { LIVE_PROVIDER } from "./meetLiveNotes";

/**
 * What the During face reads about the live path (tier 4, migration 0215) — the states, and the
 * one read that turns the meeting row, the session and the listener heartbeat into a view.
 *
 * In its own file because `meetingRoom.ts` renders it and `meetLive.ts` (which imports the room
 * for the rolling draft) writes it; the view imports neither.
 */

/** The states the During face renders. Named once here; the migration's CHECK repeats them. */
export const MEET_LIVE_STATES = [
  "meet_not_started",
  "meet_live_joining",
  "meet_live_listening",
  "meet_live_ended",
  "meet_live_no_listener",
  "meet_live_unavailable_scope",
  "meet_live_unavailable_preview",
  "meet_live_unavailable_edition",
  "meet_live_unavailable_policy",
  "meet_live_off_lp_policy",
  "meet_live_failed",
] as const;
export type MeetLiveState = (typeof MEET_LIVE_STATES)[number];

/**
 * THE OWNER'S RULE, 19 Sep 2026: LP and Broker meetings NEVER join the live media stream.
 *
 * WHY. The Meet Media API is a Pre-GA API under the Google Workspace Developer Preview Program,
 * and the program's terms — term (vi) — let Google use data sent through Pre-GA APIs to improve
 * them. An LP conversation names limited partners and deal terms, which must never reach a route
 * whose terms permit that (the same rule the router enforces for models). So the live path is
 * gated BY MEETING TYPE at the join decision, in code: Internal, Founder, Diligence and Portfolio
 * meetings may join; LP and Broker meetings keep the GA post-call transcript path (tier 2) and
 * read `meet_live_off_lp_policy` on the row. `validate:meet-live` plants an LP meeting and
 * requires the refusal.
 */
export const LIVE_EXCLUDED_MEETING_TYPES = ["LP", "BROKER"] as const;

export function liveAllowedForType(meetingType: string): boolean {
  return !(LIVE_EXCLUDED_MEETING_TYPES as readonly string[]).includes(meetingType);
}

export const LP_POLICY_DETAIL = "Live listening is off for LP and Broker meetings by policy: the Meet Media API is a Pre-GA API whose terms let Google use what passes through it, and an LP conversation must never go there. The official transcript is read in after the call as usual.";

/** A listener not heard from for this long is not listening, whatever its last row said. Three heartbeats. */
export const LISTENER_STALE_MS = 90_000;
/** How long before its scheduled start a calendar meeting is offered to the listener, and for how long after. */
export const DUE_BEFORE_MS = 15 * 60_000;
export const DUE_AFTER_MS = 3 * 3_600_000;
export interface LiveSessionView {
  id: string;
  state: "JOINING" | "LISTENING" | "ENDED" | "FAILED" | "REFUSED";
  chunks: number;
  turns: number;
  seconds_heard: number;
  neurons: number;
  drafts_rolled: number;
  joined_at: string | null;
  ended_at: string | null;
  official_import_id: string | null;
}

/** A firm-hosted Meet is a calendar-synced meeting with a conference id. Everything else has no live path. */
export function isFirmHostedMeet(meeting: Pick<MeetingRow, "source" | "meet_conference_id">): boolean {
  return meeting.source === "google_calendar" && typeof meeting.meet_conference_id === "string" && meeting.meet_conference_id.length > 0;
}

// ── What the During face reads ───────────────────────────────────────────────

export interface MeetLiveView {
  /** NULL for a manual meeting or one without a Meet conference: the live path does not apply. */
  state: MeetLiveState | null;
  detail: string | null;
  updated_at: string | null;
  applicable: boolean;
  session: LiveSessionView | null;
  listener_seen_at: string | null;
  /** Live turns on the record right now, and whether they have been superseded by the official transcript. */
  live_turns: number;
  superseded: boolean;
}

export async function meetLiveView(env: Env, meeting: Pick<MeetingRow, "id" | "source" | "meet_conference_id">, now = new Date()): Promise<MeetLiveView> {
  const row = await env.WP_OS_DB.prepare("SELECT meet_live_state, meet_live_detail, meet_live_updated_at FROM meeting WHERE id = ?1").bind(meeting.id)
    .first<{ meet_live_state: MeetLiveState | null; meet_live_detail: string | null; meet_live_updated_at: string | null }>();
  const applicable = isFirmHostedMeet(meeting);
  const session = await env.WP_OS_DB.prepare(
    "SELECT id, state, chunks, turns, seconds_heard, neurons, drafts_rolled, joined_at, ended_at, official_import_id, listener_device FROM meet_live_session WHERE meeting_id = ?1 ORDER BY created_at DESC LIMIT 1",
  ).bind(meeting.id).first<MeetLiveView["session"] & { listener_device: string }>();
  const listener = session
    ? await env.WP_OS_DB.prepare("SELECT last_seen_at FROM meet_live_listener WHERE device_id = ?1").bind(session.listener_device).first<{ last_seen_at: string }>()
    : await env.WP_OS_DB.prepare("SELECT last_seen_at FROM meet_live_listener ORDER BY last_seen_at DESC LIMIT 1").first<{ last_seen_at: string }>();
  const live = await env.WP_OS_DB.prepare(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN ti.superseded_by IS NOT NULL THEN 1 ELSE 0 END) AS s
       FROM meeting_note n JOIN transcript_import ti ON ti.id = n.transcript_import_id
      WHERE n.meeting_id = ?1 AND n.note_type = 'TRANSCRIPT_DERIVED' AND ti.provider_name = ?2`,
  ).bind(meeting.id, LIVE_PROVIDER).first<{ n: number; s: number | null }>();

  let state = applicable ? row?.meet_live_state ?? "meet_not_started" : null;
  let detail = applicable ? row?.meet_live_detail ?? "The Meet conference has not started; the OS joins when it does." : null;
  // A session that says it is listening while its listener has gone quiet is not listening.
  if ((state === "meet_live_listening" || state === "meet_live_joining") && listener && now.getTime() - Date.parse(listener.last_seen_at) > LISTENER_STALE_MS) {
    state = "meet_live_no_listener";
    detail = `The call is live but the listener on the Mac has not been heard from since ${listener.last_seen_at}. Is the Mac awake?`;
  }
  if (state === "meet_not_started" && !listener) {
    detail = "The Meet conference has not started. No listener has ever checked in from the Mac — the live path needs scripts/meet/live-listener.mjs running there.";
  }
  const { listener_device: _d, ...sessionView } = session ?? ({} as MeetLiveView["session"] & { listener_device: string });
  return {
    state, detail, updated_at: row?.meet_live_updated_at ?? null, applicable,
    session: session ? sessionView : null,
    listener_seen_at: listener?.last_seen_at ?? null,
    live_turns: Number(live?.n ?? 0),
    superseded: Number(live?.s ?? 0) > 0,
  };
}

