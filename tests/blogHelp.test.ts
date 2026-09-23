import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { saidNothing } from "./helpers/interpret";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleInboundEmail } from "../src/worker/effects/inboundEmail";
import { TRUSTED_AUTHSERV_ID } from "../src/shared/intake/partnerAuthority";
import { INTAKE_MAILBOX } from "../src/shared/intake/emailTriggers";
import { parseBlogAsk, readBlogAsk } from "../src/shared/intake/blogHelp";
import { sweepOnce } from "../src/worker/services/workSweep";
import {
  buildDraftPrompt,
  buildOutlinePrompt,
  parseDraft,
  parseOutline,
  parseResearch,
  runBlogHelpCard,
  wordBand,
  type BlogModelCall,
} from "../src/worker/services/blogHelp";
import { lintExecEmail } from "../src/shared/email/execEmail";
import { skillsForMachines } from "../src/shared/skills/library";

/**
 * BLOG HELP AS A ROUTED REQUEST (16 Sep 2026).
 *
 * The partners are starting blogs. A partner emails os@joinwestpeek.com; Porter reads the ask at
 * the door and marks the card BLOG_HELP with the modes and topic; the sweep hands it to the blog
 * runner, which researches live (every source checked and judged), writes in the partner's voice,
 * files a `blog_help` deliverable on their Home, and emails them ONCE in the busy-executive format.
 * All of it here goes through the real inbound handler, the real sweep and the real runner, with
 * the three model calls and the URL check stubbed.
 */

let t: TestDb;
let env: Env;
const NOW = new Date("2026-09-16T15:00:00.000Z");
const sent: Array<{ to: string; subject: string; text: string; html?: string }> = [];

const genuineFrom = (address: string): string =>
  `${TRUSTED_AUTHSERV_ID}; dkim=pass header.d=westpeek-ventures.20251104.gappssmtp.com header.s=20251104; ` +
  `dmarc=none header.from=westpeek.ventures policy.dmarc=none; ` +
  `spf=pass (${TRUSTED_AUTHSERV_ID}: domain of ${address} designates 2607:f8b0:4864:20::f2e as permitted sender) smtp.mailfrom=${address}; arc=none`;

function deliverMail(from: string, subject: string, body: string): Promise<void> {
  const bytes = new TextEncoder().encode(body);
  return handleInboundEmail(
    { from, to: INTAKE_MAILBOX, headers: new Headers({ from: `"Partner" <${from}>`, subject, "authentication-results": genuineFrom(from) }), raw: new Blob([bytes]).stream(), rawSize: bytes.byteLength },
    env,
  );
}

type Card = { id: string; kind: string | null; owner_id: string; state: string; request_json: string | null; requested_by_email: string | null; description: string };
async function cardsOwnedBy(owner: string): Promise<Card[]> {
  return (await env.WP_OS_DB.prepare("SELECT id, kind, owner_id, state, request_json, requested_by_email, description FROM work_card WHERE owner_id = ?1 ORDER BY created_at").bind(owner).all<Card>()).results ?? [];
}

function fakeBucket() {
  const store = new Map<string, Uint8Array>();
  return {
    put: async (key: string, body: ArrayBuffer | Uint8Array) => { store.set(key, body instanceof Uint8Array ? body : new Uint8Array(body)); return { key }; },
    get: async (key: string) => { const b = store.get(key); return b ? { arrayBuffer: async () => b.buffer } : null; },
  };
}

// ── The stubbed models ───────────────────────────────────────────────────────

const LIVE_1 = "https://www.example-research.org/report-2026";
const LIVE_2 = "https://blog.example-operator.com/first-ten-hires";
const DEAD = "https://dead.example/gone";
const WEAK = "https://listicle.example/top-10";

const researchJson = JSON.stringify({ results: [
  { fact: "62% of seed-stage companies that hired a recruiter before month 12 reached 20 people within two years", why_it_matters: "the headcount compounding argument", source: "Example Research", url: LIVE_1, date: "2026-03" },
  { fact: "An operator's account of hiring the first ten", why_it_matters: "a named example", source: "Example Operator", url: LIVE_2, date: "2025-11" },
  { fact: "A page that is gone", source: "dead", url: DEAD },
  { fact: "Top 10 tips for founders", source: "Listicle", url: WEAK },
  { fact: "No url on this one", source: "nowhere" },
] });

const search: BlogModelCall = async () => ({ ok: true, text: researchJson, detail: "ok" });
const judge: BlogModelCall = async () => ({ ok: true, text: JSON.stringify({ verdicts: [
  { url: LIVE_1, keep: true, reason: "specific, dated, credible" },
  { url: LIVE_2, keep: true, reason: "a named example" },
  { url: WEAK, keep: false, reason: "an SEO listicle" },
] }), detail: "ok" });
const urlCheck = async (u: string): Promise<boolean> => u !== DEAD;

const outlineJson = JSON.stringify({
  title: "The first hire is the hire who hires",
  alternates: ["Recruiter before CFO", "Who builds the team builds the company", "Your first ten"],
  thesis: "At seed the scarce resource is people, not cash control, so the first senior hire should compound headcount.",
  sections: [
    { heading: "The cash myth", proves: "a CFO at 8 people is a spreadsheet, not a strategy", leans_on: [{ fact: "62% reached 20 people", url: LIVE_1 }] },
    { heading: "What a recruiter actually does at 8 people", proves: "pipeline is the job", leans_on: [{ fact: "an operator's account", url: LIVE_2 }, { fact: "an invented one", url: "https://made-up.example/never-checked" }] },
    { heading: "What to do Monday", proves: "the concrete step", leans_on: [] },
  ],
  opening: "Every founder I meet at seed has a CFO on the hiring plan. Almost none has a recruiter.",
  closing: "Hire the person who hires. The rest follows.",
  research_notes: [{ note: "62% reached 20 people within two years", url: LIVE_1 }, { note: "the operator's account", url: LIVE_2 }, { note: "unchecked", url: "https://made-up.example/other" }],
});

const words = (n: number): string => Array.from({ length: n }, (_, i) => (i % 40 === 0 ? `\n\n## Section ${i / 40 + 1}\n\n` : "") + `word${i}`).join(" ");
const draftJson = (n: number) => JSON.stringify({
  title: "What LPs get wrong about emerging managers",
  body_markdown: `${words(n)} [1] See also https://made-up.example/never-checked and ${LIVE_2}.`,
  sources: [{ n: 1, url: LIVE_1, note: "the 62% figure" }, { n: 2, url: "https://made-up.example/x", note: "not checked" }],
});

const phraseJson = JSON.stringify({
  candidates: [
    { phrase: "Early inclusion beats early access", reasoning: "it names the thesis", recurs_as: "a sign-off: 'Early inclusion beats early access. See you in the room.'" },
    { phrase: "Good people should meet good people", reasoning: "it is the belief", recurs_as: "an opening line" },
    { phrase: "Community is an operating advantage", reasoning: "positioning", recurs_as: "a section header" },
    { phrase: "Meet them before the raise", reasoning: "the when", recurs_as: "a refrain" },
    { phrase: "The room before the round", reasoning: "memorable", recurs_as: "a header" },
  ],
  recommendation: "Early inclusion beats early access",
  why: "It is the one claim only West Peek can make and keep making.",
});

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled", WP_OS_EMAIL_SEND: "enabled", RESEND_API_KEY: "re_test_not_a_real_key", WP_OS_EMAIL_FROM: "os@westpeek.ventures", WP_OS_DOCUMENTS: fakeBucket() as never } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; html?: string };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text, html: body.html });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

describe("Porter reads the ask at the door", () => {
  it("parses the three phrasings into their modes, and leaves an ordinary request alone", () => {
    expect(parseBlogAsk("Blog", "help me make an outline for a blog post on why early-stage founders should hire a recruiter before a CFO and do research")).toMatchObject({ modes: ["OUTLINE"], topic: "why early-stage founders should hire a recruiter before a CFO" });
    expect(parseBlogAsk("Post", "write a blog post on what LPs get wrong about emerging managers")).toMatchObject({ modes: ["DRAFT"], topic: "what LPs get wrong about emerging managers" });
    expect(parseBlogAsk("Authority", "help me come up with a phrase I can repeat across posts to build authority")).toMatchObject({ modes: ["PHRASE"] });
    expect(parseBlogAsk("Both", "Can you outline a post about hiring your first ten people and then write the full draft, about 700 words? And suggest a tagline I can reuse.")).toMatchObject({ modes: ["OUTLINE", "DRAFT", "PHRASE"], topic: "hiring your first ten people" });
    expect(parseBlogAsk("Draft outline", "draft an outline for an article on secondaries")).toMatchObject({ modes: ["OUTLINE"] });
    expect(parseBlogAsk("Blog", "a blog on functional drinks, please")).toMatchObject({ modes: ["OUTLINE"] });
    expect(parseBlogAsk("Sensori", "can someone look at Sensori, the functional drinks company, and tell me if it is worth a call?")).toBeNull();
    expect(readBlogAsk(null)).toBeNull();
    expect(readBlogAsk('{"modes":["NOPE"]}')).toBeNull();
  });

  it("Sequoia's outline ask lands on Wren as BLOG_HELP / OUTLINE, remembering she asked", async () => {
    await deliverMail("sequoia@westpeek.ventures", "Blog post", "Wren — help me make an outline for a blog post on why early-stage founders should hire a recruiter before a CFO and do research.");
    const cards = await cardsOwnedBy("aie_wren");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.kind).toBe("BLOG_HELP");
    expect(readBlogAsk(cards[0]!.request_json)).toMatchObject({ modes: ["OUTLINE"], topic: "why early-stage founders should hire a recruiter before a CFO" });
    expect(cards[0]!.requested_by_email).toBe("sequoia@westpeek.ventures");
  });

  it("Scooter's draft ask lands on Walker as BLOG_HELP / DRAFT; his phrase ask as PHRASE", async () => {
    await deliverMail("scooter@westpeek.ventures", "Post", "write a blog post on what LPs get wrong about emerging managers");
    await deliverMail("scooter@westpeek.ventures", "Authority", "help me come up with a phrase I can repeat across posts to build authority");
    const cards = await cardsOwnedBy("aie_walker");
    expect(cards.map((c) => c.kind)).toEqual(["BLOG_HELP", "BLOG_HELP"]);
    expect(readBlogAsk(cards[0]!.request_json)?.modes).toEqual(["DRAFT"]);
    expect(readBlogAsk(cards[1]!.request_json)?.modes).toEqual(["PHRASE"]);
    expect(cards.every((c) => c.requested_by_email === "scooter@westpeek.ventures")).toBe(true);
  });

  it("an ordinary request from a partner is still an ordinary assignment", async () => {
    await deliverMail("sequoia@westpeek.ventures", "Sensori", "can someone look at Sensori and tell me if it is worth a call?");
    const cards = await cardsOwnedBy("aie_wren");
    expect(cards).toHaveLength(2);
    expect(cards[1]!.kind).toBeNull();
    expect(cards[1]!.request_json).toBeNull();
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(cards[1]!.id).run();
  });

  it("the method is written where Wren and Walker sit", () => {
    const skill = skillsForMachines(["mp_personal_office"]).find((s) => s.key === "blog_help_for_a_partner");
    expect(skill).toBeTruthy();
    expect(skill!.guidance.join("\n")).toMatch(/OUTLINE is a spine with research; DRAFT is the whole post; PHRASE/);
    expect(skill!.guidance.join("\n")).toMatch(/JUDGED against the brief/);
  });
});

describe("the runner: research judged, the piece written, filed, one email", () => {
  it("OUTLINE: Wren works Sequoia's card — sources checked and judged, unchecked URLs stripped, deliverable filed, one email, DONE", async () => {
    const writes: string[] = [];
    const write: BlogModelCall = async (_e, _a, prompt) => { writes.push(prompt); return { ok: true, text: outlineJson, detail: "ok" }; };
    const out = await sweepOnce(env, NOW, { blogHelp: (e, card) => runBlogHelpCard(e, card, { search, judge, write, urlCheck, interpret: saidNothing }) });
    expect(out.outcome, out.summary).toBe("DONE");
    const card = (await cardsOwnedBy("aie_wren"))[0]!;
    expect(out.card?.id).toBe(card.id);

    // The writer was told who it writes as, the positioning, and ONLY the judged sources.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/You are Wren, Sequoia's Chief of Staff/);
    expect(writes[0]).toMatch(/WHOSE VOICE THIS IS: Sequoia Taylor/);
    expect(writes[0]).toMatch(/EARLY INCLUSION/);
    expect(writes[0]).toContain(LIVE_1);
    expect(writes[0]).toContain(LIVE_2);
    expect(writes[0]).not.toContain(DEAD);
    expect(writes[0]).not.toContain(WEAK);

    // Filed: a blog_help deliverable on Sequoia's Home, signed by Wren, with a document behind it.
    const dlv = await env.WP_OS_DB.prepare("SELECT * FROM deliverable WHERE source_type = 'work_card' AND source_id = ?1").bind(card.id).first<{ id: string; kind: string; title: string; body: string; prepared_by: string; prepared_for: string; document_id: string | null }>();
    expect(dlv).toBeTruthy();
    expect(dlv!.kind).toBe("blog_help");
    expect(dlv!.prepared_by).toBe("Wren");
    expect(dlv!.prepared_for).toBe("fu_sequoia_taylor");
    expect(dlv!.title).toBe("Blog outline: The first hire is the hire who hires");
    expect(dlv!.document_id, "filed to Documents as markdown").toMatch(/^doc_/);
    expect(dlv!.body).toMatch(/\*\*Working title:\*\* The first hire is the hire who hires/);
    expect(dlv!.body).toMatch(/- Recruiter before CFO/);
    expect(dlv!.body).toMatch(/\*\*Thesis:\*\* At seed the scarce resource is people/);
    expect(dlv!.body).toMatch(/#### 1\. The cash myth\nProves: a CFO at 8 people/);
    expect(dlv!.body).toContain(LIVE_1);
    expect(dlv!.body).not.toContain("made-up.example");
    expect(dlv!.body).toMatch(/### Suggested opening\nEvery founder I meet/);
    expect(dlv!.body).toMatch(/### Research notes\n1\. 62% reached 20 people/);
    expect(dlv!.body).toMatch(/2 URL\(s\) the writer offered were not among the checked sources and were removed/);
    expect(dlv!.body).toMatch(/Left out on judgement: .*listicle/);

    // One email, to the partner who asked, in the format.
    const mine = sent.filter((s) => s.to === "sequoia@westpeek.ventures");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toBe("Wren: blog outline — why early-stage founders should hire a recruiter…");
    expect(lintExecEmail(mine[0]!.subject, mine[0]!.text, "Wren")).toEqual([]);
    expect(mine[0]!.text).toMatch(/^\*\*TL;DR:\*\* An outline with research for your post on why early-stage founders/);
    expect(mine[0]!.text).toMatch(/\*\*What I found\*\*\n• Title: \*\*The first hire is the hire who hires\*\*/);
    expect(mine[0]!.text).toMatch(/\*\*Your call\*\*\n• Pick a title and reply "draft it"/);
    expect(mine[0]!.text).toMatch(/— Details —/);
    expect(mine[0]!.html).toContain("<strong>What I found</strong>");

    const done = await env.WP_OS_DB.prepare("SELECT state, description FROM work_card WHERE id = ?1").bind(card.id).first<{ state: string; description: string }>();
    expect(done!.state).toBe("DONE");
    expect(done!.description).toMatch(/Emailed to sequoia@westpeek\.ventures/);
    // The sweep's own announcement did not email a second time (the runner already did).
    expect(sent.filter((s) => s.to === "sequoia@westpeek.ventures")).toHaveLength(1);
    const notice = await env.WP_OS_DB.prepare("SELECT title, firm_user_id FROM notification WHERE object_id = ?1").bind(dlv!.id).first<{ title: string; firm_user_id: string }>();
    expect(notice?.firm_user_id).toBe("fu_sequoia_taylor");
    expect(notice?.title).toMatch(/Wren finished your blog outline/);
  });

  it("DRAFT: Walker writes Scooter's post to length — a short first draft is sent back once with the count — sources footnoted, unchecked URLs removed", async () => {
    const drafts: string[] = [];
    const write: BlogModelCall = async (_e, _a, prompt) => { drafts.push(prompt); return { ok: true, text: draftJson(drafts.length === 1 ? 400 : 1000), detail: "ok" }; };
    const out = await sweepOnce(env, new Date(NOW.getTime() + 60_000), { blogHelp: (e, card) => runBlogHelpCard(e, card, { search, judge, write, urlCheck, interpret: saidNothing }) });
    expect(out.outcome, out.summary).toBe("DONE");
    const card = (await cardsOwnedBy("aie_walker"))[0]!;
    expect(out.card?.id).toBe(card.id);
    expect(drafts, "the 400-word draft was sent back for length once").toHaveLength(2);
    expect(drafts[0]).toMatch(/You are Walker, Scooter's Chief of Staff/);
    expect(drafts[0]).toMatch(/900–1400 words/);
    expect(drafts[1]).toMatch(/Your previous draft was 4\d\d words; it must be 900–1400/);

    const dlv = await env.WP_OS_DB.prepare("SELECT * FROM deliverable WHERE source_type = 'work_card' AND source_id = ?1").bind(card.id).first<{ title: string; body: string; prepared_for: string; document_id: string | null }>();
    expect(dlv!.title).toBe("Blog draft: What LPs get wrong about emerging managers");
    expect(dlv!.prepared_for).toBe("fu_scooter_taylor");
    expect(dlv!.document_id).toMatch(/^doc_/);
    expect(dlv!.body).toMatch(/_10\d\d words\._/);
    expect(dlv!.body).toMatch(/### Sources\n\[1\] https:\/\/www\.example-research\.org\/report-2026 — the 62% figure/);
    expect(dlv!.body).not.toContain("made-up.example");
    expect(dlv!.body).toContain("[source removed: not among the checked sources]");
    expect(dlv!.body).toContain(LIVE_2);

    const mine = sent.filter((s) => s.to === "scooter@westpeek.ventures");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toBe("Walker: blog draft — what LPs get wrong about emerging managers");
    expect(lintExecEmail(mine[0]!.subject, mine[0]!.text, "Walker")).toEqual([]);
    expect(mine[0]!.text).toMatch(/• Draft: \*\*What LPs get wrong about emerging managers\*\*, \*\*10\d\d\*\* words, \*\*1\*\* source\(s\) footnoted\./);
    expect(mine[0]!.text).toMatch(/• Read the draft; reply with edits/);
  });

  it("PHRASE: five candidates with reasoning and how each recurs, and one recommendation", async () => {
    const write: BlogModelCall = async () => ({ ok: true, text: phraseJson, detail: "ok" });
    const out = await sweepOnce(env, new Date(NOW.getTime() + 120_000), { blogHelp: (e, card) => runBlogHelpCard(e, card, { search, judge, write, urlCheck, interpret: saidNothing }) });
    expect(out.outcome, out.summary).toBe("DONE");
    const card = (await cardsOwnedBy("aie_walker"))[1]!;
    expect(out.card?.id).toBe(card.id);
    const dlv = await env.WP_OS_DB.prepare("SELECT title, body FROM deliverable WHERE source_type = 'work_card' AND source_id = ?1").bind(card.id).first<{ title: string; body: string }>();
    expect(dlv!.title).toMatch(/^Blog phrases: /);
    expect(dlv!.body).toMatch(/### 1\. “Early inclusion beats early access”\nWhy it builds authority: it names the thesis\nHow it recurs: a sign-off/);
    expect((dlv!.body.match(/^### \d\. “/gm) ?? []).length).toBe(5);
    expect(dlv!.body).toMatch(/\*\*Recommendation:\*\* “Early inclusion beats early access” — It is the one claim/);
    const mine = sent.filter((s) => s.to === "scooter@westpeek.ventures");
    expect(mine).toHaveLength(2);
    expect(mine[1]!.subject).toMatch(/^Walker: blog phrases — /);
    expect(mine[1]!.text).toMatch(/• Recommended phrase: \*\*“Early inclusion beats early access”\*\*/);
    expect(mine[1]!.text).toMatch(/• Commit to one phrase/);
  });

  it("no source survives for an outline: BLOCKED with the reason, nothing emailed, nothing filed", async () => {
    await deliverMail("sequoia@westpeek.ventures", "Blog", "outline a blog post on the history of the West Peek mastermind please");
    const before = sent.length;
    const out = await sweepOnce(env, new Date(NOW.getTime() + 180_000), {
      blogHelp: (e, card) => runBlogHelpCard(e, card, { search, judge, write: async () => ({ ok: true, text: outlineJson, detail: "ok" }), urlCheck: async () => false, interpret: saidNothing }),
    });
    expect(out.outcome, out.summary).toBe("BLOCKED");
    // 0173: the block is a sentence she can read, and the specifics are in "what would clear it".
    expect(out.summary).toMatch(/looked and found nothing solid enough to put in front of you/);
    const blocked = await env.WP_OS_DB.prepare("SELECT next_action, block_who FROM work_card WHERE id = ?1").bind(out.card!.id).first<{ next_action: string; block_who: string }>();
    expect(blocked!.next_action).toMatch(/Send a source or two to start from/);
    expect(blocked!.block_who).toBe("SEQUOIA");
    // The only email is the sweep's BLOCKED reply — a question back to her — never a piece.
    expect(sent).toHaveLength(before + 1);
    expect(sent[sent.length - 1]!.subject).toMatch(/^Wren: a question — /);
    expect(sent[sent.length - 1]!.subject, "never \"blocked\" to a partner (23 Sep 2026)").not.toMatch(/blocked/i);
    expect(sent[sent.length - 1]!.text).toMatch(/nothing solid enough to put in front of you/);
    const dlv = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM deliverable WHERE source_type = 'work_card' AND source_id = ?1").bind(out.card!.id).first<{ n: number }>();
    expect(dlv!.n).toBe(0);
  });

  it("a BLOG_HELP card opened by hand with no email still knows whose it is, from the chief of staff's own role", async () => {
    await env.WP_OS_DB.prepare("INSERT INTO work_card (id, title, description, owner_type, owner_id, state, priority, privacy_label, firm_scope, created_by, kind, request_json) VALUES ('wc_blog_hand', 'Blog phrases for Sequoia', 'x', 'AI', 'aie_wren', 'OPEN', 'NORMAL', 'INTERNAL', 'west-peek', 'test', 'BLOG_HELP', ?1)")
      .bind(JSON.stringify({ modes: ["PHRASE"], topic: "the blog", ask: "a phrase I can repeat" })).run();
    const out = await runBlogHelpCard(env, { id: "wc_blog_hand", title: "Blog phrases for Sequoia", kind: "BLOG_HELP", owner_id: "aie_wren", state: "OPEN", work_attempts: 1, firm_scope: "west-peek", requested_by_email: null }, { search, judge, write: async () => ({ ok: true, text: phraseJson, detail: "ok" }), urlCheck, interpret: saidNothing });
    expect(out.finished, out.detail).toBe(true);
    const dlv = await env.WP_OS_DB.prepare("SELECT prepared_for FROM deliverable WHERE source_type = 'work_card' AND source_id = 'wc_blog_hand'").first<{ prepared_for: string }>();
    expect(dlv!.prepared_for).toBe("fu_sequoia_taylor");
    expect(sent[sent.length - 1]!.to).toBe("sequoia@westpeek.ventures");
  });
});

describe("the pieces, on their own", () => {
  it("research: no url, no note; one per url", () => {
    const notes = parseResearch(researchJson);
    expect(notes.map((n) => n.url)).toEqual([LIVE_1, LIVE_2, DEAD, WEAK]);
    expect(parseResearch(`${researchJson}`.replace(LIVE_2, LIVE_1))).toHaveLength(3);
  });
  it("outline and draft: only the judged URLs survive; the count of what was stripped is kept", () => {
    const allowed = new Set([LIVE_1.toLowerCase(), LIVE_2.toLowerCase()]);
    const o = parseOutline(outlineJson, allowed);
    expect(o.strippedUrls).toBe(2);
    expect(o.piece!.sections[1]!.leansOn).toHaveLength(1);
    expect(o.piece!.notes).toHaveLength(2);
    const d = parseDraft(draftJson(1000), allowed);
    expect(d.strippedUrls).toBe(2);
    expect(d.piece!.sources).toHaveLength(1);
    expect(d.piece!.words).toBeGreaterThan(990);
    expect(parseOutline("not json", allowed).piece).toBeNull();
  });
  it("the word band reads the ask", () => {
    expect(wordBand("write a post")).toEqual({ min: 900, max: 1400, stated: false });
    expect(wordBand("about 700 words please")).toEqual({ min: 560, max: 840, stated: true });
    expect(wordBand("keep it under 500 words")).toEqual({ min: 300, max: 500, stated: true });
  });
  it("the prompts carry the rules that matter", () => {
    const base = { employee: { name: "Wren", role: "Sequoia's Chief of Staff" }, partner: { fullName: "Sequoia Taylor" }, profile: { sectors: ["consumer"], themes: ["early inclusion"] }, feedback: "", ask: { modes: ["OUTLINE" as const], topic: "t", ask: "a" }, notes: [] };
    expect(buildOutlinePrompt(base)).toMatch(/RESEARCH NOTES: none survived the checks\. Cite nothing/);
    expect(buildOutlinePrompt(base)).toMatch(/WHAT SEQUOIA COVERS AND THINKS ABOUT \(from their profile\): consumer, early inclusion/);
    expect(buildDraftPrompt({ ...base, band: { min: 900, max: 1400 } })).toMatch(/End on the takeaway, not on 'reach out' or 'join us'/);
    expect(buildDraftPrompt({ ...base, band: { min: 900, max: 1400 } })).toMatch(/No invented quotes, no invented numbers/);
  });
});

describe("the finished email names what is still missing (0237, one list for every card)", () => {
  it("a blog card with a missing item sends its DONE email with the shared \"Still missing\" section, before \"Your call\"", async () => {
    await env.WP_OS_DB.prepare("INSERT INTO work_card (id, title, description, owner_type, owner_id, state, priority, privacy_label, firm_scope, created_by, kind, request_json, missing_materials_json) VALUES ('wc_blog_missing', 'Blog phrases for Sequoia', 'x', 'AI', 'aie_wren', 'OPEN', 'NORMAL', 'INTERNAL', 'west-peek', 'test', 'BLOG_HELP', ?1, ?2)")
      .bind(JSON.stringify({ modes: ["PHRASE"], topic: "the blog", ask: "a phrase I can repeat" }), JSON.stringify([{ item: "the latest LP letter (PDF)", where: "the post's evidence section" }])).run();
    const before = sent.length;
    const out = await runBlogHelpCard(env, { id: "wc_blog_missing", title: "Blog phrases for Sequoia", kind: "BLOG_HELP", owner_id: "aie_wren", state: "OPEN", work_attempts: 1, firm_scope: "west-peek", requested_by_email: null }, { search, judge, write: async () => ({ ok: true, text: phraseJson, detail: "ok" }), urlCheck, interpret: saidNothing });
    expect(out.finished, out.detail).toBe(true);
    const mail = sent.slice(before).find((s) => s.to === "sequoia@westpeek.ventures")!;
    expect(mail.text).toContain("Still missing");
    expect(mail.text).toContain("the latest LP letter (PDF) — for the post's evidence section");
    expect(mail.text.indexOf("Still missing")).toBeLessThan(mail.text.indexOf("Your call"));
  });
});
