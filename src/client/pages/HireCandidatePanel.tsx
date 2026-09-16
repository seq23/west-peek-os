import { useState } from "react";
import { api, useApi } from "../lib/api";

/**
 * Scooter marks a hire candidate from the note itself (16 Sep 2026).
 *
 * Walker's weekly hire search for West Peek Productions lands on Scooter's Home as a deliverable.
 * Under its text, the candidates behind it — each with the two verbs that change next week's note:
 * CONTACTED (he wrote to them; never shown again) and PASSED (not the one; never shown again).
 * "Put back" undoes either. Chosen over a reply-by-email convention because it works end to end
 * with nothing to parse: one row, one status, one click.
 *
 * Only rendered for the `productions_hire_search` kind, and the route answers only to Scooter — for
 * anybody else the list is a 404 and this panel says so rather than rendering an empty list that
 * looks like "no candidates".
 */

interface Candidate {
  id: string;
  url: string;
  name: string;
  title: string;
  company: string;
  city: string;
  evidence_url: string | null;
  fit_score: number;
  first_seen: string;
  status: "NEW" | "SEEN" | "CONTACTED" | "PASSED";
}

const STATUS_WORD: Record<Candidate["status"], string> = {
  NEW: "new this week",
  SEEN: "seen before",
  CONTACTED: "contacted",
  PASSED: "passed",
};

export function HireCandidatePanel({ deliverableId }: { deliverableId: string }): JSX.Element {
  const list = useApi<{ candidates: Candidate[] }>(`/api/productions/candidates?deliverable=${encodeURIComponent(deliverableId)}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function mark(c: Candidate, status: "CONTACTED" | "PASSED" | "NEW") {
    setBusy(c.id);
    const res = await api<{ error?: string; detail?: string }>(`/api/productions/candidates/${c.id}/status`, { method: "POST", body: { status } });
    setBusy(null);
    setMessage(
      res.status === 200
        ? status === "NEW"
          ? `${c.name} is back on the list.`
          : `${c.name} marked ${STATUS_WORD[status]} — Walker leaves them out from next week.`
        : `That did not work: ${res.data?.detail ?? res.data?.error ?? res.status}`,
    );
    list.reload();
  }

  if (list.status === 404) {
    return <p className="muted small" data-testid={`hire-candidates-private-${deliverableId}`}>The candidate list answers only to the partner this note was for.</p>;
  }
  const rows = list.data?.candidates ?? [];
  if (!list.loading && rows.length === 0) {
    return <p className="state-empty" data-testid={`hire-candidates-empty-${deliverableId}`}>No candidate rows are behind this note.</p>;
  }

  return (
    <div className="hire-candidates" data-testid={`hire-candidates-${deliverableId}`}>
      <p className="muted small">Mark each one so next week's note leaves them out. Nothing is sent to a candidate from here.</p>
      {message && <p className="notice small" data-testid="hire-candidates-message">{message}</p>}
      <ul className="hire-candidate-list">
        {rows.map((c) => (
          <li key={c.id} className="hire-candidate" data-testid={`hire-candidate-${c.id}`}>
            <div className="hire-candidate-head">
              <a href={c.url} target="_blank" rel="noreferrer noopener" className="hire-candidate-name">{c.name}</a>
              <span className="muted small">
                {c.title}{c.company ? `, ${c.company}` : ""}{c.city ? ` · ${c.city}` : ""} · fit {c.fit_score}/10
              </span>
              <span className="badge badge-quiet" data-testid={`hire-candidate-status-${c.id}`}>{STATUS_WORD[c.status]}</span>
            </div>
            <div className="form-row hire-candidate-actions">
              {c.status === "CONTACTED" || c.status === "PASSED" ? (
                <button type="button" className="link-button" disabled={busy === c.id} data-testid={`hire-candidate-undo-${c.id}`} onClick={() => void mark(c, "NEW")}>
                  Put back
                </button>
              ) : (
                <>
                  <button type="button" className="btn-ghost" disabled={busy === c.id} data-testid={`hire-candidate-contacted-${c.id}`} onClick={() => void mark(c, "CONTACTED")}>
                    Contacted
                  </button>
                  <button type="button" className="link-button" disabled={busy === c.id} data-testid={`hire-candidate-passed-${c.id}`} onClick={() => void mark(c, "PASSED")}>
                    Pass
                  </button>
                </>
              )}
              {c.evidence_url && (
                <a href={c.evidence_url} target="_blank" rel="noreferrer noopener" className="link-button small">The page that answered</a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
