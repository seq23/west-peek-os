#!/usr/bin/env node
/**
 * Every SQL statement in the worker, parsed against the schema it will actually meet.
 *
 * WHY THIS EXISTS. Three bugs in one day shared a shape: correct-looking SQL that typechecked,
 * passed every test, and had never once been executed.
 *
 *   1. `ON CONFLICT (source_type, source_id)` against a PARTIAL unique index. SQLite requires the
 *      predicate repeated in the conflict target. The entire deliverables feature was dead for a
 *      day and reported nothing, because its callers wrap it so a handover failure cannot fail the
 *      brief it belongs to.
 *   2. `SELECT id FROM firm_user WHERE firm_scope = ?` — that table has no such column, so the
 *      weekly review's handover threw on every run, inside the same kind of catch.
 *   3. `SELECT id, superseded_by FROM knowledge_record` — the column is `supersedes_id` and points
 *      the other way. That one gates whether a knowledge record may back an LP claim.
 *
 * None of these is catchable by TypeScript: SQL is a string. None was caught by 1,175 tests,
 * because the paths were never exercised. All three are caught in seconds by asking SQLite to parse
 * them against the real schema.
 *
 * HOW. `EXPLAIN <statement>` parses and resolves every table and column reference WITHOUT executing
 * anything — no rows read, no rows written, safe against production. Binding errors are expected
 * and ignored: this checks the shape of the statement, not the arguments.
 *
 * LIMITS, stated because a validator that overstates itself is worse than none. Statements built by
 * interpolation (`${...}`) are skipped — their text is not knowable here. It proves a statement
 * CAN run; it says nothing about whether it returns the right rows.
 *
 * Usage:  node scripts/validate/sql-against-schema.mjs [--db WP_OS_DB] [--env production]
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const WORKER_DIR = path.resolve("src/worker");
const DB = process.argv.includes("--db") ? process.argv[process.argv.indexOf("--db") + 1] : "WP_OS_DB";
const ENV = process.argv.includes("--env") ? process.argv[process.argv.indexOf("--env") + 1] : "production";

/** Errors that mean the statement is WRONG, as opposed to merely un-bound. */
const REAL_ERROR = /no such (column|table|function)|syntax error|ambiguous column|ON CONFLICT clause does not match|too many terms/i;

function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full));
    else if (e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

export function extractStatements(files) {
  const found = new Map();
  const patterns = [
    /`(\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]{10,1400})`/gis,
    /"(\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[^"]{10,700})"/gi,
  ];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        const raw = m[1];
        if (raw.includes("${")) continue; // interpolated: text is not knowable statically
        const sql = raw.replace(/\?\d+/g, "?").replace(/\s+/g, " ").trim();
        const line = src.slice(0, m.index).split("\n").length;
        if (!found.has(sql)) found.set(sql, `${path.relative(process.cwd(), file)}:${line}`);
      }
    }
  }
  return found;
}

async function explain(sql) {
  try {
    const { stdout } = await run(
      "npx",
      ["wrangler", "d1", "execute", DB, "--env", ENV, "--remote", "--json", "--command", `EXPLAIN ${sql}`],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout;
  } catch (err) {
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
}

async function main() {
  const statements = extractStatements(listFiles(WORKER_DIR));
  const entries = [...statements.entries()];
  process.stdout.write(`Checking ${entries.length} statements against ${DB} (${ENV})…\n`);

  const failures = [];
  const CONCURRENCY = 10;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < entries.length) {
        const [sql, where] = entries[cursor++];
        const out = await explain(sql);
        const hit = REAL_ERROR.exec(out);
        if (hit) {
          const note = /"text": "([^"]{0,140})"/.exec(out.slice(out.indexOf("notes")));
          failures.push({ where, sql: sql.slice(0, 90), reason: note ? note[1] : hit[0] });
        }
      }
    }),
  );

  if (failures.length === 0) {
    process.stdout.write("SQL SCHEMA SCAN PASSED: every checkable statement parses against the live schema.\n");
    return;
  }
  process.stdout.write(`\nSQL SCHEMA SCAN FAILED — ${failures.length} statement(s) the schema rejects:\n`);
  for (const f of failures) process.stdout.write(`  ✗ ${f.where}\n      ${f.sql}\n      → ${f.reason}\n`);
  process.exitCode = 1;
}

await main();
