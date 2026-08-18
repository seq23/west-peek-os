import { describe, expect, it } from "vitest";
import {
  classify, dedupe, isWeekend, localReportDate, rank, reportKey, scoreItem, similarity, titleKey,
  SOURCE_AUTHORITY, type NormalisedItem, type PartnerLens,
} from "../src/shared/intelligence/pipeline";

/**
 * The Daily Intelligence funnel (P41).
 *
 * These stages are deterministic on purpose — the operator's brief asked for separate reliable
 * stages rather than one enormous model call. That decision only pays off if the arithmetic is
 * actually pinned, so this suite is the return on it.
 */

const NOW = new Date("2026-08-17T12:00:00Z");

const item = (over: Partial<NormalisedItem> = {}): NormalisedItem => ({
  id: over.id ?? "i1",
  sourceType: "news",
  title: "Something happened",
  summary: "A reasonably detailed summary of the thing that happened today in the market.",
  url: null, publisher: null,
  publishedAt: "2026-08-17T06:00:00Z",
  entities: [], categories: ["GENERAL_MARKETS"],
  sourceAuthority: SOURCE_AUTHORITY.news,
  ...over,
});

const LENS: PartnerLens = { sectors: ["fintech"], companies: ["Acme"], themes: ["distribution"], depth: {} };

describe("deduplication", () => {
  it("collapses the same story from several outlets", () => {
    const out = dedupe([
      item({ id: "a", title: "Nvidia announces acquisition of Foo Systems", url: "https://reuters.test/1" }),
      item({ id: "b", title: "Nvidia to acquire Foo Systems", url: "https://cnbc.test/2" }),
    ]);
    expect(out.events).toHaveLength(1);
    expect(out.duplicatesRemoved).toBe(1);
  });

  it("keeps the PRIMARY source and demotes commentary to corroboration", () => {
    // The rule that matters: citing CNBC when the filing was available is getting the fact
    // second-hand for no reason.
    const out = dedupe([
      item({ id: "news", title: "Nvidia acquires Foo Systems", url: "https://cnbc.test/2", sourceType: "news", sourceAuthority: SOURCE_AUTHORITY.news }),
      item({ id: "filing", title: "Nvidia acquires Foo Systems", url: "https://sec.test/f", sourceType: "filing", sourceAuthority: SOURCE_AUTHORITY.filing }),
    ]);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.id).toBe("filing");
    expect(out.supporting["filing"]).toContain("https://cnbc.test/2");
  });

  it("treats the same URL with different query strings as one item", () => {
    const out = dedupe([
      item({ id: "a", title: "Totally different words here", url: "https://x.test/p?utm_source=a" }),
      item({ id: "b", title: "Nothing alike whatsoever friend", url: "https://x.test/p?utm_source=b" }),
    ]);
    expect(out.events).toHaveLength(1);
  });

  it("does NOT merge two genuinely different stories", () => {
    // Merging loses an event silently, which is worse than showing a near-duplicate.
    const out = dedupe([
      item({ id: "a", title: "Fed holds rates steady" }),
      item({ id: "b", title: "Stripe acquires a payments startup" }),
    ]);
    expect(out.events).toHaveLength(2);
  });

  it("scores similarity independent of word order and filler", () => {
    expect(similarity(titleKey("The Fed holds rates steady"), titleKey("Fed steady on rates"))).toBeGreaterThan(0.6);
  });
});

describe("classification", () => {
  it("recognises obvious categories without a model", () => {
    expect(classify({ title: "Fed signals a rate cut", summary: "" })).toContain("FED_MONETARY_POLICY");
    expect(classify({ title: "Acme raises Series B", summary: "" })).toContain("FUNDING");
    expect(classify({ title: "Tender offer for employee shares", summary: "" })).toContain("SECONDARIES");
  });

  it("allows several categories on one item", () => {
    const c = classify({ title: "SEC opens review of an AI acquisition", summary: "" });
    expect(c.length).toBeGreaterThan(1);
  });

  it("falls back rather than returning nothing", () => {
    expect(classify({ title: "A quiet day", summary: "" })).toEqual(["GENERAL_MARKETS"]);
  });
});

describe("ranking", () => {
  it("puts a portfolio mention above a generic story", () => {
    const generic = scoreItem({ item: item({ id: "g" }), lens: LENS, firmEntities: [], now: NOW });
    const ours = scoreItem({ item: item({ id: "o", title: "Acme Corp raises a round" }), lens: LENS, firmEntities: ["Acme Corp"], now: NOW });
    expect(ours.score).toBeGreaterThan(generic.score);
    expect(ours.reasons.join(" ")).toMatch(/mentions Acme Corp/);
  });

  it("explains every component so a ranking can be argued with", () => {
    const r = scoreItem({ item: item({ sourceType: "filing", sourceAuthority: 1 }), lens: LENS, firmEntities: [], now: NOW });
    expect(r.reasons).toContain("primary source");
    expect(r.reasons).toContain("published in the last day");
  });

  it("penalises a week-old story in a MORNING report", () => {
    const stale = scoreItem({ item: item({ publishedAt: "2026-08-01T06:00:00Z" }), lens: LENS, firmEntities: [], now: NOW });
    expect(stale.reasons).toContain("over a week old");
  });

  it("lets a depth dial of zero actually remove a category", () => {
    // A preference that cannot change the outcome is decoration.
    const off: PartnerLens = { ...LENS, depth: { macro: 0 } };
    const r = scoreItem({ item: item({ categories: ["MACRO"] }), lens: off, firmEntities: [], now: NOW });
    expect(r.reasons.join(" ")).toMatch(/turned macro off/);
    expect(r.score).toBeLessThan(0);
  });

  it("raises a category the partner asked for more of", () => {
    const more: PartnerLens = { ...LENS, depth: { secondaries: 3 } };
    const base = scoreItem({ item: item({ categories: ["SECONDARIES"] }), lens: LENS, firmEntities: [], now: NOW });
    const deep = scoreItem({ item: item({ categories: ["SECONDARIES"] }), lens: more, firmEntities: [], now: NOW });
    expect(deep.score).toBeGreaterThan(base.score);
  });

  it("cuts to a cap and drops everything under the floor", () => {
    const many = Array.from({ length: 100 }, (_, n) =>
      ({ item: item({ id: `i${n}`, title: `Story ${n}` }), lens: LENS, firmEntities: [], now: NOW }));
    expect(rank(many, { max: 30 }).length).toBeLessThanOrEqual(30);
  });

  it("produces a SHORT report on a quiet day rather than padding it", () => {
    const weak = [{ item: item({ categories: ["MACRO"], summary: "" }), lens: { ...LENS, depth: { macro: 0 } }, firmEntities: [], now: NOW }];
    expect(rank(weak, { floor: 1 })).toHaveLength(0);
  });

  it("is stable when two items tie", () => {
    const a = rank([
      { item: item({ id: "b", title: "Bravo" }), lens: LENS, firmEntities: [], now: NOW },
      { item: item({ id: "a", title: "Alpha" }), lens: LENS, firmEntities: [], now: NOW },
    ]);
    expect(a.map((x) => x.title)).toEqual(["Alpha", "Bravo"]);
  });
});

describe("idempotency and timezones", () => {
  it("keys a report to one partner and one day", () => {
    expect(reportKey("fu_1", "2026-08-17")).toBe("daily_intelligence:fu_1:2026-08-17");
  });

  it("uses the partner's own date, not UTC's", () => {
    // 01:30 UTC on the 18th is still the 17th in Chicago — a partner must not get two reports
    // dated a day apart because the scheduler ran either side of midnight UTC.
    const late = new Date("2026-08-18T01:30:00Z");
    expect(localReportDate(late, "America/Chicago")).toBe("2026-08-17");
    expect(localReportDate(late, "UTC")).toBe("2026-08-18");
  });

  it("falls back to UTC on a broken timezone rather than skipping the partner", () => {
    expect(localReportDate(NOW, "Not/AZone")).toBe("2026-08-17");
  });

  it("knows a weekend in the partner's timezone", () => {
    expect(isWeekend(new Date("2026-08-15T12:00:00Z"), "UTC")).toBe(true);  // Saturday
    expect(isWeekend(new Date("2026-08-17T12:00:00Z"), "UTC")).toBe(false); // Monday
  });
});
