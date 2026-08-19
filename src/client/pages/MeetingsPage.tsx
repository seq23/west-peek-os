import { useMemo, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { MEETING_TYPES, meetingType, seatableFor } from "@shared/meetings/meetingTypes";

/**
 * Meetings — what kind, who is in the room, and what came out of it.
 *
 * WHAT WAS WRONG. The page created every meeting as FOUNDER, because the type was hardcoded in the
 * form. Seven types existed in the schema and one was ever used, so every meeting the firm recorded
 * claimed to be a founder meeting. Not cosmetic: close-out delegation reads the type to decide who
 * follows up, so an LP call filed as a founder meeting routes its commitments to the wrong person.
 *
 * SEATING WAS REACHABLE ONLY BY API. Live Help — conferring with an employee during a meeting — was
 * built, tested and governed, and had no button anywhere. The reason it stayed unused is worth
 * naming: "add an employee" on an empty meeting is a question with no obvious answer unless you
 * already know all seventeen. Suggesting the right two or three by meeting type is what makes it
 * usable, and it is why the type had to be real first.
 *
 * THE IC PORTAL IS LINKED FROM HERE. It was reachable only by opening a deal, finding its packet,
 * and following the id — so the surface built for running an investment committee could not be
 * found from the page where committees are scheduled.
 */

interface MeetingRow {
  id: string;
  title: string;
  meeting_type: string;
  status: string;
  scheduled_at: string | null;
  occurred_at: string | null;
  company_id: string | null;
}

interface SeatedEmployee {
  id: string;
  ai_employee_id: string;
  name?: string;
  released_at: string | null;
}

function SeatingPanel({ meeting, me }: { meeting: MeetingRow; me: MeResponse }) {
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
    <section className="card" data-testid={`seating-${meeting.id}`}>
      <h4>Who is in the room</h4>
      <p className="muted small">
        Seat an employee to confer with them during the meeting. Seating grants no new authority —
        they see what you see and can do nothing you have not already approved.
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
      {message && <p className="notice small" data-testid="seating-message">{message}</p>}
      <p className="muted small">Signed in as {me.fullName}. Only a human can seat an employee.</p>
    </section>
  );
}

export function MeetingsPage({ me, onNavigate }: { me: MeResponse; onNavigate: (key: string) => void }) {
  const meetings = useApi<{ meetings: MeetingRow[] }>("/api/meetings");
  const companies = useApi<{ companies: Array<{ id: string; canonical_name: string }> }>("/api/companies");
  const [title, setTitle] = useState("");
  const [type, setType] = useState("FOUNDER");
  const [companyId, setCompanyId] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const rows = meetings.data?.meetings ?? [];
  const open = rows.find((m) => m.id === selected) ?? null;
  const chosen = meetingType(type);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const res = await api<{ id?: string; error?: string; detail?: string }>("/api/meetings", {
      method: "POST",
      body: {
        title: title.trim(),
        // The type is chosen, not assumed. This is the whole bug that was here.
        meeting_type: type,
        company_id: companyId || undefined,
        occurred_at: new Date().toISOString(),
      },
    });
    if (res.status !== 201 || !res.data?.id) {
      setMessage(`Not recorded: ${res.data?.detail ?? res.data?.error ?? res.status}`);
      return;
    }
    setMessage(`Recorded. Seat whoever should be in the room.`);
    setTitle("");
    meetings.reload();
    setSelected(res.data.id);
  }

  return (
    <section data-testid="meetings-page">
      <p className="muted small">
        Preparation, who is in the room, and what came out of it.
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
          <button type="submit" className="btn-strong" data-testid="meeting-create-submit">Record meeting</button>
        </div>
        {chosen && <p className="muted small" data-testid="meeting-type-when">{chosen.when}</p>}
        {message && <p className="notice small" data-testid="meetings-message">{message}</p>}
      </form>

      <div className="home-section-head">
        <h2>Meetings</h2>
      </div>

      <ul className="card-list" data-testid="meeting-list">
        {rows.map((m) => {
          const t = meetingType(m.meeting_type);
          return (
            <li key={m.id} className="card" data-testid={`meeting-${m.id}`}>
              <button type="button" className="link-button" data-testid={`meeting-open-${m.id}`} onClick={() => setSelected(m.id === selected ? null : m.id)}>
                {m.title}
              </button>{" "}
              <span className="badge">{t?.label ?? m.meeting_type}</span>{" "}
              <span className="muted small">{m.status.toLowerCase()}</span>
            </li>
          );
        })}
        {rows.length === 0 && (
          <li className="state-empty" data-testid="no-meetings">
            No meetings recorded yet.
          </li>
        )}
      </ul>

      {open && <SeatingPanel meeting={open} me={me} />}

      {/* The IC portal was reachable only by opening a deal and following its packet id — the
          surface built for running a committee could not be found from where committees are
          scheduled. */}
      <section className="card" data-testid="meetings-ic">
        <h4>Investment Committee</h4>
        <p className="muted small">
          The committee runs off a packet assembled from a deal: the company, the memo, the market,
          the people and the decision. Assemble one from the deal, then run the meeting against it.
        </p>
        <button type="button" className="link-button" data-testid="meetings-ic-open" onClick={() => onNavigate("investment")}>
          Go to Dealflow to assemble a packet →
        </button>
      </section>
    </section>
  );
}
