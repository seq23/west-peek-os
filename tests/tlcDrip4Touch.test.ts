import { DRIP_DEPS } from "./helpers/tlcSamplesPdf";
import { DRIP_STEP_2_POLICY, DRIP_STEP_2_RULE } from "../src/shared/tlc/dripPolicy";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { DRIP_TIMED_FOR_SETTING, contentHashes, recordBrandMail, retimeDrip, runDrip } from "../src/worker/services/learningClub";
import { SPAM_PAUSE_SETTING, TLC_DRIP_DAYS } from "../src/shared/tlc/learningClub";

/**
 * THE FOUR-EMAIL DRIP (owner, 6 Nov 2026; risk brain R-EML-04). Fake brands and addresses only.
 *   · the first email and up to three follow-ups, at day 0/3/7/14 from the first send, then never again;
 *   · emails 2 to 4 go by policy, email 1 only on her approval;
 *   · deals mid-sequence are re-timed once from first_sent_at; a deal past day 14 gets nothing more;
 *   · any reply stops that brand; a spam complaint pauses ALL brand sending and tells her (named stop).
 */
let t: TestDb;
let env: Env;
const sends: Array<{ to: string; subject: string; text: string }> = [];
const SEQUOIA = "sequoia@westpeek.ventures";
const SERVICE_ACCOUNT = JSON.stringify({ client_email: "sa@firm.iam.example", private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) });
const FIRST = "2026-11-10T15:00:00.000Z";
const day = (n: number, plusMinutes = 1) => new Date(Date.parse(FIRST) + n * 86_400_000 + plusMinutes * 60_000);
const to = (brand: string) => sends.filter((s) => s.to.includes(`${brand}.example`));
const owner = () => sends.filter((s) => s.to === SEQUOIA);

async function pitched(brand: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = `tld_${brand}`;
  await env.WP_OS_DB.prepare("INSERT INTO tlc_deal (id, event_id, brand, contact_name, contact_email, contact_source_url, why_fit, stage, drip_step, first_sent_at, last_sent_at, next_send_at, firm_scope) VALUES (?1, 'tlc_2027-03', ?2, 'Pat Example', ?3, 'https://example.test/team', 'they make memory', 'PITCHED', 1, ?4, ?4, ?5, 'west-peek')")
    .bind(id, brand, `pat@${brand.toLowerCase()}.example`, FIRST, day(3, 0).toISOString()).run();
  // Email 1 went (with her approval), so a step-0 message exists, SENT; its Gmail thread lets the follow-ups thread.
  await env.WP_OS_DB.prepare("INSERT INTO tlc_drip_message (id, deal_id, step, subject, body, state, sent_at) VALUES (?1, ?2, 0, ?3, 'x', 'SENT', ?4)").bind(`tdm_${brand}_0`, id, `${brand} + a small room in New York`, FIRST).run();
  for (const [k, v] of Object.entries(extra)) await env.WP_OS_DB.prepare(`UPDATE tlc_deal SET ${k} = ?2 WHERE id = ?1`).bind(id, v as string | number | null).run();
  return id;
}
const dealRow = (id: string) => env.WP_OS_DB.prepare("SELECT drip_step, next_send_at, stop_reason, stage FROM tlc_deal WHERE id = ?1").bind(id).first<{ drip_step: number; next_send_at: string | null; stop_reason: string | null; stage: string }>();

beforeAll(async () => {
  t = await createTestDb();
  env = { ...makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled", WP_OS_DOCUMENTS: t.docs } as Partial<Env>), RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures", WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT, WP_OS_NEVERBOUNCE_API_KEY: "nb_test" } as Env;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://api.neverbounce.com/")) return new Response(JSON.stringify({ status: "success", result: "valid" }), { status: 200 });
    if (u.includes("api.resend.com")) {
      const b = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
      sends.push({ to: Array.isArray(b.to) ? b.to.join(",") : b.to, subject: b.subject, text: b.text });
      return new Response(JSON.stringify({ id: `re_${sends.length}` }), { status: 200 });
    }
    if (u === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 });
    if (u.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")) {
      const raw = Buffer.from((JSON.parse(String(init?.body)) as { raw: string }).raw, "base64url").toString();
      const [head, ...body] = raw.split("\r\n\r\n");
      const h = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(head!)?.[1] ?? "";
      sends.push({ to: h("To"), subject: h("Subject"), text: body.join("\r\n\r\n") });
      return new Response(JSON.stringify({ id: `gm_${sends.length}`, threadId: "th_1" }), { status: 200 });
    }
    if (u.startsWith("https://gmail.googleapis.com/")) return new Response(JSON.stringify({ id: "gm_x", threadId: "th_1", payload: { headers: [{ name: "Message-ID", value: "<m@x>" }] } }), { status: 200 });
    return new Response("{}", { status: 200 });
  });
  await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES ('fu_sequoia_taylor', ?1, 'Sequoia Taylor', 'ACTIVE')").bind(SEQUOIA).run();
  await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, angle, status, sponsor_categories_json, pitch_token, switch_deadline, go_no_go_date) VALUES ('tlc_2027-03', '2027-03', '2027-03-18', 'EVENING', 'Build Your Own AI Agent', 'A hands-on evening.', 'TOPIC_READY', '[]', ?1, '2027-01-15', '2027-01-28')")
    .bind("202703".padEnd(32, "c")).run();
  const h = await contentHashes(env);
  await env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value) VALUES ('pitch_approved_hash', ?1), ('playbook_approved_hash', ?2), ('brand_send', 'on') ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(h.pitch, h.playbook).run();
  await env.WP_OS_DB.prepare("INSERT INTO outside_email_allow (item_type, item_id, allowed, changed_by) VALUES ('JOB','tlc_brand_sales',1,'test')").run();
});
afterEach(() => { sends.length = 0; });
afterAll(async () => { vi.unstubAllGlobals(); await disposeTestDb(t); });

describe("the four emails, day 0/3/7/14, then never again", () => {
  it("emails 2, 3 and 4 each go on their own on their day, decided by the policy; nothing goes after email 4", async () => {
    const id = await pitched("Fourco");
    expect(TLC_DRIP_DAYS).toEqual([0, 3, 7, 14]);
    for (const [n, step] of [[3, 1], [7, 2], [14, 3]] as const) {
      // Not before its day.
      await runDrip(env, day(n, -60), "west-peek", DRIP_DEPS);
      expect(to("fourco"), `nothing before day ${n}`).toHaveLength(0);
      const queued = await runDrip(env, day(n), "west-peek", DRIP_DEPS);
      expect(queued.newDrafts, `day ${n}: never a draft for her`).toEqual([]);
      expect(queued.followUpsQueued, `day ${n}`).toBe(1);
      const card = await env.WP_OS_DB.prepare("SELECT a.decided_by, a.decision_note FROM tlc_drip_message m JOIN approval_card a ON a.id = m.approval_card_id WHERE m.deal_id = ?1 AND m.step = ?2").bind(id, step).first();
      expect(card).toEqual({ decided_by: DRIP_STEP_2_POLICY, decision_note: DRIP_STEP_2_RULE });
      await runDrip(env, day(n, 2), "west-peek", DRIP_DEPS);
      expect(to("fourco"), `email ${step + 1} went on day ${n}`).toHaveLength(1);
      sends.length = 0;
      expect((await dealRow(id))!.drip_step).toBe(step + 1);
    }
    expect(await dealRow(id)).toMatchObject({ drip_step: 4, next_send_at: null });
    for (const n of [15, 21, 60]) await runDrip(env, day(n), "west-peek", DRIP_DEPS);
    expect(to("fourco"), "never a fifth email").toHaveLength(0);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_drip_message WHERE deal_id = ?1").bind(id).first<{ n: number }>())!.n).toBe(4);
  });

  it("a reply stops that brand's sequence at once: no email 3 or 4", async () => {
    const id = await pitched("Replyco", { drip_step: 2, last_sent_at: day(3, 2).toISOString(), next_send_at: day(7, 0).toISOString() });
    expect(await recordBrandMail(env, { from: "Pat <pat@replyco.example>", subject: "Re: Replyco + a small room in New York", now: day(5) })).toMatchObject({ matched: 1, stop: "REPLIED" });
    for (const n of [7, 14]) { await runDrip(env, day(n), "west-peek", DRIP_DEPS); await runDrip(env, day(n, 5), "west-peek", DRIP_DEPS); }
    expect(to("replyco")).toHaveLength(0);
    expect(await dealRow(id)).toMatchObject({ stop_reason: "REPLIED", next_send_at: null });
  });

  it("an approved follow-up that could not go by day 14 (+1 grace day) never goes", async () => {
    const id = await pitched("Lateco", { drip_step: 3, last_sent_at: day(7, 2).toISOString(), next_send_at: day(14, 0).toISOString() });
    await env.WP_OS_DB.prepare("UPDATE tlc_setting SET value = 'off' WHERE key = 'brand_send'").run();
    await runDrip(env, day(14), "west-peek", DRIP_DEPS); // held: the switch is off
    await env.WP_OS_DB.prepare("UPDATE tlc_setting SET value = 'on' WHERE key = 'brand_send'").run();
    const out = await runDrip(env, day(15, 2), "west-peek", DRIP_DEPS);
    expect(out.sequenceEnded).toContain("Lateco");
    await runDrip(env, day(15, 5), "west-peek", DRIP_DEPS);
    expect(to("lateco")).toHaveLength(0);
    expect((await dealRow(id))!.next_send_at).toBeNull();
  });
});

describe("deals mid-sequence are re-timed once, from first_sent_at", () => {
  it("day 12 → day 3; a finished two-email sequence gets email 3; past day 14 gets nothing; once only", async () => {
    const now = new Date("2026-11-06T18:00:00.000Z");
    const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
    // Email 1 eleven days ago, email 2 still waiting for its old day 12 (tomorrow): it is due now (day 3 has passed).
    const late = await pitched("Oldtwelve", { first_sent_at: ago(11), last_sent_at: ago(11), next_send_at: "2026-11-07T15:00:00.000Z" });
    // Both old emails went; email 3 is armed at day 7, but never within two days of email 2.
    const two = await pitched("Twosent", { drip_step: 2, first_sent_at: ago(10), last_sent_at: ago(1), next_send_at: null });
    // First email sixteen days ago: past day 14 (+1), nothing more.
    const past = await pitched("Pastco", { first_sent_at: ago(16), last_sent_at: ago(16), next_send_at: "2026-11-07T00:00:00.000Z" });
    await env.WP_OS_DB.prepare("DELETE FROM tlc_setting WHERE key = ?1").bind(DRIP_TIMED_FOR_SETTING).run();
    const moved = await retimeDrip(env, now);
    expect(moved.length).toBeGreaterThanOrEqual(3);
    expect((await dealRow(late))!.next_send_at).toBe(new Date(Date.parse(ago(11)) + 3 * 86_400_000).toISOString());
    expect((await dealRow(two))!.next_send_at).toBe(new Date(Date.parse(ago(1)) + 2 * 86_400_000).toISOString());
    expect((await dealRow(past))!.next_send_at).toBeNull();
    // Once per sequence: a second pass changes nothing, even if a date is moved by hand.
    await env.WP_OS_DB.prepare("UPDATE tlc_deal SET next_send_at = '2026-12-01T00:00:00.000Z' WHERE id = ?1").bind(late).run();
    expect(await retimeDrip(env, now)).toEqual([]);
    expect((await dealRow(late))!.next_send_at).toBe("2026-12-01T00:00:00.000Z");
  });
});

describe("a spam complaint pauses ALL brand sending, and she is told", () => {
  it("one complaint: that brand stopped for good, the switch off, every other brand's due email held, one email to her; on again clears it", async () => {
    const bad = await pitched("Spamco");
    const other = await pitched("Calmco");
    expect(await recordBrandMail(env, { from: "Pat <pat@spamco.example>", subject: "Re: this is spam", now: day(2) })).toMatchObject({ matched: 1, stop: "COMPLAINED" });
    expect(await dealRow(bad)).toMatchObject({ stop_reason: "UNSUBSCRIBED", stage: "STOPPED", next_send_at: null });
    const settings = await env.WP_OS_DB.prepare("SELECT key, value FROM tlc_setting WHERE key IN ('brand_send', ?1) ORDER BY key").bind(SPAM_PAUSE_SETTING).all<{ key: string; value: string }>();
    expect(settings.results!.map((r) => r.key)).toEqual(["brand_send", SPAM_PAUSE_SETTING]);
    expect(settings.results!.find((r) => r.key === "brand_send")!.value).toBe("off");
    expect(owner().filter((s) => /Brand emails are paused/.test(s.subject))).toHaveLength(1);
    expect(owner()[0]!.text.replace(/=\r?\n/g, "")).toMatch(/Spamco/);
    sends.length = 0;
    const held = await runDrip(env, day(3), "west-peek", DRIP_DEPS);
    expect(held.gate.open).toBe(false);
    expect(held.gate.reasons.join(" ")).toMatch(/spam complaint/);
    await runDrip(env, day(3, 5), "west-peek", DRIP_DEPS);
    expect(to("calmco"), "no brand gets anything while paused").toHaveLength(0);
    // She turns sending back on: the pause record goes, and the other brand's email goes.
    await env.WP_OS_DB.prepare("UPDATE tlc_setting SET value = 'on' WHERE key = 'brand_send'").run();
    const back = await runDrip(env, day(4), "west-peek", DRIP_DEPS);
    expect(back.spamPauseCleared).toMatch(/cleared/);
    expect(await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_setting WHERE key = ?1").bind(SPAM_PAUSE_SETTING).first()).toBeNull();
    await runDrip(env, day(4, 5), "west-peek", DRIP_DEPS);
    expect(to("calmco")).toHaveLength(1);
    expect(to("spamco")).toHaveLength(0);
    expect((await dealRow(other))!.drip_step).toBe(2);
  });
});
