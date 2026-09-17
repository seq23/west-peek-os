#!/usr/bin/env node
/**
 * generate-ai-employee-seed.mjs — P4 AI-employee roster seed generator (D10/ADR-002).
 *
 * Sibling of generate-machine-seed.mjs: the AI employee roster lives in ONE
 * TypeScript source (`src/shared/registry/aiEmployees.ts`); this script regenerates
 * the GENERATED SEEDS section of migrations/0004_ai_cost_privacy.sql as
 * deterministic INSERT OR IGNORE statements. The generated SQL is committed.
 *
 * WHY THIS ALSO EMITS BACKFILLS. The seeds are INSERT OR IGNORE into migration 0004, which every
 * existing database applied long ago. For a NEW employee that is fine — the row does not exist, so
 * the insert lands on the next fresh database and a backfill carries it to the others. For an
 * EXISTING employee whose role or layer CHANGED, it is worse than fine: the row already exists, so
 * OR IGNORE skips it silently and the old value survives forever. Rewriting 0004 changes nothing
 * anywhere that matters.
 *
 * That is the exact trap the action-type generator fell into — three keys added in August 2026
 * passed every test and were simply absent in production (README, "The action-type generator").
 * It bit here too: renaming Parker to Event Marketing Coordinator updated the registry, the tests
 * and 0004, while production kept saying Event Planner.
 *
 * So every employee's CURRENT role must be established by some migration other than 0004. Any that
 * is not gets a numbered backfill of guarded UPDATEs, which existing databases pick up on the next
 * apply, and `--check` fails until one exists.
 *
 * Hard guards (fail loudly, exit 1):
 * - the roster matches EXPECTED_ROSTER_SIZE (ADR-002, revised for roster v4.0);
 * - every row seeds INACTIVE (activation is a human-reserved action, never seed-time);
 * - no Managing Partner name (full or first) appears as an AI employee (D10/ADR-003).
 *
 * Usage:
 *   node scripts/seed/generate-ai-employee-seed.mjs           # rewrite the seed section
 *   node scripts/seed/generate-ai-employee-seed.mjs --check   # verify it is up to date (CI-safe)
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATION = path.join(ROOT, "migrations", "0004_ai_cost_privacy.sql");
const BEGIN = "-- BEGIN GENERATED SEEDS (scripts/seed/generate-ai-employee-seed.mjs) — do not hand-edit";
const END = "-- END GENERATED SEEDS";

/**
 * Load a registry TS module by transpiling to CJS and evaluating it.
 *
 * RESOLVES RELATIVE IMPORTS SINCE 17 SEP 2026, and it has to. This used to require the module to be
 * import-free, which held only while every registry was a standalone list of literals.
 * `managingPartners.ts` is now a VIEW of `shared/registry/partners.ts` — the one place the firm says
 * who the two partners are — so loading it means loading what it derives from.
 *
 * The alternative was to leave `managingPartners.ts` holding its own copy of the names so this
 * script could keep its simplification, which is the tail wagging the dog: a seed generator's
 * convenience is not a reason for the firm to state a fact twice.
 *
 * Relative specifiers only, and only within `src/`. Anything else throws rather than being resolved
 * from node_modules — a registry that reaches for a dependency is not a registry, and the seed this
 * produces is written into a migration.
 */
function loadRegistryModule(relPath, cache = new Map()) {
  const key = path.normalize(relPath);
  if (cache.has(key)) return cache.get(key);
  const source = readFileSync(path.join(ROOT, key), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: key,
  });
  const sandbox = {
    exports: {},
    module: { exports: {} },
    require: (specifier) => {
      if (!specifier.startsWith(".")) {
        throw new Error(`${key} imports "${specifier}"; a registry module may only import a sibling registry.`);
      }
      const resolved = path.join(path.dirname(key), `${specifier}.ts`);
      if (!resolved.startsWith(`src${path.sep}`)) {
        throw new Error(`${key} imports "${specifier}", which resolves outside src/.`);
      }
      return loadRegistryModule(resolved, cache);
    },
  };
  sandbox.module.exports = sandbox.exports;
  cache.set(key, sandbox.module.exports);
  vm.runInNewContext(outputText, sandbox, { filename: key });
  // Re-seat: a module that reassigns `module.exports` (tsc does not, but be exact) must win.
  cache.set(key, sandbox.module.exports);
  return sandbox.module.exports;
}

const esc = (value) => `'${String(value).replaceAll("'", "''")}'`;

const roster = loadRegistryModule("src/shared/registry/aiEmployees.ts");
const mps = loadRegistryModule("src/shared/registry/managingPartners.ts");

const { AI_EMPLOYEE_ROSTER, AI_EMPLOYEE_ROSTER_VERSION } = roster;
const { MANAGING_PARTNER_NAMES } = mps;

// ── Hard guards ──
/**
 * The roster size, asserted rather than assumed.
 *
 * It was 31 under ADR-002 and became 17 under roster v4.0, consolidated on operator direction:
 * several pairs were the same job wearing two titles, and thirty-one seats described a firm that
 * does not exist. It went to 18 when Whitney was un-retired to teach in University (migrations 0069
 * and 0070) and to 19 when Percy was un-retired to review design and growth — both existing seats
 * re-pointed at questions the live roster could not answer, rather than new seats invented beside
 * retired people who already did the job.
 *
 * It is 18 again since 21 Aug 2026: LP Sourcing merged into LP Relations. Piper and Wesley both sat
 * on `lp_fundraising` and NOTHING else, so they read byte-identical guidance and were two seats
 * working the same LP prospect at a fund with roughly forty limited partners. Her row is RETIRED by
 * migration 0126, never deleted — attribution and meeting seating point at it.
 *
 * The check stays because its real job is catching an ACCIDENTAL loss — a bad merge, a deleted
 * block — which a bare "whatever length the array is" would wave through. Changing this number is a
 * deliberate act and should arrive with the roster change that justifies it.
 */
const EXPECTED_ROSTER_SIZE = 18;

if (AI_EMPLOYEE_ROSTER.length !== EXPECTED_ROSTER_SIZE) {
  console.error(
    `FATAL: AI employee roster count is ${AI_EMPLOYEE_ROSTER.length}, expected ${EXPECTED_ROSTER_SIZE}.\n` +
      "If the roster was deliberately resized, update EXPECTED_ROSTER_SIZE in this file with it.",
  );
  process.exit(1);
}
for (const entry of AI_EMPLOYEE_ROSTER) {
  if (entry.status !== "INACTIVE") {
    console.error(`FATAL: roster entry '${entry.name}' has status ${entry.status}; every seed must be INACTIVE (D10).`);
    process.exit(1);
  }
  if (MANAGING_PARTNER_NAMES.some((mp) => entry.name.toLowerCase() === mp.toLowerCase())) {
    console.error(`FATAL: roster entry '${entry.name}' collides with a Managing Partner name (D10/ADR-003).`);
    process.exit(1);
  }
}

const lines = [];
lines.push(`-- Registry provenance: AI employee roster v${AI_EMPLOYEE_ROSTER_VERSION} (Revised v3.0 roster + Whitney, ADR-002).`);
lines.push(`-- All ${AI_EMPLOYEE_ROSTER.length} rows seed INACTIVE; activation is human-reserved (ai_employee.activate), never seed-time.`);
lines.push("INSERT OR IGNORE INTO ai_employee (id, name, role, layer, primary_machines_json, status, purpose) VALUES");
lines.push(
  AI_EMPLOYEE_ROSTER.map((e, i) => {
    const id = `aie_${e.name.toLowerCase()}`;
    const row = `  (${esc(id)}, ${esc(e.name)}, ${esc(e.role)}, ${esc(e.layer)}, ${esc(JSON.stringify(e.primaryMachineKeys))}, 'INACTIVE', ${esc(e.role)})`;
    return row + (i === AI_EMPLOYEE_ROSTER.length - 1 ? ";" : ",");
  }).join("\n"),
);

const generated = `${BEGIN}\n${lines.join("\n")}\n${END}`;

const current = readFileSync(MIGRATION, "utf8");
const beginIdx = current.indexOf(BEGIN);
const endIdx = current.indexOf(END);
if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
  console.error(`FATAL: generated-seed markers not found (or out of order) in ${MIGRATION}.`);
  process.exit(1);
}
const next = current.slice(0, beginIdx) + generated + current.slice(endIdx + END.length);

const MIGRATIONS_DIR = path.join(ROOT, "migrations");

/**
 * Employees whose current role is not established by any migration outside 0004.
 *
 * Deliberately a plain substring test over the SQL rather than a parser. The question is only
 * "does some already-appliable migration mention this employee alongside this role", and a parser
 * would be a lot of machinery for a check whose failure mode is emitting one harmless extra
 * guarded UPDATE.
 */
function rolesUnreachableOutside0004() {
  const others = readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith(".sql") && !n.startsWith("0004_"))
    .map((n) => readFileSync(path.join(MIGRATIONS_DIR, n), "utf8"))
    .join("\n");
  return AI_EMPLOYEE_ROSTER.filter((e) => {
    // Compare against the SQL-ESCAPED forms. Roles like "Scooter's Chief of Staff" are written to
    // the migration with a doubled apostrophe, so a raw substring test never matches and reports
    // a perfectly reachable role as unreachable. It failed safe — a spurious backfill rather than a
    // missing one — but it would have cried wolf on every apostrophe forever.
    const mentioned = others.includes(esc(e.name)) && others.includes(esc(e.role));
    return !mentioned;
  });
}

function nextMigrationNumber() {
  const nums = readdirSync(MIGRATIONS_DIR)
    .filter((n) => /^\d{4}_.*\.sql$/.test(n))
    .map((n) => Number(n.slice(0, 4)));
  return String(Math.max(0, ...nums) + 1).padStart(4, "0");
}

if (process.argv.includes("--check")) {
  if (next !== current) {
    console.error("STALE: AI employee seeds are out of date — re-run scripts/seed/generate-ai-employee-seed.mjs.");
    process.exit(1);
  }
  const unreachable = rolesUnreachableOutside0004();
  if (unreachable.length > 0) {
    console.error(
      `UNREACHABLE: ${unreachable.length} employee role(s) exist only in 0004, so any database that ` +
      `already applied it keeps the old value:\n  ` +
      unreachable.map((e) => `${e.name} → ${e.role}`).join("\n  ") +
      "\nRe-run scripts/seed/generate-ai-employee-seed.mjs to emit a backfill migration.",
    );
    process.exit(1);
  }
  console.log(`OK: AI employee seeds up to date (${AI_EMPLOYEE_ROSTER.length} employees, all INACTIVE, no MP names; all roles reachable by an applied database).`);
} else {
  writeFileSync(MIGRATION, next);
  console.log(`Wrote seeds: ${AI_EMPLOYEE_ROSTER.length} AI employees (all INACTIVE) → ${path.relative(ROOT, MIGRATION)}`);

  const unreachable = rolesUnreachableOutside0004();
  if (unreachable.length > 0) {
    const num = nextMigrationNumber();
    const file = path.join(MIGRATIONS_DIR, `${num}_ai_employee_backfill.sql`);
    const body = [
      `-- ${num}_ai_employee_backfill.sql — generated by scripts/seed/generate-ai-employee-seed.mjs.`,
      "--",
      "-- These employees' roles were changed after 0004 had already been applied to a live database.",
      "-- The seeds there are INSERT OR IGNORE, so an existing row keeps its old value no matter how",
      "-- many times 0004 is rewritten. This migration reaches the databases that already exist.",
      "--",
      "-- Each UPDATE is guarded on the row still holding a DIFFERENT value, so a database already",
      "-- carrying the new one is untouched and re-applying changes nothing. Generated, not",
      "-- hand-written: re-run the seed generator rather than editing this.",
      "",
      // Every migration records itself. /api/health reports the latest row as the schema version,
      // and a migration that stays silent makes the deployed schema look older than it is.
      `INSERT OR IGNORE INTO schema_version (migration) VALUES ('${num}_ai_employee_backfill');`,
      "",
      ...unreachable.flatMap((e) => [
        "UPDATE ai_employee",
        `   SET role = ${esc(e.role)}, layer = ${esc(e.layer)}`,
        ` WHERE name = ${esc(e.name)}`,
        `   AND (role <> ${esc(e.role)} OR layer <> ${esc(e.layer)});`,
        "",
      ]),
    ].join("\n");
    writeFileSync(file, body);
    console.log(`Wrote backfill: ${unreachable.length} employee role(s) unreachable by applied databases → ${path.relative(ROOT, file)}`);
  }

  // ── Employees who left the roster ──
  //
  // Removing someone from the registry does NOT remove their row: the seed is INSERT OR IGNORE and
  // touches nothing that already exists. So a consolidation leaves the departed sitting in every
  // live database, still selectable, still seatable in a meeting.
  //
  // They are RETIRED, never deleted. Their rows are referenced by ai_run attribution, meeting
  // seating and work cards, and the history of what they did is real even though the seat is gone —
  // deleting would break those references and erase the record with them. RETIRED already means
  // "no longer employable" in the lifecycle, so nothing new is invented.
  //
  // Expressed as "anybody not on the roster" rather than a list of names, so it stays correct
  // through the next consolidation without anyone maintaining a leavers' list.
  //
  // Emitted ONLY when no existing retirement migration already names exactly this roster. Without
  // that check every regeneration adds another file, and a migration set grows a new no-op on each
  // run until nobody can tell which ones did anything.
  const retireList = AI_EMPLOYEE_ROSTER.map((e) => esc(e.name)).join(", ");
  const alreadyRetired = readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith("_ai_employee_retire.sql"))
    .some((n) => readFileSync(path.join(MIGRATIONS_DIR, n), "utf8").includes(retireList));

  if (!alreadyRetired && !process.argv.includes("--no-retire")) {
    const num = nextMigrationNumber();
    const file = path.join(MIGRATIONS_DIR, `${num}_ai_employee_retire.sql`);
    const body = [
      `-- ${num}_ai_employee_retire.sql — generated by scripts/seed/generate-ai-employee-seed.mjs.`,
      "--",
      "-- Employees consolidated off the roster. Their rows stay: ai_run attribution, meeting seating",
      "-- and work cards reference them, and what they did actually happened. RETIRED is the lifecycle's",
      "-- existing word for a seat that no longer exists, so nothing new is introduced here.",
      "--",
      "-- Guarded so re-applying changes nothing, and so an already-RETIRED row is left alone.",
      "",
      `INSERT OR IGNORE INTO schema_version (migration) VALUES ('${num}_ai_employee_retire');`,
      "",
      "UPDATE ai_employee",
      "   SET status = 'RETIRED'",
      ` WHERE name NOT IN (${retireList})`,
      "   AND status <> 'RETIRED';",
      "",
    ].join("\n");
    writeFileSync(file, body);
    console.log(`Wrote retirement: employees off the roster → ${path.relative(ROOT, file)}`);
  }
}
