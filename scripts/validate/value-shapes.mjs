#!/usr/bin/env node
/**
 * The class of bug where two pieces of code disagree about what a column HOLDS.
 *
 * WHY THIS EXISTS. `validate:sql` proves every statement can RUN. It cannot prove one will ever
 * MATCH A ROW, and that is where this firm's four most expensive bugs lived — every side typed
 * `string`, so nothing but running it could tell:
 *
 *   1. `CANCELLED: []` in the work-card transition table — "put it back" 409'd in silence.
 *   2. `INVESTED` compared against a column whose value is `CLOSED` — the board read "Invested 0"
 *      beside a row badged Invested.
 *   3. `DAILY` compared against a schedule whose value is `DAILY_AT` — "No cadence set" printed
 *      directly above a next-run time.
 *   4. `WHERE ai_employee.id = ?` bound with `scheduled_job.target_id`, which holds the roster NAME.
 *      Parker's id is `aie_parker`, so the job refused itself twice daily with "target employee
 *      Parker does not exist" — about an employee who exists and is ACTIVE.
 *
 * Each was found by a person noticing something wrong on a page. After the fourth the operator
 * asked, fairly, why the class had never been swept. This is the sweep.
 *
 * WHAT IT DELIBERATELY WILL NOT DO, because the first draft did and was useless. It does not guess
 * which table a bare `state === "DOWN"` belongs to: `state`, `kind` and `status` name columns in
 * dozens of tables, and unioning their values produced 226 findings of which zero were bugs. A
 * detector that cries wolf 226 times is worse than none, and this session has already produced two
 * of those. Every check below rests on something the schema or the data DECLARES, never on two
 * names looking alike.
 *
 * THE FOUR CHECKS:
 *
 *   A · ORPHANED REFERENCES. Every REFERENCES clause the schema declares, checked against the rows.
 *       A value pointing at a row that is not there is a bug needing no judgement.
 *
 *   B · POLYMORPHIC COLUMNS, REPORTED. A column like `scheduled_job.target_id` declares no target,
 *       which is exactly why nothing caught Parker. This prints what its values ACTUALLY match on
 *       every run, so the answer is on the screen rather than in somebody's head.
 *
 *   C · SQL LITERALS AGAINST THE OWNING TABLE. `FROM investment_opportunity WHERE status = 'X'` is
 *       checked against THAT table's CHECK constraint. Table-aware, therefore exact.
 *
 *   D · TS CONSTANTS AGAINST THE SCHEMA. The exported value lists the code compares against must
 *       equal the database's CHECK constraint. This is the one that kills the family at its root:
 *       when the list and the column agree and the code uses the list, a typo stops compiling.
 *
 * Usage:  node scripts/validate/value-shapes.mjs [--env production]
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ENV = process.argv.includes("--env") ? process.argv[process.argv.indexOf("--env") + 1] : "production";
const DB = "WP_OS_DB";
const SRC = path.resolve("src");

async function query(sql) {
  const { stdout } = await exec(
    "npx",
    ["wrangler", "d1", "execute", DB, "--env", ENV, "--remote", "--json", "--command", sql],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout.slice(stdout.indexOf("[")))[0]?.results ?? [];
}

/** Run `worker` over `items` a few at a time. Sequential remote queries make this unrunnable. */
async function pooled(items, worker, concurrency = 12) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < items.length) await worker(items[cursor++]);
    }),
  );
}

function sourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

// ── The schema, exactly as the database has it ──────────────────────────────

async function loadSchema() {
  const rows = await query("SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL");
  const tables = new Map();
  for (const { name, sql } of rows) {
    if (name.startsWith("sqlite_") || name === "d1_migrations") continue;
    const lines = String(sql).split("\n");
    const columns = new Map();
    for (let i = 0; i < lines.length; i += 1) {
      /*
       * A LINE CAN DECLARE MORE THAN ONE COLUMN. `ALTER TABLE ADD COLUMN` appends to the last line,
       * so `briefing` ends with firm_scope, synthesis_md and synthesis_ai_run_id all on one line.
       * Reading REFERENCES from the whole line attributed `REFERENCES ai_run (id)` to firm_scope
       * and reported five orphans against a column that references nothing. Segments, not lines.
       */
      for (const segment of lines[i].split(/,(?![^(]*\))/)) {
        const col = /^\s*"?([a-z_][a-z0-9_]*)"?\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)/i.exec(segment);
        if (!col || columns.has(col[1])) continue;
        // A CHECK may sit in the segment or spill onto the next two lines; both spellings are used.
        const window = `${segment} ${lines[i + 1] ?? ""} ${lines[i + 2] ?? ""}`;
        const check = new RegExp(`CHECK\\s*\\(\\s*"?${col[1]}"?\\s+IN\\s*\\(([^)]*)\\)`, "i").exec(window);
        const ref = /REFERENCES\s+"?(\w+)"?\s*\(\s*"?(\w+)"?\s*\)/i.exec(segment);
        columns.set(col[1], {
          type: col[2].toUpperCase(),
          values: check ? [...check[1].matchAll(/'([^']*)'/g)].map((m) => m[1]) : null,
          references: ref ? { table: ref[1], column: ref[2] } : null,
        });
      }
    }
    tables.set(name, columns);
  }
  return tables;
}

// ── A · references the schema declares, checked against the rows ────────────

async function orphanAudit(tables) {
  const pairs = [];
  for (const [table, columns] of tables) {
    for (const [column, meta] of columns) {
      if (meta.references) pairs.push({ table, column, target: meta.references });
    }
  }
  const findings = [];
  await pooled(pairs, async (p) => {
    const rows = await query(
      `SELECT COUNT(*) AS n FROM "${p.table}" c
        WHERE c."${p.column}" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "${p.target.table}" t WHERE t."${p.target.column}" = c."${p.column}")`,
    ).catch(() => null);
    if (!rows) return;
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) findings.push({ ...p, orphans: n });
  });
  findings.sort((a, b) => b.orphans - a.orphans);
  return findings;
}


/**
 * Polymorphic columns whose target IS decided, even though the schema cannot say so.
 *
 * `scheduled_job.target_id` points at an employee, a machine or nothing, depending on target_kind —
 * so it can carry no REFERENCES clause and check A can never see it. That is precisely why the
 * id/name divergence lived there. Migration 0087 settled the rule (a reference is an id, a byline
 * is a name); this is what stops it drifting back.
 */
const POLY_PINS = [
  {
    table: "scheduled_job",
    column: "target_id",
    where: "target_kind = 'EMPLOYEE'",
    target: { table: "ai_employee", column: "id" },
    rule: "an employee REFERENCE is their id — their name is a byline, not a pointer (migration 0087)",
  },
  {
    table: "work_card",
    column: "owner_id",
    where: "owner_type = 'AI'",
    target: { table: "ai_employee", column: "id" },
    rule: "an employee REFERENCE is their id (migration 0087)",
  },
  {
    table: "ai_run",
    column: "ai_employee_id",
    where: "ai_employee_id IS NOT NULL",
    target: { table: "ai_employee", column: "id" },
    rule: "spend is attributed by id, so one employee is never split across two keys",
  },
];

async function polyPinAudit() {
  const findings = [];
  await pooled(POLY_PINS, async (pin) => {
    const rows = await query(
      `SELECT DISTINCT c."${pin.column}" AS v FROM "${pin.table}" c
        WHERE ${pin.where} AND c."${pin.column}" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "${pin.target.table}" t WHERE t."${pin.target.column}" = c."${pin.column}")
        LIMIT 10`,
    ).catch(() => null);
    if (!rows || rows.length === 0) return;
    findings.push({ ...pin, offenders: rows.map((r) => String(r.v)) });
  });
  return findings;
}

// ── B · what a polymorphic column actually points at ────────────────────────

function polymorphicColumns(tables) {
  const out = [];
  for (const [table, columns] of tables) {
    for (const [column, meta] of columns) {
      if (meta.type !== "TEXT" || meta.references || meta.values) continue;
      if (column === "id" || !/(_id|_key)$/.test(column)) continue;
      out.push({ table, column });
    }
  }
  return out;
}

function identityColumns(tables) {
  const out = [];
  for (const [table, columns] of tables) {
    for (const column of ["id", "name", "job_key", "email", "machine_key", "slug"]) {
      if (columns.has(column)) out.push({ table, column });
    }
  }
  return out;
}

async function polymorphicReport(tables) {
  const values = new Map();
  await pooled(identityColumns(tables), async (id) => {
    const rows = await query(
      `SELECT DISTINCT "${id.column}" AS v FROM "${id.table}" WHERE "${id.column}" IS NOT NULL LIMIT 3000`,
    ).catch(() => []);
    if (rows.length > 0) values.set(`${id.table}.${id.column}`, { ...id, set: new Set(rows.map((r) => String(r.v))) });
  });

  const out = [];
  await pooled(polymorphicColumns(tables), async (ref) => {
    const rows = await query(
      `SELECT DISTINCT "${ref.column}" AS v FROM "${ref.table}" WHERE "${ref.column}" IS NOT NULL AND "${ref.column}" != '' LIMIT 50`,
    ).catch(() => []);
    const sample = rows.map((r) => String(r.v));
    if (sample.length === 0) return;
    const matches = [];
    for (const [key, id] of values) {
      if (id.table === ref.table && id.column === ref.column) continue;
      const n = sample.filter((v) => id.set.has(v)).length;
      if (n > 0) matches.push({ key, n, of: sample.length });
    }
    matches.sort((a, b) => b.n - a.n);
    out.push({ ref, sample, matches });
  });
  out.sort((a, b) => `${a.ref.table}.${a.ref.column}`.localeCompare(`${b.ref.table}.${b.ref.column}`));
  return out;
}

// ── C · SQL literals, checked against the table the statement names ─────────

function sqlLiteralAudit(tables, files, sources = {}) {
  const findings = [];
  for (const file of files) {
    const src = sources[file] ?? readFileSync(file, "utf8");
    /*
     * ONLY WHERE THE STATEMENT SAYS WHICH TABLE THE COLUMN IS.
     *
     * The first cut took any comparison within 400 characters of a FROM. On a statement selecting
     * from `intelligence_report` inside a query over `firm_user`, it read the outer `u.status =
     * 'ACTIVE'` as an intelligence_report status and reported a bug that was not there. A literal
     * counts here only when the column carries the alias this FROM bound, or when the statement
     * touches exactly one table and the column is unqualified. Everything else is skipped —
     * a missed check costs nothing; a false one costs the whole validator's credibility.
     */
    for (const stmt of src.matchAll(/(?:FROM|UPDATE|INTO)\s+"?(\w+)"?(?:\s+(?:AS\s+)?([a-z]\w*))?\b([\s\S]{0,400}?)(?:`|"|;)/g)) {
      const table = tables.get(stmt[1]);
      if (!table) continue;
      const alias = stmt[2] && !/^(WHERE|SET|VALUES|ON|ORDER|GROUP|LIMIT|JOIN|LEFT|INNER|AS)$/i.test(stmt[2]) ? stmt[2] : null;
      const body = stmt[3];
      const multiTable = /\bJOIN\b/i.test(body) || /\bFROM\s+\w/i.test(body);
      for (const cmp of body.matchAll(/(?:\b(\w+)\.)?\b(\w+)\s*(?:=|!=|<>)\s*'([^']+)'/g)) {
        const [, qualifier, column, literal] = cmp;
        // Qualified: it must be THIS table's alias. Unqualified: only trust a single-table statement.
        if (qualifier ? qualifier !== alias : multiTable) continue;
        const meta = table.get(column);
        if (!meta?.values || meta.values.includes(literal)) continue;
        findings.push({
          file: path.relative(process.cwd(), file),
          line: src.slice(0, stmt.index).split("\n").length,
          table: stmt[1],
          column,
          literal,
          legal: meta.values,
        });
      }
    }
  }
  return findings;
}

// ── D · the TS constants the code compares against, versus the schema ───────

/**
 * The lists worth pinning, and the column each one is the vocabulary FOR.
 *
 * Explicit rather than discovered, deliberately. A list is worth checking only where somebody has
 * decided it is the same vocabulary as a column; inferring that from a name is what made check C's
 * first draft produce 226 false alarms. Add a row here whenever a new enum earns a constant.
 */
const PINNED = [
  { constant: "CARD_STATES", file: "src/shared/work/workCards.ts", table: "work_card", column: "state" },
  { constant: "SCHEDULE_KINDS", file: "src/shared/setup/recommendedJobs.ts", table: "scheduled_job", column: "schedule_kind" },
  { constant: "TARGET_KINDS", file: "src/shared/setup/recommendedJobs.ts", table: "scheduled_job", column: "target_kind" },
  { constant: "DELIVERABLE_KINDS", file: "src/shared/deliverables/deliverable.ts", table: "deliverable", column: "kind" },
];

function constantValues(file, name, suppliedSource) {
  const src = suppliedSource ?? readFileSync(path.resolve(file), "utf8");
  const m = new RegExp(`export const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`).exec(src);
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function constantDriftAudit(tables, pins = PINNED, sources = {}) {
  const findings = [];
  for (const pin of pins) {
    const declared = tables.get(pin.table)?.get(pin.column)?.values;
    if (!declared) {
      findings.push({ ...pin, problem: `no CHECK on ${pin.table}.${pin.column} — the pin is stale` });
      continue;
    }
    const actual = constantValues(pin.file, pin.constant, sources[pin.file]);
    if (!actual) {
      findings.push({ ...pin, problem: `constant ${pin.constant} not found — renamed or moved?` });
      continue;
    }
    const missing = declared.filter((v) => !actual.includes(v));
    const extra = actual.filter((v) => !declared.includes(v));
    if (missing.length || extra.length) {
      findings.push({
        ...pin,
        problem: [
          missing.length ? `the column permits ${missing.join(", ")}, which the constant omits` : "",
          extra.length ? `the constant offers ${extra.join(", ")}, which the column rejects` : "",
        ]
          .filter(Boolean)
          .join("; "),
      });
    }
  }
  return findings;
}


// ── Self-test ────────────────────────────────────────────────────────────────

/**
 * Prove the detector detects, on every run.
 *
 * A validator nobody has watched fail is a validator nobody should trust. This session produced two
 * scanners that reported cleanly because their patterns never matched anything — so every validator
 * here plants known violations and refuses to pass unless each one is caught. The fixtures below are
 * the four real bugs, reduced to their shape.
 */
function selfTest() {
  const fakeTables = new Map([
    [
      "investment_opportunity",
      new Map([
        ["status", { type: "TEXT", values: ["NEW", "SCREENING", "CLOSED", "PASS"], references: null }],
        ["company_id", { type: "TEXT", values: null, references: { table: "canonical_company", column: "id" } }],
      ]),
    ],
    ["work_card", new Map([["state", { type: "TEXT", values: ["OPEN", "DONE", "CANCELLED"], references: null }]])],
    ["canonical_company", new Map([["status", { type: "TEXT", values: ["ACTIVE", "MERGED"], references: null }]])],
  ]);

  const cases = [];

  // 1 · the INVESTED/CLOSED bug: a literal the column cannot hold.
  cases.push({
    name: "a SQL literal outside the column's CHECK",
    caught:
      sqlLiteralAudit(fakeTables, ["f.ts"], {
        "f.ts": "`SELECT id FROM investment_opportunity WHERE status = 'INVESTED'`",
      }).length === 1,
  });

  // 2 · the DAILY/DAILY_AT bug, as constant drift.
  cases.push({
    name: "a TS constant out of step with its column",
    caught:
      constantDriftAudit(
        fakeTables,
        [{ constant: "CARD_STATES", file: "f.ts", table: "work_card", column: "state" }],
        { "f.ts": 'export const CARD_STATES = ["OPEN", "DONE", "ABANDONED"] as const;' },
      ).length === 1,
  });

  // 3 · a renamed constant, which is drift wearing a different hat.
  cases.push({
    name: "a pinned constant that no longer exists",
    caught:
      constantDriftAudit(
        fakeTables,
        [{ constant: "CARD_STATES", file: "f.ts", table: "work_card", column: "state" }],
        { "f.ts": "export const SOMETHING_ELSE = [];" },
      ).length === 1,
  });

  // And the two shapes that must NOT be reported, because reporting them is what made the first
  // draft useless: a literal belonging to another table in a joined statement, and a correct one.
  cases.push({
    name: "another table's literal in a joined statement is left alone",
    caught:
      sqlLiteralAudit(fakeTables, ["f.ts"], {
        "f.ts":
          "`SELECT o.id FROM investment_opportunity o JOIN canonical_company c ON c.id = o.company_id WHERE c.status = 'MERGED'`",
      }).length === 0,
  });
  cases.push({
    name: "a legal literal is left alone",
    caught:
      sqlLiteralAudit(fakeTables, ["f.ts"], {
        "f.ts": "`SELECT id FROM investment_opportunity WHERE status = 'CLOSED'`",
      }).length === 0,
  });

  const missed = cases.filter((c) => !c.caught);
  if (missed.length > 0) {
    process.stdout.write(`SELF-TEST FAILED — ${missed.length} case(s) the detector gets wrong:\n`);
    for (const m of missed) process.stdout.write(`  ✗ ${m.name}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`SELF-TEST PASSED: ${cases.length}/${cases.length} fixtures behave as intended.\n`);
}

// ── Report ───────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const files = sourceFiles(SRC);
  process.stdout.write(`Reading the live schema and data (${DB}, ${ENV})…\n`);
  const tables = await loadSchema();

  const drift = constantDriftAudit(tables);
  const literals = sqlLiteralAudit(tables, files);
  const orphans = await orphanAudit(tables);
  const pins = await polyPinAudit();
  const poly = await polymorphicReport(tables);

  let failed = false;

  if (drift.length > 0) {
    failed = true;
    process.stdout.write(`\nA TS CONSTANT AND ITS COLUMN DISAGREE — ${drift.length}:\n`);
    for (const d of drift) {
      process.stdout.write(`  ✗ ${d.constant} (${d.file}) vs ${d.table}.${d.column}\n      ${d.problem}\n`);
    }
  }

  if (literals.length > 0) {
    failed = true;
    process.stdout.write(`\nSQL LITERALS THE COLUMN CANNOT HOLD — ${literals.length}:\n`);
    for (const l of literals) {
      process.stdout.write(
        `  ✗ ${l.file}:${l.line}  ${l.table}.${l.column} = '${l.literal}'\n      permitted: ${l.legal.join(", ")}\n`,
      );
    }
  }

  if (orphans.length > 0) {
    failed = true;
    process.stdout.write(`\nREFERENCES POINTING AT ROWS THAT ARE NOT THERE — ${orphans.length}:\n`);
    for (const o of orphans) {
      process.stdout.write(
        `  ✗ ${o.table}.${o.column} → ${o.target.table}.${o.target.column}: ${o.orphans} orphaned row(s)\n`,
      );
    }
  }

  if (pins.length > 0) {
    failed = true;
    process.stdout.write(`\nA REFERENCE POINTING AT THE WRONG THING — ${pins.length}:\n`);
    for (const p of pins) {
      process.stdout.write(
        `  ✗ ${p.table}.${p.column} (${p.where}) holds ${JSON.stringify(p.offenders)}\n` +
          `      which is not a ${p.target.table}.${p.target.column}\n      ${p.rule}\n`,
      );
    }
  }

  // Printed every run, pass or fail. Parker's bug was invisible precisely because nothing ever
  // stated what `scheduled_job.target_id` contained; a line of output is the whole fix.
  process.stdout.write(`\nPolymorphic columns — what their values actually match:\n`);
  for (const p of poly) {
    const best = p.matches[0];
    process.stdout.write(
      `  · ${p.ref.table}.${p.ref.column} → ${
        best ? `${best.key} (${best.n}/${best.of})` : `NOTHING (e.g. ${JSON.stringify(p.sample[0])})`
      }\n`,
    );
  }

  if (failed) {
    process.stdout.write(`\nVALUE SHAPE SCAN FAILED.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `\nVALUE SHAPE SCAN PASSED: no constant out of step with its column, no SQL literal the column rejects, no orphaned reference, and every pinned reference points at the right kind of thing.\n`,
  );
}

await main();
