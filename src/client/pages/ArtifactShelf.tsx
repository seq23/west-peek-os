import { useEffect, useState } from "react";
import { useApi, isFailure, failureText } from "../lib/api";
import { KIND_WORDS, isTerminal, type ArtifactAbout, type ArtifactKind } from "@shared/artifacts/artifact";

/**
 * THE SHELF ROWS (owner, 19 Sep 2026): what has been built on demand, listed where it would be
 * reused. One component, two homes: the Documents page ("Built on demand", grouped by the object,
 * searchable by title) and the object's own page (a company record, a deal, Fund strategy, the
 * meeting's After face) as link rows filtered to that object.
 *
 * Every row says kind, title, built-by, built-at, cites and its STATE — a row that is still
 * building says so in words and keeps reading the shelf until it is not; a failed one says why.
 */

export interface ShelfRow {
  id: string;
  kind: ArtifactKind;
  title: string;
  state: "REQUESTED" | "BUILDING" | "READY" | "FAILED";
  stage: string | null;
  words: string;
  built_by: string;
  built_at: string | null;
  requested_at: string;
  cites_count: number;
  version_no: number;
  door: "ROOM" | "CARD";
  work_card_id: string | null;
  about: ArtifactAbout;
  error_message: string | null;
}

/** The address of an artifact's page, inside Documents. */
export function artifactHash(id: string): string {
  return `#/documents/a/${id}`;
}

export function openArtifact(id: string): void {
  window.location.hash = artifactHash(id);
}

function when(iso: string | null): string {
  if (!iso) return "not yet";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function ShelfRowView({ row, showObject = true }: { row: ShelfRow; showObject?: boolean }): JSX.Element {
  return (
    <li className="card artifact-row" data-testid={`artifact-row-${row.id}`} data-state={row.state} data-kind={row.kind}>
      <div className="grow">
        <span className="badge badge-quiet">{KIND_WORDS[row.kind].label}</span>{" "}
        <button type="button" className="link-button artifact-row-title" data-testid={`artifact-open-${row.id}`} onClick={() => openArtifact(row.id)}>
          <strong>{row.title}</strong>
        </button>
        <span className="muted small">
          {" "}· built by {row.built_by} · {when(row.built_at)} · {row.cites_count} row{row.cites_count === 1 ? "" : "s"} cited · v{row.version_no}
          {showObject ? ` · about ${row.about.label}` : ""}
        </span>
        {!isTerminal(row.state) && <span className="task-chip task-chip-live" data-testid={`artifact-row-state-${row.id}`}> {row.words}</span>}
        {row.state === "FAILED" && <span className="field-help err" data-testid={`artifact-row-state-${row.id}`}>{row.words}</span>}
      </div>
    </li>
  );
}

/**
 * The rows for one object, or the whole shelf. Polls while anything on it is still building, so a
 * row never sits at "building" after the row itself has moved.
 */
export function ArtifactShelf({
  about,
  card,
  query = "",
  emptyNote,
  showObject = true,
  testId = "artifact-shelf",
}: {
  /** An object id (company, deal, meeting, fund, LP): only what is about it. */
  about?: string | null;
  /** A work card id: only what that card built. */
  card?: string | null;
  query?: string;
  emptyNote: string;
  showObject?: boolean;
  testId?: string;
}): JSX.Element {
  const params = new URLSearchParams();
  if (about) params.set("about", about);
  if (card) params.set("card", card);
  if (query.trim()) params.set("q", query.trim());
  const path = `/api/artifacts${params.toString() ? `?${params}` : ""}`;
  const shelf = useApi<{ artifacts: ShelfRow[]; note: string | null }>(path, [path]);
  const rows = shelf.data?.artifacts ?? [];
  const moving = rows.some((r) => !isTerminal(r.state));
  usePoll(moving, shelf.reload);

  if (shelf.loading && !shelf.data) return <p className="state-message" data-testid={`${testId}-loading`}>Reading the shelf…</p>;
  if (!shelf.data) return <p className="state-message" data-testid={`${testId}-failed`}>{isFailure(shelf.loading, shelf.status) ? failureText(shelf.status ?? 0) : "The shelf could not be read."}</p>;
  // The caller's note first: it knows whose shelf this is (a card's, a company's); the server's is the generic one.
  if (rows.length === 0) return <p className="state-empty" data-testid={`${testId}-empty`}>{emptyNote || shelf.data.note || "Nothing built yet."}</p>;
  return (
    <ul className="card-list" data-testid={testId}>
      {rows.map((r) => <ShelfRowView key={r.id} row={r} showObject={showObject} />)}
    </ul>
  );
}

/** The Documents page's band: a search box, then the rows grouped by what they are about. */
export function BuiltOnDemand(): JSX.Element {
  const [q, setQ] = useState("");
  const path = `/api/artifacts${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`;
  const shelf = useApi<{ artifacts: ShelfRow[]; note: string | null }>(path, [path]);
  const rows = shelf.data?.artifacts ?? [];
  usePoll(rows.some((r) => !isTerminal(r.state)), shelf.reload);
  const groups = new Map<string, ShelfRow[]>();
  for (const r of rows) groups.set(r.about.label, [...(groups.get(r.about.label) ?? []), r]);

  return (
    <section className="card" data-testid="built-on-demand">
      <div className="home-section-head">
        <h3>Built on demand <span className="count-pill">{rows.length}</span></h3>
        <label className="small">
          Search by title{" "}
          <input type="search" data-testid="artifact-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="a title, or part of one" />
        </label>
      </div>
      <p className="muted small">Dashboards, decks and documents built from the record — asked for in a live room or on a work card — kept here under the company, deal, fund, LP or meeting they are about. Open one to refresh it or export it.</p>
      {shelf.loading && !shelf.data ? (
        <p className="state-message">Reading the shelf…</p>
      ) : !shelf.data ? (
        <p className="state-message" data-testid="built-on-demand-failed">{isFailure(shelf.loading, shelf.status) ? failureText(shelf.status ?? 0) : "The shelf could not be read."}</p>
      ) : rows.length === 0 ? (
        <p className="state-empty" data-testid="built-on-demand-empty">{shelf.data.note ?? "Nothing has been built yet."}</p>
      ) : (
        <ul className="card-list" data-testid="built-on-demand-groups">
          {[...groups.entries()].map(([label, group]) => (
            <li key={label} data-testid="built-on-demand-group">
              <h4>{label} <span className="count-pill">{group.length}</span></h4>
              <ul className="card-list">{group.map((r) => <ShelfRowView key={r.id} row={r} showObject={false} />)}</ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function usePoll(active: boolean, reload: () => void): void {
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(reload, 3000);
    return () => window.clearInterval(id);
  }, [active, reload]);
}
