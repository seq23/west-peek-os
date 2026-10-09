import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { openSiteCardFor, steerFromReply } from "../src/worker/services/emailThread";
import { blockCard } from "../src/worker/services/blocks";
import { handleInboundEmail } from "../src/worker/effects/inboundEmail";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { WEB_PROPERTY_CHANGE_KIND } from "../src/shared/work/localJobs";
import { NEW_EMAIL_NOTE_PREFIX, stripLateThreadPrefix } from "../src/shared/work/approvalReply";

/**
 * ONE OPEN WEBSITE CARD PER PARTNER PER REPO (28 Sep 2026).
 *
 * THE NIGHT THIS PINS. Scooter sent five emails about the community site, each under its own
 * subject, while Porter's card for that site was open. The door read every one as a new
 * assignment: five cards, five Walker hand-offs, five "Got it" emails, five plans queued to a Mac
 * that was asleep, and a "Blocked" email for each. Her ruling: "we should have not made 5
 * workcards for this one site job... scooter's emails should have registered as follow ups to one
 * card. and those items should go back to plan mode and fix automatically b/c the ask itself is
 * approval."
 *
 * What is proven, each against the code that does it and never against prose:
 *   · A partner's NEW-SUBJECT email that reads as a website change joins their open card for that
 *     repo as a follow-up: a note in their words (subject included), the card's own event, and NO
 *     new card anywhere.
 *   · THE ASK RE-OPENS THE JOB: a card blocked after three failed attempts is re-opened by the
 *     follow-up with its attempts reset, so the next sweep plans and builds it without anyone
 *     clicking anything — and since 9 Oct 2026 the follow-up is kept as INSTRUCTIONS, never recorded
 *     as the block's answer (a new email is not a reply to the question the block asked).
 *   · The matcher is narrow: an unauthenticated sender, a message that is not a website change,
 *     and a partner with no open website card all fall through to the ladder the door always ran.
 *   · At the door itself (both sizes go through the same reply check), the second email creates
 *     nothing: the count of work cards is the same before and after.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string; text: string }> = [];

const SCOOTER = "scooter@westpeek.ventures";
const GOOD_AUTH = `mx.cloudflare.net; spf=pass smtp.mailfrom=${SCOOTER}; dkim=pass header.d=westpeek.ventures; dmarc=pass`;
const BAD_AUTH = `mx.cloudflare.net; spf=fail smtp.mailfrom=${SCOOTER}; dkim=none`;

function fakeBucket() {
  const store = new Map<string, Uint8Array>();
  return {
    put: async (key: string, body: ArrayBuffer | Uint8Array | string) => {
      store.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : new Uint8Array(body));
      return { key };
    },
    get: async (key: string) => {
      const b = store.get(key);
      return b ? { arrayBuffer: async () => b.buffer, text: async () => new TextDecoder().decode(b) } : null;
    },
  };
}

/** A fresh email from Scooter's Gmail: its own subject, no References, no token. */
function newMail(subject: string, body: string): string {
  return [`From: Scooter Taylor <${SCOOTER}>`, "To: os@joinwestpeek.com", `Subject: ${subject}`, "", body].join("\n");
}

async function cardCount(): Promise<number> {
  return (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card").first<{ n: number }>())!.n;
}

async function porterCardFrom(chiefId: string): Promise<string> {
  const chief = await env.WP_OS_DB.prepare("SELECT description FROM work_card WHERE id = ?1").bind(chiefId).first<{ description: string }>();
  const m = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(chief?.description ?? "");
  expect(m, "the chief handed the site change to Porter").not.toBeNull();
  return m![1]!;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, {
    WP_OS_AI_EMAIL_PARTNERS: "enabled",
    WP_OS_EMAIL_SEND: "enabled",
    RESEND_API_KEY: "re_test_not_a_real_key",
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
    WP_OS_DOCUMENTS: fakeBucket() as never,
  } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  });
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_porter', 'aie_walker', 'aie_wren')").run();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

describe("a partner's new email about an open site job is a follow-up on that job", () => {
  let porterId = "";

  it("opens the one card, once, the way the door always has", async () => {
    const chiefId = await openAssignmentCard(env, {
      subject: "Community site redesign",
      partnerAddress: SCOOTER,
      chiefOfStaff: "Walker",
      raw: newMail("Community site redesign", "Hey Porter! Please rebuild the community site (joinwestpeek.com): new nav, homepage, episodes."),
      limits: EMAILED_TASK_LIMITS,
      emlKey: null,
    });
    porterId = await porterCardFrom(chiefId);
    const porter = await env.WP_OS_DB.prepare("SELECT kind, state, requested_by_email FROM work_card WHERE id = ?1").bind(porterId).first<{ kind: string; state: string; requested_by_email: string }>();
    expect(porter?.kind).toBe(WEB_PROPERTY_CHANGE_KIND);
    expect(porter?.requested_by_email).toBe(SCOOTER);
    // The RECEIVED notice went out on a thread of its own: that thread is what a follow-up rides.
    const thread = await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_id = ?1 AND to_address = ?2").bind(porterId, SCOOTER).first<{ token: string }>();
    expect(thread?.token, "the card has a conversation with the partner").toMatch(/^wpt_/);
  });

  it("the matcher finds the open card for an authenticated partner's website words, and nobody else's", async () => {
    const asks = { fromHeader: `Scooter Taylor <${SCOOTER}>`, authenticationResults: GOOD_AUTH, subject: "Names missing on the HBCU flyers", raw: newMail("Names missing on the HBCU flyers", "Hey Porter!\n\nThe HBCU flyers on the community site still don't show names.") };
    const found = await openSiteCardFor(env, asks);
    expect(found?.cardId).toBe(porterId);
    expect(found?.targetRepo).toBe("join-west-peek-main");
    expect(found?.thread.object_id).toBe(porterId);

    // "Hey Porter" with no site named at all still joins their open site card: "the site" the morning after.
    const toPorter = await openSiteCardFor(env, { ...asks, subject: "Two more", raw: newMail("Two more", "Hey Porter!\n\nRemove my email from the Update form.") });
    expect(toPorter?.cardId).toBe(porterId);

    // The bar is the assignment door's bar: a failed authentication is nobody.
    expect(await openSiteCardFor(env, { ...asks, authenticationResults: BAD_AUTH })).toBeNull();
    // Deal flow is not a website change and is not Porter's: the ladder takes it.
    expect(await openSiteCardFor(env, { ...asks, subject: "#wpdealflow Acme Robotics", raw: newMail("#wpdealflow Acme Robotics", "Seed round, deck attached.") })).toBeNull();
    // ANOTHER property is another job, not a follow-up on this one — even one in the same repo
    // (the ventures site and the community site share join-west-peek-main and are still two jobs).
    expect(await openSiteCardFor(env, { ...asks, subject: "westpeek.live", raw: newMail("westpeek.live", "Change the tagline on westpeek.live please.") })).toBeNull();
    expect(await openSiteCardFor(env, { ...asks, subject: "Ventures team page", raw: newMail("Ventures team page", "Please add the new partner to the team page on westpeek.ventures.") })).toBeNull();
    // The same property, named outright, joins.
    // A site we do not know is still a site (9 Oct 2026): Scooter's "New site build:
    // voting.topbarz.xyz/entry" — with a Google Doc link, no Porter greeting — joined the newest open
    // card as the answer to its preview gate. It is a new job.
    const topbarz = "Hey!\n\nWe need a page at voting.topbarz.xyz/entry for the Top Barz CultureCon contest. Keep it simple.\n- Link to the official rules: https://docs.google.com/document/d/1VqrGTQdvbFbqno4Wx_J5xC6PlFBHFdTdTeMalDTueks/edit\n- Track upload\n\nBest,\nScooter";
    expect(await openSiteCardFor(env, { ...asks, subject: "New site build: voting.topbarz.xyz/entry", raw: newMail("New site build: voting.topbarz.xyz/entry", topbarz) })).toBeNull();
    expect(await openSiteCardFor(env, { ...asks, subject: "Rules", raw: newMail("Rules", "Hey Porter!\n\nThe rules for https://voting.topbarz.xyz are attached.") })).toBeNull();
    // Hosts that are not sites never split a follow-up off: an address, a file name, a Doc link.
    expect(await openSiteCardFor(env, { ...asks, subject: "Logo", raw: newMail("Logo", "Hey Porter!\n\nUse logo.png from the doc https://docs.google.com/document/d/abc/edit and email scooter@westpeek.ventures if stuck.") })).not.toBeNull();
    const named = await openSiteCardFor(env, { ...asks, subject: "joinwestpeek.com hero", raw: newMail("joinwestpeek.com hero", "Make the hero on joinwestpeek.com feel live.") });
    expect(named?.cardId).toBe(porterId);
  });

  it("steers the open card as a follow-up: a note in their words with the subject, the event, and no new card", async () => {
    const before = await cardCount();
    const raw = newMail("Names missing on the HBCU flyers", "Hey Porter!\n\nThe HBCU flyers on the community site still don't show people's names. Please use the Dropbox filenames.");
    const out = await steerFromReply(env, { fromHeader: `Scooter Taylor <${SCOOTER}>`, authenticationResults: GOOD_AUTH, subject: "Names missing on the HBCU flyers", raw, inReplyTo: null, references: null, emlKey: null });
    expect(out.steered, "a new subject about the open site job is a steer, not a new request").toBe(true);
    expect(out.thread?.object_id).toBe(porterId);
    expect(out.written).toMatch(/^Names missing on the HBCU flyers\n\nHey Porter!/);
    expect(await cardCount(), "nothing new was created").toBe(before);
    const note = await env.WP_OS_DB.prepare("SELECT body FROM work_card_note WHERE work_card_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(porterId).first<{ body: string }>();
    expect(note?.body).toMatch(/Names missing on the HBCU flyers/);
    expect(note?.body).toMatch(/Dropbox filenames/);
    const event = await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE object_id = ?1 AND event_type = 'work.steered_by_reply' ORDER BY created_at DESC LIMIT 1").bind(porterId).first<{ payload_json: string }>();
    expect(JSON.parse(event!.payload_json)).toMatchObject({ follow_up: true, follow_up_subject: "Names missing on the HBCU flyers" });
  });

  it("THE ASK RE-OPENS THE JOB, NEVER ANSWERS ITS BLOCK: a card blocked after three failed attempts is re-opened by the follow-up with its attempts reset, the follow-up kept as instructions (rule 1b, 9 Oct 2026)", async () => {
    // Blocked the way the sweep blocks it after the third failed attempt: the real door, not SQL.
    const row = (await env.WP_OS_DB.prepare("SELECT id, title, firm_scope, owner_id FROM work_card WHERE id = ?1").bind(porterId).first<{ id: string; title: string; firm_scope: string; owner_id: string | null }>())!;
    await blockCard(env, row, { reason: "tried_and_could_not_finish", trying: row.title, employee: "Porter", who: "SEQUOIA" });
    // The three spent attempts, recorded after the block as the sweep leaves them (0194 forbids an OPEN card with none left).
    await env.WP_OS_DB.prepare("UPDATE work_card SET work_attempts = 3 WHERE id = ?1").bind(porterId).run();
    expect((await env.WP_OS_DB.prepare("SELECT state FROM work_card WHERE id = ?1").bind(porterId).first<{ state: string }>())?.state).toBe("BLOCKED");
    const before = await cardCount();
    const raw = newMail("Two more - remove my email, fix the Past Winners heading", "Hey Porter!\n\nTwo more fixes: remove my email from the Update form, and make the Past Winners heading one heading.");
    const out = await steerFromReply(env, { fromHeader: `Scooter Taylor <${SCOOTER}>`, authenticationResults: GOOD_AUTH, subject: "Two more - remove my email, fix the Past Winners heading", raw, inReplyTo: null, references: null, emlKey: null });
    expect(out.steered).toBe(true);
    // 9 Oct 2026: Scooter's NEW email was recorded as the answer to his spam card's preview gate. A new
    // email is never the answer to a block — it is instructions for the work.
    expect(out.answered, "a NEW email never answers a block").toBe(false);
    const card = await env.WP_OS_DB.prepare("SELECT state, work_attempts, block_answer, block_answered_at FROM work_card WHERE id = ?1").bind(porterId).first<{ state: string; work_attempts: number; block_answer: string | null; block_answered_at: string | null }>();
    expect(card?.state, "open again for the next sweep — no button, no owner").toBe("OPEN");
    expect(card?.work_attempts, "the three failed attempts are forgiven; the new ask gets its own three").toBe(0);
    expect(card?.block_answer, "nothing is recorded as the block's answer").toBeNull();
    expect(card?.block_answered_at).toBeNull();
    const note = await env.WP_OS_DB.prepare("SELECT body FROM work_card_note WHERE work_card_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(porterId).first<{ body: string }>();
    expect(note?.body.startsWith(NEW_EMAIL_NOTE_PREFIX), "kept with the prefix the runner reads as instructions, never as approval").toBe(true);
    expect(note?.body).toMatch(/remove my email/);
    expect(stripLateThreadPrefix(note!.body).late, "the runner treats it like a late reply: it can approve or force nothing").toBe(true);
    expect(await cardCount()).toBe(before);
  });

  it("at the door, the same new-subject email creates nothing", async () => {
    const before = await cardCount();
    const raw = newMail("Update form is broken + site fixes", "Hey Porter!\n\nThe Update form on the community site is broken on the preview. Please fix the delivery.");
    const bytes = new TextEncoder().encode(raw);
    const headers = new Headers({
      from: `Scooter Taylor <${SCOOTER}>`,
      to: "os@joinwestpeek.com",
      subject: "Update form is broken + site fixes",
      "message-id": `<follow-up-${Date.now()}@mail.gmail.com>`,
      "authentication-results": GOOD_AUTH,
    });
    await handleInboundEmail({ from: SCOOTER, to: "os@joinwestpeek.com", headers, raw: new Blob([bytes]).stream(), rawSize: bytes.byteLength }, env);
    expect(await cardCount(), "no Walker intake, no second Porter card").toBe(before);
    const note = await env.WP_OS_DB.prepare("SELECT body FROM work_card_note WHERE work_card_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(porterId).first<{ body: string }>();
    expect(note?.body).toMatch(/Update form is broken/);
    const open = (
      await env.WP_OS_DB.prepare("SELECT id FROM work_card WHERE kind = ?1 AND lower(requested_by_email) = ?2 AND state NOT IN ('DONE','CANCELLED') AND merged_into_card_id IS NULL")
        .bind(WEB_PROPERTY_CHANGE_KIND, SCOOTER)
        .all<{ id: string }>()
    ).results!;
    expect(open.map((r) => r.id), "THE INVARIANT: one open website card for this partner and repo").toEqual([porterId]);
  });
});
