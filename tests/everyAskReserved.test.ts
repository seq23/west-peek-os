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
