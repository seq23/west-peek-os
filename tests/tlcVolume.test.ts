import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { contentHashes, fileDraft, openBrandBatchCard, recordBrandMail, runDrip, runDripPass } from "../src/worker/services/learningClub";
import { clubProgress, promoteProspects } from "../src/worker/services/tlcVolume";
import { sendDraftNotice } from "../src/worker/services/tlcDraftNotice";
import { decideApproval } from "../src/worker/services/approvals";
import { actorForFirmUser } from "../src/worker/services/authorize";
import { TLC_NEW_BRANDS_PER_EVENT_WEEK, orderProspects, progressLine, weekStartUtc } from "../src/shared/tlc/volume";
import { warmupDailyCap } from "../src/shared/tlc/learningClub";

/**
 * MORE SPONSOR VOLUME (owner, 26 Oct 2026): Parker's list, Wynn's ten a week nearest club first, stop at $25,000,
 * NeverBounce before any first email, never a follow-up to a bounce — and every earlier rule kept (one brand per
 * category per club, a featured partner's competitors, the warm-up daily cap). Fake brands and addresses only.
 */
let t: TestDb;
let env: Env;
const SEQUOIA = "sequoia@westpeek.ventures";
const SERVICE_ACCOUNT = JSON.stringify({ client_email: "sa@firm.iam.example", private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) });
const MONDAY = new Date("2026-11-09T14:00:00.000Z");
const sends: Array<{ to: string; subject: string; text: string }> = [];
/** NeverBounce's answer per address (default valid); "down" makes it fail to answer. */
const nb = new Map<string, string>();
const asked: string[] = [];

beforeAll(() => {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://api.neverbounce.com/v4.2/single/check?")) {
      const email = new URL(u).searchParams.get("email")!;
      asked.push(email);
      const r = nb.get(email) ?? "valid";
      if (r === "down") return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({ status: "success", result: r }), { status: 200 });
    }
    if (u === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 });
    if (u === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
      const raw = Buffer.from((JSON.parse(String(init?.body)) as { raw: string }).raw, "base64url").toString();
      const [head, ...rest] = raw.split("\r\n\r\n");
      sends.push({ to: /^To: (.*)$/m.exec(head!)?.[1] ?? "", subject: /^Subject: (.*)$/m.exec(head!)?.[1] ?? "", text: rest.join("\n") });
      return new Response(JSON.stringify({ id: `gm_${sends.length}` }), { status: 200 });
    }
    if (u.includes("api.resend.com")) {
      const b = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text?: string };
      sends.push({ to: Array.isArray(b.to) ? b.to.join(",") : b.to, subject: b.subject, text: b.text ?? "" });
      return new Response(JSON.stringify({ id: `re_${sends.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
});
afterAll(() => vi.unstubAllGlobals());

beforeEach(async () => {
  t = await createTestDb();
  env = { ...makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>), RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures", WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT, WP_OS_NEVERBOUNCE_API_KEY: "nb_test" } as Env;
  await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES ('fu_sequoia_taylor', ?1, 'Sequoia Taylor', 'ACTIVE')").bind(SEQUOIA).run();
  const cats = JSON.stringify([{ category: "Wearable", excluded_brands: ["Rival Ring"] }]);
  for (const [m, d, topic] of [["2027-01", "2027-01-21", "The Longevity Reset"], ["2027-02", "2027-02-11", "Fragrance Lab"], ["2027-03", "2027-03-18", "Build Your Own AI Agent"]] as const) {
    await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, angle, status, sponsor_categories_json, pitch_token) VALUES (?1, ?2, ?3, 'EVENING', ?4, 'A hands-on evening.', 'TOPIC_READY', ?5, ?6)")
      .bind(`tlc_${m}`, m, d, topic, m === "2027-01" ? cats : "[]", m.replace("-", "").padEnd(32, "c")).run();
  }
  nb.clear();
  asked.length = 0;
  sends.length = 0;
});
afterEach(async () => { await disposeTestDb(t); });

const slug = (s: string) => s.toLowerCase().replace(/\W/g, "");
async function prospect(month: string, brand: string, o: { band?: "TITLE" | "PARTNER"; category?: string | null; rank?: number; email?: string } = {}): Promise<void> {
  await env.WP_OS_DB.prepare("INSERT INTO tlc_prospect (id, event_id, brand, band, category, contact_name, contact_email, contact_source_url, why_fit, rank) VALUES (?1, ?2, ?3, ?4, ?5, 'Pat Example', ?6, 'https://example.test/team', 'a good fit', ?7)")
    .bind(`tp_${slug(month + brand)}`, `tlc_${month}`, brand, o.band ?? "PARTNER", o.category === undefined ? `Cat ${brand}` : o.category, o.email ?? `pat@${slug(brand)}.example`, o.rank ?? 100).run();
}
async function deal(month: string, brand: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = `tld_${slug(month + brand)}`;
  const row: Record<string, unknown> = { id, event_id: `tlc_${month}`, brand, category: `Cat ${brand}`, contact_name: "Pat Example", contact_email: `pat@${slug(brand)}.example`, contact_source_url: "https://example.test/team", why_fit: "fit", next_send_at: MONDAY.toISOString(), firm_scope: "west-peek", created_at: "2026-10-01T00:00:00.000Z", ...extra };
  const keys = Object.keys(row);
  await env.WP_OS_DB.prepare(`INSERT INTO tlc_deal (${keys.join(", ")}) VALUES (${keys.map((_, i) => `?${i + 1}`).join(", ")})`).bind(...keys.map((k) => row[k])).run();
  return id;
}
async function openGate(): Promise<void> {
  const h = await contentHashes(env);
  await env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value) VALUES ('pitch_approved_hash', ?1), ('playbook_approved_hash', ?2), ('brand_send', 'on') ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(h.pitch, h.playbook).run();
  await env.WP_OS_DB.prepare("INSERT INTO outside_email_allow (item_type, item_id, allowed, changed_by) VALUES ('JOB','tlc_brand_sales',1,'test')").run();
}
const brandsOf = async (month: string) => ((await env.WP_OS_DB.prepare("SELECT brand FROM tlc_deal WHERE event_id = ?1 ORDER BY brand").bind(`tlc_${month}`).all<{ brand: string }>()).results ?? []).map((r) => r.brand);
const approveAll = async () => {
  const cards = (await env.WP_OS_DB.prepare("SELECT approval_card_id AS id FROM tlc_drip_message WHERE state = 'AWAITING_APPROVAL'").all<{ id: string }>()).results ?? [];
  const her = (await actorForFirmUser(env, "fu_sequoia_taylor"))!;
  for (const c of cards) await decideApproval(env, her, c.id, "approved", "test");
};

describe("the rules, as pure functions", () => {
  it("Title candidates first, then Parker's rank; the week starts Monday 00:00 UTC; ten a week", () => {
    const order = orderProspects([
      { id: "a", brand: "Zeta", band: "PARTNER" as const, category: null, rank: 1 },
      { id: "b", brand: "Alpha", band: "TITLE" as const, category: null, rank: 9 },
      { id: "c", brand: "Beta", band: "PARTNER" as const, category: null, rank: 0 },
    ]);
    expect(order.map((p) => p.id)).toEqual(["b", "c", "a"]);
    expect(weekStartUtc(new Date("2026-11-12T23:00:00.000Z"))).toBe("2026-11-09T00:00:00.000Z");
    expect(weekStartUtc(new Date("2026-11-09T00:00:00.000Z"))).toBe("2026-11-09T00:00:00.000Z");
    expect(TLC_NEW_BRANDS_PER_EVENT_WEEK).toBe(10);
    expect(progressLine({ club: "January 2027", topic: "The Longevity Reset", committedUsd: 15_000, goalUsd: 25_000, pitched: 12, replied: 3, yes: 1, ready: 20, stopped: false }))
      .toBe("January 2027 (The Longevity Reset): $15,000 agreed of $25,000. 12 pitched, 3 replied, 1 said yes. 20 more brands ready to pitch.");
  });

  it("the daily send cap is the warm-up cap, unchanged: 5 a day in week one, then 10, 20, 30", () => {
    const first = "2026-11-02T15:00:00.000Z";
    expect(warmupDailyCap(null, MONDAY)).toBe(5);
    expect(warmupDailyCap(first, new Date("2026-11-08T15:00:00.000Z"))).toBe(5);
    expect(warmupDailyCap(first, new Date("2026-11-10T15:00:00.000Z"))).toBe(10);
    expect(warmupDailyCap(first, new Date("2026-11-17T15:00:00.000Z"))).toBe(20);
    expect(warmupDailyCap(first, new Date("2027-01-17T15:00:00.000Z"))).toBe(30);
  });
});

describe("Wynn's ten a week, nearest club first", () => {
  it("about 10 new brands per club per week, Title candidates first, nearest club first; the rest wait for next week", async () => {
    // Listed in the far club first, so the order below is the code's, not the insert's.
    for (let i = 1; i <= 3; i++) await prospect("2027-03", `March ${i}`);
    for (let i = 1; i <= 12; i++) await prospect("2027-02", `Feb ${String(i).padStart(2, "0")}`, { rank: i });
    for (let i = 1; i <= 10; i++) await prospect("2027-01", `Jan ${String(i).padStart(2, "0")}`, { rank: i });
    await prospect("2027-01", "Jan Title A", { band: "TITLE", rank: 50 });
    await prospect("2027-01", "Jan Title B", { band: "TITLE", rank: 60 });
    // A brand Wynn's own search found this week counts toward the club's ten.
    await deal("2027-02", "Feb Own Pick", { created_at: "2026-11-09T09:00:00.000Z" });

    const first = await promoteProspects(env, MONDAY);
    const jan = first.promoted.filter((p) => p.includes("January"));
    const feb = first.promoted.filter((p) => p.includes("February"));
    expect(jan).toHaveLength(10);
    expect(feb).toHaveLength(9);
    expect(first.promoted.filter((p) => p.includes("March"))).toHaveLength(3);
    // Nearest club first, and within it the Title candidates first.
    expect(first.promoted.slice(0, 2)).toEqual(["Jan Title A (January 2027)", "Jan Title B (January 2027)"]);
    expect(first.promoted.findIndex((p) => p.includes("February"))).toBeGreaterThan(first.promoted.map((p) => p.includes("January")).lastIndexOf(true));
    expect(first.promoted.findIndex((p) => p.includes("March"))).toBeGreaterThan(first.promoted.map((p) => p.includes("February")).lastIndexOf(true));
    expect(await brandsOf("2027-01")).not.toContain("Jan 10");
    expect(await brandsOf("2027-01")).not.toContain("Jan 09");

    // The same week: nothing more, however many passes run.
    expect((await promoteProspects(env, new Date("2026-11-12T10:00:00.000Z"))).promoted).toEqual([]);
    // The next week: the rest of the list.
    const next = await promoteProspects(env, new Date("2026-11-16T10:00:00.000Z"));
    expect(next.promoted.sort()).toEqual(["Feb 10 (February 2027)", "Feb 11 (February 2027)", "Feb 12 (February 2027)", "Jan 09 (January 2027)", "Jan 10 (January 2027)"].sort());
    // Every promoted brand went in through the one insert, at drip step 0, and the list remembers it.
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_prospect WHERE promoted_at IS NOT NULL AND deal_id IS NOT NULL").first<{ n: number }>())!.n).toBe(27);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_deal WHERE stage = 'PROSPECT' AND drip_step = 0").first<{ n: number }>())!.n).toBe(28);
  });

  it("the half-hour pass moves the week's brands into the drip and drafts them, nothing sent while the gate is shut", async () => {
    for (let i = 1; i <= 3; i++) await prospect("2027-01", `Jan ${i}`);
    const out = await runDripPass(env, MONDAY);
    expect(out.prospects.promoted).toHaveLength(3);
    expect(out.drip.gate.open).toBe(false);
    expect(out.drip.held).toBe(3);
    expect(sends).toEqual([]);
  });
});

describe("every earlier rule holds for the listed brands", () => {
  it("one brand per category per club at a time; a featured partner's competitor is never approached; her own contacts are hers", async () => {
    await deal("2027-01", "Live Lab", { category: "Lab testing", stage: "PITCHED", drip_step: 1, first_sent_at: "2026-11-05T14:00:00.000Z", last_sent_at: "2026-11-05T14:00:00.000Z", next_send_at: "2026-11-09T14:00:00.000Z" });
    await prospect("2027-01", "Other Lab", { category: "Lab testing", rank: 1 });
    await prospect("2027-01", "Ring A", { category: "Wearable", rank: 2 });
    await prospect("2027-01", "Ring B", { category: "Wearable", rank: 3 });
    await prospect("2027-01", "Rival Ring Co", { category: "Smart ring", rank: 4 });
    await prospect("2027-01", "Hers Co", { category: "Recovery", rank: 5 });
    await env.WP_OS_DB.prepare("INSERT INTO tlc_must_pitch (id, brand, month, reason, added_by, added_at, owner_contacted_at, firm_scope) VALUES ('tmp_hers', 'Hers Co', '2027-01', 'she knows them', 'Sequoia', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 'west-peek')").run();

    const out = await promoteProspects(env, MONDAY);
    expect(out.promoted).toEqual(["Ring A (January 2027)"]);
    expect(out.dropped.sort()).toEqual(["Hers Co (January 2027): Sequoia contacted them directly", "Rival Ring Co (January 2027): competes with a featured partner"]);
    // Ring B waits behind Ring A; Other Lab waits behind the live lab brand. Neither is dropped.
    const ready = ((await env.WP_OS_DB.prepare("SELECT brand FROM tlc_prospect WHERE promoted_at IS NULL AND dropped_reason IS NULL ORDER BY brand").all<{ brand: string }>()).results ?? []).map((r) => r.brand);
    expect(ready).toEqual(["Other Lab", "Ring B"]);
    // Next week, Ring A is still queued and unsent: Ring B still waits. The lab brand declined: Other Lab goes.
    await env.WP_OS_DB.prepare("UPDATE tlc_deal SET stage = 'DECLINED', stop_reason = 'DECLINED' WHERE brand = 'Live Lab'").run();
    expect((await promoteProspects(env, new Date("2026-11-16T10:00:00.000Z"))).promoted).toEqual(["Other Lab (January 2027)"]);
  });

  it("the drip still holds the second first pitch in a category, whatever put it there", async () => {
    await openGate();
    await deal("2027-01", "Ring One", { category: "Wearable", created_at: "2026-11-09T10:00:00.000Z" });
    await deal("2027-01", "Ring Two", { category: "Wearable", created_at: "2026-11-09T11:00:00.000Z" });
    const out = await runDrip(env, MONDAY);
    expect(out.awaitingApproval).toBe(1);
    expect(out.heldForCategory).toEqual(["Ring Two (after Ring One)"]);
  });
});

describe("NeverBounce before any first email", () => {
  it("only a valid address is ever listed for a pitch; invalid, unknown and catch-all are dropped; no answer waits; one check per address", async () => {
    nb.set("bad@bad.example", "invalid");
    nb.set("who@unknown.example", "unknown");
    nb.set("any@catchall.example", "catchall");
    nb.set("later@down.example", "down");
    await prospect("2027-01", "Good Co", { rank: 1 });
    await prospect("2027-01", "Bad Co", { email: "bad@bad.example", rank: 2 });
    await prospect("2027-01", "Unknown Co", { email: "who@unknown.example", rank: 3 });
    await prospect("2027-01", "Catchall Co", { email: "any@catchall.example", rank: 4 });
    await prospect("2027-01", "Later Co", { email: "later@down.example", rank: 5 });
    const out = await promoteProspects(env, MONDAY);
    expect(out.promoted).toEqual(["Good Co (January 2027)"]);
    expect(out.dropped.sort()).toEqual([
      "Bad Co (January 2027): the address did not pass NeverBounce (invalid)",
      "Catchall Co (January 2027): the address did not pass NeverBounce (catchall)",
      "Unknown Co (January 2027): the address did not pass NeverBounce (unknown)",
    ]);
    expect(out.waiting).toEqual(["Later Co (January 2027): NeverBounce answered 503"]);
    expect(await brandsOf("2027-01")).toEqual(["Good Co"]);
    // NeverBounce answers again: the waiting brand goes; the stored answers are not asked twice.
    nb.set("later@down.example", "valid");
    asked.length = 0;
    expect((await promoteProspects(env, MONDAY)).promoted).toEqual(["Later Co (January 2027)"]);
    expect(asked).toEqual(["later@down.example"]);
  });

  it("a brand queued any other way is checked before its first draft: a bad address is stopped, never drafted, never sent", async () => {
    await openGate();
    nb.set("pat@badaddress.example", "invalid");
    await deal("2027-01", "Bad Address");
    await deal("2027-01", "Fine Address");
    const out = await runDrip(env, MONDAY);
    expect(out.awaitingApproval).toBe(1);
    expect(out.addressRefused).toEqual(["Bad Address"]);
    expect(await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_drip_message WHERE deal_id = 'tld_202701badaddress'").first()).toBeNull();
    expect((await env.WP_OS_DB.prepare("SELECT stage, next_send_at FROM tlc_deal WHERE id = 'tld_202701badaddress'").first())).toEqual({ stage: "STOPPED", next_send_at: null });
  });

  it("without the NeverBounce key nothing is drafted to an unchecked address; it waits and says so", async () => {
    await openGate();
    const noKey = { ...env, WP_OS_NEVERBOUNCE_API_KEY: undefined } as Env;
    await deal("2027-01", "Unchecked");
    const out = await runDrip(noKey, MONDAY);
    expect(out.awaitingApproval).toBe(0);
    expect(out.addressWaiting).toBe(1);
    expect(asked).toEqual([]);
    expect((await env.WP_OS_DB.prepare("SELECT stage FROM tlc_deal WHERE brand = 'Unchecked'").first())).toEqual({ stage: "PROSPECT" });
  });

  it("an approved first email whose address fails at send time is held, never sent", async () => {
    await openGate();
    await deal("2027-01", "Turned Bad");
    await runDrip(env, MONDAY);
    await approveAll();
    await env.WP_OS_DB.prepare("UPDATE tlc_address_check SET result = 'invalid' WHERE email = 'pat@turnedbad.example'").run();
    const out = await runDrip(env, new Date("2026-11-09T15:00:00.000Z"));
    expect(out.sent).toBe(0);
    expect(sends).toEqual([]);
    expect((await env.WP_OS_DB.prepare("SELECT state, held_reason FROM tlc_drip_message WHERE deal_id = 'tld_202701turnedbad'").first())).toEqual({ state: "HELD", held_reason: "the address did not pass NeverBounce (invalid), so it is never written to" });
  });
});

describe("never a follow-up to a bounce", () => {
  it("a bounce stops the follow-up, and the address is never written to again for any club", async () => {
    await openGate();
    const id = await deal("2027-01", "Bouncy", { stage: "PITCHED", drip_step: 1, first_sent_at: "2026-11-05T14:00:00.000Z", last_sent_at: "2026-11-05T14:00:00.000Z", next_send_at: "2026-11-09T14:00:00.000Z" });
    await env.WP_OS_DB.prepare("INSERT INTO tlc_address_check (email, result, source, checked_at) VALUES ('pat@bouncy.example', 'valid', 'neverbounce', '2026-11-01T00:00:00Z')").run();
    // The follow-up was already drafted and approved when the bounce came back.
    await fileDraft(env, { id, brand: "Bouncy", contact_email: "pat@bouncy.example", drip_step: 1 }, { subject: "The Learning Club", text: "A follow-up." });
    await approveAll();
    await recordBrandMail(env, { from: "pat@bouncy.example", subject: "Undeliverable: The Learning Club", now: MONDAY });
    const out = await runDrip(env, new Date("2026-11-09T15:00:00.000Z"));
    expect(out.sent).toBe(0);
    expect(sends).toEqual([]);
    expect((await env.WP_OS_DB.prepare("SELECT result FROM tlc_address_check WHERE email = 'pat@bouncy.example'").first())).toEqual({ result: "bounced" });
    // The same inbox, listed for another club, is never pitched.
    await prospect("2027-03", "Bouncy", { email: "pat@bouncy.example" });
    const later = await promoteProspects(env, new Date("2026-11-16T10:00:00.000Z"));
    expect(later.promoted).toEqual([]);
    expect(later.dropped).toEqual(["Bouncy (March 2027): the address did not pass NeverBounce (bounced)"]);
    // And a deal for it that slipped in some other way is never drafted.
    await deal("2027-02", "Bouncy Again", { contact_email: "pat@bouncy.example" });
    const drip = await runDrip(env, new Date("2026-11-16T10:00:00.000Z"));
    expect(drip.addressRefused).toEqual(["Bouncy Again"]);
  });
});

describe("the daily send cap, spent nearest club first", () => {
  it("five a day in the first week: the nearest club's approved emails go first, the rest wait for tomorrow's room", async () => {
    await openGate();
    // February's drafts are filed (and approved) first; January's come a pass later. The nearer club still goes first.
    for (let i = 1; i <= 4; i++) await deal("2027-02", `Feb Send ${i}`, { created_at: `2026-11-09T0${i}:00:00.000Z` });
    expect((await runDrip(env, MONDAY)).awaitingApproval).toBe(4);
    await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET created_at = '2020-01-01T00:00:00.000Z'").run();
    for (let i = 1; i <= 4; i++) await deal("2027-01", `Jan Send ${i}`, { created_at: `2026-11-09T1${i}:00:00.000Z` });
    expect((await runDrip(env, MONDAY)).awaitingApproval).toBe(4);
    await approveAll();
    const today = await runDrip(env, new Date("2026-11-09T15:00:00.000Z"));
    expect(today.sent).toBe(5);
    expect(today.waitingForAllowance).toBe(3);
    expect(today.sentBrands.slice(0, 4).sort()).toEqual(["Jan Send 1", "Jan Send 2", "Jan Send 3", "Jan Send 4"]);
    expect(sends).toHaveLength(5);
    // Later the same day: the cap is spent.
    expect((await runDrip(env, new Date("2026-11-09T20:00:00.000Z"))).sent).toBe(0);
    // The next day has room again.
    expect((await runDrip(env, new Date("2026-11-10T15:00:00.000Z"))).sent).toBe(3);
  });
});

describe("stop at $25,000", () => {
  const agree = async (month: string, brand: string, usd: number, tier: string) =>
    deal(month, brand, { stage: "AGREED", tier, cash_offer_usd: usd, first_sent_at: "2026-11-01T14:00:00.000Z", next_send_at: null });

  it("a club whose agreed sponsor cash reaches $25,000 gets no new brand, no first pitch and no follow-up; the others go on", async () => {
    await openGate();
    await agree("2027-01", "Big One", 15_000, "PRESENTING");
    await agree("2027-01", "Big Two", 10_000, "LEAD");
    for (let i = 1; i <= 3; i++) await prospect("2027-01", `Jan More ${i}`);
    await prospect("2027-02", "Feb More");
    await deal("2027-01", "Jan Queued");
    await deal("2027-01", "Jan Pitched", { stage: "PITCHED", drip_step: 1, first_sent_at: "2026-11-05T14:00:00.000Z", last_sent_at: "2026-11-05T14:00:00.000Z" });

    const promoted = await promoteProspects(env, MONDAY);
    expect(promoted.stopped).toEqual(["January 2027"]);
    expect(promoted.promoted).toEqual(["Feb More (February 2027)"]);
    const out = await runDrip(env, MONDAY);
    expect(out.goalStopped).toEqual(["January 2027"]);
    expect(out.newDrafts.map((d) => d.brand)).toEqual(["Feb More"]);
    expect(await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_drip_message m JOIN tlc_deal d ON d.id = m.deal_id WHERE d.event_id = 'tlc_2027-01'").first()).toBeNull();
    // Wynn's own weekly search skips the club too.
    expect((await clubProgress(env, "west-peek", MONDAY))[0]).toBe("January 2027 (The Longevity Reset): $25,000 agreed of $25,000. 3 pitched, 0 replied, 2 said yes. Goal reached, so new pitches for this club have stopped.");
  });

  it("an email already approved for a club that then reaches its goal is held, not sent; a product partner never counts toward the goal", async () => {
    await openGate();
    await deal("2027-01", "Was Approved");
    await runDrip(env, MONDAY);
    await approveAll();
    await agree("2027-01", "Product Co", 0, "PRODUCT");
    await env.WP_OS_DB.prepare("UPDATE tlc_deal SET in_kind_value_usd = 30000 WHERE brand = 'Product Co'").run();
    await agree("2027-01", "Title Co", 25_000, "TITLE");
    const out = await runDrip(env, new Date("2026-11-09T15:00:00.000Z"));
    expect(out.sent).toBe(0);
    expect((await env.WP_OS_DB.prepare("SELECT state, held_reason FROM tlc_drip_message WHERE deal_id = 'tld_202701wasapproved'").first())).toEqual({ state: "HELD", held_reason: "the club reached its sponsor goal, so its outreach stopped" });
    // Without the Title partner, the product partner's $30,000 of product does not stop anything.
    await env.WP_OS_DB.prepare("UPDATE tlc_deal SET stage = 'DECLINED' WHERE brand = 'Title Co'").run();
    await prospect("2027-01", "Still Going");
    expect((await promoteProspects(env, MONDAY)).promoted).toEqual(["Still Going (January 2027)"]);
  });
});

describe("the one weekly email says where each club stands", () => {
  it("$ agreed against $25,000, pitched / replied / yes, per club, in the same single weekly email", async () => {
    await openGate();
    await deal("2027-01", "Agreed Co", { stage: "AGREED", tier: "PARTNER", cash_offer_usd: 5_000, first_sent_at: "2026-11-01T14:00:00.000Z", replied_at: "2026-11-02T14:00:00.000Z", next_send_at: null });
    await deal("2027-01", "Replied Co", { stage: "PITCHED", first_sent_at: "2026-11-01T14:00:00.000Z", stop_reason: "REPLIED", replied_at: "2026-11-03T14:00:00.000Z", next_send_at: null });
    await deal("2027-01", "Quiet Co", { stage: "PITCHED", drip_step: 2, first_sent_at: "2026-11-01T14:00:00.000Z", next_send_at: null });
    await prospect("2027-01", "Ready One");
    await prospect("2027-01", "Ready Two");
    const card = await openBrandBatchCard(env, MONDAY);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(card.cardId).run();
    const detail = await sendDraftNotice(env, MONDAY);
    expect(detail).toMatch(/^this week's email TLC-/);
    const notices = sends.filter((s) => s.to.includes(SEQUOIA));
    expect(notices).toHaveLength(1);
    const lines = await clubProgress(env, "west-peek", MONDAY);
    expect(lines).toEqual([
      "January 2027 (The Longevity Reset): $5,000 agreed of $25,000. 3 pitched, 2 replied, 1 said yes. 2 more brands ready to pitch.",
      "February 2027 (Fragrance Lab): $0 agreed of $25,000. 0 pitched, 0 replied, 0 said yes. 0 more brands ready to pitch.",
      "March 2027 (Build Your Own AI Agent): $0 agreed of $25,000. 0 pitched, 0 replied, 0 said yes. 0 more brands ready to pitch.",
    ]);
    // The lines are in the one email she gets, under their own heading, above the drafts.
    expect(notices[0]!.text).toContain("Where each club stands");
    for (const l of lines) expect(notices[0]!.text.replace(/=\r?\n/g, "").replace(/\*\*/g, "").replace(/\s+/g, " ")).toContain(l);
  });
});
