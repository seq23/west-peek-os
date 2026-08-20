import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { SPEND_POSTURES, postureDef, postureFor } from "@shared/ai/spendPosture";
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
  firm_policy: { cost_mode: string; privacy_mode: string; daily_cap_usd: number; per_run_cap_usd: number; spent_today_usd: number; honours_pins: boolean };
  all_time: {
    spent_usd: number; model_spent_usd: number; vendor_spent_usd: number;
    runs: number; since: string | null; unpriced_vendor_calls: number;
  };
  by_vendor: Array<{ vendor: string; spent_usd: number; calls: number; unpriced: number; since: string }>;
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
          {/* WHAT IT HAS COST, EVER. The page reported a period, which answers "are we on track this
              month" — not "what has this cost us", which is the question somebody asks first and
              had no answer anywhere. */}
          {/*
            THE LEVER, AND IT NOW DOES SOMETHING.

            There has always been a `cost_mode`, and dragging it changed nothing: the cheapest
            registered model was $0.075 per million tokens, and the only two things that actually
            run — the morning brief and employee work — are both PINNED by routing policy, and a pin
            beat cost mode outright.

            Both are fixed. Cloudflare's open models are now in the catalogue at roughly a fortieth
            of the frontier rate, free inside the daily allowance; and the cheapest posture is
            allowed to override a pin, on the record, with the consequence stated rather than
            discovered in a thin brief.
          */}
          {isMp && (
            <section className="card spend-lever" data-testid="spend-posture">
              <div className="home-section-head">
                <h3>How much to spend</h3>
                <span className="muted small">applies to everything the firm runs</span>
              </div>
              <ul className="posture-list">
                {SPEND_POSTURES.map((p) => {
                  const current =
                    postureFor(cost.data!.firm_policy.cost_mode, cost.data!.firm_policy.honours_pins) === p.key;
                  return (
                    <li key={p.key} className={current ? "posture is-current" : "posture"}>
                      <button
                        type="button"
                        className="posture-pick"
                        aria-pressed={current}
                        data-testid={`posture-${p.key}`}
                        onClick={async () => {
                          const res = await api<{ error?: string; detail?: string }>("/api/ai/budget", {
                            method: "POST",
                            body: {
                              cost_mode: p.costMode,
                              privacy_mode: cost.data!.firm_policy.privacy_mode,
                              daily_cap_usd: cost.data!.firm_policy.daily_cap_usd,
                              per_run_cap_usd: cost.data!.firm_policy.per_run_cap_usd,
                              honours_pins: p.honoursPins,
                            },
                          });
                          setMessage(
                            res.status === 201 || res.status === 200
                              ? `Now on “${p.label}”. ${p.tradeoff}`
                              : `Refused: ${res.data?.detail ?? res.data?.error ?? res.status}`,
                          );
                          cost.reload();
                        }}
                      >
                        <span className="posture-label">
                          {p.label}
                          {current && <span className="badge badge-ok">current</span>}
                        </span>
                        <span className="small">{p.what}</span>
                        <span className="muted small">{p.cost}</span>
                        {/* THE DOWNSIDE, ON THE CONTROL. Every one of these has one, and a lever
                            that only advertises its upside is how the brief got quietly wrecked
                            the first time. */}
                        <span className="muted small posture-tradeoff">{p.tradeoff}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section className="card cost-alltime" data-testid="cost-all-time">
            <div>
              <span className="cost-alltime-figure">${cost.data.all_time.spent_usd.toFixed(2)}</span>
              <span className="muted small"> spent by the firm, all time</span>
            </div>
            <p className="muted small">
              Across {cost.data.all_time.runs} completed run{cost.data.all_time.runs === 1 ? "" : "s"}
              {cost.data.all_time.since ? ` since ${cost.data.all_time.since.slice(0, 10)}` : ""}. Runs
              completed before cost recording was corrected on 19 Aug 2026 stored zero, so the true
              figure is a little higher than this.
            </p>

            {/* THE TOTAL IS TWO LEDGERS. Model work goes through the AI boundary and is summed from
                its runs; anything bought outside it — image generation — is summed separately and
                added here. Split out rather than merged silently, because "what did the models
                cost" and "what did the firm spend" are different questions. */}
            {cost.data.all_time.vendor_spent_usd > 0 && (
              <p className="muted small" data-testid="cost-vendor-split">
                ${cost.data.all_time.model_spent_usd.toFixed(2)} on models · $
                {cost.data.all_time.vendor_spent_usd.toFixed(2)} with other vendors
                {(cost.data.by_vendor ?? []).length > 0 &&
                  ` (${cost.data.by_vendor.map((v) => `${v.vendor}: ${v.calls}`).join(", ")})`}
              </p>
            )}
            {cost.data.all_time.unpriced_vendor_calls > 0 && (
              <p className="muted small">
                {cost.data.all_time.unpriced_vendor_calls} vendor call
                {cost.data.all_time.unpriced_vendor_calls === 1 ? "" : "s"} came back without a price.
                That is real money of an unknown amount, counted here as unpriced rather than as zero.
              </p>
            )}
          </section>

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
              Firm policy: {postureDef(postureFor(cost.data.firm_policy.cost_mode, cost.data.firm_policy.honours_pins)).label}
              {" / "}{cost.data.firm_policy.privacy_mode} · today $
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
            {/* SET, AND THEN STUCK. A budget could be created and never changed or removed from
                here — the operator's report, and accurate. The server has always supported both:
                re-publishing the same scope writes a new version, and `active: false` retires one.
                Neither was reachable, so a cap typed wrong was permanent.

                Amending pre-fills the form below rather than editing in place, because a budget is
                a versioned policy: you are writing the next version, not correcting the last one,
                and the old one stays readable. */}
            {cost.data.budgets.map((b) => (
              <li key={`${b.scope_type}-${b.scope_id}-${b.period}`}>
                <code>
                  {b.scope_type}:{b.scope_id}
                </code>{" "}
                {b.period} — ${b.spent_usd.toFixed(4)} of ${b.cap_usd}
                {b.utilisation_pct !== null ? ` (${b.utilisation_pct}%)` : ""} · v{b.version_no} · {b.reason}
                {isMp && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="link-button"
                      data-testid={`budget-amend-${b.scope_type}-${b.scope_id}`}
                      onClick={() => {
                        setScopeType(b.scope_type);
                        setScopeId(b.scope_id);
                        setBudgetPeriod(b.period);
                        setCap(String(b.cap_usd));
                        setMessage(`Amending ${b.scope_type}:${b.scope_id}. Change the cap below and save — it becomes version ${b.version_no + 1}.`);
                      }}
                    >
                      change the cap
                    </button>
                    {" · "}
                    <button
                      type="button"
                      className="link-button"
                      data-testid={`budget-retire-${b.scope_type}-${b.scope_id}`}
                      title="Stops this cap applying. The versions stay on the record."
                      onClick={async () => {
                        const res = await api<{ version_no?: number; error?: string; detail?: string }>("/api/ai/budgets", {
                          method: "POST",
                          body: {
                            scope_type: b.scope_type,
                            scope_id: b.scope_id,
                            period: b.period,
                            cap_usd: b.cap_usd,
                            active: false,
                            reason: `retired from the cost centre by ${me.fullName}`,
                          },
                        });
                        setMessage(
                          res.status === 201
                            ? `${b.scope_type}:${b.scope_id} no longer applies. Every version it had is still on the record.`
                            : `Refused: ${res.data?.detail ?? res.data?.error ?? res.status}`,
                        );
                        cost.reload();
                      }}
                    >
                      stop applying it
                    </button>
                  </>
                )}
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
              <select data-testid="budget-scope-type" aria-label="What kind of thing this cap applies to" value={scopeType} onChange={(e) => setScopeType(e.target.value)}>
                {["FIRM", "EMPLOYEE", "MACHINE", "PROVIDER", "MODEL", "CATEGORY"].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <input data-testid="budget-scope-id" aria-label="Which employee, machine or model this cap applies to" value={scopeId} onChange={(e) => setScopeId(e.target.value)} placeholder="scope id" />
              <select data-testid="budget-period" aria-label="How often the cap resets" value={budgetPeriod} onChange={(e) => setBudgetPeriod(e.target.value)}>
                {["DAILY", "WEEKLY", "MONTHLY"].map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <input data-testid="budget-cap" aria-label="Spending cap in dollars" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="cap USD" />
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
