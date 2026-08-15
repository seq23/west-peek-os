import { useEffect, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";

/**
 * MP Home / Executive Command Center (P14, GAP-04 + GAP-23).
 *
 * Reads ONE aggregation (`/api/mp-home`) and renders configurable modules. Every module
 * states which Managing Partner question it answers and links to the surface that owns
 * the underlying records — the home is a view, never a second store.
 *
 * The private personal-intelligence panel is deliberately a separate, collapsed section
 * with its own disclaimer. It is owner-only server-side; hiding it here is presentation,
 * not the boundary.
 */

interface HomeModule {
  key: string;
  title: string;
  answers: string;
  link: string;
  count: number;
  items: Array<Record<string, unknown>>;
  note?: string;
}

interface HomeResponse {
  modules: HomeModule[];
  enabled_modules: string[];
  available_modules: string[];
  one_thing_to_watch: { headline: string; because: string; link: string } | null;
  questions: Array<{ question: string; module: string | null }>;
  generated_at: string;
}

interface PreferenceResponse {
  preference: { version_no: number; modules_json: string; briefing_json: string; created_at: string } | null;
  history: Array<{ id: string; version_no: number; created_at: string; set_by: string }>;
}

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

const MODULE_LABELS: Record<string, string> = {
  approvals: "Waiting on your decision",
  intelligence: "Daily intelligence",
  portfolio_risk: "Portfolio risk",
  allocation_constraints: "Allocation constraints",
  meetings: "Upcoming meetings",
  ic_priorities: "IC / deal priorities",
  lp_signals: "LP / fundraising signals",
  reconciliation: "Reconciliation exceptions",
  ai_spend: "AI spend today",
  what_changed: "What changed",
  my_work: "My open work",
  employees: "AI workforce",
};

function ModuleCard({ module, onNavigate }: { module: HomeModule; onNavigate: (key: string) => void }) {
  return (
    <section className="module-card" data-testid={`home-module-${module.key}`}>
      <header className="module-card-head">
        <h4>
          {module.title} <span className="module-count">{module.count}</span>
        </h4>
        <button type="button" className="link-button" onClick={() => onNavigate(module.link)}>
          Open
        </button>
      </header>
      <p className="module-answers">{module.answers}</p>
      {module.items.length === 0 ? (
        <p className="muted" data-testid={`home-module-empty-${module.key}`}>
          {module.note ?? "Nothing here."}
        </p>
      ) : (
        <>
          <ul className="module-items">
            {module.items.slice(0, 5).map((item, i) => (
              <li key={String(item.id ?? i)}>{summarize(module.key, item)}</li>
            ))}
          </ul>
          {module.note && <p className="muted small">{module.note}</p>}
        </>
      )}
    </section>
  );
}

/** Render one row per module type. Deliberately explicit: each surface has its own shape. */
function summarize(moduleKey: string, item: Record<string, unknown>): string {
  const s = (k: string) => (item[k] === null || item[k] === undefined ? "" : String(item[k]));
  switch (moduleKey) {
    case "approvals":
      return `${s("title")} — ${s("action_key")}`;
    case "intelligence":
      return `${s("title")} · score ${s("relevance_score")} (${s("relevance_reason")})`;
    case "portfolio_risk":
      return `${s("severity")} · ${s("canonical_name") || s("company_id")} — ${s("alert_type")}${s("metric_key") ? ` (${s("metric_key")})` : ""}`;
    case "allocation_constraints":
      return `${s("severity")} · ${s("kind")} — ${s("detail")}`;
    case "meetings":
      return `${s("scheduled_at")} — ${s("title")} (${s("meeting_type")})`;
    case "ic_priorities":
      return `${s("status")} · ${s("canonical_name") || s("company_id")} — ${s("title")}`;
    case "lp_signals":
      return `${s("stage")} · ${s("legal_name")}${s("target_commitment") ? ` — target ${s("target_commitment")}` : ""}`;
    case "reconciliation":
      return `${s("exception_kind")} · ${s("record_kind")}/${s("record_key")} field ${s("field")}`;
    case "ai_spend":
      return `$${s("spent_usd")} of $${s("daily_cap_usd")} cap · ${s("cost_mode")}/${s("privacy_mode")} · ${s("blocked_runs_today")} blocked run(s)`;
    case "what_changed":
      return `${s("event_type")} — ${s("object_type")}/${s("object_id")} at ${s("created_at")}`;
    case "my_work":
      return `${s("priority")} · ${s("title")} — ${s("state")}${s("next_action") ? ` · next: ${s("next_action")}` : ""}`;
    default:
      return JSON.stringify(item);
  }
}

function PersonalIntelligencePanel() {
  const [open, setOpen] = useState(false);
  const profile = useApi<PersonalProfile>(open ? "/api/personal-intelligence/profile" : null);
  const entries = useApi<{ entries: PersonalEntry[]; disclaimer: string }>(open ? "/api/personal-intelligence/entries" : null);
  const [message, setMessage] = useState<string | null>(null);
  const [headline, setHeadline] = useState("");
  const [kind, setKind] = useState("TIMING_WINDOW");

  const enabled = profile.data?.profile?.enabled === 1;

  return (
    <section className="card private-panel" data-testid="personal-intelligence">
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
              <select data-testid="personal-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                {["TRANSIT", "LUNAR", "TIMING_WINDOW", "NOTE"].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <input
                data-testid="personal-headline"
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
            {open && !entries.loading && (entries.data?.entries ?? []).length === 0 && <li className="state-empty">No entries.</li>}
          </ul>
        </>
      )}
    </section>
  );
}

function ModuleSettings({ home, onSaved }: { home: HomeResponse; onSaved: () => void }) {
  const prefs = useApi<PreferenceResponse>("/api/mp-home/preferences");
  const [selected, setSelected] = useState<string[]>(home.enabled_modules);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setSelected(home.enabled_modules);
  }, [home.enabled_modules]);

  return (
    <section className="card" data-testid="home-settings">
      <header className="module-card-head">
        <h4>Home layout</h4>
        <button type="button" className="link-button" data-testid="home-settings-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? "Done" : "Configure"}
        </button>
      </header>
      {open && (
        <>
          <div className="module-toggles">
            {home.available_modules.map((key) => (
              <label key={key} className="module-toggle">
                <input
                  type="checkbox"
                  data-testid={`module-toggle-${key}`}
                  checked={selected.includes(key)}
                  onChange={(e) =>
                    setSelected((cur) => (e.target.checked ? [...cur, key] : cur.filter((k) => k !== key)))
                  }
                />{" "}
                {MODULE_LABELS[key] ?? key}
              </label>
            ))}
          </div>
          <button
            type="button"
            data-testid="home-settings-save"
            onClick={async () => {
              const res = await api<{ version_no: number }>("/api/mp-home/preferences", {
                method: "POST",
                body: { modules: selected, briefing: {} },
              });
              setMessage(
                res.status === 201
                  ? `Saved as version ${res.data?.version_no}. Previous versions are kept.`
                  : `Save failed (HTTP ${res.status}).`,
              );
              prefs.reload();
              onSaved();
            }}
          >
            Save layout
          </button>
          {message && <p className="notice" data-testid="home-settings-message">{message}</p>}
          {prefs.data?.history && prefs.data.history.length > 0 && (
            <p className="muted small">
              {prefs.data.history.length} saved version(s); the newest applies. Preferences are append-only.
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function HomePage({ me, onNavigate }: { me: MeResponse; onNavigate: (key: string) => void }) {
  const home = useApi<HomeResponse>("/api/mp-home");
  const briefing = useApi<{ briefing: { one_thing_to_watch: string | null; selection_rule: string; briefing_date: string }; items: Array<{ id: string; title: string }> }>(
    "/api/briefings/current",
  );

  // Mark the visit AFTER the first read, so "what changed" is a diff against the
  // previous visit rather than against this one.
  useEffect(() => {
    if (home.status === 200) void api("/api/mp-home/seen", { method: "POST" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home.status]);

  // Only the FIRST load blanks the page. A refresh after saving preferences keeps the
  // rendered surface (and the settings panel's own state) in place.
  if (home.loading && !home.data) return <p data-testid="home-loading">Loading your command surface…</p>;
  if (home.status !== 200 || !home.data) {
    return <p data-testid="home-error">Could not load the command surface (HTTP {home.status ?? "?"}).</p>;
  }

  const data = home.data;

  return (
    <section data-testid="home-page">
      <p className="muted small">
        Good day, {me.fullName}. Assembled {new Date(data.generated_at).toLocaleString()} from live firm state.
      </p>

      {data.one_thing_to_watch ? (
        <section className="card watch-banner" data-testid="one-thing-to-watch">
          <h3>One thing to watch</h3>
          <p className="watch-headline">{data.one_thing_to_watch.headline}</p>
          <p className="muted small">{data.one_thing_to_watch.because}</p>
          <button type="button" onClick={() => onNavigate(data.one_thing_to_watch!.link)}>
            Go there
          </button>
        </section>
      ) : (
        <section className="card" data-testid="one-thing-to-watch-empty">
          <h3>One thing to watch</h3>
          <p className="state-empty">Nothing is flagged: no open portfolio alert, no card waiting on you, no ranked intelligence.</p>
        </section>
      )}

      <div className="module-grid" data-testid="home-modules">
        {data.modules.map((m) => (
          <ModuleCard key={m.key} module={m} onNavigate={onNavigate} />
        ))}
      </div>

      <section className="card" data-testid="home-questions">
        <h4>The ten questions this surface answers</h4>
        <ul className="question-list">
          {data.questions.map((q) => (
            <li key={q.question} data-testid={`home-question-${q.module ?? "none"}`}>
              {q.question}{" "}
              {q.module ? (
                <code>{MODULE_LABELS[q.module] ?? q.module}</code>
              ) : (
                <span className="muted small">no module enabled for this yet</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {briefing.data?.briefing && (
        <section className="card" data-testid="home-briefing">
          <h4>Today&apos;s briefing ({briefing.data.briefing.briefing_date})</h4>
          <p className="muted small">Selection rule: {briefing.data.briefing.selection_rule}</p>
          <ul className="card-list">
            {briefing.data.items.slice(0, 5).map((i) => (
              <li key={i.id}>{i.title}</li>
            ))}
            {briefing.data.items.length === 0 && <li className="state-empty">No items ranked for today yet.</li>}
          </ul>
          <button type="button" className="link-button" onClick={() => onNavigate("intelligence")}>
            Open Intelligence
          </button>
        </section>
      )}

      <ModuleSettings home={data} onSaved={home.reload} />
      <PersonalIntelligencePanel />
    </section>
  );
}
