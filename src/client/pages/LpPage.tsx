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
