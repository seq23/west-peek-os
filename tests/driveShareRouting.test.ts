import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { blockCard } from "../src/worker/services/blocks";
import { handleInboundEmail } from "../src/worker/effects/inboundEmail";
import { announceOutcome } from "../src/worker/services/workSweep";
import { writeProfile } from "../src/worker/services/partnerProfile";
import { driveFilesFor } from "../src/worker/services/driveShares";
import { cantPlaceEmail, shortSubject } from "../src/worker/services/emailRouting";
import { driveShareNotice } from "../src/shared/intake/driveShare";
import { lintExecEmail, renderExecEmail } from "../src/shared/email/execEmail";
import { threadReference } from "../src/shared/email/thread";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";

/**
 * A DRIVE SHARE IS THE SHARING PARTNER'S MATERIAL, NEVER AN "UNCLEAR EMAIL" (9 Oct 2026, 0256).
 *
 * At 13:29Z Scooter shared "Official Rules - Top Barz CultureCon Song Contest - Draft II" with os@.
 * The notice comes from drive-shares-dm-noreply@google.com, so the door opened "Unclear email…", the
 * card could not open the document, and Sequoia got a question that cut its subject mid-word, opened
 * with nothing, claimed nothing was on record about Top Barz, and argued two readings. Pinned here:
 *   · the sharer is read from Google's signed Reply-To; the file goes on his matching open job, with its
 *     text read through the firm's Drive delegation (as the sharer);
 *   · no matching job → a card for him with the file, BLOCKED on him (the normal reminder), and ONE plain
 *     email to him; his reply routes it;
 *   · a share nobody can be identified behind is still asked about — in the plain shape, never the essay.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string; text: string }> = [];
const SCOOTER = "scooter@westpeek.ventures";
const SEQUOIA = "sequoia@westpeek.ventures";
const GOOD_AUTH = `mx.cloudflare.net; spf=pass smtp.mailfrom=${SCOOTER}; dkim=pass header.d=westpeek.ventures; dmarc=pass`;
const GOOGLE_AUTH = "mx.cloudflare.net; dkim=pass header.d=google.com header.s=20251104 header.b=c2pKR3Yx; dmarc=pass header.from=google.com policy.dmarc=reject; spf=pass smtp.mailfrom=doclist.bounces.google.com";
const RULES_ID = "1VqrGTQdvbFbqno4Wx_J5xC6PlFBHFdTdTeMalDTueks";
const driveText = new Map<string, string>([[RULES_ID, "OFFICIAL RULES\nTop Barz CultureCon Song Contest\n1. One entry per artist."]]);
const driveName = new Map<string, string>([[RULES_ID, "Official Rules - Top Barz CultureCon Song Contest - Draft II"], ["1PodcastIdeasDocAAAAAAAAAAAAAAAAAAAAAAAAA", "Q4 Podcast Ideas"], ["1BudgetSheetAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "Studio photos for later"]]);

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

let seq = 0;
/** Google's share notice, as it arrived on 9 Oct (headers trimmed to the ones that matter). */
async function share(title: string, fileId: string, opts: { replyTo?: string | null; auth?: string } = {}): Promise<void> {
  const subject = `Document shared with you: "${title}"`;
  const replyTo = opts.replyTo === undefined ? `Scooter Taylor <${SCOOTER}>` : opts.replyTo;
  const from = `"Scooter Taylor (via Google Docs)" <drive-shares-dm-noreply@google.com>`;
  const body = `I've shared an item with you:\r\n\r\n${title}\r\nhttps://docs.google.com/document/d/${fileId}/edit?usp=sharing&ts=6ac8ec41\r\n\r\nIt's not an attachment -- it's stored online. To open this item, just click\r\nthe link above.`;
  const messageId = `autogen-java-${Date.now()}-${++seq}@google.com`;
  const head = [`From: ${from}`, "To: os@joinwestpeek.com", `Subject: ${subject}`, `Message-ID: <${messageId}>`, `Authentication-Results: ${opts.auth ?? GOOGLE_AUTH}`, ...(replyTo ? [`Reply-To: ${replyTo}`] : [])];
  const raw = [...head, "", body].join("\r\n");
  const bytes = new TextEncoder().encode(raw);
  const headers = new Headers({ from, to: "os@joinwestpeek.com", subject, "message-id": `<${messageId}>`, "authentication-results": opts.auth ?? GOOGLE_AUTH });
  if (replyTo) headers.set("reply-to", replyTo);
  await handleInboundEmail({ from: "bounce@doclist.bounces.google.com", to: "os@joinwestpeek.com", headers, raw: new Blob([bytes]).stream(), rawSize: bytes.byteLength }, env);
}

async function reply(subject: string, body: string, inReplyTo: string): Promise<void> {
  const messageId = `reply-${Date.now()}-${++seq}@mail.gmail.com`;
  const raw = [`From: Scooter Taylor <${SCOOTER}>`, "To: os@joinwestpeek.com", `Subject: ${subject}`, `Message-ID: <${messageId}>`, `In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`, `Authentication-Results: ${GOOD_AUTH}`, "", body].join("\r\n");
  const bytes = new TextEncoder().encode(raw);
  const headers = new Headers({ from: `Scooter Taylor <${SCOOTER}>`, to: "os@joinwestpeek.com", subject, "message-id": `<${messageId}>`, "authentication-results": GOOD_AUTH, "in-reply-to": inReplyTo, references: inReplyTo });
  await handleInboundEmail({ from: SCOOTER, to: "os@joinwestpeek.com", headers, raw: new Blob([bytes]).stream(), rawSize: bytes.byteLength }, env);
}

const one = <T>(sql: string, ...b: unknown[]) => env.WP_OS_DB.prepare(sql).bind(...b).first<T>();
const all = async <T>(sql: string, ...b: unknown[]) => (await env.WP_OS_DB.prepare(sql).bind(...b).all<T>()).results ?? [];
const unclearCards = async () => (await one<{ n: number }>("SELECT COUNT(*) AS n FROM work_card WHERE title LIKE 'Unclear email:%'"))!.n;

async function siteJob(subject: string, body: string, host?: string): Promise<string> {
  const chiefId = await openAssignmentCard(env, { subject, partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: [`From: Scooter Taylor <${SCOOTER}>`, `Subject: ${subject}`, "", body].join("\n"), limits: EMAILED_TASK_LIMITS, emlKey: null });
  const chief = await one<{ description: string }>("SELECT description FROM work_card WHERE id = ?1", chiefId);
  const id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(chief!.description)![1]!;
  if (host) {
    await env.WP_OS_DB.prepare("UPDATE web_property_change SET property_host = ?2 WHERE work_card_id = ?1").bind(id, host).run();
    await env.WP_OS_DB.prepare("UPDATE work_card SET request_json = json_set(COALESCE(request_json, '{}'), '$.property_host', ?2) WHERE id = ?1").bind(id, host).run();
  }
  return id;
}
async function closeAll(): Promise<void> {
  await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state NOT IN ('DONE','CANCELLED')").run();
}

beforeAll(async () => {
  t = await createTestDb();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  env = makeTestEnv(t.db, {
    WP_OS_AI_EMAIL_PARTNERS: "enabled",
    WP_OS_EMAIL_SEND: "enabled",
    RESEND_API_KEY: "re_test_not_a_real_key",
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
    WP_OS_DOCUMENTS: fakeBucket() as never,
    WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "gsc-bot@test.iam.gserviceaccount.com", private_key: privateKey }),
  } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    if (u.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 });
    const meta = /drive\/v3\/files\/([A-Za-z0-9_-]+)\?fields=/.exec(u);
    if (meta) {
      const id = meta[1]!;
      if (!driveText.has(id)) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ id, name: driveName.get(id) ?? `Doc ${id}`, mimeType: "application/vnd.google-apps.document", owners: [{ emailAddress: SCOOTER }] }), { status: 200 });
    }
    const exp = /drive\/v3\/files\/([A-Za-z0-9_-]+)\/export/.exec(u);
    if (exp) return new Response(driveText.get(exp[1]!) ?? "", { status: driveText.has(exp[1]!) ? 200 : 404 });
    throw new Error(`unexpected fetch in test: ${u}`);
  });
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_porter', 'aie_walker', 'aie_wren')").run();
  await writeProfile(env, SCOOTER, { aliases: [{ host: "voting.topbarz.xyz", words: ["top barz", "topbarz", "culturecon"] }] });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

describe("the share notice, read", () => {
  it("the sharer is Google's signed Reply-To — and nobody when Google's signature did not pass", () => {
    const base = { from: `"Scooter Taylor (via Google Docs)" <drive-shares-dm-noreply@google.com>`, replyTo: `Scooter Taylor <${SCOOTER}>`, authenticationResults: GOOGLE_AUTH, subject: 'Document shared with you: "Official Rules - Top Barz CultureCon Song', body: `I've shared an item with you:\n\nOfficial Rules - Top Barz CultureCon Song Contest - Draft II\nhttps://docs.google.com/document/d/${RULES_ID}/edit?usp=sharing\n` };
    const n = driveShareNotice(base)!;
    expect(n.sharer).toBe(SCOOTER);
    expect(n.fileId).toBe(RULES_ID);
    expect(n.title, "the whole title from the body, not the folded subject").toBe("Official Rules - Top Barz CultureCon Song Contest - Draft II");
    expect(n.kind).toBe("document");
    expect(driveShareNotice({ ...base, authenticationResults: "mx.cloudflare.net; dkim=fail" })!.sharer, "an unsigned Reply-To names nobody").toBeNull();
    expect(driveShareNotice({ ...base, from: `Scooter <${SCOOTER}>` }), "only Google's share sender is a share notice").toBeNull();
  });
});

describe("a share from a partner lands on his matching job", () => {
  it("Top Barz rules doc → his voting.topbarz.xyz job, text and all; no Unclear card, nothing to Sequoia", async () => {
    await closeAll();
    const voting = await siteJob("Top Barz entry page", "Hey!\n\nWe need an entry page on westpeekproductions.com for the Top Barz contest.", "voting.topbarz.xyz");
    await siteJob("Spam on the Ventures form", "Hey! Instinct took a look at the spam coming through the westpeek.ventures form.");
    const before = { unclear: await unclearCards(), sent: sent.length, cards: (await one<{ n: number }>("SELECT COUNT(*) AS n FROM work_card"))!.n };
    await share("Official Rules - Top Barz CultureCon Song Contest - Draft II", RULES_ID);
    expect(await unclearCards(), "a share is never an unclear email").toBe(before.unclear);
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM work_card"))!.n, "nothing new was opened").toBe(before.cards);
    const files = await driveFilesFor(env, voting);
    expect(files.map((f) => f.title)).toEqual(["Official Rules - Top Barz CultureCon Song Contest - Draft II"]);
    expect(files[0]!.shared_by).toBe(SCOOTER);
    expect(files[0]!.text, "the card can READ the document").toMatch(/One entry per artist/);
    const desc = (await one<{ description: string }>("SELECT description FROM work_card WHERE id = ?1", voting))!.description;
    expect(desc).toMatch(/SHARED DOCUMENT from Scooter/);
    expect(desc).toMatch(/One entry per artist/);
    expect(sent.slice(before.sent).filter((m) => m.to === SEQUOIA).length, "Sequoia is not asked about Scooter's file").toBe(0);
  });
});

describe("a share matching none of his open jobs: a card for him with the file, and one plain question", () => {
  it("asks HIM once, in the plain shape; his reply routes it", async () => {
    await closeAll();
    const spam = await siteJob("Spam on the Ventures form", "Hey! Instinct took a look at the spam coming through the westpeek.ventures form.");
    driveText.set("1PodcastIdeasDocAAAAAAAAAAAAAAAAAAAAAAAAA", "Episode ideas");
    const sentBefore = sent.length;
    await share("Q4 Podcast Ideas", "1PodcastIdeasDocAAAAAAAAAAAAAAAAAAAAAAAAA");
    const card = await one<{ id: string; state: string; block_who: string; block_nag_at: string | null; requested_by_email: string }>("SELECT * FROM work_card WHERE title = 'Shared by Scooter: Q4 Podcast Ideas'");
    expect(card, "a card for him").not.toBeNull();
    expect(card!.requested_by_email).toBe(SCOOTER);
    expect(card!.state).toBe("BLOCKED");
    expect(card!.block_who, "waiting on HIM, not Sequoia").toBe("SCOOTER");
    expect(card!.block_nag_at, "the normal 24-hour reminder runs").not.toBeNull();
    expect((await driveFilesFor(env, card!.id)).map((f) => f.title)).toEqual(["Q4 Podcast Ideas"]);
    const mails = sent.slice(sentBefore);
    expect(mails.filter((m) => m.to === SEQUOIA).length).toBe(0);
    const asked = mails.filter((m) => m.to === SCOOTER);
    expect(asked.length, "one email").toBe(1);
    expect(asked[0]!.text).toMatch(/^\*\*TL;DR:\*\* I got "Q4 Podcast Ideas" from you at \d{1,2}:\d{2} [AP]M CT\. What would you like me to do with it\?/);
    const options = asked[0]!.text.split("\n").filter((l) => /^• Reply '/.test(l));
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options.length, "at most three replies").toBeLessThanOrEqual(3);
    // His answer: "1" — the open job named first.
    const thread = await one<{ token: string }>("SELECT token FROM email_thread WHERE object_type = 'inbound_clarification' ORDER BY created_at DESC LIMIT 1");
    await reply("Re: Porter", "1\r\n\r\nSent from my iPhone", threadReference(thread!.token));
    expect((await driveFilesFor(env, spam)).map((f) => f.title), "the file is on the job he named").toContain("Q4 Podcast Ideas");
    const after = await one<{ state: string; merged_into_card_id: string | null }>("SELECT state, merged_into_card_id FROM work_card WHERE id = ?1", card!.id);
    expect(after).toEqual({ state: "CANCELLED", merged_into_card_id: spam });
  });

  it("\"file\" files it: the card closes with the document on it, nothing more", async () => {
    await closeAll();
    driveText.set("1BudgetSheetAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "a,b");
    const sentBefore = sent.length;
    await share("Studio photos for later", "1BudgetSheetAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const asked = sent.slice(sentBefore).filter((m) => m.to === SCOOTER);
    expect(asked.length).toBe(1);
    const thread = await one<{ token: string }>("SELECT token FROM email_thread WHERE object_type = 'inbound_clarification' ORDER BY created_at DESC LIMIT 1");
    await reply("Re: Porter", "file", threadReference(thread!.token));
    const card = await one<{ state: string }>("SELECT state FROM work_card WHERE title = 'Shared by Scooter: Studio photos for later'");
    expect(card!.state).toBe("DONE");
  });
});

describe("the can't-place question has one plain shape (hostile review of the 13:44Z email)", () => {
  function check(subject: string, text: string, originalSubject: string): void {
    expect(subject.length).toBeLessThanOrEqual(70);
    expect(subject).toMatch(/^Porter: I got an email I can't place — /);
    // Never cut mid-word: the short subject is the original's words, whole, up to where it stops.
    const shown = subject.replace(/^Porter: I got an email I can't place — /, "").replace(/…$/, "");
    const words = originalSubject.replace(/^Document shared with you:\s*/i, "").split(/\s+/);
    const shownWords = shown.split(/\s+/);
    expect(words.slice(0, shownWords.length), "cut only between words").toEqual(shownWords);
    const first = text.split("\n").find((l) => l.trim())!;
    expect(first).toMatch(/^\*\*TL;DR:\*\* I got the following at \d{1,2}:\d{2} [AP]M CT from .+: .+\. I don't know/);
    expect(text.split("\n").filter((l) => /^• Reply '/.test(l)).length).toBeLessThanOrEqual(3);
    expect(text).not.toMatch(/nothing in the record|needs something from you before this can go any further/i);
    expect(lintExecEmail(subject, text, "Porter"), "it meets the exec-email format").toEqual([]);
  }

  it("a share nobody can be identified behind: asked of Sequoia — plainly, with Scooter's job named, never the essay", async () => {
    await closeAll();
    await siteJob("Top Barz entry page", "Hey!\n\nWe need an entry page on westpeekproductions.com for the Top Barz contest.", "voting.topbarz.xyz");
    const title = "Official Rules - Top Barz CultureCon Song Contest - Draft III";
    await share(title, "1UnknownSharerDocAAAAAAAAAAAAAAAAAAAAAAAA", { replyTo: null });
    const routing = await one<{ id: string; title: string; kind: string | null; owner_id: string | null; state: string; work_attempts: number; firm_scope: string; requested_by_email: string | null }>("SELECT * FROM work_card WHERE title LIKE 'Unclear email:%' ORDER BY created_at DESC LIMIT 1");
    expect(routing, "nobody identified → the can't-place question").not.toBeNull();
    // Porter's loop decides it cannot place it and asks — exactly what happened at 13:44Z, essay included.
    await blockCard(env, routing!, { reason: "a_question_for_you", trying: routing!.title, employee: "Porter", who: "SEQUOIA", detail: "I have nothing in the record about Top Barz or CultureCon. Two readings: Ventures or Productions…" });
    const sentBefore = sent.length;
    await announceOutcome(env, { ...routing!, state: "BLOCKED" }, "BLOCKED", "I have nothing in the record about Top Barz or CultureCon. Two readings: Ventures or Productions…");
    const mail = sent.slice(sentBefore).find((m) => m.to === SEQUOIA);
    expect(mail, "the question went out").toBeTruthy();
    check(mail!.subject, mail!.text, `Document shared with you: "${title}"`);
    expect(mail!.text).toMatch(/from Google share notice, sharer unknown: a shared Google document, "Official Rules/);
    expect(mail!.text, "Scooter's open job is named as a reply").toMatch(/Reply 'top barz' to add it to Scooter's .*voting\.topbarz\.xyz/);
    expect(mail!.text, "the original is quoted below").toMatch(/> I've shared an item with you:/);
  });

  it("the builder keeps every subject whole-worded and every first line factual", () => {
    for (const subject of ['Document shared with you: "Official Rules - Top Barz CultureCon Song Contest - Draft II"', "Buttons", "A very long subject line that keeps going well past the room the subject has left"]) {
      const q = cantPlaceEmail({ subject, receivedAt: "2026-10-09T13:29:38.813Z", fromLabel: "you", whatItIs: `"${subject}"`, options: [{ reply: "1", does: "x" }, { reply: "2", does: "y" }, { reply: "new", does: "z" }, { reply: "drop", does: "w" }], original: "hi" });
      const r = renderExecEmail(q);
      check(r.subject, r.text, subject);
      expect(r.text).toMatch(/at 8:29 AM CT/);
    }
    expect(shortSubject("Buttons", "I got an email I can't place — ")).toBe("Buttons");
  });
});
