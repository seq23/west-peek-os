import { pagePurpose } from "@shared/help/pagePurpose";

/**
 * The plain-English orientation block at the top of every page (P40).
 *
 * Rendered ONCE in the shell, keyed off the active nav route, rather than added to each page
 * component. Thirty-eight pages written over months means the ones nobody thinks about are exactly
 * the ones that would be missed — and Diagnostics or Contradictions are precisely where a new
 * operator most needs a sentence of orientation.
 *
 * It answers one question: should I be here? Someone who knows the page skims past it in a second.
 * HowThisWorks at the bottom of each page is the detailed version for someone already working.
 */
export function PagePurposeBlock({
  navKey,
  label,
  onNavigate,
}: {
  navKey: string;
  label: string;
  onNavigate: (key: string) => void;
}): JSX.Element | null {
  const p = pagePurpose(navKey);
  // Help itself does not need a block explaining Help.
  if (!p || navKey === "help") return null;

  return (
    /*
     * ONE LINE ACROSS THE PAGE. Not a block, and not an accordion either.
     *
     * It started as a paragraph, a wrapped list and a link stacked above every page — a third of a
     * screen, read once and scrolled past hundreds of times. Folding it into a <details> fixed the
     * height and broke something worse: "How everything works" is the way into the help system from
     * anywhere, and hiding it behind a disclosure means nobody finds it.
     *
     * So everything stays visible and gets smaller instead. The sentence and what you can do run
     * together on one line at small size; the help link is pushed to the far right by the line's
     * own width, which is where the eye already ends up.
     */
    <div className="page-purpose" data-testid={`page-purpose-${navKey}`}>
      {/* Line one runs the full width and ends with the way into the help system, which is where
          the eye already finishes. Line two is what you can do, smaller and quieter — present,
          because a page that cannot say what you do on it is not oriented, but never competing
          with the page itself. */}
      {/*
        THE HELP LINK IS A SIBLING OF THE SENTENCE, NOT INSIDE IT.
        It used to be a float inside the paragraph, declared after the text — so it attached to the
        right edge of whichever line it happened to wrap into, landing in the middle of a sentence
        break. Operator report, 21 Aug 2026: "the 'how everything works' is in the line break, it
        looks weird." As a flex sibling it sits on the first line's right edge on every page, and
        the sentence wraps in its own column without ever running into it.
      */}
      <div className="page-purpose-head">
        <p className="page-purpose-line">
          <strong>{label}.</strong> {p.purpose}
        </p>
        <button
          type="button"
          className="link-button page-purpose-help"
          data-testid={`page-purpose-help-${navKey}`}
          onClick={() => onNavigate("help")}
        >
          How everything works →
        </button>
      </div>
      <p className="page-purpose-can">
        {p.youCan.map((c, i) => (
          <span key={c}>
            {i > 0 && " · "}
            {c}
          </span>
        ))}
      </p>
    </div>
  );
}
