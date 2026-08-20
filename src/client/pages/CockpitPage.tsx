import { useState } from "react";
import { useApi, type MeResponse } from "../lib/api";

/**
 * Portfolio Intelligence Cockpit + Allocation Decision View (P25; GAP-12, GAP-13).
 *
 * The Managing Partner view over substrate that already exists. Every number carries its
 * definition, missing data is shown as a finding rather than a blank, and the allocation view
 * states plainly that a scenario is a comparison rather than a prediction.
 */

interface Cockpit {
  top_risks: Array<{ id: string; canonical_name: string | null; company_id: string; alert_type: string; severity: string; metric_key: string | null }>;
  open_alert_count: number;
  deteriorating: Array<{ company: string; metric: string; previous: number; latest: number; change_pct: number; window: string }>;
  improving: Array<{ company: string; metric: string; change_pct: number; window: string }>;
  stale_or_missing: Array<{ company: string; metric: string; as_of_date: string; days_old: number; stale_after_days: number }>;
  support_asks: Array<{ id: string; canonical_name: string | null; request_type: string; urgency: string; description: string }>;
  follow_on_candidates: Array<{ id: string; label: string; option_type: string; canonical_name: string | null; capital: number }>;
  secondary_opportunities: Array<{ id: string; title: string; status: string; canonical_name: string | null }>;
  ownership_changes: Array<{ id: string; canonical_name: string | null; as_of_date: string; ownership_pct: number; source: string }>;
  changed_this_week: Array<{ event_type: string; object_type: string; object_id: string; created_at: string }>;
  definitions: Record<string, string>;
}

interface StrategyView {
  scenario: { id: string; name: string; status: string };
  comparison_run: { id: string; created_at: string } | null;
  options_by_type: Record<string, Array<{ id: string; label: string; capital: number; decision: string; canonical_name: string | null; result: { sleeve_fits: number; concentration_pct_after: number; concentration_within_limit: number; reserve_sufficient: number; breach_count: number } | null }>>;
  constraint_findings: Array<{ id: string; kind: string; severity: string; detail: string }>;
  assumptions: Array<{ assumption_key: string; assumption_value: string; basis: string }>;
  reserved_actions: Record<string, string>;
  statements: Record<string, string>;
}

function Panel({ title, testid, children }: { title: string; testid: string; children: React.ReactNode }) {
  return (
    <section className="module-card" data-testid={testid}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

export function CockpitPage({ me }: { me: MeResponse }) {
  const cockpit = useApi<Cockpit>("/api/portfolio/cockpit");
  const scenarios = useApi<{ scenarios: Array<{ id: string; name: string }> }>("/api/allocation/scenarios");
  const [scenarioId, setScenarioId] = useState<string>("");
  const strategy = useApi<StrategyView>(scenarioId ? `/api/allocation/scenarios/${scenarioId}/strategy-view` : null, [scenarioId]);

  if (cockpit.loading && !cockpit.data) return <p data-testid="cockpit-loading">Loading the cockpit…</p>;
  const c = cockpit.data;

  return (
    <section data-testid="cockpit-page">
      <p className="muted small">
        {me.fullName}: {c?.open_alert_count ?? 0} open portfolio alert(s). Everything below is read from the monitoring and
        allocation records the firm already holds — nothing is recomputed for display.
      </p>

      <div className="module-grid">
        <Panel title="Top risks" testid="cockpit-risks">
          <ul className="small">
            {(c?.top_risks ?? []).map((r) => (
              <li key={r.id}>
                <span className="badge badge-bad">{r.severity}</span> {r.canonical_name ?? r.company_id} — {r.alert_type}
                {r.metric_key ? ` (${r.metric_key})` : ""}
              </li>
            ))}
            {(c?.top_risks ?? []).length === 0 && <li className="state-empty">No open alerts.</li>}
          </ul>
        </Panel>

        <Panel title="Deteriorating" testid="cockpit-deteriorating">
          <ul className="small">
            {(c?.deteriorating ?? []).map((t) => (
              <li key={`${t.company}-${t.metric}`}>
                {t.company} · {t.metric}: {t.previous} → {t.latest} ({t.change_pct}%) <span className="muted">{t.window}</span>
              </li>
            ))}
            {(c?.deteriorating ?? []).length === 0 && <li className="state-empty">Nothing deteriorating period-over-period.</li>}
          </ul>
        </Panel>

        <Panel title="Improving" testid="cockpit-improving">
          <ul className="small">
            {(c?.improving ?? []).map((t) => (
              <li key={`${t.company}-${t.metric}`}>
                {t.company} · {t.metric} ({t.change_pct}%) <span className="muted">{t.window}</span>
              </li>
            ))}
            {(c?.improving ?? []).length === 0 && <li className="state-empty">Nothing improving period-over-period.</li>}
          </ul>
        </Panel>

        <Panel title="Stale or missing" testid="cockpit-stale">
          <ul className="small">
            {(c?.stale_or_missing ?? []).map((s) => (
              <li key={`${s.company}-${s.metric}`}>
                {s.company} · {s.metric} — {s.days_old} days old (rule: {s.stale_after_days})
              </li>
            ))}
            {(c?.stale_or_missing ?? []).length === 0 && <li className="state-empty">No metric is past its staleness rule.</li>}
          </ul>
        </Panel>

        <Panel title="Support asks" testid="cockpit-support">
          <ul className="small">
            {(c?.support_asks ?? []).map((s) => (
              <li key={s.id}>
                <span className="badge">{s.urgency}</span> {s.canonical_name} — {s.request_type}: {s.description}
              </li>
            ))}
            {(c?.support_asks ?? []).length === 0 && <li className="state-empty">No open support requests.</li>}
          </ul>
        </Panel>

        <Panel title="Follow-on candidates" testid="cockpit-followon">
          <ul className="small">
            {(c?.follow_on_candidates ?? []).map((f) => (
              <li key={f.id}>
                {f.canonical_name ?? f.label} — {f.option_type}, capital {f.capital}
              </li>
            ))}
            {(c?.follow_on_candidates ?? []).length === 0 && <li className="state-empty">No undecided follow-on or reserve options.</li>}
          </ul>
        </Panel>

        <Panel title="Secondary opportunities" testid="cockpit-secondaries">
          <ul className="small">
            {(c?.secondary_opportunities ?? []).map((s) => (
              <li key={s.id}>
                <code>{s.status}</code> {s.canonical_name} — {s.title}
              </li>
            ))}
            {(c?.secondary_opportunities ?? []).length === 0 && <li className="state-empty">No live secondary opportunities.</li>}
          </ul>
        </Panel>

        <Panel title="What changed this week" testid="cockpit-changed">
          <ul className="small">
            {(c?.changed_this_week ?? []).slice(0, 8).map((e, i) => (
              <li key={`${e.object_id}-${i}`}>
                <code>{e.event_type}</code>{" "}
                <span className="muted">{new Date(e.created_at).toLocaleString()}</span>
              </li>
            ))}
            {(c?.changed_this_week ?? []).length === 0 && <li className="state-empty">No portfolio events in the last 7 days.</li>}
          </ul>
        </Panel>
      </div>

      <section className="card" data-testid="cockpit-definitions">
        <h4>What these mean</h4>
        <ul className="small">
          {Object.entries(c?.definitions ?? {}).map(([k, v]) => (
            <li key={k}>
              <code>{k}</code> — {v}
            </li>
          ))}
        </ul>
      </section>

      <h3>Allocation decision view</h3>
      <div className="form-row">
        <label>
          Scenario{" "}
          <select data-testid="cockpit-scenario" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
            <option value="">(choose)</option>
            {(scenarios.data?.scenarios ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {strategy.data && (
        <section className="card" data-testid="strategy-view">
          <h4>
            {strategy.data.scenario.name} <span className="badge">{strategy.data.scenario.status}</span>
          </h4>
          <ul className="small muted" data-testid="strategy-statements">
            {Object.entries(strategy.data.statements).map(([k, v]) => (
              <li key={k}>{v}</li>
            ))}
          </ul>

          {Object.entries(strategy.data.options_by_type).map(([type, options]) => (
            <section key={type} data-testid={`strategy-type-${type}`}>
              <h4>
                {type} <span className="muted small">→ {strategy.data!.reserved_actions[type]}</span>
              </h4>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Option</th>
                      <th className="num">Capital</th>
                      <th>Sleeve fits</th>
                      <th className="num">Concentration after</th>
                      <th>Reserve sufficient</th>
                      <th className="num">Breaches</th>
                      <th>Decision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {options.map((o) => (
                      <tr key={o.id}>
                        <td>{o.canonical_name ?? o.label}</td>
                        <td className="num">{o.capital}</td>
                        <td>{o.result ? (o.result.sleeve_fits ? "yes" : "no") : "—"}</td>
                        <td className="num">{o.result ? `${o.result.concentration_pct_after}%${o.result.concentration_within_limit ? "" : " (over limit)"}` : "—"}</td>
                        <td>{o.result ? (o.result.reserve_sufficient ? "yes" : "no") : "—"}</td>
                        <td className="num">{o.result ? o.result.breach_count : "—"}</td>
                        <td>{o.decision}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}

          {strategy.data.assumptions.length > 0 && (
            <section data-testid="strategy-assumptions">
              <h4>Stated assumptions</h4>
              <ul className="small">
                {strategy.data.assumptions.map((a) => (
                  <li key={a.assumption_key}>
                    <code>{a.assumption_key}</code> = {a.assumption_value} — {a.basis}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {strategy.data.constraint_findings.length > 0 && (
            <section data-testid="strategy-findings">
              <h4>Constraint findings</h4>
              <ul className="small">
                {strategy.data.constraint_findings.map((v) => (
                  <li key={v.id}>
                    <span className={v.severity === "BREACH" ? "badge badge-bad" : "badge badge-gate"}>{v.severity}</span> {v.kind} —{" "}
                    {v.detail}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </section>
      )}
    </section>
  );
}
