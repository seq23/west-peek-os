import { useState } from "react";
import { api, useApi } from "../lib/api";
import { kindDef } from "@shared/deliverables/deliverable";
import { portraitAlt, portraitFor } from "../lib/employeePortraits";

/**
 * Things the firm has handed you.
 *
 * ONE COMPONENT FOR ALL FOUR KINDS, used on Research, on Home, and anywhere else a deliverable
 * should surface. The operator asked for download and email on research packets; building it once
 * means the morning brief and the weekly review get the same two buttons rather than each waiting
 * its turn for a copy of the same code.
 *
 * FILTERED BY KIND WHERE IT IS EMBEDDED, unfiltered on Home. Research shows the latest few research
 * packets; Home shows everything anybody prepared for you.
 */

interface Deliverable {
  id: string;
  kind: string;
  title: string;
  body: string;
  prepared_by: string;
  prepared_for: string;
  document_id: string | null;
  created_at: string;
}

export function DeliverableList({
  kind,
  limit = 5,
  emptyNote,
  onNavigate,
}: {
  kind?: string;
  limit?: number;
  emptyNote: string;
  onNavigate?: (k: string) => void;
}): JSX.Element {
  const list = useApi<{ deliverables: Deliverable[] }>(
    `/api/deliverables?limit=${limit}${kind ? `&kind=${kind}` : ""}`,
  );
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const rows = list.data?.deliverables ?? [];

  async function emailIt(id: string) {
    setBusy(id);
    setMessage(null);
    const res = await api<{ sent?: boolean; detail?: string; error?: string; to?: string }>(
      `/api/deliverables/${id}/email`,
      { method: "POST", body: {} },
    );
    setBusy(null);
    // "Sending is switched off" is a real answer and is reported as one rather than as success.
    setMessage(
      res.status === 200
        ? res.data?.sent
          ? `Sent to ${res.data.to}.`
          : res.data?.detail ?? "Nothing was sent."
        : `Could not send it: ${res.data?.detail ?? res.data?.error ?? res.status}`,
    );
  }

  if (!list.loading && rows.length === 0) {
    return <p className="state-empty" data-testid="deliverables-empty">{emptyNote}</p>;
  }

  return (
    <>
      {message && <p className="notice small" data-testid="deliverables-message">{message}</p>}
      <ul className="deliverable-list" data-testid="deliverable-list">
        {rows.map((d) => {
          const def = kindDef(d.kind);
          const isOpen = open === d.id;
          return (
            <li key={d.id} className="card deliverable" data-testid={`deliverable-${d.id}`}>
              <div className="deliverable-head">
                {/* SIGNED. Everything the firm produces arrives from somebody, with their face on
                    it — the whole point of the delivery model. */}
                <span className="owner-chip">
                  {portraitFor(d.prepared_by) ? (
                    <img className="owner-face" src={portraitFor(d.prepared_by)!} alt={portraitAlt(d.prepared_by, "prepared this")} loading="lazy" />
                  ) : (
                    <span className="owner-face owner-face-initial" aria-hidden="true">{d.prepared_by.slice(0, 1)}</span>
                  )}
                  {d.prepared_by}
                </span>
                <span className="badge">{def?.label ?? d.kind}</span>
                <span className="muted small">{new Date(d.created_at).toLocaleDateString()}</span>
              </div>

              <button
                type="button"
                className="link-button deliverable-title"
                data-testid={`deliverable-open-${d.id}`}
                onClick={() => setOpen(isOpen ? null : d.id)}
              >
                {d.title}
              </button>
              {!isOpen && <p className="muted small">{def?.blurb}</p>}

              {isOpen && <pre className="deliverable-body">{d.body}</pre>}

              <div className="form-row deliverable-actions">
                {/* A plain link, not a fetch: the browser handles the save dialog and the filename
                    comes from the content-disposition header the route already sets. */}
                <a className="link-button" href={`/api/deliverables/${d.id}/download`} data-testid={`deliverable-download-${d.id}`}>
                  Download
                </a>
                <button
                  type="button"
                  className="link-button"
                  disabled={busy === d.id}
                  data-testid={`deliverable-email-${d.id}`}
                  onClick={() => void emailIt(d.id)}
                >
                  {busy === d.id ? "Sending…" : "Email it to me"}
                </button>
                {onNavigate && d.document_id && (
                  <button type="button" className="link-button" onClick={() => onNavigate("documents")}>
                    Find it in Documents
                  </button>
                )}
                {!d.document_id && (
                  <span className="muted small" title="The handover stands; the archive copy did not save">
                    not filed
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
