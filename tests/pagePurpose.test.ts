import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAGE_PURPOSES, pagePurpose } from "../src/shared/help/pagePurpose";

/**
 * Every nav destination explains itself (P40).
 *
 * The registry is read against App.tsx's actual nav, so adding a page without a purpose block
 * fails here rather than shipping a surface with no explanation. The pages that would get missed
 * are the ones nobody thinks about — Diagnostics, Contradictions, Activity — and those are exactly
 * where a first-time reader needs a sentence most.
 */

const APP = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
// Tolerant of extra fields (an `icon`, anything added later) on purpose. The previous pattern
// required the object to be exactly `{ key, label }`, so giving Home, Ask and Approvals icons
// silently dropped them from coverage — the check quietly stopped watching the three pages it
// most needed to watch, while still reporting green.
const NAV_KEYS = [...APP.matchAll(/\{ key: "([a-z0-9-]+)", label: "/g)].map((m) => m[1]!);
// Every key App.tsx will actually RENDER, which is a wider set than the nav lists. A page can be
// reachable without being listed: Go and look renders inside Work, Market mapping inside Research,
// and both keep their own route so existing links still resolve. The orphan check below runs
// against this rather than the nav, so it still catches a purpose left behind by a DELETED page
// while allowing one that merely stopped being a top-level tab.
const ROUTE_KEYS = [...APP.matchAll(/active === "([a-z0-9-]+)"/g)].map((m) => m[1]!);

describe("nav coverage", () => {
  it("reads a real nav out of App.tsx", () => {
    // Guards the guard: a refactor that changes the nav literal shape would otherwise make this
    // whole suite silently pass over an empty list.
    expect(NAV_KEYS.length).toBeGreaterThan(20);
    expect(NAV_KEYS).toContain("home");
  });

  it("has a purpose for every nav destination", () => {
    expect(NAV_KEYS.filter((k) => !pagePurpose(k))).toEqual([]);
  });

  it("routes everything it lists in the nav", () => {
    // Guards the guard again: ROUTE_KEYS is only a safe basis for the orphan check below if it is
    // really being read out of App.tsx.
    expect(ROUTE_KEYS.length).toBeGreaterThan(20);
    expect(NAV_KEYS.filter((k) => !ROUTE_KEYS.includes(k) && k !== "home")).toEqual([]);
  });

  it("has no purpose for a page that no longer exists", () => {
    // Stops the registry accumulating entries for deleted routes — a page that is merely absent
    // from the nav but still rendered is not deleted, and keeps its explanation.
    expect(Object.keys(PAGE_PURPOSES).filter((k) => !ROUTE_KEYS.includes(k))).toEqual([]);
  });
});

describe("how each one is written", () => {
  it("says what the page is, in a sentence a person would say out loud", () => {
    for (const [key, p] of Object.entries(PAGE_PURPOSES)) {
      expect(p.purpose.length, key).toBeGreaterThan(30);
      expect(p.purpose.trim().endsWith("."), key).toBe(true);
    }
  });

  it("gives two to four things you can actually do", () => {
    for (const [key, p] of Object.entries(PAGE_PURPOSES)) {
      expect(p.youCan.length, key).toBeGreaterThanOrEqual(2);
      expect(p.youCan.length, key).toBeLessThanOrEqual(4);
    }
  });

  it("uses no system vocabulary", () => {
    // If a line needs a schema term to make sense, it is written for the wrong reader.
    const jargon = /\b(payload|schema|endpoint|CRUD|idempoten|foreign key|migration|D1|JSON|API)\b/i;
    for (const [key, p] of Object.entries(PAGE_PURPOSES)) {
      expect(jargon.test(p.purpose), `${key} purpose`).toBe(false);
      for (const c of p.youCan) expect(jargon.test(c), `${key}: ${c}`).toBe(false);
    }
  });

  it("does not start every 'you can' line with the same verb", () => {
    // A list of four lines all starting "View…" tells the reader nothing they could not guess.
    for (const [key, p] of Object.entries(PAGE_PURPOSES)) {
      const verbs = p.youCan.map((c) => c.split(" ")[0]!.toLowerCase());
      expect(new Set(verbs).size, key).toBeGreaterThan(1);
    }
  });
});
