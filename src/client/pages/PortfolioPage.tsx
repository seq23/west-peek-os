import { useState } from "react";
import { api, mutationError, useApi, type MeResponse } from "../lib/api";
import { useSelectedFund } from "../lib/selectedFund";
import { Composition } from "./FundAllocation";
import { PortfolioAllocation } from "./PortfolioAllocation";

/**
 * Portfolio — the companies the fund owns, and what is happening to them.
 *
 * WHAT WAS WRONG, and the operator said it plainly about a different page: "i dont understand why it
 * cant be simple like the lp page. everything is there and its easy to follow." This page opened
 * with a form headed "Define metric (operator bands)" carrying fields called `metric_key` and
 * `as_of_date`. Nobody arrives at Portfolio wanting to define a metric. They arrive wanting to know
 * what the fund owns and whether any of it is in trouble.
 *
 * SO IT IS ORDERED THE WAY THE LP PAGE IS: a flat sequence of questions somebody actually asks, the
 * answers first, and each form placed directly after the answer it feeds. What we own → what it is
 * worth (and the form that says so) → what is going wrong → which way things are moving → who we
 * have not heard from → who asked for help → record what a company reported.
 *
 * TWO SUB-TABS, BECAUSE THEY ARE TWO JOBS (item 12). Monitoring is standing over the portfolio day
 * to day. Reporting is what the companies themselves sent in, and how a month reads against the last
 * one. Same records underneath; different question, different hour of the week.
 *
 * THE MOVEMENT FIGURES ARE THE COCKPIT'S OWN. Deteriorating, improving and stale are read from
 * `/api/portfolio/cockpit` rather than recomputed here. A second implementation of "is this getting
 * worse" is how two surfaces end up disagreeing about the same company, which this repo has already
 * paid for once.
 *
 * WHAT WE OWN IS ONE LIST, 18 Sep 2026. "What we own" used to be counted from booked positions
 * alone, and the firm's only investment — Sensori, a $10K SPV that closed before Fund I existed —
 * has no position, because a position is booked only by executing a transaction and a pre-fund SPV
 * never walked that ladder. So this page said "The fund holds nothing yet" while Fund strategy's
 * composition bars, counted from closed opportunities, drew Sensori at 100%. The comment that used
 * to sit here recorded that disagreement as the reason the bars had been REMOVED from this page —
 * which hid the symptom and kept the two portfolios. Now `/api/portfolio/holdings` merges closed
 * investments with booked positions, per company, and says which each one is; the composition bars
 * and the deployment ring below are computed from the same list. One list, one answer, two pages.
 *
 * THE PLAN STAYS ON FUND STRATEGY. "Where the fund goes" — fees, reserves, sleeves as the firm
 * decided them — is where the fund is GOING. What sits here is where it IS against that plan:
 * deployed, still to deploy, and the composition of what has been bought. Same ring, same
 * arithmetic, hosted twice (`AllocationRing`, `@shared/fund/allocation`).
 */

interface CompanyRow {
  id: string;
  canonical_name: string;
}

interface AlertRow {
  id: string;
  company_id: string;
  alert_type: string;
  metric_key: string | null;
  severity: string;
  status: string;
  occurrence_count: number;
  escalated_from: string | null;
}

interface SupportRequestRow {
  id: string;
  company_id: string;
  request_type: string;
  description: string;
  status: string;
  matches?: Array<{ id: string; target_label: string; status: string; proposed_by_type: string; approval_card_id: string | null }>;
  outcomes?: Array<{ id: string; outcome_type: string; value_note: string | null; relationship_note: string | null }>;
}

interface MetricDefinition {
  metric_key: string;
  name: string;
  direction: string;
  stale_after_days: number | null;
}

interface Trend {
  company_id: string;
  company: string;
  metric: string;
  previous: number;
  latest: number;
  change_pct: number;
  verdict: string;
  window: string;
}

interface Cockpit {
  deteriorating: Trend[];
  improving: Trend[];
  stale_or_missing: Array<{ company: string; metric: string; as_of_date: string; days_old: number; stale_after_days: number }>;
}

interface Performance {
  fund: { id: string; name: string; currency: string };
  cost: number;
  value: number;
  holdings: Array<{
    position_id: string;
    company: string;
    cost: number;
    value: number;
    mark_source: string;
    mark_basis: string | null;
    marked_as_of: string | null;
    multiple: number | null;
  }>;
  honesty: { holdings_total: number; held_at_cost: number; note: string };
}

/** One company the firm has invested in, with the facts a partner asks about it. */
interface Holding {
  company_id: string;
  company: string;
  sector: string | null;
  kind: string;
  vehicle: string | null;
  booked: boolean;
  fund_id: string | null;
  fund_name: string | null;
  position_id: string | null;
  amount_in: number | null;
  provisional: boolean;
  placeholder_note: string | null;
  invested_on: string | null;
  ownership_pct: number | null;
  ownership_as_of: string | null;
  valuation: { value: number; source: string; basis: string | null; as_of: string } | null;
  last_check_in: string | null;
  open_asks: number;
  open_alerts: number;
  open_follow_on_reviews: number;
}

interface Holdings {
  holdings: Holding[];
  totals: { companies: number; booked: number; unbooked: number; invested: number; held_at: number; unvalued: number };
  note: string | null;
}

/** What kind of investment it is, in words. The enum never reaches the screen. */
const KIND_WORDS: Record<string, string> = {
  EARLY_STAGE_PRIMARY: "Early stage",
  FOLLOW_ON: "Follow-on",
  SECONDARY_PURCHASE: "Secondary",
  SECONDARY_SALE: "Sold",
  OTHER: "Investment",
};

/** Severity as somebody would say it out loud. The enum never reaches the screen. */
const SEVERITY_WORDS: Record<string, string> = {
  CRITICAL: "Critical",
  HIGH: "Serious",
  MEDIUM: "Worth a look",
  LOW: "Minor",
};

/** What each kind of alert actually means about the company. */
const ALERT_WORDS: Record<string, string> = {
  METRIC_DETERIORATION: "went the wrong way",
  STALE_UPDATE: "has not been updated in too long",
  MISSING_METRIC: "has never been reported",
  THRESHOLD_BREACH: "crossed the line the firm set",
};

/** Where a valuation came from, in the words a partner would use to defend it. */
const MARK_SOURCES = [
  { key: "LAST_ROUND", label: "The price of its most recent round" },
  { key: "THIRD_PARTY", label: "A third party valued it" },
  { key: "WRITE_DOWN", label: "We have written it down" },
  { key: "WRITE_OFF", label: "We have written it off" },
  { key: "COST", label: "Still just what we paid" },
] as const;

const SUPPORT_KINDS = [
  { key: "HIRING", label: "They need to hire somebody" },
  { key: "CUSTOMER_INTRO", label: "They want an introduction to a customer" },
  { key: "FUNDRAISE", label: "They are raising" },
  { key: "OPERATIONS", label: "Something operational" },
  { key: "LEGAL", label: "Something legal" },
  { key: "OTHER", label: "Something else" },
] as const;

const OUTCOMES = [
  { key: "HELPED", label: "It helped" },
  { key: "PARTIALLY_HELPED", label: "It helped a bit" },
  { key: "NO_EFFECT", label: "It made no difference" },
  { key: "HARMED", label: "It made things worse" },
  { key: "UNKNOWN", label: "We never found out" },
] as const;

function money(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
}

/** A percentage a person can read, with the sign kept because direction is the whole point. */
function pct(n: number): string {
  return `${n > 0 ? "+" : ""}${n}%`;
}

/**
 * A tracked figure's key, derived from what somebody typed.
 *
 * The old form asked for `metric_key` directly, which is why production holds metrics named things
 * like `arr`. A person types "Monthly revenue"; the key is machinery and belongs behind the field.
 */
function keyFor(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function PortfolioPage({ me }: { me: MeResponse }) {
  const [tab, setTab] = useState<"monitoring" | "reporting">("monitoring");

  return (
    <section data-testid="portfolio-page">
      <nav className="ic-tabs" data-testid="portfolio-tabs">
        <button
          type="button"
          className={tab === "monitoring" ? "ic-tab ic-tab-active" : "ic-tab"}
          data-testid="portfolio-tab-monitoring"
          onClick={() => setTab("monitoring")}
        >
          How the companies are doing
        </button>
        <button
          type="button"
          className={tab === "reporting" ? "ic-tab ic-tab-active" : "ic-tab"}
          data-testid="portfolio-tab-reporting"
          onClick={() => setTab("reporting")}
        >
          What they have reported
        </button>
      </nav>

      {tab === "monitoring" ? <Monitoring me={me} /> : <Reporting me={me} />}
    </section>
  );
}

/**
 * Standing over the portfolio: what we hold, what it is worth, and what is going wrong.
 */
function Monitoring({ me }: { me: MeResponse }) {
  const [nonce, setNonce] = useState(0);
  const companies = useApi<{ companies: CompanyRow[] }>("/api/companies");
  const definitions = useApi<{ metric_definitions: MetricDefinition[] }>("/api/portfolio/metric-definitions", [nonce]);
  const alerts = useApi<{ alerts: AlertRow[] }>("/api/portfolio/alerts?status=OPEN", [nonce]);
  const requests = useApi<{ support_requests: SupportRequestRow[] }>("/api/support/requests", [nonce]);
  const cockpit = useApi<Cockpit>("/api/portfolio/cockpit", [nonce]);
  const selected = useSelectedFund();
  const perf = useApi<Performance>(selected.fund ? `/api/funds/${selected.fund.id}/performance` : null, [selected.fund?.id, nonce]);
  const owned = useApi<Holdings>("/api/portfolio/holdings", [nonce]);

  const [companyId, setCompanyId] = useState("");
  const [metricName, setMetricName] = useState("");
  const [chosenMetric, setChosenMetric] = useState("");
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [value, setValue] = useState("");
  const [mark, setMark] = useState({ position_id: "", value: "", source: "LAST_ROUND", basis: "", as_of_date: new Date().toISOString().slice(0, 10) });
  const [ask, setAsk] = useState({ company_id: "", request_type: "HIRING", description: "" });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openRequest, setOpenRequest] = useState<string | null>(null);

  const isPartner = me.roles.includes("MANAGING_PARTNER");
  const companyList = companies.data?.companies ?? [];
  const tracked = definitions.data?.metric_definitions ?? [];
  const open = alerts.data?.alerts ?? [];
  const asks = requests.data?.support_requests ?? [];
  const p = perf.data;
  const currency = p?.fund.currency ?? "USD";
  const own = owned.data;
  const nameOf = (id: string) => companyList.find((c) => c.id === id)?.canonical_name ?? "a company";
  const labelOf = (key: string | null) => (key ? tracked.find((d) => d.metric_key === key)?.name ?? key : "Something we track");

  function refresh() {
    setNonce((n) => n + 1);
  }

  async function recordMark() {
    if (!mark.position_id || !mark.value.trim()) {
      setMessage("Pick the holding and say what it is worth now.");
      return;
    }
    if (mark.source !== "COST" && !mark.basis.trim()) {
      setMessage("Say what this rests on — the round, the valuation, or why it was written down. It is the question an investor asks.");
      return;
    }
    setBusy(true);
    const failed = mutationError(
      await api(`/api/positions/${mark.position_id}/mark`, {
        method: "POST",
        body: { value: Number(mark.value), source: mark.source, basis: mark.basis.trim() || undefined, as_of_date: mark.as_of_date },
      }),
      201,
    );
    setBusy(false);
    setMessage(failed ?? "Recorded. The old figure is kept — a valuation is superseded, never overwritten.");
    if (!failed) {
      setMark((m) => ({ ...m, value: "", basis: "" }));
      refresh();
    }
  }

  async function trackSomethingNew() {
    const key = keyFor(metricName);
    if (key.length < 2) {
      setMessage("Name what you want to track — “Monthly revenue”, “Cash in the bank”, “Runway in months”.");
      return;
    }
    setBusy(true);
    const failed = mutationError(
      await api("/api/portfolio/metric-definitions", {
        method: "POST",
        body: {
          metric_key: key,
          name: metricName.trim(),
          direction: "HIGHER_IS_BETTER",
          // The firm's own bands, stated here rather than invented per company. Nothing is flagged
          // as serious until the operator says what serious is; below these it still fires, and the
          // alert says the severity was never configured.
          severity_bands: { MEDIUM: 5, HIGH: 15, CRITICAL: 30 },
          stale_after_days: 120,
        },
      }),
      201,
    );
    setBusy(false);
    setMessage(failed ?? `Now tracking ${metricName.trim()} across the portfolio. Record the first figure below.`);
    if (!failed) {
      setChosenMetric(key);
      setMetricName("");
      refresh();
    }
  }

  async function recordFigure() {
    const key = chosenMetric || tracked[0]?.metric_key;
    if (!companyId || !key || !value.trim()) {
      setMessage("Pick the company, pick what the figure is, and type it.");
      return;
    }
    setBusy(true);
    const failed = mutationError(
      await api("/api/portfolio/snapshots", {
        method: "POST",
        body: { company_id: companyId, metric_key: key, as_of_date: asOf, value: Number(value), source: "recorded by hand" },
      }),
      201,
    );
    setBusy(false);
    setMessage(failed ?? `Recorded for ${nameOf(companyId)} as of ${asOf}.`);
    if (!failed) {
      setValue("");
      refresh();
    }
  }

  async function checkCompany() {
    if (!companyId) {
      setMessage("Pick a company to check.");
      return;
    }
    setBusy(true);
    const res = await api<{ results?: unknown[] }>(`/api/portfolio/companies/${companyId}/evaluate`, { method: "POST", body: {} });
    setBusy(false);
    const failed = mutationError(res, 201);
    const raised = res.data?.results?.length ?? 0;
    setMessage(failed ?? (raised === 0 ? `Checked ${nameOf(companyId)}. Nothing to flag.` : `Checked ${nameOf(companyId)}. ${raised} thing${raised === 1 ? "" : "s"} to look at, above.`));
    if (!failed) refresh();
  }

  async function recordAsk() {
    if (!ask.company_id || ask.description.trim().length < 3) {
      setMessage("Which company, and what did they actually ask for?");
      return;
    }
    setBusy(true);
    const failed = mutationError(
      await api("/api/support/requests", {
        method: "POST",
        body: { company_id: ask.company_id, request_type: ask.request_type, description: ask.description.trim() },
      }),
      201,
    );
    setBusy(false);
    setMessage(failed ?? `Written down for ${nameOf(ask.company_id)}.`);
    if (!failed) {
      setAsk((a) => ({ ...a, description: "" }));
      refresh();
    }
  }

  async function acknowledge(id: string) {
    setBusy(true);
    const failed = mutationError(await api(`/api/portfolio/alerts/${id}/decide`, { method: "POST", body: { to: "ACKNOWLEDGED" } }), 200);
    setBusy(false);
    setMessage(failed ?? "Noted. It stays on the record; it stops asking.");
    if (!failed) refresh();
  }

  async function askForHelp(alert: AlertRow) {
    setBusy(true);
    const failed = mutationError(
      await api("/api/support/requests", {
        method: "POST",
        body: {
          company_id: alert.company_id,
          request_type: "OPERATIONS",
          description: `${labelOf(alert.metric_key)} ${ALERT_WORDS[alert.alert_type] ?? "needs looking at"} at ${nameOf(alert.company_id)}.`,
          alert_id: alert.id,
        },
      }),
      201,
    );
    setBusy(false);
    setMessage(failed ?? "Opened. It is in “where a company has asked for help”, below.");
    if (!failed) refresh();
  }

  return (
    <>
      <h3>What we own, and what it is worth</h3>
      <div className="card" data-testid="holdings">
        {selected.hasChoice && (
          <div className="form-row">
            <label>
              Fund{" "}
              <select value={selected.fund?.id ?? ""} onChange={(e) => selected.select(e.target.value)} data-testid="holdings-fund">
                {selected.funds.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {own && own.totals.companies > 0 && (
          <div className="cohort-grid" data-testid="holdings-totals">
            <div className="cohort">
              <span className="cohort-count">{own.totals.companies}</span>
              <span className="cohort-label">Companies</span>
              <span className="cohort-pct">the firm has invested in</span>
            </div>
            <div className="cohort">
              <span className="cohort-count">{money(own.totals.invested, currency)}</span>
              <span className="cohort-label">Invested</span>
              <span className="cohort-pct">what was paid for them</span>
            </div>
            <div className="cohort">
              <span className="cohort-count">{money(own.totals.held_at, currency)}</span>
              <span className="cohort-label">Held at</span>
              <span className="cohort-pct">
                {own.totals.unvalued === 0 ? "what they are carried at today" : `${own.totals.unvalued} at what was paid — never valued`}
              </span>
            </div>
          </div>
        )}

        {/* Said before anybody reads the figures above, not discovered after quoting them. */}
        {own?.note && (
          <p className="notice notice-gate small" data-testid="holdings-honesty">
            {own.note}
          </p>
        )}
        {!own?.note && p && p.honesty.held_at_cost > 0 && (
          <p className="notice notice-gate small" data-testid="holdings-honesty">
            {p.honesty.note}
          </p>
        )}

        <ul className="card-list small" data-testid="holdings-list">
          {owned.loading && !own && <li className="state-message" data-testid="holdings-list-loading">Loading…</li>}
          {(own?.holdings ?? []).map((h) => (
            <li key={h.company_id} data-testid={`holding-${h.company_id}`}>
              <strong>{h.company}</strong>
              {" — "}
              {KIND_WORDS[h.kind] ?? "Investment"}
              {h.vehicle ? ` via ${h.vehicle}` : ""}
              {h.invested_on ? `, ${h.invested_on}` : ""}
              {h.sector ? ` · ${h.sector}` : ""}
              <div className="muted" data-testid={`holding-facts-${h.company_id}`}>
                {h.amount_in !== null ? `Paid ${money(h.amount_in, currency)}` : "Amount not recorded"}
                {h.provisional ? " (stand-in figures)" : ""}
                {" · "}
                {h.ownership_pct !== null ? `${h.ownership_pct}% owned` : "ownership not recorded"}
                {" · "}
                {h.valuation
                  ? `held at ${money(h.valuation.value, currency)} — ${(MARK_SOURCES.find((s) => s.key === h.valuation!.source)?.label ?? h.valuation.source).toLowerCase()}, as of ${h.valuation.as_of}${h.valuation.basis ? ` — ${h.valuation.basis}` : ""}`
                  : h.booked
                    ? "nobody has valued it since we bought it"
                    : "no valuation until it is booked"}
              </div>
              <div className="muted" data-testid={`holding-standing-${h.company_id}`}>
                {h.booked
                  ? `Booked to ${h.fund_name ?? "the fund"}`
                  : "Recorded as closed; not yet booked to a fund — book the transaction on the company's record, under Dealflow"}
                {" · "}
                {h.last_check_in ? `last heard from ${h.last_check_in}` : "never reported a figure"}
                {h.open_alerts > 0 ? ` · ${h.open_alerts} flagged` : ""}
                {h.open_asks > 0 ? ` · ${h.open_asks} open ask${h.open_asks === 1 ? "" : "s"}` : ""}
                {h.open_follow_on_reviews > 0 ? ` · follow-on under review` : ""}
              </div>
              {h.provisional && h.placeholder_note && (
                <div className="muted small" data-testid={`holding-placeholder-${h.company_id}`}>{h.placeholder_note}</div>
              )}
            </li>
          ))}
          {own && own.totals.companies === 0 && (
            <li className="state-empty" data-testid="holdings-empty">
              The firm has invested in nothing yet. A company appears here the moment a deal closes on Dealflow, and is
              booked to the fund when the transaction is executed on the company's own record.
            </li>
          )}
        </ul>
      </div>

      {/* WHAT THE PORTFOLIO IS. The same two drawings Fund strategy hosts, from the same list as the
          holdings above — a shape of what has been bought, and where the money sits against the plan. */}
      <Composition />
      <PortfolioAllocation fundId={selected.fund?.id ?? null} />

      <h3>Say what a holding is worth now</h3>
      <div className="card">
        <p className="small">
          A valuation is a fact about the holding, so it is recorded here and nowhere else — the LP letter reads these
          figures rather than keeping its own.
        </p>
        <div className="form-row" data-testid="mark-form">
          <label>
            Which holding{" "}
            <select data-testid="mark-position" value={mark.position_id} onChange={(e) => setMark((m) => ({ ...m, position_id: e.target.value }))}>
              <option value="">— pick one —</option>
              {(p?.holdings ?? []).map((h) => (
                <option key={h.position_id} value={h.position_id}>
                  {h.company}
                </option>
              ))}
            </select>
          </label>
          <label>
            Worth now{" "}
            <input
              className="input-money"
              inputMode="decimal"
              data-testid="mark-value"
              value={mark.value}
              onChange={(e) => setMark((m) => ({ ...m, value: e.target.value }))}
              placeholder="2500000"
            />
          </label>
          <label>
            On what basis{" "}
            <select data-testid="mark-source" value={mark.source} onChange={(e) => setMark((m) => ({ ...m, source: e.target.value }))}>
              {MARK_SOURCES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Say more{" "}
            <input
              data-testid="mark-basis"
              value={mark.basis}
              onChange={(e) => setMark((m) => ({ ...m, basis: e.target.value }))}
              placeholder="Series B at $40M post, March 2026"
            />
          </label>
          <label>
            As of{" "}
            <input type="date" data-testid="mark-date" value={mark.as_of_date} onChange={(e) => setMark((m) => ({ ...m, as_of_date: e.target.value }))} />
          </label>
          <button type="button" className="btn-strong" disabled={busy || !isPartner} data-testid="mark-submit" onClick={() => void recordMark()}>
            Record it
          </button>
        </div>
        <p className="muted small">
          {isPartner
            ? "Only a person can say what a holding is worth — no employee may do this. “Why is it held there” is a question an investor asks, so the basis is required."
            : "Recording a valuation is reserved for a Managing Partner. Ask one of them; the figures above are yours to read."}
        </p>
      </div>

      <h3>What is going wrong right now</h3>
      <ul className="card-list" data-testid="alert-list">
        {open.map((a) => (
          <li key={a.id} className="card" data-testid={`alert-${a.id}`}>
            <strong>{nameOf(a.company_id)}</strong> — {labelOf(a.metric_key)} {ALERT_WORDS[a.alert_type] ?? "needs looking at"}.{" "}
            <span className="muted small" data-testid={`alert-severity-${a.id}`}>
              {SEVERITY_WORDS[a.severity] ?? a.severity}
              {a.occurrence_count > 1 ? ` · seen ${a.occurrence_count} times` : ""}
              {a.escalated_from ? " · it got worse" : ""}
            </span>
            <div className="form-row">
              <button type="button" disabled={busy || !isPartner} data-testid={`alert-ack-${a.id}`} onClick={() => void acknowledge(a.id)}>
                I have seen it
              </button>
              <button type="button" disabled={busy} data-testid={`alert-support-${a.id}`} onClick={() => void askForHelp(a)}>
                Get the firm behind it
              </button>
            </div>
          </li>
        ))}
        {open.length === 0 && (
          <li className="state-empty" data-testid="no-alerts">
            Nothing is flagged. Something appears here when a figure a company reported moves the wrong way, or when one
            goes too long without being reported at all.
          </li>
        )}
      </ul>

      <h3>Which way each company is moving</h3>
      <div className="card" data-testid="movement">
        <p className="muted small">
          The newest figure against the one before it, read against whether higher or lower is better for that figure.
          Exactly the comparison the flags above use, so the two can never tell you different things.
        </p>
        <h4>Going the wrong way</h4>
        <ul className="card-list small" data-testid="deteriorating">
          {(cockpit.data?.deteriorating ?? []).map((t) => (
            <li key={`${t.company_id}-${t.metric}`}>
              <strong>{t.company}</strong> — {t.metric} {t.previous} → {t.latest} ({pct(t.change_pct)}) · <span className="muted">{t.window}</span>
            </li>
          ))}
          {(cockpit.data?.deteriorating ?? []).length === 0 && <li className="state-empty">Nothing is falling.</li>}
        </ul>

        <h4>Pulling ahead</h4>
        <ul className="card-list small" data-testid="improving">
          {(cockpit.data?.improving ?? []).map((t) => (
            <li key={`${t.company_id}-${t.metric}`}>
              <strong>{t.company}</strong> — {t.metric} {t.previous} → {t.latest} ({pct(t.change_pct)}) · <span className="muted">{t.window}</span>
            </li>
          ))}
          {(cockpit.data?.improving ?? []).length === 0 && (
            <li className="state-empty">Nothing has two figures to compare yet. Record what a company reported, below.</li>
          )}
        </ul>
      </div>

      <h3>Who we have not heard from</h3>
      <ul className="card-list small" data-testid="stale">
        {(cockpit.data?.stale_or_missing ?? []).map((s) => (
          <li key={`${s.company}-${s.metric}`}>
            <strong>{s.company}</strong> — {s.metric} last reported {s.as_of_date}, {s.days_old} days ago. The firm asked to
            be told after {s.stale_after_days}.
          </li>
        ))}
        {(cockpit.data?.stale_or_missing ?? []).length === 0 && (
          <li className="state-empty">Every company is current on everything the firm tracks.</li>
        )}
      </ul>

      <h3>Where a company has asked for help</h3>
      <ul className="card-list" data-testid="support-list">
        {asks.map((r) => (
          <li key={r.id} className="card" data-testid={`support-${r.id}`}>
            <strong>{nameOf(r.company_id)}</strong> — {r.description}{" "}
            <span className="muted small">
              {r.status === "OPEN" ? "nobody has suggested anybody yet" : r.status === "MATCHED" ? "somebody has been suggested" : r.status.toLowerCase()}
            </span>
            <div className="form-row">
              <button type="button" data-testid={`support-open-${r.id}`} onClick={() => setOpenRequest(r.id === openRequest ? null : r.id)}>
                {r.id === openRequest ? "Close" : "Open"}
              </button>
            </div>
          </li>
        ))}
        {asks.length === 0 && (
          <li className="state-empty" data-testid="no-support-requests">
            Nobody has asked for anything. A request appears when a founder asks, or when you press “Get the firm behind it”
            on something flagged above.
          </li>
        )}
      </ul>

      {openRequest && <SupportRequestDetail requestId={openRequest} onChanged={refresh} />}

      <div className="card">
        <div className="form-row" data-testid="support-ask-form">
          <label>
            Company{" "}
            <select data-testid="support-ask-company" value={ask.company_id} onChange={(e) => setAsk((a) => ({ ...a, company_id: e.target.value }))}>
              <option value="">— pick one —</option>
              {companyList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.canonical_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            What kind of thing{" "}
            <select data-testid="support-ask-kind" value={ask.request_type} onChange={(e) => setAsk((a) => ({ ...a, request_type: e.target.value }))}>
              {SUPPORT_KINDS.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            What they asked for{" "}
            <input
              data-testid="support-ask-description"
              value={ask.description}
              onChange={(e) => setAsk((a) => ({ ...a, description: e.target.value }))}
              placeholder="a VP Engineering who has scaled a team past 30"
            />
          </label>
          <button type="button" disabled={busy} data-testid="support-ask-submit" onClick={() => void recordAsk()}>
            Record the ask
          </button>
        </div>
        <p className="muted small">
          Most asks arrive in a call, not in a flagged number. Writing one down here is what lets the firm find out later
          whether the help ever landed.
        </p>
      </div>

      <h3>Record what a company reported</h3>
      <div className="card">
        <p className="small">
          Every figure is dated, because a number with no date invites somebody to quote it in a meeting without knowing
          whether it is from last month or last year.
        </p>
        <div className="form-row" data-testid="snapshot-form">
          <label>
            Company{" "}
            <select data-testid="portfolio-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              <option value="">— pick one —</option>
              {companyList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.canonical_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Which figure{" "}
            <select data-testid="snapshot-metric" value={chosenMetric} onChange={(e) => setChosenMetric(e.target.value)}>
              {tracked.length === 0 && <option value="">— nothing tracked yet —</option>}
              {tracked.map((d) => (
                <option key={d.metric_key} value={d.metric_key}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            As of{" "}
            <input type="date" data-testid="snapshot-date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
          <label>
            The number{" "}
            <input className="input-money" inputMode="decimal" data-testid="snapshot-value" value={value} onChange={(e) => setValue(e.target.value)} placeholder="1000" />
          </label>
          <button type="button" className="btn-strong" disabled={busy || tracked.length === 0} data-testid="snapshot-submit" onClick={() => void recordFigure()}>
            Record it
          </button>
          <button type="button" disabled={busy} data-testid="evaluate-alerts" onClick={() => void checkCompany()}>
            Check this company against its history
          </button>
        </div>

        <div className="form-row" data-testid="metric-definition-form">
          <label>
            Track something new{" "}
            <input data-testid="metric-key" value={metricName} onChange={(e) => setMetricName(e.target.value)} placeholder="Monthly revenue" />
          </label>
          <button type="button" disabled={busy} data-testid="metric-define" onClick={() => void trackSomethingNew()}>
            Track it across the portfolio
          </button>
        </div>
        <p className="muted small">
          Anything tracked is tracked for every company, and the firm is told when a company goes four months without
          reporting it. Track the two or three that decide whether a company is alive, not everything a founder sends.
        </p>
      </div>

      {message && (
        <p className="notice" data-testid="portfolio-message" role="status">
          {message}
        </p>
      )}
    </>
  );
}

/**
 * One company's ask, and who the firm might put behind it.
 *
 * MOVED OUT OF App.tsx UNCHANGED IN SUBSTANCE, with two defects fixed on the way. It rendered raw
 * enum values on screen, and its "record outcome" button posted a hard-coded result — every outcome
 * came out as "one intro converted / founder felt supported" whatever had happened. A form that
 * writes the same sentence every time is worse than no form: it fills the record with fiction that
 * later reads as evidence.
 *
 * PROPOSING A MATCH CONTACTS NOBODY, and accepting one does not either. Accepting opens the
 * introduction approval a Managing Partner decides, and the mail goes only when they send it.
 */
function SupportRequestDetail({ requestId, onChanged }: { requestId: string; onChanged: () => void }) {
  const request = useApi<SupportRequestRow>(`/api/support/requests/${requestId}`, [requestId]);
  const [target, setTarget] = useState("");
  const [outcome, setOutcome] = useState({ outcome_type: "HELPED", value_note: "", relationship_note: "" });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const r = request.data;
  if (!r) return <p className="muted small">Opening it…</p>;

  async function after(failed: string | null, ok: string) {
    setBusy(false);
    setMessage(failed ?? ok);
    if (!failed) {
      request.reload();
      onChanged();
    }
  }

  async function propose() {
    if (target.trim().length < 2) {
      setMessage("Who could help? A name is enough.");
      return;
    }
    setBusy(true);
    const failed = mutationError(
      await api(`/api/support/requests/${requestId}/matches`, {
        method: "POST",
        body: { match_type: "PERSON", target_label: target.trim(), rationale: "proposed from the firm's own network" },
      }),
      201,
    );
    if (!failed) setTarget("");
    await after(failed, "Suggested. Nobody has been contacted.");
  }

  async function accept(matchId: string) {
    setBusy(true);
    const res = await api<{ approval_card_id?: string }>(`/api/support/matches/${matchId}/decide`, { method: "POST", body: { decision: "ACCEPTED" } });
    const failed = mutationError(res, 200);
    await after(
      failed,
      `Accepted${res.data?.approval_card_id ? ` — approval card ${res.data.approval_card_id}` : ""}. That is permission to ASK a partner, not permission to make the introduction.`,
    );
  }

  async function record() {
    setBusy(true);
    const failed = mutationError(
      await api(`/api/support/requests/${requestId}/outcomes`, {
        method: "POST",
        body: {
          outcome_type: outcome.outcome_type,
          value_note: outcome.value_note.trim() || undefined,
          relationship_note: outcome.relationship_note.trim() || undefined,
        },
      }),
      201,
    );
    if (!failed) setOutcome((o) => ({ ...o, value_note: "", relationship_note: "" }));
    await after(failed, "Written down. What actually happened is the only way to know whether helping helps.");
  }

  return (
    <div className="card" data-testid="support-detail">
      <h4>{r.description}</h4>

      <div className="form-row" data-testid="match-form">
        <label>
          Who could help{" "}
          <input data-testid="match-target" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="a name" />
        </label>
        <button type="button" className="btn-strong" disabled={busy} data-testid="match-submit" onClick={() => void propose()}>
          Suggest them
        </button>
      </div>

      <ul className="card-list small" data-testid="match-list">
        {(r.matches ?? []).map((m) => (
          <li key={m.id} data-testid={`match-${m.id}`}>
            <strong>{m.target_label}</strong>{" "}
            <span className="muted" data-testid={`match-status-${m.id}`}>
              {m.status === "PROPOSED"
                ? "suggested, nobody contacted"
                : m.status === "ACCEPTED"
                  ? "accepted — waiting on a partner to make the introduction"
                  : m.status.toLowerCase()}
              {m.proposed_by_type === "AI" ? " · suggested by an employee" : ""}
            </span>
            {m.status === "PROPOSED" && (
              <>
                {" "}
                <button type="button" disabled={busy} data-testid={`match-accept-${m.id}`} onClick={() => void accept(m.id)}>
                  Take it to a partner
                </button>
              </>
            )}
          </li>
        ))}
        {(r.matches ?? []).length === 0 && <li className="state-empty" data-testid="no-matches">Nobody has been suggested yet.</li>}
      </ul>

      <div className="form-row" data-testid="outcome-form">
        <label>
          What happened{" "}
          <select data-testid="outcome-type" value={outcome.outcome_type} onChange={(e) => setOutcome((o) => ({ ...o, outcome_type: e.target.value }))}>
            {OUTCOMES.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          What it was worth{" "}
          <input data-testid="outcome-value" value={outcome.value_note} onChange={(e) => setOutcome((o) => ({ ...o, value_note: e.target.value }))} placeholder="they hired her" />
        </label>
        <label>
          How it left the relationship{" "}
          <input
            data-testid="outcome-relationship"
            value={outcome.relationship_note}
            onChange={(e) => setOutcome((o) => ({ ...o, relationship_note: e.target.value }))}
            placeholder="the founder felt backed"
          />
        </label>
        <button type="button" disabled={busy} data-testid="outcome-submit" onClick={() => void record()}>
          Write it down
        </button>
      </div>

      <ul className="card-list small" data-testid="outcome-list">
        {(r.outcomes ?? []).map((o) => (
          <li key={o.id} data-testid={`outcome-${o.id}`}>
            {OUTCOMES.find((x) => x.key === o.outcome_type)?.label ?? o.outcome_type}
            {o.value_note ? ` — ${o.value_note}` : ""}
            {o.relationship_note ? ` · ${o.relationship_note}` : ""}
          </li>
        ))}
        {(r.outcomes ?? []).length === 0 && (
          <li className="state-empty">Nothing recorded yet. Whether the help landed is the only thing that tells the firm this is worth doing.</li>
        )}
      </ul>

      {message && (
        <p className="notice small" data-testid="support-message" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

interface ReportingView {
  updates: Array<{ id: string; company: string | null; period_label: string | null; received_at: string; summary: string | null; source: string; numbers_taken: number }>;
  waiting: Array<{ id: string; title: string; next_action: string | null; created_at: string }>;
  waiting_count: number;
  month_over_month: Trend[];
  month_over_month_skipped: Array<{ company: string; metric: string; reason: string }>;
  quarter_over_quarter: Trend[];
  quarter_over_quarter_skipped: Array<{ company: string; metric: string; reason: string }>;
  mailbox: string;
  reads_the_inbox: string;
}

/**
 * What the companies themselves sent in, and how it reads over a month and over a quarter.
 *
 * Operator, item 12: the host employee "parses inbound updates emailed to os@joinwestpeek.com and
 * summarises month-over-month and quarter-over-quarter."
 *
 * AN EMAIL OPENS A JOB, IT DOES NOT SET A NUMBER. A founder's update arriving with a hashtag becomes
 * a piece of work for Winter, who reads it and records what it says. That is the whole reason this
 * page can be trusted: the figures the fund reports to its own investors are ones somebody at the
 * firm wrote down, not ones an unauthenticated email asserted.
 */
function Reporting({ me }: { me: MeResponse }) {
  const [nonce, setNonce] = useState(0);
  const view = useApi<ReportingView>("/api/portfolio/reporting", [nonce]);
  const companies = useApi<{ companies: CompanyRow[] }>("/api/companies");
  const [form, setForm] = useState({ company_id: "", period_label: "", received_at: new Date().toISOString().slice(0, 10), summary: "" });
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  void me;

  const v = view.data;
  const companyList = companies.data?.companies ?? [];

  async function fileUpdate() {
    if (!form.company_id) {
      setMessage("Which company sent it?");
      return;
    }
    setBusy(true);
    const failed = mutationError(
      await api("/api/portfolio/updates", {
        method: "POST",
        body: {
          company_id: form.company_id,
          received_at: form.received_at,
          source: "filed by hand",
          period_label: form.period_label.trim() || undefined,
          summary: form.summary.trim() || undefined,
        },
      }),
      201,
    );
    setBusy(false);
    setMessage(failed ?? "Filed. Record the figures it contains on the other tab, so they count towards the comparisons here.");
    if (!failed) {
      setForm((f) => ({ ...f, period_label: "", summary: "" }));
      setNonce((n) => n + 1);
    }
  }

  async function askForSummary() {
    setBusy(true);
    const res = await api<{ draft?: string; detail?: string; error?: string }>("/api/portfolio/reporting/summary", { method: "POST", body: {} });
    setBusy(false);
    if (res.status === 200 && res.data?.draft) {
      setDraft(res.data.draft);
      setMessage(`${v?.reads_the_inbox ?? "Winter"} has written it up. It has gone to nobody.`);
    } else {
      setMessage(res.data?.detail ?? res.data?.error ?? `It could not be written (HTTP ${res.status}).`);
    }
  }

  const table = (rows: Trend[], testid: string) => (
    <div className="table-wrap">
      <table className="surface-body" data-testid={testid}>
        <thead>
          <tr>
            <th>Company</th>
            <th>Figure</th>
            <th className="num">Was</th>
            <th className="num">Now</th>
            <th className="num">Change</th>
            <th>Between</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={`${t.company_id}-${t.metric}`}>
              <td>{t.company}</td>
              <td>{t.metric}</td>
              <td className="num">{t.previous}</td>
              <td className="num">{t.latest}</td>
              <td className="num">{pct(t.change_pct)}</td>
              <td>{t.window}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="state-empty">
                Nothing has two figures far enough apart to compare. Record what a company reported on the other tab, and
                this fills in as the second month lands.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  const gaps = (rows: Array<{ company: string; metric: string; reason: string }>, testid: string) =>
    rows.length > 0 && (
      <ul className="card-list small" data-testid={testid}>
        {rows.map((s) => (
          <li key={`${s.company}-${s.metric}`}>
            <strong>{s.company}</strong> — {s.metric}: {s.reason}
          </li>
        ))}
      </ul>
    );

  return (
    <>
      <h3>What the companies have sent us</h3>
      <div className="card" data-testid="updates">
        <p className="small">
          A company emails {v?.mailbox ?? "the firm's inbox"} with <strong>#wpupdate</strong> and it becomes a job for{" "}
          {v?.reads_the_inbox ?? "the employee who watches the portfolio"}, who reads it and writes down what it actually
          says. Nothing an email claims becomes the firm's figure on its own.
        </p>

        {v && v.waiting_count > 0 && (
          <p className="notice small" data-testid="updates-waiting">
            {v.waiting_count} update{v.waiting_count === 1 ? " has" : "s have"} arrived and {v.waiting_count === 1 ? "has" : "have"} not
            been read yet. {v.waiting.map((w) => w.title.replace(/^Portfolio update:\s*/, "")).join(", ")} — they are on Work.
          </p>
        )}

        <ul className="card-list small" data-testid="update-list">
          {(v?.updates ?? []).map((u) => (
            <li key={u.id} data-testid={`update-${u.id}`}>
              <strong>{u.company ?? "a company"}</strong>
              {u.period_label ? ` · ${u.period_label}` : ""} — received {u.received_at.slice(0, 10)} ·{" "}
              <span className="muted">
                {u.numbers_taken === 0 ? "no figures taken out of it yet" : `${u.numbers_taken} figure${u.numbers_taken === 1 ? "" : "s"} recorded from it`}
              </span>
              {u.summary ? <div className="muted">{u.summary}</div> : null}
            </li>
          ))}
          {v && v.updates.length === 0 && (
            <li className="state-empty" data-testid="no-updates">
              No company has reported yet. The first one lands here when a founder emails {v.mailbox} with #wpupdate, or when
              somebody files one below.
            </li>
          )}
        </ul>
      </div>

      <h3>Month on month</h3>
      {table(v?.month_over_month ?? [], "mom-table")}
      {gaps(v?.month_over_month_skipped ?? [], "mom-gaps")}

      <h3>Quarter on quarter</h3>
      {table(v?.quarter_over_quarter ?? [], "qoq-table")}
      {gaps(v?.quarter_over_quarter_skipped ?? [], "qoq-gaps")}

      <h3>The write-up</h3>
      <div className="card">
        <p className="small">
          {v?.reads_the_inbox ?? "Winter"} turns the two tables above into something a partner can read. Every figure is
          handed over already worked out — nothing in the write-up is a number an employee arrived at on its own.
        </p>
        <div className="form-row">
          <button type="button" className="btn-strong" disabled={busy} data-testid="summary-ask" onClick={() => void askForSummary()}>
            {busy ? "Writing…" : `Ask ${v?.reads_the_inbox ?? "Winter"} to write it up`}
          </button>
          <span className="muted small">For the partners. It goes to nobody unless one of you sends it.</span>
        </div>
        {draft && (
          <div className="brief-prose" data-testid="summary-draft">
            <p style={{ whiteSpace: "pre-wrap" }}>{draft}</p>
          </div>
        )}
      </div>

      <h3>File an update that came another way</h3>
      <div className="card">
        <p className="small">Somebody rang, or it landed in a partner's own inbox. Record that it arrived, then put its figures on the other tab.</p>
        <div className="form-row" data-testid="update-form">
          <label>
            Company{" "}
            <select data-testid="update-company" value={form.company_id} onChange={(e) => setForm((f) => ({ ...f, company_id: e.target.value }))}>
              <option value="">— pick one —</option>
              {companyList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.canonical_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Which period{" "}
            <input data-testid="update-period" value={form.period_label} onChange={(e) => setForm((f) => ({ ...f, period_label: e.target.value }))} placeholder="Q1 2026" />
          </label>
          <label>
            Arrived{" "}
            <input type="date" data-testid="update-received" value={form.received_at} onChange={(e) => setForm((f) => ({ ...f, received_at: e.target.value }))} />
          </label>
          <label>
            What it said{" "}
            <input data-testid="update-summary" value={form.summary} onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))} placeholder="growing, hiring two engineers" />
          </label>
          <button type="button" disabled={busy} data-testid="update-submit" onClick={() => void fileUpdate()}>
            File it
          </button>
        </div>
      </div>

      {message && (
        <p className="notice" data-testid="reporting-message" role="status">
          {message}
        </p>
      )}
    </>
  );
}
