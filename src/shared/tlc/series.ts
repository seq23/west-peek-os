/**
 * SERIES PRICING, ONE BRAND AT A TIME (owner, 7 Nov 2026, the Pinecone Pricing Reply v2 she approved: "prices are per
 * event, cheaper per event for 4 and cheaper again for 6"). A per-brand setting (tlc_deal.series_json) the partners
 * set: the per-event price at each level for one evening, four (the quarterly hackathons) and six (the monthly
 * happy hours), and the named evenings of each series. PURE.
 *
 * Partner never goes below $5,000 (her 4 Nov rule: a room breaks even only with two or more cash sponsors), at any
 * count: a setting that tries is not read at all (`seriesOf` returns null and `seriesProblems` says why), so a sheet
 * can never show it.
 */
export const PARTNER_FLOOR_USD = 5000;
export const SERIES_COUNTS = [1, 4, 6] as const;
export type SeriesCount = (typeof SERIES_COUNTS)[number];
export type SeriesLevel = "PARTNER" | "LEAD" | "PRESENTING";
export const SERIES_LEVELS: readonly SeriesLevel[] = ["PARTNER", "LEAD", "PRESENTING"];

export interface SeriesBlock {
  /** "Quarterly hackathons" / "Monthly happy hours, a series of six". */
  name: string;
  /** How an evening of this series runs, in one line. */
  style: string;
  /** Each evening: when ("Q1 · March", "Month 1") and its title. */
  evenings: ReadonlyArray<{ when: string; title: string }>;
}
export interface SeriesPricing {
  year: number;
  prices: Record<SeriesLevel, Record<SeriesCount, number>>;
  quarterly: SeriesBlock | null;
  monthly: SeriesBlock | null;
}

const isPrice = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;

/** Why a series setting cannot be used, in words. [] when it can. */
export function seriesProblems(v: unknown): string[] {
  const out: string[] = [];
  if (!v || typeof v !== "object") return ["no series setting"];
  const s = v as Partial<SeriesPricing>;
  if (!isPrice(s.year)) out.push("no year");
  for (const level of SERIES_LEVELS) {
    const row = (s.prices as Record<string, Record<string, unknown>> | undefined)?.[level];
    for (const n of SERIES_COUNTS) {
      const p = row?.[String(n)];
      if (!isPrice(p)) { out.push(`no ${level.toLowerCase()} price for ${n}`); continue; }
      if (p < PARTNER_FLOOR_USD) out.push(`${level.toLowerCase()} at $${p.toLocaleString("en-US")} for ${n} is below $5,000`);
    }
  }
  for (const key of ["quarterly", "monthly"] as const) {
    const b = s[key];
    if (b == null) continue;
    const want = key === "quarterly" ? 4 : 6;
    if (!b.name || !b.style || !Array.isArray(b.evenings) || b.evenings.length !== want || b.evenings.some((e) => !e?.when || !e?.title)) out.push(`the ${key} series needs a name, a style and ${want} named evenings`);
  }
  return out;
}

/** The setting, read strictly: anything malformed or below the floor is no series at all. */
export function seriesOf(json: string | null | undefined): SeriesPricing | null {
  let v: unknown;
  try { v = JSON.parse(json ?? "null"); } catch { return null; }
  if (seriesProblems(v).length) return null;
  const s = v as SeriesPricing;
  const prices = Object.fromEntries(SERIES_LEVELS.map((l) => [l, Object.fromEntries(SERIES_COUNTS.map((n) => [n, Number((s.prices[l] as Record<string, number>)[String(n)])]))])) as SeriesPricing["prices"];
  return { year: s.year, prices, quarterly: s.quarterly ?? null, monthly: s.monthly ?? null };
}

export const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;

/** "$9,000 per event ($36,000; you save $4,000)": the per-event price, the total and the saving against one evening each. */
export function seriesPriceWords(s: SeriesPricing, level: SeriesLevel, n: SeriesCount): string {
  const each = s.prices[level][n];
  if (n === 1) return `${usd(each)} per event`;
  const save = s.prices[level][1] * n - each * n;
  return `${usd(each)} per event${save > 0 ? ` (${usd(each * n)}; you save ${usd(save)})` : ""}`;
}
