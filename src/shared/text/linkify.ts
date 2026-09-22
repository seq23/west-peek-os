/**
 * A LINK IN PLAIN TEXT IS STILL A LINK (Addendum 1, Wave A, 22 Sep 2026).
 *
 * Confirmed against the live prod card page (wc_9374245b): `block_needed` and the preview notice
 * text (`previewBlockText` in `services/webPropertyChange.ts`) are built as PLAIN SENTENCES that
 * carry a bare URL — "Look at it here: https://…pages.dev" — and, on at least one production card,
 * a stray HTML anchor a model's own words had embedded, `<a href="...">...</a>`. Interpolated
 * straight into a text node, React escapes both faithfully: a real reader saw the literal
 * characters `https://...pages.dev' · https://...pages.dev</a` on screen, never a clickable link.
 *
 * THE FIX IS NEVER `dangerouslySetInnerHTML`. Trusting arbitrary stored text (some of it written by
 * a model) as HTML would be a bigger defect than the one it fixes. Instead: parse the string into
 * segments — plain text, a bare URL, or a literal anchor tag already sitting in the text — and hand
 * the caller real segments to render as real `<a>` elements. No segment of kind `text` may ever
 * contain `<a` or `</a>` as a substring; `tests/linkify.test.ts` pins that against the exact
 * strings production produced.
 */

export interface TextSegment {
  kind: "text";
  value: string;
}

export interface LinkSegment {
  kind: "link";
  href: string;
  label: string;
}

export type Segment = TextSegment | LinkSegment;

/**
 * Matches, in document order:
 *   1. a literal `<a href="...">label</a>` tag already sitting in the text (the historical
 *      defect this exists to repair) — group 1 is the href, group 2 is the label;
 *   2. a bare `http(s)://…` URL with no markup around it at all — the ordinary case.
 * Quotes, parens and brackets are excluded from the URL charset, so a URL written `'like this'` or
 * `(like this)` in a sentence is captured without its surrounding punctuation.
 */
const SEGMENT_PATTERN = /<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>|https?:\/\/[^\s<>"')\]]+/gi;

/** Trailing punctuation a sentence leaves against a bare URL — never part of the address. */
function trimTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:]+$/, "");
}

/**
 * Parse plain text that may carry a bare URL or an already-embedded anchor tag into segments a
 * caller renders as real `<a>` elements for `link` and plain text otherwise.
 *
 * NEVER LOSES A CHARACTER. Every segment concatenated back together — treating a `link` segment
 * as its original matched text — reproduces the input exactly; the trailing-punctuation trim above
 * moves the trimmed characters into the following `text` segment rather than dropping them.
 */
export function linkify(input: string | null | undefined): Segment[] {
  const s = input ?? "";
  if (!s) return [];
  const segments: Segment[] = [];
  let last = 0;
  for (const m of s.matchAll(SEGMENT_PATTERN)) {
    const idx = m.index ?? 0;
    if (idx > last) segments.push({ kind: "text", value: s.slice(last, idx) });
    if (m[1] !== undefined) {
      // A literal anchor tag already in the text. Its own href and label, not re-derived.
      const label = (m[2] ?? "").trim() || m[1];
      segments.push({ kind: "link", href: m[1], label });
      last = idx + m[0].length;
    } else {
      const trimmed = trimTrailingPunctuation(m[0]);
      segments.push({ kind: "link", href: trimmed, label: trimmed });
      last = idx + trimmed.length;
    }
  }
  if (last < s.length) segments.push({ kind: "text", value: s.slice(last) });
  return segments;
}

/** True if any segment is a real link — used to decide whether a sentence needs linking at all. */
export function hasLink(input: string | null | undefined): boolean {
  return linkify(input).some((seg) => seg.kind === "link");
}
