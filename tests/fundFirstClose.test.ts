import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { runJob } from "../src/worker/services/jobs";
import { describeFacts, openFirstCloseCard } from "../src/worker/services/fundFirstClose";
import { JOB_FACTS } from "../src/shared/work/scheduledWork";
import { AI_EMPLOYEE_ROSTER } from "../src/shared/registry/aiEmployees";

/**
 * Preston's weekly first-close readiness (migration 0287) and the idle-employee pass that came
 * with it (migration 0286 retired Pippa). Proven offline against the migrated local D1.
 */
let t: TestDb;
let env: Env;
const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_sequoia_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const TUE_W46 = new Date("2026-11-10T14:00:00.000Z");

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id = 'aie_preston'").run();
});
afterAll(async () => {
  await disposeTestDb(t);
});

describe("0287 seeds Preston's duty", () => {
  it("is WEEKLY on Tuesday 14:00 UTC, ACTIVE, on Preston, and says what it is", async () => {
    const row = await t.db
      .prepare("SELECT schedule_kind, day_of_week, daily_at_utc, status, target_kind, target_id, data_class FROM scheduled_job WHERE job_key = 'fund_first_close_readiness'")
      .first<Record<string, unknown>>();
    expect(row).toEqual({
      schedule_kind: "WEEKLY",
      day_of_week: 2,
      daily_at_utc: "14:00",
      status: "ACTIVE",
      target_kind: "EMPLOYEE",
      target_id: "aie_preston",
      data_class: "INTERNAL",
    });
    expect(JOB_FACTS.fund_first_close_readiness?.deliveredBy).toEqual(["Preston"]);
    expect(JOB_FACTS.fund_first_close_readiness?.what).toMatch(/first close/);
  });
});

describe("the week's card", () => {
  it("opens once per ISO week on Preston's desk, with the fund records written on it and every gap named", async () => {
    const ran = await runJob(env, MP_ACTOR, "fund_first_close_readiness", { trigger: "SCHEDULED", now: TUE_W46 });
    expect(ran.run.status, String(ran.run.outcome_summary)).toBe("SUCCEEDED");
    expect(String(ran.run.outcome_summary)).toMatch(/Opened "Preston: Fund I first-close readiness 2026-W46" on Preston's desk/);
    const card = await t.db
      .prepare("SELECT owner_type, owner_id, description, state FROM work_card WHERE title = 'Preston: Fund I first-close readiness 2026-W46'")
      .first<{ owner_type: string; owner_id: string; description: string; state: string }>();
    expect(card?.owner_type).toBe("AI");
    expect(card?.owner_id).toBe("aie_preston");
    expect(card?.description).toMatch(/First close date recorded: /);
    expect(card?.description).toMatch(/Commitments: \d+ signed, \d+ soft\./);
    expect(card?.description).toMatch(/Send nothing to anyone outside the firm/);

    // The same week again opens nothing; the next week opens a new card.
    const again = await openFirstCloseCard(env, new Date("2026-11-12T09:00:00.000Z"));
    expect(again.opened).toBe(false);
    const next = await openFirstCloseCard(env, new Date("2026-11-17T14:00:00.000Z"));
    expect(next.opened).toBe(true);
    expect(next.title).toBe("Preston: Fund I first-close readiness 2026-W47");
  });

  it("names a missing record as missing rather than inventing one", () => {
    const text = describeFacts({
      fundName: null, firstCloseOn: null, lpRecords: 0, lpEngaged: 0,
      commitmentsSoft: 0, commitmentsSigned: 0, deckCardState: null, deckCardUpdatedAt: null,
    });
    expect(text).toMatch(/NONE — there is no fund row/);
    expect(text).toMatch(/First close date recorded: NOT RECORDED/);
    expect(text).toMatch(/no rework card yet/);
  });

  it("refuses to run while Preston is switched off, like every employee duty (D10)", async () => {
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'INACTIVE' WHERE id = 'aie_preston'").run();
    const ran = await runJob(env, MP_ACTOR, "fund_first_close_readiness", { trigger: "SCHEDULED", now: new Date("2026-11-24T14:00:00.000Z") });
    expect(ran.run.status).not.toBe("SUCCEEDED");
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id = 'aie_preston'").run();
  });
});

describe("0286 retires Pippa", () => {
  it("keeps her row, RETIRED, and takes her off the roster", async () => {
    const row = await t.db.prepare("SELECT status FROM ai_employee WHERE id = 'aie_pippa'").first<{ status: string }>();
    // A fresh database never seeds her (0004 is generated from the roster); an old one keeps the row RETIRED.
    if (row) expect(row.status).toBe("RETIRED");
    expect(AI_EMPLOYEE_ROSTER.some((e) => e.name === "Pippa")).toBe(false);
    const active = await t.db.prepare("SELECT COUNT(*) AS n FROM ai_employee WHERE name = 'Pippa' AND status <> 'RETIRED'").first<{ n: number }>();
    expect(active?.n).toBe(0);
  });
});
