import { useEffect, useState } from "react";
import { api, getDevUser, isFailure, failureText, useApi } from "../lib/api";
import { KIND_WORDS, isTerminal, type ArtifactAbout, type ArtifactKind, type ArtifactPanel, type ArtifactSpec } from "@shared/artifacts/artifact";
import { chartSeries, panelTable, type DocBlock, type Slide } from "@shared/artifacts/render";
import { RoomChart } from "./RoomPanel";
import { openOnRegister } from "./CompaniesPage";

/**
 * AN ARTIFACT, OPENED (owner, 19 Sep 2026): the in-app render of a dashboard, a deck or a document
 * built on demand, with `Export .pptx` / `Export .docx`, `Refresh`, `Open the object` and the
 * versions. Reached at `#/documents/a/<id>` from the Documents shelf, from the object's own page,
 * from the room's link block and from the card's deliverable row.
 *
 * THE PAGE RENDERS THE SAME DERIVATION THE EXPORT WRITES. The server answers with `slides` (from
 * `slidesFor`) and `document` (from `documentFor`) beside the spec; the deck view walks the
 * slides, the document view walks the blocks, and the dashboard view walks the panels the way a
 * chart slide does. `validate:artifacts` proves render → export → parse back → same figures.
 *
 * EVERY STATE IS ON THE ROW. `data-state` carries REQUESTED / BUILDING / READY / FAILED; a moving
 * build polls every three seconds and prints the stage in words, the elapsed time and the measured
 * usual; a failed one prints the reason with Try again. Nothing here is inferred from silence.
 */

interface ArtifactRead {
  id: string;
  kind: ArtifactKind;
  title: string;
  state: "REQUESTED" | "BUILDING" | "READY" | "FAILED";
  stage: string | null;
  words: string;
  elapsed_seconds: number;
  usual_seconds: number;
  slow: boolean;
  error_code: string | null;
  error_message: string | null;
  version_no: number;
  built_by: string;
  requested_at: string;
  built_at: string | null;
  cites_count: number;
  can_retry: boolean;
  about: ArtifactAbout;
  door: "ROOM" | "CARD";
  work_card_id: string | null;
  confidential: boolean;
  brief: string;
  spec: ArtifactSpec | null;
  slides: Slide[] | null;
  document: DocBlock[] | null;
  shown_version_no: number | null;
  versions: Array<{ id: string; version_no: number; cites_count: number; built_by: string; built_at: string; build_seconds: number | null }>;
}

const POLL_MS = 3000;

/** Where the object lives, and how to get there. */
export function objectDoor(about: ArtifactAbout): { page: string; label: string; open: () => void } | null {
  if (about.company_id) return { page: "companies", label: `Open ${about.label}`, open: () => openOnRegister(about.company_id!) };
  if (about.opportunity_id) return { page: "dealflow", label: `Open the deal`, open: () => undefined };
  if (about.fund_id) return { page: "fund-strategy", label: `Open Fund strategy`, open: () => undefined };
  if (about.lp_record_id) return { page: "lp", label: `Open ${about.label}`, open: () => undefined };
  if (about.meeting_id) return { page: "meetings", label: `Open the meeting`, open: () => undefined };
  return null;
}

async function downloadExport(id: string, format: "pptx" | "docx", version: number | null, filenameHint: string, onFail: (msg: string) => void): Promise<void> {
  const headers: Record<string, string> = {};
  const devUser = getDevUser();
  if (devUser) headers["x-wpos-dev-user"] = devUser;
  const res = await fetch(`/api/artifacts/${id}/export.${format}${version ? `?version=${version}` : ""}`, { headers });
  if (res.status !== 200) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    onFail(body?.detail ?? `Export failed: HTTP ${res.status}`);
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filenameHint}.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ArtifactPage({ artifactId, onNavigate, onBack }: { artifactId: string; onNavigate: (key: string) => void; onBack: () => void }): JSX.Element {
  const [version, setVersion] = useState<number | null>(null);
  const read = useApi<ArtifactRead>(`/api/artifacts/${artifactId}${version ? `?version=${version}` : ""}`, [artifactId, version]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const a = read.data;

  // A moving build is read again every few seconds until it is ready or has said why it is not.
  useEffect(() => {
    if (!a || isTerminal(a.state)) return;
    const id = window.setInterval(read.reload, POLL_MS);
    return () => window.clearInterval(id);
  }, [a?.state, read.reload, a]);

  const rebuild = async (why: "refresh" | "retry") => {
    setBusy(true);
    setMessage(null);
    const res = await api<{ words?: string; detail?: string }>(`/api/artifacts/${artifactId}/${why}`, { method: "POST" });
    setBusy(false);
    if (res.status !== 202) setMessage(res.data?.detail ?? `Could not ${why === "retry" ? "try again" : "refresh"}: HTTP ${res.status}`);
    else {
      setVersion(null);
      read.reload();
    }
  };

  if (read.loading && !a) return <p className="state-message" data-testid="artifact-loading">Opening…</p>;
  if (!a) {
    return (
      <p className="state-message" data-testid="artifact-unavailable">
        {isFailure(read.loading, read.status) ? failureText(read.status ?? 0) : "That artifact is not here — it may have been built for a record you cannot open."}{" "}
        <button type="button" className="link-button" onClick={onBack}>Back to Documents</button>
      </p>
    );
  }

  const door = objectDoor(a.about);
  const shown = a.shown_version_no;
  const filename = `${(a.built_at ?? a.requested_at).slice(0, 10)}-${a.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || a.kind}-v${shown ?? a.version_no}`;

  return (
    <section className="artifact-page" data-testid="artifact-page" data-kind={a.kind} data-state={a.state}>
      <div className="home-section-head">
        <div>
          <p className="artifact-kind"><span>{KIND_WORDS[a.kind].label}</span><span className="muted">about {a.about.label}{a.confidential ? " · confidential" : ""}</span></p>
          <h3 data-testid="artifact-title">{a.title}</h3>
          <p className="muted small">
            Built by {a.built_by} · {a.door === "ROOM" ? "asked in the room" : "from a work card"}
            {a.built_at ? ` · ${new Date(a.built_at).toLocaleString()}` : ""}
          </p>
        </div>
        <button type="button" className="link-button" data-testid="artifact-back" onClick={onBack}>Back to Documents</button>
      </div>

      <p className={a.state === "FAILED" ? "notice notice-bad" : a.state === "READY" ? "brief-state-line" : "notice"} data-testid="artifact-state" data-state={a.state}>
        <strong>{a.state === "READY" ? "Ready" : a.state === "FAILED" ? "Failed" : "Building"}</strong> · {a.words}
      </p>
      {message && <p className="notice" data-testid="artifact-message">{message}</p>}

      <div className="row artifact-actions" data-testid="artifact-actions">
        <button type="button" className="btn-ghost" data-testid="artifact-export-pptx" disabled={!a.spec} onClick={() => void downloadExport(a.id, "pptx", shown, filename, setMessage)}>Export .pptx</button>
        <button type="button" className="btn-ghost" data-testid="artifact-export-docx" disabled={!a.spec} onClick={() => void downloadExport(a.id, "docx", shown, filename, setMessage)}>Export .docx</button>
        {a.state === "FAILED" ? (
          <button type="button" className="btn-ghost" data-testid="artifact-retry" disabled={busy} onClick={() => void rebuild("retry")}>{busy ? "Starting…" : "Try again"}</button>
        ) : (
          <button type="button" className="btn-ghost" data-testid="artifact-refresh" disabled={busy || !isTerminal(a.state)} onClick={() => void rebuild("refresh")}>{busy ? "Starting…" : "Refresh"}</button>
        )}
        {door && (
          <button type="button" className="link-button" data-testid="artifact-open-object" onClick={() => { door.open(); onNavigate(door.page); }}>
            Open the object · {door.label}
          </button>
        )}
        {a.work_card_id && <button type="button" className="link-button" data-testid="artifact-open-card" onClick={() => onNavigate("work")}>Open the card</button>}
      </div>

      {a.state === "FAILED" && (
        <p className="field-help err" data-testid="artifact-failure">{a.error_message ?? "The build stopped without saying why."}</p>
      )}

      {!a.spec ? (
        <p className="state-empty" data-testid="artifact-empty">
          {a.state === "FAILED" ? "Nothing was built. Try again, or change what you asked for." : "Nothing to show yet — this page reads the row every few seconds and fills in the moment it is ready."}
        </p>
      ) : a.kind === "dashboard" ? (
        <DashboardView spec={a.spec} />
      ) : a.kind === "deck" ? (
        <DeckView spec={a.spec} slides={a.slides ?? []} />
      ) : a.kind === "document" ? (
        <DocumentView blocks={a.document ?? []} spec={a.spec} />
      ) : null}

      {a.versions.length > 0 && (
        <details className="artifact-versions" data-testid="artifact-versions" open={a.versions.length > 1}>
          <summary className="muted small">Versions — {a.versions.length}; a refresh is a new one and the old ones stay</summary>
          <ul className="card-list">
            {a.versions.map((v) => (
              <li key={v.id} className="row" data-testid={`artifact-version-${v.version_no}`}>
                <span className="grow">
                  <strong>v{v.version_no}</strong>{v.version_no === a.version_no ? <span className="badge badge-ok"> current</span> : null} · built by {v.built_by} · {new Date(v.built_at).toLocaleString()} · {v.cites_count} row{v.cites_count === 1 ? "" : "s"} cited
                  {v.build_seconds !== null ? ` · ${Math.round(v.build_seconds)}s` : ""}
                </span>
                {shown !== v.version_no && (
                  <button type="button" className="link-button" onClick={() => setVersion(v.version_no)}>Show</button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

// ── The three renders ──────────────────────────────────────────────────────────────────────────

function PanelTable({ panel }: { panel: ArtifactPanel }): JSX.Element {
  const t = panelTable(panel);
  if (panel.rows.length === 0) return <p className="muted small">{panel.note ?? "The record holds nothing matching that."}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{t.columns.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {t.rows.map((r, i) => (
            <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cites({ panel }: { panel: ArtifactPanel }): JSX.Element {
  return (
    <p className="muted small" data-testid={`artifact-panel-cites-${panel.id}`}>
      From <code>{panel.table}</code> · {panel.rows.length} row{panel.rows.length === 1 ? "" : "s"} · cites {panel.cites.length} record{panel.cites.length === 1 ? "" : "s"}{panel.confidential ? " · confidential" : ""}
    </p>
  );
}

function PanelView({ panel }: { panel: ArtifactPanel }): JSX.Element {
  const drawn = panel.chart !== "table" && chartSeries(panel).length > 0;
  return (
    <article className="card artifact-panel" data-testid={`artifact-panel-${panel.id}`} data-chart={panel.chart}>
      <h4>{panel.title}</h4>
      {drawn && <RoomChart kind={panel.chart} rows={panel.rows} columns={panel.columns} title={panel.title} />}
      <PanelTable panel={panel} />
      <Cites panel={panel} />
    </article>
  );
}

function DashboardView({ spec }: { spec: ArtifactSpec }): JSX.Element {
  return (
    <div className="artifact-grid" data-testid="artifact-dashboard">
      {spec.panels.map((p) => <PanelView key={p.id} panel={p} />)}
    </div>
  );
}

function DeckView({ spec, slides }: { spec: ArtifactSpec; slides: Slide[] }): JSX.Element {
  const byId = new Map(spec.panels.map((p) => [p.id, p]));
  return (
    <ol className="artifact-slides" data-testid="artifact-deck">
      {slides.map((s, i) => {
        const panel = s.panel_id ? byId.get(s.panel_id) : undefined;
        return (
          <li key={`${s.kind}-${i}`} className="card artifact-slide" data-testid={`artifact-slide-${i + 1}`} data-slide={s.kind}>
            <p className="artifact-kind"><span>Slide {i + 1}</span><span className="muted">{s.kind}</span></p>
            {s.kind === "title" ? <h3>{s.title}</h3> : <h4>{s.title}</h4>}
            {s.kind === "chart" && panel ? (
              <>
                {panel.chart !== "table" && chartSeries(panel).length > 0 && <RoomChart kind={panel.chart} rows={panel.rows} columns={panel.columns} title={panel.title} />}
                <PanelTable panel={panel} />
                <Cites panel={panel} />
              </>
            ) : s.kind === "sources" ? (
              <ul className="deliverable-doc-list">{s.lines.map((l, j) => <li key={j} className="small">{l}</li>)}</ul>
            ) : (
              s.lines.map((l, j) => <p key={j} className={s.kind === "title" ? "muted small" : "deliverable-doc-p"}>{l}</p>)
            )}
          </li>
        );
      })}
    </ol>
  );
}

function DocumentView({ blocks, spec }: { blocks: DocBlock[]; spec: ArtifactSpec }): JSX.Element {
  const byId = new Map(spec.panels.map((p) => [p.id, p]));
  return (
    <article className="deliverable-doc" data-testid="artifact-document">
      {blocks.map((b, i) => {
        if (b.type === "heading") return b.level === 1 ? <h3 key={i} className="deliverable-doc-title">{b.text}</h3> : <p key={i} className="deliverable-doc-heading">{b.text}</p>;
        if (b.type === "paragraph") return <p key={i} className={i === 1 ? "muted small" : "deliverable-doc-p"}>{b.text}</p>;
        if (b.type === "sources") return <ul key={i} className="deliverable-doc-list">{b.lines.map((l, j) => <li key={j} className="small">{l}</li>)}</ul>;
        const panel = byId.get(b.panel_id);
        return (
          <div key={i}>
            {panel && panel.chart !== "table" && chartSeries(panel).length > 0 && <RoomChart kind={panel.chart} rows={panel.rows} columns={panel.columns} title={panel.title} />}
            <div className="deliverable-doc-tablewrap">
              <table className="deliverable-doc-table">
                <thead><tr>{b.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
                <tbody>{b.rows.map((r, ri) => <tr key={ri}>{r.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>)}</tbody>
              </table>
            </div>
            {panel && <Cites panel={panel} />}
          </div>
        );
      })}
    </article>
  );
}
