import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { DELIVERABLES, driftLine, driftSection, markMonthlyRead, monthlyRead, recordFloor } from "../src/worker/services/floorLog";
import { monthlyFloor } from "../src/worker/services/productions";
import { sponsorFloor } from "../src/worker/services/roomPacket";
import { wayInListing, wayInWords } from "../src/shared/tlc/mustPitch";
import { whyIsMissing } from "../src/worker/services/meetingBrief";

/* DRIFT PREVENTION (owner, 13 Nov 2026). Every name, organisation and sentence here is made up. */

describe("the weekly drift line", () => {
  const w = (n: number, headline: number, ok = true) => ({ week: `2027-W${String(n).padStart(2, "0")}`, headline, ok });

  it("a steady week reads against its best and its last four, and is not flagged", () => {
    const out = driftLine("Made-up search", "people", [w(1, 4), w(2, 6), w(3, 5), w(4, 5)], "2027-W04");
    expect(out).toEqual({ line: "Made-up search: 5 people in the last 7 days; best 6 (week to 2027-W02); last 4 measured: 4, 6, 5, 5.", flagged: false });
  });

  it("one bad week is not drift; two weeks running more than 25% below the best is; a floor miss is flagged at once", () => {
    expect(driftLine("X", "u", [w(1, 8), w(2, 8), w(3, 5)], "2027-W03").flagged, "one week below").toBe(false);
    const two = driftLine("X", "u", [w(1, 8), w(2, 5), w(3, 5)], "2027-W03");
    expect(two.flagged).toBe(true);
    expect(two.line).toMatch(/DRIFTING: more than 25% below its best two weeks running\.$/);
    expect(driftLine("X", "u", [w(1, 8), w(2, 6), w(3, 6)], "2027-W03").flagged, "exactly 25% below is not more than 25%").toBe(false);
    const miss = driftLine("X", "u", [w(1, 8), w(2, 8), w(3, 7, false)], "2027-W03");
    expect(miss).toMatchObject({ flagged: true });
    expect(miss.line).toMatch(/BELOW ITS FLOOR\.$/);
  });

  it("a week with no measure says 'not measured', with the last one it has, and is never left out", () => {
    expect(driftLine("X", "u", [w(1, 8)], "2027-W03").line).toBe("X: not measured in the last 7 days (last: 8 u, week to 2027-W01).");
    expect(driftLine("Prep", "% of meetings with a reason", [w(1, 50), w(2, 75)], "2027-W02").line).toBe("Prep: 75% of meetings with a reason in the last 7 days; best 50 (week to 2027-W01); last 2 measured: 50, 75.");
    expect(driftLine("X", "u", [w(3, 5)], "2027-W03").line).toBe("X: 5 u in the last 7 days; the first measured week.");
    expect(driftLine("X", "u", [], "2027-W03").line).toBe("X: not measured yet, no run since measuring began (13 Nov 2026).");
  });
});

describe("the measures are stored per run and read back into the roundup's section", () => {
  let t: TestDb;
  let env: Env;
  beforeAll(async () => { t = await createTestDb(); env = makeTestEnv(t.db); });
  afterAll(async () => { await disposeTestDb(t); });
  const NOW = new Date("2027-02-08T15:00:00.000Z");

  it("every deliverable has a row every week; a measured one shows this week against its best, a missed floor is counted", async () => {
    const empty = await driftSection(env, NOW);
    expect(empty.label).toBe("Quality of the work: nothing was measured in the last 7 days");
    expect(empty.bullets).toHaveLength(Object.keys(DELIVERABLES).length);
    expect(empty.bullets.every((b) => /not measured yet, no run since measuring began \(13 Nov 2026\)\.$/.test(b)), "nothing measured is said, not hidden").toBe(true);

    await recordFloor(env, { deliverable: "hire_search", ok: true, headline: 4, measures: { kept: 5, at_floor: 4 }, sample: "fit 8: sold sponsorships at a made-up agency", at: new Date(Date.now() - 9 * 86_400_000) }); // the week before
    await recordFloor(env, { deliverable: "hire_search", ok: false, headline: 1, measures: { kept: 6, at_floor: 1 }, sample: "fit 4: a made-up profile with no selling shown" });
    const stored = (await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE event_type = 'floor.measured' AND object_id = 'hire_search' ORDER BY rowid").all<{ payload_json: string }>()).results!;
    expect(stored).toHaveLength(2);
    expect(JSON.parse(stored[1]!.payload_json)).toMatchObject({ ok: false, headline: 1, measures: { kept: 6, at_floor: 1 } });

    const out = await driftSection(env, new Date());
    expect(out.bullets).toHaveLength(Object.keys(DELIVERABLES).length);
    const hire = out.bullets.find((b) => b.startsWith("Weekly hire search (Productions)"))!;
    expect(hire).toMatch(/1 people at the floor in the last 7 days; best 4 \(week to \d{4}-\d\d-\d\d\)/);
    expect(hire).toMatch(/BELOW ITS FLOOR\.$/);
    expect(out.flagged).toBe(1);
    expect(out.label).toBe("Quality of the work: 1 to look at");
  });

  it("the monthly read: a seat compares the latest with the best; a seat that is away is said and retried; once sent it is not asked again that month", async () => {
    const prompts: string[] = [];
    const away = await monthlyRead(env, new Date(), "west-peek", async () => ({ ok: false, text: "", detail: "seat_wait_important_work: neither seat is free right now" }));
    expect(away).toMatchObject({ done: false });
    expect(away!.bullets[0]).toMatch(/^Not read this week: no seat was free to read it, and it never goes to a free or paid model\. It is tried again next Monday\.$/);
    const read = await monthlyRead(env, new Date(), "west-peek", async (_e, prompt) => { prompts.push(prompt); return { ok: true, text: "Weekly hire search (Productions): WORSE than its best, no selling is shown on any page.", detail: "ok" }; });
    expect(read).toMatchObject({ done: true, bullets: ["Weekly hire search (Productions): WORSE than its best, no selling is shown on any page."] });
    expect(prompts[0]).toContain("BEST EXAMPLE:\nfit 8: sold sponsorships at a made-up agency");
    expect(prompts[0]).toContain("LATEST:\nfit 4: a made-up profile with no selling shown");
    await markMonthlyRead(env, new Date(), "west-peek", read!.bullets);
    expect(await monthlyRead(env, new Date(), "west-peek", async () => { throw new Error("must not be asked twice in a month"); })).toBeNull();
  });
});

describe("GOLDEN REPLAY: each floor still passes its stored best example and still fails the run it was written to catch", () => {
  // Runs in CI on every change, so a change to a floor, a prompt's parsed shape or a route's handling that would let
  // the bad run through, or turn the good one away, fails here before it ships. It does not call a model.
  // The hire search's own replay (the 22 Sep standard and the 2026-W46 list, masked) is in productionsHire.test.ts.
  it("the monthly note, sponsor research, the way-in list and the prep's reason", () => {
    expect(monthlyFloor(9, 3).ok).toBe(true);
    expect(monthlyFloor(0, 4).ok).toBe(false);
    const sponsor = (n: number) => ({ orgName: `Made-up Sponsor ${n}`, contact: { name: `Person ${n}`, title: "Partnerships", sourceUrl: `https://s${n}.example` }, evidence: [] });
    expect(sponsorFloor([1, 2, 3, 4, 5, 6].map(sponsor) as never).ok).toBe(true);
    expect(sponsorFloor([1, 2, 3, 4, 5, 6].map(sponsor) as never, ["Made-up Sponsor 1", "Made-up Sponsor 2", "Made-up Sponsor 3"]).ok).toBe(false);
    const item = { brand: "Made-up Brand", months: ["2027-01"], pages: [] };
    expect(wayInListing(item, 7)).toBe(wayInWords(item));
    expect(wayInListing(item, 28)).toBeNull();
    const brief = { record: { about: "COMPANY" as const, name: "Made-up Co", summary: null, stage: null, touches: [] }, find_out: [], last_time: { firm: [], counterparty: [] }, diligence: null };
    expect(whyIsMissing(brief)).not.toBeNull();
    expect(whyIsMissing({ ...brief, record: { ...brief.record, stage: "DILIGENCE" } })).toBeNull();
  });

});
