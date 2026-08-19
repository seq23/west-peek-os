import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { PrivacyModePanel } from "./PrivacyModePanel";

/**
 * AI Operations — provider/model router + cost command center (P16; GAP-02, GAP-03).
 *
 * Every number on this page carries its provenance: pricing state, credential presence,
 * health mode, and the definition behind each cost total. Nothing here presents a
 * placeholder as a fact or a fixture as a live check.
 */

interface CatalogResponse {
  providers: Array<{
    id: string;
    provider_key: string;
    display_name: string;
    enabled: number;
    kill_switched: number;
    credential_name: string;
    credential_configured: boolean;
    allowed_data_classes: string[];
    latest_health: { mode: string; ok: number; detail: string; created_at: string } | null;
  }>;
  models: Array<{
    id: string;
    provider_key: string;
    model: string;
    display_name: string;
    context_window: number | null;
    supports_tools: number;
    supports_reasoning: number;
    max_data_class: string;
    pricing_state: string;
    pricing_source_note: string;
    status: string;
    input_per_mtok_usd: number | null;
    output_per_mtok_usd: number | null;
  }>;
  notes: Record<string, string>;
}

interface CostResponse {
  period: string;
  firm_policy: { cost_mode: string; privacy_mode: string; daily_cap_usd: number; per_run_cap_usd: number; spent_today_usd: number };
  totals: {
    committed_usd: number;
    runs: number;
    blocked_runs: number;
    estimate_only_runs: number;
    quarantined_runs: number;
    rework_cost_usd: number;
    forecast_period_usd: number;
  };
  by_employee: Array<{ key: string; committed_usd: number; runs: number; blocked: number }>;
  by_provider: Array<{ key: string; committed_usd: number; runs: number; blocked: number }>;
  by_model: Array<{ key: string; committed_usd: number; runs: number; blocked: number }>;
  by_machine: Array<{ key: string; committed_usd: number; runs: number; blocked: number }>;
  by_category: Array<{ key: string; committed_usd: number; runs: number; blocked: number }>;
  budgets: Array<{
    scope_type: string;
    scope_id: string;
    period: string;
    cap_usd: number;
    spent_usd: number;
    utilisation_pct: number | null;
    version_no: number;
    reason: string;
  }>;
  alerts: Array<{ id: string; scope_type: string; scope_id: string; severity: string; cap_usd: number; observed_usd: number; status: string }>;
  definitions: Record<string, string>;
}

interface RoutingPolicies {
  policies: Array<{ id: string; task_class: string; version_no: number; candidates_json: string; allow_fallback: number; notes: string }>;
  note: string;
}

function pricingBadge(state: string): string {
  if (state === "SOURCED") return "badge badge-ok";
  if (state === "STALE" || state === "UNKNOWN") return "badge badge-bad";
  return "badge badge-gate";
}

function SpendTable({ title, rows, testid }: { title: string; rows: Array<{ key: string; committed_usd: number; runs: number; blocked: number }>; testid: string }) {
  return (
    <section className="module-card" data-testid={testid}>
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p className="state-empty">Nothing recorded in this period.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th className="num">Committed</th>
                <th className="num">Runs</th>
                <th className="num">Blocked</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((r) => (
                <tr key={r.key}>
                  <td>{r.key}</td>
                  <td className="num">${r.committed_usd.toFixed(4)}</td>
                  <td className="num">{r.runs}</td>
                  <td className="num">{r.blocked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function AiOpsPage({ me }: { me: MeResponse }) {
  const catalog = useApi<CatalogResponse>("/api/ai/catalog");
  const [period, setPeriod] = useState("MONTHLY");
  const cost = useApi<CostResponse>(`/api/ai/cost?period=${period}`, [period]);
  const policies = useApi<RoutingPolicies>("/api/ai/routing-policies");
  const [message, setMessage] = useState<string | null>(null);

  const [scopeType, setScopeType] = useState("CATEGORY");
  const [scopeId, setScopeId] = useState("RESEARCH");
  const [budgetPeriod, setBudgetPeriod] = useState("MONTHLY");
  const [cap, setCap] = useState("25");
  const isMp = me.roles.includes("MANAGING_PARTNER");

  return (
    <section data-testid="ai-ops-page">
      {/* First on the page, because every number below it is meaningless while the firm is locked
          down — spend, routing and provider health all describe calls that never reach a model. */}
      <PrivacyModePanel me={me} />

      <h3>Providers</h3>
      {catalog.loading && !catalog.data && <p>Loading the catalogue…</p>}
      <ul className="card-list" data-testid="provider-catalog">
        {(catalog.data?.providers ?? []).map((p) => (
          <li key={p.id} className="card" data-testid={`catalog-provider-${p.provider_key}`}>
            <p>
              <strong>{p.display_name}</strong>{" "}
              <span className={p.enabled ? "badge badge-ok" : "badge"}>{p.enabled ? "ENABLED" : "DISABLED"}</span>{" "}
              {p.kill_switched === 1 && <span className="badge badge-bad">KILL-SWITCHED</span>}{" "}
              <span
                className={p.credential_configured ? "badge badge-ok" : "badge badge-gate"}
                data-testid={`catalog-credential-${p.provider_key}`}
              >
                {p.credential_configured ? `${p.credential_name} configured` : `${p.credential_name} not configured`}
              </span>
            </p>
            <p className="muted small">
              egress allowed for: {p.allowed_data_classes.length > 0 ? p.allowed_data_classes.join(", ") : "nothing (default deny)"}
            </p>
            {p.latest_health ? (
              <p className="muted small" data-testid={`catalog-health-${p.provider_key}`}>
                last check <code>{p.latest_health.mode}</code> — {p.latest_health.detail}
              </p>
            ) : (
              <p className="state-empty">no health check recorded</p>
            )}
            <button
              type="button"
              data-testid={`catalog-check-${p.provider_key}`}
              onClick={async () => {
                const res = await api<{ detail: string }>(`/api/ai/providers/${p.provider_key}/health-check`, { method: "POST" });
                setMessage(res.data?.detail ?? `Health check failed (HTTP ${res.status}).`);
                catalog.reload();
              }}
            >
              Run health check
            </button>
          </li>
        ))}
      </ul>
      {message && <p className="notice" data-testid="ai-ops-message">{message}</p>}
      {catalog.data?.notes && (
        <p className="muted small" data-testid="catalog-notes">
          {catalog.data.notes.credentials} {catalog.data.notes.health}
        </p>
      )}

      <h3>Model catalogue</h3>
      <p className="muted small">{catalog.data?.notes.pricing}</p>
      <div className="table-wrap">
        <table data-testid="model-catalog">
          <thead>
            <tr>
              <th>Model</th>
              <th>Provider</th>
              <th className="num">Context</th>
              <th>Tools / reasoning</th>
              <th>Max data class</th>
              <th className="num">Price (in/out per Mtok)</th>
              <th>Pricing state</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(catalog.data?.models ?? []).map((m) => (
              <tr key={m.id} data-testid={`model-row-${m.model}`}>
                <td>{m.display_name}</td>
                <td>{m.provider_key}</td>
                <td className="num">{m.context_window ?? "—"}</td>
                <td>
                  {m.supports_tools ? "tools" : "—"} / {m.supports_reasoning ? "reasoning" : "—"}
                </td>
                <td>{m.max_data_class}</td>
                <td className="num">
                  {m.input_per_mtok_usd !== null ? `$${m.input_per_mtok_usd} / $${m.output_per_mtok_usd}` : "unpriced"}
                </td>
                <td>
                  <span className={pricingBadge(m.pricing_state)} title={m.pricing_source_note}>
                    {m.pricing_state}
                  </span>
                </td>
                <td>{m.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Task routing</h3>
      <p className="muted small">{policies.data?.note}</p>
      <ul className="card-list small" data-testid="routing-policies">
        {(policies.data?.policies ?? []).map((p) => (
          <li key={p.id}>
            <code>{p.task_class}</code> v{p.version_no} —{" "}
            {(JSON.parse(p.candidates_json) as Array<{ provider_key: string; model: string }>)
              .map((c) => `${c.provider_key}/${c.model}`)
              .join(" → ")}{" "}
            {p.allow_fallback ? <span className="badge">fallback allowed</span> : <span className="badge badge-gate">no fallback</span>}
          </li>
        ))}
        {!policies.loading && (policies.data?.policies ?? []).length === 0 && (
          <li className="state-empty">No routing policies. Every task uses the default: cheapest priced capable model, one attempt.</li>
        )}
      </ul>

      <h3>Spend</h3>
      <div className="form-row">
        <label>
          Period{" "}
          <select data-testid="cost-period" value={period} onChange={(e) => setPeriod(e.target.value)}>
            {["DAILY", "WEEKLY", "MONTHLY"].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>
      {cost.data && (
        <>
          <section className="card" data-testid="cost-totals">
            <p>
              <strong>${cost.data.totals.committed_usd.toFixed(4)}</strong> committed this {cost.data.period.toLowerCase()} across{" "}
              {cost.data.totals.runs} run(s) · {cost.data.totals.blocked_runs} blocked · forecast $
              {cost.data.totals.forecast_period_usd.toFixed(4)}
            </p>
            <p className="muted small">
              {cost.data.totals.estimate_only_runs} run(s) have no provider-reported cost, so that part of the total is an
              estimate. Rework cost (completed but never accepted): ${cost.data.totals.rework_cost_usd.toFixed(4)} across{" "}
              {cost.data.totals.quarantined_runs} quarantined output(s).
            </p>
            <p className="muted small">
              Firm policy: {cost.data.firm_policy.cost_mode} / {cost.data.firm_policy.privacy_mode} · today $
              {cost.data.firm_policy.spent_today_usd.toFixed(4)} of ${cost.data.firm_policy.daily_cap_usd}
            </p>
          </section>

          <div className="module-grid">
            <SpendTable title="By employee" rows={cost.data.by_employee} testid="spend-by-employee" />
            <SpendTable title="By provider" rows={cost.data.by_provider} testid="spend-by-provider" />
            <SpendTable title="By model" rows={cost.data.by_model} testid="spend-by-model" />
            <SpendTable title="By machine" rows={cost.data.by_machine} testid="spend-by-machine" />
            <SpendTable title="By category" rows={cost.data.by_category} testid="spend-by-category" />
          </div>

          <h3>Budgets</h3>
          <ul className="card-list small" data-testid="budget-list">
            {cost.data.budgets.map((b) => (
              <li key={`${b.scope_type}-${b.scope_id}-${b.period}`}>
                <code>
                  {b.scope_type}:{b.scope_id}
                </code>{" "}
                {b.period} — ${b.spent_usd.toFixed(4)} of ${b.cap_usd}
                {b.utilisation_pct !== null ? ` (${b.utilisation_pct}%)` : ""} · v{b.version_no} · {b.reason}
              </li>
            ))}
            {cost.data.budgets.length === 0 && <li className="state-empty">No scoped budgets. Only the firmwide caps apply.</li>}
          </ul>

          {isMp && (
            <form
              className="form-row"
              data-testid="budget-form"
              onSubmit={async (e) => {
                e.preventDefault();
                const res = await api<{ version_no?: number; error?: string; detail?: string }>("/api/ai/budgets", {
                  method: "POST",
                  body: {
                    scope_type: scopeType,
                    scope_id: scopeId,
                    period: budgetPeriod,
                    cap_usd: Number(cap),
                    reason: `set from the cost centre by ${me.fullName}`,
                  },
                });
                setMessage(
                  res.status === 201
                    ? `Budget saved as version ${res.data?.version_no}. Previous versions are preserved.`
                    : `Refused: ${res.data?.detail ?? res.data?.error ?? res.status}`,
                );
                cost.reload();
              }}
            >
              <select data-testid="budget-scope-type" value={scopeType} onChange={(e) => setScopeType(e.target.value)}>
                {["FIRM", "EMPLOYEE", "MACHINE", "PROVIDER", "MODEL", "CATEGORY"].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <input data-testid="budget-scope-id" value={scopeId} onChange={(e) => setScopeId(e.target.value)} placeholder="scope id" />
              <select data-testid="budget-period" value={budgetPeriod} onChange={(e) => setBudgetPeriod(e.target.value)}>
                {["DAILY", "WEEKLY", "MONTHLY"].map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <input data-testid="budget-cap" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="cap USD" />
              <button type="submit" className="btn-strong" data-testid="budget-submit">
                Set budget
              </button>
            </form>
          )}

          <h3>Cost alerts</h3>
          <ul className="card-list small" data-testid="cost-alerts">
            {cost.data.alerts.map((a) => (
              <li key={a.id}>
                <span className={a.severity === "BREACH" ? "badge badge-bad" : "badge badge-gate"}>{a.severity}</span>{" "}
                {a.scope_type}:{a.scope_id} — ${a.observed_usd.toFixed(4)} against ${a.cap_usd}{" "}
                <button
                  type="button"
                  className="link-button"
                  data-testid={`alert-ack-${a.id}`}
                  onClick={async () => {
                    await api(`/api/ai/cost-alerts/${a.id}/acknowledge`, { method: "POST" });
                    cost.reload();
                  }}
                >
                  Acknowledge
                </button>
              </li>
            ))}
            {cost.data.alerts.length === 0 && <li className="state-empty">No open cost alerts.</li>}
          </ul>

          <section className="card" data-testid="cost-definitions">
            <h4>What these numbers mean</h4>
            <ul className="small">
              {Object.entries(cost.data.definitions).map(([k, v]) => (
                <li key={k}>
                  <code>{k}</code> — {v}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </section>
  );
}
