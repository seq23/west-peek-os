import { useState } from "react";
import { api, useApi } from "../lib/api";

/**
 * Who is holding each piece — the close-out, as a card on the After face (P33; Phase D §3).
 *
 * It used to be a panel of its own under the record. What came out of a meeting is one face now,
 * and this is the part of it that answers "who was given which task": the After face's four objects
 * say what was decided, owed and left open; this says who is carrying the firm's side of it.
 *
 * The panel answers one question the operator asked for directly: "what deliverables were gathered
 * and who was given which task". So the ASSIGNEE leads every row, not the task text — you scan a
 * column of names to see whether anything landed on you, which is the actual thing being checked.
 *
 * Recommendations are visually separated from assignments because they are a different kind of
 * fact: an assignment is done, a recommendation is a question. Collapsing them into one list would
 * let work quietly sit unowned while appearing handled.
 */

interface Commitment {
  id: string;
  commitment_text: string;
  owner_side: string;
  due_date: string | null;
  status: string;
  origin: string;
  assignee_kind: "AI_EMPLOYEE" | "AI_WITH_HUMAN_TOUCH" | "HUMAN_RECOMMENDED" | "UNASSIGNED";
  assignee_name: string | null;
  assignee_label: string;
  human_touch_reason: string | null;
  source_quote: string | null;
  work_card_id: string | null;
}

interface Closeout {
  id: string;
  digest_md: string;
  commitment_count: number;
  assigned_count: number;
  recommended_count: number;
  unresolved_count: number;
  state: string;
  detail: string | null;
  created_at: string;
}

interface CloseoutResponse {
  closeout: Closeout | null;
  commitments: Commitment[];
}

/** The assignee leads the row: green when an employee holds it, amber when a person must, grey when nobody does. */
function kindClass(kind: Commitment["assignee_kind"]): string {
  switch (kind) {
    case "AI_EMPLOYEE": return "badge badge-ok";
    case "AI_WITH_HUMAN_TOUCH": return "badge badge-gate";
    case "HUMAN_RECOMMENDED": return "badge badge-gate";
    case "UNASSIGNED": return "badge";
  }
}

export function CloseoutPanel({ meetingId }: { meetingId: string }): JSX.Element {
  const state = useApi<CloseoutResponse>(`/api/meetings/${meetingId}/closeout`);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const closeout = state.data?.closeout ?? null;
  const commitments = state.data?.commitments ?? [];
  const firm = commitments.filter((c) => c.owner_side === "FIRM");
  const theirs = commitments.filter((c) => c.owner_side === "COUNTERPARTY");
  const assigned = firm.filter((c) => c.assignee_kind === "AI_EMPLOYEE" || c.assignee_kind === "AI_WITH_HUMAN_TOUCH");
  const recommended = firm.filter((c) => c.assignee_kind === "HUMAN_RECOMMENDED");
  const unowned = firm.filter((c) => c.assignee_kind === "UNASSIGNED");

  async function run() {
    setBusy(true);
    setMessage(null);
    const res = await api<{ error?: string; detail?: string }>(`/api/meetings/${meetingId}/closeout`, {
      method: "POST",
      body: {},
    });
    if (res.status !== 201) setMessage(res.data?.detail ?? res.data?.error ?? `Close-out failed (HTTP ${res.status}).`);
    setBusy(false);
    state.reload();
  }

  function row(c: Commitment) {
    return (
      <li key={c.id} data-testid={`closeout-item-${c.id}`}>
        <span className={kindClass(c.assignee_kind)} data-testid={`closeout-kind-${c.id}`}>
          {c.assignee_name ?? c.assignee_label}
        </span>{" "}
        <strong>{c.commitment_text}</strong>
        {c.due_date && <span className="muted small"> · by {c.due_date}</span>}
        {c.human_touch_reason && (
          <div className="muted small" data-testid={`closeout-touch-${c.id}`}>
            {c.human_touch_reason}
          </div>
        )}
        {c.source_quote && (
          // Provenance in the UI, not just the database: the operator can check the deliverable
          // against the words it was read out of without reopening the notes.
          <div className="muted small closeout-quote">“{c.source_quote}”</div>
        )}
      </li>
    );
  }

  return (
    <section className="card" data-testid={`closeout-${meetingId}`}>
      <div className="panel-head">
        <h3>Who is holding each piece</h3>
        <span className="muted small">
          {closeout && closeout.state === "READY" ? (
            <span data-testid="closeout-counts">
              {closeout.assigned_count} assigned
              {closeout.recommended_count > 0 && `, ${closeout.recommended_count} recommended for you`}
              {closeout.unresolved_count > 0 && `, ${closeout.unresolved_count} need an owner`}
              {" · "}
              {new Date(closeout.created_at).toLocaleString()}
            </span>
          ) : (
            "the firm's side, with a name on each"
          )}
        </span>
      </div>

      {!closeout && (
        <p className="muted small" data-testid="closeout-none">
          No close-out yet. Walter can read the notes and turn what was agreed into assigned work.
        </p>
      )}

      {closeout && closeout.state !== "READY" && (
        <p className="notice" data-testid="closeout-problem">
          {closeout.digest_md}
          {closeout.detail && <span className="muted small"> ({closeout.detail})</span>}
        </p>
      )}

      {assigned.length > 0 && (
        <>
          <p className="eyebrow">Assigned</p>
          <ul className="card-list small" data-testid="closeout-assigned">{assigned.map(row)}</ul>
        </>
      )}

      {recommended.length > 0 && (
        <>
          <p className="eyebrow">Recommended for you</p>
          <p className="muted small">Not assigned to anyone — these need a person.</p>
          <ul className="card-list small" data-testid="closeout-recommended">{recommended.map(row)}</ul>
        </>
      )}

      {unowned.length > 0 && (
        <>
          <p className="eyebrow">Needs an owner</p>
          <ul className="card-list small" data-testid="closeout-unowned">{unowned.map(row)}</ul>
        </>
      )}

      {theirs.length > 0 && (
        <>
          <p className="eyebrow">They owe us</p>
          <p className="muted small">Tracked, not assigned to anyone here.</p>
          <ul className="card-list small" data-testid="closeout-counterparty">{theirs.map(row)}</ul>
        </>
      )}

      <div className="form-row">
        <button type="button" className="btn-strong" disabled={busy} data-testid="closeout-run" onClick={run}>
          {busy ? "Reading the notes…" : closeout ? "Run close-out again" : "Run close-out"}
        </button>
      </div>

      {message && <p className="notice" data-testid="closeout-message">{message}</p>}
      <p className="muted small">
        Internal only. Nothing here has been sent — external follow-ups still need your approval.
      </p>
    </section>
  );
}
