import { pagePurpose } from "@shared/help/pagePurpose";
import { HELP_FOCUS_KEY } from "./HelpCenterPage";

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

  // Split the sentence so its last word can be tied to the link. `lastIndexOf` rather than a
  // split/join round trip: the purpose text is prose and must survive verbatim, whitespace and all.
  const cut = p.purpose.lastIndexOf(" ");
  const lead = cut === -1 ? "" : p.purpose.slice(0, cut);
  const tail = cut === -1 ? p.purpose : p.purpose.slice(cut + 1);

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
        THE HELP LINK JUST FOLLOWS THE SENTENCE. No float, no flex row, no right edge.

        It was `float: right` declared after the text, so it attached to the right edge of whichever
        line it wrapped into — landing mid-paragraph. Making it a flex sibling fixed that and bought
        a worse problem: space-between pushed it to the far right of a row whose sentence ends
        wherever it ends, so the gap between them was the width of half the page, and it aligned to
        the sentence's last line rather than its first. Operator, twice: "it looks weird", then "why
        is there a huge fucking space and why is the last sentence on a new line".

        Both attempts were trying to POSITION it. It is a link at the end of a sentence, so it goes
        at the end of the sentence — inline, one space after the full stop. There is then no gap to
        get wrong and no line for it to be orphaned on.
      */}
      <p className="page-purpose-line">
        <strong>{label}.</strong> {lead}{lead ? " " : ""}
        {/* The final word and the link travel together — a widow guard. Inline is right, but on a
            page whose sentence happens to fill the line the link would drop to a line of its own,
            which reads as an orphan rather than as the end of a sentence. Bound to the last word it
            can never sit alone: either both fit, or both wrap. */}
        <span className="page-purpose-tail">
          {tail}{" "}
          <button
            type="button"
            className="link-button page-purpose-help"
            data-testid={`page-purpose-help-${navKey}`}
            onClick={() => {
              // Land on THIS page's section of Help, not the top of it. The same mechanism as
              // Documents' focus: the key is left for the Help tab to read once on arrival.
              try {
                sessionStorage.setItem(HELP_FOCUS_KEY, navKey);
              } catch {
                /* a private window may refuse; the top of Help is still a fine place to land */
              }
              onNavigate("help");
            }}
          >
            How everything works →
          </button>
        </span>
      </p>
      {/* An archived page says so first, so a bookmark that lands here reads the reason before the
          controls — a surface that is still reachable but no longer listed has to explain itself. */}
      {p.archived && (
        <p className="notice notice-gate small" data-testid={`page-archived-${navKey}`}>
          {p.archived}
        </p>
      )}
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
