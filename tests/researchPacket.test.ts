import { describe, expect, it } from "vitest";
import { groundFindings, parsePacket, renderPacketMarkdown, type Finding } from "../src/worker/services/researchPacket";

/**
 * Research packets (P43).
 *
 * The grounding rule is the product. A packet that reads well and cites nothing launders a model's
 * priors into something that looks like firm research — and it gets quoted in an IC.
 */

const f = (over: Partial<Finding> = {}): Finding => ({
  statement: "The segment consolidated around three vendors.", confidence: "MEDIUM", item_ids: ["i1"], ...over,
});

describe("parsing", () => {
  it("reads a packet with findings and open questions", () => {
    const p = parsePacket('{"summary":"Here is the state of play in the segment.","findings":[{"statement":"X","confidence":"HIGH","item_ids":["i1"]}],"open_questions":["What are the unit economics?"]}');
    expect(p!.findings).toHaveLength(1);
    expect(p!.open_questions).toHaveLength(1);
  });

  it("defaults an unrecognised confidence to LOW rather than assuming HIGH", () => {
    const p = parsePacket('{"summary":"S","findings":[{"statement":"X","confidence":"CERTAIN","item_ids":[]}]}');
    expect(p!.findings[0]!.confidence).toBe("LOW");
  });

  it("rejects a packet with no summary", () => {
    expect(parsePacket('{"findings":[]}')).toBeNull();
  });

  it("reads JSON out of a code fence", () => {
    expect(parsePacket('```json\n{"summary":"S","findings":[]}\n```')!.summary).toBe("S");
  });
});

describe("grounding", () => {
  const known = new Set(["i1", "i2"]);

  it("keeps a finding whose sources all exist", () => {
    expect(groundFindings([f({ item_ids: ["i1", "i2"] })], known).kept).toHaveLength(1);
  });

  it("DROPS a finding citing an item that does not exist", () => {
    const out = groundFindings([f({ item_ids: ["i9"] })], known);
    expect(out.kept).toHaveLength(0);
    expect(out.dropped).toBe(1);
  });

  it("DROPS a finding citing nothing at all", () => {
    // The exact failure: a confident claim with no source, which reads like research.
    expect(groundFindings([f({ item_ids: [] })], known).kept).toHaveLength(0);
  });

  it("drops rather than flags, because a flagged claim still gets quoted", () => {
    const out = groundFindings([f({ item_ids: ["i1"] }), f({ statement: "Ungrounded", item_ids: [] })], known);
    expect(out.kept.map((x) => x.statement)).toEqual(["The segment consolidated around three vendors."]);
  });
});

describe("export", () => {
  const sources = new Map([["i1", { title: "Item one", url: "https://s.test/1", publisher: "Reuters" }]]);

  it("renders a portable document with the question and confidence", () => {
    const md = renderPacketMarkdown(
      { title: "Payments infra", question: "Who wins?", summary: "Orientation.", findings: [f()], open_questions: ["Margins?"], created_at: "2026-08-17" },
      sources,
    );
    expect(md).toContain("# Payments infra");
    expect(md).toContain("**Question.** Who wins?");
    expect(md).toContain("**[MEDIUM]**");
    expect(md).toContain("[Reuters](https://s.test/1)");
    expect(md).toContain("## Still open");
  });

  it("states that ungrounded claims were removed", () => {
    // The reader takes this into a meeting; the provenance rule travels with it.
    const md = renderPacketMarkdown(
      { title: "T", question: "Q", summary: "S", findings: [], open_questions: [], created_at: "2026-08-17" },
      new Map(),
    );
    expect(md).toMatch(/removed rather than softened/);
  });
});
