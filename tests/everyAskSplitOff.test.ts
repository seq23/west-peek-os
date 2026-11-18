import { describe, expect, it } from "vitest";
import { buildProblems, splitOffItems } from "../src/shared/work/everyAsk";

/*
 * wc_d4b961bc, 18 Nov 2026: Porter's GA4 plan asked whether to add privacy pages and recommended "as its own item after
 * this"; that answer was adopted. The BUILD did the GA work and reported the privacy item unmet, quoting the answer. The
 * v1.0 bar refused the finished build and sent the card's last attempt to draft privacy pages inside the GA job.
 */
const REQUEST = "Please install Google Analytics 4 on the three sites. Standard gtag.js in the <head> of every page.";
const ANSWER = "1. Yes, as its own item after this: the GA tags go live now; drafted privacy wording comes to you on its own preview for your yes (approved as recommended)";
const TEXT = `${REQUEST}\n${ANSWER}`;
const items = (note: string) => [
  { item: "GA4 base tag on westpeek.ventures", state: "done", done_when: [{ check: "exactly one tag per page", met: true }] },
  { item: "Privacy pages naming Google Analytics (and Clarity)", state: "not_done", done_when: [{ check: "privacy pages drafted and previewed", met: false, note }] },
];
const REAL_NOTE = "Partner's answer: \"Yes, as its own item after this: the GA tags go live now; drafted privacy wording comes to you on its own preview for your yes\"";

describe("an item the approved answer split off is its own job, not this build's (18 Nov 2026)", () => {
  it("the real report passes the v1.0 bar and names the item to file as its own job", () => {
    expect(buildProblems({ items: items(REAL_NOTE), partnerText: TEXT })).toEqual([]);
    expect(splitOffItems(items(REAL_NOTE), TEXT)).toEqual([{ item: "Privacy pages naming Google Analytics (and Clarity)", words: expect.stringContaining("its own item after this") }]);
  });
  it("split-off words nobody wrote, no quote, or no split-off words are still refused and filed nowhere", () => {
    for (const note of [
      "Partner's answer: \"Yes, as its own item after the launch party next spring\"",
      "to do as its own item",
      "Partner's answer: \"the GA tags go live now; drafted privacy wording\"",
    ]) {
      expect(buildProblems({ items: items(note), partnerText: TEXT }), note).toHaveLength(1);
      expect(splitOffItems(items(note), TEXT), note).toEqual([]);
    }
  });
});
