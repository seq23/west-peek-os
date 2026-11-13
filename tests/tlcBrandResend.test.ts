import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { gmailReadStub, type FakeMessage } from "./helpers/gmailMailbox";
import type { Env } from "../src/worker/env";
import { contentHashes, recordBrandMail, recordBrandReplyText } from "../src/worker/services/learningClub";
import { applyBrandReplyApproval, resendUnanswered, RESEND_SETTING_PREFIX, type ReplyDrafter, type ResendOrder } from "../src/worker/services/tlcBrandReply";
import { THREE_THINGS_OFFER } from "../src/shared/tlc/brandReply";
import { TRUSTED_AUTHSERV_ID } from "../src/shared/intake/partnerAuthority";

/**
 * WYNN NEVER DROPS THE THREAD, AND FOLLOWS UP ONCE WHEN A BRAND SAYS NOTHING (owner, 13 Nov 2026: "the pinecone latest
 * email did not go in the thread it should have … we need to follow up on the actual thread with the exact same
 * pricing email if we do not get a response in 7 days"; "never drop the thread!!!").
 * Her approved answer is a reply on the brand message's own conversation in her mailbox, or it is not sent. An answer
 * armed on her word goes again once, word for word with its PDF, after 7 quiet days, on that same conversation; any
 * message from the brand cancels it; nothing arms it by itself. Fake brands only.
 */
let t: TestDb;
let env: Env;
let SEQUOIA = "";
const toBrand: Array<{ threadId: string | undefined; to: string; cc: string; subject: string; inReplyTo: string; references: string; raw: string }> = [];
const toUs: Array<{ to: string; subject: string; text: string }> = [];
const SERVICE_ACCOUNT = JSON.stringify({ client_email: "sa@firm.iam.example", private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) });
const auth = (address: string) => `${TRUSTED_AUTHSERV_ID}; dkim=pass header.d=${address.split("@")[1]} header.s=s1; spf=pass smtp.mailfrom=${address}; dmarc=pass header.from=${address.split("@")[1]}`;
const SENT_AT = new Date("2026-11-10T15:00:00.000Z");
const days = (n: number) => new Date(SENT_AT.getTime() + n * 86_400_000);
const drafter: ReplyDrafter = async (_e, _a, i) => ({ ok: true, body: `Hi,\n\nThanks for asking about ${i.topic}. ${THREE_THINGS_OFFER}`, detail: "ok" });
// What her mailbox holds beyond each brand message itself: nothing, unless a test says so.
let notInMailbox = new Set<string>();
let search: (query: string) => FakeMessage | null = () => null;
const mailbox = gmailReadStub({ search: (q) => search(q), missing: (mid) => notInMailbox.has(mid) });
const row = (dealId: string) => env.WP_OS_DB.prepare("SELECT id, state, notice_ref, sent_at, held_reason, effect_request_id FROM tlc_brand_reply WHERE deal_id = ?1 ORDER BY received_at DESC").bind(dealId).first<{ id: string; state: string; notice_ref: string; sent_at: string | null; held_reason: string | null; effect_request_id: string | null }>();
/** The follow-up order for an answer, as its `tlc_setting` row holds it now. */
const order = async (replyId: string) => JSON.parse((await env.WP_OS_DB.prepare("SELECT value FROM tlc_setting WHERE key = ?1").bind(`${RESEND_SETTING_PREFIX}${replyId}`).first<{ value: string }>())!.value) as ResendOrder;

/** A brand asks; Wynn drafts; she approves; the answer goes. Returns what went to the brand. */
async function answered(dealId: string, brand: string, email: string) {
  await env.WP_OS_DB.prepare(
    "INSERT INTO tlc_deal (id, event_id, brand, contact_email, contact_source_url, why_fit, stage, drip_step, first_sent_at, last_sent_at, next_send_at, firm_scope) VALUES (?1, 'tlc_2027-03', ?2, ?3, 'https://example.test', 'fit', 'PITCHED', 1, '2026-11-09T15:00:00.000Z', '2026-11-09T15:00:00.000Z', NULL, 'west-peek')",
  ).bind(dealId, brand, email).run();
  await recordBrandMail(env, { from: `Pat <${email}>`, subject: `Re: ${brand} + a small room in New York`, now: SENT_AT });
  await recordBrandReplyText(env, { from: `Pat <${email}>`, subject: `Re: ${brand} + a small room in New York`, text: "Hi,\n\nWhat do you have in mind?", messageId: `<${dealId}@brand.example>`, now: SENT_AT });
  const ref = (await row(dealId))!.notice_ref;
  const out = await applyBrandReplyApproval(env, { fromHeader: `Her <${SEQUOIA}>`, authenticationResults: auth(SEQUOIA), subject: `Re: ${brand} Reply · v1 · ready for your OK · ${ref}`, body: "approved" }, { now: SENT_AT, drafter });
  return out.detail;
}

/** The answer that went, made a pricing email with a copy and its PDF (fixture rows only), and armed on her word. */
async function armed(dealId: string, brand: string, email: string, due = days(7)) {
  expect(await answered(dealId, brand, email)).toContain("sent from");
  const r = (await row(dealId))!;
  const sentRequest = (await env.WP_OS_DB.prepare("SELECT payload_json FROM external_effect_request WHERE id = ?1").bind(r.effect_request_id).first<{ payload_json: string }>())!;
  const payload = { ...JSON.parse(sentRequest.payload_json), cc: [`lee@${email.split("@")[1]}`], attachments: [{ filename: "partner levels.pdf", content: btoa("%PDF-1.4 the sheet that went"), contentType: "application/pdf" }] };
  await env.WP_OS_DB.prepare("UPDATE external_effect_request SET payload_json = ?2 WHERE id = ?1").bind(r.effect_request_id, JSON.stringify(payload)).run();
  await env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value, set_by) VALUES (?1, ?2, 'test')").bind(`${RESEND_SETTING_PREFIX}${r.id}`, JSON.stringify({ state: "ARMED", due: due.toISOString(), note: "Her words, 13 Nov: follow up on the actual thread with the exact same pricing email if no response in 7 days" })).run();
  toBrand.length = 0; toUs.length = 0;
  return { id: r.id, payload: payload as { subject: string; text: string } };
}

beforeAll(async () => {
  t = await createTestDb();
  env = { ...makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>), RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures", WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT } as Env;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const b = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
      toUs.push({ to: Array.isArray(b.to) ? b.to.join(",") : b.to, subject: b.subject, text: b.text });
      return new Response(JSON.stringify({ id: `re_${toUs.length}` }), { status: 200 });
    }
    if (String(url) === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 });
    if (String(url) === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
      const body = JSON.parse(String(init?.body)) as { raw: string; threadId?: string };
      const raw = Buffer.from(body.raw, "base64url").toString();
      const h = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(raw)?.[1] ?? "";
      toBrand.push({ threadId: body.threadId, to: h("To"), cc: h("Cc"), subject: h("Subject"), inReplyTo: h("In-Reply-To"), references: h("References"), raw });
      return new Response(JSON.stringify({ id: `gm_${toBrand.length}`, threadId: body.threadId ?? `newthread_${toBrand.length}` }), { status: 200 });
    }
    const read = mailbox(String(url));
    if (read) return read;
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  SEQUOIA = (await env.WP_OS_DB.prepare("SELECT email FROM firm_user WHERE id = 'fu_sequoia_taylor'").first<{ email: string }>())!.email;
  await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, angle, status, sponsor_categories_json, pitch_token) VALUES ('tlc_2027-03', '2027-03', '2027-03-18', 'EVENING', 'Build Your Own AI Agent', 'A hands-on evening.', 'TOPIC_READY', '[]', ?1)").bind("e".repeat(32)).run();
  const h = await contentHashes(env);
  await env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value) VALUES ('pitch_approved_hash', ?1), ('playbook_approved_hash', ?2), ('brand_send', 'on') ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(h.pitch, h.playbook).run();
  await env.WP_OS_DB.prepare("INSERT INTO outside_email_allow (item_type, item_id, allowed, changed_by) VALUES ('JOB','tlc_brand_sales',1,'test')").run();
});
afterEach(() => { toBrand.length = 0; toUs.length = 0; notInMailbox = new Set(); search = () => null; });
afterAll(async () => { vi.unstubAllGlobals(); await disposeTestDb(t); });

describe("her approved answer is a reply on the brand's conversation, or it is not sent", () => {
  it("goes on the thread her mailbox holds the brand's message in, answering that message", async () => {
    expect(await answered("tld_thr", "Thread Co", "pat@threadco.example")).toContain("sent from");
    expect(toBrand).toHaveLength(1);
    expect(toBrand[0]!.threadId).toBe("thread-of-tld_thr_brand_example");
    expect(toBrand[0]!.inReplyTo).toBe("<tld_thr@brand.example>");
    expect(toBrand[0]!.references).toBe("<tld_thr@brand.example>");
  });

  it("a brand message that reached only the intake door: the thread of the last email we sent that address, still answering their message", async () => {
    notInMailbox.add("tld_door@brand.example");
    search = (q) => (q === "in:sent to:pat@doorco.example" ? { id: "g-ours", threadId: "ourthread7", messageId: "CAours@mail.gmail.example", references: ["CAfirst@mail.gmail.example"] } : null);
    expect(await answered("tld_door", "Door Co", "pat@doorco.example")).toContain("sent from");
    expect(toBrand[0]!.threadId).toBe("ourthread7");
    expect(toBrand[0]!.inReplyTo).toBe("<tld_door@brand.example>");
    expect(toBrand[0]!.references).toBe("<CAfirst@mail.gmail.example> <CAours@mail.gmail.example> <tld_door@brand.example>");
  });

  it("no conversation in her mailbox at all: NAMED STOP, nothing goes to the brand, and her done email says so", async () => {
    notInMailbox.add("tld_lost@brand.example");
    const detail = await answered("tld_lost", "Lost Co", "pat@lostco.example");
    expect(detail).toContain("NOT sent (NAMED STOP [TLC_BRAND_THREAD_NOT_FOUND]: nothing sent");
    expect(toBrand).toHaveLength(0);
    expect((await row("tld_lost"))!.state).toBe("FAILED");
    expect(toUs.some((m) => m.text.includes("NAMED STOP [TLC_BRAND_THREAD_NOT_FOUND]"))).toBe(true);
  });
});

describe("the same email again, once, after 7 quiet days, on her word", () => {
  it("nothing before day 7 (even armed for an earlier day); on day 7 the email that went goes again word for word with its PDF, on their thread; never a third time", async () => {
    const a = await armed("tld_quiet", "Quiet Co", "pat@quietco.example", days(2));
    expect(await resendUnanswered(env, days(6.99), "west-peek", true)).toBe("pricing follow-ups: OUTPUT 0 resend_sent (1 armed and waiting, 0 cancelled by a reply)");
    expect(toBrand).toHaveLength(0);
    expect(await resendUnanswered(env, days(7), "west-peek", true)).toBe("pricing follow-ups: OUTPUT 1 resend_sent (0 armed and waiting, 0 cancelled by a reply)");
    expect(toBrand).toHaveLength(1);
    const again = toBrand[0]!;
    expect(again.to).toBe("pat@quietco.example");
    expect(again.cc).toBe("lee@quietco.example");
    expect(again.subject).toBe(a.payload.subject);
    expect(again.raw).toContain(a.payload.text.split("\n")[0]!);
    expect(again.raw.replace(/\r\n/g, "")).toContain(btoa("%PDF-1.4 the sheet that went"));
    expect(again.threadId).toBe("thread-of-tld_quiet_brand_example");
    expect(again.inReplyTo).toBe("<tld_quiet@brand.example>");
    // The stored request is the first one's words and PDF exactly, plus the thread.
    const done = await order(a.id);
    expect(done.state).toBe("SENT");
    const resent = JSON.parse((await env.WP_OS_DB.prepare("SELECT payload_json FROM external_effect_request WHERE id = ?1 AND state = 'EXECUTED'").bind(done.effect_request_id).first<{ payload_json: string }>())!.payload_json);
    expect(resent).toMatchObject({ subject: a.payload.subject, text: a.payload.text, cc: ["lee@quietco.example"], attachments: [{ filename: "partner levels.pdf", content: btoa("%PDF-1.4 the sheet that went") }] });
    // Her approval of this one follow-up is the card's decision, in her words; and she is told it went.
    const decided = await env.WP_OS_DB.prepare("SELECT d.note FROM approval_decision d JOIN approval_card c ON c.id = d.approval_card_id WHERE c.object_id = ?1").bind(done.effect_request_id).first<{ note: string }>();
    expect(decided?.note).toContain("Her words, 13 Nov");
    const told = toUs.find((m) => m.subject.includes("Quiet Co follow-up, sent"))!;
    expect(told.to).toBe(SEQUOIA);
    await resendUnanswered(env, days(8), "west-peek", true);
    await resendUnanswered(env, days(30), "west-peek", true);
    expect(toBrand).toHaveLength(1);
  });

  it("an answer nobody armed is never sent again, however long the brand is quiet", async () => {
    expect(await answered("tld_unarmed", "Unarmed Co", "pat@unarmedco.example")).toContain("sent from");
    toBrand.length = 0;
    expect(await resendUnanswered(env, days(60), "west-peek", true)).toContain("OUTPUT 0 resend_sent (0 armed and waiting");
    expect(toBrand).toHaveLength(0);
  });

  it("any message from the brand cancels it for good; an auto-reply does not", async () => {
    const a = await armed("tld_wrote", "Wrote Co", "pat@wroteco.example");
    await env.WP_OS_DB.prepare("INSERT INTO tlc_brand_reply (id, deal_id, brand_message_id, their_subject, their_text, received_at, intent, draft_subject, draft_body, state, firm_scope) VALUES ('tbr_ooo', 'tld_wrote', 'ooo@brand.example', 'Automatic reply', 'I am away', ?1, 'AUTO_REPLY', '', '', 'CLOSED', 'west-peek')").bind(days(1).toISOString()).run();
    expect(await resendUnanswered(env, days(2), "west-peek", true)).toContain("(1 armed and waiting, 0 cancelled");
    await env.WP_OS_DB.prepare("INSERT INTO tlc_brand_reply (id, deal_id, brand_message_id, their_subject, their_text, received_at, intent, draft_subject, draft_body, state, firm_scope) VALUES ('tbr_real', 'tld_wrote', 'real@brand.example', 'Re: Wrote Co', 'We are reviewing.', ?1, 'QUESTION', '', '', 'CLOSED', 'west-peek')").bind(days(3).toISOString()).run();
    expect(await resendUnanswered(env, days(4), "west-peek", true)).toContain("(0 armed and waiting, 1 cancelled by a reply)");
    expect((await order(a.id)).state).toBe("CANCELLED");
    await resendUnanswered(env, days(9), "west-peek", true);
    expect(toBrand).toHaveLength(0);
  });

  it("never on a guess: an inbox not read on this pass waits (still armed); a newer message from the brand that Wynn has not taken in stops it and she is told", async () => {
    const a = await armed("tld_guess", "Guess Co", "pat@guessco.example");
    expect(await resendUnanswered(env, days(7), "west-peek", false)).toContain("NAMED STOP [RESEND_INBOX_NOT_READ] Guess Co");
    expect(toBrand).toHaveLength(0);
    expect((await order(a.id)).state).toBe("ARMED");
    search = (q) => (q.startsWith("from:(pat@guessco.example OR lee@guessco.example OR guessco.example) after:") ? { id: "g-new", threadId: "t9", messageId: "unseen@brand.example" } : null);
    expect(await resendUnanswered(env, days(7), "west-peek", true)).toContain("NAMED STOP [RESEND_BRAND_WROTE] Guess Co");
    expect(toBrand).toHaveLength(0);
    expect(await order(a.id)).toMatchObject({ state: "STOPPED", reason: expect.stringContaining("NAMED STOP [RESEND_BRAND_WROTE]") });
    const alarm = toUs.find((m) => m.subject.includes("Guess Co follow-up NOT sent"))!;
    expect(alarm.to).toBe(SEQUOIA);
    expect(alarm.text).toContain("Nothing went to Guess Co");
    expect(alarm.text).toContain("A newer message from the brand is in your mailbox");
  });

  it("the brand's conversation is gone from her mailbox on the day: STOPPED, nothing sent, she is told", async () => {
    const a = await armed("tld_gone", "Gone Co", "pat@goneco.example");
    notInMailbox.add("tld_gone@brand.example");
    expect(await resendUnanswered(env, days(7), "west-peek", true)).toContain("NAMED STOP [TLC_BRAND_THREAD_NOT_FOUND] Gone Co");
    expect(toBrand).toHaveLength(0);
    expect(toUs.some((m) => m.subject.includes("Gone Co follow-up NOT sent"))).toBe(true);
    expect((await order(a.id)).state).toBe("STOPPED");
    // A stopped order is finished: the conversation coming back later sends nothing.
    notInMailbox = new Set();
    await resendUnanswered(env, days(8), "west-peek", true);
    expect(toBrand).toHaveLength(0);
  });
});
