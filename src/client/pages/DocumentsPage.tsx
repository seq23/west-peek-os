import { useEffect, useMemo, useRef, useState } from "react";
import { api, getDevUser, mutationError, useApi } from "../lib/api";
import { DocumentPreview } from "../components/DocumentPreview";
import { BuiltOnDemand } from "./ArtifactShelf";
import { buildShelf, downloadName, groupLabel, groupOf, plainTitle, shortDate, type ShelfEntry, type ShelfGroupKey } from "@shared/documents/shelf";

/**
 * DOCUMENTS, LAID OUT FOR A BUSY READER ON A PHONE (owner, 23 Oct 2026: "how does the documents
 * section inside west peek os look? make sure it is formatted properly for my consumption").
 *
 * Summary first ("4 to read this week", then the newest), then a search box and a "Show:" pull-down,
 * then the shelf in plain-word groups with each recurring series collapsed to its latest. Opening a
 * document lays it over the list (← Back / ✕ Close), so closing puts her back exactly where she was.
 * Archiving sits apart at the bottom, labelled, and always asks first. Upload is one tap away.
 * The sorting itself is `@shared/documents/shelf` — tested there, not here.
 */
export interface DocumentRow {
  id: string;
  title: string;
  doc_type: string;
  type_label?: string;
  privacy_label: string;
  created_at: string;
  content_type?: string | null;
  archived_at?: string | null;
  archive_reason?: string | null;
  deck?: { version_no: number; state: string; id: string; title?: string | null } | null;
}
type DocumentTypeChoice = { key: string; label: string; means: string };

const isLiveDeck = (d: DocumentRow): boolean => Boolean(d.deck && (d.deck.state === "CURRENT" || d.deck.state === "PROPOSED"));
const deckState = (d: DocumentRow): string =>
  d.deck!.state === "CURRENT" ? "current" : d.deck!.state === "PROPOSED" ? "waiting on your decision" : d.deck!.state === "REJECTED" ? "sent back" : "superseded";
const deckStateClass = (d: DocumentRow): string =>
  d.deck!.state === "CURRENT" ? "badge badge-ok" : d.deck!.state === "PROPOSED" ? "badge badge-gate" : "badge badge-quiet";
/** "23 Oct 2026" — the firm writes dates day-first, the same on every device. */
const longDate = (iso: string): string => `${shortDate(iso.slice(0, 10))} ${iso.slice(0, 4)}`;

export function DocumentsPage({ onNavigate }: { onNavigate: (page: string) => void }) {
  const documents = useApi<{ documents: DocumentRow[]; types: DocumentTypeChoice[] }>("/api/documents");
  const archived = useApi<{ documents: DocumentRow[] }>("/api/documents?archived=1");
  /*
   * ARRIVING FROM "VIEW THE DECK". Fund strategy names a document and hands over through a session
   * key, so a bookmarked #/documents stays a plain list. Cleared once read.
   */
  const [focus, setFocus] = useState<string | null>(() => {
    try {
      const id = window.sessionStorage.getItem("wpos.documents.focus");
      window.sessionStorage.removeItem("wpos.documents.focus");
      return id;
    } catch {
      return null;
    }
  });
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<ShelfGroupKey | "all">("all");
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [allReason, setAllReason] = useState("");

  const all = documents.data?.documents ?? [];
  const archivedRows = archived.data?.documents ?? [];
  const types = documents.data?.types ?? [];
  const chosenType = types.find((t) => t.key === docType) ?? null;
  const shelf = useMemo(() => buildShelf(all, { query, group }), [all, query, group]);
  const fullShelf = useMemo(() => buildShelf(all), [all]);
  const focused = focus ? all.find((d) => d.id === focus) ?? archivedRows.find((d) => d.id === focus) ?? null : null;
  const focusedEntry: ShelfEntry<DocumentRow> | null = useMemo(() => {
    if (!focused) return null;
    for (const g of fullShelf.groups)
      for (const l of g.lines) for (const e of [l.latest, ...l.earlier]) if (e.doc.id === focused.id || e.copies.some((c) => c.id === focused.id)) return e;
    const p = plainTitle(focused);
    return { doc: focused, plain: p.title, original: p.changed ? focused.deck?.title ?? focused.title : null, group: groupOf(focused), copies: [] };
  }, [focused, fullShelf]);
  const archivable = all.filter((d) => !isLiveDeck(d));

  const reload = () => {
    documents.reload();
    archived.reload();
  };

  const chooseFile = (chosen: File | null) => {
    setFile(chosen);
    if (chosen && !title.trim()) setTitle(chosen.name.replace(/\.[a-z0-9]{2,5}$/i, ""));
  };

  const download = async (d: DocumentRow) => {
    const headers: Record<string, string> = {};
    const devUser = getDevUser();
    if (devUser) headers["x-wpos-dev-user"] = devUser;
    const res = await fetch(`/api/documents/${d.id}/download`, { headers });
    if (res.status !== 200) {
      setMessage(`Download failed: HTTP ${res.status}`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName(plainTitle(d).title, res.headers.get("content-type") ?? d.content_type ?? "");
    a.click();
    URL.revokeObjectURL(url);
  };

  const row = (e: ShelfEntry<DocumentRow>, opts: { archived?: boolean } = {}) => {
    const d = e.doc;
    return (
      <li key={d.id} className={d.id === focus ? "doc-row doc-row-current" : "doc-row"} data-testid={`document-${d.id}`}>
        <div className="doc-row-text">
          <button type="button" className="doc-row-title" data-testid={`document-title-${d.id}`} onClick={() => setFocus(d.id)}>
            {d.deck && (
              <span className={d.deck.state === "CURRENT" ? "badge badge-ok" : d.deck.state === "PROPOSED" ? "badge badge-gate" : "badge"} data-testid={`document-deck-${d.id}`}>
                v{d.deck.version_no}
              </span>
            )}{" "}
            {e.plain}
          </button>
          <span className="doc-row-meta">
            {longDate(d.created_at)}
            {d.deck && (
              <>
                {" · "}
                <span className={deckStateClass(d)} data-testid={`document-deck-state-${d.id}`}>{deckState(d)}</span>
              </>
            )}
            {e.copies.length > 0 && ` · filed ${e.copies.length + 1} times that day, all kept`}
            {opts.archived && d.archive_reason ? ` · archived: ${d.archive_reason}` : ""}
          </span>
        </div>
        <div className="doc-row-actions">
          <button type="button" className="btn-quiet" data-testid={`view-${d.id}`} onClick={() => setFocus(d.id)}>
            Open here
          </button>
          <button type="button" className="link-button" data-testid={`download-${d.id}`} onClick={() => download(d)}>
            Download
          </button>
          {d.deck && d.deck.state === "PROPOSED" && (
            <button type="button" className="btn-strong" onClick={() => onNavigate("fund-strategy")}>
              Decide on Fund strategy
            </button>
          )}
          {opts.archived && (
            <button
              type="button"
              className="link-button"
              data-testid={`doc-restore-${d.id}`}
              onClick={async () => {
                const failed = mutationError(await api(`/api/documents/${d.id}/restore`, { method: "POST" }), 200);
                setMessage(failed ?? "Back on the shelf.");
                reload();
              }}
            >
              Put it back on the shelf
            </button>
          )}
        </div>
      </li>
    );
  };

  const entryOf = (d: DocumentRow): ShelfEntry<DocumentRow> => {
    const p = plainTitle(d);
    return { doc: d, plain: p.title, original: p.changed ? d.deck?.title ?? d.title : null, group: groupOf(d), copies: [] };
  };

  const loading = documents.loading && !documents.data;

  return (
    <section data-testid="documents-page" className="docs-page">
      {message && (
        <p className="notice" data-testid="doc-message">
          {message}
        </p>
      )}

      {/* 1 · THE SUMMARY. What is new, and the newest, before anything else. */}
      <div className="card docs-summary" data-testid="documents-summary">
        <h3 data-testid="documents-this-week">
          {loading ? "Reading the shelf…" : fullShelf.thisWeek === 0 ? "Nothing new this week" : `${fullShelf.thisWeek} to read this week`}
        </h3>
        {fullShelf.newest.length > 0 && (
          <ul className="docs-newest">
            {fullShelf.newest.map((e) => (
              <li key={e.doc.id}>
                <button type="button" className="doc-row-title" data-testid={`newest-${e.doc.id}`} onClick={() => setFocus(e.doc.id)}>
                  {e.plain}
                </button>
                <span className="doc-row-meta"> {shortDate(e.doc.created_at.slice(0, 10))} · {groupLabel(e.group)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 2 · FIND. A search box and a pull-down, directly above the list they narrow. */}
      <div className="docs-controls">
        <label className="docs-control">
          <span>Search</span>
          <input type="search" data-testid="docs-search" value={query} onChange={(ev) => setQuery(ev.target.value)} placeholder="Type a word from the title" />
        </label>
        <label className="docs-control">
          <span>Show: tap to choose</span>
          <select data-testid="docs-filter" value={group} onChange={(ev) => setGroup(ev.target.value as ShelfGroupKey | "all")}>
            <option value="all">Everything ({all.length})</option>
            {fullShelf.available.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label} ({g.count})
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* 3 · THE SHELF, in plain-word groups; each recurring series shows its latest. */}
      <ul data-testid="document-list" className="docs-groups">
        {shelf.groups.map((g) => (
          <li key={g.key} className="card" data-testid={`docs-group-${g.key}`}>
            <h4>
              {g.label} <span className="count-pill">{g.count}</span>
            </h4>
            <p className="muted small">{g.means}</p>
            <ul className="docs-rows">
              {g.lines.map((l) => {
                const key = l.series ?? l.latest.doc.id;
                const isOpen = opened.has(key);
                return [
                  row(l.latest),
                  l.earlier.length > 0 && (
                    <li key={`${key}-more`} className="doc-row-more">
                      <button
                        type="button"
                        className="link-button"
                        data-testid={`docs-earlier-${l.latest.doc.id}`}
                        aria-expanded={isOpen}
                        onClick={() =>
                          setOpened((prev) => {
                            const next = new Set(prev);
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          })
                        }
                      >
                        {isOpen ? `Hide the ${l.earlier.length} earlier ▴` : `Show ${l.earlier.length} earlier ▾`}
                      </button>
                    </li>
                  ),
                  ...(isOpen ? l.earlier.map((e) => row(e)) : []),
                ];
              })}
            </ul>
          </li>
        ))}
        {!loading && all.length === 0 && (
          <li className="state-empty">Nothing on the shelf. Morning briefs are not filed here on purpose — they live on Home and are superseded each day.</li>
        )}
        {!loading && all.length > 0 && shelf.groups.length === 0 && (
          <li className="state-empty" data-testid="docs-no-match">
            Nothing matches that. Clear the search or choose “Everything” to see the whole shelf.
          </li>
        )}
      </ul>

      <BuiltOnDemand />

      {/* 4 · ADD ONE. One tap away, not in the way of reading. */}
      <details className="card docs-upload" data-testid="document-upload">
        <summary>Put a document on the shelf ▾</summary>
        <form
          data-testid="document-upload-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setMessage(null);
            if (!file) {
              setMessage("Choose a file first.");
              return;
            }
            if (!docType) {
              setMessage("Say what kind of document this is.");
              return;
            }
            const buffer = await file.arrayBuffer();
            let binary = "";
            new Uint8Array(buffer).forEach((b) => (binary += String.fromCharCode(b)));
            const { status, data } = await api<{ id: string; version?: { sha256: string }; deck_version?: { version_no: number }; error?: string; detail?: string }>("/api/documents", {
              method: "POST",
              body: { title: title || file.name, doc_type: docType, content_base64: window.btoa(binary), content_type: file.type || "application/octet-stream" },
            });
            setMessage(
              status === 201
                ? data?.deck_version
                  ? `Recorded as v${data.deck_version.version_no} of the deck. It is not the deck the firm sends until you approve it on Fund strategy.`
                  : `Uploaded ${data!.id}${data!.version ? ` (sha256 ${data!.version.sha256.slice(0, 12)}…)` : ""}.`
                : `Upload failed: ${data?.detail ?? data?.error ?? status}`,
            );
            if (status === 201) {
              setTitle("");
              setFile(null);
              documents.reload();
            }
          }}
        >
          <div className="form-row">
            <label>
              Title <input data-testid="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="what a partner would call it" />
            </label>
            <label>
              What is it?{" "}
              <select data-testid="doc-type" value={docType} onChange={(e) => setDocType(e.target.value)}>
                <option value="">— pick one —</option>
                {types.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <input data-testid="doc-file" aria-label="Choose a file to upload" type="file" onChange={(e) => chooseFile(e.target.files?.[0] ?? null)} />
          </div>
          {chosenType && (
            <p className="muted small" data-testid="doc-type-means">
              {chosenType.means}
            </p>
          )}
          <button type="submit" className="btn-strong" data-testid="doc-submit">
            Upload
          </button>
        </form>
      </details>

      {/* 5 · ARCHIVE, APART AND LABELLED. Off the shelf, never destroyed; always asks first. */}
      <section className="card docs-archive" data-testid="documents-archive-area">
        <h4>Archive</h4>
        <p className="muted small">
          Archiving takes a document off the shelf. Nothing is destroyed: each one keeps who took it off, when and why, and can be put back. The current deck and a
          version waiting on your decision are never archived from here. To archive one document, open it.
        </p>
        {archivable.length > 0 &&
          (confirmAll ? (
            <div className="docs-confirm" data-testid="doc-archive-all-confirm">
              <label>
                Why take all {archivable.length} off the shelf?{" "}
                <input data-testid="doc-archive-all-reason" value={allReason} onChange={(e) => setAllReason(e.target.value)} placeholder="a few words" />
              </label>
              <div className="doc-row-actions">
                <button
                  type="button"
                  className="btn-danger"
                  data-testid="doc-archive-all-yes"
                  disabled={allReason.trim().length < 3}
                  onClick={async () => {
                    const res = await api<{ note?: string }>("/api/documents/archive-all", { method: "POST", body: { reason: allReason.trim() } });
                    setMessage(mutationError(res, 200) ?? res.data?.note ?? "Archived.");
                    setConfirmAll(false);
                    setAllReason("");
                    reload();
                  }}
                >
                  Yes, archive all {archivable.length}
                </button>
                <button type="button" className="link-button" onClick={() => setConfirmAll(false)}>
                  No, keep them
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="link-button" data-testid="doc-archive-all" onClick={() => setConfirmAll(true)}>
              Archive everything on the shelf…
            </button>
          ))}
        {archivedRows.length > 0 && (
          <details data-testid="documents-archived">
            <summary className="small">Show the {archivedRows.length} archived — none destroyed ▾</summary>
            <ul className="docs-rows">{archivedRows.map((d) => row(entryOf(d), { archived: true }))}</ul>
          </details>
        )}
      </section>

      {focused && focusedEntry && (
        <DocumentViewer
          entry={focusedEntry}
          onClose={() => setFocus(null)}
          onOpen={(id) => setFocus(id)}
          onDownload={download}
          onArchived={(note) => {
            setMessage(note);
            setFocus(null);
            reload();
          }}
        />
      )}
    </section>
  );
}

/**
 * THE VIEWER, LAID OVER THE LIST. Because the list never moves underneath it, "← Back" and "✕ Close"
 * put her exactly where she was; focus goes back to the row she opened.
 */
function DocumentViewer({
  entry,
  onClose,
  onOpen,
  onDownload,
  onArchived,
}: {
  entry: ShelfEntry<DocumentRow>;
  onClose: () => void;
  onOpen: (id: string) => void;
  onDownload: (d: DocumentRow) => void;
  onArchived: (note: string) => void;
}): JSX.Element {
  const d = entry.doc;
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const opener = useRef<Element | null>(typeof document !== "undefined" ? document.activeElement : null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus({ preventScroll: true });
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const back = opener.current;
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      if (back instanceof HTMLElement && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, [onClose]);

  useEffect(() => {
    panel.current?.scrollTo?.({ top: 0 });
    setAsking(false);
    setReason("");
    setProblem(null);
  }, [d.id]);

  const close = (
    <div className="doc-viewer-bar">
      <button type="button" className="btn-quiet" data-testid="document-viewer-back" onClick={onClose}>
        ← Back to the list
      </button>
      <button type="button" className="btn-quiet" data-testid="document-viewer-close" aria-label="Close the document" onClick={onClose}>
        ✕ Close
      </button>
    </div>
  );

  return (
    <div className="doc-viewer-backdrop" onClick={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="doc-viewer" role="dialog" aria-modal="true" aria-label={entry.plain} data-testid="document-viewer" ref={panel} tabIndex={-1}>
        {close}
        <h3 className="doc-viewer-title" data-testid="document-viewer-title">
          {d.deck ? `v${d.deck.version_no} — ` : ""}
          {entry.plain}
        </h3>
        {entry.original && (
          <p className="muted small" data-testid="document-viewer-original">
            Filed as: {entry.original}
          </p>
        )}
        <p className="doc-row-meta">
          {groupLabel(entry.group)} · {longDate(d.created_at)}
          {d.archived_at ? " · archived" : ""}
        </p>
        {entry.copies.length > 0 && (
          <p className="notice small" data-testid="document-viewer-copies">
            The same document was filed {entry.copies.length === 1 ? "twice" : `${entry.copies.length + 1} times`} that day; every copy is kept.{" "}
            {entry.copies.map((c, i) => (
              <button key={c.id} type="button" className="link-button" onClick={() => onOpen(c.id)}>
                Open copy {i + 2}
              </button>
            ))}
          </p>
        )}
        <div className="doc-viewer-actions">
          <button type="button" className="btn-strong" data-testid="document-viewer-download" onClick={() => onDownload(d)}>
            Download
          </button>
        </div>
        <DocumentPreview documentId={d.id} title={entry.plain} height="70vh" />
        {close}
        {!d.archived_at && !isLiveDeck(d) && (
          <div className="docs-archive-one" data-testid="document-viewer-archive">
            {asking ? (
              <div className="docs-confirm">
                <label>
                  Why take this off the shelf?{" "}
                  <input data-testid="doc-archive-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="for example: duplicate of last week's" />
                </label>
                {problem && <p className="notice notice-gate small">{problem}</p>}
                <div className="doc-row-actions">
                  <button
                    type="button"
                    className="btn-danger"
                    data-testid={`doc-archive-${d.id}`}
                    disabled={reason.trim().length < 3}
                    onClick={async () => {
                      const failed = mutationError(await api(`/api/documents/${d.id}/archive`, { method: "POST", body: { reason: reason.trim() } }), 200);
                      if (failed) setProblem(failed);
                      else onArchived(`Archived. It is kept, with your reason attached — find it under "Archive" at the bottom.`);
                    }}
                  >
                    Yes, archive it
                  </button>
                  <button type="button" className="link-button" onClick={() => setAsking(false)}>
                    No, keep it
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="link-button" data-testid="doc-archive-ask" onClick={() => setAsking(true)}>
                Archive this document (take it off the shelf)…
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
