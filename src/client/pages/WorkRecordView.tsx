import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { readableDate, shortDate } from "../lib/dates";
import {
  NO_KIND_FILTER_VALUE,
  RECORD_STATES,
  bandByMonth,
  isFiltered,
  monthLabel,
  recordSummary,
  type RecordOriginKind,
  type RecordPage,
  type RecordRow,
  type RecordState,
} from "@shared/work/record";

/**
 * THE RECORD — the second of the Work page's three addresses.
 *
 * WHAT THIS REPLACES, and the numbers are measured rather than remembered. The Work page rendered
 * finished work as `<details open>` containing `finished.slice(0, 50)` of a payload the server had
 * capped at 500 rows. On 18 Sep 2026, against a database holding a realistic 200 days of output:
 *
 *   531 finished cards · 50 reachable from the page · 481 absent with nothing saying so
 *   3,300px of undifferentiated list, inside the same scroll as the two things waiting on her
 *   the top of that list was three identical "build the September 2026 Room packet" rows
 *
 * The owner's test is "can she find last month's Room packet in ten seconds on day 200". The old
 * page could not do it at all — the packet was one of the 481.
 *
 * ── WHY SEARCH FIRST AND MONTH SECOND ─────────────────────────────────────────────────────────
 *
 * She suggested filtering by month, and month is the right SPINE: it is how finished work is
 * naturally shaped and it is what makes a long list scannable. It is the wrong PRIMARY control,
 * because the thing she remembers is what a piece of work WAS, not which month it landed in — and
 * a month filter makes her guess before it will show her anything. So the free-text box is first
 * and focused by `/`, the month is a filter beside it, and every result arrives inside its month
 * band whether or not she used either.
 *
 * ── WHY THE RECORD IS NOT A TO-DO ─────────────────────────────────────────────────────────────
 *
 * It is behind its own tab rather than at the bottom of the desk. Sharing a scroll with live work
 * is what made 496 finished cards compete with two blocked ones, and no amount of collapsing fixes
 * that: a collapsed section is still a thing she scrolls past, and on the 199 days out of 200 when
 * she is not looking anything up, the desk should be the whole page.
 *
 * ── THE PERMANENT READ-ONLY VERSION OF THE CARD PAGE (Addendum 4, 22 Sep 2026) ──────────────────
 *
 * Her decision, settling "what Record does more of": a finished card is not summarised here a
 * second time in a shape of its own — Wave A's `WorkCardPage.tsx` (`#/work/<id>`) already renders a
 * DONE/CANCELLED card correctly, read-only, with its full message trail, decisions and artifacts.
 * So a row's title is the door into that same page rather than a second renderer; Record's job is
 * "list and filter well, then link into the real card page" — by kind, by owner, by origin
 * (`originOf()`/`originBadgeText()`, `@shared/work/origin`, built by Wave C — reused, not
 * reinvented), by outcome and by a date range, on top of the search and month it already had.
 */

const PAGE_SIZE = 40;

interface Props {
  /** Reopen or put back the most recent run in a group. Returns once the board has been reloaded. */
  onMove: (id: string, state: "OPEN") => Promise<void> | void;
  onNavigate: (key: string) => void;
  /** Bumped by the parent whenever a card changes state, so the record re-reads itself. */
  refreshNonce: number;
}

export function WorkRecordView({ onMove, onNavigate, refreshNonce }: Props): JSX.Element {
  const [q, setQ] = useState("");
  /** What has actually been sent to the server. Debounced, so typing is not one request per key. */
  const [applied, setApplied] = useState("");
  const [who, setWho] = useState("");
  const [month, setMonth] = useState("");
  const [state, setState] = useState<RecordState>("ALL");
  const [kind, setKind] = useState("");
  const [origin, setOrigin] = useState<RecordOriginKind | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState<RecordPage | null>(null);
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const searchBox = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setApplied(q.trim()), 220);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(
    async (append: string | null) => {
      setLoading(true);
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (applied) params.set("q", applied);
      if (who) params.set("who", who);
      if (month) params.set("month", month);
      if (state !== "ALL") params.set("state", state);
      if (kind) params.set("kind", kind);
      if (origin) params.set("origin", origin);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (append) params.set("cursor", append);
      const res = await api<RecordPage & { error?: string; detail?: string }>(`/api/work-cards/record?${params}`);
      setLoading(false);
      if (res.status !== 200 || !res.data || res.data.error) {
        /*
         * SAID OUT LOUD. A record that fails to load and renders an empty list is the same lie the
         * silent 50-row cap told, and she would read it as "the firm has done nothing".
         */
        setFailed(res.data?.detail ?? res.data?.error ?? `the record did not load (HTTP ${res.status})`);
        return;
      }
      setFailed(null);
      setPage(res.data);
      setCursor(res.data.next_cursor);
      setRows((prev) => (append ? [...prev, ...res.data!.rows] : res.data!.rows));
    },
    [applied, who, month, state, kind, origin, from, to],
  );

  useEffect(() => {
    void load(null);
  }, [load, refreshNonce]);

  /** `/` focuses the search, the way every search over a long list on this machine already does. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      if (typing) return;
      e.preventDefault();
      searchBox.current?.focus();
      searchBox.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filtered = isFiltered({ q: applied, who, month, state, kind, origin, from, to });
  const bands = bandByMonth(rows);

  return (
    <section data-testid="work-record" className="work-region">
      <div className="work-band-head">
        <h3>The record</h3>
        <p className="work-band-note">
          Everything the firm has finished
          {page?.since ? ` since ${readableDate(page.since)}` : ""}. Search it — you remember what a thing{" "}
          <em>was</em>, not which month it landed in.
        </p>
      </div>

      <div className="record-controls" data-testid="work-record-controls">
        <label className="record-field record-field-grow">
          <span className="lbl">Search the record</span>
          <input
            ref={searchBox}
            type="search"
            value={q}
            data-testid="work-record-search"
            placeholder="room packet, press pitches, LP letter…"
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label className="record-field">
          <span className="lbl">Who did it</span>
          <select data-testid="work-record-who" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Anyone</option>
            {(page?.people ?? []).map((p) => (
              <option key={p.owner_id} value={p.owner_id}>
                {p.name} ({p.cards})
              </option>
            ))}
          </select>
        </label>
        <label className="record-field">
          <span className="lbl">When</span>
          <select data-testid="work-record-month" value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="">Every month</option>
            {(page?.months ?? []).map((m) => (
              <option key={m.month} value={m.month}>
                {m.label} ({m.cards})
              </option>
            ))}
          </select>
        </label>
        {/* KIND, OWNER, ORIGIN, OUTCOME AND A DATE RANGE (Addendum 4) — not just full-text search.
            Origin reuses `RecordOriginKind`/`recordOriginLabel`, the same six categories
            `originOf()`/`originBadgeText()` name, never a second vocabulary invented here. */}
        <label className="record-field">
          <span className="lbl">Kind</span>
          <select data-testid="work-record-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Any kind</option>
            {(page?.kinds ?? []).map((k) => (
              <option key={k.kind || NO_KIND_FILTER_VALUE} value={k.kind || NO_KIND_FILTER_VALUE}>
                {k.label} ({k.cards})
              </option>
            ))}
          </select>
        </label>
        <label className="record-field">
          <span className="lbl">Where it came from</span>
          <select
            data-testid="work-record-origin"
            value={origin}
            onChange={(e) => setOrigin(e.target.value as RecordOriginKind | "")}
          >
            <option value="">Any origin</option>
            {(page?.origins ?? []).map((o) => (
              <option key={o.origin} value={o.origin}>
                {o.label} ({o.cards})
              </option>
            ))}
          </select>
        </label>
        <label className="record-field">
          <span className="lbl">From</span>
          <input type="date" data-testid="work-record-from" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="record-field">
          <span className="lbl">To</span>
          <input type="date" data-testid="work-record-to" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {/* DONE AND DROPPED ARE BOTH THE RECORD. A decision not to do something is a decision, and
            a record that quietly omitted it would be a highlight reel. */}
        <div className="record-states" role="group" aria-label="Which finished work">
          {RECORD_STATES.map((s) => (
            <button
              key={s}
              type="button"
              className={`record-state${state === s ? " is-on" : ""}`}
              aria-pressed={state === s}
              data-testid={`work-record-state-${s.toLowerCase()}`}
              onClick={() => setState(s)}
            >
              {s === "ALL" ? "All" : s === "DONE" ? "Done" : s === "CANCELLED" ? "Dropped" : "Stowed"}
            </button>
          ))}
        </div>
      </div>

      {failed ? (
        <p className="notice" data-testid="work-record-failed">
          {failed}. Nothing has been lost — this is the page failing to read it, not the record being empty.
        </p>
      ) : (
        <p className="record-summary muted small" data-testid="work-record-summary">
          {page
            ? recordSummary({ matched: page.matched, total: page.total, rows }, filtered)
            : "Reading the record…"}
          {". Press "}
          <kbd>/</kbd> to search.
        </p>
      )}

      {!failed && page && rows.length === 0 && !loading && (
        <div className="card" data-testid="work-record-empty">
          <p>
            <strong>Nothing in the record matches that.</strong>
          </p>
          <p className="muted small">
            {filtered
              ? `The record holds ${page.total.cards.toLocaleString()} finished cards — widen the search or clear the filters.`
              : "The firm has not finished anything yet. Finished and dropped cards land here and stay."}
          </p>
          {filtered && (
            <button
              type="button"
              className="link-button"
              data-testid="work-record-clear"
              onClick={() => {
                setQ("");
                setWho("");
                setMonth("");
                setState("ALL");
                setKind("");
                setOrigin("");
                setFrom("");
                setTo("");
              }}
            >
              Clear the filters
            </button>
          )}
        </div>
      )}

      {bands.map((band) => (
        <div key={band.month} className="record-band" data-testid={`work-record-month-${band.month}`}>
          {/* THE SPINE. The month is a heading a reader can aim at, not a row of its own. */}
          <div className="record-band-head">
            <h4>{band.label}</h4>
            <span className="muted small">
              {band.rows.length} row{band.rows.length === 1 ? "" : "s"}
            </span>
          </div>
          <ul className="record-rows">
            {/* KEYED ON r.id, NOT ON THE VISIBLE COLUMNS (Addendum 4): a one-off card never
                collapses, so two of them can now legitimately share month/title/owner/state as
                separate rows — a key built from those alone would collide between them. */}
            {band.rows.map((r) => (
              <li key={r.id} className="record-row" data-testid={`work-record-row-${r.id}`}>
                <span className="record-when">{shortDate(r.at)}</span>
                <span className="record-what">
                  {/* THE ROW OPENS THE REAL CARD PAGE (Addendum 4): `WorkCardPage.tsx` already
                      renders a DONE/CANCELLED card correctly, read-only, with its full trail — the
                      title is the door into it rather than a second, shallower renderer here. */}
                  <button
                    type="button"
                    className="link-button record-title"
                    data-testid={`work-record-open-${r.id}`}
                    onClick={() => {
                      window.location.hash = `#/work/${r.id}`;
                    }}
                  >
                    {r.title}
                  </button>
                  <span className="record-meta">
                    <span className={r.state === "DONE" ? "badge badge-ok" : "badge"}>
                      {/* STOWED IS ITS OWN LABEL, NEVER "DROPPED" (Addendum 10, 22 Sep 2026) — a
                          card the intake classifier caught as banter shares `state = 'CANCELLED'`
                          with a real Drop, but reads as something a person actually decided against
                          only when it wasn't one. */}
                      {r.auto_resolution === "NO_ACTION_NEEDED" ? "Stowed" : r.state === "CANCELLED" ? "Dropped" : "Done"}
                    </span>
                    {/* ORIGIN, AT A GLANCE (Addendum 4/Addendum 1's "origin isn't named at a
                        glance"): `originBadgeText()`'s own words, computed server-side. */}
                    <span className="badge" data-testid={`work-record-origin-${r.id}`}>
                      {r.origin_label}
                    </span>
                    {r.result && <span className="muted small record-result">{r.result}</span>}
                    {/* BOTH LABELS, HERE TOO. "So we can have a trail of how it's working" is a
                        question asked of finished work more often than of live work — a trail you
                        can only read while the card is still open is not a trail. */}
                    <span className={r.model_access === "PRIVATE_MODEL_ONLY" ? "badge badge-gate" : "badge"}>
                      {r.model_access === "PRIVATE_MODEL_ONLY" ? "private model only" : "public model approved"}
                    </span>
                    <span className="badge">{r.audience === "EXTERNAL" ? "external" : "internal"}</span>
                  </span>
                  {/* THREE IDENTICAL ROWS WERE READING AS THREE ACHIEVEMENTS. They are one piece of
                      work attempted three times, and the count says so on one line. */}
                  {r.runs > 1 && (
                    <span className="record-runs" data-testid={`work-record-runs-${r.id}`}>
                      ran {r.runs}× this month — identical, collapsed into one row
                    </span>
                  )}
                </span>
                <span className="record-doors">
                  {r.kind === "DECK_REWORK" && r.state === "DONE" && (
                    <button type="button" className="link-button" onClick={() => onNavigate("fund-strategy")}>
                      Decide on Fund strategy
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid={`work-card-undrop-${r.id}`}
                    title={
                      r.runs > 1
                        ? `Puts the most recent of the ${r.runs} runs back on the board`
                        : "Puts it back on the board as open"
                    }
                    onClick={() => void onMove(r.id, "OPEN")}
                  >
                    {r.state === "CANCELLED" ? "Put it back" : "Reopen"}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {cursor && (
        <div className="record-more">
          <button type="button" data-testid="work-record-more" disabled={loading} onClick={() => void load(cursor)}>
            {loading ? "…" : `Show the next ${PAGE_SIZE}`}
          </button>
          <span className="muted small">
            {rows.length.toLocaleString()} of {(page?.matched.rows ?? 0).toLocaleString()} rows shown
          </span>
        </div>
      )}
    </section>
  );
}

/** Re-exported so the page can label a tab without importing the shared module twice. */
export { monthLabel };
