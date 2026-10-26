import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { contentHashes, isOwnBrandMailCopy, pitchFollowUp, runDrip } from "../src/worker/services/learningClub";
import { recomposeBrandNames } from "../src/worker/services/tlcDraftNotice";
import { brandDisplayName, dripEmail } from "../src/shared/tlc/learningClub";
import { gmailRaw } from "../src/worker/effects/googleClient";
import { decideApproval } from "../src/worker/services/approvals";
import { actorForFirmUser } from "../src/worker/services/authorize";

/**
 * 24 Oct 2026, the owner: a Learning Club brand email is signed by her, so it comes FROM her own Gmail and sits in
 * her Sent folder; and a brand is named the way a person would write it ("Osmo", not "Osmo (Generation)").
 */

const SEQUOIA = "sequoia@westpeek.ventures";
const MORNING = new Date("2026-11-09T14:00:00.000Z");
const SERVICE_ACCOUNT = JSON.stringify({ client_email: "sa@firm.iam.example", private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) });

describe("the brand's name, as a person writes it", () => {
  it("drops a parenthetical qualifier, keeps everything else, never comes out empty", () => {
    expect(brandDisplayName("Osmo (Generation)")).toBe("Osmo");
    expect(brandDisplayName("Quest Diagnostics (questhealth.com)")).toBe("Quest Diagnostics");
    expect(brandDisplayName("Fireworks AI")).toBe("Fireworks AI");
    expect(brandDisplayName("(stealth)")).toBe("(stealth)");
  });

  it("every drip step and the pitch email use the clean name in subject and body", () => {
    for (const step of [0, 1, 2, 3]) {
      const m = dripEmail({ step, brand: "Osmo (Generation)", contactName: "Pat Lee", topic: "Fragrance Lab", month: "2027-02", eventDate: "2027-02-11", why: null });
      expect(m.subject).toBe("Osmo + a small room in New York");
      expect(m.text).not.toContain("(Generation)");
    }
    expect(dripEmail({ step: 0, brand: "Osmo (Generation)", contactName: null, topic: "Fragrance Lab", month: "2027-02", eventDate: "2027-02-11", why: null }).text)
      .toContain("I am writing because Osmo feels like a natural fit for a room we are building.");
    expect(pitchFollowUp({ brand: "Quest Diagnostics (questhealth.com)", contactName: null, topic: "The Longevity Reset", month: "2027-01", pitchUrl: "https://x.example/p", callLink: null }).subject)
      .toBe("Quest Diagnostics + a small room in New York");
  });
});

describe("the Gmail message itself", () => {
  it("carries Reply-To, a blind copy and a PDF; a newline in an address cannot add a header", () => {
    const raw = gmailRaw({
      to: "pat@brand.example", from: SEQUOIA, fromName: "Sequoia Taylor", subject: "Café + a small room", text: "Hi,",
      replyTo: [SEQUOIA, "os@joinwestpeek.com"], bcc: ["os@joinwestpeek.com\r\nX-Evil: 1"],
      attachments: [{ filename: "pitch.pdf", content: "JVBERi0xLjQK", contentType: "application/pdf" }],
    });
    expect(raw).toContain("From: Sequoia Taylor <sequoia@westpeek.ventures>\r\n");
    expect(raw).toContain("Reply-To: sequoia@westpeek.ventures, os@joinwestpeek.com\r\n");
    expect(raw).not.toMatch(/^X-Evil:/m);
    expect(raw).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
    expect(raw).toMatch(/Content-Type: multipart\/mixed; boundary="wpos_[0-9a-f]+"/);
    expect(raw).toContain('Content-Disposition: attachment; filename="pitch.pdf"');
  });
});

describe("in the database", () => {
  let t: TestDb;
  let env: Env;
  const calls: string[] = [];
  beforeAll(async () => {
    t = await createTestDb();
    env = { ...makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>), RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Env;
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url) === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ error: "unauthorized_client" }), { status: 401 });
      if (String(url).includes("api.resend.com")) return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_parker','aie_wynn')").run();
    await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES ('fu_sequoia_taylor', ?1, 'Sequoia Taylor', 'ACTIVE')").bind(SEQUOIA).run();
    await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, angle, status, sponsor_categories_json, pitch_token) VALUES ('tlc_2027-02', '2027-02', '2027-02-11', 'EVENING', 'Fragrance Lab', 'A hands-on evening.', 'TOPIC_READY', '[]', ?1)").bind("b".repeat(32)).run();
    const h = await contentHashes(env);
    await env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value) VALUES ('pitch_approved_hash', ?1), ('playbook_approved_hash', ?2), ('brand_send', 'on') ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(h.pitch, h.playbook).run();
    await env.WP_OS_DB.prepare("INSERT INTO outside_email_allow (item_type, item_id, allowed, changed_by) VALUES ('JOB','tlc_brand_sales',1,'test')").run();
    for (const [id, brand, email] of [["tld_osmo", "Osmo (Generation)", "pat@osmo.example"], ["tld_quest", "Quest Diagnostics (questhealth.com)", "kim@quest.example"], ["tld_own", "Mine Co (owner text)", "lee@mine.example"]] as const) {
      await env.WP_OS_DB.prepare("INSERT INTO tlc_deal (id, event_id, brand, contact_name, contact_email, contact_source_url, why_fit, next_send_at, firm_scope) VALUES (?1, 'tlc_2027-02', ?2, 'Pat Example', ?3, 'https://example.test/team', NULL, ?4, 'west-peek')")
        .bind(id, brand, email, MORNING.toISOString()).run();
    }
  });
  afterEach(() => { calls.length = 0; });
  afterAll(async () => { vi.unstubAllGlobals(); await disposeTestDb(t); });

  /** Approved the way she approves: her decision on the card, which is what authorize() reads. */
  const approve = async (deal: string) => {
    const card = (await env.WP_OS_DB.prepare("SELECT approval_card_id AS id FROM tlc_drip_message WHERE deal_id = ?1").bind(deal).first<{ id: string }>())!.id;
    await decideApproval(env, (await actorForFirmUser(env, "fu_sequoia_taylor"))!, card, "approved", "test");
  };
  const draft = (deal: string) => env.WP_OS_DB.prepare(
    "SELECT m.state, m.subject, m.body, a.state AS card, a.summary, r.payload_json FROM tlc_drip_message m JOIN approval_card a ON a.id = m.approval_card_id JOIN external_effect_request r ON r.id = m.effect_request_id WHERE m.deal_id = ?1",
  ).bind(deal).first<{ state: string; subject: string; body: string; card: string; summary: string; payload_json: string }>();

  it("drafts filed before the fix are re-composed in place, approved or not; nothing is approved, her own text is untouched", async () => {
    // As the composer wrote them before the display name: the stored brand, parenthetical and all.
    await runDrip(env, MORNING);
    for (const [deal, brand] of [["tld_osmo", "Osmo (Generation)"], ["tld_quest", "Quest Diagnostics (questhealth.com)"]] as const) {
      const m = (await draft(deal))!;
      const subject = m.subject.replace(brandDisplayName(brand), brand);
      const body = m.body.split(brandDisplayName(brand)).join(brand);
      const payload = { ...JSON.parse(m.payload_json), subject, text: body };
      await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET subject = ?2, body = ?3 WHERE deal_id = ?1").bind(deal, subject, body).run();
      await env.WP_OS_DB.prepare("UPDATE external_effect_request SET payload_json = ?2 WHERE id = (SELECT effect_request_id FROM tlc_drip_message WHERE deal_id = ?1)").bind(deal, JSON.stringify(payload)).run();
    }
    // Hers, not the template: left exactly as it is.
    await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET subject = 'Mine Co (owner text) and you', body = 'Her words.' WHERE deal_id = 'tld_own'").run();
    // Quest is approved and waiting for tomorrow's allowance; Osmo is still undecided.
    await approve("tld_quest");
    expect((await draft("tld_quest"))!.subject).toBe("Quest Diagnostics (questhealth.com) + a small room in New York");

    expect((await recomposeBrandNames(env)).sort()).toEqual(["Osmo", "Quest Diagnostics"]);
    for (const [deal, name, card] of [["tld_osmo", "Osmo", "pending_review"], ["tld_quest", "Quest Diagnostics", "approved"]] as const) {
      const m = (await draft(deal))!;
      expect(m.card).toBe(card);
      expect(m.state).toBe("AWAITING_APPROVAL");
      const sent = JSON.parse(m.payload_json) as { subject: string; text: string };
      // No brand qualifier anywhere (the template's own "(flexible to your goals)" is not one).
      for (const words of [m.subject, m.body, m.summary, sent.subject, sent.text]) {
        expect(words).not.toMatch(/\((?:Generation|questhealth\.com)\)/);
        expect(words.replace(/\(flexible to your goals\)/g, "")).not.toMatch(/\(/);
      }
      expect(sent.subject).toBe(`${name} + a small room in New York`);
    }
    expect((await draft("tld_own"))!.subject).toBe("Mine Co (owner text) and you");
    expect(await recomposeBrandNames(env)).toEqual([]);
  });

  const requestOf = async (deal: string) => (await env.WP_OS_DB.prepare("SELECT effect_request_id AS id FROM tlc_drip_message WHERE deal_id = ?1").bind(deal).first<{ id: string }>())!.id;
  const failure = async (requestId: string) => {
    const r = await env.WP_OS_DB.prepare("SELECT state FROM external_effect_request WHERE id = ?1").bind(requestId).first<{ state: string }>();
    const e = await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE event_type = 'effect.failed' AND object_id = ?1").bind(requestId).first<{ payload_json: string }>();
    return { state: r!.state, error: e ? (JSON.parse(e.payload_json) as { error: string }).error : null };
  };

  it("an approved brand email whose sender Google refuses FAILS with the reason; it never goes out as anybody else", async () => {
    await approve("tld_osmo");
    const osmo = await requestOf("tld_osmo");
    const noAccount = await runDrip(env, MORNING);
    expect(noAccount.sent).toBe(0);
    expect(await failure(osmo)).toEqual({ state: "FAILED", error: expect.stringMatching(/WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON is not set/) });
    expect(calls.filter((c) => c.includes("api.resend.com"))).toEqual([]);

    // With the account but without the delegation grant: still FAILED, still nothing through the firm transport.
    await approve("tld_own");
    const own = await requestOf("tld_own");
    const refused = await runDrip({ ...env, WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT } as Env, MORNING);
    expect(refused.sent).toBe(0);
    expect(await failure(own)).toEqual({ state: "FAILED", error: expect.stringMatching(/delegation grant does not cover .*gmail\.compose for sequoia@westpeek\.ventures/) });
    expect(calls).toContain("https://oauth2.googleapis.com/token");
    expect(calls.filter((c) => c.includes("api.resend.com"))).toEqual([]);
  });

  it("the blind copy of her brand email is recognised; her ordinary mail and a brand's reply are not", async () => {
    expect(await isOwnBrandMailCopy(env, { from: `Sequoia Taylor <${SEQUOIA}>`, to: "Pat Example <PAT@osmo.example>" })).toBe("tld_osmo");
    expect(await isOwnBrandMailCopy(env, { from: SEQUOIA, to: "os@joinwestpeek.com" })).toBeNull();
    expect(await isOwnBrandMailCopy(env, { from: "Pat <pat@osmo.example>", to: SEQUOIA })).toBeNull();
    expect(await isOwnBrandMailCopy(env, { from: "scooter@westpeek.ventures", to: "pat@osmo.example" })).toBeNull();
  });
});
