import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { createWorkCardInternal } from "../src/worker/services/workCards";
import { systemIdentity } from "../src/worker/services/dealIntake";
import { startThread, steerFromReply } from "../src/worker/services/emailThread";
import { threadReference } from "../src/shared/email/thread";
import { parseReplyIntent, type ReplyIntentReader } from "../src/worker/services/replyIntent";

/**
 * A REPLY THAT ASKS FOR A BUILD GOES TO THE BUILD DOOR (14 Nov 2026). A partner replying on a memo or a
 * deck "can you make this a dashboard" gets Porter's build job — exactly one, linked to the card he
 * replied on — and the card itself carries on as it was.
 */

let t: TestDb;
let env: Env;
const SCOOTER = "scooter@westpeek.ventures";
const AUTH = `mx.cloudflare.net; spf=pass smtp.mailfrom=${SCOOTER}; dkim=pass header.d=westpeek.ventures; dmarc=pass`;

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>);
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_porter', 'aie_walker', 'aie_wren', 'aie_wyatt')").run();
});
afterAll(async () => disposeTestDb(t));

const reads = (door: string, buildIn = "none"): ReplyIntentReader => async (_e, input) => ({ ...parseReplyIntent(`INTENT: CONTINUE\nDOOR: ${door}\nSEAT: none\nBUILD_IN: ${buildIn}\nCHANGES: none\nQUESTION: none\nREASON: test`, input.text), keyword: null, aiRunId: null });

async function replyOn(title: string, written: string, readWords: ReplyIntentReader) {
  const card = await createWorkCardInternal(env, systemIdentity(), { title, owner_type: "AI", owner_id: "aie_wyatt", firm_scope: "west-peek", priority: "NORMAL" } as never);
  await env.WP_OS_DB.prepare("UPDATE work_card SET requested_by_email = ?2 WHERE id = ?1").bind(card.id, SCOOTER).run();
  const { token } = await startThread(env, { objectType: "work_card", objectId: card.id, cardKind: "ARTIFACT", employee: "Wyatt", to: SCOOTER, subject: `Wyatt: ${title}`, firmScope: "west-peek" });
  const raw = [`From: ${SCOOTER}`, "To: os@joinwestpeek.com", `Subject: Re: Wyatt: ${title}`, "", written, "", "On Fri, 13 Nov 2026 at 09:02, Wyatt <os@westpeek.ventures> wrote:", "> Here it is."].join("\n");
  const before = await env.WP_OS_DB.prepare("SELECT state FROM work_card WHERE id = ?1").bind(card.id).first<{ state: string }>();
  const out = await steerFromReply(env, { fromHeader: `<${SCOOTER}>`, authenticationResults: AUTH, subject: `Re: Wyatt: ${title}`, raw, inReplyTo: threadReference(token), references: null, emlKey: null }, { readWords });
  const builds = (await env.WP_OS_DB.prepare("SELECT c.id, c.owner_id, c.requested_by_email, w.target_repo FROM work_card c JOIN web_property_change w ON w.work_card_id = c.id WHERE c.assigned_from_card_id = ?1").bind(card.id).all<{ id: string; owner_id: string; requested_by_email: string; target_repo: string }>()).results ?? [];
  const after = await env.WP_OS_DB.prepare("SELECT state FROM work_card WHERE id = ?1").bind(card.id).first<{ state: string }>();
  return { out, builds, before: before!.state, after: after!.state };
}

describe("a reply on a memo or deck card that asks for a build", () => {
  it("opens exactly one Porter build job, linked to the card, for the partner who asked; the memo carries on", async () => {
    const r = await replyOn("Write me a memo on Sensori Labs", "Thanks. Can you also make this a dashboard inside the OS that I can check every week?", reads("BUILD", "OS"));
    expect(r.out.steered).toBe(true);
    expect(r.builds).toHaveLength(1);
    expect(r.builds[0]).toMatchObject({ owner_id: "aie_porter", requested_by_email: SCOOTER, target_repo: "west-peek-os" });
    expect(r.after, "the card he replied on is left as it was").toBe(r.before);
  });

  it("a reply on a deck card that is not a build opens nothing", async () => {
    const r = await replyOn("Build me a deck on the Q4 pipeline", "Looks good, thanks — what's the date on slide 3?", reads("ANSWER"));
    expect(r.builds).toHaveLength(0);
  });
});

/**
 * A REPLY ON A CLOSED WEBSITE JOB THAT ASKS FOR A NEW BUILD (17 Nov 2026). Scooter's "New build for the Top Barz
 * site: a holiday party version of the booth flow" came back on the thread of October's CANCELLED voting.topbarz.xyz
 * card. Website cards skipped the build door, so it became a "question after done" notice and no build opened.
 */
async function replyOnClosedSite(state: "CANCELLED" | "DONE" | "OPEN", written: string, readWords: ReplyIntentReader) {
  const title = `Change voting.topbarz.xyz: ${state} card`;
  const card = await createWorkCardInternal(env, systemIdentity(), { title, owner_type: "AI", owner_id: "aie_porter", firm_scope: "west-peek", priority: "NORMAL" } as never);
  // State first, then kind: a finished website job's proof-of-finish trigger (0219) is not what this test is about.
  await env.WP_OS_DB.prepare("UPDATE work_card SET requested_by_email = ?2, state = ?3 WHERE id = ?1").bind(card.id, SCOOTER, state).run();
  await env.WP_OS_DB.prepare("UPDATE work_card SET kind = 'WEB_PROPERTY_CHANGE' WHERE id = ?1").bind(card.id).run();
  const { token } = await startThread(env, { objectType: "work_card", objectId: card.id, cardKind: "WEB_PROPERTY_CHANGE", employee: "Porter", to: SCOOTER, subject: "Porter: New site build: New preview ready", firmScope: "west-peek" });
  const raw = [`From: ${SCOOTER}`, "To: os@joinwestpeek.com", "Subject: Re: Porter: New site build: New preview ready", "", written, "", "On Fri, 9 Oct 2026 at 09:02, Porter <porter@joinwestpeek.com> wrote:", "> Preview ready."].join("\n");
  let readerCalls = 0;
  const counted: ReplyIntentReader = async (e, input) => { readerCalls += 1; return readWords(e, input); };
  await steerFromReply(env, { fromHeader: `<${SCOOTER}>`, authenticationResults: AUTH, subject: "Re: Porter: New site build: New preview ready", raw, inReplyTo: threadReference(token), references: null, emlKey: null }, { readWords: counted });
  const builds = (await env.WP_OS_DB.prepare("SELECT c.id, c.owner_id, c.requested_by_email FROM work_card c JOIN web_property_change w ON w.work_card_id = c.id WHERE c.assigned_from_card_id = ?1").bind(card.id).all<{ id: string; owner_id: string; requested_by_email: string }>()).results ?? [];
  const notes = (await env.WP_OS_DB.prepare("SELECT body FROM work_card_note WHERE work_card_id = ?1").bind(card.id).all<{ body: string }>()).results ?? [];
  const after = await env.WP_OS_DB.prepare("SELECT state FROM work_card WHERE id = ?1").bind(card.id).first<{ state: string }>();
  const told = (await env.WP_OS_DB.prepare("SELECT count(*) AS n FROM event_record WHERE object_id = ?1 AND event_type IN ('work_card.owner_reply_emailed', 'work_card.owner_reply_not_sent')").bind(card.id).first<{ n: number }>())!.n;
  return { builds, notes, after: after!.state, readerCalls, told };
}

describe("a reply on a closed website job", () => {
  const ask = "New build for the Top Barz site: a holiday party version of the booth flow. What already exists vs what's new build, and any red flags?";

  it("a cancelled website card's reply asking for a new build opens exactly one Porter build job; no question-after-done note", async () => {
    const r = await replyOnClosedSite("CANCELLED", ask, reads("BUILD", "EXISTING"));
    expect(r.builds).toHaveLength(1);
    expect(r.builds[0]).toMatchObject({ owner_id: "aie_porter", requested_by_email: SCOOTER });
    expect(r.notes.some((n) => /QUESTION AFTER DONE/.test(n.body))).toBe(false);
    expect(r.after, "the closed card stays closed").toBe("CANCELLED");
  });

  it("a done website card's reply asking for a build also opens one", async () => {
    const r = await replyOnClosedSite("DONE", ask, reads("BUILD", "EXISTING"));
    expect(r.builds).toHaveLength(1);
  });

  it("a closed website card's reply that asks for no build opens nothing", async () => {
    const r = await replyOnClosedSite("DONE", "Thanks, that looked great.", reads("ANSWER"));
    expect(r.builds).toHaveLength(0);
  });

  it("a live website card's reply is never read for the build door: it steers that build", async () => {
    const r = await replyOnClosedSite("OPEN", ask, reads("BUILD", "EXISTING"));
    expect(r.readerCalls).toBe(0);
    expect(r.builds).toHaveLength(0);
  });
});

/**
 * EVERY PARTNER EMAIL GETS ONE EMAIL BACK (owner's ruling, 16 Nov 2026). A reply on a closed card that asks for work
 * nothing could start, or asks a question nobody could answer, still reaches the partner once: never silence.
 */
describe("a reply on a closed card always gets one email back", () => {
  const ask = "New build for the Top Barz site: a holiday party version of the booth flow. What already exists vs what's new build, and any red flags?";
  const noBuild: ReplyIntentReader = async (e, input) => ({ ...(await reads("BUILD", "EXISTING")(e, input)), buildIn: "nowhere-mapped" } as never);

  it("a build is asked for and opens: the partner is told by the build door; no fallback email", async () => {
    const r = await replyOnClosedSite("CANCELLED", ask, reads("BUILD", "EXISTING"));
    expect(r.builds).toHaveLength(1);
    expect(r.notes.some((n) => /NEW REQUEST AFTER DONE/.test(n.body))).toBe(false);
  });

  it("a question nobody can answer on a cancelled card: exactly one email back to the partner; the card stays cancelled", async () => {
    const r = await replyOnClosedSite("CANCELLED", "Did the voting page ever get the new rules link?", reads("QUESTION"));
    expect(r.told).toBe(1);
    expect(r.after).toBe("CANCELLED");
  });

  it("a thank-you on a closed card sends nothing", async () => {
    const r = await replyOnClosedSite("DONE", "Thanks Porter!", reads("NOTHING"));
    expect(r.told).toBe(0);
  });
});

/**
 * HIS EMAIL AND ITS ASKS FOLLOW THE BUILD (16 Nov 2026). Scooter's Top Barz brief was read first (9 asks) but filed on
 * October's cancelled card, so Porter's build carried no asks and its final reply had nothing to check against.
 */
describe("a reply that opens a build moves its email and asks to the build", () => {
  it("the stored message and the asks already read from it land on Porter's new card; the old card keeps none", async () => {
    const card = await createWorkCardInternal(env, systemIdentity(), { title: "Change voting.topbarz.xyz: asks card", owner_type: "AI", owner_id: "aie_porter", firm_scope: "west-peek", priority: "NORMAL" } as never);
    await env.WP_OS_DB.prepare("UPDATE work_card SET requested_by_email = ?2, state = 'CANCELLED' WHERE id = ?1").bind(card.id, SCOOTER).run();
    await env.WP_OS_DB.prepare("UPDATE work_card SET kind = 'WEB_PROPERTY_CHANGE' WHERE id = ?1").bind(card.id).run();
    const key = "inbound-email/2026-11-17/asks-test.eml";
    await env.WP_OS_DB.prepare("INSERT INTO inbound_message (id, message_id, r2_key, from_address, received_at, work_card_id) VALUES ('inm_asks_test', '<asks-test@x>', ?1, ?2, '2026-11-17T01:09:54Z', ?3)").bind(key, SCOOTER, card.id).run();
    for (let i = 1; i <= 3; i++) await env.WP_OS_DB.prepare("INSERT INTO partner_ask (id, work_card_id, inbound_message_id, seq, words, firm_scope) VALUES (?1, ?2, 'inm_asks_test', ?3, ?4, 'west-peek')").bind(`pask_t${i}`, card.id, i, `ask ${i}`).run();
    const { token } = await startThread(env, { objectType: "work_card", objectId: card.id, cardKind: "WEB_PROPERTY_CHANGE", employee: "Porter", to: SCOOTER, subject: "Porter: New site build: New preview ready", firmScope: "west-peek" });
    const written = "New build for the Top Barz site: a holiday party version of the booth flow.";
    const raw = [`From: ${SCOOTER}`, "To: os@joinwestpeek.com", "Subject: Re: Porter: New site build: New preview ready", "", written].join("\n");
    await steerFromReply(env, { fromHeader: `<${SCOOTER}>`, authenticationResults: AUTH, subject: "Re: Porter: New site build: New preview ready", raw, inReplyTo: threadReference(token), references: null, emlKey: key }, { readWords: reads("BUILD", "EXISTING") });
    const build = await env.WP_OS_DB.prepare("SELECT id FROM work_card WHERE assigned_from_card_id = ?1").bind(card.id).first<{ id: string }>();
    expect(build).toBeTruthy();
    const msg = await env.WP_OS_DB.prepare("SELECT work_card_id FROM inbound_message WHERE id = 'inm_asks_test'").first<{ work_card_id: string }>();
    expect(msg!.work_card_id).toBe(build!.id);
    const asks = (await env.WP_OS_DB.prepare("SELECT work_card_id FROM partner_ask WHERE inbound_message_id = 'inm_asks_test'").all<{ work_card_id: string }>()).results ?? [];
    expect(asks).toHaveLength(3);
    expect(asks.every((a) => a.work_card_id === build!.id)).toBe(true);
  });
});
