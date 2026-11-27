import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { resurfaceStaleBlocks } from "../src/worker/services/blocks";
import { remindRequesterByEmail } from "../src/worker/services/webPropertyChange";

/**
 * A BLOCK REMINDER REACHES AN EMAILED REQUESTER BY EMAIL (9 Oct 2026).
 *
 * Production, 9 Oct 2026: wc_cdc33590 and wc_739461bd — both asked for by Scooter by email, both
 * blocked on him — rang "Still waiting on you" into the in-app notice centre only (IN_APP DELIVERED,
 * PUSH UNAVAILABLE, no email_thread row). Scooter works by email alone, so the reminder never
 * reached him. What is proven here:
 *
 *   (a) a due reminder on a card blocked on its PREVIEW sends ONE email to Scooter, on the card's
 *       own thread, recorded in work_card_notice with cause `nag:1`, carrying the card's
 *       block_needed (its preview link) and the in-app notice still rings;
 *   (b) the same nag handed over again sends nothing;
 *   (c) a blocked card nobody asked for by email sends no email and still gets its in-app notice.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string; text: string; headers: Record<string, string> }> = [];

const SCOOTER = "scooter@westpeek.ventures";
const CARD = "wc_block_nag_email";
const BARE = "wc_block_nag_no_requester";
const ROOT_TOKEN = `wpt_${"d".repeat(32)}`;
const PREVIEW = "https://work-wpc-test.topbarz-voting.pages.dev";
const NOW = new Date("2026-10-09T20:00:00.000Z");

async function seedBlocked(id: string, requestedBy: string | null): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO work_card (id, title, description, owner_type, owner_id, state, priority, privacy_label, firm_scope, created_by, kind, requested_by_email,
                            block_who, block_needed, block_reason, block_stopped, block_trying, block_actions_json, blocked_at, block_nag_at, block_nags, created_at)
     VALUES (?1, 'Change topbarz-voting: the voting page', 'x', 'AI', 'aie_porter', 'BLOCKED', 'NORMAL', 'INTERNAL', 'west-peek', 'test', 'WEB_PROPERTY_CHANGE', ?2,
             'SCOOTER', ?3, 'a_question_for_you', 'the preview', 'the voting page', '[{"key":"ANSWER","label":"Answer"}]', '2026-10-07T20:00:00.000Z', '2026-10-08T20:00:00.000Z', 0, '2026-10-07T19:00:00.000Z')`,
  )
    .bind(id, requestedBy, `PREVIEW READY. Look at it here: ${PREVIEW}\nReply "approved" to land it.`)
    .run();
  await env.WP_OS_DB.prepare(
    `INSERT INTO web_property_change (work_card_id, target_repo, property_host, ask, phase, pr_url, branch, check_state, check_green_at, preview_url, publish_ready, preview_only)
     VALUES (?1, 'topbarz-voting', 'topbarz-voting.pages.dev', 'the voting page', 'BUILD', 'https://github.com/seq23/topbarz-voting/pull/9', 'work/wpc-test', 'GREEN', '2026-10-07T19:59:00.000Z', ?2, 0, 1)`,
  )
    .bind(id, PREVIEW)
    .run();
}

async function notices(id: string): Promise<Array<{ kind: string; cause: string; sent: number; sent_to: string }>> {
  return ((await env.WP_OS_DB.prepare("SELECT kind, cause, sent, sent_to FROM work_card_notice WHERE work_card_id = ?1 AND cause LIKE 'nag:%'").bind(id).all<never>()).results ?? []) as never;
}

async function inApp(id: string): Promise<number> {
  return (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM notification WHERE dedupe_key = ?1").bind(`work_card:${id}:block_nag:1`).first<{ n: number }>())?.n ?? 0;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, {
    WP_OS_AI_EMAIL_PARTNERS: "enabled",
    WP_OS_EMAIL_SEND: "enabled",
    RESEND_API_KEY: "re_test_not_a_real_key",
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
  } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; headers?: Record<string, string> };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text, headers: body.headers ?? {} });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  });
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id = 'aie_porter'").run();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

beforeEach(async () => {
  sent.length = 0;
  for (const id of [CARD, BARE]) {
    await env.WP_OS_DB.prepare("DELETE FROM work_card_notice WHERE work_card_id = ?1").bind(id).run();
    await env.WP_OS_DB.prepare("DELETE FROM web_property_change WHERE work_card_id = ?1").bind(id).run();
    await env.WP_OS_DB.prepare("DELETE FROM work_card WHERE id = ?1").bind(id).run();
  }
});

describe("a block reminder reaches an emailed requester by email", () => {
  it("(a)+(b) sends ONE reminder email to Scooter on the card's thread, cause nag:1, carrying the preview link; the same nag again sends nothing", async () => {
    await seedBlocked(CARD, SCOOTER);
    // The card's first email to Scooter: the reminder must land under it, not start a new conversation.
    await env.WP_OS_DB.prepare("INSERT INTO work_card_notice (id, work_card_id, kind, cause, sent_to, message_id, sent, sent_at) VALUES (?1, ?2, 'RECEIVED', '', ?3, ?4, 1, '2026-10-07T19:00:05.000Z')")
      .bind(`wcn_${crypto.randomUUID()}`, CARD, SCOOTER, ROOT_TOKEN)
      .run();

    // 21 Nov 2026: the re-ask email is part of the sweep's re-ask itself (resurfaceStaleBlocks), not a second step.
    const rung = await resurfaceStaleBlocks(env, NOW);
    expect(rung.map((r) => r.id)).toEqual([CARD]);
    expect(rung[0]!.requested_by_email).toBe(SCOOTER);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(SCOOTER);
    expect(sent[0]!.text).toContain(PREVIEW);
    expect(sent[0]!.text).toMatch(/A reminder, \**2\** days on\./);
    expect(sent[0]!.subject, "it waits on him").toMatch(/^ACTION REQUIRED: /);
    expect(`${sent[0]!.headers["In-Reply-To"] ?? ""} ${sent[0]!.headers["References"] ?? ""}`).toContain(ROOT_TOKEN);
    expect(await notices(CARD)).toEqual([{ kind: "PREVIEW", cause: "nag:1@2026-10-07T20:00:00.000Z", sent: 1, sent_to: SCOOTER }]);
    // The in-app notice is kept, exactly as before.
    expect(await inApp(CARD)).toBe(1);

    // (b) The same re-ask handed over again sends nothing.
    const again = await remindRequesterByEmail(env, { ...rung[0]!, block_nags: 0 }, NOW);
    expect(again).toEqual({ sent: false, reason: "PREVIEW already sent for this cause", failed: false });
    expect(sent).toHaveLength(1);
    expect(await notices(CARD)).toHaveLength(1);
    // And the next real sweep finds nothing due: the clock moved on to the next re-ask (about 7 days).
    expect(await resurfaceStaleBlocks(env, new Date(NOW.getTime() + 60_000))).toEqual([]);
  });

  it("(c) a card nobody asked for by email still reaches the partner it waits on (21 Nov 2026), once, and still gets its in-app notice", async () => {
    await seedBlocked(BARE, null);
    const rung = await resurfaceStaleBlocks(env, NOW);
    expect(rung.map((r) => r.id)).toEqual([BARE]);
    expect(sent.map((m) => m.to), "block_who names Scooter: the re-ask goes to him").toEqual([SCOOTER]);
    expect(sent[0]!.subject).toMatch(/^ACTION REQUIRED: /);
    expect(await notices(BARE)).toEqual([{ kind: "QUESTION", cause: "nag:1@2026-10-07T20:00:00.000Z", sent: 1, sent_to: SCOOTER }]);
    expect(await inApp(BARE)).toBe(1);
  });
  it("(d) a wait that clears itself (the Mac asleep) re-asks him nothing by email; its in-app ring stays (23 Nov 2026, wc_59ef2d40)", async () => {
    await seedBlocked(CARD, SCOOTER);
    await env.WP_OS_DB.prepare("UPDATE work_card SET block_context = ?2 WHERE id = ?1").bind(CARD, JSON.stringify({ wait: "MAC_ASLEEP", run: "ccr_test" })).run();
    const rung = await resurfaceStaleBlocks(env, NOW);
    expect(rung.map((r) => r.id), "the re-ask still rings").toEqual([CARD]);
    expect(sent, "no 'ACTION REQUIRED: New preview ready' for a build that never ran").toHaveLength(0);
    expect(await notices(CARD)).toEqual([]);
    expect(await inApp(CARD)).toBe(1);
    expect(await resurfaceStaleBlocks(env, new Date(NOW.getTime() + 60_000)), "the clock moved on: no retry loop").toEqual([]);
  });

  it("(d) negative: a block whose cause is his own word, or unreadable, is still re-asked by email", async () => {
    for (const context of [JSON.stringify({ wait: "WHICH_SITE" }), "{not json"]) {
      sent.length = 0;
      await env.WP_OS_DB.prepare("DELETE FROM work_card_notice WHERE work_card_id = ?1").bind(CARD).run();
      await env.WP_OS_DB.prepare("DELETE FROM web_property_change WHERE work_card_id = ?1").bind(CARD).run();
      await env.WP_OS_DB.prepare("DELETE FROM work_card WHERE id = ?1").bind(CARD).run();
      await seedBlocked(CARD, SCOOTER);
      await env.WP_OS_DB.prepare("UPDATE work_card SET block_context = ?2 WHERE id = ?1").bind(CARD, context).run();
      await resurfaceStaleBlocks(env, NOW);
      expect(sent.map((m) => m.to), `cause ${context}`).toEqual([SCOOTER]);
    }
  });

  it("(e) a card re-blocked on a NEW preview gets its own 2-day re-ask; the old block's nag:1 never silences it (27 Nov 2026, wc_59ef2d40)", async () => {
    await seedBlocked(CARD, SCOOTER);
    // The previous block's re-ask, sent under the old per-card key before this block began.
    await env.WP_OS_DB.prepare("INSERT INTO work_card_notice (id, work_card_id, kind, cause, sent_to, message_id, sent, sent_at) VALUES (?1, ?2, 'PREVIEW', 'nag:1', ?3, ?4, 1, '2026-10-05T12:00:00.000Z')")
      .bind(`wcn_${crypto.randomUUID()}`, CARD, SCOOTER, ROOT_TOKEN).run();
    await resurfaceStaleBlocks(env, NOW);
    expect(sent.map((m) => m.to), "the new block's re-ask reaches him").toEqual([SCOOTER]);
    expect((await notices(CARD)).map((n) => n.cause).sort()).toEqual(["nag:1", "nag:1@2026-10-07T20:00:00.000Z"]);
    await resurfaceStaleBlocks(env, new Date(NOW.getTime() + 60_000));
    expect(sent, "and only once").toHaveLength(1);
  });

  it("(e) negative: a re-ask sent under the old key AFTER this block began still counts, so an in-flight block is not asked twice", async () => {
    await seedBlocked(CARD, SCOOTER);
    await env.WP_OS_DB.prepare("INSERT INTO work_card_notice (id, work_card_id, kind, cause, sent_to, message_id, sent, sent_at) VALUES (?1, ?2, 'PREVIEW', 'nag:1', ?3, ?4, 1, '2026-10-08T20:30:00.000Z')")
      .bind(`wcn_${crypto.randomUUID()}`, CARD, SCOOTER, ROOT_TOKEN).run();
    await resurfaceStaleBlocks(env, NOW);
    expect(sent, "no duplicate of the reminder he already has").toHaveLength(0);
    const ev = await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE object_id = ?1 AND event_type = 'work_card.reask_not_emailed'").bind(CARD).first<{ payload_json: string }>();
    expect(ev?.payload_json, "the skip is written on the card").toMatch(/already sent/);
  });
});
