import { describe, expect, it } from "vitest";
import { CARD_SOURCES, CARD_STATES, STATE_MEANINGS, stateMeaning, triage } from "@shared/work/workCards";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WORK_CARD_STATES, canTransition, offeredMoves } from "../src/worker/services/workCards";

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

  /*
   * STRENGTHENED 22 Sep 2026 (Wave D). This used to read migration 0003 alone, which was true only
   * because every value ever written to `work_card.state` happened to be declared there. HELD
   * (0227) is deliberately NOT one of them — `work_card.state` carries a CHECK constraint from 0003
   * that would need a full table rebuild to widen (SQLite cannot ALTER a CHECK in place), and
   * `work_card` is referenced by roughly twenty other tables. Migration 0189 already hit that exact
   * failure class once, on a much smaller table, rebuilding `deliverable` and only later
   * discovering a dependent (`deliverable_feedback`) whose foreign key had been silently rewritten
   * to point at the rollback copy. So HELD is never written to the `state` column at all — it is
   * `held_at IS NOT NULL`, synthesised into `state: "HELD"` only in the JSON a card is served as
   * (`displayState` in `services/workCards.ts`). CARD_STATES therefore covers TWO different kinds
   * of member: the five the database column itself is ever set to, and HELD, which is a display
   * value the database never stores. Reading every migration for the first five is the stronger
   * claim this sentence makes over reading 0003 alone; asserting HELD is enforced through held_at
   * instead (the second test below) is what keeps that split honest rather than merely asserted.
   */
  it("covers exactly the states the database column itself allows, wherever they were declared", () => {
    const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    expect(files.length, "no migrations found — the scan would pass over nothing").toBeGreaterThan(100);
    const allSql = files.map((f) => readFileSync(`${dir}${f}`, "utf8")).join("\n");
    const storedInTheColumn = CARD_STATES.filter((s) => s !== "HELD");
    expect(storedInTheColumn.length, "HELD must be the only display-only member, or this filter is hiding a real gap").toBe(CARD_STATES.length - 1);
    for (const state of storedInTheColumn) {
      expect(allSql, `${state} is not a real work_card state — no migration declares it`).toContain(`'${state}'`);
    }
    expect(STATE_MEANINGS.map((s) => s.key).sort()).toEqual([...CARD_STATES].sort());
  });

  it("HELD is enforced at the row through held_at, not through a state value — a row trigger names it", () => {
    // The correctness rule this repo keeps: a state that changes behaviour is refused at the
    // database when a caller forgets it, not merely documented in TypeScript. Proven here against
    // the actual migration text rather than assumed from ALLOWED_TRANSITIONS existing. And proven
    // negatively that HELD was never smuggled back in as a `state` value anywhere in the migration
    // corpus — the whole reason this test file needed rewriting once, it must not need it again.
    const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    const allSql = files.map((f) => readFileSync(`${dir}${f}`, "utf8")).join("\n");
    expect(allSql).toMatch(/WHEN\s+NEW\.held_at\s+IS\s+NOT\s+NULL/);
    expect(allSql).toMatch(/NEW\.held_at\s+IS\s+NOT\s+NULL\s+AND\s+NEW\.lease_until\s+IS\s+NOT\s+NULL/);
    expect(allSql, "HELD must never appear as a literal work_card.state value").not.toMatch(/state\s*=\s*'HELD'/i);
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

/**
 * THE PAGE AND THE SERVER HAVE TO AGREE ABOUT WHAT IS POSSIBLE.
 *
 * Two buttons shipped that the server refused: "Put it back" on a dropped card (CANCELLED allowed
 * no transition at all) and "Done" on an open one (OPEN did not list DONE). Both rendered, both
 * 409'd, and the only sign was a notice near the top of a long page. Nothing typechecked wrong —
 * the coupling was between a React branch and a lookup table in another file, which is exactly the
 * kind that drifts.
 */
describe("offered moves are all legal moves", () => {
  it("permits every move the Work page can offer, for every state", () => {
    const illegal: string[] = [];
    for (const state of WORK_CARD_STATES) {
      for (const target of offeredMoves(state)) {
        if (!canTransition(state, target)) illegal.push(`${state} → ${target}`);
      }
    }
    expect(illegal).toEqual([]);
  });

  it("lets a dropped card come back, because a decision not to act gets revisited", () => {
    expect(canTransition("CANCELLED", "OPEN")).toBe(true);
    expect(offeredMoves("CANCELLED")).toContain("OPEN");
  });

  it("lets an open card be finished without being started first", () => {
    // Plenty of work is done in the moment it is noticed. Forcing a trip through IN_PROGRESS to
    // record that is ceremony, and the page never offered it anyway.
    expect(canTransition("OPEN", "DONE")).toBe(true);
  });
});
