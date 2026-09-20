import type { ArtifactPanel, ArtifactSpec } from "./artifact";

/**
 * ONE DERIVATION, THREE SURFACES. This file turns an `ArtifactSpec` into the slides a deck is made
 * of and the blocks a document is made of, and writes those SAME derivations as .pptx and .docx.
 * The in-app page (`ArtifactPage.tsx`) renders `slidesFor` / `documentFor`; the export routes call
 * `pptxBytes` / `docxBytes` on the same spec; `textOfPptx` / `textOfDocx` read an export back. So
 * "the export contains exactly what the page shows" is a test that runs (render → export → parse →
 * same figures), not a promise.
 *
 * NO DEPENDENCY, ON PURPOSE. `package.json` carries no .pptx or .docx library, and AGENTS.md says
 * to prefer built-ins over a new one. Both formats are a ZIP of XML parts, and the parts these
 * artifacts need — a title, text, a table, rectangles for bars — are a few hundred lines of
 * Office Open XML. A stored (uncompressed) ZIP needs a CRC-32 and three record shapes, written
 * below in ~60 lines; PowerPoint and Word open stored entries without complaint. The alternative,
 * `pptxgenjs` + `docx` (each pulling `jszip`, ~1 MB minified, written for Node's `fs`/`https`),
 * would have been a dependency for a Worker to carry for two file formats it can write itself.
 * `validate:artifacts` runs the round trip on fixtures on every build, so the writer cannot drift
 * quietly.
 *
 * EVERY NUMBER CITES ITS ROWS. `checkCitations` is the refusal: a panel with rows and no cites, or
 * a sentence carrying a number its panel's rows do not hold, fails the spec by name. The producer
 * never saves a version that fails it, and the validator proves the refusal on fixtures.
 *
 * NO RELATIVE IMPORTS except the type. `validate:artifacts` loads this file under esbuild and runs
 * the fixtures through the real functions.
 */

// ── Formatting, shared by the page and the exports ─────────────────────────────────────────────

/** A cell, as every surface prints it. One function, so the page and the file cannot differ. */
export function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

/** Every number in a piece of text, normalised (commas dropped) so "1,200" and "1200" agree. */
export function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    const raw = m[0].replace(/,/g, "");
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(Number.isInteger(n) ? String(n) : String(n));
  }
  return out;
}

/** The numbers a panel can vouch for: every numeric-looking cell, plus its own row count. */
export function panelNumbers(panel: ArtifactPanel): Set<string> {
  const set = new Set<string>();
  for (const row of panel.rows) {
    for (const col of panel.columns) {
      for (const n of numbersIn(fmtCell(row[col]))) set.add(n);
      const v = row[col];
      if (typeof v === "number") set.add(Number.isInteger(v) ? String(v) : v.toFixed(2)).add(String(v));
    }
  }
  set.add(String(panel.rows.length));
  return set;
}

// ── Citations ──────────────────────────────────────────────────────────────────────────────────

export class UncitedFigure extends Error {
  constructor(public where: string, detail: string) {
    super(detail);
  }
}

/**
 * Refuse a spec that shows a number it cannot cite.
 *
 *   · a panel with rows must cite as many rows as it shows (the compiler returns one cite per row);
 *   · a section's prose may carry only numbers its panel's rows hold (or the row count);
 *   · a section with no panel may carry no numbers at all — there is nothing to cite them to;
 *   · the summary is held to the union of every panel.
 *
 * Returns the count of figures checked, so a caller can refuse a spec that had nothing to check.
 */
export function checkCitations(spec: ArtifactSpec): { figures: number } {
  let figures = 0;
  const all = new Set<string>();
  const byId = new Map<string, ArtifactPanel>();
  for (const p of spec.panels) {
    byId.set(p.id, p);
    if (p.rows.length > 0 && p.cites.length !== p.rows.length) {
      throw new UncitedFigure(p.id, `panel "${p.title}" shows ${p.rows.length} rows and cites ${p.cites.length} — every row must be cited`);
    }
    const nums = panelNumbers(p);
    figures += nums.size;
    for (const n of nums) all.add(n);
  }
  for (const s of spec.sections) {
    const nums = numbersIn(s.prose).concat(numbersIn(s.heading));
    figures += nums.length;
    const panel = s.panel_id ? byId.get(s.panel_id) : undefined;
    if (s.panel_id && !panel) throw new UncitedFigure(s.heading, `section "${s.heading}" names panel ${s.panel_id}, which the artifact does not have`);
    const allowed = panel ? panelNumbers(panel) : new Set<string>();
    for (const n of nums) {
      if (!allowed.has(n)) {
        throw new UncitedFigure(s.heading, panel ? `"${n}" in "${s.heading}" is not in the rows of panel "${panel.title}", so it cannot be cited` : `"${n}" in "${s.heading}" has no panel to cite`);
      }
    }
  }
  if (spec.summary) {
    for (const n of numbersIn(spec.summary)) {
      figures += 1;
      if (!all.has(n)) throw new UncitedFigure("summary", `"${n}" in the summary is not in any panel's rows, so it cannot be cited`);
    }
  }
  return { figures };
}

/**
 * Take the uncitable numbers OUT of a sentence rather than refuse the whole build: the producer
 * runs this on what a model wrote, then `checkCitations` on the result. A number becomes "[figure
 * not in the record]" so the reader sees a gap where the model guessed, never a guess.
 */
export function stripUncited(prose: string, allowed: Set<string>): { prose: string; stripped: number } {
  let stripped = 0;
  const out = prose.replace(/-?\d[\d,]*(?:\.\d+)?/g, (raw) => {
    const n = Number(raw.replace(/,/g, ""));
    const key = Number.isFinite(n) ? String(n) : raw;
    if (allowed.has(key) || allowed.has(raw)) return raw;
    stripped += 1;
    return "[figure not in the record]";
  });
  return { prose: out, stripped };
}

// ── The derivations ────────────────────────────────────────────────────────────────────────────

export interface Slide {
  kind: "title" | "summary" | "finding" | "chart" | "sources";
  title: string;
  lines: string[];
  panel_id: string | null;
}

export type DocBlock =
  | { type: "heading"; level: 1 | 2; text: string }
  | { type: "paragraph"; text: string }
  | { type: "table"; columns: string[]; rows: string[][]; panel_id: string }
  | { type: "sources"; lines: string[] };

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/** The line under the title on every surface. */
export function bylineOf(spec: ArtifactSpec): string {
  return `${spec.about.label} · built by ${spec.built_by} · v${spec.version_no} · ${when(spec.built_at)}`;
}

/** The sources lines, one per panel: what was read, how many rows, which ones. */
export function sourceLines(spec: ArtifactSpec): string[] {
  return spec.panels.map((p) => {
    const ids = p.cites.slice(0, 6).join(", ");
    const more = p.cites.length > 6 ? ` and ${p.cites.length - 6} more` : "";
    return `${p.id} · ${p.table} · ${p.rows.length} row${p.rows.length === 1 ? "" : "s"} cited${p.cites.length ? `: ${ids}${more}` : ""}`;
  });
}

/**
 * A panel's rows as printed cells — the table every surface shows. The `id` column rides on every
 * row for the CITES (`citationsFor`) and is not printed when the panel has anything else to show:
 * a partner reads names and figures, and the ids are on the sources line.
 */
export function panelTable(panel: ArtifactPanel): { columns: string[]; rows: string[][] } {
  const columns = panel.columns.length > 1 ? panel.columns.filter((c) => c !== "id") : panel.columns;
  return { columns, rows: panel.rows.map((r) => columns.map((c) => fmtCell(r[c]))) };
}

/** The deck: title, the summary, a slide per finding, a chart slide per panel, the sources. */
export function slidesFor(spec: ArtifactSpec): Slide[] {
  const slides: Slide[] = [{ kind: "title", title: spec.title, lines: [bylineOf(spec)], panel_id: null }];
  if (spec.summary) slides.push({ kind: "summary", title: "In one line", lines: [spec.summary], panel_id: null });
  for (const s of spec.sections) slides.push({ kind: "finding", title: s.heading, lines: [s.prose], panel_id: s.panel_id });
  for (const p of spec.panels) {
    const t = panelTable(p);
    const lines = p.rows.length === 0 ? [p.note ?? "The record holds nothing matching that."] : t.rows.map((r) => r.join(" · "));
    slides.push({ kind: "chart", title: p.title, lines: [t.columns.join(" · "), ...lines], panel_id: p.id });
  }
  slides.push({ kind: "sources", title: "Sources", lines: sourceLines(spec), panel_id: null });
  return slides;
}

/** The document: title, byline, summary, a heading and prose per section with its panel's table, sources. */
export function documentFor(spec: ArtifactSpec): DocBlock[] {
  const blocks: DocBlock[] = [{ type: "heading", level: 1, text: spec.title }, { type: "paragraph", text: bylineOf(spec) }];
  if (spec.summary) blocks.push({ type: "paragraph", text: spec.summary });
  const shown = new Set<string>();
  for (const s of spec.sections) {
    blocks.push({ type: "heading", level: 2, text: s.heading }, { type: "paragraph", text: s.prose });
    const p = s.panel_id ? spec.panels.find((x) => x.id === s.panel_id) : undefined;
    if (p && !shown.has(p.id)) {
      shown.add(p.id);
      blocks.push(tableBlock(p));
    }
  }
  for (const p of spec.panels) {
    if (shown.has(p.id)) continue;
    shown.add(p.id);
    blocks.push({ type: "heading", level: 2, text: p.title }, tableBlock(p));
  }
  blocks.push({ type: "heading", level: 2, text: "Sources" }, { type: "sources", lines: sourceLines(spec) });
  return blocks;
}

function tableBlock(p: ArtifactPanel): DocBlock {
  const t = panelTable(p);
  if (p.rows.length === 0) return { type: "table", columns: t.columns, rows: [[p.note ?? "The record holds nothing matching that.", ...t.columns.slice(1).map(() => "")]], panel_id: p.id };
  return { type: "table", columns: t.columns, rows: t.rows, panel_id: p.id };
}

/** Every line of text the deck shows, in order — what a parsed .pptx must contain. */
export function textOfSlides(slides: Slide[]): string[] {
  return slides.flatMap((s) => [s.title, ...s.lines]);
}

/** Every line of text the document shows, in order — what a parsed .docx must contain. */
export function textOfDocument(blocks: DocBlock[]): string[] {
  return blocks.flatMap((b) => {
    if (b.type === "heading" || b.type === "paragraph") return [b.text];
    if (b.type === "sources") return b.lines;
    return [...b.columns, ...b.rows.flat()];
  });
}

/** The multiset of numbers a list of lines carries, sorted — the figures a surface shows. */
export function figuresOf(lines: string[]): string[] {
  return lines.flatMap(numbersIn).sort();
}

// ── ZIP, stored ────────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function u16(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff];
}
function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/** A ZIP with every entry stored (method 0). Office opens it; nothing needs compressing at this size. */
export function zipStored(entries: Array<{ name: string; data: Uint8Array | string }>): Uint8Array {
  const parts: number[] = [];
  const central: number[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = typeof e.data === "string" ? enc.encode(e.data) : e.data;
    const crc = crc32(data);
    const local = [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...name];
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name);
    parts.push(...local, ...data);
    offset += local.length + data.length;
  }
  const cdOffset = offset;
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(central.length), ...u32(cdOffset), ...u16(0)];
  return Uint8Array.from([...parts, ...central, ...end]);
}

/** Read a stored ZIP back: name → bytes. Refuses a compressed entry by name (this writer never makes one). */
export function unzipStored(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip: no end-of-central-directory record");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("not a zip: bad central directory entry");
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (method !== 0) throw new Error(`zip entry ${name} is compressed (method ${method}); this reader takes stored entries only`);
    const lNameLen = view.getUint16(local + 26, true);
    const lExtraLen = view.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(start, start + size);
    if (crc32(data) !== crc) throw new Error(`zip entry ${name} fails its CRC`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ── Office Open XML ────────────────────────────────────────────────────────────────────────────

export function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// 16:9 in EMU. 12192000 × 6858000.
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
const MARGIN = 457200; // half an inch

const THEME = `${XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="West Peek"><a:themeElements><a:clrScheme name="West Peek"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="333333"/></a:dk2><a:lt2><a:srgbClr val="F2F2F2"/></a:lt2><a:accent1><a:srgbClr val="111111"/></a:accent1><a:accent2><a:srgbClr val="555555"/></a:accent2><a:accent3><a:srgbClr val="888888"/></a:accent3><a:accent4><a:srgbClr val="AAAAAA"/></a:accent4><a:accent5><a:srgbClr val="CCCCCC"/></a:accent5><a:accent6><a:srgbClr val="E5E5E5"/></a:accent6><a:hlink><a:srgbClr val="111111"/></a:hlink><a:folHlink><a:srgbClr val="555555"/></a:folHlink></a:clrScheme><a:fontScheme name="West Peek"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const SLIDE_MASTER = `${XML_HEAD}<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="lt1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

const SLIDE_LAYOUT = `${XML_HEAD}<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

function rels(items: Array<{ id: string; type: string; target: string }>): string {
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map((i) => `<Relationship Id="${i.id}" Type="${i.type}" Target="${i.target}"/>`).join("")}</Relationships>`;
}

const REL = {
  officeDocument: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  slideMaster: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster",
  slideLayout: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout",
  slide: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
  theme: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme",
  styles: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
};

let shapeSeq = 0;

function textBox(x: number, y: number, w: number, h: number, paras: Array<{ text: string; size: number; bold?: boolean; grey?: boolean }>): string {
  shapeSeq += 1;
  const body = paras
    .map((p) => `<a:p><a:r><a:rPr lang="en-GB" sz="${p.size}"${p.bold ? ' b="1"' : ""} dirty="0"><a:solidFill><a:srgbClr val="${p.grey ? "666666" : "111111"}"/></a:solidFill></a:rPr><a:t>${xml(p.text)}</a:t></a:r></a:p>`)
    .join("");
  return `<p:sp><p:nvSpPr><p:cNvPr id="${shapeSeq + 1}" name="Text ${shapeSeq}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`;
}

function rect(x: number, y: number, w: number, h: number, fill: string): string {
  shapeSeq += 1;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${shapeSeq + 1}" name="Bar ${shapeSeq}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-GB"/></a:p></p:txBody></p:sp>`;
}

/** The values a chart draws: the `metric` column, else the first numeric column; labels from the first column. */
export function chartSeries(panel: ArtifactPanel): Array<{ label: string; value: number }> {
  const numeric = panel.columns.includes("metric") ? "metric" : panel.columns.find((c) => panel.rows.some((r) => typeof r[c] === "number"));
  if (!numeric) return [];
  const labelCol = panel.columns.find((c) => c !== numeric) ?? numeric;
  return panel.rows
    .filter((r) => typeof r[numeric] === "number")
    .slice(0, 12)
    .map((r) => ({ label: fmtCell(r[labelCol]), value: r[numeric] as number }));
}

function slideXml(slide: Slide, spec: ArtifactSpec): string {
  shapeSeq = 0;
  const shapes: string[] = [];
  const innerW = SLIDE_W - MARGIN * 2;
  if (slide.kind === "title") {
    shapes.push(textBox(MARGIN, SLIDE_H / 3, innerW, 1200000, [{ text: slide.title, size: 4000, bold: true }]));
    shapes.push(textBox(MARGIN, SLIDE_H / 3 + 1300000, innerW, 600000, slide.lines.map((t) => ({ text: t, size: 1600, grey: true }))));
  } else if (slide.kind === "chart") {
    const panel = spec.panels.find((p) => p.id === slide.panel_id);
    shapes.push(textBox(MARGIN, MARGIN, innerW, 700000, [{ text: slide.title, size: 2800, bold: true }]));
    const series = panel && panel.chart !== "table" ? chartSeries(panel) : [];
    let y = MARGIN + 800000;
    if (series.length > 0) {
      // Bars, drawn as rectangles: the honest shape for every chart kind in a file with no chart
      // part. Each bar is labelled with its value, which is the number the panel cites.
      const max = Math.max(...series.map((s) => Math.abs(s.value)), 1);
      const areaH = 2600000;
      const gap = 120000;
      const barW = Math.max(120000, Math.floor((innerW - gap * (series.length - 1)) / series.length));
      series.forEach((s, i) => {
        const h = Math.max(20000, Math.round((Math.abs(s.value) / max) * areaH));
        const x = MARGIN + i * (barW + gap);
        shapes.push(rect(x, y + areaH - h, barW, h, "111111"));
        shapes.push(textBox(x, y + areaH + 40000, barW, 500000, [{ text: `${s.label} · ${fmtCell(s.value)}`, size: 1000, grey: true }]));
      });
      y += areaH + 600000;
    }
    shapes.push(textBox(MARGIN, y, innerW, SLIDE_H - y - MARGIN, slide.lines.map((t, i) => ({ text: t, size: series.length > 0 ? 1000 : 1400, bold: i === 0 }))));
  } else {
    shapes.push(textBox(MARGIN, MARGIN, innerW, 900000, [{ text: slide.title, size: 2800, bold: true }]));
    shapes.push(textBox(MARGIN, MARGIN + 1000000, innerW, SLIDE_H - MARGIN * 2 - 1000000, slide.lines.map((t) => ({ text: t, size: slide.kind === "sources" ? 1100 : 1800, grey: slide.kind === "sources" }))));
  }
  return `${XML_HEAD}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

/** The deck as a .pptx: one part per slide of `slidesFor`, a blank layout, a black-on-white theme. */
export function pptxBytes(spec: ArtifactSpec): Uint8Array {
  const slides = slidesFor(spec);
  const entries: Array<{ name: string; data: string }> = [];
  const overrides = slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  entries.push({
    name: "[Content_Types].xml",
    data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${overrides}</Types>`,
  });
  entries.push({ name: "_rels/.rels", data: rels([{ id: "rId1", type: REL.officeDocument, target: "ppt/presentation.xml" }]) });
  entries.push({
    name: "ppt/presentation.xml",
    data: `${XML_HEAD}<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  });
  entries.push({
    name: "ppt/_rels/presentation.xml.rels",
    data: rels([
      { id: "rId1", type: REL.slideMaster, target: "slideMasters/slideMaster1.xml" },
      { id: "rId2", type: REL.theme, target: "theme/theme1.xml" },
      ...slides.map((_, i) => ({ id: `rId${i + 3}`, type: REL.slide, target: `slides/slide${i + 1}.xml` })),
    ]),
  });
  entries.push({ name: "ppt/slideMasters/slideMaster1.xml", data: SLIDE_MASTER });
  entries.push({ name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: rels([{ id: "rId1", type: REL.slideLayout, target: "../slideLayouts/slideLayout1.xml" }, { id: "rId2", type: REL.theme, target: "../theme/theme1.xml" }]) });
  entries.push({ name: "ppt/slideLayouts/slideLayout1.xml", data: SLIDE_LAYOUT });
  entries.push({ name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: rels([{ id: "rId1", type: REL.slideMaster, target: "../slideMasters/slideMaster1.xml" }]) });
  entries.push({ name: "ppt/theme/theme1.xml", data: THEME });
  slides.forEach((s, i) => {
    entries.push({ name: `ppt/slides/slide${i + 1}.xml`, data: slideXml(s, spec) });
    entries.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: rels([{ id: "rId1", type: REL.slideLayout, target: "../slideLayouts/slideLayout1.xml" }]) });
  });
  return zipStored(entries);
}

function wPara(text: string, style?: string): string {
  return `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
}

function wTable(columns: string[], rows: string[][]): string {
  const cell = (t: string, head: boolean) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:r>${head ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${xml(t)}</w:t></w:r></w:p></w:tc>`;
  const tr = (cells: string[], head: boolean) => `<w:tr>${cells.map((c) => cell(c, head)).join("")}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="AAAAAA"/><w:left w:val="single" w:sz="4" w:space="0" w:color="AAAAAA"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="AAAAAA"/><w:right w:val="single" w:sz="4" w:space="0" w:color="AAAAAA"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="AAAAAA"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="AAAAAA"/></w:tblBorders></w:tblPr><w:tblGrid>${columns.map(() => '<w:gridCol w:w="1800"/>').join("")}</w:tblGrid>${tr(columns, true)}${rows.map((r) => tr(r, false)).join("")}</w:tbl>`;
}

const STYLES = `${XML_HEAD}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Byline"><w:name w:val="Byline"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="666666"/><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;

/** The document as a .docx: the blocks of `documentFor`, headings styled, tables bordered. */
export function docxBytes(spec: ArtifactSpec): Uint8Array {
  const blocks = documentFor(spec);
  const body = blocks
    .map((b, i) => {
      if (b.type === "heading") return wPara(b.text, b.level === 1 ? "Title" : "Heading2");
      if (b.type === "paragraph") return wPara(b.text, i === 1 ? "Byline" : undefined);
      if (b.type === "sources") return b.lines.map((l) => wPara(l, "Byline")).join("");
      return `${wTable(b.columns, b.rows)}${wPara("")}`;
    })
    .join("");
  const document = `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return zipStored([
    {
      name: "[Content_Types].xml",
      data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    },
    { name: "_rels/.rels", data: rels([{ id: "rId1", type: REL.officeDocument, target: "word/document.xml" }]) },
    { name: "word/document.xml", data: document },
    { name: "word/_rels/document.xml.rels", data: rels([{ id: "rId1", type: REL.styles, target: "styles.xml" }]) },
    { name: "word/styles.xml", data: STYLES },
  ]);
}

// ── Reading an export back ─────────────────────────────────────────────────────────────────────

function unxml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** Every text run of every slide, slide by slide, in order. What PowerPoint would show. */
export function textOfPptx(bytes: Uint8Array): string[][] {
  const parts = unzipStored(bytes);
  const names = [...parts.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return names.map((n) => [...dec.decode(parts.get(n)!).matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => unxml(m[1]!)));
}

/** Every text run of the document body, in order. What Word would show. */
export function textOfDocx(bytes: Uint8Array): string[] {
  const parts = unzipStored(bytes);
  const doc = parts.get("word/document.xml");
  if (!doc) throw new Error("not a docx: no word/document.xml");
  return [...dec.decode(doc).matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => unxml(m[1]!)).filter((t) => t.length > 0);
}
