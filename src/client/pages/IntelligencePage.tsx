import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";

/**
 * Daily Intelligence surface (P14, GAP-05).
 *
 * Shows the engine as it actually is: which sources are readable and which are gated,
 * what a run acquired/deduped/kept, why each item ranked where it did, and where the
 * item came from. Nothing here presents a gated source as a working one.
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

function statusTone(status: string): string {
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
        <span className="badge">{item.category}</span> <span className="badge">{item.privacy_label}</span>
      </p>
      <p className="muted small" data-testid={`intel-reason-${item.id}`}>
        score {item.relevance_score.toFixed(2)} — {item.relevance_reason}
      </p>
      {item.why_matters && (
        <p className="small">
          {item.why_matters} <code>{item.why_matters_origin}</code>
        </p>
      )}
      <div className="form-row">
        <button type="button" className="link-button" data-testid={`intel-detail-${item.id}`} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide sources" : "Sources"}
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
            await api(`/api/intelligence/items/${item.id}/feedback`, { method: "POST", body: { signal: "USEFUL" } });
            setMessage("Feedback recorded.");
          }}
        >
          Useful
        </button>
        <button
          type="button"
          data-testid={`intel-notrelevant-${item.id}`}
          onClick={async () => {
            await api(`/api/intelligence/items/${item.id}/feedback`, { method: "POST", body: { signal: "NOT_RELEVANT" } });
            setMessage("Feedback recorded.");
          }}
        >
          Not relevant
        </button>
        <button
          type="button"
          data-testid={`intel-archive-${item.id}`}
          onClick={async () => {
            const res = await api(`/api/intelligence/items/${item.id}/archive`, { method: "POST" });
            setMessage(res.status === 200 ? "Archived. The record is preserved." : `Archive refused (HTTP ${res.status}).`);
            onChanged();
          }}
        >
          Archive
        </button>
      </div>
      {message && <p className="small" data-testid={`intel-message-${item.id}`}>{message}</p>}
      {open && (
        <div data-testid={`intel-citations-${item.id}`}>
          {detail.loading && <p className="muted small">Loading provenance…</p>}
          <ul className="card-list small">
            {(detail.data?.citations ?? []).map((c) => (
              <li key={c.id}>
                <code>{c.source_name}</code> ({c.source_kind}) — {c.locator}
                {c.quote ? `: “${c.quote}”` : ""}
              </li>
            ))}
          </ul>
          {(detail.data?.feedback ?? []).length > 0 && (
            <p className="muted small">
              Feedback: {(detail.data?.feedback ?? []).map((f) => f.signal).join(", ")}
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

  return (
    <section data-testid="intelligence-page">
      {/* THE BRIEF IS NOT HERE ANY MORE. It was a second, always-expanded copy of what Home
          already carries in full — Home shows the one-minute version and expands the whole report
          in place — so this page was holding a duplicate of the read while calling itself Sources.
          What is left is genuinely setup: where material comes from, and what was done with it.
          That is why it now lives under Admin. */}
      <p className="muted small">
        Where your briefing gets its material. Nothing here is something to read — the brief itself
        is on Home, and this is the plumbing behind it.
      </p>


      {/* Sources, watchlist and history are REFERENCE, not the point of the page — they were
          taking most of the screen above the items you actually came to read. Collapsed by
          default using native <details> so they stay keyboard-operable and findable. */}
      <details className="card intel-panel" data-testid="intel-sources-panel">
        <summary>
          Sources <span className="muted small">{(sources.data?.sources ?? []).length}</span>
        </summary>
        {sources.loading && <p>Loading sources…</p>}
        <ul className="card-list" data-testid="intel-sources">
        {(sources.data?.sources ?? []).map((s) => (
          <li key={s.id} className="card" data-testid={`intel-source-${s.source_key}`}>
            <p>
              <strong>{s.name}</strong> <span className="badge">{s.kind}</span>{" "}
              <span className={statusTone(s.status)} data-testid={`intel-source-status-${s.source_key}`}>
                {s.status}
              </span>{" "}
              {s.enabled ? "" : <span className="badge badge-bad">DISABLED</span>}
            </p>
            {s.status_detail && <p className="muted small">{s.status_detail}</p>}
            {s.last_checked_at && <p className="muted small">last checked {s.last_checked_at}</p>}
          </li>
        ))}
      </ul>
        {sources.data?.note && <p className="muted small">{sources.data.note}</p>}
      </details>

      <details className="card intel-panel" data-testid="intel-watchlist-panel">
        <summary>
          Watchlist <span className="muted small">{(watchlist.data?.watchlist ?? []).length}</span>
        </summary>
        <p className="muted small">
          Anything on this list scores higher when a sweep ranks new items.
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
          setMessage(res.status === 201 ? `Watching “${watchLabel}”.` : `Refused: ${res.data?.error ?? res.status}`);
          setWatchLabel("");
          watchlist.reload();
        }}
      >
        <select data-testid="intel-watch-kind" aria-label="Kind of thing to watch" value={watchKind} onChange={(e) => setWatchKind(e.target.value)}>
          {["TOPIC", "COMPANY", "SECTOR", "PERSON"].map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input data-testid="intel-watch-label" aria-label="What to watch" value={watchLabel} onChange={(e) => setWatchLabel(e.target.value)} placeholder="What should we watch?" />
        <button type="submit" className="btn-strong" data-testid="intel-watch-submit">
          Watch
        </button>
      </form>
      <ul className="card-list" data-testid="intel-watchlist">
        {(watchlist.data?.watchlist ?? []).map((w) => (
          <li key={w.id}>
            {w.label} <span className="badge">{w.kind}</span>{" "}
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
        {!watchlist.loading && (watchlist.data?.watchlist ?? []).length === 0 && (
          <li className="state-empty">Nothing on your watchlist. Watchlist matches are the strongest ranking signal.</li>
        )}
      </ul>
      </details>

      {/* WHAT AN ITEM IS was never stated anywhere, and the page rendered every one of several
          hundred at full height. The operator's verdict — too long, not understood, overbearing —
          was all three true at once. It is raw material, so it reads as raw material: folded away,
          explained, and shown a screenful at a time. */}
      <details className="card intel-panel" data-testid="intel-items-panel">
        <summary>
          Everything gathered <span className="muted small">{(items.data?.items ?? []).length}</span>
        </summary>
        <p className="muted small">
          One headline each, as the sweep found it — before anything was written. Your brief is
          drawn from the top of this list, so this is where you check what it was working from, or
          find something it left out. You do not need to read it.
        </p>
        <p className="muted small">
          The score is how closely an item matched what you and the firm follow. Nothing here is
          deleted when a brief is written; archiving one only takes it out of tomorrow's ranking.
        </p>

        {items.loading && <p>Loading…</p>}
        {!items.loading && (items.data?.items ?? []).length === 0 && (
          <p className="state-empty" data-testid="intel-no-items">
            Nothing gathered yet. Sweeps run each morning; there is a manual one below.
          </p>
        )}
        <ul className="card-list" data-testid="intel-items">
          {(items.data?.items ?? []).slice(0, itemLimit).map((i) => (
            <ItemCard key={i.id} item={i} onChanged={reloadAll} />
          ))}
        </ul>
        {(items.data?.items ?? []).length > itemLimit && (
          <button
            type="button"
            className="link-button"
            data-testid="intel-items-more"
            onClick={() => setItemLimit((n) => n + 25)}
          >
            Show 25 more — {itemLimit} of {(items.data?.items ?? []).length} shown
          </button>
        )}
      </details>

      <details className="card intel-panel" data-testid="intel-sweep-panel">
        <summary>Gather now, by hand</summary>
        <p className="muted small">
          Sweeps run on their own every morning before your brief is written. This is here for the
          days you want fresh material immediately — after adding a source, or when something has
          happened and you do not want to wait for tomorrow.
        </p>
        <p className="muted small">
          A run acquires from enabled sources, drops duplicates firm-wide, scores against your watchlists, and stores a
          citation for every item kept. Running twice with the same key replays the first run instead of acquiring again.
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
              setMessage(
                `Run ${r.status}: ${r.sources_attempted} source(s) attempted, ${r.sources_failed} failed, ${r.items_acquired} acquired, ${r.items_duplicate} duplicate, ${r.items_kept} kept.`,
              );
              setManualTitle("");
              setManualUrl("");
              setManualBody("");
              setManualLocator("");
              reloadAll();
            } else {
              setMessage(`Run failed: ${res.data?.detail ?? res.data?.error ?? res.status}`);
            }
          }}
        >
          {/* The form does TWO things and used to look like one, which is why nobody could tell what
              "Run a sweep" would do. The button checks your sources; the fields below add a single
              item you found yourself. They are now labelled and separated. */}
          <p className="muted small" data-testid="intel-sweep-explainer">
            <strong>Run a sweep</strong> checks every enabled source below for anything published
            since the last sweep, drops duplicates, ranks what is left against your watchlist, and
            adds it to Items. It sends nothing and changes nothing outside this page.
          </p>

          {/* Styled as a real button. As a bare <summary> this read as a line of prose and the
              operator's verdict was that it did not look like a button at all — which is the whole
              job of the control, since nothing else on the page tells you that you can add to what
              gets read for you. */}
          <details className="intel-manual-add summary-button" data-testid="intel-manual-add">
            <summary>Add something I found myself</summary>
            <p className="muted small">
              Use this when you read something the sources will not pick up — a conversation, a
              paywalled article, a document. It is added to this sweep as one item.
            </p>
            <div className="form-row">
            <label>
              Headline{" "}
              <input data-testid="intel-manual-title" value={manualTitle} onChange={(e) => setManualTitle(e.target.value)} />
            </label>
            <label>
              Category{" "}
              <select data-testid="intel-manual-category" value={manualCategory} onChange={(e) => setManualCategory(e.target.value)}>
                {["MARKET", "SECONDARIES", "FUNDING_MA", "WATCHLIST", "AI_TECH", "REGULATORY", "PORTFOLIO", "COMPETITOR", "LP_SIGNAL", "OPPORTUNITY", "OTHER"].map((c) => (
                  <option key={c} value={c}>
                    {c}
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
                placeholder="citation, e.g. 'FT, 12 Aug'"
              />
            </label>
          </div>
          <div className="form-row">
            <textarea
              data-testid="intel-manual-body" aria-label="The item to add by hand"
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
        {message && <p className="notice" data-testid="intel-run-message">{message}</p>}
        {lastRun && (
          <p className="muted small" data-testid="intel-last-run">
            Last run {lastRun.status} at {lastRun.started_at}
            {lastRun.failure_reason ? ` — ${lastRun.failure_reason}` : ""}
          </p>
        )}
      </details>

      <details className="card intel-panel" data-testid="intel-history-panel">
        <summary>Sweep history</summary>
      <ul className="card-list small" data-testid="intel-runs">
        {(runs.data?.runs ?? []).map((r) => (
          <li key={r.id}>
            <code>{r.status}</code> {r.started_at} — {r.items_kept} kept / {r.items_duplicate} duplicate /{" "}
            {r.sources_failed} source failure(s)
          </li>
        ))}
        {!runs.loading && (runs.data?.runs ?? []).length === 0 && <li className="state-empty">No sweeps yet. A sweep gathers items from your sources; the Daily Brief is what you read.</li>}
      </ul>
      </details>
    </section>
  );
}
