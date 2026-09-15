import { useState } from "react";
import { readableDate, shortDate } from "../lib/dates";
import { api, mutationError, useApi, type MeResponse } from "../lib/api";

/**
 * Where the daily brief gets its material — sources, watchlist, what was gathered, and the runs.
 *
 * WHAT WAS WRONG (operator, item 25: "make sure the pages are not jumbled like the events tab and
 * look more like the LP tab"). This file had 478 lines and not one heading. It was an intro
 * sentence followed by five `<details>` cards, every one of them closed on load, so a page whose
 * whole job is to explain where the brief comes from announced nothing at all: you had to open
 * five disclosures to discover it held sources, a watchlist, items, a manual sweep and a history.
 *
 * IT NOW READS IN THE ORDER SOMEBODY ASKS THE QUESTIONS. Where does the material come from → what
 * are we looking for → what came in → get more now → what has run before. Every section is a
 * plain `<h3>`, always rendered, with its own sentence for the empty case, exactly like the LP
 * page. `<details>` survives in two places only, both of them genuinely secondary detail INSIDE a
 * section that is already on screen: adding an item by hand, and a source's own status note.
 *
 * NO WORD FROM INSIDE THE MACHINE IS ON SCREEN. `EGRESS_GATED`, `HTTP_FEED`, `DISABLED`,
 * `CONFIDENTIAL`, `AI_ACCEPTED`, `SUCCEEDED` and a raw ISO timestamp all rendered here verbatim.
 * Each now has one sentence-cased phrase a first-time reader can act on, mapped in one place at
 * the top of the file so the words cannot drift apart across the page.
 */

interface SourceRow {
  id: string;
  source_key: string;
  name: string;
  kind: string;
  url: string | null;
  category: string;
  data_class: string;
  enabled: number;
  status: string;
  status_detail: string | null;
  last_checked_at: string | null;
}

interface ItemRow {
  id: string;
  title: string;
  url: string | null;
  body: string;
  category: string;
  relevance_score: number;
  relevance_reason: string;
  why_matters: string | null;
  why_matters_origin: string;
  privacy_label: string;
  created_at: string;
}

interface RunRow {
  id: string;
  trigger_kind: string;
  status: string;
  sources_attempted: number;
  sources_failed: number;
  items_acquired: number;
  items_duplicate: number;
  items_kept: number;
  source_report_json: string;
  failure_reason: string | null;
  started_at: string;
}

interface WatchRow {
  id: string;
  kind: string;
  label: string;
  company_id: string | null;
  active: number;
}

/**
 * The vocabulary, in one place.
 *
 * Every one of these was previously printed raw. A partner reading "EGRESS_GATED" cannot tell
 * whether something is broken, forbidden, or simply not built yet — which are three different
 * decisions. The phrasing says which.
 */
const SOURCE_STATE: Record<string, string> = {
  CONFIGURED: "Working",
  UNCONFIGURED: "Not set up yet",
  EGRESS_GATED: "Cannot reach the internet from here",
  FAILED: "Failed last time it was tried",
};

const SOURCE_KIND: Record<string, string> = {
  MANUAL: "Things you paste in yourself",
  INTERNAL: "West Peek's own records",
  HTTP_FEED: "A feed from outside",
};

/** Lower case, because it reads as an aside beside the thing being watched. */
const WATCH_WORD: Record<string, string> = { TOPIC: "topic", COMPANY: "company", SECTOR: "sector", PERSON: "person" };

const WATCH_KINDS = [
  { key: "TOPIC", label: "A topic" },
  { key: "COMPANY", label: "A company" },
  { key: "SECTOR", label: "A sector" },
  { key: "PERSON", label: "A person" },
] as const;

const CATEGORIES = [
  { key: "MARKET", label: "Markets" },
  { key: "SECONDARIES", label: "Secondaries" },
  { key: "FUNDING_MA", label: "Funding and M&A" },
  { key: "WATCHLIST", label: "Watchlist" },
  { key: "AI_TECH", label: "AI and technology" },
  { key: "REGULATORY", label: "Regulation" },
  { key: "PORTFOLIO", label: "Our portfolio" },
  { key: "COMPETITOR", label: "Other funds" },
  { key: "LP_SIGNAL", label: "Investor signals" },
  { key: "OPPORTUNITY", label: "An opportunity" },
  { key: "OTHER", label: "Something else" },
] as const;

/** Who may see the item. The label is a permission, so it is written as one. */
const SENSITIVITY: Record<string, string> = {
  PUBLIC: "Anyone may see this",
  INTERNAL: "The firm only",
  CONFIDENTIAL: "The firm only, handle with care",
  RESTRICTED: "Restricted",
  LP_PRIVATE: "Investor-private",
  MNPI_SENSITIVE: "Market-sensitive",
  BANKING_RESTRICTED: "Banking-restricted",
};

const WHY_ORIGIN: Record<string, string> = {
  DETERMINISTIC: "written from the item itself",
  AI_ACCEPTED: "drafted by an employee and accepted",
  AI_QUARANTINED: "drafted by an employee, not yet accepted",
  NONE: "not written yet",
};

const RUN_RESULT: Record<string, string> = {
  RUNNING: "still running",
  SUCCEEDED: "every source answered",
  PARTIAL: "some sources did not answer",
  FAILED: "failed",
};

function label(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return "—";
  return map[key] ?? key.toLowerCase().split("_").join(" ");
}

function categoryLabel(key: string): string {
  return CATEGORIES.find((c) => c.key === key)?.label ?? key.toLowerCase().split("_").join(" ");
}

function sourceTone(status: string): string {
  if (status === "CONFIGURED") return "badge badge-ok";
  if (status === "EGRESS_GATED") return "badge badge-gate";
  return "badge badge-bad";
}

function ItemCard({ item, onChanged }: { item: ItemRow; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const detail = useApi<ItemRow & { citations: Array<{ id: string; locator: string; quote: string | null; source_name: string; source_kind: string }>; feedback: Array<{ id: string; signal: string; note: string | null }> }>(
    open ? `/api/intelligence/items/${item.id}` : null,
  );

  return (
    <li className="card" data-testid={`intel-item-${item.id}`}>
      <p>
        <strong>{item.title}</strong>{" "}
        <span className="badge">{categoryLabel(item.category)}</span>{" "}
        <span className="badge">{label(SENSITIVITY, item.privacy_label)}</span>
      </p>
      <p className="muted small" data-testid={`intel-reason-${item.id}`}>
        Matched {item.relevance_score.toFixed(2)} out of 1 — {item.relevance_reason}
      </p>
      {item.why_matters && (
        <p className="small">
          {item.why_matters} <span className="muted">({label(WHY_ORIGIN, item.why_matters_origin)})</span>
        </p>
      )}
      <div className="form-row">
        <button type="button" className="link-button" data-testid={`intel-detail-${item.id}`} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide where this came from" : "Where this came from"}
        </button>
        <button
          type="button"
          data-testid={`intel-synth-${item.id}`}
          onClick={async () => {
            const res = await api<{ applied: boolean; reason: string | null }>(`/api/intelligence/items/${item.id}/synthesize`, { method: "POST" });
            setMessage(
              res.data?.applied
                ? "Why-it-matters drafted through the governed AI boundary."
                : `Not applied: ${res.data?.reason ?? `HTTP ${res.status}`}`,
            );
            onChanged();
          }}
        >
          Draft why it matters
        </button>
        <button
          type="button"
          data-testid={`intel-useful-${item.id}`}
          onClick={async () => {
            // Said only when it is true. This printed "Feedback recorded." unconditionally, so a
            // refusal and a recorded vote were the same sentence — and intelligence_feedback in
            // production holds zero rows against a page that had been reporting success.
            const failed = mutationError(
              await api(`/api/intelligence/items/${item.id}/feedback`, { method: "POST", body: { signal: "USEFUL" } }),
            );
            setMessage(failed ?? "Noted — more like this.");
          }}
        >
          Useful
        </button>
        <button
          type="button"
          data-testid={`intel-notrelevant-${item.id}`}
          onClick={async () => {
            // Said only when it is true. This printed "Feedback recorded." unconditionally, so a
            // refusal and a recorded vote were the same sentence — and intelligence_feedback in
            // production holds zero rows against a page that had been reporting success.
            const failed = mutationError(
              await api(`/api/intelligence/items/${item.id}/feedback`, { method: "POST", body: { signal: "NOT_RELEVANT" } }),
            );
            setMessage(failed ?? "Noted — less like this.");
          }}
        >
          Not relevant
        </button>
        <button
          type="button"
          data-testid={`intel-archive-${item.id}`}
          onClick={async () => {
            const res = await api(`/api/intelligence/items/${item.id}/archive`, { method: "POST" });
            setMessage(res.status === 200 ? "Put away. The record is kept; it just stops being ranked." : `Could not put it away (HTTP ${res.status}).`);
            onChanged();
          }}
        >
          Put away
        </button>
      </div>
      {message && <p className="small" data-testid={`intel-message-${item.id}`}>{message}</p>}
      {open && (
        <div data-testid={`intel-citations-${item.id}`}>
          {detail.loading && <p className="muted small">Looking it up…</p>}
          <ul className="card-list small">
            {(detail.data?.citations ?? []).map((c) => (
              <li key={c.id}>
                <strong>{c.source_name}</strong> <span className="muted">({label(SOURCE_KIND, c.source_kind)})</span> — {c.locator}
                {c.quote ? `: “${c.quote}”` : ""}
              </li>
            ))}
            {!detail.loading && (detail.data?.citations ?? []).length === 0 && (
              <li className="state-empty">Nothing was recorded about where this came from.</li>
            )}
          </ul>
          {(detail.data?.feedback ?? []).length > 0 && (
            <p className="muted small">
              You have said this is{" "}
              {(detail.data?.feedback ?? []).map((f) => (f.signal === "USEFUL" ? "useful" : "not relevant")).join(", ")}.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function IntelligencePage({ me }: { me: MeResponse }) {
  const sources = useApi<{ sources: SourceRow[]; note: string }>("/api/intelligence/sources");
  const items = useApi<{ items: ItemRow[]; ranking: string }>("/api/intelligence/items");
  const runs = useApi<{ runs: RunRow[] }>("/api/intelligence/runs");
  const watchlist = useApi<{ watchlist: WatchRow[] }>("/api/intelligence/watchlist");

  const [message, setMessage] = useState<string | null>(null);
  const [manualTitle, setManualTitle] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [manualBody, setManualBody] = useState("");
  const [manualCategory, setManualCategory] = useState("MARKET");
  const [manualLocator, setManualLocator] = useState("");
  const [watchLabel, setWatchLabel] = useState("");
  const [watchKind, setWatchKind] = useState("TOPIC");
  const [busy, setBusy] = useState(false);

  const reloadAll = () => {
    items.reload();
    runs.reload();
    sources.reload();
  };

  const lastRun = runs.data?.runs[0];
  // A screenful at a time. Several hundred items rendered at once was the complaint.
  const [itemLimit, setItemLimit] = useState(25);

  const sourceRows = sources.data?.sources ?? [];
  const watchRows = watchlist.data?.watchlist ?? [];
  const itemRows = items.data?.items ?? [];
  const runRows = runs.data?.runs ?? [];

  return (
    <section data-testid="intelligence-page">
      {/* THE BRIEF IS NOT HERE. It was a second, always-expanded copy of what Home already carries
          in full, so this page held a duplicate of the read while calling itself Sources. What is
          left is genuinely the plumbing, which is why it lives under Admin. */}
      <p className="muted small">
        Where your morning brief gets its material. Nothing here is something to read — the brief
        itself is on Home. This is what feeds it, and it is all yours to change.
      </p>

      <h3>Where the material comes from</h3>
      <p className="small">
        Each morning these are checked for anything new. A source that cannot be reached says so
        here rather than quietly returning nothing.
      </p>
      <ul className="card-list" data-testid="intel-sources">
        {sources.loading && <li className="state-message" data-testid="intel-sources-loading">Loading…</li>}
        {sourceRows.map((s) => (
          <li key={s.id} className="card" data-testid={`intel-source-${s.source_key}`}>
            <p>
              <strong>{s.name}</strong>{" "}
              <span className={sourceTone(s.status)} data-testid={`intel-source-status-${s.source_key}`}>
                {label(SOURCE_STATE, s.status)}
              </span>{" "}
              {s.enabled ? null : <span className="badge badge-bad">Switched off</span>}
            </p>
            <p className="muted small">
              {label(SOURCE_KIND, s.kind)}
              {s.last_checked_at ? ` · last looked at ${readableDate(s.last_checked_at)}` : " · never looked at yet"}
            </p>
            {/* The status note is the one genuinely secondary thing on a source: it explains a
                state the badge has already named, in the engine's own detail. */}
            {s.status_detail && (
              <details>
                <summary className="muted small">Why it says that</summary>
                <p className="muted small">{s.status_detail}</p>
              </details>
            )}
          </li>
        ))}
        {!sources.loading && sourceRows.length === 0 && (
          <li className="state-empty" data-testid="intel-no-sources">
            No sources are registered. Until one is, the only material a sweep can gather is what
            you add by hand below.
          </li>
        )}
      </ul>
      {sources.data?.note && <p className="muted small">{sources.data.note}</p>}

      <h3>What we are watching for</h3>
      <p className="small">
        Anything on this list scores higher when a sweep ranks what it found, so this is the dial
        that decides what your brief is about.
      </p>
      <form
        className="form-row"
        data-testid="intel-watch-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const res = await api<{ error?: string }>("/api/intelligence/watchlist", {
            method: "POST",
            body: { kind: watchKind, label: watchLabel, keywords: [watchLabel] },
          });
          setMessage(res.status === 201 ? `Watching “${watchLabel}” from the next sweep on.` : `Not added: ${res.data?.error ?? res.status}`);
          setWatchLabel("");
          watchlist.reload();
        }}
      >
        <label>
          What kind of thing{" "}
          <select data-testid="intel-watch-kind" value={watchKind} onChange={(e) => setWatchKind(e.target.value)}>
            {WATCH_KINDS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          What to watch{" "}
          <input data-testid="intel-watch-label" value={watchLabel} onChange={(e) => setWatchLabel(e.target.value)} placeholder="Continuation funds" />
        </label>
        <button type="submit" className="btn-strong" data-testid="intel-watch-submit">
          Watch it
        </button>
      </form>
      <ul className="card-list" data-testid="intel-watchlist">
        {watchlist.loading && <li className="state-message" data-testid="intel-watchlist-loading">Loading…</li>}
        {watchRows.map((w) => (
          <li key={w.id}>
            <strong>{w.label}</strong> <span className="muted small">{label(WATCH_WORD, w.kind)}</span>{" "}
            {w.active === 1 ? null : <span className="muted small">— paused</span>}{" "}
            <button
              type="button"
              className="link-button"
              data-testid={`intel-watch-toggle-${w.id}`}
              onClick={async () => {
                await api(`/api/intelligence/watchlist/${w.id}/active`, { method: "POST", body: { active: w.active !== 1 } });
                watchlist.reload();
              }}
            >
              {w.active === 1 ? "Stop watching" : "Resume"}
            </button>
          </li>
        ))}
        {!watchlist.loading && watchRows.length === 0 && (
          <li className="state-empty">
            Nothing on your watchlist. A watchlist match is the strongest thing a sweep can go on,
            so until you add one the ranking is working from general relevance alone.
          </li>
        )}
      </ul>

      <h3>What the sweeps have gathered</h3>
      <p className="small">
        One headline each, as the sweep found it, before anything was written about it. Your brief
        is drawn from the top of this list — this is where you check what it was working from, or
        find something it left out. You do not need to read it.
      </p>
      <p className="muted small">
        The match score is how closely something lines up with what you and the firm follow.
        Putting an item away does not delete it; it only takes it out of tomorrow's ranking.
      </p>
      {items.loading && <p className="muted small">Looking…</p>}
      {!items.loading && itemRows.length === 0 && (
        <p className="state-empty" data-testid="intel-no-items">
          Nothing gathered yet. Sweeps run each morning; you can run one yourself below.
        </p>
      )}
      <ul className="card-list" data-testid="intel-items">
        {items.loading && <li className="state-message" data-testid="intel-items-loading">Loading…</li>}
        {itemRows.slice(0, itemLimit).map((i) => (
          <ItemCard key={i.id} item={i} onChanged={reloadAll} />
        ))}
      </ul>
      {itemRows.length > itemLimit && (
        <button
          type="button"
          className="link-button"
          data-testid="intel-items-more"
          onClick={() => setItemLimit((n) => n + 25)}
        >
          Show 25 more — {itemLimit} of {itemRows.length} shown
        </button>
      )}

      <h3>Gather something now</h3>
      <p className="small">
        Sweeps run on their own every morning before your brief is written. This is for the days you
        want fresh material immediately — after adding a source, or when something has happened and
        tomorrow is too late.
      </p>
      <form
        data-testid="intel-run-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage(null);
          const manual =
            manualTitle.trim().length > 0
              ? [
                  {
                    title: manualTitle,
                    url: manualUrl.trim().length > 0 ? manualUrl : undefined,
                    body: manualBody,
                    category: manualCategory,
                    citation_locator: manualLocator.trim().length > 0 ? manualLocator : "operator desk entry",
                  },
                ]
              : [];
          const res = await api<{ run: RunRow; items: ItemRow[]; replayed: boolean; error?: string; detail?: string }>(
            "/api/intelligence/runs",
            {
              method: "POST",
              body: {
                idempotency_key: `manual-${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`,
                manual_items: manual,
              },
            },
          );
          setBusy(false);
          if (res.data?.run) {
            const r = res.data.run;
            // Counts, in the order somebody wants them: what came in, what was already known,
            // what survived. The run's own status word is spelled out rather than shouted.
            setMessage(
              `Done — ${label(RUN_RESULT, r.status)}. ${r.sources_attempted} source${r.sources_attempted === 1 ? "" : "s"} checked, ` +
                `${r.items_acquired} found, ${r.items_duplicate} already known, ${r.items_kept} kept.`,
            );
            setManualTitle("");
            setManualUrl("");
            setManualBody("");
            setManualLocator("");
            reloadAll();
          } else {
            setMessage(`The sweep did not run: ${res.data?.detail ?? res.data?.error ?? res.status}`);
          }
        }}
      >
        <p className="muted small" data-testid="intel-sweep-explainer">
          A sweep checks every source above for anything published since the last one, drops what it
          already has, ranks the rest against your watchlist, and adds it to the list above. It
          sends nothing out and changes nothing outside this page.
        </p>

        {/* Adding one item by hand is genuinely secondary to the button beside it, and folding it
            away is what stopped "Run a sweep" reading as an ambiguous two-in-one form. */}
        <details className="intel-manual-add summary-button" data-testid="intel-manual-add">
          <summary>Add something I found myself</summary>
          <p className="muted small">
            Use this when you read something the sources will not pick up — a conversation, a
            paywalled article, a document. It joins this sweep as one item.
          </p>
          <div className="form-row">
            <label>
              Headline{" "}
              <input data-testid="intel-manual-title" value={manualTitle} onChange={(e) => setManualTitle(e.target.value)} />
            </label>
            <label>
              What it is about{" "}
              <select data-testid="intel-manual-category" value={manualCategory} onChange={(e) => setManualCategory(e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              Link <input data-testid="intel-manual-url" value={manualUrl} onChange={(e) => setManualUrl(e.target.value)} placeholder="https://…" />
            </label>
            <label>
              Where it came from{" "}
              <input
                data-testid="intel-manual-locator"
                value={manualLocator}
                onChange={(e) => setManualLocator(e.target.value)}
                placeholder="e.g. FT, 12 Aug"
              />
            </label>
          </div>
          <div className="form-row">
            <textarea
              data-testid="intel-manual-body" aria-label="What the item says"
              rows={2}
              style={{ width: "100%" }}
              value={manualBody}
              onChange={(e) => setManualBody(e.target.value)}
              placeholder="Context"
            />
          </div>
        </details>

        <button type="submit" className="btn-strong" data-testid="intel-run-submit" disabled={busy}>
          {busy ? "Sweeping…" : "Run a sweep"}
        </button>
      </form>
      {message && <p className="notice" data-testid="intel-run-message" role="status">{message}</p>}
      {lastRun && (
        <p className="muted small" data-testid="intel-last-run">
          Last sweep {readableDate(lastRun.started_at)} — {label(RUN_RESULT, lastRun.status)}
          {lastRun.failure_reason ? ` (${lastRun.failure_reason})` : ""}
        </p>
      )}

      <h3>Every sweep that has run</h3>
      <p className="small">
        The record of what was gathered and when. If your brief looks thin, this says whether a
        sweep ran at all and whether a source failed in it.
      </p>
      <ul className="card-list small" data-testid="intel-runs">
        {runs.loading && <li className="state-message" data-testid="intel-runs-loading">Loading…</li>}
        {runRows.map((r) => (
          <li key={r.id}>
            <strong>{shortDate(r.started_at)}</strong> — {label(RUN_RESULT, r.status)}: {r.items_kept} kept,{" "}
            {r.items_duplicate} already known
            {r.sources_failed > 0 ? `, ${r.sources_failed} source${r.sources_failed === 1 ? "" : "s"} did not answer` : ""}
          </li>
        ))}
        {!runs.loading && runRows.length === 0 && (
          <li className="state-empty">
            No sweep has run yet. A sweep gathers material from your sources; the brief on Home is
            what you actually read.
          </li>
        )}
      </ul>
      <p className="muted small">Signed in as {me.fullName}.</p>
    </section>
  );
}
