import { useState } from "react";
import { api, mutationError, useApi, type MeResponse } from "../lib/api";

/**
 * Limited partners — who they are, what they have committed, and where the raise stands.
 *
 * WHAT WAS WRONG, in the operator's words: "LP page rebuilt in human language; i have no idea what
 * a claim is." The page opened with `EXTERNAL VDR UNPROVEN — PROVIDER NOT SELECTED`, a heading
 * reading `LP records (LP_PRIVATE)`, and controls labelled "Working claim", "VERIFIED evidence" and
 * "Approval receipt". Every one of those is a word from inside the machine.
 *
 * THE VOCABULARY WAS THE SMALLER HALF. There was nowhere in the entire system to record how much
 * money an LP had committed, or how big the fund is. A page about limited partners could not answer
 * the only two questions anybody asks about limited partners — so this leads with those and the
 * governance machinery sits underneath, in plain words, for the days it is actually needed.
 *
 * SIGNED AND SOFT ARE NEVER ADDED TOGETHER. A verbal yes over dinner tells a partner where the
 * raise stands and belongs on this page. It does not belong in the same number as a signed
 * subscription, because the moment those are one figure labelled "raised", the fund's headline is a
 * hope.
 */

interface FundRaise {
  id: string;
  name: string;
  currency: string;
  vintage_year: number | null;
  target: number | null;
  signed: number;
  signed_count: number;
  soft: number;
  soft_count: number;
  percent_of_target: number | null;
}

interface CommitmentRow {
  id: string;
  lp_name: string;
  lp_record_id: string;
  fund_name: string;
  fund_id: string;
  amount: number;
  currency: string;
  state: string;
  committed_on: string | null;
  note: string | null;
}

interface LpRecordRow {
  id: string;
  legal_name: string;
  lp_type: string;
  status: string;
}

/** The words a partner would use, not the enum. */
const LP_KINDS = [
  { key: "FAMILY_OFFICE", label: "Family office" },
  { key: "INDIVIDUAL", label: "An individual" },
  { key: "INSTITUTION", label: "Institution — endowment, foundation, pension" },
  { key: "FUND_OF_FUNDS", label: "Fund of funds" },
  { key: "CORPORATE", label: "A company" },
  { key: "OTHER", label: "Something else" },
] as const;

const STATES = [
  { key: "SOFT", label: "Said yes, not signed" },
  { key: "SIGNED", label: "Signed" },
  { key: "WITHDRAWN", label: "Fell through" },
] as const;

function money(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
}


interface PeriodRow {
  id: string;
  fund_id: string;
  label: string;
  period_start: string;
  period_end: string;
  status: string;
}

interface PacketRow {
  id: string;
  period_id: string;
  version: number;
  title: string;
  status: string;
  distributed_at: string | null;
}

/**
 * What the fund has told its investors, folded into the page about the investors.
 *
 * Operator, item 16: "LP page rebuilt in human language; reporting folded in." They were two tabs
 * for one relationship — an LP is somebody who gave the fund money and whom the fund owes an
 * account of it, and splitting those meant answering "what has Cedar been told?" required knowing
 * that packets live somewhere else.
 *
 * WHAT THE OLD PAGE OPENED WITH, verbatim: "NO FINANCIAL, ACCOUNTING, OR VALUATION CORRECTNESS IS
 * CERTIFIED — this surface records process, review, and discrepancy only" and "UNPROVEN — FUND-ADMIN
 * SOURCE CONTRACT GATE". Both are true and neither is a sentence. They said the same thing a
 * partner needs to know — this records what you sent, it does not audit your numbers — in a voice
 * nobody reads twice.
 *
 * A PERIOD IS A QUARTER YOU OWE A LETTER FOR. A packet is the letter. Reviews are the people who
 * have to read it before it goes. That is the whole model, and it did not need three headings of
 * vocabulary to say.
 */
function ReportingSection({ funds }: { funds: FundRaise[] }) {
  const [nonce, setNonce] = useState(0);
  const periods = useApi<{ periods: PeriodRow[] }>("/api/reporting/periods", [nonce]);
  const packets = useApi<{ packets: PacketRow[] }>("/api/reporting/packets", [nonce]);
  const [fundId, setFundId] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const rows = periods.data?.periods ?? [];
  const packs = packets.data?.packets ?? [];

  async function openPeriod() {
    const fund = fundId || funds[0]?.id;
    if (!fund || label.trim().length < 2) {
      setMessage("Which fund, and what do you call this period? “Q1 2026” is enough.");
      return;
    }
    setBusy(true);
    // Dates are derived from the label where it looks like a quarter, because typing two ISO dates
    // to say "Q1" is the kind of small tax that stops a thing being used.
    const quarter = /Q([1-4])\s*(20\d\d)/i.exec(label);
    const bounds = quarter
      ? {
          period_start: `${quarter[2]}-${String((Number(quarter[1]) - 1) * 3 + 1).padStart(2, "0")}-01`,
          period_end: `${quarter[2]}-${String(Number(quarter[1]) * 3).padStart(2, "0")}-${Number(quarter[1]) === 1 ? "31" : Number(quarter[1]) === 2 ? "30" : Number(quarter[1]) === 3 ? "30" : "31"}`,
        }
      : null;
    if (!bounds) {
      setBusy(false);
      setMessage("Name it like “Q1 2026” so the dates can be worked out.");
      return;
    }
    const failed = mutationError(
      await api("/api/reporting/periods", { method: "POST", body: { fund_id: fund, label: label.trim(), ...bounds } }),
      201,
    );
    setBusy(false);
    setMessage(failed ?? `${label.trim()} opened. Draft the letter, then it needs its reviews before it goes out.`);
    if (!failed) {
      setLabel("");
      setNonce((n) => n + 1);
    }
  }

  return (
    <>
      <h3>What we have told them</h3>
      <div className="card">
        <p className="small">
          Each quarter the fund owes its investors an account of it. A period is that quarter; the
          letter is what goes out; the reviews are who has to read it first.
        </p>
        {/* The disclaimer, said once and in a sentence. It used to be shouted twice in capitals. */}
        <p className="muted small">
          This records what was sent and who signed it off. It does not check whether the numbers in
          it are right — that is the administrator's job, and comparing the two is below.
        </p>

        <div className="form-row" data-testid="period-form">
          <label>
            Fund{" "}
            <select data-testid="period-fund" value={fundId} onChange={(e) => setFundId(e.target.value)}>
              {funds.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Which period{" "}
            <input
              className="input-money"
              data-testid="period-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Q1 2026"
            />
          </label>
          <button type="button" disabled={busy || funds.length === 0} data-testid="period-open" onClick={() => void openPeriod()}>
            Start this period's letter
          </button>
        </div>

        <ul className="card-list small" data-testid="period-list">
          {rows.map((p) => {
            const mine = packs.filter((k) => k.period_id === p.id);
            const out = mine.find((k) => k.distributed_at);
            return (
              <li key={p.id} data-testid={`period-${p.id}`}>
                <strong>{p.label}</strong>{" "}
                {out ? (
                  <span className="muted">sent {new Date(out.distributed_at!).toLocaleDateString()}</span>
                ) : mine.length > 0 ? (
                  <span className="muted">drafted, not sent yet — {mine[0]!.status.toLowerCase().split("_").join(" ")}</span>
                ) : (
                  <span className="muted">nothing drafted yet</span>
                )}
              </li>
            );
          })}
          {rows.length === 0 && (
            <li className="state-empty">
              No period has been opened. Investors are owed an account each quarter; this is where it
              starts.
            </li>
          )}
        </ul>

        {message && (
          <p className="notice small" data-testid="reporting-message" role="status">
            {message}
          </p>
        )}
      </div>
    </>
  );
}


interface ExceptionRow {
  id: string;
  record_kind: string;
  field: string;
  administrator_value: string;
  internal_value: string;
  difference: string | null;
  status: string;
}

/**
 * Whether the administrator's books agree with ours.
 *
 * KEPT, and moved here with the rest of reporting, because it is the step BEFORE a letter goes out.
 * Telling investors a number the fund administrator disagrees with is the single most expensive
 * mistake available on this page, and the check for it lived on a different tab.
 *
 * WHAT THE OLD PAGE SAID: "UNPROVEN — FUND-ADMIN SOURCE CONTRACT GATE (no live administrator system
 * is configured; West Peek OS never writes to one)". True, and unreadable. It means: nobody has
 * connected an administrator yet, so the numbers are typed in by hand — which is worth knowing and
 * is not worth a line of capitals.
 *
 * A DIFFERENCE IS A FINDING, NOT AN ERROR. The two systems disagreeing is normal and is exactly what
 * this is for; what matters is that it is written down and resolved by a person rather than
 * flattened by whichever number was entered second.
 */
function ReconciliationSection({ funds }: { funds: FundRaise[] }) {
  const [nonce, setNonce] = useState(0);
  const exceptions = useApi<{ exceptions: ExceptionRow[] }>("/api/reconciliation/exceptions", [nonce]);
  const [fundId, setFundId] = useState("");
  const [adminNav, setAdminNav] = useState("");
  const [ourNav, setOurNav] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const rows = exceptions.data?.exceptions ?? [];

  async function compare() {
    const fund = fundId || funds[0]?.id;
    if (!fund || !adminNav.trim() || !ourNav.trim()) {
      setMessage("Both numbers, please — there is nothing to compare with one.");
      return;
    }
    setBusy(true);
    const failed = mutationError(
      await api("/api/reconciliation/runs", {
        method: "POST",
        body: {
          fund_id: fund,
          source_system: "fund_administrator",
          source_reference: "entered by hand",
          administrator_records: [{ record_kind: "NAV", record_key: "fund", field: "nav", value: adminNav.trim() }],
          internal_records: [{ record_kind: "NAV", record_key: "fund", field: "nav", value: ourNav.trim() }],
        },
      }),
      201,
    );
    setBusy(false);
    setMessage(failed ?? "Compared. Anything the two systems disagree about is listed below.");
    if (!failed) setNonce((n) => n + 1);
  }

  return (
    <>
      <h3>Do the administrator's numbers agree with ours</h3>
      <div className="card">
        <p className="small">
          Check this before a letter goes out. Telling investors a figure the administrator disagrees
          with is the most expensive mistake available on this page.
        </p>
        <p className="muted small">
          No administrator system is connected, so both numbers are typed in by hand. Nothing here is
          ever written back to them.
        </p>

        <div className="form-row" data-testid="reconciliation-form">
          <label>
            Fund{" "}
            <select data-testid="reconciliation-fund" value={fundId} onChange={(e) => setFundId(e.target.value)}>
              {funds.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            What the administrator says{" "}
            <input className="input-money" inputMode="decimal" data-testid="admin-nav" value={adminNav} onChange={(e) => setAdminNav(e.target.value)} placeholder="31500000" />
          </label>
          <label>
            What we say{" "}
            <input className="input-money" inputMode="decimal" data-testid="our-nav" value={ourNav} onChange={(e) => setOurNav(e.target.value)} placeholder="31000000" />
          </label>
          <button type="button" disabled={busy || funds.length === 0} data-testid="reconciliation-run" onClick={() => void compare()}>
            Compare
          </button>
        </div>

        <ul className="card-list small" data-testid="reconciliation-exceptions">
          {rows.map((x) => (
            <li key={x.id} data-testid={`exception-${x.id}`}>
              <strong>{x.field}</strong> — they say {x.administrator_value}, we say {x.internal_value}
              {x.difference ? ` (${x.difference} apart)` : ""} · {x.status.toLowerCase().split("_").join(" ")}
            </li>
          ))}
          {rows.length === 0 && <li className="state-empty">Nothing is in dispute.</li>}
        </ul>

        {message && (
          <p className="notice small" data-testid="reconciliation-message" role="status">
            {message}
          </p>
        )}
      </div>
    </>
  );
}


interface Performance {
  fund: { id: string; name: string; currency: string; target: number | null };
  committed: number;
  called: number;
  uncalled: number;
  distributed: number;
  cost: number;
  value: number;
  holdings: Array<{ position_id: string; company: string; cost: number; value: number; mark_source: string; mark_basis: string | null; multiple: number | null }>;
  metrics: { tvpi: number | null; dpi: number | null; rvpi: number | null };
  honesty: { holdings_total: number; held_at_cost: number; note: string };
}

/**
 * Where the fund actually is, and the letter that says so.
 *
 * Operator: "the LP page needs to allow us to create a report for LPs at the drop of a hat that
 * explains where we are at any given time with metrics LPs care about", and "our ai employee that
 * deals with LPs is hosting this page too and can send the report to LPs when we ask him to."
 *
 * EVERY FIGURE IS COMPUTED, none is typed. It reads Portfolio's marks and this page's capital, and
 * writes neither — Portfolio owns what a holding is worth because that is a fact about the holding,
 * and two surfaces claiming the fund's position would disagree inside a quarter.
 *
 * THE HONESTY LINE IS NOT A FOOTNOTE. How many holdings have never been marked decides whether any
 * ratio above it is worth putting in a letter, so it is stated before the letter is drafted rather
 * than discovered afterwards.
 *
 * DRAFTED, NEVER SENT. Automatic outbound is off for everyone including the partners; mail reaches
 * an investor when a partner sends it and not before.
 */
function FundStanding({ funds, lps }: { funds: FundRaise[]; lps: LpRecordRow[] }) {
  const [fundId, setFundId] = useState("");
  const chosen = fundId || funds[0]?.id || "";
  const perf = useApi<Performance>(chosen ? `/api/funds/${chosen}/performance` : null, [chosen]);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const p = perf.data;

  async function ask() {
    setBusy(true);
    const res = await api<{ draft?: string; detail?: string; error?: string }>(`/api/funds/${chosen}/lp-report`, {
      method: "POST",
      body: {},
    });
    setBusy(false);
    if (res.status === 200 && res.data?.draft) {
      setDraft(res.data.draft);
      setMessage("Wesley has drafted it. Nothing has been sent.");
    } else {
      setMessage(`Wesley could not draft it: ${res.data?.detail ?? res.data?.error ?? `HTTP ${res.status}`}`);
    }
  }

  const money = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: p?.fund.currency ?? "USD", maximumFractionDigits: 0 }).format(n);

  return (
    <>
      <h3>Where the fund stands</h3>
      <div className="card" data-testid="fund-standing">
        {funds.length > 1 && (
          <div className="form-row">
            <label>
              Fund{" "}
              <select value={chosen} onChange={(e) => setFundId(e.target.value)} data-testid="standing-fund">
                {funds.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {p && (
          <>
            <div className="cohort-grid" data-testid="fund-metrics">
              <div className="cohort">
                <span className="cohort-count">{p.metrics.tvpi ?? "—"}</span>
                <span className="cohort-label">TVPI</span>
                <span className="cohort-pct">everything held plus paid back, per dollar called</span>
              </div>
              <div className="cohort">
                <span className="cohort-count">{p.metrics.dpi ?? "—"}</span>
                <span className="cohort-label">DPI</span>
                <span className="cohort-pct">what has actually come back</span>
              </div>
              <div className="cohort">
                <span className="cohort-count">{money(p.called)}</span>
                <span className="cohort-label">Called</span>
                <span className="cohort-pct">{money(p.uncalled)} still uncalled</span>
              </div>
              <div className="cohort">
                <span className="cohort-count">{money(p.value)}</span>
                <span className="cohort-label">Held at</span>
                <span className="cohort-pct">{money(p.cost)} invested</span>
              </div>
            </div>

            {/* Stated before the letter is drafted, not discovered after it goes out. */}
            {p.honesty.held_at_cost > 0 && (
              <p className="notice notice-gate small" data-testid="fund-honesty">
                {p.honesty.note}
              </p>
            )}

            <ul className="card-list small" data-testid="fund-holdings">
              {p.holdings.map((h) => (
                <li key={h.position_id}>
                  <strong>{h.company}</strong> — cost {money(h.cost)}, held at {money(h.value)}
                  {h.multiple !== null ? ` (${h.multiple}×)` : ""} ·{" "}
                  <span className="muted">
                    {h.mark_source === "COST" ? "never marked" : h.mark_source.toLowerCase().split("_").join(" ")}
                    {h.mark_basis ? ` — ${h.mark_basis}` : ""}
                  </span>
                </li>
              ))}
              {p.holdings.length === 0 && (
                <li className="state-empty">
                  The fund holds nothing yet. A holding appears when a transaction is executed on a company.
                </li>
              )}
            </ul>

            <div className="form-row">
              <button type="button" className="btn-strong" disabled={busy || !chosen} data-testid="lp-report-ask" onClick={() => void ask()}>
                {busy ? "Wesley is writing…" : "Ask Wesley for the report"}
              </button>
              <span className="muted small">He drafts it from these figures. Nothing goes to an investor until you send it.</span>
            </div>

            {draft && (
              <div className="brief-prose" data-testid="lp-report-draft">
                <h4>Wesley's draft</h4>
                <p style={{ whiteSpace: "pre-wrap" }}>{draft}</p>
                <p className="muted small">
                  Not sent. {lps.length} investor{lps.length === 1 ? "" : "s"} on record would receive it.
                </p>
              </div>
            )}
          </>
        )}

        {message && (
          <p className="notice small" data-testid="standing-message" role="status">
            {message}
          </p>
        )}
      </div>
    </>
  );
}

export function LpPage({ me }: { me: MeResponse }) {
  const raise = useApi<{ funds: FundRaise[] }>("/api/lp/fundraising");
  const commitments = useApi<{ commitments: CommitmentRow[] }>("/api/lp/commitments");
  const lps = useApi<{ lp_records: LpRecordRow[] }>("/api/lp/records");

  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>("FAMILY_OFFICE");
  const [form, setForm] = useState({ lp_record_id: "", fund_id: "", amount: "", state: "SOFT" });
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const funds = raise.data?.funds ?? [];
  const rows = commitments.data?.commitments ?? [];
  const records = lps.data?.lp_records ?? [];
  const isPartner = me.roles.includes("MANAGING_PARTNER");

  function reload() {
    raise.reload();
    commitments.reload();
    lps.reload();
  }

  async function addLp() {
    if (name.trim().length < 2) {
      setMessage("Give them a name — the legal one that will go on the subscription document.");
      return;
    }
    setBusy(true);
    const failed = mutationError(
      await api("/api/lp/records", { method: "POST", body: { legal_name: name.trim(), lp_type: kind } }),
      201,
    );
    setBusy(false);
    setMessage(failed ?? `Added ${name.trim()}.`);
    if (!failed) {
      setName("");
      reload();
    }
  }

  async function record() {
    const amount = Number(form.amount);
    if (!form.lp_record_id || !form.fund_id || !Number.isFinite(amount) || amount <= 0) {
      setMessage("Pick the investor, the fund, and how much.");
      return;
    }
    setBusy(true);
    const failed = mutationError(
      await api("/api/lp/commitments", {
        method: "POST",
        body: { lp_record_id: form.lp_record_id, fund_id: form.fund_id, amount, state: form.state },
      }),
      [200, 201],
    );
    setBusy(false);
    setMessage(failed ?? "Recorded.");
    if (!failed) {
      setForm((f) => ({ ...f, amount: "" }));
      reload();
    }
  }

  async function setSize(fundId: string) {
    const amount = Number(target);
    if (!Number.isFinite(amount) || amount <= 0) {
      setMessage("How much is this fund raising?");
      return;
    }
    setBusy(true);
    const failed = mutationError(await api(`/api/funds/${fundId}/size`, { method: "PATCH", body: { target_size: amount } }), 200);
    setBusy(false);
    setMessage(failed ?? "Saved.");
    if (!failed) {
      setTarget("");
      reload();
    }
  }

  return (
    <section data-testid="lp-page">
      <h3>Where the raise stands</h3>

      {funds.length === 0 && !raise.loading && (
        <p className="state-empty" data-testid="lp-no-funds">
          No fund is recorded yet, so there is nothing for anybody to commit to. Create one on Fund strategy first.
        </p>
      )}

      {funds.map((f) => (
        <section className="card" key={f.id} data-testid={`fund-raise-${f.id}`}>
          <h4>
            {f.name}
            {f.vintage_year ? <span className="muted small"> · {f.vintage_year}</span> : null}
          </h4>

          {f.target === null ? (
            <div className="form-row" data-testid={`fund-target-form-${f.id}`}>
              <label>
                How much is this fund raising?{" "}
                <input
                  data-testid={`fund-target-${f.id}`}
                  className="input-money"
                  inputMode="decimal"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="30000000"
                />
              </label>
              <button type="button" disabled={busy || !isPartner} onClick={() => void setSize(f.id)}>
                Save
              </button>
              <span className="muted small">
                Nobody has said yet. Until they do, there is nothing to measure the raise against.
              </span>
            </div>
          ) : (
            <>
              {/* Signed and soft are shown as two figures and never summed. The distinction is the
                  point: one is banked, the other is somebody's word. */}
              <div className="cohort-grid" data-testid={`fund-numbers-${f.id}`}>
                <div className="cohort">
                  <span className="cohort-count">{money(f.signed, f.currency)}</span>
                  <span className="cohort-label">Signed</span>
                  <span className="cohort-pct">
                    {f.signed_count} investor{f.signed_count === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="cohort">
                  <span className="cohort-count">{money(f.soft, f.currency)}</span>
                  <span className="cohort-label">Said yes, not signed</span>
                  <span className="cohort-pct">
                    {f.soft_count} investor{f.soft_count === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="cohort">
                  <span className="cohort-count">{money(f.target, f.currency)}</span>
                  <span className="cohort-label">Target</span>
                  <span className="cohort-pct">{f.percent_of_target === null ? "—" : `${f.percent_of_target}% signed`}</span>
                </div>
              </div>
              {f.percent_of_target !== null && (
                <div
                  className="progress-track"
                  role="progressbar"
                  aria-valuenow={Math.min(100, f.percent_of_target)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${f.name} signed against target`}
                >
                  <div className="progress-fill" style={{ width: `${Math.min(100, f.percent_of_target)}%` }} />
                </div>
              )}
            </>
          )}
        </section>
      ))}

      <h3>Record what somebody committed</h3>
      <div className="card">
        <div className="form-row" data-testid="commitment-form">
          <label>
            Investor{" "}
            <select
              data-testid="commitment-lp"
              value={form.lp_record_id}
              onChange={(e) => setForm((f) => ({ ...f, lp_record_id: e.target.value }))}
            >
              <option value="">— pick one —</option>
              {records.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.legal_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Fund{" "}
            <select data-testid="commitment-fund" value={form.fund_id} onChange={(e) => setForm((f) => ({ ...f, fund_id: e.target.value }))}>
              <option value="">— pick one —</option>
              {funds.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            How much{" "}
            <input
              data-testid="commitment-amount"
              className="input-money"
              inputMode="decimal"
              value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              placeholder="5000000"
            />
          </label>
          <label>
            Where it stands{" "}
            <select data-testid="commitment-state" value={form.state} onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}>
              {STATES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn-strong" disabled={busy} data-testid="commitment-save" onClick={() => void record()}>
            Record it
          </button>
        </div>
        <p className="muted small">
          Recording the same investor and fund again updates what is there — it never adds a second
          line, so the fund's total cannot count the same money twice.
        </p>
      </div>

      <h3>Who has committed</h3>
      <div className="tablewrap">
        <table className="surface-body" data-testid="commitment-list">
          <thead>
            <tr>
              <th>Investor</th>
              <th>Fund</th>
              <th className="num">Amount</th>
              <th>Where it stands</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} data-testid={`commitment-${c.id}`}>
                <td>{c.lp_name}</td>
                <td>{c.fund_name}</td>
                <td className="num">{money(c.amount, c.currency ?? "USD")}</td>
                <td>{STATES.find((s) => s.key === c.state)?.label ?? c.state}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="state-empty">
                  Nobody has committed anything yet. Add an investor below, then record what they said.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <FundStanding funds={funds} lps={records} />

      <ReportingSection funds={funds} />

      <ReconciliationSection funds={funds} />

      <h3>Add an investor</h3>
      <div className="card">
        <div className="form-row" data-testid="lp-form">
          <label>
            Legal name{" "}
            <input data-testid="lp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Cedar Family Office" />
          </label>
          <label>
            What kind{" "}
            {/* Every LP used to be silently filed as a family office — the form hard-coded it. */}
            <select data-testid="lp-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {LP_KINDS.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={busy} data-testid="lp-add" onClick={() => void addLp()}>
            Add
          </button>
        </div>
        <p className="muted small">
          Only people at the firm can see any of this. It never leaves without a partner deciding it should.
        </p>
      </div>

      {message && (
        <p className="notice" data-testid="lp-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
