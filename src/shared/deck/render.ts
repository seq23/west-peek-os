import { DECK_SLIDES, MONEY_BINDINGS, PERCENT_BINDINGS, type Binding, type Slide, type Slot } from "./definition";
import { usd } from "../fund/sleeveMath";

/**
 * The deck definition plus a snapshot, rendered to HTML a browser can print.
 *
 * ONE FORMATTER FOR EACH KIND OF FIGURE. `usd` is the same function the fund page, the discrepancy
 * register and the construction editor use, so $16.8M is spelled identically wherever it appears.
 * Two spellings of one number on one document is the smaller cousin of the bug this deck exists to
 * have fixed.
 *
 * A MISSING BINDING RENDERS AS A VISIBLE GAP, never as a blank or a zero. A slide that quietly
 * prints "$0M" because a record was absent is exactly the confident-wrong-number failure the whole
 * exercise is about; "—— not recorded ——" is ugly on purpose and impossible to miss in review.
 *
 * ON THE TYPEFACE, said here because the render is where the decision bites: the identity face is
 * NORWESTER, a free condensed display face, and it could not be fetched from this environment (both
 * known sources returned 404 HTML rather than a font). Oswald is substituted — the closest
 * widely-available condensed face on Google Fonts — and the delivery note says so, because
 * substituting a condensed display face is visible to anyone who knows the original and she should
 * hear it from her own employee rather than notice it herself. Public Sans IS the real body face and
 * is loaded genuinely.
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
}

const SECTOR_LABELS: Record<string, string> = {
  AI: "AI",
  HEALTH_TECH: "Healthcare",
  CONSUMER: "Consumer",
  ED_TECH: "Education",
  FUTURE_OF_WORK: "Future of work",
  FINTECH: "Fintech",
  CLIMATE: "Climate",
};

/** Deliberately loud. A gap a reader cannot miss beats a zero they will believe. */
const MISSING = "—— not recorded ——";

export function renderBinding(bind: Binding, figures: DeckFigures): string {
  if (bind === "as_of_date") return figures.as_of_date;

  if (bind === "sectors") {
    if (figures.sectors.length === 0) return MISSING;
    return figures.sectors.map((s) => SECTOR_LABELS[s] ?? s).join(" · ");
  }

  if (bind === "community_sourced_share") {
    const c = figures.community_sourced;
    if (!c || c.total === 0) return MISSING;
    // WITH the denominator, always. A proportion of four is a signal, not a statistic.
    return `${c.through_community} of ${c.total}`;
  }

  if (bind === "positions_held") {
    if (figures.positions_held === null) return MISSING;
    // Zero is a real and important answer here, not an empty one.
    return figures.positions_held === 0 ? "None yet — this is a first fund" : String(figures.positions_held);
  }

  const value = (figures as unknown as Record<string, number | null>)[bind];
  if (typeof value !== "number") return MISSING;
  if (MONEY_BINDINGS.has(bind)) return usd(value);
  if (PERCENT_BINDINGS.has(bind)) return `${value}%`;
  return String(value);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function renderSlot(slot: Slot, figures: DeckFigures): string {
  if (slot.kind === "text") return `<li class="point">${escapeHtml(slot.text)}</li>`;

  const value = escapeHtml(renderBinding(slot.bind, figures));
  const missing = value === MISSING ? " missing" : "";
  if (slot.kind === "derivation") {
    const sign = slot.operator === "minus" ? "−" : "";
    const rule = slot.operator === "equals" ? " sum" : "";
    return `<li class="derive${rule}${missing}"><span class="label">${escapeHtml(slot.label)}</span><span class="value">${sign}${value}</span></li>`;
  }
  return `<li class="figure${missing}"><span class="label">${escapeHtml(slot.label)}</span><span class="value">${value}</span></li>`;
}

function renderSlide(slide: Slide, figures: DeckFigures, n: number, total: number): string {
  const body = slide.slots.map((s) => renderSlot(s, figures)).join("\n");
  const kind = slide.slots.some((s) => s.kind === "derivation") ? "construction" : slide.key;
  return `<section class="slide slide-${escapeHtml(kind)}">
  <header>
    <span class="wordmark">WEST&thinsp;PEEK VENTURES</span>
    <span class="folio">Fund I · ${escapeHtml(figures.as_of_date)} · ${n} / ${total}</span>
  </header>
  <h1>${escapeHtml(slide.headline)}</h1>
  ${slide.standfirst ? `<p class="standfirst">${escapeHtml(slide.standfirst)}</p>` : ""}
  <ul class="slots">
${body}
  </ul>
  <footer>Private &amp; Confidential — not for distribution. For Accredited Investors Only.</footer>
</section>`;
}

/** The whole deck, one printable page per slide at 16:9. */
export function renderDeckHtml(figures: DeckFigures, slides: readonly Slide[] = DECK_SLIDES): string {
  const pages = slides.map((s, i) => renderSlide(s, figures, i + 1, slides.length)).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>West Peek Ventures Fund I</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600&family=Public+Sans:ital,wght@0,400;0,600;1,400&display=swap">
<style>
  /* The deck's own ground and ink, matched to her export rather than invented. */
  :root{
    --paper:#EFECE6; --ink:#141311; --muted:#6B6862; --rule:#C9C3B8; --accent:#141311;
    --page-w:1280px; --page-h:720px;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:var(--paper);color:var(--ink)}
  body{font-family:"Public Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
       -webkit-font-smoothing:antialiased;font-size:17px;line-height:1.5}

  .slide{
    width:var(--page-w); height:var(--page-h);
    padding:56px 72px 48px; background:var(--paper);
    display:flex; flex-direction:column;
    page-break-after:always; break-after:page; position:relative; overflow:hidden;
  }
  .slide:last-child{page-break-after:auto;break-after:auto}

  header{display:flex;justify-content:space-between;align-items:baseline;
         border-bottom:1px solid var(--rule);padding-bottom:10px;margin-bottom:36px}
  /* The wordmark, set in the condensed display face. See the note on Norwester above. */
  .wordmark{font-family:"Oswald","Public Sans",sans-serif;font-weight:600;letter-spacing:.18em;font-size:15px}
  .folio{font-size:12px;color:var(--muted);letter-spacing:.04em}

  h1{font-family:"Oswald","Public Sans",sans-serif;font-weight:500;
     font-size:52px;line-height:1.04;letter-spacing:.005em;margin:0 0 18px;
     text-transform:uppercase;max-width:22ch;text-wrap:balance}
  .slide-cover h1{font-size:76px;font-style:normal;max-width:16ch}
  .standfirst{font-size:21px;line-height:1.45;color:var(--ink);margin:0 0 28px;max-width:62ch}
  .slide-cover .standfirst{font-size:17px;letter-spacing:.12em;color:var(--muted);text-transform:none}
  /* THE COVER IS NOT A DATA TABLE. Its slots are cover lines — a date and a disclosure — and the
     first render set them as label/value rows with a rule under each, which read as a spreadsheet
     on the one slide that has to look like a document. */
  .slide-cover ul.slots{justify-content:flex-end;gap:6px;flex:1}
  .slide-cover li.figure,.slide-cover li.derive{display:block;border-bottom:0;padding-bottom:0;max-width:none}
  .slide-cover li.figure .label{font-size:13px;letter-spacing:.1em;text-transform:uppercase;margin-right:10px}
  .slide-cover li.figure .value{font-size:17px;font-weight:400}
  .slide-cover li.point{padding-left:0;font-size:16px;color:var(--muted)}
  .slide-cover li.point::before{display:none}

  ul.slots{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px;flex:1;min-height:0}
  /* THE CONSTRUCTION SLIDE CLIPPED ITS LAST LINE — "For initial cheques", the single figure an
     allocator is looking for — because eight rows at the default rhythm overflow a 720px page.
     Found by reading the rendered PDF rather than the HTML. Denser rows, and the slide no longer
     depends on nobody adding a ninth. */
  .slide-construction ul.slots{gap:4px}
  .slide-construction li.figure,.slide-construction li.derive{padding-bottom:4px}
  .slide-construction .value{font-size:19px}
  .slide-construction h1{font-size:44px;margin-bottom:10px}
  .slide-construction .standfirst{font-size:18px;margin-bottom:16px}
  li.point{position:relative;padding-left:22px;max-width:70ch;font-size:19px;line-height:1.5}
  li.point::before{content:"";position:absolute;left:0;top:.62em;width:9px;height:1px;background:var(--ink)}

  /* A wider measure, because the first render left the right half of every slide dead while her
     own deck sets content against generous whitespace rather than beside emptiness. */
  li.figure,li.derive{display:flex;justify-content:space-between;align-items:baseline;
    gap:32px;max-width:62ch;border-bottom:1px solid var(--rule);padding-bottom:8px}
  li.derive.sum{border-bottom:2px solid var(--ink);font-weight:600}
  .label{color:var(--muted);font-size:17px}
  .value{font-variant-numeric:tabular-nums;font-weight:600;font-size:24px;white-space:nowrap}
  /* A gap nobody can mistake for a figure. */
  .missing .value{color:#A8422A;font-weight:400;font-size:15px}

  footer{margin-top:auto;padding-top:14px;border-top:1px solid var(--rule);
         font-size:11px;color:var(--muted);letter-spacing:.03em}

  @page{size:${1280 / 96}in ${720 / 96}in;margin:0}
  @media print{.slide{margin:0}}
</style></head>
<body>
${pages}
</body></html>`;
}
