import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { contentHashes, recordBrandMail, recordBrandReplyText } from "../src/worker/services/learningClub";
import { applyBrandReplyApproval, approvalWords, changedLines, sendReplyApprovals, type ReplyDrafter } from "../src/worker/services/tlcBrandReply";
import { THREE_THINGS_OFFER, classifyBrandReply } from "../src/shared/tlc/brandReply";
import { TRUSTED_AUTHSERV_ID } from "../src/shared/intake/partnerAuthority";

/**
 * BRAND REPLIES GO IN TWO ROUNDS (owner, 6 Nov 2026: "any emails where they are ready to send pricing info they stop
 * and send me something for approval first and then the next round of it goes to me + scooter for both approval";
 * "he should wait for both our inputs and not send a full pdf back but an artifact that can be pinged back and forth").
 * Round 1 is Sequoia's alone. A draft with prices she approves goes to round 2: her and Scooter (his address read from
 * his own firm_user row), a link to the live draft page and no PDF; nothing reaches the brand until both approve, and
 * Wynn redrafts only once both have answered. Fake brands only.
 */
let t: TestDb;
let env: Env;
let SEQUOIA = "";
let SCOOTER = "";
const sends: Array<{ via: "resend" | "gmail"; to: string; cc: string; subject: string; text: string }> = [];
const SERVICE_ACCOUNT = JSON.stringify({ client_email: "sa@firm.iam.example", private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) });
const auth = (address: string) => `${TRUSTED_AUTHSERV_ID}; dkim=pass header.d=${address.split("@")[1]} header.s=s1; spf=pass smtp.mailfrom=${address}; dmarc=pass header.from=${address.split("@")[1]}`;
const AT = new Date("2026-11-10T15:00:00.000Z");
const drafter: ReplyDrafter = async (_e, _a, i) => ({ ok: true, body: `Hi,\n\n${i.note ? `Redrafted: ${i.note}.` : `Thanks for asking about ${i.topic}.`} ${THREE_THINGS_OFFER}`, detail: "ok" });
const toBrand = () => sends.filter((s) => s.via === "gmail");
const toUs = () => sends.filter((s) => s.via === "resend");
const answer = (from: string, body: string, ref: string, a = auth(from)) =>
  applyBrandReplyApproval(env, { fromHeader: `Partner <${from}>`, authenticationResults: a, subject: `Re: Wynn: 1 brand reply to approve · ${ref}`, body: `${body}\n\nRef ${ref}` }, { now: AT, drafter });
const row = (id: string) => env.WP_OS_DB.prepare("SELECT state, notice_ref, round, inputs_json, draft_body, change_note, page_token FROM tlc_brand_reply WHERE deal_id = ?1 ORDER BY received_at DESC").bind(id).first<{ state: string; notice_ref: string; round: string | null; inputs_json: string | null; draft_body: string; change_note: string | null; page_token: string | null }>();
const approversOf = async (ref: string) => JSON.parse((await env.WP_OS_DB.prepare("SELECT approvers_json FROM tlc_brand_reply_notice WHERE ref = ?1").bind(ref).first<{ approvers_json: string }>())!.approvers_json) as string[];

async function replyFrom(dealId: string, brand: string, email: string): Promise<string> {
  await env.WP_OS_DB.prepare(
    "INSERT INTO tlc_deal (id, event_id, brand, contact_email, contact_source_url, why_fit, stage, drip_step, first_sent_at, last_sent_at, next_send_at, firm_scope) VALUES (?1, 'tlc_2027-03', ?2, ?3, 'https://example.test', 'fit', 'PITCHED', 1, '2026-11-09T15:00:00.000Z', '2026-11-09T15:00:00.000Z', '2026-11-21T15:00:00.000Z', 'west-peek')",
  ).bind(dealId, brand, email).run();
  await recordBrandMail(env, { from: `Pat <${email}>`, subject: `Re: ${brand} + a small room in New York`, now: AT });
  await recordBrandReplyText(env, { from: `Pat <${email}>`, subject: `Re: ${brand} + a small room in New York`, text: "Hi Sequoia,\n\nWhat do you have in mind?", messageId: `<${dealId}@brand.example>`, now: AT });
  return (await row(dealId))!.notice_ref;
}

/** A brand that asked the price: Wynn's proposal draft (kind PROPOSAL) goes to her on round 1. Returns its ref. */
async function pricingFrom(dealId: string, brand: string, email: string): Promise<string> {
  await env.WP_OS_DB.prepare(
    "INSERT INTO tlc_deal (id, event_id, brand, contact_email, contact_source_url, why_fit, stage, drip_step, first_sent_at, last_sent_at, next_send_at, firm_scope, stop_reason) VALUES (?1, 'tlc_2027-03', ?2, ?3, 'https://example.test', 'fit', 'PITCHED', 1, '2026-11-09T15:00:00.000Z', '2026-11-09T15:00:00.000Z', NULL, 'west-peek', 'REPLIED')",
  ).bind(dealId, brand, email).run();
  await env.WP_OS_DB.prepare(
    "INSERT INTO tlc_brand_reply (id, deal_id, brand_message_id, their_subject, their_text, received_at, intent, draft_subject, draft_body, state, firm_scope, kind, attachments_json) VALUES (?1, ?2, ?3, ?4, 'How much is this to do?', ?5, 'QUESTION', ?4, ?6, 'DRAFTED', 'west-peek', 'PROPOSAL', '[]')",
  ).bind(`tbr_${dealId}`, dealId, `${dealId}@brand.example`, `Re: ${brand} + a small room in New York`, AT.toISOString(), "Hi Pat,\n\nThank you for asking.\nLead partner, $10,000 per event.").run();
  await sendReplyApprovals(env, AT);
  return (await row(dealId))!.notice_ref;
}
/** Round 1 approved by her: the new round-2 ref. */
async function toRoundTwo(dealId: string, brand: string, email: string): Promise<string> {
  const ref = await pricingFrom(dealId, brand, email);
  await answer(SEQUOIA, "approved", ref);
  const r = (await row(dealId))!;
  expect(r.round).toBe("PARTNERS");
  expect(r.notice_ref).not.toBe(ref);
  return r.notice_ref;
}

beforeAll(async () => {
  t = await createTestDb();
  env = { ...makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>), RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures", WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT } as Env;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const b = JSON.parse(String(init?.body)) as { to: string | string[]; cc?: string[]; subject: string; text: string };
      sends.push({ via: "resend", to: Array.isArray(b.to) ? b.to.join(",") : b.to, cc: (b.cc ?? []).join(","), subject: b.subject, text: b.text });
      return new Response(JSON.stringify({ id: `re_${sends.length}` }), { status: 200 });
    }
    if (String(url) === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 });
    if (String(url) === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
      const raw = Buffer.from((JSON.parse(String(init?.body)) as { raw: string }).raw, "base64url").toString();
      const head = raw.split("\r\n\r\n")[0]!;
      const h = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(head)?.[1] ?? "";
      sends.push({ via: "gmail", to: h("To"), cc: h("Cc"), subject: h("Subject"), text: raw });
      return new Response(JSON.stringify({ id: `gm_${sends.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  // The partners' own firm_user rows (migration 0001): the addresses come from there, never from this file.
  SEQUOIA = (await env.WP_OS_DB.prepare("SELECT email FROM firm_user WHERE id = 'fu_sequoia_taylor'").first<{ email: string }>())!.email;
  SCOOTER = (await env.WP_OS_DB.prepare("SELECT email FROM firm_user WHERE id = 'fu_scooter_taylor' AND status = 'ACTIVE'").first<{ email: string }>())!.email;
  expect(SCOOTER).toMatch(/@/);
  await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, angle, status, sponsor_categories_json, pitch_token) VALUES ('tlc_2027-03', '2027-03', '2027-03-18', 'EVENING', 'Build Your Own AI Agent', 'A hands-on evening.', 'TOPIC_READY', '[]', ?1)").bind("e".repeat(32)).run();
  const h = await contentHashes(env);
  await env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value) VALUES ('pitch_approved_hash', ?1), ('playbook_approved_hash', ?2), ('brand_send', 'on') ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(h.pitch, h.playbook).run();
  await env.WP_OS_DB.prepare("INSERT INTO outside_email_allow (item_type, item_id, allowed, changed_by) VALUES ('JOB','tlc_brand_sales',1,'test')").run();
});
afterEach(() => { sends.length = 0; });
afterAll(async () => { vi.unstubAllGlobals(); await disposeTestDb(t); });

describe("round 1 is hers alone", () => {
  it("any reply: to Sequoia only, Scooter not on it, and the notice names her alone", async () => {
    const ref = await replyFrom("tld_one", "One Co", "pat@one.example");
    const mail = toUs().find((s) => s.subject.includes(ref))!;
    expect(mail.to).toBe(SEQUOIA);
    expect(mail.cc).toBe("");
    expect(await approversOf(ref)).toEqual(["fu_sequoia_taylor"]);
  });

  it("Scooter's reply to a round-1 email is refused and changes nothing", async () => {
    const ref = await replyFrom("tld_him1", "Him One Co", "pat@him1.example");
    sends.length = 0;
    expect((await answer(SCOOTER, "approved", ref)).handled).toBe(false);
    expect(toBrand()).toHaveLength(0);
    expect((await row("tld_him1"))!.state).toBe("NOTIFIED");
  });

  it("a reply with no prices: her approved sends it, once", async () => {
    const ref = await replyFrom("tld_plain", "Plain Co", "pat@plain.example");
    sends.length = 0;
    expect((await answer(SEQUOIA, "approved", ref)).detail).toContain("sent from");
    expect(toBrand()).toHaveLength(1);
    await answer(SEQUOIA, "approved", ref);
    expect(toBrand()).toHaveLength(1);
  });

  it("a draft with prices: her approved sends NOTHING to the brand; it goes to round 2, to her and Scooter, as a link and no PDF", async () => {
    const ref = await pricingFrom("tld_price", "Price Co", "pat@price.example");
    expect(toUs().find((s) => s.subject.includes(ref))!.cc).toBe("");
    sends.length = 0;
    const out = await answer(SEQUOIA, "approved", ref);
    expect(out.detail).toContain("it now goes to you and Scooter");
    expect(toBrand()).toHaveLength(0);
    const r = (await row("tld_price"))!;
    expect(r).toMatchObject({ state: "NOTIFIED", round: "PARTNERS" });
    expect(await approversOf(r.notice_ref)).toEqual(["fu_sequoia_taylor", "fu_scooter_taylor"]);
    const two = toUs().find((s) => s.subject.includes(r.notice_ref))!;
    expect(two.to).toBe(SEQUOIA);
    expect(two.cc).toBe(SCOOTER);
    expect(two.text).toContain(`https://os.joinwestpeek.com/api/tlc-pitch/draft/${r.page_token}`);
  });
});

describe("round 2: nothing goes until both have approved", () => {
  it("one approval alone sends nothing and says who is still needed", async () => {
    const ref = await toRoundTwo("tld_half", "Half Co", "pat@half.example");
    sends.length = 0;
    expect((await answer(SCOOTER, "approved", ref)).detail).toContain("Scooter approved; waiting on Sequoia, nothing sent yet");
    expect(toBrand()).toHaveLength(0);
    // The same "approved" again changes nothing.
    await answer(SCOOTER, "approved", ref);
    expect(toBrand()).toHaveLength(0);
  });

  it("both, in either order: sent once, from her mailbox, to the brand", async () => {
    const ref = await toRoundTwo("tld_both", "Both Co", "pat@both.example");
    sends.length = 0;
    await answer(SCOOTER, "approved", ref);
    expect(toBrand()).toHaveLength(0);
    expect((await answer(SEQUOIA, "approved", ref)).detail).toContain("sent from");
    expect(toBrand()).toHaveLength(1);
    expect(toBrand()[0]!.to).toContain("pat@both.example");
    await answer(SCOOTER, "approved", ref);
    expect(toBrand()).toHaveLength(1);
  });

  it("Scooter's notes alone change nothing: Wynn waits for Sequoia, then redrafts ONCE with both sets of notes", async () => {
    const ref = await toRoundTwo("tld_wait", "Wait Co", "pat@wait.example");
    const before = (await row("tld_wait"))!.draft_body;
    sends.length = 0;
    const rulesBefore = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_wynn_rule").first<{ n: number }>())!.n;
    expect((await answer(SCOOTER, "Pitch a quarterly series at a discount.", ref)).detail).toContain("Wynn waits for Sequoia before changing anything");
    const mid = (await row("tld_wait"))!;
    expect(mid).toMatchObject({ state: "NOTIFIED", notice_ref: ref, draft_body: before });
    expect(toUs().filter((s) => /^Wynn: .*pricing/.test(s.subject))).toHaveLength(0);
    await answer(SEQUOIA, "Keep the opening warm.", ref);
    const r = (await row("tld_wait"))!;
    expect(r.notice_ref).not.toBe(ref);
    expect(r.round).toBe("PARTNERS");
    expect(r.change_note).toBe("Sequoia: Keep the opening warm.\n\nScooter: Pitch a quarterly series at a discount.");
    expect(r.inputs_json).toBeNull();
    expect(toBrand()).toHaveLength(0);
    const again = toUs().find((s) => s.subject.includes(r.notice_ref))!;
    expect(again.cc).toBe(SCOOTER);
    expect(again.text).toContain("What Wynn changed:");
    // Scooter's notes change this one draft; they do not become a standing rule.
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_wynn_rule").first<{ n: number }>())!.n).toBeGreaterThanOrEqual(rulesBefore);
  });

  it("one approves and the other sends notes: one redraft, with the notes", async () => {
    const ref = await toRoundTwo("tld_mix", "Mix Co", "pat@mix.example");
    await answer(SEQUOIA, "approved", ref);
    await answer(SCOOTER, "Mention the rooftop.", ref);
    const r = (await row("tld_mix"))!;
    expect(r.notice_ref).not.toBe(ref);
    expect(r.change_note).toBe("Scooter: Mention the rooftop.");
    expect(toBrand()).toHaveLength(0);
  });

  it("Scooter's address with failed authentication, or anyone else, counts for nothing", async () => {
    const ref = await toRoundTwo("tld_spoof", "Spoof Co", "pat@spoof.example");
    const forged = `${TRUSTED_AUTHSERV_ID}; dkim=fail; spf=fail; dmarc=fail header.from=${SCOOTER.split("@")[1]}`;
    expect((await answer(SCOOTER, "approved", ref, forged)).handled).toBe(false);
    expect((await answer("someone@else.example", "approved", ref)).handled).toBe(false);
    await answer(SEQUOIA, "approved", ref);
    expect(toBrand()).toHaveLength(0);
    expect(JSON.parse((await row("tld_spoof"))!.inputs_json!)).toEqual({ fu_sequoia_taylor: expect.objectContaining({ approved: true }) });
  });
});

describe("the live draft page", () => {
  it("shows their email, the answer and every answer so far; private, never indexed; a bad token is a plain 404", async () => {
    const ref = await toRoundTwo("tld_page", "Page Co", "pat@page.example");
    await answer(SCOOTER, "Pitch a quarterly series.", ref);
    const { handleRequest } = await import("../src/worker/index");
    const token = (await row("tld_page"))!.page_token!;
    const res = await handleRequest(new Request(`https://test.local/api/tlc-pitch/draft/${token}`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    const html = await res.text();
    expect(html).toContain("How much is this to do?");
    expect(html).toContain("Lead partner, $10,000 per event.");
    expect(html).toContain("Pitch a quarterly series.");
    expect(html).toContain("Sequoia: not answered yet");
    expect((await handleRequest(new Request(`https://test.local/api/tlc-pitch/draft/${"0".repeat(32)}`), env)).status).toBe(404);
    expect((await handleRequest(new Request("https://test.local/api/tlc-pitch/draft/nope"), env)).status).toBe(404);
  });
});

describe("the words", () => {
  it("says who has approved and who is still needed", () => {
    expect(approvalWords(["fu_sequoia_taylor", "fu_scooter_taylor"], [])).toBe("nobody has approved yet · waiting on Sequoia and Scooter");
    expect(approvalWords(["fu_sequoia_taylor", "fu_scooter_taylor"], ["fu_scooter_taylor"])).toBe("Scooter approved · waiting on Sequoia");
  });
  it("what changed between two drafts, line by line", () => {
    expect(changedLines("Hi,\nA\nB", "Hi,\nA\nC")).toEqual({ removed: ["B"], added: ["C"] });
    expect(changedLines("Hi,\nA", "Hi,\nA")).toEqual({ removed: [], added: [] });
  });
});

describe("a machine's acknowledgement is not a reply (6 Nov 2026: Osmo, Loop)", () => {
  const NOW = new Date("2026-11-06T18:44:37.000Z");
  it("a marketing autoresponder is an auto-reply, so no draft and the drip goes on", () => {
    expect(classifyBrandReply({ subject: "Thanks for reaching out. Let's get you connected to the right team.", text: "Hi there,\n\nThanks for reaching out to Acme. We want to make sure you get connected with the right person. Fill out our Studio form here." }, NOW).kind).toBe("AUTO_REPLY");
    expect(classifyBrandReply({ subject: "Re: Acme + a small room in New York", text: "Hi there,\n\nOur Partnerships team will review your message and get back to you in due time. Our mailbox is quite busy at the moment." }, NOW).kind).toBe("AUTO_REPLY");
    expect(classifyBrandReply({ subject: "Re: x", text: "Thanks", raw: "From: Acme <hello@acme.example>\r\nAuto-Submitted: auto-replied\r\nSubject: Re: x\r\n\r\nThanks" }, NOW).kind).toBe("AUTO_REPLY");
  });
  it("a person is never mistaken for one", () => {
    expect(classifyBrandReply({ subject: "Re: x", text: "Thanks for reaching out! How much is this to do?" }, NOW).kind).toBe("REPLY");
    expect(classifyBrandReply({ subject: "Re: x", text: "Thanks, our marketing team will review it and get back to you." }, NOW).kind).not.toBe("AUTO_REPLY");
    expect(classifyBrandReply({ subject: "Re: x", text: "Sounds good", raw: "From: Pat <pat@acme.example>\r\nAuto-Submitted: no\r\n\r\nSounds good" }, NOW).kind).not.toBe("AUTO_REPLY");
  });
});
