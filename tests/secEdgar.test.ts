import { describe, expect, it } from "vitest";
import { looksLikeFund, parseAmount, searchFormD } from "../src/worker/effects/secEdgarClient";

/**
 * SEC EDGAR Form D adapter (P46).
 *
 * The fund filter exists because of a real result: querying "artificial intelligence" returns
 * "Brookfield Artificial Intelligence Infrastructure Fund-A, L.P." near the top. Form D is filed by
 * anyone raising private capital — an unfiltered map lists the INVESTORS in a sector as companies
 * in it, which is exactly backwards.
 */

function respond(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}
const hit = (name: string, cik = "0001234567") => ({
  _id: "0001234567-25-000001:primary_doc.xml",
  _source: { display_names: [`${name}  (CIK ${cik})`], file_date: "2026-08-01", ciks: [cik] },
});

describe("telling funds from operating companies", () => {
  it("recognises the real filer that prompted this filter", () => {
    expect(looksLikeFund("Brookfield Artificial Intelligence Infrastructure Fund-A, L.P.")).toBe(true);
  });

  it("catches the usual vehicle shapes", () => {
    for (const n of ["Acme Ventures LP", "Foo Capital Partners", "Bar Growth Fund III", "Baz SCSp", "Quux Management LLC"]) {
      expect(looksLikeFund(n), n).toBe(true);
    }
  });

  it("leaves operating companies alone", () => {
    for (const n of ["Anthropic", "Stripe", "Modal Labs", "Together AI", "Cursor"]) {
      expect(looksLikeFund(n), n).toBe(false);
    }
  });
});

describe("searching", () => {
  it("returns operating companies and drops the funds", async () => {
    const r = await searchFormD("inference", respond({
      hits: { hits: [hit("Brookfield AI Infrastructure Fund-A, L.P."), hit("Modal Labs")] },
    }));
    expect(r.ok).toBe(true);
    expect(r.companies.map((c) => c.name)).toEqual(["Modal Labs"]);
  });

  it("marks every hit as a Form D source", async () => {
    const r = await searchFormD("inference", respond({ hits: { hits: [hit("Modal Labs")] } }));
    expect(r.companies[0]!.funding_source).toBe("SEC_FORM_D");
    expect(r.companies[0]!.source_url).toMatch(/sec\.gov/);
  });

  it("never infers an amount the filing did not state", async () => {
    // The one number this source exists to be authoritative about. Guessing it defeats the point.
    const r = await searchFormD("inference", respond({ hits: { hits: [hit("Modal Labs")] } }));
    expect(r.companies[0]!.total_raised_usd).toBeNull();
  });

  it("degrades rather than throwing when SEC is unavailable", async () => {
    const r = await searchFormD("inference", respond({}, 503));
    expect(r.ok).toBe(false);
    expect(r.companies).toEqual([]);
    expect(r.detail).toMatch(/503/);
  });

  it("refuses an empty sector", async () => {
    expect((await searchFormD("  ", respond({}))).ok).toBe(false);
  });
});

describe("amount parsing", () => {
  it("reads the common shapes", () => {
    expect(parseAmount("$12.5 million")).toBe(12_500_000);
    expect(parseAmount("$2 billion")).toBe(2_000_000_000);
    expect(parseAmount("$750,000")).toBe(750_000);
  });

  it("returns null rather than a guess", () => {
    expect(parseAmount("an undisclosed amount")).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });
});
