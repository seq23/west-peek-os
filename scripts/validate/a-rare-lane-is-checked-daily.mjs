#!/usr/bin/env node
/**
 * a-rare-lane-is-checked-daily.mjs — `npm run validate:deck-cadence`.
 *
 * ONE ASSERTION: A LANE THAT RECEIVES SOMETHING A FEW TIMES A MONTH IS NOT POLLED NINETY-SIX TIMES
 * A DAY, AND WHERE ITS HOUR WAS CHOSEN ON A PERSON'S CLOCK, IT IS STORED AS THAT PERSON'S CLOCK.
 *
 * WHAT WENT WRONG, 18 Sep 2026. `deck_reading` ran every fifteen minutes. In the seven days to
 * 9 Sep it succeeded 310 times and every single run reported "no decks waiting"; two decks have ever
 * been enqueued. The operator, looking at her Home: "decks arriving is not broken. we just dont get
 * decks every day. he should not check every 15 min. he should check once per day at some point in
 * the day ----maybe like after 11am". This portfolio has already paid once for a job that ran 96
 * times a day for something that happened rarely.
 *
 * AND THE HALF THAT WOULD HAVE ROTTED SILENTLY. Her 11am is 16:00Z under CDT and 17:00Z under CST.
 * A job written `daily_at_utc = '16:00'` honours her sentence until the first Sunday in November and
 * then runs at 10am for her all winter — the one thing she ruled out — and nothing would fail, no
 * test would go red, and the drift would be discovered by her noticing the time on a card. So the
 * zone is stored in `daily_at_tz` and this scan refuses a local-clock lane that has lost it.
 *
 * WHAT IS CHECKED
 *   1 · EVERY DECLARED RARE LANE ENDS UP AT A DAILY-OR-SLOWER CADENCE, replayed across every
 *       migration in order rather than read off the newest file — a later migration can move a job
 *       back, and reading only the file that introduced it is how a sibling repo's scan went blind.
 *   2 · A LANE PINNED TO A LOCAL CLOCK CARRIES A ZONE the runtime can actually resolve, and an hour
 *       at or after the earliest local hour the operator asked for.
 *   3 · THE ZONE IS READ BY CODE. `computeNextRun` must consult `daily_at_tz` and `ScheduledJobRow`
 *       must declare it. A column no scheduler reads is a wish, and the drift would be identical to
 *       having never added it.
 *   4 · THE HEALTH BOARD DERIVES THE LANE'S CADENCE FROM THE ROW rather than from a literal. A
 *       board with "fifteen minutes" typed into it disagrees with the schedule the moment the
 *       schedule changes, and then measures its own memory.
 *
 * HARD-FAILS ON ZERO: zero migrations, zero declared lanes, or a declared lane whose schedule was
 * never found in any migration all exit 1. A scan that examined nothing has proved nothing.
 *
 * `--self-test` feeds the REAL pre-fix shapes through the same functions and requires each to be
 * caught, alongside the shipped shape, which must pass.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATIONS = path.join(ROOT, "migrations");
const JOBS_FILE = path.join(ROOT, "src", "worker", "services", "jobs.ts");
const HEALTH_FILE = path.join(ROOT, "src", "worker", "services", "health.ts");

/**
 * The lanes this rule governs, and why each is on the list.
 *
 * Adding a job here is a claim that the thing it waits for happens rarely. It is deliberately a
 * short, named list rather than a heuristic: `employee_work_sweep` runs every five minutes because
 * work cards genuinely move that often, and a scan that guessed would either flag it or learn to
 * excuse everything.
 */
const RARE_LANES = [
  {
    job_key: "deck_reading",
    why: "decks reach this firm a few times a month; 310 runs in seven days read zero of them",
    // Her words: "once per day at some point in the day ----maybe like after 11am".
    localClock: { tz: "America/Chicago", notBeforeHour: 11 },
  },
];

const MIN_MINUTES = 1440;

export function readMigrationsInOrder(dir = MIGRATIONS) {
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  return files.map((f) => ({ file: f, sql: readFileSync(path.join(dir, f), "utf8") }));
}

function stripSqlComments(sql) {
  return sql.replace(/^\s*--.*$/gm, " ");
}

/**
 * The schedule a statement leaves a job on, or null if the statement does not set one.
 *
 * Deliberately shape-agnostic: 0135 seeds the row with `'INTERVAL', 15,` inside an INSERT … SELECT,
 * 0169 and 0091 change it with an UPDATE … SET, and 0172 carries it through a table rebuild. Rather
 * than parse three grammars, this reads the assignments that are unambiguous in all of them.
 */
export function scheduleFromStatement(stmt) {
  const kindMatch = [...stmt.matchAll(/'(INTERVAL|DAILY_AT|WEEKLY|MONTHLY|ON_REQUEST)'/g)];
  const touchesClock = /daily_at_utc\s*=|daily_at_tz\s*=|interval_minutes\s*=/i.test(stmt);
  /*
   * A statement that moves only the HOUR still moves the schedule. Returning null for it would have
   * let `SET daily_at_utc = '07:00'` slip past — the exact shape that puts this lane back before the
   * hour she asked for without touching schedule_kind at all.
   */
  if (kindMatch.length === 0 && !touchesClock) return null;
  const kind = kindMatch.length > 0 ? kindMatch[kindMatch.length - 1][1] : undefined;

  let minutes = null;
  const setForm = stmt.match(/interval_minutes\s*=\s*(\d+)/i);
  const seedForm = stmt.match(/'INTERVAL'\s*,\s*(\d+)/i);
  if (setForm) minutes = Number(setForm[1]);
  else if (seedForm) minutes = Number(seedForm[1]);

  const tz = stmt.match(/daily_at_tz\s*=\s*'([^']+)'/i);
  const at = stmt.match(/daily_at_utc\s*=\s*'(\d{2}):(\d{2})'/i);

  return {
    kind,
    interval_minutes: minutes,
    daily_at_tz: tz ? tz[1] : /daily_at_tz\s*=\s*NULL/i.test(stmt) ? null : undefined,
    hour: at ? Number(at[1]) : undefined,
    minute: at ? Number(at[2]) : undefined,
  };
}

/** The last schedule any migration leaves a job on. */
export function effectiveSchedule(migrations, jobKey) {
  let current = null;
  for (const { file, sql } of migrations) {
    for (const stmt of stripSqlComments(sql).split(";")) {
      /*
       * ONLY STATEMENTS THAT WRITE THE ROW. 0193's own guard SELECTs from `scheduled_job` with a
       * WHERE clause naming every column this parser reads, so a merely-mentions test read the
       * guard as if it were the change — and the scan then reported the schedule it was CHECKING
       * FOR rather than the one that was written. Caught by the negative proof: breaking the UPDATE
       * left the scan green.
       */
      if (!/^\s*(UPDATE\s+scheduled_job|INSERT\s+INTO\s+scheduled_job)\b/i.test(stmt)) continue;
      if (!stmt.includes(`'${jobKey}'`)) continue;
      const found = scheduleFromStatement(stmt);
      if (!found) continue;
      current = {
        file,
        kind: found.kind ?? current?.kind,
        interval_minutes: found.interval_minutes ?? (found.kind === "INTERVAL" ? current?.interval_minutes ?? null : null),
        daily_at_tz: found.daily_at_tz === undefined ? current?.daily_at_tz ?? null : found.daily_at_tz,
        hour: found.hour === undefined ? current?.hour : found.hour,
        minute: found.minute === undefined ? current?.minute : found.minute,
      };
    }
  }
  return current;
}

export function auditLane(lane, schedule) {
  const bad = [];
  if (!schedule) {
    bad.push(`${lane.job_key}: no migration sets a schedule for it — this scan cannot see the lane it governs`);
    return bad;
  }
  if (schedule.kind === "INTERVAL") {
    const mins = schedule.interval_minutes ?? 0;
    if (mins < MIN_MINUTES) {
      bad.push(
        `${lane.job_key}: back on INTERVAL ${mins} minutes (${Math.round(1440 / Math.max(1, mins))} runs a day) in ${schedule.file} — ${lane.why}`,
      );
    }
  }
  if (lane.localClock) {
    if (schedule.kind === "INTERVAL" || schedule.kind === "ON_REQUEST") {
      // An interval has no hour to pin, so the local-clock half is moot — rule 1 already failed it.
      return bad;
    }
    if (!schedule.daily_at_tz) {
      bad.push(
        `${lane.job_key}: ${schedule.kind} with no daily_at_tz (${schedule.file}). The hour was chosen on ` +
          `${lane.localClock.tz} and a bare UTC hour drifts by one when the clocks change`,
      );
    } else {
      if (schedule.daily_at_tz !== lane.localClock.tz) {
        bad.push(`${lane.job_key}: scheduled in ${schedule.daily_at_tz}, but the hour was chosen in ${lane.localClock.tz}`);
      }
      if (!zoneResolves(schedule.daily_at_tz)) {
        bad.push(`${lane.job_key}: daily_at_tz '${schedule.daily_at_tz}' is not a zone this runtime can resolve, so it would schedule in UTC`);
      }
      if (schedule.hour !== undefined && schedule.hour < lane.localClock.notBeforeHour) {
        bad.push(
          `${lane.job_key}: runs at ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute ?? 0).padStart(2, "0")} ` +
            `${schedule.daily_at_tz}, before the ${lane.localClock.notBeforeHour}:00 the operator asked for`,
        );
      }
    }
  }
  return bad;
}

function zoneResolves(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The column has to be READ, or it is decoration with a migration behind it. */
export function auditSources(jobsSrc, healthSrc) {
  const bad = [];
  const nextRun = jobsSrc.slice(jobsSrc.indexOf("export function computeNextRun"), jobsSrc.indexOf("export function isoWeekOf"));
  if (nextRun.length < 50) bad.push("computeNextRun could not be located in jobs.ts — this scan lost its target");
  else if (!/daily_at_tz/.test(nextRun)) {
    bad.push("computeNextRun never reads daily_at_tz: the zone is stored and ignored, which schedules in UTC exactly as before");
  }
  if (!/daily_at_tz\s*:\s*string \| null/.test(jobsSrc)) {
    bad.push("ScheduledJobRow does not declare daily_at_tz, so nothing typed can carry it");
  }
  if (!/deck_reading/.test(healthSrc) || !/schedule_kind/.test(healthSrc)) {
    bad.push("the health board does not read the deck job's own schedule row, so it cannot know what 'late' means");
  }
  if (/every fifteen minutes/.test(healthSrc)) {
    bad.push("the health board still tells the operator the deck reader runs every fifteen minutes");
  }
  return bad;
}

function selfTest() {
  const failures = [];
  const expect = (what, cond) => {
    if (!cond) failures.push(what);
  };

  // 1 · The REAL pre-fix shape: 0135's seed, INTERVAL 15.
  const preFix = [
    { file: "0135.sql", sql: `INSERT INTO scheduled_job (id, job_key, name, kind, schedule_kind, interval_minutes) SELECT 'sjob_deck_reading', 'deck_reading', 'x', 'EMPLOYEE_TASK', 'INTERVAL', 15;` },
  ];
  expect(
    "the shipped fifteen-minute cadence is caught",
    auditLane(RARE_LANES[0], effectiveSchedule(preFix, "deck_reading")).some((m) => m.includes("INTERVAL 15")),
  );

  // 2 · The shipped fix passes.
  const fixed = [
    ...preFix,
    { file: "0193.sql", sql: `UPDATE scheduled_job SET schedule_kind = 'DAILY_AT', interval_minutes = NULL, daily_at_utc = '11:15', daily_at_tz = 'America/Chicago' WHERE job_key = 'deck_reading';` },
  ];
  expect("the shipped fix passes", auditLane(RARE_LANES[0], effectiveSchedule(fixed, "deck_reading")).length === 0);

  // 3 · Daily, but with the zone dropped — the drift that would never have gone red.
  const noZone = [
    ...preFix,
    { file: "0194.sql", sql: `UPDATE scheduled_job SET schedule_kind = 'DAILY_AT', interval_minutes = NULL, daily_at_utc = '16:15', daily_at_tz = NULL WHERE job_key = 'deck_reading';` },
  ];
  expect("a daily lane that lost its zone is caught", auditLane(RARE_LANES[0], effectiveSchedule(noZone, "deck_reading")).some((m) => m.includes("no daily_at_tz")));

  // 4 · Daily, zoned, and before the hour she asked for.
  const tooEarly = [
    ...fixed,
    { file: "0195.sql", sql: `UPDATE scheduled_job SET daily_at_utc = '07:00' WHERE job_key = 'deck_reading';` },
  ];
  expect("an hour before 11am local is caught", auditLane(RARE_LANES[0], effectiveSchedule(tooEarly, "deck_reading")).some((m) => m.includes("before the 11:00")));

  // 5 · A later migration putting it back on a fast interval — the regression this scan exists for.
  const regressed = [
    ...fixed,
    { file: "0196.sql", sql: `UPDATE scheduled_job SET schedule_kind = 'INTERVAL', interval_minutes = 15, daily_at_utc = NULL WHERE job_key = 'deck_reading';` },
  ];
  expect("a later migration moving it back is caught", auditLane(RARE_LANES[0], effectiveSchedule(regressed, "deck_reading")).length > 0);

  // 6 · Hourly is still sub-daily. Slower than it was, and still not what was asked for.
  const hourly = [
    ...preFix,
    { file: "0197.sql", sql: `UPDATE scheduled_job SET schedule_kind = 'INTERVAL', interval_minutes = 60 WHERE job_key = 'deck_reading';` },
  ];
  expect("hourly is still refused", auditLane(RARE_LANES[0], effectiveSchedule(hourly, "deck_reading")).length > 0);

  // 7 · A lane no migration mentions must fail rather than pass vacuously.
  expect("an unseen lane is a failure, not a pass", auditLane(RARE_LANES[0], effectiveSchedule([], "deck_reading")).length > 0);

  // 8 · The source half: a computeNextRun that ignores the column.
  const blindJobs = "export function computeNextRun(job, from) { return from.toISOString(); }\nexport function isoWeekOf() {}\n  daily_at_tz: string | null;";
  expect(
    "a scheduler that ignores the zone is caught",
    auditSources(blindJobs, "deck_reading schedule_kind").some((m) => m.includes("never reads daily_at_tz")),
  );
  // 9 · And a board that types the cadence in prose instead of reading it.
  expect(
    "a board quoting the old cadence is caught",
    auditSources(readFileSync(JOBS_FILE, "utf8"), "deck_reading schedule_kind — runs every fifteen minutes").some((m) =>
      m.includes("every fifteen minutes"),
    ),
  );

  if (failures.length > 0) {
    console.error("RARE LANE SELF-TEST FAILED:");
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log("RARE LANE SELF-TEST PASSED (9 fixtures, including the shipped 15-minute cadence and a zone-less daily job)");
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const migrations = readMigrationsInOrder();
  if (migrations.length === 0) {
    console.error("RARE LANE SCAN FAILED — read zero migrations. Rule 0.");
    process.exit(1);
  }
  if (RARE_LANES.length === 0) {
    console.error("RARE LANE SCAN FAILED — zero lanes declared, so this scan governs nothing. Rule 0.");
    process.exit(1);
  }

  const violations = [];
  for (const lane of RARE_LANES) {
    violations.push(...auditLane(lane, effectiveSchedule(migrations, lane.job_key)));
  }
  violations.push(...auditSources(readFileSync(JOBS_FILE, "utf8"), readFileSync(HEALTH_FILE, "utf8")));

  if (violations.length > 0) {
    console.error("RARE LANE SCAN FAILED — a lane that receives something rarely is being polled, or has lost its clock:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(
      "\nOperator, 18 Sep 2026: \"he should not check every 15 min. he should check once per day at some\n" +
        "point in the day ----maybe like after 11am\". Ninety-six checks a day for something that happens\n" +
        "twice a month is the runaway this portfolio has already paid for once, and a UTC hour standing in\n" +
        "for her clock drifts an hour every November without failing anything.",
    );
    process.exit(1);
  }

  console.log(
    `RARE LANE SCAN PASSED: ${RARE_LANES.length} declared lane(s), each daily-or-slower as replayed across ` +
      `${migrations.length} migrations; every local-clock lane carries a resolvable zone at or after its ` +
      `earliest hour; computeNextRun reads daily_at_tz and the health board reads the schedule off the row.`,
  );
}

main();
