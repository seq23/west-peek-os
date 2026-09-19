import { forwardRef, useEffect, useRef, useState } from "react";
import { api, mutationError, useApi, type MeResponse } from "../lib/api";
import { useSelectedFund } from "../lib/selectedFund";
import { MANAGING_PARTNERS } from "@shared/registry/managingPartners";
import { Composition } from "./FundAllocation";
import { PortfolioAllocation } from "./PortfolioAllocation";

/**
 * Portfolio — how portfolio companies are doing, what the firm owns, and whether each holding is
 * booked. Phase D of the Deals section (design/DEALS_SECTION_DESIGN.md §6, artboards G1 and G2,
 * owner-approved 18 Sep 2026).
 *
 * WHAT WAS WRONG (§1.4, the audit): "Book it" did not exist — the holdings notice sent a partner to
 * another screen and a receipt id to paste; marking was a separate form with a `<select>` of
 * holdings; two sub-tabs split one object; a holding was nine facts in one wrapped sentence;
 * concentration, per-company reserves and the stage were absent. The owner's words: "there needs to
 * be an easy intuitive way to book a company as a real Fund I position and the MPs should be able
 * to add the data there and save."
 *
 * THE SHAPE NOW. One masthead answer derived from the counts the page already loads. One band per
 * question, in the order a partner asks them: what we own (the rows, with Book it / Mark it /
 * Reserve for it / Sell inline on the row) → what it is made of and where the money is against the
 * plan (the two drawings Fund strategy hosts, from the same list) → what is going wrong → which way
 * each company is moving → who we have not heard from → who asked for help → what they have
 * reported → record what a company reported. Reporting is a band, not a tab.
 *
 * BOOK IT IS ONE SAVE, AND APPROVAL BOOKS IT. The form on the row posts to
 * `POST /api/holdings/:company_id/book`, which composes the EXISTING ladder — share class → DRAFT →
 * the `investment.approve` card — and stops. A partner's approval of that card executes the
 * booking on the server; there is no receipt to paste and no third click. The row renders every
 * state of that walk: unbooked → draft → awaiting a partner → booked (and sent back). Sensori is
 * the first real case: a pre-fund SPV recorded with a $1 × 10,000 STAND-IN, so the form never
 * pre-fills price or count from the record — the partners type the real terms, and saving heals the
 * stand-ins on the deal from what they typed.
 *
 * THE MOVEMENT FIGURES ARE THE COCKPIT'S OWN, and WHAT WE OWN IS ONE LIST (`/api/portfolio/holdings`):
 * both unchanged from Phase Portfolio, for the reasons recorded there — a second implementation of
 * "is this getting worse", or a second portfolio, is how two surfaces end up disagreeing about the
 * same company. `validate:portfolio` keeps the list one; `validate:booking` keeps the ladder one.
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
  opportunity_id: string | null;
  stage: { status: string; backfilled: boolean } | null;
  standing: "unbooked" | "draft" | "awaiting" | "declined" | "booked";
  booking: {
    transaction_id: string;
    status: string;
    approval_card_id: string | null;
    card_state: string | null;
    quantity: number;
    price_per_share: number;
    net_amount: number;
    transaction_date: string;
    fund_id: string | null;
    vehicle: string | null;
    created_by: string;
    created_at: string;
  } | null;
  shares: { quantity: number; price_per_share: number | null; security_class_id: string } | null;
  reserve: { amount: number; as_of: string; note: string | null } | null;
  sale: { opportunity_id: string; status: string } | null;
}

interface Concentration {
  max_single_company_pct: number | null;
  committed_usd: number;
  cap_usd: number | null;
  rows: Array<{ company_id: string; company: string; at_cost_usd: number; pct_of_committed: number; ownership_pct: number | null; level: "ok" | "near" | "at" }>;
}

interface Holdings {
  holdings: Holding[];
  concentration: Concentration;
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

/** Which entity holds it. Typed over when none fits. */
const VEHICLES = ["SPV", "Fund I direct", "Warehouse"] as const;

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

function moneyExact(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: Math.abs(amount) < 100 ? 2 : 0 }).format(amount);
}

function count(n: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
}

/** "6 Aug 2025" from an ISO date; the raw string when it is not one. */
function day(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** A percentage a person can read, with the sign kept because direction is the whole point. */
function pct(n: number): string {
  return `${n > 0 ? "+" : ""}${n}%`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
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

/** The partner who will decide — the other Managing Partner, by name. */
function approverFor(me: MeResponse): string {
  return MANAGING_PARTNERS.find((p) => p.fullName !== me.fullName)?.firstName ?? "a partner";
}

export function PortfolioPage({ me }: { me: MeResponse }) {
  const [nonce, setNonce] = useState(0);
  const companies = useApi<{ companies: CompanyRow[] }>("/api/companies");
  const definitions = useApi<{ metric_definitions: MetricDefinition[] }>("/api/portfolio/metric-definitions", [nonce]);
  const alerts = useApi<{ alerts: AlertRow[] }>("/api/portfolio/alerts?status=OPEN", [nonce]);
  const requests = useApi<{ support_requests: SupportRequestRow[] }>("/api/support/requests", [nonce]);
  const cockpit = useApi<Cockpit>("/api/portfolio/cockpit", [nonce]);
  const selected = useSelectedFund();
  const owned = useApi<Holdings>(
    selected.fund ? `/api/portfolio/holdings?fund_id=${encodeURIComponent(selected.fund.id)}` : "/api/portfolio/holdings",
    [selected.fund?.id, nonce],
  );

  const [companyId, setCompanyId] = useState("");
  const [metricName, setMetricName] = useState("");
  const [chosenMetric, setChosenMetric] = useState("");
  const [asOf, setAsOf] = useState(today());
  const [value, setValue] = useState("");
  const [ask, setAsk] = useState({ company_id: "", request_type: "HIRING", description: "" });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openRequest, setOpenRequest] = useState<string | null>(null);

  const isPartner = me.roles.includes("MANAGING_PARTNER");
  const companyList = companies.data?.companies ?? [];
  const tracked = definitions.data?.metric_definitions ?? [];
  const open = alerts.data?.alerts ?? [];
  const asks = requests.data?.support_requests ?? [];
  const own = owned.data;
  const currency = "USD";
  const fundName = selected.fund?.name ?? own?.holdings.find((h) => h.fund_name)?.fund_name ?? "the fund";
  const nameOf = (id: string) => companyList.find((c) => c.id === id)?.canonical_name ?? "a company";
  const labelOf = (key: string | null) => (key ? tracked.find((d) => d.metric_key === key)?.name ?? key : "Something we track");

  function refresh() {
    setNonce((n) => n + 1);
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

  // ── The masthead answer, derived from the counts the page already loads ──
  const totals = own?.totals;
  const awaiting = own?.holdings.filter((h) => h.standing === "awaiting").length ?? 0;
  const unbookedRows = own?.holdings.filter((h) => !h.booked) ?? [];
  const eyebrow = [
    new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
    totals ? `${totals.companies} holding${totals.companies === 1 ? "" : "s"}` : null,
    totals ? `${totals.booked} booked` : null,
    awaiting > 0 ? `${awaiting} waiting on a partner` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  let answer = "Reading what the firm owns…";
  let detail: string | null = null;
  if (totals) {
    if (totals.companies === 0) {
      answer = "The firm has invested in nothing yet.";
      detail = "A company appears here the moment a deal closes on Dealflow, and is booked to the fund from its row.";
    } else if (totals.unbooked === 0) {
      answer = `The firm owns ${totals.companies === 1 ? "one company" : `${totals.companies} companies`}, all booked to ${fundName}.`;
      detail = `${money(totals.invested, currency)} paid in; held at ${money(totals.held_at, currency)}${totals.unvalued > 0 ? ` with ${totals.unvalued} still at what was paid` : ""}.`;
    } else if (totals.companies === 1) {
      answer = awaiting > 0 ? "The firm owns one company, and its booking is waiting on a partner." : "The firm owns one company, and it is not booked.";
    } else {
      answer = `The firm owns ${totals.companies} companies, and ${totals.unbooked === 1 ? "one is" : `${totals.unbooked} are`} not booked.`;
    }
    if (totals.unbooked > 0 && detail === null) {
      const first = unbookedRows[0]!;
      const when = first.invested_on ? ` on ${day(first.invested_on)}` : "";
      detail = `${first.company} closed as ${first.amount_in !== null ? `a ${money(first.amount_in, currency)} ` : "an "}${KIND_WORDS[first.kind]?.toLowerCase() ?? "investment"}${first.vehicle ? ` via ${first.vehicle}` : ""}${when}${first.provisional ? " with stand-in figures" : ""}. Until it is booked it has no position, no mark and no place in ${fundName}'s performance.`;
    }
  }

  const concentration = own?.concentration;

  return (
    <section data-testid="portfolio-page">
      <div className="masthead" data-testid="portfolio-masthead">
        <p className="masthead-date">{eyebrow}</p>
        <h2 data-testid="portfolio-answer">{answer}</h2>
        {detail && <p className="masthead-second">{detail}</p>}
      </div>

      {/* ── What we own ─────────────────────────────────────────────────────────────────────── */}
      <section className="band" data-testid="holdings">
        <div className="band-head">
          <h3>What we own</h3>
          <span className="band-when">each row says whether it is booked</span>
        </div>
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

        {/* Said before anybody reads the figures, not discovered after quoting them. */}
        {own?.note && (
          <p className="notice notice-gate small" data-testid="holdings-honesty">
            {own.note}
          </p>
        )}

        <ul className="stack" data-testid="holdings-list">
          {owned.loading && !own && <li className="state-message" data-testid="holdings-list-loading">Loading…</li>}
          {(own?.holdings ?? []).map((h) => (
            <HoldingRow key={h.company_id} holding={h} me={me} isPartner={isPartner} funds={selected.funds} defaultFund={selected.fund?.id ?? null} onChanged={refresh} />
          ))}
          {own && own.totals.companies === 0 && (
            <li className="state-empty" data-testid="holdings-empty">
              The firm has invested in nothing yet. A company appears here the moment a deal closes on Dealflow, and is
              booked to the fund from its row — one save, one partner's approval.
            </li>
          )}
        </ul>

        {concentration && own && own.totals.companies > 0 && (
          <>
            <div className="hairline" />
            <ConcentrationView c={concentration} currency={currency} />
          </>
        )}
      </section>

      {/* ── What the portfolio is made of, and where the money is against the plan. The same two
          drawings Fund strategy hosts, from the same list as the rows above. ─────────────────── */}
      <section className="band" data-testid="portfolio-shape">
        <div className="band-head">
          <h3>What the portfolio is made of</h3>
          <span className="band-when">by money, not by headcount · the plan ring stays on Fund strategy</span>
        </div>
        <div className="two-col">
          <Composition level="h4" />
          <PortfolioAllocation fundId={selected.fund?.id ?? null} level="h4" />
        </div>
      </section>

      {/* ── What is going wrong right now ────────────────────────────────────────────────────── */}
      <section className="band">
        <div className="band-head">
          <h3>What is going wrong right now</h3>
          <span className="band-when">a figure moved the wrong way, or went unreported too long</span>
        </div>
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
      </section>

      {/* ── Which way each company is moving ─────────────────────────────────────────────────── */}
      <section className="band">
        <div className="band-head">
          <h3>Which way each company is moving</h3>
          <span className="band-when">the newest figure against the one before it</span>
        </div>
        <div className="card" data-testid="movement">
          <p className="muted small">
            Read against whether higher or lower is better for that figure. Exactly the comparison the flags above use, so
            the two can never tell you different things.
          </p>
          <div className="section-head">
            <h4>Going the wrong way</h4>
          </div>
          <ul className="card-list small" data-testid="deteriorating">
            {(cockpit.data?.deteriorating ?? []).map((t) => (
              <li key={`${t.company_id}-${t.metric}`}>
                <strong>{t.company}</strong> — {t.metric} {t.previous} → {t.latest} ({pct(t.change_pct)}) · <span className="muted">{t.window}</span>
              </li>
            ))}
            {(cockpit.data?.deteriorating ?? []).length === 0 && <li className="state-empty">Nothing is falling.</li>}
          </ul>

          <div className="section-head">
            <h4>Pulling ahead</h4>
          </div>
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
      </section>

      {/* ── Who we have not heard from ───────────────────────────────────────────────────────── */}
      <section className="band">
        <div className="band-head">
          <h3>Who we have not heard from</h3>
          <span className="band-when">against how long the firm said it would wait</span>
        </div>
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
      </section>

      {/* ── Where a company has asked for help ───────────────────────────────────────────────── */}
      <section className="band">
        <div className="band-head">
          <h3>Where a company has asked for help</h3>
          <span className="band-when">and whether help actually landed</span>
        </div>
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
      </section>

      {/* ── What they have reported — the old second tab, as a band ──────────────────────────── */}
      <Reporting me={me} />

      {/* ── Record what a company reported ───────────────────────────────────────────────────── */}
      <section className="band">
        <div className="band-head">
          <h3>Record what a company reported</h3>
          <span className="band-when">every figure is dated</span>
        </div>
        <div className="card">
          <p className="small">
            A number with no date invites somebody to quote it in a meeting without knowing whether it is from last month or
            last year.
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
      </section>

      {message && (
        <p className="notice" data-testid="portfolio-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

// ── The holding row, and everything that happens on it ─────────────────────────────────────────

type RowForm = "book" | "mark" | "reserve" | null;

/** The words for a standing, and the badge tone. Colour is never the only cue: the words say it. */
function standingWords(h: Holding, approver: string): { label: string; tone: string; sub: string | null } {
  switch (h.standing) {
    case "booked":
      return { label: `booked to ${h.fund_name ?? "the fund"}`, tone: "badge badge-ok", sub: h.sale ? "sale open on Dealflow" : null };
    case "draft":
      return { label: "draft", tone: "badge", sub: h.booking ? `saved ${day(h.booking.created_at.slice(0, 10))}, not yet sent` : null };
    case "awaiting":
      return { label: `awaiting ${approver}`, tone: "badge badge-gate", sub: "one card on Approvals — approving it books the position" };
    case "declined":
      return { label: "sent back", tone: "badge badge-bad", sub: "the partner did not approve these terms — edit and send again" };
    default:
      return { label: "not yet booked", tone: "badge badge-gate", sub: "closed, no position" };
  }
}

function HoldingRow({
  holding: h,
  me,
  isPartner,
  funds,
  defaultFund,
  onChanged,
}: {
  holding: Holding;
  me: MeResponse;
  isPartner: boolean;
  funds: Array<{ id: string; name: string }>;
  defaultFund: string | null;
  onChanged: () => void;
}) {
  const [form, setForm] = useState<RowForm>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const approver = approverFor(me);
  const standing = standingWords(h, approver);
  const currency = "USD";

  function toggle(next: RowForm) {
    setNotice(null);
    setForm((f) => (f === next ? null : next));
  }

  async function send(transactionId: string) {
    setBusy(true);
    const failed = mutationError(await api(`/api/transactions/${transactionId}/submit`, { method: "POST", body: {} }), [200, 201]);
    setBusy(false);
    setNotice(failed ? { tone: "bad", text: failed } : { tone: "ok", text: `Sent. ${approver} decides it on Approvals, and approving it books the position.` });
    if (!failed) onChanged();
  }

  async function sell() {
    setBusy(true);
    const res = await api<{ opportunity_id: string; already_open: boolean }>(`/api/holdings/${h.company_id}/sell`, { method: "POST", body: {} });
    setBusy(false);
    const failed = mutationError(res, [200, 201]);
    setNotice(
      failed
        ? { tone: "bad", text: failed }
        : { tone: "ok", text: res.data?.already_open ? "A sale is already open for this company on Dealflow." : "A sale is open on Dealflow. It walks the stages like any deal; nothing is sold until a partner approves the sale." },
    );
    if (!failed) onChanged();
  }

  const stageChip = h.stage ? (
    <span className="stage-chip stage-chip-closed" data-testid={`holding-stage-${h.company_id}`}>
      Invested
    </span>
  ) : null;

  const sub = [KIND_WORDS[h.kind] ?? "Investment", h.vehicle ? `via ${h.vehicle}` : null].filter(Boolean).join(" ") + [h.invested_on ? day(h.invested_on) : null, h.sector].filter(Boolean).map((s) => ` · ${s}`).join("");

  // The actions the row offers, which is the state machine made visible.
  const actions: JSX.Element[] = [];
  if (h.standing === "unbooked") {
    actions.push(
      <button
        key="book"
        type="button"
        className="btn-primary"
        data-testid={`holding-book-${h.company_id}`}
        aria-expanded={form === "book"}
        aria-controls={`holding-form-${h.company_id}`}
        disabled={!isPartner || busy}
        onClick={() => toggle("book")}
      >
        Book it
      </button>,
    );
  } else if (h.standing === "draft" && h.booking) {
    actions.push(
      <button key="send" type="button" className="btn-strong" data-testid={`holding-send-${h.company_id}`} disabled={!isPartner || busy} onClick={() => void send(h.booking!.transaction_id)}>
        Send for approval
      </button>,
    );
  } else if (h.standing === "declined" && h.booking) {
    actions.push(
      <button key="resend" type="button" className="btn-strong" data-testid={`holding-send-${h.company_id}`} disabled={!isPartner || busy} onClick={() => void send(h.booking!.transaction_id)}>
        Send again
      </button>,
    );
  } else if (h.standing === "awaiting") {
    actions.push(
      <button key="book" type="button" className="btn-primary" data-testid={`holding-book-${h.company_id}`} disabled title="Its card is waiting on a partner. Approving the card books it.">
        Book it
      </button>,
    );
    if (h.booking?.approval_card_id) {
      actions.push(
        <a key="card" className="link-button" href="#/approvals" data-testid={`holding-card-${h.company_id}`}>
          Open the card
        </a>,
      );
    }
  } else if (h.standing === "booked" && h.position_id) {
    actions.push(
      <button key="mark" type="button" className="btn-ghost" data-testid={`holding-mark-${h.company_id}`} aria-expanded={form === "mark"} aria-controls={`holding-form-${h.company_id}`} disabled={!isPartner || busy} onClick={() => toggle("mark")}>
        Mark it
      </button>,
      <button key="reserve" type="button" className="btn-ghost" data-testid={`holding-reserve-${h.company_id}`} aria-expanded={form === "reserve"} aria-controls={`holding-form-${h.company_id}`} disabled={!isPartner || busy} onClick={() => toggle("reserve")}>
        Reserve for it
      </button>,
    );
    if (h.sale) {
      actions.push(
        <a key="sale" className="link-button" href="#/dealflow" data-testid={`holding-sale-${h.company_id}`}>
          Open the sale
        </a>,
      );
    } else {
      actions.push(
        <button key="sell" type="button" className="btn-ghost" data-testid={`holding-sell-${h.company_id}`} disabled={!isPartner || busy} onClick={() => void sell()}>
          Sell
        </button>,
      );
    }
  }

  return (
    <li data-testid={`holding-${h.company_id}`}>
      <div className={`holding-row ${form ? "is-open" : ""}`} data-testid={`holding-row-${h.company_id}`}>
        <div>
          <strong>{h.company}</strong> {stageChip}
          <div className="muted small">
            {sub}
            {h.stage?.backfilled ? " · entered as history" : ""}
          </div>
        </div>
        <div className="kv" data-testid={`holding-paid-${h.company_id}`}>
          <b>Paid</b>
          {h.amount_in !== null ? money(h.amount_in, currency) : "not recorded"}
          {h.provisional ? <span className="muted small"> · stand-in</span> : null}
          {h.shares ? (
            <div className="muted small">
              {count(h.shares.quantity)} shares{h.shares.price_per_share !== null ? ` @ ${moneyExact(h.shares.price_per_share, currency)}` : ""}
            </div>
          ) : h.booking && h.standing !== "unbooked" ? (
            <div className="muted small">
              {count(h.booking.quantity)} shares @ {moneyExact(h.booking.price_per_share, currency)} · {money(h.booking.net_amount, currency)}
            </div>
          ) : null}
        </div>
        <div className="stack">
          <div className="kv" data-testid={`holding-owned-${h.company_id}`}>
            <b>Owned</b>
            {h.ownership_pct !== null ? `${h.ownership_pct}%` : <span className="muted">not recorded</span>}
            {h.ownership_as_of ? <span className="muted small"> · {day(h.ownership_as_of)}</span> : null}
          </div>
          <div className="kv" data-testid={`holding-reserved-${h.company_id}`}>
            <b>Reserved</b>
            {h.reserve ? money(h.reserve.amount, currency) : <span className="muted">{h.booked ? "none set" : "—"}</span>}
            {h.reserve ? <span className="muted small"> · {day(h.reserve.as_of)}</span> : null}
          </div>
        </div>
        <div className="kv" data-testid={`holding-held-${h.company_id}`}>
          <b>Held at</b>
          {h.valuation ? (
            <>
              {money(h.valuation.value, currency)}
              <div className="muted small">
                {(MARK_SOURCES.find((s) => s.key === h.valuation!.source)?.label ?? h.valuation.source).toLowerCase()}, {day(h.valuation.as_of)}
              </div>
            </>
          ) : h.booked ? (
            <>
              {h.amount_in !== null ? money(h.amount_in, currency) : "—"}
              <div className="muted small">still just what we paid</div>
            </>
          ) : (
            <>
              —<div className="muted small">no valuation until booked</div>
            </>
          )}
        </div>
        <div className="stack" data-testid={`holding-standing-${h.company_id}`}>
          <div>
            <span className={standing.tone}>{standing.label}</span>
            {h.sale && h.standing === "booked" ? (
              <>
                {" "}
                <span className="badge" data-testid={`holding-sale-open-${h.company_id}`}>
                  sale open
                </span>
              </>
            ) : null}
          </div>
          {standing.sub && <div className="muted small">{standing.sub}</div>}
          <div className="muted small">
            {h.last_check_in ? `last heard from ${day(h.last_check_in)}` : "never reported a figure"}
            {h.open_alerts > 0 ? ` · ${h.open_alerts} flagged` : ""}
            {h.open_asks > 0 ? ` · ${h.open_asks} open ask${h.open_asks === 1 ? "" : "s"}` : ""}
            {h.open_follow_on_reviews > 0 ? " · follow-on under review" : ""}
          </div>
          {actions.length > 0 && <div className="row">{actions}</div>}
          {!isPartner && h.standing === "unbooked" && (
            <div className="muted small" data-testid={`holding-book-reason-${h.company_id}`}>
              Booking is reserved for a Managing Partner; you hold {me.roles.join(", ") || "no role"}.
            </div>
          )}
        </div>
      </div>

      {form === "book" && (
        <BookItForm
          holding={h}
          approver={approver}
          funds={funds}
          defaultFund={defaultFund}
          onDone={(text) => {
            setForm(null);
            setNotice({ tone: "ok", text });
            onChanged();
          }}
          onCancel={() => setForm(null)}
        />
      )}
      {form === "mark" && h.position_id && (
        <MarkForm
          positionId={h.position_id}
          onDone={(text) => {
            setForm(null);
            setNotice({ tone: "ok", text });
            onChanged();
          }}
          onCancel={() => setForm(null)}
        />
      )}
      {form === "reserve" && h.position_id && (
        <ReserveForm
          positionId={h.position_id}
          current={h.reserve}
          onDone={(text) => {
            setForm(null);
            setNotice({ tone: "ok", text });
            onChanged();
          }}
          onCancel={() => setForm(null)}
        />
      )}
      {notice && (
        <p className={notice.tone === "bad" ? "notice notice-bad small" : "notice small"} role="status" data-testid={`holding-notice-${h.company_id}`}>
          {notice.text}
        </p>
      )}
    </li>
  );
}

// ── Book it: the inline form (artboard G2, and its eight states) ────────────────────────────────

type MoneyState = "default" | "error" | "success";

/**
 * A money input in its class forms (`.in-error`, `.in-success`): the border width is constant and
 * only the colour changes, so a field flipping state never shifts the layout. Three explicit
 * branches rather than a computed string, because `validate:css-classes` reads literal classNames.
 */
const MoneyInput = forwardRef<HTMLInputElement, { state: MoneyState } & React.InputHTMLAttributes<HTMLInputElement>>(function MoneyInput({ state, ...rest }, ref) {
  if (state === "error") return <input {...rest} ref={ref} className="input-money in-error" inputMode="decimal" />;
  if (state === "success") return <input {...rest} ref={ref} className="input-money in-success" inputMode="decimal" />;
  return <input {...rest} ref={ref} className="input-money" inputMode="decimal" />;
});

interface SecurityClass {
  id: string;
  class_name: string;
}

type BookField = "class" | "price" | "quantity" | "date" | "vehicle" | "fund";

/**
 * The money inputs on this form: `aria-invalid` + the danger border + words that name the field
 * and say what to do; the helper slot reserves one line so an error never shifts the layout.
 *
 * NOTHING HERE PRE-FILLS PRICE OR COUNT. The record's figures may be stand-ins (Sensori's $1 ×
 * 10,000), and a form that put them in the boxes would invite the partner to save the placeholder
 * as if it were the fact. Date and vehicle are real facts on the closed record and are offered.
 */
function BookItForm({
  holding: h,
  approver,
  funds,
  defaultFund,
  onDone,
  onCancel,
}: {
  holding: Holding;
  approver: string;
  funds: Array<{ id: string; name: string }>;
  defaultFund: string | null;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const classes = useApi<{ security_classes: SecurityClass[] }>(`/api/security-classes?company_id=${encodeURIComponent(h.company_id)}`);
  const allFunds = useApi<{ funds: Array<{ id: string; name: string }> }>(funds.length === 0 ? "/api/funds" : null);
  const fundList = funds.length > 0 ? funds : (allFunds.data?.funds ?? []);
  const available = classes.data?.security_classes ?? [];
  const NEW_CLASS = "__new__";

  const [classId, setClassId] = useState<string>("");
  const [className, setClassName] = useState("");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [date, setDate] = useState(h.invested_on ?? today());
  const [vehicle, setVehicle] = useState(h.vehicle ?? VEHICLES[0]);
  const [fundId, setFundId] = useState(defaultFund ?? "");
  const [errors, setErrors] = useState<Partial<Record<BookField, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const first = useRef<HTMLSelectElement>(null);

  // First field takes focus; Esc is Never mind (§11, keyboard).
  useEffect(() => {
    first.current?.focus();
  }, []);
  useEffect(() => {
    if (available.length > 0 && !classId) setClassId(available[0]!.id);
    if (available.length === 0 && classes.data && !classId) setClassId(NEW_CLASS);
  }, [available, classes.data, classId]);
  useEffect(() => {
    if (!fundId && fundList.length > 0) setFundId(fundList[0]!.id);
  }, [fundId, fundList]);

  const priceNum = Number(price.replace(/[,$\s]/g, ""));
  const quantityNum = Number(quantity.replace(/[,\s]/g, ""));
  const costBasis = Number.isFinite(priceNum) && Number.isFinite(quantityNum) && priceNum > 0 && quantityNum > 0 ? priceNum * quantityNum : null;

  function validate(): Partial<Record<BookField, string>> {
    const e: Partial<Record<BookField, string>> = {};
    if (!classId || (classId === NEW_CLASS && className.trim().length < 2)) e.class = "Name the share class — Common, SPV interest, Series Seed Preferred.";
    if (!price.trim() || !Number.isFinite(priceNum) || priceNum <= 0) e.price = "Price per share must be a number above zero.";
    if (!quantity.trim() || !Number.isFinite(quantityNum) || quantityNum <= 0) e.quantity = "Share count must be a number above zero.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) e.date = "Say when the money went in, as a date.";
    if (!vehicle.trim()) e.vehicle = "Say which entity holds it.";
    if (!fundId) e.fund = "Pick the fund the position is booked to.";
    return e;
  }

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    setFailure(null);
    if (Object.keys(e).length > 0) return;
    setSaving(true);
    const res = await api<{ approval_card_id: string | null; healed: string[] }>(`/api/holdings/${h.company_id}/book`, {
      method: "POST",
      body: {
        ...(h.opportunity_id ? { opportunity_id: h.opportunity_id } : {}),
        ...(classId === NEW_CLASS ? { class_name: className.trim() } : { security_class_id: classId }),
        price_per_share: priceNum,
        quantity: quantityNum,
        transaction_date: date,
        vehicle: vehicle.trim(),
        fund_id: fundId,
      },
    });
    setSaving(false);
    const failed = mutationError(res, 201);
    if (failed) {
      setFailure(`Not saved: ${failed}`);
      return;
    }
    const healed = res.data?.healed?.length ? " The stand-ins on the deal record now read what you typed." : "";
    onDone(`Saved and sent to ${approver}. Approving the card books ${h.company} to the fund — nothing more to do here.${healed}`);
  }

  const help = (field: BookField, text: string) =>
    errors[field] ? (
      <span className="field-help err" id={`book-${field}-help-${h.company_id}`} role="alert">
        {errors[field]}
      </span>
    ) : (
      <span className="field-help" id={`book-${field}-help-${h.company_id}`}>
        {text}
      </span>
    );
  const inputState = (field: BookField, filled: boolean): MoneyState => (errors[field] ? "error" : filled ? "success" : "default");

  return (
    <form
      className="holding-form"
      id={`holding-form-${h.company_id}`}
      data-testid={`holding-form-${h.company_id}`}
      onSubmit={(ev) => void save(ev)}
      onKeyDown={(ev) => {
        if (ev.key === "Escape") {
          ev.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="book-grid">
        <label className="field">
          Share class
          <select
            ref={first}
            data-testid={`book-class-${h.company_id}`}
            value={classId}
            aria-invalid={errors.class ? true : undefined}
            aria-describedby={`book-class-help-${h.company_id}`}
            onChange={(e) => setClassId(e.target.value)}
          >
            {available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.class_name}
              </option>
            ))}
            <option value={NEW_CLASS}>— add a class —</option>
          </select>
          {classId === NEW_CLASS && (
            <input
              data-testid={`book-class-name-${h.company_id}`}
              value={className}
              aria-label="Name of the new share class"
              aria-invalid={errors.class ? true : undefined}
              placeholder="SPV interest"
              onChange={(e) => setClassName(e.target.value)}
            />
          )}
          {help("class", available.length > 0 ? "From the company's security classes" : "Shares are shares of something — name the class once")}
        </label>
        <label className="field">
          Price per share
          <MoneyInput
            state={inputState("price", price.trim().length > 0)}
            data-testid={`book-price-${h.company_id}`}
            value={price}
            aria-invalid={errors.price ? true : undefined}
            aria-describedby={`book-price-help-${h.company_id}`}
            onChange={(e) => setPrice(e.target.value)}
          />
          {help("price", h.provisional ? "The record holds a stand-in · saving replaces it" : "What was paid per share")}
        </label>
        <label className="field">
          Share count
          <MoneyInput
            state={inputState("quantity", quantity.trim().length > 0)}
            data-testid={`book-quantity-${h.company_id}`}
            value={quantity}
            aria-invalid={errors.quantity ? true : undefined}
            aria-describedby={`book-quantity-help-${h.company_id}`}
            onChange={(e) => setQuantity(e.target.value)}
          />
          {help("quantity", h.provisional ? "The record holds a stand-in · saving replaces it" : "How many the fund holds")}
        </label>
        <label className="field">
          Date
          <input
            type="date"
            data-testid={`book-date-${h.company_id}`}
            value={date}
            aria-invalid={errors.date ? true : undefined}
            aria-describedby={`book-date-help-${h.company_id}`}
            onChange={(e) => setDate(e.target.value)}
          />
          {help("date", "When the money went in")}
        </label>
        <label className="field">
          Vehicle
          <select data-testid={`book-vehicle-${h.company_id}`} value={vehicle} aria-describedby={`book-vehicle-help-${h.company_id}`} onChange={(e) => setVehicle(e.target.value)}>
            {[...new Set<string>([...VEHICLES, ...(h.vehicle ? [h.vehicle] : [])])].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          {help("vehicle", "Which entity holds it")}
        </label>
        <label className="field">
          Fund
          <select data-testid={`book-fund-${h.company_id}`} value={fundId} aria-invalid={errors.fund ? true : undefined} aria-describedby={`book-fund-help-${h.company_id}`} onChange={(e) => setFundId(e.target.value)}>
            {fundList.length === 0 && <option value="">— no fund recorded —</option>}
            {fundList.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          {help("fund", "Where the position is booked")}
        </label>
      </div>
      <div className="row between">
        <span className="muted small kv" data-testid={`book-cost-${h.company_id}`}>
          <b>Cost basis</b>
          {costBasis !== null ? <strong className="mono">{money(costBasis, "USD")}</strong> : <span>works out from price × count</span>}
          {h.provisional && costBasis !== null ? " · saving replaces the stand-ins on the deal record" : ""}
        </span>
        <span className="row">
          <button type="button" className="btn-ghost" data-testid={`book-cancel-${h.company_id}`} disabled={saving} onClick={onCancel}>
            Never mind
          </button>
          <button type="submit" className="btn-strong" data-testid={`book-save-${h.company_id}`} disabled={saving} aria-busy={saving || undefined}>
            {saving ? "Saving…" : `Save and send to ${approver}`}
          </button>
        </span>
      </div>
      {failure && (
        <p className="notice notice-bad small" role="alert" data-testid={`book-error-${h.company_id}`}>
          {failure} Fix it and save again.
        </p>
      )}
    </form>
  );
}

// ── Mark it, inline on the booked row ───────────────────────────────────────────────────────────

function MarkForm({ positionId, onDone, onCancel }: { positionId: string; onDone: (message: string) => void; onCancel: () => void }) {
  const [mark, setMark] = useState({ value: "", source: "LAST_ROUND", basis: "", as_of_date: today() });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);

  async function recordMark(ev: React.FormEvent) {
    ev.preventDefault();
    const value = Number(mark.value.replace(/[,$\s]/g, ""));
    if (!mark.value.trim() || !Number.isFinite(value) || value < 0) {
      setError("Say what it is worth now, as a number.");
      return;
    }
    if (mark.source !== "COST" && !mark.basis.trim()) {
      setError("Say what this rests on — the round, the valuation, or why it was written down. It is the question an investor asks.");
      return;
    }
    setBusy(true);
    const failed = mutationError(
      await api(`/api/positions/${positionId}/mark`, {
        method: "POST",
        body: { value, source: mark.source, basis: mark.basis.trim() || undefined, as_of_date: mark.as_of_date },
      }),
      201,
    );
    setBusy(false);
    if (failed) {
      setError(failed);
      return;
    }
    onDone("Recorded. The old figure is kept — a valuation is superseded, never overwritten.");
  }

  return (
    <form
      className="holding-form"
      data-testid="mark-form"
      onSubmit={(ev) => void recordMark(ev)}
      onKeyDown={(ev) => {
        if (ev.key === "Escape") {
          ev.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="form-row">
        <label className="field">
          Worth now
          <MoneyInput ref={first} state={error && !mark.value.trim() ? "error" : "default"} data-testid="mark-value" value={mark.value} aria-invalid={error && !mark.value.trim() ? true : undefined} onChange={(e) => setMark((m) => ({ ...m, value: e.target.value }))} placeholder="2500000" />
          <span className="field-help">&nbsp;</span>
        </label>
        <label className="field">
          On what basis
          <select data-testid="mark-source" value={mark.source} onChange={(e) => setMark((m) => ({ ...m, source: e.target.value }))}>
            {MARK_SOURCES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <span className="field-help">&nbsp;</span>
        </label>
        <label className="field grow">
          Say more
          <input data-testid="mark-basis" value={mark.basis} onChange={(e) => setMark((m) => ({ ...m, basis: e.target.value }))} placeholder="Seed at $12M post, September 2026" />
          <span className="field-help">A valuation is superseded, never overwritten</span>
        </label>
        <label className="field">
          As of
          <input type="date" data-testid="mark-date" value={mark.as_of_date} onChange={(e) => setMark((m) => ({ ...m, as_of_date: e.target.value }))} />
          <span className="field-help">&nbsp;</span>
        </label>
        <button type="button" className="btn-ghost" disabled={busy} onClick={onCancel}>
          Never mind
        </button>
        <button type="submit" className="btn-strong" disabled={busy} data-testid="mark-submit" aria-busy={busy || undefined}>
          {busy ? "Recording…" : "Record it"}
        </button>
      </div>
      {error && (
        <p className="notice notice-bad small" role="alert" data-testid="mark-error">
          {error}
        </p>
      )}
    </form>
  );
}

// ── Reserve for it, inline on the booked row ────────────────────────────────────────────────────

function ReserveForm({
  positionId,
  current,
  onDone,
  onCancel,
}: {
  positionId: string;
  current: { amount: number; as_of: string; note: string | null } | null;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [asOf, setAsOf] = useState(today());
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);

  async function reserve(ev: React.FormEvent) {
    ev.preventDefault();
    const n = Number(amount.replace(/[,$\s]/g, ""));
    if (!amount.trim() || !Number.isFinite(n) || n < 0) {
      setError("Say how much to hold back for this company, as a number. Zero clears it.");
      return;
    }
    setBusy(true);
    const failed = mutationError(await api(`/api/positions/${positionId}/reserve`, { method: "POST", body: { amount: n, as_of_date: asOf, note: note.trim() || undefined } }), 201);
    setBusy(false);
    if (failed) {
      setError(failed);
      return;
    }
    onDone(`Reserved ${money(n, "USD")} for it. The fund-level reserve on Fund strategy is still the plan; this is the share earmarked for this company.`);
  }

  return (
    <form
      className="holding-form"
      data-testid="reserve-form"
      onSubmit={(ev) => void reserve(ev)}
      onKeyDown={(ev) => {
        if (ev.key === "Escape") {
          ev.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="form-row">
        <label className="field">
          Reserve for it
          <MoneyInput ref={first} state={error ? "error" : "default"} data-testid="reserve-amount" value={amount} aria-invalid={error ? true : undefined} onChange={(e) => setAmount(e.target.value)} placeholder="250000" />
          <span className="field-help">{current ? `Now ${money(current.amount, "USD")} as of ${day(current.as_of)}` : "Follow-on capital earmarked for this company"}</span>
        </label>
        <label className="field">
          As of
          <input type="date" data-testid="reserve-date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          <span className="field-help">&nbsp;</span>
        </label>
        <label className="field grow">
          Why
          <input data-testid="reserve-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="the seed extension they are raising in Q1" />
          <span className="field-help">A reserve is superseded, never edited</span>
        </label>
        <button type="button" className="btn-ghost" disabled={busy} onClick={onCancel}>
          Never mind
        </button>
        <button type="submit" className="btn-strong" disabled={busy} data-testid="reserve-submit" aria-busy={busy || undefined}>
          {busy ? "Reserving…" : "Reserve it"}
        </button>
      </div>
      {error && (
        <p className="notice notice-bad small" role="alert" data-testid="reserve-error">
          {error}
        </p>
      )}
    </form>
  );
}

// ── Ownership concentration: ranked bars by % of committed and $ at cost ────────────────────────

/** The level in words first; the colour follows the words (non-colour cue, §11). */
const LEVEL_WORDS: Record<"ok" | "near" | "at", { word: string | null; color: string }> = {
  ok: { word: null, color: "var(--viz-1)" },
  near: { word: "near the cap", color: "var(--wp-warn)" },
  at: { word: "at the cap", color: "var(--wp-danger)" },
};

function ConcentrationView({ c, currency }: { c: Concentration; currency: string }) {
  const top = c.rows[0];
  const maxPct = Math.max(...c.rows.map((r) => r.pct_of_committed), c.max_single_company_pct ?? 0, 0.0001);
  return (
    <div className="viz-row" data-testid="concentration">
      <ul className="legend grow" data-testid="concentration-list">
        {c.rows.map((r) => {
          const level = LEVEL_WORDS[r.level];
          return (
            <li key={r.company_id} data-testid={`concentration-${r.company_id}`}>
              <span className="sw" style={{ background: level.color }} aria-hidden="true" />
              <span className="legend-label">
                {r.company}
                {level.word ? <span className="muted small"> · {level.word}</span> : null}
                {r.ownership_pct !== null ? <span className="muted small"> · {r.ownership_pct}% owned</span> : null}
                <span className="bar" role="img" aria-label={`${r.company}: ${r.pct_of_committed.toFixed(2)}% of committed capital at cost`}>
                  <i style={{ width: `${Math.max(1, (r.pct_of_committed / maxPct) * 100)}%`, background: level.color }} />
                </span>
              </span>
              <span className="legend-val">{money(r.at_cost_usd, currency)}</span>
              <span className="legend-pct">{r.pct_of_committed < 0.1 && r.pct_of_committed > 0 ? "<0.1%" : `${r.pct_of_committed.toFixed(1)}%`}</span>
            </li>
          );
        })}
      </ul>
      <p className="muted small" data-testid="concentration-line">
        {c.max_single_company_pct !== null && c.cap_usd !== null
          ? `Ownership concentration: the plan caps one company at ${c.max_single_company_pct}% of committed capital, ${money(c.cap_usd, currency)}.${top ? ` ${top.company} is ${top.pct_of_committed < 0.1 && top.pct_of_committed > 0 ? "under 0.1%" : `${top.pct_of_committed.toFixed(2)}%`} of it${top.level === "at" ? " — at the cap" : top.level === "near" ? " — near the cap" : ""}.` : ""} A row says “near the cap” at 80% of it and “at the cap” when it is reached.`
          : c.committed_usd > 0
            ? `Ownership concentration, at cost, against ${money(c.committed_usd, currency)} committed. No concentration cap is set on Fund strategy yet, so no row can be near or at one.`
            : "Ownership concentration needs a fund size. Set the thesis on Fund strategy and the cap draws here."}
      </p>
    </div>
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
      <div className="section-head">
        <h4>{r.description}</h4>
      </div>

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
 * What the companies themselves sent in, and how it reads over a month and over a quarter — the
 * old second tab, as a band (design §6: "What they have reported (the old second tab, as a band)").
 *
 * Operator, item 12: the host employee "parses inbound updates emailed to os@joinwestpeek.com and
 * summarises month-over-month and quarter-over-quarter."
 *
 * AN EMAIL OPENS A JOB, IT DOES NOT SET A NUMBER. A founder's update arriving with a hashtag becomes
 * a piece of work for Winter, who reads it and records what it says. That is the whole reason this
 * band can be trusted: the figures the fund reports to its own investors are ones somebody at the
 * firm wrote down, not ones an unauthenticated email asserted.
 */
function Reporting({ me }: { me: MeResponse }) {
  const [nonce, setNonce] = useState(0);
  const view = useApi<ReportingView>("/api/portfolio/reporting", [nonce]);
  const companies = useApi<{ companies: CompanyRow[] }>("/api/companies");
  const [form, setForm] = useState({ company_id: "", period_label: "", received_at: today(), summary: "" });
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
    setMessage(failed ?? "Filed. Record the figures it contains below, so they count towards the comparisons here.");
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
                Nothing has two figures far enough apart to compare. Record what a company reported below, and this fills
                in as the second month lands.
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
    <section className="band" data-testid="reporting">
      <div className="band-head">
        <h3>What they have reported</h3>
        <span className="band-when">
          {v ? `${v.updates.length} update${v.updates.length === 1 ? "" : "s"} on file` : "what the companies sent in"}
          {v && v.waiting_count > 0 ? ` · ${v.waiting_count} not yet read` : ""}
        </span>
      </div>
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

      <div className="section-head">
        <h4>Month on month</h4>
      </div>
      {table(v?.month_over_month ?? [], "mom-table")}
      {gaps(v?.month_over_month_skipped ?? [], "mom-gaps")}

      <div className="section-head">
        <h4>Quarter on quarter</h4>
      </div>
      {table(v?.quarter_over_quarter ?? [], "qoq-table")}
      {gaps(v?.quarter_over_quarter_skipped ?? [], "qoq-gaps")}

      <div className="section-head">
        <h4>The write-up</h4>
      </div>
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

      <div className="section-head">
        <h4>File an update that came another way</h4>
      </div>
      <div className="card">
        <p className="small">Somebody rang, or it landed in a partner's own inbox. Record that it arrived, then put its figures below.</p>
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
    </section>
  );
}
