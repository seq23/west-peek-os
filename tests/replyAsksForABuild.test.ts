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
  env = makeTestEnv(t.db);
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
  return { builds, notes, after: after!.state, readerCalls };
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
