#!/usr/bin/env node
/**
 * no-unauthorized-effects.mjs — static authority scan (P3, `npm run validate:authority`).
 *
 * Proves, by construction:
 * (a) ONLY src/worker/effects/executor.ts performs external-effect execution:
 *     - no other worker file writes state 'EXECUTED' on external_effect_request;
 *     - no worker file contains an outbound fetch() to a non-localhost URL
 *       (all effect adapters are local simulations).
 * (b) The reserved/executed call sites pass through authorize():
 *     - handleMergeCompanies and handleReverseMerge (services/companies.ts) each call
 *       authorize() with the reserved action identity_merge.execute;
 *     - executeExternalEffect (effects/executor.ts) calls authorize() and consumes
 *       the receipt via consumeApprovalCard().
 *
 * The scan FAILS LOUDLY (exit 1, named violations) on any breach. `--self-test`
 * feeds synthetic violating sources through the same check functions and asserts
 * they are caught — proving detection by design, without breaking real code.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKER_DIR = path.join(ROOT, "src", "worker");
const EXECUTOR = path.join("src", "worker", "effects", "executor.ts");

const OUTBOUND_FETCH = /fetch\s*\(\s*["'`]https?:\/\/(?!localhost\b|127\.0\.0\.1\b)/;

function listWorkerFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(WORKER_DIR);
  return out;
}

/** Extract the body of an exported async function from a source string. */
function functionBody(source, name) {
  const start = source.indexOf(`export async function ${name}`);
  if (start === -1) return null;
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

/**
 * Run all checks over a map of { relativePath: source }. Returns violation strings.
 * Pure — the same function scans the real tree and the self-test fixtures.
 */
export function checkSources(files) {
  const violations = [];

  for (const [rel, source] of Object.entries(files)) {
    // (a2) No outbound network fetch anywhere in worker code.
    if (OUTBOUND_FETCH.test(source)) {
      violations.push(`${rel}: outbound fetch() to a non-localhost URL (external effects must be local simulations in effects/executor.ts adapters)`);
    }
    // (a1) Only the executor may mark external_effect_request EXECUTED.
    if (rel !== EXECUTOR.split(path.sep).join("/") && source.includes("external_effect_request") && source.includes("EXECUTED")) {
      violations.push(`${rel}: references external_effect_request and 'EXECUTED' — only effects/executor.ts may execute external effects`);
    }
  }

  // (b) Choke-point routing at the reserved/executed call sites.
  const companies = files["src/worker/services/companies.ts"];
  if (!companies) {
    violations.push("src/worker/services/companies.ts: file missing");
  } else {
    for (const fn of ["handleMergeCompanies", "handleReverseMerge"]) {
      const body = functionBody(companies, fn);
      if (!body) {
        violations.push(`services/companies.ts: ${fn} not found`);
        continue;
      }
      if (!body.includes("authorize(") || !body.includes('"identity_merge.execute"')) {
        violations.push(`services/companies.ts: ${fn} does not route through authorize() with identity_merge.execute`);
      }
      if (!body.includes("consumeApprovalCard(")) {
        violations.push(`services/companies.ts: ${fn} does not consume the authorization receipt (consumeApprovalCard)`);
      }
    }
  }

  const executor = files[EXECUTOR.split(path.sep).join("/")];
  if (!executor) {
    violations.push(`${EXECUTOR}: file missing`);
  } else {
    const body = functionBody(executor, "executeExternalEffect");
    if (!body || !body.includes("authorize(")) {
      violations.push("effects/executor.ts: executeExternalEffect does not verify through authorize()");
    }
    if (!body || !body.includes("consumeApprovalCard(")) {
      violations.push("effects/executor.ts: executeExternalEffect does not consume the receipt (replay protection)");
    }
  }

  return violations;
}

function scanRealTree() {
  const files = {};
  for (const full of listWorkerFiles()) {
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    files[rel] = readFileSync(full, "utf8");
  }
  return files;
}

function selfTest() {
  const clean = {
    "src/worker/services/companies.ts": [
      "export async function handleMergeCompanies() { await authorize(env, actor, \"identity_merge.execute\", ref, { receiptId }); await consumeApprovalCard(env, card); }",
      "export async function handleReverseMerge() { await authorize(env, actor, \"identity_merge.execute\", ref, { receiptId }); await consumeApprovalCard(env, card); }",
    ].join("\n"),
    "src/worker/effects/executor.ts":
      "export async function executeExternalEffect() { await authorize(env, actor, key, ref, { receiptId }); await consumeApprovalCard(env, id); db('external_effect_request', 'EXECUTED'); }",
  };
  const failures = [];
  if (checkSources(clean).length !== 0) failures.push("clean fixture was flagged");

  const cases = {
    "another module marks EXECUTED": {
      ...clean,
      "src/worker/services/sneaky.ts": 'await db.prepare("UPDATE external_effect_request SET state = \'EXECUTED\'")',
    },
    "outbound fetch outside localhost": {
      ...clean,
      "src/worker/services/sneaky.ts": 'await fetch("https://api.example.com/send")',
    },
    "merge without authorize()": {
      ...clean,
      "src/worker/services/companies.ts": clean["src/worker/services/companies.ts"].replaceAll("authorize(", "noop("),
    },
    "executor without receipt consumption": {
      ...clean,
      "src/worker/effects/executor.ts": clean["src/worker/effects/executor.ts"].replace("consumeApprovalCard(", "noop("),
    },
  };
  for (const [name, files] of Object.entries(cases)) {
    if (checkSources(files).length === 0) failures.push(`violating fixture NOT caught: ${name}`);
  }
  return failures;
}

if (process.argv.includes("--self-test")) {
  const failures = selfTest();
  if (failures.length > 0) {
    console.error("SELF-TEST FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("SELF-TEST PASSED: clean fixture passes; all 4 violating fixtures are caught.");
  process.exit(0);
}

const violations = checkSources(scanRealTree());
if (violations.length > 0) {
  console.error("AUTHORITY SCAN FAILED — unauthorized-effect violations:");
  for (const v of violations) console.error(`  ✗ ${v}`);
  process.exit(1);
}
console.log("AUTHORITY SCAN PASSED: external-effect execution is confined to effects/executor.ts, no outbound fetch in worker code, merge/reverse/executor route through authorize().");
