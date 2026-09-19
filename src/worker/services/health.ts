import type { Env } from "../env";
import { isAfterLocalTime, isWeekend, localReportDate } from "../../shared/intelligence/pipeline";
import type { RouteContext } from "../router";
import { json } from "../router";
import { ago, summarise, worstOf, type HealthCheck } from "../../shared/health/checks";
// The browser and the cheap tier are platform bindings that do not carry the WP_OS_ prefix.
// Reading them through their owning module keeps the one cast in the one file that owns it.
import { browserConfigured } from "../effects/browserClient";
import { BRIEF_SENTINEL_GRACE_MINUTES, STALE_AFTER_MINUTES } from "./dailyIntelligence";
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
              WHERE r.firm_user_id = u.id AND r.status = 'FAILED' AND r.report_date >= date('now','-7 day')) AS fails,
            COALESCE(p.timezone, 'America/Chicago') AS timezone,
            COALESCE(p.earliest_start_local, '06:15') AS earliest_start_local,
            COALESCE(p.enabled, 1) AS enabled,
            COALESCE(p.weekends, 1) AS weekends
       FROM firm_user u
       JOIN firm_user_role fr ON fr.firm_user_id = u.id AND fr.role_id = 'role_managing_partner'
       LEFT JOIN partner_intelligence_profile p ON p.firm_user_id = u.id
      WHERE u.status = 'ACTIVE'
      ORDER BY u.full_name`,
  ).all<{ id: string; full_name: string; status: string | null; report_date: string | null; error_message: string | null; started_at: string | null; fails: number; timezone: string; earliest_start_local: string; enabled: number; weekends: number }>()
    .catch(() => {
      unreadable.push("intelligence_report");
      return { results: [] };
    })).results ?? []);

  const TERMINAL = new Set(["READY", "FAILED"]);
  /** "06:15" + 105 → "08:00". A malformed hour is treated as its floor rather than as a throw. */
  const plusMinutes = (hhmm: string, minutes: number): string => {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm.trim());
    const total = (m ? Number(m[1]) * 60 + Number(m[2]) : 6 * 60 + 15) + minutes;
    return `${String(Math.floor((total % 1440) / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  };
  for (const b of briefs) {
    const firstName = b.full_name.split(" ")[0] ?? b.full_name;
    /*
     * Mid-flight is normal for a few minutes and stuck after that. The threshold is the pipeline's
     * own — the same STALE_AFTER_MINUTES the sweeper closes rows out on — so the board and the
     * sweeper can never disagree about whether a run is still going.
     */
    const ageMinutes = b.started_at ? (Date.now() - new Date(b.started_at).getTime()) / 60_000 : 0;
    const stuck = b.status !== null && !TERMINAL.has(b.status) && ageMinutes > STALE_AFTER_MINUTES;
    /*
     * THE SENTINEL (19 Sep 2026): by BRIEF_SENTINEL_GRACE_MINUTES after the partner's earliest
     * start, on a day the schedule builds, today's row must EXIST and be either READY or FAILED
     * with a reason. A morning with no row at all is the one failure the row-based checks above
     * cannot see — it is what happened on Saturday 19 Sep, when the schedule skipped the day and
     * nothing anywhere was red. "No brief and no explanation" is DOWN, named as such.
     */
    const now = new Date();
    const today = localReportDate(now, b.timezone);
    const buildsToday = b.enabled === 1 && (b.weekends === 1 || !isWeekend(now, b.timezone));
    const pastSentinel = buildsToday && isAfterLocalTime(now, b.timezone, plusMinutes(b.earliest_start_local, BRIEF_SENTINEL_GRACE_MINUTES));
    const missing = pastSentinel && b.report_date !== today;
    const unstated = pastSentinel && b.report_date === today && b.status === "FAILED" && !(b.error_message ?? "").trim();
    checks.push({
      key: `daily_brief_${b.id}`,
      label: `${firstName}'s brief`,
      state:
        missing || unstated ? "DOWN"
        : !b.status ? "DEGRADED"
        : b.status === "READY" ? "OK"
        : b.status === "FAILED" || stuck ? "DOWN"
        : "DEGRADED",
      reading: missing
        ? `${today} · no brief and no explanation — the clock never started one${b.report_date ? `; the last row is ${b.report_date}` : ""}`
        : b.status
        ? `${b.report_date} · ${
            b.status === "READY" ? "delivered"
            : stuck ? `stopped part-way, ${ago(b.started_at)}`
            : b.status.toLowerCase()
          }${b.fails > 0 ? ` · ${b.fails} failed this week` : ""}`
        : "none has ever been built",
      remedy:
        missing
          ? `It should have started at ${b.earliest_start_local} ${b.timezone} and the tick serves it every minute; if this stays red the cron is not firing. Press "Build today's brief" on Home now.`
          : unstated
            ? "It failed and the run did not record why. Build it again from Home; if it fails the same way, the lane that wrote it is the thing to look at."
            : b.status === "FAILED"
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
   * ── THE DECK LANE: CAN IT RECEIVE A DECK, NOT HAS IT RECENTLY ──
   *
   * Operator, 18 Sep 2026, reading her own Home: "decks arriving is not broken. we just dont get
   * decks every day. he should not check every 15 min."
   *
   * WHAT THIS CHECK USED TO ASSERT, AND WHY IT WAS WRONG. It measured the age of the last arrival
   * and went DEGRADED past seven days. On 18 Sep that rendered as "Decks arriving · Needs a look ·
   * nothing has arrived for 25 days", beside a check that was genuinely failing. Both wore the same
   * amber. The quiet was TRUE and it was not a fault: this firm is sent a deck a few times a month,
   * so the check fired on the ordinary condition of the business it was watching.
   *
   * A check that fires on normal is worse than no check. It does not merely fail to inform; it
   * spends the reader's attention on nothing and teaches her that this board can be skimmed — and
   * the next light she skims is the one that meant something. The earlier note in this file argued
   * DEGRADED-not-DOWN on exactly that logic and then made the same mistake one rung down.
   *
   * RAISING THE THRESHOLD WOULD BE THE SAME BUG WITH A LATER FUSE. Sixty days instead of twenty-five
   * still asserts that silence is evidence, and silence is evidence of nothing: a quiet quarter and
   * a mailbox that stopped delivering look identical from the arrivals table, which is precisely why
   * counting days cannot tell them apart.
   *
   * SO IT ASKS THE ANSWERABLE QUESTION: WOULD A DECK ARRIVING TODAY BE READ? Five things have to be
   * true, and each is a fact about the machinery rather than about the founders who did or did not
   * send anything — somewhere to put the bytes, a job that exists, a job that is switched on, a job
   * that is actually running to its own schedule, and nothing sitting unread past that schedule.
   * Reaching the lane and finding it empty is the lane WORKING, and it reads as working.
   *
   * THE QUIET IS STILL REPORTED, in the reading, where it belongs — "nothing to read since 23 Aug"
   * is worth knowing and is not worth a light. `daysQuiet` below is deliberately kept out of every
   * state expression, and `npm run validate:quiet-is-not-a-fault` fails the build if it, or anything
   * else measuring a silence, ever appears in one again.
   */
  const decks = await one<{ waiting: number; waiting_for_company: number; oldest_readable: string | null; last_arrival: string | null; ever: number }>(
    "pending_deck",
    `SELECT SUM(state = 'PENDING') AS waiting,
            SUM(state = 'PENDING' AND company_id IS NULL) AS waiting_for_company,
            MIN(CASE WHEN state = 'PENDING' AND company_id IS NOT NULL THEN created_at END) AS oldest_readable,
            MAX(created_at) AS last_arrival,
            COUNT(*) AS ever
       FROM pending_deck`,
  );
  const deckJob = await one<{
    status: string; schedule_kind: string; interval_minutes: number | null; daily_at_utc: string | null;
    daily_at_tz: string | null; next_run_at: string | null; last_run_at: string | null; last_status: string | null;
  }>(
    "scheduled_job",
    `SELECT j.status, j.schedule_kind, j.interval_minutes, j.daily_at_utc, j.daily_at_tz, j.next_run_at, j.last_run_at,
            (SELECT status FROM job_run r WHERE r.job_id = j.id ORDER BY started_at DESC LIMIT 1) AS last_status
       FROM scheduled_job j WHERE j.job_key = 'deck_reading'`,
  );

  /*
   * THE LANE'S OWN CADENCE, READ OFF THE ROW RATHER THAN TYPED HERE. A constant would have gone
   * stale the moment 0193 moved this job from fifteen minutes to once a day — the board and the
   * schedule disagreeing about what "late" means is how a check ends up measuring its own memory.
   */
  const cadenceMinutes =
    !deckJob ? null
    : deckJob.schedule_kind === "INTERVAL" ? (deckJob.interval_minutes ?? 60)
    : deckJob.schedule_kind === "DAILY_AT" ? 1440
    : deckJob.schedule_kind === "WEEKLY" ? 10_080
    : deckJob.schedule_kind === "MONTHLY" ? 43_200
    : null;
  // One missed run is late; a quarter of a cycle of slack keeps a tick that fired a few minutes
  // after its minute from reading as a fault.
  const graceMs = cadenceMinutes === null ? null : (cadenceMinutes + Math.max(60, cadenceMinutes * 0.25)) * 60_000;
  const sinceLastRunMs = deckJob?.last_run_at ? Date.now() - new Date(deckJob.last_run_at).getTime() : null;
  const overdueMs = deckJob?.next_run_at ? Date.now() - new Date(deckJob.next_run_at).getTime() : null;

  const cadenceWords =
    !deckJob ? "no schedule"
    : deckJob.schedule_kind === "DAILY_AT"
      ? `once a day at ${deckJob.daily_at_utc}${deckJob.daily_at_tz ? ` ${deckJob.daily_at_tz}` : " UTC"}`
    : deckJob.schedule_kind === "INTERVAL" ? `every ${deckJob.interval_minutes} minutes`
    : deckJob.schedule_kind === "ON_REQUEST" ? "only when asked"
    : deckJob.schedule_kind.toLowerCase();

  const noStore = !env.WP_OS_DOCUMENTS;
  const jobMissing = !deckJob;
  const jobOff = deckJob !== null && deckJob.status !== "ACTIVE";
  const lastRunBroke = deckJob?.last_status === "FAILED" || deckJob?.last_status === "DEAD_LETTER";
  // Never run AND already past its own deadline: scheduled, due, and not happening.
  const neverRanAndOverdue = !deckJob?.last_run_at && overdueMs !== null && graceMs !== null && overdueMs > graceMs;
  const notRunning = sinceLastRunMs !== null && graceMs !== null && sinceLastRunMs > graceMs;
  /*
   * A DECK THAT ARRIVED AND WAS NOT READ IS THE REAL VERSION OF THIS ALARM. It has a company to
   * fill, so nothing is waiting on a person, and it has sat there longer than the lane's own
   * cadence. That is the failure the old check was pretending to look for by counting quiet days,
   * and unlike a quiet week it cannot happen while the pipeline is healthy.
   */
  const unreadMs = decks?.oldest_readable ? Date.now() - new Date(decks.oldest_readable).getTime() : null;
  const stuckDeck = unreadMs !== null && graceMs !== null && unreadMs > graceMs;
  // Waiting on a PERSON, not on the machinery: the analyst has to open the company first. A real
  // thing to do, so amber — never a fault, and never confused with a lane that cannot run.
  const awaitingAnalyst = (decks?.waiting_for_company ?? 0) > 0;

  const daysQuiet = decks?.last_arrival
    ? Math.floor((Date.now() - new Date(decks.last_arrival).getTime()) / 86_400_000)
    : null;
  const quietWords =
    decks?.last_arrival
      ? daysQuiet === 0
        ? "a deck arrived today"
        : `nothing to read for ${daysQuiet} day${daysQuiet === 1 ? "" : "s"} — last on ${decks.last_arrival.slice(0, 10)}, which is normal for this firm`
      : "no deck has arrived yet";

  const deckFault =
    noStore ? "no document store is bound, so a deck arriving today could not be read"
    : jobMissing ? "nothing is scheduled to read decks at all"
    : jobOff ? `the reader is ${deckJob!.status.toLowerCase()}, so nothing will read a deck that arrives`
    : lastRunBroke ? `the last run ${deckJob!.last_status === "DEAD_LETTER" ? "gave up after retrying" : "failed"}`
    : neverRanAndOverdue ? `it was due ${ago(deckJob!.next_run_at)} and has never run`
    : notRunning ? `it last ran ${ago(deckJob!.last_run_at)}, and it is set to run ${cadenceWords}`
    : stuckDeck ? `a deck arrived ${ago(decks!.oldest_readable)} and has not been read`
    : null;

  checks.push({
    key: "deck_intake",
    label: "Decks arriving",
    /*
     * NOT ONE TERM OF THIS EXPRESSION IS AN AGE SINCE THE LAST ARRIVAL. That is the whole fix, and
     * it is a rule a validator reads rather than a promise this comment makes.
     */
    state: deckFault ? "DOWN" : awaitingAnalyst ? "DEGRADED" : "OK",
    reading: deckFault
      ? `${deckFault} · ${quietWords}`
      : `${cadenceWords} · ${
          deckJob!.last_run_at ? `last checked ${ago(deckJob!.last_run_at)}` : "not run yet"
        } · ${
          (decks?.waiting ?? 0) > 0
            ? `${decks!.waiting} waiting${awaitingAnalyst ? `, ${decks!.waiting_for_company} of them for a company to be opened` : ""}`
            : "nothing waiting"
        } · ${quietWords}`,
    remedy: deckFault
      ? noStore
        ? "Bind the documents bucket. Until it is, decks are being kept and none can be read."
        : jobMissing || jobOff
          ? "Switch the deck reader back on from Work. Decks are still being kept; nothing is reading them."
          : stuckDeck
            ? "A deck has been sitting unread past the reader's own schedule. Run it from Work and read why it stopped."
            : "The reader is not running to its schedule. Run it from Work and read the last run's reason."
      : awaitingAnalyst
        ? `${decks!.waiting_for_company} deck${decks!.waiting_for_company === 1 ? " is" : "s are"} waiting for somebody to open the company ${decks!.waiting_for_company === 1 ? "it belongs" : "they belong"} to. Nothing is broken — that step is a person's.`
        : undefined,
    page: deckFault && !noStore ? "work" : "capture",
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
