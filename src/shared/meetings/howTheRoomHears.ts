/**
 * HOW THE ROOM HEARS — one named state per way a meeting's words reach its record.
 *
 * WHY THIS EXISTS (owner, 19 Sep 2026, after Walter walked her through a fake meeting): "If I push
 * Join on Meet what happens? I got to the Google Meet page but is that enough? Is it recording? Are
 * my AI employees there from Join on Meet alone? I don't get how this works." Every one of those is
 * a question the During face could have answered and did not. The recording line said "Recording"
 * or "Not recording — why"; nothing said what a Google Meet call does on its own, when its words
 * arrive, or that the laptop-mic switch is a different path from the Meet one.
 *
 * THE TRUTH THIS MODULE SPEAKS, each line verified in code before it was written:
 *   · `Join on Meet` opens the Meet link in a new tab and nothing else (MeetingsPage.tsx, `JoinOnMeet`).
 *     No employee is in the call; the room does not hear it live.
 *   · With the firm default on, Google transcribes the call and `meet_ingest` (an INTERVAL job,
 *     `interval_minutes` on its `scheduled_job` row — read here, never assumed) reads participants
 *     and the transcript into this meeting's record after the call ends (meetIngest.ts).
 *   · The room's recording switch captures THIS BROWSER'S MICROPHONE a minute at a time, behind two
 *     gates: a Managing Partner's recording policy for this meeting and a yes asked for every session
 *     (liveTranscription.ts, RoomPanel.tsx). On a Meet it hears the call through the speakers, so the
 *     same words arrive twice — once live, once from Google.
 *   · A seated employee reads what is on the record — typed notes and captured turns — and never
 *     joins the Meet (meetingRoom.ts, `buildRoomContext`).
 *
 * EVERY VARIANT IS A NAMED STATE FROM THE ROW, NEVER INFERRED IN A COMPONENT. `hearingState` reads
 * the facts the Worker serves (`GET /api/meetings/:id/hearing`) plus one fact only the browser
 * knows — whether its recorder is running right now — and returns one state with its sentence.
 * `scripts/validate/every-hearing-state-has-a-sentence.mjs` fails the build if a state has no
 * sentence or no test.
 */

export type MeetInboxState = "RECEIVED" | "INGESTED" | "REFUSED" | "NO_TRANSCRIPT" | "NO_MEETING" | "FAILED";

/** `meeting.meet_live_state` (migration 0215) — repeated here as a type so the shared module imports nothing from the Worker. */
export type MeetLiveRowState =
  | "meet_not_started" | "meet_live_joining" | "meet_live_listening" | "meet_live_ended" | "meet_live_no_listener"
  | "meet_live_unavailable_scope" | "meet_live_unavailable_preview" | "meet_live_unavailable_edition"
  | "meet_live_unavailable_policy" | "meet_live_off_lp_policy" | "meet_live_failed";

/** What the Worker knows about how this meeting's words reach the record. */
export interface HearingFacts {
  /** Where the meeting came from: the firm calendar (a Meet call) or recorded here by hand. */
  source: "manual" | "google_calendar";
  /** The Meet link the calendar carries, when there is one. */
  meet_link: string | null;
  /** The firm default — transcribe every firm-hosted Meet — is on (`meet_recording_policy`). */
  firm_default_on: boolean;
  /** How often the Meet ingest runs, from its `scheduled_job` row. Null when the row is missing. */
  ingest_every_minutes: number | null;
  /**
   * THE END-OF-CALL SIGNAL (the contract with feat/meet-media-live, #131): `meeting.call_ended_at`,
   * ISO, null until the call ends; first writer wins between the live listener's ENDED report and
   * the ended-call ingest from Google's end time. On a head where that column does not exist yet it
   * is null here and Google's end time on the inbox row (`meet.conference_ended_at`) stands in.
   */
  call_ended_at: string | null;
  /**
   * THE LIVE PATH (tier 4, #131): the state the live listener wrote on the row
   * (`meeting.meet_live_state`, migration 0215), its detail, and the turns heard live so far.
   * `state` is null when the live path does not apply — a manual meeting, or one without a Meet
   * conference. The names are `MEET_LIVE_STATES` in `services/meetLiveView.ts`.
   */
  meet_live: { state: MeetLiveRowState | null; detail: string | null; turns: number };
  /** The Meet inbox row for this meeting, once the ended call has been heard about. */
  meet: {
    state: MeetInboxState;
    conference_ended_at: string | null;
    turns: number;
    participants: number;
    /** When the row was last written — for INGESTED, when the transcript landed. */
    read_at: string | null;
    detail: string | null;
  } | null;
  /** A transcription service is reachable from this build. */
  transcription_available: boolean;
  /** A Managing Partner's recording policy is on for THIS meeting. */
  recording_policy_active: boolean;
  /** The consent on file today, per type. */
  consent: { transcription: string; recording: string };
  /** Turns the laptop mic has written down on this meeting so far. */
  turns_captured: number;
  /** Notes typed by hand. */
  notes_typed: number;
}

/** Where After's material came from — one row per origin, with times (served by the Worker). */
export interface MaterialSource {
  kind: "meet_transcript" | "laptop_capture" | "fireflies_export" | "other_import" | "typed_notes" | "room_blocks";
  label: string;
  count: number;
  first_at: string | null;
  last_at: string | null;
  /** For laptop capture: the turns those minutes produced. For Meet: the turns Google attributed. */
  turns: number | null;
}

/** The one fact only the browser has: is its recorder running at this moment. */
export interface HearingNow {
  live: boolean;
}

export const HEARING_STATES = [
  // The live path (tier 4): the OS itself in the call, from the Mac.
  "MEET_LIVE_LISTENING",
  "MEET_LIVE_JOINING",
  "MEET_LIVE_ENDED",
  "MEET_LIVE_NO_LISTENER",
  "MEET_LIVE_NO_SCOPE",
  "MEET_LIVE_NO_PREVIEW",
  "MEET_LIVE_REFUSED",
  "MEET_LIVE_OFF_LP",
  "MEET_LIVE_FAILED",
  "MEET_LIVE_HERE",
  "MEET_INGESTED",
  "MEET_WAITING_FOR_TRANSCRIPT",
  "MEET_NO_TRANSCRIPT",
  "MEET_REFUSED_DEFAULT_OFF",
  "MEET_READ_FAILED",
  "MEET_DEFAULT_OFF",
  "MEET_PENDING",
  "MANUAL_LIVE",
  "MANUAL_NO_SERVICE",
  "MANUAL_POLICY_OFF",
  "MANUAL_CONSENT_DENIED",
  "MANUAL_CAPTURED_EARLIER",
  "MANUAL_READY",
] as const;
export type HearingState = (typeof HEARING_STATES)[number];

/** The way to have the room follow live, when it is not doing so — a named tail, never a guess. */
export const LIVE_PATHS = ["LIVE_PATH_OPEN", "LIVE_PATH_POLICY_OFF", "LIVE_PATH_NO_SERVICE", "LIVE_PATH_CONSENT_DENIED"] as const;
export type LivePath = (typeof LIVE_PATHS)[number];

export interface Hearing {
  state: HearingState;
  /** The narrow room's chip words for this state. */
  chip: string;
  /** The line under "How this room hears": what is heard, by what, and when it lands. */
  sentence: string;
  /** How to have the room follow live, when it is not. Null while it is, or once the call is read. */
  live_path: LivePath | null;
  live_sentence: string | null;
  /** "Google Meet call" or "In person or by phone" — the eyebrow. */
  channel: "Google Meet call" | "In person or by phone";
}

function minutes(n: number | null): string {
  return n === null ? "the next ingest run" : `~${n} min`;
}

function clock(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function n(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Every state's sentence, keyed by name. A function of the facts so a state can carry its real
 * numbers — the ingest cadence from the job row, the turns Meet read, the time it landed.
 */
export const HEARING_SENTENCES: Readonly<Record<HearingState, (f: HearingFacts) => string>> = {
  MEET_LIVE_LISTENING: (f) =>
    `Google Meet call · the OS is in the call and listening — Meet announced it to everyone · ${n(f.meet_live.turns, "turn", "turns")} heard so far, a minute at a time · the draft rolls every five minutes and a seated employee reads what is written down here · Google's transcript is read in after the call and becomes After's source`,
  MEET_LIVE_JOINING: () =>
    "Google Meet call · the OS is joining the call now from the Mac — Meet announces it to everyone in the room · the first minute is written down once it is in",
  MEET_LIVE_ENDED: (f) =>
    `Google Meet call · the call ended · ${n(f.meet_live.turns, "turn", "turns")} heard live are on this record · Google's transcript is read in within ${minutes(f.ingest_every_minutes)} and becomes After's source; the live turns stay as corroboration`,
  MEET_LIVE_NO_LISTENER: (f) =>
    `Google Meet call · the call is live but the Mac has not been heard from${f.meet_live.detail ? ` — ${f.meet_live.detail}` : ""} · is it awake? · Google's transcript is still read in after the call`,
  MEET_LIVE_NO_SCOPE: (f) =>
    `Google Meet call · the OS cannot join live: the Google grant does not cover the Media API scope · Google's transcript is read in within ${minutes(f.ingest_every_minutes)} of the call ending`,
  MEET_LIVE_NO_PREVIEW: (f) =>
    `Google Meet call · the OS cannot join live yet: Google serves the Media API only to a project in its Developer Preview, which the firm has applied for · it tries again every five minutes while the call runs · Google's transcript is read in within ${minutes(f.ingest_every_minutes)} of the call ending`,
  MEET_LIVE_REFUSED: (f) =>
    `Google Meet call · Google refused the live join${f.meet_live.detail ? ` — ${f.meet_live.detail}` : ""} · Google's transcript is read in within ${minutes(f.ingest_every_minutes)} of the call ending`,
  MEET_LIVE_OFF_LP: (f) =>
    `Google Meet call · live listening is off for LP and Broker meetings by policy: the Media API is Pre-GA and its terms let Google use what passes through it · Google's transcript is read in within ${minutes(f.ingest_every_minutes)} of the call ending, as usual`,
  MEET_LIVE_FAILED: (f) =>
    `Google Meet call · the live join failed${f.meet_live.detail ? ` — ${f.meet_live.detail}` : ""} · it is tried again every five minutes while the call runs · Google's transcript is read in within ${minutes(f.ingest_every_minutes)} of the call ending`,
  MEET_LIVE_HERE: (f) =>
    `Google Meet call · laptop mic · live — this room hears you directly and them through your speakers · Google's transcript arrives after the call as the authoritative record, within ${minutes(f.ingest_every_minutes)} of it ending`,
  MEET_INGESTED: (f) =>
    `Google Meet call · transcribed by Google · read into this record ${clock(f.meet?.read_at ?? null) || "after the call"}: ${n(f.meet?.turns ?? 0, "turn", "turns")}, ${n(f.meet?.participants ?? 0, "participant", "participants")} · nobody from the firm's AI was in the call; they read it afterwards`,
  MEET_WAITING_FOR_TRANSCRIPT: (f) =>
    `Google Meet call · the call ended${f.meet?.conference_ended_at ? ` ${clock(f.meet.conference_ended_at)}` : ""} and Google has not finished its transcript yet · it is checked again every ${minutes(f.ingest_every_minutes)} and read into this record when it is there`,
  MEET_NO_TRANSCRIPT: () =>
    "Google Meet call · the call ended and Google generated no transcript — transcription was not on for it · nothing from the call is on this record; the notes typed here are all there is",
  MEET_REFUSED_DEFAULT_OFF: (f) =>
    `Google Meet call · Google transcribed it, but the firm default was off so the transcript was refused and the refusal written down · turn the firm default on in the Google Meet band and it is read in within ${minutes(f.ingest_every_minutes)}`,
  MEET_READ_FAILED: (f) =>
    `Google Meet call · the transcript could not be read${f.meet?.detail ? ` — ${f.meet.detail}` : ""} · it is tried again every ${minutes(f.ingest_every_minutes)}`,
  MEET_DEFAULT_OFF: () =>
    "Google Meet call · the firm default is off, so Google's transcript of this call will not be read into this record · Join on Meet only opens the call; turn the firm default on in the Google Meet band first",
  MEET_PENDING: (f) =>
    f.meet_live.state === "meet_not_started"
      ? `Google Meet call · the call has not started · when it does, the OS joins it from the Mac and this room hears it live if Google admits the join — this line says which · Google transcribes it either way and it is read into this record within ${minutes(f.ingest_every_minutes)} of the call ending`
      : `Google Meet call · transcribed by Google · read into this record within ${minutes(f.ingest_every_minutes)} of the call ending · Join on Meet opens the call; the OS joins it live from the Mac only once it is in its window and Google admits the join — until then no employee is in it and this room does not hear it live`,
  MANUAL_LIVE: (f) =>
    `In person or by phone · recording through the laptop microphone, a minute at a time, with their yes on the file · ${n(f.turns_captured, "turn", "turns")} written down so far · a seated employee reads what is written down here`,
  MANUAL_NO_SERVICE: () =>
    "In person or by phone · this build has no transcription service, so the room cannot hear anything · what you type under Notes is all a seated employee can read",
  MANUAL_POLICY_OFF: () =>
    "In person or by phone · a Managing Partner has not switched recording on for this meeting, so the room hears nothing · a seated employee reads only what you type under Notes",
  MANUAL_CONSENT_DENIED: () =>
    "In person or by phone · they said no to being recorded, and that is on the file · nothing is captured; a seated employee reads only what you type under Notes",
  MANUAL_CAPTURED_EARLIER: (f) =>
    `In person or by phone · recording is off now · ${n(f.turns_captured, "turn", "turns")} were captured through the laptop microphone earlier and are on this record · switch recording on to continue; it asks for their yes again`,
  MANUAL_READY: () =>
    "In person or by phone · nothing is being heard yet · switch recording on above, ask them out loud, and the laptop microphone writes the room down a minute at a time · a seated employee reads what is written down here",
};

/** The chip the narrow room shows at the top — one or three words per state, the sentence behind it. */
export const HEARING_CHIP_WORDS: Readonly<Record<HearingState, string>> = {
  MEET_LIVE_LISTENING: "in the call · live",
  MEET_LIVE_JOINING: "joining the call",
  MEET_LIVE_ENDED: "call ended · heard live",
  MEET_LIVE_NO_LISTENER: "live · the Mac is not listening",
  MEET_LIVE_NO_SCOPE: "live path · grant missing",
  MEET_LIVE_NO_PREVIEW: "live path · waiting for Google's preview",
  MEET_LIVE_REFUSED: "live join refused by Google",
  MEET_LIVE_OFF_LP: "not joined live · LP policy",
  MEET_LIVE_FAILED: "live join failed",
  MEET_LIVE_HERE: "laptop mic · live",
  MEET_INGESTED: "Meet transcript read in",
  MEET_WAITING_FOR_TRANSCRIPT: "waiting for Google's transcript",
  MEET_NO_TRANSCRIPT: "no transcript from Meet",
  MEET_REFUSED_DEFAULT_OFF: "transcript refused · firm default off",
  MEET_READ_FAILED: "transcript not read",
  MEET_DEFAULT_OFF: "firm default off",
  MEET_PENDING: "Google transcribes · read in after the call",
  MANUAL_LIVE: "laptop mic · live",
  MANUAL_NO_SERVICE: "no transcription service",
  MANUAL_POLICY_OFF: "recording not switched on",
  MANUAL_CONSENT_DENIED: "they said no",
  MANUAL_CAPTURED_EARLIER: "captured earlier · off now",
  MANUAL_READY: "not recording",
};

export const LIVE_PATH_SENTENCES: Readonly<Record<LivePath, string>> = {
  LIVE_PATH_OPEN: "To have the room follow live as well, switch recording on here — it captures this laptop's microphone with their yes, and a seated employee then reads it as it lands.",
  LIVE_PATH_POLICY_OFF: "The room cannot follow live: a Managing Partner has not switched recording on for this meeting.",
  LIVE_PATH_NO_SERVICE: "The room cannot follow live: this build has no transcription service.",
  LIVE_PATH_CONSENT_DENIED: "The room will not follow live: they said no to being recorded, and that is on the file.",
};

function consentDenied(f: HearingFacts): boolean {
  return ["DENIED", "REVOKED"].includes(f.consent.transcription) || ["DENIED", "REVOKED"].includes(f.consent.recording);
}

export function isMeetCall(f: Pick<HearingFacts, "source" | "meet_link">): boolean {
  return f.source === "google_calendar" && Boolean(f.meet_link);
}

/** The way to follow live, from the same gates the recording switch is disabled by. */
export function livePath(f: HearingFacts): LivePath {
  if (!f.transcription_available) return "LIVE_PATH_NO_SERVICE";
  if (!f.recording_policy_active) return "LIVE_PATH_POLICY_OFF";
  if (consentDenied(f)) return "LIVE_PATH_CONSENT_DENIED";
  return "LIVE_PATH_OPEN";
}

/** The one state this meeting is in. Order matters: what is happening now beats what will. */
/** The live path's row state → the hearing state it is, or null when the inbox row should decide. */
function liveStateOf(f: HearingFacts): HearingState | null {
  switch (f.meet_live.state) {
    case "meet_live_listening": return "MEET_LIVE_LISTENING";
    case "meet_live_joining": return "MEET_LIVE_JOINING";
    case "meet_live_no_listener": return "MEET_LIVE_NO_LISTENER";
    case "meet_live_off_lp_policy": return "MEET_LIVE_OFF_LP";
    // The call ended and was heard live: until Google's transcript is read in, the live turns are
    // what the record has; once it is INGESTED the official transcript speaks (superseding them).
    case "meet_live_ended": return f.meet?.state === "INGESTED" ? null : "MEET_LIVE_ENDED";
    // A join that could not happen is said while the call has not been read; a read call is a read call.
    case "meet_live_unavailable_scope": return f.meet ? null : "MEET_LIVE_NO_SCOPE";
    case "meet_live_unavailable_preview": return f.meet ? null : "MEET_LIVE_NO_PREVIEW";
    case "meet_live_unavailable_edition": return f.meet ? null : "MEET_LIVE_REFUSED";
    case "meet_live_failed": return f.meet ? null : "MEET_LIVE_FAILED";
    // Not started, or the firm default off: the existing states already say it.
    default: return null;
  }
}

export function hearingStateOf(f: HearingFacts, now: HearingNow): HearingState {
  if (isMeetCall(f)) {
    if (now.live) return "MEET_LIVE_HERE";
    const live = liveStateOf(f);
    if (live) return live;
    switch (f.meet?.state) {
      case "INGESTED": return "MEET_INGESTED";
      case "RECEIVED": return "MEET_WAITING_FOR_TRANSCRIPT";
      case "NO_TRANSCRIPT": return "MEET_NO_TRANSCRIPT";
      case "REFUSED": return "MEET_REFUSED_DEFAULT_OFF";
      case "FAILED":
      case "NO_MEETING": return "MEET_READ_FAILED";
      default: break;
    }
    return f.firm_default_on ? "MEET_PENDING" : "MEET_DEFAULT_OFF";
  }
  if (now.live) return "MANUAL_LIVE";
  if (!f.transcription_available) return "MANUAL_NO_SERVICE";
  if (!f.recording_policy_active) return "MANUAL_POLICY_OFF";
  if (consentDenied(f)) return "MANUAL_CONSENT_DENIED";
  if (f.turns_captured > 0) return "MANUAL_CAPTURED_EARLIER";
  return "MANUAL_READY";
}

/** States in which the live tail is spoken: the room is not following live and could, or cannot. */
const TAIL_STATES: ReadonlySet<HearingState> = new Set<HearingState>([
  "MEET_PENDING", "MEET_WAITING_FOR_TRANSCRIPT", "MEET_DEFAULT_OFF", "MEET_REFUSED_DEFAULT_OFF",
  // The live path could not join: the laptop mic is still the way to follow live.
  "MEET_LIVE_NO_LISTENER", "MEET_LIVE_NO_SCOPE", "MEET_LIVE_NO_PREVIEW", "MEET_LIVE_REFUSED", "MEET_LIVE_OFF_LP", "MEET_LIVE_FAILED",
]);

export function hearing(f: HearingFacts, now: HearingNow): Hearing {
  const state = hearingStateOf(f, now);
  const path = TAIL_STATES.has(state) ? livePath(f) : null;
  return {
    state,
    chip: HEARING_CHIP_WORDS[state],
    sentence: HEARING_SENTENCES[state](f),
    live_path: path,
    live_sentence: path ? LIVE_PATH_SENTENCES[path] : null,
    channel: isMeetCall(f) ? "Google Meet call" : "In person or by phone",
  };
}

/** Is the call over? The named signal first, Google's end time on the inbox row as the stand-in. */
export function callIsOver(f: Pick<HearingFacts, "call_ended_at" | "meet">): boolean {
  return Boolean(f.call_ended_at) || Boolean(f.meet?.conference_ended_at);
}

/** What `Join on Meet` does and does not do — one line, said beside the button and in its tooltip. */
export const JOIN_ON_MEET_LINE = "Opens the Google Meet call. When the listener on the Mac is running and Google admits the join, the OS joins the call as a participant and this room hears it live (never for LP or Broker meetings); the line above says which. Google transcribes it either way, and the transcript is read into this record after the call.";

/** What a seated employee can and cannot do — one sentence beside Seat. */
export const SEATED_EMPLOYEE_LINE = "A seated employee answers in Ask the room by name and can take a task that returns here. They read what is written down — typed notes, the recording when it is on, and the call itself when the OS is in it live — and are never in the Meet call as a participant themselves; the OS is.";

/** The standalone room, said where its link is. */
export const STANDALONE_ROOM_LINE = "The same room, in its own window — no app shell, for a second window beside your call, and a way back when it is over.";
