#!/usr/bin/env node
/**
 * a-switch-is-a-switch-on-both-sides.mjs — `npm run validate:kind-rule-switches`.
 *
 * ONE ASSERTION: A STANDING RULE THAT IS A SWITCH IS A SWITCH IN BOTH PLACES THAT DECIDE, AND
 * NEITHER PLACE KEEPS ITS OWN LIST OF WHICH RULES THOSE ARE.
 *
 * WHAT WENT WRONG, 22 Sep 2026. `work_kind_rule` rows are rendered by the Work page and changed by
 * `PATCH /api/work-kinds/:kind/rules/:key`. Both sides had the same name typed into them separately:
 *
 *     const isSwitch = rule.rule_key === "land_on_green";          // WebPropertyChangePanel.tsx
 *     if (key === "land_on_green" && !["on","off"].includes(value))  // webPropertyChange.ts
 *
 * Migration 0223 seeds `done_reply_preview_first` — her rule that Porter's finished email is shown
 * to her before it goes — as `editable = 1`. With those two lines, it would have shipped as a rule a
 * partner can READ AND NOT CHANGE: the page falls through to a read-only badge for any editable rule
 * that is not a model and not `land_on_green`, while the route would have accepted any
 * forty-character string for it. An editable row nobody can edit is the "exists but nothing invokes
 * it" defect wearing a checkbox, and the seed, the page and the route each looked correct alone.
 *
 * THE FIX IS ONE LIST IN `src/shared/work/localJobs.ts`, which both sides already import from, and
 * this scan, which fails when either side grows a list of its own again.
 *
 * WHAT IS CHECKED
 *   1 · THE LIST EXISTS AND IS SHARED. `ON_OFF_RULE_KEYS` is exported from `shared/work/localJobs.ts`
 *       — not from a worker file the client cannot import, which is what would push the page back to
 *       a literal.
 *   2 · THE PAGE READS IT. `WebPropertyChangePanel.tsx` imports `ON_OFF_RULE_KEYS` and decides
 *       `isSwitch` from it, and compares no rule key to a string literal of its own.
 *   3 · THE ROUTE READS IT. `webPropertyChange.ts`'s on/off refusal is driven by the same symbol and
 *       compares no rule key to a literal.
 *   4 · EVERY SWITCH IS A REAL, EDITABLE, ON/OFF ROW. Each key on the list is seeded by some
 *       migration with `editable = 1` and a value of `on` or `off`; a name on the list that no
 *       migration writes is a switch for a rule that does not exist.
 *   5 · EVERY EDITABLE ON/OFF ROW IS ON THE LIST. The other direction, and the one that actually
 *       bit: a migration seeding an editable rule whose value is `on` or `off` and whose key is not
 *       a model must be on the list, or it renders as a badge nobody can press.
 *
 * HARD-FAILS ON ZERO: zero switch keys, zero seeded rules, or a file it cannot read exits 1.
 *
 * `--self-test` runs the REAL pre-fix shapes — the page's `rule.rule_key === "land_on_green"`, the
 * route's `key === "land_on_green"` — plus a switch no migration seeds, an editable on/off rule
 * left off the list, and a list moved into a worker-only module, and requires each to be caught.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripCommentsFor } from "./lib/strip-comments.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SHARED = path.join(ROOT, "src", "shared", "work", "localJobs.ts");
const PAGE = path.join(ROOT, "src", "client", "pages", "WebPropertyChangePanel.tsx");
const ROUTE = path.join(ROOT, "src", "worker", "services", "webPropertyChange.ts");
const MIGRATIONS = path.join(ROOT, "migrations");

/*
 * EVERY SOURCE THIS SCAN READS IS COMMENT-STRIPPED FIRST, migrations included. A commented-out
 * `INSERT OR IGNORE INTO work_kind_rule` in a migration would otherwise read as a seeded rule, and
 * a comment on the Work page explaining that `land_on_green` used to be a literal would read as the
 * literal itself. `validate:scans-read-code` is what requires this.
 */
function read(file) {
  return stripCommentsFor(file, readFileSync(file, "utf8"));
}

/** The keys the shared list declares. Read out of the source, so a rename is visible here. */
export function switchKeysIn(shared) {
  const m = /export const ON_OFF_RULE_KEYS[^=]*=\s*\[([^\]]*)\]/.exec(shared);
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/**
 * Every `work_kind_rule` row any migration seeds: key → { editable, value }. The seed is the truth
 * about what exists; the list is a claim about it, and claim-against-truth is the whole scan.
 */
export function seededRules(migrationSources) {
  const out = {};
  for (const sql of migrationSources) {
    for (const block of sql.matchAll(/INSERT\s+OR\s+IGNORE\s+INTO\s+work_kind_rule[^;]*;/gi)) {
      for (const row of block[0].matchAll(/\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'(?:[^']|'')*'\s*,\s*'([^']*)'\s*,\s*(\d)/g)) {
        out[row[2]] = { kind: row[1], value: row[3], editable: Number(row[4]) };
      }
    }
  }
  return out;
}

export function check(files) {
  const v = [];
  const keys = switchKeysIn(files.shared);
  if (!keys) {
    v.push("ON_OFF_RULE_KEYS is not exported from src/shared/work/localJobs.ts — a list the client cannot import is a list the page will type out again");
    return { violations: v, keys: [], rules: {}, examined: 0 };
  }
  if (keys.length === 0) v.push("ON_OFF_RULE_KEYS is empty — nothing renders as a switch");

  // 2 · THE PAGE.
  if (!/ON_OFF_RULE_KEYS/.test(files.page)) v.push("WebPropertyChangePanel.tsx does not read ON_OFF_RULE_KEYS");
  if (!/const\s+isSwitch\s*=\s*ON_OFF_RULE_KEYS\.includes\(/.test(files.page)) v.push("the Work page does not decide isSwitch from the shared list");
  for (const key of keys) {
    if (new RegExp(`rule_key\\s*===\\s*["'\`]${key}["'\`]`).test(files.page)) v.push(`WebPropertyChangePanel.tsx compares rule_key to the literal "${key}" — that is the second list`);
  }

  // 3 · THE ROUTE.
  if (!/ON_OFF_RULE_KEYS\.includes\(key\)/.test(files.route)) v.push("handleSetWorkKindRule does not refuse a non-on/off value using the shared list");
  for (const key of keys) {
    if (new RegExp(`\\bkey\\s*===\\s*["'\`]${key}["'\`]`).test(files.route)) v.push(`webPropertyChange.ts compares the rule key to the literal "${key}" — that is the second list`);
  }

  // 4 + 5 · THE LIST AND THE SEEDS AGREE, BOTH WAYS.
  const rules = seededRules(files.migrations);
  if (Object.keys(rules).length === 0) v.push("no work_kind_rule row was found in any migration — this scan is reading nothing");
  for (const key of keys) {
    const row = rules[key];
    if (!row) {
      v.push(`"${key}" is on the switch list but no migration seeds a work_kind_rule row for it`);
      continue;
    }
    if (row.editable !== 1) v.push(`"${key}" renders as a switch but is seeded editable = ${row.editable}; a switch nobody may press is a lie about who decides`);
    if (!["on", "off"].includes(row.value)) v.push(`"${key}" renders as a switch but is seeded with the value "${row.value}"`);
  }
  for (const [key, row] of Object.entries(rules)) {
    if (keys.includes(key) || key.startsWith("model_")) continue;
    if (row.editable === 1 && ["on", "off"].includes(row.value)) {
      v.push(`"${key}" is seeded editable with an on/off value but is not on ON_OFF_RULE_KEYS — it renders as a read-only badge and the API takes any string for it`);
    }
  }
  return { violations: v, keys, rules, examined: keys.length + Object.keys(rules).length };
}

function loadFiles() {
  return {
    shared: read(SHARED),
    page: read(PAGE),
    route: read(ROUTE),
    migrations: readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => read(path.join(MIGRATIONS, f))),
  };
}

function selfTest() {
  let failed = 0;
  const say = (ok, what) => {
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${what}`);
  };
  const files = loadFiles();
  const real = check(files);
  say(real.violations.length === 0 && real.keys.length > 0 && real.examined > 0, `the shipped tree passes (${real.keys.length} switch(es), ${Object.keys(real.rules).length} seeded rule(s)): ${real.violations.join("; ")}`);

  // THE REAL PRE-FIX PAGE.
  const oldPage = { ...files, page: files.page.replace(/const isSwitch = ON_OFF_RULE_KEYS\.includes\(rule\.rule_key\);/, 'const isSwitch = rule.rule_key === "land_on_green";').replace(/import \{ ON_OFF_RULE_KEYS \}[^\n]*\n/, "") };
  say(check(oldPage).violations.some((x) => /Work page does not decide isSwitch|does not read ON_OFF_RULE_KEYS/.test(x)), "22 Sep's real page — isSwitch from a literal — is caught");

  // THE REAL PRE-FIX ROUTE.
  const oldRoute = { ...files, route: files.route.replace(/ON_OFF_RULE_KEYS\.includes\(key\)/, 'key === "land_on_green"') };
  const oldRouteOut = check(oldRoute);
  say(oldRouteOut.violations.some((x) => /does not refuse a non-on\/off value using the shared list/.test(x)) && oldRouteOut.violations.some((x) => /compares the rule key to the literal "land_on_green"/.test(x)), "22 Sep's real route — the key compared to a literal — is caught");

  // A SWITCH FOR A RULE THAT DOES NOT EXIST.
  const ghost = { ...files, shared: files.shared.replace(/(export const ON_OFF_RULE_KEYS[^=]*=\s*\[)/, '$1"never_seeded_anywhere", ') };
  say(check(ghost).violations.some((x) => /no migration seeds a work_kind_rule row for it/.test(x)), "a switch for a rule no migration seeds is caught");

  // THE DEFECT THAT ACTUALLY HAPPENED: an editable on/off rule left off the list.
  const dropped = { ...files, shared: files.shared.replace(/"done_reply_preview_first"\s*,?\s*/, "") };
  say(check(dropped).violations.some((x) => /done_reply_preview_first.*not on ON_OFF_RULE_KEYS/.test(x)), "an editable on/off rule left off the list is caught — the defect this file exists for");

  // A SWITCH SEEDED UNEDITABLE.
  const locked = { ...files, migrations: files.migrations.map((m) => m.replace("'Land on green', 'on', 1,", "'Land on green', 'on', 0,")) };
  say(check(locked).violations.some((x) => /a switch nobody may press/.test(x)), "a switch seeded uneditable is caught");

  // THE LIST MOVED SOMEWHERE THE CLIENT CANNOT IMPORT FROM.
  say(check({ ...files, shared: "export const SOMETHING_ELSE = [];" }).violations.some((x) => /not exported from src\/shared/.test(x)), "the list moved out of shared is caught");

  say(check({ ...files, migrations: [] }).violations.some((x) => /reading nothing/.test(x)), "no seeded rules at all fails rather than passing on nothing");

  if (failed > 0) {
    console.error(`SELF-TEST FAILED: ${failed} case(s)`);
    process.exit(1);
  }
  console.log("SELF-TEST PASSED: every planted defect was caught and the shipped tree passes");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const files = loadFiles();
  const { violations, keys, rules, examined } = check(files);
  if (keys.length === 0 || Object.keys(rules).length === 0 || examined === 0) {
    console.error("KIND-RULE SWITCH SCAN FAILED — it examined nothing. A scan that goes blind must look like a failure.");
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error(`KIND-RULE SWITCH SCAN FAILED — ${violations.length} violation(s):`);
    for (const x of violations) console.error(`  · ${x}`);
    process.exit(1);
  }
  console.log(
    `KIND-RULE SWITCH SCAN PASSED: ${keys.length} switch(es) across ${Object.keys(rules).length} seeded standing rule(s) — ` +
      "the Work page and the PATCH route read one shared list, every switch is a real editable on/off row, and every editable on/off row is a switch.",
  );
}
