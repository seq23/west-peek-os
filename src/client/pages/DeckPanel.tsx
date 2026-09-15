import { useState } from "react";
import { api, useApi } from "../lib/api";
import { DocumentPreview } from "../components/DocumentPreview";
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

/**
 * THE LINK GOES TO THE DOCUMENT, ON THE DOCUMENTS PAGE. Operator, 14 Sep 2026: the "view the deck"
 * link "needs to go to the actual documents page to view the latest deck". The Documents page owns
 * viewing; this panel names which document to open there and hands over. The proposed versions
 * get the same link — until now a version could be approved or sent back without a way to look at
 * it first, which is deciding on a document unread.
 */
export function viewOnDocuments(onNavigate: ((key: string) => void) | undefined, documentId: string): void {
  try {
    window.sessionStorage.setItem("wpos.documents.focus", documentId);
  } catch {
    /* a private window; the page still opens, just not scrolled to it */
  }
  if (onNavigate) onNavigate("documents");
  else window.location.hash = "#/documents";
}

export function DeckPanel({ onNavigate }: { onNavigate?: (key: string) => void } = {}): JSX.Element {
  const deck = useApi<DeckResponse>("/api/deck");
  const [message, setMessage] = useState<string | null>(null);
  const [openPreview, setOpenPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function decide(id: string, decision: "APPROVE" | "REJECT", reinstate = false): Promise<void> {
    setBusy(true);
    const reason = decision === "REJECT" ? window.prompt("What is wrong with it? Preston gets this back.") : undefined;
    if (decision === "REJECT" && !reason) { setBusy(false); return; }
    const res = await api(`/api/deck/versions/${id}/decide`, { method: "POST", body: { decision, reason } });
    setBusy(false);
    setMessage(
      res.status === 200
        ? decision === "REJECT"
          ? "Sent back to Preston with your reason."
          : reinstate
            ? "That is the current deck again. Nothing about it changed — only which one the firm sends."
            : "Approved. That is now the current deck."
        : "That did not go through. Nothing changed.",
    );
    deck.reload();
  }

  /*
   * THE UPLOAD CONTROL, WITHOUT WHICH THE ENDPOINT IS DEAD CODE. `POST /api/deck/versions` existed
   * with nothing in the interface able to reach it — this repo's "exists but nothing invokes it"
   * defect, committed while building the surface that exists to prevent that class. A partner
   * exporting from Canva is how a version arrives today, so it is the control that matters most.
   */
  async function upload(file: File): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const buffer = await file.arrayBuffer();
      // Chunked so a multi-megabyte deck does not blow the argument limit on String.fromCharCode.
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      const res = await api<{ error?: string; detail?: string }>("/api/deck/versions", {
        method: "POST",
        body: { title: file.name.replace(/\.pdf$/i, ""), content_base64: btoa(binary) },
      });
      setMessage(
        res.status === 201
          ? "Recorded, with a snapshot of every fund figure it was built from. It is NOT the deck yet — it is waiting on you below. The deck the firm sends has not changed."
          : `That did not save${res.data?.detail ? `: ${res.data.detail}` : ""}. Nothing was changed.`,
      );
      deck.reload();
    } catch {
      setMessage("Could not read that file. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  if (deck.loading) return <section className="card"><p className="muted small">Loading the deck…</p></section>;

  /*
   * A REFUSAL AND A 404 ARRIVE AS A BODY, NOT AS NULL.
   *
   * `useApi` hands back whatever the server returned, so a 404 `{error:"no_fund"}` or a 403 is a
   * TRUTHY object with no `versions` array — and `data.versions.filter(...)` threw, taking the whole
   * Fund strategy page down to nothing. Both design journeys caught it: "Fund strategy (0 chars)"
   * and the no-Managing-Partner sweep. A blank page is the worst possible rendering of a governed
   * refusal, because it looks like a firm with nothing in it rather than a door that is closed.
   *
   * So the shape is checked, and the two cases are told apart: a refusal says it was refused, and
   * an absent fund says there is nothing to hold a deck yet.
   */
  const data = deck.data;
  const versions = Array.isArray(data?.versions) ? data!.versions : null;
  if (!data || versions === null) {
    const refused = deck.status === 403;
    return (
      <section className="card" data-testid="deck-panel">
        <h3>The deck</h3>
        <p className="state-empty" data-testid="deck-unavailable">
          {refused
            ? "The deck is visible to Managing Partners. Ask Sequoia or Scooter if you need it."
            : deck.status === 404
              ? "No fund has been set up yet, so there is nothing for a deck to be about. Create the fund first and the deck history starts here."
              : "Could not read the deck just now. Nothing has been changed — try again in a moment."}
        </p>
      </section>
    );
  }

  const proposed = versions.filter((v) => v.state === "PROPOSED");
  const history = versions.filter((v) => v.state !== "PROPOSED");
  const drift = data.staleness?.changed_since ?? [];
  /*
   * A PREVIEW WHERE THE DECISION IS. Operator, 15 Sep 2026: "v14 in fund strategy for me to
   * approve should have a nice preview so i can choose to view it on that page OR in documents".
   * Approving a document she has to leave the page to look at is a decision made blind; the PDF
   * opens here, under the version it belongs to, and Documents remains one click away.
   */
  const preview = (documentId: string, label: string, testId: string) =>
    documentId && (
      <div>
        <div className="notification-actions">
          <button type="button" className="link-button" data-testid={`${testId}-preview`}
            onClick={() => setOpenPreview((cur) => (cur === documentId ? null : documentId))}>
            {openPreview === documentId ? "Hide the preview" : `Preview ${label} here`}
          </button>
          <button type="button" className="link-button" data-testid={testId}
            onClick={() => viewOnDocuments(onNavigate, documentId)}>
            Open {label} on Documents
          </button>
        </div>
        {openPreview === documentId && <DocumentPreview documentId={documentId} title={label} />}
      </div>
    );

  return (
    <section className="card deck-home" data-testid="deck-panel">
      <div className="home-section-head">
        <h3>The current deck — what the firm sends</h3>
        {data.current && (
          <span className="badge badge-ok" data-testid="deck-current-badge">
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
            <strong className="deck-current-title">{data.current.title}</strong>
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

          {data.current.document_id && preview(data.current.document_id, `v${data.current.version_no}`, "deck-open")}
        </>
      )}

      {/*
        WAITING ON YOU IS NOW THE ONLY DOOR. Until 9 Sep 2026 an upload published itself: it inserted
        as CURRENT and superseded whatever the firm was sending. Recording a PDF and deciding it is
        the document that goes to limited partners are different acts, and both now arrive here.
      */}
      {proposed.length > 0 && (
        <>
          <h4 className="deck-waiting-head">Waiting on your decision</h4>
          <p className="muted small">
            Nothing here is the deck yet. The current deck above does not change until you approve one;
            "Send back" asks for what is wrong and opens Preston's next card.
          </p>
          <ul className="card-list" data-testid="deck-proposed">
            {proposed.map((v) => (
              <li key={v.id} className="card">
                <strong>
                  <span className="badge badge-gate">v{v.version_no}</span> {v.title}
                </strong>
                <p className="muted small">
                  {v.origin === "UPLOADED" ? "Uploaded by" : "Built by"} {v.created_by} · {when(v.created_at)}
                </p>
                {v.change_summary && <p className="small">{v.change_summary}</p>}
                {v.document_id ? (
                  preview(v.document_id, `v${v.version_no}`, `deck-view-${v.id}`)
                ) : (
                  <p className="muted small">No PDF is attached to this version, so there is nothing to look at before deciding.</p>
                )}
                <div className="notification-actions">
                  <button type="button" className="btn-strong" disabled={busy} data-testid={`deck-approve-${v.id}`}
                    onClick={() => void decide(v.id, "APPROVE")}>
                    Approve
                  </button>
                  <button type="button" disabled={busy} data-testid={`deck-reject-${v.id}`}
                    onClick={() => void decide(v.id, "REJECT")}>
                    Send back to Preston
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="muted small">
        <label htmlFor="deck-upload">
          <strong>Add a version of the deck</strong> — export it to PDF and put it here (or upload it
          on Documents as "The LP deck"; both land in the same place). It goes on the record as the
          next version, with the fund figures it was built from, and waits on your approval above:
          uploading a file never changes which deck the firm sends.
        </label>
      </p>
      <input
        id="deck-upload"
        type="file"
        accept="application/pdf"
        disabled={busy}
        data-testid="deck-upload"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          if (file) void upload(file);
          e.currentTarget.value = "";
        }}
      />

      {history.length > 0 && (
        <details className="card" data-testid="deck-history">
          <summary>History — {history.length} version{history.length === 1 ? "" : "s"} on the record, including the current one</summary>
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
                  {/*
                    NOT "sent back". A REJECTED row is any version that is not the document, and the
                    two reasons read nothing alike: a build Preston must redo, or — migration 0155 —
                    a row recorded in error that nobody ever chose. The reason says which.
                  */}
                  {v.rejected_reason && <div className="muted">Why this is not the deck: {v.rejected_reason}</div>}
                  {/*
                    REINSTATE. A superseded version can be made current again without anything about
                    it changing, which is what was missing when a stray upload displaced the Canva
                    deck and putting it back needed a migration.
                  */}
                  {v.state === "SUPERSEDED" && (
                    <div className="notification-actions">
                      <button type="button" disabled={busy} data-testid={`deck-reinstate-${v.id}`}
                        onClick={() => void decide(v.id, "APPROVE", true)}>
                        Make this the current deck again
                      </button>
                    </div>
                  )}
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
