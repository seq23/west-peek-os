import { describe, expect, it } from "vitest";
import { mergeDecidedRows } from "../src/shared/home/decidedRows";

/**
 * A row she just decided stays on screen through the refetch that would otherwise drop it (found
 * 22 Sep 2026 — Wave F's global `invalidateAll()` reintroduced the exact flicker
 * `HomePage.tsx`'s `decide()` comment says was fixed, because the decide POST is itself a mutation
 * and the server's own list naturally excludes a card the moment it stops being pending).
 */
describe("mergeDecidedRows", () => {
  const A = { id: "apc_a", title: "A" };
  const B = { id: "apc_b", title: "B" };

  it("passes an untouched fresh list straight through when nothing has been decided", () => {
    expect(mergeDecidedRows([A, B], {}, {})).toEqual([A, B]);
  });

  it("keeps a decided row's own snapshot once the server's fresh list has already dropped it", () => {
    // The server refetch (Wave F's global invalidate) already excludes A; her decision and A's
    // own snapshot from the moment she acted are what keep the row rendered.
    expect(mergeDecidedRows([B], { apc_a: "approved 7:04 AM" }, { apc_a: A })).toEqual([B, A]);
  });

  it("does not duplicate a row the fresh list still happens to carry", () => {
    // Before any refetch lands, the server list may still include the just-decided card — do not
    // add a second copy from the snapshot.
    expect(mergeDecidedRows([A, B], { apc_a: "approved 7:04 AM" }, { apc_a: A })).toEqual([A, B]);
  });

  it("drops nothing when a decision was made but no snapshot was ever captured", () => {
    // Defensive: a decided id with no snapshot (should not happen in practice) adds nothing rather
    // than throwing or rendering a broken row.
    expect(mergeDecidedRows([B], { apc_a: "approved 7:04 AM" }, {})).toEqual([B]);
  });

  it("keeps more than one decided-and-dropped row, in the order they were captured", () => {
    expect(
      mergeDecidedRows([], { apc_a: "approved 7:04 AM", apc_b: "rejected 7:05 AM" }, { apc_a: A, apc_b: B }),
    ).toEqual([A, B]);
  });
});
