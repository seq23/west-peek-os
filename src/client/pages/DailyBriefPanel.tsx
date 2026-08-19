import { useState } from "react";
import { api, useApi } from "../lib/api";

/**
 * The expanded Daily Intelligence report (P41), rendered on the Sweeps page directly under the
 * sweep module — the operator's requested placement, and the right one: a sweep GATHERS, the brief
 * is what you READ, so the two belong in that order on one page.
 *
 * Sections render in the order the pipeline stored them, and each carries its real sources. Those
 * come from `intelligence_item` records, never from the model, so a link here always points at
 * something that was actually fetched.
 */

interface Section {
  section_key: string;
  heading: string;
  body_md: string;
  item_ids_json: string;
  position: number;
}
interface Citation { id: string; title: string; url: string | null; publisher: string | null }
interface Report {
  id: string; report_date: string; status: string; model: string | null;
  prompt_version: string | null; candidate_count: number; verification_flags: number;
  raw_count: number; deduped_count: number; completed_at: string | null;
}

/** Minimal markdown: paragraphs, bullets and bold. The model is asked for prose, not documents. */
function renderBody(md: string): JSX.Element {
  const blocks = md.split(/\n\s*\n/);
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);

        const scored = extractImportance(block);
        if (scored) {
          return (
            <p key={i} className="brief-scored">
              <span className={importanceClass(scored.score)}>{scored.score}/10</span>
              {bold(scored.rest)}
            </p>
          );
        }

        const bulleted = lines.length > 0 && lines.every((l) => /^[-*·]\s+/.test(l));
        if (bulleted) {
          return (
            <ul key={i} className="card-list small">
              {lines.map((l, n) => <li key={n}>{bold(l.replace(/^[-*·]\s+/, ""))}</li>)}
            </ul>
          );
        }

        const numbered = lines.length > 1 && lines.every((l) => /^\d+[.)]\s+/.test(l));
        if (numbered) {
          return (
            <ol key={i} className="brief-numbered">
              {lines.map((l, n) => <li key={n}>{bold(l.replace(/^\d+[.)]\s+/, ""))}</li>)}
            </ol>
          );
        }
        return <p key={i}>{bold(block)}</p>;
      })}
    </>
  );
}

/**
 * Pull an importance score out of a line so it can be shown as a chip rather than as bold text.
 *
 * The model is asked for "**Importance: 8/10**" because a fixed shape is what makes a score
 * comparable across a page. Rendering it as bold prose would waste that — the reader is scanning
 * for the nines, and a number they have to read a sentence to find is not scannable.
 */
function extractImportance(line: string): { score: number; rest: string } | null {
  const m = line.match(/\*\*Importance:\s*(\d{1,2})\s*\/\s*10\*\*\s*/i);
  if (!m) return null;
  const score = Number(m[1]);
  if (!Number.isFinite(score) || score < 0 || score > 10) return null;
  return { score, rest: line.replace(m[0], "").trim() };
}

function importanceClass(score: number): string {
  // Ten means it changes a decision the firm is about to make. Only that band earns the accent.
  if (score >= 9) return "importance importance-high";
  if (score >= 7) return "importance importance-mid";
  return "importance";
}

function bold(text: string): JSX.Element {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>,
      )}
    </>
  );
}

export function DailyBriefPanel(): JSX.Element {
  const state = useApi<{ report: Report | null; sections: Section[]; citations: Citation[]; date: string }>("/api/daily-intelligence");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const report = state.data?.report ?? null;
  const sections = state.data?.sections ?? [];
  const citations = new Map((state.data?.citations ?? []).map((c) => [c.id, c]));

  async function generate() {
    setBusy(true);
    setMessage(null);
    const res = await api<{ status?: string; candidates?: number; detail?: string; error?: string }>(
      "/api/daily-intelligence/generate", { method: "POST", body: {} },
    );
    if (res.status !== 201) setMessage(res.data?.detail ?? res.data?.error ?? `Could not build the brief (HTTP ${res.status}).`);
    else if (res.data?.status !== "READY") setMessage(`Brief did not complete: ${res.data?.status}.`);
    setBusy(false);
    state.reload();
  }

  function sourcesFor(s: Section): Citation[] {
    let ids: string[] = [];
    try { ids = JSON.parse(s.item_ids_json) as string[]; } catch { ids = []; }
    return ids.map((i) => citations.get(i)).filter((c): c is Citation => Boolean(c));
  }

  return (
    <section className="card daily-brief" data-testid="daily-brief">
      <header className="brief-masthead">
        <h3>Executive Intelligence Report</h3>
        {report && (
          <span className="brief-edition">
            {report.report_date}
            {report.completed_at
              ? ` · delivered ${new Date(report.completed_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
              : ""}
          </span>
        )}
      </header>
      <p className="muted small">
        Written from what the sweep gathered overnight and the levels read this morning. Every
        figure carries the source it came from; where a level could not be read, the report says so
        rather than estimating.
      </p>

      <div className="form-row">
        <button type="button" className="btn-strong" disabled={busy} data-testid="daily-brief-generate" onClick={generate}>
          {busy ? "Reading everything…" : report ? "Rebuild today's brief" : "Build today's brief"}
        </button>
        {report && (
          <span className="muted small" data-testid="daily-brief-meta">
            {report.report_date} · {report.raw_count} items → {report.deduped_count} events →{" "}
            {report.candidate_count} considered
            {report.model ? ` · ${report.model}` : ""}
          </span>
        )}
      </div>

      {message && <p className="notice" data-testid="daily-brief-message">{message}</p>}

      {!report && !state.loading && (
        <p className="state-empty" data-testid="daily-brief-empty">
          No brief for today yet. Run a sweep first so there is something to read, then build it.
        </p>
      )}

      {report && report.verification_flags > 0 && (
        <p className="notice" data-testid="daily-brief-flags">
          {report.verification_flags} section{report.verification_flags === 1 ? " was" : "s were"} held
          back: the checks found a claim that its own sources did not support.
        </p>
      )}

      {sections.map((s) => {
        const srcs = sourcesFor(s);
        return (
          <section key={s.section_key} className="brief-section" data-testid={`brief-${s.section_key}`}>
            <h4>{s.heading}</h4>
            {renderBody(s.body_md)}
            {srcs.length > 0 && (
              <p className="muted small brief-sources">
                Sources:{" "}
                {srcs.map((c, i) => (
                  <span key={c.id}>
                    {i > 0 && " · "}
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer noopener">{c.publisher ?? c.title}</a>
                    ) : (
                      (c.publisher ?? c.title)
                    )}
                  </span>
                ))}
              </p>
            )}
          </section>
        );
      })}
    </section>
  );
}
