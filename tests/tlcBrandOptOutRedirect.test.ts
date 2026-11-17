import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { recordBrandMail, recordBrandReplyText } from "../src/worker/services/learningClub";
import { queueDeal } from "../src/worker/services/tlcMustPitch";
import { takeBrandReply } from "../src/worker/services/tlcBrandReply";
import type { TlcDealRow } from "../src/worker/services/learningClub";

/**
 * A STOP IS FOR THE WHOLE BRAND, AND A REDIRECT IS FOLLOWED (owner, 16 Nov 2026). Fake brands and addresses only.
 *  - Malin+Goetz: a colleague of the address we wrote to replied "unsubscribe." It was stored as a decline, and only the
 *    exact address was blocked, so another address or another club could be emailed again.
 *  - Therabody: info@ replied "email partnerships@… include what you do and what you have in mind", and it was closed
 *    as "they are reviewing it".
 */
let t: TestDb;
let env: Env;
const checked: string[] = [];
const NOW = new Date("2026-11-16T17:40:00.000Z");

async function deal(id: string, eventId: string, brand: string, email: string, sent = true): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO tlc_deal (id, event_id, brand, category, contact_email, contact_source_url, why_fit, stage, drip_step, first_sent_at, last_sent_at, next_send_at, firm_scope)
     VALUES (?1, ?2, ?3, 'Care', ?4, 'https://example.test', 'a fit', ?5, ?6, ?7, ?7, ?8, 'west-peek')`,
  ).bind(id, eventId, brand, email, sent ? "PITCHED" : "PROSPECT", sent ? 1 : 0, sent ? "2026-11-10T15:00:00.000Z" : null, "2026-11-20T15:00:00.000Z").run();
}
const row = (id: string) => env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(id).first<{ stage: string; stop_reason: string | null; next_send_at: string | null }>();
const arrive = async (from: string, subject: string, text: string, mid: string) => {
  await recordBrandMail(env, { from, subject, now: NOW });
  return recordBrandReplyText(env, { from, subject, text, messageId: `<${mid}>`, now: NOW });
};
const queue = (eventId: string, brand: string, email: string) =>
  queueDeal(env, { eventId, brand, category: "Care", contactName: null, contactEmail: email, contactSourceUrl: "https://example.test", whyFit: null, firmScope: "west-peek" }, NOW);

beforeAll(async () => {
  t = await createTestDb();
  env = { ...makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs }), WP_OS_NEVERBOUNCE_API_KEY: "nb_test" } as Env;
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const u = new URL(String(url));
    if (u.hostname === "api.neverbounce.com") {
      const email = u.searchParams.get("email") ?? "";
      checked.push(email);
      return new Response(JSON.stringify({ status: "success", result: email.startsWith("bad") ? "invalid" : "valid" }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  for (const [id, month] of [["tlc_2027-01", "2027-01"], ["tlc_2027-03", "2027-03"]] as const) {
    await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, angle, status, sponsor_categories_json, pitch_token) VALUES (?1, ?2, ?3, 'EVENING', 'A topic', 'An angle.', 'TOPIC_READY', '[]', ?4)")
      .bind(id, month, `${month}-20`, id.slice(-2).repeat(16)).run();
  }
});
afterAll(async () => { vi.unstubAllGlobals(); await disposeTestDb(t); });

describe("an unsubscribe from anyone at a brand stops the brand for good", () => {
  it("stores UNSUBSCRIBED, stops its other clubs, and refuses any other address or club", async () => {
    await deal("tld_mg", "tlc_2027-03", "Malin+Goetz", "press@malin.example");
    await deal("tld_mg_jan", "tlc_2027-01", "Malin + Goetz", "hello@malin.example", false);

    await arrive("Ben <b.ben@malin.example>", "Re: Malin+Goetz + a small room in New York", "unsubscribe.", "mg-1");

    expect(await row("tld_mg")).toMatchObject({ stop_reason: "UNSUBSCRIBED", stage: "STOPPED" });
    expect(await row("tld_mg_jan")).toMatchObject({ stop_reason: "UNSUBSCRIBED", stage: "STOPPED", next_send_at: null });
    // Another address at the same domain, another club, another spelling of the name: never queued.
    expect(await queue("tlc_2027-01", "Malin and Goetz", "info@malin.example")).toBe(false);
    expect(await queue("tlc_2027-03", "M&G Studio", "sales@malin.example")).toBe(false);
    expect(await queue("tlc_2027-01", "Malin+Goetz", "pr@agency.example")).toBe(false);
    // A different brand is not caught by it.
    expect(await queue("tlc_2027-01", "Other Care Co", "hi@othercare.example")).toBe(true);
  });
});

describe("a reply that points us to another address is a redirect", () => {
  it("queues email 1 to the named address on the brand's domain, NeverBounce-checked; the old thread stops", async () => {
    await deal("tld_tb", "tlc_2027-03", "Therabody", "info@thera.example");
    const text = "Hello,\n\nThanks for reaching out. For an event collaboration like this, the right route is to email [partnerships@thera.example](mailto:partnerships@thera.example).\n\nPlease include what you do and what you have in mind for the collaboration. The partnerships team reviews opportunities on a rolling basis.\n\nBest,\nVirtual Assistant";

    await arrive("Thera <info@thera.example>", "Re: Therabody + a small room in New York", text, "tb-1");

    const next = await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE event_id = 'tlc_2027-03' AND contact_email = 'partnerships@thera.example'")
      .first<{ stage: string; drip_step: number; next_send_at: string | null; first_sent_at: string | null; owner_angle: string | null }>();
    expect(next).toMatchObject({ stage: "PROSPECT", drip_step: 0, first_sent_at: null });
    expect(next?.next_send_at).toBeTruthy();
    expect(next?.owner_angle).toMatch(/what we have in mind/);
    expect(checked).toContain("partnerships@thera.example");
    expect(await row("tld_tb")).toMatchObject({ stage: "STOPPED", stop_reason: "REPLIED" });
    const reply = await env.WP_OS_DB.prepare("SELECT held_reason FROM tlc_brand_reply WHERE deal_id = 'tld_tb'").first<{ held_reason: string }>();
    expect(reply?.held_reason).toMatch(/redirect: .*partnerships@thera\.example/);
  });

  it("never follows an address off the brand's domain, nor one NeverBounce refuses", async () => {
    await deal("tld_off", "tlc_2027-03", "Offsite Co", "info@offsite.example");
    await arrive("Off <info@offsite.example>", "Re: x", "Please email our agency at events@agency-elsewhere.example with the details.", "off-1");
    expect(await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_deal WHERE contact_email = 'events@agency-elsewhere.example'").first()).toBeNull();

    await deal("tld_bad", "tlc_2027-03", "Badaddr Co", "info@badaddr.example");
    await arrive("Bad <info@badaddr.example>", "Re: x", "For partnerships, please email bad.partners@badaddr.example.", "bad-1");
    expect(await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_deal WHERE contact_email = 'bad.partners@badaddr.example'").first()).toBeNull();
    const reply = await env.WP_OS_DB.prepare("SELECT held_reason FROM tlc_brand_reply WHERE deal_id = 'tld_bad'").first<{ held_reason: string }>();
    expect(reply?.held_reason).toMatch(/TLC_REDIRECT_ADDRESS_REFUSED/);
  });
});

describe("a desk that sends us back to the address we already wrote to", () => {
  it("drafts the sample-event one-pager, no prices, to that address alone; a reply closed as 'no reply needed' is read again", async () => {
    // Therabody, 17 Nov 2026: email 1 had gone to partnerships@; info@'s assistant answered the old thread with this,
    // and it was closed as "they are reviewing it" ("emailing" was not read, and the deal's own address was skipped).
    await deal("tld_tbp", "tlc_2027-01", "Therabody", "partnerships@therapart.example");
    await env.WP_OS_DB.prepare("INSERT INTO tlc_drip_message (id, deal_id, step, subject, body, state, sent_at) VALUES ('tdm_tbp', 'tld_tbp', 0, 'West Peek x Therabody: a recovery station', 'Hi, what we do.', 'SENT', '2026-11-10T15:00:00.000Z')").run();
    const text = "Hello,\n\nThanks for sharing more context. For this kind of event collaboration, please continue by emailing [partnerships@therapart.example](mailto:partnerships@therapart.example).\n\nInclude what you do, where you post, and what you have in mind. The partnerships team reviews opportunities on a rolling basis and keeps information on file for future consideration.\n\nBest,  \nTherabody Virtual Assistant";
    await env.WP_OS_DB.prepare("INSERT INTO tlc_brand_reply (id, deal_id, brand_message_id, their_subject, their_text, received_at, intent, draft_subject, draft_body, state, held_reason) VALUES ('tbr_old', 'tld_tbp', 'tbp-1', 's', ?1, ?2, 'QUESTION', '', '', 'CLOSED', 'no reply needed (they are reviewing it): waiting on them, nothing drafted')").bind(text, NOW.toISOString()).run();
    const d = await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = 'tld_tbp'").first<TlcDealRow>();
    let html = "";
    const out = await takeBrandReply(env, d!, { messageId: "<tbp-1>", subject: "Therabody + a small room in New York", text, receivedAt: NOW.toISOString(), from: "Therabody <info@therapart.example>" },
      { now: NOW, samples: { renderPdf: async (h: string) => { html = h; return { pdfBase64: btoa("%PDF-1.4"), reason: null } as never; } } });

    expect(out).toBe("DRAFTED");
    const r = await env.WP_OS_DB.prepare("SELECT * FROM tlc_brand_reply WHERE deal_id = 'tld_tbp'").all<{ kind: string; state: string; send_to: string; send_cc_json: string | null; draft_subject: string; draft_body: string; attachments_json: string }>();
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ kind: "SAMPLE_EVENT", state: "DRAFTED", send_to: "partnerships@therapart.example", send_cc_json: null, draft_subject: "Re: West Peek x Therabody: a recovery station" });
    expect(r.results[0]!.draft_body).toMatch(/one-pager that lays out a sample event we are planning/);
    expect(JSON.parse(r.results[0]!.attachments_json)).toHaveLength(1);
    // No money before a call: no price, level or payment terms in the email or the one-pager.
    const page = html.replace(/<style>[\s\S]*?<\/style>/g, "");
    for (const words of [r.results[0]!.draft_body, page]) expect(words).not.toMatch(/\$\s?\d|\bfee\b|\bprice|invoice|payment|partner levels/i);
    expect(page).toMatch(/@westpeek/);
  });
});

describe("a reply through a helpdesk that quotes our email without \"On … wrote:\"", () => {
  it("is read on their words only: never an auto-reply, and our own P.S. is never their no", async () => {
    await deal("tld_desk", "tlc_2027-03", "Deskapp", "startup-partners@deskapp.example");
    const ours = "Hi,\n\nIn March 2027 we are hosting The Learning Club in New York.\n\nWould you be open to exploring a partnership?\n\nSequoia Taylor\nWest Peek Ventures\n\nP.S. If this isn't a fit, just let me know and I won't follow up.";
    await env.WP_OS_DB.prepare("INSERT INTO tlc_drip_message (id, deal_id, step, subject, body, state, sent_at) VALUES ('tdm_desk', 'tld_desk', 0, 'Deskapp + a small room in New York', ?1, 'SENT', '2026-11-10T00:24:00.000Z')").bind(ours).run();
    // Notion's real layout (16 Nov): the desk's template line, dashed rules, "Name, date" comment blocks, machine headers.
    const rule = "----------------------------------------------";
    const ticket = `From: Deskapp for Startups <startup-partners@deskapp.example>\r\nAuto-Submitted: auto-generated\r\nSubject: [Deskapp] Re: Deskapp + a small room in New York\r\n\r\nWe’ve responded to your message (5517441). If you need further assistance, please reply to this email.\n${rule}\n\nKyle, Nov 16, 2026, 09:41 PST\n\nHi Sequoia,\n\nCould you send a short overview of what you'd want from us as a founding partner, including any sponsorship fee? Happy to review the details here by email!\n\n-\nKyle,\nDeskapp for Startups\n\n${rule}\n\nSequoia Taylor, Nov 9, 2026, 16:24 PST\n\n${ours}`;

    await arrive("Deskapp for Startups <startup-partners@deskapp.example>", "[Deskapp] Re: Deskapp + a small room in New York", ticket, "desk-1");

    expect((await row("tld_desk"))?.stage).not.toBe("DECLINED");
    const reply = await env.WP_OS_DB.prepare("SELECT intent, their_text FROM tlc_brand_reply WHERE deal_id = 'tld_desk'").first<{ intent: string; their_text: string }>();
    expect(reply?.intent).not.toMatch(/^(?:NO|AUTO_REPLY)$/);
    expect((await row("tld_desk"))?.next_send_at).toBeNull();
    expect(reply?.their_text).toMatch(/sponsorship fee/);
    expect(reply?.their_text).not.toMatch(/isn't a fit/);
  });
});

