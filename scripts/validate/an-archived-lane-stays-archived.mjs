#!/usr/bin/env node
/**
 * an-archived-lane-stays-archived.mjs — `npm run validate:weekly-review-archived`.
 *
 * ONE ASSERTION: A JOB THE OWNER RETIRED CANNOT COME BACK, AND THE SURFACE IT FED IS OFF THE NAV.
 *
 * Owner, 18 Sep 2026, on the weekly MP operating review: "we don't need it anymore." Migration 0198
 * sets its job `weekly_mp_review` to RETIRED — the table's terminal status, which the dispatcher
 * refuses on every trigger and the status route will not flip back. That is the right mechanism,
 * and it is exactly the kind of thing a later migration undoes by accident: 0043 seeded the row
 * PAUSED, 0169 and 0172 both rebuilt the whole table and copied every row back, and any future
 * "switch the reviews back on" migration or a seed that rewrites job rows would revive it with
 * nothing failing.
 *
 * WHAT IS CHECKED, all read from code with comments stripped, never from prose:
 *   1 · EVERY RETIRED JOB STAYS RETIRED. Every migration is replayed in filename order and each
 *       statement that sets `scheduled_job.status` for a named job key is applied to a small model
 *       of the table. A key that reaches RETIRED and is later set to anything else is a violation.
 *       `weekly_mp_review` must be among the retired keys — this validator exists for it — and the
 *       generic rule covers the three productions duties 0169 folded as well.
 *   2 · NO SEED WRITES THE ROW BACK. Nothing under scripts/seed may write `scheduled_job` at all;
 *       the jobs are migration-owned. (Today nothing does. This pins that.)
 *   3 · THE DISPATCHER CANNOT GENERATE. The `weekly_mp_review` branch in services/jobs.ts must be a
 *       REFUSED outcome that never touches the generator — a hand-edited row must find a refusal,
 *       not a generator, and not the INTELLIGENCE fallthrough either.
 *   4 · THE NAV DOES NOT LIST IT, THE ROUTE STILL ANSWERS. App.tsx carries no `{ key: "weekly-review"`
 *       nav literal and still renders `active === "weekly-review"`.
 *   5 · THE KIND IS ARCHIVED AND THE SHELF HONOURS IT. `weekly_review` carries `archived:` in its
 *       definition, and the unfiltered listing in services/deliverables.ts excludes archived kinds
 *       through `archivedDeliverableKinds()` — derived from the definitions, never a second list.
 *
 * HARD-FAILS ON ZERO: zero migrations read, zero job-status statements found, or zero retired jobs
 * each exit 1. An empty loop reporting success is Rule 0.
 *
 * `--self-test` runs a migration that re-enables the job, a seed that writes the table, a
 * dispatcher that generates again, and a restored nav item through the same functions.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripCommentsFor } from "./lib/strip-comments.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const MIGRATIONS = path.join(ROOT, "migrations");
const SEEDS = path.join(ROOT, "scripts", "seed");
const JOBS = path.join(ROOT, "src", "worker", "services", "jobs.ts");
const APP = path.join(ROOT, "src", "client", "App.tsx");
const KINDS = path.join(ROOT, "src", "shared", "deliverables", "deliverable.ts");
const LISTING = path.join(ROOT, "src", "worker", "services", "deliverables.ts");

/** The job this validator was written for. The generic rule covers every other retired key too. */
export const MUST_BE_RETIRED = ["weekly_mp_review"];

/**
 * Every statement that sets the status of a named scheduled_job, in order: seeds (INSERT with a
 * job_key literal and a status literal) and UPDATEs (`SET … status = 'X' … WHERE job_key = 'k'` or
 * `job_key IN ('a','b')`). Returns [{ file, key, status }] in the order the database would apply
 * them. A table rebuild that copies rows (0169, 0172) changes nothing and is correctly ignored.
 */
export function jobStatusWrites(files) {
  const writes = [];
  for (const { name, sql } of files) {
    // UPDATE … SET … status = 'X' … WHERE job_key = 'k' | job_key IN (…)
    for (const m of sql.matchAll(/UPDATE\s+scheduled_job\s+SET([\s\S]*?)WHERE([\s\S]*?);/gi)) {
      const status = /\bstatus\s*=\s*'([A-Z_]+)'/.exec(m[1]);
      if (!status) continue;
      const where = m[2];
      const one = /job_key\s*=\s*'([a-z_]+)'/.exec(where);
      const many = /job_key\s+IN\s*\(([^)]*)\)/i.exec(where);
      const keys = one ? [one[1]] : many ? [...many[1].matchAll(/'([a-z_]+)'/g)].map((k) => k[1]) : [];
      for (const key of keys) writes.push({ file: name, key, status: status[1] });
    }
    // INSERT [OR IGNORE|OR REPLACE] INTO scheduled_job … — the seeds. Positions cannot be trusted
    // (numbers and NULLs are not quoted), so the row is read by shape: the job id literal (`sjb_…`
    // or `sjob_…`) is followed by the job_key, and the status is the one literal drawn from the
    // column's CHECK vocabulary. A rebuild's `INSERT INTO scheduled_job (…) SELECT … FROM
    // scheduled_job_copy` carries no id literal and is correctly ignored: it copies, it does not set.
    for (const m of sql.matchAll(/INSERT(?:\s+OR\s+(?:IGNORE|REPLACE))?\s+INTO\s+scheduled_job\b([\s\S]*?);/gi)) {
      const literals = [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1]);
      const idAt = literals.findIndex((l) => /^sjb_|^sjob_/.test(l));
      if (idAt < 0 || idAt + 1 >= literals.length) continue;
      const status = literals.find((l) => /^(ACTIVE|PAUSED|RETIRED)$/.test(l));
      if (!status) continue;
      writes.push({ file: name, key: literals[idAt + 1], status });
    }
  }
  return writes;
}

/** Replay the writes: the keys that reach RETIRED, and any write after that which sets something else. */
export function auditRetirements(writes) {
  const violations = [];
  const retiredAt = new Map();
  const finalStatus = new Map();
  for (const w of writes) {
    if (retiredAt.has(w.key) && w.status !== "RETIRED") {
      violations.push(`${w.file} sets scheduled_job '${w.key}' to ${w.status} after ${retiredAt.get(w.key)} retired it — a retired lane came back`);
    }
    if (w.status === "RETIRED" && !retiredAt.has(w.key)) retiredAt.set(w.key, w.file);
    finalStatus.set(w.key, w.status);
  }
  for (const key of MUST_BE_RETIRED) {
    if (finalStatus.get(key) !== "RETIRED") {
      violations.push(`scheduled_job '${key}' ends the migrations as ${finalStatus.get(key) ?? "never seeded"}, not RETIRED`);
    }
  }
  return { violations, retired: [...retiredAt.keys()] };
}

export function auditSeeds(seeds) {
  return seeds.filter((s) => /scheduled_job/.test(s.text)).map((s) => `${s.name} writes scheduled_job — jobs are migration-owned, and a seed that rewrites them can revive a retired one`);
}

export function auditDispatcher(jobsSource) {
  const violations = [];
  const branch = /if \(job\.job_key === "weekly_mp_review"\) \{([\s\S]*?)\n  \}/.exec(jobsSource);
  if (!branch) {
    violations.push("services/jobs.ts has no `weekly_mp_review` branch — a hand-edited row would fall through to the INTELLIGENCE sweep under this key");
    return violations;
  }
  if (!/status:\s*"REFUSED"/.test(branch[1])) violations.push("the `weekly_mp_review` branch in services/jobs.ts does not return REFUSED");
  if (/generateReview|weeklyReview"/.test(branch[1])) violations.push("the `weekly_mp_review` branch in services/jobs.ts still reaches the generator");
  return violations;
}

export function auditNav(appSource) {
  const violations = [];
  if (/\{ key: "weekly-review", label: "/.test(appSource)) violations.push('App.tsx lists { key: "weekly-review" } in the nav again');
  if (!/active === "weekly-review"/.test(appSource)) violations.push("App.tsx no longer renders the weekly-review route — the route was meant to stay live for bookmarks");
  return violations;
}

export function auditShelf(kindsSource, listingSource) {
  const violations = [];
  const def = /weekly_review:\s*\{([\s\S]*?)\n  \}/.exec(kindsSource);
  if (!def || !/archived:\s*"/.test(def[1])) violations.push("the `weekly_review` deliverable kind is not marked archived in deliverable.ts");
  if (!/archivedDeliverableKinds\(\)/.test(listingSource)) violations.push("services/deliverables.ts does not derive the archived kinds from the definitions");
  if (!/\$\{archivedClause\}/.test(listingSource)) violations.push("the unfiltered deliverable listing does not apply the archived clause");
  return violations;
}

function readMigrations() {
  const names = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  return names.map((name) => ({ name, sql: stripCommentsFor(path.join(MIGRATIONS, name), readFileSync(path.join(MIGRATIONS, name), "utf8")) }));
}

function readSeeds() {
  if (!existsSync(SEEDS)) return [];
  return readdirSync(SEEDS)
    .filter((f) => f.endsWith(".mjs"))
    .map((name) => ({ name: `scripts/seed/${name}`, text: stripCommentsFor(path.join(SEEDS, name), readFileSync(path.join(SEEDS, name), "utf8")) }));
}

const read = (file) => stripCommentsFor(file, readFileSync(file, "utf8"));

function selfTest() {
  const fail = (m) => {
    console.error(`SELF-TEST FAILED — ${m}`);
    process.exit(1);
  };
  const ok = (m) => console.log(`  ✓ ${m}`);

  const real = jobStatusWrites(readMigrations());
  const realAudit = auditRetirements(real);
  if (realAudit.violations.length !== 0) fail(`the real migrations were rejected: ${realAudit.violations.join("; ")}`);
  if (!realAudit.retired.includes("weekly_mp_review")) fail("the real 0198 retirement was not seen");
  ok(`the real migrations retire ${realAudit.retired.length} job(s), weekly_mp_review among them, and nothing revives one`);
  const seed = real.find((w) => w.key === "weekly_mp_review");
  if (!seed || seed.file !== "0043_scheduled_briefings.sql" || seed.status !== "PAUSED") fail("the real 0043 seed (PAUSED) was not read");
  ok("the real 0043 seed is read as PAUSED, so the replay starts from the row as it was born");
  // A seed that REPLACES the row after the retirement.
  const reseeded = jobStatusWrites([
    ...readMigrations(),
    { name: "0199_reseed.sql", sql: "INSERT OR REPLACE INTO scheduled_job (id, job_key, name, kind, schedule_kind, daily_at_utc, target_kind, budget_usd, status, created_by) VALUES ('sjb_weekly_review', 'weekly_mp_review', 'x', 'INTELLIGENCE', 'DAILY_AT', '12:00', 'SYSTEM', 0.1, 'ACTIVE', 'system');" },
  ]);
  if (!auditRetirements(reseeded).violations.some((v) => v.includes("0199_reseed.sql"))) fail("a re-seed after the retirement was not caught");
  ok("a seed that REPLACES the row after the retirement");

  // A later migration switching it back on, both shapes.
  const revived = auditRetirements([...real, { file: "0199_bring_it_back.sql", key: "weekly_mp_review", status: "ACTIVE" }]);
  if (!revived.violations.some((v) => v.includes("0199_bring_it_back.sql"))) fail("a re-enabling UPDATE was not caught");
  const parsed = jobStatusWrites([
    ...readMigrations(),
    { name: "0199_x.sql", sql: "UPDATE scheduled_job SET status = 'PAUSED', pause_reason = 'x' WHERE job_key IN ('deck_rebuild', 'weekly_mp_review');" },
  ]);
  if (!auditRetirements(parsed).violations.some((v) => v.includes("0199_x.sql"))) fail("a re-enabling UPDATE with an IN list was not caught");
  ok("a later migration that sets the job ACTIVE or PAUSED, by `=` and by `IN (…)`");

  // The retirement itself removed.
  const never = auditRetirements(real.filter((w) => !(w.key === "weekly_mp_review" && w.status === "RETIRED")));
  if (!never.violations.some((v) => v.includes("not RETIRED"))) fail("a missing retirement was not caught");
  ok("the retirement removed altogether");

  // A seed that writes the table.
  if (auditSeeds([{ name: "scripts/seed/x.mjs", text: "db.exec(\"INSERT INTO scheduled_job (job_key, status) VALUES ('weekly_mp_review','ACTIVE')\")" }]).length !== 1) fail("a seed writing scheduled_job was not caught");
  ok("a seed that writes scheduled_job");

  // The dispatcher generating again — the real pre-archive branch.
  const jobs = read(JOBS);
  if (auditDispatcher(jobs).length !== 0) fail(`the real dispatcher was rejected: ${auditDispatcher(jobs).join("; ")}`);
  const generating = jobs.replace(
    /if \(job\.job_key === "weekly_mp_review"\) \{[\s\S]*?\n  \}/,
    'if (job.job_key === "weekly_mp_review") {\n    const { generateReview } = await import("./weeklyReview");\n    const out = await generateReview(env, actor, now);\n    return { status: "SUCCEEDED", summary: "x", artifacts };\n  }',
  );
  const v = auditDispatcher(generating);
  if (!v.some((x) => x.includes("reaches the generator"))) fail("a generating branch was not caught");
  if (!auditDispatcher(jobs.replace(/if \(job\.job_key === "weekly_mp_review"\) \{[\s\S]*?\n  \}\n/, "")).some((x) => x.includes("fall through"))) fail("a deleted branch was not caught");
  ok("the dispatcher generating again (the real pre-archive branch), and the branch deleted");

  // The nav item restored, and the route deleted.
  const app = read(APP);
  if (auditNav(app).length !== 0) fail(`the real App.tsx was rejected: ${auditNav(app).join("; ")}`);
  if (!auditNav(app.replace('{ key: "notifications", label: "Notifications" },', '{ key: "notifications", label: "Notifications" },\n      { key: "weekly-review", label: "Weekly review" },')).some((x) => x.includes("nav again"))) fail("a restored nav item was not caught");
  if (!auditNav(app.replace('active === "weekly-review"', 'active === "gone"')).some((x) => x.includes("stay live"))) fail("a deleted route was not caught");
  ok("the nav item restored, and the route deleted");

  // The kind un-archived, the shelf ignoring it.
  const kinds = read(KINDS);
  const listing = read(LISTING);
  if (auditShelf(kinds, listing).length !== 0) fail(`the real shelf was rejected: ${auditShelf(kinds, listing).join("; ")}`);
  if (!auditShelf(kinds.replace(/\n\s*archived: "[^"]*",/, ""), listing).some((x) => x.includes("not marked archived"))) fail("an un-archived kind was not caught");
  if (!auditShelf(kinds, listing.replace("${archivedClause}", "1=1")).some((x) => x.includes("archived clause"))) fail("a shelf ignoring the clause was not caught");
  ok("the kind un-archived, and the shelf ignoring the clause");

  console.log("ARCHIVED-LANE SELF-TEST PASSED");
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const files = readMigrations();
  if (files.length === 0) {
    console.error("ARCHIVED-LANE SCAN FAILED — read zero migrations. Rule 0.");
    process.exit(1);
  }
  const writes = jobStatusWrites(files);
  if (writes.length === 0) {
    console.error("ARCHIVED-LANE SCAN FAILED — found zero statements that set a scheduled_job status. Either the jobs moved or this scan's patterns no longer match. Rule 0.");
    process.exit(1);
  }
  const { violations: retire, retired } = auditRetirements(writes);
  if (retired.length === 0) {
    console.error("ARCHIVED-LANE SCAN FAILED — examined zero retired jobs. Rule 0.");
    process.exit(1);
  }

  const violations = [
    ...retire,
    ...auditSeeds(readSeeds()),
    ...auditDispatcher(read(JOBS)),
    ...auditNav(read(APP)),
    ...auditShelf(read(KINDS), read(LISTING)),
  ];
  if (violations.length > 0) {
    console.error("ARCHIVED-LANE SCAN FAILED — a retired lane can come back:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(
      "\nOwner, 18 Sep 2026, on the weekly review: \"we don't need it anymore.\" Migration 0198 retired its\n" +
        "job. RETIRED is the table's terminal status — the tick refuses it, the status route refuses it —\n" +
        "and that only holds while nothing later writes the row back.",
    );
    process.exit(1);
  }
  console.log(
    `ARCHIVED-LANE SCAN PASSED: ${writes.length} job-status statement(s) across ${files.length} migrations; ${retired.length} retired job(s) ` +
      `(${retired.join(", ")}) and none revived; no seed writes scheduled_job; the dispatcher refuses weekly_mp_review; the nav ` +
      `does not list weekly-review and the route still answers; the archived kind is off the unfiltered shelf.`,
  );
}

main();
