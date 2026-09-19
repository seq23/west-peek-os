import { describe, expect, it } from "vitest";
import { HOME_FILTERS, bandsFor, effectiveFilter, isHomeFilter } from "../src/client/lib/homeFilter";

describe("the filter rail never opens on an empty screen", () => {
  it("a remembered filter with something in its band is honoured", () => {
    expect(effectiveFilter("waiting", { waiting: 1, arrived: 0, quiet: 0 })).toBe("waiting");
    expect(effectiveFilter("arrived", { waiting: 0, arrived: 3, quiet: 0 })).toBe("arrived");
    expect(effectiveFilter("quiet", { waiting: 0, arrived: 0, quiet: 9 })).toBe("quiet");
  });
  it("a remembered filter whose band is empty this morning opens on All", () => {
    expect(effectiveFilter("waiting", { waiting: 0, arrived: 3, quiet: 9 })).toBe("all");
    expect(effectiveFilter("arrived", { waiting: 1, arrived: 0, quiet: 0 })).toBe("all");
    expect(effectiveFilter("quiet", { waiting: 0, arrived: 0, quiet: 0 })).toBe("all");
  });
  it("All is always All, and every filter still shows the brief", () => {
    expect(effectiveFilter("all", { waiting: 0, arrived: 0, quiet: 0 })).toBe("all");
    for (const f of HOME_FILTERS) expect(bandsFor(f).brief).toBe(true);
    expect(bandsFor("waiting")).toEqual({ waiting: true, arrived: false, quiet: false, brief: true });
    expect(bandsFor("all")).toEqual({ waiting: true, arrived: true, quiet: true, brief: true });
  });
  it("only the four names are filters; anything else read from the store is All", () => {
    expect(isHomeFilter("waiting")).toBe(true);
    expect(isHomeFilter("everything")).toBe(false);
    expect(isHomeFilter(null)).toBe(false);
  });
});
