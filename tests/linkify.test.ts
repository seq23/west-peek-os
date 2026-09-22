import { describe, expect, it } from "vitest";
import { linkify, hasLink } from "../src/shared/text/linkify";

/**
 * A LINK IN PLAIN TEXT IS STILL A LINK (Addendum 1, Wave A).
 *
 * Confirmed against the live prod card page (wc_9374245b): `block_needed` and the preview notice
 * text render a bare URL, and at least one card rendered a literal `<a href="...">...</a>` tag as
 * on-screen text — `https://...pages.dev' · https://...pages.dev</a` — because it was
 * string-interpolated into a text node rather than parsed. The guard here is at the parser: no
 * `text` segment may ever contain `<a` or `</a>`, and every URL — bare or already tagged — comes
 * back as a real `link` segment a caller renders as a real anchor.
 */
describe("linkify", () => {
  it("turns a bare URL in a sentence into a link segment", () => {
    const segs = linkify("Look at it here: https://westpeek-network-os.pages.dev/preview/pr-5. The PR: https://github.com/x/y/pull/5.");
    const links = segs.filter((s) => s.kind === "link");
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ href: "https://westpeek-network-os.pages.dev/preview/pr-5" });
    expect(links[1]).toMatchObject({ href: "https://github.com/x/y/pull/5" });
    // Neither surviving text segment carries the URL verbatim — it was extracted, not merely found.
    for (const s of segs) if (s.kind === "text") expect(s.value).not.toMatch(/https?:\/\//);
  });

  it("reproduces the exact production defect and repairs it: a literal <a> tag in text", () => {
    // The real symptom on wc_9374245b, reconstructed: a model's own words carried a finished anchor
    // tag, stored verbatim, and rendered as literal characters.
    const stored = `Two previews are ready: 'https://a.pages.dev' · <a href="https://b.pages.dev">https://b.pages.dev</a>`;
    const segs = linkify(stored);
    // NO SEGMENT OF KIND text MAY CONTAIN THE LITERAL SUBSTRING '<a' OR '</a>' — this is the guard
    // that pins the defect cannot come back, whatever the exact wording drifts to.
    for (const s of segs) {
      if (s.kind === "text") {
        expect(s.value).not.toContain("<a");
        expect(s.value).not.toContain("</a");
      }
    }
    const links = segs.filter((s) => s.kind === "link");
    expect(links).toHaveLength(2);
    expect(links.some((l) => l.kind === "link" && l.href === "https://a.pages.dev")).toBe(true);
    expect(links.some((l) => l.kind === "link" && l.href === "https://b.pages.dev")).toBe(true);
  });

  it("never trusts the tag's own markup beyond href and label — no nested markup executes", () => {
    const segs = linkify(`<a href="https://evil.example/x"><script>alert(1)</script></a>`);
    const link = segs.find((s) => s.kind === "link");
    expect(link).toBeDefined();
    if (link?.kind === "link") {
      // The label is exactly the text between the tags; nothing is interpreted as markup by this
      // parser (the caller renders it as a plain string inside a real <a>, never re-parsed as HTML).
      expect(link.label).toContain("<script>");
      expect(link.href).toBe("https://evil.example/x");
    }
  });

  it("drops trailing sentence punctuation from a bare URL, keeping it in the following text", () => {
    const segs = linkify("See https://example.com/page. It explains everything.");
    const link = segs.find((s) => s.kind === "link");
    expect(link).toMatchObject({ href: "https://example.com/page" });
    const joined = segs.map((s) => (s.kind === "link" ? s.href : s.value)).join("");
    // The period is not swallowed — it lands in the text that follows.
    expect(joined).toContain(".");
  });

  it("returns plain text unchanged when there is nothing to link", () => {
    const segs = linkify("Nothing here needs a decision.");
    expect(segs).toEqual([{ kind: "text", value: "Nothing here needs a decision." }]);
  });

  it("handles null, undefined and empty input without throwing", () => {
    expect(linkify(null)).toEqual([]);
    expect(linkify(undefined)).toEqual([]);
    expect(linkify("")).toEqual([]);
  });

  it("hasLink is true only when a real link segment exists", () => {
    expect(hasLink("plain sentence")).toBe(false);
    expect(hasLink("see https://x.example")).toBe(true);
  });
});
