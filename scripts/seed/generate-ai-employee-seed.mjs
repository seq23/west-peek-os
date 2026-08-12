#!/usr/bin/env node
/**
 * generate-ai-employee-seed.mjs — P4 AI-employee roster seed generator (D10/ADR-002).
 *
 * Sibling of generate-machine-seed.mjs: the AI employee roster lives in ONE
 * TypeScript source (`src/shared/registry/aiEmployees.ts`); this script regenerates
 * the GENERATED SEEDS section of migrations/0004_ai_cost_privacy.sql as
 * deterministic INSERT OR IGNORE statements. The generated SQL is committed.
 *
 * Hard guards (fail loudly, exit 1):
 * - exactly 31 roster rows (ADR-002);
 * - every row seeds INACTIVE (activation is a human-reserved action, never seed-time);
 * - no Managing Partner name (full or first) appears as an AI employee (D10/ADR-003).
 *
 * Usage:
 *   node scripts/seed/generate-ai-employee-seed.mjs           # rewrite the seed section
 *   node scripts/seed/generate-ai-employee-seed.mjs --check   # verify it is up to date (CI-safe)
 */

import { readFileSync, writeFileSync } from "node:fs";
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

const roster = loadRegistryModule("src/shared/registry/aiEmployees.ts");
const mps = loadRegistryModule("src/shared/registry/managingPartners.ts");

const { AI_EMPLOYEE_ROSTER, AI_EMPLOYEE_ROSTER_VERSION } = roster;
const { MANAGING_PARTNER_NAMES } = mps;

// ── Hard guards ──
if (AI_EMPLOYEE_ROSTER.length !== 31) {
  console.error(`FATAL: AI employee roster count is ${AI_EMPLOYEE_ROSTER.length}, expected 31 (ADR-002).`);
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
lines.push("-- All 31 rows seed INACTIVE; activation is human-reserved (ai_employee.activate), never seed-time.");
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

if (process.argv.includes("--check")) {
  if (next !== current) {
    console.error("STALE: AI employee seeds are out of date — re-run scripts/seed/generate-ai-employee-seed.mjs.");
    process.exit(1);
  }
  console.log(`OK: AI employee seeds up to date (${AI_EMPLOYEE_ROSTER.length} employees, all INACTIVE, no MP names).`);
} else {
  writeFileSync(MIGRATION, next);
  console.log(`Wrote seeds: ${AI_EMPLOYEE_ROSTER.length} AI employees (all INACTIVE) → ${path.relative(ROOT, MIGRATION)}`);
}
