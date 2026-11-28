import { describe, expect, it } from "vitest";
import { buildProblems } from "../src/shared/work/everyAsk";

/** 19 Nov 2026 (wc_59ef2d40): a check that can only be met on production is LAND's, never an unfinished preview build. */
describe("a done-when check whose place is production is LAND's when the review rules so", () => {
  const ITEM = "Inquiries shows '[email protected]'";
  const PROD = "The markers reach production and the address reads correctly on the live site";
  const item = (check: string) => ({ item: ITEM, state: "done", done_when: [{ check: "A test fails if any address sits outside the markers", met: true }, { check, met: false, note: "LAND checks it after the merge" }] });
  it("the refused build of wc_59ef2d40 passes with the review's landing hold", () => {
    expect(buildProblems({ items: [item(PROD)], reviewHolds: [{ item: ITEM, check: PROD, held: true, by: "landing", why: "Cloudflare only rewrites the address on the live host." }] })).toEqual([]);
  });
  it("the same check with no ruling, or a preview check ruled not held, is refused", () => {
    expect(buildProblems({ items: [item(PROD)] })).toHaveLength(1);
    const preview = "On the preview the address is plain text and a tap opens mail";
    expect(buildProblems({ items: [item(preview)], reviewHolds: [{ item: ITEM, check: preview, held: false }] })).toHaveLength(1);
  });
});
