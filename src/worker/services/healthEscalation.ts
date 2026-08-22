import type { Env } from "../env";
import { appendEvent } from "../events";
import { runHealthChecks } from "./health";
import { notifyQuietly } from "./notifications";
import { MANAGING_PARTNERS } from "../../shared/registry/managingPartners";

/**
 * Diagnostics that runs when nobody is watching, and tells somebody when it finds something.
 *
 * Operator, item 22: "Fix the three red diagnostics; decide the check interval; escalate unresolved
 * items to both MPs, with a table showing what was escalated and whether it is being worked."
 *
 * THE REVIEW CORRECTED THE PREMISE AND FOUND SOMETHING WORSE. Diagnostics DOES detect, accurately —
 * it reports what is broken and why. It runs only when a partner opens the page, and it tells
 * nobody. A monitor that checks while you are watching is a mirror.
 *
 * THE INTERVAL, DECIDED: every tick, which is fifteen minutes. The checks are a handful of COUNT
 * queries against D1 and cost nothing, and the failures they catch — a dead binding, a job whose
 * employee is switched off, a provider with no credential — are exactly the kind that sit unnoticed
 * for days. There is no argument for checking less often than the cheapest thing on the schedule.
 *
 * IT ESCALATES ONLY WHAT PERSISTS. A check that is DOWN on one tick is often a transient — a
 * provider blip, a query that lost a race. Escalating those trains a partner to ignore the alert,
 * which is worse than not sending it. So a fault has to be seen DOWN on two consecutive runs before
 * anybody is told, and it is told once rather than every quarter of an hour until fixed.
 *
 * BOTH PARTNERS, because "somebody will see it" is how a thing goes unowned. The firm has two people
 * and a broken system is both of their problem.
 *
 * AND IT SAYS WHEN IT RECOVERS. An alert with no all-clear leaves a partner unable to tell a fixed
 * fault from one nobody has mentioned lately.
 */

/** The state carried between runs, so "still down" can be told from "down again". */
interface FaultRow {
  check_key: string;
  first_seen_at: string;
  escalated_at: string | null;
}

export async function runHealthEscalation(
  env: Env,
  now: Date,
): Promise<{ checked: number; down: number; escalated: string[]; recovered: string[] }> {
  const checks = await runHealthChecks(env);
  const down = checks.filter((c) => c.state === "DOWN");
  const downKeys = new Set(down.map((c) => c.key));

  const open = (
    await env.WP_OS_DB.prepare("SELECT check_key, first_seen_at, escalated_at FROM health_fault WHERE resolved_at IS NULL").all<FaultRow>()
  ).results ?? [];
  const openByKey = new Map(open.map((f) => [f.check_key, f]));

  const escalated: string[] = [];
  const recovered: string[] = [];
  const stamp = now.toISOString();

  for (const check of down) {
    const existing = openByKey.get(check.key);
    if (!existing) {
      // First sighting. Recorded, not escalated — one bad tick is usually a blip, and crying about
      // it is how a partner learns to ignore this.
      await env.WP_OS_DB.prepare(
        "INSERT INTO health_fault (id, check_key, label, reading, remedy, first_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
        .bind(`hf_${crypto.randomUUID()}`, check.key, check.label, check.reading, check.remedy ?? null, stamp)
        .run();
      continue;
    }
    if (existing.escalated_at) continue; // Already told them once. Telling them again is noise.

    await env.WP_OS_DB.prepare("UPDATE health_fault SET escalated_at = ?2, reading = ?3 WHERE check_key = ?1 AND resolved_at IS NULL")
      .bind(check.key, stamp, check.reading)
      .run();

    for (const mp of MANAGING_PARTNERS) {
      await notifyQuietly(env, {
        // PROVIDER_FAILURE rather than a new kind: the notification kinds are a CHECK constraint
        // in the database, and widening it for one caller would be a migration to say a thing the
        // nearest existing kind already says.
        kind: "PROVIDER_FAILURE",
        severity: "WARNING",
        title: `${check.label} is down`,
        body: `${check.reading}${check.remedy ? ` — ${check.remedy}` : ""}`,
        objectType: "health_fault",
        objectId: check.key,
        // One per fault per partner, so a fault that lasts a week does not send 672 notifications.
        dedupeKey: `health_fault:${check.key}:${existing.first_seen_at}:${mp.firstName}`,
        firmScope: "west-peek",
      });
    }
    escalated.push(check.key);
  }

  // Recovery. An alert with no all-clear leaves a partner unable to tell a fixed fault from one
  // nobody has mentioned lately.
  for (const fault of open) {
    if (downKeys.has(fault.check_key)) continue;
    await env.WP_OS_DB.prepare("UPDATE health_fault SET resolved_at = ?2 WHERE check_key = ?1 AND resolved_at IS NULL")
      .bind(fault.check_key, stamp)
      .run();
    recovered.push(fault.check_key);
    if (fault.escalated_at) {
      await notifyQuietly(env, {
        kind: "PROVIDER_FAILURE",
        severity: "INFO",
        title: `${fault.check_key} is working again`,
        body: "It had been reported as down. Nothing else was changed by this check.",
        objectType: "health_fault",
        objectId: fault.check_key,
        dedupeKey: `health_recovered:${fault.check_key}:${stamp.slice(0, 13)}`,
        firmScope: "west-peek",
      });
    }
  }

  if (escalated.length > 0 || recovered.length > 0) {
    await appendEvent(env, {
      eventType: "health.escalated",
      actorType: "system",
      actorId: "diagnostics",
      objectType: "health_fault",
      objectId: "sweep",
      firmScope: "west-peek",
      payload: { escalated, recovered, down: down.map((d) => d.key) },
    });
  }

  return { checked: checks.length, down: down.length, escalated, recovered };
}

/** What was escalated and whether it is still open — the table item 22 asked for. */
export async function openFaults(env: Env) {
  const rows = (
    await env.WP_OS_DB.prepare(
      `SELECT check_key, label, reading, remedy, first_seen_at, escalated_at, resolved_at
         FROM health_fault
        ORDER BY resolved_at IS NULL DESC, first_seen_at DESC
        LIMIT 50`,
    ).all()
  ).results ?? [];
  return rows;
}
