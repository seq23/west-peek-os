import { describe, expect, it } from "vitest";
import { previewNotice } from "../src/shared/work/porterNotices";
import { readLocalJobReport } from "../src/shared/work/localJobs";
import { buildAnswersText } from "../src/worker/services/webPropertyChange";
import { answersOf } from "../scripts/duties/web-property-change.mjs";

/*
 * wc_9f7312e4, 27-28 Nov 2026. Scooter asked Porter six questions in his community-site emails (how he would sequence
 * the Give and Take build, how fast a Luma event appears and whether finished ones drop off, whether the tile can show
 * the feed's title and date, how the podcast feed is matched, whether a verified-email step fits and would cost
 * anything). The BUILD answered all six, but in `proof`, which no partner email shows. The preview marked each ask
 * "Done" and Scooter got none of the answers. Each answer now travels as its own row and leads the preview.
 */
const ROWS = [
  { question: "Tell me how you would sequence the build.", answer: "Ask box and review first, then the board, then private offers, then intros by hand." },
  { question: "Please confirm how fast a new Luma event appears and that finished events drop off.", answer: "Within about 15 minutes; an event stays until it ends and drops off within 15 minutes after." },
  { question: "Could you tell me whether a light verified-email step fits the site, what you would reuse, and whether anything new or paid would be needed?", answer: "It fits. It reuses the Resend sending in lead.js, the signing key and Turnstile. Nothing new or paid." },
];

describe("his questions reach him with their answers (28 Nov 2026)", () => {
  it("the Mac's report keeps every whole row and drops a row missing either half", () => {
    const out = answersOf({ answers: [...ROWS, { question: "Only a question" }, { answer: "Only an answer" }, "junk"] });
    expect(out).toEqual(ROWS);
    expect(answersOf({})).toEqual([]);
  });

  it("the Worker reads the rows off the report as written", () => {
    const { report } = readLocalJobReport(JSON.stringify({ phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/x/pull/1", answers: [...ROWS, { question: "q" }] }));
    expect(report?.answers).toEqual(ROWS);
  });

  it("the answers lead the text, each with its question, before the done-lines", () => {
    const text = buildAnswersText({ answers: ROWS, items: [{ item: "Homepage tiles", state: "done", done_when: [{ check: "six tiles", met: true }] }], notes: "one line" })!;
    const lines = text.split("\n");
    expect(lines[0]).toBe(`• Answered: "${ROWS[0]!.question}" — ${ROWS[0]!.answer}`);
    expect(lines[2]).toContain("Nothing new or paid.");
    expect(lines[3]).toBe("• Done: Homepage tiles");
  });

  it("the preview email carries every answer word for word", () => {
    const email = previewNotice({ title: "Community site redesign", previewLine: "https://work.example.pages.dev", placeholders: [], cardId: "wc_x", answers: buildAnswersText({ answers: ROWS }) });
    const all = email.sections.flatMap((s) => s.bullets).join("\n");
    for (const r of ROWS) {
      expect(all).toContain(r.question);
      expect(all).toContain(r.answer);
    }
  });

  it("many answered questions are never cut at the old 4,000 characters", () => {
    const long = Array.from({ length: 8 }, (_, i) => ({ question: `Question ${i + 1}?`, answer: `Answer ${i + 1}. `.padEnd(900, "x") }));
    const text = buildAnswersText({ answers: long })!;
    expect(text).toContain("Answer 8.");
  });
});
