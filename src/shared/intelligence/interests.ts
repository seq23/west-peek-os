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

/**
 * THE LENS: which way a partner reads the same brief.
 *
 * Audit, 15 Sep 2026. Both partners are written by ONE template, ONE required-section list and ONE
 * verifier — the code has never had a partner-specific branch. What differed on the page that day
 * was the prompt version (Scooter's was built by the old pipeline hours before the staged one
 * shipped), not the standard. The only intended difference between the two briefs is emphasis:
 * Scooter reads marketing, growth, brand, the creator economy, community, events and go-to-market;
 * Sequoia reads markets, venture and private markets, secondaries, legal and AI. Both get the macro
 * dashboard, the Top 5 and the West Peek read-throughs, in the same sections, in the same order.
 *
 * A lens is a NAMED PRESET, stored on the profile (`partner_intelligence_profile.lens`) so it is
 * data a partner can change rather than a name hard-coded against a person. It decides which
 * stories lead and which angle "why it matters" takes — never what is true and never which
 * sections exist. The partner's own sectors and themes sit on top of it as before.
 */
export type LensKey = "investing" | "growth";

export interface Lens {
  key: LensKey;
  /** Reads on the report header: "Edition: Scooter — marketing & growth lens". */
  label: string;
  /** What leads under this lens, in the order it is said to the model. */
  categories: readonly string[];
}

export const LENSES: Readonly<Record<LensKey, Lens>> = {
  investing: {
    key: "investing",
    label: "markets & private-markets lens",
    categories: ["markets", "VC and private markets", "secondaries", "legal and the courts", "AI"],
  },
  growth: {
    key: "growth",
    label: "marketing & growth lens",
    categories: ["marketing", "growth", "brand", "creator economy", "community", "events", "go-to-market"],
  },
} as const;

/** The default when a profile says nothing: the fund's own lens. */
export const DEFAULT_LENS: LensKey = "investing";

export function isLensKey(value: unknown): value is LensKey {
  return value === "investing" || value === "growth";
}

/** The lens a stored value names; an unknown or missing value is the default, never a throw. */
export function lensFor(key: string | null | undefined): Lens {
  return LENSES[isLensKey(key) ? key : DEFAULT_LENS];
}

/** The header line every report carries, written by the system rather than the model. */
export function editionLine(partnerName: string, lens: Lens): string {
  const first = partnerName.trim().split(/\s+/)[0] || "Partner";
  return `Edition: ${first} — ${lens.label}`;
}
