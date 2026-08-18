import { describe, expect, it } from "vitest";
import {
  SOURCE_TRUST, bySegment, companyKey, coverageNote, formatUsd, groundCompanies, mergeCompanies,
  type CompanyFact,
} from "../src/shared/market/mapping";

/**
 * Market mapping (P46).
 *
 * The whole risk in a market map is a confident wrong number — it gets quoted in a partner meeting
 * and nobody re-checks it. So the merge rules and the unknown-handling are what these tests are for.
 */

const c = (over: Partial<CompanyFact> & { name: string }): CompanyFact => ({
  funding_source: "WEB_SEARCH", ...over,
});

describe("identifying the same company twice", () => {
  it("ignores suffixes and punctuation", () => {
    expect(companyKey("Acme Technologies, Inc.")).toBe(companyKey("acme"));
    expect(companyKey("Foo Labs LLC")).toBe(companyKey("Foo"));
  });

  it("keeps genuinely different companies apart", () => {
    expect(companyKey("Acme Health")).not.toBe(companyKey("Acme Freight"));
  });
});

describe("merging by source trust, field by field", () => {
  it("prefers a regulatory filing over a news figure for the raise", () => {
    const out = mergeCompanies([
      c({ name: "Acme", total_raised_usd: 20_000_000, funding_source: "SWEPT_NEWS", source_url: "https://news.test/1" }),
      c({ name: "Acme Inc.", total_raised_usd: 18_500_000, funding_source: "SEC_FORM_D", source_url: "https://sec.test/d" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.total_raised_usd).toBe(18_500_000);
  });

  it("moves the source URL with the number it justifies", () => {
    // A row showing a Form D figure beside a news link sends the reader to check the wrong thing.
    const out = mergeCompanies([
      c({ name: "Acme", total_raised_usd: 20_000_000, funding_source: "SWEPT_NEWS", source_url: "https://news.test/1" }),
      c({ name: "Acme", total_raised_usd: 18_500_000, funding_source: "SEC_FORM_D", source_url: "https://sec.test/d" }),
    ]);
    expect(out[0]!.funding_source).toBe("SEC_FORM_D");
    expect(out[0]!.source_url).toBe("https://sec.test/d");
  });

  it("keeps a good description from a weaker source", () => {
    // Field-by-field is the point: a Form D knows the raise and nothing about what they do.
    const out = mergeCompanies([
      c({ name: "Acme", description: "Inference infrastructure for regulated industries", funding_source: "SWEPT_NEWS" }),
      c({ name: "Acme", total_raised_usd: 18_500_000, funding_source: "SEC_FORM_D" }),
    ]);
    expect(out[0]!.description).toMatch(/Inference infrastructure/);
    expect(out[0]!.total_raised_usd).toBe(18_500_000);
  });

  it("never lets a blank overwrite a known value", () => {
    const out = mergeCompanies([
      c({ name: "Acme", total_raised_usd: 18_500_000, funding_source: "SEC_FORM_D" }),
      c({ name: "Acme", total_raised_usd: null, funding_source: "FIRM_RECORD" }),
    ]);
    expect(out[0]!.total_raised_usd).toBe(18_500_000);
  });

  it("keeps 'ours' once any source says so", () => {
    const out = mergeCompanies([
      c({ name: "Acme", funding_source: "WEB_SEARCH" }),
      c({ name: "Acme", funding_source: "FIRM_RECORD", is_ours: true }),
    ]);
    expect(out[0]!.is_ours).toBe(true);
  });

  it("ranks a filing above the firm's book above news above search", () => {
    expect(SOURCE_TRUST.SEC_FORM_D).toBeGreaterThan(SOURCE_TRUST.FIRM_RECORD);
    expect(SOURCE_TRUST.FIRM_RECORD).toBeGreaterThan(SOURCE_TRUST.SWEPT_NEWS);
    expect(SOURCE_TRUST.SWEPT_NEWS).toBeGreaterThan(SOURCE_TRUST.WEB_SEARCH);
  });
});

describe("laying out the map", () => {
  const list = [
    c({ name: "Big", segment: "Inference", total_raised_usd: 100_000_000 }),
    c({ name: "Small", segment: "Inference", total_raised_usd: 5_000_000 }),
    c({ name: "Unknown", segment: "Inference" }),
    c({ name: "Solo", segment: "Tooling", total_raised_usd: 1_000_000 }),
    c({ name: "Nowhere" }),
  ];

  it("puts the biggest segment first and unsegmented last", () => {
    const g = bySegment(list).map((s) => s.segment);
    expect(g[0]).toBe("Inference");
    expect(g[g.length - 1]).toBe("Unsegmented");
  });

  it("sorts by raise inside a panel", () => {
    expect(bySegment(list)[0]!.companies.map((x) => x.name).slice(0, 2)).toEqual(["Big", "Small"]);
  });

  it("puts unknown funding at the bottom, not treated as zero", () => {
    // "We do not know" is not "they raised nothing" — ranking it as zero libels the company.
    expect(bySegment(list)[0]!.companies.at(-1)!.name).toBe("Unknown");
  });
});

describe("unknowns and money", () => {
  it("renders an unknown as a dash, never as zero", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
    expect(formatUsd(0)).toBe("$0");
  });

  it("reads at the precision a partner uses", () => {
    expect(formatUsd(18_500_000)).toBe("$18.5M");
    expect(formatUsd(2_400_000_000)).toBe("$2.4B");
    expect(formatUsd(750_000)).toBe("$750k");
    // A clean number should not sprout a decimal, and past $100M the decimal is noise.
    expect(formatUsd(20_000_000)).toBe("$20M");
    expect(formatUsd(250_000_000)).toBe("$250M");
  });
});

describe("stating coverage", () => {
  it("always says what the map could not see", () => {
    const note = coverageNote({ companies: [c({ name: "A" })], sourcesUsed: ["firm records"] });
    expect(note).toMatch(/working map, not a complete census/);
  });

  it("counts the gaps rather than hiding them", () => {
    const note = coverageNote({
      companies: [c({ name: "A" }), c({ name: "B", total_raised_usd: 1, stage: "Seed" })],
      sourcesUsed: ["SEC Form D"],
    });
    expect(note).toMatch(/1 with no funding figure/);
    expect(note).toMatch(/1 with no stage/);
  });
});

describe("grounding", () => {
  it("drops a row with no name", () => {
    expect(groundCompanies([c({ name: "  " }), c({ name: "Real" })]).kept).toHaveLength(1);
  });
});
