import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { createWorkCardInternal } from "../src/worker/services/workCards";
import { MAX_WORK_ATTEMPTS, claimNextCard, settleAbandonedCards, sweepIdentity, sweepOnce } from "../src/worker/services/workSweep";
import { runDueJobs } from "../src/worker/services/jobs";
import { STEPS_PER_TICK } from "../src/shared/work/employeeLoop";

/**
 * The sweep that works the cards employees own — proven without a model.
 *
 * WHAT THE OPERATOR SAW, 14 Sep 2026: four cards owned by Wyatt "in progress" since 9 Sep with
 * nothing behind them; a rejected deck that told Preston nothing; a cron tick killed at 10 ms of
 * CPU four jobs deep. Each assertion below is one of those, made impossible.
 */

let t: TestDb;
let env: Env;
const NOW = new Date("2026-09-14T12:00:00.000Z");

async function card(title: string, owner = "aie_wyatt"): Promise<string> {
  const c = await createWorkCardInternal(env, sweepIdentity(), {
    title,
    description: "test",
    owner_type: "AI",
    owner_id: owner,
    firm_scope: "west-peek",
  });
  return c.id;
}

async function state(id: string): Promise<{ state: string; next_action: string | null; work_attempts: number; lease_until: string | null }> {
  return (await env.WP_OS_DB.prepare("SELECT state, next_action, work_attempts, lease_until FROM work_card WHERE id = ?1").bind(id).first())!;
}

async function notices(cardId: string): Promise<Array<{ title: string; severity: string }>> {
  return (
    await env.WP_OS_DB.prepare("SELECT title, severity FROM notification WHERE object_type = 'work_card' AND object_id = ?1 ORDER BY created_at")
      .bind(cardId)
      .all<{ title: string; severity: string }>()
  ).results ?? [];
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("assignment causes work", () => {
  it("claims the OLDEST waiting AI-owned card, marks it in progress, and counts the attempt", async () => {
    const first = await card("First card");
    const second = await card("Second card");
    const claimed = await claimNextCard(env, NOW);
    expect(claimed?.id).toBe(first);
    expect(claimed?.work_attempts).toBe(1);
    const s = await state(first);
    expect(s.state).toBe("IN_PROGRESS");
    expect(s.lease_until).not.toBeNull();
    // The lease is the lock: the same card is not handed out twice while it is held.
    const again = await claimNextCard(env, NOW);
    expect(again?.id).toBe(second);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id IN (?1, ?2)").bind(first, second).run();
  });

  it("a card the employee finishes goes DONE and both partners are told where to look", async () => {
    const id = await card("Deck: Sensori");
    const out = await sweepOnce(env, NOW, {
      general: async (e, _ctx, cardId) => {
        await e.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE', next_action = NULL WHERE id = ?1").bind(cardId).run();
        return { finished: true, blocked: false, detail: "Real company, fits the thesis; opened at the top of the funnel.", steps: [{ action: "done", detail: "Real company, fits the thesis; opened at the top of the funnel." }] };
      },
    });
    expect(out.outcome).toBe("DONE");
    expect((await state(id)).state).toBe("DONE");
    expect((await state(id)).lease_until).toBeNull();
    const n = await notices(id);
    expect(n.length).toBeGreaterThanOrEqual(1);
    expect(n[0]!.title).toMatch(/Wyatt finished "Deck: Sensori"/);
    expect(n[0]!.title).toMatch(/check it on Work/);
  });

  it("a card the employee cannot finish goes BLOCKED with the question, and the partners are told", async () => {
    const id = await card("Deal flow: Helios Grid");
    const out = await sweepOnce(env, NOW, {
      general: async (e, _ctx, cardId) => {
        await e.WP_OS_DB.prepare("UPDATE work_card SET state = 'BLOCKED', next_action = ?2 WHERE id = ?1")
          .bind(cardId, "Is a $2M pre-seed inside the mandate?")
          .run();
        return { finished: false, blocked: true, detail: "Is a $2M pre-seed inside the mandate?", steps: [{ action: "blocked", detail: "Is a $2M pre-seed inside the mandate?" }] };
      },
    });
    expect(out.outcome).toBe("BLOCKED");
    const n = await notices(id);
    expect(n[0]!.title).toMatch(/Wyatt is blocked on/);
    expect(n[0]!.severity).toBe("WARNING");
  });

  it("a run that took its steps and ran out is PROGRESSED, costs no attempt, and the next tick continues the same card", async () => {
    const id = await card("Deal flow: Helios Grid");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'IN_PROGRESS', work_steps = 5 WHERE id = ?1").bind(id).run();
    let askedFor: number | null = null;
    const out = await sweepOnce(env, NOW, {
      general: async (_e, _ctx, _cardId, options) => {
        askedFor = options.maxSteps;
        return { finished: false, blocked: false, detail: "Searched …", steps: [{ action: "search", detail: "Searched …" }, { action: "note", detail: "nothing live" }] };
      },
    });
    expect(askedFor, "the sweep asks for a few steps per tick, not the whole run").toBe(STEPS_PER_TICK);
    expect(out.outcome).toBe("PROGRESSED");
    expect(out.summary).toMatch(/The next tick continues it/);
    const s = await state(id);
    expect(s.state).toBe("IN_PROGRESS");
    expect(s.work_attempts, "an invocation that did its work is not an attempt lost").toBe(0);
    expect(s.lease_until).toBeNull();
    const steps = (await env.WP_OS_DB.prepare("SELECT work_steps FROM work_card WHERE id = ?1").bind(id).first<{ work_steps: number }>())!.work_steps;
    expect(steps, "a continued card keeps its step count; only a reopened (OPEN) card starts again").toBe(5);
    const again = await claimNextCard(env, new Date(NOW.getTime() + 60_000));
    expect(again?.id).toBe(id);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED', lease_until = NULL WHERE id = ?1").bind(id).run();
  });

  it("a card a person reopens starts its step allowance again", async () => {
    const id = await card("Reopened");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'OPEN', work_steps = 8 WHERE id = ?1").bind(id).run();
    const claimed = await claimNextCard(env, NOW);
    expect(claimed?.id).toBe(id);
    const steps = (await env.WP_OS_DB.prepare("SELECT work_steps FROM work_card WHERE id = ?1").bind(id).first<{ work_steps: number }>())!.work_steps;
    expect(steps).toBe(0);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED', lease_until = NULL WHERE id = ?1").bind(id).run();
  });

  it("three failed attempts end in BLOCKED with the failure on the card, never a fourth retry", async () => {
    const id = await card("Find accelerators in Texas");
    const failing = async () => ({ finished: false, blocked: false, detail: "provider returned 429", steps: [{ action: "failed", detail: "provider returned 429" }] });
    for (let i = 1; i < MAX_WORK_ATTEMPTS; i++) {
      const out = await sweepOnce(env, new Date(NOW.getTime() + i * 60_000), { general: failing });
      expect(out.outcome).toBe("FAILED");
      expect(out.status, "an attempt that needs another go is not a failed run").toBe("SUCCEEDED");
      expect(out.summary).toMatch(/will be tried again/);
      expect((await state(id)).state).toBe("IN_PROGRESS");
    }
    const last = await sweepOnce(env, new Date(NOW.getTime() + MAX_WORK_ATTEMPTS * 60_000), { general: failing });
    expect(last.outcome).toBe("BLOCKED");
    const s = await state(id);
    expect(s.state).toBe("BLOCKED");
    expect(s.next_action).toMatch(/Could not finish after 3 attempts/);
    expect(s.next_action).toMatch(/provider returned 429/);
    // And it is not picked up again.
    const next = await sweepOnce(env, new Date(NOW.getTime() + 10 * 60_000), { general: failing });
    expect(next.card?.id).not.toBe(id);
  });

  it("a third attempt killed mid-run (lease expired, cap reached, still IN_PROGRESS) is settled BLOCKED on the next sweep, and the partners told", async () => {
    const id = await card("Deal flow: Helios Grid (killed)");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'IN_PROGRESS', work_attempts = ?2, lease_until = ?3 WHERE id = ?1")
      .bind(id, MAX_WORK_ATTEMPTS, new Date(NOW.getTime() - 60_000).toISOString())
      .run();
    const settled = await settleAbandonedCards(env, NOW);
    expect(settled.map((c) => c.id)).toContain(id);
    const s = await state(id);
    expect(s.state).toBe("BLOCKED");
    expect(s.lease_until).toBeNull();
    expect(s.next_action).toMatch(/cut off before it could report/);
    expect((await notices(id))[0]!.title).toMatch(/is blocked on/);
    // A card whose lease is still held is a run in flight, not abandoned.
    const live = await card("Still running");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'IN_PROGRESS', work_attempts = ?2, lease_until = ?3 WHERE id = ?1")
      .bind(live, MAX_WORK_ATTEMPTS, new Date(NOW.getTime() + 60_000).toISOString())
      .run();
    expect((await settleAbandonedCards(env, NOW)).map((c) => c.id)).not.toContain(live);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(live).run();
  });

  it("a DECK_REWORK card is worked by the deck runner, not the four-move loop", async () => {
    const id = await card("Rebuild the LP deck as v12", "aie_preston");
    await env.WP_OS_DB.prepare("UPDATE work_card SET kind = 'DECK_REWORK' WHERE id = ?1").bind(id).run();
    let generalCalled = false;
    let deckCalled = false;
    const out = await sweepOnce(env, new Date(NOW.getTime() + 20 * 60_000), {
      general: async () => { generalCalled = true; return { finished: true, blocked: false, detail: "", steps: [] }; },
      deckRework: async (e, c) => {
        deckCalled = true;
        await e.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(c.id).run();
        return { finished: true, blocked: false, detail: "v12 is proposed on Fund strategy" };
      },
    });
    expect(deckCalled).toBe(true);
    expect(generalCalled).toBe(false);
    expect(out.outcome).toBe("DONE");
  });

  it("with nothing waiting the sweep says so and touches nothing", async () => {
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS','BLOCKED')").run();
    const out = await sweepOnce(env, NOW);
    expect(out.outcome).toBe("NOTHING_WAITING");
    expect(out.card).toBeNull();
  });
});

describe("one job per tick", () => {
  it("seeds the sweep ACTIVE every five minutes and puts the deck rebuild back to on-request", async () => {
    const sweep = await env.WP_OS_DB.prepare("SELECT status, schedule_kind, interval_minutes FROM scheduled_job WHERE job_key = 'employee_work_sweep'").first<{ status: string; schedule_kind: string; interval_minutes: number }>();
    expect(sweep).toMatchObject({ status: "ACTIVE", schedule_kind: "INTERVAL", interval_minutes: 5 });
    const deck = await env.WP_OS_DB.prepare("SELECT status FROM scheduled_job WHERE job_key = 'deck_rebuild'").first<{ status: string }>();
    expect(deck?.status).toBe("PAUSED");
  });

  it("runs only the single most overdue job on a scheduled tick, leaving the rest for the next tick", async () => {
    await env.WP_OS_DB.prepare("UPDATE scheduled_job SET status = 'PAUSED'").run();
    const at = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
    for (const [id, key, due] of [["sj_t_a", "t_a", at(30)], ["sj_t_b", "t_b", at(10)], ["sj_t_c", "t_c", at(20)]] as const) {
      await env.WP_OS_DB.prepare(
        `INSERT INTO scheduled_job (id, job_key, name, kind, schedule_kind, interval_minutes, target_kind, task_class, budget_usd, data_class, status, created_by, firm_scope, next_run_at)
         VALUES (?1, ?2, ?2, 'INTELLIGENCE', 'INTERVAL', 60, 'SYSTEM', 'OPERATIONS', 0, 'INTERNAL', 'ACTIVE', 'test', 'west-peek', ?3)`,
      ).bind(id, key, due).run();
    }
    const results = await runDueJobs(env, NOW);
    expect(results.map((r) => r.job_key)).toEqual(["t_a"]);
    const still = (await env.WP_OS_DB.prepare("SELECT job_key FROM scheduled_job WHERE status = 'ACTIVE' AND next_run_at <= ?1 ORDER BY next_run_at").bind(NOW.toISOString()).all<{ job_key: string }>()).results ?? [];
    expect(still.map((r) => r.job_key)).toEqual(["t_c", "t_b"]);
  });

});

describe("the employee sees what the firm already holds", () => {
  it("a card titled for a company carries the company record and its deck reading into the history", async () => {
    const { companyKnowledge } = await import("../src/worker/services/employeeWork");
    await env.WP_OS_DB.prepare(
      "INSERT INTO canonical_company (id, canonical_name, status, privacy_label, created_by, firm_scope, sector, one_liner) VALUES ('cc_sensori_t', 'Sensori', 'ACTIVE', 'INTERNAL', 'test', 'west-peek', 'Functional beverage / CPG', 'A 12oz functional non-alcoholic sparkling beverage.')",
    ).run();
    await env.WP_OS_DB.prepare(
      "INSERT INTO pending_deck (id, company_id, filename, object_key, bytes, state, applied_json, firm_scope, read_at) VALUES ('pdk_t', 'cc_sensori_t', 'Sensori Deck.eml', 'k', 1, 'READ', ?1, 'west-peek', '2026-08-24T02:01:20.265Z')",
    ).bind(JSON.stringify({ claims: ["61% of U.S. adults plan to drink less", "$4.2M ARR run-rate"], missing: ["Team bios"] })).run();
    const lines = await companyKnowledge(env, "Deck: Sensori Deck");
    expect(lines[0]).toMatch(/record for Sensori: sector Functional beverage/);
    expect(lines[1]).toMatch(/Their deck \(Sensori Deck\.eml, read 2026-08-24\) claims: 61% of U\.S\. adults/);
    expect(lines[2]).toMatch(/does not say: Team bios/);
    expect(await companyKnowledge(env, "Find accelerators in Texas")).toEqual([]);
  });

  it("a deck queued against the card itself is found even when no company was matched from the subject", async () => {
    const { companyKnowledge } = await import("../src/worker/services/employeeWork");
    const id = await card("Deck: Nobody Knows This One");
    await env.WP_OS_DB.prepare(
      "INSERT INTO pending_deck (id, company_id, work_card_id, filename, object_key, bytes, state, applied_json, firm_scope, read_at) VALUES ('pdk_t_card', NULL, ?1, 'Fwd deck.eml', 'k2', 1, 'READ', ?2, 'west-peek', '2026-09-14T02:01:20.265Z')",
    ).bind(id, JSON.stringify({ claims: ["Raising $1.5M pre-seed"], missing: [] })).run();
    const lines = await companyKnowledge(env, "Deck: Nobody Knows This One", id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Their deck \(Fwd deck\.eml, read 2026-09-14\) claims: Raising \$1\.5M/);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(id).run();
  });

  it("a deck that could NOT be read is told to the employee as that fact, not as silence", async () => {
    const { companyKnowledge } = await import("../src/worker/services/employeeWork");
    const id = await card("Deck: Unreadable Co");
    await env.WP_OS_DB.prepare(
      "INSERT INTO pending_deck (id, company_id, work_card_id, filename, object_key, bytes, state, detail, firm_scope, read_at) VALUES ('pdk_t_failed', NULL, ?1, 'deck.eml', 'k3', 1, 'FAILED', 'the attachment is a .pptx, not a PDF', 'west-peek', '2026-09-14T02:01:20.265Z')",
    ).bind(id).run();
    const lines = await companyKnowledge(env, "Deck: Unreadable Co", id);
    expect(lines[0]).toMatch(/could NOT be read: the attachment is a \.pptx/);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(id).run();
  });

  it("the sweep WAITS for a queued deck instead of working the card from an empty body, and the wait costs no attempt", async () => {
    const id = await card("Deck: Still Arriving");
    await env.WP_OS_DB.prepare(
      "INSERT INTO pending_deck (id, company_id, work_card_id, filename, object_key, bytes, state, firm_scope) VALUES ('pdk_t_pending', NULL, ?1, 'Still Arriving.eml', 'k4', 7000000, 'PENDING', 'west-peek')",
    ).bind(id).run();
    let worked = false;
    const out = await sweepOnce(env, new Date(NOW.getTime() + 30 * 60_000), {
      general: async () => { worked = true; return { finished: true, blocked: false, detail: "", steps: [] }; },
    });
    expect(out.outcome).toBe("WAITING_ON_DECK");
    expect(out.summary).toMatch(/waiting for its deck \(Still Arriving\.eml\) to be read/);
    expect(worked, "the employee must not be handed a deck card before the deck is read").toBe(false);
    const s = await state(id);
    expect(s.state).toBe("OPEN");
    expect(s.work_attempts).toBe(0);
    expect(s.lease_until, "parked until the reader has had a turn").not.toBeNull();
    // Once the reader is done the card is worked as normal on the next free tick.
    await env.WP_OS_DB.prepare("UPDATE pending_deck SET state = 'READ', applied_json = '{\"claims\":[\"x\"]}' WHERE id = 'pdk_t_pending'").run();
    const later = await sweepOnce(env, new Date(NOW.getTime() + 50 * 60_000), {
      general: async (e, _ctx, cardId) => {
        worked = true;
        await e.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(cardId).run();
        return { finished: true, blocked: false, detail: "read it", steps: [] };
      },
    });
    expect(later.card?.id).toBe(id);
    expect(worked).toBe(true);
    expect((await state(id)).work_attempts).toBe(1);
  });
});
