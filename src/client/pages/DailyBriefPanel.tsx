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

        // A markets table. The model is asked for one because a column of levels is read by
        // comparison — the eye goes down it — and the same figures in prose are not.
        if (lines.length >= 2 && lines.every((l) => l.startsWith("|") && l.endsWith("|"))) {
          const rows = lines
            .filter((l) => !/^\|[\s|:-]+\|$/.test(l))
            .map((l) => l.slice(1, -1).split("|").map((c) => c.trim()));
          const [head, ...body] = rows;
          if (head && body.length > 0) {
            return (
              <div key={i} className="brief-table-wrap">
                <table className="brief-table">
                  <thead>
                    <tr>{head.map((c, n) => <th key={n}>{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {body.map((r, n) => (
                      <tr key={n}>{r.map((c, m) => <td key={m}>{bold(c)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
        }

        // Traffic lights. Every line of the block must be one, so an ordinary paragraph that
        // happens to contain the word "red" is never repainted as a status row.
        const lights = lines.map(readLight);
        if (lines.length >= 2 && lights.every(Boolean)) {
          return (
            <ul key={i} className="brief-lights" data-testid="brief-classification">
              {lights.map((l, n) => (
                <li key={n}>
                  <span className={`light light-${l!.tone}`} aria-hidden="true" />
                  <strong>{l!.label}</strong>
                  <span className="muted small">{l!.why}</span>
                  {/* The colour is never the only carrier — it is repeated as a word for anyone
                      who cannot separate the three, and for anyone reading this aloud. */}
                  <span className="sr-only">{l!.tone}</span>
                </li>
              ))}
            </ul>
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
 * The model is asked for "**Investor Importance: 8/10**" because a fixed shape is what makes a score
 * comparable across a page. Rendering it as bold prose would waste that — the reader is scanning
 * for the nines, and a number they have to read a sentence to find is not scannable.
 */
function extractImportance(line: string): { score: number; rest: string } | null {
  const m = line.match(/\*\*(?:Investor\s+)?Importance:\s*(\d{1,2})\s*\/\s*10\*\*\s*/i);
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

/**
 * Read one classification line: `Equities: YELLOW — earnings strong, discount-rate pressure rising`.
 *
 * Returns null unless the line is exactly that shape, which is what lets the caller require EVERY
 * line in a block to parse before it renders any of them as status.
 */
function readLight(line: string): { label: string; tone: string; why: string } | null {
  const m = line
    .replace(/^[-*·]\s+/, "")
    .match(/^\*{0,2}([A-Za-z][A-Za-z /&-]{1,40}?)\*{0,2}:\s*\*{0,2}(GREEN|YELLOW|RED)\*{0,2}\s*[—–-]\s*(.+)$/i);
  if (!m) return null;
  return { label: m[1]!.trim(), tone: m[2]!.toLowerCase(), why: m[3]!.trim() };
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

/**
 * The report, whole or folded.
 *
 * ON HOME IT ARRIVES FOLDED. The full report is thousands of words by design — that length is the
 * product, not padding — but Home is where a partner checks what is waiting on them, and a wall of
 * text there means the rest of the page is never seen. So Home gets the part that is meant to be
 * readable in a minute (the numbered summary and the traffic lights), and the rest opens in place
 * on a click. Sources keeps the whole thing open: that page is where you go to READ it.
 */

interface InterestsState {
  firm: { sectors: string[]; themes: string[] };
  mine: { sectors: string[]; themes: string[]; companies: string[] };
  suggestions: Array<{ group: string; items: string[] }>;
  note: string;
}

/**
 * What this partner's brief covers, and the controls to change it.
 *
 * TWO KINDS OF CHIP, deliberately looking different. Firm interests carry no remove button because
 * there is no removing them — a partner should still hear that a portfolio company is in trouble
 * whatever else they follow. The partner's own come off with one click, because an interest you
 * cannot drop is a subscription rather than a preference.
 *
 * SUGGESTIONS EXIST BECAUSE A BLANK BOX ASKS THE WRONG QUESTION. "What are you interested in" is
 * hard to answer cold and easy to answer from a list, and the groups are named after the job
 * somebody does so a partner recognises their own column.
 */
function InterestsEditor(): JSX.Element {
  const state = useApi<InterestsState>("/api/daily-intelligence/interests");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<"themes" | "sectors">("themes");
  const [message, setMessage] = useState<string | null>(null);

  const data = state.data;
  const mine = data?.mine ?? { sectors: [], themes: [], companies: [] };

  async function save(next: { sectors: string[]; themes: string[] }) {
    setBusy(true);
    const res = await api<{ note?: string }>("/api/daily-intelligence/interests", {
      method: "POST",
      body: { sectors: next.sectors, themes: next.themes },
    });
    setBusy(false);
    setMessage(res.status === 201 ? (res.data?.note ?? "Saved.") : `Could not save (HTTP ${res.status}).`);
    state.reload();
  }

  function add(value: string, into: "themes" | "sectors") {
    const v = value.trim();
    if (!v) return;
    const existing = into === "themes" ? mine.themes : mine.sectors;
    if (existing.some((e) => e.toLowerCase() === v.toLowerCase())) return;
    void save({
      sectors: into === "sectors" ? [...mine.sectors, v] : mine.sectors,
      themes: into === "themes" ? [...mine.themes, v] : mine.themes,
    });
  }

  function remove(value: string, from: "themes" | "sectors") {
    void save({
      sectors: from === "sectors" ? mine.sectors.filter((x) => x !== value) : mine.sectors,
      themes: from === "themes" ? mine.themes.filter((x) => x !== value) : mine.themes,
    });
  }

  const alreadyHave = new Set(
    [...mine.themes, ...mine.sectors, ...(data?.firm.themes ?? []), ...(data?.firm.sectors ?? [])].map((x) =>
      x.toLowerCase(),
    ),
  );

  return (
    /*
     * A QUIET DISCLOSURE, not the loudest thing on the page.
     *
     * `summary-button` paints the accent across the whole control, which was written for the one
     * action a page wants you to take. On Home that made "What my brief covers" — a reference
     * panel you open once a month — shout louder than "Ask for something" and "Build today's
     * brief", the two things somebody actually comes here to do. The accent marks one thing; this
     * is not it.
     */
    <details className="card" data-testid="brief-interests">
      <summary className="muted small">What my brief covers</summary>

      {state.loading && <p className="muted small">Loading…</p>}
      {data && (
        <>
          <p className="muted small">{data.note}</p>

          <h4>On every partner&apos;s brief</h4>
          <ul className="chip-row" data-testid="interests-firm">
            {[...data.firm.sectors, ...data.firm.themes].map((f) => (
              <li key={f} className="chip chip-fixed">{f}</li>
            ))}
          </ul>

          <h4>Mine</h4>
          {mine.themes.length + mine.sectors.length === 0 ? (
            <p className="muted small" data-testid="interests-mine-empty">
              Nothing added yet — your brief reads like the firm&apos;s. Add something below and it
              starts leading with what you actually care about.
            </p>
          ) : (
            <ul className="chip-row" data-testid="interests-mine">
              {mine.sectors.map((v) => (
                <li key={`s-${v}`} className="chip">
                  {v}
                  <button type="button" disabled={busy} aria-label={`Remove ${v}`} onClick={() => remove(v, "sectors")}>×</button>
                </li>
              ))}
              {mine.themes.map((v) => (
                <li key={`t-${v}`} className="chip">
                  {v}
                  <button type="button" disabled={busy} aria-label={`Remove ${v}`} onClick={() => remove(v, "themes")}>×</button>
                </li>
              ))}
            </ul>
          )}

          <form
            className="form-row"
            onSubmit={(e) => { e.preventDefault(); add(draft, kind); setDraft(""); }}
          >
            <label style={{ flexGrow: 1 }}>
              Add your own{" "}
              <input
                data-testid="interests-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="how attention is bought, held and measured"
              />
            </label>
            <label>
              as a{" "}
              <select value={kind} onChange={(e) => setKind(e.target.value as "themes" | "sectors")}>
                <option value="themes">theme</option>
                <option value="sectors">sector</option>
              </select>
            </label>
            <button type="submit" className="btn-strong" disabled={busy || draft.trim().length < 2}>
              {busy ? "…" : "Add"}
            </button>
          </form>

          <h4>Or pick from these</h4>
          {data.suggestions.map((g) => (
            <div key={g.group} className="suggestion-group">
              <p className="muted small"><strong>{g.group}</strong></p>
              <ul className="chip-row">
                {g.items
                  .filter((i) => !alreadyHave.has(i.toLowerCase()))
                  .map((i) => (
                    <li key={i}>
                      <button
                        type="button"
                        className="chip chip-add"
                        disabled={busy}
                        data-testid={`interest-suggest-${i.slice(0, 18)}`}
                        onClick={() => add(i, "themes")}
                      >
                        + {i}
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          ))}

          {message && <p className="notice small">{message}</p>}
        </>
      )}
    </details>
  );
}

export function DailyBriefPanel({ compact = false }: { compact?: boolean } = {}): JSX.Element {
  const state = useApi<{ report: Report | null; sections: Section[]; citations: Citation[]; date: string; no_brief_because?: string | null }>("/api/daily-intelligence");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

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

  // What survives the fold on Home: the one-minute version, and the ten-second version under it.
  // Everything else is the long read.
  const ABOVE_FOLD = ["executive_summary", "classification"];
  const folded = compact && !expanded;
  const shown = folded ? sections.filter((s) => ABOVE_FOLD.includes(s.section_key)) : sections;
  const hiddenCount = sections.length - shown.length;

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
          {/* The reason the schedule gives, not a blank. A partner who cannot tell "nothing today"
              from "this is broken" stops trusting the thing she reads first every morning. */}
          {state.data?.no_brief_because ?? "No brief for today yet. Run a sweep first so there is something to read, then build it."}
        </p>
      )}

      {report && report.verification_flags > 0 && (
        <p className="notice" data-testid="daily-brief-flags">
          {report.verification_flags} section{report.verification_flags === 1 ? " was" : "s were"} held
          back: the checks found a claim that its own sources did not support.
        </p>
      )}

      {shown.map((s) => {
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

      {folded && hiddenCount > 0 && (
        <button
          type="button"
          className="brief-expand"
          data-testid="daily-brief-expand"
          onClick={() => setExpanded(true)}
        >
          Read the full report
          <span className="muted small">
            {hiddenCount} more section{hiddenCount === 1 ? "" : "s"} — headlines, markets, what is
            scheduled today
          </span>
        </button>
      )}

      {compact && expanded && (
        <button type="button" className="link-button" data-testid="daily-brief-collapse" onClick={() => setExpanded(false)}>
          Fold it back up
        </button>
      )}

      {/* AT THE FOOT, because the moment you want this is just after reading a brief that missed
          something. It sat on the Sources page, which is now Admin plumbing and the wrong home for
          a personal preference about your own daily read. One folded line until you open it. */}
      <InterestsEditor />
    </section>
  );
}
