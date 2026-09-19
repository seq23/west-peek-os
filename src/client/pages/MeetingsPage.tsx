import { Fragment, useMemo, useRef, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { MEETING_TYPES, meetingType } from "@shared/meetings/meetingTypes";
import { LiveHelpPanel } from "./LiveHelpPanel";
import { RoomPanel } from "./RoomPanel";
import { CloseoutPanel } from "./CloseoutPanel";
import { AfterPanel, BeforePanel } from "./MeetingFacesPanel";

/**
 * Meetings — one object, three faces (design/DEALS_SECTION_DESIGN.md §3, approved 18 Sep 2026).
 *
 * OPERATOR, 22 AUG 2026: "the meeting tab is not good enough it is not self explanatory from looking
 * at the page what im able to do… this page would probably be the longest and needs to be clean and
 * clear like the LP page."
 *
 * WHAT THE DESIGN PASS FOUND (§1.1). Two objects on one page — the committee's packets and dissent
 * sat under the meetings list; no rank 0 — the one line a partner opens the page for ("is a brief
 * ready, is anything waiting on me") was scattered across row captions; the record was every panel
 * always rendered, one under the other; and the list was sorted by when a row was created rather
 * than when the meeting is.
 *
 * WHAT THIS IS NOW. A masthead whose answer line is derived from the same counts the rows carry
 * (`brief_ready`, `stage_proposal_pending_count`, `draft_waiting_count`); two bands — what is
 * coming up, soonest first, and what is on the record, newest first — plus the door for a meeting
 * the calendar did not bring; and ONE record at a time, with a tab strip over its three faces:
 * Before (the brief), During (the room, and what was written down), After (what came out of it,
 * and the one approval that makes it the record). Live Help and Close-out are no longer panels of
 * their own: who is in the room is a card on Before and During, and who is holding each piece is a
 * card on After. The committee lives on Dealflow now; the pointer at the foot says so.
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

/** One part of a readiness or outputs line. A tone is a word beside a colour, never a colour alone. */
interface LinePart {
  text: string;
  tone?: "ok" | "gate" | "bad" | "pill";
}

/** "Brief ready · 3 to find out · 2 we owe them · 1 they owe us" — what an upcoming meeting is walking into. */
function readinessInWords(m: MeetingRow): LinePart[] {
  const parts: LinePart[] = [m.brief_ready ? { text: "Brief ready", tone: "ok" } : { text: "No brief yet" }];
  parts.push({ text: `${m.carried_open_questions ?? 0} to find out` });
  parts.push({ text: `${m.we_owe_them ?? 0} we owe them` });
  if ((m.they_owe_us ?? 0) > 0) parts.push({ text: `${m.they_owe_us} they owe us` });
  return parts;
}

/** "1 decision · 2 still open · 1 stage move waiting on you" — what a past meeting produced, and what is still owed. */
function outputsInWords(m: MeetingRow): LinePart[] {
  const n = (k: number | undefined) => k ?? 0;
  const parts: LinePart[] = [];
  if (n(m.stage_proposal_pending_count) > 0) parts.push({ text: `${n(m.stage_proposal_pending_count)} stage move${n(m.stage_proposal_pending_count) === 1 ? "" : "s"} waiting on you`, tone: "pill" });
  parts.push({ text: `${n(m.decision_count)} decision${n(m.decision_count) === 1 ? "" : "s"}` });
  if (n(m.commitment_overdue_count) > 0) parts.push({ text: `${n(m.commitment_overdue_count)} commitment${n(m.commitment_overdue_count) === 1 ? "" : "s"} overdue`, tone: "bad" });
  parts.push({ text: `${n(m.open_question_count)} still open` });
  if (n(m.draft_waiting_count) > 0) parts.push({ text: "draft waiting for approval", tone: "gate" });
  return parts;
}

function joinWords(parts: LinePart[]): string {
  return parts.map((p) => p.text).join(" · ");
}

/** The parts of a line, with a hairline dot between them and a badge where a tone was given. */
function ReadinessLine({ parts, testid }: { parts: LinePart[]; testid: string }): JSX.Element {
  return (
    <div className="readiness" data-testid={testid}>
      {parts.map((p, i) => (
        <Fragment key={`${i}-${p.text}`}>
          {i > 0 && <span className="dot" aria-hidden="true" />}
          {p.tone === "pill" ? (
            <span className="count-pill">{p.text}</span>
          ) : p.tone ? (
            <span className={`badge badge-${p.tone}`}>{p.text}</span>
          ) : (
            <span>{p.text}</span>
          )}
        </Fragment>
      ))}
    </div>
  );
}

interface MeetingsResponse {
  meetings: MeetingRow[];
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

/** "Thu 18 Sep, 10:00" — the row's clock. */
function whenShort(value: string | null): string {
  if (!value) return "no time recorded";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** The meeting's time as a partner reads it on the masthead: "today at 10:00", "Tue 23 Sep at 14:00". */
function whenOnMasthead(value: string | null, now: Date): string {
  if (!value) return "with no time set";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (sameDay(d, now)) return `today at ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} at ${time}`;
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

/** Where the meeting came from, in words. */
function sourceInWordsRow(m: MeetingRow): string {
  return m.source === "google_calendar" ? "from the firm calendar" : "recorded here";
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

// ── The masthead: the answer line, derived from the rows ─────────────────────

/**
 * Rank 0. The one line a partner opens this page for, from the counts the rows already carry —
 * nothing here is a second count kept by the page.
 */
function mastheadFor(upcoming: MeetingRow[], past: MeetingRow[], loading: boolean, now: Date): { eyebrow: string; answer: string; detail: string } {
  const date = now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const eyebrow = `${date} · ${upcoming.length} coming up · ${past.length} on the record`;
  if (loading) return { eyebrow: date, answer: "Reading the calendar…", detail: "" };

  const moves = past.reduce((s, m) => s + (m.stage_proposal_pending_count ?? 0), 0);
  const drafts = past.reduce((s, m) => s + (m.draft_waiting_count ?? 0), 0);
  const next = upcoming[0] ?? null;
  const nextLine = next
    ? `${next.title}, ${whenOnMasthead(next.scheduled_at, now)}. ${joinWords(readinessInWords(next))}.`
    : "Nothing is on the calendar.";

  if (moves + drafts > 0) {
    const waiting: string[] = [];
    if (moves > 0) waiting.push(`${moves} stage move${moves === 1 ? "" : "s"}`);
    if (drafts > 0) waiting.push(`${drafts} draft${drafts === 1 ? "" : "s"}`);
    const verb = moves + drafts === 1 ? "is" : "are";
    return { eyebrow, answer: `${waiting.join(" and ")} ${verb} waiting on you.`, detail: `On the record, below. Next up: ${nextLine}` };
  }
  if (next) {
    const today = next.scheduled_at ? sameDay(new Date(next.scheduled_at), now) : false;
    const todayCount = upcoming.filter((m) => m.scheduled_at && sameDay(new Date(m.scheduled_at), now)).length;
    const brief = next.brief_ready ? "its brief is ready" : "its brief is not built yet";
    if (today) {
      return {
        eyebrow,
        answer: todayCount === 1 ? `One meeting today, and ${brief}.` : `${todayCount} meetings today; the first one’s brief is ${next.brief_ready ? "ready" : "not built yet"}.`,
        detail: nextLine,
      };
    }
    return { eyebrow, answer: `Nothing today. The next one is ${whenOnMasthead(next.scheduled_at, now)}, and ${brief}.`, detail: nextLine };
  }
  return { eyebrow, answer: "Nothing is on the calendar, and nothing is waiting on you.", detail: past.length === 0 ? "No meeting has been held yet. Start one below, or let the firm calendar bring one." : `${past.length} meeting${past.length === 1 ? "" : "s"} on the record, nothing owed on any of them.` };
}

// ── The faces strip ───────────────────────────────────────────────────────────

const FACES = [
  { key: "before", label: "Before" },
  { key: "during", label: "During" },
  { key: "after", label: "After" },
] as const;
export type Face = (typeof FACES)[number]["key"];

interface FaceBadge {
  text: string;
  tone?: "ok" | "gate" | "bad";
}

/**
 * role=tablist / role=tab with aria-selected; roving tabindex, arrows move, Home/End jump. Only the
 * selected face's panel is mounted — the room's poll stops when the partner is reading the brief.
 */
function Faces({ meetingId, face, onFace, badges }: { meetingId: string; face: Face; onFace: (f: Face) => void; badges: Partial<Record<Face, FaceBadge>> }): JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function onKey(e: React.KeyboardEvent<HTMLButtonElement>, i: number) {
    const n = FACES.length;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (i + 1) % n;
    else if (e.key === "ArrowLeft") next = (i - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next === null) return;
    e.preventDefault();
    onFace(FACES[next]!.key);
    refs.current[next]?.focus();
  }
  return (
    <div className="faces" role="tablist" aria-label="The three faces of this meeting" data-testid="faces">
      {FACES.map((f, i) => {
        const badge = badges[f.key];
        return (
          <button
            key={f.key}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="tab"
            id={`face-${f.key}-${meetingId}`}
            aria-selected={face === f.key}
            aria-controls={`face-panel-${f.key}-${meetingId}`}
            tabIndex={face === f.key ? 0 : -1}
            className="face-tab"
            data-testid={`face-${f.key}`}
            onClick={() => onFace(f.key)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {f.label}
            {badge && <span className={badge.tone ? `badge badge-${badge.tone}` : "badge"}>{badge.text}</span>}
          </button>
        );
      })}
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
      <div className="section-head">
        <h4>Bring in a Fireflies transcript</h4>
        <span className="muted small">paste the export, or open the file</span>
      </div>
      <p className="muted small">
        Nothing here talks to Fireflies — this reads what you already have. It still needs the same
        permission as anything else recorded on this meeting, and bringing it in is not the same as
        having asked: somebody else made this recording.
      </p>
      <textarea
        aria-label="The Fireflies export"
        data-testid="fireflies-text"
        rows={4}
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

// ── The During face's written record ─────────────────────────────────────────

/**
 * What was written down: the two gates in the stored words a test reads back, the consent that a
 * person records on the file, the notes typed by hand, and any transcript brought in from elsewhere.
 * It sits under the live room because it is the same face — what is being said, and what was.
 */
function WrittenRecord({ meetingId, m, onChanged }: { meetingId: string; m: MeetingDetailRow | null; onChanged: () => void }): JSX.Element {
  const [noteBody, setNoteBody] = useState("");
  const [noteType, setNoteType] = useState("MANUAL");
  const [message, setMessage] = useState<string | null>(null);

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
     * passed even if the gate had opened. `p7` now counts the REFUSED rows on the record — which
     * cannot be stale — and this clears the old verdict for the person reading the page.
     */
    setMessage(null);
    const { status, data } = await api<{ error?: string; detail?: string }>(path, { method: "POST", body });
    setMessage(status === okStatus ? `${label} ok.` : `${label} refused: ${(data as { error?: string })?.error ?? status}`);
    onChanged();
  };

  return (
    <section className="card" data-testid="written-record">
      <div className="panel-head">
        <h3>What was written down</h3>
        <span className="muted small">
          recording is <span data-testid="meeting-recording">{m?.recording_enabled === 1 ? "ACTIVE" : "NOT ACTIVATED"}</span>
          {" · "}permission to transcribe: <span data-testid="meeting-consent">{m?.consent_current?.TRANSCRIPTION?.state ?? "NOT RECORDED"}</span>
        </span>
      </div>
      {/*
        TWO GATES, AND BOTH HAVE TO BE OPEN. The stored words above are what `e2e/p7-meetings.spec.ts`
        reads back, so they stay exactly as they are — and the sentence here says what each one
        means, which is the half a partner was missing.
      */}
      <p className="muted small">
        {m?.recording_enabled === 1
          ? "The firm has switched recording on for this meeting"
          : "The firm has not switched recording on for this meeting"}
        {" — "}
        {consentInWords(m?.consent_current?.TRANSCRIPTION?.state ?? null).toLowerCase()}. Nothing can
        be written down until both of those are true.
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
          A transcript exists elsewhere
        </button>
      </div>
      {message && <p className="notice small" data-testid="meeting-message" role="status">{message}</p>}

      <div className="section-head">
        <h4>Notes</h4>
        <span className="muted small">typed by hand, on or off the record</span>
      </div>
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
      <ul className="card-list small transcript" data-testid="note-list">
        {(m?.notes ?? []).map((n) => (
          <li key={n.id} data-testid={`note-${n.id}`}>
            <span className={n.note_type === "OFF_RECORD" ? "help-tag help-tag-muted" : "help-tag help-tag-good"}>
              {n.note_type === "OFF_RECORD" ? "off record" : n.note_type === "TRANSCRIPT_DERIVED" ? "MANUAL from the recording" : "MANUAL"}
            </span>{" "}
            <b>{n.body}</b>
          </li>
        ))}
        {(m?.notes ?? []).length === 0 && (
          <li className="state-empty" data-testid="no-notes">
            Nothing written down yet. Record the room above, or type what was said.
          </li>
        )}
      </ul>

      <FirefliesImport meetingId={meetingId} onImported={onChanged} />
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
    </section>
  );
}

// ── The record of one meeting ─────────────────────────────────────────────────

/**
 * One meeting, three faces. The head names it; the strip chooses the face; only that face is
 * mounted. Before is the brief with the model's one line at rank 0; During is the room over what
 * was written down, with who is in the room beside it; After is what came out of it — the stage
 * proposal as a direct click (owner's decision Q2, 18 Sep 2026: `decideStageProposal` is already a
 * person's act), and the draft's approval as the one human card.
 */
function MeetingRecord({ row, me, face, onFace, onBack, onChanged, onNavigate }: {
  row: MeetingRow;
  me: MeResponse;
  face: Face;
  onFace: (f: Face) => void;
  onBack: () => void;
  onChanged: () => void;
  onNavigate: (key: string) => void;
}): JSX.Element {
  const meetingId = row.id;
  const meeting = useApi<MeetingDetailRow>(`/api/meetings/${meetingId}`, [meetingId]);
  const m = meeting.data;
  const type = meetingType(row.meeting_type);
  const changed = () => {
    meeting.reload();
    onChanged();
  };

  const badges: Partial<Record<Face, FaceBadge>> = {};
  if (!row.brief_ready && row.status === "SCHEDULED") badges.before = { text: "no brief" };
  if (row.recording_enabled === 1) badges.during = { text: "recording on", tone: "ok" };
  if ((row.stage_proposal_pending_count ?? 0) > 0) badges.after = { text: "waiting on you", tone: "gate" };
  else if ((row.draft_waiting_count ?? 0) > 0) badges.after = { text: "draft", tone: "gate" };
  else if ((row.decision_count ?? 0) + (row.commitment_count ?? 0) + (row.open_question_count ?? 0) === 0) badges.after = { text: "empty" };

  const seating = <LiveHelpPanel meeting={{ id: meetingId, meeting_type: row.meeting_type }} me={me} />;

  return (
    <section className="stack" data-testid="meeting-detail" aria-label={row.title}>
      <div className="row between">
        <div className="grow">
          <p className="deal-name">{row.title}</p>
          <p className="deal-sub">
            {type?.label ?? row.meeting_type} · {whenShort(row.occurred_at ?? row.scheduled_at)} ·{" "}
            <span data-testid="meeting-status">{statusInWords(m?.status ?? row.status)}</span> · {sourceInWordsRow(row)}
          </p>
        </div>
        {row.meet_link && <JoinOnMeet meeting={row} />}
        <button type="button" className="btn-ghost" data-testid="record-back" onClick={onBack}>
          ← All meetings
        </button>
      </div>

      <Faces meetingId={meetingId} face={face} onFace={onFace} badges={badges} />

      <div role="tabpanel" id={`face-panel-${face}-${meetingId}`} aria-labelledby={`face-${face}-${meetingId}`} data-testid={`face-panel-${face}`}>
        {face === "before" && (
          <BeforePanel meetingId={meetingId} onChanged={changed} seating={seating} onOpenRoom={() => onFace("during")} onNavigate={onNavigate} />
        )}
        {face === "during" && (
          <div className="stack">
            <RoomPanel
              meetingId={meetingId}
              aside={
                <>
                  {seating}
                  <QuestionChecklist meetingId={meetingId} />
                  <button type="button" className="btn-strong btn-lg" data-testid="live-finish" onClick={() => onFace("after")}>
                    Done — open the record
                  </button>
                </>
              }
            />
            <WrittenRecord meetingId={meetingId} m={m} onChanged={changed} />
          </div>
        )}
        {face === "after" && (
          <AfterPanel meetingId={meetingId} onChanged={changed} closeout={<CloseoutPanel meetingId={meetingId} />} />
        )}
      </div>
    </section>
  );
}

/** "What we need to find out" as a checklist beside the room: what is still open, from the record. */
function QuestionChecklist({ meetingId }: { meetingId: string }): JSX.Element {
  const after = useApi<{ open_questions: Array<{ id: string; question: string; state: string }> }>(`/api/meetings/${meetingId}/after`, [meetingId]);
  const qs = after.data?.open_questions ?? [];
  const answered = qs.filter((q) => q.state === "ANSWERED").length;
  return (
    <section className="card" data-testid="room-questions">
      <div className="panel-head">
        <h3>What we need to find out</h3>
        <span className="muted small">{qs.length === 0 ? "nothing open" : `${answered} of ${qs.length} answered`}</span>
      </div>
      {qs.length === 0 ? (
        <p className="state-empty">{after.loading ? "Reading the record…" : "No open question is on this meeting. The brief carries them in; the After face records them."}</p>
      ) : (
        <ul className="card-list">
          {qs.map((q) => (
            <li key={q.id} className="check">
              <i className={q.state === "ANSWERED" ? "on" : ""} aria-hidden="true" />
              {q.question} <span className="muted small">— {q.state === "ANSWERED" ? "answered" : q.state === "WITHDRAWN" ? "not needed" : "open"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The Meet link the calendar carries, so joining is one press. A button rather than a bare link
 * because the row's other acts are buttons and the design system has no anchor-as-button rule;
 * the label says where it goes and that it opens elsewhere.
 */
function JoinOnMeet({ meeting }: { meeting: MeetingRow }): JSX.Element {
  return (
    <button
      type="button"
      data-testid={`join-${meeting.id}`}
      aria-label="Join on Meet — opens Google Meet in a new tab"
      title={meeting.meet_link ?? undefined}
      onClick={() => window.open(meeting.meet_link ?? "", "_blank", "noopener,noreferrer")}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" /></svg>
      Join on Meet
    </button>
  );
}

// ── The page ──────────────────────────────────────────────────────────────────

export function MeetingsPage({ me, onNavigate }: { me: MeResponse; onNavigate: (key: string) => void }): JSX.Element {
  const meetings = useApi<MeetingsResponse>("/api/meetings");
  const companies = useApi<{ companies: Array<{ id: string; canonical_name: string }> }>("/api/companies");
  const [title, setTitle] = useState("");
  const [type, setType] = useState("FOUNDER");
  const [companyId, setCompanyId] = useState("");
  const [startsNow, setStartsNow] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [face, setFace] = useState<Face>("before");
  const [message, setMessage] = useState<string | null>(null);
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
  /*
   * CALENDAR TIME, NOT CREATION TIME (§1.1 #4). The list route orders by `created_at` for its own
   * reasons (the archive shelf, the 500 cap); a partner reads a calendar. Soonest first for what is
   * coming, newest first for what happened; a row with no time at all goes last, never first.
   */
  const upcoming = useMemo(
    () => rows.filter((m) => m.status === "SCHEDULED").sort((a, b) => timeOf(a.scheduled_at, Infinity) - timeOf(b.scheduled_at, Infinity)),
    [rows],
  );
  const past = useMemo(
    () => rows.filter((m) => m.status !== "SCHEDULED").sort((a, b) => timeOf(b.occurred_at ?? b.scheduled_at, -Infinity) - timeOf(a.occurred_at ?? a.scheduled_at, -Infinity)),
    [rows],
  );
  const chosen = meetingType(type);
  const openRow = open ? rows.find((m) => m.id === open) ?? null : null;
  const masthead = mastheadFor(upcoming, past, meetings.loading && rows.length === 0, new Date());

  /** The name is a door, not a toggle: opening the record that is open keeps it open. */
  function openRecord(id: string, f: Face) {
    setOpen(id);
    setFace(f);
  }

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
        ? `Recorded as ${res.data.id}. The room is open — ask permission before anything is captured.`
        : `Recorded as ${res.data.id} and put on the calendar.`,
    );
    setTitle("");
    meetings.reload();
    openRecord(res.data.id, startsNow ? "during" : "before");
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
    meetings.reload();
    if (showArchived) archived.reload();
  }

  if (open && openRow) {
    return (
      <section data-testid="meetings-page">
        <MeetingRecord
          row={openRow}
          me={me}
          face={face}
          onFace={setFace}
          onBack={() => setOpen(null)}
          onChanged={() => meetings.reload()}
          onNavigate={onNavigate}
        />
        {message && <p className="notice small" data-testid="meetings-message" role="status">{message}</p>}
      </section>
    );
  }

  return (
    <section data-testid="meetings-page">
      <div className="masthead" data-testid="meetings-masthead">
        <p className="masthead-date">{masthead.eyebrow}</p>
        <h2 data-testid="meetings-answer">{masthead.answer}</h2>
        {masthead.detail && <p className="masthead-second">{masthead.detail}</p>}
      </div>

      {/* ── 1 ─────────────────────────────────────────────────────────────── */}
      <section className="band" data-testid="band-upcoming">
        <div className="band-head">
          <h3>Coming up</h3>
          <span className="band-when">on the calendar, soonest first</span>
        </div>
        <ul className="deal-list" data-testid="meetings-upcoming">
          {upcoming.map((m) => (
            <li key={m.id} className="deal-row deal-row-3" data-testid={`upcoming-${m.id}`}>
              <div>
                <div className="deal-name">{m.title}</div>
                <div className="deal-sub">
                  {meetingType(m.meeting_type)?.label ?? m.meeting_type} · {whenShort(m.scheduled_at)} · {sourceInWordsRow(m)}
                  {/*
                    THE TYPE WAS A GUESS, AND THE ROW SAYS SO. A calendar meeting whose attendees matched
                    neither the firm, a known LP contact nor a known company's domain is filed FOUNDER
                    because something has to be chosen; this is the flag that keeps the guess honest until
                    a person confirms or corrects it.
                  */}
                  {m.type_inference === "UNKNOWN_CHECK_IT" && (
                    <>
                      {" · "}
                      <span className="badge badge-gate" data-testid={`type-check-${m.id}`}>type inferred, check it</span>
                    </>
                  )}
                </div>
              </div>
              <ReadinessLine parts={readinessInWords(m)} testid={`readiness-${m.id}`} />
              <div className="deal-actions">
                {m.meet_link && <JoinOnMeet meeting={m} />}
                <button type="button" data-testid={`start-${m.id}`} onClick={() => openRecord(m.id, "during")}>
                  It is happening now
                </button>
                <button type="button" className="btn-strong" data-testid={`upcoming-open-${m.id}`} onClick={() => openRecord(m.id, "before")}>
                  Open the room
                </button>
              </div>
            </li>
          ))}
          {upcoming.length === 0 && (
            <li className="state-empty" data-testid="no-upcoming">
              {meetings.loading && rows.length === 0
                ? "Reading the calendar…"
                : "Nothing is on the calendar. That is not a fault — put one here from “Start a meeting now” below by giving it a time instead of starting it."}
            </li>
          )}
        </ul>
      </section>

      {/* ── 2 ─────────────────────────────────────────────────────────────── */}
      <section className="band" data-testid="band-record">
        <div className="band-head">
          <h3>On the record</h3>
          <span className="band-when">every meeting held, newest first</span>
        </div>
        <ul className="deal-list" data-testid="meeting-list">
          {past.map((m) => (
            <li key={m.id} className="deal-row deal-row-3" data-testid={`meeting-${m.id}`}>
              <div>
                <div className="deal-name">{m.title}</div>
                <div className="deal-sub">
                  {meetingType(m.meeting_type)?.label ?? m.meeting_type} · {whenShort(m.occurred_at ?? m.scheduled_at)} ·{" "}
                  {(m.transcript_count ?? 0) > 0 ? "transcript on the record" : m.recording_enabled === 1 ? "recording switched on" : "notes only, not recorded"}
                </div>
              </div>
              <ReadinessLine parts={outputsInWords(m)} testid={`outputs-${m.id}`} />
              <div className="deal-actions">
                {/* The row's door. The title rides in the accessible name so a screen reader hears which
                    meeting's record this opens, and a test can find the row by what it is about. */}
                <button type="button" data-testid={`meeting-open-${m.id}`} onClick={() => openRecord(m.id, "after")}>
                  Open what came out of it<span className="sr-only">: {m.title}</span>
                </button>
                {archiving !== m.id && (
                  <button
                    type="button"
                    className="btn-ghost"
                    data-testid={`archive-${m.id}`}
                    onClick={() => { setArchiving(m.id); setArchiveReason(""); }}
                  >
                    Take it off the record
                  </button>
                )}
              </div>
              {archiving === m.id && (
                <div className="form-row deal-message">
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
              )}
            </li>
          ))}
          {past.length === 0 && (
            <li className="state-empty" data-testid="no-meetings">
              {meetings.loading && rows.length === 0
                ? "Reading the record…"
                : "No meeting has been held yet. Once one has, this is where what was decided, what is owed and what is still open live."}
            </li>
          )}
        </ul>

        {/*
          WHAT WAS TAKEN OFF, on the pass-pile pattern rather than as a second tab. Nothing here is
          destroyed, so the page can afford to show it — and a removal nobody can see afterwards is
          indistinguishable from a deletion, which is the thing this deliberately is not.
        */}
        <p className="muted small">
          <button
            type="button"
            className="btn-ghost"
            data-testid="meetings-archived-toggle"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? "Hide what was taken off" : "Show what was taken off"}
          </button>
        </p>
        {showArchived && (
          <ul className="deal-list" data-testid="meetings-archived">
            {(archived.data?.meetings ?? []).map((m) => (
              <li key={m.id} className="deal-row deal-row-2 deal-row-out" data-testid={`archived-${m.id}`}>
                <div>
                  <div className="deal-name">{m.title}</div>
                  <div className="deal-sub">
                    {meetingType(m.meeting_type)?.label ?? m.meeting_type} · taken off the record {whenInWords(m.archived_at ?? null)} — {m.archive_reason ?? "no reason recorded"}
                  </div>
                </div>
                <div className="muted small">Nothing was destroyed. {whatSurvives(m)}</div>
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
      </section>

      {/* ── 3 ─────────────────────────────────────────────────────────────── */}
      <section className="band" data-testid="band-start">
        <div className="band-head">
          <h3>Start a meeting now</h3>
          <span className="band-when">permission first, then the recording</span>
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
          <p className="muted small">A meeting from the firm calendar arrives here on its own. This door is for the ones that do not.</p>
          {message && <p className="notice small" data-testid="meetings-message" role="status">{message}</p>}
        </form>
      </section>

      {/* The committee moved to Dealflow with the design pass (§1.1 #1): one object per page. */}
      <p className="muted small hairline" data-testid="committee-pointer">
        The committee lives on Dealflow — packets, what they do not know, who decided and who disagreed.{" "}
        <button type="button" className="btn-ghost" data-testid="meetings-ic-open" onClick={() => onNavigate("dealflow")}>
          Open Dealflow
        </button>
      </p>
    </section>
  );
}

/** A parseable time as a number, or the given fallback so a missing time sorts to the end. */
function timeOf(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? fallback : t;
}
