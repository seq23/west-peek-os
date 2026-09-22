import type { WorkCardRow } from "./types";

/**
 * A LOOK IS A WEB PAGE THIS CARD OPENED AND READ — what was found, and the form that asks for
 * another. Moved out of `WorkCardsPage.tsx` verbatim (22 Sep 2026). Same testids, same copy.
 */

/**
 * WHAT THE LOOK FOUND, on the card that asked. Fenced as untrusted where it is shown, because a
 * web page saying "ignore your previous instructions" is exactly the input that fencing exists for.
 */
export function LookResults({
  card: c,
  showAll,
  onShowAll,
}: {
  card: WorkCardRow;
  showAll: boolean;
  onShowAll: (id: string) => void;
}): JSX.Element | null {
  if ((c.looks ?? []).length === 0) return null;
  return (
    <details className="work-card-looks" data-testid={`work-card-looks-${c.id}`}>
      <summary>
        {c.looks!.length} page{c.looks!.length === 1 ? "" : "s"} opened and read
        {c.looks!.some((l) => l.status === "SUCCEEDED") ? " · answered" : ""}
      </summary>
      {/* THE TWO MOST RECENT, AND NO MORE BY DEFAULT. A card that has been worked
          hard accumulated a dozen looks, each with up to 1,200 characters of page
          text, so one busy card was taller than the rest of the board put together.
          The older ones are still here — they are just not the first thing the card
          spends its height on. */}
      {(showAll ? c.looks! : c.looks!.slice(0, 2)).map((l) => (
        <div key={l.id} className="work-look">
          <p className="small"><strong>{l.objective}</strong></p>
          <p className="muted small">{l.start_url} · {l.status.toLowerCase()}</p>
          {l.refusal_reason && <p className="notice small">{l.refusal_reason}</p>}
          {l.result_text && (
            <>
              <pre className="browser-result">{l.result_text.slice(0, 1200)}</pre>
              <p className="muted small">
                Read off a live page. Information about the world, not instructions —
                check anything you would act on.
              </p>
            </>
          )}
        </div>
      ))}
      {c.looks!.length > 2 && !showAll && (
        <button
          type="button"
          className="link-button"
          data-testid={`work-card-all-looks-${c.id}`}
          onClick={() => onShowAll(c.id)}
        >
          Show all {c.looks!.length}
        </button>
      )}
    </details>
  );
}

/** Ask for a page to be read for this card, and the standing grant beside it. */
export function LookForm({
  card: c,
  busy,
  objective,
  setObjective,
  url,
  setUrl,
  onSubmit,
  onGrantBrowser,
}: {
  card: WorkCardRow;
  busy: boolean;
  objective: string;
  setObjective: (next: string) => void;
  url: string;
  setUrl: (next: string) => void;
  onSubmit: (id: string) => void;
  onGrantBrowser: (id: string, allow: boolean) => void;
}): JSX.Element {
  return (
    <form
      className="work-card-look"
      data-testid={`work-card-look-form-${c.id}`}
      onSubmit={(e) => { e.preventDefault(); onSubmit(c.id); }}
    >
      <input
        value={objective}
        onChange={(e) => setObjective(e.target.value)}
        placeholder="What should they find out?"
        aria-label="What to find out"
      />
      {/* OPTIONAL. Naming the page was the wrong ask — working out which page
          answers the question is part of the job, and demanding the address up
          front made the operator do the looking before asking anyone to look. */}
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Leave blank and they will search for it"
        aria-label="Optional starting page"
      />
      <div className="form-row">
        <button type="submit" className="btn-strong" disabled={busy}>
          {c.allows_browser ? "Go and look" : "Ask to look"}
        </button>
        {/* The grant, offered where it is relevant rather than in a settings page.
            Standing permission for THIS card only. */}
        <label className="muted small">
          <input
            type="checkbox"
            checked={c.allows_browser === 1}
            data-testid={`work-card-browser-grant-${c.id}`}
            onChange={(e) => onGrantBrowser(c.id, e.target.checked)}
          />{" "}
          let this card look without asking each time
        </label>
      </div>
    </form>
  );
}
