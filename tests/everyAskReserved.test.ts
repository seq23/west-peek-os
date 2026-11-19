import { describe, expect, it } from "vitest";
import { buildProblems, partnerReserved } from "../src/shared/work/everyAsk";

/*
 * wc_c548d043, 17 Nov 2026: Scooter asked for the case-study copy to stay placeholders until he sends it. The BUILD
 * left them as placeholders and reported that check unmet, quoting him; the v1.0 bar refused the finished build.
 */
const HIS = "7. On case-study cards, make \"Client / Project\" labels white like the\nexpanded view. I'm working on the copy separately, so leave placeholders until I send it. Keep \"Get in touch\" as the main call\nto action.";
const item = (note: string) => [{
  item: "(7) Case-study cards",
  state: "done",
  done_when: [
    { check: "Client / Project labels white", met: true },
    { check: "Copy left as placeholders until Scooter sends it", met: false, note },
  ],
}];

describe("a step held until the partner sends something is his (17 Nov 2026)", () => {
  it("his own 'until I send it' words hold the check, with the apostrophe in I'm inside the quote", () => {
    const note = "Scooter: \"I'm working on the copy separately, so leave placeholders until I send it.\" 'What we did' and 'Results' are marked 'Copy to come from Scooter'";
    expect(partnerReserved(note, HIS)).toBe(true);
    expect(buildProblems({ items: item(note), partnerText: HIS })).toEqual([]);
    expect(partnerReserved("his words: 'I'm working on the copy separately'", HIS), "an apostrophe no longer cuts the quote").toBe(true);
  });
  it("the same shape with words he never wrote, or words that reserve nothing, is still refused", () => {
    expect(buildProblems({ items: item("Scooter: \"leave placeholders until I send the photos next month\""), partnerText: HIS })).toHaveLength(1);
    expect(buildProblems({ items: item("Scooter: \"Keep Get in touch as the main call to action\""), partnerText: HIS })).toHaveLength(1);
    expect(buildProblems({ items: item("no quote at all, copy to come"), partnerText: HIS })).toHaveLength(1);
  });
});

/*
 * wc_c548d043, 19 Nov 2026: "Please reply with the live links once complete." The BUILD did every fix and reported the
 * live-links check unmet because only LAND can curl a live site; the v1.0 bar refused it and the retries could only fail.
 */
describe("a check only the merge can meet is LAND's, not an unfinished build (19 Nov 2026)", () => {
  const links = (check: string, blocked_by?: string) => [
    { item: "WP mark for the favicon.", state: "done", done_when: [{ check: "favicon is the WP mark", met: true }] },
    { item: "Please reply with the live links once complete.", state: "partial", ...(blocked_by ? { blocked_by } : {}), done_when: [{ check, met: false, note: "This belongs to the LAND phase after the merge" }] },
  ];
  it("'Live links curled after the merge' and blocked_by after_land are accepted", () => {
    expect(buildProblems({ items: links("Live links curled after the merge") })).toEqual([]);
    expect(buildProblems({ items: links("Each site's link answers 200", "after_land") })).toEqual([]);
    expect(buildProblems({ items: links("Live links curled once it lands") })).toEqual([]);
  });
  it("a check that does not wait on the merge is still refused", () => {
    expect(buildProblems({ items: links("Live links listed in the summary") })).toHaveLength(1);
    expect(buildProblems({ items: links("Favicon replaced on every page") })).toHaveLength(1);
  });
});
