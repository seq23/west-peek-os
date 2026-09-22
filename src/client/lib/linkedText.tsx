import { linkify } from "@shared/text/linkify";

/**
 * Render text that may carry a bare URL or a stray `<a href="...">…</a>` tag as REAL anchors —
 * never `dangerouslySetInnerHTML`. `linkify` does the parsing; this is its one renderer, so a
 * `<a>` element only ever comes from a `link` segment, never from markup interpreted as HTML. A
 * link segment's `label` is rendered as ordinary React text content, so even a label that itself
 * contains `<script>…</script>` (a stray tag nested inside a stored anchor) is shown as inert
 * characters, exactly as React renders any other string — it is never re-parsed as markup.
 *
 * See `src/shared/text/linkify.ts` for the defect this exists to fix (Addendum 1, Wave A).
 */
export function LinkedText({ text }: { text: string | null | undefined }): JSX.Element {
  const segments = linkify(text);
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "link" ? (
          <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer">
            {seg.label}
          </a>
        ) : (
          <span key={i}>{seg.value}</span>
        ),
      )}
    </>
  );
}
