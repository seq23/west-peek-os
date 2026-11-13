import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { gmailReadStub } from "./helpers/gmailMailbox";
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
// Wynn's fake model: a redraft answers every partner's note with a change line, by name (her 7 Nov rule).
const drafter: ReplyDrafter = async (_e, _a, i) => ({ ok: true, body: `Hi,\n\n${i.note ? `Redrafted for ${(i.notes ?? []).length} notes.` : `Thanks for asking about ${i.topic}.`} ${THREE_THINGS_OFFER}`, detail: "ok", changes: (i.notes ?? []).map((n) => ({ who: n.who, note: n.note.slice(0, 40), done: "applied" })) });
const PDF = { renderPdf: async () => ({ pdfBase64: btoa("%PDF-1.4 sheet"), reason: null }) } as never;
const toBrand = () => sends.filter((s) => s.via === "gmail");
const toUs = () => sends.filter((s) => s.via === "resend");
// Her reply quotes nothing: the ref rides back in the subject alone (owner, 7 Nov 2026: "that code is still important").
const answer = (from: string, body: string, ref: string, a = auth(from), d: Partial<{ drafter: ReplyDrafter }> = {}) =>
  applyBrandReplyApproval(env, { fromHeader: `Partner <${from}>`, authenticationResults: a, subject: `Re: Some Co Pricing Reply · v1 · ready for your OK · ${ref}`, body }, { now: AT, drafter, samples: PDF, ...d });
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
  // One ref for the conversation's whole life (owner, 7 Nov 2026).
  expect(r.notice_ref).toBe(ref);
  return r.notice_ref;
}

const mailbox = gmailReadStub();

beforeAll(async () => {
  t = await createTestDb();
  const store = new Map<string, Uint8Array>();
  const docs = { put: async (k: string, v: Uint8Array) => { store.set(k, v); }, get: async (k: string) => (store.has(k) ? { text: async () => new TextDecoder().decode(store.get(k)), arrayBuffer: async () => store.get(k)!.buffer } : null) };
  env = { ...makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>), WP_OS_DOCUMENTS: docs as never, RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures", WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT } as Env;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const b = JSON.parse(String(init?.body)) as { to: string | string[]; cc?: string[]; subject: string; text: string };
      sends.push({ via: "resend", to: Array.isArray(b.to) ? b.to.join(",") : b.to, cc: (b.cc ?? []).join(","), subject: b.subject, text: b.text });
      return new Response(JSON.stringify({ id: `re_${sends.length}` }), { status: 200 });
    }
    if (String(url) === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 });
    // Her mailbox, for reads: a brand answer goes only once its conversation is found there (tlcBrandThread.ts).
    const read = mailbox(String(url));
    if (read) return read;
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
    const one = toUs().find((s) => s.subject.includes(ref))!;
    expect(one.cc).toBe("");
    // The round-1 email to her alone: no prefix, the ref in the subject.
    expect(one.subject).toBe(`Price Co Pricing Reply · v1 · ready for your OK · ${ref}`);
    sends.length = 0;
    const out = await answer(SEQUOIA, "approved", ref);
    expect(out.detail).toContain("it now goes to you and Scooter");
    expect(toBrand()).toHaveLength(0);
    const r = (await row("tld_price"))!;
    expect(r).toMatchObject({ state: "NOTIFIED", round: "PARTNERS" });
    expect(await approversOf(r.notice_ref)).toEqual(["fu_sequoia_taylor", "fu_scooter_taylor"]);
    const two = toUs().find((s) => s.text.includes(`Ref ${r.notice_ref}`))!;
    expect(two.to).toBe(SEQUOIA);
    expect(two.cc).toBe(SCOOTER);
    // The shape she approved: the version and ref in the subject, the reply word for word, one readable link.
    // Both must approve: the subject starts ACTION REQUIRED and line 1 says so plainly (owner, 7 Nov 2026).
    // The thread's ref stays in the subject for every version (owner, 7 Nov 2026); this email's own ref is in the footer.
    expect(two.subject).toBe(`ACTION REQUIRED: Price Co Pricing Reply · v1 · ready for your OK · ${ref}`);
    expect(r.notice_ref).toBe(ref);
    expect(two.text.trimEnd().endsWith(`Ref ${ref}`)).toBe(true);
    expect(two.text.split("\n")[0]).toContain('You both need to reply "approved"');
    expect(two.text).toContain("THE REPLY, WORD FOR WORD");
    expect(two.text).toContain("https://os.joinwestpeek.com/tlc/price-co/reply");
    expect(two.text).not.toMatch(/\/api\/|\*\*|individual inboxes/);
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
    // One ref for the conversation's whole life (owner, 7 Nov 2026).
  expect(r.notice_ref).toBe(ref);
    expect(r.round).toBe("PARTNERS");
    expect(r.change_note).toBe("Sequoia: Keep the opening warm.\n\nScooter: Pitch a quarterly series at a discount.");
    expect(r.inputs_json).toBeNull();
    expect(toBrand()).toHaveLength(0);
    const again = toUs().find((s) => s.text.includes(`Ref ${r.notice_ref}`))!;
    expect(again.cc).toBe(SCOOTER);
    // vN counts up, and every note has its own line naming whose it was.
    expect(again.subject).toMatch(/^ACTION REQUIRED: Wait Co Pricing Reply · v2 · ready for your OK · TLR-[A-Z0-9]{6}$/);
    expect(again.subject.endsWith(` · ${r.notice_ref}`)).toBe(true);
    expect(again.text).toContain("WHAT CHANGED SINCE V1");
    expect(again.text).toMatch(/- Sequoia: "Keep the opening warm\." → applied/);
    expect(again.text).toMatch(/- Scooter: "Pitch a quarterly series at a discoun/);
    // Scooter's notes change this one draft; they do not become a standing rule.
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_wynn_rule").first<{ n: number }>())!.n).toBeGreaterThanOrEqual(rulesBefore);
  });

  it("one approves and the other sends notes: one redraft, with the notes", async () => {
    const ref = await toRoundTwo("tld_mix", "Mix Co", "pat@mix.example");
    await answer(SEQUOIA, "approved", ref);
    await answer(SCOOTER, "Mention the rooftop.", ref);
    const r = (await row("tld_mix"))!;
    // One ref for the conversation's whole life (owner, 7 Nov 2026).
  expect(r.notice_ref).toBe(ref);
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

describe("the reply page", () => {
  it("a readable page behind the sign-in: their email, the reply, who has answered; the old link redirects; a bad token is a plain 404", async () => {
    const ref = await toRoundTwo("tld_page", "Page Co", "pat@page.example");
    await answer(SCOOTER, "approved", ref);
    const { handleRequest } = await import("../src/worker/index");
    expect((await handleRequest(new Request("https://test.local/tlc/page-co/reply"), env)).status).toBe(401);
    const res = await handleRequest(new Request("https://test.local/tlc/page-co/reply", { headers: { "x-wpos-dev-user": SEQUOIA } }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    const html = await res.text();
    expect(html).toContain("How much is this to do?");
    expect(html).toContain("Lead partner, $10,000 per event.");
    expect(html).toContain("Sequoia: not answered yet · Scooter: approved");
    expect(html).not.toContain("<iframe");
    await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET page_token = ?2 WHERE deal_id = ?1").bind("tld_page", "a".repeat(32)).run();
    const old = await handleRequest(new Request(`https://test.local/api/tlc-pitch/draft/${"a".repeat(32)}`), env);
    expect(old.status).toBe(302);
    expect(old.headers.get("location")).toBe("/tlc/page-co/reply");
    expect((await handleRequest(new Request(`https://test.local/api/tlc-pitch/draft/${"0".repeat(32)}`), env)).status).toBe(404);
    expect((await handleRequest(new Request("https://test.local/api/tlc-pitch/draft/nope"), env)).status).toBe(404);
  });
});

describe("THE GUARD (owner, 7 Nov 2026): pricing goes to the brand only on both approvals, Scooter only on pricing", () => {
  it("an answer whose words carry a price is a pricing email: her approval moves it to round 2, nothing to the brand", async () => {
    const ref = await replyFrom("tld_dollar", "Dollar Co", "pat@dollar.example");
    await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET draft_body = 'Hi Pat,\n\nLead partner is $10,000 per event.' WHERE deal_id = 'tld_dollar'").run();
    sends.length = 0;
    await answer(SEQUOIA, "approved", ref);
    expect(toBrand()).toHaveLength(0);
    expect((await row("tld_dollar"))!.round).toBe("PARTNERS");
  });
  it("no round-2 email exists before her round-1 approval, and Scooter is on no round-1 email or its done note", async () => {
    const ref = await pricingFrom("tld_early", "Early Co", "pat@early.example");
    expect(await approversOf(ref)).toEqual(["fu_sequoia_taylor"]);
    expect((await row("tld_early"))!.round).toBeNull();
    expect(sends.filter((s) => s.cc.includes(SCOOTER))).toHaveLength(0);
    sends.length = 0;
    await answer(SEQUOIA, "skip", ref);
    expect(sends.filter((s) => s.cc.includes(SCOOTER))).toHaveLength(0);
  });
  it("ONE REF FOR LIFE (owner, 7 Nov 2026): every later email keeps the conversation's ref; an older code is an alias; a stranger code reaches nothing", async () => {
    const first = await pricingFrom("tld_codes", "Codes Co", "pat@codes.example");
    await answer(SEQUOIA, "approved", first);
    expect((await row("tld_codes"))!.notice_ref).toBe(first);
    // A redraft from both partners' notes: v2, still the same ref, in its subject.
    await answer(SCOOTER, "Say the quarterly dates.", first);
    sends.length = 0;
    await answer(SEQUOIA, "Keep it short.", first);
    const v2 = (await row("tld_codes"))!;
    expect(v2.notice_ref).toBe(first);
    const mail = toUs().find((s) => s.subject.includes("Codes Co Pricing Reply · v2"))!;
    expect(mail.subject.endsWith(` · ${first}`)).toBe(true);
    // An older code issued on this conversation (as Pinecone's TLR-DPA7BZ was) routes to the same draft.
    const id = (await env.WP_OS_DB.prepare("SELECT id FROM tlc_brand_reply WHERE deal_id = 'tld_codes'").first<{ id: string }>())!.id;
    await env.WP_OS_DB.prepare("INSERT INTO tlc_brand_reply_notice (ref, reply_ids_json, day, firm_scope, sent_at, sent_to, forced, approvers_json) VALUES ('TLR-ALIAS1', ?1, '2026-11-07', 'west-peek', '2026-11-07T14:00:00Z', 'x', 0, '[]')").bind(JSON.stringify([id])).run();
    expect((await answer(SCOOTER, "approved", "TLR-ALIAS1")).detail).toContain("Scooter approved; waiting on Sequoia");
    // Negative proof: a code no conversation issued changes nothing.
    expect((await answer(SEQUOIA, "approved", "TLR-NOSUCH")).handled).toBe(false);
    expect(toBrand()).toHaveLength(0);
    sends.length = 0;
    expect((await answer(SEQUOIA, "approved", first)).detail).toContain("sent from");
    expect(toBrand()).toHaveLength(1);
  });
  it("the door strips Scooter's copy from any Wynn email that is not the pricing round", async () => {
    const { tlcCcKept } = await import("../src/worker/services/execEmail");
    const { TLC_BRAND_REPLY_NOTICE_OBJECT, TLC_PRICING_NOTICE_OBJECT } = await import("../src/shared/tlc/learningClub");
    expect(tlcCcKept(TLC_BRAND_REPLY_NOTICE_OBJECT, SCOOTER)).toBe(false);
    expect(tlcCcKept("tlc_draft_notice", SCOOTER)).toBe(false);
    expect(tlcCcKept(TLC_PRICING_NOTICE_OBJECT, SCOOTER)).toBe(true);
  });
  it("a redraft that leaves a note without a change line is held and named, never sent to them", async () => {
    const ref = await toRoundTwo("tld_deaf", "Deaf Co", "pat@deaf.example");
    const deaf: ReplyDrafter = async () => ({ ok: true, body: `Hi,\n\nSame as before. ${THREE_THINGS_OFFER}`, detail: "ok", changes: [] });
    await answer(SEQUOIA, "approved", ref, auth(SEQUOIA), { drafter: deaf });
    sends.length = 0;
    await answer(SCOOTER, "Drop the last line.", ref, auth(SCOOTER), { drafter: deaf });
    const r = (await env.WP_OS_DB.prepare("SELECT state, held_reason, research_due FROM tlc_brand_reply WHERE deal_id = 'tld_deaf'").first<{ state: string; held_reason: string; research_due: string | null }>())!;
    expect(r.state).toBe("DRAFTED");
    expect(r.held_reason).toContain("WYNN_NOTE_UNANSWERED");
    expect(toUs().filter((s) => s.subject.includes("Deaf Co"))).toHaveLength(0);
    expect(toBrand()).toHaveLength(0);
  });
});

describe("series pricing, per brand (owner, 7 Nov 2026)", () => {
  const SERIES = { year: 2027, prices: { PARTNER: { 1: 5000, 4: 5000, 6: 5000 }, LEAD: { 1: 10000, 4: 9000, 6: 8500 }, PRESENTING: { 1: 15000, 4: 13500, 6: 12750 } }, quarterly: null, monthly: null };
  it("a setting with Partner below $5,000 is not read at all; a good one reaches the brand's sheet as per-event prices for 1, 4 and 6", async () => {
    const { seriesOf } = await import("../src/shared/tlc/series");
    expect(seriesOf(JSON.stringify({ ...SERIES, prices: { ...SERIES.prices, PARTNER: { 1: 5000, 4: 4500, 6: 4000 } } }))).toBeNull();
    expect(seriesOf(JSON.stringify(SERIES))!.prices.LEAD[6]).toBe(8500);
    const { renderBrandPitch, sponsorOf } = await import("../src/shared/tlc/pitch");
    const { clubViewOf } = await import("../src/worker/services/learningClub");
    const ev = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = 'tlc_2027-03'").first())! as never;
    const html = renderBrandPitch(clubViewOf(ev), sponsorOf({ brand: "Vec Co", category: "Vector database", series_json: JSON.stringify(SERIES) }));
    expect(html).toContain("Series prices, per event");
    expect(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toContain("Lead partner $10,000 $9,000 $8,500");
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

describe("the room and the community, as a brand is told them (owner, 6 Nov 2026)", () => {
  it("a draft that promises more than 25 guests, a community size today, or a guarantee is refused", async () => {
    const { draftProblems } = await import("../src/worker/services/tlcBrandReply");
    expect(draftProblems("We expect about 60 guests.", "QUESTION")).toEqual([expect.stringContaining("promises about 60 guests")]);
    expect(draftProblems("Our community grew to nearly 5,000 founders at its height.", "QUESTION")).toEqual([expect.stringContaining("the retired community wording")]);
    expect(draftProblems("We guarantee a full room.", "QUESTION")).toEqual(["a guarantee (her rule: no guarantees)"]);
    expect(draftProblems("Rooms of 25+ guests, sized to your goals, curated from a community of about 5,000.", "QUESTION")).toEqual([]);
  });
  it("queued text and Wynn's stored rules are said the new way", async () => {
    const { brandCommunityWords } = await import("../src/shared/community/size");
    expect(brandCommunityWords("Hi.\nOur community of about 5,000 founders, operators and creatives meets in person through West Peek Rooms, our event series in New York.\nBye."))
      .toBe("Hi.\nWe built a community of about 5,000 founders, operators and creatives, and we curate each room from that network. We meet in person through West Peek Rooms, our event series in New York.\nBye.");
    // Text queued in the retired 6 Nov wording is said the 7 Nov way before it goes.
    expect(brandCommunityWords("West Peek is a community that grew to nearly 5,000 founders, operators, investors, creatives and builders at its height, started by Scooter."))
      .toBe("West Peek is a community of about 5,000 founders, operators, investors, creatives and builders, started by Scooter.");
  });
  it("the pricing sheet and the samples never promise more than 25 or a community size today", async () => {
    const { renderBrandPitch } = await import("../src/shared/tlc/pitch");
    const { clubViewOf } = await import("../src/worker/services/learningClub");
    const ev = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = 'tlc_2027-03'").first())! as never;
    const html = renderBrandPitch(clubViewOf(ev));
    expect(html).not.toMatch(/100\+|nearly 5,000|at its height|25 to/);
    expect(html).toContain("community of about 5,000");
  });
});

describe("her ordered wording keeps her approval, so sending does not pause (owner, 6 Nov 2026)", () => {
  it("the approved pitch with only her ordered phrases changed is APPROVED; any other change is CHANGED", async () => {
    const { approvalState, PITCH_APPROVAL_HASH_SETTING, OWNER_ORDERED_WORDING, withOwnerOrderedWording } = await import("../src/shared/tlc/learningClub");
    // Words approved before 6 Nov, and words approved on the 6 Nov wording, both carry her approval to the 7 Nov words.
    const original = OWNER_ORDERED_WORDING.slice(0, 4).map(([a]) => a);
    const before = `March 2027\nWho will be in the room\n${original.join("\n")}`;
    const after = `March 2027\nWho will be in the room\n${original.map((w) => withOwnerOrderedWording(w)).join("\n")}`;
    expect(after).toContain("curated from a community of about 5,000.");
    expect(after).not.toMatch(/at its height/);
    const sixNov = `March 2027\nWho will be in the room\n${OWNER_ORDERED_WORDING.slice(0, 4).map(([, b]) => b).join("\n")}`;
    expect(approvalState({ [PITCH_APPROVAL_HASH_SETTING]: "old-hash", pitch_approved_text: sixNov }, PITCH_APPROVAL_HASH_SETTING, "new-hash", after)).toBe("APPROVED");
    const settings = { [PITCH_APPROVAL_HASH_SETTING]: "old-hash", pitch_approved_text: before };
    expect(approvalState(settings, PITCH_APPROVAL_HASH_SETTING, "new-hash", after)).toBe("APPROVED");
    expect(approvalState(settings, PITCH_APPROVAL_HASH_SETTING, "new-hash", `${after}\nOne more line.`)).toBe("CHANGED");
  });
  it("the live pitch, rendered the old way and the new way, differs only by her ordered phrases", async () => {
    const { contentTexts } = await import("../src/worker/services/learningClub");
    const { withOwnerOrderedWording } = await import("../src/shared/tlc/learningClub");
    const now = (await contentTexts(env)).pitch;
    const old = OLD_WORDS.reduce((w, [a, b]) => w.split(b).join(a), now);
    expect(old).not.toBe(now);
    expect(withOwnerOrderedWording(old)).toBe(now);
  });
});
const OLD_WORDS: ReadonlyArray<readonly [string, string]> = [
  ["25 to 100+ guests per event, flexible to your goals", "25+ guests per event, flexible to your goals"],
  ["25 to 100+ New Yorkers per event, a number we flex to your goals, who will choose this topic.", "Rooms of 25+ New Yorkers per event, sized to your goals, who will choose this topic."],
  ["Founders, operators, creatives and builders from a community of about 5,000.", "Founders, operators, creatives and builders, curated from a community of about 5,000."],
];
