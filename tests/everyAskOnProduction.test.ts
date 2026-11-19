import { describe, expect, it } from "vitest";
import { buildProblems } from "../src/shared/work/everyAsk";

/** 19 Nov 2026 (wc_59ef2d40): a check that can only be met on production is LAND's, never an unfinished preview build. */
describe("a done-when check whose place is production is judged at LAND", () => {
  const item = (check: string, note = "") => ({ item: "Inquiries shows '[email protected]'", state: "done", done_when: [{ check: "A test fails if any address sits outside the markers", met: true }, { check, met: false, note }] });
  it("the refused build of wc_59ef2d40 passes", () => {
    expect(buildProblems({ items: [item("The markers reach production and the address reads correctly on the live site", "Cloudflare only obfuscates on the proxied production host; LAND checks it after the merge")] })).toEqual([]);
  });
  it.each(["Confirmed on the live dashboard", "Checked against production", "Some live check"])("named for production or by its note: %s", (check) => {
    expect(buildProblems({ items: [item(check, check === "Some live check" ? "LAND confirms it on the real host" : "")] })).toEqual([]);
  });
  it("an unmet preview check is still refused", () => {
    expect(buildProblems({ items: [item("On the preview the address is plain text and a tap opens mail", "not done yet")] })).toHaveLength(1);
  });
});
