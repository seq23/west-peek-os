import { describe, expect, it } from "vitest";
import { decidedSoFar, filledLabel, previewNotice } from "../src/shared/work/porterNotices";
import { buildAnswersText } from "../src/worker/services/webPropertyChange";

/*
 * wc_59ef2d40, 19 Nov 2026. Scooter asked Porter to confirm whether the live dashboard reads and writes his tracker, and
 * to correct the record that said he had answered the plan's decisions. The preview said "Done:" over the question (its
 * one answering check was met:false, after_land), "Decided so far: … as the request answered" for every decision, and
 * "Filled in: The quote brief …: nothing arrived with the email".
 */
const ASKS = [
  { question: "Client price: do you type it, or should the dashboard calculate it?", recommended: "You type it; the suggestion is shown" },
  { question: "Default payment schedule: deposit on signing, balance on delivery?", recommended: "Yes; the deposit % blank until set" },
];

describe("the preview never says done, answered or missing when it is not (19 Nov 2026)", () => {
  it("a done item whose answering check is still open is not called Done, and says what it waits on", () => {
    const text = buildAnswersText({
      items: [
        {
          item: "Confirm whether the live dashboard reads and writes his real tracker",
          state: "done",
          blocked_by: "after_land",
          done_when: [
            { check: "dashboard:status is read-only", met: true, note: "SELECT-only guard" },
            { check: "After the merge, dashboard:status --env production gives the answer for the live dashboard", met: false, note: "Held by the landing" },
          ],
        },
        { item: "Quote tool 1a: settings", state: "done", done_when: [{ check: "saves", met: true }] },
      ],
    } as never)!;
    const lines = text.split("\n");
    expect(lines[0]).not.toMatch(/^• Done:/);
    expect(lines[0]).toMatch(/not answered until it is live, after you approve: Confirm whether the live dashboard/);
    expect(lines[0]).toContain("still to check: After the merge, dashboard:status --env production");
    expect(lines).toContain("• Done: Quote tool 1a: settings");
    // An open check with no landing in it is plainly partly done.
    const partial = buildAnswersText({ items: [{ item: "X", state: "done", done_when: [{ check: "the form posts", met: false }] }] } as never)!;
    expect(partial).toBe("• Partly done: X — still to check: the form posts");
  });

  it("a plan approved by the request never claims the request answered its decisions", () => {
    const fixed = ["NOT his answers: they are Porter's defaults for him to confirm.", "1. Porter's default: you type the price"];
    const decided = decidedSoFar(ASKS, fixed, "the request (every decision carried a recommendation)");
    for (const d of decided) expect(d).not.toMatch(/as the request answered/);
    expect(decided).toEqual(["Client price: You type it, if you approve", "Default payment schedule: Yes, if you approve"]);
    // A partner's own words still read as his answer.
    expect(decidedSoFar(ASKS.slice(0, 1), ["use a fixed price"], "Scooter")).toEqual(["Client price: use a fixed price, as Scooter answered"]);
  });

  it("'Filled in' names what was filled, never the reason it was missing", () => {
    const item = "The quote brief you said was attached (context, service list, calculation rules, example tests): nothing arrived with the email";
    expect(filledLabel(item)).toBe("The quote brief you said was attached (context, service list, calculation rules, example tests)");
    expect(filledLabel("Brand files: the folder is still empty")).toBe("Brand files");
    expect(filledLabel("Sengo logo")).toBe("Sengo logo");
    const email = JSON.stringify(previewNotice({ title: "T", previewLine: "p", placeholders: [], filled: [item], cardId: "wc_1" }));
    expect(email).toContain("The quote brief you said was attached");
    expect(email).not.toMatch(/nothing arrived/);
  });
});
