import { useState } from "react";
import { api, useApi } from "../lib/api";

/**
 * THE PRIVATE LAYER — its own route, off Home (design/HOME_DESIGN.md §2, 19 Sep 2026).
 *
 * Personal timing overlays, visible only to the owner. Production, 20 Aug → 19 Sep: 0 profiles,
 * 0 entries. It sat on Home under "The rest" as a closed drawer nobody opened; Home's job at 7 AM is
 * what is waiting and what arrived, and this is neither. The route (`#/private`) is reachable by
 * URL and from the foot of Home; the owner-only boundary is server-side and unchanged.
 */

interface PersonalProfile {
  profile: { enabled: number; calculation_state: string; calculation_source: string } | null;
  calculation_note: string;
}

interface PersonalEntry {
  id: string;
  entry_date: string;
  kind: string;
  headline: string;
  body: string;
  calculation_state: string;
  source_note: string;
}

export function PrivateLayerPage(): JSX.Element {
  const [open, setOpen] = useState(false);
  const profile = useApi<PersonalProfile>(open ? "/api/personal-intelligence/profile" : null);
  const entries = useApi<{ entries: PersonalEntry[]; disclaimer: string }>(open ? "/api/personal-intelligence/entries" : null);
  const [message, setMessage] = useState<string | null>(null);
  const [headline, setHeadline] = useState("");
  const [kind, setKind] = useState("TIMING_WINDOW");

  const enabled = profile.data?.profile?.enabled === 1;

  return (
    <section className="card private-panel" data-testid="personal-intelligence">
      {/* The page IS the panel; nothing else lives here. */}
      <header className="module-card-head">
        <h4>Private layer</h4>
        <button type="button" className="link-button" data-testid="personal-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Show"}
        </button>
      </header>
      <p className="muted small">
        Personal timing overlays, visible only to you. Not institutional truth, never firm evidence, and never a
        justification for an investment, LP, or compliance decision.
      </p>
      {open && (
        <>
          {profile.loading && <p>Loading…</p>}
          {profile.data && (
            <p className="muted small" data-testid="personal-calculation-note">
              {profile.data.calculation_note}
            </p>
          )}
          {!enabled ? (
            <button
              type="button"
              data-testid="personal-enable"
              onClick={async () => {
                const res = await api("/api/personal-intelligence/profile", {
                  method: "POST",
                  body: { enabled: true, config: { overlays: ["TRANSIT", "LUNAR", "TIMING_WINDOW"] }, calculation_source: "NONE" },
                });
                setMessage(res.status === 201 ? "Private layer enabled for you only." : `Could not enable (HTTP ${res.status}).`);
                profile.reload();
              }}
            >
              Enable my private layer
            </button>
          ) : (
            <form
              className="form-row"
              data-testid="personal-entry-form"
              onSubmit={async (e) => {
                e.preventDefault();
                const res = await api<{ error?: string }>("/api/personal-intelligence/entries", {
                  method: "POST",
                  body: {
                    entry_date: new Date().toISOString().slice(0, 10),
                    kind,
                    headline,
                    body: "",
                  },
                });
                setMessage(res.status === 201 ? "Recorded (manual entry)." : `Refused: ${res.data?.error ?? res.status}`);
                setHeadline("");
                entries.reload();
              }}
            >
              <select data-testid="personal-kind" aria-label="Kind of entry" value={kind} onChange={(e) => setKind(e.target.value)}>
                {["TRANSIT", "LUNAR", "TIMING_WINDOW", "NOTE"].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <input
                data-testid="personal-headline" aria-label="Headline"
                value={headline}
                onChange={(e) => setHeadline(e.target.value)}
                placeholder="What are you watching for yourself?"
              />
              <button type="submit" className="btn-strong" data-testid="personal-submit">
                Record
              </button>
            </form>
          )}
          {message && <p className="notice" data-testid="personal-message">{message}</p>}
          <ul className="card-list" data-testid="personal-entries">
            {(entries.data?.entries ?? []).map((e) => (
              <li key={e.id}>
                <strong>{e.entry_date}</strong> · {e.kind} — {e.headline} <code>{e.calculation_state}</code>
              </li>
            ))}
            {/* Loading is a state, not a gap — see the note on `room-list` in EmployeesPage.tsx. */}
            {open && entries.loading && <li className="state-empty">Reading the entries…</li>}
            {open && !entries.loading && (entries.data?.entries ?? []).length === 0 && <li className="state-empty">No entries.</li>}
          </ul>
        </>
      )}
    </section>
  );
}

