import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { applyGoNoGo, armOwnerFollowUps, contentHashes, openBrandBatchCard, runDrip, type TlcEventRow } from "../src/worker/services/learningClub";
import { sendDraftNotice, unlistedDrafts } from "../src/worker/services/tlcDraftNotice";
import { wayInCandidates, wayInFallback } from "../src/worker/services/tlcMustPitch";
import { brandStageWords, buildRoundup, sendWeeklyRoundup } from "../src/worker/services/tlcRoundup";
import { goNoGoDate } from "../src/shared/tlc/goNoGo";
import { stageAfterReply } from "../src/shared/tlc/brandReply";
import { TLC_RECIPIENTS } from "../src/shared/tlc/learningClub";

/**
 * TLC PIPELINE REPAIRS (31 Oct 2026). Fake brands and addresses only.
 *   A · a draft filed after the week's email was in no email at all (28 first emails + 6 follow-ups, 26–30 Oct);
 *   B · a brand she emailed herself never got its follow-up;
 *   C · her must-pitch brands sat at "needs a way in" waiting on her;
 *   D · a brand that asked for the teaser PDF is never "said yes" and never committed;
 *   E · Wynn's Monday roundup, to her only;
 *   F · the go/no-go date: seven weeks out, no sponsor in writing → the club is dropped.
 */
let t: TestDb;
let env: Env;
const sends: Array<{ to: string; subject: string; text: string }> = [];
const SEQUOIA = "sequoia@westpeek.ventures";
const SERVICE_ACCOUNT = JSON.stringify({ client_email: "sa@firm.iam.example", private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) });
const MONDAY = new Date("2026-11-09T14:00:00.000Z");
const flat = (s: string) => s.replace(/=\r?\n/g, "").replace(/=E2=80=99/g, "'").replace(/\*\*/g, "").replace(/\s+/g, " ");

async function deal(brand: string, month: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = `tld_${brand.replace(/\W/g, "")}`;
  await env.WP_OS_DB.prepare("INSERT INTO tlc_deal (id, event_id, brand, contact_name, contact_email, contact_source_url, why_fit, next_send_at, firm_scope) VALUES (?1, ?2, ?3, 'Pat Example', ?4, 'https://example.test/team', 'they host tastings', ?5, 'west-peek')")
    .bind(id, `tlc_${month}`, brand, `pat@${brand.toLowerCase().replace(/\W/g, "")}.example`, MONDAY.toISOString()).run();
  for (const [k, v] of Object.entries(extra)) await env.WP_OS_DB.prepare(`UPDATE tlc_deal SET ${k} = ?2 WHERE id = ?1`).bind(id, v as string | number | null).run();
  return id;
}

beforeAll(async () => {
  t = await createTestDb();
  env = { ...makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>), RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures", WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT, WP_OS_NEVERBOUNCE_API_KEY: "nb_test" } as Env;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://api.neverbounce.com/")) return new Response(JSON.stringify({ status: "success", result: "valid" }), { status: 200 });
    if (u.includes("api.resend.com")) {
      const b = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
      sends.push({ to: Array.isArray(b.to) ? b.to.join(",") : b.to, subject: b.subject, text: b.text });
      return new Response(JSON.stringify({ id: `re_${sends.length}` }), { status: 200 });
    }
    if (u === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 });
    if (u === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
      const raw = Buffer.from((JSON.parse(String(init?.body)) as { raw: string }).raw, "base64url").toString();
      const [head, ...body] = raw.split("\r\n\r\n");
      const h = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(head!)?.[1] ?? "";
      sends.push({ to: h("To"), subject: h("Subject"), text: body.join("\r\n\r\n") });
      return new Response(JSON.stringify({ id: `gm_${sends.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES ('fu_sequoia_taylor', ?1, 'Sequoia Taylor', 'ACTIVE')").bind(SEQUOIA).run();
  for (const [m, d, topic] of [["2027-01", "2027-01-23", "The Longevity Reset"], ["2027-02", "2027-02-11", "Fragrance Lab"], ["2027-03", "2027-03-18", "Build Your Own AI Agent"]] as const) {
    await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, angle, status, sponsor_categories_json, pitch_token, switch_deadline, go_no_go_date) VALUES (?1, ?2, ?3, 'EVENING', ?4, 'A hands-on evening.', 'TOPIC_READY', '[]', ?5, '2026-11-15', ?6)")
      .bind(`tlc_${m}`, m, d, topic, m.replace("-", "").padEnd(32, "c"), goNoGoDate(d)).run();
  }
  const h = await contentHashes(env);
  await env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value) VALUES ('pitch_approved_hash', ?1), ('playbook_approved_hash', ?2), ('brand_send', 'on') ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(h.pitch, h.playbook).run();
  await env.WP_OS_DB.prepare("INSERT INTO outside_email_allow (item_type, item_id, allowed, changed_by) VALUES ('JOB','tlc_brand_sales',1,'test')").run();
});
afterEach(() => { sends.length = 0; });
afterAll(async () => { vi.unstubAllGlobals(); await disposeTestDb(t); });

describe("F · the go/no-go date is seven weeks out, on a working day, stored on the club", () => {
  it("Sat 23 Jan 2027 → Fri 4 Dec 2026; weekday events keep their own weekday", () => {
    expect(goNoGoDate("2027-01-23")).toBe("2026-12-04");
    expect(goNoGoDate("2027-01-24")).toBe("2026-12-04");
    expect(goNoGoDate("2027-03-18")).toBe("2027-01-28");
    // The holiday week moves to the Friday before 24 Dec: Feb club Thu 11 Feb 2027 → Fri 18 Dec 2026 (not Thu 24 Dec).
    expect(goNoGoDate("2027-02-11")).toBe("2026-12-18");
    expect(goNoGoDate("2027-02-19")).toBe("2026-12-18"); // would be Fri 1 Jan
    expect(goNoGoDate("2027-02-10")).toBe("2026-12-23"); // Wed 23 Dec is outside the window, kept
  });
});

describe("A · no waiting draft is left out of her email", () => {
  it("drafts filed after the week's email go to her in ONE catch-up email with every waiting draft, once", async () => {
    await deal("Early Co", "2027-01");
    const card = await openBrandBatchCard(env, MONDAY);
    await runDrip(env, MONDAY);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(card.cardId).run();
    expect(await sendDraftNotice(env, MONDAY)).toMatch(/^this week's email TLC-\w{6} listing 1 draft/);
    // Later that day Parker's list adds two more; they are drafted, and were in no email (the 26 Oct defect).
    const later = new Date(MONDAY.getTime() + 5 * 3_600_000);
    await deal("Late One", "2027-02");
    await deal("Late Two", "2027-03");
    await env.WP_OS_DB.prepare("UPDATE tlc_deal SET next_send_at = ?1 WHERE brand LIKE 'Late%'").bind(later.toISOString()).run();
    await runDrip(env, later);
    await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET created_at = ?1 WHERE deal_id IN ('tld_LateOne','tld_LateTwo')").bind(later.toISOString()).run();
    expect((await unlistedDrafts(env, "west-peek")).map((d) => d.brand).sort()).toEqual(["Late One", "Late Two"]);
    sends.length = 0;
    // Not before they have waited a day.
    expect(await sendDraftNotice(env, new Date(later.getTime() + 3_600_000))).toBe("this week's email already went");
    const nextDay = new Date(later.getTime() + 25 * 3_600_000);
    expect(await sendDraftNotice(env, nextDay)).toMatch(/^catch-up email TLC-\w{6} listing 3 draft\(s\) \(2 were in no email\) sent to sequoia@westpeek\.ventures$/);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toBe(SEQUOIA);
    const text = flat(sends[0]!.text);
    for (const b of ["Early Co", "Late One", "Late Two"]) expect(text).toContain(b);
    expect(await unlistedDrafts(env, "west-peek")).toEqual([]);
    // One list, not a ping per draft: the same day sends nothing more.
    expect(await sendDraftNotice(env, new Date(nextDay.getTime() + 3_600_000))).toBe("this week's email already went");
    expect(sends).toHaveLength(1);
  });
});

describe("B · a brand she emailed herself gets its follow-up, for her approval", () => {
  it("drip_step 1 with no date and no draft is armed and drafted; her own first email is never re-sent by Wynn", async () => {
    await env.WP_OS_DB.prepare("INSERT INTO tlc_must_pitch (id, month, brand, reason, added_by, added_at, owner_contacted_at) VALUES ('tmp_voice', '2027-02', 'Voice Co', 'AI partner', 'Sequoia', '2026-11-01T00:00:00.000Z', '2026-11-01T22:00:00.000Z')").run();
    await deal("Voice Co", "2027-02", { stage: "PITCHED", drip_step: 1, first_sent_at: "2026-11-01T21:34:13.000Z", next_send_at: null, contact_source_url: "owner-contacted" });
    expect(await armOwnerFollowUps(env, MONDAY)).toEqual(["Voice Co"]);
    const out = await runDrip(env, MONDAY);
    expect(out.newDrafts.filter((d) => d.brand === "Voice Co").map((d) => d.step)).toEqual([1]);
    // Armed once: a draft exists now, so nothing re-arms it (a skip would leave it HELD, still never re-armed).
    expect(await armOwnerFollowUps(env, MONDAY)).toEqual([]);
  });
});

describe("C · a must-pitch brand never waits on her for an address", () => {
  it("tries Wynn's found address, then the brand's own role inboxes; the first NeverBounce-valid one queues it", async () => {
    expect(wayInCandidates({ brand: "Harlem Perfume Co.", why: "no address on a page", pages_checked_json: JSON.stringify(["https://www.harlemperfumeco.com/pages/contact", "https://www.linkedin.com/company/x"]), found_email: null }).slice(0, 2))
      .toEqual(["partnerships@harlemperfumeco.com", "partners@harlemperfumeco.com"]);
    // Dedcool is on her seeded list for February.
    await env.WP_OS_DB.prepare("INSERT INTO tlc_way_in (brand_key, brand, firm_scope, state, months_json, pages_checked_json, why, opened_at, checked_at, changed_at, found_email) VALUES ('dedcool', 'Dedcool', 'west-peek', 'OPEN', '[\"2027-02\"]', '[\"https://dedcool.example/pages/contact\"]', 'collabs@dedcool.example is not on https://dedcool.example/pages/contact', ?1, ?1, ?1, 'collabs@dedcool.example')").bind(MONDAY.toISOString()).run();
    const asked: string[] = [];
    const out = await wayInFallback(env, MONDAY, "west-peek", async (e) => { asked.push(e); return e === "partnerships@dedcool.example" ? "valid" : "refused"; });
    expect(asked.slice(0, 2)).toEqual(["collabs@dedcool.example", "partnerships@dedcool.example"]);
    expect(out.queued.some((q) => q.startsWith("Dedcool"))).toBe(true);
    const d = await env.WP_OS_DB.prepare("SELECT contact_email, contact_source_url, stage FROM tlc_deal WHERE brand = 'Dedcool' AND event_id = 'tlc_2027-02'").first<{ contact_email: string; contact_source_url: string; stage: string }>();
    expect(d).toEqual({ contact_email: "partnerships@dedcool.example", contact_source_url: "neverbounce-valid:partnerships@dedcool.example", stage: "PROSPECT" });
    expect((await env.WP_OS_DB.prepare("SELECT state FROM tlc_way_in WHERE brand_key = 'dedcool'").first<{ state: string }>())?.state).toBe("FOUND");
  });

  it("none valid: the item stays open and is not re-checked (or re-charged) until next week", async () => {
    await env.WP_OS_DB.prepare("INSERT INTO tlc_way_in (brand_key, brand, firm_scope, state, months_json, pages_checked_json, why, opened_at, checked_at, changed_at) VALUES ('phlur', 'Phlur', 'west-peek', 'OPEN', '[\"2027-02\"]', '[]', 'no address on a page', ?1, ?1, ?1)").bind(MONDAY.toISOString()).run();
    let n = 0;
    await wayInFallback(env, MONDAY, "west-peek", async () => { n += 1; return "refused"; });
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(6);
    const again = n;
    await wayInFallback(env, new Date(MONDAY.getTime() + 86_400_000), "west-peek", async () => { n += 1; return "refused"; });
    expect(n).toBe(again);
    expect((await env.WP_OS_DB.prepare("SELECT state FROM tlc_way_in WHERE brand_key = 'phlur'").first<{ state: string }>())?.state).toBe("OPEN");
  });
});

describe("D · a brand that asked for the teaser has not said yes to the event", () => {
  it("its yes stays before a call, is never committed, and is said as exactly what it was", async () => {
    // A "yes, send the PDF" never moves the deal on its own (owner, 26 and 31 Oct 2026).
    expect(stageAfterReply("YES", "PITCHED")).toBeNull();
    await deal("Vector Co", "2027-03", { stage: "PITCHED", drip_step: 1, first_sent_at: "2026-11-02T00:14:05.000Z", stop_reason: "REPLIED", replied_at: "2026-11-02T04:42:00.000Z", yes_at: "2026-11-05T05:03:00.000Z", next_send_at: null });
    await env.WP_OS_DB.prepare("INSERT INTO tlc_samples (id, deal_id, input_json, state, sent_at) VALUES ('tls_vector', 'tld_VectorCo', '{}', 'SENT', '2026-11-06T15:00:00.000Z')").run();
    expect(brandStageWords({ stage: "PITCHED", first_sent_at: "x", stop_reason: "REPLIED", yes_at: "y", samples_sent_at: "2026-10-30T15:00:00.000Z", pending_step: null })).toBe("asked for the teaser, PDF sent 30 Oct");
    const r = await buildRoundup(env, MONDAY);
    const march = r.sections.find((s) => s.label.startsWith("March 2027"))!;
    expect(march.bullets).toContain("Vector Co: asked for the teaser, PDF sent 6 Nov");
    expect(march.bullets).toContain("Committed: $0 cash and $0 in kind, of the $25,000 goal.");
    expect(JSON.stringify(r)).not.toMatch(/said yes/i);
  });
});

describe("E · Wynn's Monday roundup", () => {
  it("Monday morning only, once a week, to her alone; per club dates, pace, money, and what waits on her", async () => {
    expect(TLC_RECIPIENTS.map((x) => x.toLowerCase())).toEqual([SEQUOIA]);
    expect(await sendWeeklyRoundup(env, new Date("2026-11-08T15:00:00.000Z"))).toBe("not Monday morning yet");
    expect(await sendWeeklyRoundup(env, new Date("2026-11-09T09:00:00.000Z"))).toBe("not Monday morning yet");
    expect(await sendWeeklyRoundup(env, MONDAY)).toMatch(/^roundup \d{4}-W\d{2} sent to sequoia@westpeek\.ventures$/);
    expect(sends.map((s) => s.to)).toEqual([SEQUOIA]);
    const text = flat(sends[0]!.text);
    expect(text).toContain("Waiting on you");
    expect(text).toMatch(/brand emails are waiting for your approval/);
    expect(text).toContain("January 2027: The Longevity Reset");
    expect(text).toContain("Go/no-go Fri 4 Dec 2026");
    expect(text).toContain("Topic switch by Sun 15 Nov 2026");
    expect(text).toMatch(/Emailed \d+ of about 35 brands; the pace of 5 a week/);
    expect(text).toContain("Vector Co: asked for the teaser, PDF sent 6 Nov");
    expect(text).not.toMatch(/scooter/i);
    expect(await sendWeeklyRoundup(env, new Date(MONDAY.getTime() + 3_600_000))).toMatch(/already went/);
    expect(sends).toHaveLength(1);
  });
});

describe("F · the go/no-go rule", () => {
  const club = async (id: string) => (await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(id).first<TlcEventRow>())!;
  it("before the date nothing moves; on it, a club with only a teaser request is dropped (status, not deleted), its drafts held, its topic back on the ideas list", async () => {
    expect(await applyGoNoGo(env, await club("tlc_2027-03"), new Date("2027-01-27T12:00:00.000Z"))).toBe(false);
    expect(await applyGoNoGo(env, await club("tlc_2027-03"), new Date("2027-01-28T12:00:00.000Z"))).toBe(true);
    const ev = await club("tlc_2027-03");
    expect(ev.status).toBe("CANCELLED");
    expect(ev.dropped_reason).toMatch(/No sponsor had committed in writing/);
    expect(await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_drip_message m JOIN tlc_deal d ON d.id = m.deal_id WHERE d.event_id = 'tlc_2027-03' AND m.state = 'AWAITING_APPROVAL'").first()).toBeNull();
    expect((await env.WP_OS_DB.prepare("SELECT status FROM tlc_idea WHERE topic_key = lower('Build Your Own AI Agent') OR topic = 'Build Your Own AI Agent'").first<{ status: string }>())?.status).toBe("LATER");
    // Once dropped, never again.
    expect(await applyGoNoGo(env, ev, new Date("2027-01-29T12:00:00.000Z"))).toBe(false);
    // Wynn says so in the roundup.
    const r = await buildRoundup(env, new Date("2027-02-01T14:00:00.000Z"));
    expect(JSON.stringify(r.sections)).toMatch(/March 2027 was dropped on Thu 28 Jan 2027/);
  });

  it("a sponsor committed in writing keeps the club", async () => {
    await deal("Signed Co", "2027-01", { stage: "AGREED", tier: "PARTNER", cash_offer_usd: 5000, first_sent_at: "2026-11-01T00:00:00.000Z", next_send_at: null });
    expect(await applyGoNoGo(env, await club("tlc_2027-01"), new Date("2026-12-04T12:00:00.000Z"))).toBe(false);
    expect((await club("tlc_2027-01")).status).toBe("TOPIC_READY");
  });
});
