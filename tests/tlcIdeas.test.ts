import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { PLAYBOOK_DOCUMENT_SETTING, TLC_ALTERNATIVES, topicsEmailProblems } from "../src/shared/tlc/learningClub";
import { buildBookingPackPrompt, buildBrandBatchPrompt, buildTopicsPrompt, buildTrendPrompt, ideasFor, ideasFoundIn, openTopicsCard, openTrendStoryCard, runTlcCard, storedPlaybook, upsertIdea } from "../src/worker/services/learningClub";
import { sweepOnce } from "../src/worker/services/workSweep";

/**
 * THE IDEAS LIST AND THE PLAYBOOK (owner, 22 Oct 2026). What has to be true:
 *  - every idea carries where it came from (Partner idea / Brands spending now / Trend), in the email, on the
 *    card and on the list; an unlabelled pick or alternative is never sent;
 *  - an idea is never deleted or hidden: a partner sets it aside and it stays listed;
 *  - an idea a partner wrote down is captured when Parker reads it — only when his quote is really in her words;
 *  - Parker weighs partner ideas on merit: nothing forces one into the email;
 *  - every TLC prompt carries the playbook stored in Documents, not a copy in code.
 */

let t: TestDb;
let env: Env;
const NOW = new Date("2026-10-22T21:00:00.000Z");
beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs } as Partial<Env>);
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_parker','aie_wynn')").run();
});
afterAll(async () => { await disposeTestDb(t); });

describe("origin labels", () => {
  it("an alternative or pick with no origin label is never sent", () => {
    const picks = ["2027-01", "2027-02", "2027-03"].map((m) => ({ month: m, topic: `T ${m}`, origin: "TREND" as const, angle: "a", categories: ["c"], onePagerUrl: "https://os.joinwestpeek.com/x" }));
    const alts = Array.from({ length: TLC_ALTERNATIVES }, (_, i) => ({ topic: `A${i}`, origin: "BRANDS_SPENDING" as const, reason: "r.", brands: ["b"] }));
    expect(topicsEmailProblems(["2027-01", "2027-02", "2027-03"], picks, alts)).toEqual([]);
    const bad = [...alts.slice(1), { ...alts[0]!, origin: "WHO_KNOWS" as never }];
    expect(topicsEmailProblems(["2027-01", "2027-02", "2027-03"], picks, bad).join()).toMatch(/no origin label/);
  });
});

describe("the ideas list", () => {
  it("keeps who and where an idea came from, even when research finds it again; never deletes", async () => {
    await upsertIdea(env, { topic: "Peptides and biohacking", origin: "OWNER_IDEA", suggestedBy: "Sequoia", suggestedAt: "2026-10-13T22:09:33.357Z", preferredMonth: "2027-01", note: "New Year, new me" });
    await upsertIdea(env, { topic: "peptides & biohacking", origin: "TREND", suggestedBy: "Wynn", suggestedAt: NOW.toISOString(), status: "ALTERNATIVE" });
    const [idea] = await ideasFor(env);
    expect(idea).toMatchObject({ topic: "Peptides and biohacking", origin: "OWNER_IDEA", suggested_by: "Sequoia", status: "ALTERNATIVE", preferred_month: "2027-01" });
    await expect(env.WP_OS_DB.prepare("DELETE FROM tlc_idea WHERE id = ?1").bind(idea!.id).run()).rejects.toThrow(/never deleted/);
    // Set aside, it stays listed and stays set aside when Parker's run touches it again.
    await env.WP_OS_DB.prepare("UPDATE tlc_idea SET status = 'DROPPED', dropped_by = 'fu_sequoia_taylor', dropped_at = ?2 WHERE id = ?1").bind(idea!.id, NOW.toISOString()).run();
    await upsertIdea(env, { topic: "Peptides and biohacking", origin: "TREND", suggestedBy: "Parker", suggestedAt: NOW.toISOString(), status: "PICKED", month: "2027-01" });
    expect((await ideasFor(env)).map((i) => [i.topic, i.status])).toEqual([["Peptides and biohacking", "DROPPED"]]);
    await env.WP_OS_DB.prepare("UPDATE tlc_idea SET status = 'LATER', dropped_by = NULL, dropped_at = NULL WHERE id = ?1").bind(idea!.id).run();
  });

  it("captures an idea from a partner's words only when the quote is really there", () => {
    const words = [{ who: "Sequoia", at: "2026-10-13T22:09:33.357Z", ref: "wc_x", text: "Cymbiotika may want to sponsor a room\nWhere we get together IRL to learn about Peptides and Biohacking" }];
    const found = ideasFoundIn([{ topic: "Peptides & Biohacking", quote: "learn about Peptides and Biohacking" }, { topic: "Invented", quote: "something she never wrote" }], words);
    expect(found).toEqual([{ topic: "Peptides & Biohacking", who: "Sequoia", at: "2026-10-13T22:09:33.357Z", ref: "wc_x", quote: "learn about Peptides and Biohacking" }]);
  });

  it("Parker reads the list first, weighs it on merit, and the list says where each idea stands with its label", async () => {
    await upsertIdea(env, { topic: "Trading & Investing", origin: "OWNER_IDEA", suggestedBy: "Sequoia", suggestedAt: "2026-10-13T22:09:33.357Z" });
    const prompt = buildTopicsPrompt(["2027-01"], [], {}, { ideas: await ideasFor(env) });
    expect(prompt).toMatch(/THE IDEAS LIST — read this FIRST/);
    expect(prompt).toContain("Peptides and biohacking [Partner idea; Sequoia, 2026-10-13] (preferred: January 2027)");
    expect(prompt).toMatch(/you decide/);
    expect(prompt).not.toMatch(/must be (a pick|one of)/i);

    const opened = await openTopicsCard(env, NOW);
    const months = ["2027-01", "2027-02", "2027-03"];
    const text = JSON.stringify({
      picks: months.map((m, i) => ({
        month: m, topic: ["Trading & Investing", "Matcha Lab", "Film Walks"][i], origin: ["BRANDS_SPENDING", "BRANDS_SPENDING", "TREND"][i], angle: "an angle", why_now: "w", hands_on: "h", take_home: "t", teacher_profile: "p",
        regulatory_note: i === 0 ? "Card-only note: brokerages need FINRA-reviewed copy." : "",
        sponsor_categories: ["A", "B", "C", "D", "E"].map((c) => ({ category: c, why: "", example_brands: [] })), sources: [{ title: "s", url: `https://news.example/${i}` }],
      })),
      // Peptides is weighed and left out entirely: allowed.
      alternatives: Array.from({ length: TLC_ALTERNATIVES }, (_, i) => ({ topic: `Alt ${"ABCDEFGHI"[i]}`, origin: i % 2 ? "TREND" : "BRANDS_SPENDING", reason: "r", brands: ["b"] })),
      found_ideas: [],
    });
    const prompts: string[] = [];
    const out = await sweepOnce(env, NOW, { tlc: (e, c) => runTlcCard(e, c, { search: async (_e, _a, p) => { prompts.push(p); return { ok: true, text, detail: "ok" }; }, urlCheck: async () => true, now: NOW }) });
    expect(out.outcome).toBe("PROGRESSED");
    // ONE SEARCH PER MONTH, THEN ONE FOR THE ALTERNATIVES: each small enough to finish inside the seat's limit.
    expect(prompts.map((p) => (/Give exactly 9 ALTERNATIVE/.test(p) ? "alternatives" : /Pick ONE topic for each of these months: (\w+ \d{4})\./.exec(p)?.[1]))).toEqual(["January 2027", "February 2027", "March 2027", "alternatives"]);
    expect(prompts[0]).not.toMatch(/ALTERNATIVE topics/);
    expect(prompts[3]).not.toMatch(/Pick ONE topic/);
    expect(prompts[3]).toContain("The picks are already made: Trading & Investing; Matcha Lab; Film Walks.");
    const ideas = await ideasFor(env);
    const by = (t: string) => ideas.find((i) => i.topic === t)!;
    // A partner's idea stays labelled theirs even though the model called it brands-spending.
    expect(by("Trading & Investing")).toMatchObject({ origin: "OWNER_IDEA", status: "PICKED", status_month: "2027-01" });
    expect(by("Matcha Lab")).toMatchObject({ origin: "BRANDS_SPENDING", status: "PICKED", status_month: "2027-02" });
    expect(by("Alt B")).toMatchObject({ origin: "TREND", status: "ALTERNATIVE" });
    expect(by("Peptides and biohacking")).toMatchObject({ origin: "OWNER_IDEA", status: "LATER" });
    const card = await env.WP_OS_DB.prepare("SELECT description FROM work_card WHERE id = ?1").bind(opened.cardId).first<{ description: string }>();
    expect(card!.description).toContain("2027-01 Trading & Investing [Partner idea]");
    expect(card!.description).toContain("Alt B [Trend]");
    expect(card!.description).toContain("Regulatory check (card only, never emailed): Trading & Investing: Card-only note");
  });
});

describe("the playbook", () => {
  it("every TLC prompt carries the copy stored in Documents", async () => {
    expect(await storedPlaybook(env)).toBeNull();
    const body = "# The Learning Club Playbook\nSTORED-PLAYBOOK-MARKER: sponsors never buy access to members.";
    const key = "west-peek/doc_tlc_playbook/v1-test";
    await t.docs.put(key, body);
    await env.WP_OS_DB.prepare("INSERT INTO document (id, title, doc_type, firm_scope, current_version_id, uploaded_by) VALUES ('doc_tlc_playbook', 'The Learning Club Playbook', 'OTHER', 'west-peek', 'dver_tlc_playbook_1', 'fu_sequoia_taylor')").run();
    await env.WP_OS_DB.prepare("INSERT INTO document_version (id, document_id, version_no, r2_key, sha256, size_bytes, content_type, created_by) VALUES ('dver_tlc_playbook_1', 'doc_tlc_playbook', 1, ?1, 'x', 10, 'text/markdown', 'fu_sequoia_taylor')").bind(key).run();
    await env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value, set_by) VALUES (?1, 'doc_tlc_playbook', 'test')").bind(PLAYBOOK_DOCUMENT_SETTING).run();
    const stored = await storedPlaybook(env);
    expect(stored).toContain("STORED-PLAYBOOK-MARKER");
    for (const p of [
      buildTopicsPrompt(["2027-01"], [], {}, { playbook: stored }),
      buildBookingPackPrompt({ topic: "x", event_date: "2027-01-16", slot: "AFTERNOON" }, stored),
      buildBrandBatchPrompt([], [], stored),
      buildTrendPrompt(stored),
    ]) {
      expect(p).toContain("THE PLAYBOOK (the owner's approved copy, read from Documents");
      expect(p).toContain("STORED-PLAYBOOK-MARKER");
    }
    // And the runner itself hands the stored copy to the search.
    let seen = "";
    const trend = await openTrendStoryCard(env, NOW);
    await runTlcCard(env, (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(trend.cardId).first())! as never, { search: async (_e, _a, prompt) => { seen = prompt; return { ok: false, text: "", detail: "model refused" }; }, now: NOW });
    expect(seen).toContain("STORED-PLAYBOOK-MARKER");
  });
});
