import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { contentHashes, recordBrandMail, recordBrandReplyText } from "../src/worker/services/learningClub";
import { applyBrandReplyApproval, approvalWords, type ReplyDrafter } from "../src/worker/services/tlcBrandReply";
import { THREE_THINGS_OFFER } from "../src/shared/tlc/brandReply";
import { TRUSTED_AUTHSERV_ID } from "../src/shared/intake/partnerAuthority";

/**
 * BOTH PARTNERS APPROVE A BRAND REPLY (owner, 6 Nov 2026). Scooter is copied on Wynn's approval email, his address
 * read from his own firm_user row; nothing goes to the brand until Sequoia AND Scooter have each replied "approved";
 * a change note from either sends it back to Wynn. Fake brands only.
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
const row = (id: string) => env.WP_OS_DB.prepare("SELECT state, notice_ref, approved_by_json FROM tlc_brand_reply WHERE deal_id = ?1 ORDER BY received_at DESC").bind(id).first<{ state: string; notice_ref: string; approved_by_json: string | null }>();

async function replyFrom(dealId: string, brand: string, email: string): Promise<string> {
  await env.WP_OS_DB.prepare(
    "INSERT INTO tlc_deal (id, event_id, brand, contact_email, contact_source_url, why_fit, stage, drip_step, first_sent_at, last_sent_at, next_send_at, firm_scope) VALUES (?1, 'tlc_2027-03', ?2, ?3, 'https://example.test', 'fit', 'PITCHED', 1, '2026-11-09T15:00:00.000Z', '2026-11-09T15:00:00.000Z', '2026-11-21T15:00:00.000Z', 'west-peek')",
  ).bind(dealId, brand, email).run();
  await recordBrandMail(env, { from: `Pat <${email}>`, subject: `Re: ${brand} + a small room in New York`, now: AT });
  await recordBrandReplyText(env, { from: `Pat <${email}>`, subject: `Re: ${brand} + a small room in New York`, text: "Hi Sequoia,\n\nWhat do you have in mind?", messageId: `<${dealId}@brand.example>`, now: AT });
  return (await row(dealId))!.notice_ref;
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

describe("the approval email copies Scooter and says both must approve", () => {
  it("to Sequoia, Scooter in Cc from his record, the rule in plain words; the notice names both approvers", async () => {
    const ref = await replyFrom("tld_one", "One Co", "pat@one.example");
    expect(ref).toMatch(/^TLR-/);
    const mail = toUs().find((s) => s.subject.includes(ref))!;
    expect(mail.to).toBe(SEQUOIA);
    expect(mail.cc).toBe(SCOOTER);
    expect(mail.text.replace(/\s+/g, " ")).toContain('Nothing sends until Sequoia and Scooter have each replied "approved"');
    expect(JSON.parse((await env.WP_OS_DB.prepare("SELECT approvers_json FROM tlc_brand_reply_notice WHERE ref = ?1").bind(ref).first<{ approvers_json: string }>())!.approvers_json))
      .toEqual(["fu_sequoia_taylor", "fu_scooter_taylor"]);
  });
});

describe("nothing goes until both have approved", () => {
  it("only Sequoia: recorded, nothing sent, and the reply says who is still needed", async () => {
    const ref = await replyFrom("tld_her", "Her Co", "pat@her.example");
    sends.length = 0;
    const out = await answer(SEQUOIA, "approved", ref);
    expect(out.handled).toBe(true);
    expect(out.detail).toContain("Sequoia approved · waiting on Scooter; nothing sent yet");
    expect(toBrand()).toHaveLength(0);
    expect(await row("tld_her")).toMatchObject({ state: "NOTIFIED", approved_by_json: JSON.stringify(["fu_sequoia_taylor"]) });
    const ack = toUs().find((s) => s.subject.includes("half approved"))!;
    expect(ack.cc).toBe(SCOOTER);
    expect(ack.text).toContain("Sequoia approved · waiting on Scooter");
    // The same "approved" again changes nothing.
    sends.length = 0;
    await answer(SEQUOIA, "approved", ref);
    expect(toBrand()).toHaveLength(0);
  });

  it("only Scooter: recorded, nothing sent", async () => {
    const ref = await replyFrom("tld_him", "Him Co", "pat@him.example");
    sends.length = 0;
    const out = await answer(SCOOTER, "approved", ref);
    expect(out.detail).toContain("Scooter approved · waiting on Sequoia; nothing sent yet");
    expect(toBrand()).toHaveLength(0);
    expect((await row("tld_him"))!.state).toBe("NOTIFIED");
  });

  it("both, in either order: sent once, from her mailbox, to the brand", async () => {
    const ref = await replyFrom("tld_both", "Both Co", "pat@both.example");
    sends.length = 0;
    await answer(SCOOTER, "approved", ref);
    expect(toBrand()).toHaveLength(0);
    const out = await answer(SEQUOIA, "approved", ref);
    expect(out.detail).toContain("Sequoia and Scooter approved; sent from");
    expect(toBrand()).toHaveLength(1);
    expect(toBrand()[0]!.to).toContain("pat@both.example");
    expect((await row("tld_both"))!.state).toBe("SENT");
    // A third "approved" sends nothing again.
    await answer(SCOOTER, "approved", ref);
    expect(toBrand()).toHaveLength(1);
  });

  it("a change from Scooter sends it back to Wynn: redrafted, a new email, approvals cleared, not learned as a standing rule", async () => {
    const ref = await replyFrom("tld_change", "Change Co", "pat@change.example");
    await answer(SEQUOIA, "approved", ref);
    sends.length = 0;
    const rulesBefore = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_wynn_rule").first<{ n: number }>())!.n;
    const out = await answer(SCOOTER, "Make it shorter, and always mention the rooftop.", ref);
    expect(out.handled).toBe(true);
    expect(toBrand()).toHaveLength(0);
    const r = (await row("tld_change"))!;
    expect(r.state).toBe("NOTIFIED");
    expect(r.notice_ref).not.toBe(ref);
    expect(r.approved_by_json).toBeNull();
    expect(toUs().some((s) => s.subject.includes(r.notice_ref) && s.text.includes("Redrafted: Make it shorter"))).toBe(true);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_wynn_rule").first<{ n: number }>())!.n).toBe(rulesBefore);
    // Her earlier "approved" was for the old draft: the new one needs both again.
    const again = await answer(SEQUOIA, "approved", r.notice_ref);
    expect(again.detail).toContain("waiting on Scooter");
    expect(toBrand()).toHaveLength(0);
  });

  it("a change from Sequoia redrafts too", async () => {
    const ref = await replyFrom("tld_change2", "Change Two Co", "pat@change2.example");
    await answer(SCOOTER, "approved", ref);
    await answer(SEQUOIA, "Warmer opening please.", ref);
    const r = (await row("tld_change2"))!;
    expect(r.notice_ref).not.toBe(ref);
    expect(r.approved_by_json).toBeNull();
    expect(toBrand()).toHaveLength(0);
  });

  it("Scooter's address with failed authentication, or anyone else, approves nothing", async () => {
    const ref = await replyFrom("tld_spoof", "Spoof Co", "pat@spoof.example");
    sends.length = 0;
    const forged = `${TRUSTED_AUTHSERV_ID}; dkim=fail; spf=fail; dmarc=fail header.from=${SCOOTER.split("@")[1]}`;
    expect((await answer(SCOOTER, "approved", ref, forged)).handled).toBe(false);
    expect((await answer("someone@else.example", "approved", ref)).handled).toBe(false);
    await answer(SEQUOIA, "approved", ref);
    expect(toBrand()).toHaveLength(0);
    expect((await row("tld_spoof"))!.approved_by_json).toBe(JSON.stringify(["fu_sequoia_taylor"]));
  });
});

describe("the words", () => {
  it("says who has approved and who is still needed", () => {
    expect(approvalWords(["fu_sequoia_taylor", "fu_scooter_taylor"], [])).toBe("nobody has approved yet · waiting on Sequoia and Scooter");
    expect(approvalWords(["fu_sequoia_taylor", "fu_scooter_taylor"], ["fu_scooter_taylor"])).toBe("Scooter approved · waiting on Sequoia");
    expect(approvalWords(["fu_sequoia_taylor", "fu_scooter_taylor"], ["fu_sequoia_taylor", "fu_scooter_taylor"])).toBe("Sequoia and Scooter approved");
  });
});
