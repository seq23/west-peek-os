import { useState } from "react";
import { api, useApi } from "../lib/api";

/**
 * The context an approver needs, on the card (P52, canon §24.2).
 *
 * WHY THIS EXISTS. An approval queue whose items cannot be evaluated in place trains the approver
 * to click approve — they either go hunting through four other pages or they stop looking. Either
 * way the gate becomes ceremony, and every governed action in this system rests on that gate being
 * real.
 *
 * Risk is shown but never editable here: it is derived from the action key, because the requester
 * is frequently an AI employee with an interest in a fast approval.
 */

interface Ctx {
  card: {
    id: string; action_key: string; title: string; summary: string | null;
    risk_level: string; impact_note: string | null; recommended_approver: string | null;
    expires_at: string | null; state: string; required_approver_roles_json: string;
  };
  evidence: Array<{ id: string; kind: string; label: string; detail: string | null; created_at: string }>;
  comments: Array<{ id: string; author_type: string; author_id: string; body: string; created_at: string }>;
  stale: boolean;
}

const RISK_TONE: Record<string, string> = {
  RESERVED: "help-tag help-tag-warn",
  HIGH: "help-tag help-tag-warn",
  MEDIUM: "help-tag help-tag-muted",
  LOW: "help-tag help-tag-good",
  UNCLASSIFIED: "help-tag help-tag-muted",
};

export function ApprovalContextPanel({ cardId }: { cardId: string }): JSX.Element {
  const state = useApi<Ctx>(`/api/approvals/${cardId}/context`, [cardId]);
  const [comment, setComment] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState("CLAIM");
  const [busy, setBusy] = useState(false);

  const c = state.data?.card;
  if (!c) return <p className="muted small">Loading context…</p>;

  async function addComment(e: React.FormEvent) {
    e.preventDefault();
    if (!comment.trim() || busy) return;
    setBusy(true);
    await api(`/api/approvals/${cardId}/comments`, { method: "POST", body: { body: comment.trim() } });
    setComment("");
    setBusy(false);
    state.reload();
  }

  async function addEvidence(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim() || busy) return;
    setBusy(true);
    await api(`/api/approvals/${cardId}/evidence`, { method: "POST", body: { kind, label: label.trim() } });
    setLabel("");
    setBusy(false);
    state.reload();
  }

  return (
    <section className="approval-context" data-testid={`approval-context-${cardId}`}>
      <p>
        <span className={RISK_TONE[c.risk_level] ?? "help-tag help-tag-muted"} data-testid={`approval-risk-${cardId}`}>
          {c.risk_level === "RESERVED" ? "human-reserved" : c.risk_level.toLowerCase()} risk
        </span>{" "}
        {c.impact_note && <span className="muted small">{c.impact_note}</span>}
      </p>

      <p className="muted small">
        {c.recommended_approver && <>Best decided by <strong>{c.recommended_approver}</strong>. </>}
        {state.data!.stale
          ? /* Flagged, never auto-decided: silence approving an external send would be the system
               deciding something it has no authority to decide. */
            <strong data-testid={`approval-stale-${cardId}`}>This has been waiting past its date — it has not been decided for you.</strong>
          : c.expires_at && <>Worth deciding by {new Date(c.expires_at).toLocaleDateString()}.</>}
      </p>

      <h4>Evidence</h4>
      {state.data!.evidence.length === 0 ? (
        <p className="state-empty" data-testid={`approval-no-evidence-${cardId}`}>
          Nothing attached. Deciding without evidence is allowed — it is just on the record that you did.
        </p>
      ) : (
        <ul className="card-list small" data-testid={`approval-evidence-${cardId}`}>
          {state.data!.evidence.map((e) => (
            <li key={e.id}>
              <span className="help-tag help-tag-muted">{e.kind.toLowerCase().replace("_", " ")}</span> {e.label}
              {e.detail && <div className="muted small">{e.detail}</div>}
            </li>
          ))}
        </ul>
      )}

      <form className="form-row" onSubmit={addEvidence}>
        <select aria-label="Kind of evidence" value={kind} onChange={(e) => setKind(e.target.value)} data-testid={`approval-evidence-kind-${cardId}`}>
          {["CLAIM", "DOCUMENT", "INTELLIGENCE_ITEM", "MEETING", "CONTRADICTION", "OTHER"].map((k) => (
            <option key={k} value={k}>{k.toLowerCase().replace("_", " ")}</option>
          ))}
        </select>
        <input
          aria-label="What this evidence is" data-testid={`approval-evidence-label-${cardId}`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="What supports this?"
          style={{ flex: 1, minWidth: "12rem" }}
        />
        <button type="submit" disabled={busy}>Attach</button>
      </form>

      <h4>Questions</h4>
      {state.data!.comments.length === 0 ? (
        <p className="state-empty">No questions yet.</p>
      ) : (
        <ul className="card-list small" data-testid={`approval-comments-${cardId}`}>
          {state.data!.comments.map((m) => (
            <li key={m.id}>
              <strong>{m.author_id}</strong>{" "}
              <span className="muted small">{new Date(m.created_at).toLocaleString()}</span>
              <div>{m.body}</div>
            </li>
          ))}
        </ul>
      )}

      <form className="form-row" onSubmit={addComment}>
        <input
          aria-label="Add a comment to this approval" data-testid={`approval-comment-${cardId}`}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Ask before deciding…"
          style={{ flex: 1, minWidth: "14rem" }}
        />
        <button type="submit" disabled={busy} data-testid={`approval-comment-send-${cardId}`}>Ask</button>
      </form>
      <p className="muted small">
        Comments are part of the decision's record and cannot be edited afterwards.
      </p>
    </section>
  );
}
