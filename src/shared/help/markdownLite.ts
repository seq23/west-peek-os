/**
 * The little Markdown a host is allowed to speak.
 *
 * WHY THIS EXISTS. On 19 Sep 2026 the owner asked Walter on Meetings how the page works and got one
 * dense paragraph with three bolded phrases in it — the card rendered every turn as a single `<p>`
 * with the model's text dropped in verbatim, so a numbered list came out as a wall and a heading
 * came out as `##`. The guides in `pageGuide/` are written as structured Markdown on purpose:
 * a one-line purpose, then numbered bands, then bulleted acts with the control names in bold. That
 * shape has to survive to the screen or the structure was never there.
 *
 * WHY NOT A LIBRARY. Nothing here needs a Markdown library — the vocabulary is five things
 * (paragraph, heading, numbered list, bulleted list, bold) and a dependency for that is a supply
 * chain for a subset of what the guide renderer emits. This parser is a pure function shared by the
 * worker (which composes the answer) and the client (which paints it), and it is unit-tested on the
 * exact text the guide renderer produces, so the two cannot disagree about what a list is.
 *
 * WHAT IT DOES NOT DO. Links, images, code, tables, nesting. A guide that needs any of those is
 * written wrong — the reader is on a phone, and the answer is meant to be read in one breath.
 */

export type Inline = { kind: "text"; text: string } | { kind: "strong"; text: string };

export type Block =
  | { kind: "heading"; level: 2 | 3; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "ordered"; items: Inline[][] }
  | { kind: "bulleted"; items: Inline[][] };

/** `**bold**` runs, everything else as text. Unbalanced stars are left as text rather than eaten. */
export function parseInlines(line: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+?)\*\*/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: line.slice(last, at) });
    out.push({ kind: "strong", text: m[1]! });
    last = at + m[0].length;
  }
  if (last < line.length) out.push({ kind: "text", text: line.slice(last) });
  return out;
}

const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const HEADING = /^\s*(#{2,3})\s+(.*?)\s*#*\s*$/;

/**
 * Markdown text → blocks. Lines that are not a list item or a heading run together into one
 * paragraph until a blank line; a list continues while consecutive lines are items of its kind.
 */
export function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push({ kind: "paragraph", inlines: parseInlines(para.join(" ").trim()) });
    para = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flushPara();
      continue;
    }
    const h = line.match(HEADING);
    if (h) {
      flushPara();
      blocks.push({ kind: "heading", level: h[1]!.length === 2 ? 2 : 3, inlines: parseInlines(h[2]!) });
      continue;
    }
    const o = line.match(ORDERED);
    if (o) {
      flushPara();
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === "ordered") prev.items.push(parseInlines(o[1]!));
      else blocks.push({ kind: "ordered", items: [parseInlines(o[1]!)] });
      continue;
    }
    const b = line.match(BULLET);
    if (b) {
      flushPara();
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === "bulleted") prev.items.push(parseInlines(b[1]!));
      else blocks.push({ kind: "bulleted", items: [parseInlines(b[1]!)] });
      continue;
    }
    // A plain line directly under a list item is NOT a continuation of it — the guides never wrap
    // an item, and a model that does has started a new thought.
    para.push(line.trim());
  }
  flushPara();
  return blocks;
}

/** The text of the whole thing with the markup removed — for tests and for a plain-text fallback. */
export function plainText(blocks: Block[]): string {
  const inl = (xs: Inline[]) => xs.map((x) => x.text).join("");
  return blocks
    .map((b) => {
      if (b.kind === "heading" || b.kind === "paragraph") return inl(b.inlines);
      return b.items.map((it) => inl(it)).join("\n");
    })
    .join("\n");
}
