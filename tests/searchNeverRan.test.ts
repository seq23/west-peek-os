import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { openProductionsCard, runProductionsCard } from "../src/worker/services/productions";
import { openHireSearchCard, runHireSearchCard } from "../src/worker/services/productionsHire";
import { sweepOnce } from "../src/worker/services/workSweep";
import { createWorkCardInternal } from "../src/worker/services/workCards";
import { sweepIdentity } from "../src/worker/services/workSweep";

/**
 * A SEARCH THAT NEVER RAN IS NOT A SEARCH THAT FOUND NOTHING (1 Oct 2026).
 *
 * Walker's monthly Productions search failed — the spend setting refused the search call and no seat could search — and the
 * runner reported "no customer lead survived", a block that asked Scooter where to look. Nothing had been looked at. The same
 * shape sat in the weekly hire search ("nobody stood up to the checks") and in blog help ("send me a source or two").
 *
 * PROVEN HERE: each of the three runners, handed a search that failed with the Free-only refusal on every attempt, fails the
 * ATTEMPT (classified as the spend setting, with its own words) and asks nobody anything; a search that DID run and found
 * nothing is still the old question; and migration 0250 puts a card stopped the old way back in the queue once.
 */

let t: TestDb;
let env: Env;
const LEVER_REFUSAL = "free_only_cannot_serve_protected_work:this call is marked 'search' and needs a paid model, and the lever is set to FREE_ONLY.";
const failingSearch = async () => ({ ok: false, text: "", detail: LEVER_REFUSAL });

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_walker', 'aie_wren', 'aie_parker')").run();
});
afterAll(async () => {
  await disposeTestDb(t);
});

const row = async (id: string) => (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<Record<string, unknown>>())!;
const mails = async (id: string) => (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE object_id = ?1 AND event_type LIKE 'deliverable.%'").bind(id).first<{ n: number }>())!.n;

describe("Walker's monthly Productions card", () => {
  it("a search that never ran fails the attempt: not blocked, nobody asked, nothing emailed, the lane's own words kept", async () => {
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS','BLOCKED')").run();
    const when = new Date("2026-12-01T14:00:00.000Z");
    const opened = await openProductionsCard(env, "productions_monthly", when);
    const out = await sweepOnce(env, new Date(when.getTime() + 5 * 60_000), {
      productions: (e, c) => runProductionsCard(e, c, { search: failingSearch, now: when }),
    });
    expect(out.card?.id).toBe(opened.cardId);
    expect(out.outcome, out.summary).toBe("FAILED");
    const c = await row(opened.cardId);
    expect(c.state).not.toBe("BLOCKED");
    expect(String(c.work_last_failure)).toMatch(/spend setting/i);
    expect(await mails(opened.cardId)).toBe(0);
  });

  it("when the attempts run out it is the SPEND-SETTING block — never 'no customer lead survived'", async () => {
    const id = (await env.WP_OS_DB.prepare("SELECT id FROM work_card WHERE kind = 'PRODUCTIONS_MONTHLY' AND state IN ('OPEN','IN_PROGRESS') ORDER BY created_at DESC LIMIT 1").first<{ id: string }>())!.id;
    const when = new Date("2026-12-01T14:00:00.000Z");
    for (let i = 0; i < 4 && (await row(id)).state !== "BLOCKED"; i += 1) {
      await sweepOnce(env, new Date(when.getTime() + (10 + i * 5) * 60_000), { productions: (e, c) => runProductionsCard(e, c, { search: failingSearch, now: when }) });
    }
    const c = await row(id);
    expect(c.state).toBe("BLOCKED");
    expect(c.block_reason).not.toBe("nothing_good_enough_to_send");
    expect(c.block_lane).toBe("spend_lever");
    expect(String(c.block_needed)).not.toMatch(/where to look/i);
  });

  it("a search that RAN and found nothing is still the old question, because that one really is about where to look", async () => {
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS','BLOCKED')").run();
    const when = new Date("2027-01-01T14:00:00.000Z");
    const opened = await openProductionsCard(env, "productions_monthly", when);
    const out = await sweepOnce(env, new Date(when.getTime() + 5 * 60_000), {
      productions: (e, c) => runProductionsCard(e, c, { search: async () => ({ ok: true, text: "I could not find anything.", detail: "ok" }), now: when }),
    });
    expect(out.card?.id).toBe(opened.cardId);
    expect(out.outcome).toBe("BLOCKED");
    expect((await row(opened.cardId)).block_reason).toBe("nothing_good_enough_to_send");
  });
});

describe("a judging step that could not answer is a failed attempt too (1 Oct 2026)", () => {
  const JUDGE_REFUSAL = "free_only_cannot_serve_protected_work:this call is marked 'judgement' and needs a paid model, and the lever is set to FREE_ONLY.";
  const judgeDown = async () => ({ ok: false, text: "", detail: JUDGE_REFUSAL });

  it("the weekly hire search: a refused judge fails the attempt instead of saying nobody stood up to the checks", async () => {
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE kind = 'PRODUCTIONS_HIRE_SEARCH'").run();
    const when = new Date("2027-02-08T14:00:00.000Z");
    const opened = await openHireSearchCard(env, when);
    const hireJson = JSON.stringify({ results: [{ name: "Ada", profile_url: "https://example.org/ada", evidence_url: "https://example.org/ada/work", why: "x" }] });
    const out = await sweepOnce(env, new Date(when.getTime() + 5 * 60_000), {
      productionsHire: (e, c) => runHireSearchCard(e, c, { search: async () => ({ ok: true, text: hireJson, detail: "ok" }), judge: judgeDown as never, urlStatus: async () => 200, now: when }),
    });
    expect(out.card?.id).toBe(opened.cardId);
    expect(out.outcome, out.summary).toBe("FAILED");
    expect((await row(opened.cardId)).state).not.toBe("BLOCKED");
  });
});

describe("Walker's weekly hire search", () => {
  it("a search that never ran fails the attempt instead of saying nobody stood up to the checks", async () => {
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE kind = 'PRODUCTIONS_HIRE_SEARCH'").run();
    const when = new Date("2026-12-07T14:00:00.000Z");
    const opened = await openHireSearchCard(env, when);
    const out = await sweepOnce(env, new Date(when.getTime() + 5 * 60_000), {
      productionsHire: (e, c) => runHireSearchCard(e, c, { search: failingSearch, now: when }),
    });
    expect(out.card?.id).toBe(opened.cardId);
    expect(out.outcome, out.summary).toBe("FAILED");
    expect((await row(opened.cardId)).state).not.toBe("BLOCKED");
    expect(await mails(opened.cardId)).toBe(0);
  });
});

describe("migration 0250 puts a card stopped the old way back in the queue, once", () => {
  const backfill = (): string => {
    const sql = readFileSync("migrations/0250_a_search_that_never_ran_is_not_a_question.sql", "utf8");
    return sql.slice(sql.indexOf("UPDATE work_card"), sql.indexOf("INSERT OR IGNORE INTO schema_version")).trim().replace(/;$/, "");
  };
  async function stopped(title: string, needed: string, reason = "nothing_good_enough_to_send"): Promise<string> {
    const c = await createWorkCardInternal(env, sweepIdentity(), { title, description: "x", owner_type: "AI", owner_id: "aie_walker", firm_scope: "west-peek" });
    await env.WP_OS_DB.prepare(
      `UPDATE work_card SET state = 'BLOCKED', block_reason = ?2, block_trying = ?1, block_stopped = 'Walker looked and found nothing solid enough to put in front of you.',
              block_needed = ?3, block_who = 'SCOOTER',
              block_actions_json = '[{"key":"ANSWER","label":"Answer it","hint":"x"},{"key":"DROP","label":"Drop it","hint":"x"}]'
        WHERE id = ?4`,
    ).bind(title, reason, needed, c.id).run();
    return c.id;
  }

  it("releases only a card whose own sentence says the live search failed", async () => {
    const dead = await stopped("Walker: this month (search never ran)", "Tell Walker where to look, or leave it this month — no customer lead survived (the live search failed: free_only_cannot_serve_protected_work), and he will not send half a note.");
    const real = await stopped("Walker: this month (search ran, found nothing)", "Tell Walker where to look, or leave it this month — no customer lead survived (the judge rejected every entry: x), and he will not send half a note.");
    const other = await stopped("Walker: a different stop", "the live search failed: x", "a_question_for_you");
    await env.WP_OS_DB.prepare(backfill()).run();
    expect((await row(dead)).state).toBe("OPEN");
    expect(String((await row(dead)).block_answer)).toMatch(/^AUTO-RETRY/);
    expect((await row(real)).state, "a search that ran and found nothing keeps its question").toBe("BLOCKED");
    expect((await row(other)).state, "another block reason is untouched").toBe("BLOCKED");
  });

  it("0252 does the same for a card whose JUDGING step could not answer — and leaves the rest alone", async () => {
    const sql = readFileSync("migrations/0252_a_judging_step_that_could_not_answer_is_not_a_question.sql", "utf8");
    const stmt = sql.slice(sql.indexOf("UPDATE work_card"), sql.indexOf("INSERT OR IGNORE INTO schema_version")).trim().replace(/;$/, "");
    const dead = await stopped("Walker: this month (judge could not answer)", "Tell Walker where to look, or leave it this month — no customer lead survived (the judgement pass failed: free_only_cannot_serve_protected_work), and he will not send half a note.");
    const real = await stopped("Walker: this month (judge rejected everything)", "Tell Walker where to look, or leave it this month — no customer lead survived (the judge rejected every entry: x), and he will not send half a note.");
    await env.WP_OS_DB.prepare(stmt).run();
    expect((await row(dead)).state).toBe("OPEN");
    expect(String((await row(dead)).block_answer)).toMatch(/^AUTO-RETRY/);
    expect((await row(real)).state, "a judge that RAN and rejected everything keeps its question").toBe("BLOCKED");
  });

  it("does not touch a held card", async () => {
    const held = await stopped("Walker: held", "no customer lead survived (the live search failed: x)");
    await env.WP_OS_DB.prepare("UPDATE work_card SET held_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), held_by = 'fu_scooter_taylor', held_reason = 'later' WHERE id = ?1").bind(held).run();
    await env.WP_OS_DB.prepare(backfill()).run();
    expect((await row(held)).state).toBe("BLOCKED");
  });
});
