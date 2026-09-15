/**
 * Live macro figures from free public sources (15 Sep 2026).
 *
 * WHY THIS EXISTS. The operator's example brief carries a dashboard — 10-year Treasury, Brent, WTI,
 * Fed odds, futures, the dollar, bitcoin — and its rule is "never invent a live number; if a live
 * figure could not be fetched, say so". The morning brief had only a search-grounded read of the
 * levels, which is a model's transcription of a page. These are the pages themselves.
 *
 * WHAT IS FETCHED, AND WHY THESE. FRED publishes each daily series as a small CSV with no key and
 * no terms beyond attribution; asked for the last ten days it is a few hundred bytes, so parsing is
 * nothing (the CPU budget is 10 ms for the whole tick). Coinbase's public spot price is one JSON
 * object. Both say what date the figure is AS OF, and the brief prints that date beside the figure:
 * FRED's yield lags a business day and its oil series a week, and a partner should see that rather
 * than read a stale print as this morning's.
 *
 * WHAT IS NOT HERE. Fed funds probabilities and index futures have no free, key-less, static
 * endpoint (CME FedWatch is a JavaScript application). Those stay with the search-grounded read in
 * liveSearch.ts, which returns the page it read them from, and the brief labels them as read
 * rather than fetched. A figure with no source at all is never shown.
 *
 * READ-ONLY, https only, a short timeout, bodies capped, nothing carried out but a User-Agent.
 */

export interface MacroReading {
  instrument: MacroInstrument;
  label: string;
  /** Verbatim from the source. */
  value: string;
  numericValue: number | null;
  /** YYYY-MM-DD the source says the figure is as of. */
  asOf: string;
  sourceUrl: string;
  sourceName: string;
}

export interface MacroFailure {
  instrument: MacroInstrument;
  label: string;
  detail: string;
}

export type MacroInstrument = "US10Y" | "BRENT" | "WTI" | "DXY_BROAD" | "BTC_USD";

interface FredSeries {
  instrument: MacroInstrument;
  label: string;
  id: string;
  unit: string;
}

const FRED_SERIES: readonly FredSeries[] = [
  { instrument: "US10Y", label: "10-year Treasury yield", id: "DGS10", unit: "%" },
  { instrument: "BRENT", label: "Brent crude", id: "DCOILBRENTEU", unit: "$/bbl" },
  { instrument: "WTI", label: "WTI crude", id: "DCOILWTICO", unit: "$/bbl" },
  { instrument: "DXY_BROAD", label: "US dollar (Fed broad index)", id: "DTWEXBGS", unit: "index" },
];

const TIMEOUT_MS = 8_000;
const MAX_BYTES = 16_384;

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "user-agent": "WestPeekOS/1.0 (+https://os.joinwestpeek.com)", accept: "text/csv, application/json, text/plain" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error(`response too large (${text.length} bytes)`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** The FRED CSV URL for the last `days` days of a series — small on purpose. */
export function fredUrl(id: string, now: Date, days = 14): string {
  const start = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  return `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`;
}

/**
 * The last dated, non-missing observation in a FRED CSV. FRED writes "." for a day with no print
 * (a holiday, or a series not yet updated), and those are skipped rather than read as zero.
 */
export function parseFredCsv(csv: string): { date: string; value: string } | null {
  const lines = csv.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 1; i--) {
    const [date, value] = lines[i]!.split(",").map((c) => c.trim());
    if (!date || !value || value === "." || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!Number.isFinite(Number(value))) continue;
    return { date, value };
  }
  return null;
}

export const COINBASE_SPOT_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot";

export function parseCoinbaseSpot(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as { data?: { amount?: unknown } };
    const amount = parsed.data?.amount;
    return typeof amount === "string" && Number.isFinite(Number(amount)) ? amount : null;
  } catch {
    return null;
  }
}

/**
 * Fetch every figure in parallel. Each source succeeds or fails on its own — a FRED outage must not
 * cost the bitcoin print, and vice versa — and a failure is returned with its reason so the brief
 * can say "could not be fetched" against the right line.
 */
export async function fetchMacroReadings(
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<{ readings: MacroReading[]; failures: MacroFailure[] }> {
  const readings: MacroReading[] = [];
  const failures: MacroFailure[] = [];

  const jobs: Array<Promise<void>> = FRED_SERIES.map(async (s) => {
    const url = fredUrl(s.id, now);
    try {
      const last = parseFredCsv(await fetchText(url, fetchImpl));
      if (!last) throw new Error("no dated observation in the last fortnight");
      readings.push({
        instrument: s.instrument,
        label: s.label,
        value: `${last.value}${s.unit === "%" ? "%" : ""}`,
        numericValue: Number(last.value),
        asOf: last.date,
        sourceUrl: `https://fred.stlouisfed.org/series/${s.id}`,
        sourceName: `FRED ${s.id}`,
      });
    } catch (err) {
      failures.push({ instrument: s.instrument, label: s.label, detail: err instanceof Error ? err.message : String(err) });
    }
  });

  jobs.push(
    (async () => {
      try {
        const amount = parseCoinbaseSpot(await fetchText(COINBASE_SPOT_URL, fetchImpl));
        if (!amount) throw new Error("no amount in the response");
        readings.push({
          instrument: "BTC_USD",
          label: "Bitcoin (USD)",
          value: `$${Number(amount).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
          numericValue: Number(amount),
          asOf: now.toISOString().slice(0, 10),
          sourceUrl: COINBASE_SPOT_URL,
          sourceName: "Coinbase spot",
        });
      } catch (err) {
        failures.push({ instrument: "BTC_USD", label: "Bitcoin (USD)", detail: err instanceof Error ? err.message : String(err) });
      }
    })(),
  );

  await Promise.all(jobs);
  const order: MacroInstrument[] = ["US10Y", "BRENT", "WTI", "DXY_BROAD", "BTC_USD"];
  readings.sort((a, b) => order.indexOf(a.instrument) - order.indexOf(b.instrument));
  failures.sort((a, b) => order.indexOf(a.instrument) - order.indexOf(b.instrument));
  return { readings, failures };
}
