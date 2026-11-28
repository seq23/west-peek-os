import { describe, expect, it } from "vitest";
import { buildProblems, reviewRuling, splitOffItems } from "../src/shared/work/everyAsk";
import { readLocalJobReport } from "../src/shared/work/localJobs";
import { buildAnswersText } from "../src/worker/services/webPropertyChange";
import { notHeldFindings, readReview, reviewAndFix, reviewHoldsOf } from "../scripts/duties/web-property-change.mjs";

/*
 * wc_9f7312e4, 28 Nov 2026. Scooter asked for homepage items 1-7 and said "I don't want one to hold up the other". The
 * BUILD (PR join-west-peek-main#44, green, reviewed) finished them, built Give and Take behind a closed switch, and
 * reported two checks it could not meet in this repo, each put to him with a recommendation. The keyword bar refused
 * the whole build, so his homepage preview never came. The fresh-eyes review now rules on each unmet check.
 */
const done = (item: string) => ({ item, state: "done", done_when: [{ check: `${item} is on the preview`, met: true }] });
const H8 = "8h. Form answers kept 24 months after a form closes, then deleted";
const H8C = "Form answers are deleted 24 months after a form closes";
const I8 = "8i. A preview of the Network OS side";
const I8C = "A Give and Take screen inside Network OS";
const ITEMS = [
  ...["1. Sign-up form", "2. Header wordmark", "3. About", "4. Core Values", "6. Pitch competitions", "7. Ila's headshot"].map(done),
  { item: H8, state: "not_done", done_when: [{ check: H8C, met: false, note: "This site keeps no form answers of its own; they live in his email and in Network OS, which this repo cannot reach. Put to him in answers with a recommendation." }] },
  { item: I8, state: "partial", done_when: [{ check: "He can see the review queue working on fake entries", met: true }, { check: I8C, met: false, note: "Not built (another repo). Put to him in answers with a recommendation: not for launch." }] },
];
const HOLDS = [
  { item: H8, check: H8C, held: true, by: "partner", why: "This site keeps no form answers; where they are deleted is your call for Network OS, and I recommended a rule." },
  { item: I8, check: I8C, held: true, by: "another_job", why: "A Give and Take screen lives in Network OS, another system; I recommend it after launch." },
];

describe("the fresh-eyes review rules what holds an unmet check (28 Nov 2026, wc_9f7312e4)", () => {
  it("the refused build of wc_9f7312e4 passes with the review's holds, and 8i is filed as its own job", () => {
    expect(buildProblems({ items: ITEMS, reviewHolds: HOLDS })).toEqual([]);
    expect(splitOffItems(ITEMS, HOLDS)).toEqual([{ item: I8, words: HOLDS[1]!.why, on_card: null }]);
  });
  it("without the holds the same report is refused on exactly 8h and 8i", () => {
    const p = buildProblems({ items: ITEMS });
    expect(p).toHaveLength(2);
    expect(p[0]).toContain("8h.");
    expect(p[1]).toContain("8i.");
  });
  it("an another_job hold that names the open card already carrying it says so, so it is never filed twice", () => {
    const owned = [HOLDS[0]!, { ...HOLDS[1]!, on_card: "wc_e1d13d5c-4e5f-4678-97a2-6f4fdf63a1a2" }];
    expect(splitOffItems(ITEMS, owned)).toEqual([{ item: I8, words: HOLDS[1]!.why, on_card: "wc_e1d13d5c-4e5f-4678-97a2-6f4fdf63a1a2" }]);
    expect(splitOffItems(ITEMS, [HOLDS[0]!, { ...HOLDS[1]!, on_card: "not a card; DROP TABLE" }])[0]!.on_card, "only a card id counts").toBeNull();
    const v = readReview(JSON.stringify({ findings: [], holds: [{ ...HOLDS[1], on_card: "wc_abc" }, { ...HOLDS[0], on_card: "wc_abc" }] }))!;
    expect(v.holds[0]!.on_card).toBe("wc_abc");
    expect(v.holds[1]!.on_card, "only another_job carries a card").toBeUndefined();
  });
  it("a hold excuses only the check it names: one for 8h does not excuse 8i", () => {
    const p = buildProblems({ items: ITEMS, reviewHolds: [HOLDS[0]!] });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("8i.");
    expect(reviewRuling([HOLDS[0]!], I8, H8C)).toBeNull();
  });
  it("a done item needs no ruling; a ruling survives case, spacing and a cut at 200 characters", () => {
    expect(buildProblems({ items: ITEMS.slice(0, 6) })).toEqual([]);
    const long = `${"Every page carries the wordmark and the olive period at 390px and on desktop, ".repeat(4)}end`;
    const items = [{ item: "Wordmark", state: "partial", done_when: [{ check: long, met: false }] }];
    expect(buildProblems({ items, reviewHolds: [{ item: "  wordmark ", check: long.slice(0, 200).toUpperCase(), held: true, by: "landing", why: "Only the live host shows it." }] })).toEqual([]);
    expect(buildProblems({ items, reviewHolds: [{ item: "Wordmark", check: "Every page", held: true, by: "landing", why: "x" }] }), "a short fragment matches nothing").toHaveLength(1);
  });
  it("the preview email names each held item with the review's why", () => {
    const text = buildAnswersText({ items: ITEMS, review_holds: HOLDS } as never)!;
    expect(text).toContain(`• Waiting on you: ${H8} — ${HOLDS[0]!.why}`);
    expect(text).toContain(`• Its own job, not in this preview: ${I8} — ${HOLDS[1]!.why}`);
    expect(text).toContain("• Done: 1. Sign-up form");
  });
  it("the report reader carries review_holds, a malformed ruling read as not held", () => {
    const { report } = readLocalJobReport(JSON.stringify({ phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/x/pull/1", items: ITEMS, review_holds: [...HOLDS, { item: H8, check: H8C, held: "yes" }] }));
    expect(report!.review_holds).toHaveLength(3);
    expect(report!.review_holds![2]!.held).toBe(false);
  });
});

describe("the runner: the review's holds, never the builder's, reach the Worker", () => {
  const file = (holds: unknown[]) => JSON.stringify({ summary: "ok", findings: [], holds });
  it("readReview parses holds; held only with a known reason and a why", () => {
    const v = readReview(file([...HOLDS, { item: "A", check: "B", held: true, by: "because", why: "x" }, { item: "A", check: "C", held: true, by: "partner", why: "" }]))!;
    expect(v.holds.map((h: { held: boolean }) => h.held)).toEqual([true, true, false, false]);
    expect(readReview(JSON.stringify({ findings: [] }))!.holds).toEqual([]);
  });
  it("a ruling of not held goes back to the builder as a blocking finding, and the passing review's holds are returned", async () => {
    expect(notHeldFindings([{ item: H8, check: H8C, held: false, why: "the code can delete them" }])[0]).toMatchObject({ blocking: true, lens: "pm" });
    let rebuilds = 0;
    const out = await reviewAndFix({
      review: async (round: number) => ({ verdict: readReview(file(round === 0 ? [{ ...HOLDS[0], held: false }] : HOLDS)) }),
      rebuild: async () => (rebuilds++, {}),
    });
    expect(rebuilds).toBe(1);
    expect(out.holds).toHaveLength(2);
    expect(out.holds!.every((h: { held: boolean }) => h.held)).toBe(true);
  });
  it("reviewHoldsOf reads only the runner's field, bounded", () => {
    expect(reviewHoldsOf({ review_holds: HOLDS })).toHaveLength(2);
    expect(reviewHoldsOf({ items: ITEMS })).toEqual([]);
  });
});
