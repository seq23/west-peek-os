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
 * because shares are shares OF something. Then a draft, which is arithmetic and commits nothing —
 * and names the fund and the vehicle, so that the decision can be the last act. Then submission,
 * which raises an approval card a partner decides on the Approvals page. APPROVING THAT CARD BOOKS
 * THE POSITION (Phase D, design §6, decision Q1, owner 18 Sep 2026). The rung that used to follow —
 * come back here, paste the card's id, press "Book it" — is gone: the server executes through the
 * same `executeTransaction`, with the approved card as the receipt, the moment the partner decides.
 * `validate:booking` reads this file and fails if the paste box grows back.
 *
 * The easy way to book a closed deal is now "Book it" on its Portfolio row, which is one save. This
 * panel remains the record's own view of every transaction on the company — follow-ons, secondary
 * purchases, sales — and the way to undo a booking.
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
  fund_id: string | null;
  vehicle: string | null;
}

/** Which entity holds it. A short list, typed over when none fits. */
const VEHICLES = ["Fund I direct", "SPV", "Warehouse"] as const;

const TRANSACTION_TYPES = [
  { key: "PRIMARY_INVESTMENT", label: "Primary investment — we bought new shares from the company" },
  { key: "FOLLOW_ON", label: "Follow-on — more of a company we already own" },
  { key: "PURCHASE", label: "Secondary purchase — we bought from an existing holder" },
  { key: "SALE", label: "Sale — we sold" },
] as const;

/**
 * A booked purchase said in words, not in the six stored values it is made of.
 *
 * Until 22 Aug 2026 a row here read `primary investment · 125000 @ 4 · DRAFT · 2026-08-14` — a
 * share count and a share price as bare integers, and the lifecycle state printed as a raw enum
 * inside a `<code>` element. Money is money and a state is a sentence.
 */
function transactionKind(key: string): string {
  return TRANSACTION_TYPES.find((t) => t.key === key)?.label.split(" — ")[0] ?? "Purchase";
}

/** Where a purchase has got to on the ladder, and what has to happen next. */
function transactionStanding(status: string): string {
  switch (status) {
    case "DRAFT":
      return "drafted — nothing is booked";
    case "PENDING_APPROVAL":
      return "waiting on a partner's decision — approving it books the position";
    case "APPROVED":
      return "approved — the draft named no fund, so it is booked on the Portfolio row with one";
    case "EXECUTED":
      return "booked — the fund holds this";
    // `VOID` is what the column holds (`migrations/0006…:111` CHECK, and `voidTransaction` writes
    // it). This case read `VOIDED`, which no row has ever been, so a voided transaction fell
    // through to the default and reported itself as "in progress" — the one standing it is not.
    case "VOID":
      return "voided";
    default:
      return "in progress";
  }
}

function money(value: number | null | undefined, currency = "USD"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: Math.abs(value) < 100 ? 2 : 0,
  }).format(value);
}

function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

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
    fund_id: "",
    vehicle: "Fund I direct",
  });
  // The receipt for UNDOING a booking (`transaction.void`, MP-reserved). Booking itself needs no
  // receipt any more: the partner's approval is the receipt, spent on the server.
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
    // The fund is named on the draft so that the partner's approval can book it. Read rather than
    // typed: the first fund when there is one, and the partner should not have to know an id.
    const fundId = form.fund_id || funds.data?.funds?.[0]?.id;
    if (!fundId) {
      setMessage("No fund is recorded, and a position has to belong to one. Set the fund up first.");
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
          fund_id: fundId,
          vehicle: form.vehicle.trim() || "Fund I direct",
        },
      }),
      201,
    );
    setBusy(false);
    setMessage(failed ?? "Drafted. Nothing is booked yet — send it, and a partner's approval books it.");
    if (!failed) transactions.reload();
  }

  async function submit(id: string) {
    setBusy(true);
    const failed = mutationError(await api(`/api/transactions/${id}/submit`, { method: "POST", body: {} }), [200, 201]);
    setBusy(false);
    setMessage(failed ?? "Sent for approval. A Managing Partner decides it on Approvals, and approving it books the position.");
    if (!failed) transactions.reload();
  }

  /**
   * Undoing a booking, which the interface had no way to do.
   *
   * `POST /api/transactions/:id/void` is live, governed and correct — MP-reserved, receipt-gated,
   * and it REVERSES the recorded position rather than deleting the row. Nothing in `src/client`
   * called it. The only mention of voiding anywhere in the product was a past-tense line on the
   * activity feed describing something no control here could cause.
   *
   * That is the same defect as the missing "Book it" rung above, one step further along and worse:
   * a booking is a mistake somebody notices AFTER the fund's own records say it owns something, and
   * the only way to correct it was an API client.
   *
   * Undoing keeps its receipt box: `transaction.void` is its own reserved decision with its own
   * card, and reversing a booked position is the one act on this panel that still wants the card's
   * id in hand. Booking no longer does — approval is the booking.
   */
  async function voidTxn(id: string) {
    setBusy(true);
    const failed = mutationError(
      await api(`/api/transactions/${id}/void`, {
        method: "POST",
        body: receipt.trim() ? { approval_receipt_id: receipt.trim() } : {},
      }),
      [200, 201],
    );
    setBusy(false);
    setMessage(
      failed ??
        "Reversed. The transaction is kept as VOID and the position it created has been backed out — nothing was deleted.",
    );
    if (!failed) transactions.reload();
  }

  return (
    <section className="card" data-testid="record-investment">
      {/* An h4: this panel sits inside "The deal itself" on the deal record, and a section heading
          here would read as a sibling of that section rather than a part of it. */}
      <h4>What the fund has actually booked</h4>
      <p className="muted small">
        A position is created when a transaction is executed, and never any other way. Draft it naming the fund, send
        it, and a partner's approval books it against {companyName} — no receipt to paste.
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
          <label>
            Vehicle{" "}
            <input
              data-testid="txn-vehicle"
              list="txn-vehicles"
              value={form.vehicle}
              onChange={(e) => setForm((f) => ({ ...f, vehicle: e.target.value }))}
            />
            <datalist id="txn-vehicles">
              {VEHICLES.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </label>
          {(funds.data?.funds?.length ?? 0) > 1 && (
            <label>
              Fund{" "}
              <select data-testid="txn-fund" value={form.fund_id || funds.data!.funds[0]!.id} onChange={(e) => setForm((f) => ({ ...f, fund_id: e.target.value }))}>
                {funds.data!.funds.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="btn-strong" disabled={busy} data-testid="txn-draft" onClick={() => void draft()}>
            Draft it
          </button>
        </div>
      )}

      <ul className="card-list small" data-testid="transaction-list">
        {rows.map((t) => (
          <li key={t.id} data-testid={`txn-${t.id}`}>
            <strong>{transactionKind(t.transaction_type)}</strong> — {count(t.quantity)} shares at{" "}
            {money(t.price_per_share)} each, {money(t.gross_amount)} in all
            <div className="muted" data-testid={`txn-status-${t.id}`}>
              {transactionStanding(t.status)} · {new Date(t.transaction_date).toLocaleDateString()}
            </div>
            {t.status === "DRAFT" && (
              <>
                {" "}
                <button type="button" disabled={busy} data-testid={`txn-submit-${t.id}`} onClick={() => void submit(t.id)}>
                  Send for approval
                </button>
              </>
            )}
            {/*
              THE RUNG THAT IS NOT HERE ANY MORE, on purpose.

              This row used to carry an "Approval receipt" box and a "Book it" button: after the
              partner decided on Approvals, somebody came back here, pasted the card's id, and
              pressed it — the step that created the position. Phase D (design §6, Q1) makes the
              decision itself the booking: `decideApproval` executes through the same
              `executeTransaction`, with the approved card as the receipt, so a partner's yes on
              Approvals is where the position opens. A draft that named no fund (the older shape)
              is the one case approval cannot book, and its standing says so above.
            */}
            {t.status === "PENDING_APPROVAL" && (
              <p className="muted small" data-testid={`txn-pending-${t.id}`}>
                A Managing Partner decides it on Approvals. Approving it books the position
                {t.fund_id ? "" : " — once a fund is named on the draft"}; nothing to bring back here.
              </p>
            )}
            {/*
              REVERSING IT. Offered only once something has actually been booked: a draft is
              cancelled by not submitting it, and voiding a transaction that never moved a position
              is a governance act with nothing to govern.

              Destructive-sounding and deliberately not styled as the strong action — the strong
              action on this row is booking. The server is still the gate: `transaction.void` is
              MP-reserved and re-checked through `authorize()` on every call.
            */}
            {t.status === "EXECUTED" && isPartner && (
              <div className="form-row">
                <button
                  type="button"
                  data-testid={`txn-void-${t.id}`}
                  title="Reverses the position this created. The record is kept, marked VOID."
                  disabled={busy}
                  onClick={() => void voidTxn(t.id)}
                >
                  Undo this booking
                </button>
                <label>
                  Void receipt{" "}
                  <input
                    data-testid={`txn-void-receipt-${t.id}`}
                    value={receipt}
                    onChange={(e) => setReceipt(e.target.value)}
                    placeholder="apc_…"
                  />
                </label>
                <span className="muted small">
                  Backs the position out and keeps the record. Needs the approved transaction.void card's id.
                </span>
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
