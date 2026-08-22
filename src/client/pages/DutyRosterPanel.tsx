import { useState } from "react";
import { api, useApi, stateMessage } from "../lib/api";
import { readableHour } from "@shared/workforce/dutyRoster";

/**
 * The duty roster, and the operator's control over it.
 *
 * Operator, 22 Aug 2026: "what is dutyroster's flow? i want a default flow and one that i can
 * change in the admin section ---i should be able to adj hours for an employee"
 *
 * WHY IT IS ON AI CONTROLS rather than on Employees. She said the admin section, and this is the
 * Admin surface whose whole subject is controls over how the firm's AI behaves — the provider kill
 * switches, the spend ceiling, the outbound-email switches. Who the firm leans on at 3am is the
 * same kind of thing: a setting, not a record. Employees is where you read a colleague's file and
 * change their employment; the "On duty now" panel stays there as a READOUT, and both surfaces are
 * computed from the same overrides by the same pure resolver so they cannot disagree.
 *
 * WHAT THE PAGE HAS TO SHOW, and each of these is a thing the operator asked to be able to see:
 * which shift is running now, the whole day, which entries are the firm's default and which she
 * changed, the reason attached to every change, and a way back to default that is one press.
 *
 * DEFAULT IS NOT A BADGE ON EVERY ROW. Marking all 20 default entries "Default" would make the
 * page shout the uninteresting thing 20 times and hide the four that matter. Changed entries carry
 * the mark; a shift with nothing changed says so once, at the top of the shift.
 */

interface Change {
  reason: string;
  setBy: string;
  setAt: string;
  hours: string | null;
}

interface Assignment {
  name: string;
  role: string;
  because: string;
  source: string;
  sourceLabel: string;
  change: Change | null;
}

interface Roster {
  shift: string;
  label: string;
  intent: string;
  hours: string;
  onDuty: Assignment[];
  benched: string[];
  changed: boolean;
}

interface OverrideRow {
  employee_name: string;
  kind: "SHIFT" | "HOURS";
  shift_key: string | null;
  what: string;
  shift_label: string | null;
  hours: string | null;
  reason: string;
  set_by: string;
  set_at: string;
}

interface DutyPicture {
  now: Roster & { hour_label: string; hour_source: string };
  day: Roster[];
  overrides: OverrideRow[];
  shifts: Array<{ key: string; label: string; hours: string; intent: string }>;
  employees: string[];
  active_count: number;
  roster_size: number;
  how_it_works: string;
}

/** A stored date as a person says it. The record keeps the instant; the reader gets the day. */
function readableDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Every hour of the day, offered by its name rather than by its number. */
const HOUR_CHOICES = Array.from({ length: 24 }, (_, h) => ({ value: h, label: readableHour(h) }));

export function DutyRosterPanel() {
  // The hour is sent from the browser: a Worker runs in UTC and the partner does not, and a rota
  // that is silently three hours out is worse than no rota.
  const [hour] = useState(() => new Date().getHours());
  const query = `/api/ai/duty?hour=${hour}`;
  const duty = useApi<DutyPicture>(query, [query]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [shiftName, setShiftName] = useState("");
  const [shiftKey, setShiftKey] = useState("");
  const [shiftOn, setShiftOn] = useState("on");
  const [shiftReason, setShiftReason] = useState("");

  const [hoursName, setHoursName] = useState("");
  const [fromHour, setFromHour] = useState(9);
  const [toHour, setToHour] = useState(18);
  const [hoursReason, setHoursReason] = useState("");

  const d = duty.data;
  const load = stateMessage(duty.loading, duty.status, "The rota has not been read yet.", !d);

  const send = async (path: string, body: unknown, said: string) => {
    setBusy(true);
    setMessage(null);
    const res = await api<{ detail?: string; error?: string }>(path, { method: "POST", body });
    setBusy(false);
    if (res.status === 200 || res.status === 201) {
      setMessage(said);
      duty.reload();
      return true;
    }
    setMessage(res.data?.detail ?? res.data?.error ?? "That did not go through.");
    return false;
  };

  const revert = (row: { employee_name: string; kind: string; shift_key: string | null }) =>
    send(
      "/api/ai/duty/revert",
      { employee_name: row.employee_name, kind: row.kind, shift_key: row.shift_key ?? undefined },
      `${row.employee_name} is back on the firm's default.`,
    );

  return (
    <section data-testid="duty-roster-control">
      <h3>Who is on duty, and when</h3>

      {load && <p className="state-message" data-testid="duty-state">{load}</p>}

      {d && (
        <>
          <p className="muted small" data-testid="duty-now-line">
            It is {d.now.hour_label} for you, which is the {d.now.label} shift — {d.now.intent} Of the{" "}
            {d.roster_size} people on the roster, {d.active_count} are employed and available all day; the
            shift decides who the firm leans on.
          </p>
          <p className="muted small">{d.how_it_works}</p>

          <div className="module-grid" data-testid="duty-day">
            {d.day.map((s) => (
              <article
                key={s.shift}
                className={s.shift === d.now.shift ? "module-card rota-current" : "module-card"}
                data-testid={`duty-shift-${s.label}`}
              >
                <div className="module-card-head">
                  <h4>
                    {s.label} · {s.hours}
                  </h4>
                  {s.shift === d.now.shift && <span className="badge badge-ok">Running now</span>}
                </div>
                <p className="muted small">{s.intent}</p>

                {s.onDuty.length === 0 ? (
                  <p className="state-empty">
                    Nobody covers this shift. Everyone the firm would lean on here is either switched off or
                    has been taken off it.
                  </p>
                ) : (
                  <ul className="card-list">
                    {s.onDuty.map((a) => (
                      <li key={a.name} data-testid={`duty-entry-${s.label}-${a.name}`}>
                        <div className="rota-entry-head">
                          <strong>{a.name}</strong>
                          {a.change && <span className="badge badge-gate">{a.sourceLabel}</span>}
                        </div>
                        <span className="muted small">{a.role}</span>
                        <br />
                        <span className="muted small">{a.because}</span>
                        {a.change && (
                          <div className="rota-change">
                            <span className="muted small">
                              {a.change.hours ? `${a.change.hours}. ` : ""}
                              Changed by {a.change.setBy} on {readableDate(a.change.setAt)}.
                            </span>
                            <br />
                            <button
                              type="button"
                              className="link-button"
                              disabled={busy}
                              data-testid={`duty-revert-${s.label}-${a.name}`}
                              onClick={() =>
                                revert({
                                  employee_name: a.name,
                                  kind: a.source === "CUSTOM_HOURS" ? "HOURS" : "SHIFT",
                                  shift_key: a.source === "CUSTOM_HOURS" ? null : s.shift,
                                })
                              }
                            >
                              Put back to default
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                <p className="muted small">
                  {s.changed
                    ? "Something on this shift was changed by hand."
                    : "This shift is the firm's default."}
                  {s.benched.length > 0 && ` Also here, not on point: ${s.benched.join(", ")}.`}
                </p>
              </article>
            ))}
          </div>

          <h3>Change who is on duty</h3>
          <p className="muted small">
            Everything you set here is stored as a difference from the default above — never as a copy of
            it. Custom hours beat a shift change, and a shift change beats the default. Putting something
            back to default removes the difference, so nothing has to be remembered and restored.
          </p>

          {message && (
            <p className="notice" data-testid="duty-message">
              {message}
            </p>
          )}

          <div className="rota-forms">
            <form
              className="card"
              data-testid="duty-shift-form"
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await send(
                  "/api/ai/duty/overrides",
                  {
                    kind: "SHIFT",
                    employee_name: shiftName,
                    shift_key: shiftKey,
                    on_duty: shiftOn === "on",
                    reason: shiftReason,
                  },
                  `${shiftName} is now ${shiftOn === "on" ? "on" : "off"} that shift.`,
                );
                if (ok) setShiftReason("");
              }}
            >
              <h4>Put somebody on or off a shift</h4>
              <div className="form-row">
                <label>
                  Who
                  <select
                    data-testid="duty-shift-who"
                    required
                    value={shiftName}
                    onChange={(e) => setShiftName(e.target.value)}
                  >
                    <option value="">Choose somebody</option>
                    {d.employees.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Which shift
                  <select
                    data-testid="duty-shift-which"
                    required
                    value={shiftKey}
                    onChange={(e) => setShiftKey(e.target.value)}
                  >
                    <option value="">Choose a shift</option>
                    {d.shifts.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label} · {s.hours}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  On or off
                  <select data-testid="duty-shift-onoff" value={shiftOn} onChange={(e) => setShiftOn(e.target.value)}>
                    <option value="on">Put them on it</option>
                    <option value="off">Take them off it</option>
                  </select>
                </label>
              </div>
              <div className="form-row">
                <label>
                  Why you are changing it
                  <input
                    data-testid="duty-shift-reason"
                    required
                    minLength={4}
                    placeholder="So somebody reading this in a month knows"
                    value={shiftReason}
                    onChange={(e) => setShiftReason(e.target.value)}
                  />
                </label>
              </div>
              <button type="submit" className="btn-strong" disabled={busy} data-testid="duty-shift-save">
                Save this change
              </button>
            </form>

            <form
              className="card"
              data-testid="duty-hours-form"
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await send(
                  "/api/ai/duty/overrides",
                  {
                    kind: "HOURS",
                    employee_name: hoursName,
                    from_hour: fromHour,
                    to_hour: toHour,
                    reason: hoursReason,
                  },
                  `${hoursName} now works ${readableHour(fromHour)} to ${readableHour(toHour)}.`,
                );
                if (ok) setHoursReason("");
              }}
            >
              <h4>Give somebody their own hours</h4>
              <p className="muted small">
                Their own hours replace the shifts for them entirely — they are on whenever the window says
                so, however the firm divides the rest of the day. An end earlier than the start runs through
                the night.
              </p>
              <div className="form-row">
                <label>
                  Who
                  <select
                    data-testid="duty-hours-who"
                    required
                    value={hoursName}
                    onChange={(e) => setHoursName(e.target.value)}
                  >
                    <option value="">Choose somebody</option>
                    {d.employees.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  From
                  <select
                    data-testid="duty-hours-from"
                    value={String(fromHour)}
                    onChange={(e) => setFromHour(Number(e.target.value))}
                  >
                    {HOUR_CHOICES.map((h) => (
                      <option key={h.value} value={String(h.value)}>
                        {h.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Until
                  <select
                    data-testid="duty-hours-to"
                    value={String(toHour)}
                    onChange={(e) => setToHour(Number(e.target.value))}
                  >
                    {HOUR_CHOICES.map((h) => (
                      <option key={h.value} value={String(h.value)}>
                        {h.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="form-row">
                <label>
                  Why you are changing it
                  <input
                    data-testid="duty-hours-reason"
                    required
                    minLength={4}
                    placeholder="So somebody reading this in a month knows"
                    value={hoursReason}
                    onChange={(e) => setHoursReason(e.target.value)}
                  />
                </label>
              </div>
              <button type="submit" className="btn-strong" disabled={busy} data-testid="duty-hours-save">
                Save these hours
              </button>
            </form>
          </div>

          <h4>What you have changed</h4>
          {d.overrides.length === 0 ? (
            <p className="state-empty" data-testid="duty-overrides-empty">
              Nothing is changed. The whole rota above is the firm's default.
            </p>
          ) : (
            <ul className="card-list" data-testid="duty-overrides">
              {d.overrides.map((o) => (
                <li key={`${o.employee_name}-${o.kind}-${o.shift_key ?? "hours"}`} data-testid={`duty-override-${o.employee_name}`}>
                  <div className="rota-entry-head">
                    <strong>{o.employee_name}</strong>
                    <button
                      type="button"
                      className="link-button"
                      disabled={busy}
                      data-testid={`duty-override-revert-${o.employee_name}`}
                      onClick={() => revert(o)}
                    >
                      Put back to default
                    </button>
                  </div>
                  <span className="muted small">{o.what}</span>
                  <br />
                  <span className="muted small">
                    {o.reason} — {o.set_by}, {readableDate(o.set_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
