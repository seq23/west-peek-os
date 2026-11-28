import { describe, expect, it } from "vitest";
import { buildProblems, splitOffItems } from "../src/shared/work/everyAsk";

/*
 * wc_d4b961bc, 18 Nov 2026: Porter's GA4 plan asked whether to add privacy pages and recommended "as its own item after
 * this"; that answer was adopted. The BUILD did the GA work and reported the privacy item unmet, quoting the answer. The
 * v1.0 bar refused the finished build and sent the card's last attempt to draft privacy pages inside the GA job.
 */
const PRIVACY = "Privacy pages naming Google Analytics (and Clarity)";
const CHECK = "privacy pages drafted and previewed";
const items = () => [
  { item: "GA4 base tag on westpeek.ventures", state: "done", done_when: [{ check: "exactly one tag per page", met: true }] },
  { item: PRIVACY, state: "not_done", done_when: [{ check: CHECK, met: false, note: "Partner's answer: \"Yes, as its own item after this\"" }] },
];
const WHY = "Your approved answer made the privacy wording its own item, on its own preview.";

describe("an item the review rules another job's is filed as its own job, not refused (18 Nov 2026)", () => {
  it("the real report passes and names the item to file as its own job, with the review's why", () => {
    const holds = [{ item: PRIVACY, check: CHECK, held: true, by: "another_job", why: WHY }];
    expect(buildProblems({ items: items(), reviewHolds: holds })).toEqual([]);
    expect(splitOffItems(items(), holds)).toEqual([{ item: PRIVACY, words: WHY, on_card: null }]);
  });
  it("no ruling, not held, or held by the partner (not another job) files nothing; the first two are refused", () => {
    expect(buildProblems({ items: items() })).toHaveLength(1);
    expect(splitOffItems(items(), [])).toEqual([]);
    const no = [{ item: PRIVACY, check: CHECK, held: false }];
    expect(buildProblems({ items: items(), reviewHolds: no })).toHaveLength(1);
    expect(splitOffItems(items(), no)).toEqual([]);
    expect(splitOffItems(items(), [{ item: PRIVACY, check: CHECK, held: true, by: "partner", why: "his call" }])).toEqual([]);
  });
});
