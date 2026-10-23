import { parseMarkdownDocument, type Block, type Inline } from "@shared/documents/markdown";

/**
 * A Markdown document, painted for reading — headings, bold, lists, tables and links that open.
 *
 * SAFE BY CONSTRUCTION. The parser (`@shared/documents/markdown`) returns a tree, and every word is
 * a React text node, so it is escaped: a `<script>` in a document reads as those characters and
 * never runs. There is no `dangerouslySetInnerHTML` here, and links carry only the schemes the
 * parser allows. Links open in a new tab, with no opener and no referrer.
 *
 * READABLE ON A PHONE AND A LAPTOP: serif body at a comfortable size, a ~70ch measure, and wide
 * tables scroll inside their own box so the page never scrolls sideways (`.doc-md` in styles.css).
 */
function Inlines({ inlines }: { inlines: Inline[] }): JSX.Element {
  return (
    <>
      {inlines.map((x, i) => {
        switch (x.kind) {
          case "text":
            return <span key={i}>{x.text}</span>;
          case "strong":
            return (
              <strong key={i}>
                <Inlines inlines={x.children} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <Inlines inlines={x.children} />
              </em>
            );
          case "code":
            return <code key={i}>{x.text}</code>;
          case "link": {
            const external = !x.href.startsWith("#") && !x.href.startsWith("/");
            return (
              <a key={i} href={x.href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                <Inlines inlines={x.children} />
              </a>
            );
          }
        }
      })}
    </>
  );
}

function BlockView({ block }: { block: Block }): JSX.Element {
  switch (block.kind) {
    case "heading":
      // The shell owns h2 (page) and h3 (the viewer's title). A document's own top two ranks are
      // h4, told apart by class; anything deeper is a bold line — the product forbids h5.
      return block.level <= 2 ? (
        <h4 className={block.level === 1 ? "doc-md-h1" : "doc-md-h2"}>
          <Inlines inlines={block.inlines} />
        </h4>
      ) : (
        <p className="doc-md-h3">
          <Inlines inlines={block.inlines} />
        </p>
      );
    case "paragraph":
      return (
        <p>
          <Inlines inlines={block.inlines} />
        </p>
      );
    case "quote":
      return (
        <blockquote>
          <Inlines inlines={block.inlines} />
        </blockquote>
      );
    case "code":
      return <pre className="doc-md-code">{block.text}</pre>;
    case "rule":
      return <hr />;
    case "list": {
      const items = block.items.map((it, n) => (
        <li key={n} className={it.depth > 0 ? `doc-md-depth-${it.depth}` : undefined}>
          <Inlines inlines={it.inlines} />
        </li>
      ));
      return block.ordered ? <ol start={block.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case "table":
      return (
        <div className="doc-md-tablewrap">
          <table>
            <thead>
              <tr>
                {block.header.map((h, i) => (
                  <th key={i} scope="col">
                    <Inlines inlines={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci}>
                      <Inlines inlines={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function MarkdownDocument({ source, testId }: { source: string; testId?: string }): JSX.Element {
  const blocks = parseMarkdownDocument(source);
  return (
    <article className="doc-md" data-testid={testId ?? "document-markdown"}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </article>
  );
}
