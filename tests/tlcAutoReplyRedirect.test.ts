import { inboundRead } from "./helpers/aiShapes";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { TlcDealRow } from "../src/worker/services/learningClub";
import { sendReplyApprovals, takeBrandReply, type ReplyDrafter } from "../src/worker/services/tlcBrandReply";
import { closedWithoutReply } from "../src/worker/services/tlcRoundup";
import { queueDeal, OWNER_SUPPLIED_SOURCE } from "../src/worker/services/tlcMustPitch";
import type { Reader } from "../src/worker/services/partnerUnderstood";
import { AUTO_REPLY_RESUME_DAYS, classifyBrandReply } from "../src/shared/tlc/brandReply";

/**
 * AN AUTO-REPLY THAT SAYS "WRITE TO X INSTEAD" IS A REDIRECT, AND A SECOND AUTO-REPLY STOPS THE DRIP (owner, 23 Nov 2026:
 * "i get auto reply from those TLC brand drip campaign emails and the owner doesnt look at the auto reply ... there is one
 * in my inbox that has sent several auto replies to say to direct emails to a another inbox"). The live shapes, with
 * fake brands and example domains only:
 *  - A: "this inbox isn't actively monitored ... reach our customer experience team by emailing care@" (three times,
 *    each filed as an out-of-office, the drip resumed each week);
 *  - B: a generic "we'll get back to you shortly" acknowledgement, three times;
 *  - C: a long leave with no date the word lists can read, naming the colleague who covers brand partnerships.
 */
let t: TestDb;
const sends: Array<{ to: string; subject: string }> = [];
let env: Env;
const NOW = new Date("2026-11-23T15:00:00.000Z");
const drafter: ReplyDrafter = async () => ({ ok: true, body: "Hi,\n\nThank you. Here is what we do.", detail: "ok", changes: [] });
let modelCalls = 0;
const says = (o: Record<string, unknown>): Reader[] => [{ name: "SEAT", read: async () => { modelCalls += 1; return { ok: true, text: inboundRead({ summary: "s", ...o }), detail: "ok", reader: "CLAUDE" }; } }];
const NONE: Reader[] = ["SEAT", "WORKERS_AI", "GEMINI"].map((name) => ({ name, read: async () => ({ ok: false, text: "", detail: "usage limit", out: true }) }));

const SHAPE_A = (domain: string, to = `care@${domain}`) =>
  `Hello,\n\nThank you for your email. Please note that this inbox isn't actively monitored.\n\nYou can reach our customer experience team by emailing ${to}, and they will be happy to help.\n\nWarmly,\nThe Team`;
const SHAPE_B = "Hi there,\n\nThanks so much for reaching out! We have received your message and our team will get back to you shortly.\n\nHave a lovely day.";
const SHAPE_C = (domain: string) =>
  `Hello,\n\nThank you for your email. I am currently on maternity leave until Q2 2027 and will not be checking email.\n\nFor anything brand partnership related please contact maya@${domain}. For press, please contact press@${domain}.\n\nThank you!`;

let n = 0;
async function deal(contact: string, o: { step?: number; event?: string } = {}): Promise<TlcDealRow> {
  const id = `tld_ar_${++n}`;
  const ev = o.event ?? `tlc_ar_ev_${n}`;
  if (!o.event) {
    const month = `${2027 + Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`;
    await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, angle, status, sponsor_categories_json, pitch_token) VALUES (?1, ?3, ?4, 'EVENING', 'A topic', 'An angle.', 'TOPIC_READY', '[]', ?2)").bind(ev, String(n).padStart(32, "b"), month, `${month}-20`).run();
  }
  await env.WP_OS_DB.prepare(
    "INSERT INTO tlc_deal (id, event_id, brand, category, contact_email, contact_source_url, why_fit, stage, drip_step, first_sent_at, last_sent_at, next_send_at, firm_scope) VALUES (?1, ?4, ?2, 'Care', ?3, 'https://example.test', 'a fit', 'PITCHED', ?5, '2026-11-02T15:00:00.000Z', '2026-11-16T15:00:00.000Z', '2026-11-30T15:00:00.000Z', 'west-peek')",
  ).bind(id, `Brand ${n}`, contact, ev, o.step ?? 1).run();
  await env.WP_OS_DB.prepare("INSERT INTO tlc_drip_message (id, deal_id, step, subject, body, state, sent_at) VALUES (?1, ?2, 0, ?3, 'Hi, what we do.', 'SENT', '2026-11-02T15:00:00.000Z')").bind(`tdm_${id}`, id, `Brand ${n} + a small room in New York`).run();
  return (await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(id).first<TlcDealRow>())!;
}
const take = (d: TlcDealRow, m: { from: string; subject?: string; text: string; mid?: string }, read: Reader[]) =>
  takeBrandReply(env, d, { messageId: `<${m.mid ?? `m-${d.id}`}>`, subject: m.subject ?? "Re: Brand + a small room in New York", text: m.text, receivedAt: NOW.toISOString(), from: m.from }, { now: NOW, drafter, mailbox: null, read });
const dealRow = (id: string) => env.WP_OS_DB.prepare("SELECT stage, stop_reason, next_send_at FROM tlc_deal WHERE id = ?1").bind(id).first<{ stage: string; stop_reason: string | null; next_send_at: string | null }>();
const fresh = (id: string) => env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(id).first<TlcDealRow>().then((r) => r!);
const closes = (id: string) => env.WP_OS_DB.prepare("SELECT intent, state, held_reason, kind FROM tlc_brand_reply WHERE deal_id = ?1 ORDER BY rowid").bind(id).all<{ intent: string; state: string; held_reason: string; kind: string | null }>().then((r) => r.results ?? []);
const dealAt = (email: string) => env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE contact_email = ?1").bind(email).first<TlcDealRow>();

beforeAll(async () => {
  t = await createTestDb();
  // Sending is switched ON, so any email any path tried to send (to a brand, a new address or her) is seen here.
  env = { ...makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs, WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>), WP_OS_NEVERBOUNCE_API_KEY: "nb_test", RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@west-peek.test" } as Env;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.hostname === "api.neverbounce.com") {
      const email = u.searchParams.get("email") ?? "";
      if (email.startsWith("down")) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ status: "success", result: email.startsWith("bad") ? "invalid" : "valid" }), { status: 200 });
    }
    if (u.hostname === "api.resend.com" || u.hostname === "gmail.googleapis.com") {
      const b = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string };
      sends.push({ to: [b.to ?? "(raw)"].flat().join(","), subject: b.subject ?? "" });
      return new Response(JSON.stringify({ id: `sent_${sends.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  });
});
afterAll(async () => { vi.unstubAllGlobals(); await disposeTestDb(t); });

describe("the live loop, replayed: an auto-reply that names the address to write to instead", () => {
  it("A, read by a model: the drip moves to that address (email 1 for her approval); the old address stops", async () => {
    const d = await deal("hello@alpha.example");
    const out = await take(d, { from: "Alpha <hello@alpha.example>", text: SHAPE_A("alpha.example") },
      says({ sender_kind: "auto_reply", redirect_to: "care@alpha.example", redirect_kind: "instead", inbox_unread: true }));
    expect(out).toBe("REDIRECTED");
    expect(await dealRow(d.id)).toMatchObject({ stage: "STOPPED", stop_reason: "REPLIED", next_send_at: null });
    const moved = await dealAt("care@alpha.example");
    expect(moved).toMatchObject({ stage: "PROSPECT", drip_step: 0, event_id: d.event_id });
    expect((await closes(d.id))[0]!.held_reason).toMatch(/^redirect: moved to the address they gave \(care@alpha\.example\)/);
  });

  it("A in another club too: the redirect stops every drip to the old address, not only the one it answered", async () => {
    const other = await deal("hello@alpha4.example");
    const d = await deal("hello@alpha4.example");
    expect(await take(d, { from: "hello@alpha4.example", text: SHAPE_A("alpha4.example") },
      says({ sender_kind: "auto_reply", redirect_to: "care@alpha4.example", redirect_kind: "instead", inbox_unread: true }))).toBe("REDIRECTED");
    expect(await dealRow(other.id)).toMatchObject({ stage: "STOPPED", next_send_at: null });
  });

  it("A, when the model says the address is only for orders: the drip to this inbox stops; nothing goes anywhere", async () => {
    const d = await deal("hello@alpha2.example");
    const out = await take(d, { from: "Alpha <hello@alpha2.example>", text: SHAPE_A("alpha2.example") },
      says({ sender_kind: "auto_reply", redirect_to: "care@alpha2.example", redirect_kind: "none", inbox_unread: true }));
    expect(out).toBe("STOPPED");
    expect(await dealRow(d.id)).toMatchObject({ stage: "STOPPED", next_send_at: null });
    expect(await dealAt("care@alpha2.example")).toBeNull();
    expect((await closes(d.id))[0]!.held_reason).toMatch(/^stopped: they said this inbox isn't read; no more emails to hello@alpha2\.example/);
  });

  it("A under an \"Automatic reply\" subject with no model: the word lists follow the address", async () => {
    const d = await deal("hello@alpha3.example");
    expect(await take(d, { from: "hello@alpha3.example", subject: "Automatic reply: Brand + a small room in New York", text: SHAPE_A("alpha3.example") }, NONE)).toBe("REDIRECTED");
    expect(await dealAt("care@alpha3.example")).not.toBeNull();
    expect((await closes(d.id))[0]!.held_reason).toMatch(/INBOUND_NO_MODEL_READER/);
  });

  it("C, a long leave naming who covers it: the drip moves to that colleague, from the model and from the word lists", async () => {
    const d = await deal("lena@gamma.example");
    expect(await take(d, { from: "lena@gamma.example", subject: "Out of office", text: SHAPE_C("gamma.example") },
      says({ sender_kind: "auto_reply", redirect_to: "maya@gamma.example", redirect_kind: "instead" }))).toBe("REDIRECTED");
    expect(await dealAt("maya@gamma.example")).not.toBeNull();
    expect(classifyBrandReply({ subject: "Out of office", text: SHAPE_C("gamma2.example"), brandDomain: "gamma2.example", notThese: ["lena@gamma2.example"] }, NOW))
      .toEqual({ kind: "REDIRECT", to: "maya@gamma2.example", machine: true });
  });

  it("B, the same acknowledgement twice: the first resumes the drip, the second stops it; no third email", async () => {
    const d = await deal("hi@beta.example", { step: 2 });
    const read = says({ sender_kind: "auto_reply" });
    expect(await take(d, { from: "hi@beta.example", text: SHAPE_B, mid: "b-1" }, read)).toBe("AUTO_REPLY");
    expect((await dealRow(d.id))!.next_send_at).not.toBeNull();
    // Her approval batch already holds email 3 when the second one lands.
    await env.WP_OS_DB.prepare("INSERT INTO tlc_drip_message (id, deal_id, step, subject, body, state) VALUES ('tdm_b3', ?1, 2, 'Re: x', 'body', 'AWAITING_APPROVAL')").bind(d.id).run();
    expect(await take(await fresh(d.id), { from: "hi@beta.example", text: SHAPE_B, mid: "b-2" }, read)).toBe("STOPPED");
    expect(await dealRow(d.id)).toMatchObject({ stage: "STOPPED", stop_reason: "REPLIED", next_send_at: null });
    expect(await env.WP_OS_DB.prepare("SELECT state FROM tlc_drip_message WHERE id = 'tdm_b3'").first()).toEqual({ state: "HELD" });
    const rows = await closes(d.id);
    expect(rows.map((r) => r.held_reason.split(" · ")[0])).toEqual([
      expect.stringMatching(/^auto-reply; the drip resumes /),
      "stopped: repeated auto-replies (2 from hi@beta.example); no more emails to it",
    ]);
    // Visible where every close is: her Monday roundup.
    expect((await closedWithoutReply(env, NOW)).some((l) => l.includes("stopped: repeated auto-replies"))).toBe(true);
  });

  it("the second auto-reply counts across clubs: another club's deal to that address stops too, and is never queued again", async () => {
    const a = await deal("press@delta.example");
    const b = await deal("press@delta.example");
    expect(await take(a, { from: "press@delta.example", text: SHAPE_B, mid: "d-1" }, says({ sender_kind: "auto_reply" }))).toBe("AUTO_REPLY");
    expect(await take(b, { from: "press@delta.example", text: SHAPE_B, mid: "d-2" }, says({ sender_kind: "auto_reply" }))).toBe("STOPPED");
    expect(await dealRow(a.id)).toMatchObject({ stage: "STOPPED", next_send_at: null });
    const later = { eventId: "tlc_ar_ev_later", brand: "Delta", category: null, contactName: null, contactEmail: "press@delta.example", contactSourceUrl: "https://example.test/research", whyFit: null, firmScope: "west-peek" };
    await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, angle, status, sponsor_categories_json, pitch_token) VALUES ('tlc_ar_ev_later', '2029-01', '2029-01-20', 'EVENING', 'A topic', 'An angle.', 'TOPIC_READY', '[]', ?1)").bind("c".repeat(32)).run();
    expect(await queueDeal(env, later, NOW)).toBe(false);
    // An address she gives herself is hers to use.
    expect(await queueDeal(env, { ...later, contactSourceUrl: `${OWNER_SUPPLIED_SOURCE}:her` }, NOW)).toBe(true);
  });
});

describe("what is never followed, and what still wins", () => {
  it("an address off their domain is never followed: an unread inbox stops instead", async () => {
    const d = await deal("hello@eps.example");
    expect(await take(d, { from: "hello@eps.example", text: SHAPE_A("eps.example", "team@agency.example") },
      says({ sender_kind: "auto_reply", redirect_to: "team@agency.example", redirect_kind: "instead" }))).toBe("STOPPED");
    expect(await dealAt("team@agency.example")).toBeNull();
    expect((await closes(d.id))[0]!.held_reason).toMatch(/^stopped: the address they gave \(team@agency\.example\) is not one we write to/);
  });

  it("a no-reply address is never followed", async () => {
    const d = await deal("hello@zeta.example");
    expect(await take(d, { from: "hello@zeta.example", text: SHAPE_A("zeta.example", "noreply@zeta.example") },
      says({ sender_kind: "auto_reply", redirect_to: "noreply@zeta.example", redirect_kind: "instead" }))).toBe("STOPPED");
    expect(await dealAt("noreply@zeta.example")).toBeNull();
    expect(classifyBrandReply({ subject: "Automatic reply", text: SHAPE_A("zeta.example", "noreply@zeta.example"), brandDomain: "zeta.example", notThese: ["hello@zeta.example"] }, NOW).kind).toBe("DEAD_INBOX");
  });

  it("the sender's own address is never a redirect to itself: an ordinary auto-reply", async () => {
    const d = await deal("hello@eta.example");
    expect(await take(d, { from: "hello@eta.example", text: "Thanks! We have received your message. Write to us any time at hello@eta.example." },
      says({ sender_kind: "auto_reply", redirect_to: "hello@eta.example", redirect_kind: "instead" }))).toBe("AUTO_REPLY");
    expect(await dealRow(d.id)).toMatchObject({ stage: "PITCHED", stop_reason: null });
  });

  it("a person who asks a question and mentions another address gets her answer drafted, not a redirect", async () => {
    const d = await deal("sam@theta.example");
    const text = "Hi Sequoia,\n\nThis sounds lovely. Which evening is it on? You can also email events@theta.example, who will want to see it.\n\nSam";
    expect(await take(d, { from: "Sam <sam@theta.example>", text },
      says({ sender_kind: "person", asks: ["which evening"], redirect_to: "events@theta.example", redirect_kind: "none", we_owe: "say which evening", nothing_owed: "owed", intent: "question" }))).toBe("DRAFTED");
    expect(await dealAt("events@theta.example")).toBeNull();
  });

  it("an out-of-office with a return date and an address for urgent matters only: the drip resumes after the return date", async () => {
    const d = await deal("jo@iota.example", { step: 1 });
    const text = "I'm out of the office until December 9 with limited access to email. For urgent matters, please contact ops@iota.example.";
    expect(await take(d, { from: "jo@iota.example", subject: "Out of Office", text }, says({ sender_kind: "auto_reply", redirect_to: "ops@iota.example", redirect_kind: "urgent_only" }))).toBe("AUTO_REPLY");
    expect(await dealAt("ops@iota.example")).toBeNull();
    expect((await dealRow(d.id))!.next_send_at).toBe("2026-12-10T14:00:00.000Z");
    // The word lists agree, with no model there: a return date means wait for them.
    expect(classifyBrandReply({ subject: "Out of Office", text, brandDomain: "iota.example", notThese: ["jo@iota.example"] }, NOW)).toEqual({ kind: "AUTO_REPLY", resumeAt: "2026-12-10T14:00:00.000Z" });
    // Away with a return date and someone "in the meantime": they are back soon, so the drip waits for them.
    expect(classifyBrandReply({ subject: "Out of Office", text: "I'm out of the office until December 9. In the meantime, please reach out to sam@iota.example.", brandDomain: "iota.example", notThese: ["jo@iota.example"] }, NOW))
      .toEqual({ kind: "AUTO_REPLY", resumeAt: "2026-12-10T14:00:00.000Z" });
    // No date, urgent-only address: still never a redirect; a week from now.
    expect(classifyBrandReply({ subject: "Out of Office", text: "I am away. For urgent matters please contact ops@iota.example.", brandDomain: "iota.example" }, NOW))
      .toEqual({ kind: "AUTO_REPLY", resumeAt: new Date(NOW.getTime() + AUTO_REPLY_RESUME_DAYS * 86_400_000).toISOString() });
  });

  it("a machine-sent auto-reply known by its headers alone, with the address in the body: a redirect", async () => {
    const d = await deal("info@kappa.example");
    const text = "From: Kappa <info@kappa.example>\r\nAuto-Submitted: auto-replied\r\nSubject: Re: Brand\r\n\r\nThanks for your note. Partnerships are handled by partners@kappa.example, please write to them there.";
    expect(await take(d, { from: "info@kappa.example", text }, says({ sender_kind: "auto_reply", redirect_to: "partners@kappa.example", redirect_kind: "instead" }))).toBe("REDIRECTED");
    expect(await dealAt("partners@kappa.example")).not.toBeNull();
    // With no model, the headers alone mark it machine-sent and the word lists follow the address.
    const d2 = await deal("info@kappa2.example");
    expect(await take(d2, { from: "info@kappa2.example", subject: "Re: Brand", text: text.replaceAll("kappa.example", "kappa2.example") }, NONE)).toBe("REDIRECTED");
    expect(await dealAt("partners@kappa2.example")).not.toBeNull();
  });

  it("a stop wins over everything: an auto-reply that also asks to be removed stops the whole brand", async () => {
    const d = await deal("hello@lambda.example");
    expect(await take(d, { from: "hello@lambda.example", text: `${SHAPE_A("lambda.example")}\n\nPlease remove me from your list.` },
      says({ sender_kind: "auto_reply", redirect_to: "care@lambda.example", redirect_kind: "instead", wants_stop: true }))).toBe("NO");
    expect(await dealRow(d.id)).toMatchObject({ stop_reason: "UNSUBSCRIBED" });
    expect(await dealAt("care@lambda.example")).toBeNull();
  });
});

describe("when a check cannot answer", () => {
  it("NeverBounce down: nothing to the new address, the old one not resumed, read again next pass", async () => {
    const d = await deal("hello@mu.example");
    const read = says({ sender_kind: "auto_reply", redirect_to: "down@mu.example", redirect_kind: "instead", inbox_unread: true });
    const text = SHAPE_A("mu.example", "down@mu.example");
    expect(await take(d, { from: "hello@mu.example", text }, read)).toBe("WAITING");
    expect(await dealRow(d.id)).toMatchObject({ stage: "PITCHED", stop_reason: "REPLIED", next_send_at: null });
    expect(await dealAt("down@mu.example")).toBeNull();
    expect(await closes(d.id)).toEqual([]);
    expect(await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_address_check WHERE email = 'down@mu.example'").first()).toBeNull();
  });

  it("NeverBounce refuses the address an auto-reply gave: the old address stops too, with the named stop", async () => {
    const d = await deal("hello@nu.example");
    expect(await take(d, { from: "hello@nu.example", text: SHAPE_A("nu.example", "bad@nu.example") },
      says({ sender_kind: "auto_reply", redirect_to: "bad@nu.example", redirect_kind: "instead", inbox_unread: true }))).toBe("STOPPED");
    expect(await dealRow(d.id)).toMatchObject({ stage: "STOPPED", next_send_at: null });
    expect(await dealAt("bad@nu.example")).toBeNull();
    expect((await closes(d.id))[0]!.held_reason).toMatch(/^stopped: NAMED STOP \[TLC_REDIRECT_ADDRESS_REFUSED\]/);
  });
});

describe("the rows filed before this fix are repaired by the same handler", () => {
  async function oldRow(dealId: string, mid: string, text: string): Promise<void> {
    await env.WP_OS_DB.prepare(
      "INSERT INTO tlc_brand_reply (id, deal_id, brand_message_id, their_subject, their_text, received_at, intent, draft_subject, draft_body, state, held_reason, firm_scope) VALUES (?1, ?2, ?3, 'Re: x', ?4, '2026-11-09T15:00:00.000Z', 'AUTO_REPLY', '', '', 'CLOSED', 'auto-reply; the drip resumes 2026-11-30T15:00:00.000Z · read by Gemini', 'west-peek')",
    ).bind(`tbr_old_${mid}`, dealId, mid, text).run();
  }
  it("an inbox that auto-replied three times: re-delivered, it is read again once and the drip to it stops", async () => {
    const d = await deal("hi@omicron.example", { step: 3 });
    for (const mid of ["o-1", "o-2", "o-3"]) await oldRow(d.id, mid, SHAPE_B);
    expect(await take(d, { from: "hi@omicron.example", text: SHAPE_B, mid: "o-3" }, says({ sender_kind: "auto_reply" }))).toBe("STOPPED");
    expect(await dealRow(d.id)).toMatchObject({ stage: "STOPPED", next_send_at: null });
    // The other old rows are not read again: the deal is off the drip.
    const before = modelCalls;
    expect(await take(await fresh(d.id), { from: "hi@omicron.example", text: SHAPE_B, mid: "o-1" }, says({ sender_kind: "auto_reply" }))).toBe("SEEN");
    expect(modelCalls).toBe(before);
  });
  it("A filed as an out-of-office: re-delivered, it moves to the address they gave", async () => {
    const d = await deal("hello@pi.example", { step: 3 });
    await oldRow(d.id, "p-1", SHAPE_A("pi.example"));
    expect(await take(d, { from: "hello@pi.example", text: SHAPE_A("pi.example"), mid: "p-1" },
      says({ sender_kind: "auto_reply", redirect_to: "care@pi.example", redirect_kind: "instead", inbox_unread: true }))).toBe("REDIRECTED");
    expect(await dealAt("care@pi.example")).not.toBeNull();
  });
  it("one real out-of-office: read again once, left as it was, never read a third time", async () => {
    const d = await deal("jo@rho.example", { step: 1 });
    await oldRow(d.id, "r-1", "I am out of the office until November 30.");
    const read = says({ sender_kind: "auto_reply" });
    const before = modelCalls;
    expect(await take(d, { from: "jo@rho.example", text: "I am out of the office until November 30.", mid: "r-1" }, read)).toBe("SEEN");
    expect(await take(d, { from: "jo@rho.example", text: "I am out of the office until November 30.", mid: "r-1" }, read)).toBe("SEEN");
    expect(modelCalls).toBe(before + 1);
    expect(await dealRow(d.id)).toMatchObject({ stage: "PITCHED", stop_reason: null, next_send_at: "2026-11-30T15:00:00.000Z" });
    expect((await closes(d.id))[0]!.held_reason).toMatch(/· read again$/);
  });
});

describe("no email to anybody", () => {
  it("nothing above emailed anybody; the next approval round emails her only the drafted answer, never a stop or a move", async () => {
    expect(sends).toEqual([]);
    expect(await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_drip_message WHERE state = 'SENT' AND id NOT LIKE 'tdm_tld_ar_%'").first()).toEqual({ n: 0 });
    // The same switches do send: her approval of the one drafted answer goes, and nothing else.
    await sendReplyApprovals(env, NOW);
    expect(sends.length).toBeGreaterThan(0);
    expect(sends.every((x) => /Brand \d+/.test(x.subject) && !/stopp|redirect|auto-repl/i.test(x.subject))).toBe(true);
    expect(new Set(sends.map((x) => x.subject.match(/Brand \d+/)![0])).size).toBe(1);
  });
});
