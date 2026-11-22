import { askMarks } from "./helpers/aiShapes";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { asksAtDone, type SeatRead } from "../src/worker/services/partnerUnderstood";
import { buildItemsLedger } from "../src/worker/services/webPropertyChange";

/**
 * THE FINAL REPLY MARKS EACH ASK AGAINST EVERY BUILD, NOT ONLY THE LAST REPORT (19 Nov 2026, wc_c548d043). Scooter's
 * "Live" email listed 28 asks as "Not done" — the menu order, the 15% logo, "Turnkey production services" — that earlier
 * builds had done and previewed, because the marking read saw only the LAND report (merge + live links).
 */
let t: TestDb;
let env: Env;
const CARD = "wc_ledger_1";

async function run(id: string, at: string, output: Record<string, unknown>) {
  await env.WP_OS_DB.prepare(
    "INSERT INTO subscription_seat_run (id, seat, purpose, prompt, model_access, work_card_id, firm_scope, status, run_kind, output_text, created_at, reported_at, updated_at) VALUES (?1, 'claude_code', 'Porter: BUILD', 'p', 'PUBLIC_MODEL_APPROVED', ?2, 'west-peek', 'REPORTED', 'LOCAL_JOB', ?3, ?4, ?4, ?4)",
  )
    .bind(id, CARD, JSON.stringify(output), at)
    .run();
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  await run("ccr_b1", "2026-11-17T02:50:00.000Z", { phase: "BUILD", status: "ok", items: [{ item: "Make the WP logo about 15% smaller", state: "done", done_when: [{ check: "logo", met: true, note: "logo is 85% of before on the preview" }] }, { item: "Reorder the top menu", state: "partial" }] });
  await run("ccr_b2", "2026-11-18T23:30:00.000Z", { phase: "BUILD", status: "ok", items: [{ item: "Reorder the top menu", state: "done" }] });
  await run("ccr_l1", "2026-11-19T12:36:00.000Z", { phase: "LAND", status: "ok", merge_sha: "abc", items: [{ item: "land it", state: "done" }] });
});
afterAll(async () => disposeTestDb(t));

describe("the DONE marking reads every build's item ledger", () => {
  it("lists each item once with its newest state, builds only, and returns null for a job with no build", async () => {
    const ledger = (await buildItemsLedger(env, CARD))!;
    expect(ledger).toMatch(/DONE: Make the WP logo about 15% smaller \(logo is 85%/);
    expect(ledger).toMatch(/2026-11-18 DONE: Reorder the top menu/);
    expect(ledger, "an older state of the same item is not repeated").not.toMatch(/PARTIAL: Reorder the top menu/);
    expect(ledger, "a LAND's items are the final report's, not the ledger's").not.toMatch(/land it/);
    expect(await buildItemsLedger(env, "wc_no_builds")).toBeNull();
  });

  it("an ask an earlier build did reaches the marking read beside the final report", async () => {
    await env.WP_OS_DB.prepare("INSERT INTO work_card (id, title, state, priority, privacy_label, firm_scope, owner_type, owner_id, created_by, created_at, updated_at, requested_by_email, kind) VALUES (?1, 'Site', 'IN_PROGRESS', 'NORMAL', 'INTERNAL', 'west-peek', 'AI', 'aie_porter', 'test', '2026-11-17', '2026-11-19', 'scooter@westpeek.ventures', 'WEB_PROPERTY_CHANGE')").bind(CARD).run();
    await env.WP_OS_DB.prepare("INSERT INTO inbound_message (id, message_id, r2_key, from_address, to_address, subject, received_at, bytes, work_card_id, firm_scope) VALUES ('inm_1', '<inm_1@test>', 'inbound/inm_1.eml', 'scooter@westpeek.ventures', 'os@joinwestpeek.com', 'Re: preview', '2026-11-17T00:00:00.000Z', 10, ?1, 'west-peek')").bind(CARD).run();
    await env.WP_OS_DB.prepare("INSERT INTO partner_ask (id, work_card_id, inbound_message_id, seq, words, firm_scope) VALUES ('pa_1', ?1, 'inm_1', 1, 'Make the WP logo about 15% smaller.', 'west-peek')").bind(CARD).run();
    let prompt = "";
    const read: SeatRead = async (_e, input) => {
      prompt = input.prompt;
      return { ok: true, detail: "", text: /15% smaller \(logo is 85%/.test(input.prompt) ? askMarks([{ number: 1, status: "DONE", why: "the logo build" }]) : askMarks([{ number: 1, status: "NOT_DONE", why: "not in the report" }]) };
    };
    const card = (await env.WP_OS_DB.prepare("SELECT id, title, owner_id, firm_scope, requested_by_email FROM work_card WHERE id = ?1").bind(CARD).first<{ id: string; title: string; owner_id: string; firm_scope: string; requested_by_email: string }>())!;
    const ledger = await buildItemsLedger(env, CARD);
    const out = await asksAtDone(env, card, `Merged abc; LIVE_LINKS OK.\n\n${ledger}`, read);
    expect(prompt).toMatch(/Every build on this job/);
    expect(out.ok && out.section?.bullets[0]).toMatch(/^Done: /);
  });
});
