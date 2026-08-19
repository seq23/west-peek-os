/**
 * What a briefing covers: the firm's floor, and each partner's own additions.
 *
 * WHY TWO LAYERS. Two partners were receiving identical briefings, because the only interests the
 * system held were firm-level and therefore the same for everyone. But a fund's partners do not
 * read the same news: one is underwriting deals and watching rates, the other is thinking about
 * how attention gets bought and held. A single shared list cannot express that.
 *
 * The firm layer is a FLOOR, not a default to be overridden. Portfolio, pipeline and the macro
 * conditions the fund invests into matter to every partner whether or not they remember to ask for
 * them, so they are not removable — a partner who deletes "venture" from their interests should
 * still hear that a portfolio company is in trouble. What a partner adds is genuinely theirs, and
 * comes off again the moment they stop caring.
 */

/** Interests every partner's brief carries, whatever else they add. Not removable. */
export const FIRM_INTERESTS = {
  sectors: ["venture capital", "artificial intelligence", "private markets", "secondaries"],
  themes: [
    "cost of capital and what it does to early-stage pricing",
    "AI infrastructure financing",
    "LP sentiment and fundraising conditions",
    "exit windows and IPO reopening",
  ],
} as const;

/** A partner's own additions, on top of the firm floor. */
export interface PartnerInterests {
  sectors: string[];
  themes: string[];
  companies: string[];
}

export const EMPTY_INTERESTS: PartnerInterests = { sectors: [], themes: [], companies: [] };

/**
 * Suggestions offered in the interface, so adding one is a click rather than a blank box.
 *
 * Grouped by the job somebody does rather than by topic, because that is how a partner knows which
 * ones are theirs — Scooter reads the marketing column and recognises his work in it.
 */
export const INTEREST_SUGGESTIONS: ReadonlyArray<{ group: string; items: readonly string[] }> = [
  {
    group: "Marketing and brand",
    items: [
      "brand strategy",
      "advertising and media buying",
      "creative direction and design",
      "content and social platforms",
      "performance marketing and attribution",
      "how attention is bought, held and measured",
    ],
  },
  {
    group: "Investing",
    items: ["seed and pre-seed pricing", "down rounds and structure", "emerging manager fundraising", "carve-outs and corporate M&A"],
  },
  {
    group: "Technology",
    items: ["developer tools", "consumer AI products", "semiconductors and compute", "security and privacy regulation"],
  },
  {
    group: "Macro",
    items: ["rates and inflation", "energy prices", "labour market", "China and export controls"],
  },
] as const;

/** Normalise one interest for storage and comparison: trimmed, lowercased, collapsed whitespace. */
export function normaliseInterest(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Is this interest already carried by the firm floor? Adding it again would be a no-op. */
export function isFirmInterest(kind: "sectors" | "themes", value: string): boolean {
  const list: readonly string[] = kind === "sectors" ? FIRM_INTERESTS.sectors : FIRM_INTERESTS.themes;
  return list.some((f) => normaliseInterest(f) === normaliseInterest(value));
}

/**
 * The list a brief is actually written against: the firm floor plus this partner's additions,
 * de-duplicated, firm entries first so they read as the baseline they are.
 */
export function effectiveInterests(partner: PartnerInterests): { sectors: string[]; themes: string[] } {
  const merge = (firm: readonly string[], own: readonly string[]): string[] => {
    const seen = new Set(firm.map(normaliseInterest));
    return [...firm, ...own.filter((o) => !seen.has(normaliseInterest(o)))];
  };
  return {
    sectors: merge(FIRM_INTERESTS.sectors, partner.sectors),
    themes: merge(FIRM_INTERESTS.themes, partner.themes),
  };
}
