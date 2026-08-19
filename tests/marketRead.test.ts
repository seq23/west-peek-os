import { describe, expect, it } from "vitest";
import { parseMarketRead } from "../src/worker/services/liveSearch";
import { buildSynthesisPrompt, verifyReport, type EvidencePacket } from "@shared/intelligence/reportSchema";

const basePacket = (over: Partial<EvidencePacket> = {}): EvidencePacket => ({
  report_date: "2026-08-18",
  partner_name: "Sequoia Taylor",
  firm_context: { sectors: ["AI"], portfolio: [], watchlist: [], themes: [] },
  open_narratives: [],
  events: [],
  ...over,
});

/**
 * The brief could never say where the ten-year sits, because it was written from RSS. Market levels
 * now come from a search-grounded pass — which introduces the single most believable kind of
 * invention available to a morning brief: a partner will act on "the ten-year is at 4.7" without
 * checking, and nothing downstream can tell that number came from the model's memory.
 */
describe("reading market levels", () => {
  it("keeps levels and the calendar out of a fenced answer", () => {
    const raw = '```json\n{"levels":[{"instrument":"10-year Treasury","level":"4.73%","move":"up"}],"calendar":[{"event":"Housing Starts","when":"7:30 CT","why":"reads the consumer"}]}\n```';
    const out = parseMarketRead(raw);
    expect(out.levels).toHaveLength(1);
    expect(out.levels[0]!.instrument).toBe("10-year Treasury");
    expect(out.calendar[0]!.event).toBe("Housing Starts");
  });

  it("drops an instrument with no level", () => {
    // A name with a blank beside it reads as "unchanged" rather than "unknown", which is the worse
    // of the two failures available here.
    const out = parseMarketRead('{"levels":[{"instrument":"Brent","level":""},{"instrument":"","level":"4.7%"},{"instrument":"Brent","level":"$91"}]}');
    expect(out.levels).toHaveLength(1);
    expect(out.levels[0]!.level).toBe("$91");
  });

  it("degrades to empty rather than throwing on rubbish", () => {
    for (const raw of ["", "no json here", "{broken", '{"levels":"not an array"}']) {
      expect(() => parseMarketRead(raw)).not.toThrow();
      expect(parseMarketRead(raw).levels).toEqual([]);
    }
  });
});

describe("the prompt refuses to invent figures", () => {
  it("supplies the levels verbatim when they exist", () => {
    const prompt = buildSynthesisPrompt(basePacket({
      market_levels: [{ instrument: "Brent", level: "$91", move: "up" }],
      calendar: [{ event: "Housing Starts", when: "7:30 CT", why: null }],
    }));
    expect(prompt).toContain("Brent");
    expect(prompt).toContain("use these figures verbatim");
    expect(prompt).toContain("Housing Starts");
  });

  it("tells the model to say so when there are none", () => {
    const prompt = buildSynthesisPrompt(basePacket());
    expect(prompt).toContain("Do not state any market figure");
    expect(prompt).toContain("Omit the key_events section");
  });

  it("asks for the shape the operator wanted", () => {
    const prompt = buildSynthesisPrompt(basePacket());
    expect(prompt).toContain("NUMBERED list");
    expect(prompt).toContain("Why it matters:");
    expect(prompt).toContain("Importance: N/10");
    // …and warns against the failure mode of a scored list.
    expect(prompt).toContain("a page of nines is noise");
  });
});

describe("the verifier catches an invented market figure", () => {
  it("flags a percentage stated with no levels supplied", () => {
    const flags = verifyReport(
      [{ key: "markets_macro", body_md: "The 10-year sits at 4.73% this morning.", event_ids: [] }],
      basePacket(),
    );
    expect(flags.map((f) => f.problem)).toContain("invented_market_figure");
  });

  it("flags a dollar figure the same way", () => {
    const flags = verifyReport(
      [{ key: "markets_macro", body_md: "Brent is above $91.", event_ids: [] }],
      basePacket(),
    );
    expect(flags).toHaveLength(1);
  });

  it("allows the same figure once levels were actually supplied", () => {
    const flags = verifyReport(
      [{ key: "markets_macro", body_md: "The 10-year sits at 4.73% this morning.", event_ids: [] }],
      basePacket({ market_levels: [{ instrument: "10-year Treasury", level: "4.73%", move: "up" }] }),
    );
    expect(flags).toEqual([]);
  });

  it("does not police prose in other sections", () => {
    // Only markets_macro is held to this. A headline quoting a company's raise is evidence-cited
    // and governed by the event_id checks instead.
    const flags = verifyReport(
      [{ key: "top_headlines", body_md: "Acme raised $12M.", event_ids: [] }],
      basePacket(),
    );
    expect(flags.map((f) => f.problem)).not.toContain("invented_market_figure");
  });
});
