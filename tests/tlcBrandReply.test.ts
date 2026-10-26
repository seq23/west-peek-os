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
const sends: Array<{ to: string; from: string; subject: string; text: string; inReplyTo: string; replyTo: string }> = [];
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
      const b = JSON.parse(String(init?.body)) as { to: string | string[]; from: string; subject: string; text: string; reply_to?: string | string[] };
      sends.push({ to: Array.isArray(b.to) ? b.to.join(",") : b.to, from: b.from, subject: b.subject, text: b.text, inReplyTo: "", replyTo: String(b.reply_to ?? "") });
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
