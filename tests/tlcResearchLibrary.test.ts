import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { addResearch, buildBookingPackPrompt, buildBrandBatchPrompt, buildTopicsPrompt, libraryBlock, openTrendStoryCard, researchLibrary, runTlcCard } from "../src/worker/services/learningClub";

/**
 * THE RESEARCH LIBRARY (owner, 22 Oct 2026). What has to be true: Wynn's trend story lands in the library —
 * the story and each fact with its source and date — and NOBODY is emailed about it; every entry is dated
 * and labelled by kind; nothing is deleted; and the prompts that build or sell a club carry the library.
 */

let t: TestDb;
let env: Env;
const NOW = new Date("2026-10-22T22:00:00.000Z");
const sends: string[] = [];
beforeAll(async () => {
  t = await createTestDb();
  env = { ...makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>), RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Env;
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_parker','aie_wynn')").run();
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) { sends.push(String(init?.body)); return new Response(JSON.stringify({ id: "re_x" }), { status: 200 }); }
    return new Response("ok", { status: 200 });
  });
});
afterAll(async () => { vi.unstubAllGlobals(); await disposeTestDb(t); });

describe("the research library", () => {
  it("Wynn's trend story goes to the library, fact by fact with sources and dates, and emails nobody", async () => {
    const opened = await openTrendStoryCard(env, NOW);
    const card = (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(opened.cardId).first())!;
    const text = JSON.stringify({
      story: "People are gathering to learn one thing together [1][2][3].",
      sources: [1, 2, 3].map((i) => ({ title: `Source ${i}`, publisher: "Pub", url: `https://news.example/${i}`, published_on: `2026-0${i}-01`, claim: `Fact ${i}` })),
      topic_ideas: [{ topic: "Run clubs", origin: "BRANDS_SPENDING", reason: "Shoe brands are sponsoring city run clubs this fall.", source_url: "https://news.example/run", source_title: "Run piece" }],
    });
    const out = await runTlcCard(env, card as never, { search: async () => ({ ok: true, text, detail: "ok" }), urlCheck: async () => true, now: NOW });
    expect(out.finished).toBe(true);
    expect(sends).toHaveLength(0);
    const lib = await researchLibrary(env);
    expect(lib.map((r) => [r.kind, r.title]).sort()).toEqual([
      ["BRAND_SPEND", "Shoe brands are sponsoring city run clubs this fall."],
      ["TREND_STORY", "Fact 1"], ["TREND_STORY", "Fact 2"], ["TREND_STORY", "Fact 3"],
      ["TREND_STORY", "Trend story 2026-Q4"],
    ]);
    const fact = lib.find((r) => r.title === "Fact 2")!;
    expect(fact).toMatchObject({ source_url: "https://news.example/2", published_on: "2026-02-01", found_by: "Wynn" });
    await expect(env.WP_OS_DB.prepare("DELETE FROM tlc_research WHERE id = ?1").bind(fact.id).run()).rejects.toThrow(/nothing is deleted/);
  });

  it("the prompts that build or sell a club carry the library, dated and labelled", async () => {
    await addResearch(env, { kind: "REGULATORY", topic: "Peptides and biohacking", title: "LIBRARY-MARKER: supplement brands may not make disease claims.", foundAt: NOW.toISOString(), foundBy: "Parker" });
    const lib = await researchLibrary(env);
    const block = libraryBlock(lib);
    expect(block).toContain("[Regulatory check, 2026-10-22] Peptides and biohacking: LIBRARY-MARKER");
    expect(block).toContain("[Trend story, 2026-02-01] Fact 2 (https://news.example/2)");
    for (const p of [
      buildTopicsPrompt(["2027-01"], [], {}, { library: lib }),
      buildBookingPackPrompt({ topic: "x", event_date: "2027-01-23", slot: "AFTERNOON" }, null, lib),
      buildBrandBatchPrompt([], [], null, lib),
    ]) expect(p).toContain("LIBRARY-MARKER");
    // And the runner hands the stored library to the search, not an empty one.
    let seen = "";
    const opened = await openTrendStoryCard(env, new Date("2027-01-05T10:00:00Z"));
    const card = (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(opened.cardId).first())!;
    await runTlcCard(env, card as never, { search: async (_e, _a, prompt) => { seen = prompt; return { ok: false, text: "", detail: "model refused" }; }, now: NOW });
    expect(seen).toContain("LIBRARY-MARKER");
  });
});
