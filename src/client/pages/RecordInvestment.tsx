import { useState } from "react";
import { api, mutationError, useApi, type MeResponse } from "../lib/api";

/**
 * Recording that the fund actually bought something.
 *
 * WHY THIS EXISTS. A `position` row — the fund's record that it owns a piece of a company — is
 * created in exactly one place: when a transaction is EXECUTED. Every route in that lifecycle was
 * built, authorized and tested, and not one of them was reachable from any page. So production held
 * zero positions, zero transactions and zero security classes, and always would have. Portfolio,
 * follow-on candidates, the ownership panel and Company 360 were all structurally empty downstream
 * of that, while two other surfaces separately invented a portfolio from closed opportunities — so
 * the product could report "1 holding" and "owns nothing" at the same time.
 *
 * THE SHAPE IS THE GOVERNANCE, and it is deliberately not one button. A security class first,
 * because shares are shares OF something. Then a draft, which is arithmetic and commits nothing.
 * Then submission, which raises an approval card a partner decides on the Approvals page. Only then
 * execute, carrying the receipt — and that is the step that books the position. Nothing here
 * shortcuts any of it; the point is that the ladder was already right and simply had no rungs.
 */

interface SecurityClass {
  id: string;
  class_name: string;
}

interface TransactionRow {
  id: string;
  status: string;
  transaction_type: string;
  quantity: number;
  price_per_share: number;
  gross_amount: number;
  net_amount: number;
  transaction_date: string;
  approval_card_id: string | null;
}

const TRANSACTION_TYPES = [
  { key: "PRIMARY_INVESTMENT", label: "Primary investment — we bought new shares from the company" },
  { key: "FOLLOW_ON", label: "Follow-on — more of a company we already own" },
  { key: "PURCHASE", label: "Secondary purchase — we bought from an existing holder" },
  { key: "SALE", label: "Sale — we sold" },
] as const;

export function RecordInvestment({
  companyId,
  companyName,
  opportunityId,
  me,
  onRecorded,
}: {
  companyId: string;
  companyName: string;
  opportunityId?: string;
  me: MeResponse;
  onRecorded?: () => void;
}) {
  const classes = useApi<{ security_classes: SecurityClass[] }>(`/api/security-classes?company_id=${companyId}`);
  // The position is booked against a fund, and `execute` refuses without one — "fund_id is required
  // to book the position effect". Read rather than typed: the partner should not have to know an id.
  const funds = useApi<{ funds: Array<{ id: string; name: string }> }>("/api/funds");
  const transactions = useApi<{ transactions: TransactionRow[] }>(`/api/transactions?company_id=${companyId}`);

  const [className, setClassName] = useState("");
  const [form, setForm] = useState({
    security_class_id: "",
    transaction_type: "PRIMARY_INVESTMENT",
    quantity: "",
    price_per_share: "",
    fees: "0",
    carry: "0",
    transaction_date: new Date().toISOString().slice(0, 10),
  });
  const [receipt, setReceipt] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isPartner = me.roles.includes("MANAGING_PARTNER");
  const available = classes.data?.security_classes ?? [];
  const rows = transactions.data?.transactions ?? [];

  async function addClass() {
    if (className.trim().length < 2) {
      setMessage("Give the class a name — Series A Preferred, Common, SAFE.");
      return;
    }
    setBusy(true);
    const failed = mutationError(
      await api("/api/security-classes", { method: "POST", body: { company_id: companyId, class_name: className.trim() } }),
      201,
    );
    setBusy(false);
    setMessage(failed ?? `Added ${className.trim()}.`);
    if (!failed) {
      setClassName("");
      classes.reload();
    }
  }

  async function draft() {
    const missing = (["security_class_id", "quantity", "price_per_share"] as const).filter((k) => !form[k].trim());
    if (missing.length > 0) {
      setMessage(`Still needed: ${missing.map((m) => m.split("_").join(" ")).join(", ")}.`);
      return;
    }
    setBusy(true);
    const failed = mutationError(
      await api("/api/transactions", {
        method: "POST",
        body: {
          company_id: companyId,
          ...(opportunityId ? { opportunity_id: opportunityId } : {}),
          transaction_type: form.transaction_type,
          security_class_id: form.security_class_id,
          quantity: Number(form.quantity),
          price_per_share: Number(form.price_per_share),
          fees: Number(form.fees || 0),
          carry: Number(form.carry || 0),
          transaction_date: form.transaction_date,
        },
      }),
      201,
    );
    setBusy(false);
    setMessage(failed ?? "Drafted. Nothing is booked yet — submit it for a partner to approve.");
    if (!failed) transactions.reload();
  }

  async function submit(id: string) {
    setBusy(true);
    const failed = mutationError(await api(`/api/transactions/${id}/submit`, { method: "POST", body: {} }), [200, 201]);
    setBusy(false);
    setMessage(failed ?? "Sent for approval. A Managing Partner decides it on Approvals.");
    if (!failed) transactions.reload();
  }

  async function execute(id: string) {
    if (!receipt.trim()) {
      setMessage("Paste the approval receipt id from the decided card. Executing is what books the position.");
      return;
    }
    const fund = funds.data?.funds?.[0];
    if (!fund) {
      setMessage("No fund is recorded, and a position has to belong to one. Set the fund up first.");
      return;
    }
    setBusy(true);
    const failed = mutationError(
      await api(`/api/transactions/${id}/execute`, {
        method: "POST",
        // `approval_receipt_id`, not `receipt_id` — the wrong name is accepted by the schema as
        // absent, and the run is then refused for want of a receipt it was actually given.
        body: { approval_receipt_id: receipt.trim(), fund_id: fund.id },
      }),
      [200, 201],
    );
    setBusy(false);
    setMessage(failed ?? "Executed. The fund now holds a recorded position in this company.");
    if (!failed) {
      setReceipt("");
      transactions.reload();
      onRecorded?.();
    }
  }

  return (
    <section className="card" data-testid="record-investment">
      <h3>What the fund actually owns</h3>
      <p className="muted small">
        A position is created when a transaction is executed, and never any other way. Draft it, a partner approves it,
        then it is booked against {companyName}.
      </p>

      {available.length === 0 && (
        <div className="form-row" data-testid="security-class-form">
          <label>
            Share class{" "}
            <input
              data-testid="security-class-name"
              value={className}
              onChange={(e) => setClassName(e.target.value)}
              placeholder="Series A Preferred"
            />
          </label>
          <button type="button" disabled={busy} data-testid="security-class-add" onClick={() => void addClass()}>
            Add the class
          </button>
          <span className="muted small">Shares are shares of something. This is needed once per company.</span>
        </div>
      )}

      {available.length > 0 && (
        <div className="form-row" data-testid="transaction-form">
          <label>
            Class{" "}
            <select
              data-testid="txn-class"
              value={form.security_class_id}
              onChange={(e) => setForm((f) => ({ ...f, security_class_id: e.target.value }))}
            >
              <option value="">— select —</option>
              {available.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.class_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            What happened{" "}
            <select
              data-testid="txn-type"
              value={form.transaction_type}
              onChange={(e) => setForm((f) => ({ ...f, transaction_type: e.target.value }))}
            >
              {TRANSACTION_TYPES.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Shares{" "}
            <input
              data-testid="txn-quantity"
              inputMode="decimal"
              value={form.quantity}
              onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
            />
          </label>
          <label>
            Price per share{" "}
            <input
              data-testid="txn-price"
              inputMode="decimal"
              value={form.price_per_share}
              onChange={(e) => setForm((f) => ({ ...f, price_per_share: e.target.value }))}
            />
          </label>
          <label>
            Date{" "}
            <input
              data-testid="txn-date"
              type="date"
              value={form.transaction_date}
              onChange={(e) => setForm((f) => ({ ...f, transaction_date: e.target.value }))}
            />
          </label>
          <button type="button" className="btn-strong" disabled={busy} data-testid="txn-draft" onClick={() => void draft()}>
            Draft it
          </button>
        </div>
      )}

      <ul className="card-list small" data-testid="transaction-list">
        {rows.map((t) => (
          <li key={t.id} data-testid={`txn-${t.id}`}>
            <strong>{t.transaction_type.split("_").join(" ").toLowerCase()}</strong> · {t.quantity} @ {t.price_per_share} ·{" "}
            <code data-testid={`txn-status-${t.id}`}>{t.status}</code> · {t.transaction_date}
            {t.status === "DRAFT" && (
              <>
                {" "}
                <button type="button" disabled={busy} data-testid={`txn-submit-${t.id}`} onClick={() => void submit(t.id)}>
                  Send for approval
                </button>
              </>
            )}
            {t.status === "PENDING_APPROVAL" && (
              <p className="muted small">
                Waiting on a decision{t.approval_card_id ? ` — card ${t.approval_card_id}` : ""}. Approve it on Approvals,
                then bring the receipt back here.
              </p>
            )}
            {t.status === "APPROVED" && isPartner && (
              <div className="form-row">
                <label>
                  Approval receipt{" "}
                  <input
                    data-testid={`txn-receipt-${t.id}`}
                    value={receipt}
                    onChange={(e) => setReceipt(e.target.value)}
                    placeholder="apc_…"
                  />
                </label>
                <button type="button" className="btn-strong" disabled={busy} data-testid={`txn-execute-${t.id}`} onClick={() => void execute(t.id)}>
                  Book it
                </button>
              </div>
            )}
          </li>
        ))}
        {rows.length === 0 && (
          <li className="state-empty">
            Nothing recorded against {companyName} yet. Until a transaction is executed the fund holds no position in it,
            whatever the pipeline says.
          </li>
        )}
      </ul>

      {message && (
        <p className="notice small" data-testid="record-investment-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
