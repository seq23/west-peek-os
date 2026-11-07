/**
 * A BRAND REPLY AS A DOCUMENT (owner, 7 Nov 2026, the Pinecone Pricing Reply v2): its name, its readable page, and the
 * short sheet the email to the partners carries inline. PURE.
 */
import { SERIES_COUNTS, SERIES_LEVELS, usd, type SeriesPricing } from "./series";
import type { SheetMini } from "./wynnDraftEmail";

/** "Pinecone" → "pinecone"; "Liquid Death" → "liquid-death". The brand part of the reply page's address. */
export const brandSlug = (brand: string): string =>
  brand.replace(/\s*\([^()]*\)/g, "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "brand";

export const REPLY_PAGE_ORIGIN = "https://os.joinwestpeek.com";
/** The page behind "See the whole <Brand> story ›": readable, behind the firm's sign-in, never an /api/ address. */
export const replyPagePath = (brand: string): string => `/tlc/${brandSlug(brand)}/reply`;
export const replyPageUrl = (brand: string): string => `${REPLY_PAGE_ORIGIN}${replyPagePath(brand)}`;

/** What the document is called in the subject: a draft with prices is the "Pricing Reply". */
export function docNameFor(kind: string | null | undefined, pricing: boolean): string {
  if (kind === "CONFIRM") return "Agreement";
  if (kind === "PROPOSAL" || pricing) return "Pricing Reply";
  if (kind === "SAMPLES") return "Materials Reply";
  if (kind === "CALL") return "Call Reply";
  return "Reply";
}

/** A person as the email names them: "Aaron Kao (VP Marketing)", from the deal's people, the contact, or the address. */
export interface PersonInfo { name: string; role: string | null }
export function peopleOf(json: string | null | undefined): Record<string, PersonInfo> {
  try {
    const v = JSON.parse(json ?? "null") as Record<string, Partial<PersonInfo>> | null;
    if (!v || typeof v !== "object") return {};
    return Object.fromEntries(Object.entries(v).filter(([, p]) => p && typeof p.name === "string" && p.name.trim()).map(([a, p]) => [a.trim().toLowerCase(), { name: p.name!.trim(), role: p.role?.trim() || null }]));
  } catch { return {}; }
}
/** "Mike Sefanov (Sr. Director, Communications)" → { name: "Mike Sefanov", role: "Sr. Director, Communications" }. */
export function splitContactName(raw: string | null | undefined): PersonInfo | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(t);
  return m ? { name: m[1]!.trim(), role: m[2]!.trim() } : { name: t, role: null };
}

/**
 * The sheet as the email shows it: the title, one line of when and where, and the price table: per event for 1, 4 and 6
 * evenings when the brand has series prices, else one column of per-event prices.
 */
export function sheetMini(input: {
  brand: string; topic: string; year: string; roomWords: string;
  levels: ReadonlyArray<{ key: string; label: string; priceUsd: number | null }>;
  series: SeriesPricing | null;
}): SheetMini {
  const title = `${input.topic}, with ${input.brand}`;
  const line = `New York · ${input.year}, dates flexible · rooms of ${input.roomWords} per event`;
  const short = (label: string) => label.replace(/ partner$/i, "");
  if (input.series) {
    const s = input.series;
    const rows = SERIES_LEVELS.filter((l) => input.levels.some((x) => x.key === l)).map((l) => ({ label: short(input.levels.find((x) => x.key === l)!.label), cells: SERIES_COUNTS.map((n) => usd(s.prices[l][n])) }));
    const named = [s.quarterly ? `the ${s.quarterly.evenings.length} quarterly evenings` : "", s.monthly ? `the ${s.monthly.evenings.length} monthly ones` : ""].filter(Boolean).join(" and ");
    return { title, line, headers: ["Per event", "1", "4", "6"], rows, foot: named ? `The sheet also names ${named}. The full sheet is on the page.` : "The full sheet is on the page." };
  }
  return { title, line, headers: ["Level", "Per event"], rows: input.levels.map((l) => ({ label: l.label, cells: [l.priceUsd ? usd(l.priceUsd) : "in kind"] })), foot: "The full sheet is on the page." };
}
