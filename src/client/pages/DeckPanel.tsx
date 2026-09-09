import { useState } from "react";
import { api, useApi } from "../lib/api";
import { usd } from "@shared/fund/sleeveMath";

/**
 * The LP deck, where the firm can see it.
 *
 * Operator, 9 Sep 2026: "we should have our deck displayed prominently in the OS ... and changes are
 * tracked and the latest edits and date and timestamps in the OS".
 *
 * WHY THIS IS NOT A DOWNLOAD LINK. The deck is the most externally consequential document the firm
 * owns and it lived only in Canva and a Downloads folder, while the OS held the fund records it is
 * supposed to be about. Nothing joined them, which is how six discrepancies survived from August to
 * September — the deck said early stage was $21M, the OS said $17.0M, and nobody could say which was
 * derived from which because no version recorded its own inputs.
 *
 * THE STALENESS LINE IS THE POINT OF THE WHOLE PANEL. "This deck is eleven days old and three fund
 * figures have changed since it was built" is the sentence that would have caught all of it, and it
 * is computed on every read against the records as they are NOW — never stored. A status derived
 * once at write time is wrong by the time somebody reads it, which is exactly what the unread badge
 * taught this codebase this morning.
 */

interface DeckVersion {
  id: string;
  version_no: number;
  title: string;
  origin: string;
  created_by: string;
  created_by_type: string;
  document_id: string | null;
  page_count: number | null;
  change_summary: string | null;
  changed_fields_json: string;
  state: string;
  approved_by: string | null;
  approved_at: string | null;
  rejected_reason: string | null;
  created_at: string;
}

interface Drift {
  field: string;
  was: string;
  now: string;
}

interface DeckResponse {
  fund: { id: string; name: string };
  current: DeckVersion | null;
  versions: DeckVersion[];
  staleness: { age_days: number | null; changed_since: Drift[]; headline: string } | null;
  note?: string;
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function DeckPanel(): JSX.Element {
  const deck = useApi<DeckResponse>("/api/deck");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function decide(id: string, decision: "APPROVE" | "REJECT"): Promise<void> {
    setBusy(true);
    const reason = decision === "REJECT" ? window.prompt("What is wrong with it? Preston gets this back.") : undefined;
    if (decision === "REJECT" && !reason) { setBusy(false); return; }
    const res = await api(`/api/deck/versions/${id}/decide`, { method: "POST", body: { decision, reason } });
    setBusy(false);
    setMessage(
      res.status === 200
        ? decision === "APPROVE"
          ? "Approved. That is now the current deck."
          : "Sent back to Preston with your reason."
        : "That did not go through. Nothing changed.",
    );
    deck.reload();
  }

  if (deck.loading) return <section className="card"><p className="muted small">Loading the deck…</p></section>;

  const data = deck.data;
  if (!data) {
    return (
      <section className="card" data-testid="deck-panel">
        <h3>The deck</h3>
        <p className="state-empty">Could not read the deck. Nothing has been changed.</p>
      </section>
    );
  }

  const proposed = data.versions.filter((v) => v.state === "PROPOSED");
  const history = data.versions.filter((v) => v.state !== "PROPOSED");
  const drift = data.staleness?.changed_since ?? [];

  return (
    <section className="card" data-testid="deck-panel">
      <div className="home-section-head">
        <h3>The deck</h3>
        {data.current && (
          <span className="muted small">
            v{data.current.version_no} · {data.current.page_count ?? "?"} pages
          </span>
        )}
      </div>

      {message && <p className="notice" data-testid="deck-message">{message}</p>}

      {!data.current && (
        <p className="state-empty" data-testid="deck-empty">
          {data.note ?? "No deck version has been recorded yet."}
        </p>
      )}

      {data.current && (
        <>
          <p data-testid="deck-current">
            <strong>{data.current.title}</strong>
            <br />
            <span className="muted small">
              {data.current.origin === "UPLOADED" ? "Uploaded by" : "Built by"} {data.current.created_by} ·{" "}
              {when(data.current.created_at)}
            </span>
          </p>

          {/*
            THE LINE THAT WOULD HAVE CAUGHT ALL SIX. Not "up to date" as a badge somebody set, but a
            comparison made now between what the deck was built from and what the records say today.
          */}
          <div className={drift.length > 0 ? "note" : "note calm"} data-testid="deck-staleness">
            <p>{data.staleness?.headline}</p>
            {drift.length > 0 && (
              <ul className="card-list small" data-testid="deck-drift">
                {drift.map((d) => (
                  <li key={d.field}>
                    <strong>{d.field}</strong> — was {d.was}, now {d.now}
                  </li>
                ))}
              </ul>
            )}
            {drift.length > 0 && (
              <p className="muted small">
                Assign Preston to rebuild it and every figure comes from the records above rather than
                from the slide.
              </p>
            )}
          </div>

          {data.current.document_id && (
            <p>
              <a
                className="link-button"
                data-testid="deck-open"
                href={`/api/documents/${data.current.document_id}/download`}
              >
                Open the current deck
              </a>
            </p>
          )}
        </>
      )}

      {proposed.length > 0 && (
        <>
          <h4>Waiting on you</h4>
          <ul className="card-list" data-testid="deck-proposed">
            {proposed.map((v) => (
              <li key={v.id} className="card">
                <strong>
                  v{v.version_no} — {v.title}
                </strong>
                <p className="muted small">
                  Built by {v.created_by} · {when(v.created_at)}
                </p>
                {v.change_summary && <p className="small">{v.change_summary}</p>}
                <div className="notification-actions">
                  <button type="button" className="btn-strong" disabled={busy} data-testid={`deck-approve-${v.id}`}
                    onClick={() => void decide(v.id, "APPROVE")}>
                    Approve
                  </button>
                  <button type="button" disabled={busy} data-testid={`deck-reject-${v.id}`}
                    onClick={() => void decide(v.id, "REJECT")}>
                    Try again
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {history.length > 0 && (
        <details className="card" data-testid="deck-history">
          <summary>{history.length} version{history.length === 1 ? "" : "s"} on the record</summary>
          <ul className="card-list small">
            {history.map((v) => {
              let changed: Drift[] = [];
              try { changed = JSON.parse(v.changed_fields_json) as Drift[]; } catch { changed = []; }
              return (
                <li key={v.id} data-testid={`deck-version-${v.version_no}`}>
                  <strong>v{v.version_no}</strong> · {v.state.toLowerCase()} · {when(v.created_at)} ·{" "}
                  {v.origin === "UPLOADED" ? "uploaded by" : "built by"} {v.created_by}
                  {v.change_summary && <div className="muted">{v.change_summary}</div>}
                  {changed.length > 0 && (
                    <div className="muted">
                      {changed.map((c) => `${c.field}: ${c.was} → ${c.now}`).join(" · ")}
                    </div>
                  )}
                  {v.rejected_reason && <div className="muted">Sent back: {v.rejected_reason}</div>}
                </li>
              );
            })}
          </ul>
          <p className="muted small">
            Every version keeps the fund figures it was built from, so “which numbers were in the deck
            we sent in August” has an answer. Nothing here is editable and nothing is deleted.
          </p>
        </details>
      )}
    </section>
  );
}

/** Exported for the construction editor, so both surfaces print money the same way. */
export const money = usd;
