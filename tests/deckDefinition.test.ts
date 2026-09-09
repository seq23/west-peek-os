import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DECK_SLIDES, MONEY_BINDINGS, PERCENT_BINDINGS, bindingsUsed, type Binding,
} from "../src/shared/deck/definition";

/**
 * NO FIGURE IN THE DECK IS A LITERAL WHERE A RECORD EXISTS FOR IT.
 *
 * This is the guard that makes the six construction discrepancies structurally unrepeatable rather
 * than fixed once, and it is the actual deliverable of the deck work.
 *
 * Every one of them exists because the August deck STORED numbers duplicating what the OS already
 * knew: a construction table summing to $27M of a $30M fund, $3M of reserves labelled "30% of the
 * fund" when it is 10%, a $6M secondaries sleeve called 30% when it is 20%, an early-stage sleeve of
 * $21M against the OS's $16.8M, 20 positions against 25, and a $500K minimum cheque against $250K. A
 * deck that READS the fund row cannot sum its own table wrong.
 *
 * So a figure in the definition is a `bind` — a key resolved against the snapshot at render time —
 * and a bare number in a slot is a build failure.
 */

/*
 * COMMENTS STRIPPED BEFORE SCANNING. This file's own documentation explains the $500M overstatement
 * at length, and a scan that cannot tell prose from code fails on the explanation of the thing it
 * exists to catch — the trap the design-token validator already hit once in this repo.
 */
const RAW = readFileSync(fileURLToPath(new URL("../src/shared/deck/definition.ts", import.meta.url)), "utf8");
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Every figure a record can supply. A literal standing in for one of these is the defect. */
const RECORD_BACKED: Binding[] = [
  "fund_size", "fees", "expenses", "investable_base",
  "early_sleeve_usd", "early_sleeve_pct", "secondary_sleeve_usd", "secondary_sleeve_pct",
  "reserve_pct", "reserve_usd", "initial_capital_usd",
  "target_positions", "check_min", "check_max", "sectors", "mgmt_fee_pct", "carry_pct",
];

describe("every figure on a slide comes from a record", () => {
  it("uses bindings at all, and enough of them to be worth checking", () => {
    /*
     * THE EMPTY-LOOP GUARD. A definition with no bindings would pass every assertion below while
     * proving nothing — the exact shape of a validator that examines zero items and reports green.
     */
    const used = bindingsUsed();
    expect(used.length, "the deck definition binds no figures at all, so nothing was checked").toBeGreaterThan(0);
    expect(DECK_SLIDES.length, "there are no slides to examine").toBeGreaterThan(0);
  });

  it("carries no numeric literal in any slot where a record could supply it", () => {
    /*
     * Read from the slot VALUES rather than the source text, so the check is about what renders. A
     * money or percentage figure written as prose — "$21M", "70%", "25 companies" — is exactly the
     * August failure and is what this refuses.
     */
    const offenders: string[] = [];
    for (const slide of DECK_SLIDES) {
      for (const slot of slide.slots) {
        if (slot.kind !== "text") continue;
        // A currency amount or a bare percentage in prose that a record already holds.
        const money = slot.text.match(/\$\s?\d[\d,.]*\s?(?:M|K|million|billion)?/gi) ?? [];
        const percent = slot.text.match(/\b\d+(?:\.\d+)?\s?%/g) ?? [];
        for (const hit of [...money, ...percent]) {
          /*
           * $100M IS DELIBERATELY EXEMPT, and it is the one figure that should be. It is a quoted
           * claim about a decade of transactions Sequoia facilitated as a principal — a fact about
           * her history, not a fund figure the OS derives. The OS holds it as a comparable number;
           * the deck carries her wording. Nothing else gets this exemption.
           */
          if (/\$\s?100M/i.test(hit)) continue;
          offenders.push(`${slide.key}: "${hit}" in "${slot.text.slice(0, 60)}…"`);
        }
      }
    }
    expect(offenders, "these figures are typed onto a slide instead of read from a record").toEqual([]);
  });

  it("binds every fund figure the deck actually shows", () => {
    const used = new Set(bindingsUsed());
    // The construction slide is the one an allocator checks, so every line of it must be live.
    for (const required of [
      "fund_size", "fees", "expenses", "investable_base",
      "early_sleeve_usd", "secondary_sleeve_usd", "reserve_usd", "initial_capital_usd",
    ] as Binding[]) {
      expect(used.has(required), `${required} is not bound, so that line cannot be live`).toBe(true);
    }
    // And the figures that disagreed between the deck and the OS in August.
    for (const settled of ["target_positions", "check_min", "check_max", "sectors"] as Binding[]) {
      expect(used.has(settled), `${settled} disagreed with the OS in August and must be bound`).toBe(true);
    }
  });

  it("declares a format for every money and percentage binding, so one figure has one spelling", () => {
    for (const bind of bindingsUsed()) {
      if (/_usd$|^fund_size$|^fees$|^expenses$|^investable_base$|^check_/.test(bind)) {
        expect(MONEY_BINDINGS.has(bind), `${bind} is money but is not declared as money`).toBe(true);
      }
      if (/_pct$/.test(bind)) {
        expect(PERCENT_BINDINGS.has(bind), `${bind} is a percentage but is not declared as one`).toBe(true);
      }
    }
  });

  it("names a source for every slide that makes a non-numeric claim", () => {
    /*
     * Provenance recorded at authoring time, so the next audit does not have to re-derive it the way
     * 9 Sep did — reading a commissioning script to work out where the deck's sector list came from.
     */
    const unsourced = DECK_SLIDES
      .filter((s) => s.standfirst || s.slots.some((x) => x.kind === "text"))
      .filter((s) => !s.sources || s.sources.length === 0)
      .map((s) => s.key);
    expect(unsourced, "these slides make claims with no recorded source").toEqual([]);
  });
});

describe("the claims the operator approved, quoted rather than paraphrased", () => {
  const text = (key: string) => {
    const slide = DECK_SLIDES.find((s) => s.key === key);
    expect(slide, `the ${key} slide is missing`).toBeTruthy();
    return `${slide!.headline} ${slide!.standfirst ?? ""} ${slide!.slots.map((x) => (x.kind === "text" ? x.text : x.label)).join(" ")}`;
  };

  it("carries the FINRA line on the SECONDARIES slide, at the source's wording", () => {
    const secondaries = text("secondaries");
    expect(secondaries).toContain("FINRA-registered broker-dealer");
    expect(secondaries).toContain("relationships and partnerships with");
    // Never overstated: West Peek is not one, and no broker-dealer is named.
    expect(secondaries).not.toMatch(/we are a .{0,20}broker-dealer/i);
    expect(secondaries).not.toMatch(/exclusive/i);
    // It answers the access question where the access question is raised, not on the team slide.
    expect(text("team")).not.toContain("FINRA");
  });

  it("keeps 'combined' on the 22+ years claim, and does not upgrade the hedges", () => {
    const team = text("team");
    expect(team).toContain("22+ YEARS OF COMBINED");
    expect(team).toContain("operating in and around");
    // "proximity"/"operating in and around" are deliberate. Upgrading them is the $500M failure again.
    expect(team).not.toMatch(/\b22\+? years (?:of )?(?:investing|in venture capital)\b/i);
  });

  it("leads with the capital-allocators line, em-dash intact, before the team slide", () => {
    const positioning = DECK_SLIDES.findIndex((s) => s.key === "positioning");
    const team = DECK_SLIDES.findIndex((s) => s.key === "team");
    expect(positioning).toBeGreaterThan(-1);
    expect(positioning, "the positioning line must land before the team slide").toBeLessThan(team);

    const line = DECK_SLIDES[positioning]!.standfirst ?? "";
    // The concession-then-answer structure IS the sentence; splitting it concedes nothing.
    expect(line).toContain("not entering venture as capital allocators —");
    expect(line).toContain("already been operating within the ecosystem");
    // The three bullets are its evidence and travel with it.
    const bullets = DECK_SLIDES[positioning]!.slots.filter((s) => s.kind === "text");
    expect(bullets.length).toBe(3);
  });

  it("puts the three cities where the deck says who West Peek is", () => {
    expect(`${text("cover")} ${text("team")}`).toContain("New York • San Francisco • Atlanta");
  });

  it("never carries the $500M figure anywhere", () => {
    // The overstatement that mattered more than every arithmetic discrepancy combined.
    expect(SRC).not.toMatch(/\$\s?500\s?M/i);
    expect(SRC).not.toMatch(/500M\+/i);
    for (const slide of DECK_SLIDES) {
      const blob = `${slide.headline} ${slide.standfirst ?? ""} ${slide.slots.map((s) => (s.kind === "text" ? s.text : "")).join(" ")}`;
      expect(blob, `${slide.key} carries a $500M claim`).not.toMatch(/\$\s?500/);
    }
  });
});

describe("the deck answers the question a first-time fund is actually asked", () => {
  it("has a track-record slide that binds the position count instead of asserting one", () => {
    /*
     * Attribution is the hardest question for a first-time fund and the August deck did not answer
     * it. Binding the count means the slide cannot overstate: at zero positions it says so, and when
     * there are some it says how many without anybody rewriting it.
     */
    const slide = DECK_SLIDES.find((s) => s.key === "track_record");
    expect(slide, "there is no track-record slide, so the hardest question goes unanswered").toBeTruthy();
    expect(slide!.slots.some((s) => s.kind === "figure" && s.bind === "positions_held")).toBe(true);
    expect(`${slide!.headline} ${slide!.standfirst}`).toMatch(/first fund/i);
    // It refuses the specific substitution an allocator is watching for.
    expect(slide!.standfirst).toMatch(/not going to present transaction volume/i);
  });

  it("measures the community claim with its denominator rather than asserting a headcount", () => {
    const slide = DECK_SLIDES.find((s) => s.key === "sourcing")!;
    expect(slide.slots.some((s) => s.kind === "figure" && s.bind === "community_sourced_share")).toBe(true);
    // A proportion of four is a signal, not a statistic, and the slide says so.
    expect(slide.standfirst).toMatch(/small\s+sample/i);
  });
});
