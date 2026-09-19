#!/usr/bin/env node
/**
 * a-brief-exists-before-every-meeting.mjs — `npm run validate:meeting-brief`.
 *
 * ONE ASSERTION: THE NIGHT BEFORE ANY MEETING, A BRIEF EXISTS FOR IT — AND WHEN ONE CANNOT BE
 * BUILT, SOMEBODY IS TOLD.
 *
 * WHAT THIS GUARDS (Phase B, owner-approved 18 Sep 2026). The brief is the BEFORE face of a meeting
 * and it is produced by a scheduled job, which is the shape of work this repo has lost most often:
 * a job seeded but never dispatched, dispatched but PAUSED, dispatched and reporting SUCCEEDED
 * having written nothing, or a builder that reads no source and hands over a confident blank. Each
 * of those has shipped here once. This scan fails if any of them can ship again:
 *
 *   1 · THE JOB IS SEEDED, DAILY, AND STARTS ENABLED — in the schema the migrations actually
 *       build. The owner asked for ENABLED; a PAUSED seed is a brief that misses the first
 *       meeting. Seeded the loud way (`WHERE NOT EXISTS`, never `INSERT OR IGNORE`).
 *   2 · THE JOB IS DISPATCHED. `jobs.ts` matches `job.job_key === "meeting_brief"`, calls
 *       `runMeetingBriefs`, and reports FAILED when any brief failed — a run that swallowed a
 *       failure into SUCCEEDED is the health board lying.
 *   3 · THE BUILDER CANNOT HAND OVER A BLANK. `buildMeetingBrief` throws when it read nothing
 *       (`coverage.length === 0`), the rendered brief carries a "What was examined" block, and a
 *       why-line that could not be written SAYS SO rather than being left empty.
 *   4 · A FAILED BRIEF IS LOUD. `runMeetingBriefs` raises a CRITICAL notification on a failure,
 *       looks only at SCHEDULED, on-the-record meetings, and reports how many it examined.
 *   5 · ONE WINDOW, DECLARED ONCE. The lookahead lives in `BRIEF_LOOKAHEAD_HOURS` and the two
 *       places that say it in words — migration 0200 and the job's summary line — agree with it.
 *       One duration copied into eight places and drifting is a named defect here.
 *   6 · EVERY TYPE GETS A BRIEF. The diligence branch names FOUNDER and DILIGENCE explicitly,
 *       every type in `meetingTypes.ts` names a lead employee, and the P7 `prep` route is the
 *       brief's route — generalised, not duplicated: `assemblePrepPacket` calls
 *       `assembleMeetingBrief`.
 *
 * HARD-FAILS ON ZERO: zero migrations, zero job rows, zero meeting types — each exits 1.
 *
 * `--self-test` plants each defect and proves it is caught; the shipped source passes.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { stripCommentsFor, stripTsComments } from "./lib/strip-comments.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const JOBS = path.join(ROOT, "src", "worker", "services", "jobs.ts");
const BRIEF = path.join(ROOT, "src", "worker", "services", "meetingBrief.ts");
const MEETINGS = path.join(ROOT, "src", "worker", "services", "meetings.ts");
const MEETING_TYPES = path.join(ROOT, "src", "shared", "meetings", "meetingTypes.ts");
const JOB_KEY = "meeting_brief";

function readTs(file) {
  return stripTsComments(readFileSync(file, "utf8"));
}

function splitStatements(sql) {
  const out = [];
  let buf = "";
  let depth = 0;
  for (const line of sql.split("\n")) {
    const bare = line.replace(/--.*$/, "");
    if (/\bBEGIN\b/i.test(bare) && !/\bEND\b/i.test(bare)) depth += 1;
    if (/\bEND\s*;/i.test(bare) && depth > 0) depth -= 1;
    buf += `${line}\n`;
    if (depth === 0 && /;\s*$/.test(bare)) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * Replay the migrations. Unlike the shape-only scans, the SEED has to apply here — the job row is
 * the thing under test — so a statement that fails is kept, and the check below reads the row.
 */
export function replay(files) {
  const db = new DatabaseSync(":memory:");
  for (const [name, raw] of files) {
    for (const stmt of splitStatements(stripCommentsFor(name, raw))) {
      try {
        db.exec(stmt);
      } catch {
        // Seeds referencing rows a bare database lacks may fail; the job seed must not.
      }
    }
  }
  return db;
}

// ── 1 · seeded, daily, enabled ───────────────────────────────────────────────────────────────

export function checkSeed(db, seedSql) {
  const violations = [];
  let rows = [];
  try {
    rows = db.prepare("SELECT id, job_key, schedule_kind, daily_at_utc, status FROM scheduled_job WHERE job_key = ?").all(JOB_KEY);
  } catch (err) {
    violations.push(`scheduled_job could not be read from the replayed schema: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (rows.length === 0) violations.push(`no scheduled_job row with job_key '${JOB_KEY}' survives the migration replay — the job exists in no database`);
  for (const r of rows) {
    if (r.schedule_kind !== "DAILY_AT") violations.push(`${r.id} is ${r.schedule_kind}, not DAILY_AT — "the night before" is a daily shape`);
    if (!/^\d\d:\d\d$/.test(String(r.daily_at_utc ?? ""))) violations.push(`${r.id} has no daily_at_utc`);
    if (r.status !== "ACTIVE") violations.push(`${r.id} is seeded ${r.status}; the owner asked for it ENABLED, and a paused brief misses the first meeting`);
  }
  if (seedSql !== null) {
    if (!/WHERE NOT EXISTS\s*\(\s*SELECT 1 FROM scheduled_job WHERE job_key = 'meeting_brief'\s*\)/.test(seedSql)) {
      violations.push("the job is not seeded with INSERT … SELECT … WHERE NOT EXISTS — INSERT OR IGNORE once registered a job that existed in no database");
    }
    if (/INSERT OR IGNORE INTO scheduled_job/.test(seedSql)) violations.push("the job seed uses INSERT OR IGNORE, which swallows a constraint failure silently");
  }
  return { violations, examined: rows.length };
}

// ── 2 · dispatched, and failure reported ─────────────────────────────────────────────────────

export function checkDispatch(jobsSrc) {
  const violations = [];
  const at = jobsSrc.indexOf(`job.job_key === "${JOB_KEY}"`);
  if (at === -1) {
    violations.push(`jobs.ts never dispatches job_key "${JOB_KEY}" — the seeded job would run and do nothing`);
    return { violations, examined: 0 };
  }
  const branch = jobsSrc.slice(at, jobsSrc.indexOf("\n  }\n", at));
  if (!branch.includes("runMeetingBriefs(")) violations.push("the meeting_brief branch does not call runMeetingBriefs");
  if (!/failures\.length > 0 \? "FAILED"/.test(branch)) violations.push("the meeting_brief branch does not report FAILED when a brief failed — a swallowed failure is a green run that means nothing");
  if (!/\bexamined\b/.test(branch)) violations.push("the meeting_brief branch's summary does not say how many meetings it examined, so '0 built' cannot be told from 'nothing looked'");
  return { violations, examined: 1 };
}

// ── 3–5 · the builder and the job ────────────────────────────────────────────────────────────

function fnBody(src, name) {
  const m = new RegExp(`export (?:async )?function ${name}\\b[\\s\\S]*?\\{[ \\t]*\\n`).exec(src);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index + m[0].lastIndexOf("{"); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  return null;
}

export function checkBuilder(briefSrc) {
  const violations = [];
  let examined = 0;

  const build = fnBody(briefSrc, "buildMeetingBrief");
  if (!build) violations.push("buildMeetingBrief is missing");
  else {
    examined += 1;
    if (!/if \(coverage\.length === 0\) \{\s*throw/.test(build)) violations.push("buildMeetingBrief does not throw when it read nothing — a brief that examined no source would be handed over as an empty one");
    if (!/"FOUNDER"/.test(build) || !/"DILIGENCE"/.test(build)) violations.push("buildMeetingBrief's diligence branch does not name FOUNDER and DILIGENCE");
    if (!/coverage\.push|readSource\(/.test(build)) violations.push("buildMeetingBrief records no coverage");
  }

  const render = fnBody(briefSrc, "renderBrief");
  if (!render) violations.push("renderBrief is missing");
  else {
    examined += 1;
    if (!render.includes("What was examined")) violations.push("the rendered brief carries no 'What was examined' block — an empty brief and a broken one would read the same");
    if (!/No line could be written/.test(render)) violations.push("a why-line that could not be written is not said out loud in the brief");
  }

  const run = fnBody(briefSrc, "runMeetingBriefs");
  if (!run) violations.push("runMeetingBriefs is missing");
  else {
    examined += 1;
    if (!/severity:\s*"CRITICAL"/.test(run)) violations.push("runMeetingBriefs raises no CRITICAL notification when a brief fails — a missing brief has to be louder than an empty one");
    if (!/status = 'SCHEDULED'/.test(run)) violations.push("runMeetingBriefs does not restrict itself to SCHEDULED meetings");
    if (!/archived_at IS NULL/.test(run)) violations.push("runMeetingBriefs would brief a meeting that was taken off the record");
    if (!/examined/.test(run)) violations.push("runMeetingBriefs does not report how many meetings it examined");
  }

  const hours = /BRIEF_LOOKAHEAD_HOURS\s*=\s*(\d+)/.exec(briefSrc);
  if (!hours) violations.push("BRIEF_LOOKAHEAD_HOURS is not declared once in meetingBrief.ts");
  return { violations, examined, lookahead: hours ? Number(hours[1]) : null };
}

/** The two places that say the window in words must agree with the one constant. */
export function checkWindowAgrees(lookahead, migrationSql, jobsSrc) {
  const violations = [];
  if (lookahead === null) return { violations, examined: 0 };
  let examined = 0;
  if (migrationSql !== null) {
    examined += 1;
    if (!new RegExp(`\\b${lookahead} hours\\b`).test(migrationSql)) violations.push(`migration 0200 does not describe a ${lookahead}-hour window; BRIEF_LOOKAHEAD_HOURS is ${lookahead}`);
  }
  const branch = jobsSrc.slice(jobsSrc.indexOf(`job.job_key === "${JOB_KEY}"`));
  examined += 1;
  if (!new RegExp(`\\b${lookahead}h\\b`).test(branch.slice(0, 2000))) violations.push(`the job summary in jobs.ts does not say ${lookahead}h; it has drifted from BRIEF_LOOKAHEAD_HOURS`);
  return { violations, examined };
}

// ── 6 · every type, one route ────────────────────────────────────────────────────────────────

export function checkEveryType(typesSrc, meetingsSrc) {
  const violations = [];
  const types = [...typesSrc.matchAll(/key:\s*"([A-Z_]+)"[\s\S]*?suggests:\s*\[([^\]]*)\]/g)].map((m) => ({ key: m[1], suggests: m[2].trim() }));
  for (const t of types) if (t.suggests.length === 0) violations.push(`${t.key} names no lead employee, so nobody prepares its brief`);
  const prep = fnBody(meetingsSrc, "assemblePrepPacket");
  if (!prep) violations.push("assemblePrepPacket is missing from meetings.ts");
  else if (!prep.includes("assembleMeetingBrief(")) violations.push("POST /api/meetings/:id/prep no longer builds the brief — the IC prep and the brief have become two things");
  return { violations, examined: types.length };
}

// ── Self-test ────────────────────────────────────────────────────────────────────────────────

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort().map((f) => [path.join(MIGRATIONS_DIR, f), stripCommentsFor(path.join(MIGRATIONS_DIR, f), readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"))]);
}

function seedFile(files) {
  return files.find(([, s]) => s.includes(`'${JOB_KEY}'`)) ?? null;
}

async function selfTest() {
  let failed = 0;
  const say = (ok, what) => {
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${what}`);
  };

  const files = migrationFiles();
  const seed = seedFile(files);
  say(seed !== null, "a migration seeds the job");
  const good = checkSeed(replay(files), seed?.[1] ?? null);
  say(good.violations.length === 0 && good.examined === 1, `the shipped seed passes: ${good.violations.join("; ")}`);
  const paused = files.map(([n, s]) => [n, n === seed?.[0] ? s.replace("'INTERNAL', 'ACTIVE', 'system', 'west-peek'\nWHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'meeting_brief')", "'INTERNAL', 'PAUSED', 'system', 'west-peek'\nWHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'meeting_brief')") : s]);
  say(checkSeed(replay(paused), seedFile(paused)[1]).violations.some((v) => /PAUSED/.test(v)), "a job seeded PAUSED is caught");
  const unseeded = files.map(([n, s]) => [n, n === seed?.[0] ? s.replace(/INSERT INTO scheduled_job[\s\S]*?job_key = 'meeting_brief'\);/, "") : s]);
  say(checkSeed(replay(unseeded), null).violations.some((v) => /no scheduled_job row/.test(v)), "a job that exists in no database is caught");
  say(checkSeed(replay(files), seed[1].replace("WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'meeting_brief')", "")).violations.some((v) => /WHERE NOT EXISTS/.test(v)), "a seed without WHERE NOT EXISTS is caught");

  const jobs = readTs(JOBS);
  say(checkDispatch(jobs).violations.length === 0, "the shipped jobs.ts dispatches the job and reports failure");
  say(checkDispatch(jobs.replace(`job.job_key === "${JOB_KEY}"`, 'job.job_key === "meeting_briefs"')).violations.some((v) => /never dispatches/.test(v)), "a seeded job nothing dispatches is caught");
  say(checkDispatch(jobs.replace('status: out.failures.length > 0 ? "FAILED" : "SUCCEEDED",\n      summary:\n        `${out.examined} meeting(s) in the next 36h', 'status: "SUCCEEDED",\n      summary:\n        `${out.examined} meeting(s) in the next 36h')).violations.some((v) => /FAILED/.test(v)), "a branch that reports SUCCEEDED over a failure is caught");

  const brief = readTs(BRIEF);
  const b = checkBuilder(brief);
  say(b.violations.length === 0 && b.examined === 3 && b.lookahead !== null, `the shipped builder passes (lookahead ${b.lookahead}h): ${b.violations.join("; ")}`);
  say(checkBuilder(brief.replace(/if \(coverage\.length === 0\) \{\s*throw[^}]*\}/, "")).violations.some((v) => /read nothing/.test(v)), "a builder that hands over a blank is caught");
  say(checkBuilder(brief.replace('severity: "CRITICAL"', 'severity: "INFO"')).violations.some((v) => /CRITICAL/.test(v)), "a job that whispers a failure is caught");
  say(checkBuilder(brief.replaceAll("What was examined", "Sources")).violations.some((v) => /What was examined/.test(v)), "a brief with no coverage block is caught");

  const migration = seed?.[1] ?? null;
  say(checkWindowAgrees(b.lookahead, migration, jobs).violations.length === 0, "the window is said the same way in the constant, the migration and the summary");
  say(checkWindowAgrees(48, migration, jobs).violations.length === 2, "a constant that drifted from the words is caught in both places");

  const types = readTs(MEETING_TYPES);
  const meetings = readTs(MEETINGS);
  const every = checkEveryType(types, meetings);
  say(every.violations.length === 0 && every.examined >= 6, `every one of ${every.examined} types has a lead and the prep route builds the brief`);
  say(checkEveryType(types.replace('suggests: ["Wesley"]', "suggests: []"), meetings).violations.length === 1, "a type with no lead is caught");
  say(checkEveryType(types, meetings.replace("assembleMeetingBrief(", "assemblePrepPacketLegacy(")).violations.some((v) => /two things/.test(v)), "a prep route that stopped building the brief is caught");

  if (failed > 0) process.exit(1);
  console.log("SELF-TEST PASSED: a paused seed, an unseeded job, a quiet seed, an undispatched key, a swallowed failure, a blank brief, a whispered failure, a missing coverage block, a drifted window, a lead-less type and a duplicated prep route are each caught; the shipped source passes.");
}

// ── Run ──────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  const files = migrationFiles();
  const seed = seedFile(files);
  const seedCheck = checkSeed(replay(files), seed?.[1] ?? null);
  const jobs = readTs(JOBS);
  const dispatch = checkDispatch(jobs);
  const builder = checkBuilder(readTs(BRIEF));
  const window = checkWindowAgrees(builder.lookahead, seed?.[1] ?? null, jobs);
  const every = checkEveryType(readTs(MEETING_TYPES), readTs(MEETINGS));

  const empty = [
    files.length === 0 && "read 0 migrations",
    seedCheck.examined === 0 && `found 0 scheduled_job rows for ${JOB_KEY} after replaying the migrations`,
    dispatch.examined === 0 && "found 0 dispatch branches for the job",
    builder.examined === 0 && "examined 0 functions in meetingBrief.ts",
    every.examined === 0 && "read 0 meeting types",
  ].filter(Boolean);
  if (empty.length > 0) {
    console.error(`MEETING-BRIEF SCAN FAILED — ${empty.join("; ")}.`);
    console.error("An empty loop reporting success is the defect this repo calls Rule 0.");
    process.exit(1);
  }

  const violations = [...seedCheck.violations, ...dispatch.violations, ...builder.violations, ...window.violations, ...every.violations];
  if (violations.length > 0) {
    console.error("MEETING-BRIEF SCAN FAILED — a meeting could arrive with no brief and nobody told:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    process.exit(1);
  }
  console.log(
    `MEETING-BRIEF SCAN PASSED: ${JOB_KEY} is seeded DAILY_AT and ACTIVE by the migrations (${files.length} replayed), dispatched by jobs.ts and reports FAILED on a failure; ` +
      `the builder throws on zero coverage, prints what it examined, says when the why-line could not be written, and the job is CRITICAL on a failure; ` +
      `the ${builder.lookahead}h window is declared once and agreed in ${window.examined} places; ${every.examined} meeting types each have a lead and the prep route builds the brief.`,
  );
}
