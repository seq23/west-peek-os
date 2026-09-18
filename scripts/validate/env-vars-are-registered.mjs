#!/usr/bin/env node
/**
 * env-vars-are-registered.mjs — `npm run validate:env-vars`.
 *
 * THE FAILURE THIS CATCHES IS INVISIBLE TO EVERY OTHER CHECK.
 *
 * Most bindings are read as `env.SOMETHING`, so a grep finds them and a missing one shows up as a
 * type error. Provider credentials are not read that way: `credentialValueFor(env, providerKey)`
 * looks the name up at runtime out of `PROVIDER_CREDENTIAL_NAME`, so `WP_ANTHROPIC_API_KEY` appears
 * nowhere in the codebase as a property access. Add a vendor to that map, forget to declare it on
 * `Env`, and everything compiles, every test passes, and the lane is enabled and permanently
 * unconfigured — the exact "enabled but broken" shape the owner asked to be impossible.
 *
 * So three sources must agree, and this scan fails in every direction they can disagree:
 *
 *   · src/worker/env.ts               — what the Worker declares it can be given
 *   · deployment/env-var-registry.json — what a human wrote down and can act on
 *   · providerCredentials.ts           — the names looked up at runtime, invisible to a grep
 *
 * HARD-FAILS ON ZERO NAMES EXAMINED, because a scan that parses nothing and prints a tick is how
 * a guard dies quietly when the thing it watches is renamed.
 *
 * `--self-test` runs the same pure function over synthetic sources with each disagreement planted.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stripCommentsFor } from "./lib/strip-comments.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** SCREAMING_SNAKE members of the Env interface. */
export function declaredInEnv(source) {
  const start = source.indexOf("export interface Env {");
  if (start < 0) return [];
  let i = source.indexOf("{", start) + 1;
  let depth = 1;
  while (i < source.length && depth > 0) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  }
  const body = source.slice(start, i);
  return [...new Set([...body.matchAll(/^\s*([A-Z][A-Z0-9_]{1,})\??\s*:/gm)].map((m) => m[1]))];
}

/**
 * Credential and binding names the runtime looks up dynamically.
 *
 * COMMENTS ARE STRIPPED FIRST. This file explains at length why `ANTHROPIC_API_KEY` must not be
 * "tidied" back to its reserved spelling, and a naive scan read the shouted word TIDY out of that
 * prose and reported it as an undeclared credential. A validator that invents a defect out of a
 * comment teaches people to ignore it.
 */
export function namesFromCredentialMap(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const out = new Set();
  for (const m of code.matchAll(/:\s*["']([A-Z][A-Z0-9_]{1,})["']/g)) out.add(m[1]);
  for (const m of code.matchAll(/=\s*["']([A-Z][A-Z0-9_]{1,})["']/g)) out.add(m[1]);
  return [...out];
}

/** `env.FOO` reads anywhere under src/. */
export function readsInSource(files) {
  const out = new Set();
  for (const source of Object.values(files)) {
    for (const m of source.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) out.add(m[1]);
  }
  return [...out];
}

/** Pure. Returns violations plus the number of names it actually looked at. */
export function check({ envSource, registry, credentialSource, srcFiles }) {
  const violations = [];
  const declared = new Set(declaredInEnv(envSource));
  const registered = new Set(Object.keys(registry.vars ?? {}));
  const dynamic = new Set(namesFromCredentialMap(credentialSource));
  const read = new Set(readsInSource(srcFiles));
  const examined = new Set([...declared, ...registered, ...dynamic, ...read]);

  for (const name of declared) {
    if (!registered.has(name)) {
      violations.push(`${name}: declared on Env but not in deployment/env-var-registry.json — nobody knows what it is for or whether it is set`);
    }
  }
  for (const name of registered) {
    if (!declared.has(name)) {
      violations.push(`${name}: registered but not declared on Env — the registry describes something the Worker cannot read`);
    }
  }
  for (const name of dynamic) {
    if (!declared.has(name)) {
      violations.push(
        `${name}: looked up at runtime by providerCredentials.ts but not declared on Env. This is the invisible case: it compiles, it tests green, and the lane is enabled and permanently unconfigured.`,
      );
    }
  }
  for (const name of read) {
    if (!declared.has(name)) {
      violations.push(`${name}: read as env.${name} in source but not declared on Env`);
    }
  }
  return { violations, examined: [...examined] };
}

function listSourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function selfTest() {
  const envSource = `export interface Env {
    WP_OS_DB: D1Database;
    OPENROUTER_API_KEY?: string;
    WP_ANTHROPIC_API_KEY?: string;
  }`;
  const registry = { vars: { WP_OS_DB: {}, OPENROUTER_API_KEY: {}, WP_ANTHROPIC_API_KEY: {} } };
  const credentialSource = `const M = { openrouter: "OPENROUTER_API_KEY", anthropic: "WP_ANTHROPIC_API_KEY" };`;
  const srcFiles = { "a.ts": `env.WP_OS_DB.prepare("x")` };

  const cases = [
    ["clean", { envSource, registry, credentialSource, srcFiles }, 0],
    // THE REAL ONE: a vendor added to the map and never declared. Invisible to types and to tests.
    [
      "a credential the map looks up but Env never declares",
      { envSource, registry, credentialSource: credentialSource.replace("};", `, perplexity: "PERPLEXITY_API_KEY" };`), srcFiles },
      1,
    ],
    [
      "declared but unregistered",
      { envSource: envSource.replace("}", "  RESEND_API_KEY?: string;\n}"), registry, credentialSource, srcFiles },
      1,
    ],
    [
      "registered but undeclared",
      { envSource, registry: { vars: { ...registry.vars, GHOST_KEY: {} } }, credentialSource, srcFiles },
      1,
    ],
    ["read in source but undeclared", { envSource, registry, credentialSource, srcFiles: { "a.ts": `env.MYSTERY_TOKEN` } }, 1],
  ];

  const failures = [];
  for (const [name, input, expected] of cases) {
    const { violations } = check(input);
    if (violations.length !== expected) failures.push(`"${name}": expected ${expected}, got ${violations.length} — ${violations.join(" | ")}`);
  }
  const none = check({ envSource: "", registry: { vars: {} }, credentialSource: "", srcFiles: {} });
  if (none.examined.length !== 0) failures.push("empty input should examine zero names");

  if (failures.length > 0) {
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(`\nSELF-TEST FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log(`✓ self-test: ${cases.length} fixtures, 4 planted disagreements caught, the clean one left alone`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const envSource = stripCommentsFor(path.join(ROOT, "src", "worker", "env.ts"), readFileSync(path.join(ROOT, "src", "worker", "env.ts"), "utf8"));
  const registry = JSON.parse(stripCommentsFor(path.join(ROOT, "deployment", "env-var-registry.json"), readFileSync(path.join(ROOT, "deployment", "env-var-registry.json"), "utf8")));
  const credentialSource = stripCommentsFor(path.join(ROOT, "src", "shared", "ai", "providerCredentials.ts"), readFileSync(path.join(ROOT, "src", "shared", "ai", "providerCredentials.ts"), "utf8"));
  const srcFiles = {};
  for (const full of listSourceFiles(path.join(ROOT, "src"))) {
    srcFiles[path.relative(ROOT, full)] = stripCommentsFor(full, readFileSync(full, "utf8"));
  }

  const { violations, examined } = check({ envSource, registry, credentialSource, srcFiles });
  if (examined.length === 0) {
    console.error("✗ env-vars-are-registered examined ZERO names. The Env interface or the registry could not be parsed.");
    process.exit(1);
  }
  if (violations.length > 0) {
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(`\n✗ ${violations.length} disagreement(s) across ${examined.length} names.`);
    process.exit(1);
  }
  console.log(`✓ ${examined.length} environment names: Env, the registry and the runtime credential map all agree`);
}

main();
