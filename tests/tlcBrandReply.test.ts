import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { contentHashes, recordBrandMail, recordBrandReplyText, runDrip } from "../src/worker/services/learningClub";
import { applyBrandReplyApproval, processBrandReplies, type ReplyDrafter } from "../src/worker/services/tlcBrandReply";
import { classifyBrandReply, theirNewText } from "../src/shared/tlc/brandReply";
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
const drafter: ReplyDrafter = async (_e, _a, i) => ({ ok: true, body: `Hi,\n\n${i.note ? `Shorter, per "${i.note}".` : `Thanks for asking about ${i.topic}. A Partner is $5,000.`} Would a short call next week suit?`, detail: "ok" });
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

  it("two real replies on one day: drafted, and ONE approval email at the day's hour with both, word for word", async () => {
    expect(await arrive("Sam <sam@vector.example>", "Re: Vector + a small room in New York", `Hi Sequoia,\n\nWhat do you have in mind?${QUOTED}`, "q-1@vector.example", MORNING)).toEqual({ matched: 1, stop: "REPLIED" });
    expect(await arrive("Lee <lee@bot.example>", "Re: Bot Co + a small room in New York", "Sounds interesting. Can we set up a call?", "c-1@bot.example", new Date("2026-11-10T16:00:00.000Z"))).toEqual({ matched: 1, stop: "REPLIED" });
    // Before the day's hour nothing goes: the second reply joins the first.
    expect(await processBrandReplies(env, MORNING, "west-peek", deps)).toMatch(/2 brand replies waiting for the 16:00 CT email$/);
    expect(sends).toHaveLength(0);
    expect(await processBrandReplies(env, AFTERNOON, "west-peek", deps)).toMatch(/approval email TLR-[A-Z0-9]{6} with 2 brand replies sent$/);
    expect(sends).toHaveLength(1);
    const n = sends[0]!;
    // The firm's boundary keeps employee mail on the partner addresses: her partner inbox.
    expect(n.to).toBe("sequoia@westpeek.ventures");
    expect(n.subject).toMatch(/^Wynn: 2 brand replies to approve · TLR-[A-Z0-9]{6}$/);
    expect(n.text).toContain("Reply approved to send, or reply with changes");
    expect(n.text).toContain("Subject: Re: Vector + a small room in New York\r\n\r\nHi Sequoia,\r\n\r\nWhat do you have in mind?".replace(/\r\n/g, "\n"));
    expect(n.text).toContain("Sounds interesting. Can we set up a call?");
    const drafts = (await env.WP_OS_DB.prepare("SELECT draft_body FROM tlc_brand_reply WHERE state = 'NOTIFIED' ORDER BY received_at").all<{ draft_body: string }>()).results!;
    expect(drafts).toHaveLength(2);
    for (const d of drafts) {
      expect(n.text).toContain(d.draft_body);
      expect(d.draft_body).toMatch(/Sequoia Taylor\nWest Peek Ventures\nsequoia@westpeek\.ventures$/);
    }
    // The same day, nothing more; and her stage is untouched until she approves.
    expect(await processBrandReplies(env, new Date("2026-11-10T23:30:00.000Z"), "west-peek", deps)).toBe("brand replies: 0 drafted, 0 auto-reply (drip resumed), 0 declined; inbox not read; no brand reply waiting for her");
    expect(sends).toHaveLength(1);
    expect((await env.WP_OS_DB.prepare("SELECT stage FROM tlc_deal WHERE id = 'tld_bot'").first<{ stage: string }>())!.stage).toBe("PITCHED");
    // A re-delivered reply is the same message: not drafted twice.
    expect(await arrive("Lee <lee@bot.example>", "Re: Bot Co + a small room in New York", "Sounds interesting. Can we set up a call?", "c-1@bot.example", AFTERNOON)).toEqual({ matched: 1, stop: "REPLIED" });
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_brand_reply WHERE deal_id = 'tld_bot'").first<{ n: number }>())!.n).toBe(1);
  });

  it("a reply from anyone but her is refused; her \"approved\" sends each answer ONCE, from her mailbox, on their thread", async () => {
    const ref = (await env.WP_OS_DB.prepare("SELECT ref FROM tlc_brand_reply_notice").first<{ ref: string }>())!.ref;
    expect((await herReply(`approved\n\nRef ${ref}`, ref, "someone@else.example")).handled).toBe(false);
    expect((await herReply(`approved\n\nRef ${ref}`, ref, APPROVER, `${TRUSTED_AUTHSERV_ID}; dkim=fail; spf=fail smtp.mailfrom=${APPROVER}; dmarc=fail`)).handled).toBe(false);
    expect(sends).toHaveLength(0);

    const out = await herReply(`Approved\n\nOn Tue, Wynn wrote:\n> Ref ${ref}`, ref);
    expect(out.handled).toBe(true);
    const toBrands = sends.filter((s) => s.to.endsWith(".example"));
    expect(toBrands.map((s) => s.to).sort()).toEqual(["lee@bot.example", "sam@vector.example"]);
    for (const s of toBrands) {
      expect(s.from).toBe("Sequoia Taylor <sequoia@westpeek.ventures>");
      expect(s.subject).toMatch(/^Re: /);
    }
    expect(toBrands.find((s) => s.to === "sam@vector.example")!.inReplyTo).toBe("<q-1@vector.example>");
    expect(toBrands.find((s) => s.to === "lee@bot.example")!.inReplyTo).toBe("<c-1@bot.example>");
    // The call they asked for moves the deal to CALL; a question leaves it pitched.
    expect(await env.WP_OS_DB.prepare("SELECT id, stage FROM tlc_deal WHERE id IN ('tld_bot','tld_vec') ORDER BY id").all().then((r) => r.results)).toEqual([{ id: "tld_bot", stage: "CALL" }, { id: "tld_vec", stage: "PITCHED" }]);

    // Her "approved" again (or a re-delivery): nothing goes to a brand a second time.
    sends.length = 0;
    await herReply(`approved\n\nRef ${ref}`, ref);
    await runDrip(env, AFTERNOON, "west-peek", deps);
    expect(sends.filter((s) => s.to.endsWith(".example"))).toHaveLength(0);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_brand_reply WHERE state = 'SENT'").first<{ n: number }>())!.n).toBe(2);
  });

  it("a reply that changes the draft is redrafted and sent back to her, not to the brand", async () => {
    await deal("tld_tea", "Tea Co", "kim@tea.example");
    await arrive("Kim <kim@tea.example>", "Re: Tea Co + a small room in New York", "Tell me more about the room?", "t-1@tea.example", new Date("2026-11-11T15:00:00.000Z"));
    await processBrandReplies(env, new Date("2026-11-11T22:30:00.000Z"), "west-peek", deps);
    const ref = (await env.WP_OS_DB.prepare("SELECT notice_ref FROM tlc_brand_reply WHERE deal_id = 'tld_tea'").first<{ notice_ref: string }>())!.notice_ref;
    sends.length = 0;
    expect((await herReply(`make it shorter\n\nRef ${ref}`, ref)).handled).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toBe("sequoia@westpeek.ventures");
    expect(sends[0]!.text).toContain('Shorter, per "make it shorter".');
    expect(sends[0]!.text).toContain("Tell me more about the room?");
  });
});
