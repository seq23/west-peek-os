import type { CompanyFact } from "../../shared/market/mapping";

/**
 * SEC EDGAR Form D — the free backbone of a market map (P46).
 *
 * WHY THIS SOURCE. Every US private company raising above a threshold must file a Form D with the
 * regulator. It is public, free, and it is a FILING rather than a press release — which is why it
 * outranks everything else for "how much was raised". A funding announcement is what a company
 * chose to say; a Form D is what it was required to state.
 *
 * WHAT IT DOES NOT GIVE YOU, stated plainly because a map that quietly lacks these reads as
 * complete: no valuation, no investor names, no non-US companies, and it misses rounds structured
 * to avoid the filing. Those gaps are why the mapper also reads swept news and the firm's own books
 * rather than treating EDGAR as the whole answer.
 *
 * SEC FAIR ACCESS: their policy requires a descriptive User-Agent with a contact address and asks
 * for no more than 10 requests/second. One request per map build is well inside that; the header is
 * sent because it is a condition of access, not a nicety.
 */

const EDGAR_FTS = "https://efts.sec.gov/LATEST/search-index";
const TIMEOUT_MS = 15_000;

/** SEC asks who is calling. A generic agent gets rate-limited or blocked. */
const USER_AGENT = "West Peek Ventures OS (ops@westpeek.ventures)";

/**
 * Entities that file a Form D but are NOT operating companies.
 *
 * Found by running the real query: searching "artificial intelligence" returns
 * "Brookfield Artificial Intelligence Infrastructure Fund-A, L.P." near the top. Form D is filed by
 * anyone raising private capital, funds very much included — so an unfiltered market map lists the
 * INVESTORS in a sector as if they were companies in it, which is precisely backwards.
 *
 * Deliberately conservative: it matches legal-entity suffixes and fund words, not any company whose
 * name happens to contain "capital". A false negative here shows one extra row; a false positive
 * silently deletes a real company from the map.
 */
const NON_OPERATING = /\b(fund|funds|l\.?p\.?|lllp|llp|partners|partnership|capital|ventures?|advisors?|management|holdings? (?:i{1,3}|\d+)|trust|scsp|sicav|feeder|spv)\b/i;

/** True when a Form D filer looks like an investment vehicle rather than an operating company. */
export function looksLikeFund(name: string): boolean {
  return NON_OPERATING.test(name);
}

export interface EdgarResult {
  ok: boolean;
  companies: CompanyFact[];
  detail: string;
}

/**
 * Parse the amount from a Form D hit.
 *
 * EDGAR full-text search returns the filing metadata, not the parsed XML, so an amount is only
 * available when it appears in the indexed text. Returning null when it does not is deliberate —
 * inferring a raise from a filing that did not state one would be inventing the single number this
 * whole source exists to be authoritative about.
 */
export function parseAmount(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(/\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion|m\b|bn?\b)?/i);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "").toLowerCase();
  if (unit.startsWith("b")) return n * 1_000_000_000;
  if (unit.startsWith("m")) return n * 1_000_000;
  return n;
}

/**
 * Search Form D filings for a sector term.
 *
 * `fetchImpl` is injected so tests drive parsing and failure handling without calling the SEC —
 * the same pattern feedClient and the Network OS client use.
 */
export async function searchFormD(
  sector: string,
  fetchImpl: typeof fetch = fetch,
  limit = 40,
): Promise<EdgarResult> {
  const term = sector.trim();
  if (!term) return { ok: false, companies: [], detail: "no sector given" };

  const url = `${EDGAR_FTS}?q=${encodeURIComponent(`"${term}"`)}&forms=D`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetchImpl(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, companies: [], detail: `SEC EDGAR returned HTTP ${res.status}.` };
    }

    const body = (await res.json()) as { hits?: { hits?: Array<{ _id?: string; _source?: Record<string, unknown> }> } };
    const hits = body.hits?.hits ?? [];

    const companies: CompanyFact[] = [];
    for (const h of hits.slice(0, limit)) {
      const src = (h._source ?? {}) as Record<string, unknown> & { ciks?: string[] };
      // display_names looks like ["Acme Inc  (CIK 0001234567)"]. The name is what precedes the CIK.
      const display = Array.isArray(src.display_names) ? String(src.display_names[0] ?? "") : "";
      const name = display.replace(/\s*\(CIK[^)]*\)\s*$/i, "").trim();
      if (!name) continue;
      // A market map is of operating companies. Funds raising for the sector are not IN the sector.
      if (looksLikeFund(name)) continue;

      const adsh = typeof h._id === "string" ? h._id.split(":")[0]! : (typeof src.adsh === "string" ? src.adsh : "");
      companies.push({
        name,
        funding_source: "SEC_FORM_D",
        last_round_date: typeof src.file_date === "string" ? src.file_date : null,
        // The filing itself, so a partner can open the primary document rather than take our word.
        source_url: adsh ? `https://www.sec.gov/Archives/edgar/data/${String(src.ciks?.[0] ?? "").replace(/^0+/, "")}/${adsh.replace(/-/g, "")}/${adsh}-index.htm` : "https://www.sec.gov/edgar/search/",
        // Amounts are NOT inferred. A Form D that did not state one in indexed text leaves this null.
        total_raised_usd: null,
      });
    }

    return { ok: true, companies, detail: `${companies.length} Form D filer(s)` };
  } catch (err) {
    const detail = err instanceof Error && err.name === "AbortError"
      ? `SEC EDGAR did not respond within ${TIMEOUT_MS / 1000}s.`
      : `Could not reach SEC EDGAR: ${err instanceof Error ? err.message : String(err)}`;
    // A failed source degrades the map; it never fails the build. The coverage note will say so.
    return { ok: false, companies: [], detail };
  } finally {
    clearTimeout(timer);
  }
}
