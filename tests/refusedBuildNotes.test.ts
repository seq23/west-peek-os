import { describe, expect, it } from "vitest";
import { refusedNotesOf, refusedNotesThisRound, withRefusedNotes } from "../src/worker/services/webPropertyChange";

/*
 * wc_c548d043, 19 Nov 2026: "Flag any additional cost before starting." The first BUILD answered "No cost", was refused
 * on a live-links check, and the accepted retry's notes replaced it; the preview email never said there was no cost.
 */
const history = [
  { at: "2026-11-18T23:32:07Z", run_id: "ccr_prev", phase: "BUILD", status: "ok", reason: "" },
  { at: "2026-11-19T06:20:08Z", run_id: "ccr_first", phase: "BUILD", status: "ok", reason: "" },
  { at: "2026-11-19T06:20:09Z", run_id: "ccr_first", phase: "BUILD", status: "REFUSED", reason: "BUILD REFUSED", notes: "PR #37 now carries the GA4 (#39) and privacy (#40) work. No cost. The live links come in LAND." },
  { at: "2026-11-19T06:32:08Z", run_id: "ccr_retry", phase: "BUILD", status: "ok", reason: "" },
];

describe("a refused build's answers reach the partner with the accepted retry", () => {
  it("collects the refused run's notes since the last accepted build, and only those", () => {
    expect(refusedNotesThisRound(history)).toEqual(["PR #37 now carries the GA4 (#39) and privacy (#40) work. No cost. The live links come in LAND."]);
    expect(refusedNotesThisRound(history.slice(0, 1)), "an accepted build with no refusal carries nothing").toEqual([]);
    expect(refusedNotesThisRound([{ phase: "BUILD", status: "REFUSED", notes: "old round" }, ...history.slice(0, 2), history[3]!]), "a refusal before an accepted build belongs to an earlier round").toEqual([]);
  });
  it("adds 'No cost' to the retry's answers, never twice, and strips the cost suffix from stored notes", () => {
    const merged = withRefusedNotes("• Done: Reply with the live links once complete\n\nOnly the live-links proof was missing.", refusedNotesThisRound(history))!;
    expect(merged).toContain("No cost.");
    expect(merged).toContain("Only the live-links proof was missing.");
    expect(withRefusedNotes(merged, refusedNotesThisRound(history))).toBe(merged);
    expect(refusedNotesOf({ notes: "No cost. (cost $3.16)" })).toBe("No cost.");
    expect(refusedNotesOf({ notes: "  " })).toBeUndefined();
  });
});
