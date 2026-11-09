import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { contentHashes } from "../src/worker/services/learningClub";
import { applyBrandReplyApproval, type ReplyDrafter } from "../src/worker/services/tlcBrandReply";
import { inReminderWindow, sendApprovalReminders } from "../src/worker/services/tlcApprovalReminder";
import { TRUSTED_AUTHSERV_ID } from "../src/shared/intake/partnerAuthority";

/**
 * WYNN REMINDS ON AN UNANSWERED APPROVAL (owner, 9 Nov 2026). 24 hours after the last email on the thread, then every
 * 24 hours, weekdays 9 AM to 5 PM Chicago, only to whoever has not answered, on the original thread; stops when
 * everyone has answered or it is skipped; a new version resets the count. Fake brands and addresses only.
 */
let t: TestDb;
let env: Env;
let SEQUOIA = "";
let SCOOTER = "";
const sends: Array<{ to: string; cc: string; subject: string; text: string; inReplyTo: string }> = [];
const auth = (address: string) => `${TRUSTED_AUTHSERV_ID}; dkim=pass header.d=${address.split("@")[1]} header.s=s1; spf=pass smtp.mailfrom=${address}; dmarc=pass header.from=${address.split("@")[1]}`;
const drafter: ReplyDrafter = async (_e, _a, i) => ({ ok: true, body: `Hi,\n\nShorter, per "${(i.note ?? "").split("\n")[0]}".`, detail: "ok", changes: (i.notes ?? []).map((n) => ({ who: n.who, note: n.note.slice(0, 60), done: "done as asked" })) });

// Mon 9 Nov 2026, 9:00 AM in Chicago (CST = UTC-6).
const SENT = new Date("2026-11-09T15:00:00.000Z");
const at = (hoursAfterSent: number) => new Date(SENT.getTime() + hoursAfterSent * 3_600_000);
const hex = (c: string) => c.repeat(32);
let tokens = 0;
const newToken = () => `wpt_${(tokens += 1).toString(16).padStart(32, "0")}`;

async function waitingReply(scope: string, ref: string, opts: { partners?: boolean; inputs?: Record<string, unknown> } = {}): Promise<string> {
  const id = `tbr_${ref}`;
  await env.WP_OS_DB.prepare("INSERT INTO tlc_deal (id, event_id, brand, contact_name, contact_email, contact_source_url, why_fit, stage, drip_step, first_sent_at, firm_scope) VALUES (?1, 'tlc_2027-03', ?2, 'Robin Vale (Head of Developer Relations)', ?3, 'https://example.test', 'fit', 'PITCHED', 1, '2026-11-01T15:00:00.000Z', ?4)")
    .bind(`tld_${ref}`, `Brand ${ref.slice(-3)}`, `robin@${ref.toLowerCase()}.example`, scope).run();
  await env.WP_OS_DB.prepare(
    `INSERT INTO tlc_brand_reply (id, deal_id, brand_message_id, their_subject, their_text, received_at, intent, draft_subject, draft_body, state, notice_ref, thread_ref, round, kind, inputs_json, version, firm_scope)
     VALUES (?1, ?2, ?3, 'Re: a room', 'How much would it be?', '2026-11-06T16:00:00.000Z', 'QUESTION', 'Re: a room', ?4, 'NOTIFIED', ?5, ?5, ?6, ?7, ?8, 1, ?9)`,
  ).bind(id, `tld_${ref}`, `<m-${ref}@x.example>`, opts.partners ? "Hi,\n\nLead is $10,000 per event." : "Hi,\n\nHappy to tell you more.", ref, opts.partners ? "PARTNERS" : null, opts.partners ? "PROPOSAL" : null, opts.inputs ? JSON.stringify(opts.inputs) : null, scope).run();
  const approvers = opts.partners ? ["fu_sequoia_taylor", "fu_scooter_taylor"] : ["fu_sequoia_taylor"];
  await env.WP_OS_DB.prepare("INSERT INTO tlc_brand_reply_notice (ref, reply_ids_json, day, firm_scope, sent_at, sent_to, approvers_json) VALUES (?1, ?2, '2026-11-09', ?3, ?4, ?5, ?6)")
    .bind(ref, JSON.stringify([id]), scope, SENT.toISOString(), SEQUOIA, JSON.stringify(approvers)).run();
  await env.WP_OS_DB.prepare("INSERT INTO email_thread (token, object_type, object_id, employee, to_address, subject, firm_scope, created_at) VALUES (?1, ?2, ?3, 'Wynn', ?4, ?5, ?6, ?7)")
    .bind(newToken(), opts.partners ? "tlc_pricing_notice" : "tlc_brand_reply_notice", ref, SEQUOIA, `${opts.partners ? "ACTION REQUIRED: " : ""}Brand ${ref.slice(-3)} Reply · v1 · ready for your OK · ${ref}`, scope, SENT.toISOString()).run();
  return id;
}
const tokenOf = async (ref: string) => (await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_id = ?1 ORDER BY created_at LIMIT 1").bind(ref).first<{ token: string }>())!.token;
const remind = (scope: string, now: Date) => sendApprovalReminders(env, now, scope);

beforeAll(async () => {
  t = await createTestDb();
  env = { ...makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>), RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Env;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const b = JSON.parse(String(init?.body)) as { to: string | string[]; cc?: string[]; subject: string; text: string; headers?: Record<string, string> };
      sends.push({ to: Array.isArray(b.to) ? b.to.join(",") : b.to, cc: (b.cc ?? []).join(","), subject: b.subject, text: b.text, inReplyTo: b.headers?.["In-Reply-To"] ?? "" });
      return new Response(JSON.stringify({ id: `re_${sends.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  SEQUOIA = (await env.WP_OS_DB.prepare("SELECT email FROM firm_user WHERE id = 'fu_sequoia_taylor'").first<{ email: string }>())!.email;
  SCOOTER = (await env.WP_OS_DB.prepare("SELECT email FROM firm_user WHERE id = 'fu_scooter_taylor' AND status = 'ACTIVE'").first<{ email: string }>())!.email;
  await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, angle, status, sponsor_categories_json, pitch_token) VALUES ('tlc_2027-03', '2027-03', '2027-03-18', 'EVENING', 'Build Your Own AI Agent', 'A hands-on evening.', 'TOPIC_READY', '[]', ?1)").bind(hex("e")).run();
  const h = await contentHashes(env);
  await env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value) VALUES ('pitch_approved_hash', ?1), ('playbook_approved_hash', ?2), ('brand_send', 'on') ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(h.pitch, h.playbook).run();
});
afterEach(() => { sends.length = 0; });
afterAll(async () => { vi.unstubAllGlobals(); await disposeTestDb(t); });

describe("the window is decided in Chicago", () => {
  it("weekdays 9 AM to 5 PM only", () => {
    expect(inReminderWindow(new Date("2026-11-10T15:00:00.000Z"))).toBe(true); // Tue 9:00 AM CT
    expect(inReminderWindow(new Date("2026-11-10T14:59:00.000Z"))).toBe(false); // Tue 8:59 AM CT
    expect(inReminderWindow(new Date("2026-11-10T23:00:00.000Z"))).toBe(false); // Tue 5:00 PM CT
    expect(inReminderWindow(new Date("2026-11-14T17:00:00.000Z"))).toBe(false); // Sat 11 AM CT
  });
});

describe("a round-1 reply waiting on her", () => {
  it("24 hours later one reminder on the thread; the same day nothing; 48 hours later the 2nd; a weekend nothing; then the next weekday", async () => {
    await waitingReply("rem-a", "TLR-AAAAA1");
    expect(await remind("rem-a", at(5))).toMatch(/0 sent; 1 not due yet/); // Mon 2 PM CT: only 5 hours
    expect(await remind("rem-a", at(23))).toMatch(/outside 9 AM to 5 PM/); // Tue 8 AM CT
    expect(sends).toHaveLength(0);

    await remind("rem-a", at(24)); // Tue 9 AM CT
    expect(sends).toHaveLength(1);
    const r1 = sends[0]!;
    expect(r1.to).toBe(SEQUOIA);
    expect(r1.cc).toBe("");
    expect(r1.subject).toBe("Re: Brand AA1 Reply · v1 · ready for your OK · TLR-AAAAA1");
    expect(r1.inReplyTo).toBe(`<${await tokenOf("TLR-AAAAA1")}@joinwestpeek.com>`);
    expect(r1.text.split("\n")[0]).toBe("Reminder 1: our reply to Brand AA1 is still waiting for your OK. Wynn sent it to you Monday 9 Nov.");
    expect(r1.text).toContain("Brand AA1 has waited 3 days since their last email (Friday 6 Nov).");
    expect(r1.text).toContain('Reply "approved", "skip", or your changes, on this thread.');
    expect(r1.text).not.toMatch(/tbr_|tld_|wpt_/);

    sends.length = 0;
    await remind("rem-a", at(30)); // the same day, and a re-delivered tick
    await remind("rem-a", at(30));
    expect(sends).toHaveLength(0);

    await remind("rem-a", at(48)); // Wed 9 AM CT
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text.split("\n")[0]).toMatch(/^Reminder 2: /);

    sends.length = 0;
    await remind("rem-a", at(72)); // Thu: 3rd
    await remind("rem-a", at(96)); // Fri: 4th
    expect(sends).toHaveLength(2);
    sends.length = 0;
    await remind("rem-a", at(120)); // Sat 9 AM CT
    await remind("rem-a", at(146)); // Sun 11 AM CT
    await remind("rem-a", at(167)); // Mon 8 AM CT
    expect(sends).toHaveLength(0);
    await remind("rem-a", at(168)); // Mon 9 AM CT
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text.split("\n")[0]).toMatch(/^Reminder 5: /);
  });

  it("her change notes: Wynn's new version resets the clock and the count", async () => {
    await waitingReply("rem-c", "TLR-CCCCC1");
    await remind("rem-c", at(24));
    expect(sends).toHaveLength(1);
    sends.length = 0;
    const out = await applyBrandReplyApproval(env, { fromHeader: `Sequoia <${SEQUOIA}>`, authenticationResults: auth(SEQUOIA), subject: "Re: Brand CC1 Reply · v1 · ready for your OK · TLR-CCCCC1", body: "make it shorter\n\nRef TLR-CCCCC1" }, { now: at(26), drafter });
    expect(out.handled).toBe(true);
    // The v2 email just went (Tue 11 AM CT): not due until 24 hours after it.
    sends.length = 0;
    await remind("rem-c", at(49)); // Wed 10 AM CT: 23 hours after v2
    expect(sends).toHaveLength(0);
    await remind("rem-c", at(50));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text.split("\n")[0]).toMatch(/^Reminder 1: /);
  });

  it("approved, or skipped: no reminder", async () => {
    await waitingReply("rem-s", "TLR-SSSSS1");
    const out = await applyBrandReplyApproval(env, { fromHeader: `Sequoia <${SEQUOIA}>`, authenticationResults: auth(SEQUOIA), subject: "Re: TLR-SSSSS1", body: "skip\n\nRef TLR-SSSSS1" }, { now: at(2), drafter });
    expect(out.detail).toMatch(/skipped by Sequoia/);
    expect((await env.WP_OS_DB.prepare("SELECT state FROM tlc_brand_reply WHERE id = 'tbr_TLR-SSSSS1'").first<{ state: string }>())!.state).toBe("SKIPPED");
    sends.length = 0; // her "done" note for the skip
    expect(await remind("rem-s", at(24))).toBe("reminders: nothing waiting for an answer");
    // Approved and sent (the state an approved reply ends in): nothing either.
    await waitingReply("rem-s", "TLR-SSSSS2");
    await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'SENT', sent_at = ?1 WHERE id = 'tbr_TLR-SSSSS2'").bind(at(3).toISOString()).run();
    expect(await remind("rem-s", at(24))).toBe("reminders: nothing waiting for an answer");
    expect(sends).toHaveLength(0);
  });
});

describe("a round-2 pricing draft waiting on both partners", () => {
  it("nobody answered: one reminder to her with Scooter copied, on the thread", async () => {
    await waitingReply("rem-p", "TLR-PPPPP1", { partners: true });
    await remind("rem-p", at(24));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toBe(SEQUOIA);
    expect(sends[0]!.cc).toBe(SCOOTER);
    expect(sends[0]!.subject).toBe("Re: ACTION REQUIRED: Brand PP1 Reply · v1 · ready for your OK · TLR-PPPPP1");
    expect(sends[0]!.text).toContain("Nobody has approved yet: waiting on Sequoia and Scooter.");
  });

  it("Scooter approved (his reply accepted), Sequoia not: only she is reminded, and told Scooter approved", async () => {
    await waitingReply("rem-h", "TLR-HHHHH1", { partners: true });
    const his = await applyBrandReplyApproval(env, { fromHeader: `Scooter <${SCOOTER}>`, authenticationResults: auth(SCOOTER), subject: "Re: TLR-HHHHH1", body: "approved\n\nRef TLR-HHHHH1" }, { now: at(1), drafter });
    expect(his.handled).toBe(true);
    expect(his.detail).toMatch(/Scooter approved; waiting on Sequoia/);
    sends.length = 0;
    await remind("rem-h", at(24));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toBe(SEQUOIA);
    expect(sends[0]!.cc).toBe("");
    expect(sends[0]!.text).toContain("Scooter approved; waiting on you.");
  });

  it("Sequoia approved, Scooter not: only he is reminded, on the same thread", async () => {
    await waitingReply("rem-k", "TLR-KKKKK1", { partners: true, inputs: { fu_sequoia_taylor: { approved: true, note: null, at: at(1).toISOString() } } });
    await remind("rem-k", at(24));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toBe(SCOOTER);
    expect(sends[0]!.cc).toBe("");
    expect(sends[0]!.inReplyTo).toBe(`<${await tokenOf("TLR-KKKKK1")}@joinwestpeek.com>`);
    expect(sends[0]!.text).toContain("Sequoia approved; waiting on you.");
  });
});

describe("the door still decides who may be addressed", () => {
  it("Scooter alone is reachable only on a pricing email; any other Wynn email aimed at him goes to Sequoia", async () => {
    const { emailOwner } = await import("../src/worker/services/learningClub");
    const laidOut = { subject: "Re: x · TLR-DOORX1", text: "Reminder 1: a test.\n", html: "<p>Reminder 1: a test.</p>" };
    const send = (objectType: string) => emailOwner(env, { employee: "Wynn", to: [SCOOTER], email: { what: laidOut.subject, tldr: "t", sections: [], laidOut }, objectType, objectId: "TLR-DOORX1:reminder:1", cardId: null, cardKind: null, firmScope: "rem-door" });
    await send("tlc_brand_reply_notice");
    await send("tlc_drip");
    await send("tlc_pricing_notice");
    expect(sends.map((x) => x.to)).toEqual([SEQUOIA, SEQUOIA, SCOOTER]);
  });
});

describe("the weekly batch", () => {
  async function batch(scope: string, ref: string, createdAt: Date, liveDrafts: number, decided = 0): Promise<void> {
    const actionKey = (await env.WP_OS_DB.prepare("SELECT key FROM action_type LIMIT 1").first<{ key: string }>())!.key;
    const items: unknown[] = [];
    for (let i = 0; i < liveDrafts + decided; i += 1) {
      const dealId = `tld_${ref}_${i}`;
      await env.WP_OS_DB.prepare("INSERT INTO tlc_deal (id, event_id, brand, contact_email, contact_source_url, why_fit, firm_scope) VALUES (?1, 'tlc_2027-03', ?2, ?3, 'https://example.test', 'fit', ?4)").bind(dealId, `B${i}`, `p${i}@${ref.toLowerCase()}.example`, scope).run();
      await env.WP_OS_DB.prepare("INSERT INTO approval_card (id, action_key, object_type, object_id, title, requested_by_type, requested_by_id, required_approver_roles_json, state) VALUES (?1, ?2, 'tlc_drip_message', ?3, 't', 'AI', 'aie_wynn', '[]', ?4)")
        .bind(`ac_${ref}_${i}`, actionKey, `m_${ref}_${i}`, i < liveDrafts ? "pending_review" : "approved").run();
      await env.WP_OS_DB.prepare("INSERT INTO tlc_drip_message (id, deal_id, step, subject, body, state, approval_card_id) VALUES (?1, ?2, 0, 's', 'b', ?3, ?4)").bind(`m_${ref}_${i}`, dealId, i < liveDrafts ? "AWAITING_APPROVAL" : "SENT", `ac_${ref}_${i}`).run();
      items.push({ n: i + 1, kind: "drip", message_id: `m_${ref}_${i}`, card_id: `ac_${ref}_${i}`, brand: `B${i}`, month: "2027-03", step: 0 });
    }
    await env.WP_OS_DB.prepare("INSERT INTO tlc_draft_notice (ref, items_json, firm_scope, root_ref, created_at) VALUES (?1, ?2, ?3, ?1, ?4)").bind(ref, JSON.stringify(items), scope, createdAt.toISOString()).run();
    await env.WP_OS_DB.prepare("INSERT INTO email_thread (token, object_type, object_id, employee, to_address, subject, firm_scope, created_at) VALUES (?1, 'tlc_drip', ?2, 'Wynn', ?3, ?4, ?5, ?6)")
      .bind(newToken(), ref, SEQUOIA, `Wynn: TLC: this week's brands, ${liveDrafts + decided} to approve · ${ref}`, scope, createdAt.toISOString()).run();
  }

  it("an older batch replaced by a newer one: only the newer one is reminded, with her reply options", async () => {
    await batch("rem-b", "TLC-OLDER1", at(-72), 3);
    await batch("rem-b", "TLC-NEWER2", SENT, 2, 1);
    await remind("rem-b", at(24));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toBe(SEQUOIA);
    expect(sends[0]!.subject).toBe("Re: Wynn: TLC: this week's brands, 3 to approve · TLC-NEWER2");
    expect(sends[0]!.text.split("\n")[0]).toBe("Reminder 1: 2 brand emails are still waiting for you from Monday 9 Nov's batch.");
    expect(sends[0]!.text).toContain('Reply "approve all", or "approve 1, 3"');
    expect(sends[0]!.text).toContain("Ref TLC-NEWER2");
  });

  it("a batch with every draft decided gets nothing (the live TLC-UH9A9E case: 35 approved)", async () => {
    await batch("rem-d", "TLC-DONE01", SENT, 0, 4);
    expect(await remind("rem-d", at(24))).toBe("reminders: nothing waiting for an answer");
    expect(sends).toHaveLength(0);
  });
});
