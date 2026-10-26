import { DECK_SLIDES, MONEY_BINDINGS, PERCENT_BINDINGS, type Binding, type Slide, type Slot, type TableCell } from "./definition";
import { usd } from "../fund/sleeveMath";

/**
 * The deck definition plus a snapshot, rendered to HTML a browser can print — and the same pages,
 * framed, as the partners' DECK PREVIEW (shared/deck/preview.ts).
 *
 * ONE FORMATTER FOR EACH KIND OF FIGURE. `usd` is the same function the fund page, the discrepancy
 * register and the construction editor use, so $16.8M is spelled identically wherever it appears.
 *
 * A MISSING BINDING RENDERS AS A VISIBLE GAP, never as a blank or a zero. "—— not recorded ——" is
 * ugly on purpose and impossible to miss in review.
 *
 * ── NOTHING RUNS OFF THE PAGE (26 Oct 2026) ─────────────────────────────────────────────────────
 *
 * v18 printed rows under the footer on pages 5, 7 and 10, where the page's `overflow:hidden` cut
 * them: ten figure rows do not fit a 720px page, and nothing counted them. Every slide is now
 * PAGINATED before it is drawn: each block has a height, the blocks are laid down until the page is
 * full, and the rest flows to a continuation page under the same headline marked "(continued)". A
 * table too tall for one page is split between rows. Long figure values (the stepped fee) wrap
 * under their label instead of running off the right edge.
 *
 * The heights are an ESTIMATE, deliberately generous, and the estimate is not the guard: the guard is
 * `scripts/validate/deck-fits-the-page.mjs`, which renders the deck in a real browser and fails if
 * any block's bottom edge crosses the footer — and the final PDF build measures the same thing in the
 * Worker's browser and refuses to write a PDF that would cut a line (services/deckPreview.ts).
 */

export interface DeckFigures {
  fund_size: number | null;
  fees: number | null;
  expenses: number | null;
  investable_base: number | null;
  early_sleeve_usd: number | null;
  early_sleeve_pct: number | null;
  secondary_sleeve_usd: number | null;
  secondary_sleeve_pct: number | null;
  reserve_pct: number | null;
  mgmt_fee_pct: number | null;
  carry_pct: number | null;
  reserve_usd: number | null;
  initial_capital_usd: number | null;
  target_positions: number | null;
  check_min: number | null;
  check_max: number | null;
  sectors: string[];
  /** Opportunities that arrived through the community, and the total. A share needs its denominator. */
  community_sourced: { through_community: number; total: number } | null;
  positions_held: number | null;
  as_of_date: string;
  check_typical: number | null;
  target_ownership_pct: number | null;
  follow_on_min: number | null;
  follow_on_max: number | null;
  follow_on_companies: number | null;
  secondary_check_min: number | null;
  secondary_check_max: number | null;
  secondary_positions: number | null;
  concentration_cap: number | null;
  gp_commit_pct: number | null;
  gp_commit_usd: number | null;
  target_net_multiple: number | null;
  /** The mandate's own words for a stepped fee; null when the fee is one flat rate. */
  mgmt_fee_schedule: string | null;
}

/**
 * The mandate's sector keys in the partners' words (26 Oct 2026: "AI · Health tech · Ed tech ·
 * Consumer · Future of work"), and the ORDER they say them in — the record's array order is storage,
 * not wording. A key not listed here prints after these, as stored.
 */
export const SECTOR_LABELS: Record<string, string> = {
  AI: "AI",
  HEALTH_TECH: "Health tech",
  ED_TECH: "Ed tech",
  CONSUMER: "Consumer",
  FUTURE_OF_WORK: "Future of work",
  FINTECH: "Fintech",
  CLIMATE: "Climate",
};
const SECTOR_ORDER = Object.keys(SECTOR_LABELS);

/** Deliberately loud. A gap a reader cannot miss beats a zero they will believe. */
const MISSING = "—— not recorded ——";

export function renderBinding(bind: Binding, figures: DeckFigures): string {
  if (bind === "as_of_date") return figures.as_of_date;

  if (bind === "sectors") {
    if (figures.sectors.length === 0) return MISSING;
    const rank = (s: string) => { const i = SECTOR_ORDER.indexOf(s); return i < 0 ? SECTOR_ORDER.length : i; };
    return [...figures.sectors].sort((a, b) => rank(a) - rank(b)).map((s) => SECTOR_LABELS[s] ?? s).join(" · ");
  }

  if (bind === "community_sourced_share") {
    const c = figures.community_sourced;
    if (!c || c.total === 0) return MISSING;
    return `${c.through_community} of ${c.total}`;
  }

  if (bind === "positions_held") {
    if (figures.positions_held === null) return MISSING;
    // Zero is a real and important answer here, not an empty one.
    return figures.positions_held === 0 ? "None yet — this is a first fund" : String(figures.positions_held);
  }

  if (bind === "mgmt_fee_schedule") {
    // A stepped fee is said in the mandate's words; a flat one falls back to its rate.
    if (figures.mgmt_fee_schedule) return figures.mgmt_fee_schedule;
    return typeof figures.mgmt_fee_pct === "number" ? `${figures.mgmt_fee_pct}%` : MISSING;
  }

  const value = (figures as unknown as Record<string, number | null>)[bind];
  if (typeof value !== "number") return MISSING;
  if (bind === "target_net_multiple") return `${value.toFixed(1)}x`;
  if (MONEY_BINDINGS.has(bind)) return usd(value);
  if (PERCENT_BINDINGS.has(bind)) return `${value}%`;
  return String(value);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Picture bytes by asset name, as `data:` URIs. Handed in at render time; never stored in git. */
export type DeckAssets = Readonly<Record<string, string>>;

// ── Page geometry. One set of numbers, read by the CSS AND by the height estimate. ──────────────

export const PAGE = { w: 1280, h: 720, padTop: 44, padBottom: 34, padX: 64, header: 46, footer: 34 } as const;
/** The height a slide's blocks may use, after the page's own furniture. */
const BODY_H = PAGE.h - PAGE.padTop - PAGE.padBottom - PAGE.header - PAGE.footer;
const GAP = 10;
const FULL_W = PAGE.w - 2 * PAGE.padX;
const ASIDE_W = 380;
const SPLIT_GUTTER = 48;

const lines = (text: string, fontPx: number, widthPx: number, k = 0.53): number =>
  Math.max(1, Math.ceil((text.length * fontPx * k) / widthPx));

function headlineHeight(slide: Slide, width: number): number {
  return lines(slide.headline, 32, Math.min(width, 1020), 0.7) * 38 + 12;
}
function standfirstHeight(text: string | undefined, width: number): number {
  return text ? lines(text, 19, Math.min(width, 940)) * 28 + 18 : 0;
}

/** A generous estimate of one block's height at a column width, gap included. */
export function slotHeight(slot: Slot, width: number, figures: DeckFigures): number {
  switch (slot.kind) {
    case "text":
      return lines(slot.text, 18, Math.min(width, 1000)) * 26 + GAP;
    case "heading":
      return 32 + GAP;
    case "figure":
    case "derivation": {
      const v = renderBinding(slot.bind, figures);
      if (v.length > 30) return 22 + lines(v, 18, width * 0.95) * 26 + 10 + GAP;
      return 40 + GAP;
    }
    case "image":
      return (slot.height ?? 140) + (slot.caption ? 24 : 0) + GAP;
    case "images": {
      const cap = slot.items.some((i) => i.caption)
        ? Math.max(...slot.items.map((i) => lines(i.caption ?? "", 12, Math.max(80, width / slot.items.length - 16), 0.62))) * 16 + 8
        : 0;
      return (slot.height ?? 56) + cap + GAP;
    }
    case "quote":
      return lines(slot.text, 19, width - 48, 0.5) * 28 + (slot.by ? 30 : 0) + 36 + GAP;
    case "table":
      return tableHeight(slot, width, figures) + GAP;
    case "person": {
      const textW = width - (slot.photo ? 150 : 0);
      const pts = slot.points.reduce((h, p) => h + lines(p, 15, textW - 18) * 21 + 4, 0);
      return Math.max(slot.photo ? 150 : 0, 24 + pts + (slot.logos?.length ? 46 : 0)) + GAP + 6;
    }
  }
}

function cellText(cell: TableCell, figures: DeckFigures): string {
  if (typeof cell === "string") return cell;
  if ("bind" in cell) return renderBinding(cell.bind, figures);
  return "";
}
/** A two-column table with no header is a list of label → value, set larger (the Terms page). */
export function isKeyValue(slot: Extract<Slot, { kind: "table" }>): boolean {
  return !slot.columns?.length && slot.rows.every((r) => r.length === 2);
}
function rowHeight(row: TableCell[], width: number, figures: DeckFigures, kv: boolean): number {
  const cw = (kv ? Math.min(width, 820) : width) / Math.max(1, row.length) - 18;
  const font = kv ? 16 : 14;
  let h = 0;
  for (const cell of row) {
    const ch = typeof cell === "object" && "asset" in cell ? 32 : lines(cellText(cell, figures), font, cw, kv ? 0.5 : 0.56) * (kv ? 22 : 19);
    h = Math.max(h, ch);
  }
  return h + (kv ? 13 : 18);
}
function tableHeight(slot: Extract<Slot, { kind: "table" }>, width: number, figures: DeckFigures): number {
  const head = slot.columns?.length ? lines(slot.columns.join(" "), 12, width, 0.55) * 18 + 16 : 0;
  const kv = isKeyValue(slot);
  return head + slot.rows.reduce((h, r) => h + rowHeight(r, width, figures, kv), 0);
}

// ── Pagination ───────────────────────────────────────────────────────────────────────────────

export interface Page {
  slide: Slide;
  slots: Slot[];
  right: Slot[];
  continued: boolean;
}

function contentWidth(slide: Slide): { left: number; right: number } {
  const layout = slide.layout ?? "standard";
  if (layout === "panel" || layout === "photo") return { left: FULL_W - ASIDE_W + PAGE.padX - 40, right: 0 };
  if (layout === "split") return { left: (FULL_W - SPLIT_GUTTER) / 2, right: (FULL_W - SPLIT_GUTTER) / 2 };
  return { left: FULL_W, right: 0 };
}

/** Lay one column's blocks onto pages of a given capacity; a table splits between rows. */
function fill(slots: Slot[], width: number, first: number, rest: number, figures: DeckFigures): Slot[][] {
  const pages: Slot[][] = [[]];
  let room = first;
  const push = (slot: Slot, h: number) => {
    if (h > room && pages[pages.length - 1]!.length > 0) {
      pages.push([]);
      room = rest;
    }
    pages[pages.length - 1]!.push(slot);
    room -= h;
  };
  for (const slot of slots) {
    const h = slotHeight(slot, width, figures);
    if (slot.kind === "table" && h > room) {
      // Split between rows: as many rows as fit here, the header repeated on the next page.
      let chunk: TableCell[][] = [];
      for (const row of slot.rows) {
        const trial = { ...slot, rows: [...chunk, row] };
        const th = slotHeight(trial, width, figures);
        if (th > room && chunk.length > 0) {
          pages[pages.length - 1]!.push({ ...slot, rows: chunk });
          pages.push([]);
          room = rest;
          chunk = [row];
        } else {
          chunk.push(row);
        }
      }
      if (chunk.length) push({ ...slot, rows: chunk }, slotHeight({ ...slot, rows: chunk }, width, figures));
      continue;
    }
    push(slot, h);
  }
  return pages;
}

/**
 * Every slide as the pages it needs. A slide that fits is one page; one that does not continues on
 * the next page under its own headline. The cover never continues.
 */
export function paginate(slides: readonly Slide[], figures: DeckFigures): Page[] {
  const out: Page[] = [];
  for (const slide of slides) {
    if ((slide.layout ?? "standard") === "cover" || slide.key === "cover") {
      out.push({ slide, slots: slide.slots, right: [], continued: false });
      continue;
    }
    const w = contentWidth(slide);
    const head = headlineHeight(slide, w.left + w.right + (w.right ? SPLIT_GUTTER : 0));
    const first = BODY_H - head - standfirstHeight(slide.standfirst, w.left + w.right + (w.right ? SPLIT_GUTTER : 0));
    const rest = BODY_H - headlineHeight({ ...slide, headline: `${slide.headline} (continued)` }, w.left);
    const left = fill(slide.slots, w.left, first, rest, figures);
    const right = slide.layout === "split" ? fill(slide.right ?? [], w.right, first, rest, figures) : [[]];
    const n = Math.max(left.length, right.length);
    for (let i = 0; i < n; i++) {
      out.push({ slide, slots: left[i] ?? [], right: right[i] ?? [], continued: i > 0 });
    }
  }
  return out;
}

// ── Drawing ──────────────────────────────────────────────────────────────────────────────────

function img(assets: DeckAssets, name: string, alt: string, cls: string, style = ""): string {
  const src = assets[name];
  if (!src) return `<span class="${cls} gap-img"${style ? ` style="${style}"` : ""}>picture missing: ${escapeHtml(name)}</span>`;
  return `<img class="${cls}" src="${src}" alt="${escapeHtml(alt)}"${style ? ` style="${style}"` : ""}>`;
}

function renderCell(cell: TableCell, figures: DeckFigures, assets: DeckAssets): string {
  if (typeof cell === "string") return escapeHtml(cell);
  if ("bind" in cell) return `<b>${escapeHtml(renderBinding(cell.bind, figures))}</b>`;
  return img(assets, cell.asset, cell.alt, "cell-img");
}

function renderSlot(slot: Slot, figures: DeckFigures, assets: DeckAssets): string {
  switch (slot.kind) {
    case "text":
      return `<li class="point${slot.plain ? " plain" : ""}">${escapeHtml(slot.text)}</li>`;
    case "heading":
      return `<li class="subhead">${escapeHtml(slot.text)}</li>`;
    case "image": {
      const h = slot.height ?? 140;
      return `<li class="picture">${img(assets, slot.asset, slot.alt, slot.round ? "pic round" : "pic", `height:${h}px`)}${slot.caption ? `<span class="caption">${escapeHtml(slot.caption)}</span>` : ""}</li>`;
    }
    case "images": {
      const h = slot.height ?? 56;
      const items = slot.items
        .map((i) => `<span class="tile">${img(assets, i.asset, i.alt, "pic", `height:${h}px`)}${i.caption ? `<span class="caption">${escapeHtml(i.caption)}</span>` : ""}</span>`)
        .join("");
      return `<li class="tiles">${items}</li>`;
    }
    case "quote":
      return `<li class="quote"><blockquote>“${escapeHtml(slot.text.replace(/^[“"]|[”"]$/g, ""))}”</blockquote>${slot.by ? `<span class="by">${escapeHtml(slot.by)}</span>` : ""}</li>`;
    case "table": {
      const head = slot.columns?.length ? `<thead><tr>${slot.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>` : "";
      const body = slot.rows.map((r) => `<tr>${r.map((c) => `<td>${renderCell(c, figures, assets)}</td>`).join("")}</tr>`).join("");
      return `<li class="table"><table${isKeyValue(slot) ? ' class="kv"' : ""}>${head}<tbody>${body}</tbody></table></li>`;
    }
    case "person": {
      const photo = slot.photo ? img(assets, slot.photo, slot.name, "pic headshot") : "";
      const logos = slot.logos?.length ? `<span class="logos">${slot.logos.map((l) => img(assets, l, "", "pic logo")).join("")}</span>` : "";
      return `<li class="person">${photo ? `<span class="who">${photo}<span class="name">${escapeHtml(slot.name)}</span></span>` : ""}<span class="about">${photo ? "" : `<span class="name">${escapeHtml(slot.name)}</span>`}<ul>${slot.points.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>${logos}</span></li>`;
    }
    case "figure":
    case "derivation": {
      const raw = renderBinding(slot.bind, figures);
      const value = escapeHtml(raw);
      const missing = raw === MISSING ? " missing" : "";
      const long = raw.length > 30 ? " long" : "";
      if (slot.kind === "derivation") {
        const sign = slot.operator === "minus" ? "−" : "";
        const rule = slot.operator === "equals" ? " sum" : "";
        return `<li class="derive${rule}${missing}${long}"><span class="label">${escapeHtml(slot.label)}</span><span class="value">${sign}${value}</span></li>`;
      }
      return `<li class="figure${missing}${long}"><span class="label">${escapeHtml(slot.label)}</span><span class="value">${value}</span></li>`;
    }
  }
}

function renderPage(page: Page, figures: DeckFigures, assets: DeckAssets, n: number, total: number): string {
  const { slide } = page;
  const layout = slide.layout ?? (slide.key === "cover" ? "cover" : "standard");
  const kind = slide.slots.some((s) => s.kind === "derivation") ? "construction" : slide.key;
  const list = (slots: Slot[]) => `<ul class="slots">\n${slots.map((s) => renderSlot(s, figures, assets)).join("\n")}\n</ul>`;
  const headline = page.continued ? `${slide.headline.replace(/[.:]$/, "")} (continued)` : slide.headline;
  const top = `<h1>${escapeHtml(headline)}</h1>${!page.continued && slide.standfirst ? `<p class="standfirst">${escapeHtml(slide.standfirst)}</p>` : ""}`;
  let main: string;
  if (layout === "cover") {
    const logo = slide.aside?.asset ? img(assets, slide.aside.asset, slide.aside.alt ?? "West Peek Ventures", "pic cover-logo") : `<span class="cover-word">WEST PEEK VENTURES</span>`;
    main = `<div class="cover">${logo}${top}${list(page.slots)}</div>`;
  } else if (layout === "split") {
    main = `${top}<div class="cols">${list(page.slots)}${list(page.right)}</div>`;
  } else {
    main = `${top}${list(page.slots)}`;
  }
  const aside =
    (layout === "panel" || layout === "photo") && !page.continued
      ? layout === "panel"
        ? `<aside class="panel">${escapeHtml(slide.aside?.text ?? "").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")}</aside>`
        : `<aside class="photo">${slide.aside?.asset ? img(assets, slide.aside.asset, slide.aside.alt ?? "", "pic fill") : ""}</aside>`
      : "";
  const withAside = aside ? " has-aside" : "";
  return `<section class="slide slide-${escapeHtml(kind)} layout-${layout}${withAside}" data-page="${n}">
  ${aside}
  <div class="frame">
  <header>
    <span class="wordmark">WEST&thinsp;PEEK VENTURES</span>
    <span class="folio">Fund I · ${escapeHtml(figures.as_of_date)} · ${n} / ${total}</span>
  </header>
  <div class="body">
  ${main}
  </div>
  <footer>Private &amp; Confidential, not for distribution. For Accredited Investors Only.</footer>
  </div>
</section>`;
}

/** The deck's own stylesheet. Shared by the PDF and the preview page so the two cannot differ. */
export const DECK_CSS = `
  :root{
    --paper:#F7F5EF; --ink:#141311; --muted:#5F5C56; --rule:#D3CEC4; --slate:#384653; --slate-ink:#FFFFFF;
  }
  .slide{
    width:${PAGE.w}px; height:${PAGE.h}px; background:var(--paper); color:var(--ink);
    font-family:"Public Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    -webkit-font-smoothing:antialiased; font-size:18px; line-height:1.45;
    display:flex; page-break-after:always; break-after:page; position:relative; overflow:hidden; box-sizing:border-box;
  }
  .slide *{box-sizing:border-box}
  .slide:last-child{page-break-after:auto;break-after:auto}
  .frame{flex:1;min-width:0;display:flex;flex-direction:column;padding:${PAGE.padTop}px ${PAGE.padX}px ${PAGE.padBottom}px}
  .has-aside .frame{padding-left:40px}
  .slide header{display:flex;justify-content:space-between;align-items:baseline;height:${PAGE.header - 18}px;
         border-bottom:1px solid var(--rule);margin-bottom:18px}
  .wordmark{font-weight:800;letter-spacing:.16em;font-size:12px}
  .folio{font-size:11px;color:var(--muted);letter-spacing:.04em}
  .body{flex:1;min-height:0;display:flex;flex-direction:column}
  .slide h1{font-weight:800;font-size:32px;line-height:1.18;letter-spacing:.005em;margin:0 0 12px;text-transform:uppercase;max-width:1020px;text-wrap:balance}
  .standfirst{font-size:19px;line-height:1.45;margin:0 0 18px;max-width:940px}
  ul.slots{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:${GAP}px;min-width:0;flex:1}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:${SPLIT_GUTTER}px;flex:1;min-height:0}
  li.point{position:relative;padding-left:22px;max-width:1000px;font-size:18px;line-height:1.45}
  li.point::before{content:"";position:absolute;left:0;top:.68em;width:9px;height:2px;background:var(--ink)}
  li.subhead{font-weight:800;font-size:14px;letter-spacing:.08em;text-transform:uppercase;padding-top:8px}
  li.figure,li.derive{display:flex;justify-content:space-between;align-items:baseline;gap:28px;max-width:760px;
    border-bottom:1px solid var(--rule);padding-bottom:6px}
  li.figure.long,li.derive.long{flex-direction:column;align-items:flex-start;gap:2px}
  li.long .value{white-space:normal;font-size:18px;text-align:left}
  li.derive.sum{border-bottom:2px solid var(--ink);font-weight:600}
  .label{color:var(--muted);font-size:16px}
  .value{font-variant-numeric:tabular-nums;font-weight:700;font-size:22px;white-space:nowrap}
  .missing .value{color:#A8422A;font-weight:400;font-size:15px}
  li.picture{display:flex;flex-direction:column;align-items:flex-start;gap:4px}
  .pic{display:block;object-fit:contain;max-width:100%}
  .pic.round{border-radius:50%;aspect-ratio:1;object-fit:cover}
  .caption{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink);line-height:1.3}
  li.tiles{display:flex;gap:16px;align-items:flex-start;justify-content:space-between}
  .tile{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;flex:1;min-width:0}
  .tile .caption{font-size:12px}
  li.quote{background:var(--slate);color:var(--slate-ink);padding:18px 24px}
  li.quote blockquote{margin:0;font-style:italic;font-size:19px;line-height:1.45}
  li.quote .by{display:block;margin-top:8px;font-size:15px;opacity:.85}
  li.table table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.35}
  li.table th{font-size:12px;letter-spacing:.06em;text-transform:uppercase;text-align:left;padding:6px 8px;border-bottom:2px solid var(--ink)}
  li.table td{padding:8px;border-bottom:1px solid var(--rule);vertical-align:middle}
  .cell-img{height:30px;max-width:160px;object-fit:contain;display:block}
  li.table table.kv{max-width:820px;font-size:16px}
  li.table table.kv td{padding:6px 8px}
  li.table table.kv td:first-child{color:var(--muted);width:45%}
  li.point.plain{padding-left:0}
  li.point.plain::before{display:none}
  li.person{display:flex;gap:24px;align-items:flex-start}
  .who{display:flex;flex-direction:column;align-items:center;gap:6px;width:126px;flex:none}
  .headshot{width:120px;height:120px;object-fit:cover}
  .name{font-weight:800;font-size:12px;letter-spacing:.08em;text-transform:uppercase}
  .about{flex:1;min-width:0}
  .about ul{margin:0;padding-left:18px;font-size:15px;line-height:1.4;display:flex;flex-direction:column;gap:4px}
  .logos{display:flex;gap:22px;align-items:center;margin-top:10px}
  .logo{height:36px;max-width:420px;object-fit:contain;object-position:left center}
  aside.panel{width:${ASIDE_W}px;flex:none;background:var(--slate);color:var(--slate-ink);padding:120px 34px 40px 40px;
    font-size:21px;line-height:1.4;text-transform:uppercase;white-space:pre-line}
  aside.photo{width:${ASIDE_W}px;flex:none;background:#000;overflow:hidden}
  aside.photo .fill{width:100%;height:100%;object-fit:cover}
  .cover{flex:1;display:flex;flex-direction:column;justify-content:center;max-width:860px}
  .cover-logo{height:64px;margin-bottom:28px;align-self:flex-start}
  .cover-word{font-weight:800;letter-spacing:.14em;font-size:20px;margin-bottom:24px}
  .layout-cover h1{font-size:54px;font-style:italic;letter-spacing:.04em;margin-bottom:14px}
  .layout-cover .standfirst{font-size:18px;color:var(--muted)}
  .layout-cover ul.slots{flex:none;margin-top:40px;gap:4px}
  .layout-cover li.point{padding-left:0;font-size:15px;color:var(--muted)}
  .layout-cover li.point::before{display:none}
  .layout-cover li.figure{border:0;padding:0;display:block}
  .layout-cover li.figure .label{font-size:12px;letter-spacing:.1em;text-transform:uppercase;margin-right:10px}
  .layout-cover li.figure .value{font-size:16px;font-weight:400}
  .gap-img{display:inline-flex;align-items:center;justify-content:center;border:2px dashed #A8422A;color:#A8422A;font-size:12px;padding:6px;min-width:90px;min-height:40px}
  .slide footer{margin-top:auto;height:${PAGE.footer - 12}px;padding-top:8px;border-top:1px solid var(--rule);font-size:11px;font-weight:600;color:var(--muted);letter-spacing:.02em;text-align:right}
`;

const FONTS =
  `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
  `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Public+Sans:ital,wght@0,400;0,600;0,700;0,800;1,400&display=swap">`;

/** Only the pages, paginated — for the PDF and for the preview's frames. */
export function renderDeckPages(figures: DeckFigures, slides: readonly Slide[] = DECK_SLIDES, assets: DeckAssets = {}): string[] {
  const pages = paginate(slides, figures);
  return pages.map((p, i) => renderPage(p, figures, assets, i + 1, pages.length));
}

/** The whole deck, one printable page per page at 16:9. */
export function renderDeckHtml(figures: DeckFigures, slides: readonly Slide[] = DECK_SLIDES, assets: DeckAssets = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>West Peek Ventures Fund I</title>
${FONTS}
<style>
  html,body{margin:0;padding:0;background:#F7F5EF}
${DECK_CSS}
  @page{size:${PAGE.w / 96}in ${PAGE.h / 96}in;margin:0}
  @media print{.slide{margin:0}}
</style></head>
<body>
${renderDeckPages(figures, slides, assets).join("\n")}
</body></html>`;
}

/**
 * Runs IN THE BROWSER (puppeteer `page.evaluate`, Playwright in the validator): every block whose
 * bottom edge crosses its page's footer, or whose right edge leaves the page. Empty means it fits.
 * Kept as a function source string so the Worker, the validator and a test measure identically.
 */
export const MEASURE_OVERFLOW_JS = `(() => {
  const out = [];
  for (const slide of document.querySelectorAll("section.slide")) {
    const page = slide.getAttribute("data-page");
    const foot = slide.querySelector("footer").getBoundingClientRect();
    const box = slide.getBoundingClientRect();
    for (const el of slide.querySelectorAll(".body h1, .body .standfirst, .body ul.slots > li")) {
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      if (r.bottom > foot.top + 1) out.push({ page: Number(page), what: (el.textContent || "").trim().slice(0, 60), by: Math.round(r.bottom - foot.top) });
      else if (r.right > box.right + 1) out.push({ page: Number(page), what: (el.textContent || "").trim().slice(0, 60), by: Math.round(r.right - box.right), edge: "right" });
    }
  }
  return out;
})()`;
