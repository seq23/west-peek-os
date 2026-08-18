#!/usr/bin/env node
/**
 * generate-machine-seed.mjs — P3 reference-data seed generator (D14: ONE source).
 *
 * Migrations are static SQL, but the machine/domain/reserved-action reference data
 * lives in the TypeScript registry (the single versioned source). This script bridges
 * the two: it loads the registry TS files (transpiled with the repo's own `typescript`
 * devDependency — no new deps), and regenerates the GENERATED SEEDS section of
 * migrations/0003_work_authority_approval.sql as deterministic INSERT OR IGNORE
 * statements. The generated SQL is committed; this script documents provenance.
 *
 * Usage:
 *   node scripts/seed/generate-machine-seed.mjs           # rewrite the seed section
 *   node scripts/seed/generate-machine-seed.mjs --check   # verify it is up to date (CI-safe)
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATION = path.join(ROOT, "migrations", "0003_work_authority_approval.sql");
const BEGIN = "-- BEGIN GENERATED SEEDS (scripts/seed/generate-machine-seed.mjs) — do not hand-edit";
const END = "-- END GENERATED SEEDS";

/** Load an import-free registry TS module by transpiling to CJS and evaluating it. */
function loadRegistryModule(relPath) {
  const source = readFileSync(path.join(ROOT, relPath), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: relPath,
  });
  const sandbox = { exports: {}, module: { exports: {} } };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(outputText, sandbox, { filename: relPath });
  return sandbox.module.exports;
}

const esc = (value) => `'${String(value).replaceAll("'", "''")}'`;

function titleCaseDomain(id) {
  return id
    .toLowerCase()
    .split("_")
    .map((w) => (w === "os" || w === "mp" || w === "lp" ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

const machines = loadRegistryModule("src/shared/registry/machines.ts");
const reserved = loadRegistryModule("src/shared/registry/reservedActions.ts");
const actionTypes = loadRegistryModule("src/shared/registry/actionTypes.ts");

const { MACHINE_REGISTRY, MACHINE_REGISTRY_VERSION, DOMAIN_IDS } = machines;
const { HUMAN_RESERVED_ACTIONS } = reserved;
const { ORDINARY_ACTION_TYPES, EXTERNAL_EFFECT_ACTION_TYPES } = actionTypes;

// Hard guards: the generated SQL must reflect the registry counts exactly.
if (MACHINE_REGISTRY.length !== 45) {
  console.error(`FATAL: machine registry count is ${MACHINE_REGISTRY.length}, expected 45 (D14).`);
  process.exit(1);
}
if (DOMAIN_IDS.length !== 15) {
  console.error(`FATAL: domain count is ${DOMAIN_IDS.length}, expected 15.`);
  process.exit(1);
}

const reservedKeys = new Set(HUMAN_RESERVED_ACTIONS.map((a) => a.key));
const lines = [];

lines.push(`-- Registry provenance: machines v${MACHINE_REGISTRY_VERSION} (canon §5A.2), reserved-action register v3.2.14 §3.1–3.4.`);
lines.push("");
lines.push("-- Domains (canon §0C 15-domain map, order preserved):");
lines.push("INSERT OR IGNORE INTO domain (id, name) VALUES");
lines.push(
  DOMAIN_IDS.map((id, i) => `  (${esc(id)}, ${esc(titleCaseDomain(id))})${i === DOMAIN_IDS.length - 1 ? ";" : ","}`).join("\n"),
);
lines.push("");
lines.push("-- Machines (1–45, canonical row order):");
lines.push("INSERT OR IGNORE INTO machine (id, key, name, domain_id, purpose, in_initial_scope) VALUES");
lines.push(
  MACHINE_REGISTRY.map((m, i) => {
    const row = `  (${m.id}, ${esc(m.key)}, ${esc(m.name)}, ${esc(m.domain)}, ${esc(m.purpose)}, ${m.inInitialScope ? 1 : 0})`;
    return row + (i === MACHINE_REGISTRY.length - 1 ? ";" : ",");
  }).join("\n"),
);
lines.push("");
lines.push("-- Action types: human-reserved register first (is_reserved=1), then ordinary");
lines.push("-- internal actions, then external-effect action keys (is_external_effect=1).");
lines.push("INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES");
const actionRows = [
  ...HUMAN_RESERVED_ACTIONS.map((a) => ({ key: a.key, name: a.key, description: a.description, ext: 0, res: 1 })),
  ...ORDINARY_ACTION_TYPES.map((a) => ({ key: a.key, name: a.name, description: a.description, ext: a.isExternalEffect ? 1 : 0, res: reservedKeys.has(a.key) ? 1 : 0 })),
  ...EXTERNAL_EFFECT_ACTION_TYPES.map((a) => ({ key: a.key, name: a.name, description: a.description, ext: 1, res: reservedKeys.has(a.key) ? 1 : 0 })),
];
lines.push(
  actionRows
    .map((a, i) => `  (${esc(a.key)}, ${esc(a.name)}, ${esc(a.description)}, ${a.ext}, ${a.res})${i === actionRows.length - 1 ? ";" : ","}`)
    .join("\n"),
);
lines.push("");
lines.push("-- Human-reserved action register (approver roles as JSON arrays):");
lines.push("INSERT OR IGNORE INTO human_reserved_action (key, category, description, approver_roles_json) VALUES");
lines.push(
  HUMAN_RESERVED_ACTIONS.map((a, i) => {
    const row = `  (${esc(a.key)}, ${esc(a.category)}, ${esc(a.description)}, ${esc(JSON.stringify(a.approverRoles))})`;
    return row + (i === HUMAN_RESERVED_ACTIONS.length - 1 ? ";" : ",");
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

/**
 * ── Reaching databases that already applied 0003 ────────────────────────────
 *
 * THE BUG THIS EXISTS TO PREVENT, recorded because it shipped. Rewriting 0003 is correct for a
 * fresh database and useless for an existing one: a migration that has already been applied never
 * runs again. On 17 Aug 2026 three action keys were added, `--check` passed, every test passed —
 * and production simply did not have them. authorize() denies unknown keys, so three shipped
 * features returned 403 in production while working perfectly everywhere else.
 *
 * So the generator now also guarantees every key appears in SOME migration beyond 0003. Any key
 * missing from all of them gets a new numbered migration of its own, which existing databases will
 * pick up on the next apply.
 */
const MIGRATIONS_DIR = path.join(ROOT, "migrations");

/** Every action key mentioned anywhere in the migration set, 0003 included. */
function keysInMigrations() {
  const seen = new Set();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql"))) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
    for (const m of sql.matchAll(/\(\s*'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'\s*,/g)) seen.add(m[1]);
  }
  return seen;
}

/**
 * Keys that only 0003 carries. These are the dangerous ones: fine on a fresh database, absent on
 * every database that applied 0003 before the key existed.
 */
function keysOnlyIn0003() {
  const others = new Set();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql") && !n.startsWith("0003_"))) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
    for (const m of sql.matchAll(/\(\s*'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'\s*,/g)) others.add(m[1]);
  }
  return actionRows.filter((a) => !others.has(a.key)).map((a) => a.key);
}

function nextMigrationNumber() {
  const nums = readdirSync(MIGRATIONS_DIR)
    .filter((n) => /^\d{4}_.*\.sql$/.test(n))
    .map((n) => Number(n.slice(0, 4)));
  return String(Math.max(0, ...nums) + 1).padStart(4, "0");
}

if (process.argv.includes("--check")) {
  if (next !== current) {
    console.error("STALE: generated seeds are out of date — re-run scripts/seed/generate-machine-seed.mjs.");
    process.exit(1);
  }
  const unreachable = keysOnlyIn0003();
  if (unreachable.length > 0) {
    console.error(
      `UNREACHABLE: ${unreachable.length} action key(s) exist only in 0003, so any database that ` +
      `already applied it will DENY them:\n  ${unreachable.join("\n  ")}\n` +
      "Re-run scripts/seed/generate-machine-seed.mjs to emit a backfill migration.",
    );
    process.exit(1);
  }
  console.log(`OK: seeds up to date (${MACHINE_REGISTRY.length} machines, ${DOMAIN_IDS.length} domains, ${HUMAN_RESERVED_ACTIONS.length} reserved actions, ${actionRows.length} action types; all reachable by an applied database).`);
} else {
  writeFileSync(MIGRATION, next);
  console.log(`Wrote seeds: ${MACHINE_REGISTRY.length} machines, ${DOMAIN_IDS.length} domains, ${HUMAN_RESERVED_ACTIONS.length} reserved actions, ${actionRows.length} action types → ${path.relative(ROOT, MIGRATION)}`);

  const unreachable = keysOnlyIn0003();
  if (unreachable.length > 0) {
    const num = nextMigrationNumber();
    const file = path.join(MIGRATIONS_DIR, `${num}_action_types_backfill.sql`);
    const rows = actionRows.filter((a) => unreachable.includes(a.key));
    const body = [
      `-- ${num}_action_types_backfill.sql — generated by scripts/seed/generate-machine-seed.mjs.`,
      "--",
      "-- These action keys were added to the registry after 0003 had already been applied to a live",
      "-- database. Rewriting 0003 reaches new databases only; this migration reaches the existing",
      "-- ones. Without it authorize() denies the key and the feature 403s in production while",
      "-- passing every local test.",
      "--",
      "-- Generated, not hand-written. Re-run the seed generator rather than editing this.",
      "",
      `INSERT OR IGNORE INTO schema_version (migration) VALUES ('${num}_action_types_backfill');`,
      "",
      "INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES",
      rows.map((a, i) =>
        `  (${esc(a.key)}, ${esc(a.name)}, ${esc(a.description)}, ${a.ext}, ${a.res})` +
        (i === rows.length - 1 ? ";" : ","),
      ).join("\n"),
      "",
    ].join("\n");
    writeFileSync(file, body);
    console.log(`Wrote backfill: ${rows.length} action type(s) unreachable by applied databases → ${path.relative(ROOT, file)}`);
  }
}
