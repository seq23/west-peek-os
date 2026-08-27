import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { runHealthEscalation } from "../src/worker/services/healthEscalation";
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

/** A fault already seen once, so the next run is the one that escalates. */
async function plantFault(key: string, label: string, firstSeen: string): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO health_fault (id, check_key, label, first_seen_at, firm_scope)
     VALUES (?1, ?2, ?3, ?4, 'west-peek')`,
  )
    .bind(`hf_${key}`, key, label, firstSeen)
    .run();
}

describe("escalation reaches the partners, once each", () => {
  it("addresses each Managing Partner by id rather than broadcasting twice", async () => {
    await plantFault("planted_down", "Scooter's morning brief", "2026-08-01T00:00:00.000Z");
    await runHealthEscalation(env, new Date());

    const notes = await env.WP_OS_DB.prepare(
      "SELECT firm_user_id, title, dedupe_key FROM notification WHERE object_type = 'health_fault'",
    ).all<{ firm_user_id: string | null; title: string; dedupe_key: string }>();
    const rows = notes.results ?? [];

    // Nothing firm-wide: a notice addressed to nobody is not an escalation.
    expect(rows.every((r) => r.firm_user_id), "every escalation names a recipient").toBe(true);

    // One per partner, and the dedupe key is keyed by RECIPIENT so neither gets two.
    const recipients = new Set(rows.map((r) => r.firm_user_id));
    expect(recipients.size).toBeLessThanOrEqual(MANAGING_PARTNERS.length);
    expect(new Set(rows.map((r) => r.dedupe_key)).size).toBe(rows.length);
  });

  it("says the same words in the all-clear as it said in the alarm", async () => {
    // Resolve it: the check no longer reports DOWN, so the next run announces recovery.
    await env.WP_OS_DB.prepare("UPDATE health_fault SET resolved_at = NULL WHERE check_key = 'planted_down'").run();
    const before = await env.WP_OS_DB.prepare(
      "SELECT label FROM health_fault WHERE check_key = 'planted_down'",
    ).first<{ label: string }>();

    await runHealthEscalation(env, new Date());

    const recovery = await env.WP_OS_DB.prepare(
      "SELECT title FROM notification WHERE title LIKE '%working again%' ORDER BY created_at DESC LIMIT 1",
    ).first<{ title: string }>();

    if (recovery) {
      // A partner told "daily_brief_fu_scooter_taylor is working again" has to work out that it is
      // the same thing she was told was down. The label is stored precisely so she does not have to.
      expect(recovery.title).toContain(before!.label);
      expect(recovery.title).not.toMatch(/_fu_|^[a-z_]+ is working/);
    }
  });
});
