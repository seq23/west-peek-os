import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { runHealthEscalation } from "../src/worker/services/healthEscalation";
import { runHealthChecks } from "../src/worker/services/health";
import { MANAGING_PARTNERS } from "../src/shared/registry/managingPartners";
import type { Env } from "../src/worker/env";

/**
 * The thing that tells the partners something is broken.
 *
 * IT HAD NO TEST AT ALL, and carried two defects that only a test would find — which is the whole
 * argument for testing the alarm rather than only the thing it watches:
 *
 * 1. **It addressed nobody.** `MANAGING_PARTNERS` holds names and ownership percentages and no
 *    `firm_user.id`, so `notifyQuietly` was called without `firmUserId` — which means FIRM-WIDE. The
 *    loop ran twice and sent the same firm-wide notice twice. "Escalate to both MPs" was doubling
 *    the noise rather than reaching two people, and the dedupe key differed only by first name so
 *    nothing collided to reveal it.
 * 2. **The all-clear spoke a different language from the alarm.** Escalation used `check.label`,
 *    recovery used `check_key`, so "Scooter's morning brief is down" came back as
 *    "daily_brief_fu_scooter_taylor is working again" — the same event in two vocabularies, one of
 *    them a column value. `label` was stored and never read back.
 */

let t: TestDb;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

/**
 * A fault already seen once, so the next run is the one that escalates.
 *
 * `escalated` plants a fault that has ALREADY been announced, which is the only state from which
 * the all-clear can fire — the recovery branch is guarded on `fault.escalated_at`.
 */
async function plantFault(key: string, label: string, firstSeen: string, escalated?: string): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO health_fault (id, check_key, label, first_seen_at, escalated_at, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, 'west-peek')`,
  )
    .bind(`hf_${key}`, key, label, firstSeen, escalated ?? null)
    .run();
}

/**
 * A check key that this environment genuinely reports DOWN.
 *
 * WHY THIS IS NOT A LITERAL, AND WHY IT MATTERS MORE THAN IT LOOKS. Both tests below used to plant
 * a fault under the invented key `planted_down`. No such CHECK exists, so `runHealthEscalation`
 * never saw it in `down`, never escalated it, and wrote no notification at all — and the assertions
 * were `rows.every(...)` over an empty array and an `if (recovery)` that simply did not run. Two
 * tests, both green, both examining nothing, in the file that tests the alarm. That is the exact
 * defect this repo hunts by name: a guard that cannot reach what it governs.
 *
 * Anchoring on a real DOWN check means the escalation actually happens, and the helper throws loudly if
 * the environment ever stops producing one rather than quietly reverting these to vacuous.
 */
async function aDownCheckKey(): Promise<string> {
  const down = (await runHealthChecks(env)).filter((c) => c.state === "DOWN");
  if (down.length === 0) throw new Error("no check reports DOWN in this environment: these tests would examine nothing");
  return down[0]!.key;
}

describe("escalation reaches the partners, once each", () => {
  it("addresses each Managing Partner by id rather than broadcasting twice", async () => {
    // A key the board actually reports DOWN, so the escalation branch is genuinely entered.
    const key = await aDownCheckKey();
    await plantFault(key, "Scooter's morning brief", "2026-08-01T00:00:00.000Z");
    await runHealthEscalation(env, new Date());

    const notes = await env.WP_OS_DB.prepare(
      "SELECT firm_user_id, title, dedupe_key FROM notification WHERE object_type = 'health_fault' AND object_id = ?1",
    ).bind(key).all<{ firm_user_id: string | null; title: string; dedupe_key: string }>();
    const rows = notes.results ?? [];

    // Hard-fails on nothing to examine: every assertion below is vacuously true over an empty list,
    // which is precisely how this test spent its life green while escalating nobody.
    expect(rows.length, "no escalation was written, so nothing was checked").toBeGreaterThan(0);

    // Nothing firm-wide: a notice addressed to nobody is not an escalation.
    expect(rows.every((r) => r.firm_user_id), "every escalation names a recipient").toBe(true);

    // One per partner, and the dedupe key is keyed by RECIPIENT so neither gets two.
    const recipients = new Set(rows.map((r) => r.firm_user_id));
    expect(recipients.size).toBe(rows.length);
    expect(recipients.size).toBeLessThanOrEqual(MANAGING_PARTNERS.length);
    expect(new Set(rows.map((r) => r.dedupe_key)).size).toBe(rows.length);
  });

  it("says the same words in the all-clear as it said in the alarm", async () => {
    // Already announced, and not a real check — so this run finds it absent from `down` and clears
    // it. `escalated_at` is what the recovery branch is guarded on.
    await plantFault("planted_clears", "Scooter's morning brief", "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z");
    const before = await env.WP_OS_DB.prepare(
      "SELECT label FROM health_fault WHERE check_key = 'planted_clears'",
    ).first<{ label: string }>();

    await runHealthEscalation(env, new Date());

    const recovery = await env.WP_OS_DB.prepare(
      "SELECT title FROM notification WHERE dedupe_key LIKE 'health_recovered:planted_clears:%' ORDER BY created_at DESC LIMIT 1",
    ).first<{ title: string }>();

    /*
     * HARD-FAILS ON NOTHING TO EXAMINE. This assertion used to sit inside `if (recovery)`, so a
     * change that stopped the all-clear being sent AT ALL would have passed this test in silence —
     * a guard that cannot reach what it governs, in the file whose whole subject is monitors that
     * report while doing nothing.
     */
    expect(recovery, "no all-clear was sent, so nothing was checked").toBeTruthy();
    // A partner told "daily_brief_fu_scooter_taylor is working again" has to work out that it is
    // the same thing she was told was down. The label is stored precisely so she does not have to.
    expect(recovery!.title).toContain(before!.label);
    expect(recovery!.title).not.toMatch(/_fu_|^[a-z_]+ is working/);
  });

  /*
   * THE ALL-CLEAR IS ADDRESSED, AND IT WAS NOT.
   *
   * The alarm was fixed to write one row per named partner. Its sibling four lines below kept
   * calling `notifyQuietly` with no `firmUserId` — a FIRM-WIDE row, and `notify()` can only load a
   * preference row for a NAMED person, so a firm-wide notice skips the preference block entirely:
   * per-kind switches, minimum severity and quiet hours are all dead for it.
   *
   * CONFIRMED in production on 9 Sep 2026: all twelve `health_recovered:%` rows carry
   * `firm_user_id = NULL`. Every all-clear this system has ever sent ignored the quiet hours the
   * operator asked for by name. The alarm respected them; the all-clear did not; nothing said so.
   */
  it("addresses the all-clear to each partner, so quiet hours apply to it too", async () => {
    await plantFault("planted_recovers", "The planted check", "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z");
    await runHealthEscalation(env, new Date()); // no longer down, so this run clears it

    const rows = (
      await env.WP_OS_DB.prepare(
        "SELECT firm_user_id, dedupe_key FROM notification WHERE dedupe_key LIKE 'health_recovered:planted_recovers:%'",
      ).all<{ firm_user_id: string | null; dedupe_key: string }>()
    ).results ?? [];

    // Hard-fails on an empty set rather than passing an empty loop.
    expect(rows.length, "no all-clear rows to examine").toBeGreaterThan(0);
    expect(
      rows.every((r) => Boolean(r.firm_user_id)),
      "an all-clear with firm_user_id NULL bypasses quiet hours and every per-kind preference",
    ).toBe(true);
    // One each, never two to the same person.
    expect(new Set(rows.map((r) => r.firm_user_id)).size).toBe(rows.length);
  });
});
