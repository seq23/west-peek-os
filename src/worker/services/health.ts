import type { RouteContext } from "../router";
import { json } from "../router";
import { ago, summarise, worstOf, type HealthCheck } from "../../shared/health/checks";
// The browser and the cheap tier are platform bindings that do not carry the WP_OS_ prefix.
// Reading them through their owning module keeps the one cast in the one file that owns it.
import { browserConfigured } from "../effects/browserClient";
import { STALE_AFTER_MINUTES } from "./dailyIntelligence";
import { workersAiConfigured } from "../ai/runAi";

/**
 * GET /api/diagnostics/health — is anything broken, and what do I do about it.
 *
 * WHAT THIS REPLACED. The page listed four bindings as "bound" and counted approvals. That answers
 * "did the deploy work", which is not what anybody opens Diagnostics to find out. Nothing on it
 * would have shown that the morning brief had failed three days running, that a scheduled job was
 * switched on with its employee switched off, or that a feature had been throwing silently since
 * Tuesday — all of which were true at various points today.
 *
 * EVERY CHECK READS SOMETHING REAL. No check returns a bare OK: each carries the measurement it
 * made, so a green light can be disbelieved and checked. Where a check can be red, it names the
 * page that fixes it, because "AI provider unavailable" without a destination is a puzzle rather
 * than a report.
 */
export async function handleSystemHealth(ctx: RouteContext): Promise<Response> {
  const { env } = ctx;
  const checks: HealthCheck[] = [];
  /*
   * A QUERY THAT THREW MUST NOT READ AS A ZERO. This page exists because failures were being
   * swallowed, so swallowing one here would be the joke telling itself: a broken `document`
   * query would return null, become "0 documents filed", and print a confident remedy about a
   * bucket that is fine. Catching keeps one bad table from blanking the whole board, and the
   * names of what failed are reported as their own red check rather than folded into a count.
   */
  const unreadable: string[] = [];
  const one = async <T>(what: string, sql: string, ...binds: unknown[]): Promise<T | null> => {
    try {
      return await env.WP_OS_DB.prepare(sql).bind(...binds).first<T>();
    } catch {
      unreadable.push(what);
      return null;
    }
  };

  // ── The database, and whether the schema is the one this code expects ──
  const schema = await one<{ migration: string }>("schema_version", "SELECT migration FROM schema_version ORDER BY migration DESC LIMIT 1");
  checks.push({
    key: "database",
    label: "Database",
    state: schema ? "OK" : "DOWN",
    reading: schema ? `reachable · schema ${schema.migration}` : "not reachable",
    remedy: schema ? undefined : "The Worker cannot read D1. Nothing else on this page is trustworthy until that is fixed.",
  });

  // ── Storage. Bound is not the same as working, and `document` sat empty for months while every
  //    binding reported healthy — so this reads the count that proves a write has ever succeeded.
  const docs = await one<{ n: number }>("document", "SELECT COUNT(*) AS n FROM document");
  checks.push({
    key: "storage",
    label: "Document storage",
    state: !env.WP_OS_DOCUMENTS ? "DOWN" : (docs?.n ?? 0) > 0 ? "OK" : "DEGRADED",
    reading: !env.WP_OS_DOCUMENTS
      ? "no bucket bound"
      : `${docs?.n ?? 0} document${docs?.n === 1 ? "" : "s"} filed`,
    remedy: (docs?.n ?? 0) === 0 ? "Bound, but nothing has ever been written to it. A brief or an image would prove it works." : undefined,
  });

  /*
   * ── The morning brief, PER PARTNER ──
   *
   * The first cut of this read one global "Morning brief" and turned red because three runs had
   * failed in three days. Both facts were true and the conclusion was wrong: the failures were
   * spread across two partners with entirely independent briefs, and on most of those days one
   * partner's brief landed perfectly well. The operator had been reading her brief while this page
   * called the brief broken.
   *
   * There are two briefs. A board that averages them tells neither partner what happened to theirs.
   */
  const briefs = ((await env.WP_OS_DB.prepare(
    `SELECT u.id, u.full_name,
            (SELECT status FROM intelligence_report r
              WHERE r.firm_user_id = u.id ORDER BY r.report_date DESC, r.started_at DESC LIMIT 1) AS status,
            (SELECT report_date FROM intelligence_report r
              WHERE r.firm_user_id = u.id ORDER BY r.report_date DESC, r.started_at DESC LIMIT 1) AS report_date,
            (SELECT error_message FROM intelligence_report r
              WHERE r.firm_user_id = u.id ORDER BY r.report_date DESC, r.started_at DESC LIMIT 1) AS error_message,
            (SELECT started_at FROM intelligence_report r
              WHERE r.firm_user_id = u.id ORDER BY r.report_date DESC, r.started_at DESC LIMIT 1) AS started_at,
            (SELECT COUNT(*) FROM intelligence_report r
              WHERE r.firm_user_id = u.id AND r.status = 'FAILED' AND r.report_date >= date('now','-7 day')) AS fails
       FROM firm_user u
       JOIN firm_user_role fr ON fr.firm_user_id = u.id AND fr.role_id = 'role_managing_partner'
      WHERE u.status = 'ACTIVE'
      ORDER BY u.full_name`,
  ).all<{ id: string; full_name: string; status: string | null; report_date: string | null; error_message: string | null; started_at: string | null; fails: number }>()
    .catch(() => {
      unreadable.push("intelligence_report");
      return { results: [] };
    })).results ?? []);

  const TERMINAL = new Set(["READY", "FAILED"]);
  for (const b of briefs) {
    const firstName = b.full_name.split(" ")[0] ?? b.full_name;
    /*
     * Mid-flight is normal for a few minutes and stuck after that. The threshold is the pipeline's
     * own — the same STALE_AFTER_MINUTES the sweeper closes rows out on — so the board and the
     * sweeper can never disagree about whether a run is still going.
     */
    const ageMinutes = b.started_at ? (Date.now() - new Date(b.started_at).getTime()) / 60_000 : 0;
    const stuck = b.status !== null && !TERMINAL.has(b.status) && ageMinutes > STALE_AFTER_MINUTES;
    checks.push({
      key: `daily_brief_${b.id}`,
      label: `${firstName}'s brief`,
      state:
        !b.status ? "DEGRADED"
        : b.status === "READY" ? "OK"
        : b.status === "FAILED" || stuck ? "DOWN"
        : "DEGRADED",
      reading: b.status
        ? `${b.report_date} · ${
            b.status === "READY" ? "delivered"
            : stuck ? `stopped part-way, ${ago(b.started_at)}`
            : b.status.toLowerCase()
          }${b.fails > 0 ? ` · ${b.fails} failed this week` : ""}`
        : "none has ever been built",
      remedy:
        b.status === "FAILED"
          ? (b.error_message ?? "It failed. Build it again from Home.")
          : stuck
            ? "It stopped part-way through and never finished. Build it again from Home."
            : undefined,
      page: "home",
    });
  }
  if (briefs.length === 0) {
    checks.push({
      key: "daily_brief",
      label: "Morning brief",
      state: "DEGRADED",
      reading: "no active managing partner to write one for",
      page: "employees",
    });
  }

  // ── Scheduled work, and the specific silent failure: on, with its employee off ──
  const jobs = ((await env.WP_OS_DB.prepare(
    `SELECT j.job_key, j.status, j.target_kind, j.target_id, j.last_run_at,
            (SELECT status FROM job_run r WHERE r.job_id = j.id ORDER BY started_at DESC LIMIT 1) AS last_status
       FROM scheduled_job j`,
  ).all<{ job_key: string; status: string; target_kind: string; target_id: string | null; last_run_at: string | null; last_status: string | null }>()
    .catch(() => ({ results: [] }))).results ?? []);
  const employees = ((await env.WP_OS_DB.prepare("SELECT name, status FROM ai_employee").all<{ name: string; status: string }>()
    .catch(() => ({ results: [] }))).results ?? []);
  const byName = new Map(employees.map((e) => [e.name, e.status]));

  const active = jobs.filter((j) => j.status === "ACTIVE");
  const stalled = active.filter((j) => j.target_kind === "EMPLOYEE" && j.target_id && byName.get(j.target_id) !== "ACTIVE");
  const failing = active.filter((j) => j.last_status === "FAILED" || j.last_status === "DEAD_LETTER");
  checks.push({
    key: "scheduled_work",
    label: "Scheduled work",
    state: failing.length > 0 ? "DOWN" : stalled.length > 0 ? "DEGRADED" : active.length > 0 ? "OK" : "DEGRADED",
    reading: `${active.length} of ${jobs.length} running${failing.length ? ` · ${failing.length} failing` : ""}${stalled.length ? ` · ${stalled.length} cannot run` : ""}`,
    remedy: stalled.length
      ? `${stalled.map((j) => j.target_id).join(", ")} ${stalled.length === 1 ? "is" : "are"} switched off, so ${stalled.length === 1 ? "that job" : "those jobs"} cannot run.`
      : failing.length
        ? `${failing.map((j) => j.job_key).join(", ")} failed on the last attempt.`
        : active.length === 0 ? "Nothing is scheduled to run." : undefined,
    page: "work-cards",
  });

  // ── The workforce ──
  const activeEmployees = employees.filter((e) => e.status === "ACTIVE").length;
  checks.push({
    key: "workforce",
    label: "AI employees",
    state: activeEmployees > 0 ? "OK" : "DOWN",
    reading: `${activeEmployees} switched on of ${employees.filter((e) => e.status !== "RETIRED").length} employed`,
    remedy: activeEmployees === 0 ? "Nobody is switched on, so no work of any kind can run." : undefined,
    page: "employees",
  });

  // ── The model boundary: is anything actually reaching a provider ──
  const lastRun = await one<{ created_at: string; status: string }>("ai_run", "SELECT created_at, status FROM ai_run ORDER BY created_at DESC LIMIT 1",
  );
  const blocked = await one<{ n: number }>("ai_run", "SELECT COUNT(*) AS n FROM ai_run WHERE status != 'COMPLETED' AND date(created_at) = date('now')",
  );
  checks.push({
    key: "ai",
    label: "AI runs",
    state: !lastRun ? "DEGRADED" : (blocked?.n ?? 0) > 3 ? "DEGRADED" : "OK",
    reading: lastRun
      ? `last run ${ago(lastRun.created_at)}${(blocked?.n ?? 0) > 0 ? ` · ${blocked!.n} blocked or failed today` : ""}`
      : "nothing has ever run",
    page: "ai-ops",
  });

  // ── Spend against the cap ──
  const policy = await one<{ daily_cap_usd: number }>("budget_policy", "SELECT daily_cap_usd FROM budget_policy ORDER BY rowid DESC LIMIT 1");
  const today = await one<{ spent: number }>("ai_run spend", "SELECT COALESCE(SUM(json_extract(actual_usage_json,'$.cost_usd')),0) AS spent FROM ai_run WHERE date(created_at) = date('now')",
  );
  const cap = policy?.daily_cap_usd ?? 0;
  const spent = Number(today?.spent ?? 0);
  const pct = cap > 0 ? (spent / cap) * 100 : 0;
  checks.push({
    key: "spend",
    label: "Spend today",
    state: pct >= 90 ? "DOWN" : pct >= 70 ? "DEGRADED" : "OK",
    reading: `$${spent.toFixed(4)} of $${cap} · ${Math.round(pct)}% of the daily cap`,
    remedy: pct >= 70 ? "Close to the cap. Work will start being refused when it is reached." : undefined,
    page: "ai-ops",
  });

  // ── Failures that were deliberately swallowed. The whole reason recordSwallowed() exists. ──
  const swallowed = await one<{ n: number; last: string | null }>("event_record", "SELECT COUNT(*) AS n, MAX(created_at) AS last FROM event_record WHERE event_type = 'system.swallowed_failure' AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 day')",
  );
  checks.push({
    key: "silent_failures",
    label: "Silent failures",
    state: (swallowed?.n ?? 0) === 0 ? "OK" : (swallowed?.n ?? 0) > 5 ? "DOWN" : "DEGRADED",
    reading: (swallowed?.n ?? 0) === 0 ? "none in 7 days" : `${swallowed!.n} in 7 days · last ${ago(swallowed!.last)}`,
    remedy: (swallowed?.n ?? 0) > 0 ? "Something failed without failing the caller. The Record page has each one and what it was." : undefined,
    page: "record",
  });

  // ── Outbound email and image generation: configured or not, stated plainly ──
  checks.push({
    key: "email",
    label: "Outbound email",
    state: env.WP_OS_EMAIL_SEND === "enabled" ? "OK" : "DEGRADED",
    reading: env.WP_OS_EMAIL_SEND === "enabled" ? `sending as ${env.WP_OS_EMAIL_FROM ?? "unset"}` : "switched off — approved messages are recorded, not sent",
    page: "integrations",
  });
  checks.push({
    key: "images",
    label: "Image generation",
    state: env.RUNWARE_API_KEY ? "OK" : "DEGRADED",
    reading: env.RUNWARE_API_KEY ? "configured" : "no credential bound",
    page: "integrations",
  });
  checks.push({
    key: "browser",
    label: "Browser",
    state: browserConfigured(env) ? "OK" : "DEGRADED",
    reading: browserConfigured(env) ? "bound — employees can read live pages" : "not bound — nothing can open a page",
  });
  checks.push({
    key: "cheap_tier",
    label: "Cheap model tier",
    state: workersAiConfigured(env) ? "OK" : "DEGRADED",
    reading: workersAiConfigured(env) ? "Workers AI bound — routine work can run near free" : "not bound — everything routes to paid models",
    page: "ai-ops",
  });

  // Reported last so it names everything that failed above, and reported at all so a check that
  // could not run is never mistaken for a check that came back clean.
  if (unreadable.length > 0) {
    const tables = [...new Set(unreadable)];
    checks.push({
      key: "readings",
      label: "Readings on this page",
      state: "DOWN",
      reading: `${tables.length} could not be taken: ${tables.join(", ")}`,
      remedy: "The counts above that depend on those tables are not measurements. Treat them as unknown.",
    });
  }

  return json({ overall: worstOf(checks), summary: summarise(checks), checks, checked_at: new Date().toISOString() });
}
