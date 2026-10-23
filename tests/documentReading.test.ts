import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { inlineText, parseInline, parseMarkdownDocument, safeHref, isMarkdownType, type Block } from "../src/shared/documents/markdown";
import { MarkdownDocument } from "../src/client/components/MarkdownDocument";
import { buildShelf, downloadName, groupOf, plainTitle, seriesKey, shelfCount, type ShelfDoc } from "../src/shared/documents/shelf";

/**
 * Documents, formatted for the owner's consumption (23 Oct 2026). "View here" showed Markdown as raw
 * monospace; the shelf was one pile under type codes, titles were email snippets, and every weekly
 * discrepancy register appeared twice. These pin the reading and the sorting.
 */

const SAMPLE = [
  "# The Example Club Playbook",
  "",
  "Intro with **bold words**, *emphasis*, `code` and a [link to the site](https://example.com/page).",
  "",
  "## Money",
  "",
  "| Tier | Amount |",
  "|---|---:|",
  "| Title | $25,000 |",
  "| Partner \\| in kind | $5,000 |",
  "",
  "- first point",
  "  continues here",
  "- second point",
  "  - nested point",
  "",
  "1. step one",
  "2. step two",
  "",
  "### Small heading",
  "> a quote",
  "",
  "---",
  "Last line · with a middle dot – and a dash.",
].join("\n");

describe("Markdown reads as a document", () => {
  const blocks = parseMarkdownDocument(SAMPLE);
  const kinds = blocks.map((b) => b.kind);

  it("finds headings at their levels", () => {
    const heads = blocks.filter((b): b is Extract<Block, { kind: "heading" }> => b.kind === "heading");
    expect(heads.map((h) => [h.level, inlineText(h.inlines)])).toEqual([
      [1, "The Example Club Playbook"],
      [2, "Money"],
      [3, "Small heading"],
    ]);
  });

  it("turns a pipe table into rows and cells, with an escaped pipe kept as text", () => {
    const table = blocks.find((b): b is Extract<Block, { kind: "table" }> => b.kind === "table")!;
    expect(table.header.map(inlineText)).toEqual(["Tier", "Amount"]);
    expect(table.rows.map((r) => r.map(inlineText))).toEqual([
      ["Title", "$25,000"],
      ["Partner | in kind", "$5,000"],
    ]);
  });

  it("reads bold, emphasis, code and links inline", () => {
    const para = blocks.find((b) => b.kind === "paragraph")! as Extract<Block, { kind: "paragraph" }>;
    expect(para.inlines.map((i) => i.kind)).toEqual(["text", "strong", "text", "em", "text", "code", "text", "link", "text"]);
    const link = para.inlines.find((i) => i.kind === "link") as { href: string };
    expect(link.href).toBe("https://example.com/page");
  });

  it("keeps lists, their continuation lines and their nesting; drops no line", () => {
    const lists = blocks.filter((b): b is Extract<Block, { kind: "list" }> => b.kind === "list");
    expect(lists[0]!.ordered).toBe(false);
    expect(lists[0]!.items.map((i) => [i.depth, inlineText(i.inlines)])).toEqual([
      [0, "first point continues here"],
      [0, "second point"],
      [1, "nested point"],
    ]);
    expect(lists[1]!.ordered).toBe(true);
    expect(lists[1]!.items).toHaveLength(2);
    expect(kinds).toContain("quote");
    expect(kinds).toContain("rule");
    expect(inlineText((blocks.at(-1) as Extract<Block, { kind: "paragraph" }>).inlines)).toBe("Last line · with a middle dot – and a dash.");
  });

  it("paints real headings, a table, bold and a link that opens safely", () => {
    const html = renderToStaticMarkup(createElement(MarkdownDocument, { source: SAMPLE }));
    expect(html).toContain('<h4 class="doc-md-h1">');
    expect(html).toContain('<h4 class="doc-md-h2">');
    expect(html).toContain("<table>");
    expect(html).toContain("<th scope=\"col\">");
    expect(html).toContain("<strong>");
    expect(html).toMatch(/<a href="https:\/\/example.com\/page" target="_blank" rel="noopener noreferrer">/);
    expect(html).not.toContain("<h5");
    expect(html).not.toMatch(/(^|\s)#\s/);
    expect(html).not.toContain("**");
    expect(html).not.toContain("|---");
  });
});

describe("a document can never run code on the page", () => {
  const hostile = [
    "# Title <script>alert(1)</script>",
    "<img src=x onerror=alert(2)>",
    "[click me](javascript:alert(3)) and [data](data:text/html,<b>x</b>) and [vb](VBScript:msgbox)",
    "<iframe src='https://evil.example'></iframe>",
    "| a | b |",
    "|---|---|",
    "| <script>x</script> | [ok](https://example.com) |",
  ].join("\n\n");
  const html = renderToStaticMarkup(createElement(MarkdownDocument, { source: hostile }));

  it("shows raw HTML as its characters, never as elements", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
  });

  it("drops the link, keeps the words, for any scheme but http(s), mailto and in-page", () => {
    expect(html).not.toMatch(/href="(javascript|data|vbscript):/i);
    expect(html).toContain("click me");
    expect(html).toContain('href="https://example.com"');
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref(" JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("//evil.example/x")).toBeNull();
    expect(safeHref("mailto:someone@example.com")).toBe("mailto:someone@example.com");
    expect(safeHref("#money")).toBe("#money");
    expect(parseInline("[x](javascript:alert(1))").some((i) => i.kind === "link")).toBe(false);
  });

  it("decides Markdown by type, or by name when the type is vague", () => {
    expect(isMarkdownType("text/markdown; charset=utf-8")).toBe(true);
    expect(isMarkdownType("text/plain", "notes.md")).toBe(true);
    expect(isMarkdownType("text/plain", "notes.txt")).toBe(false);
    expect(isMarkdownType("application/pdf", "deck.md")).toBe(false);
  });
});

// ── The shelf ─────────────────────────────────────────────────────────────────────────────────

let n = 0;
const doc = (title: string, doc_type: string, created_at: string, extra: Partial<ShelfDoc> = {}): ShelfDoc => ({
  id: `doc_${++n}`,
  title,
  doc_type,
  created_at,
  ...extra,
});
const REGISTER = "Example Fund I — where our records and the deck disagree";

const SHELF: ShelfDoc[] = [
  doc("The Learning Club Playbook (version 2, 23 Oct 2026)", "OTHER", "2026-10-22T20:48:21.322Z", { id: "doc_tlc_playbook" }),
  // The register: twice a week, identical, for six weeks.
  ...["2026-10-22", "2026-10-15", "2026-10-08", "2026-10-01", "2026-09-24", "2026-09-17"].flatMap((d) => [
    doc(REGISTER, "REVIEW", `${d}T11:00:00.000Z`),
    doc(REGISTER, "REVIEW", `${d}T11:00:01.000Z`),
  ]),
  doc("Sequoia — prep for the Wednesday sync, 2026-10-28", "REVIEW", "2026-10-22T11:00:00.000Z"),
  doc("Scooter — prep for the Wednesday sync, 2026-10-28", "REVIEW", "2026-10-22T11:00:00.000Z"),
  doc("Sequoia — prep for the Wednesday sync, 2026-10-21", "REVIEW", "2026-10-15T11:00:00.000Z"),
  doc("Scooter — prep for the Wednesday sync, 2026-10-21", "REVIEW", "2026-10-15T11:00:00.000Z"),
  doc("Hire search 2026-W43: 1 candidate(s) for senior producer, freelance", "BRIEF", "2026-10-19T09:00:00.000Z"),
  doc("Hire search 2026-W41: 3 candidate(s) for senior producer, freelance", "BRIEF", "2026-10-05T09:00:00.000Z"),
  doc('Change westpeek.ventures: "Hey! The agency took a look at the spam coming through the contact form and', "BRIEF", "2026-10-15T09:00:00.000Z"),
  doc('Plan: Change westpeek.ventures: "Hey Porter, Both forms on westpeek.ventures - the pitch/deck su', "BRIEF", "2026-09-22T09:00:00.000Z"),
  doc("Workshop packet — An Example Workshop (November 2026)", "ROOM_PACKET", "2026-10-01T09:00:00.000Z"),
  doc("Fund deck as it is", "DECK", "2026-09-15T09:00:00.000Z", { deck: { version_no: 1, state: "SUPERSEDED", title: "Fund deck as it is" } }),
  doc("Fund deck rebuilt", "DECK", "2026-09-15T10:00:00.000Z", { deck: { version_no: 2, state: "CURRENT", title: "Fund deck rebuilt" } }),
  doc("Porter → Scooter: Tell Scooter: Sequoia asked me to pass along a note — nothing", "BRIEF", "2026-10-10T09:00:00.000Z"),
];

describe("the shelf, sorted for a reader", () => {
  const now = new Date("2026-10-23T12:00:00.000Z");
  const shelf = buildShelf(SHELF, { now });
  const group = (k: string) => shelf.groups.find((g) => g.key === k)!;

  it("accounts for every document: nothing hidden, nothing dropped", () => {
    expect(shelfCount(shelf)).toBe(SHELF.length);
  });

  it("groups in plain words, never type codes, playbooks first", () => {
    expect(shelf.groups.map((g) => g.label)).toEqual([
      "Playbooks & plans",
      "Weekly reviews & sync prep",
      "Room & workshop packets",
      "The LP deck",
      "Website changes",
      "Hiring searches",
      "Notes & requests",
    ]);
    expect(groupOf(SHELF[0]!)).toBe("playbooks");
    expect(group("playbooks").lines[0]!.latest.doc.id).toBe("doc_tlc_playbook");
  });

  it("shows the twice-filed weekly register once per week, keeping the copy on the entry", () => {
    const reviews = group("reviews");
    const register = reviews.lines.find((l) => l.series?.startsWith("discrepancy:"))!;
    expect(register.latest.doc.created_at.slice(0, 10)).toBe("2026-10-22");
    expect(register.latest.copies).toHaveLength(1);
    expect(register.earlier.map((e) => e.doc.created_at.slice(0, 10))).toEqual(["2026-10-15", "2026-10-08", "2026-10-01", "2026-09-24", "2026-09-17"]);
    expect(register.earlier.every((e) => e.copies.length === 1)).toBe(true);
  });

  it("collapses each recurring series to its latest: per-partner prep, hire searches", () => {
    const reviews = group("reviews");
    const preps = reviews.lines.filter((l) => l.series?.startsWith("prep:"));
    expect(preps.map((l) => l.latest.plain).sort()).toEqual([
      "Scooter's prep for the Wednesday sync, 28 Oct",
      "Sequoia's prep for the Wednesday sync, 28 Oct",
    ]);
    expect(preps.every((l) => l.earlier.length === 1)).toBe(true);
    const hires = group("hiring");
    expect(hires.lines).toHaveLength(1);
    expect(hires.lines[0]!.latest.plain).toBe("Hire search for senior producer, freelance, week 43: 1 candidate");
    expect(hires.lines[0]!.earlier[0]!.plain).toBe("Hire search for senior producer, freelance, week 41: 3 candidates");
    expect(seriesKey(SHELF[0]!)).toBeNull();
  });

  it("gives an email-snippet title a short plain one, and keeps the stored one to show on open", () => {
    const web = group("website").lines.map((l) => l.latest);
    expect(web[0]!.plain).toBe("Website change on westpeek.ventures: “The agency took a look at the spam coming…”");
    expect(web[0]!.original).toMatch(/^Change westpeek\.ventures: "Hey!/);
    expect(web[1]!.plain).toMatch(/^Plan for a website change on westpeek\.ventures: “Both forms on/);
    expect(plainTitle({ title: "Porter → Scooter: Tell Scooter: Sequoia asked me to pass along a note — nothing" }).title).toBe(
      "Note passed to Scooter: “Sequoia asked me to pass along a note — nothing”",
    );
    // A title that is already plain is left alone and marked unchanged.
    const playbook = plainTitle(SHELF[0]!);
    expect(playbook).toEqual({ title: "The Learning Club Playbook (version 2, 23 Oct 2026)", changed: false });
    for (const g of shelf.groups) for (const l of g.lines) expect(l.latest.plain.length, l.latest.plain).toBeLessThanOrEqual(100);
  });

  it("leads the deck group with the current version", () => {
    expect(group("deck").lines.map((l) => l.latest.doc.deck!.version_no)).toEqual([2, 1]);
  });

  it("summarises the week and names the newest", () => {
    // In the last 7 days: playbook, register (once), two preps, a hire search.
    expect(shelf.thisWeek).toBe(5);
    expect(shelf.newest).toHaveLength(3);
    // One per series: never two weeks of the same register or search side by side.
    const keys = shelf.newest.map((e) => seriesKey(e.doc)).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("narrows by search and by group without changing the counts", () => {
    const searched = buildShelf(SHELF, { now, query: "spam" });
    expect(searched.groups.map((g) => g.key)).toEqual(["website"]);
    expect(searched.thisWeek).toBe(shelf.thisWeek);
    const filtered = buildShelf(SHELF, { now, group: "hiring" });
    expect(filtered.groups.map((g) => g.key)).toEqual(["hiring"]);
    expect(filtered.available).toEqual(shelf.available);
    expect(buildShelf(SHELF, { now, query: "nothing like this anywhere" }).groups).toEqual([]);
  });

  it("names a download for what it is, with the right extension", () => {
    expect(downloadName("Sequoia's prep for the Wednesday sync, 28 Oct", "text/markdown; charset=utf-8")).toBe("Sequoia's prep for the Wednesday sync, 28 Oct.md");
    expect(downloadName("Room packet: An “Example”", "application/pdf")).toBe("Room packet An Example.pdf");
  });
});
