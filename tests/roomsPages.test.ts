import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createTestDb, disposeTestDb, makeTestEnv, splitSqlStatements, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { RouteContext } from "../src/worker/router";
import { sweepIdentity } from "../src/worker/services/workSweep";
import { handleTlcIdeaNote, handleTlcOverview, handleTlcResearchLinkAdd } from "../src/worker/services/learningClub";
import { backupMonthFor, dedupeIdeas, ideaKey, isSetAside, matchesFilter, matchesSearch, orderIdeas, previewIdeas, type IdeaLike } from "../src/shared/tlc/ideasView";
import { ALLOWED_BY_OWNER, NOT_PITCHING, TITLE_SPONSORS_TO_PITCH_FIRST, TITLE_SPONSOR_RESEARCH_URL } from "../src/shared/tlc/titleSponsors";
import { buildShelf, emailSnippet, plainTitle, shelfCount, type ShelfDoc } from "../src/shared/documents/shelf";

/**
 * THE ROOMS & EVENTS REDESIGN (owner approved the v8 mock-up, 23 Oct 2026) — the parts that are data
 * rather than layout. Layout is pinned in tests/roomsLayout.test.ts; the sponsor flow in
 * tests/roomSponsorsWaitForSchedule.test.ts.
 */

const MIGRATION = readFileSync(new URL("../migrations/0268_rooms_pages_idea_notes_research_links.sql", import.meta.url), "utf8");

const idea = (over: Partial<IdeaLike> & { id: string; topic: string }): IdeaLike => ({
  status: "LATER", status_month: null, suggested_at: "2026-10-22T10:00:00.000Z", suggested_by: "Sequoia", ...over,
});

describe("the ideas card shows each idea once, and never deletes", () => {
  const ideas: IdeaLike[] = [
    idea({ id: "a", topic: "The Record Room", status: "DROPPED", suggested_at: "2026-10-01T00:00:00.000Z" }),
    idea({ id: "b", topic: "The Record Room (November 2026 Room)", status: "DROPPED", suggested_at: "2026-10-01T00:00:01.000Z" }),
    idea({ id: "c", topic: "Sewing, matcha, day trading", status: "DROPPED" }),
    idea({ id: "d", topic: "Sewing, matcha, day trading (examples of learning-club topics)", status: "DROPPED" }),
    idea({ id: "e", topic: "The Longevity Reset", status: "PICKED", status_month: "2027-01" }),
    idea({ id: "f", topic: "Build Your Own AI Agent", status: "PICKED", status_month: "2027-03" }),
    idea({ id: "g", topic: "Fragrance Lab", status: "PICKED", status_month: "2027-02" }),
    idea({ id: "h", topic: 'Trading & Investing ("Money Reset")', status: "ALTERNATIVE" }),
    idea({ id: "i", topic: "Matcha & Tea", status: "ALTERNATIVE", notes: [{ body: "Matcha making.", author: "Sequoia", created_at: "2026-10-23T12:00:00.000Z" }] }),
    idea({ id: "j", topic: "Matcha & Tea: tasting and whisking", status: "LATER" }),
    idea({ id: "k", topic: "Ready for Anything: home emergency prep", suggested_at: "2026-10-23T09:00:00.000Z" }),
    idea({ id: "l", topic: "The Supplement Shootout", suggested_at: "2026-10-23T08:00:00.000Z" }),
    idea({ id: "m", topic: "Peptides and biohacking", status: "MERGED" }),
  ];

  it("folds the two real duplicates the mock-up found, and nothing else", () => {
    expect(ideaKey("The Record Room (November 2026 Room)")).toBe(ideaKey("The Record Room"));
    const entries = dedupeIdeas(ideas);
    expect(entries).toHaveLength(ideas.length - 2);
    const record = entries.find((e) => e.idea.id === "a")!;
    expect(record.alsoListed.map((x) => x.id)).toEqual(["b"]);
    expect(entries.find((e) => e.idea.id === "c")!.alsoListed.map((x) => x.id)).toEqual(["d"]);
    // Different ideas that share words stay apart.
    expect(entries.map((e) => e.idea.id)).toEqual(expect.arrayContaining(["i", "j"]));
  });

  it("prefers a live row over a set-aside one when an idea was filed twice", () => {
    const out = dedupeIdeas([idea({ id: "x1", topic: "Mahjong", status: "DROPPED", suggested_at: "2026-01-01" }), idea({ id: "x2", topic: "Mahjong (Saturday afternoon)", status: "ALTERNATIVE" })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.idea.id).toBe("x2");
  });

  it("orders picked by month, then alternatives, then later; the preview is the picked ones and the newest", () => {
    const live = orderIdeas(dedupeIdeas(ideas).filter((e) => !isSetAside(e.idea)));
    expect(live.slice(0, 3).map((e) => e.idea.id)).toEqual(["e", "g", "f"]);
    const preview = previewIdeas(live);
    expect(preview.map((e) => e.idea.id)).toEqual(["e", "g", "f", "k", "l", "h"]);
    expect(preview.every((e) => !isSetAside(e.idea))).toBe(true);
  });

  it("filters and searches, notes included", () => {
    const entries = dedupeIdeas(ideas);
    expect(entries.filter((e) => matchesFilter(e.idea, "set-aside")).map((e) => e.idea.id).sort()).toEqual(["a", "c", "m"]);
    expect(entries.filter((e) => matchesFilter(e.idea, "picked"))).toHaveLength(3);
    expect(entries.filter((e) => matchesSearch(e, "matcha making")).map((e) => e.idea.id)).toEqual(["i"]);
  });

  it("knows Trading & Investing is March's backup, Money Reset", () => {
    expect(backupMonthFor('Trading & Investing ("Money Reset")', [{ month: "2027-03", topic: "Money Reset" }])).toBe("2027-03");
    expect(backupMonthFor("Fragrance Lab", [{ month: "2027-03", topic: "Money Reset" }])).toBeNull();
  });
});

describe("Not pitching is the owner's list: sportsbooks out; prediction markets, Robinhood and full-body scans allowed", () => {
  it("never lists what she allowed, and says she allowed it", () => {
    const listed = NOT_PITCHING.map((n) => `${n.what} ${n.why}`).join(" ");
    for (const allowed of [/kalshi/i, /polymarket/i, /prediction/i, /robinhood/i, /full[- ]body/i, /neko/i]) expect(listed).not.toMatch(allowed);
    expect(listed).toMatch(/sportsbook/i);
    expect(ALLOWED_BY_OWNER).toMatch(/Prediction markets[\s\S]*Robinhood[\s\S]*full-body scans are allowed/);
    expect(NOT_PITCHING.length).toBe(7);
  });

  it("names a role, never a person or an address, for a title sponsor's way in", () => {
    const text = TITLE_SPONSORS_TO_PITCH_FIRST.map((t) => t.fit).join(" ");
    expect(text).not.toMatch(/@|https?:\/\//);
    expect(TITLE_SPONSORS_TO_PITCH_FIRST.map((t) => t.brand)).toEqual(expect.arrayContaining(["Anthropic", "Google for Startups / Cloud", "ElevenLabs"]));
    expect(TITLE_SPONSOR_RESEARCH_URL).toBe("https://claude.ai/artifact/7632jc1TJSg7wbMzMrYkbA");
  });
});

describe("Documents: a website change reads cleanly, and its plan is on the same row", () => {
  const req = { id: "doc_req", title: 'Change westpeek.ventures: "Hey Porter! Quick one - can you swap the Sensori photo on the s', doc_type: "BRIEF", created_at: "2026-09-22T00:18:00.000Z" };
  const plan = { id: "doc_plan", title: 'Plan: Change westpeek.ventures: "Hey Porter! Quick one - can you swap the Sensori photo on the s', doc_type: "BRIEF", created_at: "2026-09-22T00:03:00.000Z" };
  const lone = { id: "doc_lone", title: 'Plan: Change westpeek.ventures: "thanks -- yea i think i\'d like it to go to some database even i', doc_type: "BRIEF", created_at: "2026-09-22T13:46:00.000Z" };

  it("cuts a snipped email at a word, with …, and leaves a closed quote alone", () => {
    expect(plainTitle(req).title).toBe("Website change on westpeek.ventures: “Can you swap the Sensori photo on the…”");
    expect(plainTitle(req).title).not.toMatch(/the s”$/);
    expect(emailSnippet('Fix the footer link"')).toBe("Fix the footer link");
    expect(plainTitle(lone).title).toMatch(/…”$/);
  });

  it("pairs a request with its plan as one row, keeps an orphan plan as its own row, and counts every document", () => {
    const shelf = buildShelf([req, plan, lone] as ShelfDoc[], { now: new Date("2026-10-23T00:00:00Z") });
    const web = shelf.groups.find((g) => g.key === "website")!;
    expect(web.lines.map((l) => l.latest.doc.id)).toEqual(["doc_lone", "doc_req"]);
    expect(web.lines.find((l) => l.latest.doc.id === "doc_req")!.latest.plan!.doc.id).toBe("doc_plan");
    expect(shelfCount(shelf)).toBe(3);
    const page = readFileSync(new URL("../src/client/pages/DocumentsPage.tsx", import.meta.url), "utf8");
    expect(page).toContain("<summary>Plan ▾</summary>");
  });
});

describe("no raw ISO date or internal id on the four pages", () => {
  it("renders dates in words and people by name", () => {
    for (const f of ["RoomsPage", "LearningClubPanel", "RoomSponsorsPage", "EventsPage", "PartnersPanel", "ScheduleRoom"]) {
      const src = readFileSync(new URL(`../src/client/pages/${f}.tsx`, import.meta.url), "utf8");
      expect(src, `${f} shows an ISO date`).not.toMatch(/\.slice\(0, 10\)\}/);
      expect(src, `${f} shows a decided_by id`).not.toMatch(/\$\{p\.decided_by\}|\{p\.decided_by\}/);
      expect(src, `${f} shows a packet id`).not.toMatch(/\$\{s\.delivered_packet_id\}/);
    }
    const events = readFileSync(new URL("../src/client/pages/EventsPage.tsx", import.meta.url), "utf8");
    expect(events).toContain("<MarkdownDocument source={done.digest_md}");
    expect(events).not.toContain("{ev.starts_at}");
  });
});

describe("notes on ideas and research links are stored, with who and when", () => {
  let t: TestDb;
  let env: Env;
  const ctx = (path: string, body?: unknown, params: Record<string, string> = {}): RouteContext => ({
    request: new Request(`https://os.joinwestpeek.com${path}`, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } }),
    env,
    identity: { ...sweepIdentity(), id: "fu_sequoia_taylor" },
    params,
  });

  beforeAll(async () => {
    t = await createTestDb();
    env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs } as Partial<Env>);
    const keys = ["matcha and tea", "grow your own food security in a nyc apartment", "trading and investing money reset", "the longevity reset", "build your own ai agent", "sewing and visible mending", "mahjong learn to play", "make a music video in a night", "sleep and recovery"];
    await t.db.batch(keys.map((k, n) => t.db.prepare("INSERT INTO tlc_idea (id, topic, topic_key, origin, suggested_by, suggested_at) VALUES (?1, ?2, ?2, 'OWNER_IDEA', 'Sequoia', '2026-10-22T00:00:00.000Z')").bind(`tli_fx_${n}`, k)));
  });
  afterAll(async () => { await disposeTestDb(t); });

  it("the migration seeds the research pages, and nothing else, on a firm with no ideas", async () => {
    const links = (await env.WP_OS_DB.prepare("SELECT url FROM tlc_research_link ORDER BY url").all<{ url: string }>()).results!.map((r) => r.url);
    expect(links).toEqual(["https://claude.ai/artifact/7632jc1TJSg7wbMzMrYkbA", "https://claude.ai/artifact/8iuxFJ3KbmPrcUCeWbTkxW"]);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_idea_note").first<{ n: number }>())!.n).toBe(0);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_idea WHERE id LIKE 'tli_seed_%'").first<{ n: number }>())!.n).toBe(0);
  });

  it("on the live list, the seed puts each 23 Oct angle on its idea by Sequoia, adds three new ideas, and is safe to run twice", async () => {
    const seeds = splitSqlStatements(MIGRATION).filter((s) => /^\s*INSERT OR IGNORE INTO tlc_idea/i.test(s.replace(/^(\s*--.*\n)+/, "")));
    expect(seeds.length).toBe(12);
    for (let pass = 0; pass < 2; pass++) for (const s of seeds) await env.WP_OS_DB.prepare(s).run();
    // The guard for new ideas reads 'the longevity reset', which the fixture has.
    const notes = (await env.WP_OS_DB.prepare("SELECT i.topic_key AS k, n.body, n.author FROM tlc_idea_note n JOIN tlc_idea i ON i.id = n.idea_id ORDER BY n.id").all<{ k: string; body: string; author: string }>()).results!;
    expect(notes.filter((n) => n.author === "Sequoia")).toHaveLength(7);
    expect(notes.find((n) => n.k === "matcha and tea")!.body).toBe("Matcha making.");
    expect(notes.find((n) => n.k === "the longevity reset")!.body).toMatch(/glutathione, NAD\+/);
    expect(notes.find((n) => n.k === "trading and investing money reset")!.body).toMatch(/stocks, bonds and crypto/);
    expect(notes.find((n) => n.k === "mahjong learn to play")!.body).toBe("Mahjong: it's trendy.");
    expect(notes.filter((n) => n.author.startsWith("Research"))).toHaveLength(2);
    const added = (await env.WP_OS_DB.prepare("SELECT topic FROM tlc_idea WHERE id LIKE 'tli_seed_%' ORDER BY topic").all<{ topic: string }>()).results!.map((r) => r.topic);
    expect(added).toEqual(["AI Glasses Night", "Run Your Life Like a Company", "Your AI Sales Machine"]);
  });

  it("a partner's note is saved under the idea with her name and the time; the overview carries it; nothing deletes it", async () => {
    const res = await handleTlcIdeaNote(ctx("/api/tlc/ideas/tli_fx_0/notes", { body: "Try a ceremonial-grade tasting." }, { id: "tli_fx_0" }));
    expect(res.status).toBe(200);
    const over = (await (await handleTlcOverview(ctx("/api/tlc"))).json()) as { ideas: Array<{ id: string; notes: Array<{ body: string; author: string; created_at: string }> }>; research_links: Array<{ title: string }> };
    const notes = over.ideas.find((i) => i.id === "tli_fx_0")!.notes;
    expect(notes.map((n) => [n.author, n.body])).toEqual([["Sequoia", "Matcha making."], ["Sequoia", "Try a ceremonial-grade tasting."]]);
    expect(notes[1]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(over.research_links.map((l) => l.title)).toEqual(expect.arrayContaining(["Title sponsors: who pays $25K alone", "Fragrance & AI sponsors"]));
    await expect(env.WP_OS_DB.prepare("DELETE FROM tlc_idea_note").run()).rejects.toThrow(/never deleted/);
    expect((await handleTlcIdeaNote(ctx("/api/tlc/ideas/nope/notes", { body: "x y" }, { id: "nope" }))).status).toBe(404);
    expect((await handleTlcIdeaNote(ctx("/api/tlc/ideas/tli_fx_0/notes", { body: "" }, { id: "tli_fx_0" }))).status).toBe(400);
  });

  it("a research link needs a title and an https address, and is kept with who added it", async () => {
    expect((await handleTlcResearchLinkAdd(ctx("/api/tlc/research-links", { title: "Bad", url: "http://example.com" }))).status).toBe(400);
    const res = await handleTlcResearchLinkAdd(ctx("/api/tlc/research-links", { title: "Who funds TLC", url: "https://claude.ai/artifact/example" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { research_links: Array<{ title: string; added_by: string }> };
    expect(body.research_links.find((l) => l.title === "Who funds TLC")!.added_by).toBe("Sequoia");
  });
});
