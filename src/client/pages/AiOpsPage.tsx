import { useState } from "react";
import { readableDate, shortDate } from "../lib/dates";
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

interface FirmBudgetState {
  budget_window: "MONTHLY" | "ALL_TIME";
  cap_usd: number | null;
  spent_usd: number;
  remaining_usd: number | null;
  used_pct: number | null;
  version_no: number | null;
  reason: string | null;
  set_by: string | null;
  set_at: string | null;
}

interface QuarantineResponse {
  waiting: Array<{
    id: string;
    what_it_was_for: string;
    who: string | null;
    model: string | null;
    provider: string | null;
    created_at: string;
    cost_usd: number;
    preview: string | null;
    truncated: boolean;
  }>;
  waiting_count: number;
  listed_count: number;
  what_this_is: string;
}

interface CostResponse {
  period: string;
  firm_budgets: FirmBudgetState[];
  firm_policy: {
    cost_mode: string;
    privacy_mode: string;
    daily_cap_usd: number;
    per_run_cap_usd: number;
    spent_today_usd: number;
    honours_pins: boolean;
    prefers_frontier: boolean;
  };
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

/**
 * A spend breakdown, with the row keys read as what they are.
 *
 * The employee table printed `aie_wyatt` — a database id on the page where a partner is deciding
 * whether the firm is spending too much on somebody. `label` turns the id into a name where one is
 * knowable and leaves everything else alone, so provider and model rows (which really are keys, and
 * are what you would search for) are untouched.
 */
function spendRowLabel(key: string | null): string {
  if (!key) return "unattributed";
  const m = /^aie_(.+)$/.exec(key);
  if (!m) return key;
  return m[1]!.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
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
                <th>Who or what</th>
                <th className="num">Committed</th>
                <th className="num">Runs</th>
                <th className="num">Blocked</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((r) => (
                <tr key={r.key}>
                  <td>{spendRowLabel(r.key)}</td>
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

/** Plain-English names for the server's definition keys. Anything unmapped falls back to the key. */
const DEFINITION_LABELS: Record<string, string> = {
  committed: "What counts as spent",
  estimate_only_runs: "Runs the provider never priced",
  rework_cost_usd: "Work paid for and never used",
  forecast_period_usd: "The rate this stretch is running at",
  value: "What is not measured here",
};

const BUDGET_WINDOW_COPY: Record<FirmBudgetState["budget_window"], { heading: string; blurb: string }> = {
  MONTHLY: {
    heading: "Most it may spend in a month",
    blurb: "Resets on the first of each month. Work is refused once the month's spending would go past it.",
  },
  ALL_TIME: {
    heading: "Most it may ever spend",
    blurb: "Does not reset. This is the total the firm is prepared to put into AI, from the first run to the last.",
  },
};

/**
 * One firmwide ceiling: what it is, what has gone against it, and how to change it.
 *
 * DETERMINISTIC AND ADJUSTABLE, which is the operator's phrasing and both halves matter. The figure
 * shown is the same one the boundary refuses runs against — not a second calculation that agrees by
 * coincidence — and it is typed in and saved here rather than being a constant somebody has to
 * deploy. Every version is kept, so a cap can always be read back to who set it and why.
 */
function FirmBudgetControl({
  state,
  canEdit,
  fullName,
  onSaved,
}: {
  state: FirmBudgetState;
  canEdit: boolean;
  fullName: string;
  onSaved: (message: string) => void;
}) {
  const copy = BUDGET_WINDOW_COPY[state.budget_window];
  const [draft, setDraft] = useState(state.cap_usd === null ? "" : state.cap_usd.toFixed(2));
  const [busy, setBusy] = useState(false);

  return (
    <section className="module-card" data-testid={`firm-budget-${state.budget_window}`}>
      <h4>{copy.heading}</h4>
      <p className="muted small">{copy.blurb}</p>
      {state.cap_usd === null ? (
        // NOTHING IS INVENTED. A default ceiling nobody chose would read as protection while being
        // an arbitrary number, so the absence is stated in words instead.
        <p className="state-empty" data-testid={`firm-budget-none-${state.budget_window}`}>
          No limit set, so nothing stops the spending here. ${state.spent_usd.toFixed(2)} has gone{" "}
          {state.budget_window === "MONTHLY" ? "this month" : "in total"} so far.
        </p>
      ) : (
        <>
          <p>
            <strong data-testid={`firm-budget-cap-${state.budget_window}`}>${state.cap_usd.toFixed(2)}</strong> is the limit ·{" "}
            <strong>${state.spent_usd.toFixed(2)}</strong> spent
            {state.remaining_usd !== null && (
              <>
                {" "}· <strong>${Math.max(0, state.remaining_usd).toFixed(2)}</strong> left
              </>
            )}
            {state.used_pct !== null ? ` (${state.used_pct}% used)` : ""}
          </p>
          {state.used_pct !== null && state.used_pct >= 80 && (
            <p className="notice notice-gate" data-testid={`firm-budget-warn-${state.budget_window}`}>
              Close to the limit. When it is reached, work stops being sent to a model and each refusal says which limit
              stopped it.
            </p>
          )}
          <p className="muted small">
            Set by {state.set_by ?? "somebody"}
            {state.set_at ? ` on ${readableDate(state.set_at)}` : ""} · version {state.version_no} ·{" "}
            {state.reason}
          </p>
        </>
      )}
      {canEdit && (
        <form
          className="form-row"
          data-testid={`firm-budget-form-${state.budget_window}`}
          onSubmit={async (e) => {
            e.preventDefault();
            const dollars = Number(draft);
            if (!Number.isFinite(dollars) || dollars < 0) {
              onSaved(`“${draft}” is not an amount of money. Type a number of dollars, such as 40.`);
              return;
            }
            setBusy(true);
            const res = await api<{ error?: string; detail?: string }>("/api/ai/firm-budget", {
              method: "POST",
              body: {
                budget_window: state.budget_window,
                // CENTS ON THE WIRE. The ceiling is stored as a whole number of cents, so the
                // rounding happens here, once, in front of the person who typed the figure.
                cap_cents: Math.round(dollars * 100),
                reason: `set on the Cockpit by ${fullName}`,
              },
            });
            setBusy(false);
            onSaved(
              res.status === 201
                ? `Saved. ${copy.heading.toLowerCase()} is now $${dollars.toFixed(2)}, and it applies from the next piece of work.`
                : // The real reason, never a generic one — the server refuses a ceiling below what
                  // has already been spent and says both figures.
                  `Not saved: ${res.data?.detail ?? res.data?.error ?? `the server answered ${res.status}`}`,
            );
          }}
        >
          <label>
            Dollars
            <input
              data-testid={`firm-budget-input-${state.budget_window}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. 40"
            />
          </label>
          <button type="submit" className="btn-strong" disabled={busy} data-testid={`firm-budget-save-${state.budget_window}`}>
            {state.cap_usd === null ? "Set the limit" : "Change the limit"}
          </button>
        </form>
      )}
    </section>
  );
}

/**
 * Work the models finished that nobody has looked at.
 *
 * WHY THIS EXISTS AT ALL. 51 outputs were sitting here on the deployed system and there was no
 * button to accept one — the route had existed since P4 with no caller — and no way at all to
 * refuse one. A queue with no exit only grows, and every row in it is counted against the firm as
 * work paid for twice.
 *
 * Two exits, and they are genuinely different acts. "Use it" releases the text into the rest of the
 * system. "Throw it away" never does, and asks why, because a queue emptied without reasons
 * teaches nobody anything and the same bad work gets commissioned again next week.
 */
function QuarantineQueue({ onMessage }: { onMessage: (m: string) => void }) {
  const queue = useApi<QuarantineResponse>("/api/ai/quarantine");
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [bulkReason, setBulkReason] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);

  const decide = async (id: string, path: string, body: unknown, ok: string) => {
    const res = await api<{ error?: string; detail?: string }>(`/api/ai/runs/${id}/${path}`, { method: "POST", body });
    onMessage(
      res.status === 200
        ? ok
        : `Nothing changed: ${res.data?.detail ?? res.data?.error ?? `the server answered ${res.status}`}`,
    );
    setDiscarding(null);
    setReason("");
    queue.reload();
  };

  return (
    <section data-testid="quarantine-queue">
      <div className="home-section-head">
        <h3>What is waiting for somebody to look at it?</h3>
        <span className="muted small">
          {queue.data ? `${queue.data.waiting_count} waiting` : queue.loading ? "counting…" : ""}
        </span>
      </div>
      <p className="muted small">{queue.data?.what_this_is}</p>

      {/*
        THROW THE WHOLE QUEUE AWAY. Operator, 22 Aug 2026: "we need a throw all away option."
        Fifty-one items nobody is going to review one at a time is a queue that sits there, and a
        queue that sits there teaches a partner to stop looking at queues.

        Behind a disclosure and requiring a reason, because it is the one control here that acts on
        everything at once — not to make it hard, but so it cannot be the thing your hand lands on
        while reaching for a single item. The reason covers the batch: asking fifty-one times would
        guarantee it was answered without thought.

        Nothing is released. Discarding is a tombstone exactly as it is for one item — refused output
        stays refused, and "why did we throw that away" stays answerable.
      */}
      {(queue.data?.waiting_count ?? 0) > 0 && (
        <details className="delegate" data-testid="quarantine-discard-all">
          <summary>Throw all {queue.data!.waiting_count} of these away…</summary>
          <div className="delegate-body">
            <label>
              Why
              <input
                data-testid="quarantine-discard-all-reason"
                aria-label="Why the whole queue is being thrown away"
                placeholder="so the next person knows what was wrong with it"
                value={bulkReason}
                onChange={(e) => setBulkReason(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn-strong"
              disabled={bulkReason.trim().length < 4 || bulkBusy}
              data-testid="quarantine-discard-all-submit"
              onClick={async () => {
                setBulkBusy(true);
                const res = await api<{ discarded?: number; failed?: Array<{ id: string }>; detail?: string }>(
                  "/api/ai/quarantine/discard-all",
                  { method: "POST", body: { reason: bulkReason.trim() } },
                );
                setBulkBusy(false);
                onMessage(
                  res.status === 200
                    ? `${res.data?.discarded ?? 0} thrown away.${
                        res.data?.failed?.length
                          ? ` ${res.data.failed.length} could not be — they are still in the list.`
                          : ""
                      }`
                    : `Nothing changed: ${res.data?.detail ?? `the server answered ${res.status}`}`,
                );
                setBulkReason("");
                queue.reload();
              }}
            >
              {bulkBusy ? "Throwing away…" : "Throw them all away"}
            </button>
            <p className="muted small">
              The text is never released — each one is recorded as thrown away, with this reason and
              your name, exactly as if you had done them one at a time.
            </p>
          </div>
        </details>
      )}

      <ul className="card-list small" data-testid="quarantine-list">
        {(queue.data?.waiting ?? []).map((r) => (
          <li key={r.id} data-testid={`quarantine-item-${r.id}`}>
            <p>
              <strong>{r.what_it_was_for}</strong>{" "}
              <span className="muted small">
                {r.who ? `${r.who} · ` : ""}
                {r.model ?? "unknown model"} · {shortDate(r.created_at)} · cost ${r.cost_usd.toFixed(4)}
              </span>
            </p>
            {r.preview ? (
              <p className="small">
                {r.preview}
                {r.truncated ? "…" : ""}
              </p>
            ) : (
              <p className="state-empty">This run finished without producing any text.</p>
            )}
            {discarding === r.id ? (
                <div className="form-row">
                  <label>
                    Why are you throwing it away?
                    <input
                      data-testid={`quarantine-reason-${r.id}`}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="e.g. it answered the wrong question"
                    />
                  </label>
                  <button
                    type="button"
                    className="btn-strong"
                    data-testid={`quarantine-discard-confirm-${r.id}`}
                    onClick={() => {
                      if (reason.trim().length === 0) {
                        onMessage("Say why first. A discarded output with no reason tells the next person nothing.");
                        return;
                      }
                      void decide(r.id, "discard-output", { reason }, "Thrown away. It will never be used, and the reason is on the record.");
                    }}
                  >
                    Throw it away
                  </button>
                  <button type="button" className="link-button" onClick={() => setDiscarding(null)}>
                    Keep it for now
                  </button>
                </div>
              ) : (
                <p>
                  <button
                    type="button"
                    className="btn-strong"
                    data-testid={`quarantine-accept-${r.id}`}
                    onClick={() => void decide(r.id, "accept-output", {}, "Accepted. The rest of the system can use it now.")}
                  >
                    Use it
                  </button>{" "}
                  <button
                    type="button"
                    className="link-button"
                    data-testid={`quarantine-discard-${r.id}`}
                    onClick={() => {
                      setDiscarding(r.id);
                      setReason("");
                    }}
                  >
                    Throw it away
                  </button>
                </p>
              )}
          </li>
        ))}
        {!queue.loading && (queue.data?.waiting ?? []).length === 0 && (
          <li className="state-empty">Nothing is waiting. Everything the models finished has been decided about.</li>
        )}
      </ul>
      {queue.data && queue.data.waiting_count > queue.data.listed_count && (
        <p className="muted small">
          Showing the {queue.data.listed_count} oldest of {queue.data.waiting_count}. Decide about these and the next
          ones appear.
        </p>
      )}
      {/* Deliberately not gated on role in the client. Anybody who can SEE a row can decide about
          it — the privacy rules already decide what a given reader sees — and if authorize() does
          refuse, the refusal above says the real reason rather than a hidden button implying one. */}
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
        {catalog.loading && <li className="state-message" data-testid="provider-catalog-loading">Loading…</li>}
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
        {policies.loading && <li className="state-message" data-testid="routing-policies-loading">Loading…</li>}
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

      <h3>What is this costing us?</h3>
      {/* ONE DEFINITION, PRINTED ONCE, ABOVE EVERY FIGURE THAT USES IT. The operator found three
          places answering this question with three different numbers under the same word. The
          sentence below comes from the server, from the same module the figures are summed in, so
          the page cannot drift from the arithmetic by rewording it. */}
      <p className="muted small" data-testid="spend-definition">
        {cost.data?.definitions.committed}
      </p>
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
                    postureFor(
                      cost.data!.firm_policy.cost_mode,
                      cost.data!.firm_policy.honours_pins,
                      cost.data!.firm_policy.prefers_frontier,
                    ) === p.key;
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
                              // The bit that makes "Best available" a different setting rather than
                              // a second button that writes the Balanced policy.
                              prefers_frontier: p.prefersFrontier,
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

          {/* THE TWO BLOCKS, AND WHY THERE ARE TWO. The operator asked what the two adjacent spend
              figures were, which is the correct question: they sat one above the other, both large,
              both labelled with a dollar sign, and nothing said they were not the same thing
              measured twice. They are two different questions and the headings now ask them. */}
          <p className="muted small" data-testid="cost-two-blocks">
            The two figures below are not the same number. The first is everything spent since the
            system started running; the second is only the stretch you picked above, which is what
            tells you whether this month is on track. They count the same things — the sentence at
            the top of this section is the definition both use.
          </p>

          <section className="card cost-alltime" data-testid="cost-all-time">
            <h4>What has it cost us, ever?</h4>
            <div>
              <span className="cost-alltime-figure">${cost.data.all_time.spent_usd.toFixed(2)}</span>
              <span className="muted small"> spent by the firm since the first run</span>
            </div>
            <p className="muted small">
              Across {cost.data.all_time.runs} run{cost.data.all_time.runs === 1 ? "" : "s"} that reached a model
              {cost.data.all_time.since ? `, starting ${readableDate(cost.data.all_time.since)}` : ""}. Runs
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
            <h4>
              And what has it cost{" "}
              {cost.data.period === "DAILY" ? "today" : cost.data.period === "WEEKLY" ? "this week" : "this month"}?
            </h4>
            <p>
              <strong>${cost.data.totals.committed_usd.toFixed(4)}</strong> so far, across {cost.data.totals.runs} run
              {cost.data.totals.runs === 1 ? "" : "s"}. {cost.data.totals.blocked_runs} more{" "}
              {cost.data.totals.blocked_runs === 1 ? "was" : "were"} refused before reaching a model and cost nothing. At
              this rate the whole stretch comes to ${cost.data.totals.forecast_period_usd.toFixed(4)} — a projection from
              how much of it has elapsed, not a prediction of what the firm will decide to do.
            </p>
            <p className="muted small">
              {cost.data.totals.estimate_only_runs} run{cost.data.totals.estimate_only_runs === 1 ? "" : "s"} came back
              with no price from the provider, so that part of this figure is our own estimate rather than an invoice.
              ${cost.data.totals.rework_cost_usd.toFixed(4)} of it went on {cost.data.totals.quarantined_runs} finished
              piece{cost.data.totals.quarantined_runs === 1 ? "" : "s"} of work nobody has looked at — money already
              spent that has produced nothing until somebody decides about it, below.
            </p>
            <p className="muted small">
              Currently on{" "}
              {
                postureDef(
                  postureFor(
                    cost.data.firm_policy.cost_mode,
                    cost.data.firm_policy.honours_pins,
                    cost.data.firm_policy.prefers_frontier,
                  ),
                ).label
              }
              {", privacy "}
              {cost.data.firm_policy.privacy_mode.toLowerCase()} · today ${cost.data.firm_policy.spent_today_usd.toFixed(4)}{" "}
              of a ${cost.data.firm_policy.daily_cap_usd} daily limit
            </p>
          </section>

          {/* THE FIRMWIDE CEILING. Item 23: "i need to be able to set a firmwide budget very easily
              and have it change, show up and persist". Directly under the two figures it governs,
              because a ceiling read on a different screen from the spending is a ceiling nobody
              checks. Both windows are shown even when unset — an absent limit is a fact. */}
          <div className="home-section-head">
            <h3>How much are we willing to spend?</h3>
            <span className="muted small">{isMp ? "you can change these" : "set by a Managing Partner"}</span>
          </div>
          <p className="muted small">
            These bind. When one is reached the system stops sending work to a model and every refusal names the limit
            that stopped it — so a number typed here is not a display, it is the thing that says no.
          </p>
          <div className="module-grid" data-testid="firm-budgets">
            {cost.data.firm_budgets.map((b) => (
              <FirmBudgetControl
                key={b.budget_window}
                state={b}
                canEdit={isMp}
                fullName={me.fullName}
                onSaved={(m) => {
                  setMessage(m);
                  cost.reload();
                }}
              />
            ))}
          </div>

          <div className="module-grid">
            <SpendTable title="By employee" rows={cost.data.by_employee} testid="spend-by-employee" />
            <SpendTable title="By provider" rows={cost.data.by_provider} testid="spend-by-provider" />
            <SpendTable title="By model" rows={cost.data.by_model} testid="spend-by-model" />
            <SpendTable title="By machine" rows={cost.data.by_machine} testid="spend-by-machine" />
            <SpendTable title="By category" rows={cost.data.by_category} testid="spend-by-category" />
          </div>

          {/* Distinct from the firmwide ceiling above, and the heading has to say so or the page has
              two things called "budget" again — which is the shape of the bug this item exists for. */}
          <h3>Is anyone in particular spending too much?</h3>
          <p className="muted small">
            Limits on one employee, machine, provider, model or kind of work. These sit underneath the firmwide limits:
            work has to be inside every limit that covers it.
          </p>
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

          {/* The quarantine sits inside the spend section on purpose: its rows ARE the rework cost
              named two blocks above, and a partner who has just read "money already spent that has
              produced nothing" should find the thing that resolves it without going anywhere. */}
          <QuarantineQueue onMessage={(m) => { setMessage(m); cost.reload(); }} />

          <h3>Has anything gone past a limit?</h3>
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
            <h4>What exactly is being counted?</h4>
            {/* THE KEY NAMES WERE ON SCREEN. This list printed `rework_cost_usd` and
                `estimate_only_runs` in a code tag to a partner reading a spend page. The
                definitions themselves are worth keeping and were the only honest thing about it;
                the labels are now the words the rest of the page uses. */}
            <ul className="small">
              {Object.entries(cost.data.definitions).map(([k, v]) => (
                <li key={k}>
                  <strong>{DEFINITION_LABELS[k] ?? k}</strong> — {v}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </section>
  );
}
