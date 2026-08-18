/**
 * The Daily Intelligence funnel: normalise → dedupe → classify → rank (P41).
 *
 * PURE FUNCTIONS, NO I/O. Everything here is deterministic and testable without a database, a
 * model, or a network. That is the point of the operator's brief: "Do not let one enormous LLM call
 * perform every stage if separate deterministic or smaller-model stages would make the system more
 * reliable." Ranking that a model performs is ranking nobody can debug at 6:45am when the report
 * looks wrong.
 *
 * The model's job is SYNTHESIS — the paragraph that connects three stories. Deciding which twenty
 * of four hundred items reach it is arithmetic, and arithmetic belongs here.
 */

export type SourceType = "news" | "filing" | "market_data" | "government" | "earnings" | "funding" | "internal" | "other";

export const EVENT_CATEGORIES = [
  "GENERAL_MARKETS", "MACRO", "FED_MONETARY_POLICY", "AI_TECHNOLOGY", "VENTURE_CAPITAL",
  "FUNDING", "M_AND_A", "IPO", "PUBLIC_MARKETS", "PRIVATE_MARKETS", "SECONDARIES",
  "PRIVATE_CREDIT", "REGULATION", "SUPREME_COURT", "LEGAL", "GEOPOLITICS", "ENERGY",
  "PORTFOLIO_COMPANY", "PIPELINE_COMPANY", "FUNDRAISING_LP", "SECTOR_THESIS",
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export interface NormalisedItem {
  id: string;
  sourceType: SourceType;
  title: string;
  summary?: string | null;
  url?: string | null;
  publisher?: string | null;
  publishedAt?: string | null;
  /** Free-text entities the item mentions — companies, people, agencies. */
  entities: string[];
  categories: EventCategory[];
  /** 0–1. How much a source is trusted on its own account. */
  sourceAuthority: number;
}

export interface PartnerLens {
  sectors: string[];
  companies: string[];
  themes: string[];
  /** 0–3 per category family; absent means 1 (normal). */
  depth: Record<string, number>;
}

export interface RankedItem extends NormalisedItem {
  score: number;
  /** Every component, so a partner can be told WHY something ranked. */
  reasons: string[];
  duplicateOf?: string;
  supportingUrls: string[];
}

/** Authority by source type. Primary sources outrank commentary about them. */
export const SOURCE_AUTHORITY: Readonly<Record<SourceType, number>> = {
  filing: 1.0,
  government: 1.0,
  earnings: 0.9,
  internal: 0.9,
  market_data: 0.8,
  funding: 0.7,
  news: 0.5,
  other: 0.3,
};

/**
 * Crude suffix stemming.
 *
 * Exists because two outlets describing one event pick different forms of the same verb:
 * "Nvidia announces ACQUISITION of Foo" and "Nvidia to ACQUIRE Foo" share only three tokens out of
 * six, which scores 0.5 and slips under any sane dedupe threshold. Loosening the threshold instead
 * would start merging genuinely different stories, which loses events silently — so the fix
 * belongs here, at the cause.
 *
 * Deliberately not a real stemmer: no dependency, and over-aggressive stemming creates false
 * merges, which is the failure mode that actually costs something.
 */
export function stem(word: string): string {
  return word
    .replace(/(isition|isitions)$/, "ire")   // acquisition → acquire
    .replace(/(ings|ing)$/, "")
    .replace(/(ed|es|s)$/, "")
    .replace(/(ment|ments)$/, "");
}

/**
 * Normalise a headline for comparison: lowercase, strip punctuation, drop the filler words that
 * differ between outlets, stem what remains, and sort so word order stops mattering.
 */
export function titleKey(title: string): string {
  const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "and", "as", "at", "by", "with", "is", "its", "said", "says", "after", "amid"]);
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map(stem)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/** Jaccard overlap of two token sets — 1.0 identical, 0 disjoint. */
export function similarity(a: string, b: string): number {
  const sa = new Set(a.split(" ").filter(Boolean));
  const sb = new Set(b.split(" ").filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared += 1;
  return shared / (sa.size + sb.size - shared);
}

export interface DedupeResult {
  events: NormalisedItem[];
  /** Extra URLs that corroborate each surviving event, keyed by its id. */
  supporting: Record<string, string[]>;
  duplicatesRemoved: number;
}

/**
 * Collapse the same event reported by many outlets into one, keeping the others as corroboration.
 *
 * THE PRIMARY-SOURCE RULE. When Reuters, CNBC, a press release and an SEC filing all describe one
 * acquisition, the FILING survives and the rest become supporting URLs — not whichever arrived
 * first. A report that cites CNBC when the filing was available is a report that got the fact
 * second-hand for no reason.
 *
 * Threshold is deliberately conservative (0.62): merging two genuinely different stories is far
 * worse than showing a near-duplicate, because the merged one silently loses an event.
 */
export function dedupe(items: readonly NormalisedItem[], threshold = 0.62): DedupeResult {
  const kept: NormalisedItem[] = [];
  const supporting: Record<string, string[]> = {};
  let removed = 0;

  // Highest authority first, so the survivor of any pair is the better source.
  const ordered = [...items].sort((a, b) => b.sourceAuthority - a.sourceAuthority);

  for (const item of ordered) {
    const key = titleKey(item.title);
    const canonicalUrl = (item.url ?? "").split("?")[0];

    const match = kept.find((k) => {
      if (canonicalUrl && (k.url ?? "").split("?")[0] === canonicalUrl) return true;
      return similarity(titleKey(k.title), key) >= threshold;
    });

    if (match) {
      removed += 1;
      if (item.url) {
        supporting[match.id] = [...(supporting[match.id] ?? []), item.url];
      }
      continue;
    }
    kept.push(item);
    supporting[item.id] = supporting[item.id] ?? [];
  }

  return { events: kept, supporting, duplicatesRemoved: removed };
}

/** Deterministic category rules. Obvious cases should never cost a model call. */
const CATEGORY_RULES: ReadonlyArray<{ pattern: RegExp; category: EventCategory }> = [
  { pattern: /\b(federal reserve|fomc|rate cut|rate hike|interest rates?)\b/i, category: "FED_MONETARY_POLICY" },
  { pattern: /\b(inflation|cpi|ppi|unemployment|payrolls|gdp)\b/i, category: "MACRO" },
  { pattern: /\b(artificial intelligence|\bai\b|llm|foundation model|inference|gpu)\b/i, category: "AI_TECHNOLOGY" },
  { pattern: /\b(seed|series [a-e]\b|raises?|raised|funding round|venture)\b/i, category: "FUNDING" },
  { pattern: /\b(acquires?|acquisition|merger|takeover|buyout)\b/i, category: "M_AND_A" },
  { pattern: /\b(ipo|public offering|s-1|direct listing)\b/i, category: "IPO" },
  { pattern: /\b(secondary|secondaries|tender offer|continuation (fund|vehicle))\b/i, category: "SECONDARIES" },
  { pattern: /\b(private credit|direct lending|nav loan)\b/i, category: "PRIVATE_CREDIT" },
  { pattern: /\b(sec|regulator|regulation|antitrust|ftc|doj)\b/i, category: "REGULATION" },
  { pattern: /\bsupreme court\b/i, category: "SUPREME_COURT" },
  { pattern: /\b(sanction|tariff|export controls?|geopolit)/i, category: "GEOPOLITICS" },
  { pattern: /\b(oil|crude|opec|natural gas|energy prices?)\b/i, category: "ENERGY" },
  { pattern: /\b(limited partners?|\blps?\b|fundrais)/i, category: "FUNDRAISING_LP" },
];

/** Categories for an item. Multiple allowed; falls back to GENERAL_MARKETS rather than nothing. */
export function classify(item: Pick<NormalisedItem, "title" | "summary">): EventCategory[] {
  const text = `${item.title} ${item.summary ?? ""}`;
  const hits = CATEGORY_RULES.filter((r) => r.pattern.test(text)).map((r) => r.category);
  return hits.length > 0 ? Array.from(new Set(hits)) : ["GENERAL_MARKETS"];
}

/** Which depth dial governs a category. */
const DEPTH_FAMILY: Readonly<Partial<Record<EventCategory, string>>> = {
  MACRO: "macro", FED_MONETARY_POLICY: "macro", GENERAL_MARKETS: "macro",
  AI_TECHNOLOGY: "technical",
  VENTURE_CAPITAL: "venture", FUNDING: "venture", PRIVATE_MARKETS: "venture",
  SECONDARIES: "secondaries", PRIVATE_CREDIT: "secondaries",
  PUBLIC_MARKETS: "publicMarkets", IPO: "publicMarkets", M_AND_A: "publicMarkets",
  REGULATION: "policy", SUPREME_COURT: "policy", LEGAL: "policy", GEOPOLITICS: "policy",
};

export interface RankInput {
  item: NormalisedItem;
  lens: PartnerLens;
  /** Firm-level interests: portfolio names, watchlist, active pipeline. */
  firmEntities: readonly string[];
  now: Date;
}

/**
 * Score one item for one partner.
 *
 * Every component is named in `reasons`, because the operator has to be able to ask "why is this
 * at the top" and get an answer. A single opaque number is the thing that makes people stop
 * trusting a ranked list.
 */
export function scoreItem({ item, lens, firmEntities, now }: RankInput): RankedItem {
  const reasons: string[] = [];
  let score = 0;

  score += item.sourceAuthority * 2;
  if (item.sourceAuthority >= 0.9) reasons.push("primary source");

  // Freshness: full marks under 24h, decaying to nothing at a week. Stale news in a MORNING report
  // is the clearest possible signal that nobody is reading it.
  if (item.publishedAt) {
    const ageHours = (now.getTime() - new Date(item.publishedAt).getTime()) / 3_600_000;
    if (ageHours <= 24) { score += 2; reasons.push("published in the last day"); }
    else if (ageHours <= 72) { score += 1; }
    else if (ageHours > 168) { score -= 1; reasons.push("over a week old"); }
  }

  const haystack = `${item.title} ${item.summary ?? ""} ${item.entities.join(" ")}`.toLowerCase();

  const firmHit = firmEntities.find((e) => e && haystack.includes(e.toLowerCase()));
  if (firmHit) { score += 4; reasons.push(`mentions ${firmHit}`); }

  const companyHit = lens.companies.find((c) => c && haystack.includes(c.toLowerCase()));
  if (companyHit) { score += 3; reasons.push(`a company you follow (${companyHit})`); }

  const sectorHit = lens.sectors.find((s) => s && haystack.includes(s.toLowerCase()));
  if (sectorHit) { score += 2; reasons.push(`your sector (${sectorHit})`); }

  const themeHit = lens.themes.find((t) => t && haystack.includes(t.toLowerCase()));
  if (themeHit) { score += 1.5; reasons.push(`your theme (${themeHit})`); }

  // Depth dials. 0 means "stop sending me this" and must be able to push an item out entirely,
  // otherwise the preference is decorative.
  const families = Array.from(new Set(item.categories.map((c) => DEPTH_FAMILY[c]).filter(Boolean) as string[]));
  for (const f of families) {
    const d = lens.depth[f];
    if (d === undefined) continue;
    if (d === 0) { score -= 4; reasons.push(`you turned ${f} off`); }
    else score += (d - 1) * 1.5;
  }

  // A headline with no body is a stub. It can still rank if it is about us, but it should not beat
  // a substantive story on freshness alone.
  if (!item.summary || item.summary.trim().length < 40) { score -= 1; reasons.push("thin on detail"); }

  return { ...item, score: Math.round(score * 100) / 100, reasons, supportingUrls: [] };
}

/**
 * Rank and cut to the candidates that reach synthesis.
 *
 * The brief asks for 20–50 candidates out of hundreds. The cut is a floor AND a cap: a quiet day
 * should produce a short report, not a padded one, so items below the floor are dropped even if
 * that leaves fewer than the cap.
 */
export function rank(inputs: readonly RankInput[], opts: { max?: number; floor?: number } = {}): RankedItem[] {
  const max = opts.max ?? 30;
  const floor = opts.floor ?? 1;
  return inputs
    .map(scoreItem)
    .filter((i) => i.score >= floor)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, max);
}

/** Idempotency key for one partner-day. A retry must never produce a second report. */
export function reportKey(firmUserId: string, reportDate: string): string {
  return `daily_intelligence:${firmUserId}:${reportDate}`;
}

/** The report date in a partner's own timezone — 6:45am in Chicago is not 6:45am in UTC. */
export function localReportDate(now: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    // An invalid timezone must not stop a partner's report; UTC is a defensible fallback and the
    // profile is visibly wrong rather than silently skipped.
    return now.toISOString().slice(0, 10);
  }
}

/** Weekday check in the partner's timezone, for the weekends-off default. */
export function isWeekend(now: Date, timezone: string): boolean {
  let day: string;
  try {
    day = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(now);
  } catch {
    day = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(now);
  }
  return day === "Sat" || day === "Sun";
}
