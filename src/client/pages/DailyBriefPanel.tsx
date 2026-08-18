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
        const bulleted = lines.length > 0 && lines.every((l) => /^[-*·]\s+/.test(l));
        if (bulleted) {
          return (
            <ul key={i} className="card-list small">
              {lines.map((l, n) => <li key={n}>{bold(l.replace(/^[-*·]\s+/, ""))}</li>)}
            </ul>
          );
        }
        return <p key={i}>{bold(block)}</p>;
      })}
    </>
  );
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
      <h3>Daily intelligence</h3>
      <p className="muted small">
        What changed, what matters, and why — written from the items a sweep gathered. A sweep
        collects; this is the read.
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
