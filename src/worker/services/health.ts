import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { ago, summarise, worstOf, type HealthCheck } from "../../shared/health/checks";
// The browser and the cheap tier are platform bindings that do not carry the WP_OS_ prefix.
// Reading them through their owning module keeps the one cast in the one file that owns it.
import { browserConfigured } from "../effects/browserClient";
import { STALE_AFTER_MINUTES } from "./dailyIntelligence";
import { dailySpendUsd, workersAiConfigured } from "../ai/runAi";
import { actionName } from "../../shared/help/actionNames";

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
/**
 * Run every check. Takes `env` rather than a request so a scheduled job can call it.
 *
 * ITEM 22: "Fix the three red diagnostics; decide the check interval; escalate to MPs." The review
 * corrected the operator's guess about the first part and found something worse about the rest —
 * Diagnostics DOES detect, accurately. It runs only when somebody opens the page, and it tells
 * nobody. A monitor that checks while you are watching is a mirror.
 */
export async function runHealthChecks(env: Env): Promise<HealthCheck[]> {
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
    .catch(() => {
      unreadable.push("scheduled_job");
      return { results: [] };
    })).results ?? []);
  /*
   * NAMED WHEN IT FAILS, like every other read on this board.
   *
   * These two swallowed their errors and pushed nothing, so an unreadable `ai_employee` produced
   * `employees = []` and the workforce check below then reported DOWN with "0 switched on of 0
   * employed" and "Nobody is switched on, so no work of any kind can run." — a confident diagnosis
   * of a fact nobody had established, which `runHealthEscalation` then sends to both partners. The
   * "Readings on this page" check exists precisely so "a check that could not run is never mistaken
   * for a check that came back clean", and these two were the ones it could not see.
   */
  const employees = ((await env.WP_OS_DB.prepare("SELECT id, name, status FROM ai_employee").all<{ id: string; name: string; status: string }>()
    .catch(() => {
      unreadable.push("ai_employee");
      return { results: [] };
    })).results ?? []);
  /*
   * Keyed by id AND name. `scheduled_job.target_id` holds the id after migration 0087; keying on
   * name alone would have turned every EMPLOYEE job amber the moment that landed — the same
   * disagreement this board exists to surface, committed by the board itself.
   */
  const byRef = new Map<string, { status: string; name: string }>();
  for (const e of employees) {
    byRef.set(e.id, { status: e.status, name: e.name });
    byRef.set(e.name, { status: e.status, name: e.name });
  }

  const active = jobs.filter((j) => j.status === "ACTIVE");
  const stalled = active.filter((j) => j.target_kind === "EMPLOYEE" && j.target_id && byRef.get(j.target_id)?.status !== "ACTIVE");
  const failing = active.filter((j) => j.last_status === "FAILED" || j.last_status === "DEAD_LETTER");
  /*
   * A JOB THAT KEEPS BEING REFUSED IS NOT RUNNING, and this check could not see it.
   *
   * `runJob` records `job_run.refused` and returns — no notification, and REFUSED is not FAILED, so
   * it was invisible here too. Production holds two of them from 20 Aug that nobody was ever told
   * about. A refusal is usually legitimate and transient (a spend ceiling reached for the day, an
   * employee paused), which is exactly why it is DEGRADED rather than DOWN: the job is not broken,
   * it is not happening, and those need different words.
   */
  const refused = active.filter((j) => j.last_status === "REFUSED");
  /*
   * A LONG APPROVAL QUEUE IS A BUG REPORT, NOT A TO-DO LIST — and this check is the inversion.
   *
   * Research on alert fatigue is consistent and unkind: review quality collapses well before volume
   * feels overwhelming, and people begin batch-approving while believing they are still reading. For
   * two partners sharing one queue, more than ten pending at once does not mean the partners are
   * behind. It means something is classified wrong and is generating cards that were never a
   * decision.
   *
   * So this reports on the DESIGN and names the action keys producing the volume, because the fix is
   * to reclassify them — or to delegate them under ADR-018 — rather than to work harder. Reasoning
   * in docs/APPROVAL_AND_WORK_DESIGN.md.
   */
  // Caught like the rest: an uncaught throw here rejects `runHealthChecks` outright, so one bad
  // table 500s `GET /api/diagnostics/health` and takes `runHealthEscalation` down with it — the
  // opposite of this file's rule that catching keeps one bad table from blanking the whole board.
  const pending = await env.WP_OS_DB.prepare(
    `SELECT action_key, COUNT(*) AS n FROM approval_card
      WHERE state = 'pending_review' GROUP BY action_key ORDER BY n DESC`,
  )
    .all<{ action_key: string; n: number }>()
    .catch(() => {
      unreadable.push("approval_card");
      return { results: [] as Array<{ action_key: string; n: number }> };
    });
  const pendingRows = pending.results ?? [];
  const pendingTotal = pendingRows.reduce((sum, r) => sum + r.n, 0);
  const worst = pendingRows.slice(0, 3).map((r) => `${actionName(r.action_key)} (${r.n})`);
  checks.push({
    key: "approval_load",
    label: "Is the approval queue asking too much?",
    // DEGRADED rather than DOWN even when it is bad: nothing is broken, and a red light for a design
    // problem would train the partners to ignore red lights that mean something has actually failed.
    state: pendingTotal > 25 ? "DOWN" : pendingTotal > 10 ? "DEGRADED" : "OK",
    reading:
      pendingTotal === 0
        ? "Nothing waiting"
        : `${pendingTotal} waiting${worst.length ? ` · mostly ${worst.join(", ")}` : ""}`,
    remedy:
      pendingTotal > 10
        ? `Past about ten at once, a queue gets skimmed rather than read. ${worst.length ? `Most of this is ${worst.join(", ")} — ` : ""}the fix is to stop those needing a decision at all, or to delegate them for the day, not to get through them faster.`
        : undefined,
    page: "approvals",
  });

  checks.push({
    key: "scheduled_work",
    label: "Scheduled work",
    // DOWN MEANS DOWN. "Scheduled work is down — 8 of 9 running · 1 failing" went to both partners
    // on 14 Sep because one job's upstream (Network OS) answered 503. Eight jobs were running.
    // A red light for one failing job is the red light that gets ignored when everything stops;
    // one failing job is DEGRADED and named, and DOWN is kept for nothing running or everything
    // failing.
    state:
      active.length === 0 || (failing.length > 0 && failing.length >= active.length)
        ? "DOWN"
        : failing.length > 0 || stalled.length > 0 || refused.length > 0
          ? "DEGRADED"
          : "OK",
    reading: `${active.length} of ${jobs.length} running${failing.length ? ` · ${failing.length} failing` : ""}${stalled.length ? ` · ${stalled.length} cannot run` : ""}${refused.length ? ` · ${refused.length} refused` : ""}`,
    remedy: refused.length && !stalled.length && !failing.length
      ? `${refused.map((j) => j.job_key).join(", ")} ${refused.length === 1 ? "was" : "were"} refused on the last attempt — usually a spend ceiling or an employee who is switched off. Not broken, but not happening either.`
      : stalled.length
      ? `${stalled.map((j) => byRef.get(j.target_id!)?.name ?? j.target_id).join(", ")} ${stalled.length === 1 ? "is" : "are"} switched off, so ${stalled.length === 1 ? "that job" : "those jobs"} cannot run.`
      : failing.length
        ? `${failing.map((j) => j.job_key).join(", ")} failed on the last attempt.`
        : active.length === 0 ? "Nothing is scheduled to run." : undefined,
    page: "work",
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
    key: "ai-controls",
    label: "AI runs",
    state: !lastRun ? "DEGRADED" : (blocked?.n ?? 0) > 3 ? "DEGRADED" : "OK",
    reading: lastRun
      ? `last run ${ago(lastRun.created_at)}${(blocked?.n ?? 0) > 0 ? ` · ${blocked!.n} blocked or failed today` : ""}`
      : "nothing has ever run",
    page: "cockpit",
  });

  // ── Spend against the cap ──
  const policy = await one<{ daily_cap_usd: number }>("budget_policy", "SELECT daily_cap_usd FROM budget_policy ORDER BY rowid DESC LIMIT 1");
  /*
   * READ, NOT RE-DERIVED. This check used to run its own SQL: `SUM(actual_usage_json.cost_usd)` over
   * runs of ANY status. That counted a run the provider never priced as free and a blocked run as
   * if it had happened, so Diagnostics and Cockpit reported "today's spend" 28% apart wearing the
   * same label — and a partner reconciling two screens has no way to tell which is lying.
   *
   * `dailySpendUsd` is now one line over `ai/spend.ts`, which is also what the boundary refuses runs
   * against. If the cap is close on this page, it is close in the gate.
   */
  const cap = policy?.daily_cap_usd ?? 0;
  // Diagnostics reports the firm, and there is one. Kept behind the same catch as every other read
  // here so a spend query that throws shows as unreadable rather than as a comfortable $0.00.
  let spent = 0;
  try {
    spent = await dailySpendUsd(env, "west-peek");
  } catch {
    unreadable.push("ai_run spend");
  }
  const pct = cap > 0 ? (spent / cap) * 100 : 0;
  checks.push({
    key: "spend",
    label: "Spend today",
    state: pct >= 90 ? "DOWN" : pct >= 70 ? "DEGRADED" : "OK",
    reading: `$${spent.toFixed(4)} of $${cap} · ${Math.round(pct)}% of the daily cap`,
    remedy: pct >= 70 ? "Close to the cap. Work will start being refused when it is reached." : undefined,
    page: "cockpit",
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

  /*
   * ── THE DECK LANE, AND WHETHER ANYTHING IS COMING DOWN IT ──
   *
   * Operator, 9 Sep 2026: "i noticed i had to tell Wyatt to 'start' inputting the decks that came in
   * — this should be automatic not something he asks me if he can do."
   *
   * WHAT WAS ACTUALLY WRONG, which is not what it looked like. Wyatt does not ask. `deck_reading` is
   * ACTIVE, fires every fifteen minutes, needs no approval and has no gate — and in the seven days
   * to 9 Sep it succeeded 310 times, every single run reporting "no decks waiting". Two decks have
   * ever been enqueued and both were read on 23 August. The lane has had NO ARRIVALS IN SIXTEEN
   * DAYS and 310 green ticks said so in a way nobody could hear.
   *
   * That is Rule 0 exactly: a stage exiting 0 having done nothing, with no named stop. And it is why
   * a human became the trigger — not because the employee waits for permission, but because an
   * empty lane and a working lane were indistinguishable, so the only way to discover it was for a
   * partner to go and ask.
   *
   * SO THE QUIET IS REPORTED. An empty queue right after a read is health; an empty queue that has
   * been empty for a fortnight is a lane to look at. DEGRADED rather than DOWN: nothing is broken,
   * decks may genuinely not have been sent, and a red light for a quiet inbox would train two
   * partners to ignore red lights. It carries the real reading so the judgement stays with them.
   */
  const decks = await one<{ waiting: number; last_arrival: string | null; ever: number }>(
    "pending_deck",
    `SELECT SUM(state = 'PENDING') AS waiting, MAX(created_at) AS last_arrival, COUNT(*) AS ever
       FROM pending_deck`,
  );
  const QUIET_AFTER_DAYS = 7;
  const waiting = decks?.waiting ?? 0;
  const daysQuiet = decks?.last_arrival
    ? Math.floor((Date.now() - new Date(decks.last_arrival).getTime()) / 86_400_000)
    : null;
  checks.push({
    key: "deck_intake",
    label: "Decks arriving",
    state:
      waiting > 0 ? "OK"
      : daysQuiet === null ? "DEGRADED"
      : daysQuiet >= QUIET_AFTER_DAYS ? "DEGRADED"
      : "OK",
    reading:
      waiting > 0
        ? `${waiting} waiting to be read · one is read every tick`
        : daysQuiet === null
          ? "no deck has ever arrived"
          : `nothing has arrived for ${daysQuiet} day${daysQuiet === 1 ? "" : "s"} · last on ${decks!.last_arrival!.slice(0, 10)}`,
    remedy:
      waiting > 0 || (daysQuiet !== null && daysQuiet < QUIET_AFTER_DAYS)
        ? undefined
        : "Wyatt reads a deck every fifteen minutes and needs no permission to; there has been nothing to read. " +
          "Decks reach this queue as attachments on mail to the firm, so a long silence is either a quiet fortnight " +
          "or nothing reaching the inbox. Anything you have by hand can be put in from Capture.",
    page: "capture",
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
    page: "cockpit",
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

  return checks;
}

export async function handleSystemHealth(ctx: RouteContext): Promise<Response> {
  const checks = await runHealthChecks(ctx.env);
  return json({ overall: worstOf(checks), summary: summarise(checks), checks, checked_at: new Date().toISOString() });
}
