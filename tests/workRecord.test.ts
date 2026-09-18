import { describe, expect, it } from "vitest";
import {
  RECORD_GROUP_COLUMNS,
  RECORD_GROUP_SQL,
  RECORD_STATES,
  bandByMonth,
  isFiltered,
  monthLabel,
  monthOf,
  recordSummary,
  searchTerms,
  LIKE_TERM_MAX,
  LIKE_TERMS_MAX,
  type RecordRow,
} from "../src/shared/work/record";
import { deskAnswer, deskSubline } from "../src/shared/work/deskAnswer";

/**
 * THE RECORD AND THE DESK'S ANSWER, held to arithmetic and grammar.
 *
 * Both are read by the operator every day and both were wrong in a way nothing caught. The page
 * printed "Finished 496" over fifty rows — a denominator that did not match what was on screen —
 * and it opened with "2 waiting on you" in the same type as everything under it. A count that lies
 * and a sentence that does not read are exactly the defects a unit test can hold.
 */

const row = (over: Partial<RecordRow> = {}): RecordRow => ({
  id: "wc_1",
  title: "Parker — build the September 2026 Room packet",
  state: "DONE",
  owner_id: "aie_parker",
  owner_name: "Parker",
  month: "2026-09",
  at: "2026-09-16T10:00:00.000Z",
  runs: 1,
  result: "Room requested: an event for Black lawyers in our network",
  model_access: "PUBLIC_MODEL_APPROVED",
  audience: "EXTERNAL",
  kind: null,
  ...over,
});

describe("the collapse key", () => {
  it("names a SQL expression for every column it declares — the SQL cannot drift from the spec", () => {
    expect(RECORD_GROUP_COLUMNS.length).toBeGreaterThan(0);
    for (const c of RECORD_GROUP_COLUMNS) {
      expect(RECORD_GROUP_SQL[c], `no SQL expression declared for "${c}"`).toBeTruthy();
    }
  });

  it("includes the month, so March's Room packet and September's stay two pieces of work", () => {
    // Without the month in the key, every recurring job in the firm's history collapses to one row
    // and the record stops being a record of output.
    expect(RECORD_GROUP_COLUMNS).toContain("month");
    expect(RECORD_GROUP_SQL.month).toContain("substr");
  });

  it("includes the state, so a dropped attempt never hides inside a finished one", () => {
    expect(RECORD_GROUP_COLUMNS).toContain("state");
  });

  it("offers dropped work as a filter rather than omitting it — a record is not a highlight reel", () => {
    expect(RECORD_STATES).toContain("CANCELLED");
    expect(RECORD_STATES[0]).toBe("ALL");
  });
});

describe("the month spine", () => {
  it("labels a month from its own digits, not through a Date the reader's zone would shift", () => {
    // `new Date("2026-09")` is UTC midnight, rendered in Chicago as 31 August — which relabels
    // every month boundary for the firm that actually uses this.
    expect(monthLabel("2026-09")).toBe("September 2026");
    expect(monthLabel("2026-01")).toBe("January 2026");
    expect(monthLabel("2026-12")).toBe("December 2026");
  });

  it("returns anything it cannot parse unchanged rather than inventing a month", () => {
    expect(monthLabel("not-a-month")).toBe("not-a-month");
    expect(monthLabel("2026-13")).toBe("2026-13");
  });

  it("derives the same key the SQL derives", () => {
    expect(monthOf("2026-09-16T10:00:00.000Z")).toBe("2026-09");
  });

  it("bands rows in the order they arrive, newest month first, without re-sorting", () => {
    const bands = bandByMonth([
      row({ month: "2026-09", id: "a" }),
      row({ month: "2026-09", id: "b" }),
      row({ month: "2026-08", id: "c" }),
    ]);
    expect(bands.map((b) => b.month)).toEqual(["2026-09", "2026-08"]);
    expect(bands[0]!.rows).toHaveLength(2);
    expect(bands[0]!.label).toBe("September 2026");
  });

  it("makes no bands out of no rows", () => {
    expect(bandByMonth([])).toEqual([]);
  });
});

describe("the summary line", () => {
  it("states the total and what is on screen, because the old page said 496 over fifty rows", () => {
    const line = recordSummary({ matched: { cards: 531, rows: 353 }, total: { cards: 531, rows: 353 }, rows: Array(40).fill(row()) }, false);
    expect(line).toContain("531 finished");
    expect(line).toContain("353 rows after identical runs are collapsed");
    expect(line).toContain("showing the most recent 40");
  });

  it("says how much of the whole record a filter matched, so an empty result is legible", () => {
    const line = recordSummary({ matched: { cards: 35, rows: 23 }, total: { cards: 531, rows: 353 }, rows: Array(23).fill(row()) }, true);
    expect(line).toContain("35 of 531 finished match");
    expect(line).toContain("showing all 23");
  });

  it("does not mention collapsing when nothing collapsed", () => {
    const line = recordSummary({ matched: { cards: 12, rows: 12 }, total: { cards: 12, rows: 12 }, rows: Array(12).fill(row()) }, false);
    expect(line).not.toContain("collapsed");
  });

  it("knows a filter is on for each control independently", () => {
    expect(isFiltered({})).toBe(false);
    expect(isFiltered({ state: "ALL" })).toBe(false);
    expect(isFiltered({ q: "   " })).toBe(false);
    expect(isFiltered({ q: "room" })).toBe(true);
    expect(isFiltered({ who: "aie_parker" })).toBe(true);
    expect(isFiltered({ month: "2026-09" })).toBe(true);
    expect(isFiltered({ state: "CANCELLED" })).toBe(true);
  });
});

describe("the search terms", () => {
  /*
   * MEASURED AGAINST THE REAL BINDING on 18 Sep 2026: D1 refuses a LIKE pattern of 50 characters
   * or more with `SQLITE_ERROR: LIKE or GLOB pattern too complex`. 40 characters plus its two
   * wildcards answers; 48 does not. One `%<whole query>%` therefore turned her longest and most
   * specific searches — the ones she makes when she actually remembers something — into a 500 and
   * a blank record, which reads as "the firm has never done this".
   */
  it("cannot build a pattern D1 would refuse, however long the query", () => {
    const long = "a".repeat(400);
    for (const term of searchTerms(long)) {
      expect(term.length + 2, "the term plus its two wildcards must clear D1's 50-character limit").toBeLessThan(50);
    }
    expect(LIKE_TERM_MAX + 2).toBeLessThan(50);
  });

  it("caps how many terms a search can AND together", () => {
    expect(searchTerms("one two three four five six seven eight nine")).toHaveLength(LIKE_TERMS_MAX);
  });

  it("splits on words, so the order she typed them in does not matter", () => {
    expect(searchTerms("  room   packet  black lawyers ")).toEqual(["room", "packet", "black", "lawyers"]);
  });

  it("makes no terms out of nothing, so an empty box filters nothing", () => {
    expect(searchTerms("")).toEqual([]);
    expect(searchTerms("   ")).toEqual([]);
  });

  it("truncates one very long word rather than dropping the search", () => {
    const terms = searchTerms("x".repeat(120));
    expect(terms).toHaveLength(1);
    expect(terms[0]).toHaveLength(LIKE_TERM_MAX);
  });
});

describe("the desk's answer", () => {
  it("answers the question rather than printing a count", () => {
    expect(deskAnswer({ waiting: 2, decks: 0, inFlight: 4, failing: 0 }).line).toBe(
      "Two things are stopped until you answer.",
    );
  });

  it("agrees with itself in number", () => {
    expect(deskAnswer({ waiting: 1, decks: 0, inFlight: 0, failing: 0 }).line).toBe(
      "One thing is stopped until you answer.",
    );
    expect(deskAnswer({ waiting: 0, decks: 1, inFlight: 0, failing: 0 }).line).toBe(
      "One thing is stopped until you answer.",
    );
  });

  it("counts a waiting deck alongside a waiting card — both are stopped on her", () => {
    const a = deskAnswer({ waiting: 2, decks: 1, inFlight: 0, failing: 0 });
    expect(a.line).toBe("Three things are stopped until you answer.");
    expect(a.count).toBe(3);
  });

  it("uses a numeral past six rather than spelling out a sentence nobody reads", () => {
    expect(deskAnswer({ waiting: 11, decks: 0, inFlight: 0, failing: 0 }).line).toBe(
      "11 things are stopped until you answer.",
    );
  });

  it("says the clear day plainly, and marks it clear so it can be said in the good tone", () => {
    const a = deskAnswer({ waiting: 0, decks: 0, inFlight: 6, failing: 0 });
    expect(a.line).toBe("Nothing is waiting on you.");
    expect(a.clear).toBe(true);
    expect(a.count).toBe(0);
  });

  it("does not say the desk is clear while a card is failing behind her back", () => {
    /*
     * 17 Sep: a card failed three times in fourteen minutes against a lane with no credit, and
     * every reading of the page said it was queued. It is not waiting on her yet — the sweep is
     * still retrying — but "nothing is waiting" full stop is how she found out by asking.
     */
    const a = deskAnswer({ waiting: 0, decks: 0, inFlight: 3, failing: 1 });
    expect(a.clear).toBe(false);
    expect(a.line).toContain("one card has failed once and is being tried again");
    expect(a.count).toBe(0);
  });

  it("puts a real block ahead of a retry — she can act on one and not the other", () => {
    expect(deskAnswer({ waiting: 1, decks: 0, inFlight: 0, failing: 5 }).line).toBe(
      "One thing is stopped until you answer.",
    );
  });

  it("renders no subline rather than an empty paragraph when nothing is in flight", () => {
    expect(deskSubline({ waiting: 0, decks: 0, inFlight: 0, failing: 0 })).toBeNull();
    expect(deskSubline({ waiting: 0, decks: 0, inFlight: 1, failing: 0 })).toBe("One card is being worked right now.");
    expect(deskSubline({ waiting: 0, decks: 0, inFlight: 9, failing: 0 })).toBe("9 cards are being worked right now.");
  });
});
