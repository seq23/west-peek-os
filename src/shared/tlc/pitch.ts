import { BRAND_COMMUNITY_SHORT, COMMUNITY_ABOUT } from "../community/size";
import { SERIES_COUNTS, SERIES_LEVELS, seriesOf, usd as seriesUsd, type SeriesPricing } from "./series";
import { MAAX_BOLD_WOFF2, MAAX_REGULAR_WOFF2, WP_MONOGRAM_PNG } from "./brandAssets";
import { TLC_ABOUT_COMMUNITY, TLC_ABOUT_WEST_PEEK } from "./aboutWestPeek";
import {
  TLC_IDEA_ORIGIN_LABEL,
  TLC_NET_FLOOR_USD,
  TLC_NET_TARGET_USD,
  TLC_OWNER,
  TLC_SEATS,
  BRAND_ROOM_WORDS,
  TLC_TARGET_PATH,
  TLC_TICKET_PRICE_USD,
  TLC_TIERS,
  TLC_TIER_KEYS,
  type TlcTier,
  competingCategories,
  sponsorMixProblems,
  aiRuleProblems,
  seasonOption,
  seatsWords,
  type Seats,
  type TlcSponsorCategory,
  isIdeaOrigin,
  monthWords,
} from "./learningClub";

/**
 * TWO DOCUMENTS PER CLUB MONTH (owner, 22 Oct 2026, after a hostile review of the one-sheets).
 *
 *   THE BRAND PITCH — what a brand reads. In this order: a two-line hook; why now for the brand's
 *   category (the packet's OWN sourced why-now, never the generic quarterly trend story: review B3);
 *   who is in the room; what the brand gets; the price and the ask; the contact. No internal labels,
 *   no exclusivity (there is no such policy: review B4), the community-first About.
 *
 *   THE INTERNAL ONE-PAGER — what Sequoia reads. The topic and angle, the why-now with sources, the
 *   economics, the categories with example brands and reasons, where the idea came from, the risks,
 *   and what she must decide. The full About (the $100M line and the portfolio names) lives ONLY here.
 *
 * Both are self-contained HTML (light and dark, phone width) that print to one letter page; the
 * worker prints them through the browser (effects/htmlPdf.ts). PURE: no database, no network.
 */

export type TlcCategory = TlcSponsorCategory;
export interface TlcClubView {
  topic: string;
  angle: string | null;
  month: string;
  eventDate: string;
  slot: string;
  whyNow: string | null;
  sources: ReadonlyArray<{ title: string; url: string }>;
  categories: readonly TlcCategory[];
  handsOn: string | null;
  takeHome: string | null;
  recap: string | null;
  /** The AI segment in the run of show (every non-AI club has one). */
  aiSegment?: string | null;
  /** The club's own planned room size (the partners set it; internal, never what a brand is told). */
  seats?: Seats;
}
export interface TlcInternalView extends TlcClubView {
  origin: string | null;
  status: string;
  vetoUntil: string | null;
  committedUsd: number;
  committedPartners: number;
  pitchUrl: string | null;
  /** This club's sponsor goal and cost budget ($25,000 and $15,000 unless the partners changed it). */
  goalUsd?: number;
  costBudgetUsd?: number;
  /** Product partners and other in-kind help: cost relief, never counted toward the goal. */
  inKind?: ReadonlyArray<{ brand: string; what: string | null }>;
  /** The month's backup club and its switch deadline (internal only; the brand pitch shows the primary alone). */
  backup?: { topic: string; angle: string | null; deadline: string } | null;
  /** Who chose this month's topic, when it was the owner's decision rather than Parker's pick. */
  decidedBy?: string | null;
}

/**
 * WHAT THE PITCH PDF SAYS ABOUT THE ROOM (owner, 30 Oct 2026): our materials say 25 to 100+ guests per event,
 * flexible to the brand's needs, whatever size the club is planned for (an EMAIL to a brand says 25+ instead:
 * BRAND_EMAIL_ROOM_WORDS, 1 Nov 2026). The planned size stays internal
 * (the one-pager and the economics read it).
 */
export const BRAND_GUESTS_WORDS = `${BRAND_ROOM_WORDS} guests per event, flexible to your goals`;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Thursday 11 February 2027, 6–10 pm". The weekday is read off the date, never assumed. */
export function clubWhen(eventDate: string, slot: string): string {
  const d = new Date(`${eventDate}T12:00:00Z`);
  const day = Number.isNaN(d.getTime()) ? "" : `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${monthWords(eventDate.slice(0, 7))}`;
  return `${day || monthWords(eventDate.slice(0, 7))}, ${slot === "AFTERNOON" ? "1–5 pm" : "6–10 pm"}`;
}

const sentences = (t: string): string[] => t.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);

/** Sentences no brand-facing copy may carry: a stale date, a promised result, an exclusivity claim, an internal name. */
const BRAND_DROP = [/proposed date/i, /running on their own|working automations|drafts itself|guarantee/i, /exclusiv/i, /\b(Parker|Wynn)\b/];

/**
 * Copy a brand may read. "Dry January" is a trademark risk (review), so it is never our words (owner:
 * "Zero-Proof January" or "January reset" instead); a
 * stale proposed date, a promised outcome and an exclusivity claim are dropped; internal labels
 * like "(lead)" or "(donated)" are removed.
 */
export function brandSafe(text: string | null | undefined): string {
  const t = String(text ?? "")
    .replace(/\bdo Dry January\b/gi, "do a Zero-Proof January")
    .replace(/\bDry January\b/gi, "Zero-Proof January")
    .replace(/\s*\((?:lead|supporting|donated|in[- ]kind|frontier model)[^)]*\)/gi, "")
    .replace(/\s*—\s*/g, ", ");
  // A sentence that would charge guests, offer a venue or imply a track record is dropped too (owner, 4 Nov 2026).
  return sentences(t).filter((x) => !BRAND_DROP.some((r) => r.test(x)) && !BRAND_COPY_FORBIDDEN.some(([r]) => r.test(x))).join(" ");
}

/** Internal copy keeps everything except what is simply untrue: no exclusivity, no stale proposed date. */
function internalSafe(text: string | null | undefined): string {
  const t = String(text ?? "").replace(/,?\s*category-exclusive/gi, "");
  return sentences(t).filter((x) => !/proposed date/i.test(x) && !/exclusiv/i.test(x)).join(" ");
}

/** The safety lines a topic needs (review: January 21+ and ABV; March confidential data and no overpromise). */
export function safetyLines(topic: string, text = ""): string[] {
  const all = `${topic} ${text}`;
  const out: string[] = [];
  if (/peptide/i.test(all)) {
    out.push("The peptides segment is evidence and regulatory status only, led by an independent doctor West Peek pays: no dosing, no sources, no sellers, and nothing handed out.");
  }
  if (/health data|wearable|\blab (results|tests|numbers|reports?)\b|sleep data/i.test(all)) {
    out.push("Guests choose what to share; sample data is there for anyone who would rather not use their own; nothing is uploaded on their behalf. AI is not medical advice.");
  }
  if (/\binvest|\bmoney\b|budget|retirement/i.test(all)) {
    out.push("Nothing here is investment advice: no stock picks and no recommendations.");
  }
  if (/zero[- ]proof|non[- ]alcoholic|cocktail|mocktail|\bbar\b|spirits|aperitif|\bbeer\b|\bwine\b/i.test(all)) {
    out.push("21+ only, with ID checked at the door. Every drink served is non-alcoholic (0.5% ABV or less).");
  }
  // Work with AI on real tasks: AI tools, agents, assistants, automations. Not a fragrance night that uses AI-designed accords.
  if (/\bAI (tools?|agents?|assistants?)\b|automation|chatbot|\bLLM\b|\bprompt/i.test(all)) {
    out.push("Attendees work only on sample or non-confidential material, never their employer's confidential data.");
    out.push("We teach how the tools work and where they help; we do not promise any particular result.");
  }
  return out;
}

/**
 * WEST PEEK'S BRAND ON EVERY TLC DOCUMENT (owner, 6 Nov 2026, on the Pinecone sheet: "the entire page needs better
 * branding according to West Peek branding and typography"). WEST_PEEK_BRAND_SYSTEM.md: black and white first, West
 * Peek Orange #F05A1A as the accent only, warm off-white for cards, the WP monogram as the anchor; Maax, self-hosted
 * (brain, 23 Sep 2026), as the one face. FOUR TYPE SIZES, each a step quieter than the one above (make-it-calm 4):
 * 1 the title, 2 a section heading or a price, 3 a level's name, 4 body; the small uppercase label is supporting.
 */
const MAAX = `@font-face{font-family:Maax;font-weight:400;font-style:normal;src:url(data:font/woff2;base64,${MAAX_REGULAR_WOFF2}) format("woff2")}
@font-face{font-family:Maax;font-weight:700;font-style:normal;src:url(data:font/woff2;base64,${MAAX_BOLD_WOFF2}) format("woff2")}`;
const STYLE = `<style>
${MAAX}
:root{--bg:#FFFFFF;--ink:#171717;--muted:#5F5B55;--line:#E4DDD2;--accent:#F05A1A;--card:#F7F2EA;--tint:#FFF1E9;--mast:#050505;--mast-ink:#FFFFFF;
--t1:40px;--t2:20px;--t3:17px;--t4:16px;--label:12px;--levelcol:clamp(140px,34%,260px)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0B0B0B;--ink:#F7F2EA;--muted:#B5AEA4;--line:#2E2B28;--card:#171717;--tint:#2A1A12}}
:root[data-theme="dark"]{--bg:#0B0B0B;--ink:#F7F2EA;--muted:#B5AEA4;--line:#2E2B28;--card:#171717;--tint:#2A1A12}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:400 var(--t4)/1.5 Maax,-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:0 16px 64px}
.mast{display:flex;align-items:center;justify-content:space-between;gap:16px;background:var(--mast);color:var(--mast-ink);margin:0 -16px 28px;padding:16px 22px;border-bottom:4px solid var(--accent)}
.mast img{width:44px;height:44px;filter:invert(1);display:block}
.eyebrow{letter-spacing:.14em;text-transform:uppercase;font-size:var(--label);font-weight:700;color:var(--accent)}
.mast .eyebrow{color:var(--mast-ink)}
h1{font-size:var(--t1);line-height:1.08;margin:0 0 10px;letter-spacing:-.02em;font-weight:700}
h2{font-size:var(--t2);line-height:1.25;margin:26px 0 8px;font-weight:700;letter-spacing:-.01em}
h2::before{content:"";display:block;width:28px;height:3px;background:var(--accent);margin-bottom:8px}
.lede{font-size:var(--t3);max-width:700px;margin:0 0 8px}.when{color:var(--muted);margin:0}
ul,ol{padding-left:20px;margin:0}li{margin:4px 0}.cats{columns:2;column-gap:28px}@media (max-width:560px){.cats{columns:1}}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:0 32px}
.note{background:var(--card);border-left:3px solid var(--accent);padding:10px 14px;margin:18px 0 0;color:var(--muted)}
.tiers{border-top:2px solid var(--ink);margin:6px 0 10px}
.tier{display:grid;grid-template-columns:var(--levelcol) 1fr;column-gap:22px;padding:12px 0;border-bottom:1px solid var(--line)}
.tier b{grid-row:1 / span 2;font-weight:700}.tier .name{display:block;font-size:var(--t3);line-height:1.25}.tier .dot{display:none}
.tier .price{display:block;font-size:var(--t2);line-height:1.3;color:var(--accent);letter-spacing:-.01em}
.tier .mark{display:block;font-style:normal;font-weight:700;font-size:var(--label);letter-spacing:.06em;text-transform:uppercase;color:var(--accent);margin:0 0 4px}
.tier .adds{color:var(--ink)}.tier .adds::first-letter{text-transform:uppercase}
.tier[data-level="LEAD"]{background:var(--tint);margin-left:-12px;padding-left:9px;padding-right:12px;border-left:3px solid var(--accent)}
.tiers + p,.tiers + p + p{margin:6px 0;color:var(--muted)}
.yes ol{padding-left:20px}
.box{background:var(--card);border-radius:12px;padding:14px 16px}.box h2{margin-top:0}.box p{margin:0}
table{border-collapse:collapse;width:100%}td,th{border-top:1px solid var(--line);padding:6px 8px 6px 0;text-align:left;vertical-align:top}
a{color:inherit}.muted{color:var(--muted)}
footer{margin-top:24px;border-top:2px solid var(--ink);padding-top:12px;display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px 24px}
footer a{text-decoration:none;color:var(--accent)}footer .conf{margin:0;color:var(--muted);font-size:var(--label);letter-spacing:.06em;text-transform:uppercase}
.two .box{margin-top:26px}.two h2{margin-top:26px}
@page{size:letter;margin:0 0 .45in}
@media print{:root,:root:not([data-theme="light"]),:root[data-theme="dark"]{--bg:#FFFFFF;--ink:#171717;--muted:#5F5B55;--line:#E4DDD2;--card:#F7F2EA;--tint:#FFF1E9;
--t1:30px;--t2:16px;--t3:13.5px;--t4:12px;--label:9.5px;--levelcol:2.5in}
body{line-height:1.45;-webkit-print-color-adjust:exact;print-color-adjust:exact}main{max-width:none;padding:0 .5in}
.mast{margin:0 -.5in 20px;padding:14px .5in}.mast img{width:36px;height:36px}
h2{margin:16px 0 6px}h2::before{margin-bottom:6px;width:22px}.src{font-size:10px;columns:2;column-gap:28px}
li{margin:2px 0}.tier{padding:8px 0}.tier[data-level="LEAD"]{padding:8px 12px 8px 9px}.tier,.box,.note,li,tr{break-inside:avoid}.note{margin-top:12px;padding:8px 12px}
.two .box,.two h2{margin-top:16px}footer{margin-top:16px}}
</style>`;

/** The black masthead: the WP monogram (alt "West Peek") and the document's label, the label's words unchanged. */
const mast = (label: string): string => `<header class="mast"><img src="data:image/png;base64,${WP_MONOGRAM_PNG}" alt="West Peek"><div class="eyebrow">${esc(label)}</div></header>`;

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${STYLE}</head><body><main>
${body}
</main></body></html>`;

const sourcesList = (sources: TlcClubView["sources"]): string =>
  sources.length ? `<ol class="src">${sources.map((s) => `<li><a href="${esc(s.url)}">${esc(s.title)}</a></li>`).join("")}</ol>` : "";

/** The brand-facing category name: no "(lead)", no "(supporting)", no exclusivity. */
export function categoryName(c: string): string {
  return brandSafe(c).replace(/[.\s]+$/, "") || c.replace(/\s*\(.*?\)/g, "");
}

/**
 * THE SPONSOR A SHEET IS RENDERED FOR (owner, 4 Nov 2026). Every fact comes from the deal row and Wynn's rules: the
 * category Parker gave it, the large-brand flag, her angle. Nothing is invented: an unknown answer leaves a line out
 * (fail closed: no in-kind level, no Title level, no product line).
 */
export interface TlcSponsorView {
  brand: string;
  /** A physical product guests can hold: only then is the in-kind level shown. */
  physicalProduct: boolean;
  /** Software or a service guests use in the hands-on hour (e.g. a vector database). */
  software: boolean;
  /** What the brand is to the guests, from its category ("vector database"); null when not known. */
  role: string | null;
  /** The brand's newest relevant product, only where research names one. */
  newestProduct: string | null;
  /** Research marks the brand as large enough to fund a whole room: only then is Title shown. */
  largeBrand: boolean;
  /** The brand asked about owning the room (a reply draft may then add Title). */
  askedToOwnRoom?: boolean;
  /** The deal (her angle or Wynn's rule) leads with the series of six. */
  series: boolean;
  /**
   * A QUARTERLY SERIES OFFERED TO THIS BRAND (partners, 6 Nov 2026, Pinecone: "a quarterly event series at $10K per
   * event as a discount"): one evening a quarter, a per-event price and a discounted total. Set per deal by the
   * partners (tlc_deal.offer_json); when present it replaces the series-of-six line.
   */
  quarterly?: QuarterlyOffer | null;
  /**
   * SERIES PRICES SET FOR THIS BRAND (owner, 7 Nov 2026; tlc_deal.series_json, shared/tlc/series.ts): per-event prices
   * for 1, 4 and 6 evenings and the named evenings. When present it replaces the quarterly and series-of-six lines.
   */
  seriesPricing?: SeriesPricing | null;
}
export interface QuarterlyOffer { year: number; events: number; perEventUsd: number; totalUsd: number }
/** A partner-set offer, read safely: anything malformed is no offer. PURE. */
export function quarterlyOf(json: string | null | undefined): QuarterlyOffer | null {
  try {
    const v = JSON.parse(json ?? "null") as Partial<QuarterlyOffer> | null;
    const ok = v && [v.year, v.events, v.perEventUsd, v.totalUsd].every((n) => Number.isInteger(n) && (n as number) > 0) && v.totalUsd! <= v.perEventUsd! * v.events!;
    return ok ? { year: v!.year!, events: v!.events!, perEventUsd: v!.perEventUsd!, totalUsd: v!.totalUsd! } : null;
  } catch { return null; }
}
/** "A quarterly series in 2027: 4 evenings, one a quarter, $10,000 per event; $35,000 for all four (you save $5,000)." */
export function quarterlyWords(q: QuarterlyOffer, brand: string): string {
  const save = q.perEventUsd * q.events - q.totalUsd;
  return `A quarterly series in ${q.year}: ${q.events} evenings, one a quarter, each built hackathon-style around ${brand}, at ${usd(q.perEventUsd)} per event; ${usd(q.totalUsd)} for all ${q.events === 4 ? "four" : q.events}${save > 0 ? ` (you save ${usd(save)})` : ""}.`;
}

const SOFTWARE = /\b(software|saa?s|api|apis|platform|database|vector|cloud|developer|dev tools?|ai (?:lab|model|assistant|agents?)|llm|frontier model|model provider|app|apps|analytics|infrastructure|search engine|no[- ]code|automation|hosting|data (?:platform|warehouse)|service)\b/i;
const PHYSICAL = /\b(drinks?|beverages?|spirits?|aperitifs?|wine|beer|zero[- ]proof|mocktails?|mixers?|glassware|coffee|tea|snacks?|food|chocolate|candy|skincare|beauty|cosmetics?|fragrance|perfume|candles?|apparel|clothing|footwear|shoes?|jewel(?:le)?ry|supplements?|vitamins?|wearables?|devices?|hardware|headphones?|speakers?|cameras?|kitchen|cookware|stationery|notebooks?|furniture|home goods|consumer goods|pet food)\b/i;

/** "Pinecone (vector database)" -> its key for Wynn's rules: "PINECONE". */
export const brandRuleKey = (brand: string): string => brand.replace(/\s*\([^()]*\)/g, "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
const SERIES_ASK = /\bseries of six\b|\bsix[- ](?:room|club|month) series\b|\bsix rooms\b/i;

/** The sponsor view of a deal, from its own row and Wynn's rules. PURE. */
export function sponsorOf(
  deal: { brand: string; category?: string | null; why_fit?: string | null; owner_angle?: string | null; large_brand?: number | boolean | null; offer_json?: string | null; series_json?: string | null },
  rules: ReadonlyArray<{ code: string | null }> = [],
): TlcSponsorView {
  const brand = deal.brand.replace(/\s*\([^()]*\)/g, "").replace(/\s+/g, " ").trim() || deal.brand.trim();
  const category = (deal.category ?? "").replace(/\s*\((?:lead|supporting|donated|in[- ]kind|frontier model)[^)]*\)/gi, "").trim();
  const software = SOFTWARE.test(category);
  // A physical product only when the category says so and it is not software: unknown never shows in-kind.
  const physicalProduct = !software && PHYSICAL.test(category);
  const role = software && category ? category.toLowerCase().replace(/[.\s]+$/, "") : null;
  const key = brandRuleKey(brand);
  return {
    brand, software, physicalProduct, role, newestProduct: null,
    largeBrand: deal.large_brand === true || deal.large_brand === 1,
    series: SERIES_ASK.test(deal.owner_angle ?? "") || rules.some((r) => r.code === `${key}_SERIES`),
    quarterly: quarterlyOf(deal.offer_json),
    seriesPricing: seriesOf(deal.series_json),
  };
}

export interface BrandLevel { key: TlcTier; label: string; priceUsd: number | null; head: string; adds: string[]; marked: string | null }

/**
 * THE LEVELS ONE BRAND SEES, lowest price first, each saying what it adds over the one below (owner, 4 Nov 2026).
 * Title only for a large brand (or one that asked to own the room); in-kind only for a physical product; never a
 * cash level below $5,000. "Presented by" is sold only at Presenting; Title is "with <Brand>".
 */
export function brandLevels(sponsor: TlcSponsorView | null, topic: string): BrandLevel[] {
  const b = sponsor?.brand ?? "your brand";
  const B = sponsor?.brand ?? "Your brand";
  const product = sponsor?.software && sponsor.role
    ? `${B} is the ${sponsor.role} every guest uses in the hands-on hour, with a starter account set up in the room`
    : "your product in guests' hands during the hands-on hour, where it fits";
  const out: BrandLevel[] = [
    { key: "PARTNER", label: "Partner", priceUsd: TLC_TIERS.PARTNER.priceUsd, head: "", marked: null,
      adds: ["named on the invitation and on the day", product, "photographs for your channels", "opt-in leads", "a recap with the numbers"] },
    { key: "LEAD", label: "Lead partner", priceUsd: TLC_TIERS.LEAD.priceUsd, head: "Everything in Partner, plus:",
      // A sheet made for one brand carries no "most brands like <Brand>" line (Scooter, 6 Nov 2026: it "reads like AI
      // produced a proposal"; when their notes conflict Scooter's wins, her ruling 7 Nov 2026). The club's generic
      // sheet, which she approved word for word, keeps its line.
      marked: sponsor ? null : "Most brands would benefit most from this",
      adds: ["the hands-on segment built around your product", "five minutes to the room", "first placement among partners"] },
    { key: "PRESENTING", label: "Presenting partner", priceUsd: TLC_TIERS.PRESENTING.priceUsd, head: "Everything in Lead, plus:", marked: null,
      adds: [`"Presented by ${B}" on the invitation, signage and recap`] },
  ];
  if (sponsor && (sponsor.largeBrand || sponsor.askedToOwnRoom)) {
    out.push({ key: "TITLE", label: "Title partner", priceUsd: TLC_TIERS.TITLE.priceUsd, head: "Everything in Presenting, plus:", marked: null,
      adds: [`the whole room is yours: "The Learning Club: ${topic}, with ${B}"`, "the only cash partner that night", "first say on the format"] });
  }
  if (sponsor?.physicalProduct) {
    out.push({ key: "PRODUCT", label: "Product partner", priceUsd: null, head: "In kind, instead of cash:", marked: null,
      adds: ["your product in guests' hands during the hands-on hour", "named on the invitation"] });
  }
  return out;
}

/** "Partner · $5,000 per event" / "Product partner · in kind". */
/** "$5,000 per event" / "in kind". */
export const priceWords = (l: Pick<BrandLevel, "priceUsd">): string => (l.priceUsd ? `${usd(l.priceUsd)} per event` : "in kind");
export const levelPriceWords = (l: Pick<BrandLevel, "label" | "priceUsd">): string => `${l.label} · ${priceWords(l)}`;
export const SERIES_PRICE_WORDS = "A series of six: the same per-event price for each club, as a founding partner.";

/**
 * Words no brand-facing copy may carry (owner, 4 Nov 2026): no charge to guests, no venue or "your space", no implied
 * track record (the first club is in 2027, said in the future tense), and never a flat "we have never hosted".
 */
export const BRAND_COPY_FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/\$10\b(?![,\d])/, "a ticket price"],
  [/paid ticket|paid for|seats? sold|ticket price|each paid|\bpaid seat/i, "charging guests"],
  [/\bvenue\b|your (?:office|space)|sponsor'?s office|\bhost it at\b/i, "a venue or their space"],
  [/most brands choose|brands usually|our last club|past partners|guests who signed up|a few brands partner on each club|several brands partner on each club/i, "an implied track record"],
  [/never hosted|our first ever|first-ever/i, "saying it has not run"],
  [/\bwhy now\b/i, "the why-now section"],
];

/** The forbidden words a brand-facing render carries (style and cited sources aside). [] when clean. */
export function brandCopyProblems(text: string): string[] {
  const body = text.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");
  return [...new Set(BRAND_COPY_FORBIDDEN.filter(([r]) => r.test(body)).map(([, w]) => w))];
}

/**
 * THE PARTNER-LEVELS SHEET, RENDERED FOR ONE SPONSOR (owner, 4 Nov 2026; the approved pattern). Titled "<topic>, with
 * <Brand>"; why this room works for the brand; the levels that fit it, per event, lowest first; how to say yes; a
 * one-line About; her sign-off. Without a sponsor it is the club's generic sheet (the public page and the send-gate
 * hash): no Title, no in-kind. Never another brand's name, a why-now, a ticket price or a fixed weekday.
 */
/**
 * THE SHEET'S DESIGN, NAMED (owner, 6 Nov 2026). Every partner-levels PDF made is stamped with it; a proposal still
 * waiting for approval whose PDF carries an older stamp is made again on the current design before anyone approves
 * it (services/tlcBrandReply.ts refreshStaleSheets). Change it whenever the sheet's look changes.
 */
export const SHEET_VERSION = "2026-11-06 West Peek brand";
/** What she is told changed when a waiting proposal comes back with the sheet made again. */
export const SHEET_CHANGE_WORDS = "The attached partner-levels sheet is rebuilt in West Peek's branding and type (the logo, Maax, the brand colours, a clear price table). The words in the sheet are unchanged.";

/** The confidentiality line on a sheet made for one brand (brand-pitch skill: every sponsor PDF carries one). */
export const confidentialFor = (brand: string): string => `Prepared for ${brand}. Confidential, for your team only.`;

/** The series line under the title: one evening, four quarterly hackathons or six monthly happy hours. */
export function seriesLede(s: SeriesPricing, brand: string): string {
  const parts = [s.quarterly ? `${s.quarterly.evenings.length} quarterly hackathons` : "", s.monthly ? `a monthly series of ${s.monthly.evenings.length} happy hours` : ""].filter(Boolean);
  return `One evening, or a series in ${s.year}: ${parts.join(" or ")}, with ${brand} in every room. Each series costs less per event.`;
}

/** The price table (per event, for 1, 4 and 6 evenings) and the named evenings of each series. HTML, the sheet's own classes. */
export function seriesSheetHtml(s: SeriesPricing, levels: ReadonlyArray<{ key: string; label: string }>): string {
  const shown = SERIES_LEVELS.filter((l) => levels.some((x) => x.key === l));
  const label = (k: string) => levels.find((x) => x.key === k)?.label ?? k;
  const block = (b: SeriesPricing["quarterly"]) => (b ? `<section class="box series"><h2>${esc(b.name)}</h2><p>${esc(b.style)}</p><ol>${b.evenings.map((e) => `<li><b>${esc(e.when)}</b> · ${esc(e.title)}</li>`).join("")}</ol></section>` : "");
  return `<h2>Series prices, per event</h2>
<table class="series-prices"><thead><tr><th>Per event</th>${SERIES_COUNTS.map((n) => `<th>${n === 1 ? "One evening" : n === 4 ? "4 quarterly" : "6 monthly"}</th>`).join("")}</tr></thead>
<tbody>${shown.map((l) => `<tr><td>${esc(label(l))}</td>${SERIES_COUNTS.map((n) => `<td>${seriesUsd(s.prices[l][n])}</td>`).join("")}</tr>`).join("")}</tbody></table>
<div class="two">${block(s.quarterly)}${block(s.monthly)}</div>`;
}

export function renderBrandPitch(v: TlcClubView, sponsor: TlcSponsorView | null = null): string {
  const B = sponsor?.brand ?? null;
  const hook = sentences(brandSafe(v.angle)).slice(0, 2).join(" ");
  const takeHome = brandSafe(v.takeHome);
  const safety = safetyLines(v.topic, `${v.angle ?? ""} ${v.handsOn ?? ""} ${v.aiSegment ?? ""}`);
  const levels = brandLevels(sponsor, v.topic);
  const hasTitle = levels.some((l) => l.key === "TITLE");
  const why = [
    B ? (sponsor!.software ? `Every guest will build on ${B} in the hands-on hour.` : `Every guest will have ${B} in hand during the hands-on hour, where it fits the topic.`) : "Every guest will work hands-on with your product in the hands-on hour, where it fits the topic.",
    ...(B && sponsor!.newestProduct ? [`The build will show ${sponsor!.newestProduct}.`] : []),
    "Nothing to staff: we host every segment, and you send someone only if you want to.",
    `A room that chose this topic: every guest will be there for ${v.topic}.`,
  ];
  const seriesP = B ? sponsor?.seriesPricing ?? null : null;
  const quarterly = !seriesP && sponsor?.quarterly && B ? quarterlyWords(sponsor.quarterly, B) : null;
  const series = seriesP ? `<p class="lede">${esc(seriesLede(seriesP, B!))}</p>` : quarterly ? `<p class="lede">${esc(quarterly)}</p>` : sponsor?.series
    ? `<p class="lede">A series of six rooms, one a month for six months, with ${esc(B!)} in every room. A single evening is the option.</p>`
    : "";
  return page(
    B ? `${v.topic}, with ${B}` : `The Learning Club: ${v.topic}`,
    `${mast("West Peek Rooms · The Learning Club")}
<h1>${esc(B ? `${v.topic}, with ${B}` : v.topic)}</h1>
${hook ? `<p class="lede">${esc(hook)}</p>` : ""}
${series}
<p class="when">${esc(monthWords(v.month))} (date flexible) · New York City · ${BRAND_GUESTS_WORDS}</p>
<div class="two"><div>
<h2>Why this room works for ${esc(B ?? "your brand")}</h2>
<ul>${why.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>
</div><div>
<h2>Who will be in the room</h2>
<ul><li>Rooms of ${BRAND_ROOM_WORDS} New Yorkers per event, sized to your goals, who will choose this topic.</li>
<li>Founders, operators, creatives and builders, curated from a community of ${BRAND_COMMUNITY_SHORT}.</li>
<li>Taught by someone who does this for a living. The session will run: arrive, learn, an hour hands-on, a real meal, go deeper, share, close.</li>
${v.aiSegment ? `<li>The AI segment: ${esc(brandSafe(v.aiSegment))}</li>` : ""}
${takeHome ? `<li>They will leave with: ${esc(takeHome)}</li>` : ""}</ul>
</div></div>
${safety.length ? `<p class="note">${safety.map(esc).join(" ")}</p>` : ""}
<h2>Partner levels, per event</h2>
<div class="tiers">${levels.map((l) => `<div class="tier" data-level="${l.key}"><b><span class="name">${esc(l.label)}</span><span class="dot"> · </span><span class="price">${esc(priceWords(l))}</span></b>${l.marked ? `<em class="mark">${esc(l.marked)}</em>` : ""}<span class="adds">${l.head ? `${esc(l.head)} ` : ""}${esc(l.adds.join("; "))}.</span></div>`).join("")}</div>
${seriesP ? seriesSheetHtml(seriesP, levels) : `<p>${esc(quarterly ?? SERIES_PRICE_WORDS)}</p>`}
<p>${hasTitle ? "Except with a Title partner, a few brands can partner on each club." : "A few brands can partner on each club."}</p>
<div class="two"><div class="yes">
<h2>To say yes</h2>
<ol><li>${seriesP ? "Reply with the level, and whether it's one evening, four or six." : "Reply with the level."}</li><li>We send a one-page agreement and an invoice; payment is due within 14 days.</li><li>Then we set the date with you and shape the guest list around your audience.</li></ol>
</div><section class="box"><h2>About West Peek</h2><p>${esc(TLC_ABOUT_COMMUNITY)}</p></section></div>
<footer><span><strong>${esc(TLC_OWNER.name)}</strong> · ${esc(TLC_OWNER.firm)} · <a href="mailto:${TLC_OWNER.email}">${TLC_OWNER.email}</a></span>${B ? `<p class="conf">${esc(confidentialFor(B))}</p>` : ""}</footer>`,
  );
}

/** The risks Sequoia should see before saying yes to a month. */
export function clubRisks(v: TlcInternalView): string[] {
  const out = [...safetyLines(v.topic, `${v.angle ?? ""} ${v.handsOn ?? ""} ${v.aiSegment ?? ""}`)];
  const raw = `${v.angle ?? ""} ${v.whyNow ?? ""}`;
  if (/dry january/i.test(raw)) out.push('"Dry January" is a possible trademark: the brand pitch never uses it as our words.');
  if (/proposed date/i.test(v.angle ?? "")) out.push(`The packet proposed a different date; the club is set for ${clubWhen(v.eventDate, v.slot)}.`);
  if (/running on their own|working automations|guarantee/i.test(`${v.angle ?? ""} ${v.takeHome ?? ""}`)) out.push("The packet promised a set result; the brand pitch leaves that out.");
  for (const c of competingCategories(v.categories)) out.push(`Sponsors must not compete: ${c}.`);
  for (const p of sponsorMixProblems(v.month, v.categories)) out.push(`Sponsor rule: ${p}.`);
  for (const p of aiRuleProblems(v.topic, { ai_segment: v.aiSegment }, v.categories)) out.push(`AI rule: ${p}.`);
  if (v.committedPartners === 0) out.push("No brand has agreed yet.");
  return out;
}

/** THE INTERNAL ONE-PAGER, for Sequoia. Never sent to a brand. */
export function renderInternalOnePager(v: TlcInternalView): string {
  const origin = v.origin && isIdeaOrigin(v.origin) ? TLC_IDEA_ORIGIN_LABEL[v.origin] : v.origin ?? "not recorded";
  const goal = v.goalUsd ?? 25_000;
  const budget = v.costBudgetUsd ?? goal - TLC_NET_TARGET_USD;
  const pct = Math.min(100, Math.round((v.committedUsd / goal) * 100));
  const seats = v.seats ?? TLC_SEATS;
  const rows = v.categories
    .map((c) => `<tr><td><strong>${esc(internalSafe(c.category) || c.category)}</strong>${c.tier ? `<br><span class="muted">${esc(TLC_TIERS[c.tier].label)}</span>` : ""}${c.bench ? `<br><span class="muted">Bench: only if the lead agrees</span>` : ""}</td><td>${esc(internalSafe(c.why))}${c.featured ? ` Featured: ${esc(c.featured)}.` : ""}${c.excluded_brands?.length ? ` Never approach: ${esc(c.excluded_brands.join(", "))}.` : ""}</td><td>${esc(c.example_brands.join(", "))}</td></tr>`)
    .join("");
  const decide = [
    v.vetoUntil ? `Keep or swap this topic. It goes ahead on ${v.vetoUntil.slice(0, 10)} unless you say no.` : "Keep or swap this topic.",
    "Approve the brand pitch (on the Rooms page). Brands see nothing until you do.",
    "Approve the playbook and turn brand sending on, when you are ready.",
    "Say yes, no or counter to each brand that comes back.",
  ];
  return page(
    `Internal: ${v.topic}`,
    `${mast("Internal one-pager · for Sequoia · not for brands")}
<h1>${esc(v.topic)}</h1>
<p class="when">${esc(clubWhen(v.eventDate, v.slot))} · New York City · where the idea came from: ${esc(origin)}${v.decidedBy ? ` · ${esc(v.decidedBy)}` : ""}</p>
<p class="lede">${esc(internalSafe(v.angle))}</p>
<h2>Why now</h2>
<p>${esc(internalSafe(v.whyNow))}</p>
${sourcesList(v.sources)}
${v.aiSegment ? `<p><strong>AI segment:</strong> ${esc(v.aiSegment)}</p>` : ""}
${v.categories.some((c) => c.ai_partner) ? `<p><strong>AI partner:</strong> ${v.categories.filter((c) => c.ai_partner).map((c) => `${esc(c.category)}${c.example_brands.length ? ` (targets: ${esc(c.example_brands.join(", then "))})` : ""}`).join("; ")}. Cash at any tier, or in kind (credits, an expert); in kind never counts toward the goal. One frontier-model company per club: first yes is seated.</p>` : ""}
<h2>The economics</h2>
<ul><li>Goal: ${usd(goal)} raised from sponsors; costs up to ${usd(budget)} (venue, food, decor, materials); ${usd(TLC_NET_TARGET_USD)} net. Under ${usd(TLC_NET_FLOOR_USD)} net at a go-check escalates to you.${goal === 25_000 ? ` ${esc(TLC_TARGET_PATH)}` : ""}</li>
<li>Tiers: ${TLC_TIER_KEYS.map((t) => `${esc(TLC_TIERS[t].label)}${TLC_TIERS[t].priceUsd ? ` ${usd(TLC_TIERS[t].priceUsd!)}` : ""}`).join("; ")}. Custom amounts are fine; neither size nor count is capped. No category exclusivity.</li>
<li>Agreed so far: ${usd(v.committedUsd)} of ${usd(goal)} (${pct}%) · ${v.committedPartners} partner${v.committedPartners === 1 ? "" : "s"}.</li>
${v.inKind?.length ? `<li>In kind (cost relief, not counted toward the goal): ${v.inKind.map((x) => `${esc(x.brand)}${x.what ? ` (${esc(x.what)})` : ""}`).join("; ")}.</li>` : ""}
<li>Room: planned for ${seatsWords(seats)} people. Tickets $${TLC_TICKET_PRICE_USD} each; they add to the net, the goal never depends on them.</li>
<li>${esc(seasonOption())}</li></ul>
<h2>Sponsor categories</h2>
<table><thead><tr><th>Category</th><th>Why it fits</th><th>Example brands</th></tr></thead><tbody>${rows}</tbody></table>
<div class="two"><div><h2>Risks</h2>
<ul>${clubRisks(v).map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>
<div><h2>What you decide</h2>
<ol>${decide.map((d) => `<li>${esc(d)}</li>`).join("")}</ol></div></div>
${v.backup ? `<section class="box" data-backup><h2>Backup topic, switch on ${esc(v.backup.deadline.slice(0, 10))}</h2><p><strong>${esc(v.backup.topic)}.</strong> ${esc(internalSafe(v.backup.angle))} If fewer than 2 cash sponsors and no Title partner have said yes by ${esc(v.backup.deadline.slice(0, 10))}, the month switches to it automatically and you are told. Wynn sells ${esc(v.topic)} first.</p></section>` : ""}
<section class="box"><h2>About West Peek Ventures</h2><p>${esc(TLC_ABOUT_WEST_PEEK)}</p></section>
<footer>${v.pitchUrl ? `The brand pitch for this month: <a href="${esc(v.pitchUrl)}">${esc(v.pitchUrl)}</a>` : "The brand pitch is attached beside this page."}</footer>`,
  );
}

/** What a brand must never read in the pitch (outside the cited source titles). [] when clean. */
export function brandPitchProblems(html: string): string[] {
  const body = html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<ol class="src">[\s\S]*?<\/ol>/g, "");
  const out: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/dry january/i, '"Dry January"'],
    [/exclusiv/i, "an exclusivity claim"],
    [/to itself/i, "an exclusivity claim"],
    [/\$100M|secondary transactions|Higgsfield|Databricks|\bStripe\b|Fund I\b/i, "an internal-only fact"],
    [/\b(Parker|Wynn)\b|\bwc_[0-9a-z]|\bwork card\b|\bon the card\b/i, "an internal name"],
    [/\((?:lead|supporting|donated)/i, "an internal label"],
    [/proposed date/i, "a stale proposed date"],
    [/running on their own|working automations/i, "a promised result"],
    [/—/, "an em dash"],
    // Owner, 22 Oct 2026: playful and honest about other brands' customers, never mocking; never "cult".
    [/\bcult\b/i, "\"cult\" language"],
  ];
  for (const [r, what] of checks) if (r.test(body)) out.push(what);
  if (!/\$5,000/.test(body) || !/\$10,000/.test(body) || !/\$15,000/.test(body)) out.push("no price");
  // The $25,000 the brand reads is the Title partner's price, never our goal; our costs never show.
  if (/\bgoal\b|to raise|our costs|cost budget|\bnet\b|\$15,000 (in )?costs/i.test(body)) out.push("our goal or costs");
  if (/\bseason\b/i.test(body)) out.push("a season offer (internal only)");
  if (!body.includes(TLC_OWNER.email)) out.push("no contact");
  const plain = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  if ([...plain.matchAll(/\$\d[\d,]*/g)].some((m) => !plain.slice(m.index! + m[0].length).startsWith(" per event"))) out.push('a price without "per event"');
  out.push(...brandCopyProblems(body));
  return [...new Set(out)];
}
