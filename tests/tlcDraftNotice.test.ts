import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { contentHashes, openBrandBatchCard, runDrip } from "../src/worker/services/learningClub";
import { applyTlcDraftReply, sendDraftNotice } from "../src/worker/services/tlcDraftNotice";
import { parseDraftReply } from "../src/shared/tlc/draftReply";
import { TRUSTED_AUTHSERV_ID } from "../src/shared/intake/partnerAuthority";

/**
 * ONE NOTICE FOR A BATCH OF DRAFTS, APPROVED BY REPLY (owner, 24 Oct 2026). Fake brands and addresses only.
 */
let t: TestDb;
let env: Env;
const sends: Array<{ to: string; subject: string; text: string }> = [];

const SEQUOIA = "sequoia@westpeek.ventures";
const genuineFrom = (address: string): string =>
  `${TRUSTED_AUTHSERV_ID}; dkim=pass header.d=westpeek-ventures.20251104.gappssmtp.com header.s=20251104; ` +
  `dmarc=none header.from=${address.split("@")[1]} policy.dmarc=none; ` +
  `spf=pass (${TRUSTED_AUTHSERV_ID}: domain of ${address} designates 2607:f8b0:4864:20::f2e as permitted sender) smtp.mailfrom=${address}; arc=none`;
const SCOOTER = "scooter@westpeek.ventures";
const MORNING = new Date("2026-11-09T14:00:00.000Z");

const reply = (subject: string, body: string, from = SEQUOIA, auth = genuineFrom(from)) =>
  applyTlcDraftReply(env, { fromHeader: `Partner <${from}>`, authenticationResults: auth, subject, body }, { now: MORNING, redraft: async (_e, _a, i) => ({ ok: true, subject: `${i.subject} (v2)`, body: `Shorter, per "${i.note}".`, detail: "ok" }) });

const cardState = async (brand: string) =>
  (await env.WP_OS_DB.prepare("SELECT a.state FROM tlc_drip_message m JOIN tlc_deal d ON d.id = m.deal_id JOIN approval_card a ON a.id = m.approval_card_id WHERE d.brand = ?1 ORDER BY m.created_at DESC LIMIT 1").bind(brand).first<{ state: string }>())?.state;

async function deal(brand: string, month: string): Promise<void> {
  await env.WP_OS_DB.prepare("INSERT INTO tlc_deal (id, event_id, brand, contact_name, contact_email, contact_source_url, why_fit, next_send_at, firm_scope) VALUES (?1, ?2, ?3, 'Pat Example', ?4, 'https://example.test/team', 'they host tastings', ?5, 'west-peek')")
    .bind(`tld_${brand.replace(/\W/g, "")}`, `tlc_${month}`, brand, `pat@${brand.toLowerCase().replace(/\W/g, "")}.example`, MORNING.toISOString()).run();
}

beforeAll(async () => {
  t = await createTestDb();
  env = { ...makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>), RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Env;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const b = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
      sends.push({ to: Array.isArray(b.to) ? b.to.join(",") : b.to, subject: b.subject, text: b.text });
      return new Response(JSON.stringify({ id: `re_${sends.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES ('fu_sequoia_taylor', ?1, 'Sequoia Taylor', 'ACTIVE')").bind(SEQUOIA).run();
  for (const [m, d, topic] of [["2027-01", "2027-01-21", "The Longevity Reset"], ["2027-02", "2027-02-11", "Fragrance Lab"]] as const) {
    await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, angle, status, sponsor_categories_json, pitch_token) VALUES (?1, ?2, ?3, 'EVENING', ?4, 'A hands-on evening.', 'TOPIC_READY', '[]', ?5)")
      .bind(`tlc_${m}`, m, d, topic, m.replace("-", "").padEnd(32, "b")).run();
  }
  // The gate open, exactly as it is live: approved pitch and playbook by hash, the switch on, the job allowed.
  const h = await contentHashes(env);
  await env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value) VALUES ('pitch_approved_hash', ?1), ('playbook_approved_hash', ?2), ('brand_send', 'on') ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(h.pitch, h.playbook).run();
  await env.WP_OS_DB.prepare("INSERT INTO outside_email_allow (item_type, item_id, allowed, changed_by) VALUES ('JOB','tlc_brand_sales',1,'test')").run();
  for (const [b, m] of [["Leaf Co", "2027-01"], ["Root Co", "2027-01"], ["Scent Co", "2027-02"]] as const) await deal(b, m);
});
afterEach(() => { sends.length = 0; });
afterAll(async () => { vi.unstubAllGlobals(); await disposeTestDb(t); });

describe("her reply is read the way she writes it", () => {
  it("approve all / approve 1, 3 / skip 2 / change 2: …", () => {
    expect(parseDraftReply("approve all")).toMatchObject({ approveAll: true });
    expect(parseDraftReply("Approved!")).toMatchObject({ approveAll: true });
    expect(parseDraftReply("approve 1, 3")).toMatchObject({ approveAll: false, approve: [1, 3] });
    expect(parseDraftReply("approve 1 and 3; skip 2")).toMatchObject({ approve: [1, 3], skip: [2] });
    expect(parseDraftReply("change 2: shorter, mention the AI segment")).toMatchObject({ change: [{ n: 2, note: "shorter, mention the AI segment" }] });
    expect(parseDraftReply("what is Osmo?")).toMatchObject({ approveAll: false, approve: [], skip: [], change: [] });
  });
});

describe("one notice for the batch, full copy, approved by reply", () => {
  let ref = "";
  it("drafts every due email together (the warm-up cap is on sends) and sends ONE notice with the full text of each", async () => {
    const drip = await runDrip(env, MORNING);
    expect(drip.awaitingApproval).toBe(3);
    // No per-draft email from the drip itself.
    expect(sends).toHaveLength(0);
    const said = await sendDraftNotice(env, MORNING);
    expect(said).toMatch(/^notice TLC-[A-Z0-9]{6} listing 3 draft\(s\) sent to sequoia@westpeek\.ventures$/);
    expect(sends).toHaveLength(1);
    const n = sends[0]!;
    expect(n.to).toBe(SEQUOIA);
    ref = /TLC-[A-Z0-9]{6}/.exec(n.subject)![0];
    // Numbered, grouped by club in month order, each with the contact, why, subject and the whole body.
    expect(n.text).toMatch(/\*\*1\*\* · Leaf Co — Pat Example <pat@leafco\.example>/);
    expect(n.text).toMatch(/\*\*2\*\* · Root Co/);
    expect(n.text).toMatch(/\*\*3\*\* · Scent Co/);
    expect(n.text.indexOf("January 2027")).toBeLessThan(n.text.indexOf("February 2027"));
    expect(n.text).toContain("Why this brand: they host tastings");
    expect(n.text).toContain("Subject: Leaf Co + a small room in New York");
    expect(n.text).toContain("Sequoia Taylor\nWest Peek Ventures\nsequoia@westpeek.ventures");
    expect(n.text).toMatch(/approve all/);
    // Never a second notice the same day for the same drafts.
    expect(await sendDraftNotice(env, new Date("2026-11-09T15:00:00.000Z"))).toMatch(/no new drafts/);
  });

  it("refuses a reply that is not from her authenticated address, and decides nothing", async () => {
    expect((await reply(`Re: Wynn: TLC: 3 brand emails to approve · ${ref}`, "approve all", SCOOTER)).handled).toBe(false);
    expect((await reply(`Re: ${ref}`, "approve all", SEQUOIA, `${TRUSTED_AUTHSERV_ID}; spf=fail; dkim=fail; dmarc=fail`)).handled).toBe(false);
    expect(await cardState("Leaf Co")).toBe("pending_review");
  });

  it("approve 1, skip 2, change 3: approves, sends inside the allowance, holds the skip, redrafts for a fresh approval, and confirms to her", async () => {
    const out = await reply(`Re: Wynn: TLC: 3 brand emails to approve · ${ref}`, "approve 1\nskip 2\nchange 3: shorter\n\nOn Mon, 9 Nov 2026 Wynn wrote:\n> approve all");
    expect(out).toMatchObject({ handled: true, ref });
    // Approved by her, then spent by the send.
    expect(await cardState("Leaf Co")).toBe("executed");
    // Sent now, to the brand, as the approved draft.
    expect(sends.some((s) => s.to === "pat@leafco.example" && s.subject === "Leaf Co + a small room in New York")).toBe(true);
    expect((await env.WP_OS_DB.prepare("SELECT state FROM tlc_drip_message WHERE deal_id = 'tld_LeafCo'").first<{ state: string }>())!.state).toBe("SENT");
    // Skipped: never sent, the sequence stops.
    expect(sends.some((s) => s.to === "pat@rootco.example")).toBe(false);
    expect((await env.WP_OS_DB.prepare("SELECT state, held_reason FROM tlc_drip_message WHERE deal_id = 'tld_RootCo'").first<{ state: string; held_reason: string }>())).toMatchObject({ state: "HELD", held_reason: `skipped by Sequoia (${ref})` });
    // Changed: the old card is rejected, a redraft waits for her, and a new notice carries it at once.
    expect((await env.WP_OS_DB.prepare("SELECT m.subject, m.redraft_note, a.state FROM tlc_drip_message m JOIN approval_card a ON a.id = m.approval_card_id WHERE m.deal_id = 'tld_ScentCo'").first())).toMatchObject({ subject: "Scent Co + a small room in New York (v2)", redraft_note: "shorter", state: "pending_review" });
    const confirm = sends.find((s) => s.to === SEQUOIA && /your reply to/.test(s.subject))!;
    expect(confirm.text).toMatch(/\*\*1\*\* · Leaf Co \(January 2027\)/);
    expect(confirm.text).toMatch(/Skipped/);
    const renotice = sends.find((s) => s.to === SEQUOIA && /1 brand email to approve · TLC-/.test(s.subject))!;
    expect(renotice.text).toContain("Redrafted for your note: shorter");
    expect(sends.every((s) => s.to !== SCOOTER)).toBe(true);
  });

  it("a reply decides only the drafts listed in ITS notice", async () => {
    await deal("Late Co", "2027-01");
    await runDrip(env, MORNING);
    // The old notice's "approve all" reaches nothing new: Late Co is not in it.
    await reply(`Re: ${ref}`, "approve all");
    expect(await cardState("Late Co")).toBe("pending_review");
  });

  it("waits for the week's batch to finish, so the batch arrives in one email — unless a draft has waited a day", async () => {
    const tue = new Date("2026-11-10T09:00:00.000Z");
    expect((await openBrandBatchCard(env, tue)).opened).toBe(true);
    await deal("Batch Co", "2027-02");
    await env.WP_OS_DB.prepare("UPDATE tlc_deal SET next_send_at = ?2 WHERE brand = ?1").bind("Batch Co", tue.toISOString()).run();
    await runDrip(env, tue);
    // The database stamps drafts with its own clock; put the unlisted ones on this test's Tuesday.
    await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET created_at = ?1 WHERE notice_ref IS NULL").bind(tue.toISOString()).run();
    expect(await sendDraftNotice(env, new Date("2026-11-10T20:00:00.000Z"))).toMatch(/wait for the week's batch to finish/);
    expect(sends).toHaveLength(0);
    // A day on, the batch still open: the notice goes anyway, never a draft left waiting.
    expect(await sendDraftNotice(env, new Date("2026-11-11T19:30:00.000Z"))).toMatch(/^notice TLC-/);
  });
});
