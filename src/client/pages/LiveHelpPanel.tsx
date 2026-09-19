import { useMemo, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { meetingType, seatableFor } from "@shared/meetings/meetingTypes";
import { portraitAlt, portraitFor } from "../lib/employeePortraits";

/**
 * Who is in the room — the one seating card, on the Before and During faces (Phase D, §3).
 *
 * "The Live Help tab is where Walter lives" (canon §3, §28.5). It was two panels keeping two lists
 * of the same seats: `SeatingPanel` on the record (suggestions by meeting type, with the warning
 * for an internal-only seat in an external room) and `LiveHelpPanel` under it (the same seats
 * again, a release button, a chat thread the live room has since replaced with saved blocks, and
 * the revoke-all switch). One list now, with everything a seat can do on its row.
 *
 * WHAT STAYED. Suggestions ordered by meeting type, because "add an employee" on an empty meeting
 * is a question with no obvious answer unless you already know the roster; the WARNING, never a
 * lock, for an internal-only seat in a room with outsiders (owner's rule, 18 Sep 2026: any employee
 * can be seated anywhere); release; and revoke-all / restore, which is destructive enough to
 * confirm first (canon §9.6.2E). Only an ACTIVE employee can be seated and only a person can seat
 * one — the server enforces both; this card offers what can happen and nothing else.
 *
 * WHAT WENT. The chat thread and its quick actions: the room's own ask box answers and SAVES the
 * answer on the meeting (`RoomPanel.tsx`), where the thread evaporated. The name is kept so the
 * shell's import still resolves; what it names is the seating card.
 */

interface SeatedEmployee {
  ai_employee_id: string;
  name: string;
  role: string;
  status: string;
}

interface LiveHelpResponse {
  seated: SeatedEmployee[];
  ai_access_state: string;
  ai_access_note: string | null;
}

export function LiveHelpPanel({ meeting, me }: { meeting: { id: string; meeting_type: string }; me: MeResponse }): JSX.Element {
  const state = useApi<LiveHelpResponse>(`/api/meetings/${meeting.id}/live-help`, [meeting.id]);
  const lounge = useApi<{ employees: Array<{ id: string; name: string; status: string }> }>("/api/workforce/lounge");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const seated = state.data?.seated ?? [];
  const revoked = state.data?.ai_access_state === "REVOKED";
  const seatedByName = new Map(seated.map((s) => [s.name, s]));
  const employed = useMemo(() => (lounge.data?.employees ?? []).filter((e) => e.status === "ACTIVE"), [lounge.data]);
  const byName = useMemo(() => new Map(employed.map((e) => [e.name, e.id])), [employed]);
  // Suggested first, then the rest of the roster, each in roster order.
  const seats = useMemo(() => {
    const all = seatableFor(meeting.meeting_type, employed.map((e) => e.name));
    return [...all.filter((s) => s.suggested), ...all.filter((s) => !s.suggested)];
  }, [meeting.meeting_type, employed]);
  const type = meetingType(meeting.meeting_type);

  async function seat(name: string) {
    const id = byName.get(name);
    if (!id) return;
    setBusy(name);
    setMessage(null);
    const res = await api<{ error?: string; detail?: string }>(`/api/meetings/${meeting.id}/employees`, { method: "POST", body: { ai_employee_id: id } });
    setBusy(null);
    if (res.status >= 400) setMessage(res.data?.detail ?? res.data?.error ?? `Could not seat ${name}.`);
    else setMessage(`${name} is in the room.`);
    state.reload();
  }

  async function release(s: SeatedEmployee) {
    setBusy(s.name);
    setMessage(null);
    const res = await api<{ error?: string; detail?: string }>(`/api/meetings/${meeting.id}/employees/release`, { method: "POST", body: { ai_employee_id: s.ai_employee_id } });
    setBusy(null);
    if (res.status >= 400) setMessage(res.data?.detail ?? res.data?.error ?? `Could not release ${s.name}.`);
    else setMessage(`${s.name} has left the room.`);
    state.reload();
  }

  return (
    <section className="card" data-testid={`seating-${meeting.id}`}>
      <div className="panel-head">
        <h3>Who is in the room</h3>
        <span className="muted small">seating grants no authority</span>
      </div>

      {revoked ? (
        <div className="notice notice-bad" data-testid="live-help-revoked">
          <strong>AI access to this room is revoked.</strong> No employee can read the notes, answer
          here, or process follow-up. You can keep taking notes yourself.
          {state.data?.ai_access_note && <div className="muted small">{state.data.ai_access_note}</div>}
          <div className="form-row">
            <button
              type="button"
              data-testid="live-help-restore"
              onClick={async () => {
                await api(`/api/meetings/${meeting.id}/ai-access/restore`, { method: "POST", body: {} });
                state.reload();
              }}
            >
              Restore AI access
            </button>
          </div>
        </div>
      ) : employed.length === 0 ? (
        <p className="state-empty" data-testid="seating-nobody-employed">
          Nobody is employed yet, so there is nobody to seat. Turn someone on from Employees.
        </p>
      ) : (
        <div data-testid="live-help-seats">
          {seats.map((s) => {
            const on = seatedByName.get(s.name) ?? null;
            return (
              <div key={s.name} className="seat" data-testid={`seat-row-${s.name}`}>
                {portraitFor(s.name) ? (
                  <img className="employee-portrait" src={portraitFor(s.name)!} alt={portraitAlt(s.name, s.role)} width={22} height={22} loading="lazy" onError={(ev) => { (ev.currentTarget as HTMLImageElement).style.display = "none"; }} />
                ) : (
                  <span className="avatar" aria-hidden="true">{s.name.slice(0, 2).toUpperCase()}</span>
                )}
                <div className="who">
                  {s.name}
                  <span>
                    {s.role} · {s.because}
                    {/* A WARNING, NOT A LOCK. The owner's rule: any employee can be seated anywhere. */}
                    {s.warning && <span className="badge badge-gate" data-testid={`seat-warning-${s.name}`}>{s.warning}</span>}
                  </span>
                </div>
                {on ? (
                  <>
                    <span className="badge badge-ok" data-testid={`live-help-seat-${on.ai_employee_id}`}>seated</span>
                    <button type="button" className="link-button" disabled={busy === s.name} aria-label={`Release ${s.name} from this meeting`} data-testid={`release-${s.name}`} onClick={() => void release(on)}>
                      Release
                    </button>
                  </>
                ) : (
                  <button type="button" disabled={busy === s.name} data-testid={`seat-${s.name}`} onClick={() => void seat(s.name)}>
                    {busy === s.name ? "…" : "Seat"}
                  </button>
                )}
              </div>
            );
          })}
          {seated.length === 0 && (
            <p className="muted small" data-testid="live-help-nobody">
              No one is seated yet. Seat someone here, or say a name in the room and they join.
            </p>
          )}
        </div>
      )}

      {type?.external && !revoked && (
        <p className="muted small">
          An internal-only seat in a room with outsiders is a warning, not a lock: what they say is
          meant for the firm.
        </p>
      )}
      {!revoked && (
        <div className="form-row">
          {/* Prominent, per canon §9.6.2E — and destructive enough to confirm first. */}
          <button
            type="button"
            className="btn-danger"
            data-testid="live-help-revoke-all"
            onClick={async () => {
              if (!confirm("Revoke all AI access to this room? Everyone seated is removed and nobody can be seated again until you restore access.")) return;
              await api(`/api/meetings/${meeting.id}/ai-access/revoke`, { method: "POST", body: {} });
              state.reload();
            }}
          >
            Revoke all AI access
          </button>
        </div>
      )}
      {message && <p className="notice small" data-testid="seating-message" role="status">{message}</p>}
      <p className="muted small">Signed in as {me.fullName}. Only a person can seat an employee.</p>
    </section>
  );
}
