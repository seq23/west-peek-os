/**
 * A DELIVERABLE IS A DOCUMENT, NOT A TEXT DUMP.
 *
 * Until 18 Sep 2026 every deliverable on Home opened as `<pre className="deliverable-body">`: the
 * whole body, monospaced, unwrapped, whatever its length. Parker's October event kit is 5,621
 * characters — a recommendation, three angles, a run of show, five questions, two social drafts —
 * and it arrived as one grey block. The owner, on being shown it: "the kit should not arrive on the
 * fucking card that sounds like hell — maybe a link to an external page artifact with the kit".
 *
 * The reusable answer was already in the product. Home's deliverable list is where every brief,
 * packet and kit the firm produces already lands; a page per kit, or an artifact per kit, would be
 * a second home that has to be maintained and that nothing else benefits from. Her follow-up made
 * the requirement explicit: "make them reusable so that future kits are all there and you have one
 * page with all the kits". So the fix is to RENDER the one surface properly rather than build
 * another.
 *
 * WHAT THIS PARSES, and why it is deliberately small. Employees write plain text with two heading
 * conventions that already appear across the corpus — `=== TITLE ===` for the document and
 * `--- SECTION ---` for its parts — plus pipe tables and `1.`/`-`/`*` lists. Nothing here is a
 * markdown engine: an unrecognised body degrades to paragraphs, which is still better than `<pre>`,
 * and NOTHING is ever dropped. A renderer that silently discards a line it cannot classify would be
 * a worse bug than the one it replaces, so `toSections` is total — every input line lands in
 * exactly one block, and `validate:nothing-is-dropped` proves it over the real corpus.
 */

export type Block =
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; header: string[]; rows: string[][] };

export interface Section {
  /** Null for content that appears before any `--- heading ---`. */
  heading: string | null;
  blocks: Block[];
}

export interface ParsedDeliverable {
  /** From a leading `=== TITLE ===`, when the body carries one. */
  title: string | null;
  sections: Section[];
}

const DOC_TITLE = /^\s*={2,}\s*(.+?)\s*={2,}\s*$/;
const SECTION = /^\s*-{2,}\s*(.+?)\s*-{2,}\s*$/;
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)]|[A-Z][.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
/** A `|---|---|` separator carries no content and is the only line intentionally not rendered. */
const TABLE_RULE = /^\s*\|[\s|:-]+\|\s*$/;

function cells(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * Split a body into sections and blocks. Total by construction: every non-blank line that is not a
 * table rule ends up in exactly one block.
 */
export function toSections(body: string): ParsedDeliverable {
  const lines = (body ?? "").split("\n");
  let title: string | null = null;
  const sections: Section[] = [];
  let current: Section = { heading: null, blocks: [] };
  let para: string[] = [];
  let list: string[] = [];
  let table: { header: string[]; rows: string[][] } | null = null;

  const flushPara = (): void => {
    if (para.length > 0) {
      current.blocks.push({ type: "paragraph", text: para.join(" ").trim() });
      para = [];
    }
  };
  const flushList = (): void => {
    if (list.length > 0) {
      current.blocks.push({ type: "list", items: list });
      list = [];
    }
  };
  const flushTable = (): void => {
    if (table) {
      current.blocks.push({ type: "table", header: table.header, rows: table.rows });
      table = null;
    }
  };
  const flushAll = (): void => {
    flushPara();
    flushList();
    flushTable();
  };
  const closeSection = (): void => {
    flushAll();
    if (current.heading !== null || current.blocks.length > 0) sections.push(current);
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    if (line.trim() === "") {
      flushAll();
      continue;
    }

    const docTitle = DOC_TITLE.exec(line);
    if (docTitle && title === null && sections.length === 0 && current.blocks.length === 0) {
      title = docTitle[1]!;
      continue;
    }

    const section = SECTION.exec(line);
    if (section) {
      closeSection();
      current = { heading: section[1]!, blocks: [] };
      continue;
    }

    if (TABLE_RULE.test(line)) continue;

    const tableRow = TABLE_ROW.exec(line);
    if (tableRow) {
      flushPara();
      flushList();
      const row = cells(line);
      if (!table) table = { header: row, rows: [] };
      else table.rows.push(row);
      continue;
    }
    flushTable();

    const item = LIST_ITEM.exec(line);
    if (item) {
      flushPara();
      list.push(item[1]!);
      continue;
    }
    flushList();

    para.push(line.trim());
  }

  closeSection();
  return { title, sections };
}

/**
 * The first thing worth reading, for an email or a card line — never the whole body.
 *
 * An employee's recommendation is the decision the owner is being asked to make, so it wins over
 * position when the document states one. Otherwise the opening paragraph. Trimmed to `max` on a
 * word boundary, because a summary cut mid-word reads as broken rather than abbreviated.
 */
export function leadLine(body: string, max = 320): string {
  const { sections } = toSections(body);
  const paragraphs = sections.flatMap((s) => s.blocks.filter((b): b is Extract<Block, { type: "paragraph" }> => b.type === "paragraph"));
  const recommended = paragraphs.find((p) => /^\s*RECOMMEND(ED|ATION)\b/i.test(p.text));
  const text = (recommended ?? paragraphs[0])?.text ?? "";
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : max)}…`;
}
