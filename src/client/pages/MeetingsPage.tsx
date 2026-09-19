import { useMemo, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { MEETING_TYPES, meetingType, seatableFor } from "@shared/meetings/meetingTypes";
import { IC_FLOW } from "@shared/ic/meetingFlow";
import { LiveHelpPanel } from "./LiveHelpPanel";
import { RoomPanel } from "./RoomPanel";
import { CloseoutPanel } from "./CloseoutPanel";
import { AfterPanel, BeforePanel } from "./MeetingFacesPanel";

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
 * FOUR SECTIONS, ALWAYS RENDERED, EACH WITH AN EMPTY STATE. "Nothing has reached this yet" and
 * "this is broken" look identical unless the page says which — the same defect the IC sequence
 * block was written to fix, applied to the whole page. The order is the argument: what is coming
 * up, what happened and what came of it, start one now, and where a deal stands with the
 * committee. The static "How a meeting becomes work" explainer went with Phase B (18 Sep 2026):
 * every meeting record now SHOWS its three faces — the brief before, the capture during, and what
 * came out after — so a chain described in the abstract at the foot of the page was describing
 * something the record itself now says. The committee sequence stays inside section 4, where the
 * deals it describes are.
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
  /**
   * What this meeting has already produced (migration 0140's list read).
   *
   * They exist so the archive confirm can say what stops being shown and what stays. A partner
   * clearing out a test call must not discover six weeks later that a real work card went with it,
   * and "are you sure?" does not tell her that — a count does.
   */
  note_count?: number;
  commitment_count?: number;
  work_card_count?: number;
  transcript_count?: number;
  archived_at?: string | null;
  archived_by?: string | null;
  archive_reason?: string | null;
  /** Phase Meet (migration 0202). Present on a meeting the calendar sync created. */
  meet_link?: string | null;
  source?: "manual" | "google_calendar";
  type_inference?: "FIRM_ONLY" | "LP_CONTACT" | "COMPANY_DOMAIN" | "UNKNOWN_CHECK_IT" | null;
  /**
   * The three faces on the list (Phase B). Readiness for an upcoming meeting — is the brief built,
   * what rolls forward from earlier meetings with the same company or LP — and outputs for a past
   * one. Server-counted; the list never derives them.
   */
  brief_ready?: number;
  carried_open_questions?: number;
  we_owe_them?: number;
  they_owe_us?: number;
  decision_count?: number;
  commitment_overdue_count?: number;
  open_question_count?: number;
  stage_proposal_pending_count?: number;
  draft_waiting_count?: number;
}

/** "Brief ready · 3 open · 2 we owe them" — what an upcoming meeting is walking into. */
function readinessInWords(m: MeetingRow): string {
  const parts = [m.brief_ready ? "Brief ready" : "No brief yet"];
  parts.push(`${m.carried_open_questions ?? 0} open`);
  parts.push(`${m.we_owe_them ?? 0} we owe them`);
  if ((m.they_owe_us ?? 0) > 0) parts.push(`${m.they_owe_us} they owe us`);
  return parts.join(" \u00b7 ");
}

/** "2 decisions · 1 commitment overdue" — what a past meeting produced, and what is still owed. */
function outputsInWords(m: MeetingRow): string {
  const n = (k: number | undefined) => k ?? 0;
  const parts = [`${n(m.decision_count)} decision${n(m.decision_count) === 1 ? "" : "s"}`];
  if (n(m.commitment_overdue_count) > 0) parts.push(`${n(m.commitment_overdue_count)} commitment${n(m.commitment_overdue_count) === 1 ? "" : "s"} overdue`);
  if (n(m.open_question_count) > 0) parts.push(`${n(m.open_question_count)} still open`);
  if (n(m.stage_proposal_pending_count) > 0) parts.push(`${n(m.stage_proposal_pending_count)} stage move waiting on you`);
  if (n(m.draft_waiting_count) > 0) parts.push("draft waiting for approval");
  return parts.join(" \u00b7 ");
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
  decision: { id: string; decision: string; rationale: string | null; created_at: string; decided_by: string } | null;
  /** Kept whole and never folded into the decision. The rule `ic.ts` holds, made visible. */
  dissents: Array<{ id: string; decision: string; dissenter: string; dissent_text: string; created_at: string }>;
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

/** Where a meeting stands, in words. Lower-casing a stored value is still printing it. */
function statusInWords(status: string | null): string {
  switch (status) {
    case "SCHEDULED": return "on the calendar";
    case "HELD": return "it happened";
    case "CANCELLED": return "it did not happen";
    default: return "no state recorded";
  }
}

/** Whether anybody may write this conversation down, in words. */
function consentInWords(state: string | null): string {
  switch (state) {
    case "GRANTED": return "They agreed to it being written down";
    case "DENIED": return "They said no, and that is on the file";
    case "REVOKED": return "They took their permission back";
    case "REQUESTED": return "Permission has been asked for and not answered";
    default: return "Nobody has been asked yet";
  }
}

/** What became of a transcript somebody tried to bring in. */
function importInWords(status: string): string {
  switch (status) {
    case "IMPORTED": return "brought in";
    case "REFUSED": return "refused";
    case "PENDING": return "waiting";
    default: return "not brought in";
  }
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

/**
 * What taking a meeting off the record does NOT remove, counted from what it actually holds.
 *
 * A confirm that says "are you sure?" tells a partner nothing. This one names the notes, the
 * transcripts, the promises and — the one that matters — the work cards already made out of it,
 * because those belong to whoever is working them and go on existing. The alternative is somebody
 * clearing out a test call and finding out weeks later what left with it.
 */
function whatSurvives(m: MeetingRow): string {
  const kept: string[] = [];
  const say = (n: number, one: string, many: string) => {
    if (n > 0) kept.push(`${n} ${n === 1 ? one : many}`);
  };
  say(m.note_count ?? 0, "note", "notes");
  say(m.transcript_count ?? 0, "transcript", "transcripts");
  say(m.commitment_count ?? 0, "recorded promise", "recorded promises");
  say(m.work_card_count ?? 0, "work card already made from it", "work cards already made from it");
  if (kept.length === 0) return "Nothing has been taken out of this one yet, so nothing goes with it.";
  const list = kept.length === 1 ? kept[0] : `${kept.slice(0, -1).join(", ")} and ${kept[kept.length - 1]}`;
  return `It stops appearing in these lists. The ${list} stay exactly where they are.`;
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

// ── Section 3's working parts: the live room ──────────────────────────────────
//
// The consent prompt and the recorder moved into RoomPanel.tsx (Phase C), where they are one
// status line and one button on the During face beside the rolling draft, the ask box and the
// artifacts stream. Nothing about the gates changed: the server still refuses a chunk without an
// activated policy AND a granted consent, and the prompt is still asked every session.

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
                  {/* A WARNING, NOT A LOCK. The owner's rule: any employee can be seated anywhere. */}
                  {s.warning && <div className="notice small" data-testid={`seat-warning-${s.name}`}>{s.warning}</div>}
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
          This meeting has people outside the firm in it. Every employee can be seated; the ones
          whose job is checking the firm are marked so you know before you press.
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
    /*
     * THE OLD ANSWER GOES BEFORE THE NEW QUESTION IS ASKED.
     *
     * This helper left the previous outcome on screen for the whole width of the request, so
     * pressing "Import the transcript" a second time showed the FIRST attempt's verdict until the
     * second one came back. For a surface whose whole job is saying whether a governed act was
     * allowed, a stale "refused" sitting next to a button you have just pressed is the worst
     * possible thing to show — and it is also read by a test.
     *
     * CONFIRMED 18 Sep 2026 in `p7-meetings`: "Consent alone is not enough — the recording policy is
     * a separate gate" grants consent, imports again, and waits for
     * `Transcript import refused: recording_policy_not_activated`. That sentence was ALREADY on the
     * page from the previous attempt, so the assertion resolved instantly and the journey would have
     * passed even if the gate had opened. A test that cannot fail is worse than a flaky one; this is
     * the gate it was built to hold. The claim form in `App.tsx` has always cleared first — same
     * repair, same reason.
     *
     * THIS LINE IS THE UX REPAIR AND NOT, BY ITSELF, THE FIX FOR THE SPEC. Measured: pressing the
     * button and reading the banner in the same tick still returns the old sentence, because the
     * re-render this schedules has not flushed by the time the click returns. A banner is the wrong
     * thing to wait on either way, so `p7` now counts the REFUSED rows on the record — which cannot
     * be stale — and this clears the old verdict for the person reading the page.
     */
    setMessage(null);
    const { status, data } = await api<{ error?: string; detail?: string }>(path, { method: "POST", body });
    setMessage(status === okStatus ? `${label} ok.` : `${label} refused: ${(data as { error?: string })?.error ?? status}`);
    meeting.reload();
  };

  return (
    <div className="card" data-testid="meeting-detail">
      <h4>
        {m?.title ?? "Loading the record…"}{" "}
        <span className="muted small" data-testid="meeting-status">{statusInWords(m?.status ?? null)}</span>
      </h4>
      {/*
        TWO GATES, AND BOTH HAVE TO BE OPEN. The stored words are what `e2e/p7-meetings.spec.ts`
        reads back, so they stay exactly as they are — and the sentence underneath says what each
        one means, which is the half a partner was missing.
      */}
      <p className="muted small">
        Recording is{" "}
        <span data-testid="meeting-recording">{m?.recording_enabled === 1 ? "ACTIVE" : "NOT ACTIVATED"}</span>
        {" \u00b7 "}permission to transcribe:{" "}
        <span data-testid="meeting-consent">{m?.consent_current?.TRANSCRIPTION?.state ?? "NOT RECORDED"}</span>
      </p>
      <p className="muted small">
        {m?.recording_enabled === 1
          ? "The firm has switched recording on for this meeting"
          : "The firm has not switched recording on for this meeting"}
        {" \u2014 "}
        {consentInWords(m?.consent_current?.TRANSCRIPTION?.state ?? null).toLowerCase()}. Nothing can
        be written down until both of those are true.
      </p>

      <p className="muted small record-lede">
        Four things you can do to this meeting before you write anything down: record that the other
        side agreed, record that they took it back, note that a transcript of it exists somewhere
        else, or have a prep sheet put together for it.
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

      <BeforePanel meetingId={meetingId} onChanged={() => meeting.reload()} />

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
            <span className="muted small">{importInWords(tr.status)}</span>{" "}
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
      <AfterPanel meetingId={meetingId} onChanged={() => meeting.reload()} />

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
  const [dissenting, setDissenting] = useState<string | null>(null);
  const [dissent, setDissent] = useState("");
  /**
   * TAKING A MEETING OFF THE RECORD. Operator, 22 Aug 2026: "the call with scooter meeting has no
   * way to delete it. it was a test and some meetings i want to delete….we need a way to delete them
   * and we can have an audit trail if someone deletes."
   *
   * Not a delete. The confirm is a reason box rather than an "are you sure?", because a reason is
   * the only part of this that is still worth anything six months later, and typing one is also the
   * half second that stops an accidental press.
   */
  const [archiving, setArchiving] = useState<string | null>(null);
  const [archiveReason, setArchiveReason] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const archived = useApi<MeetingsResponse>(showArchived ? "/api/meetings?archived=1" : null, [showArchived]);

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

  /** Off the record, with a reason, and nothing taken out of it is touched. */
  async function archiveMeeting(id: string) {
    const res = await api<{ already_archived?: boolean; note?: string; error?: string; detail?: string }>(
      `/api/meetings/${id}/archive`,
      { method: "POST", body: { reason: archiveReason.trim() } },
    );
    if (res.status !== 200) {
      setMessage(res.data?.detail ?? res.data?.error ?? `Not taken off the record (HTTP ${res.status}).`);
      return;
    }
    setMessage(res.data?.note ?? "Off the record.");
    setArchiving(null);
    setArchiveReason("");
    if (open === id) setOpen(null);
    if (live === id) setLive(null);
    meetings.reload();
    if (showArchived) archived.reload();
  }

  /**
   * A partner disagreeing, in her own words, against the decision she disagreed with.
   *
   * The rule this exists to keep is the one `ic.ts` already holds: dissent is append-only and is
   * never folded into the rationale. Without a control it was a rule about a table nobody could
   * write to — a committee record that could only ever record agreement.
   */
  async function recordDissent(decisionId: string) {
    const res = await api<{ error?: string; detail?: string }>(`/api/ic/decisions/${decisionId}/dissent`, {
      method: "POST",
      body: { dissent_text: dissent.trim() },
    });
    if (res.status !== 201) {
      setMessage(res.data?.detail ?? res.data?.error ?? `Not recorded (HTTP ${res.status}).`);
      return;
    }
    setMessage("Recorded, in your words, against that decision. It cannot be edited or removed by anybody.");
    setDissenting(null);
    setDissent("");
    committee.reload();
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
      <p className="muted small record-lede" data-testid="upcoming-lede">
        Two things you can do to anything on this list. Say it is happening now and the permission
        prompt and the recorder open further down the page; open its record and you can prepare for
        it, write what was said, and seat an employee you want to be able to ask during the call.
      </p>
      <ul className="card-list" data-testid="meetings-upcoming">
        {upcoming.map((m) => (
          <li key={m.id} className="card" data-testid={`upcoming-${m.id}`}>
            <strong>{m.title}</strong>{" "}
            <span className="badge">{meetingType(m.meeting_type)?.label ?? m.meeting_type}</span>{" "}
            <span className="muted small">{whenInWords(m.scheduled_at)}</span>
            {/*
              THE TYPE WAS A GUESS, AND THE CARD SAYS SO. A calendar meeting whose attendees matched
              neither the firm, a known LP contact nor a known company's domain is filed FOUNDER
              because something has to be chosen; this is the flag that keeps the guess honest until
              a person confirms or corrects it. Phase D redesigns the card; the flag stays.
            */}
            {m.type_inference === "UNKNOWN_CHECK_IT" && (
              <span className="muted small" data-testid={`type-check-${m.id}`}> · type inferred, check it</span>
            )}
            <div className="muted small" data-testid={`readiness-${m.id}`}>{readinessInWords(m)}</div>
            <div className="form-row">
              {/* Phase Meet: the Meet link the calendar carries, so joining is one press from here. */}
              {m.meet_link && (
                <a className="link-button" href={m.meet_link} target="_blank" rel="noreferrer noopener" data-testid={`join-${m.id}`}>
                  Join on Meet
                </a>
              )}
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
      <p className="muted small record-lede" data-testid="past-lede">
        Open one by its name. Its record holds what was said, what was promised, who is holding each
        promise, any transcript brought in and the close-out that turns a promise into a work card.
        A meeting that should never have been on the record — a test, or one entered twice — can be
        taken off it here, with a reason.
      </p>
      <ul className="card-list" data-testid="meeting-list">
        {past.map((m) => (
          <li key={m.id} className="card" data-testid={`meeting-${m.id}`}>
            <button type="button" className="link-button" data-testid={`meeting-open-${m.id}`} onClick={() => setOpen(m.id === open ? null : m.id)}>
              {m.title}
            </button>{" "}
            <span className="badge">{meetingType(m.meeting_type)?.label ?? m.meeting_type}</span>{" "}
            <span className="muted small">{whenInWords(m.occurred_at ?? m.scheduled_at)}</span>
            <div className="muted small" data-testid={`outputs-${m.id}`}>{outputsInWords(m)}</div>
            {archiving === m.id ? (
              <div className="form-row">
                {/* WHAT STAYS IS SAID BEFORE THE PRESS, not implied afterwards. */}
                <span className="muted small" data-testid={`archive-keeps-${m.id}`}>{whatSurvives(m)}</span>
                <label>
                  Why{" "}
                  <input
                    data-testid={`archive-reason-${m.id}`}
                    value={archiveReason}
                    onChange={(e) => setArchiveReason(e.target.value)}
                    placeholder="it was a test"
                  />
                </label>
                <button
                  type="button"
                  className="btn-strong"
                  disabled={archiveReason.trim().length < 3}
                  data-testid={`archive-confirm-${m.id}`}
                  onClick={() => void archiveMeeting(m.id)}
                >
                  Take it off the record
                </button>
                <button type="button" data-testid={`archive-cancel-${m.id}`} onClick={() => { setArchiving(null); setArchiveReason(""); }}>
                  Keep it
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="link-button"
                data-testid={`archive-${m.id}`}
                onClick={() => { setArchiving(m.id); setArchiveReason(""); }}
              >
                Take it off the record
              </button>
            )}
          </li>
        ))}
        {past.length === 0 && (
          <li className="state-empty" data-testid="no-meetings">
            No meeting has been held yet. Once one has, this is where the notes, what was promised
            and who is holding each piece of it live.
          </li>
        )}
      </ul>

      {/*
        WHAT WAS TAKEN OFF, on the pass-pile pattern rather than as a second tab. Nothing here is
        destroyed, so the page can afford to show it — and a removal nobody can see afterwards is
        indistinguishable from a deletion, which is the thing this deliberately is not.
      */}
      <div className="form-row">
        <button
          type="button"
          className="link-button"
          data-testid="meetings-archived-toggle"
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? "Hide what was taken off the record" : "Show what was taken off the record"}
        </button>
      </div>
      {showArchived && (
        <ul className="card-list" data-testid="meetings-archived">
          {(archived.data?.meetings ?? []).map((m) => (
            <li key={m.id} className="card" data-testid={`archived-${m.id}`}>
              <strong>{m.title}</strong>{" "}
              <span className="badge">{meetingType(m.meeting_type)?.label ?? m.meeting_type}</span>
              <div className="muted small">
                Taken off the record {whenInWords(m.archived_at ?? null)} — {m.archive_reason ?? "no reason recorded"}
              </div>
              <div className="muted small">
                Nothing was destroyed. {whatSurvives(m)}
              </div>
            </li>
          ))}
          {(archived.data?.meetings ?? []).length === 0 && (
            <li className="state-empty" data-testid="no-archived-meetings">
              {archived.loading
                ? "Reading what was taken off…"
                : "Nothing has been taken off the record. When something is, it appears here with who removed it, when, and why."}
            </li>
          )}
        </ul>
      )}
      {open && <MeetingRecord meetingId={open} me={me} />}

      {/* ── 3 ─────────────────────────────────────────────────────────────── */}
      <div className="home-section-head">
        <h3>Start a meeting now</h3>
        <span className="muted small">permission first, then the recording</span>
      </div>
      <p className="muted small record-lede" data-testid="start-lede">
        Give it a name and say whether it is happening now or is going on the calendar. Starting one
        opens three things underneath: the words to ask permission with, the recorder — which stays
        switched off until somebody has said yes — and the employees you can seat so you can ask them
        something while the call is still running.
      </p>
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
          <RoomPanel meetingId={liveMeeting.id} />
          <SeatingPanel meeting={liveMeeting} me={me} />
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

      {/*
        THE FOUR QUESTIONS, ANSWERED WHERE THEY ARE ASKED. Operator, 22 Aug 2026: "the IC flow ----
        who makes the packet how does that get done? how do we get thru the pipeline and what happens
        to the page once a deal is at the IC stage?" The sequence at the foot of this page describes
        the chain in the abstract; this answers the four questions beside the deals they are about,
        and it renders whether or not any deal has got here — because the commonest moment somebody
        needs the answer is when the list below is empty and they cannot tell why.
      */}
      <div className="card" data-testid="ic-how-it-works">
        <h4>Who makes the packet, and how a deal gets here</h4>
        <ul className="card-list small">
          <li>
            <strong>{facilitator?.name ?? "The committee's facilitator"} makes it, and never decides anything.</strong>
            <div className="muted">
              She is the one seat whose job is the committee itself: she assembles the packet, raises
              the contradiction nobody wants to raise, and writes down who disagreed. The partners
              decide.
            </div>
          </li>
          <li>
            <strong>It is drafted from what the firm already holds, and every gap becomes a question with a name on it.</strong>
            <div className="muted">
              Nothing is written to fill a hole. A packet that invents its missing half reads as
              complete, so nobody goes looking — so each gap is listed below as a question, with what
              was looked at and who owes the answer. The case against the deal is always one of them,
              and whoever is carrying the deal may never be the one to write it.
            </div>
          </li>
          <li>
            <strong>A deal gets here by one move, made by a person, on Dealflow.</strong>
            <div className="muted">
              Moving it from diligence to the committee stage is the whole trigger — it opens the
              packet and hands the facilitator a work card to assemble it. Nothing else puts a deal
              in front of the committee, and arriving here decides nothing.{" "}
              <button type="button" className="link-button" data-testid="ic-how-open-dealflow" onClick={() => onNavigate("dealflow")}>
                Move a deal on Dealflow
              </button>
            </div>
          </li>
          <li>
            <strong>Once it is here, the questions are what is holding it up — and the decision goes back to the pipeline.</strong>
            <div className="muted">
              The deal appears below and the same file appears on its own record under Dealflow.
              Answering a question, putting the packet in front of the partners and recording what
              was decided all happen below. Investing marks the deal decided; passing sends it to the
              pass pile carrying the reason you typed, so it is readable the day they come back
              raising; not yet leaves the deal exactly where it is.
            </div>
          </li>
        </ul>
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
              <>
                <p className="notice small" data-testid={`ic-decision-${d.opportunity_id}`}>
                  <strong>
                    {d.decision.decision === "APPROVE" ? "The firm is investing." : d.decision.decision === "REJECT" ? "The firm passed." : "Not yet — deferred."}
                  </strong>{" "}
                  {d.decision.rationale}
                  <span className="muted small"> · {d.decision.decided_by} · {whenInWords(d.decision.created_at)}</span>
                </p>

                {/*
                  DISSENT SURVIVES, and it needed a control to survive through. `dissent_record` is
                  append-only and human-only and there was nothing anywhere in the product that
                  wrote to it — a rule about a table nobody could reach, which is to say a committee
                  record that could only ever record agreement.
                */}
                <p className="small"><strong>Who disagreed</strong></p>
                <ul className="card-list small" data-testid={`ic-dissents-${d.opportunity_id}`}>
                  {d.dissents.map((ds) => (
                    <li key={ds.id} data-testid={`ic-dissent-${ds.id}`}>
                      <strong>{ds.dissenter}</strong> <span className="muted small">· {whenInWords(ds.created_at)}</span>
                      <div className="closeout-quote">{ds.dissent_text}</div>
                    </li>
                  ))}
                  {d.dissents.length === 0 && (
                    <li className="state-empty">
                      Nobody has written down a disagreement. That is not the same as everybody
                      agreeing — it is only the same as nobody having said so here.
                    </li>
                  )}
                </ul>
                {dissenting === d.opportunity_id ? (
                  <div className="form-row">
                    <label>
                      What you disagreed with{" "}
                      <input
                        value={dissent}
                        data-testid={`ic-dissent-text-${d.opportunity_id}`}
                        onChange={(e) => setDissent(e.target.value)}
                        placeholder="the churn figure came from the founder and nothing else"
                      />
                    </label>
                    <button
                      type="button"
                      className="btn-strong"
                      disabled={dissent.trim().length < 4}
                      data-testid={`ic-dissent-save-${d.opportunity_id}`}
                      onClick={() => void recordDissent(d.decision!.id)}
                    >
                      Record it
                    </button>
                    <button type="button" data-testid={`ic-dissent-cancel-${d.opportunity_id}`} onClick={() => { setDissenting(null); setDissent(""); }}>
                      Never mind
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="link-button"
                    data-testid={`ic-dissent-open-${d.opportunity_id}`}
                    onClick={() => { setDissenting(d.opportunity_id); setDissent(""); }}
                  >
                    Record that you disagreed with this
                  </button>
                )}
              </>
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

      {/* The committee's own sequence, kept with the deals it describes. */}
      <p className="small"><strong>How a deal becomes a decision</strong></p>
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
