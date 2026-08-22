import { describe, expect, it } from "vitest";
import { matchSector, OFF_THESIS, sectorLabel, sectorOptions } from "../src/shared/investment/sectors";

/**
 * Operator, item 10: "Sectors should derive from the thesis, plus a Misc catch-all."
 *
 * The mandate says AI, FUTURE_OF_WORK, HEALTH_TECH, ED_TECH, CONSUMER. The companies on record
 * carried "AI", "Ed tech", "Consumer". Three spellings of one taxonomy means nothing can be
 * counted — "how much of the pipeline is health tech" has no answer.
 */
const MANDATE = ["AI", "FUTURE_OF_WORK", "HEALTH_TECH", "ED_TECH", "CONSUMER"];

describe("the list comes from the thesis", () => {
  it("offers exactly the mandate's sectors, in its order, plus one catch-all last", () => {
    const opts = sectorOptions(MANDATE);
    expect(opts.map((o) => o.key)).toEqual([...MANDATE, OFF_THESIS]);
    expect(opts[opts.length - 1]!.inMandate).toBe(false);
  });

  it("writes them the way a person would, acronyms included", () => {
    expect(sectorLabel("FUTURE_OF_WORK")).toBe("Future of work");
    expect(sectorLabel("HEALTH_TECH")).toBe("Health tech");
    // "AI" rendered as "Ai" on the first live read. The list of acronyms is named rather than
    // inferred: the heuristic that fixes this one ("short all-caps stays capitalised") turns
    // ED_TECH into "ED tech", so no rule is right about both.
    // The key stays AI so nothing already filed under it orphans; the firm says it in full.
    expect(sectorLabel("AI")).toBe("Artificial intelligence");
    // Inside a compound the short form is right — nobody says "artificial intelligence
    // infrastructure".
    expect(sectorLabel("AI_INFRASTRUCTURE")).toBe("AI infrastructure");
    expect(sectorLabel("SAAS")).toBe("SaaS");
  });

  it("still offers the catch-all when the mandate names no sectors", () => {
    // A fund with no stated sectors can still meet a company.
    expect(sectorOptions([]).map((o) => o.key)).toEqual([OFF_THESIS]);
    expect(sectorOptions(undefined).map((o) => o.key)).toEqual([OFF_THESIS]);
  });
});

describe("what is already on the books is read, not discarded", () => {
  const opts = sectorOptions(MANDATE);

  it("recognises the free text written before the mandate was the source", () => {
    expect(matchSector("Ed tech", opts)).toBe("ED_TECH");
    expect(matchSector("AI", opts)).toBe("AI");
    expect(matchSector("consumer", opts)).toBe("CONSUMER");
    expect(matchSector("Future of Work", opts)).toBe("FUTURE_OF_WORK");
  });

  it("calls anything that genuinely does not match off-thesis, which is true of it", () => {
    expect(matchSector("Crypto", opts)).toBe(OFF_THESIS);
    expect(matchSector(null, opts)).toBe(OFF_THESIS);
  });
});
