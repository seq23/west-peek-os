/**
 * WHAT A DOCUMENT IS, IN WORDS.
 *
 * Operator, 15 Sep 2026: "what is type, diligence_note? what other types are there?" The Documents
 * page offered a free-text box defaulting to `diligence_note`, showed each row as
 * `title — diligence_note · INTERNAL`, and gave no list. The stored value stays a short key —
 * other services write `REVIEW`, `BRIEF`, `IMAGE`, `administrator_statement` — but every reader
 * sees a label and a sentence, and the upload form offers a list, not a box.
 */
export interface DocumentType {
  key: string;
  label: string;
  /** One line a partner reads before choosing it. */
  means: string;
}

export const DOCUMENT_TYPES: readonly DocumentType[] = [
  { key: "DECK", label: "The LP deck", means: "A version of the fund's deck. It goes on the record as a numbered version and waits on your approval on Fund strategy before it becomes the deck the firm sends." },
  { key: "DILIGENCE_NOTE", label: "Diligence note", means: "Something you learned about a company — a memo, a call note, a data-room extract. Claims can be read out of it on the company's evidence page." },
  { key: "REVIEW", label: "Review", means: "A written review the firm produced: the weekly operating review, a deck-versus-records check, meeting prep." },
  { key: "BRIEF", label: "Brief", means: "A briefing written for a partner — the morning brief, a pre-read." },
  { key: "LP_STATEMENT", label: "LP statement", means: "A statement or letter as sent to limited partners." },
  { key: "IMAGE", label: "Image", means: "A picture — a chart, a screenshot, a photo." },
  { key: "OTHER", label: "Other", means: "Anything that is none of the above. Say what it is in the title." },
] as const;

/** Old spellings that still arrive from other services and older rows, mapped to the key above. */
const ALIASES: Record<string, string> = {
  diligence_note: "DILIGENCE_NOTE",
  administrator_statement: "LP_STATEMENT",
  lp_statement: "LP_STATEMENT",
  deck: "DECK",
  review: "REVIEW",
  brief: "BRIEF",
  image: "IMAGE",
  other: "OTHER",
};

export function normaliseDocumentType(raw: string): string {
  const trimmed = raw.trim();
  if (DOCUMENT_TYPES.some((t) => t.key === trimmed)) return trimmed;
  return ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

export function documentTypeLabel(raw: string): string {
  const key = normaliseDocumentType(raw);
  const known = DOCUMENT_TYPES.find((t) => t.key === key);
  if (known) return known.label;
  // An unknown key still reads as words: "administrator_statement" → "Administrator statement".
  const words = key.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
