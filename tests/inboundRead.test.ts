import { inboundRead } from "./helpers/aiShapes";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { TlcDealRow } from "../src/worker/services/learningClub";
import { recordBrandReplyText } from "../src/worker/services/learningClub";
import { takeBrandReply, type ReplyDrafter } from "../src/worker/services/tlcBrandReply";
import { buildRoundup, CLOSED_LABEL, closedWithoutReply } from "../src/worker/services/tlcRoundup";
import type { Reader } from "../src/worker/services/partnerUnderstood";
import { inboundLadder, readInbound } from "../src/worker/services/inboundRead";
import { decideBrandReply } from "../src/shared/tlc/brandReply";
import { parseInboundRead } from "../src/shared/intake/inboundRead";

/**
 * EVERY INBOUND EMAIL IS READ FOR MEANING (owner, 17 Nov 2026). The real inbound corpus, replayed through the brand-reply
 * decision twice: with a model read (stubbed with what a model says of it), and with no model there (the word lists
 * decide, and the close is listed in her Monday roundup with the named stop). Brands' text is theirs, scrubbed to
 * example domains; no LP names, no deal terms, no personal addresses.
 */
let t: TestDb;
let env: Env;
const NOW = new Date("2026-11-17T12:00:00.000Z");
const drafter: ReplyDrafter = async () => ({ ok: true, body: "Hi,\n\nThank you. Here is what we do.", detail: "ok", changes: [] });
const samples = { renderPdf: async () => ({ pdfBase64: btoa("%PDF-1.4"), reason: null }) as never };

/** A reader that answers with this JSON, as the model would. */
const says = (o: Record<string, unknown>): Reader[] => [{ name: "SEAT", read: async () => ({ ok: true, text: inboundRead({ nothing_owed: o.we_owe === "none" ? "no_ask" : "owed", ...o }), detail: "ok", reader: "CLAUDE" }) }];
/** Every reader out: usage spent, Workers AI unbound, Gemini refused. */
const NONE: Reader[] = ["SEAT", "WORKERS_AI", "GEMINI"].map((name) => ({ name, read: async () => ({ ok: false, text: "", detail: "usage limit", out: true }) }));

const PRIVACY = "\nWe use AI to help handle support requests. Your message and any attachments are stored and processed by the brand and by third-party service providers acting on our behalf, including AI providers. If you need further assistance, a member of our team will be happy to help.";
const CORPUS = {
  // Therabody, 17 Nov 03:10Z: their partnerships desk's assistant asks for what we do.
  thera0310: { from: "Thera <partnerships@thera.example>", subject: "Therabody + a small room in New York", text: "Hi there, just checking in on your request. To keep things moving, could you reply with details about what you do and your idea for the collaboration? Once we have it, we'll take care of the next step for you." },
  // Therabody, 17 Nov 11:01Z: info@'s assistant sends us back to the partnerships address we already wrote to.
  thera1101: { from: "Thera <info@thera.example>", subject: "Therabody + a small room in New York", text: `Hello,\n\nThanks for sharing more context. For this kind of event collaboration, please continue by emailing [partnerships@thera.example](mailto:partnerships@thera.example).\n\nInclude what you do, where you post, and what you have in mind. The partnerships team reviews opportunities on a rolling basis and keeps information on file for future consideration.\n\nBest,  \nTherabody Virtual Assistant  ${PRIVACY}` },
  // Notion for Startups, 16 Nov: Kyle's answer through a Zendesk ticket, machine headers and all.
  notion: { from: "Deskapp for Startups <startup-partners@deskapp.example>", subject: "[Deskapp] Re: Deskapp + a small room in New York", text: `From: Deskapp for Startups <startup-partners@deskapp.example>\r\nAuto-Submitted: auto-generated\r\nSubject: [Deskapp] Re: Deskapp + a small room in New York\r\n\r\nWe've responded to your message (5517441). If you need further assistance, please reply to this email.\n${"-".repeat(46)}\n\nKyle, Nov 16, 2026, 09:41 PST\n\nHi Sequoia,\n\nThanks for thinking of us! Could you send a short overview of what you'd want from us as a founding partner, including any sponsorship fee, hands-on support, or other commitments?\n\nHappy to review the details here by email!\n\n-\nKyle,\nDeskapp for Startups\n\n${"-".repeat(46)}` },
  // Retool, 10 Nov: a billing-support ticket desk's acknowledgement. The word lists read it as "they are reviewing it".
  retool: { from: "Retool Support <support@retool.example>", subject: "Re: Retool + a small room in New York", text: "Hi Sequoia,\n\nThanks for contacting Retool Billing and Account Support! We've got your ticket #57652 and our team is here to help. While we aim to respond within 2 business days, we'll do our best to get back to you sooner.\n\nIf something's broken that was previously working, please open the Help menu in your Retool instance and submit through the Report a breakage form.\n\nBest,\nRetool Customer Support" },
  // Pydantic, 10 Nov: a person's no. The word lists read it as "they asked for nothing".
  pydantic: { from: "L. C. <hello@pydantic.example>", subject: "Re: [pydantic-hello] Pydantic + a small room in New York", text: "Hi Sequoia,\n\nThank you for reaching out. Unfortunately, now is not the right time for a\npartnership with us.\n\nThanks again for your email, and best of luck.\n\nBest regards,\nL. C." },
};
const READS = {
  thera0310: { sender_kind: "ai_assistant", asks: ["details about what you do and your idea"], redirect_to: null, wants_stop: false, declines: false, we_owe: "reply with what we do and our idea", summary: "their assistant asks what we do and our idea" },
  thera1101: { sender_kind: "ai_assistant", asks: ["continue by emailing partnerships"], redirect_to: "partnerships@thera.example", wants_stop: false, declines: false, we_owe: "write to partnerships@thera.example", summary: "their assistant sends us to partnerships@" },
  notion: { sender_kind: "helpdesk", asks: ["a short overview including any sponsorship fee"], redirect_to: null, wants_stop: false, declines: false, we_owe: "send the overview", summary: "Kyle asks for an overview and the fee" },
  retool: { sender_kind: "auto_reply", asks: [], redirect_to: null, wants_stop: false, declines: false, we_owe: "none", summary: "a billing-support ticket acknowledgement" },
  pydantic: { sender_kind: "person", asks: [], redirect_to: null, wants_stop: false, declines: true, we_owe: "none", summary: "not the right time for a partnership" },
};

let n = 0;
async function dealFor(brand: string, contact: string): Promise<TlcDealRow> {
  const id = `tld_${++n}`;
  // One club per deal, so the same address can be replayed with and without a model.
  const ev = `tlc_ev_${n}`;
  const month = `${2027 + Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`;
  await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, angle, status, sponsor_categories_json, pitch_token) VALUES (?1, ?3, ?4, 'EVENING', 'A topic', 'An angle.', 'TOPIC_READY', '[]', ?2)").bind(ev, String(n).padStart(32, "a"), month, `${month}-20`).run();
  await env.WP_OS_DB.prepare(
    "INSERT INTO tlc_deal (id, event_id, brand, category, contact_email, contact_source_url, why_fit, stage, drip_step, first_sent_at, last_sent_at, next_send_at, firm_scope) VALUES (?1, ?4, ?2, 'Tech', ?3, 'https://example.test', 'a fit', 'PITCHED', 1, '2026-11-09T15:00:00.000Z', '2026-11-09T15:00:00.000Z', '2026-11-20T15:00:00.000Z', 'west-peek')",
  ).bind(id, brand, contact, ev).run();
  await env.WP_OS_DB.prepare("INSERT INTO tlc_drip_message (id, deal_id, step, subject, body, state, sent_at) VALUES (?1, ?2, 0, ?3, 'Hi, what we do.', 'SENT', '2026-11-09T15:00:00.000Z')").bind(`tdm_${id}`, id, `${brand} + a small room in New York`).run();
  return (await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(id).first<TlcDealRow>())!;
}
const take = (deal: TlcDealRow, m: { from: string; subject: string; text: string }, read: Reader[]) =>
  takeBrandReply(env, deal, { messageId: `<m-${deal.id}>`, subject: m.subject, text: m.text, receivedAt: NOW.toISOString(), from: m.from }, { now: NOW, drafter, mailbox: null, samples, read });
const dealRow = (id: string) => env.WP_OS_DB.prepare("SELECT stage, stop_reason, next_send_at FROM tlc_deal WHERE id = ?1").bind(id).first<{ stage: string; stop_reason: string | null; next_send_at: string | null }>();
const replyRow = (id: string) => env.WP_OS_DB.prepare("SELECT state, kind, held_reason, send_to FROM tlc_brand_reply WHERE deal_id = ?1").bind(id).first<{ state: string; kind: string | null; held_reason: string | null; send_to: string | null }>();

beforeAll(async () => {
  t = await createTestDb();
  env = { ...makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs }), WP_OS_NEVERBOUNCE_API_KEY: "nb_test" } as Env;
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const u = new URL(String(url));
    if (u.hostname === "api.neverbounce.com") return new Response(JSON.stringify({ status: "success", result: "valid" }), { status: 200 });
    throw new Error(`unexpected fetch ${String(url)}`);
  });
});
afterAll(async () => { vi.unstubAllGlobals(); await disposeTestDb(t); });

describe("the real inbound corpus, read by a model first", () => {
  it("Therabody 03:10Z: their assistant asks what we do; an answer is drafted for her approval", async () => {
    const d = await dealFor("Therabody", "partnerships@thera.example");
    expect(await take(d, CORPUS.thera0310, says(READS.thera0310))).toBe("DRAFTED");
  });
  it("Therabody 11:01Z: sent back to the address we wrote to; the sample-event one-pager is drafted to it alone", async () => {
    const d = await dealFor("Therabody", "partnerships@thera.example");
    expect(await take(d, CORPUS.thera1101, says(READS.thera1101))).toBe("DRAFTED");
    expect(await replyRow(d.id)).toMatchObject({ kind: "SAMPLE_EVENT", send_to: "partnerships@thera.example" });
  });
  it("Notion 16 Nov: a person's answer through a ticket desk is a reply, never an auto-reply", async () => {
    const d = await dealFor("Deskapp", "startup-partners@deskapp.example");
    expect(await take(d, CORPUS.notion, says(READS.notion))).toBe("DRAFTED");
  });
  it("Retool 10 Nov: a ticket desk's acknowledgement is an auto-reply; the drip resumes", async () => {
    const d = await dealFor("Retool", "startups@retool.example");
    expect(await take(d, CORPUS.retool, says(READS.retool))).toBe("AUTO_REPLY");
    expect((await dealRow(d.id))?.next_send_at).toBeTruthy();
    expect((await replyRow(d.id))?.held_reason).toMatch(/auto-reply.* · read by Claude: "a billing-support ticket acknowledgement"/);
  });
  it("Pydantic 10 Nov: \"not the right time\" is a no; the deal is declined and the brand stopped", async () => {
    const d = await dealFor("Pydantic", "hello@pydantic.example");
    expect(await take(d, CORPUS.pydantic, says(READS.pydantic))).toBe("NO");
    expect(await dealRow(d.id)).toMatchObject({ stage: "DECLINED", stop_reason: "DECLINED" });
    expect((await replyRow(d.id))?.held_reason).toMatch(/they said no · read by Claude/);
  });
  it("Scooter's email to os@ is never read as a brand reply (his asks are the partner first read's)", async () => {
    expect(await recordBrandReplyText(env, { from: "Scooter <partner@westpeek.example>", subject: "Porter: update the deck", text: "1. Update the deck with the new numbers.\n2. Preview first, nothing goes live.", now: NOW })).toEqual({ matched: 0, stop: null });
  });
});

describe("the same corpus with no model there: the word lists decide, and every close is on her list", () => {
  it("each message gets the word lists' outcome, and a close names the reader and the named stop", async () => {
    const outcomes: Record<string, string> = {};
    for (const [key, m] of Object.entries(CORPUS)) {
      const brand = key.startsWith("thera") ? "Therabody" : key === "notion" ? "Deskapp" : key[0]!.toUpperCase() + key.slice(1);
      const contact = key.startsWith("thera") ? "partnerships@thera.example" : key === "notion" ? "startup-partners@deskapp.example" : `hello@${key}.example`;
      const d = await dealFor(`${brand} NoModel`, contact);
      outcomes[key] = await take(d, m, NONE);
    }
    expect(outcomes).toEqual({ thera0310: "DRAFTED", thera1101: "DRAFTED", notion: "DRAFTED", retool: "WAITING", pydantic: "WAITING" });
    const listed = await closedWithoutReply(env, NOW);
    expect(listed.find((l) => l.startsWith("Retool NoModel"))).toMatch(/no reply needed .* · read by word lists \(NAMED STOP INBOUND_NO_MODEL_READER: no model answered\)/);
    expect(listed.find((l) => l.startsWith("Pydantic NoModel"))).toMatch(/no reply needed .*INBOUND_NO_MODEL_READER/);
  });
});

describe("no inbound email closes silently: her Monday roundup lists every close of the week", () => {
  it("lists each close, one line with the reason and the reader; a redirect (her approval follows) is not listed", async () => {
    const r = await buildRoundup(env, NOW);
    const section = r.sections.find((s) => s.label === CLOSED_LABEL);
    expect(section?.bullets.some((b) => /^Pydantic \(17 Nov\): they said no · read by Claude: "not the right time for a partnership"$/.test(b))).toBe(true);
    expect(section?.bullets.some((b) => /^Retool \(17 Nov\): auto-reply/.test(b))).toBe(true);
    expect(section?.bullets.some((b) => /^redirect:|: redirect:/.test(b))).toBe(false);
  });
});

describe("who reads first depends on who sent it (owner, 17 Nov 2026)", () => {
  const names = async (from: string, words = "Hello there.") => (await inboundLadder(env, { from, subject: "Hi", words, firmScope: "west-peek" })).readers.map((r) => r.name);
  it("anyone else (a brand, a desk, an assistant, an LP prospect): free Gemini first, then the rest of the ladder", async () => {
    expect(await names(CORPUS.retool.from)).toEqual(["GEMINI", "SEAT", "WORKERS_AI"]);
    await env.WP_OS_DB.prepare("INSERT INTO lp_record (id, legal_name, lp_type, status, created_by) VALUES ('lpr_prospect', 'Prospect Family Office', 'FAMILY_OFFICE', 'PROSPECT', 'test')").run();
    expect(await names("Pat <pat@prospect.example>", "Prospect Family Office would like the deck.")).toEqual(["GEMINI", "SEAT", "WORKERS_AI"]);
  });
  it("a partner: the partner ladder, Claude first", async () => {
    const partner = (await env.WP_OS_DB.prepare("SELECT email FROM firm_user WHERE id = 'fu_scooter_taylor'").first<{ email: string }>())!.email;
    expect((await names(`Scooter <${partner}>`))[0]).toBe("SEAT");
  });
  it("a committed LP: Claude or Codex only, never a free route, even when a caller hands in Gemini", async () => {
    await env.WP_OS_DB.prepare("INSERT INTO lp_record (id, legal_name, lp_type, status, created_by) VALUES ('lpr_committed', 'Committed Test Trust', 'INSTITUTION', 'COMMITTED', 'test')").run();
    expect(await names("Committed Test Trust <office@trust.example>")).toEqual(["SEAT"]);
    const asked: string[] = [];
    const spy = (name: string): Reader => ({ name, read: async () => { asked.push(name); return { ok: false, text: "", detail: "usage", out: true }; } });
    await readInbound(env, { context: "c", from: "Office <office@trust.example>", subject: "Re: Fund I", words: "Committed Test Trust here, a question.", firmScope: "west-peek", employeeId: null }, [spy("GEMINI"), spy("SEAT"), spy("WORKERS_AI")]);
    expect(asked).toEqual(["SEAT"]);
  });
});

describe("the code still checks the hard parts of a model's read", () => {
  const read = (o: Record<string, unknown>) => parseInboundRead(inboundRead({ we_owe: "answer them", nothing_owed: "owed", summary: "s", ...o }), "CLAUDE");
  const base = { subject: "Re: x", brandDomain: "brand.example", notThese: ["info@brand.example"] };
  it("a stop that only the word lists see is still a stop", () => {
    expect(decideBrandReply({ ...base, text: "Please unsubscribe me from these." }, read({}), NOW).cls).toEqual({ kind: "NO", unsubscribe: true });
  });
  it("a redirect off the brand's domain, or not in their words, is never followed", () => {
    expect(decideBrandReply({ ...base, text: "Write to events@agency.example please." }, read({ redirect_to: "events@agency.example" }), NOW).cls.kind).not.toBe("REDIRECT");
    expect(decideBrandReply({ ...base, text: "Write to our partnerships team." }, read({ redirect_to: "partnerships@brand.example" }), NOW).cls.kind).not.toBe("REDIRECT");
  });
  it("an answer that does not parse is no read at all", () => {
    expect(parseInboundRead("Sure! They want a call.", "CLAUDE")).toBeNull();
    expect(parseInboundRead('{"sender_kind":"robot"}', "CLAUDE")).toBeNull();
  });
});
