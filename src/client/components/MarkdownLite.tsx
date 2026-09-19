import { parseMarkdown, type Inline } from "@shared/help/markdownLite";

/**
 * Paints the little Markdown a host speaks — paragraph, heading, numbered list, bullets, bold.
 *
 * The parser is shared with the worker (`@shared/help/markdownLite`) so what the guide renderer
 * writes and what this paints cannot disagree about where a list starts. The type scale is the
 * product's: everything here sits at `--text-sm`, headings one weight up rather than one size up,
 * because a chat turn that suddenly grows a 22px heading has stopped being a chat turn.
 */
function Inlines({ inlines }: { inlines: Inline[] }): JSX.Element {
  return (
    <>
      {inlines.map((x, i) => (x.kind === "strong" ? <strong key={i}>{x.text}</strong> : <span key={i}>{x.text}</span>))}
    </>
  );
}

export function MarkdownLite({ text, className }: { text: string; className?: string }): JSX.Element {
  const blocks = parseMarkdown(text);
  return (
    <div className={className ?? "md-lite"}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading":
            // The product has three heading ranks (h2 answer · h3 band · h4 panel) and a rule
            // against a fourth: a `##` inside a turn is the panel rank, and anything deeper is a
            // bold line rather than a new rank.
            return b.level === 2 ? (
              <h4 key={i} className="md-lite-head">
                <Inlines inlines={b.inlines} />
              </h4>
            ) : (
              <p key={i} className="md-lite-head">
                <Inlines inlines={b.inlines} />
              </p>
            );
          case "ordered":
            return (
              <ol key={i} className="md-lite-list">
                {b.items.map((it, n) => (
                  <li key={n}>
                    <Inlines inlines={it} />
                  </li>
                ))}
              </ol>
            );
          case "bulleted":
            return (
              <ul key={i} className="md-lite-list">
                {b.items.map((it, n) => (
                  <li key={n}>
                    <Inlines inlines={it} />
                  </li>
                ))}
              </ul>
            );
          default:
            return (
              <p key={i}>
                <Inlines inlines={b.inlines} />
              </p>
            );
        }
      })}
    </div>
  );
}
