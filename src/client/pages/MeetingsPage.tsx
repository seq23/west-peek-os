import { useEffect, useMemo, useRef, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { MEETING_TYPES, meetingType, seatableFor } from "@shared/meetings/meetingTypes";
import { IC_FLOW } from "@shared/ic/meetingFlow";
import { LiveHelpPanel } from "./LiveHelpPanel";
import { CloseoutPanel } from "./CloseoutPanel";

/**
 * Meetings — the whole surface, in the order a partner asks in (ADR-019).
 *
 * OPERATOR, 22 AUG 2026: "the meeting tab is not good enough it is not self explanatory from looking
 * at the page what im able to do… we need a look into the meeting flow. this page would probably be
 * the longest and needs to be clean and clear like the LP page."
 *
 * WHAT WAS ACTUALLY WRONG was not the wording. This surface was TWO pages stacked on each other —
 * a list with a create form here, and a second list with the notes, consent, transcript and
 * close-out machinery mounted from App.tsx underneath it. Both rendered `meeting-list`, both
 * rendered `meeting-${id}`, and opening a meeting in one had no effect on the other. Anybody
 * looking at it was reading two surfaces and being asked to work out which one they were on.
 *
 * FIVE SECTIONS, ALWAYS RENDERED, EACH WITH AN EMPTY STATE. "Nothing has reached this yet" and
 * "this is broken" look identical unless the page says which — the same defect the IC sequence
 * block was written to fix, applied to the whole page. The order is the argument: what is coming
 * up, what happened and what came of it, start one now, where a deal stands with the committee,
 * and last of all how any of this becomes work. The explainer goes last because a page that
 * explains itself before showing anything is a page you have to read before you can use.
 */

interface MeetingRow {
  id: string;
  title: string;
  meeting_type: string;
  status: string;
  scheduled_at: string | null;
  occurred_at: string | null;
  company_id: string | null;
  recording_enabled?: number;
}

interface MeetingsResponse {
  meetings: MeetingRow[];
  ic?: {
    ready_deals: number;
    packets: number;
    meetings: number;
    decisions: number;
    facilitator: { name: string; status: string } | null;
  };
}

interface CaptureReadiness {
  meeting_id: string;
  transcription_available: boolean;
  recording_policy_active: boolean;
  consent: Record<string, string>;
  can_capture: boolean;
  blockers: string[];
  turns: number;
}

interface OpenQuestion {
  id: string;
  section_id: string | null;
  question: string;
  because: string;
  owed_by_kind: string;
  owed_by: string | null;
  state: string;
  answer: string | null;
  answered_by: string | null;
  withdrawn_reason: string | null;
}

interface CommitteeSeat {
  name: string;
  role: string;
  decides: boolean;
}

interface IcDeal {
  opportunity_id: string;
  title: string;
  company_name: string | null;
  stage: string;
  packet_id: string | null;
  packet_state: string;
  questions: OpenQuestion[];
  open_question_count: number;
  seats: CommitteeSeat[];
  decision: { decision: string; rationale: string | null; created_at: string } | null;
  facilitator_card: { id: string; state: string; title: string } | null;
  approval_card: { id: string; state: string } | null;
}

interface MeetingDetailRow extends MeetingRow {
  recording_enabled: number;
  consent_current: Record<string, { id: string; state: string; basis: string } | null>;
  notes: Array<{ id: string; note_type: string; body: string; author_type: string }>;
  commitments: Array<{ id: string; commitment_text: string; status: string; work_card_id: string | null }>;
  transcript_imports: Array<{ id: string; status: string; refusal_reason: string | null; source: string; provider_name: string | null }>;
  participants: Array<{ id: string; display_name: string; participant_type: string }>;
}

/** A date a person would say out loud, or a plain dash when there is nothing to say. */
function whenInWords(value: string | null): string {
  if (!value) return "no time recorded";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

/** Where a transcript came from, in words. The stored value is never printed at a partner. */
function sourceInWords(source: string, provider: string | null): string {
  if (provider === "FIREFLIES") return "Fireflies export";
  switch (source) {
    case "NATIVE": return "Recorded here, in this page";
    case "PROVIDER": return "Somebody else's recording";
    case "UPLOAD": return "A file somebody uploaded";
    default: return "Typed in by hand";
  }
}

/** Who owes an answer, in words. The stored value is never printed. */
function owedInWords(q: OpenQuestion): string {
  if (q.owed_by) return q.owed_by;
  switch (q.owed_by_kind) {
    case "PARTNER": return "A partner who is not carrying this deal";
    case "CHAMPION": return "Whoever is carrying the deal";
    case "AI_EMPLOYEE": return "An employee";
    case "COUNTERPARTY": return "The company";
    default: return "Nobody yet";
  }
}

// ── Section 3's working parts: consent, then capture ──────────────────────────

const CHUNK_MS = 60_000;

/** Blob → base64, without the data-URI prefix the API does not want. */
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not read the recording"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * The consent prompt and the recorder behind it.
 *
 * THE PROMPT IS SHOWN EVERY TIME AND IS NEVER REMEMBERED. California is a two-party state; New York
 * and Georgia are not. Consent is given by a person, in a room, on a day — a checkbox that carries
 * it forward to the next session is a record of something that did not happen. So the answer is
 * re-asked before every start, even when this meeting already carries a GRANTED row.
 *
 * THE BUTTON IS NEVER LIVE-LOOKING AND INERT. Whether a transcription service can be reached at all
 * is decided by the server and reported here, so wherever it cannot be, the control is disabled
 * with the reason printed beside it rather than failing after somebody has spoken for ten minutes.
 *
 * EACH SLICE IS A COMPLETE RECORDING. The recorder is stopped and restarted every minute rather
 * than streamed, because a timesliced stream produces fragments that are not independently
 * decodable — the container header only appears in the first one. A fragment nothing can read is
 * indistinguishable from silence, which is the worst possible failure for a record of a
 * conversation.
 */
function CapturePanel({ meeting, onCaptured }: { meeting: MeetingRow; onCaptured: () => void }): JSX.Element {
  const readiness = useApi<CaptureReadiness>(`/api/meetings/${meeting.id}/capture`, [meeting.id]);
  const [asked, setAsked] = useState(false);
  const [who, setWho] = useState("");
  const [basis, setBasis] = useState("Asked out loud at the start of the call.");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [heard, setHeard] = useState<string[]>([]);
  const stopRef = useRef<(() => void) | null>(null);
  const seqRef = useRef(0);

  // A recorder left running after the panel goes away would hold the microphone open with nothing
  // on screen saying so, which is the one thing a recording indicator exists to prevent.
  useEffect(() => () => stopRef.current?.(), []);

  const state = readiness.data;
  const consentGranted = state?.consent.TRANSCRIPTION === "GRANTED" && state?.consent.RECORDING === "GRANTED";

  async function answerPrompt(answer: "GRANTED" | "DENIED") {
    setBusy(true);
    setMessage(null);
    const res = await api<{ error?: string; detail?: string }>(`/api/meetings/${meeting.id}/capture/consent`, {
      method: "POST",
      body: { answer, granted_by: who.trim() || undefined, basis: basis.trim() },
    });
    setBusy(false);
    if (res.status !== 201) {
      setMessage(res.data?.detail ?? res.data?.error ?? `Not recorded (HTTP ${res.status}).`);
      return;
    }
    setAsked(answer === "GRANTED");
    setMessage(
      answer === "GRANTED"
        ? "Recorded. Their answer is on the file for this meeting and can be taken back at any point."
        : "Recorded as a no. Nothing will be captured, and that refusal is on the file too.",
    );
    readiness.reload();
  }

  async function send(blob: Blob) {
    if (blob.size === 0) return;
    let audio: string;
    try {
      audio = await toBase64(blob);
    } catch {
      setMessage("A slice of the recording could not be read, so it was not written down.");
      return;
    }
    const res = await api<{ text?: string; error?: string; detail?: string }>(
      `/api/meetings/${meeting.id}/capture/chunk`,
      { method: "POST", body: { audio_base64: audio, sequence: seqRef.current++ } },
    );
    if (res.status !== 201) {
      // Named, never dropped. A transcript with a silent hole in it is worse than a short one.
      setMessage(`Minute ${seqRef.current} was not written down: ${res.data?.detail ?? res.data?.error ?? res.status}`);
      return;
    }
    if (res.data?.text) setHeard((h) => [...h, res.data!.text!]);
    onCaptured();
    readiness.reload();
  }

  function stop() {
    stopRef.current?.();
    stopRef.current = null;
    setRecording(false);
    // The prompt is re-armed, deliberately: starting again is a new start and asks again.
    setAsked(false);
  }

  async function start() {
    setMessage(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMessage("This browser will not record audio for a page. Nothing was started.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setMessage("The browser did not give this page the microphone, so nothing is being recorded.");
      return;
    }
    let stopped = false;
    stopRef.current = () => {
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
    };
    setRecording(true);

    const runOne = () => {
      if (stopped) return;
      const rec = new MediaRecorder(stream);
      const parts: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) parts.push(e.data);
      };
      rec.onstop = () => {
        void send(new Blob(parts, { type: rec.mimeType || "audio/webm" }));
        runOne();
      };
      rec.start();
      window.setTimeout(() => {
        if (rec.state !== "inactive") rec.stop();
      }, CHUNK_MS);
    };
    runOne();
  }

  return (
    <div data-testid={`capture-${meeting.id}`}>
      <h4>Before anything is recorded</h4>
      <p className="muted small">
        California needs everyone in the conversation to agree; New York and Georgia do not. This
        firm sits in one and talks to founders in the others, so permission gets asked for out loud
        every time — not remembered from last time, and not assumed from an invitation nobody read.
      </p>

      <p className="consent-script" data-testid="consent-script">
        “Before we start — I record these calls so I can write up what we agreed rather than take
        notes at you. It stays inside the firm. Is that alright with you?”
      </p>

      <div className="form-row">
        <label>
          Who said yes{" "}
          <input
            data-testid="consent-who"
            value={who}
            onChange={(e) => setWho(e.target.value)}
            placeholder="Deana Oliver"
          />
        </label>
        <label>
          How you asked{" "}
          <input
            data-testid="consent-basis"
            value={basis}
            onChange={(e) => setBasis(e.target.value)}
          />
        </label>
        <button type="button" className="btn-strong" disabled={busy} data-testid="consent-yes" onClick={() => void answerPrompt("GRANTED")}>
          They said yes
        </button>
        <button type="button" disabled={busy} data-testid="consent-no" onClick={() => void answerPrompt("DENIED")}>
          They said no
        </button>
      </div>

      <h4>Record it</h4>
      {state && state.blockers.length > 0 && (
        <ul className="card-list small" data-testid="capture-blockers">
          {state.blockers.map((b) => (
            <li key={b} className="state-empty">{b}</li>
          ))}
        </ul>
      )}
      {state && state.can_capture && !asked && (
        <p className="notice small" data-testid="capture-reask">
          Permission is on the file for this meeting already. Ask again before you start anyway —
          consent is something a person gave in a room on a day, not a setting.
        </p>
      )}

      <div className="form-row">
        <button
          type="button"
          className="btn-strong"
          data-testid="capture-start"
          disabled={!state?.can_capture || !asked || recording}
          onClick={() => void start()}
        >
          Start recording
        </button>
        <button type="button" data-testid="capture-stop" disabled={!recording} onClick={stop}>
          Stop
        </button>
        {recording && (
          <span className="capture-live" data-testid="capture-live">
            Recording. Every minute is written down as it finishes.
          </span>
        )}
        {!recording && consentGranted && (
          <span className="muted small">{state?.turns ?? 0} turns written down so far.</span>
        )}
      </div>

      {heard.length > 0 && (
        <ul className="card-list small" data-testid="capture-heard">
          {heard.slice(-6).map((t, i) => (
            <li key={i} className="closeout-quote">“{t}”</li>
          ))}
        </ul>
      )}

      {message && <p className="notice small" data-testid="capture-message" role="status">{message}</p>}
    </div>
  );
}

// ── Who is in the room ────────────────────────────────────────────────────────

interface SeatedEmployee {
  id: string;
  ai_employee_id: string;
  released_at: string | null;
}

/**
 * Seating, which is the good idea nobody used because "add an employee" on an empty meeting is a
 * question with no obvious answer unless you already know all seventeen. Suggesting the right two
 * or three by meeting type is what makes it usable.
 */
function SeatingPanel({ meeting, me }: { meeting: MeetingRow; me: MeResponse }): JSX.Element {
  const liveHelp = useApi<{ seated: SeatedEmployee[] }>(`/api/meetings/${meeting.id}/live-help`, [meeting.id]);
  const lounge = useApi<{ employees: Array<{ id: string; name: string; status: string }> }>("/api/workforce/lounge");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const employed = useMemo(
    () => (lounge.data?.employees ?? []).filter((e) => e.status === "ACTIVE"),
    [lounge.data],
  );
  const byName = useMemo(() => new Map(employed.map((e) => [e.name, e.id])), [employed]);
  const seats = useMemo(
    () => seatableFor(meeting.meeting_type, employed.map((e) => e.name)),
    [meeting.meeting_type, employed],
  );

  const seated = new Set((liveHelp.data?.seated ?? []).filter((s) => !s.released_at).map((s) => s.ai_employee_id));
  const type = meetingType(meeting.meeting_type);

  async function seat(name: string) {
    const id = byName.get(name);
    if (!id) return;
    setBusy(name);
    const res = await api<{ error?: string; detail?: string }>(`/api/meetings/${meeting.id}/employees`, {
      method: "POST",
      body: { ai_employee_id: id },
    });
    setBusy(null);
    if (res.status >= 400) setMessage(res.data?.detail ?? res.data?.error ?? `Could not seat ${name}.`);
    else setMessage(`${name} is in the room.`);
    liveHelp.reload();
  }

  return (
    <div data-testid={`seating-${meeting.id}`}>
      <h4>Who is in the room</h4>
      <p className="muted small">
        Seat an employee to confer with them while the meeting is happening. Seating grants no new
        authority — they see what you see and can do nothing you have not already approved.
      </p>

      {employed.length === 0 ? (
        <p className="state-empty" data-testid="seating-nobody-employed">
          Nobody is employed yet, so there is nobody to seat. Turn someone on from Employees.
        </p>
      ) : (
        <ul className="card-list small" data-testid="seating-list">
          {seats.map((s) => {
            const id = byName.get(s.name);
            const isSeated = id ? seated.has(id) : false;
            return (
              <li key={s.name} className={s.suggested ? "seat-row seat-suggested" : "seat-row"}>
                <div>
                  <strong>{s.name}</strong> <span className="muted small">{s.role}</span>
                  {s.suggested && <span className="badge">suggested</span>}
                  <div className="muted small">{s.because}</div>
                </div>
                <button
                  type="button"
                  disabled={isSeated || busy === s.name}
                  data-testid={`seat-${s.name}`}
                  onClick={() => void seat(s.name)}
                >
                  {isSeated ? "In the room" : busy === s.name ? "…" : "Seat"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {type?.external && (
        <p className="muted small">
          Internal-only employees are not offered here — this meeting has people outside the firm in it.
        </p>
      )}
      {message && <p className="notice small" data-testid="seating-message" role="status">{message}</p>}
      <p className="muted small">Signed in as {me.fullName}. Only a person can seat an employee.</p>
    </div>
  );
}

/**
 * A transcript somebody else recorded.
 *
 * Operator, 22 Aug 2026: "i sometimes have fireflies meeting notes so the meetings should have
 * fireflies and whisper capabilities to transfer those notes and transcripts."
 *
 * PASTE OR UPLOAD, NOT AN INTEGRATION. Reaching Fireflies' API needs a credential, a declared
 * network boundary and a vendor decision; an export already in your hand needs none of those and
 * works today. The API route is designed and deferred — see ADR-019.
 *
 * IT REPORTS WHAT IT COULD NOT READ. Exports vary, and a line the file did not attribute to anybody
 * is kept and said to be unattributed rather than handed to the nearest name above it. Close-out
 * assigns commitments out of these turns, so an invented attribution becomes a task assigned to
 * somebody who never agreed to it.
 */
function FirefliesImport({ meetingId, onImported }: { meetingId: string; onImported: () => void }): JSX.Element {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function send(raw: string) {
    if (!raw.trim()) return;
    setBusy(true);
    setMessage(null);
    const res = await api<{ turns?: number; unattributed?: number; summary_captured?: boolean; error?: string; detail?: string }>(
      `/api/meetings/${meetingId}/transcript/fireflies`,
      { method: "POST", body: { text: raw } },
    );
    setBusy(false);
    if (res.status !== 201) {
      setMessage(res.data?.detail ?? res.data?.error ?? `Not brought in (HTTP ${res.status}).`);
      return;
    }
    const turns = res.data?.turns ?? 0;
    const unnamed = res.data?.unattributed ?? 0;
    setMessage(
      `${turns} turn${turns === 1 ? "" : "s"} brought in` +
        (unnamed > 0 ? `, ${unnamed} of which the export did not say who said` : "") +
        (res.data?.summary_captured ? ". Their own summary is filed separately from what was said." : "."),
    );
    setText("");
    onImported();
  }

  return (
    <div data-testid="fireflies-import">
      <h4>Bring in a Fireflies transcript</h4>
      <p className="muted small">
        Paste the export, or open the file. Nothing here talks to Fireflies — this reads what you
        already have. It still needs the same permission as anything else recorded on this meeting,
        and bringing it in is not the same as having asked: somebody else made this recording.
      </p>
      <textarea
        aria-label="The Fireflies export"
        data-testid="fireflies-text"
        rows={5}
        value={text}
        placeholder="Deana Oliver: we can get you the data room by Friday"
        onChange={(e) => setText(e.target.value)}
      />
      <div className="form-row">
        <button type="button" className="btn-strong" disabled={busy || !text.trim()} data-testid="fireflies-submit" onClick={() => void send(text)}>
          {busy ? "Reading it…" : "Bring it in"}
        </button>
        <label>
          Or open a file{" "}
          <input
            type="file"
            accept=".txt,.md,.vtt,.srt,text/plain"
            data-testid="fireflies-file"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              await send(await file.text());
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {message && <p className="notice small" data-testid="fireflies-message" role="status">{message}</p>}
    </div>
  );
}

// ── The record of one meeting ─────────────────────────────────────────────────

/**
 * Everything one meeting holds: what was said, what was promised, and what became of it.
 *
 * This used to live in App.tsx as a second Meetings page mounted under the first one, printing
 * `MANUAL`, `IMPORTED` and `CONVERTED` at a partner reading their own calendar. It is one panel
 * now, inside the section whose heading says what it is for.
 */
function MeetingRecord({ meetingId, me }: { meetingId: string; me: MeResponse }): JSX.Element {
  const meeting = useApi<MeetingDetailRow>(`/api/meetings/${meetingId}`, [meetingId]);
  const [noteBody, setNoteBody] = useState("");
  const [noteType, setNoteType] = useState("MANUAL");
  const [commitmentText, setCommitmentText] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const m = meeting.data;

  const post = async (path: string, body: unknown, okStatus: number, label: string) => {
    const { status, data } = await api<{ error?: string; detail?: string }>(path, { method: "POST", body });
    setMessage(status === okStatus ? `${label} ok.` : `${label} refused: ${(data as { error?: string })?.error ?? status}`);
    meeting.reload();
  };

  return (
    <div className="card" data-testid="meeting-detail">
      <h4>
        {m?.title ?? "Loading the record…"}{" "}
        <span className="muted small" data-testid="meeting-status">{(m?.status ?? "").toLowerCase()}</span>
      </h4>
      <p className="muted small">
        Recording is{" "}
        <span data-testid="meeting-recording">{m?.recording_enabled === 1 ? "ACTIVE" : "NOT ACTIVATED"}</span>
        {" · "}permission to transcribe:{" "}
        <span data-testid="meeting-consent">{m?.consent_current?.TRANSCRIPTION?.state ?? "NOT RECORDED"}</span>
      </p>

      <div className="form-row">
        <button
          type="button"
          data-testid="consent-grant"
          onClick={() =>
            post(
              `/api/meetings/${meetingId}/consent`,
              { consent_type: "TRANSCRIPTION", state: "GRANTED", basis: "verbal consent recorded on the call", granted_by: "counterparty" },
              201,
              "Consent GRANTED",
            )
          }
        >
          Record that they agreed
        </button>
        <button
          type="button"
          data-testid="consent-revoke"
          onClick={() => post(`/api/meetings/${meetingId}/consent`, { consent_type: "TRANSCRIPTION", state: "REVOKED", basis: "counterparty revoked" }, 201, "Consent REVOKED")}
        >
          They took it back
        </button>
        {/* Both gates are independent: this is refused, and the refusal recorded, unless the
            recording policy was activated through an approved receipt. */}
        <button type="button" data-testid="transcript-import" onClick={() => post(`/api/meetings/${meetingId}/transcript`, { source: "transcription export" }, 201, "Transcript import")}>
          Record that a transcript exists elsewhere
        </button>
        <button type="button" data-testid="prep-assemble" onClick={() => post(`/api/meetings/${meetingId}/prep`, { open_questions: ["What is the authoritative ARR?"] }, 201, "Prep packet")}>
          Prepare for it
        </button>
      </div>

      <h4>What was said</h4>
      <form
        className="form-row"
        data-testid="note-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await post(`/api/meetings/${meetingId}/notes`, { note_type: noteType, body: noteBody }, 201, "Note");
          setNoteBody("");
        }}
      >
        <select data-testid="note-type" aria-label="Kind of note" value={noteType} onChange={(e) => setNoteType(e.target.value)}>
          <option value="MANUAL">On the record</option>
          <option value="OFF_RECORD">Off the record</option>
        </select>
        <input data-testid="note-body" aria-label="What the note says" value={noteBody} onChange={(e) => setNoteBody(e.target.value)} placeholder="what was said" />
        <button type="submit" className="btn-strong" data-testid="note-submit">Add a note</button>
      </form>

      <ul className="card-list small" data-testid="note-list">
        {(m?.notes ?? []).map((n) => (
          <li key={n.id} data-testid={`note-${n.id}`}>
            <span className={n.note_type === "OFF_RECORD" ? "help-tag help-tag-muted" : "help-tag help-tag-good"}>
              {n.note_type === "OFF_RECORD" ? "off record" : n.note_type === "TRANSCRIPT_DERIVED" ? "MANUAL from the recording" : "MANUAL"}
            </span>{" "}
            {n.body}
          </li>
        ))}
        {(m?.notes ?? []).length === 0 && (
          <li className="state-empty" data-testid="no-notes">
            Nothing written down yet. Record the meeting from the section above, or type what was said.
          </li>
        )}
      </ul>

      <FirefliesImport meetingId={meetingId} onImported={() => meeting.reload()} />

      <ul className="card-list small" data-testid="transcript-list">
        {(m?.transcript_imports ?? []).map((tr) => (
          <li key={tr.id} data-testid={`transcript-${tr.id}`}>
            <span className={tr.status === "IMPORTED" ? "help-tag help-tag-good" : "help-tag help-tag-warn"}>{tr.status}</span>{" "}
            {sourceInWords(tr.source, tr.provider_name)}
            {tr.refusal_reason ? <span className="muted small"> — {tr.refusal_reason.split("_").join(" ")}</span> : null}
            {/* WHO RECORDED IT is evidence, not trivia. A turn West Peek captured was recorded with
                permission this firm asked for and logged; a turn out of somebody else's export was
                recorded under conditions nobody here witnessed. */}
            {tr.provider_name && (
              <div className="muted small">
                We did not make this recording and cannot vouch for the permission it was made
                under. Importing it is not the same as having asked.
              </div>
            )}
          </li>
        ))}
        {(m?.transcript_imports ?? []).length === 0 && (
          <li className="state-empty" data-testid="no-transcripts">
            No recording has been brought in. A refusal would show here too — “we did not record” is
            a fact this system writes down rather than an absence.
          </li>
        )}
      </ul>

      <h4>What was promised</h4>
      <form
        className="form-row"
        data-testid="commitment-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await post(`/api/meetings/${meetingId}/commitments`, { commitment_text: commitmentText, owner_side: "FIRM" }, 201, "Commitment");
          setCommitmentText("");
        }}
      >
        <input data-testid="commitment-text" aria-label="What was promised" value={commitmentText} onChange={(e) => setCommitmentText(e.target.value)} placeholder="send the diligence question list" />
        <button type="submit" className="btn-strong" data-testid="commitment-submit">Record it</button>
      </form>

      <ul className="card-list small" data-testid="commitment-list">
        {(m?.commitments ?? []).map((c) => (
          <li key={c.id} data-testid={`commitment-${c.id}`}>
            {c.commitment_text}{" "}
            <span className={c.status === "CONVERTED" ? "help-tag help-tag-good" : "help-tag help-tag-warn"}>
              {c.status === "CONVERTED" ? "CONVERTED into a work card" : "waiting on you"}
            </span>
            {c.status === "OPEN" && (
              <button type="button" className="link-button" data-testid={`commitment-convert-${c.id}`} onClick={() => post(`/api/meeting-commitments/${c.id}/convert`, {}, 200, "Converted to work card")}>
                Make it a work card
              </button>
            )}
          </li>
        ))}
        {(m?.commitments ?? []).length === 0 && (
          <li className="state-empty" data-testid="no-commitments">
            Nothing promised yet. Close-out below reads the notes and proposes these for you.
          </li>
        )}
      </ul>

      {m && <SeatingPanel meeting={m} me={me} />}
      <LiveHelpPanel meetingId={meetingId} />
      <CloseoutPanel meetingId={meetingId} />

      {message && <p className="notice small" data-testid="meeting-message" role="status">{message}</p>}
    </div>
  );
}

// ── The page ──────────────────────────────────────────────────────────────────

export function MeetingsPage({ me, onNavigate }: { me: MeResponse; onNavigate: (key: string) => void }): JSX.Element {
  const meetings = useApi<MeetingsResponse>("/api/meetings");
  const companies = useApi<{ companies: Array<{ id: string; canonical_name: string }> }>("/api/companies");
  const committee = useApi<{ deals: IcDeal[] }>("/api/ic/deals");
  const [title, setTitle] = useState("");
  const [type, setType] = useState("FOUNDER");
  const [companyId, setCompanyId] = useState("");
  const [startsNow, setStartsNow] = useState(true);
  const [live, setLive] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [deciding, setDeciding] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");

  const rows = meetings.data?.meetings ?? [];
  const upcoming = rows.filter((m) => m.status === "SCHEDULED");
  const past = rows.filter((m) => m.status !== "SCHEDULED");
  const liveMeeting = rows.find((m) => m.id === live) ?? null;
  const chosen = meetingType(type);
  const facilitator = meetings.data?.ic?.facilitator ?? null;
  const deals = committee.data?.deals ?? [];

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const now = new Date().toISOString();
    const res = await api<{ id?: string; error?: string; detail?: string }>("/api/meetings", {
      method: "POST",
      body: {
        title: title.trim(),
        // Chosen, never assumed. Close-out delegation reads the type to decide who follows up, so a
        // hardcoded type routed an LP call's commitments to the wrong person — which is what it did.
        meeting_type: type,
        company_id: companyId || undefined,
        ...(startsNow ? { occurred_at: now } : { scheduled_at: now }),
      },
    });
    if (res.status !== 201 || !res.data?.id) {
      setMessage(`Not recorded: ${res.data?.detail ?? res.data?.error ?? res.status}`);
      return;
    }
    // The id is in the message on purpose: it is the one handle a person or a test has on the
    // meeting that was just made, and a message that omits it makes the next step guesswork.
    setMessage(
      startsNow
        ? `Recorded as ${res.data.id}. Ask permission below before anything is captured.`
        : `Recorded as ${res.data.id} and put on the calendar above.`,
    );
    setTitle("");
    meetings.reload();
    if (startsNow) setLive(res.data.id);
    else setOpen(res.data.id);
  }

  async function resolveQuestion(id: string, state: "ANSWERED" | "WITHDRAWN") {
    const res = await api<{ error?: string; detail?: string }>(`/api/ic/questions/${id}/resolve`, {
      method: "POST",
      body: state === "ANSWERED" ? { state, answer } : { state, withdrawn_reason: answer },
    });
    if (res.status >= 400) {
      setMessage(res.data?.detail ?? res.data?.error ?? `Could not record that (HTTP ${res.status}).`);
      return;
    }
    setAnswering(null);
    setAnswer("");
    committee.reload();
  }

  /**
   * Put the packet in front of the partners.
   *
   * This does not decide anything. It raises the human-reserved approval card that an APPROVE has
   * to be recorded against, which is why the decision buttons only appear once it exists.
   */
  async function submitPacket(packetId: string) {
    const res = await api<{ error?: string; detail?: string }>(`/api/ic/packets/${packetId}/submit`, { method: "POST", body: {} });
    setMessage(
      res.status === 200
        ? "It is in front of both partners now. Approving the capital is a separate signature in Approvals."
        : res.data?.detail ?? res.data?.error ?? `Could not put it forward (HTTP ${res.status}).`,
    );
    committee.reload();
  }

  async function decide(deal: IcDeal, decision: "APPROVE" | "REJECT" | "DEFER") {
    if (!deal.packet_id) return;
    const res = await api<{ error?: string; detail?: string }>(`/api/ic/packets/${deal.packet_id}/decide`, {
      method: "POST",
      body: { decision, rationale, receipt_id: deal.approval_card ? deal.approval_card.id : undefined },
    });
    if (res.status !== 201) {
      setMessage(res.data?.detail ?? res.data?.error ?? `Not recorded (HTTP ${res.status}).`);
      return;
    }
    setMessage(
      decision === "APPROVE"
        ? "Recorded. The deal is marked decided."
        : decision === "REJECT"
          ? "Recorded as a pass, with your reason, and the deal is on the pass pile. Nothing is deleted."
          : "Recorded as not yet. The deal stays where it is.",
    );
    setDeciding(null);
    setRationale("");
    committee.reload();
  }

  return (
    <section data-testid="meetings-page">
      {/* ── 1 ─────────────────────────────────────────────────────────────── */}
      <div className="home-section-head">
        <h3>What is coming up</h3>
        <span className="muted small">meetings on the calendar that have not happened yet</span>
      </div>
      <ul className="card-list" data-testid="meetings-upcoming">
        {upcoming.map((m) => (
          <li key={m.id} className="card" data-testid={`upcoming-${m.id}`}>
            <strong>{m.title}</strong>{" "}
            <span className="badge">{meetingType(m.meeting_type)?.label ?? m.meeting_type}</span>{" "}
            <span className="muted small">{whenInWords(m.scheduled_at)}</span>
            <div className="form-row">
              <button type="button" className="link-button" data-testid={`start-${m.id}`} onClick={() => setLive(m.id)}>
                It is happening now
              </button>
              <button type="button" className="link-button" data-testid={`upcoming-open-${m.id}`} onClick={() => setOpen(m.id === open ? null : m.id)}>
                Open its record
              </button>
            </div>
          </li>
        ))}
        {upcoming.length === 0 && (
          <li className="state-empty" data-testid="no-upcoming">
            Nothing is on the calendar. That is not a fault — put one here from “Start a meeting
            now” below by giving it a time instead of starting it.
          </li>
        )}
      </ul>

      {/* ── 2 ─────────────────────────────────────────────────────────────── */}
      <div className="home-section-head">
        <h3>What happened, and what came out of it</h3>
        <span className="muted small">every meeting on the record, newest first</span>
      </div>
      <ul className="card-list" data-testid="meeting-list">
        {past.map((m) => (
          <li key={m.id} className="card" data-testid={`meeting-${m.id}`}>
            <button type="button" className="link-button" data-testid={`meeting-open-${m.id}`} onClick={() => setOpen(m.id === open ? null : m.id)}>
              {m.title}
            </button>{" "}
            <span className="badge">{meetingType(m.meeting_type)?.label ?? m.meeting_type}</span>{" "}
            <span className="muted small">{whenInWords(m.occurred_at ?? m.scheduled_at)}</span>
          </li>
        ))}
        {past.length === 0 && (
          <li className="state-empty" data-testid="no-meetings">
            No meeting has been held yet. Once one has, this is where the notes, what was promised
            and who is holding each piece of it live.
          </li>
        )}
      </ul>
      {open && <MeetingRecord meetingId={open} me={me} />}

      {/* ── 3 ─────────────────────────────────────────────────────────────── */}
      <div className="home-section-head">
        <h3>Start a meeting now</h3>
        <span className="muted small">permission first, then the recording</span>
      </div>
      <form className="card" data-testid="meeting-create-form" onSubmit={create}>
        <div className="form-row">
          <label>
            What is it?{" "}
            <input data-testid="meeting-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Call with Deana Oliver" />
          </label>
          <label>
            Kind{" "}
            <select data-testid="meeting-type" value={type} onChange={(e) => setType(e.target.value)}>
              {MEETING_TYPES.map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
          </label>
          <label>
            Company{" "}
            <select data-testid="meeting-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              <option value="">— none —</option>
              {(companies.data?.companies ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.canonical_name}</option>
              ))}
            </select>
          </label>
          <label>
            When{" "}
            <select data-testid="meeting-when" value={startsNow ? "now" : "later"} onChange={(e) => setStartsNow(e.target.value === "now")}>
              <option value="now">It is happening now</option>
              <option value="later">Put it on the calendar</option>
            </select>
          </label>
          <button type="submit" className="btn-strong" data-testid="meeting-create-submit">Record meeting</button>
        </div>
        {chosen && <p className="muted small" data-testid="meeting-type-when">{chosen.when}</p>}
        {message && <p className="notice small" data-testid="meetings-message" role="status">{message}</p>}
      </form>

      {liveMeeting ? (
        <div className="card" data-testid="live-meeting">
          <h4>{liveMeeting.title}</h4>
          <CapturePanel meeting={liveMeeting} onCaptured={() => meetings.reload()} />
          <SeatingPanel meeting={liveMeeting} me={me} />
          <LiveHelpPanel meetingId={liveMeeting.id} />
          <div className="form-row">
            <button type="button" className="link-button" data-testid="live-finish" onClick={() => { setOpen(liveMeeting.id); setLive(null); }}>
              We are done — open the record
            </button>
          </div>
        </div>
      ) : (
        <p className="state-empty" data-testid="no-live-meeting">
          Nothing is being recorded. Start a meeting above, or say one on the calendar is happening
          now, and the permission prompt and the recorder appear here.
        </p>
      )}

      {/* ── 4 ─────────────────────────────────────────────────────────────── */}
      <div className="home-section-head">
        <h3>Where a deal stands with the committee</h3>
        <span className="muted small">the packet, what it does not know, and who owes each answer</span>
      </div>

      {facilitator && facilitator.status !== "ACTIVE" && (
        <p className="notice small" data-testid="ic-facilitator-off">
          {facilitator.name} facilitates the committee — assembling the packet and recording the
          dissent — and is currently {facilitator.status.toLowerCase()}. The committee can still
          meet; nobody will prepare it or write it down.{" "}
          <button type="button" className="link-button" onClick={() => onNavigate("employees")}>
            Switch her on
          </button>
        </p>
      )}

      <ul className="card-list" data-testid="ic-deals">
        {deals.map((d) => (
          <li key={d.opportunity_id} className="card ic-deal" data-testid={`ic-deal-${d.opportunity_id}`}>
            <h4>
              {d.title}{" "}
              <span className="badge">{d.stage}</span>{" "}
              <span className={d.packet_id ? "help-tag help-tag-good" : "help-tag help-tag-warn"} data-testid={`ic-packet-state-${d.opportunity_id}`}>
                {d.packet_state}
              </span>
            </h4>
            {d.company_name && <p className="muted small">{d.company_name}</p>}

            {d.facilitator_card && (
              <p className="muted small" data-testid={`ic-card-${d.opportunity_id}`}>
                Poppy is holding a work card to assemble it — {d.facilitator_card.state.toLowerCase().split("_").join(" ")}.{" "}
                <button type="button" className="link-button" onClick={() => onNavigate("work")}>
                  Open Work cards
                </button>
              </p>
            )}

            <p className="small"><strong>What the packet does not know</strong></p>
            {d.questions.length === 0 ? (
              <p className="state-empty">
                No gaps have been named yet. A packet with nothing open is either finished or
                unassembled — check whether Poppy has started.
              </p>
            ) : (
              <ul className="card-list small" data-testid={`ic-questions-${d.opportunity_id}`}>
                {d.questions.map((q) => (
                  <li key={q.id} className="ic-question" data-testid={`ic-question-${q.id}`}>
                    <span className={q.state === "OPEN" ? "help-tag help-tag-warn" : q.state === "ANSWERED" ? "help-tag help-tag-good" : "help-tag help-tag-muted"}>
                      {q.state === "OPEN" ? "open" : q.state === "ANSWERED" ? "answered" : "not needed"}
                    </span>{" "}
                    <strong>{q.question}</strong>
                    <div className="muted small">{q.because}</div>
                    <div className="ic-owes">Owed by {owedInWords(q)}</div>
                    {q.answer && <div className="closeout-quote">{q.answer}</div>}
                    {q.withdrawn_reason && <div className="muted small">Not needed because {q.withdrawn_reason}</div>}
                    {q.state === "OPEN" && answering !== q.id && (
                      <button type="button" className="link-button" data-testid={`ic-answer-${q.id}`} onClick={() => { setAnswering(q.id); setAnswer(""); }}>
                        Answer it
                      </button>
                    )}
                    {answering === q.id && (
                      <div className="form-row">
                        <label>
                          The answer{" "}
                          <input value={answer} onChange={(e) => setAnswer(e.target.value)} data-testid={`ic-answer-text-${q.id}`} placeholder="what we found" />
                        </label>
                        <button type="button" className="btn-strong" disabled={!answer.trim()} data-testid={`ic-answer-save-${q.id}`} onClick={() => void resolveQuestion(q.id, "ANSWERED")}>
                          Save
                        </button>
                        <button type="button" disabled={!answer.trim()} data-testid={`ic-withdraw-${q.id}`} onClick={() => void resolveQuestion(q.id, "WITHDRAWN")}>
                          We do not need this
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <p className="small"><strong>Who is in the room</strong></p>
            <ul className="card-list small" data-testid={`ic-seats-${d.opportunity_id}`}>
              {d.seats.map((s) => (
                <li key={s.name}>
                  <strong>{s.name}</strong>{" "}
                  {s.decides && <span className="badge badge-gate">decides</span>}
                  <div className="muted small">{s.role}</div>
                </li>
              ))}
              {d.seats.length === 0 && (
                <li className="state-empty">
                  Nobody is seated. A committee with no named members is one nobody has agreed to sit on.
                </li>
              )}
            </ul>

            {d.decision ? (
              <p className="notice small" data-testid={`ic-decision-${d.opportunity_id}`}>
                <strong>
                  {d.decision.decision === "APPROVE" ? "The firm is investing." : d.decision.decision === "REJECT" ? "The firm passed." : "Not yet — deferred."}
                </strong>{" "}
                {d.decision.rationale}
                <span className="muted small"> · {whenInWords(d.decision.created_at)}</span>
              </p>
            ) : (
              <>
                <p className="muted small">
                  No decision recorded. It is made against the packet, by both partners, with an
                  approval receipt behind it — and a pass keeps its reason forever.
                </p>
                {d.packet_id && !d.approval_card && (
                  <button type="button" className="btn-strong" data-testid={`ic-submit-${d.opportunity_id}`} onClick={() => void submitPacket(d.packet_id!)}>
                    Put it in front of the partners
                  </button>
                )}
                {d.packet_id && d.approval_card && deciding !== d.opportunity_id && (
                  <div className="form-row">
                    <span className="muted small">
                      In front of both partners. Investing needs the approval signed off in Approvals
                      first; passing and deferring do not.
                    </span>
                    <button type="button" className="btn-strong" data-testid={`ic-decide-${d.opportunity_id}`} onClick={() => { setDeciding(d.opportunity_id); setRationale(""); }}>
                      Record what the committee decided
                    </button>
                  </div>
                )}
                {deciding === d.opportunity_id && (
                  <div className="form-row">
                    <label>
                      Why{" "}
                      <input
                        value={rationale}
                        data-testid={`ic-rationale-${d.opportunity_id}`}
                        onChange={(e) => setRationale(e.target.value)}
                        placeholder="the second founder had already left and nobody would say why"
                      />
                    </label>
                    <button type="button" className="btn-strong" data-testid={`ic-invest-${d.opportunity_id}`} onClick={() => void decide(d, "APPROVE")}>
                      The firm is investing
                    </button>
                    {/* A pass needs a sentence. "We passed in August" is a fact; the reason is what
                        you want in front of you when they come back raising. */}
                    <button type="button" disabled={rationale.trim().length < 12} data-testid={`ic-pass-${d.opportunity_id}`} onClick={() => void decide(d, "REJECT")}>
                      The firm passes
                    </button>
                    <button type="button" data-testid={`ic-defer-${d.opportunity_id}`} onClick={() => void decide(d, "DEFER")}>
                      Not yet
                    </button>
                  </div>
                )}
              </>
            )}

            {/* The four things a committee needs are ON this page, and so is the decision. What is
                NOT here is the eleven-section diligence framework, which is a different depth of
                work and belongs with the deal record. */}
            {d.packet_id && (
              <button type="button" className="link-button" data-testid={`ic-open-${d.opportunity_id}`} onClick={() => onNavigate("dealflow")}>
                Open the deal itself in Dealflow
              </button>
            )}
          </li>
        ))}
        {deals.length === 0 && (
          <li className="state-empty" data-testid="no-ic-deals">
            No deal has reached the committee. That is not a fault — a deal has to get through
            screening and diligence first, and the moment one moves to the committee stage a packet
            opens here on its own with a card for Poppy to assemble it.
          </li>
        )}
      </ul>

      {/* ── 5 ─────────────────────────────────────────────────────────────── */}
      <div className="home-section-head">
        <h3>How a meeting becomes work</h3>
        <span className="muted small">the whole chain, whether or not anything is in it yet</span>
      </div>
      <p className="muted small">
        Nothing on this page sends anything or decides anything. The chain below is what actually
        happens to a conversation after it ends: it is read, what was agreed is proposed back to you
        as work, and you are the one who accepts it.
      </p>
      <ol className="ic-flow" data-testid="meeting-chain">
        <li className="ic-step">
          <span className="ic-step-num" aria-hidden="true">1</span>
          <div className="ic-step-body">
            <p className="ic-step-title"><strong>Permission, then the recording</strong></p>
            <p className="small">
              You ask out loud, the answer goes on the file, and only then can anything be captured.
              Taking permission back closes the door again immediately, and a refusal is written
              down rather than leaving a gap that looks like an oversight.
            </p>
            <p className="muted small">You ask. Nobody else can record that somebody agreed.</p>
          </div>
        </li>
        <li className="ic-step">
          <span className="ic-step-num" aria-hidden="true">2</span>
          <div className="ic-step-body">
            <p className="ic-step-title"><strong>Walter reads the notes and proposes the follow-ups</strong></p>
            <p className="small">
              Each one quotes the line it came from, so you can check it against the words it was
              read out of. Proposals only — nothing is assigned by the model.
            </p>
            <p className="muted small">Walter proposes. He never assigns.</p>
          </div>
        </li>
        <li className="ic-step">
          <span className="ic-step-num" aria-hidden="true">3</span>
          <div className="ic-step-body">
            <p className="ic-step-title"><strong>Who holds each one is decided in code, not by the model</strong></p>
            <p className="small">
              Employees by default; work that genuinely needs a person is recommended to you and
              never assigned to anybody. The policy holds even on a run where the model ignores its
              instructions, because it is not the model making the choice.
            </p>
            <p className="muted small">The firm's rule, applied the same way every time.</p>
          </div>
        </li>
        <li className="ic-step">
          <span className="ic-step-num" aria-hidden="true">4</span>
          <div className="ic-step-body">
            <p className="ic-step-title"><strong>You turn what you accept into a work card</strong></p>
            <p className="small">
              A promise sitting in a close-out is a note. A work card is the thing that gets worked,
              chased and closed — so nothing leaves this page as work until you say it should.
            </p>
            <p className="muted small">You accept. Nothing is sent to anybody outside the firm by any of this.</p>
          </div>
        </li>
      </ol>

      <p className="small"><strong>And how a deal becomes a decision</strong></p>
      <ol className="ic-flow" data-testid="ic-flow">
        {IC_FLOW.map((step, i) => (
          <li key={step.key} className="ic-step" data-testid={`ic-step-${step.key}`}>
            <span className="ic-step-num" aria-hidden="true">{i + 1}</span>
            <div className="ic-step-body">
              <p className="ic-step-title"><strong>{step.title}</strong></p>
              <p className="small">{step.what}</p>
              <p className="muted small">
                {step.who} · needs {step.needs.charAt(0).toLowerCase() + step.needs.slice(1)}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <p className="muted small">
        A deal enters that sequence by moving to the committee stage in Dealflow. Nothing else
        triggers it, and nothing about arriving there decides anything.{" "}
        <button type="button" className="link-button" data-testid="meetings-ic-open" onClick={() => onNavigate("dealflow")}>
          Open Dealflow
        </button>
      </p>
    </section>
  );
}
