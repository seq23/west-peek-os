import { toSections } from "@shared/deliverables/sections";

/**
 * A deliverable, rendered as the document it is.
 *
 * WHAT THIS REPLACES. Every deliverable on Home opened as `<pre className="deliverable-body">` —
 * the entire body, monospaced, unwrapped, at any length. Parker's October event kit is 5,621
 * characters carrying a recommendation, three angles, an eight-row run of show, five questions for
 * the guest and two social drafts, and it arrived as one grey block. The owner: "the kit should not
 * arrive on the fucking card that sounds like hell."
 *
 * ONE RENDERER FOR EVERY KIND, on the surface that already exists. Home's deliverable list is where
 * every brief, packet and kit already lands, so a page per kit would be a second home to maintain
 * that nothing else benefits from. Her requirement, stated plainly: "make them reusable so that
 * future kits are all there and you have one page with all the kits." This renders the one surface
 * properly instead of building another.
 *
 * DEGRADES, NEVER DROPS. `toSections` is total — an unrecognised body becomes paragraphs, which
 * still beats `<pre>`, and no line is discarded. The only input deliberately not rendered is a
 * `|---|---|` table rule, which carries no content.
 */
export function DeliverableDocument({ body, testId }: { body: string; testId?: string }): JSX.Element {
  const { title, sections } = toSections(body);

  return (
    <article className="deliverable-doc" data-testid={testId}>
      {title && <h4 className="deliverable-doc-title">{title}</h4>}
      {sections.map((section, si) => (
        <section className="deliverable-doc-section" key={`${section.heading ?? "intro"}-${si}`}>
          {/* NOT A HEADING ELEMENT, deliberately. The shell renders the page title as an h2, a
              section as h3 and a thing inside one as h4; `dealRecordLayout.test.ts` forbids h5
              anywhere in the client because "there is nothing deeper to navigate to". A run-of-show
              label is exactly that — a label on a block, not a destination — so it is a <p> that
              reads as an eyebrow, and the document outline stays honest. */}
          {section.heading && <p className="deliverable-doc-heading">{section.heading}</p>}
          {section.blocks.map((block, bi) => {
            const key = `${si}-${bi}`;
            if (block.type === "paragraph") {
              // A recommendation is the decision she is being asked to make, so it is lifted out of
              // the run of prose rather than left to be found in it.
              const isRecommendation = /^\s*RECOMMEND(ED|ATION)\b/i.test(block.text);
              return (
                <p className={isRecommendation ? "deliverable-doc-recommendation" : "deliverable-doc-p"} key={key}>
                  {block.text}
                </p>
              );
            }
            if (block.type === "list") {
              return (
                <ul className="deliverable-doc-list" key={key}>
                  {block.items.map((item, ii) => (
                    <li key={`${key}-${ii}`}>{item}</li>
                  ))}
                </ul>
              );
            }
            return (
              // Wide tables scroll in their own container so the page itself never scrolls sideways.
              <div className="deliverable-doc-tablewrap" key={key}>
                <table className="deliverable-doc-table">
                  <thead>
                    <tr>
                      {block.header.map((h, hi) => (
                        <th key={`${key}-h-${hi}`} scope="col">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, ri) => (
                      <tr key={`${key}-r-${ri}`}>
                        {row.map((cell, ci) => (
                          <td key={`${key}-r-${ri}-${ci}`}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </section>
      ))}
    </article>
  );
}
