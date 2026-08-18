/**
 * Market mapping — the parts that must be right regardless of where data came from (P46).
 *
 * Pure functions. The whole risk in a market map is a confident wrong number, so the merging,
 * formatting and grounding rules live here where they are testable, not scattered through a service
 * that also does I/O.
 */

export type FundingSource = "FIRM_RECORD" | "SWEPT_NEWS" | "SEC_FORM_D" | "WEB_SEARCH";

/** How much a source is trusted for a FUNDING FIGURE specifically. */
export const SOURCE_TRUST: Readonly<Record<FundingSource, number>> = {
  // A Form D is a filing with the regulator. Nothing beats it for "how much was raised".
  SEC_FORM_D: 1.0,
  // The firm's own books. Authoritative for our own positions, silent on everyone else.
  FIRM_RECORD: 0.95,
  // A funding announcement. Usually right, occasionally the founder's rounding.
  SWEPT_NEWS: 0.6,
  // A search result. Fine for discovering that a company exists; weak for its numbers.
  WEB_SEARCH: 0.4,
};

export interface CompanyFact {
  name: string;
  segment?: string | null;
  description?: string | null;
  stage?: string | null;
  total_raised_usd?: number | null;
  last_round_usd?: number | null;
  last_round_date?: string | null;
  valuation_usd?: number | null;
  investors?: string | null;
  website?: string | null;
  funding_source: FundingSource;
  source_url?: string | null;
  company_id?: string | null;
  is_ours?: boolean;
}

/** Company names differ cosmetically between sources; this is what they are compared on. */
export function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|plc|gmbh|sa|ab|oy|labs|technologies|technology|holdings|group)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Merge the same company seen by several sources into one row.
 *
 * FIELD BY FIELD, BY SOURCE TRUST — not whole-record. A Form D knows the raise and nothing about
 * what the company does; a news article has a good description and a shakier number. Taking the
 * higher-trust record wholesale would throw away the description; taking the first would take a
 * search result's guess over a regulatory filing.
 */
export function mergeCompanies(facts: readonly CompanyFact[]): CompanyFact[] {
  const byKey = new Map<string, { out: CompanyFact; trust: Partial<Record<keyof CompanyFact, number>> }>();

  for (const f of facts) {
    const key = companyKey(f.name);
    if (!key) continue;
    const t = SOURCE_TRUST[f.funding_source];
    const existing = byKey.get(key);

    if (!existing) {
      const trust: Partial<Record<keyof CompanyFact, number>> = {};
      for (const k of Object.keys(f) as Array<keyof CompanyFact>) {
        if (f[k] !== null && f[k] !== undefined && f[k] !== "") trust[k] = t;
      }
      byKey.set(key, { out: { ...f }, trust });
      continue;
    }

    for (const k of Object.keys(f) as Array<keyof CompanyFact>) {
      const v = f[k];
      if (v === null || v === undefined || v === "") continue;
      const held = existing.trust[k] ?? -1;
      if (t > held) {
        (existing.out as unknown as Record<string, unknown>)[k] = v;
        existing.trust[k] = t;
        // The provenance must follow the number it justifies. A row showing a Form D figure and a
        // news URL invites someone to check the wrong source.
        if (k === "total_raised_usd" || k === "last_round_usd" || k === "valuation_usd") {
          existing.out.funding_source = f.funding_source;
          existing.out.source_url = f.source_url ?? existing.out.source_url;
        }
      }
    }
    // Ours is sticky: one source knowing we hold it is enough.
    if (f.is_ours) existing.out.is_ours = true;
  }

  return Array.from(byKey.values()).map((v) => v.out);
}

/** Group into the panels of the map, largest segment first, unknowns last. */
export function bySegment(companies: readonly CompanyFact[]): Array<{ segment: string; companies: CompanyFact[] }> {
  const groups = new Map<string, CompanyFact[]>();
  for (const c of companies) {
    const seg = (c.segment ?? "").trim() || "Unsegmented";
    if (!groups.has(seg)) groups.set(seg, []);
    groups.get(seg)!.push(c);
  }
  return Array.from(groups.entries())
    .map(([segment, list]) => ({
      segment,
      // Biggest raise first inside a panel; unknowns at the bottom rather than treated as zero,
      // because "we do not know" is not "they raised nothing".
      companies: [...list].sort((a, b) => (b.total_raised_usd ?? -1) - (a.total_raised_usd ?? -1)),
    }))
    .sort((a, b) => {
      if (a.segment === "Unsegmented") return 1;
      if (b.segment === "Unsegmented") return -1;
      return b.companies.length - a.companies.length;
    });
}

/**
 * Money, at the precision a partner actually reads.
 *
 * Keeps one decimal below $100M, because the difference between an $18.5M round and a $19M round is
 * the kind of detail that gets repeated in a meeting — rounding it away is a small lie. Above
 * $100M the decimal stops carrying information and just adds noise. Trailing ".0" is dropped so a
 * clean $20M does not render as "$20.0M".
 */
export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const fmt = (n: number, suffix: string, decimals: number) => {
    const s = n.toFixed(decimals);
    return `$${s.endsWith(".0") ? s.slice(0, -2) : s}${suffix}`;
  };
  if (v >= 1_000_000_000) return fmt(v / 1_000_000_000, "B", v >= 100_000_000_000 ? 0 : 1);
  if (v >= 1_000_000) return fmt(v / 1_000_000, "M", v >= 100_000_000 ? 0 : 1);
  if (v >= 1_000) return `$${Math.round(v / 1_000)}k`;
  return `$${Math.round(v)}`;
}

/**
 * State what the map could not see.
 *
 * Always non-empty on a finished map. A map that lists twelve companies and says nothing about
 * coverage reads as "these are the twelve companies", which is a claim no free-source map can make.
 */
export function coverageNote(input: {
  companies: readonly CompanyFact[];
  sourcesUsed: readonly string[];
}): string {
  const total = input.companies.length;
  const noFunding = input.companies.filter((c) => c.total_raised_usd == null && c.last_round_usd == null).length;
  const noStage = input.companies.filter((c) => !c.stage).length;

  const parts = [`${total} compan${total === 1 ? "y" : "ies"} found from ${input.sourcesUsed.join(", ") || "no sources"}.`];
  if (noFunding > 0) parts.push(`${noFunding} with no funding figure on record.`);
  if (noStage > 0) parts.push(`${noStage} with no stage.`);
  parts.push(
    "Built from public and firm sources, so coverage is strongest for US companies that have filed " +
    "or been written about. Treat this as a working map, not a complete census of the sector.",
  );
  return parts.join(" ");
}

/** Drop anything with no name or no source. A row that cannot be traced does not belong on a map. */
export function groundCompanies(facts: readonly CompanyFact[]): { kept: CompanyFact[]; dropped: number } {
  const kept = facts.filter((f) => f.name?.trim() && f.funding_source);
  return { kept, dropped: facts.length - kept.length };
}
