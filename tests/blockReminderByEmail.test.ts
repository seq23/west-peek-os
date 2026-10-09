import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { resurfaceStaleBlocks } from "../src/worker/services/blocks";
import { remindRequestersByEmail } from "../src/worker/services/workSweep";

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

    const rung = await resurfaceStaleBlocks(env, NOW);
    expect(rung.map((r) => r.id)).toEqual([CARD]);
    expect(rung[0]!.requested_by_email).toBe(SCOOTER);
    const out = await remindRequestersByEmail(env, rung, NOW);

    expect(out).toEqual([{ id: CARD, sent: true, reason: expect.any(String) }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(SCOOTER);
    expect(sent[0]!.text).toContain(PREVIEW);
    expect(sent[0]!.text).toMatch(/Still waiting on you \(\**2\** days\)\./);
    expect(`${sent[0]!.headers["In-Reply-To"] ?? ""} ${sent[0]!.headers["References"] ?? ""}`).toContain(ROOT_TOKEN);
    expect(await notices(CARD)).toEqual([{ kind: "PREVIEW", cause: "nag:1", sent: 1, sent_to: SCOOTER }]);
    // The in-app notice is kept, exactly as before.
    expect(await inApp(CARD)).toBe(1);

    // (b) The same nag handed over again — a second sweep tick before the next ring — sends nothing.
    const again = await remindRequestersByEmail(env, rung, NOW);
    expect(again).toEqual([{ id: CARD, sent: false, reason: "PREVIEW already sent for this cause" }]);
    expect(sent).toHaveLength(1);
    expect(await notices(CARD)).toHaveLength(1);
    // And the next real sweep finds nothing due: the clock moved on 24 hours.
    expect(await resurfaceStaleBlocks(env, new Date(NOW.getTime() + 60_000))).toEqual([]);
  });

  it("(c) a blocked card nobody asked for by email sends no email and still gets its in-app notice", async () => {
    await seedBlocked(BARE, null);
    const rung = await resurfaceStaleBlocks(env, NOW);
    expect(rung.map((r) => r.id)).toEqual([BARE]);
    expect(await remindRequestersByEmail(env, rung, NOW)).toEqual([]);
    expect(sent).toHaveLength(0);
    expect(await notices(BARE)).toEqual([]);
    expect(await inApp(BARE)).toBe(1);
  });
});
