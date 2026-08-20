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
     * ONE LINE, NOT FOUR BLOCKS.
     *
     * This was a paragraph at body size, then a wrapped list of everything you can do, then a link
     * — on every page, above everything, every time. The operator reads it once and then scrolls
     * past it several hundred times, and it was pushing the actual page down by a third of a screen.
     *
     * So: the sentence stays, at small size, because a page that does not say what it is for is the
     * failure this was built to fix. Everything else goes behind the same line — a <details> whose
     * summary IS the sentence, so opening it costs one click and closing it costs nothing.
     */
    <details className="page-purpose" data-testid={`page-purpose-${navKey}`}>
      <summary>
        <strong>{label}.</strong> <span className="page-purpose-what">{p.purpose}</span>
      </summary>
      <ul className="page-purpose-can">
        {p.youCan.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <button
        type="button"
        className="link-button"
        data-testid={`page-purpose-help-${navKey}`}
        onClick={() => onNavigate("help")}
      >
        How everything works →
      </button>
    </details>
  );
}
