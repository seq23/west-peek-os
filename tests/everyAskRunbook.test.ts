import { describe, expect, it } from "vitest";
import { ITEM_STATE, buildProblems } from "../src/shared/work/everyAsk";
import { buildAnswersText } from "../src/worker/services/webPropertyChange";

/*
 * wc_76e6d7ff, 19 Nov 2026: Scooter asked to take a song through contest entry "with my own access". The topbarz
 * RUNBOOK says his own track is never in the vote, so the BUILD ran a demo song instead, met both checks, and reported
 * the item "partial" with RUNBOOK_FORBIDS, as the prompt orders. The v1.0 bar refused it; no preview went out.
 */
const ITEM = "Use my own access to take a song through contest entry and see it on the voting page";
const NOTE = "His own email cannot be the one on the song: RUNBOOK_FORBIDS: \"Scooter Taylor's own track is never in the vote\" — did a demo song he runs from the preview instead";
const WHY = "The site's runbook says your own track is never in the vote, so the preview uses a demo song you can run yourself.";
const item = (over: Record<string, unknown> = {}) => ({
  item: ITEM,
  state: "partial",
  note: NOTE,
  done_when: [
    { check: "Enter the contest on a demo song puts it on the preview voting page", met: true },
    { check: "Test data cleared from the preview line", met: true },
  ],
  ...over,
});
const HOLD = [{ item: ITEM, check: ITEM_STATE, held: true, by: "runbook", why: WHY }];

describe("a RUNBOOK never-rule is a decision when the review rules so, not an unfinished item (19 Nov 2026)", () => {
  it("the real report passes with the review's runbook ruling on the item", () => {
    expect(buildProblems({ items: [item()], reviewHolds: HOLD })).toEqual([]);
  });
  it("the same partial with no ruling, ruled not held, or an unmet check the ruling does not name, is refused", () => {
    expect(buildProblems({ items: [item()] })[0]).toMatch(/its state is "partial" and the review ruled on it nowhere/);
    expect(buildProblems({ items: [item()], reviewHolds: [{ ...HOLD[0]!, held: false }] })).toHaveLength(1);
    expect(buildProblems({ items: [item({ done_when: [{ check: "demo song on the vote", met: false }] })], reviewHolds: HOLD })).toHaveLength(1);
  });
  it("the preview email says why an item is only partly done, in the review's plain words", () => {
    const text = buildAnswersText({ items: [item(), { item: "Use Prize details TBD", state: "done", done_when: [{ check: "prize line", met: true }] }], review_holds: HOLD } as never)!;
    expect(text).toContain(`Partly done: ${ITEM} — ${WHY}`);
    expect(text).not.toContain("RUNBOOK_FORBIDS");
    expect(text.split("\n")).toContain("• Done: Use Prize details TBD");
    // With no ruling the builder's own note is still said, the code word in plain words.
    const bare = buildAnswersText({ items: [item()] } as never)!;
    expect(bare).toContain("the site's runbook says \"Scooter Taylor's own track is never in the vote\"");
  });
});
