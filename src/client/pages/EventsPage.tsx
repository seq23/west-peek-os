import { useState } from "react";
import { api, useApi } from "../lib/api";
import { HowThisWorks } from "./HowThisWorks";

/**
 * Event OS — scaffolding (P33, V1 #20).
 *
 * This page is deliberately thin and SAYS SO on screen. A page that looks finished but does almost
 * nothing is worse than an honest stub: the operator plans around capability that isn't there. So
 * the scope note is part of the UI, not a comment in the source.
 *
 * West Peek Live already exists at westpeek.live and runs the actual room. This page owns the
 * event as a firm record and links out — it does not embed, stream, or duplicate the conference.
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

const TYPES = ["DINNER", "SUMMIT", "WORKSHOP", "OFFICE_HOURS", "MASTERMIND", "WEBINAR", "OTHER"] as const;
const NEXT_STATUS: Record<string, string | null> = {
  DRAFT: "PLANNED", PLANNED: "LIVE", LIVE: "COMPLETE", COMPLETE: null, CANCELLED: null,
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
    if (res.status !== 201) setMessage(res.data?.detail ?? res.data?.error ?? `Could not create (HTTP ${res.status}).`);
    else { setTitle(""); setStartsAt(""); setLiveUrl(""); }
    setBusy(false);
    state.reload();
  }

  return (
    <div className="page" data-testid="events-page">
      <h3>Events</h3>
      <p className="muted">
        Events as firm records — who came, when, and what came out of it.{" "}
        <strong>West Peek Live</strong> runs the room itself; link it here.
      </p>

      <p className="notice" data-testid="events-scope">
        Scaffolding. You can record an event, track attendance and move it through its lifecycle.
        Run-of-show, sponsorship, ticketing and the AI Event Planner are not built yet.
      </p>

      <form className="card" onSubmit={create} data-testid="event-create-form">
        <h4>Add an event</h4>
        <div className="form-row">
          <label>
            Title{" "}
            <input data-testid="event-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Founder dinner, SF" />
          </label>
          <label>
            Type{" "}
            <select data-testid="event-type" value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => (
                <option key={t} value={t}>{t.replace(/_/g, " ").toLowerCase()}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row">
          <label>
            Starts{" "}
            <input data-testid="event-starts" type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </label>
          <label>
            West Peek Live link{" "}
            <input data-testid="event-live-url" value={liveUrl} onChange={(e) => setLiveUrl(e.target.value)} placeholder="https://westpeek.live/…" />
          </label>
        </div>
        <button type="submit" className="btn-strong" disabled={busy} data-testid="event-create">
          {busy ? "Adding…" : "Add event"}
        </button>
        {message && <p className="notice" data-testid="event-message">{message}</p>}
      </form>

      <section className="card">
        <h4>All events</h4>
        {events.length === 0 ? (
          <p className="state-empty" data-testid="events-empty">No events recorded yet.</p>
        ) : (
          <ul className="card-list" data-testid="events-list">
            {events.map((ev) => (
              <li key={ev.id} data-testid={`event-${ev.id}`}>
                <span className={ev.status === "LIVE" ? "help-tag help-tag-good" : "help-tag help-tag-muted"}>
                  {ev.status.toLowerCase()}
                </span>{" "}
                <strong>{ev.title}</strong>{" "}
                <span className="muted small">
                  {ev.event_type.replace(/_/g, " ").toLowerCase()}
                  {ev.starts_at && ` · ${ev.starts_at}`}
                </span>
                {ev.live_url && (
                  <>
                    {" "}
                    {/* External app, so it opens in a new tab and carries noreferrer. */}
                    <a href={ev.live_url} target="_blank" rel="noreferrer noopener" data-testid={`event-live-${ev.id}`}>
                      Open in West Peek Live
                    </a>
                  </>
                )}
                {NEXT_STATUS[ev.status] && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="link-button"
                      data-testid={`event-advance-${ev.id}`}
                      onClick={async () => {
                        await api(`/api/events/${ev.id}/status`, { method: "POST", body: { status: NEXT_STATUS[ev.status] } });
                        state.reload();
                      }}
                    >
                      Mark {NEXT_STATUS[ev.status]!.toLowerCase()}
                    </button>
                  </>
                )}
                <CloseoutPanel eventId={ev.id} status={ev.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <HowThisWorks
        title="Events"
        testId="events"
        what="Events as firm records — the guest list, the date, and what came out of it — so an event connects to relationships and follow-ups instead of living in someone's calendar."
        when="When you are planning or have just run a dinner, summit, workshop or office hours and want it on the record."
        operatorDoes={[
          "Add an event and set its type and date.",
          "Paste the West Peek Live link if it happens in the virtual venue.",
          "Move it through draft → planned → live → complete.",
        ]}
        aiDoes={[
          "Nothing yet. The AI Event Planner in canon §15 is not built.",
        ]}
        requiresOperator={[
          "Inviting anyone. Sending outside the firm is an external effect and needs an approval card; adding an attendee here records intent, it does not contact them.",
        ]}
        next="Attendance and outcomes feed the relationship record. Run-of-show, sponsorship, ticketing and budgets come later — this is agreed scaffolding, not a finished module."
        blocked={[
          "Creating an event needs the event.manage action in your role.",
          "A West Peek Live link must be a full https URL.",
        ]}
      />
    </div>
  );
}


/**
 * Close-out — what came out of a gathering (P51).
 *
 * Two things are captured and both decay fast: what West Peek committed to, and who was actually
 * there. Attendance in particular is unrecoverable a week later, which is why the panel nags once
 * an event is over rather than waiting to be found.
 *
 * The notes box is optional. Running with no notes still records attendance, and the copy says so —
 * otherwise a partner with no notes skips the whole thing and loses the half that mattered.
 */
function CloseoutPanel({ eventId, status }: { eventId: string; status: string }): JSX.Element | null {
  const existing = useApi<{ closeout: { digest_md: string; state: string; acts_recorded: number } | null }>(
    `/api/events/${eventId}/closeout`, [eventId],
  );
  const [notes, setNotes] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Nothing to close out before it has happened.
  if (status === "DRAFT" || status === "PLANNED" || status === "CANCELLED") return null;
  if (existing.loading) return null;

  const done = existing.data?.closeout;
  if (done) {
    return (
      <details className="closeout-done" data-testid={`closeout-${eventId}`}>
        <summary>
          Closed out — {done.acts_recorded} attendance record{done.acts_recorded === 1 ? "" : "s"}
          {done.state !== "COMPLETE" && <span className="warn"> ({done.state.toLowerCase().replace(/_/g, " ")})</span>}
        </summary>
        <pre className="prewrap">{done.digest_md}</pre>
      </details>
    );
  }

  async function run(): Promise<void> {
    setBusy(true);
    await api(`/api/events/${eventId}/closeout`, { method: "POST", body: { notes } });
    setBusy(false);
    existing.reload();
  }

  return (
    <div className="closeout-prompt" data-testid={`closeout-prompt-${eventId}`}>
      {!open ? (
        <button type="button" className="link-button" onClick={() => setOpen(true)} data-testid={`closeout-open-${eventId}`}>
          Close it out — record who came and what we owe
        </button>
      ) : (
        <>
          <label>
            Notes (optional)
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              placeholder="What was said, and what we said we would do."
              data-testid={`closeout-notes-${eventId}`}
            />
          </label>
          <p className="muted">
            With notes, Parker extracts what West Peek committed to and assigns it. Without them,
            attendance is still recorded — which is the part nobody can reconstruct later.
            Commitments guests made to each other are theirs, and are not recorded.
          </p>
          <button type="button" className="btn-strong" onClick={run} disabled={busy} data-testid={`closeout-run-${eventId}`}>
            {busy ? "Closing out…" : "Close out"}
          </button>
        </>
      )}
    </div>
  );
}
