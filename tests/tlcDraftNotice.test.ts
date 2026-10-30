import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { contentHashes, openBrandBatchCard, runDrip } from "../src/worker/services/learningClub";
import { applyTlcDraftReply, repairLeakedDrafts, sendDraftNotice } from "../src/worker/services/tlcDraftNotice";
import { parseDraftReply } from "../src/shared/tlc/draftReply";
import { TRUSTED_AUTHSERV_ID } from "../src/shared/intake/partnerAuthority";

/**
 * ONE TLC EMAIL A WEEK, APPROVED BY REPLY (owner, 24 Oct 2026). Fake brands and addresses only.
 */
let t: TestDb;
let env: Env;
const sends: Array<{ to: string; subject: string; text: string; headers: Record<string, string>; via?: "gmail" | "resend"; from?: string; bcc?: string; replyTo?: string; tokenFor?: string }> = [];
/** The firm's service account, as the Worker holds it: a brand email is sent from her own Gmail through it. */
const SERVICE_ACCOUNT = JSON.stringify({ client_email: "sa@firm.iam.example", private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) });
let tokenSubject = "";
/** Every address NeverBounce was asked about (26 Oct 2026: checked before any first email). */
const checked: string[] = [];

const SEQUOIA = "sequoia@westpeek.ventures";
const SCOOTER = "scooter@westpeek.ventures";
const genuineFrom = (address: string): string =>
  `${TRUSTED_AUTHSERV_ID}; dkim=pass header.d=westpeek-ventures.20251104.gappssmtp.com header.s=20251104; ` +
  `dmarc=none header.from=${address.split("@")[1]} policy.dmarc=none; ` +
  `spf=pass (${TRUSTED_AUTHSERV_ID}: domain of ${address} designates 2607:f8b0:4864:20::f2e as permitted sender) smtp.mailfrom=${address}; arc=none`;
const MORNING = new Date("2026-11-09T14:00:00.000Z");
let cardId = "";

const reply = (subject: string, body: string, from = SEQUOIA, auth = genuineFrom(from)) =>
  applyTlcDraftReply(env, { fromHeader: `Partner <${from}>`, authenticationResults: auth, subject, body }, { now: MORNING, redraft: async (_e, _a, i) => ({ ok: true, subject: `${i.subject} (v2)`, body: `Shorter, per "${i.note}".`, detail: "ok" }) });

/*
 * HER REPLY AS IT REALLY ARRIVES (TLC-ZF84KK, 24 Oct 2026): the raw message, header block first ("From: …"),
 * multipart, quoted-printable. Read as plain text, the header's "From:" line looked like a quote marker and her
 * "Approve all" came out empty. The stateful tests below send her reply this way.
 */
const asRawMime = (body: string, from = SEQUOIA): string => [
  `From: Sequoia Taylor <${from}>`,
  "To: os@joinwestpeek.com",
  "Subject: Re: TLC",
  "Mime-Version: 1.0 (1.0)",
  'Content-Type: multipart/alternative; boundary="Apple-Mail-ABC"',
  "",
  "--Apple-Mail-ABC",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  body.replace(/=/g, "=3D").replace(/\n/g, "\r\n"),
  "--Apple-Mail-ABC",
  "Content-Type: text/html; charset=utf-8",
  "",
  `<html><body>${body}</body></html>`,
  "--Apple-Mail-ABC--",
  "",
].join("\r\n");

const cardState = async (brand: string) =>
  (await env.WP_OS_DB.prepare("SELECT a.state FROM tlc_drip_message m JOIN tlc_deal d ON d.id = m.deal_id JOIN approval_card a ON a.id = m.approval_card_id WHERE d.brand = ?1 ORDER BY m.created_at DESC LIMIT 1").bind(brand).first<{ state: string }>())?.state;

async function deal(brand: string, month: string): Promise<void> {
  await env.WP_OS_DB.prepare("INSERT INTO tlc_deal (id, event_id, brand, contact_name, contact_email, contact_source_url, why_fit, next_send_at, firm_scope) VALUES (?1, ?2, ?3, 'Pat Example', ?4, 'https://example.test/team', 'they host tastings', ?5, 'west-peek')")
    .bind(`tld_${brand.replace(/\W/g, "")}`, `tlc_${month}`, brand, `pat@${brand.toLowerCase().replace(/\W/g, "")}.example`, MORNING.toISOString()).run();
}
const record = (month: string, added: string[], dropped: string[] = []) =>
  env.WP_OS_DB.prepare("INSERT INTO event_record (id, event_type, actor_type, actor_id, object_type, object_id, firm_scope, payload_json) VALUES (?1, 'tlc.batch_club_done', 'ai_employee', 'aie_wynn', 'work_card', ?2, 'west-peek', ?3)")
    .bind(`evr_${crypto.randomUUID()}`, cardId, JSON.stringify({ event_id: `tlc_${month}`, month, part: "picks", added, dropped, queued: [], wayIn: [], changed: 0 })).run();

beforeAll(async () => {
  t = await createTestDb();
  env = { ...makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>), RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures", WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT, WP_OS_NEVERBOUNCE_API_KEY: "nb_test" } as Env;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith("https://api.neverbounce.com/v4.2/single/check?")) {
      checked.push(new URL(String(url)).searchParams.get("email")!);
      return new Response(JSON.stringify({ status: "success", result: "valid" }), { status: 200 });
    }
    if (String(url).includes("api.resend.com")) {
      const b = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string; headers?: Record<string, string> };
      sends.push({ to: Array.isArray(b.to) ? b.to.join(",") : b.to, subject: b.subject, text: b.text, headers: b.headers ?? {}, via: "resend" });
      return new Response(JSON.stringify({ id: `re_${sends.length}` }), { status: 200 });
    }
    if (String(url) === "https://oauth2.googleapis.com/token") {
      const assertion = new URLSearchParams(String(init?.body)).get("assertion")!;
      const claims = JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString()) as { sub?: string; scope: string };
      tokenSubject = `${claims.sub ?? ""} ${claims.scope}`;
      return new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 });
    }
    if (String(url) === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
      const raw = Buffer.from((JSON.parse(String(init?.body)) as { raw: string }).raw, "base64url").toString();
      const [head, ...body] = raw.split("\r\n\r\n");
      const h = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(head!)?.[1] ?? "";
      sends.push({ to: h("To"), subject: h("Subject"), text: body.join("\r\n\r\n"), headers: {}, via: "gmail", from: h("From"), bcc: h("Bcc"), replyTo: h("Reply-To"), tokenFor: tokenSubject });
      return new Response(JSON.stringify({ id: `gm_${sends.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES ('fu_sequoia_taylor', ?1, 'Sequoia Taylor', 'ACTIVE')").bind(SEQUOIA).run();
  for (const [m, d, topic] of [["2027-01", "2027-01-21", "The Longevity Reset"], ["2027-02", "2027-02-11", "Fragrance Lab"], ["2027-03", "2027-03-18", "Build Your Own AI Agent"]] as const) {
    await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, angle, status, sponsor_categories_json, pitch_token) VALUES (?1, ?2, ?3, 'EVENING', ?4, 'A hands-on evening.', 'TOPIC_READY', '[]', ?5)")
      .bind(`tlc_${m}`, m, d, topic, m.replace("-", "").padEnd(32, "b")).run();
  }
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

describe("one TLC email a week, every club at once, approved by reply", () => {
  let ref = "";
  let subject = "";
  it("sends nothing while the week's batch is still running — not a partial email, not a per-draft ping", async () => {
    const opened = await openBrandBatchCard(env, MORNING);
    cardId = opened.cardId!;
    const drip = await runDrip(env, MORNING);
    expect(drip.awaitingApproval).toBe(3);
    // Each address was checked with NeverBounce before its first email was drafted, once each.
    expect([...checked].sort()).toEqual(["pat@leafco.example", "pat@rootco.example", "pat@scentco.example"]);
    expect(await sendDraftNotice(env, MORNING)).toBe("waiting for the week's batch to finish");
    // Not even after her morning, and not after a day: the batch decides.
    expect(await sendDraftNotice(env, new Date("2026-11-10T20:00:00.000Z"))).toBe("waiting for the week's batch to finish");
    expect(sends).toHaveLength(0);
  });

  it("once the batch is done: ONE email, all clubs, numbered, full copy, and the short club named in it", async () => {
    await record("2027-01", ["Leaf Co (January 2027)", "Root Co (January 2027)"]);
    await record("2027-02", ["Scent Co (February 2027)"]);
    await record("2027-03", [], ["Pine Co: pine@pine.example is not on https://pine.example/news"]);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(cardId).run();
    expect(await sendDraftNotice(env, MORNING)).toMatch(/^this week's email TLC-[A-Z0-9]{6} listing 3 draft\(s\), 1 club\(s\) short sent to sequoia@westpeek\.ventures$/);
    expect(sends).toHaveLength(1);
    const n = sends[0]!;
    expect(n.to).toBe(SEQUOIA);
    subject = n.subject;
    ref = /TLC-[A-Z0-9]{6}/.exec(n.subject)![0];
    expect(n.text).toContain(`Ref ${ref}`);
    expect(n.text).toMatch(/\*\*1\*\* · Leaf Co — Pat Example <pat@leafco\.example>/);
    expect(n.text).toMatch(/\*\*2\*\* · Root Co/);
    expect(n.text).toMatch(/\*\*3\*\* · Scent Co/);
    expect(n.text.indexOf("January 2027")).toBeLessThan(n.text.indexOf("February 2027"));
    expect(n.text).toMatch(/Short this week[\s\S]*March 2027: no new brand this week — Pine Co: pine@pine\.example is not on/);
    expect(n.text).toContain("Why this brand: they host tastings");
    expect(n.text).toContain("Subject: Leaf Co + a small room in New York");
    expect(n.text).toContain("P.S. If this isn't a fit, just let me know and I won't follow up.");
    // Once a week: the same batch never sends a second one.
    expect(await sendDraftNotice(env, new Date("2026-11-09T15:00:00.000Z"))).toBe("this week's email already went");
  });

  it("refuses a reply that is not from her authenticated address, and decides nothing", async () => {
    expect((await reply(`Re: ${subject}`, "approve all", SCOOTER)).handled).toBe(false);
    expect((await reply(`Re: ${subject}`, "approve all", SEQUOIA, `${TRUSTED_AUTHSERV_ID}; spf=fail; dkim=fail; dmarc=fail`)).handled).toBe(false);
    expect(await cardState("Leaf Co")).toBe("pending_review");
    expect(sends).toHaveLength(0);
  });

  let nextRef = "";
  it("approve 1, skip 2, change 3: ONE answer on the same thread — what was sent, and the redraft in full to approve", async () => {
    const out = await reply(`Re: ${subject}`, asRawMime(`Approve 1\nskip 2\nchange 3: shorter\n\n\n\nSequoia Taylor\nGeneral Partner\n\n> On Nov 9, 2026, at 9:00 AM, Wynn · West Peek <wynn@joinwestpeek.com> wrote:\n> \n> Reply "approve all"\n> Ref ${ref}`));
    expect(out).toMatchObject({ handled: true, ref });
    // Approved by her, then spent by the send: to the brand, inside the warm-up allowance.
    expect(await cardState("Leaf Co")).toBe("executed");
    expect(sends.some((s) => s.to === "pat@leafco.example" && s.subject === "Leaf Co + a small room in New York")).toBe(true);
    // FROM HER, through her own Gmail (so it is in her Sent folder), never the firm transport as the employee.
    const brand = sends.find((s) => s.to === "pat@leafco.example")!;
    expect(brand).toMatchObject({ via: "gmail", from: `Sequoia Taylor <${SEQUOIA}>`, bcc: "os@joinwestpeek.com", replyTo: `${SEQUOIA}, os@joinwestpeek.com` });
    expect(brand.tokenFor).toBe(`${SEQUOIA} https://www.googleapis.com/auth/gmail.compose`);
    expect(sends.filter((s) => s.via === "resend" && s.to !== SEQUOIA)).toEqual([]);
    const receipt = await env.WP_OS_DB.prepare("SELECT r.state FROM external_effect_request r JOIN tlc_drip_message m ON m.effect_request_id = r.id WHERE m.deal_id = 'tld_LeafCo'").first<{ state: string }>();
    expect(receipt!.state).toBe("EXECUTED");
    expect(sends.some((s) => s.to === "pat@rootco.example")).toBe(false);
    expect((await env.WP_OS_DB.prepare("SELECT state, held_reason FROM tlc_drip_message WHERE deal_id = 'tld_RootCo'").first())).toMatchObject({ state: "HELD", held_reason: `skipped by Sequoia (${ref})` });
    expect((await env.WP_OS_DB.prepare("SELECT m.subject, m.redraft_note, a.state FROM tlc_drip_message m JOIN approval_card a ON a.id = m.approval_card_id WHERE m.deal_id = 'tld_ScentCo'").first())).toMatchObject({ subject: "Scent Co + a small room in New York (v2)", redraft_note: "shorter", state: "pending_review" });
    // Exactly one email to her: the answer, under the week's subject, threaded, with the redraft's full text and a new ref.
    const toHer = sends.filter((s) => s.to === SEQUOIA);
    expect(toHer).toHaveLength(1);
    const a = toHer[0]!;
    expect(a.subject).toBe(subject);
    expect(a.headers["In-Reply-To"]).toBeTruthy();
    expect(a.text).toMatch(/Done: \*\*1\*\* approved \(\*\*1\*\* sent now\), \*\*1\*\* skipped, \*\*1\*\* redrafted/);
    expect(a.text).toContain("Shorter, per \"shorter\".");
    expect(a.text).toContain("Redrafted for your note: shorter");
    nextRef = /Ref (TLC-[A-Z0-9]{6})/.exec(a.text)![1]!;
    expect(nextRef).not.toBe(ref);
    expect(sends.every((s) => s.to !== SCOOTER)).toBe(true);
  });

  it("her reply to that answer decides the redraft, bound to the answer's own list", async () => {
    sends.length = 0;
    const out = await reply(`Re: ${subject}`, asRawMime(`Approve all\n\nOn Mon, 9 Nov 2026 Wynn wrote:\n> Ref ${nextRef}\n> Ref ${ref}`));
    expect(out).toMatchObject({ handled: true, ref: nextRef });
    expect(await cardState("Scent Co")).toBe("executed");
    expect(sends.some((s) => s.to === "pat@scentco.example" && s.subject === "Scent Co + a small room in New York (v2)" && s.via === "gmail" && s.from === `Sequoia Taylor <${SEQUOIA}>`)).toBe(true);
    expect(sends.filter((s) => s.to === SEQUOIA)).toHaveLength(1);
  });

  it("a reply decides only the drafts listed in ITS email", async () => {
    await deal("Late Co", "2027-01");
    await runDrip(env, MORNING);
    await reply(`Re: ${subject}`, `approve all\n\n> Ref ${ref}`);
    expect(await cardState("Late Co")).toBe("pending_review");
  });

  it("a waiting draft that pasted the research note is re-composed in place, she gets ONE clean list, nothing is approved for her (TLC-ZF84KK)", async () => {
    const note = "Leak Co makes sleep trackers for longevity rooms. Caveat: the address is a shared PR inbox, and it fits the Lead partner tier.";
    await deal("Leak Co", "2027-01");
    await env.WP_OS_DB.prepare("UPDATE tlc_deal SET why_fit = ?1 WHERE id = 'tld_LeakCo'").bind(note).run();
    await runDrip(env, MORNING);
    // As the old template wrote it: the whole note, first letter lowered, in the brand email.
    const m = (await env.WP_OS_DB.prepare("SELECT id, body, effect_request_id, approval_card_id FROM tlc_drip_message WHERE deal_id = 'tld_LeakCo'").first<{ id: string; body: string; effect_request_id: string; approval_card_id: string }>())!;
    const leakedBody = m.body.replace(/I am writing because [^\n]*/, `I am writing because l${note.slice(1)}`);
    const req = (await env.WP_OS_DB.prepare("SELECT payload_json FROM external_effect_request WHERE id = ?1").bind(m.effect_request_id).first<{ payload_json: string }>())!;
    await env.WP_OS_DB.prepare("UPDATE external_effect_request SET payload_json = ?2 WHERE id = ?1").bind(m.effect_request_id, JSON.stringify({ ...JSON.parse(req.payload_json), text: leakedBody })).run();
    await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET body = ?2, notice_ref = ?3 WHERE id = ?1").bind(m.id, leakedBody, ref).run();
    sends.length = 0;

    expect(await repairLeakedDrafts(env, MORNING)).toMatch(/^1 draft\(s\) re-composed without the research note; the clean list re-sent on TLC-/);
    const after = (await env.WP_OS_DB.prepare("SELECT m.body, m.approval_card_id, m.notice_ref, r.payload_json, a.state, a.summary FROM tlc_drip_message m JOIN external_effect_request r ON r.id = m.effect_request_id JOIN approval_card a ON a.id = m.approval_card_id WHERE m.id = ?1").bind(m.id).first<{ body: string; approval_card_id: string; notice_ref: string; payload_json: string; state: string; summary: string }>())!;
    for (const words of [after.body, (JSON.parse(after.payload_json) as { text: string }).text, after.summary]) {
      expect(words).toContain("I am writing because Leak Co makes sleep trackers for longevity rooms.");
      expect(words).not.toMatch(/Caveat|inbox|Lead partner tier/);
    }
    // Same card, still hers to decide; nothing to a brand; exactly one email to her, on the week's thread, a new ref.
    expect(after.approval_card_id).toBe(m.approval_card_id);
    expect(after.state).toBe("pending_review");
    expect(sends.filter((s) => s.to !== SEQUOIA)).toHaveLength(0);
    const toHer = sends.filter((s) => s.to === SEQUOIA);
    expect(toHer).toHaveLength(1);
    expect(toHer[0]!.headers["In-Reply-To"]).toBeTruthy();
    expect(toHer[0]!.text).toMatch(/Nothing has gone to a brand/);
    // Her copy keeps the note as "Why this brand" (it is hers); the brand email inside it does not.
    expect(toHer[0]!.text).toContain("Why this brand: Leak Co makes sleep trackers");
    expect(toHer[0]!.text).toContain("I am writing because Leak Co makes sleep trackers for longevity rooms.\n");
    expect(toHer[0]!.text).not.toMatch(/I am writing because[^\n]*Caveat/);
    expect(after.notice_ref).not.toBe(ref);
    // Once: a repaired draft no longer carries the note.
    expect(await repairLeakedDrafts(env, MORNING)).toBe("no draft carries a research note");
    expect(sends.filter((s) => s.to === SEQUOIA)).toHaveLength(1);
    // Her approve-all on the clean list sends the clean words.
    await reply(`Re: ${subject}`, asRawMime(`Approve all\n\n> Ref ${after.notice_ref}`));
    const out = sends.find((s) => s.to === "pat@leakco.example");
    expect(out?.text).toContain("I am writing because Leak Co makes sleep trackers");
    expect(out?.text).not.toMatch(/Caveat/);
  });
});

describe("a re-read of her stored reply is reported as done (24 Oct 2026, learned in production)", () => {
  it("POST /api/inbound-email/reingest answers 200 with the TLC handler's detail when the reply was handled, never 409 'no card'", async () => {
    const { handleReingestStoredEmail } = await import("../src/worker/services/webPropertyChange");
    const ref = "TLC-RPLY24";
    await env.WP_OS_DB.prepare("INSERT INTO tlc_draft_notice (ref, items_json, firm_scope) VALUES (?1, '[]', 'west-peek')").bind(ref).run();
    const key = `inbound-email/2026-10-24/${crypto.randomUUID()}.eml`;
    const raw = asRawMime(`Approve all\n\n> Ref ${ref}`)
      .replace("Subject: Re: TLC", `Subject: Re: TLC: this week's brands · ${ref}\r\nMessage-ID: <${crypto.randomUUID()}@mail.gmail.com>\r\nAuthentication-Results: ${genuineFrom(SEQUOIA)}`);
    const docEnv = { ...env, WP_OS_DOCUMENTS: t.docs } as Env;
    await t.docs.put(key, raw);
    const res = await handleReingestStoredEmail({
      request: new Request("https://os.joinwestpeek.com/api/inbound-email/reingest", { method: "POST", body: JSON.stringify({ object_key: key }) }),
      env: docEnv,
      identity: { id: "fu_sequoia_taylor", email: SEQUOIA, fullName: "Sequoia Taylor", status: "ACTIVE", roles: ["MANAGING_PARTNER"], authorityScopes: [] },
      params: {},
    });
    const body = (await res.json()) as { ok: boolean; handled_by?: string; handled_ref?: string; detail?: string; new_card: string | null };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.handled_by).toBe("tlc_draft_reply");
    expect(body.handled_ref).toBe(ref);
    expect(body.detail).toBe("0 approved, 0 skipped, 0 redrafted");
    expect(body.new_card).toBeNull();
    const ev = await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE event_type = 'tlc.draft_reply' AND object_id = ?1").bind(ref).first<{ payload_json: string }>();
    expect(ev, "the handler really ran").not.toBeNull();
  });

  it("a reply the TLC handler declined is never reported as handled by it: the door's own card is the answer", async () => {
    const { handleReingestStoredEmail } = await import("../src/worker/services/webPropertyChange");
    const key = `inbound-email/2026-10-24/${crypto.randomUUID()}.eml`;
    // An unknown notice reference: the TLC handler declines it, and the door opens Porter's "unclear email" card.
    const raw = asRawMime("Approve all\n\n> Ref TLC-NOSUCH")
      .replace("Subject: Re: TLC", `Subject: Re: TLC-NOSUCH\r\nMessage-ID: <${crypto.randomUUID()}@mail.gmail.com>`);
    const docEnv = { ...env, WP_OS_DOCUMENTS: t.docs } as Env;
    await t.docs.put(key, raw);
    const res = await handleReingestStoredEmail({
      request: new Request("https://os.joinwestpeek.com/api/inbound-email/reingest", { method: "POST", body: JSON.stringify({ object_key: key }) }),
      env: docEnv,
      identity: { id: "fu_sequoia_taylor", email: SEQUOIA, fullName: "Sequoia Taylor", status: "ACTIVE", roles: ["MANAGING_PARTNER"], authorityScopes: [] },
      params: {},
    });
    const body = (await res.json()) as { ok: boolean; handled_by?: string; new_card: string | null };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.handled_by, "a declined reply is not reported as a TLC decision").toBeUndefined();
    expect(body.new_card).toMatch(/^wc_/);
    expect(await env.WP_OS_DB.prepare("SELECT 1 FROM event_record WHERE event_type = 'tlc.draft_reply' AND object_id = 'TLC-NOSUCH'").first(), "nothing was decided").toBeNull();
  });
});

describe("a queued email 2 offers the three samples (owner, 26 Oct 2026)", () => {
  it("re-composes unsent email 2 drafts in place; sent mail and her own redrafts are never touched", async () => {
    const { fileDraft } = await import("../src/worker/services/learningClub");
    const { recomposeSecondEmails } = await import("../src/worker/services/tlcDraftNotice");
    const OLD = "Hi Pat,\n\nA quick picture of the room, in case it helps. 30 New Yorkers, each with a paid seat.\n\nWould you be open to exploring a partnership?";
    const mk = async (brand: string) => {
      await deal(brand, "2027-01");
      const id = `tld_${brand.replace(/\W/g, "")}`;
      await env.WP_OS_DB.prepare("UPDATE tlc_deal SET drip_step = 1 WHERE id = ?1").bind(id).run();
      await fileDraft(env, { id, brand, contact_email: `pat@${brand.toLowerCase().replace(/\W/g, "")}.example`, drip_step: 1 }, { subject: `${brand} + a small room in New York`, text: OLD });
      return id;
    };
    const queued = await mk("Second Co");
    const sent = await mk("Sent Co");
    const mine = await mk("Mine Co");
    await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET state = 'SENT' WHERE deal_id = ?1").bind(sent).run();
    await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET redraft_note = 'her words' WHERE deal_id = ?1").bind(mine).run();
    expect(await recomposeSecondEmails(env)).toEqual(["Second Co"]);
    const row = (id: string) => env.WP_OS_DB.prepare("SELECT m.body, r.payload_json FROM tlc_drip_message m JOIN external_effect_request r ON r.id = m.effect_request_id WHERE m.deal_id = ?1").bind(id).first<{ body: string; payload_json: string }>();
    const q = (await row(queued))!;
    for (const text of [q.body, (JSON.parse(q.payload_json) as { text: string }).text]) {
      expect(text).toContain("One quick follow-up on The Learning Club. Rather than describe it, I'd be happy to show you: a sample run of show for the evening, a sketch of what a series of six could look like, and a breakdown of the kind of people we'd have in the room, all built around Second Co.");
      expect(text).not.toMatch(/\bcall\b|\$|exploring a partnership|quick picture/i);
    }
    expect((await row(sent))!.body).toBe(OLD);
    expect((await row(mine))!.body).toBe(OLD);
    // Once re-composed it is the current template: a second pass changes nothing.
    expect(await recomposeSecondEmails(env)).toEqual([]);
  });
});

describe("a queued draft tells the brand 25 to 100+ guests per event, flexible (owner, 30 Oct 2026)", () => {
  it("re-words the room size in unsent drafts only; everything else in the draft stays as it was", async () => {
    const { fileDraft } = await import("../src/worker/services/learningClub");
    const { recomposeGuestCounts, standardGuestWords } = await import("../src/worker/services/tlcDraftNotice");
    expect(standardGuestWords("In March we are hosting it: 60 to 75 people spending an evening.")).toBe("In March we are hosting it: 25 to 100+ people per event (flexible to your goals) spending an evening.");
    // Idempotent: the standard words are never re-worded again.
    expect(standardGuestWords("In March we are hosting it: 25 to 100+ people per event (flexible to your goals) spending an evening.")).toBe("In March we are hosting it: 25 to 100+ people per event (flexible to your goals) spending an evening.");
    expect(standardGuestWords("80 to 120 New Yorkers, each paying")).toBe("25 to 100+ New Yorkers (flexible to your goals), each paying");
    const OLD = "Hi Pat,\n\nI am writing because they host tastings.\nIn March 2027 we are hosting The Learning Club in New York: 80 to 120 people spending an afternoon or evening going deep on T, hands-on.";
    const mk = async (brand: string) => {
      await deal(brand, "2027-03");
      const id = `tld_${brand.replace(/\W/g, "")}`;
      await fileDraft(env, { id, brand, contact_email: `pat@${brand.toLowerCase().replace(/\W/g, "")}.example`, drip_step: 0 }, { subject: `${brand} + a small room in New York`, text: OLD });
      return id;
    };
    const queued = await mk("Room Co");
    const sent = await mk("Sent Room Co");
    await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET state = 'SENT' WHERE deal_id = ?1").bind(sent).run();
    expect(await recomposeGuestCounts(env)).toContain("Room Co");
    const body = async (id: string) => (await env.WP_OS_DB.prepare("SELECT m.body, r.payload_json FROM tlc_drip_message m JOIN external_effect_request r ON r.id = m.effect_request_id WHERE m.deal_id = ?1").bind(id).first<{ body: string; payload_json: string }>())!;
    const q = await body(queued);
    for (const text of [q.body, (JSON.parse(q.payload_json) as { text: string }).text]) {
      expect(text).toContain("25 to 100+ people per event (flexible to your goals) spending");
      expect(text).not.toContain("25 to 40");
      expect(text).not.toContain("80 to 120");
      expect(text).toContain("I am writing because they host tastings.");
    }
    expect((await body(sent)).body).toBe(OLD);
    expect(await recomposeGuestCounts(env)).not.toContain("Room Co");
  });
});

describe("one brand per category per club at a time (owner, 26 Oct 2026)", () => {
  it("the second brand in a category is not pitched while the first is live; it goes once the first declines or goes quiet after its follow-up", async () => {
    const { categoryRival } = await import("../src/worker/services/learningClub");
    const mk = (id: string, brand: string, extra: string) =>
      env.WP_OS_DB.prepare(`INSERT INTO tlc_deal (id, event_id, brand, category, contact_name, contact_email, contact_source_url, why_fit, next_send_at, firm_scope${extra ? ", stage, drip_step, first_sent_at, last_sent_at, stop_reason" : ""}) VALUES (?1, 'tlc_2027-03', ?2, 'Vector memory', 'Pat Example', ?3, 'https://example.test/team', 'they make memory', ?4, 'west-peek'${extra})`)
        .bind(id, brand, `pat@${id}.example`, MORNING.toISOString()).run();
    await mk("tld_mem1", "Memory One", ", 'PITCHED', 1, '2026-11-01T14:00:00.000Z', '2026-11-01T14:00:00.000Z', 'REPLIED'");
    await mk("tld_mem2", "Memory Two", "");
    const two = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = 'tld_mem2'").first())! as never;
    // The first replied: the second waits, and no first pitch is drafted for it.
    expect(await categoryRival(env, two, MORNING)).toBe("Memory One");
    const out = await runDrip(env, MORNING);
    expect(out.heldForCategory).toEqual(["Memory Two (after Memory One)"]);
    expect(await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_drip_message WHERE deal_id = 'tld_mem2'").first()).toBeNull();
    // The first goes quiet: its one follow-up went eight days ago and it never answered. The category opens.
    await env.WP_OS_DB.prepare("UPDATE tlc_deal SET stop_reason = NULL, drip_step = 2, last_sent_at = '2026-11-01T14:00:00.000Z' WHERE id = 'tld_mem1'").run();
    expect(await categoryRival(env, two, MORNING)).toBeNull();
    // A follow-up only two days old is still live.
    await env.WP_OS_DB.prepare("UPDATE tlc_deal SET last_sent_at = '2026-11-07T14:00:00.000Z' WHERE id = 'tld_mem1'").run();
    expect(await categoryRival(env, two, MORNING)).toBe("Memory One");
    // It declines: the second is pitched on the next pass.
    await env.WP_OS_DB.prepare("UPDATE tlc_deal SET stage = 'DECLINED', stop_reason = 'DECLINED' WHERE id = 'tld_mem1'").run();
    await env.WP_OS_DB.prepare("UPDATE tlc_deal SET next_send_at = ?1 WHERE id = 'tld_mem2'").bind(MORNING.toISOString()).run();
    await runDrip(env, MORNING);
    expect(await env.WP_OS_DB.prepare("SELECT state FROM tlc_drip_message WHERE deal_id = 'tld_mem2' AND step = 0").first()).toEqual({ state: "AWAITING_APPROVAL" });
  });
});
