#!/usr/bin/env node
/**
 * free-lanes-cannot-see-confidential.mjs — `npm run validate:free-lanes`.
 *
 * THE LINE THIS DEFENDS is the owner's, in her words: "yes LP names and deal terms are
 * confidential." A free model route is generally free BECAUSE the provider may use what you send it
 * to improve their models. Google states it in terms, verbatim: "Do not submit sensitive,
 * confidential, or personal information to the Unpaid Services."
 *
 * So a training-permitting lane must be STRUCTURALLY INCAPABLE of receiving content above its
 * permitted data class — refused at the router, before a request is formed. That is the lesson of
 * the sonar incident: callers said "must not be the search model" in an if-statement AFTER the run,
 * and a rule enforced after the request has left is not a rule.
 *
 * This scan reads the migrations as data and the router as source, and asserts four things:
 *
 *   1. Every provider with `training_permitted = 1` has an explicit `provider_data_policy` row for
 *      EVERY privacy label, allowing PUBLIC and nothing else. Default-deny means a missing row is
 *      already a refusal, but an explicit 0 is the difference between "denied" and "nobody thought
 *      about it" when somebody adds a label next year.
 *   2. Every model on such a provider records `max_data_class = 'PUBLIC'`, so the catalogue and the
 *      egress policy cannot disagree.
 *   3. `runAi` filters those providers out when a call is marked `confidential`, and does it BEFORE
 *      the egress check — because `confidential` is a fact about the words, not the label, and a
 *      PUBLIC-labelled summary of a deal still contains the terms.
 *   4. The refusal is a block with a named reason, not a silent skip.
 *
 * HARD-FAILS ON ZERO ROUTES EXAMINED. A validator that finds no training-permitting lane and prints
 * a tick is the "guard that cannot reach what it governs" defect in this portfolio's own words.
 *
 * `--self-test` feeds synthetic migrations and router sources through the same pure functions,
 * including a lane that allows INTERNAL and a router missing the filter, and asserts both are
 * caught.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stripCommentsFor } from "./lib/strip-comments.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Every label the schema knows. A lane that may train gets PUBLIC and is denied all of these. */
export const NON_PUBLIC_LABELS = [
  "INTERNAL",
  "RESTRICTED",
  "LP_PRIVATE",
  "CONFIDENTIAL",
  "MNPI_SENSITIVE",
  "BANKING_RESTRICTED",
];

/** Providers the migrations mark as permitting training, by provider id. */
export function trainingPermittedProviders(migrationSql) {
  const ids = new Set();
  // Rows inserted with the column listed, taking the value from the tuple's position.
  const insertRe =
    /INSERT\s+OR\s+IGNORE\s+INTO\s+provider_registry\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*?);/gi;
  let m;
  while ((m = insertRe.exec(migrationSql)) !== null) {
    const cols = m[1].split(",").map((c) => c.trim());
    const idAt = cols.indexOf("id");
    const tpAt = cols.indexOf("training_permitted");
    if (idAt < 0 || tpAt < 0) continue;
    for (const tuple of m[2].matchAll(/\(([\s\S]*?)\)\s*(?:,|$)/g)) {
      const parts = splitTuple(tuple[1]);
      if (parts.length <= Math.max(idAt, tpAt)) continue;
      if (parts[tpAt].trim() === "1") ids.add(unquote(parts[idAt]));
    }
  }
  // …and rows switched on afterwards by key.
  for (const u of migrationSql.matchAll(
    /UPDATE\s+provider_registry\s+SET\s+training_permitted\s*=\s*1[\s\S]*?WHERE[\s\S]*?provider_key\s+IN\s*\(([^)]*)\)/gi,
  )) {
    for (const k of splitTuple(u[1])) ids.add(`key:${unquote(k)}`);
  }
  return ids;
}

/** Split a SQL tuple on commas that are not inside quotes or braces. */
function splitTuple(s) {
  const out = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") quoted = !quoted;
    if (!quoted && (c === "(" || c === "{")) depth++;
    if (!quoted && (c === ")" || c === "}")) depth--;
    if (c === "," && !quoted && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function unquote(s) {
  return s.trim().replace(/^'|'$/g, "").replace(/''/g, "'");
}

/** Every (provider_id, label) → allowed pair the migrations declare. */
export function dataPolicyRows(migrationSql) {
  const rows = [];
  for (const m of migrationSql.matchAll(
    /INSERT\s+OR\s+IGNORE\s+INTO\s+provider_data_policy[^;]*?VALUES([\s\S]*?);/gi,
  )) {
    for (const tuple of m[1].matchAll(/\(([\s\S]*?)\)/g)) {
      const parts = splitTuple(tuple[1]).map((p) => p.trim());
      if (parts.length < 4) continue;
      rows.push({ providerId: unquote(parts[1]), label: unquote(parts[2]), allowed: parts[3] === "1" });
    }
  }
  return rows;
}

/** max_data_class per model, for models on the providers we care about. */
export function modelDataClasses(migrationSql) {
  const out = [];
  for (const m of migrationSql.matchAll(
    /INSERT\s+OR\s+IGNORE\s+INTO\s+provider_model\s*\(([^)]*)\)\s*VALUES([\s\S]*?);/gi,
  )) {
    const cols = m[1].split(",").map((c) => c.trim());
    const pAt = cols.indexOf("provider_id");
    const mAt = cols.indexOf("model");
    const dAt = cols.indexOf("max_data_class");
    if (pAt < 0 || mAt < 0 || dAt < 0) continue;
    for (const tuple of m[2].matchAll(/\(([\s\S]*?)\)\s*(?:,\s*\n|,?\s*$)/g)) {
      const parts = splitTuple(tuple[1]);
      if (parts.length <= Math.max(pAt, mAt, dAt)) continue;
      out.push({ providerId: unquote(parts[pAt]), model: unquote(parts[mAt]), maxDataClass: unquote(parts[dAt]) });
    }
  }
  return out;
}

/** Pure: everything the check knows how to be wrong about. */
export function check({ migrationSql, routerSource }) {
  const violations = [];
  const trainingIds = trainingPermittedProviders(migrationSql);
  const policies = dataPolicyRows(migrationSql);
  const models = modelDataClasses(migrationSql);
  const examined = [...trainingIds].filter((id) => !id.startsWith("key:"));

  for (const providerId of examined) {
    const mine = policies.filter((p) => p.providerId === providerId);
    const publicRow = mine.find((p) => p.label === "PUBLIC");
    if (!publicRow || !publicRow.allowed) {
      violations.push(`${providerId}: no provider_data_policy row allowing PUBLIC — the lane is unusable rather than safe`);
    }
    for (const label of NON_PUBLIC_LABELS) {
      const row = mine.find((p) => p.label === label);
      if (!row) {
        violations.push(
          `${providerId}: no explicit provider_data_policy row for ${label}. Default-deny already refuses it, but "denied" and "nobody thought about it" must not look the same to the next person who adds a label.`,
        );
      } else if (row.allowed) {
        violations.push(
          `${providerId}: provider_data_policy ALLOWS ${label} on a lane whose terms permit training. LP names and deal terms would reach a model that may learn from them.`,
        );
      }
    }
    for (const model of models.filter((m) => m.providerId === providerId)) {
      if (model.maxDataClass !== "PUBLIC") {
        violations.push(
          `${providerId}/${model.model}: max_data_class is ${model.maxDataClass}, not PUBLIC. The catalogue and the egress policy must not disagree about what a training-permitting lane may see.`,
        );
      }
    }
  }

  // The router half: the data class stops content CLASSES; this stops a call the caller marked
  // confidential even where the label alone would have allowed it.
  if (!/budgetContext\?\.confidential === true/.test(routerSource)) {
    violations.push(
      "runAi: no filter on `budgetContext.confidential`. The data class alone cannot express \"this call carries LP names\", because a PUBLIC-labelled summary of a deal still contains the terms.",
    );
  }
  if (!/training_permitted/.test(routerSource)) {
    violations.push("runAi: the confidential filter does not consult `training_permitted`, so it cannot be excluding the free lanes.");
  }
  if (!/confidential_call_has_no_lane_that_does_not_train/.test(routerSource)) {
    violations.push(
      "runAi: a confidential call with no safe lane must BLOCK with a named reason. Falling through silently would send it somewhere anyway.",
    );
  }
  // Order matters: the confidential filter has to run before the egress check, or a lane could be
  // selected and then merely re-filtered.
  const confAt = routerSource.indexOf("budgetContext?.confidential === true");
  const egressAt = routerSource.indexOf("dataPolicyAllows(env, provider.id, input.sensitivity)");
  if (confAt >= 0 && egressAt >= 0 && confAt > egressAt) {
    violations.push("runAi: the confidential filter runs AFTER the egress check. It must narrow the candidate set, not review it.");
  }

  return { violations, examined };
}

function readMigrations() {
  const dir = path.join(ROOT, "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => stripCommentsFor(path.join(dir, f), readFileSync(path.join(dir, f), "utf8")))
    .join("\n");
}

function selfTest() {
  const goodMigration = `
    INSERT OR IGNORE INTO provider_registry (id, provider_key, display_name, enabled, kill_switched, capabilities_json, cost_metadata_json, base_url, training_permitted, firm_scope)
    VALUES ('prov_free', 'free', 'Free', 1, 0, '["text-completion"]', '{}', 'https://x', 1, 'west-peek');
    INSERT OR IGNORE INTO provider_data_policy (id, provider_id, privacy_label, allowed) VALUES
      ('a','prov_free','PUBLIC',1),('b','prov_free','INTERNAL',0),('c','prov_free','RESTRICTED',0),
      ('d','prov_free','LP_PRIVATE',0),('e','prov_free','CONFIDENTIAL',0),('f','prov_free','MNPI_SENSITIVE',0),
      ('g','prov_free','BANKING_RESTRICTED',0);
    INSERT OR IGNORE INTO provider_model (id, provider_id, model, display_name, capabilities_json, context_window, max_output_tokens, supports_tools, supports_reasoning, max_data_class, pricing_state, pricing_source_note, pricing_sourced_at, status, registered_by, firm_scope)
    VALUES ('pm_free','prov_free','m','M','["text-completion"]',1000,100,0,1,'PUBLIC','SOURCED','n','2026-09-17','ACTIVE','system','west-peek');
  `;
  const goodRouter = `
    if (input.budgetContext?.confidential === true) {
      candidates = candidates.filter((p) => Number(p.training_permitted ?? 0) !== 1);
      if (candidates.length === 0) return blocked("EGRESS_BLOCKED", "confidential_call_has_no_lane_that_does_not_train:x");
    }
    if (await dataPolicyAllows(env, provider.id, input.sensitivity)) egressAllowed.push(provider);
  `;

  const cases = [
    ["clean", { migrationSql: goodMigration, routerSource: goodRouter }, 0],
    [
      "a free lane allowed INTERNAL",
      { migrationSql: goodMigration.replace("'b','prov_free','INTERNAL',0", "'b','prov_free','INTERNAL',1"), routerSource: goodRouter },
      1,
    ],
    [
      "a free lane's model claims INTERNAL",
      { migrationSql: goodMigration.replace("0,1,'PUBLIC','SOURCED'", "0,1,'INTERNAL','SOURCED'"), routerSource: goodRouter },
      1,
    ],
    [
      "a label nobody wrote a row for",
      { migrationSql: goodMigration.replace("('e','prov_free','CONFIDENTIAL',0),", ""), routerSource: goodRouter },
      1,
    ],
    [
      "the router's confidential condition was weakened to a constant",
      { migrationSql: goodMigration, routerSource: goodRouter.replace("input.budgetContext?.confidential === true", "false") },
      1,
    ],
    [
      "the router lost the confidential block entirely",
      { migrationSql: goodMigration, routerSource: `if (await dataPolicyAllows(env, provider.id, input.sensitivity)) egressAllowed.push(provider);` },
      3,
    ],
    [
      "the confidential filter runs after the egress check",
      {
        migrationSql: goodMigration,
        routerSource:
          `if (await dataPolicyAllows(env, provider.id, input.sensitivity)) egressAllowed.push(provider);\n` +
          `if (input.budgetContext?.confidential === true) { p.training_permitted; blocked("confidential_call_has_no_lane_that_does_not_train:x"); }`,
      },
      1,
    ],
  ];

  const failures = [];
  for (const [name, input, expected] of cases) {
    const { violations } = check(input);
    if (violations.length !== expected) {
      failures.push(`self-test "${name}": expected ${expected} violation(s), got ${violations.length} — ${violations.join(" | ")}`);
    }
  }
  // Zero routes must fail, not pass.
  const none = check({ migrationSql: "SELECT 1;", routerSource: goodRouter });
  if (none.examined.length !== 0) failures.push("self-test: a migration set with no free lane should examine zero routes");

  if (failures.length > 0) {
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(`\nSELF-TEST FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log(`✓ self-test: ${cases.length} fixtures, 6 planted defects caught, the clean one left alone`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const migrationSql = readMigrations();
  const routerSource = stripCommentsFor(path.join(ROOT, "src", "worker", "ai", "runAi.ts"), readFileSync(path.join(ROOT, "src", "worker", "ai", "runAi.ts"), "utf8"));
  const { violations, examined } = check({ migrationSql, routerSource });

  if (examined.length === 0) {
    console.error("✗ free-lanes examined ZERO training-permitting routes.");
    console.error("  Either the free lanes were removed, or the column they are marked with was renamed.");
    console.error("  A guard that cannot reach what it governs must fail, not print a tick.");
    process.exit(1);
  }
  if (violations.length > 0) {
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(`\n✗ ${violations.length} violation(s) across ${examined.length} training-permitting route(s).`);
    process.exit(1);
  }
  console.log(
    `✓ ${examined.length} training-permitting route(s) (${examined.join(", ")}) may receive PUBLIC content only, ` +
      `their models agree, and runAi refuses them for any call marked confidential before a request is formed`,
  );
}

main();
