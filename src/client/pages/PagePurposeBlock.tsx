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
    <section className="page-purpose" data-testid={`page-purpose-${navKey}`}>
      <p className="page-purpose-what">
        <strong>{label}.</strong> {p.purpose}
      </p>
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
    </section>
  );
}
