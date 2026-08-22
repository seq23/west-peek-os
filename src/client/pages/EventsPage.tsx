import { useState } from "react";
import { api, useApi } from "../lib/api";

/**
 * The firm's record of what it has gathered — the second half of Events & Rooms.
 *
 * This is not a page of its own. It renders two h3 sections into Events & Rooms, at the same rank
 * as the Room sections above it. It used to be mounted inside an h4 subsection of RoomsPage, which
 * put an h3 two levels below another h3 and an h3 inside an h4 — the single worst thing about the
 * layout the operator called jumbled.
 *
 * ORDER: the record first, the form that adds to it second. It was the other way round, so the page
 * asked you to type a new gathering before it showed you the ones you already had.
 *
 * West Peek Live already exists at westpeek.live and runs the actual room. This owns the gathering
 * as a firm record and links out — it does not embed, stream, or duplicate the conference.
 */

interface EventRow {
  id: string;
  title: string;
  event_type: string;
  status: string;
  starts_at: string | null;
  location: string | null;
  live_url: string | null;
  summary: string | null;
}

/** The words a partner would use for the kind of thing it was. */
const TYPES = [
  { key: "DINNER", label: "Dinner" },
  { key: "SUMMIT", label: "Summit" },
  { key: "WORKSHOP", label: "Workshop" },
  { key: "OFFICE_HOURS", label: "Office hours" },
  { key: "MASTERMIND", label: "Mastermind" },
  { key: "WEBINAR", label: "Webinar" },
  { key: "OTHER", label: "Something else" },
] as const;

const typeLabel = (key: string): string =>
  TYPES.find((t) => t.key === key)?.label ?? key.replace(/_/g, " ").toLowerCase();

/**
 * Where a gathering is in its life, in plain English, plus the button that moves it on.
 *
 * `DRAFT`, `PLANNED`, `LIVE` and `COMPLETE` were rendered raw. They are the database's words. The
 * branching below still tests the raw string — only the label changes.
 */
const LIFE: Record<string, { label: string; tone: string; next: string | null; advance: string }> = {
  DRAFT: { label: "Not on the calendar yet", tone: "help-tag help-tag-muted", next: "PLANNED", advance: "Put it on the calendar" },
  PLANNED: { label: "On the calendar", tone: "help-tag help-tag-muted", next: "LIVE", advance: "It is happening now" },
  LIVE: { label: "Happening now", tone: "help-tag help-tag-good", next: "COMPLETE", advance: "It is over" },
  COMPLETE: { label: "Over", tone: "help-tag help-tag-muted", next: null, advance: "" },
  CANCELLED: { label: "Cancelled", tone: "help-tag help-tag-muted", next: null, advance: "" },
};

export function EventsPage(): JSX.Element {
  const state = useApi<{ events: EventRow[] }>("/api/events");
  const [title, setTitle] = useState("");
  const [type, setType] = useState<string>("DINNER");
  const [startsAt, setStartsAt] = useState("");
  const [liveUrl, setLiveUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const events = state.data?.events ?? [];

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    const res = await api<{ error?: string; detail?: string }>("/api/events", {
      method: "POST",
      body: {
        title: title.trim(),
        event_type: type,
        starts_at: startsAt || null,
        live_url: liveUrl.trim() || null,
      },
    });
    if (res.status !== 201) setMessage(res.data?.detail ?? res.data?.error ?? `Could not record it (HTTP ${res.status}).`);
    else { setTitle(""); setStartsAt(""); setLiveUrl(""); }
    setBusy(false);
    state.reload();
  }

  return (
    <>
      <h3>Every gathering on the record</h3>
      <p className="muted">
        Rooms, dinners, workshops, masterminds and the summit, as firm records: who came, when, and
        what came out of it. West Peek Live runs the room itself; this is the record of it.
      </p>
      <p className="muted small" data-testid="events-scope">
        You can record a gathering, move it through its life, and close it out. Run-of-show,
        ticketing, budgets and an AI event planner are not built.
      </p>

      {state.loading && <p className="state-empty">Reading the record…</p>}

      {!state.loading && events.length === 0 && (
        <p className="state-empty" data-testid="events-empty">
          Nothing is on the record. Add the first gathering below — an approved Room becomes one once
          it has a date.
        </p>
      )}

      <div data-testid="events-list">
        {events.map((ev) => {
          const life = LIFE[ev.status] ?? { label: ev.status.toLowerCase(), tone: "help-tag help-tag-muted", next: null, advance: "" };
          return (
            <article className="card" key={ev.id} data-testid={`event-${ev.id}`}>
              <div className="card-head-static">
                <h4>{ev.title}</h4>
                <span className={life.tone} data-testid={`event-state-${ev.id}`}>{life.label}</span>
              </div>
              <p className="muted small">
                {typeLabel(ev.event_type)}
                {ev.starts_at ? ` · ${ev.starts_at}` : " · no date yet"}
                {ev.location ? ` · ${ev.location}` : ""}
              </p>

              <div className="form-row">
                {life.next && (
                  <button
                    type="button"
                    data-testid={`event-advance-${ev.id}`}
                    onClick={async () => {
                      await api(`/api/events/${ev.id}/status`, { method: "POST", body: { status: life.next } });
                      state.reload();
                    }}
                  >
                    {life.advance}
                  </button>
                )}
                {/* External app, so it opens in a new tab and carries noreferrer. */}
                {ev.live_url && (
                  <a href={ev.live_url} target="_blank" rel="noreferrer noopener" data-testid={`event-live-${ev.id}`}>
                    Open in West Peek Live
                  </a>
                )}
              </div>

              <EventCloseout eventId={ev.id} status={ev.status} />
            </article>
          );
        })}
      </div>

      <h3>Put a gathering on the record</h3>
      <form className="card" onSubmit={create} data-testid="event-create-form">
        <div className="form-row">
          <label>
            What was it called{" "}
            <input data-testid="event-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Founder dinner, SF" />
          </label>
          <label>
            What kind{" "}
            <select data-testid="event-type" value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
          </label>
          <label>
            When{" "}
            <input data-testid="event-starts" type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </label>
          <label>
            West Peek Live link{" "}
            <input data-testid="event-live-url" value={liveUrl} onChange={(e) => setLiveUrl(e.target.value)} placeholder="https://westpeek.live/…" />
          </label>
          <button type="submit" className="btn-strong" disabled={busy} data-testid="event-create">
            {busy ? "Recording…" : "Put it on the record"}
          </button>
        </div>
        <p className="muted small">
          Recording it contacts nobody. Inviting anyone is an external effect and needs an approval
          card of its own.
        </p>
        {message && <p className="notice" data-testid="event-message" role="status">{message}</p>}
      </form>
    </>
  );
}

/**
 * Close-out — what came out of a gathering (P51).
 *
 * Two things are captured and both decay fast: what West Peek committed to, and who was actually
 * there. Attendance in particular is unrecoverable a week later, which is why this asks as soon as
 * the gathering is over rather than waiting to be found.
 *
 * WHAT WAS WRONG, TWICE OVER. It returned null for a gathering that had not happened yet, so a
 * partner planning one never learned the step existed and met it for the first time on the one day
 * it is hard to do. And once the gathering was over it rendered a link you had to click before the
 * notes box appeared — a door in front of a door. It now states where it stands in every state, and
 * when there is something to record, the box is already open.
 *
 * The notes box is optional. Running with no notes still records attendance, and the copy says so —
 * otherwise a partner with no notes skips the whole thing and loses the half that mattered.
 */
function EventCloseout({ eventId, status }: { eventId: string; status: string }): JSX.Element {
  const existing = useApi<{ closeout: { digest_md: string; state: string; acts_recorded: number } | null }>(
    `/api/events/${eventId}/closeout`, [eventId],
  );
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(): Promise<void> {
    setBusy(true);
    await api(`/api/events/${eventId}/closeout`, { method: "POST", body: { notes } });
    setBusy(false);
    existing.reload();
  }

  // Announced rather than hidden: a partner should know the step is coming before it is due.
  if (status === "DRAFT" || status === "PLANNED") {
    return (
      <p className="muted small" data-testid={`closeout-pending-${eventId}`}>
        Nothing to close out yet. When it is over, this is where you record who came and what West
        Peek said it would do — and attendance is the part nobody can reconstruct a week later.
      </p>
    );
  }

  if (status === "CANCELLED") {
    return (
      <p className="muted small" data-testid={`closeout-pending-${eventId}`}>
        Cancelled, so there is nothing to close out.
      </p>
    );
  }

  if (existing.loading) {
    return <p className="state-empty">Checking whether this was closed out…</p>;
  }

  const done = existing.data?.closeout;
  if (done) {
    return (
      <details data-testid={`closeout-${eventId}`}>
        <summary>
          Closed out — {done.acts_recorded} attendance record{done.acts_recorded === 1 ? "" : "s"}
          {done.state !== "COMPLETE" && <span className="muted"> (finished with problems)</span>}
        </summary>
        <p className="small" style={{ whiteSpace: "pre-wrap" }}>{done.digest_md}</p>
      </details>
    );
  }

  return (
    <div data-testid={`closeout-prompt-${eventId}`}>
      <p className="small"><strong>Close it out</strong></p>
      <div className="form-row">
        <label>
          What was said, and what we said we would do (optional)
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            data-testid={`closeout-notes-${eventId}`}
          />
        </label>
      </div>
      <p className="muted small">
        With notes, Parker extracts what West Peek committed to and assigns it. Without them,
        attendance is still recorded — which is the part nobody can reconstruct later. Commitments
        guests made to each other are theirs, and are not recorded.
      </p>
      <div className="form-row">
        <button type="button" className="btn-strong" onClick={run} disabled={busy} data-testid={`closeout-run-${eventId}`}>
          {busy ? "Closing out…" : "Close it out"}
        </button>
      </div>
    </div>
  );
}
