import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { createWorkCardInternal } from "../src/worker/services/workCards";
import { sweepIdentity, sweepOnce } from "../src/worker/services/workSweep";
import { developerDirector, handBackCard, takeOverCard } from "../src/worker/services/developerDirection";
import { startThread, steerFromReply } from "../src/worker/services/emailThread";
import { threadReference } from "../src/shared/email/thread";
import { INTAKE_MAILBOX } from "../src/shared/intake/emailTriggers";

/**
 * A DEVELOPER TAKES A CARD OVER, AND HANDS IT BACK (owner's design, 15 Nov 2026).
 *
 * Taken over: the card never runs by itself, and a partner's reply meanwhile is filed and acted on by nothing. Handed
 * back: the employee starts from the developer's note; when every ask is done and nothing came in meanwhile the card
 * closes and waits, otherwise it goes back to work with the note and the replies filed during the takeover.
 */

let t: TestDb;
let env: Env;
const SCOOTER_FROM = "Scooter Taylor <scooter@westpeek.ventures>";
const GOOD_AUTH = "mx.cloudflare.net; spf=pass smtp.mailfrom=scooter@westpeek.ventures; dkim=pass header.d=westpeek.ventures; dmarc=none";

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>);
});
afterAll(async () => {
  await disposeTestDb(t);
});

async function card(title: string): Promise<string> {
  const c = await createWorkCardInternal(env, sweepIdentity(), { title, description: "test", owner_type: "AI", owner_id: "aie_parker", firm_scope: "west-peek" } as never);
  return (c as { id: string }).id;
}
const row = (id: string) => env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<Record<string, unknown>>();
const events = async (id: string, type: string) => Number((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE object_id = ?1 AND event_type = ?2").bind(id, type).first<{ n: number }>())!.n);

describe("a developer takeover", () => {
  it("a taken-over card never runs by itself; a hand-back resumes from the note, closes when nothing is left, and picks up replies filed meanwhile", async () => {
    const by = (await developerDirector(env, "tail:fu_sequoia_taylor"))!;
    expect(by, "the developer is on the registry").not.toBeNull();
    const ran: string[] = [];
    const runner = async (_e: Env, _c: unknown, cardId: string) => {
      ran.push(cardId);
      return { finished: false, blocked: false, detail: "worked a step", steps: [{ action: "noted", detail: "worked a step" }] };
    };

    // ── A: taken over, a reply comes in, handed back "all done": it is NOT closed, it carries on with the reply. ──
    const a = await card("Parker: a job the developer takes over");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id <> ?1 AND state IN ('OPEN', 'IN_PROGRESS')").bind(a).run();
    expect((await takeOverCard(env, a, { why: "building the dashboard by hand", by, enteredBy: "test" })).ok).toBe(true);
    expect(String((await row(a))!.held_reason)).toMatch(/^A developer is doing this by hand/);
    for (let k = 0; k < 3; k++) await sweepOnce(env, new Date(Date.now() + k * 60_000), { general: runner });
    expect(ran, "a taken-over card never runs by itself").not.toContain(a);

    const { token } = await startThread(env, { objectType: "work_card", objectId: a, cardKind: "TAKEOVER_TEST", employee: "Parker", to: "scooter@westpeek.ventures", subject: "Parker: the job", firmScope: "west-peek" });
    const raw = [`From: ${SCOOTER_FROM}`, `To: ${INTAKE_MAILBOX}`, "Subject: Re: Parker: the job", "", "Also add the press logos to the footer.", "", "On Sat, 14 Nov 2026 at 10:02, Parker <parker@joinwestpeek.com> wrote:", "> the note"].join("\n");
    await steerFromReply(env, { fromHeader: SCOOTER_FROM, authenticationResults: GOOD_AUTH, subject: "Re: Parker: the job", raw, inReplyTo: threadReference(token), references: null, emlKey: null, messageId: "takeover-reply@mail.gmail.com" });
    expect(await events(a, "work_card.reply_filed_during_takeover"), "his reply is filed on the card").toBe(1);
    expect((await row(a))!.held_at, "and acted on by nothing: still taken over").not.toBeNull();
    await sweepOnce(env, new Date(Date.now() + 5 * 60_000), { general: runner });
    expect(ran).not.toContain(a);

    const back = await handBackCard(env, a, { note: "Built the dashboard and shipped it.", allDone: true, by, enteredBy: "test", finishedAt: "2026-11-15T03:30:00.000Z" });
    expect(back.ok && back.state, "a reply came in while it was taken over, so it is not closed").toBe("OPEN");
    const notes = (await env.WP_OS_DB.prepare("SELECT body FROM work_card_note WHERE work_card_id = ?1 ORDER BY created_at").bind(a).all<{ body: string }>()).results!.map((n) => n.body);
    expect(notes.some((n) => /press logos/.test(n)), "the reply filed meanwhile is part of what is picked up").toBe(true);
    expect(notes.at(-1)).toMatch(/^Done by a developer on 14 Nov, finished at 9:30 PM Central; Parker, take it from here\. Built the dashboard/);
    expect(String((await row(a))!.next_action)).toMatch(/^Start from the developer's note/);
    await sweepOnce(env, new Date(Date.now() + 10 * 60_000), { general: runner });
    expect(ran, "handed back, it runs again").toContain(a);
    expect(await events(a, "work_card.taken_over_by_developer")).toBe(1);
    expect(await events(a, "work_card.handed_back_by_developer")).toBe(1);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(a).run();

    // ── B: taken over, nothing came in, handed back "all done": closed, waiting for the partner. ──
    const b = await card("Parker: a job the developer finishes");
    await takeOverCard(env, b, { why: "doing it by hand", by, enteredBy: "test" });
    const closed = await handBackCard(env, b, { note: "Every ask is done.", allDone: true, by, enteredBy: "test" });
    expect(closed.ok && closed.state).toBe("DONE");
    const rb = (await row(b))!;
    expect(rb.held_at).toBeNull();
    expect(String(rb.next_action)).toMatch(/next instruction/);
    await sweepOnce(env, new Date(Date.now() + 15 * 60_000), { general: runner });
    expect(ran, "a closed card is not run").not.toContain(b);
  });

  it("a website job handed back 'all done' waits on the partner's word on the preview: never DONE without a merge, nothing rebuilds", async () => {
    // 14 Nov 2026: the hand-back of wc_c548d043 (a website job under 'nothing goes live') hit trigger 0219 with a 500
    // and left an orphan note. A website job is never DONE without a merged PR, so it goes back waiting on his word.
    const by = (await developerDirector(env, "tail:fu_sequoia_taylor"))!;
    const w = await card("Porter: Change westpeekproductions.com");
    await env.WP_OS_DB.prepare(
      `UPDATE work_card SET kind = 'WEB_PROPERTY_CHANGE', state = 'IN_PROGRESS', requested_by_email = 'scooter@westpeek.ventures',
         block_reason = 'a_question_for_you', block_who = 'SCOOTER', block_trying = 'Change westpeekproductions.com',
         block_stopped = 'Porter needs something from you before this can go any further.', block_needed = 'Waiting on: your word on the preview.',
         block_actions_json = '[{"key":"ANSWER","label":"Answer it","hint":"Type your answer"}]', blocked_at = '2026-11-14T21:44:15.402Z',
         block_answer = 'Here is the whole vision', block_answered_by = 'fu_scooter_taylor', block_answered_at = '2026-11-14T22:12:17.204Z'
       WHERE id = ?1`,
    ).bind(w).run();
    await takeOverCard(env, w, { why: "doing the site edits by hand", by, enteredBy: "test" });
    const back = await handBackCard(env, w, { note: "All 12 site edits are on the preview.", allDone: true, by, enteredBy: "test" });
    expect(back.ok, JSON.stringify(back)).toBe(true);
    expect(back.ok && back.state, "never DONE without a merge").toBe("IN_PROGRESS");
    const rw = (await row(w))!;
    expect(rw.held_at).toBeNull();
    expect(rw.block_reason, "still waiting on his word").toBe("a_question_for_you");
    expect(rw.block_answer, "the earlier answer is cleared, so nothing rebuilds from it").toBeNull();
    expect(String(rw.next_action)).toMatch(/preview waits for Scooter's word/);
    const notes = Number((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card_note WHERE work_card_id = ?1").bind(w).first<{ n: number }>())!.n);
    expect(notes, "exactly one note, no orphan").toBe(1);
  });
});
