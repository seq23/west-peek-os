import { describe, expect, it } from "vitest";
import { CARD_SOURCES, CARD_STATES, STATE_MEANINGS, stateMeaning, triage } from "@shared/work/workCards";
import { readFileSync } from "node:fs";

/**
 * The operator's report was "I don't understand work cards, and there's no way to create them."
 * Both halves were true: cards appear as a consequence of five things happening elsewhere, the page
 * named none of them, and the one direct route had no button. These pin the explanation to reality
 * so the page cannot describe a product that no longer exists.
 */
describe("what a work card is", () => {
  it("names every way a card can actually be created", () => {
    // Each source must correspond to code that really calls the creator. If a path is removed, the
    // page would otherwise keep promising it.
    const creators = ["captures.ts", "workPackets.ts", "meetings.ts", "networkAdapter.ts", "workCards.ts"];
    for (const file of creators) {
      const src = readFileSync(new URL(`../src/worker/services/${file}`, import.meta.url), "utf8");
      expect(src, `${file} no longer creates work cards`).toMatch(/createWorkCardInternal|INSERT INTO work_card/);
    }
    expect(CARD_SOURCES).toHaveLength(creators.length);
  });

  it("explains each source rather than naming it", () => {
    for (const s of CARD_SOURCES) {
      expect(s.label).not.toMatch(/_/);
      expect(s.how.length).toBeGreaterThan(40);
    }
  });

  it("covers exactly the states the database allows", () => {
    const sql = readFileSync(new URL("../migrations/0003_work_authority_approval.sql", import.meta.url), "utf8");
    for (const state of CARD_STATES) {
      expect(sql, `${state} is not a real work_card state`).toContain(`'${state}'`);
    }
    expect(STATE_MEANINGS.map((s) => s.key).sort()).toEqual([...CARD_STATES].sort());
  });
});

describe("triage", () => {
  const card = (over: Partial<{ state: string; priority: string; due_at: string | null }> = {}) => ({
    state: "OPEN",
    priority: "NORMAL",
    due_at: null,
    ...over,
  });

  it("puts blocked work first, because it is the only kind that has stopped", () => {
    const out = triage([card({ state: "OPEN" }), card({ state: "IN_PROGRESS" }), card({ state: "BLOCKED" })]);
    expect(out[0]!.state).toBe("BLOCKED");
    expect(out[1]!.state).toBe("IN_PROGRESS");
  });

  it("breaks ties on urgency, then on what is due soonest", () => {
    const out = triage([
      card({ priority: "NORMAL", due_at: "2026-09-01" }),
      card({ priority: "URGENT" }),
      card({ priority: "NORMAL", due_at: "2026-08-20" }),
    ]);
    expect(out[0]!.priority).toBe("URGENT");
    expect(out[1]!.due_at).toBe("2026-08-20");
  });

  it("leaves finished work out of the open list", () => {
    const out = triage([card({ state: "DONE" }), card({ state: "CANCELLED" }), card({ state: "OPEN" })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.state).toBe("OPEN");
  });

  it("does not mutate what it was given", () => {
    const input = [card({ state: "OPEN" }), card({ state: "BLOCKED" })];
    triage(input);
    expect(input[0]!.state).toBe("OPEN");
  });

  it("misses cleanly on an unknown state", () => {
    expect(stateMeaning("NOT_A_STATE")).toBeNull();
  });
});
