import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OFF_NAV_TITLES } from "../src/client/lib/pageTitles";

/**
 * EVERY ROUTED PAGE HAS ITS OWN HEADER TITLE (23 Oct 2026). `#/outside-email` read "Home" because the
 * shell looked only in the nav for a title and fell back to the nav's first item. Read from App.tsx
 * itself, so a page added to the routable set without a title fails here, not in front of her.
 */
const APP = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
const NAV = [...APP.matchAll(/\{ key: "([a-z0-9-]+)", label: "([^"]+)"/g)].map((m) => ({ key: m[1]!, label: m[2]! }));
const setStart = APP.indexOf("const ALL_NAV_KEYS");
const setBody = APP.slice(setStart, APP.indexOf("]);", setStart));
const EXTRA_ROUTABLE = [...setBody.replace(/\/\/.*$/gm, "").matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!);
const MERGED = APP.slice(APP.indexOf("const MERGED_ROUTES"), APP.indexOf("};", APP.indexOf("const MERGED_ROUTES")));
const MERGED_FROM = [...MERGED.matchAll(/^\s*"?([a-z0-9-]+)"?: "[a-z0-9-]+",/gm)].map((m) => m[1]!);

function titleOf(key: string): string | null {
  return NAV.find((n) => n.key === key)?.label ?? OFF_NAV_TITLES[key]?.label ?? null;
}

describe("every routed page has its own header title", () => {
  it("reads the real nav and the routable set out of App.tsx", () => {
    expect(NAV.length).toBeGreaterThan(20);
    expect(EXTRA_ROUTABLE).toContain("outside-email");
    expect(EXTRA_ROUTABLE.length).toBeGreaterThan(5);
    expect(APP).toContain("const activeItem = navItemFor(active);");
  });

  it("names a title for every key the shell will render, and only Home is called Home", () => {
    const routable = [...new Set([...NAV.map((n) => n.key), ...EXTRA_ROUTABLE])];
    expect(routable.filter((k) => !titleOf(k))).toEqual([]);
    expect(routable.filter((k) => k !== "home" && titleOf(k) === "Home")).toEqual([]);
  });

  it("calls #/outside-email 'Outside email'", () => {
    expect(titleOf("outside-email")).toBe("Outside email");
  });

  it("files each off-nav page under a real nav page, and lists no page twice", () => {
    for (const [k, t] of Object.entries(OFF_NAV_TITLES)) {
      expect(NAV.some((n) => n.key === t.under), k).toBe(true);
      expect(NAV.some((n) => n.key === k), `${k} is in the nav already`).toBe(false);
    }
    // Merged addresses resolve to their destination before render; they need no title of their own.
    expect(MERGED_FROM).toContain("deal-math");
  });
});
