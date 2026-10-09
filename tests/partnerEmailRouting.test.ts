import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { blockCard, answerBlock, restoreBlock } from "../src/worker/services/blocks";
import { handleInboundEmail } from "../src/worker/effects/inboundEmail";
import { handleReingestStoredEmail } from "../src/worker/services/webPropertyChange";
import { resolveStaleClarifications, readClarificationAnswer, siteCardDecision, withoutSignatures } from "../src/worker/services/emailRouting";
import { loadProfile, profileBlockFor, refreshAllWorkingOn, refreshWorkingOn, writeProfile } from "../src/worker/services/partnerProfile";
import { practicesForCard } from "../src/worker/services/partnerConstraints";
import { profileLineProblem, stripPersonalDetails } from "../src/shared/partners/profileFilter";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { threadReference } from "../src/shared/email/thread";
import { WEB_PROPERTY_CHANGE_KIND } from "../src/shared/work/localJobs";

/**
 * EVERY PARTNER EMAIL LANDS IN ONE RIGHT PLACE (9 Oct 2026; owner-approved rules 1a–1e, 2, 3, 4).
 *
 * THE INCIDENTS THIS PINS, each proven against the code that does the routing, never against prose:
 *   1 · Scooter's spam card was BLOCKED on his preview; his NEW email "New site build:
 *       voting.topbarz.xyz/entry" was recorded as its answer — block cleared, build queued on the wrong
 *       site, the reminder clock wiped.
 *   2 · Re-reading that stored email CANCELLED the spam card as "superseded".
 *   3 · Two re-reads two seconds apart made two cards and sent him two "Got it" emails.
 * And the burst the rules exist for: six mixed emails inside a few minutes — replies to two different
 * cards, a request for another known site, a request for a site nobody registered, a pocket "Sent from
 * my iPhone", and one nobody could place — each landing on the right card, a new card, or one
 * clarifying email.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string; text: string; headers?: Record<string, string> }> = [];

const SCOOTER = "scooter@westpeek.ventures";
const SEQUOIA = "seq.taylor@gmail.com";
const GOOD_AUTH = `mx.cloudflare.net; spf=pass smtp.mailfrom=${SCOOTER}; dkim=pass header.d=westpeek.ventures; dmarc=pass`;

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
/** A message from Scooter's Gmail, delivered through the real door. Returns its Message-ID. */
async function deliver(subject: string, body: string, opts: { inReplyTo?: string | null; messageId?: string } = {}): Promise<string> {
  const messageId = opts.messageId ?? `burst-${Date.now()}-${++seq}@mail.gmail.com`;
  const head = [
    `From: Scooter Taylor <${SCOOTER}>`,
    "To: os@joinwestpeek.com",
    `Subject: ${subject}`,
    `Message-ID: <${messageId}>`,
    `Authentication-Results: ${GOOD_AUTH}`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`] : []),
  ];
  const raw = [...head, "", body].join("\r\n");
  const bytes = new TextEncoder().encode(raw);
  const headers = new Headers({ from: `Scooter Taylor <${SCOOTER}>`, to: "os@joinwestpeek.com", subject, "message-id": `<${messageId}>`, "authentication-results": GOOD_AUTH });
  if (opts.inReplyTo) {
    headers.set("in-reply-to", opts.inReplyTo);
    headers.set("references", opts.inReplyTo);
  }
  await handleInboundEmail({ from: SCOOTER, to: "os@joinwestpeek.com", headers, raw: new Blob([bytes]).stream(), rawSize: bytes.byteLength }, env);
  return messageId;
}

const one = <T>(sql: string, ...binds: unknown[]) => env.WP_OS_DB.prepare(sql).bind(...binds).first<T>();
const all = async <T>(sql: string, ...binds: unknown[]) => (await env.WP_OS_DB.prepare(sql).bind(...binds).all<T>()).results ?? [];
const cardCount = async () => (await one<{ n: number }>("SELECT COUNT(*) AS n FROM work_card"))!.n;
const card = (id: string) => one<{ id: string; state: string; title: string; block_answer: string | null; block_answered_at: string | null; block_nag_at: string | null; merged_into_card_id: string | null }>("SELECT * FROM work_card WHERE id = ?1", id);
const lastNote = async (id: string) => (await one<{ body: string }>("SELECT body FROM work_card_note WHERE work_card_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1", id))?.body ?? "";
async function tokenFor(cardId: string): Promise<string> {
  const row = await one<{ token: string }>("SELECT token FROM email_thread WHERE object_id = ?1 AND to_address = ?2 ORDER BY created_at DESC LIMIT 1", cardId, SCOOTER);
  expect(row?.token, `card ${cardId} has a conversation with Scooter`).toMatch(/^wpt_/);
  return threadReference(row!.token);
}
async function porterCardFrom(chiefId: string): Promise<string> {
  const chief = await one<{ description: string }>("SELECT description FROM work_card WHERE id = ?1", chiefId);
  const m = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(chief?.description ?? "");
  expect(m, "the chief handed the site change to Porter").not.toBeNull();
  return m![1]!;
}
async function openSiteJob(subject: string, body: string): Promise<string> {
  const chiefId = await openAssignmentCard(env, { subject, partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: [`From: Scooter Taylor <${SCOOTER}>`, `Subject: ${subject}`, "", body].join("\n"), limits: EMAILED_TASK_LIMITS, emlKey: null });
  return porterCardFrom(chiefId);
}
async function blockOnScooter(id: string): Promise<void> {
  const row = (await one<{ id: string; title: string; firm_scope: string }>("SELECT id, title, firm_scope FROM work_card WHERE id = ?1", id))!;
  await blockCard(env, row, { reason: "tried_and_could_not_finish", trying: row.title, employee: "Porter", who: "SCOOTER" });
}
async function closeAllOpenSiteCards(): Promise<void> {
  // Every job of his still open — the website cards and the intake cards that opened them — so each case starts clean.
  await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE lower(requested_by_email) = ?1 AND state NOT IN ('DONE','CANCELLED')").bind(SCOOTER).run();
}
const newCardsSince = (iso: string) => all<{ id: string; title: string; kind: string | null }>("SELECT id, title, kind FROM work_card WHERE created_at >= ?1 ORDER BY created_at", iso);

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
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; headers?: Record<string, string> };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text, headers: body.headers });
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

describe("a burst of six mixed emails inside a few minutes: each lands on the right card, a new card, or one clarifying email", () => {
  let spam = "";
  let community = "";

  it("two open jobs: the westpeek.ventures spam fix BLOCKED on Scooter, the community site open", async () => {
    spam = await openSiteJob("Spam on the Ventures form", "Hey! Instinct took a look at the spam coming through the westpeek.ventures form. Can we stop it?");
    community = await openSiteJob("Community site refresh", "Hey Porter! Please refresh the community site (joinwestpeek.com): new nav and the episodes grid.");
    await blockOnScooter(spam);
    expect((await card(spam))?.state).toBe("BLOCKED");
    expect((await card(community))?.state).not.toBe("BLOCKED");
  });

  it("delivers the burst and every email lands where it belongs", async () => {
    const startedAt = new Date().toISOString();
    const before = await cardCount();
    const sentBefore = sent.length;
    const spamRef = await tokenFor(spam);
    const communityRef = await tokenFor(community);
    const spamNagBefore = (await card(spam))!.block_nag_at;

    // 1 · A REPLY to the spam card's own thread: it IS the answer to that card's block (rule 1a).
    await deliver("Re: Porter: Spam on the Ventures form", "Looks good. Also block the .ru addresses.\r\n\r\nSent from my iPhone", { inReplyTo: spamRef });
    // 2 · A REPLY to the community card's thread: a note on THAT card, nowhere else.
    await deliver("Re: Porter: Community site refresh", "Make the hero bigger please.", { inReplyTo: communityRef });
    // 3 · A NEW email for another KNOWN site: a new job, never a follow-up on either open card.
    await deliver("Productions reel page", "Hey Porter! Add a reel page to westpeekproductions.com with the three trailers.");
    // 4 · A NEW email for a site NOBODY REGISTERED: a new job (no closed list).
    await deliver("New site build: voting.topbarz.xyz/entry", "Hey!\r\n\r\nWe need a page at voting.topbarz.xyz/entry for the Top Barz contest. Keep it simple.");
    // 5 · An EMPTY reply from his phone: steers nothing, opens nothing.
    const notesBefore = (await one<{ n: number }>("SELECT COUNT(*) AS n FROM work_card_note"))!.n;
    await deliver("Re: Porter: Community site refresh", "\r\nSent from my iPhone", { inReplyTo: communityRef });
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM work_card_note"))!.n, "an empty email leaves no note anywhere").toBe(notesBefore);
    // 6 · An AMBIGUOUS new email: four open jobs, no site named, no words that match one.
    const ambiguous = await deliver("Buttons", "Hey Porter!\r\n\r\nCan you make the buttons bigger and bolder?");

    // ── 1 ── answered by its own reply; the reply is the block's answer.
    const s = (await card(spam))!;
    expect(s.state, "the spam card's own reply answered it").toBe("OPEN");
    expect(s.block_answer).toMatch(/block the \.ru addresses/);
    // ── 2 ──
    expect(await lastNote(community)).toMatch(/Make the hero bigger/);
    // ── 3 + 4 ── two new jobs, one each; neither email touched the open cards.
    const created = await newCardsSince(startedAt);
    const titles = created.map((c) => c.title).join(" | ");
    expect(titles, "the Productions request opened its own job").toMatch(/westpeekproductions\.com|reel page/i);
    expect(titles, "the Top Barz request opened its own job").toMatch(/voting\.topbarz\.xyz/);
    expect(await lastNote(community), "nothing from the new requests landed on the community card").not.toMatch(/reel page|topbarz/i);
    expect(s.block_answer, "and nothing from them answered the spam card").not.toMatch(/reel|topbarz/i);
    // ── 6 ── one clarifying email, no card.
    const clar = await one<{ id: string; candidates_json: string; sent: number }>("SELECT id, candidates_json, sent FROM inbound_clarification WHERE message_id = ?1", ambiguous);
    expect(clar, "Porter asked which job the ambiguous email is for").not.toBeNull();
    expect(clar!.sent).toBe(1);
    const asked = sent.slice(sentBefore).filter((m) => m.to === SCOOTER && /^Porter: I got an email I can't place — Buttons$/.test(m.subject));
    expect(asked.length, "exactly ONE clarifying email").toBe(1);
    // The plain shape (9 Oct 2026 hostile review): the fact first, at most three replies, the original below.
    expect(asked[0]!.text).toMatch(/^\*\*TL;DR:\*\* I got the following at \d{1,2}:\d{2} [AP]M CT from you: "Buttons"\. I don't know which of your jobs it is for\./);
    const replies = asked[0]!.text.split("\n").filter((l) => /^• Reply '/.test(l));
    expect(replies.length, "at most three replies, the way out among them").toBeLessThanOrEqual(3);
    expect(replies.join("\n")).toMatch(/Reply '(?:\*\*)?1(?:\*\*)?' to add it to your .+ job[\s\S]*Reply 'new' to start it as a new job/);
    expect(replies.join("\n"), "each candidate is named by what he asked for and its site, never by his greeting").not.toMatch(/your Hey\b/);
    expect(asked[0]!.text, "the original is quoted below").toMatch(/> Hey Porter!/);
    expect(created.every((c) => !/buttons/i.test(c.title)), "the ambiguous email opened no card").toBe(true);
    // Six emails, two new jobs (each a Walker intake handed to a Porter card) and nothing else.
    expect(await cardCount()).toBe(before + created.length);
    expect(created.filter((c) => /^From scooter@/.test(c.title)).map((c) => c.title).sort(), "exactly two new requests opened: the two new sites, nothing for the replies, the empty email or the ambiguous one").toEqual([
      "From scooter@westpeek.ventures: New site build: voting.topbarz.xyz/entry",
      "From scooter@westpeek.ventures: Productions reel page",
    ]);
    expect(spamNagBefore).not.toBeNull();

    // THE SAME AMBIGUOUS EMAIL AGAIN (a re-delivery): never a second question.
    await env.WP_OS_DB.prepare("DELETE FROM inbound_email_seen WHERE message_id = ?1").bind(ambiguous).run();
    await deliver("Buttons", "Hey Porter!\r\n\r\nCan you make the buttons bigger and bolder?", { messageId: ambiguous });
    expect(sent.filter((m) => m.to === SCOOTER && /^Porter: I got an email I can't place — Buttons$/.test(m.subject)).length, "never asked twice about the same email").toBe(1);

    // HIS ANSWER ROUTES IT: the number of the community card, on the clarifying email's own thread.
    const candidates = JSON.parse(clar!.candidates_json) as Array<{ cardId: string }>;
    expect(candidates.length, "the two jobs shown are the two he can answer with").toBe(2);
    const target = candidates.some((c) => c.cardId === community) ? community : candidates[0]!.cardId;
    const n = candidates.findIndex((c) => c.cardId === target) + 1;
    const clarThread = await one<{ token: string }>("SELECT token FROM email_thread WHERE object_type = 'inbound_clarification' AND object_id = ?1", clar!.id);
    const cardsBeforeAnswer = await cardCount();
    await deliver("Re: Porter: Which job is \"Buttons\" for?", `${n}\r\n\r\nSent from my iPhone`, { inReplyTo: threadReference(clarThread!.token) });
    expect(await lastNote(target), "the ambiguous email landed on the card he named").toMatch(/buttons bigger and bolder/);
    expect(await cardCount(), "and opened nothing").toBe(cardsBeforeAnswer);
    expect((await one<{ resolution: string }>("SELECT resolution FROM inbound_clarification WHERE id = ?1", clar!.id))?.resolution).toBe("CARD");
  });

  it("no answer in 24 hours → a new card, once", async () => {
    const msg = await deliver("Colors", "Hey Porter!\r\n\r\nWarmer colors everywhere please.");
    const clar = await one<{ id: string }>("SELECT id FROM inbound_clarification WHERE message_id = ?1", msg);
    expect(clar, "asked").not.toBeNull();
    const before = await cardCount();
    expect(await resolveStaleClarifications(env, new Date()), "not before 24 hours").toBe(0);
    expect(await resolveStaleClarifications(env, new Date(Date.now() + 25 * 3_600_000))).toBe(1);
    expect(await cardCount(), "the email became a new job").toBeGreaterThan(before);
    expect((await one<{ resolution: string }>("SELECT resolution FROM inbound_clarification WHERE id = ?1", clar!.id))?.resolution).toBe("TIMED_OUT");
    const after = await cardCount();
    expect(await resolveStaleClarifications(env, new Date(Date.now() + 50 * 3_600_000)), "never twice").toBe(0);
    expect(await cardCount()).toBe(after);
  });

  it("the answer reader: a number, a site, \"new\", and nothing readable", () => {
    const c = [
      { cardId: "wc_a", label: "Spam on the Ventures form · westpeek.ventures", host: "westpeek.ventures" },
      { cardId: "wc_b", label: "Community site refresh · joinwestpeek.com", host: "joinwestpeek.com" },
    ];
    expect(readClarificationAnswer("2\n\nSent from my iPhone", c)).toEqual({ cardId: "wc_b" });
    expect(readClarificationAnswer("the joinwestpeek.com one", c)).toEqual({ cardId: "wc_b" });
    expect(readClarificationAnswer("New", c)).toBe("NEW");
    expect(readClarificationAnswer("it's a new one", c)).toBe("NEW");
    expect(readClarificationAnswer("spam", c)).toEqual({ cardId: "wc_a" });
    expect(readClarificationAnswer("hmm", c)).toBeNull();
    expect(withoutSignatures("\nSent from my iPhone\n")).toBe("");
    expect(withoutSignatures("Yes\n\nSent from my iPhone")).toBe("Yes");
  });
});

describe("the three incidents of 8–9 Oct 2026", () => {
  it("1 · a NEW email naming another site never answers a BLOCKED card; its reminder clock is untouched", async () => {
    await closeAllOpenSiteCards();
    const spam = await openSiteJob("Spam on the Ventures form", "Hey! Instinct took a look at the spam coming through the westpeek.ventures form.");
    await blockOnScooter(spam);
    const nag = (await card(spam))!.block_nag_at;
    const startedAt = new Date().toISOString();
    await deliver("New site build: voting.topbarz.xyz/entry", "Hey!\r\n\r\nWe need a page at voting.topbarz.xyz/entry for the Top Barz contest.");
    const s = (await card(spam))!;
    expect(s.state, "still waiting on Scooter").toBe("BLOCKED");
    expect(s.block_answer, "never recorded as the answer").toBeNull();
    expect(s.block_nag_at, "the reminder clock is untouched").toBe(nag);
    const nc = await newCardsSince(startedAt);
    expect(nc.map((c) => c.title).join(" | "), "the new build got its own card").toMatch(/voting\.topbarz\.xyz/);
  });

  it("1 · …even when he does not write the host: the profile knows \"Top Barz\" is voting.topbarz.xyz", async () => {
    await closeAllOpenSiteCards();
    await writeProfile(env, SCOOTER, { aliases: [{ host: "voting.topbarz.xyz", words: ["top barz", "topbarz", "culturecon"] }] });
    const spam = await openSiteJob("Spam on the Ventures form", "Hey! Instinct took a look at the spam coming through the westpeek.ventures form.");
    await blockOnScooter(spam);
    const message = { fromHeader: `Scooter Taylor <${SCOOTER}>`, authenticationResults: GOOD_AUTH, subject: "Top Barz entry page", raw: ["Subject: Top Barz entry page", "", "Hey Porter! The Top Barz entry page needs the rules link."].join("\n") };
    const d = await siteCardDecision(env, message);
    expect(d.kind, "his one open job is a different site: a new job").toBe("NEW");
    // The same words without the profile alias would have joined his one open job — the profile is what tells them apart.
    await writeProfile(env, SCOOTER, { aliases: [] });
    expect((await siteCardDecision(env, message)).kind).toBe("JOIN");
    await writeProfile(env, SCOOTER, { aliases: [{ host: "voting.topbarz.xyz", words: ["top barz", "topbarz", "culturecon"] }] });
  });

  it("2 · a re-read of that email puts the wrongly answered block BACK — never cancels the card — with its reminder", async () => {
    await closeAllOpenSiteCards();
    const spam = await openSiteJob("Spam on the Ventures form", "Hey! Instinct took a look at the spam coming through the westpeek.ventures form.");
    await blockOnScooter(spam);
    await env.WP_OS_DB.prepare("UPDATE work_card SET created_at = '2026-10-08T19:32:38.429Z' WHERE id = ?1").bind(spam).run();
    // What the old door did on 9 Oct: the new email recorded as the block's answer, through the real door.
    const key = `inbound-email/2026-10-09/${crypto.randomUUID()}.eml`;
    const raw = [`From: Scooter Taylor <${SCOOTER}>`, "To: os@joinwestpeek.com", "Subject: New site build: voting.topbarz.xyz/entry", `Message-ID: <${crypto.randomUUID()}@mail.gmail.com>`, `Authentication-Results: ${GOOD_AUTH}`, "", "Hey!\r\n\r\nWe need a page at voting.topbarz.xyz/entry for the Top Barz contest."].join("\r\n");
    await (env.WP_OS_DOCUMENTS as unknown as { put: (k: string, b: string) => Promise<unknown> }).put(key, raw);
    await new Promise((r) => setTimeout(r, 5));
    await env.WP_OS_DB.prepare("INSERT INTO inbound_message (id, message_id, r2_key, from_address, to_address, subject, received_at, bytes, mail_authority_json, work_card_id, firm_scope) VALUES (?1, ?2, ?3, ?4, 'os@joinwestpeek.com', 'New site build: voting.topbarz.xyz/entry', ?5, 1, '{}', ?6, 'west-peek')")
      .bind(`inm_${crypto.randomUUID()}`, `${crypto.randomUUID()}@mail.gmail.com`, key, SCOOTER, new Date().toISOString(), spam)
      .run();
    await answerBlock(env, spam, "fu_scooter_taylor", { action: "ANSWER", text: "We need a page at voting.topbarz.xyz/entry" });
    const wrong = (await card(spam))!;
    expect(wrong.state).toBe("OPEN");
    expect(wrong.block_answer).not.toBeNull();

    const res = await handleReingestStoredEmail({
      request: new Request("https://os.joinwestpeek.com/api/inbound-email/reingest", { method: "POST", body: JSON.stringify({ object_key: key }) }),
      env,
      identity: { id: "fu_sequoia_taylor", email: SEQUOIA, fullName: "Sequoia Taylor", status: "ACTIVE", roles: ["MANAGING_PARTNER"], authorityScopes: [] },
      params: {},
    });
    const body = (await res.json()) as { superseded: string[]; new_card: string | null };
    expect(body.superseded, "the card it was wrongly attached to is not one it opened").not.toContain(spam);
    const s = (await card(spam))!;
    expect(s.state, "BLOCKED on his preview again").toBe("BLOCKED");
    expect(s.block_answer, "the wrong answer is gone").toBeNull();
    expect(s.block_answered_at).toBeNull();
    expect(s.block_nag_at, "and the reminder clock runs again").not.toBeNull();
    expect(Date.parse(s.block_nag_at!)).toBeGreaterThan(Date.now());
    expect(body.new_card, "the request got its own card").not.toBeNull();
    expect(body.new_card).not.toBe(spam);
  });

  it("3 · two re-reads of one message seconds apart make ONE card and send ONE \"Got it\"", async () => {
    await closeAllOpenSiteCards();
    const key = `inbound-email/2026-10-09/${crypto.randomUUID()}.eml`;
    const raw = [`From: Scooter Taylor <${SCOOTER}>`, "To: os@joinwestpeek.com", "Subject: New site build: voting.topbarz.xyz/entry", `Message-ID: <${crypto.randomUUID()}@mail.gmail.com>`, `Authentication-Results: ${GOOD_AUTH}`, "", "Hey!\r\n\r\nWe need a page at voting.topbarz.xyz/entry for the Top Barz contest."].join("\r\n");
    await (env.WP_OS_DOCUMENTS as unknown as { put: (k: string, b: string) => Promise<unknown> }).put(key, raw);
    const reread = () =>
      handleReingestStoredEmail({
        request: new Request("https://os.joinwestpeek.com/api/inbound-email/reingest", { method: "POST", body: JSON.stringify({ object_key: key }) }),
        env,
        identity: { id: "fu_sequoia_taylor", email: SEQUOIA, fullName: "Sequoia Taylor", status: "ACTIVE", roles: ["MANAGING_PARTNER"], authorityScopes: [] },
        params: {},
      });
    const sentBefore = sent.length;
    const startedAt = new Date().toISOString();
    const [a, b] = await Promise.all([reread(), reread()]);
    expect([a.status, b.status].sort(), "one read ran, the other was refused").toEqual([200, 409]);
    const refused = (await (a.status === 409 ? a : b).json()) as { error?: string };
    expect(refused.error, "refused BECAUSE a re-read of the same message was already running").toBe("already_rereading");
    const created = (await newCardsSince(startedAt)).filter((c) => /voting\.topbarz\.xyz/.test(c.title));
    expect(created.length, "one card for the request").toBe(1);
    const toHim = sent.slice(sentBefore).filter((m) => m.to === SCOOTER).map((m) => m.subject);
    expect(toHim.length, "no email of the pair was sent twice").toBe(new Set(toHim).size);
    // And once the window has passed, a deliberate re-read is allowed again.
    await env.WP_OS_DB.prepare("UPDATE inbound_reingest_claim SET claimed_at = '2026-01-01T00:00:00.000Z' WHERE object_key = ?1").bind(key).run();
    expect((await reread()).status).not.toBe(409);
  });

  it("3 · the same message delivered twice at once (a mail retry, a second listener) is read once", async () => {
    await closeAllOpenSiteCards();
    const startedAt = new Date().toISOString();
    const sentBefore = sent.length;
    const id = `twice-${crypto.randomUUID()}@mail.gmail.com`;
    await Promise.all([
      deliver("Productions press page", "Hey Porter! Add a press page to westpeekproductions.com.", { messageId: id }),
      deliver("Productions press page", "Hey Porter! Add a press page to westpeekproductions.com.", { messageId: id }),
    ]);
    const created = (await newCardsSince(startedAt)).filter((c) => /^From scooter@/.test(c.title));
    expect(created.length, "one intake card").toBe(1);
    const events = await all<{ n: number }>("SELECT COUNT(*) AS n FROM event_record WHERE created_at >= ?1 AND event_type IN ('inbound_email.received', 'inbound_email.unrouted')", startedAt);
    expect(events[0]!.n, "the door ran once").toBe(1);
    const toHim = sent.slice(sentBefore).filter((m) => m.to === SCOOTER).map((m) => m.subject);
    expect(toHim.length, "no email sent twice").toBe(new Set(toHim).size);
  });

  it("1a · a reply to a card that was merged away steers the card it was merged into", async () => {
    await closeAllOpenSiteCards();
    const survivor = await openSiteJob("Spam on the Ventures form", "Hey! Instinct took a look at the spam coming through the westpeek.ventures form.");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(survivor).run();
    const twin = await openSiteJob("Ventures form spam again", "Hey Porter! The westpeek.ventures form is still getting spam.");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'OPEN' WHERE id = ?1").bind(survivor).run();
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED', merged_into_card_id = ?2 WHERE id = ?1").bind(twin, survivor).run();
    await deliver("Re: Porter: Ventures form spam again", "Use a honeypot field too.", { inReplyTo: await tokenFor(twin) });
    expect(await lastNote(survivor), "the reply reached the live card").toMatch(/honeypot/);
    expect(await lastNote(twin)).not.toMatch(/honeypot/);
  });

  it("3 · a BLOCKED card can never be left without a reminder time (any write, any path)", async () => {
    const id = await openSiteJob("Ventures footer", "Hey Porter! Fix the footer on westpeek.ventures.");
    await blockOnScooter(id);
    await env.WP_OS_DB.prepare("UPDATE work_card SET block_nag_at = NULL WHERE id = ?1").bind(id).run();
    expect((await card(id))!.block_nag_at, "the database puts the reminder back").not.toBeNull();
    // restoreBlock sets it explicitly, from now.
    await answerBlock(env, id, "fu_scooter_taylor", { action: "ANSWER", text: "go" });
    expect(await restoreBlock(env, id, "test")).toBe(true);
    const r = (await card(id))!;
    expect(r.state).toBe("BLOCKED");
    expect(r.block_answer).toBeNull();
    expect(Date.parse(r.block_nag_at!)).toBeGreaterThan(Date.now());
    const stuck = await one<{ n: number }>("SELECT COUNT(*) AS n FROM work_card WHERE state = 'BLOCKED' AND block_nag_at IS NULL");
    expect(stuck!.n, "no BLOCKED card anywhere without a reminder").toBe(0);
  });
});

describe("partner profiles (0255): living, in D1, never LP or deal detail", () => {
  it("the filter refuses LP names, deal terms, fund details and amounts — and keeps his own projects", () => {
    expect(profileLineProblem("open: Top Barz entry page · voting.topbarz.xyz")).toBeNull();
    expect(profileLineProblem("Runs West Peek Productions and the Top Barz contest at CultureCon")).toBeNull();
    for (const bad of ["Talk to the LPs about Q4", "limited partner update", "capital call next week", "term sheet from Acme", "$2M pre-money", "carried interest split", "Fund II close", "secondaries pipeline", "#wpdealflow Acme Robotics", "raise 5m"]) {
      expect(profileLineProblem(bad), bad).not.toBeNull();
    }
    expect(profileLineProblem("lunch with Northwind Family Office", ["Northwind Family Office"]), "an LP on record by name").not.toBeNull();
  });

  it("a write carrying fund detail is refused whole; an LP on record is refused by name", async () => {
    await env.WP_OS_DB.prepare("INSERT INTO lp_record (id, legal_name, lp_type, created_by) VALUES ('lp_test_1', 'Northwind Holdings', 'FAMILY_OFFICE', 'fu_sequoia_taylor')").run();
    const out = await writeProfile(env, SCOOTER, {
      who: "Managing Partner of West Peek; runs West Peek Productions (westpeekproductions.com) and the Top Barz contest (voting.topbarz.xyz).",
      writes_like: "Short emails from his iPhone, a new subject per ask, often several in a row.",
      usually_asks: "Changes to westpeek.ventures, joinwestpeek.com and the Top Barz voting site.",
      notes: ["Prefers previews before anything goes live", "Northwind Holdings wants the deck"],
      working_on: [{ body: "Fund II close with the LPs" }, { body: "Top Barz entry page", at: new Date().toISOString() }, { body: "an old thing", at: new Date(Date.now() - 40 * 86_400_000).toISOString() }],
    });
    expect(out.refused.length, "the LP note and the fund line were refused").toBeGreaterThanOrEqual(2);
    const p = (await loadProfile(env, SCOOTER))!;
    const everything = JSON.stringify(p);
    expect(everything).not.toMatch(/Northwind|Fund II|LPs/);
    expect(p.who).toMatch(/Top Barz/);
    expect(p.notes.map((n) => n.body)).toContain("Prefers previews before anything goes live");
    expect(p.workingOn.map((w) => w.body), "a line idle for 30 days drops off").not.toContain("an old thing");
    expect(p.workingOn.map((w) => w.body)).toContain("Top Barz entry page");
  });

  it("\"Porter, note: …\" is stored verbatim and opens nothing; every email refreshes \"working on now\"", async () => {
    const before = await cardCount();
    await deliver("note", "Porter, note: voting closes Sunday night, keep the vote page fast\r\n\r\nSent from my iPhone");
    expect(await cardCount(), "a note opens no card").toBe(before);
    const p = (await loadProfile(env, SCOOTER))!;
    expect(p.notes.map((n) => n.body)).toContain("voting closes Sunday night, keep the vote page fast");
    expect(await refreshWorkingOn(env, SCOOTER)).toBeGreaterThan(0);
    expect((await loadProfile(env, SCOOTER))!.workingOn.some((w) => /^(open|finished): /.test(w.body)), "his cards are dated working-on lines").toBe(true);
  });

  // 9 Oct 2026: the title production held (the candidate's real name replaced; the repo is public).
  const HIRE_TITLE = "Walker: follow up on Scooter's W39 hire-search reply — Jane Example's email, music-affinity criterion";
  const HIRE_KEPT = "finished: Walker: follow up on Scooter's W39 hire-search reply — music-affinity criterion";
  // The refresh names the job by its shortened title ("…"), so the cut leaves no dangling separator.
  const HIRE_REFRESHED = "finished: Walker: follow up on Scooter's W39 hire-search reply";
  const KEEP = { keepEmails: [SCOOTER], keepNames: ["Scooter", "Walker"] };

  it("a third party's personal details are cut out, the line kept: the production hire-search line keeps its context without the candidate", () => {
    expect(stripPersonalDetails(`finished: ${HIRE_TITLE}`, KEEP)).toBe(HIRE_KEPT);
    expect(profileLineProblem(HIRE_KEPT), "the hire search itself is legitimate working-on context").toBeNull();
    expect(stripPersonalDetails("finished: Walker: follow up on Scooter's W39 hire-search reply — Jane Example's email", KEEP)).toBe("finished: Walker: follow up on Scooter's W39 hire-search reply");
    expect(stripPersonalDetails("open: write to Jane Doe <jane.doe@gmail.com> about the shoot", KEEP)).toBe("open: write to about the shoot");
    expect(stripPersonalDetails("open: email Jane Doe jane@x.com, then the deck", KEEP)).toBe("open: email, then the deck");
    expect(stripPersonalDetails("finished: Walker: follow up on Scooter's W39 hire-search reply — Jane Example's email…", KEEP), "the shortened title production held").toBe(HIRE_REFRESHED);
    expect(stripPersonalDetails("open: call Jane at +1 (917) 555-0134 tomorrow", KEEP)).toBe("open: call Jane at tomorrow");
    for (const untouched of ["open: Top Barz entry page · voting.topbarz.xyz", "open: Top Barz W41 voting closes 2026-10-12", `send it from ${SCOOTER}`, "Scooter's email signature on westpeek.ventures"]) {
      expect(stripPersonalDetails(untouched, KEEP), untouched).toBe(untouched);
    }
    expect(profileLineProblem(stripPersonalDetails("Talk to the LPs about Q4 — Jane Example's email", KEEP)), "an LP line is still refused whole").not.toBeNull();
  });

  it("the hourly refresh writes the hire-search line without the candidate, rewrites a stored line clean, keeps Top Barz untouched and still refuses an LP card", async () => {
    const card = (id: string, title: string) =>
      env.WP_OS_DB.prepare(
        "INSERT INTO work_card (id, title, description, owner_type, owner_id, state, priority, privacy_label, firm_scope, requested_by_email, created_by, kind) VALUES (?1, ?2, 'x', 'AI', 'aie_walker', 'DONE', 'NORMAL', 'INTERNAL', 'west-peek', ?3, 'test', NULL)",
      ).bind(id, title, SCOOTER).run();
    await card("wc_t_hire_followup", HIRE_TITLE);
    await card("wc_t_topbarz", "Top Barz voting page faster before Sunday");
    await card("wc_t_lp", "Send the LP letter to Northwind");
    // A line stored before the rule existed, carrying a third party's address.
    await env.WP_OS_DB.prepare("INSERT INTO partner_profile_line (id, partner_email, firm_scope, kind, body, last_active_at) VALUES ('ppl_t_old', ?1, 'west-peek', 'WORKING_ON', 'shoot with Jane Doe <jane.doe@gmail.com> for Productions', ?2)")
      .bind(SCOOTER, new Date().toISOString()).run();

    await refreshAllWorkingOn(env);
    const body = async (where: string) => (await env.WP_OS_DB.prepare(`SELECT body FROM partner_profile_line WHERE partner_email = ?1 AND ${where}`).bind(SCOOTER).first<{ body: string }>())?.body ?? null;
    expect(await body("card_id = 'wc_t_hire_followup'")).toBe(HIRE_REFRESHED);
    expect(await body("card_id = 'wc_t_topbarz'")).toBe("finished: Top Barz voting page faster before Sunday");
    expect(await body("card_id = 'wc_t_lp'"), "an LP card is still refused").toBeNull();
    expect(await body("id = 'ppl_t_old'"), "a stored line is rewritten clean").toBe("shoot with for Productions");
    const all = JSON.stringify((await env.WP_OS_DB.prepare("SELECT body FROM partner_profile_line WHERE partner_email = ?1").bind(SCOOTER).all()).results);
    expect(all).not.toMatch(/Jane|jane\.doe|gmail/);
    expect((await loadProfile(env, SCOOTER))!.workingOn.map((w) => w.body)).toContain(HIRE_REFRESHED);
  });

  it("every job prompt for him carries the profile; Porter's build brief included", async () => {
    const id = await openSiteJob("Ventures hero", "Hey Porter! New hero photo on westpeek.ventures.");
    const block = await practicesForCard(env, id);
    expect(block).toMatch(/PARTNER PROFILE — Scooter/);
    expect(block).toMatch(/top barz.* = voting\.topbarz\.xyz/);
    expect(block).not.toMatch(/Northwind|Fund II/);
    expect(await profileBlockFor(env, "stranger@example.com")).toBe("");
  });
});
