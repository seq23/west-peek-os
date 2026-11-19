import { describe, expect, it } from "vitest";
import { buildProblems } from "../src/shared/work/everyAsk";
import { buildAnswersText } from "../src/worker/services/webPropertyChange";

/*
 * wc_76e6d7ff, 19 Nov 2026: Scooter asked to take a song through contest entry "with my own access". The topbarz
 * RUNBOOK says his own track is never in the vote, so the BUILD ran a demo song instead, met both checks, and reported
 * the item "partial" with RUNBOOK_FORBIDS, as the prompt orders. The v1.0 bar refused it; no preview went out.
 */
const NOTE = "Song 2733 opened with jingle.demo@example.com goes through Enter the contest. His own email cannot be the one on the song: RUNBOOK_FORBIDS: \"Scooter Taylor's own track is never in the vote\" — did a demo song he runs from the preview instead";
const item = (over: Record<string, unknown> = {}) => ({
  item: "Use my own access to take a song through contest entry and see it on the voting page",
  state: "partial",
  note: NOTE,
  done_when: [
    { check: "Enter the contest on a demo song puts it on the preview voting page", met: true },
    { check: "Test data cleared from the preview line", met: true },
  ],
  ...over,
});

describe("a RUNBOOK never-rule the build recorded is a decision, not an unfinished item (19 Nov 2026)", () => {
  it("the real report passes the v1.0 bar", () => {
    expect(buildProblems({ items: [item()], partnerText: "x" })).toEqual([]);
  });
  it("an unmet check, or a partial with no quoted RUNBOOK rule, is still refused", () => {
    expect(buildProblems({ items: [item({ done_when: [{ check: "demo song on the vote", met: false }] })] })).toHaveLength(1);
    expect(buildProblems({ items: [item({ note: "RUNBOOK_FORBIDS it, did a demo song" })] })).toHaveLength(1);
    expect(buildProblems({ items: [item({ note: "did a demo song instead" })] })).toHaveLength(1);
  });
  it("the preview email says why an item is only partly done, in plain words", () => {
    const text = buildAnswersText({ items: [item(), { item: "Use Prize details TBD", state: "done", done_when: [{ check: "prize line", met: true }] }] as never })!;
    expect(text).toContain("Partly done: Use my own access");
    expect(text).toContain("the site's runbook says \"Scooter Taylor's own track is never in the vote\"");
    expect(text).not.toContain("RUNBOOK_FORBIDS");
    expect(text.split("\n")).toContain("• Done: Use Prize details TBD");
  });
});
