/**
 * A NEW VERSION OF THE DECK IS A COPY OF THE CURRENT ONE WITH ITS FIGURES CHANGED IN PLACE.
 *
 * Operator, 15 Sep 2026, on v12–v14: "every deck should copy the original deck and make tweaks."
 * Until now a rebuild transcribed the current PDF through a model and re-typeset the transcript —
 * the Canva design became bullet points ("Image: the 'W' logo mark beside the wordmark"). Three
 * versions in a row were sent back for it.
 *
 * This does the copy in the browser the firm already renders with (Browser Rendering): pdf.js finds
 * where each figure is printed, pdf-lib copies every page byte-for-byte and paints the new figure
 * over the old one in the page's own background colour, at the old figure's size and baseline.
 * Nothing else on any page is touched. A figure that cannot be found is left as printed and named
 * in the result — a page left alone beats a page redrawn.
 *
 * All of the work happens inside the headless browser, not the Worker: a 3 MB PDF parsed in a
 * Worker would exceed the invocation's CPU budget.
 */

export interface DeckTweak {
  page: number;
  /** The figure exactly as printed on the slide. */
  was: string;
  /** What the records say it should read. */
  now: string;
  field: string;
  /** The rest of the printed line the figure sits in, when known — "$3M (30% of the fund)". */
  context?: string;
}

export interface TweakResult {
  pdfBase64: string;
  pageCount: number;
  placed: DeckTweak[];
  missing: DeckTweak[];
  /** Each line repainted: what it said and what it says now. */
  repainted: Array<{ page: number; was: string; now: string }>;
}

const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";
const PDFLIB = "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js";

/** The page the browser runs; the script below is evaluated against it. */
export function tweakHostHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><script src="${PDFLIB}"></script>
<script type="module">import * as pdfjs from "${PDFJS}"; pdfjs.GlobalWorkerOptions.workerSrc = "${PDFJS_WORKER}"; window.pdfjsLib = pdfjs; window.__ready = true;</script>
</head><body></body></html>`;
}

/**
 * Runs in the browser. Kept as a string so the Worker bundle never has to parse or ship pdf.js.
 * Returns { pdfBase64, pageCount, placed, missing }.
 */
export const TWEAK_SCRIPT = `
async ({ pdfBase64, tweaks }) => {
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bytesToB64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const bytes = b64ToBytes(pdfBase64);
  const pdfjs = window.pdfjsLib;
  const src = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const out = await PDFDocument.load(bytes.slice());
  const font = await out.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await out.embedFont(StandardFonts.Helvetica);
  const placed = []; const missing = []; const repainted = [];

  // Text on a page as lines: items grouped by baseline, sorted by x, with a run of characters
  // whose positions are interpolated across each item's width.
  async function linesOf(pageNo) {
    const page = await src.getPage(pageNo);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    // Whitespace-only items are dropped: a bare " " item spanning the gap between two table cells
    // is what glued "Reserves" to "$3M (30% of the fund)" as one line. Gaps are read from geometry.
    const items = content.items.filter((it) => typeof it.str === "string" && it.str.trim().length > 0).map((it) => {
      const [a, b, c, d, e, f] = it.transform;
      const size = Math.hypot(b, d) || Math.abs(d) || 10;
      return { str: it.str, x: e, y: f, w: it.width || (it.str.length * size * 0.5), h: it.height || size, size, fontName: it.fontName };
    });
    const rows = [];
    for (const it of items.sort((p, q) => (q.y - p.y) || (p.x - q.x))) {
      const row = rows.find((l) => Math.abs(l.y - it.y) <= Math.max(2, it.size * 0.35));
      if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
    }
    // A row of the page is not a line of text: two table cells share a baseline. Split a row at
    // any gap wider than a character and a half, so "Reserves" and "$3M (30% of the fund)" are
    // two lines that happen to be level, not one line that gets repainted as a whole.
    const lines = [];
    for (const row of rows) {
      row.items.sort((p, q) => p.x - q.x);
      let cur = null; let prevEnd = null;
      for (const it of row.items) {
        const per = it.w / Math.max(1, it.str.length);
        if (!cur || (prevEnd !== null && it.x - prevEnd > Math.max(per, it.size * 0.5) * 1.5)) { cur = { y: row.y, items: [] }; lines.push(cur); }
        cur.items.push(it); prevEnd = it.x + it.w;
      }
    }
    // Whether a line is set in a bold face, from the embedded font's own name when it has one.
    for (const l of lines) {
      const fn = (l.items[0] || {}).fontName;
      let name = "";
      try { const fobj = page.commonObjs.has(fn) ? page.commonObjs.get(fn) : null; name = (fobj && (fobj.name || fobj.loadedName)) || (content.styles[fn] || {}).fontFamily || ""; } catch (e) { name = ""; }
      l.bold = /bold|black|heavy|semibold|extrabold/i.test(name) || !!(page.commonObjs.has(fn) && page.commonObjs.get(fn).bold);
    }
    return { lines, viewport, page };
  }

  function charsOf(line) {
    // Each character gets an x-span; a gap between items wider than a third of a character is a space.
    const chars = [];
    let prevEnd = null;
    for (const it of line.items) {
      const per = it.w / Math.max(1, it.str.length);
      if (prevEnd !== null && it.x - prevEnd > per * 0.34 && chars.length && chars[chars.length - 1].ch !== " ") {
        chars.push({ ch: " ", x0: prevEnd, x1: it.x, size: it.size, y: it.y, h: it.h });
      }
      for (let i = 0; i < it.str.length; i++) {
        chars.push({ ch: it.str[i], x0: it.x + per * i, x1: it.x + per * (i + 1), size: it.size, y: it.y, h: it.h });
      }
      prevEnd = it.x + it.w;
    }
    return chars;
  }

  const norm = (s) => s.replace(/\\s+/g, "").toLowerCase();

  // The page, painted once, so paper and ink can be read off it. Paper is the commonest colour on
  // a ring just outside the figure's box; ink is the pixel inside the box furthest from that paper.
  const painted = new Map();
  async function paint(pageNo, page) {
    if (painted.has(pageNo)) return painted.get(pageNo);
    const vp = page.getViewport({ scale: 1 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const entry = { ctx, w: canvas.width, h: canvas.height, vh: vp.height };
    painted.set(pageNo, entry);
    return entry;
  }
  function colours(entry, x0, x1, yBase, size) {
    const top = Math.round(entry.vh - (yBase + size * 0.95));
    const bottom = Math.round(entry.vh - (yBase - size * 0.3));
    const px = (x, y) => { const d = entry.ctx.getImageData(Math.max(0, Math.min(entry.w - 1, x)), Math.max(0, Math.min(entry.h - 1, y)), 1, 1).data; return [d[0], d[1], d[2]]; };
    const ring = [];
    for (let x = Math.round(x0) - 8; x <= Math.round(x1) + 8; x += 2) { ring.push(px(x, top - 3)); ring.push(px(x, bottom + 3)); }
    for (let y = top; y <= bottom; y += 2) { ring.push(px(Math.round(x0) - 6, y)); ring.push(px(Math.round(x1) + 6, y)); }
    const key = (c) => c.map((v) => v >> 3).join(",");
    const counts = new Map();
    for (const c of ring) counts.set(key(c), (counts.get(key(c)) || 0) + 1);
    const paperKey = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const paper = ring.find((c) => key(c) === paperKey);
    let ink = paper; let best = -1; let inked = 0; let total = 0;
    for (let x = Math.round(x0); x <= Math.round(x1); x += 1) for (let y = top; y <= bottom; y += 1) {
      const c = px(x, y); const d = Math.abs(c[0] - paper[0]) + Math.abs(c[1] - paper[1]) + Math.abs(c[2] - paper[2]);
      total += 1; if (d > 90) inked += 1;
      if (d > best) { best = d; ink = c; }
    }
    if (best < 60) ink = [30, 27, 24];
    // Weight, read off the page: a bold face covers noticeably more of its box with ink than a
    // regular one. Embedded fonts in a Canva export carry no usable name, so the pixels decide.
    const density = total ? inked / total : 0;
    return { paper: rgb(paper[0] / 255, paper[1] / 255, paper[2] / 255), ink: rgb(ink[0] / 255, ink[1] / 255, ink[2] / 255), density };
  }

  // 1 · Find, for every tweak, the line it lives on. Every line on every page that carries the
  //     figure is a candidate; the requested page first, then the line that also carries the
  //     context, then the shortest — "$3M (30% of the fund)" over a headline that says 30% too.
  const lineCache = new Map();
  async function pageLines(pageNo) { if (!lineCache.has(pageNo)) lineCache.set(pageNo, await linesOf(pageNo)); return lineCache.get(pageNo); }
  const hits = [];
  for (const t of tweaks) {
    const candidates = [];
    const order = [t.page, ...Array.from({ length: src.numPages }, (_, i) => i + 1).filter((n) => n !== t.page)];
    for (const pageNo of order) {
      if (pageNo < 1 || pageNo > src.numPages) continue;
      const { lines, page } = await pageLines(pageNo);
      lines.forEach((line, lineIndex) => {
        const chars = charsOf(line);
        const idx = []; let compact = "";
        for (let i = 0; i < chars.length; i++) { if (!/\\s/.test(chars[i].ch)) { idx.push(i); compact += chars[i].ch.toLowerCase(); } }
        const needle = norm(t.was);
        const at = compact.indexOf(needle);
        if (at === -1) return;
        const ctxHit = t.context ? compact.includes(norm(t.context)) || norm(t.context).includes(compact) : false;
        candidates.push({ score: (pageNo === t.page ? 0 : 100) + (ctxHit ? 0 : 50) + compact.length / 100, pageNo, page, lineIndex, line, chars, from: idx[at], to: idx[at + needle.length - 1] });
      });
      if (candidates.some((c) => c.pageNo === t.page && c.score < 50)) break;
    }
    if (candidates.length === 0) { missing.push(t); continue; }
    hits.push({ t, hit: candidates.sort((a, b) => a.score - b.score)[0] });
  }

  // 2 · Repaint each touched LINE once, whole: cover it in the page's own paper, and draw the line
  //     again with every figure on it replaced, at its original size, centred where it was. Redrawing
  //     the whole line is what keeps "$3M (30% of the fund)" one line after two of its figures change.
  const byLine = new Map();
  for (const h of hits) {
    const key = h.hit.pageNo + ":" + h.hit.lineIndex;
    if (!byLine.has(key)) byLine.set(key, { hit: h.hit, edits: [] });
    byLine.get(key).edits.push({ from: h.hit.from, to: h.hit.to, now: h.t.now, t: h.t });
  }
  for (const { hit, edits } of byLine.values()) {
    const chars = hit.chars;
    const x0 = chars[0].x0; const x1 = chars[chars.length - 1].x1; const y = chars[0].y; const size = chars[0].size;
    let text = ""; let i = 0;
    const sorted = edits.sort((a, b) => a.from - b.from);
    for (const e of sorted) { text += chars.slice(i, e.from).map((c) => c.ch).join(""); text += e.now; i = e.to + 1; }
    text += chars.slice(i).map((c) => c.ch).join("");
    const pg = out.getPage(hit.pageNo - 1);
    const entry = await paint(hit.pageNo, hit.page);
    const { paper, ink, density } = colours(entry, x0, x1, y, size);
    const f = hit.line.bold || density > 0.29 ? font : fontRegular;
    let drawSize = size;
    let width = f.widthOfTextAtSize(text, drawSize);
    const oldWidth = x1 - x0;
    // The redrawn line may grow a little; past a quarter more than the old width it is shrunk to fit.
    if (width > oldWidth * 1.25) { drawSize = size * (oldWidth * 1.25) / width; width = f.widthOfTextAtSize(text, drawSize); }
    const centre = (x0 + x1) / 2;
    const left = Math.max(2, centre - width / 2);
    pg.drawRectangle({ x: Math.min(x0, left) - 2, y: y - size * 0.3, width: Math.max(oldWidth, width) + 4, height: size * 1.25, color: paper });
    pg.drawText(text, { x: left, y, size: drawSize, font: f, color: ink });
    for (const e of sorted) placed.push({ ...e.t, page: hit.pageNo });
    repainted.push({ page: hit.pageNo, was: chars.map((c) => c.ch).join(""), now: text, density: Math.round(density * 100) / 100, bold: f === font, lineBold: !!hit.line.bold });
  }
  const saved = await out.save({ useObjectStreams: false });
  return { pdfBase64: bytesToB64(saved), pageCount: src.numPages, placed, missing, repainted };
}`;

/**
 * Copy the current deck and change the given figures in place, inside the browser `page`.
 * The caller owns the browser; this only drives one page of it.
 */
export async function tweakDeckInBrowser(
  page: { setContent(html: string, opts?: unknown): Promise<unknown>; evaluate(fn: unknown, ...args: unknown[]): Promise<unknown>; waitForFunction?(fn: unknown, opts?: unknown): Promise<unknown> },
  pdfBase64: string,
  tweaks: DeckTweak[],
): Promise<TweakResult> {
  await page.setContent(tweakHostHtml(), { waitUntil: "networkidle0" });
  if (page.waitForFunction) await page.waitForFunction("window.__ready === true && window.PDFLib", { timeout: 20_000 });
  // A string expression, not a function: the Worker may not build functions from strings
  // (`new Function` is refused on the platform), and puppeteer awaits the promise a string
  // expression returns. The bytes ride inside the expression.
  const result = (await page.evaluate(`(${TWEAK_SCRIPT})(${JSON.stringify({ pdfBase64, tweaks })})`)) as TweakResult;
  if (!result || typeof result.pdfBase64 !== "string") throw new Error("the browser returned no PDF from the copy");
  return result;
}
