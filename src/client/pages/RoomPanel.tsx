import { AllocationRing } from "./AllocationRing";
import type { RingSlice } from "@shared/fund/allocation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, useApi } from "../lib/api";
import { callIsOver, hearing as hearingOf, type HearingFacts } from "@shared/meetings/howTheRoomHears";
import { LAPTOP_MIC_NOTE, RETURN_LABEL, RETURN_LINE, meetingFaceHash } from "@shared/meetings/meetJoin";
import { CallDoors } from "./CallDoors";
import { portraitAlt, portraitFor } from "../lib/employeePortraits";

/**
 * THE DURING FACE — the meeting is a live room (Phase C, owner-approved 18 Sep 2026).
 *
 * One panel, five things, top to bottom: the recording STATUS LINE with its one button (the consent
 * prompt still asked every session — it opens when the button is pressed, and is never remembered);
 * the ROLLING SUMMARY (Phase B's After draft, written while they talk, a DRAFT until a partner
 * approves it on the record); ASK THE ROOM by text or by push-to-talk (the room hears only while
 * the button is held); the ARTIFACTS STREAM — every answer, table, chart and task receipt saved on
 * the meeting, never chat that evaporates; and WHO IS SEATED with a live chip per task.
 *
 * NOTHING HERE WRITES A RECORD. The server enforces it (`meetingRoom.ts`,
 * `validate:voice-is-read-only`); this panel simply has no control that could. The draft's
 * "approve" lives in the After panel on the record, where a person reads it first.
 *
 * TIER 3. The panel takes only a meeting id and reads one route, so `#/room/<id>` renders it alone
 * without the app shell — the shape a Meet Add-on side panel hosts later (App.tsx, `RoomStandalone`).
 *
 * PHASE D (design/DEALS_SECTION_DESIGN.md §3, artboards C2 and D). The recording is ONE line — a
 * switch, the live dot, the status and its consent sentence, Stop — and the room is two columns:
 * the draft, the ask box and the artifacts on the left; whatever the page puts beside it on the
 * right (`aside`: who is in the room, the question checklist, the way out). Standalone at 360px it
 * is one column and the seats are chips. Every class is from the stylesheet's declared-ahead block.
 */

interface CaptureReadiness {
  transcription_available: boolean;
  recording_policy_active: boolean;
  consent: Record<string, string>;
  can_capture: boolean;
  blockers: string[];
  turns: number;
}

interface Artifact {
  id: string;
  kind: "answer" | "table" | "chart" | "packet" | "summary";
  title: string;
  body_json: string;
  asked_text: string | null;
  asked_via: "TEXT" | "VOICE" | "SYSTEM" | null;
  work_card_id: string | null;
  created_at: string;
}

interface Task {
  work_card_id: string;
  title: string;
  state: string;
  owner_name: string | null;
  chip: "working" | "done" | "needs you";
  block_needed: string | null;
}

interface Draft {
  id: string;
  state: string;
  draft_json: string;
  drafted_by: string;
  detail: string | null;
  created_at: string;
}

interface RoomState {
  meeting: { id: string; title: string; meeting_type: string; status: string; ai_access_state: string; confidential: boolean };
  host: { name: string; role: string } | null;
  capture: CaptureReadiness;
  summary: Draft | null;
  artifacts: Artifact[];
  seated: Array<{ ai_employee_id: string; name: string; role: string }>;
  tasks: Task[];
  roll_every_ms: number;
}

const CHUNK_MS = 60_000;
const POLL_MS = 15_000;

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

function canRecordHere(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";
}

function parseBody(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function RoomPanel({ meetingId, standalone = false, aside, armLaptopMic = false }: { meetingId: string; standalone?: boolean; aside?: ReactNode; armLaptopMic?: boolean }): JSX.Element {
  const room = useApi<RoomState>(`/api/meetings/${meetingId}/room`, [meetingId]);
  const hearingRead = useApi<{ facts: HearingFacts }>(`/api/meetings/${meetingId}/hearing`, [meetingId]);
  const [message, setMessage] = useState<string | null>(null);
  // The one fact only this browser has: whether its recorder is running right now.
  const [live, setLive] = useState(false);
  // The laptop-mic path onto a Meet call: arrived armed (`#/room/<id>?mic=1`) or armed in place.
  // The recording line opens the consent prompt the moment the room's gates allow it — the SAME
  // prompt, the same yes; nothing records before "They said yes".
  const [armed, setArmed] = useState(armLaptopMic);
  const roomReload = room.reload;
  const hearingReload = hearingRead.reload;
  const reload = useCallback(() => {
    roomReload();
    hearingReload();
  }, [roomReload, hearingReload]);

  // The room changes underneath the reader — a card finishes, a chunk lands — so it re-reads on a
  // quiet interval. One route, one read; nothing here fires per block.
  useEffect(() => {
    const id = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(id);
  }, [reload]);

  const state = room.data;
  const facts = hearingRead.data?.facts ?? null;
  /*
   * RETURN WHEN IT IS OVER (owner, 19 Sep 2026: "we can return when it's over"). The call is over
   * when `meeting.call_ended_at` is set (`CALL_ENDED_SIGNAL`, #131's column — the live listener's
   * ENDED report or Google's end time, first writer wins), or, on a head without that column, when
   * the Meet inbox row carries Google's `conference_ended_at`; or the meeting is HELD. The narrow
   * room then shows one primary that returns her to the full After face in the app.
   */
  const over = (facts ? callIsOver(facts) : false) || state?.meeting.status === "HELD";
  const goToAfter = () => {
    window.location.hash = meetingFaceHash(meetingId, "after");
  };

  const summary = <SummaryBlock meetingId={meetingId} summary={state?.summary ?? null} turns={state?.capture.turns ?? 0} rollEveryMs={state?.roll_every_ms ?? 300_000} onRolled={reload} compact={standalone} />;
  const ask = <AskBox meetingId={meetingId} hostName={state?.host?.name ?? "Walter"} revoked={state?.meeting.ai_access_state === "REVOKED"} onAsked={reload} onMessage={setMessage} compact={standalone} />;
  const stream = <ArtifactStream artifacts={state?.artifacts ?? []} tasks={state?.tasks ?? []} loading={room.loading} />;
  const recording = <RecordingLine meetingId={meetingId} capture={state?.capture ?? null} onChange={reload} onLive={setLive} armed={armed} onDisarm={() => setArmed(false)} />;

  if (standalone) {
    /*
     * THE NARROW ROOM — 320 to 400px, the width of Meet's side panel (owner, 19 Sep 2026: "if
     * inside, it loads a new layout"). One column, in this order: how this room hears as one chip;
     * the head with the call's doors and, when it is over, the way back; the recording line; the
     * rolling draft first; the stream; the seats as avatars with a count; and the ask box pinned to
     * the bottom with hold-to-talk as the biggest target. No shell, no nav.
     */
    return (
      <section className="room room-standalone" data-testid={`room-${meetingId}`} aria-label="The live room">
        <HearingLine meetingId={meetingId} facts={facts} live={live} loading={hearingRead.loading} status={hearingRead.status} chip />
        <div className="room-head">
          <h3>{state?.meeting.title ?? "The room"}</h3>
          <span className="muted small">{state ? `${state.meeting.meeting_type} · ${state.meeting.status.toLowerCase()}` : "Reading the room…"}</span>
          {facts?.meet_link && <CallDoors meeting={{ id: meetingId, meet_link: facts.meet_link }} standalone compact onArmMic={() => setArmed(true)} />}
          {over && (
            <div className="stack" data-testid={`room-over-${meetingId}`}>
              <button type="button" className="btn-strong btn-lg" data-testid={`room-return-${meetingId}`} aria-describedby={`room-return-line-${meetingId}`} onClick={goToAfter}>
                {RETURN_LABEL}
              </button>
              <span className="field-help" id={`room-return-line-${meetingId}`}>{RETURN_LINE}</span>
            </div>
          )}
        </div>
        {recording}
        <div className="stack room-scroll">
          {summary}
          {stream}
          <SeatedRow seated={state?.seated ?? []} tasks={state?.tasks ?? []} compact />
        </div>
        <div className="room-dock">
          {ask}
          <button type="button" className={over ? "btn-ghost" : undefined} data-testid={`room-finish-${meetingId}`} onClick={goToAfter}>
            Done — open the record
          </button>
        </div>
        {message && <p className="notice small" data-testid="room-message" role="status">{message}</p>}
      </section>
    );
  }

  const left = (
    <>
      {summary}
      {ask}
      {stream}
    </>
  );
  return (
    <section className="room" data-testid={`room-${meetingId}`} aria-label="The live room">
      {recording}
      <HearingLine meetingId={meetingId} facts={facts} live={live} loading={hearingRead.loading} status={hearingRead.status} />

      {!aside ? (
        <div className="stack">
          {left}
          <SeatedRow seated={state?.seated ?? []} tasks={state?.tasks ?? []} />
        </div>
      ) : (
        <div className="room-grid">
          <div className="stack">{left}</div>
          <div className="stack">{aside}</div>
        </div>
      )}

      {message && <p className="notice small" data-testid="room-message" role="status">{message}</p>}
    </section>
  );
}

// ── 1 · The recording, one line ───────────────────────────────────────────────────────────────

/**
 * One status line and one button. The two gates (a Managing Partner's recording policy, and the
 * room's consent today) are still both required — they are the reason the line reads what it
 * reads — but the explanation is demoted to the tooltip and a secondary line, because a partner
 * mid-call needs "Recording" or "Not recording — why" and nothing longer.
 *
 * THE PROMPT IS SHOWN EVERY TIME AND IS NEVER REMEMBERED. Pressing Start opens it; the answer is
 * recorded on the file; only "yes" lets the recorder start; stopping re-arms it.
 *
 * EACH SLICE IS A COMPLETE RECORDING. The recorder is stopped and restarted every minute rather
 * than streamed, because a timesliced stream's later fragments are not independently decodable.
 */
function RecordingLine({ meetingId, capture, onChange, onLive, armed = false, onDisarm }: { meetingId: string; capture: CaptureReadiness | null; onChange: () => void; onLive: (live: boolean) => void; armed?: boolean; onDisarm?: () => void }): JSX.Element {
  const [prompting, setPrompting] = useState(false);
  const [asked, setAsked] = useState(false);
  const [who, setWho] = useState("");
  const [basis, setBasis] = useState("Asked out loud at the start of the call.");
  const [recording, setRecording] = useState(false);
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [engine, setEngine] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const seqRef = useRef(0);

  // A recorder left running after the panel goes away would hold the microphone open with nothing
  // on screen saying so.
  useEffect(() => () => stopRef.current?.(), []);
  // The "How this room hears" line reads the recorder's state from here — the one fact the server
  // cannot know.
  useEffect(() => onLive(recording), [recording, onLive]);
  /*
   * THE LAPTOP-MIC PATH ARMS THE SAME PROMPT (owner, 19 Sep 2026). Arrived from "Use my laptop mic
   * for this Meet call": the moment the room's gates are known, the consent prompt opens — the same
   * prompt, the same yes — or the line says which gate is shut. Nothing records before "They said
   * yes"; the recorder starts only from `answerPrompt`, as always.
   */
  const promptedRef = useRef(false);
  useEffect(() => {
    if (!armed) {
      promptedRef.current = false;
      return;
    }
    if (!capture || recording || prompting || promptedRef.current) return;
    promptedRef.current = true;
    if (!capture.transcription_available || !capture.recording_policy_active) {
      setMessage(`Nothing can start yet — ${capture.blockers[0] ?? "the room is not ready."}`);
      return;
    }
    setPrompting(true);
  }, [armed, capture, recording, prompting]);

  const state = capture;
  const consentGranted = state?.consent.TRANSCRIPTION === "GRANTED" && state?.consent.RECORDING === "GRANTED";

  async function answerPrompt(answer: "GRANTED" | "DENIED") {
    setBusy(true);
    setMessage(null);
    const res = await api<CaptureReadiness & { error?: string; detail?: string }>(`/api/meetings/${meetingId}/capture/consent`, {
      method: "POST",
      body: { answer, granted_by: who.trim() || undefined, basis: basis.trim() },
    });
    setBusy(false);
    if (res.status !== 201) {
      setMessage(res.data?.detail ?? res.data?.error ?? `Not recorded (HTTP ${res.status}).`);
      return;
    }
    setAsked(answer === "GRANTED");
    setPrompting(false);
    setMessage(answer === "GRANTED" ? "Their yes is on the file for this meeting and can be taken back at any point." : "Recorded as a no. Nothing will be captured, and that refusal is on the file too.");
    onChange();
    // THE SERVER SAYS WHETHER A CHUNK WOULD BE WRITTEN DOWN, not the click. A yes with the policy
    // gate still shut, or no transcription service, records the consent and starts nothing.
    if (answer === "GRANTED" && res.data?.can_capture) void start();
    else if (answer === "GRANTED") setMessage(`Their yes is on the file, but nothing is recording: ${res.data?.blockers?.[0] ?? "the room is not ready."}`);
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
    const res = await api<{ text?: string; engine?: string; fallback_reason?: string | null; error?: string; detail?: string }>(
      `/api/meetings/${meetingId}/capture/chunk`,
      { method: "POST", body: { audio_base64: audio, sequence: seqRef.current++, content_type: blob.type || "audio/webm", via: "laptop_mic" } },
    );
    if (res.status !== 201) {
      // Named, never dropped. A transcript with a silent hole in it is worse than a short one.
      setMessage(`Minute ${seqRef.current} was not written down: ${res.data?.detail ?? res.data?.error ?? res.status}`);
      return;
    }
    if (res.data?.engine) setEngine(res.data.engine === "NOVA3" ? "with speakers" : `words only${res.data.fallback_reason ? " — Nova-3 unavailable" : ""}`);
    onChange();
  }

  function stop() {
    stopRef.current?.();
    stopRef.current = null;
    setRecording(false);
    // The prompt is re-armed, deliberately: starting again is a new start and asks again.
    setAsked(false);
    onDisarm?.();
  }

  async function start() {
    setMessage(null);
    if (!canRecordHere()) {
      setMessage("This browser will not record audio for a page. Nothing was started.");
      return;
    }
    let stream: MediaStream;
    // The wait for the microphone is a state the line says, not a silence.
    setOpening(true);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setOpening(false);
      setMessage("The browser did not give this page the microphone, so nothing is being recorded.");
      return;
    }
    setOpening(false);
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

  const gateWords = "Two gates, both required: a Managing Partner switches recording on for the meeting (a receipt), and somebody in the room says yes today. The yes is asked for every session and never remembered.";
  const status = recording
    ? `Recording${engine ? ` · ${engine}` : ""} · ${state?.turns ?? 0} turns written down`
    : opening
      ? "Opening the microphone…"
    : !state
      ? "Reading the room…"
      : state.blockers.length > 0 && !state.can_capture
        ? `Not recording — ${state.blockers[0]}`
        : `Not recording · ${state.turns} turns on the record`;
  // The sentence under the status: the consent on file, or the rule, or the last thing that went wrong.
  const failed = message !== null && /was not written down/.test(message);
  const consentLine = recording && consentGranted
    ? "Their yes is on the file for this meeting and can be taken back at any point."
    : `${gateWords.split(".")[0]}.`;

  return (
    <div data-testid={`capture-${meetingId}`}>
      {/*
        THE SWITCH, EIGHT STATES (§3): off · on · focus · disabled with its reason in the line ·
        loading "Reading the room…" · error "Minute N was not written down" · success (on, consent on
        file). role=switch + aria-checked; the 44px hit area is the stylesheet's ::before inset. Off,
        it opens the prompt — consent is what the prompt collects, so a switch gated on consent could
        never be pressed to ask for it. On, it stops. It is never offered as on-and-inert: the two
        gates the prompt cannot open (a transcription service, the Managing Partner's policy) disable
        it, and the line says which.
      */}
      <div className="rec-line">
        <button
          type="button"
          className="switch"
          role="switch"
          aria-checked={recording}
          aria-label="Recording"
          data-testid="capture-start"
          title={gateWords}
          aria-busy={!state || opening}
          data-state={failed ? "error" : recording && consentGranted ? "success" : undefined}
          disabled={!recording && (!state?.transcription_available || !state?.recording_policy_active || prompting || opening)}
          onClick={recording ? stop : () => setPrompting(true)}
        >
          <i aria-hidden="true" />
        </button>
        <span className="live-dot" aria-hidden="true" hidden={!recording} />
        {/* role=status: a screen reader hears "Recording" / "Not recording — why" when it changes,
            without the line stealing focus. The text IS the cue; the tint is decoration. */}
        <div className="rec-text" data-testid="room-status" role="status" aria-live="polite">
          <strong className={recording ? "capture-live" : undefined}>{status}</strong>
          <span>{consentLine}</span>
        </div>
        {recording ? (
          <button type="button" data-testid="capture-stop" onClick={stop}>Stop</button>
        ) : (
          <span aria-hidden="true" />
        )}
      </div>

      {armed && <p className="notice small" data-testid="laptop-mic-note" role="status">{LAPTOP_MIC_NOTE}</p>}

      {state && state.blockers.length > 0 && (
        <ul className="card-list small" data-testid="capture-blockers">
          {state.blockers.map((b) => (
            <li key={b} className="state-empty">{b}</li>
          ))}
        </ul>
      )}

      {prompting && (
        <div className="room-consent" data-testid="consent-prompt">
          {state?.can_capture && consentGranted && !asked && (
            <p className="notice small" data-testid="capture-reask">
              Permission is on the file for this meeting already. Ask again before you start anyway —
              consent is something a person gave in a room on a day, not a setting.
            </p>
          )}
          <p className="consent-script" data-testid="consent-script">
            “Before we start — I record these calls so I can write up what we agreed rather than take
            notes at you. It stays inside the firm. Is that alright with you?”
          </p>
          <div className="form-row">
            <label>
              Who said yes{" "}
              <input data-testid="consent-who" value={who} onChange={(e) => setWho(e.target.value)} placeholder="Deana Oliver" />
            </label>
            <label>
              How you asked{" "}
              <input data-testid="consent-basis" value={basis} onChange={(e) => setBasis(e.target.value)} />
            </label>
            <button type="button" className="btn-strong" disabled={busy} data-testid="consent-yes" onClick={() => void answerPrompt("GRANTED")}>
              They said yes — record
            </button>
            <button type="button" disabled={busy} data-testid="consent-no" onClick={() => void answerPrompt("DENIED")}>
              They said no
            </button>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => { setPrompting(false); onDisarm?.(); }}>
              Not now
            </button>
          </div>
        </div>
      )}

      {message && <p className="notice small" data-testid="capture-message" role="status">{message}</p>}
    </div>
  );
}

// ── 1b · How this room hears ─────────────────────────────────────────────────────────────────

/**
 * ONE LINE UNDER THE RECORDING SWITCH THAT SAYS HOW THE WORDS REACH THE RECORD.
 *
 * Owner, 19 Sep 2026: "If I push Join on Meet what happens? … Is it recording? Are my AI employees
 * there from Join on Meet alone?" The recording line answers "is THIS switch on"; this line answers
 * the rest: a Google Meet call is transcribed by Google and read in after it ends (the cadence from
 * the job row), the laptop switch is a different path that hears the call through the speakers, and
 * no employee is ever in the Meet. Every sentence is a named state chosen in
 * `shared/meetings/howTheRoomHears.ts` from the facts the Worker serves plus this browser's
 * recorder — never composed here. States: loading, error, and one of the named states.
 */
function HearingLine({ meetingId, facts, live, loading, status, chip = false }: { meetingId: string; facts: HearingFacts | null; live: boolean; loading: boolean; status: number | null; chip?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  if (!facts) {
    return (
      <p className={chip ? "hears hears-chip" : "hears"} data-testid={`hears-${meetingId}`} data-state={loading ? "loading" : "error"} role="status" aria-live="polite">
        <span className="eyebrow">How this room hears</span>
        <span className="muted small">{loading ? "Reading how this room hears…" : `Could not read how this room hears (HTTP ${status ?? "—"}).`}</span>
      </p>
    );
  }
  const h = hearingOf(facts, { live });
  if (chip) {
    // The narrow room: one chip at the top, the sentence behind it on a press (8 states: the
    // named state on data-state; open/closed on aria-expanded; focus, hover and active from .hears-chip).
    return (
      <div className="hears hears-chip" data-testid={`hears-${meetingId}`} data-state={h.state} role="status" aria-live="polite">
        <button type="button" className="hears-chip-button" aria-expanded={open} aria-controls={`hears-detail-${meetingId}`} data-testid="hears-chip" onClick={() => setOpen((v) => !v)}>
          <span className="live-dot" aria-hidden="true" hidden={!live} />
          <span className="eyebrow">{h.channel}</span>
          <span data-testid="hears-chip-words">{h.chip}</span>
        </button>
        <div id={`hears-detail-${meetingId}`} hidden={!open} className="stack">
          <span data-testid="hears-sentence">{h.sentence}</span>
          {h.live_sentence && <span className="muted small" data-testid="hears-live-path" data-path={h.live_path ?? undefined}>{h.live_sentence}</span>}
        </div>
      </div>
    );
  }
  return (
    <div className="hears" data-testid={`hears-${meetingId}`} data-state={h.state} role="status" aria-live="polite">
      <span className="eyebrow">How this room hears · {h.channel}</span>
      <span data-testid="hears-sentence">{h.sentence}</span>
      {h.live_sentence && <span className="muted small" data-testid="hears-live-path" data-path={h.live_path ?? undefined}>{h.live_sentence}</span>}
    </div>
  );
}

// ── 2 · The rolling summary ───────────────────────────────────────────────────────────────────

interface DraftJson {
  decisions?: Array<{ decision_text: string }>;
  commitments?: Array<{ commitment_text: string; owner_side: string; owed_by?: string | null }>;
  open_questions?: Array<{ question: string; owed_by?: string | null }>;
  stage_proposal?: { to_status: string; rationale: string } | null;
}

/**
 * The After draft, written while they talk. Rolled every five minutes while the panel is open and
 * there is something new on the record, or on demand. Idempotent server-side (Phase B), so the
 * timer costs a run only when the transcript changed.
 */
function SummaryBlock({ meetingId, summary, turns, rollEveryMs, onRolled, compact }: { meetingId: string; summary: Draft | null; turns: number; rollEveryMs: number; onRolled: () => void; compact: boolean }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const lastTurns = useRef<number>(-1);

  const roll = useCallback(async () => {
    setBusy(true);
    const res = await api<{ draft?: Draft; reused?: boolean; error?: string; detail?: string }>(`/api/meetings/${meetingId}/room/roll`, { method: "POST", body: {} });
    setBusy(false);
    if (res.status !== 201) setNote(res.data?.detail ?? res.data?.error ?? `Could not refresh (HTTP ${res.status}).`);
    else setNote(res.data?.reused ? "Nothing new since the last draft." : res.data?.draft?.detail ?? null);
    onRolled();
  }, [meetingId, onRolled]);

  // Every rollEveryMs, if the transcript grew since the last roll. Never on an unchanged record.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (turns > 0 && turns !== lastTurns.current) {
        lastTurns.current = turns;
        void roll();
      }
    }, rollEveryMs);
    return () => window.clearInterval(id);
  }, [turns, rollEveryMs, roll]);

  const draft: DraftJson = summary ? parseBody(summary.draft_json) : {};
  const minutes = Math.max(1, Math.round(rollEveryMs / 60_000));
  return (
    <section className="card" data-testid="room-summary">
      <div className="panel-head">
        <h3>{compact ? "Said, decided, promised, left open" : "What has been said, decided, promised, and left open"}</h3>
        <span className="muted small">
          {summary && <><span className="badge" data-testid="room-summary-state">{summary.state === "APPROVED" ? "APPROVED" : "DRAFT"}</span> by {summary.drafted_by} · </>}
          rolls every {minutes} minute{minutes === 1 ? "" : "s"} ·{" "}
          <button type="button" className="btn-ghost" data-testid="room-roll" disabled={busy} onClick={() => void roll()}>
            {busy ? "Writing…" : "refresh now"}
          </button>
        </span>
      </div>
      {!summary ? (
        <p className="state-empty" data-testid="room-summary-empty">
          {turns > 0 ? `The draft is written every ${minutes} minutes from what has been said. Nothing yet.` : "Nothing is on the record yet. Once the room is recording, the draft writes itself as they talk."}
        </p>
      ) : (
        <div className="stack transcript">
          {(draft.decisions ?? []).length > 0 && (
            <ul className="card-list" data-testid="room-draft-decisions">
              {draft.decisions!.map((d, i) => <li key={i}><b>Decided:</b> {d.decision_text}</li>)}
            </ul>
          )}
          {(draft.commitments ?? []).length > 0 && (
            <ul className="card-list" data-testid="room-draft-commitments">
              {draft.commitments!.map((c, i) => <li key={i}><b>{c.owner_side === "FIRM" ? "We owe:" : "They owe:"}</b> {c.commitment_text}{c.owed_by ? ` — ${c.owed_by}` : ""}</li>)}
            </ul>
          )}
          {(draft.open_questions ?? []).length > 0 && (
            <ul className="card-list" data-testid="room-draft-questions">
              {draft.open_questions!.map((q, i) => <li key={i}><b>Open:</b> {q.question}{q.owed_by ? ` — ${q.owed_by}` : ""}</li>)}
            </ul>
          )}
          {draft.stage_proposal && (
            <p className="notice small" data-testid="room-draft-stage">Proposed stage move to <b>{draft.stage_proposal.to_status}</b>: {draft.stage_proposal.rationale}. A proposal only — you click it on the After face.</p>
          )}
          {summary.state !== "APPROVED" && <p className="muted small">Nothing here is a record yet — a partner approves this on the record after the meeting.</p>}
          {summary.detail && <p className="muted small">{summary.detail}</p>}
        </div>
      )}
      {note && <p className="muted small" data-testid="room-roll-note">{note}</p>}
    </section>
  );
}

// ── 3 · Ask the room: text, or hold to talk ───────────────────────────────────────────────────

/**
 * Ask the room.
 *
 * THE MICROPHONE IS HELD, NEVER LEFT OPEN. Pointer: down starts, up (or leaving the button) stops.
 * Keyboard: hold Space — keydown starts, keyup stops — or, for anyone who cannot hold a key, Enter
 * TOGGLES: once to start listening, once more to stop, with the button's own label saying which.
 * A release that arrives while the microphone is still being granted is honoured: the stream is
 * closed the moment it opens, so a quick tap never leaves the room listening.
 *
 * FOCUS STAYS WHERE IT WAS. The input is read-only while a question is in flight rather than
 * disabled — a disabled control drops keyboard focus to the page, and a partner mid-call would have
 * to find the box again for the next question.
 */
function AskBox({ meetingId, hostName, revoked, onAsked, onMessage, compact }: { meetingId: string; hostName: string; revoked: boolean; onAsked: () => void; onMessage: (m: string | null) => void; compact: boolean }): JSX.Element {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [holding, setHolding] = useState(false);
  const recRef = useRef<{ rec: MediaRecorder; stream: MediaStream; parts: Blob[] } | null>(null);
  // Set when a release arrives before the microphone was granted; holdStart reads it and stops.
  const releasedEarlyRef = useRef(false);
  const startingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => recRef.current?.stream.getTracks().forEach((t) => t.stop()), []);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    onMessage(null);
    const res = await api<{ asked?: string; error?: string; detail?: string }>(`/api/meetings/${meetingId}/room/ask`, { method: "POST", body });
    setBusy(false);
    if (res.status !== 201) onMessage(res.data?.detail ?? res.data?.error ?? `The room could not answer (HTTP ${res.status}).`);
    else if (body.audio_base64) onMessage(`Heard: “${res.data?.asked ?? ""}”. The answer is in the stream below.`);
    else onMessage("Asked. The answer is in the stream below.");
    setQuestion("");
    onAsked();
    inputRef.current?.focus();
  }

  async function holdStart() {
    if (busy || holding || startingRef.current) return;
    if (!canRecordHere()) {
      onMessage("This browser will not record audio for a page, so the room cannot hear you. Type it instead.");
      return;
    }
    startingRef.current = true;
    releasedEarlyRef.current = false;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      startingRef.current = false;
      onMessage("The browser did not give this page the microphone. Type it instead.");
      return;
    }
    startingRef.current = false;
    if (releasedEarlyRef.current) {
      // Released before the microphone opened: close it and ask nothing.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const rec = new MediaRecorder(stream);
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) parts.push(e.data);
    };
    recRef.current = { rec, stream, parts };
    rec.start();
    setHolding(true);
  }

  function holdEnd() {
    if (startingRef.current) {
      releasedEarlyRef.current = true;
      return;
    }
    const cur = recRef.current;
    if (!cur) return;
    recRef.current = null;
    setHolding(false);
    cur.rec.onstop = async () => {
      // The microphone is released the moment the button is — the room hears only while it is held.
      cur.stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(cur.parts, { type: cur.rec.mimeType || "audio/webm" });
      if (blob.size === 0) {
        onMessage("Nothing was heard while the button was held.");
        return;
      }
      try {
        await post({ audio_base64: await toBase64(blob), content_type: blob.type || "audio/webm" });
      } catch {
        onMessage("The recording could not be read, so nothing was asked.");
      }
    };
    if (cur.rec.state !== "inactive") cur.rec.stop();
  }

  const hint = revoked
    ? "AI access to this room is revoked, so nobody can answer here until a person restores it."
    : "Two characters or more. Answers are saved on the meeting. Nothing said here becomes a record until you approve the draft.";
  return (
    <section className="card" data-testid="room-ask-card">
      <div className="panel-head">
        <h3>Ask the room</h3>
        {!compact && <span className="muted small">answers are saved on the meeting; nothing becomes a record until you approve the draft</span>}
      </div>
      <form
        className="ask"
        data-testid="room-ask"
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim().length >= 2 && !busy) void post({ question: question.trim() });
        }}
      >
        <label className="sr-only" htmlFor={`room-ask-input-${meetingId}`}>Ask the room</label>
        <input
          id={`room-ask-input-${meetingId}`}
          ref={inputRef}
          data-testid="room-ask-input"
          value={question}
          placeholder={compact ? `Ask ${hostName} — or “Wyatt, …”` : `Ask ${hostName} — or “Wyatt, …” to address someone`}
          readOnly={busy}
          disabled={revoked}
          aria-busy={busy}
          aria-describedby={`room-ask-hint-${meetingId}`}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button type="submit" className="btn-strong" disabled={busy || revoked || question.trim().length < 2} data-testid="room-ask-send">
          {busy ? "Asking…" : "Ask"}
        </button>
        <button
          type="button"
          className="ptt"
          data-testid="room-ptt"
          aria-pressed={holding}
          aria-busy={busy}
          data-state={revoked ? "error" : undefined}
          aria-label={holding ? "Listening. Release, or press Enter, to stop" : "Hold to talk to the room. Hold Space, or press Enter to start and again to stop"}
          title="Hold to talk. The room hears only while this is held; there is no wake phrase. Keyboard: hold Space, or press Enter to start and again to stop."
          disabled={busy || revoked}
          onPointerDown={(e) => { e.preventDefault(); void holdStart(); }}
          onPointerUp={holdEnd}
          onPointerLeave={() => { if (holding) holdEnd(); }}
          onPointerCancel={holdEnd}
          onKeyDown={(e) => {
            if (e.repeat) return;
            if (e.key === " ") { e.preventDefault(); void holdStart(); }
            if (e.key === "Enter") { e.preventDefault(); if (holding) holdEnd(); else void holdStart(); }
          }}
          onKeyUp={(e) => { if (e.key === " ") { e.preventDefault(); holdEnd(); } }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          {holding ? (compact ? "Listening… release to send" : "Listening…") : "Hold to talk"}
        </button>
      </form>
      <p className={revoked ? "field-help err" : "field-help"} id={`room-ask-hint-${meetingId}`}>{hint}</p>
    </section>
  );
}

// ── 4 · The artifacts stream ──────────────────────────────────────────────────────────────────

function ArtifactStream({ artifacts, tasks, loading }: { artifacts: Artifact[]; tasks: Task[]; loading: boolean }): JSX.Element {
  const taskById = new Map(tasks.map((t) => [t.work_card_id, t]));
  return (
    <section>
      <div className="section-head">
        <h4>What the room has handed back</h4>
        <span className="muted small">newest first · stays on the meeting</span>
      </div>
      <ul className="card-list stack" data-testid="room-artifacts">
        {artifacts.length === 0 && (
          <li className="state-empty" data-testid="room-artifacts-empty">
            {loading ? "Reading the room…" : "Nothing asked yet. What the room answers, builds or hands to an employee appears here and stays on the meeting."}
          </li>
        )}
        {artifacts.map((a) => (
          <li key={a.id} className="artifact" data-testid={`room-artifact-${a.id}`} data-kind={a.kind}>
            <div className="artifact-kind">
              <span>{kindInWords(a.kind)}</span>
              <span className="muted">
                {a.asked_via === "VOICE" ? "You said" : a.asked_via === "SYSTEM" ? "Returned" : "You asked"} · {timeOfDay(a.created_at)}
                {a.asked_text ? ` · ${a.asked_text}` : ""}
              </span>
            </div>
            <ArtifactBody artifact={a} task={a.work_card_id ? taskById.get(a.work_card_id) ?? null : null} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function kindInWords(kind: Artifact["kind"]): string {
  switch (kind) {
    case "answer": return "Answer";
    case "table": return "Table";
    case "chart": return "Chart";
    case "packet": return "Packet";
    case "summary": return "Summary";
  }
}

function timeOfDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function ArtifactBody({ artifact, task }: { artifact: Artifact; task: Task | null }): JSX.Element {
  const body = parseBody(artifact.body_json);
  const state = String(body.state ?? "OK");
  const who = typeof body.answered_by === "string" ? body.answered_by : null;

  if (state === "REFUSED" || state === "FAILED") {
    return (
      <div className="stack">
        <strong>{who ?? "The room"} · {artifact.title}</strong>
        <span className="field-help err" data-testid={`room-artifact-detail-${artifact.id}`}>{String(body.detail ?? "")}</span>
      </div>
    );
  }

  if (artifact.kind === "table" || artifact.kind === "chart") {
    const columns = Array.isArray(body.columns) ? (body.columns as string[]) : [];
    const rows = Array.isArray(body.rows) ? (body.rows as Array<Record<string, unknown>>) : [];
    const chart = typeof body.chart === "string" ? body.chart : null;
    const cites = Array.isArray(body.cites) ? (body.cites as string[]) : [];
    return (
      <div>
        <strong>{artifact.title}</strong>
        {chart && rows.length > 0 && <RoomChart kind={chart} rows={rows} columns={columns} title={artifact.title} />}
        {rows.length === 0 ? (
          <p className="muted small">{String(body.note ?? "The record holds nothing matching that.")}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>{columns.map((c) => <td key={c}>{fmt(r[c])}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          From <code>{String(body.table ?? "")}</code> · {rows.length} row{rows.length === 1 ? "" : "s"}{rows.length >= 50 ? " (capped at 50)" : ""} · cites {cites.length} record{cites.length === 1 ? "" : "s"}
          {body.confidential ? " · confidential" : ""}
        </p>
      </div>
    );
  }

  if (artifact.kind === "packet") {
    const chip = task?.chip ?? (state === "DONE" ? "done" : "working");
    return (
      <div>
        <div className="row">
          <span className="grow"><strong>{String(body.employee ?? who ?? "An employee")}</strong> · {artifact.title}</span>
          <TaskChip chip={chip} />
        </div>
        {typeof body.brief === "string" && state !== "DONE" && <p className="muted small">{body.brief}</p>}
        {task?.chip === "needs you" && task.block_needed && <p className="notice small">{task.block_needed}</p>}
        {typeof body.finding === "string" && state === "DONE" && <p className="room-finding">{body.finding}</p>}
        {task && <p className="muted small">Work card <code>{task.work_card_id}</code> · preview-first</p>}
      </div>
    );
  }

  return (
    <p>
      {who && <strong>{who} · </strong>}
      {typeof body.text === "string" ? body.text : artifact.title}
    </p>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

/**
 * A chip per task: `working` is the live one, in words as well as tint. Two literal branches rather
 * than a computed class, so `validate:css-classes` can see both names it is asked to prove.
 */
function TaskChip({ chip, label }: { chip: Task["chip"]; label?: string }): JSX.Element {
  const testid = `room-task-chip-${chip.replace(" ", "-")}`;
  if (chip === "working") return <span className="task-chip task-chip-live" data-testid={testid}>{label ?? chip}</span>;
  return <span className="task-chip" data-testid={testid}>{label ?? chip}</span>;
}

// ── 5 · Charts: inline SVG on the token palette, bar / line / pie ─────────────────────────────

const SERIES = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)"];

/**
 * A grouped metric drawn by hand. Four series colours from the token block, direct labels beside
 * every mark, and the numbers in the table underneath — identity never depends on telling two hues
 * apart. Kept to the three shapes the owner named; anything else is a table.
 */
export function RoomChart({ kind, rows, columns, title }: { kind: string; rows: Array<Record<string, unknown>>; columns: string[]; title: string }): JSX.Element {
  const labelKey = columns[0] ?? "label";
  const points = rows.slice(0, 12).map((r) => ({ label: fmt(r[labelKey]), value: Number(r.metric ?? 0) || 0 }));
  const max = Math.max(1, ...points.map((p) => p.value));
  const W = 320;
  const H = 160;
  const pad = 8;

  if (kind === "pie") {
    /*
     * THE ONE RING. This used to draw its own strokeDasharray geometry — the same 54px radius and
     * the same circumference arithmetic as AllocationRing.tsx, copied. `validate:portfolio` refused
     * the merge on 18 Sep 2026: two rings drift the way two numbers drift. So the room hosts the
     * fund's drawing and passes its own formatter; the slice field is called `usd` because the ring
     * was born on the fund pages, and a count rides in it unchanged.
     */
    const total = points.reduce((s, p) => s + Math.max(0, p.value), 0);
    const slices: RingSlice[] = points.map((p, i) => ({
      key: `s${i}`,
      label: p.label,
      usd: Math.max(0, p.value),
      color: SERIES[i % SERIES.length] ?? "var(--viz-1)",
      note: "",
    }));
    return (
      <div className="room-chart" data-testid="room-chart-pie">
        <AllocationRing slices={slices} total={total || 1} caption={title} testid="room-pie" format={(n) => String(Math.round(n * 100) / 100)} ariaLabel={title} />
      </div>
    );
  }

  if (kind === "line") {
    const step = points.length > 1 ? (W - pad * 2) / (points.length - 1) : 0;
    const xy = points.map((p, i) => [pad + i * step, H - pad - (p.value / max) * (H - pad * 2 - 12)] as const);
    return (
      <div className="room-chart" data-testid="room-chart-line">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={title} preserveAspectRatio="none">
          <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="var(--wp-line-strong)" />
          <polyline fill="none" stroke={SERIES[0]} strokeWidth="2" points={xy.map(([x, y]) => `${x},${y}`).join(" ")} />
          {xy.map(([x, y], i) => (
            <g key={i}>
              <circle cx={x} cy={y} r="3" fill={SERIES[0]}><title>{`${points[i]!.label}: ${points[i]!.value}`}</title></circle>
              <text x={x} y={y - 6} textAnchor="middle" className="room-chart-label">{points[i]!.value}</text>
            </g>
          ))}
        </svg>
        <ul className="room-legend">{points.map((p, i) => <li key={i}>{p.label} · {p.value}</li>)}</ul>
      </div>
    );
  }

  // bar
  const bw = Math.max(6, (W - pad * 2) / Math.max(1, points.length) - 6);
  return (
    <div className="room-chart" data-testid="room-chart-bar">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={title} preserveAspectRatio="none">
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="var(--wp-line-strong)" />
        {points.map((p, i) => {
          const h = (Math.max(0, p.value) / max) * (H - pad * 2 - 12);
          const x = pad + i * (bw + 6);
          return (
            <g key={i}>
              <rect x={x} y={H - pad - h} width={bw} height={h} fill={SERIES[i % SERIES.length]}><title>{`${p.label}: ${p.value}`}</title></rect>
              <text x={x + bw / 2} y={H - pad - h - 3} textAnchor="middle" className="room-chart-label">{p.value}</text>
            </g>
          );
        })}
      </svg>
      <ul className="room-legend">
        {points.map((p, i) => (
          <li key={i}><span className="legend-swatch" style={{ background: SERIES[i % SERIES.length] }} aria-hidden="true" /> {p.label} · {p.value}</li>
        ))}
      </ul>
    </div>
  );
}

// ── 6 · Who is seated, with a chip per task ───────────────────────────────────────────────────

function SeatedRow({ seated, tasks, compact = false }: { seated: RoomState["seated"]; tasks: Task[]; compact?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  if (compact && seated.length > 0 && !open) {
    // The narrow room: avatars and a count; a press opens the chips.
    return (
      <div className="stack" data-testid="room-seated">
        <button type="button" className="seats-collapsed" aria-expanded={false} data-testid="room-seated-toggle" onClick={() => setOpen(true)}>
          <span className="seats-avatars" aria-hidden="true">
            {seated.slice(0, 5).map((s) =>
              portraitFor(s.name) ? (
                <img key={s.ai_employee_id} className="employee-portrait" src={portraitFor(s.name)!} alt={portraitAlt(s.name, s.role)} width={22} height={22} loading="lazy" />
              ) : (
                <span key={s.ai_employee_id} className="avatar">{s.name.slice(0, 2).toUpperCase()}</span>
              ),
            )}
          </span>
          <span>{seated.length} seated{tasks.some((t) => t.chip === "working") ? " · working" : ""}</span>
        </button>
      </div>
    );
  }
  return (
    <div className="stack" data-testid="room-seated">
      <p className="eyebrow">
        Seated
        {compact && seated.length > 0 && (
          <>
            {" "}
            <button type="button" className="btn-ghost" aria-expanded={true} data-testid="room-seated-toggle" onClick={() => setOpen(false)}>fold</button>
          </>
        )}
      </p>
      {seated.length === 0 ? (
        <p className="muted small" data-testid="room-seated-nobody">Nobody is seated yet. Address someone by name — “Wyatt, …” — and they join the room.</p>
      ) : (
        <div className="chips">
          {seated.map((s) => {
            const mine = tasks.filter((t) => t.owner_name === s.name);
            const chip: Task["chip"] = mine.some((t) => t.chip === "working") ? "working" : mine.some((t) => t.chip === "needs you") ? "needs you" : "done";
            const words = mine.length > 0 ? mine.map((t) => t.chip).join(", ") : s.role;
            return (
              <span key={s.ai_employee_id} data-testid={`room-seat-${s.name}`}>
                <TaskChip chip={chip} label={`${s.name} · ${words}`} />
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
