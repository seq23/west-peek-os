/**
 * MARKDOWN, READ AS A DOCUMENT — the parser behind "View here" on Documents.
 *
 * Owner, 23 Oct 2026: "how does the documents section inside west peek os look? make sure it is
 * formatted properly for my consumption". Every filed brief, review and playbook is Markdown, and
 * the viewer showed it as raw monospace — `# headings`, `**bold**`, `[text](url)`, pipe tables —
 * which is a file, not something a partner reads on a phone.
 *
 * PURE AND SHARED, so the tests read the same tree the page paints. It produces a TREE, never HTML:
 * the client renders text nodes through React, which escapes them, so a `<script>` in a document is
 * shown as the characters it is and never runs. Links are the one place a document could reach
 * out, so only http(s), mailto and in-page anchors survive as links; anything else (javascript:,
 * data:, vbscript:) is kept as its words and loses the link.
 *
 * TOTAL: every non-blank input line lands in some block. Nothing a document says is dropped.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: Inline[] };

export interface ListItem {
  depth: number;
  inlines: Inline[];
}

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "code"; text: string }
  | { kind: "quote"; inlines: Inline[] }
  | { kind: "rule" };

/** The schemes a document link may use. Everything else keeps its words and loses the link. */
export function safeHref(raw: string): string | null {
  const href = raw.trim().replace(/^<|>$/g, "");
  if (/^(https?:\/\/|mailto:)/i.test(href)) return href;
  if (/^#[\w-]*$/.test(href)) return href;
  if (/^\/(?!\/)/.test(href)) return href;
  return null;
}

const INLINE = new RegExp(
  [
    "(`+)([\\s\\S]*?)\\1", // 1,2 code
    "\\*\\*([\\s\\S]+?)\\*\\*", // 3 strong
    "__([\\s\\S]+?)__", // 4 strong
    "\\[([^\\]]+)\\]\\(([^)\\s]+)(?:\\s+\"[^\"]*\")?\\)", // 5,6 link
    "<(https?:\\/\\/[^>\\s]+)>", // 7 autolink
    "(https?:\\/\\/[^\\s<>()\\[\\]]+[^\\s<>()\\[\\].,;:!?'\"])", // 8 bare url
    "(?<![\\w*])\\*(?!\\s)([^*\\n]+?)(?<!\\s)\\*(?![\\w*])", // 9 em
    "(?<![\\w_])_(?!\\s)([^_\\n]+?)(?<!\\s)_(?![\\w_])", // 10 em
  ].join("|"),
  "g",
);

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.kind === "text") last.text += t;
    else out.push({ kind: "text", text: t });
  };
  let at = 0;
  INLINE.lastIndex = 0;
  const re = new RegExp(INLINE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    push(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] !== undefined) out.push({ kind: "code", text: m[2]!.trim() });
    else if (m[3] !== undefined || m[4] !== undefined) out.push({ kind: "strong", children: parseInline((m[3] ?? m[4])!) });
    else if (m[5] !== undefined) {
      const href = safeHref(m[6]!);
      const children = parseInline(m[5]);
      if (href) out.push({ kind: "link", href, children });
      else for (const c of children) c.kind === "text" ? push(c.text) : out.push(c);
    } else if (m[7] !== undefined) out.push({ kind: "link", href: m[7], children: [{ kind: "text", text: m[7] }] });
    else if (m[8] !== undefined) out.push({ kind: "link", href: m[8], children: [{ kind: "text", text: m[8] }] });
    else if (m[9] !== undefined || m[10] !== undefined) out.push({ kind: "em", children: parseInline((m[9] ?? m[10])!) });
  }
  push(text.slice(at));
  return out;
}

/** The words of an inline run, without any markup — for titles, search and tests. */
export function inlineText(inlines: Inline[]): string {
  return inlines.map((i) => (i.kind === "text" || i.kind === "code" ? i.text : inlineText(i.children))).join("");
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

export function parseMarkdownDocument(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").replace(/^﻿/, "").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const isBlockStart = (l: string, next: string | undefined) =>
    HEADING.test(l) || LIST.test(l) || RULE.test(l) || FENCE.test(l) || /^\s*>/.test(l) || (l.includes("|") && next !== undefined && TABLE_SEP.test(next));

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      const fence = line.trim().slice(0, 3);
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence)) body.push(lines[i++]!);
      i++; // the closing fence (or the end)
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ kind: "heading", level: h[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, inlines: parseInline(h[2]!) });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const header = splitRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) {
        const cells = splitRow(lines[i]!).map(parseInline);
        while (cells.length < header.length) cells.push([]);
        rows.push(cells);
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", inlines: parseInline(body.join(" ").trim()) });
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]!);
      const start = ordered ? Number.parseInt(li[2]!, 10) : 1;
      const items: { depth: number; text: string }[] = [];
      const base = li[1]!.length;
      while (i < lines.length) {
        const l = lines[i]!;
        const m = LIST.exec(l);
        if (m && (/\d/.test(m[2]!) === ordered || m[1]!.length > base)) {
          items.push({ depth: Math.min(3, Math.floor(Math.max(0, m[1]!.length - base) / 2)), text: m[3]! });
          i++;
        } else if (l.trim() && /^\s+/.test(l) && !m && items.length > 0) {
          items[items.length - 1]!.text += ` ${l.trim()}`;
          i++;
        } else break;
      }
      blocks.push({ kind: "list", ordered, start, items: items.map((it) => ({ depth: it.depth, inlines: parseInline(it.text) })) });
      continue;
    }
    // A paragraph: consecutive lines until a blank line or another block begins.
    const body: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!, lines[i + 1])) body.push(lines[i++]!.trim());
    blocks.push({ kind: "paragraph", inlines: parseInline(body.join(" ")) });
  }
  return blocks;
}

/** Whether a stored file should be read as Markdown: by its type, or by its name when the type is vague. */
export function isMarkdownType(contentType: string | null | undefined, title = ""): boolean {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("text/markdown") || ct.startsWith("text/x-markdown")) return true;
  return (ct === "" || ct.startsWith("text/plain") || ct === "application/octet-stream") && /\.(md|markdown)$/i.test(title);
}
