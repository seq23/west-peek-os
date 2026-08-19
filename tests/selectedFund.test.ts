import { describe, expect, it } from "vitest";
import { resolveFund, type FundRow } from "../src/client/lib/selectedFund";

/**
 * Fund II is raised alongside Fund I rather than after it, so for a stretch both are live and
 * "whichever the query returned first" stops being an answer. The failure this prevents is quiet:
 * you edit a thesis, it saves, and it saves to the wrong fund.
 */
const I: FundRow = { id: "f_one", name: "West Peek Ventures Fund I" };
const II: FundRow = { id: "f_two", name: "West Peek Ventures Fund II" };

describe("resolving which fund is being looked at", () => {
  it("honours an explicit choice over document order", () => {
    expect(resolveFund([I, II], "f_two")).toBe(II);
    // …and the order the API happens to return them in must not decide it.
    expect(resolveFund([II, I], "f_one")).toBe(I);
  });

  it("falls back to the first fund rather than to nothing when the choice does not resolve", () => {
    // A different machine, or a fund that was removed. A blank thesis page is the worse answer.
    expect(resolveFund([I, II], "f_gone")).toBe(I);
    expect(resolveFund([I, II], null)).toBe(I);
  });

  it("returns null only when the firm genuinely has no fund", () => {
    expect(resolveFund([], "f_one")).toBeNull();
    expect(resolveFund([], null)).toBeNull();
  });

  it("is stable — resolving twice gives the same fund", () => {
    expect(resolveFund([I, II], "f_two")).toBe(resolveFund([I, II], "f_two"));
  });
});
