import { describe, expect, it } from "vitest";
import { buildProblems } from "../src/shared/work/everyAsk";

/*
 * wc_c548d043, 17 Nov 2026: Scooter asked for the case-study copy to stay placeholders until he sends it. The BUILD
 * left them as placeholders and reported that check unmet, quoting him; the v1.0 bar refused the finished build.
 * 28 Nov 2026: the fresh-eyes review, not a keyword, rules that the partner holds it.
 */
const NOTE = "Scooter: \"I'm working on the copy separately, so leave placeholders until I send it.\"";
const ITEM = "(7) Case-study cards";
const CHECK = "Copy left as placeholders until Scooter sends it";
const item = () => [{
  item: ITEM,
  state: "done",
  done_when: [
    { check: "Client / Project labels white", met: true },
    { check: CHECK, met: false, note: NOTE },
  ],
}];

describe("a step held until the partner sends something is his, when the review rules so (17 Nov 2026)", () => {
  it("the review's partner hold passes the finished build", () => {
    expect(buildProblems({ items: item(), reviewHolds: [{ item: ITEM, check: CHECK, held: true, by: "partner", why: "He is writing the copy and will send it." }] })).toEqual([]);
  });
  it("the same report with no ruling, a ruling of not held, or a hold with no reason is refused", () => {
    expect(buildProblems({ items: item() })[0]).toMatch(/ruled on it nowhere/);
    expect(buildProblems({ items: item(), reviewHolds: [{ item: ITEM, check: CHECK, held: false, why: "the copy is in his email" }] })[0]).toMatch(/can finish it here/);
    expect(buildProblems({ items: item(), reviewHolds: [{ item: ITEM, check: CHECK, held: true, by: "partner", why: "" }] })).toHaveLength(1);
    expect(buildProblems({ items: item(), reviewHolds: [{ item: ITEM, check: CHECK, held: true, by: "the builder ran out of time", why: "x" }] })).toHaveLength(1);
  });
});

/*
 * wc_c548d043, 19 Nov 2026: "Please reply with the live links once complete." The BUILD did every fix and reported the
 * live-links check unmet because only LAND can curl a live site; the v1.0 bar refused it and the retries could only fail.
 */
describe("a check only the merge can meet is LAND's, when the review rules so (19 Nov 2026)", () => {
  const LINKS = "Please reply with the live links once complete.";
  const links = (check: string, blocked_by?: string) => [
    { item: "WP mark for the favicon.", state: "done", done_when: [{ check: "favicon is the WP mark", met: true }] },
    { item: LINKS, state: "partial", ...(blocked_by ? { blocked_by } : {}), done_when: [{ check, met: false, note: "This belongs to the LAND phase after the merge" }] },
  ];
  it("a landing hold passes", () => {
    expect(buildProblems({ items: links("Live links curled after the merge"), reviewHolds: [{ item: LINKS, check: "Live links curled after the merge", held: true, by: "landing", why: "Only the live site has these links." }] })).toEqual([]);
  });
  it("the builder's own after_land claim, without the review's ruling, is refused", () => {
    expect(buildProblems({ items: links("Each site's link answers 200", "after_land") })).toHaveLength(1);
    expect(buildProblems({ items: links("Live links curled after the merge") })).toHaveLength(1);
    expect(buildProblems({ items: links("Live links listed in the summary"), reviewHolds: [{ item: LINKS, check: "Live links listed in the summary", held: false }] })).toHaveLength(1);
  });
});
