import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { contentHashes, recordBrandMail, recordBrandReplyText, runDrip } from "../src/worker/services/learningClub";
import { applyBrandReplyApproval, processBrandReplies, rulesBlock, type BrandResearcher, type DraftExtras, type ReplyDrafter } from "../src/worker/services/tlcBrandReply";
import { THREE_THINGS_OFFER, classifyBrandReply, herNoteOf, standingRulesIn, theirNewText, type ReplyDraftInput } from "../src/shared/tlc/brandReply";
import { parseDraftReply } from "../src/shared/tlc/draftReply";
import { TRUSTED_AUTHSERV_ID } from "../src/shared/intake/partnerAuthority";

/**
 * WYNN ANSWERS A BRAND'S REPLY, SEQUOIA APPROVES IT (owner, 26 Oct 2026). Fake brands and addresses only.
 */
let t: TestDb;
let env: Env;
const sends: Array<{ to: string; from: string; subject: string; text: string; inReplyTo: string; replyTo: string; files?: string[] }> = [];
const SERVICE_ACCOUNT = JSON.stringify({ client_email: "sa@firm.iam.example", private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) });
const APPROVER = "owner.personal@example.test";
const auth = (address: string) => `${TRUSTED_AUTHSERV_ID}; dkim=pass header.d=${address.split("@")[1]} header.s=s1; spf=pass smtp.mailfrom=${address}; dmarc=pass header.from=${address.split("@")[1]}`;
const MORNING = new Date("2026-11-10T15:00:00.000Z"); // 09:00 in Chicago
const AFTERNOON = new Date("2026-11-10T22:30:00.000Z"); // 16:30 in Chicago
/** Every input the drafter was given, newest last: what Wynn was told. */
const seen: Array<ReplyDraftInput & DraftExtras> = [];
const drafter: ReplyDrafter = async (_e, _a, i) => {
  seen.push(i);
  return { ok: true, body: `Hi,\n\n${i.note ? `Shorter, per "${i.note.split("\n")[0]}".` : `Thanks for asking about ${i.topic}.`} ${THREE_THINGS_OFFER}`, detail: "ok" };
};
const deps = { drafter, mailbox: null };

const QUOTED = "\n\nOn Sun, Oct 25, 2026 at 5:14 PM Sequoia Taylor <sequoia@westpeek.ventures>\nwrote:\n\n> Hi,\n> Would you be open to exploring a partnership?\n";

async function deal(id: string, brand: string, email: string): Promise<void> {
  await env.WP_OS_DB.prepare(
    "INSERT INTO tlc_deal (id, event_id, brand, contact_email, contact_source_url, why_fit, stage, drip_step, first_sent_at, last_sent_at, next_send_at, firm_scope) VALUES (?1, 'tlc_2027-03', ?2, ?3, 'https://example.test', 'they make agents remember', 'PITCHED', 1, '2026-11-09T15:00:00.000Z', '2026-11-09T15:00:00.000Z', '2026-11-12T15:00:00.000Z', 'west-peek')",
  ).bind(id, brand, email).run();
}
const arrive = async (from: string, subject: string, text: string, mid: string, at: Date) => {
  await recordBrandMail(env, { from, subject, now: at });
  return recordBrandReplyText(env, { from, subject, text, messageId: `<${mid}>`, now: at });
};
const herReply = (body: string, ref: string, from = APPROVER, a = auth(from)) =>
  applyBrandReplyApproval(env, { fromHeader: `Her <${from}>`, authenticationResults: a, subject: `Re: Wynn: brand replies · ${ref}`, body }, { now: AFTERNOON, drafter });

beforeAll(async () => {
  t = await createTestDb();
  env = { ...makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>), RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures", WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT } as Env;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const b = JSON.parse(String(init?.body)) as { to: string | string[]; from: string; subject: string; text: string; reply_to?: string | string[]; attachments?: Array<{ filename: string }> };
      sends.push({ to: Array.isArray(b.to) ? b.to.join(",") : b.to, from: b.from, subject: b.subject, text: b.text, inReplyTo: "", replyTo: String(b.reply_to ?? ""), files: (b.attachments ?? []).map((a) => a.filename) });
      return new Response(JSON.stringify({ id: `re_${sends.length}` }), { status: 200 });
    }
    if (String(url) === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 });
    if (String(url) === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
      const raw = Buffer.from((JSON.parse(String(init?.body)) as { raw: string }).raw, "base64url").toString();
      const [head, ...body] = raw.split("\r\n\r\n");
      const h = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(head!)?.[1] ?? "";
      sends.push({ to: h("To"), from: h("From"), subject: h("Subject"), text: body.join("\r\n\r\n"), inReplyTo: h("In-Reply-To"), replyTo: h("Reply-To") });
      return new Response(JSON.stringify({ id: `gm_${sends.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES ('fu_sequoia_taylor', 'sequoia@westpeek.ventures', 'Sequoia Taylor', 'ACTIVE')").run();
  await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, angle, status, sponsor_categories_json, pitch_token) VALUES ('tlc_2027-03', '2027-03', '2027-03-18', 'EVENING', 'Build Your Own AI Agent', 'A hands-on evening.', 'TOPIC_READY', '[]', ?1)").bind("c".repeat(32)).run();
  const h = await contentHashes(env);
  await env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value) VALUES ('pitch_approved_hash', ?1), ('playbook_approved_hash', ?2), ('brand_send', 'on'), ('brand_reply_approver_email', ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(h.pitch, h.playbook, APPROVER).run();
  await env.WP_OS_DB.prepare("INSERT INTO outside_email_allow (item_type, item_id, allowed, changed_by) VALUES ('JOB','tlc_brand_sales',1,'test')").run();
  await deal("tld_away", "Away Co", "pat@away.example");
  await deal("tld_vec", "Vector Co (vector.example)", "sam@vector.example");
  await deal("tld_bot", "Bot Co", "lee@bot.example");
});
afterEach(() => { sends.length = 0; });
afterAll(async () => { vi.unstubAllGlobals(); await disposeTestDb(t); });

describe("what a brand's message means", () => {
  it("reads their words, not the quoted original, and tells an auto-reply, a no, a call and a question apart", () => {
    expect(theirNewText(`Hi Sequoia,\n\nWhat do you have in mind?${QUOTED}`)).toBe("Hi Sequoia,\n\nWhat do you have in mind?");
    expect(classifyBrandReply({ subject: "Re: Vector Co + a small room in New York", text: `Hi Sequoia,\n\nWhat do you have in mind?${QUOTED}` }, MORNING)).toEqual({ kind: "REPLY", intent: "QUESTION" });
    expect(classifyBrandReply({ subject: "Automatic reply: Away Co + a small room", text: "I am out of the office and will be back on November 16." }, MORNING))
      .toEqual({ kind: "AUTO_REPLY", resumeAt: "2026-11-17T14:00:00.000Z" });
    expect(classifyBrandReply({ subject: "Re: x", text: "Thanks, but this isn't a fit for us." }, MORNING)).toEqual({ kind: "NO" });
    expect(classifyBrandReply({ subject: "Re: x", text: "Happy to hop on a call next week." }, MORNING)).toEqual({ kind: "REPLY", intent: "CALL" });
  });
});

describe("a brand replied", () => {
  it("an out-of-office: no draft, no approval email, and the drip resumes the day after they are back", async () => {
    expect(await arrive("Pat <pat@away.example>", "Automatic reply: Away Co + a small room in New York", "I'm currently out of the office, returning Monday, November 16.", "ooo-1@away.example", MORNING)).toEqual({ matched: 1, stop: "AUTO_REPLY" });
    expect(await env.WP_OS_DB.prepare("SELECT stop_reason, replied_at, stage, next_send_at FROM tlc_deal WHERE id = 'tld_away'").first())
      .toEqual({ stop_reason: null, replied_at: null, stage: "PITCHED", next_send_at: "2026-11-17T14:00:00.000Z" });
    expect(await processBrandReplies(env, AFTERNOON, "west-peek", deps)).toMatch(/no brand reply waiting for her$/);
    expect(sends).toHaveLength(0);
  });

  it("each real reply is drafted and her approval email goes AT ONCE, not at 16:00 (\"Why 4pm?\"), with their words and the draft word for word, once", async () => {
    // 09:00 in Chicago: the approval goes now, on arrival — no waiting for an hour of the day.
    expect(await arrive("Sam <sam@vector.example>", "Re: Vector + a small room in New York", `Hi Sequoia,\n\nWhat do you have in mind?${QUOTED}`, "q-1@vector.example", MORNING)).toEqual({ matched: 1, stop: "REPLIED" });
    expect(sends).toHaveLength(1);
    expect(await arrive("Lee <lee@bot.example>", "Re: Bot Co + a small room in New York", "Sounds interesting. Can we set up a call?", "c-1@bot.example", new Date("2026-11-10T16:00:00.000Z"))).toEqual({ matched: 1, stop: "REPLIED" });
    expect(sends).toHaveLength(2);
    // The firm's boundary keeps employee mail on the partner addresses: her partner inbox.
    for (const n of sends) {
      expect(n.to).toBe("sequoia@westpeek.ventures");
      expect(n.subject).toMatch(/^Wynn: 1 brand reply to approve · TLR-[A-Z0-9]{6}$/);
      expect(n.text).toContain("Reply approved to send, or reply with changes");
    }
    expect(sends[0]!.text).toContain("Subject: Re: Vector + a small room in New York\n\nHi Sequoia,\n\nWhat do you have in mind?");
    expect(sends[1]!.text).toContain("Sounds interesting. Can we set up a call?");
    const drafts = (await env.WP_OS_DB.prepare("SELECT draft_body, notice_ref FROM tlc_brand_reply WHERE state = 'NOTIFIED' ORDER BY received_at").all<{ draft_body: string; notice_ref: string }>()).results!;
    expect(drafts).toHaveLength(2);
    expect(new Set(drafts.map((d) => d.notice_ref)).size).toBe(2);
    for (const [k, d] of drafts.entries()) {
      expect(sends[k]!.text).toContain(d.draft_body);
      expect(d.draft_body).toMatch(/Sequoia Taylor\nWest Peek Ventures\nsequoia@westpeek\.ventures$/);
    }
    // Send-once: the next passes send nothing more; her stage is untouched until she approves.
    expect(await processBrandReplies(env, AFTERNOON, "west-peek", deps)).toBe("brand replies: 0 drafted, 0 auto-reply (drip resumed), 0 declined; inbox not read; no brand reply waiting for her");
    expect(sends).toHaveLength(2);
    expect((await env.WP_OS_DB.prepare("SELECT stage FROM tlc_deal WHERE id = 'tld_bot'").first<{ stage: string }>())!.stage).toBe("PITCHED");
    // A re-delivered reply is the same message: not drafted twice, not sent to her twice.
    expect(await arrive("Lee <lee@bot.example>", "Re: Bot Co + a small room in New York", "Sounds interesting. Can we set up a call?", "c-1@bot.example", AFTERNOON)).toEqual({ matched: 1, stop: "REPLIED" });
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_brand_reply WHERE deal_id = 'tld_bot'").first<{ n: number }>())!.n).toBe(1);
    expect(sends).toHaveLength(2);
  });

  it("a reply from anyone but her is refused; her \"approved\" sends each answer ONCE, from her mailbox, on their thread", async () => {
    const refs = (await env.WP_OS_DB.prepare("SELECT ref FROM tlc_brand_reply_notice ORDER BY sent_at").all<{ ref: string }>()).results!.map((r) => r.ref);
    expect(refs).toHaveLength(2);
    const ref = refs[0]!;
    expect((await herReply(`approved\n\nRef ${ref}`, ref, "someone@else.example")).handled).toBe(false);
    expect((await herReply(`approved\n\nRef ${ref}`, ref, APPROVER, `${TRUSTED_AUTHSERV_ID}; dkim=fail; spf=fail smtp.mailfrom=${APPROVER}; dmarc=fail`)).handled).toBe(false);
    expect(sends).toHaveLength(0);

    for (const r of refs) expect((await herReply(`Approved\n\nOn Tue, Wynn wrote:\n> Ref ${r}`, r)).handled).toBe(true);
    const toBrands = sends.filter((s) => s.to.endsWith(".example"));
    expect(toBrands.map((s) => s.to).sort()).toEqual(["lee@bot.example", "sam@vector.example"]);
    for (const s of toBrands) {
      expect(s.from).toBe("Sequoia Taylor <sequoia@westpeek.ventures>");
      expect(s.subject).toMatch(/^Re: /);
    }
    expect(toBrands.find((s) => s.to === "sam@vector.example")!.inReplyTo).toBe("<q-1@vector.example>");
    expect(toBrands.find((s) => s.to === "lee@bot.example")!.inReplyTo).toBe("<c-1@bot.example>");
    // The call THEY asked for moves the deal to CALL; a question leaves it pitched.
    expect(await env.WP_OS_DB.prepare("SELECT id, stage FROM tlc_deal WHERE id IN ('tld_bot','tld_vec') ORDER BY id").all().then((r) => r.results)).toEqual([{ id: "tld_bot", stage: "CALL" }, { id: "tld_vec", stage: "PITCHED" }]);

    // Her "approved" again (or a re-delivery): nothing goes to a brand a second time.
    sends.length = 0;
    for (const r of refs) await herReply(`approved\n\nRef ${r}`, r);
    await runDrip(env, AFTERNOON, "west-peek", deps);
    expect(sends.filter((s) => s.to.endsWith(".example"))).toHaveLength(0);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_brand_reply WHERE state = 'SENT'").first<{ n: number }>())!.n).toBe(2);
  });

  it("a reply that changes the draft is redrafted and sent back to her, not to the brand", async () => {
    await deal("tld_tea", "Tea Co", "kim@tea.example");
    await arrive("Kim <kim@tea.example>", "Re: Tea Co + a small room in New York", "Tell me more about the room?", "t-1@tea.example", new Date("2026-11-11T15:00:00.000Z"));
    const ref = (await env.WP_OS_DB.prepare("SELECT notice_ref FROM tlc_brand_reply WHERE deal_id = 'tld_tea'").first<{ notice_ref: string }>())!.notice_ref;
    sends.length = 0;
    expect((await herReply(`make it shorter\n\nRef ${ref}`, ref)).handled).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toBe("sequoia@westpeek.ventures");
    expect(sends[0]!.text).toContain('Shorter, per "make it shorter".');
    expect(sends[0]!.text).toContain("Tell me more about the room?");
  });
});

/**
 * WYNN LISTENS (owner, 26 Oct 2026, TLR-EL84CT). Her change note was cut at 600 characters and only the email was
 * rewritten: no research, no report, and her standing preferences were forgotten by the next draft.
 */
describe("Wynn listens to her whole note, researches when asked, and keeps her standing rules", () => {
  const researcher: BrandResearcher = async () => ({
    ok: true,
    text: JSON.stringify({
      care: ["They launched a developer program for agent builders this autumn"],
      value: ["A hands-on room of founders building agents, with their product in hands"],
      sources: [{ title: "Their developer blog", url: "https://cone.example/blog/agents" }],
    }),
    detail: "ok",
  });
  let failNext = 0;
  const flaky: BrandResearcher = async (e, a, p) => (failNext-- > 0 ? { ok: false, text: "", detail: "no seat free" } : researcher(e, a, p));
  const her = (body: string, ref: string, at = AFTERNOON) =>
    applyBrandReplyApproval(env, { fromHeader: `Her <${APPROVER}>`, authenticationResults: auth(APPROVER), subject: `Re: Wynn: 1 brand reply to approve · ${ref}`, body }, { now: at, drafter, researcher: flaky });
  async function replyFrom(id: string, brand: string, email: string, mid: string): Promise<string> {
    await deal(id, brand, email);
    await arrive(`Pat <${email}>`, `Re: ${brand} + a small room in New York`, "Thanks for reaching out. What did you have in mind?", mid, AFTERNOON);
    return (await env.WP_OS_DB.prepare("SELECT notice_ref FROM tlc_brand_reply WHERE deal_id = ?1").bind(id).first<{ notice_ref: string }>())!.notice_ref;
  }

  it("reads her WHOLE note (past 600 characters), without her signature, and the redraft is told every instruction", async () => {
    const ref = await replyFrom("tld_long", "Long Co", "pat@long.example", "l-1@long.example");
    sends.length = 0;
    seen.length = 0;
    const filler = "Explain who we are, that Rooms is our event series and that The Learning Club is the hands-on part, and that we want to partner to build something special together. ".repeat(4);
    const last = "LAST INSTRUCTION: say the month is tentative and the club could repeat.";
    const note = `${filler}${last}`;
    expect(note.length).toBeGreaterThan(600);
    expect((await her(`${note}\n\nSequoia\n\nSent from my iPhone\n\nOn Tue, Wynn wrote:\n> Ref ${ref}`, ref)).handled).toBe(true);
    const told = seen.at(-1)!;
    expect(told.note).toContain(last);
    expect(told.note).not.toMatch(/Sent from my iPhone|^Sequoia$/m);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).toContain("YOUR NOTE, WORD FOR WORD");
    expect(sends[0]!.text).toContain(last);
  });

  it("a request to research makes Wynn research the brand first: the re-sent approval email carries his report ABOVE the new draft", async () => {
    const ref = await replyFrom("tld_cone", "Cone Co", "pat@cone.example", "k-1@cone.example");
    sends.length = 0;
    seen.length = 0;
    // The search lane is busy on the first try: nothing half-done goes to her, and the reply waits for the research.
    failNext = 1;
    const ask = "Don't discuss money this early. Do some research and figure out what value we can bring them first and give me a report and a new draft email.";
    expect((await her(`${ask}\n\nRef ${ref}`, ref)).handled).toBe(true);
    expect(sends).toHaveLength(0);
    const waiting = (await env.WP_OS_DB.prepare("SELECT state, research_due, research_tries FROM tlc_brand_reply WHERE deal_id = 'tld_cone'").first<{ state: string; research_due: string | null; research_tries: number }>())!;
    expect(waiting).toMatchObject({ state: "DRAFTED", research_tries: 1 });
    expect(waiting.research_due).not.toBeNull();
    // The next pass after it is due: the research runs, and her approval email goes at once with the report.
    await processBrandReplies(env, new Date(AFTERNOON.getTime() + 31 * 60_000), "west-peek", { drafter, mailbox: null, researcher: flaky });
    expect(sends).toHaveLength(1);
    const t = sends[0]!.text;
    for (const part of ["WYNN'S REPORT ON CONE CO", "What they care about now", "The value we bring them", "Sources", "https://cone.example/blog/agents"]) expect(t).toContain(part);
    expect(t.indexOf("What they care about now")).toBeLessThan(t.indexOf("WYNN'S DRAFT OF YOUR ANSWER"));
    expect(seen.at(-1)!.research).toContain("developer program for agent builders");
    // Her standing sentence is now one of Wynn's rules.
    expect((await env.WP_OS_DB.prepare("SELECT source FROM tlc_wynn_rule WHERE rule = ?1").bind("Don't discuss money this early.").first<{ source: string }>())!.source).toBe(`her note on ${ref}`);
  });

  it("a fresh draft reads Wynn's rules from data: no money before a call, who we are, never asks for a call", async () => {
    // A rule added as data reaches the very next draft.
    await env.WP_OS_DB.prepare("INSERT INTO tlc_wynn_rule (id, code, rule, source) VALUES ('wr_test_rule', NULL, 'Never use exclamation marks.', 'test')").run();
    seen.length = 0;
    sends.length = 0;
    await deal("tld_cash", "Cash Co", "pat@cash.example");
    const moneyAndCall: ReplyDrafter = async (e, a, i) => { seen.push(i); return { ok: true, body: "Hi,\n\nA Partner seat is $5,000 and a Title partner $25,000. Would a short call next week suit?", detail: "ok" }; };
    const { takeBrandReply } = await import("../src/worker/services/tlcBrandReply");
    const d = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = 'tld_cash'").first())! as never;
    expect(await takeBrandReply(env, d, { messageId: "<m-1@cash.example>", subject: "Re: Cash Co", text: "Tell me more?", receivedAt: AFTERNOON.toISOString() }, { now: AFTERNOON, drafter: moneyAndCall })).toBe("DRAFTED");
    const told = seen.at(-1)!;
    expect(told.noMoney).toBe(true);
    expect(told.rules.map((r) => r.code)).toEqual(expect.arrayContaining(["NO_MONEY_EARLY", "WHO_WE_ARE", "NO_CALL_ASK"]));
    expect(told.rules.map((r) => r.rule)).toContain("Never use exclamation marks.");
    const block = rulesBlock(told.rules).join("\n");
    expect(block).toContain("Quarantine Con");
    expect(block).toContain("Never suggest or ask for a call");
    // "Your team leads the demo" is refused: we host every segment ourselves or bring in a host.
    expect(told.rules.map((r) => r.code)).toContain("WE_HOST");
    await deal("tld_host", "Host Co", "pat@host.example");
    const staffed: ReplyDrafter = async () => ({ ok: true, body: "Hi,\n\nYour team leads the hands-on demo for the evening.", detail: "ok" });
    const d3 = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = 'tld_host'").first())! as never;
    await takeBrandReply(env, d3, { messageId: "<m-3@host.example>", subject: "Re: Host Co", text: "Tell me more?", receivedAt: AFTERNOON.toISOString() }, { now: AFTERNOON, drafter: staffed });
    expect((await env.WP_OS_DB.prepare("SELECT draft_body FROM tlc_brand_reply WHERE deal_id = 'tld_host'").first<{ draft_body: string }>())!.draft_body).not.toMatch(/your team leads/i);
    const { draftProblems } = await import("../src/worker/services/tlcBrandReply");
    expect(draftProblems("A segment led by Host Co or by our host.", "QUESTION", { weHost: true })).toEqual([]);
    // 25 to 100+ guests per event, flexible (owner, 30 Oct 2026): never the club's planned size, never the old 25–40.
    expect(draftProblems("A room of 80 to 120 people.", "QUESTION")).toEqual(["a room of 80 to 120 (her rule: 25 to 100+ guests per event, flexible)"]);
    expect(draftProblems("A room of 25–40 guests, flexible to your goals.", "QUESTION")).toEqual(["a room of 25 to 40 (her rule: 25 to 100+ guests per event, flexible)"]);
    expect(draftProblems("A room of 25 to 100 guests.", "QUESTION")).toEqual(["a room of 25 to 100 (her rule: 25 to 100+ guests per event, flexible)"]);
    expect(draftProblems("A room of 25 to 100+ guests, flexible to your goals.", "QUESTION")).toEqual([]);
    expect(block).toContain("led by the brand or by our host");
    // Money alone (no call ask) is refused too: the no-money rule stands on its own.
    await deal("tld_cash2", "Cash Two", "pat@cash2.example");
    const moneyOnly: ReplyDrafter = async () => ({ ok: true, body: "Hi,\n\nA Partner seat is $5,000.", detail: "ok" });
    const d2 = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = 'tld_cash2'").first())! as never;
    await takeBrandReply(env, d2, { messageId: "<m-2@cash2.example>", subject: "Re: Cash Two", text: "Tell me more?", receivedAt: AFTERNOON.toISOString() }, { now: AFTERNOON, drafter: moneyOnly });
    expect((await env.WP_OS_DB.prepare("SELECT draft_body FROM tlc_brand_reply WHERE deal_id = 'tld_cash2'").first<{ draft_body: string }>())!.draft_body).not.toContain("$");
    const body = (await env.WP_OS_DB.prepare("SELECT draft_body FROM tlc_brand_reply WHERE deal_id = 'tld_cash'").first<{ draft_body: string }>())!.draft_body;
    expect(body).not.toMatch(/\$|tier|price|Title partner/i);
    expect(body).not.toMatch(/short call|two times|pick a time/i);
    expect(body).toContain("more than 5,000 people");
    expect(body).toContain("Quarantine Con");
    expect(body).toContain(THREE_THINGS_OFFER);
    expect(body).toContain("Who are the people you most want to reach?");
  });

  it("a yes does not move a deal to CALL; only a call the brand proposed does", async () => {
    const { stageAfterReply } = await import("../src/shared/tlc/brandReply");
    expect(stageAfterReply("YES", "PITCHED")).toBeNull();
    expect(stageAfterReply("QUESTION", "PITCHED")).toBeNull();
    expect(stageAfterReply("CALL", "PITCHED")).toBe("CALL");
  });

  it("her note: signature off, nothing cut, a multi-line change note kept whole, standing sentences found", () => {
    const long = `${"x".repeat(700)} keep this end`;
    expect(herNoteOf(`${long}\n\nSequoia Taylor\nGeneral Partner`, "Sequoia Taylor")).toBe(long);
    expect(herNoteOf("Shorter please.\nThanks,\nSequoia", "Sequoia Taylor")).toBe("Shorter please.");
    expect(parseDraftReply(`change 2: shorter\nand mention the series of six\n${"y".repeat(650)}\napprove 1`)).toMatchObject({ approve: [1], change: [{ n: 2, note: `shorter\nand mention the series of six\n${"y".repeat(650)}` }] });
    expect(standingRulesIn("Don't discuss money this early. Explain who we are. Never ask for a call.")).toEqual(["Don't discuss money this early.", "Never ask for a call."]);
  });
});

/**
 * A YES TO THE THREE SAMPLES, AND A CALL THE BRAND ASKED FOR (owner, 26 Oct 2026). Fake brands only.
 */
describe("a yes to the samples gets the 3-page PDF; a call they asked for is scheduled from her calendar", () => {
  const SAMPLE_WORDS = {
    title: "Build Your First AI Agent", leaveFact: "everyone leaves with a working agent", openingTheme: "What agents can do now",
    panelAngle: "what changed when they put agents to work", dinnerPick: "pick the agent they'll build", segmentTitle: "Making it remember",
    segmentDoes: "every table wires Sample Co into its agent", leaveWith: "A working AI agent of their own", seriesTitle: "the agent syllabus",
    seriesTail: "with Sample Co as the memory from month 2 on.",
    months: ["Your First Agent", "Give It a Memory", "Tools", "A Human in the Loop", "A Team of Agents", "Launch Night"].map((title, k) => ({ title, line: `Month ${k + 1}, hands-on.`, brand: k === 1 })),
    whyLead: "Real code proofs:", whyLine: "starter templates the community keeps using.", perks: [{ lead: "Built in from day one:", line: "Sample Co is in every starter template." }],
  };
  const THREE_PAGES = { pdfBase64: Buffer.from("%PDF-1.4 /Type /Page a /Type /Page b /Type /Page c").toString("base64"), pageCount: 3 };
  const MON = new Date("2026-11-09T14:00:00.000Z"); // Monday 09:00 in New York
  const docEnv = () => ({ ...env, WP_OS_DOCUMENTS: t.docs } as Env);
  const sentDrip = async (dealId: string, body: string) =>
    env.WP_OS_DB.prepare("INSERT INTO tlc_drip_message (id, deal_id, step, subject, body, state, sent_at) VALUES (?1, ?2, 1, 'x', ?3, 'SENT', '2026-11-05T15:00:00.000Z')").bind(`tdm_${crypto.randomUUID()}`, dealId, body).run();
  const take = async (e: Env, dealId: string, text: string, mid: string, extra: Record<string, unknown> = {}) => {
    const { takeBrandReply } = await import("../src/worker/services/tlcBrandReply");
    const d = (await e.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(dealId).first())! as never;
    return takeBrandReply(e, d, { messageId: `<${mid}>`, subject: "Re: x + a small room in New York", text, receivedAt: MON.toISOString() }, { now: MON, drafter, ...extra });
  };
  const approve = (e: Env, ref: string, deps: Record<string, unknown> = {}) =>
    applyBrandReplyApproval(e, { fromHeader: `Her <${APPROVER}>`, authenticationResults: auth(APPROVER), subject: `Re: Wynn · ${ref}`, body: `approved\n\nRef ${ref}` }, { now: MON, drafter, ...deps });
  const refOf = async (dealId: string) => (await env.WP_OS_DB.prepare("SELECT notice_ref FROM tlc_brand_reply WHERE deal_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(dealId).first<{ notice_ref: string }>())!.notice_ref;

  const PREVIEW_URL = /https:\/\/os\.joinwestpeek\.com\/api\/tlc-pitch\/samples\/([0-9a-f]{32})/;
  /** Her private preview page, opened with no login at all (the token is the credential). */
  const openPreview = async (e: Env, url: string) => {
    const { handleRequest } = await import("../src/worker/index");
    return handleRequest(new Request(url.replace("https://os.joinwestpeek.com", "https://test.local")), e);
  };
  /** The document part of a page: from the first sheet to the last, byte for byte. */
  const sheets = (html: string) => html.slice(html.indexOf('<section class="sheet">'), html.lastIndexOf("</section>") + "</section>".length);

  it("\"Sure, send it\": Parker readies the samples PAGE, her approval email links it (no PDF), her approved makes the PDF ONCE and sends both ONCE", async () => {
    const e = docEnv();
    await deal("tld_samp", "Sample Co", "pat@sample.example");
    await sentDrip("tld_samp", `Hi,\n\n${THREE_THINGS_OFFER}`);
    sends.length = 0;
    const rendered: string[] = [];
    const prompts: string[] = [];
    const renderPdf = async (html: string) => { rendered.push(html); return THREE_PAGES; };
    expect(await take(e, "tld_samp", "Sure, send it over!", "s-1@sample.example", { samples: { renderPdf, writer: async (_e: Env, _a: unknown, prompt: string) => { prompts.push(prompt); return { ok: true, text: JSON.stringify(SAMPLE_WORDS) }; } } })).toBe("DRAFTED");
    // Wynn is asked for the per-brand words only; the standard text is never his to write.
    expect(prompts).toHaveLength(1);
    for (const field of ["title:", "openingTheme:", "panelAngle:", "segmentTitle:", "segmentDoes:", "leaveWith:", "months:", "whyLead and whyLine:", "perks:"]) expect(prompts[0]).toContain(field);
    for (const fixed of ["Who's in the room", "The team behind the room", "Confidential", "25 to 100+", "~5,000", "Scooter"]) expect(prompts[0]).not.toContain(fixed);
    const { sendReplyApprovals } = await import("../src/worker/services/tlcBrandReply");
    await sendReplyApprovals(e, MON);
    expect(sends).toHaveLength(1);
    const toHer = sends[0]!;
    expect(toHer.to).toBe("sequoia@westpeek.ventures");
    // The samples are a link while she decides: no PDF made, none attached.
    expect(rendered).toHaveLength(0);
    expect(toHer.files).toEqual([]);
    expect(toHer.text).toContain("Here's a short 3-page PDF, built around Sample Co:");
    expect(toHer.text).toContain("led by Sample Co or by our host");
    expect(toHer.text).toMatch(new RegExp(`THE SAMPLES \\(3 pages\\), OPEN ON YOUR PHONE OR LAPTOP: ${PREVIEW_URL.source}`));
    expect(toHer.text).toContain("The PDF is made from that page when you reply approved");
    const page = await openPreview(e, PREVIEW_URL.exec(toHer.text)![0]);
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain("Draft · not sent yet");
    expect(pageHtml).toContain("Making it remember");
    sends.length = 0;
    const ref = await refOf("tld_samp");
    expect((await approve(e, ref, { samples: { renderPdf } })).handled).toBe(true);
    // ONE PDF, made from exactly what the page showed.
    expect(rendered).toHaveLength(1);
    expect(sheets(rendered[0]!)).toBe(sheets(pageHtml));
    const toBrand = sends.filter((x) => x.to.includes("sample.example"));
    expect(toBrand).toHaveLength(1);
    expect(toBrand[0]!.text).toContain("The Learning Club - Build Your First AI Agent - Sample Co.pdf");
    const row = (await e.WP_OS_DB.prepare("SELECT state, pdf_r2_key, pdf_name FROM tlc_samples WHERE deal_id = 'tld_samp'").first<{ state: string; pdf_r2_key: string | null; pdf_name: string }>())!;
    expect(row.state).toBe("SENT");
    expect(row.pdf_r2_key).toBeTruthy();
    expect(row.pdf_name).toBe("The Learning Club - Build Your First AI Agent - Sample Co.pdf");
    // A second "approved" sends nothing again and makes no second PDF.
    sends.length = 0;
    await approve(e, ref, { samples: { renderPdf } });
    expect(sends.filter((x) => x.to.includes("sample.example"))).toHaveLength(0);
    expect(rendered).toHaveLength(1);
  });

  it("a direct request links the page; her edits change the PAGE (no PDF), keep earlier edits, and list what changed at the top", async () => {
    const e = docEnv();
    await deal("tld_edit", "Meadow Tools", "hello@meadow.example");
    const { planSamples, samplesForDeal, samplesAttachment } = await import("../src/worker/services/tlcSamples");
    const { sendReplyApprovals } = await import("../src/worker/services/tlcBrandReply");
    const d = (await e.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = 'tld_edit'").first())! as never;
    await planSamples(e, d, { segmentTitle: "A practical lab", seriesTitle: "Start together", reach: "builders" });
    const rendered: string[] = [];
    const renderPdf = async (html: string) => { rendered.push(html); return THREE_PAGES; };
    await take(e, "tld_edit", "Please send the materials", "edit@meadow.example", { samples: { renderPdf } });
    await sendReplyApprovals(e, MON);
    expect(sends.at(-1)!.files).toEqual([]);
    expect(sends.at(-1)!.text).toContain("Here's a short 3-page PDF");
    const url = PREVIEW_URL.exec(sends.at(-1)!.text)![0];
    const note = "Replace the series with a practice lab and make the footer say Dates agreed together";
    let patch = { seriesHeading: "A practice lab", footer2: "Dates agreed together" };
    const writer = async (_e: Env, _actor: unknown, prompt: string) => {
      expect(prompt).toContain("Owner's change note, word for word:");
      return { ok: true, text: JSON.stringify(patch) };
    };
    const revise = (ref: string, body: string, samples = { renderPdf, writer }) => applyBrandReplyApproval(e, { fromHeader: APPROVER, authenticationResults: auth(APPROVER), subject: ref, body }, {
      now: MON, samples, drafter: async (_env, _actor, input) => {
        expect(input.samplesAttached).toBe(true);
        return { ok: true, body: "Here's the attached PDF with a practice lab.", detail: "ok" };
      },
    });
    sends.length = 0;
    await revise(await refOf("tld_edit"), note);
    const edited = (await samplesForDeal(e, "tld_edit"))!;
    expect(JSON.parse(edited.overrides_json!)).toEqual(patch);
    // The change reached the page; no PDF was made for it, none is stored, none attached.
    expect(rendered).toHaveLength(0);
    expect(edited.pdf_r2_key).toBeNull();
    expect(await samplesAttachment(e, edited.id)).toBeNull();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.files).toEqual([]);
    expect(sends[0]!.text).toContain("Here's the attached PDF with a practice lab.");
    expect(sends[0]!.text).not.toContain("/api/documents/");
    // The same link as before (one page per deal), with the latest change named in the email.
    expect(PREVIEW_URL.exec(sends[0]!.text)![0]).toBe(url);
    expect(sends[0]!.text).toContain('Latest change: Changed the page 2 heading and the page 2 footer (your note: "Replace the series');
    let page = await (await openPreview(e, url)).text();
    expect(page).toContain("A practice lab");
    expect(page).toContain("Dates agreed together");
    expect(page).toContain("What changed (2): tap to show ▾");
    expect(page).toContain("First draft, from the approved template");
    patch = { seriesHeading: "Learn by doing" } as typeof patch;
    await revise(await refOf("tld_edit"), "Use Learn by doing as the series heading");
    expect(JSON.parse((await samplesForDeal(e, "tld_edit"))!.overrides_json!)).toEqual({ seriesHeading: "Learn by doing", footer2: "Dates agreed together" });
    page = await (await openPreview(e, url)).text();
    expect(page).toContain("What changed (3)");
    // Newest first: the latest change is the first line of the list and shows without opening it.
    expect(page.indexOf("Changed the page 2 heading (your note")).toBeLessThan(page.indexOf("Changed the page 2 heading and the page 2 footer"));
    expect(page).toContain("<b>Latest:</b> Changed the page 2 heading (your note");
    // Invalid money is never kept as an edit: the page keeps the last good version and says her change is still being made.
    const priceWriter = async () => ({ ok: true, text: JSON.stringify({ footer2: "Price: $4,000" }) });
    sends.length = 0;
    await revise(await refOf("tld_edit"), "Make the footer clearer", { renderPdf, writer: priceWriter });
    expect(sends).toHaveLength(0);
    expect((await samplesForDeal(e, "tld_edit"))!.state).toBe("FAILED");
    expect(JSON.parse((await samplesForDeal(e, "tld_edit"))!.overrides_json!).footer2).toBe("Dates agreed together");
    page = await (await openPreview(e, url)).text();
    expect(page).toContain("Your latest change is still being made.");
    expect(page).not.toContain("$4,000");
    expect(page).toContain("What changed (3)");
    await processBrandReplies(e, new Date(MON.getTime() + 31 * 60_000), "west-peek", { mailbox: null, drafter, samples: { renderPdf, writer: priceWriter } });
    expect(sends).toHaveLength(0);
    expect(rendered).toHaveLength(0);
    // The same amount is usable only after an explicit owner instruction, on this deal alone.
    const { reviseSamples } = await import("../src/worker/services/tlcSamples");
    const ev = (await e.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = 'tlc_2027-03'").first())! as never;
    expect((await reviseSamples(e, d, ev, "Include the price $4,000 in the PDF", { renderPdf, writer: priceWriter })).ok).toBe(true);
    expect(JSON.parse((await samplesForDeal(e, "tld_edit"))!.approved_prices_json!)).toEqual(["$4,000"]);
    expect(rendered).toHaveLength(0);
    await deal("tld_price_other", "Pebble Tools", "hello@pebble.example");
    const other = (await e.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = 'tld_price_other'").first())! as never;
    await planSamples(e, other, { segmentTitle: "A practical lab", seriesTitle: "Learn together", reach: "builders" });
    expect((await samplesForDeal(e, "tld_price_other"))!.approved_prices_json).toBeNull();
  });

  it("a revision that could not run yet retries the owner's note and revised email before another notice", async () => {
    const e = docEnv();
    const { planSamples } = await import("../src/worker/services/tlcSamples");
    const { sendReplyApprovals } = await import("../src/worker/services/tlcBrandReply");
    await deal("tld_retry_edit", "Sandstone Tools", "hello@sandstone.example");
    const d = (await e.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = 'tld_retry_edit'").first())! as never;
    await planSamples(e, d, { segmentTitle: "A useful prototype", seriesTitle: "First practice", reach: "builders" });
    const renderPdf = async () => { throw new Error("no PDF is made for a change"); };
    await take(e, "tld_retry_edit", "Please send the samples", "retry@sandstone.example", { samples: { renderPdf } });
    await sendReplyApprovals(e, MON);
    const note = "Call the series Field practice and explain the change in the email";
    const writer = async (_e: Env, _a: unknown, prompt: string) => {
      expect(prompt).toContain(note);
      return { ok: true, text: JSON.stringify({ seriesHeading: "Field practice" }) };
    };
    sends.length = 0;
    await applyBrandReplyApproval(e, { fromHeader: APPROVER, authenticationResults: auth(APPROVER), subject: await refOf("tld_retry_edit"), body: note }, {
      now: MON, drafter, samples: { renderPdf, writer: async () => ({ ok: false, text: "" }) },
    });
    expect(sends).toHaveLength(0);
    let drafted = false;
    await processBrandReplies(e, new Date(MON.getTime() + 31 * 60_000), "west-peek", {
      mailbox: null, samples: { writer, renderPdf },
      drafter: async (_env, _actor, input) => {
        expect(input.note).toBe(note);
        drafted = true;
        return { ok: true, body: "The edited Field practice PDF is attached.", detail: "ok" };
      },
    });
    expect(drafted).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).toContain("The edited Field practice PDF is attached.");
    expect(sends[0]!.files).toEqual([]);
    expect(sends[0]!.text).toMatch(PREVIEW_URL);
    expect(await (await openPreview(e, PREVIEW_URL.exec(sends[0]!.text)![0])).text()).toContain("Field practice");
  });

  it("her approved: the PDF is named from the CURRENT title; a busy renderer retries on its own; a 4-page PDF comes back to her; a sent row is never touched", async () => {
    const e = docEnv();
    const { planSamples, samplesForDeal } = await import("../src/worker/services/tlcSamples");
    const { sendReplyApprovals } = await import("../src/worker/services/tlcBrandReply");
    await deal("tld_final", "Harbor Tools", "hello@harbor.example");
    const d = (await e.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = 'tld_final'").first())! as never;
    await planSamples(e, d, { segmentTitle: "A working session", seriesTitle: "Build it together", reach: "builders" });
    await take(e, "tld_final", "Please send the materials", "final@harbor.example");
    await sendReplyApprovals(e, MON);
    const titleWriter = async () => ({ ok: true, text: JSON.stringify({ title: "Agents at Work" }) });
    await applyBrandReplyApproval(e, { fromHeader: APPROVER, authenticationResults: auth(APPROVER), subject: await refOf("tld_final"), body: "Call it Agents at Work" }, { now: MON, drafter, samples: { writer: titleWriter } });
    const url = PREVIEW_URL.exec(sends.at(-1)!.text)![0];
    const page = await (await openPreview(e, url)).text();
    expect(page).toContain("<title>The Learning Club: Agents at Work · Harbor Tools</title>");
    expect(page).toContain("Changed the title");
    // A 4-page PDF is not sent: the reply comes back to her as a draft, saying what to do.
    sends.length = 0;
    const FOUR = { pdfBase64: Buffer.from("%PDF-1.4").toString("base64"), pageCount: 4 };
    await approve(e, await refOf("tld_final"), { samples: { renderPdf: async () => FOUR } });
    expect(sends.filter((x) => x.to.includes("harbor.example"))).toHaveLength(0);
    const again = sends.find((x) => /brand reply to approve/.test(x.subject))!;
    expect(again.text).toContain("Not sent yet: the PDF came to 4 pages, not 3. Open the samples page and reply with what to shorten or change.");
    expect(again.text).toContain(url);
    expect((await samplesForDeal(e, "tld_final"))!.pdf_r2_key).toBeNull();
    // A busy renderer: approved, retried on its own (no second "approved" needed), sent once the PDF is made.
    sends.length = 0;
    await approve(e, await refOf("tld_final"), { samples: { renderPdf: async () => ({ pdfBase64: null, reason: "fixture browser busy" }) } });
    expect(sends.filter((x) => x.to.includes("harbor.example"))).toHaveLength(0);
    const held = (await e.WP_OS_DB.prepare("SELECT state, send_retry_due, send_tries FROM tlc_brand_reply WHERE deal_id = 'tld_final' ORDER BY created_at DESC LIMIT 1").first<{ state: string; send_retry_due: string | null; send_tries: number }>())!;
    expect(held).toMatchObject({ state: "FAILED", send_tries: 1 });
    expect(held.send_retry_due).toBeTruthy();
    const rendered: string[] = [];
    const draftPage = await (await openPreview(e, url)).text();
    await processBrandReplies(e, new Date(MON.getTime() + 31 * 60_000), "west-peek", { mailbox: null, drafter, samples: { renderPdf: async (html: string) => { rendered.push(html); return THREE_PAGES; } } });
    expect(rendered).toHaveLength(1);
    expect(sheets(rendered[0]!)).toBe(sheets(draftPage));
    expect(sheets(draftPage)).not.toBe("");
    const toBrand = sends.filter((x) => x.to.includes("harbor.example"));
    expect(toBrand).toHaveLength(1);
    // Named from the CURRENT title, never the old one.
    expect(toBrand[0]!.text).toContain("The Learning Club - Agents at Work - Harbor Tools.pdf");
    expect(toBrand[0]!.text).not.toContain("Build Your Own AI Agent - Harbor Tools.pdf");
    const done = (await samplesForDeal(e, "tld_final"))!;
    expect(done.state).toBe("SENT");
    expect(done.pdf_name).toBe("The Learning Club - Agents at Work - Harbor Tools.pdf");
    expect((await e.WP_OS_DB.prepare("SELECT state FROM tlc_brand_reply WHERE deal_id = 'tld_final' ORDER BY created_at DESC LIMIT 1").first<{ state: string }>())!.state).toBe("SENT");
    // The sent link shows exactly what the brand received: the stored PDF, byte for byte, never the template re-rendered.
    const sentPage = await openPreview(e, url);
    expect(sentPage.headers.get("content-type")).toBe("application/pdf");
    expect(sentPage.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(Buffer.from(await sentPage.arrayBuffer()).toString("base64")).toBe(THREE_PAGES.pdfBase64);
    const { reviseSamples } = await import("../src/worker/services/tlcSamples");
    const ev = (await e.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = 'tlc_2027-03'").first())! as never;
    // A sent row is not even shown to the model: no spend, no change.
    let modelCalls = 0;
    const counting = async () => { modelCalls += 1; return titleWriter(); };
    expect((await reviseSamples(e, d, ev, "Change the title again", { writer: counting })).ok).toBe(false);
    expect(modelCalls).toBe(0);
    expect(await samplesForDeal(e, "tld_final")).toEqual(done);
    // A row sent by hand (no token, a hand-built PDF) is left exactly as it is.
    await deal("tld_hand", "Hand Co", "hello@hand.example");
    await e.WP_OS_DB.prepare("INSERT INTO tlc_samples (id, deal_id, input_json, state, pdf_r2_key, pdf_name, sent_at) VALUES ('tls_hand', 'tld_hand', ?1, 'SENT', 'hand/built.pdf', 'Hand built.pdf', '2026-10-30T15:00:00.000Z')")
      .bind(JSON.stringify({ segmentTitle: "A session", seriesTitle: "An evening", reach: "builders" })).run();
    const handBefore = await samplesForDeal(e, "tld_hand");
    const hd = (await e.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = 'tld_hand'").first())! as never;
    const { buildSamples, samplesPreviewLink } = await import("../src/worker/services/tlcSamples");
    expect((await buildSamples(e, hd, ev)).ok).toBe(true);
    expect((await reviseSamples(e, hd, ev, "Call it Something else", { writer: counting })).ok).toBe(false);
    expect(modelCalls).toBe(0);
    expect(await samplesPreviewLink(e, "tls_hand")).toBeNull();
    expect(await samplesForDeal(e, "tld_hand")).toEqual(handBefore);
    // An unknown or malformed token is a bare 404.
    for (const bad of ["0123456789abcdef0123456789abcdee", "x"]) expect((await openPreview(e, `https://os.joinwestpeek.com/api/tlc-pitch/samples/${bad}`)).status).toBe(404);
    const ok = await openPreview(e, url);
    expect(ok.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });

  it("a yes with no samples offered is not read as a yes to samples, and a 'not now' never is", async () => {
    const e = docEnv();
    await deal("tld_nooffer", "Plain Co", "pat@plain.example");
    await take(e, "tld_nooffer", "Sure, sounds interesting", "n-1@plain.example");
    expect((await e.WP_OS_DB.prepare("SELECT samples_id FROM tlc_brand_reply WHERE deal_id = 'tld_nooffer'").first<{ samples_id: string | null }>())!.samples_id).toBeNull();
    await deal("tld_later", "Later Co", "pat@later.example");
    await sentDrip("tld_later", `Hi,\n\n${THREE_THINGS_OFFER}`);
    await take(e, "tld_later", "Not right now, maybe later in the year", "l-1@later.example");
    expect((await e.WP_OS_DB.prepare("SELECT samples_id FROM tlc_brand_reply WHERE deal_id = 'tld_later'").first<{ samples_id: string | null }>())!.samples_id).toBeNull();
  });

  it("they ask for a call: three open times from her calendar (never one she is busy for); they pick one; on her word it goes on her calendar, them invited", async () => {
    const { nyToUtc, slotWords } = await import("../src/shared/tlc/callSlots");
    const tue11 = nyToUtc(2026, 11, 10, 11).getTime();
    const busy = async () => ({ busy: [{ start: tue11, end: tue11 + 3_600_000 }], note: null });
    const made: Array<{ start: string; attendees: readonly string[] }> = [];
    const makeEvent = async (_e: Env, ev: { start: string; attendees: readonly string[] }) => { made.push(ev); return { id: "gcal_1" }; };
    await deal("tld_call", "Call Co", "kim@call.example");
    sends.length = 0;
    await take(env, "tld_call", "This looks great. Can we set up a call next week?", "c-1@call.example", { busy });
    const row = (await env.WP_OS_DB.prepare("SELECT offered_slots_json, draft_body, intent FROM tlc_brand_reply WHERE deal_id = 'tld_call'").first<{ offered_slots_json: string; draft_body: string; intent: string }>())!;
    const offered = JSON.parse(row.offered_slots_json) as string[];
    expect(offered.map(slotWords)).toEqual(["Tuesday 10 Nov, 2:00pm", "Wednesday 11 Nov, 11:00am", "Thursday 12 Nov, 11:00am"]);
    for (const x of offered) expect(row.draft_body).toContain(slotWords(x));
    expect(row.draft_body).not.toContain(THREE_THINGS_OFFER);
    const { sendReplyApprovals } = await import("../src/worker/services/tlcBrandReply");
    await sendReplyApprovals(env, MON);
    await approve(env, await refOf("tld_call"));
    expect(sends.some((x) => x.to.includes("call.example"))).toBe(true);
    expect(made).toHaveLength(0);
    // They pick Wednesday: agreed, drafted, and only on HER word does it go on the calendar.
    sends.length = 0;
    await take(env, "tld_call", "Wednesday works for us, thanks!", "c-2@call.example", { busy });
    const agreed = (await env.WP_OS_DB.prepare("SELECT agreed_slot, draft_body FROM tlc_brand_reply WHERE deal_id = 'tld_call' AND agreed_slot IS NOT NULL").first<{ agreed_slot: string; draft_body: string }>())!;
    expect(agreed.agreed_slot).toBe(offered[1]);
    expect(agreed.draft_body).toContain("Wednesday 11 Nov, 11:00am");
    await sendReplyApprovals(env, MON);
    expect(sends[0]!.text).toContain("ON YOUR WORD: Wednesday 11 Nov, 11:00am goes on your calendar, kim@call.example invited");
    expect(made).toHaveLength(0);
    sends.length = 0;
    const out = await approve(env, await refOf("tld_call"), { makeEvent });
    expect(made).toEqual([expect.objectContaining({ start: offered[1], attendees: ["kim@call.example"] })]);
    expect(out.detail).toContain("is on your calendar, kim@call.example invited");
    expect((await env.WP_OS_DB.prepare("SELECT stage FROM tlc_deal WHERE id = 'tld_call'").first<{ stage: string }>())!.stage).toBe("CALL");
  });

  it("steps 4 and 5: after the samples, the proposal with the one-pager; the level they pick gets the agreement and invoice; her approved agrees the deal ONCE", async () => {
    const e = docEnv();
    const render = { renderPdf: async () => ({ pdfBase64: Buffer.from("%PDF-1.4 /Type /Page a").toString("base64"), pageCount: 1 }) };
    await deal("tld_flow", "Flow Co", "ash@flow.example");
    await e.WP_OS_DB.prepare("INSERT INTO tlc_samples (id, deal_id, input_json, state, sent_at) VALUES ('tls_flow', 'tld_flow', ?1, 'SENT', '2026-11-06T15:00:00.000Z')")
      .bind(JSON.stringify({ segmentTitle: "Making it remember", seriesTitle: "Memory night", reach: "founders building agents" })).run();
    sends.length = 0;
    await take(e, "tld_flow", "Love the samples, a couple of notes: we'd want developers in the room.", "f-1@flow.example", { samples: render });
    const p = (await e.WP_OS_DB.prepare("SELECT kind, draft_body, attachments_json FROM tlc_brand_reply WHERE deal_id = 'tld_flow'").first<{ kind: string; draft_body: string; attachments_json: string }>())!;
    expect(p.kind).toBe("PROPOSAL");
    expect(p.draft_body).toContain("Here's how Flow Co could take part:");
    expect(p.draft_body).toContain('• Partner: "Making it remember", led by Flow Co or by our host');
    expect(p.draft_body).toContain("Prices for each are on the attached one-pager.");
    expect(JSON.parse(p.attachments_json)).toEqual([expect.objectContaining({ name: "The Learning Club - Build Your Own AI Agent - partner levels.pdf" })]);
    const { sendReplyApprovals } = await import("../src/worker/services/tlcBrandReply");
    await sendReplyApprovals(e, MON);
    expect(sends[0]!.files).toEqual(["The Learning Club - Build Your Own AI Agent - partner levels.pdf"]);
    // The exec format bolds numbers ("step **4**"), so the line is read without the bold.
    expect(sends[0]!.text.replace(/\*\*/g, "")).toContain("step 4: the proposal (prices on the attached one-pager)");
    await approve(e, await refOf("tld_flow"));
    expect(sends.filter((x) => x.to.includes("flow.example"))).toHaveLength(1);
    // They pick a level: the confirmation, with a one-page agreement and the invoice, for her approval.
    sends.length = 0;
    await take(e, "tld_flow", "Let's go with Presenting partner.", "f-2@flow.example", { samples: render });
    const c = (await e.WP_OS_DB.prepare("SELECT kind, tier, draft_body, attachments_json FROM tlc_brand_reply WHERE deal_id = 'tld_flow' AND kind = 'CONFIRM'").first<{ kind: string; tier: string; draft_body: string; attachments_json: string }>())!;
    expect(c.tier).toBe("PRESENTING");
    expect(c.draft_body).toContain("we're thrilled to have Flow Co as Presenting partner. Attached are a one-page agreement and the invoice.");
    expect((JSON.parse(c.attachments_json) as Array<{ name: string }>).map((f) => f.name)).toEqual(["The Learning Club - Flow Co - agreement.pdf", "The Learning Club - Flow Co - invoice.pdf"]);
    await sendReplyApprovals(e, MON);
    expect(sends[0]!.files).toEqual(["The Learning Club - Flow Co - agreement.pdf", "The Learning Club - Flow Co - invoice.pdf"]);
    expect((await e.WP_OS_DB.prepare("SELECT stage FROM tlc_deal WHERE id = 'tld_flow'").first<{ stage: string }>())!.stage).toBe("PITCHED");
    sends.length = 0;
    const ref = await refOf("tld_flow");
    await approve(e, ref);
    const toBrand = sends.filter((x) => x.to.includes("flow.example"));
    expect(toBrand).toHaveLength(1);
    expect(toBrand[0]!.text).toContain("Flow Co - agreement.pdf");
    expect(await e.WP_OS_DB.prepare("SELECT stage, tier, cash_offer_usd FROM tlc_deal WHERE id = 'tld_flow'").first()).toEqual({ stage: "AGREED", tier: "PRESENTING", cash_offer_usd: 15000 });
    sends.length = 0;
    await approve(e, ref);
    expect(sends.filter((x) => x.to.includes("flow.example"))).toHaveLength(0);
  });

  it("a time they proposed is accepted when she is free, and never when she is busy", async () => {
    const { nyToUtc } = await import("../src/shared/tlc/callSlots");
    const thu = nyToUtc(2026, 11, 12, 14, 30).getTime();
    await deal("tld_prop", "Prop Co", "lee@prop.example");
    await take(env, "tld_prop", "Could we do a quick call Thursday at 2:30pm?", "p-1@prop.example", { busy: async () => ({ busy: [], note: null }) });
    expect((await env.WP_OS_DB.prepare("SELECT agreed_slot FROM tlc_brand_reply WHERE deal_id = 'tld_prop'").first<{ agreed_slot: string }>())!.agreed_slot).toBe(new Date(thu).toISOString());
    await deal("tld_busy", "Busy Co", "lee@busy.example");
    await take(env, "tld_busy", "Could we do a quick call Thursday at 2:30pm?", "b-1@busy.example", { busy: async () => ({ busy: [{ start: thu - 600_000, end: thu + 3_600_000 }], note: null }) });
    const r = (await env.WP_OS_DB.prepare("SELECT agreed_slot, offered_slots_json FROM tlc_brand_reply WHERE deal_id = 'tld_busy'").first<{ agreed_slot: string | null; offered_slots_json: string }>())!;
    expect(r.agreed_slot).toBeNull();
    expect((JSON.parse(r.offered_slots_json) as string[]).includes(new Date(thu).toISOString())).toBe(false);
  });
});
