#!/usr/bin/env node
/**
 * no-cross-repo-coupling.mjs — static Network OS boundary scan (P9,
 * `npm run validate:network-boundary`).
 *
 * Proves, by construction, that West Peek OS never couples to another system's
 * storage. Outside src/worker/services/networkAdapter.ts (the ONE declared
 * adapter), no source file under src/ may contain
 *   (a) a filesystem/SQLite path into a sibling repo or DB file
 *       (network-os, agency-event-os, secondaries, *.sqlite/*.db),
 *   (b) a D1/KV/R2 binding name that is not a West Peek OS binding (WP_OS_*),
 *   (c) a Network OS hostname or API base.
 * And even INSIDE the adapter, direct storage access is forbidden: the adapter may
 * only call the injected NetworkOsClient.
 *
 * The scan FAILS LOUDLY (exit 1, named violations). `--self-test` feeds synthetic
 * violating sources through the same check function and asserts they are caught.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC_DIR = path.join(ROOT, "src");
const ADAPTER = "src/worker/services/networkAdapter.ts";

const SIBLING_REPO_PATH = /(west-peek-network-os|agency-event-os|seq23\/secondaries|\.\.\/\.\.\/\.\.\/[a-z-]*network)/i;
const FOREIGN_DB_FILE = /["'`][^"'`]*\.(sqlite3?|db)["'`]/i;
const FOREIGN_BINDING = /env\.(?!WP_OS_)(?:[A-Z][A-Z0-9_]{2,})\b/;
/**
 * Bindings that are NOT West Peek storage but are legitimately part of the declared
 * environment contract (src/worker/env.ts, docs/ENVIRONMENT_CONTRACT.md):
 * - ASSETS: the static SPA fetcher (P1).
 * - Provider API-key SECRETS (P16/P23, including the specialist lane): names only, values live in
 *   the encrypted vault. These are
 *   credentials for the governed AI boundary, not another system's storage, which is what this
 *   scan exists to prevent. Any binding outside this list is still a violation.
 * - RESEND_API_KEY (P33): the outbound email transport credential. Same category as the provider
 *   keys — a credential for an effect this system performs itself, NOT a handle on another
 *   repository's database. The two switches that gate its use (WP_OS_EMAIL_SEND, WP_OS_EMAIL_FROM)
 *   already carry the WP_OS_ prefix and need no exemption.
 * - RUNWARE_API_KEY: the image-generation credential. Same category as the provider and transport
 *   keys — a credential for an effect this system performs itself, not a handle on another
 *   repository's storage, which is the thing this scan exists to prevent. Vendor-named, so it
 *   cannot carry a WP_OS_ prefix, and reachable only from effects/runwareClient.ts, which is on the
 *   egress allowlist with its own written reason.
 * - GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET (P51): the firm's own OAuth client, used
 *   so each partner can grant this system read access to their own calendar. Same category as the
 *   provider keys — a credential for something this system does itself, not a handle on another
 *   repository's storage. Platform-named, so neither can carry a WP_OS_ prefix, and both are
 *   reachable only from effects/googleClient.ts.
 * - EMAIL (P33): Cloudflare's Email Sending binding, the second transport for that same effect.
 *   Platform-named, so it cannot carry a WP_OS_ prefix. It is a capability this system was granted
 *   on its own account — not a handle on another repository's storage — which is the thing this
 *   scan exists to prevent. It is declared in src/worker/env.ts and reachable only from
 *   effects/cloudflareEmailClient.ts, and being a binding it adds no egress surface at all.
 */
const DECLARED_NON_STORAGE_BINDINGS = /env\.(ASSETS|OPENROUTER_API_KEY|FIREWORKS_API_KEY|AI_PROVIDER_API_KEY|HARVEY_API_KEY|NORM_API_KEY|RESEND_API_KEY|RUNWARE_API_KEY|EMAIL|GOOGLE_OAUTH_CLIENT_ID|GOOGLE_OAUTH_CLIENT_SECRET)\b/;
const NETWORK_OS_HOST = /(network-os[a-z0-9.-]*\.(?:com|dev|net|io|workers\.dev)|api\.westpeeknetwork)/i;

function listSourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs|jsx)$/.test(entry.name)) out.push(full);
    }
  };
  walk(SRC_DIR);
  return out;
}

/**
 * Strip `//` line comments and block comments. Comments cannot couple anything —
 * naming a partner repository as PROVENANCE (e.g. "ported from seq23/secondaries")
 * is exactly what the plan asks for; only executable references are violations.
 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
}

/**
 * Run all checks over a map of { relativePath: source }. Returns violation strings.
 * Pure — the same function scans the real tree and the self-test fixtures.
 */
export function checkSources(files) {
  const violations = [];
  for (const [rel, rawSource] of Object.entries(files)) {
    const source = stripComments(rawSource);
    if (SIBLING_REPO_PATH.test(source)) {
      violations.push(`${rel}: reference to a partner repository path (cross-repo coupling; D5 forbids direct access)`);
    }
    if (FOREIGN_DB_FILE.test(source)) {
      violations.push(`${rel}: literal database file path (no system may open another system's storage)`);
    }
    if (NETWORK_OS_HOST.test(source) && rel !== ADAPTER) {
      violations.push(`${rel}: Network OS hostname outside the declared adapter`);
    }
    // Remove the declared non-storage bindings before looking for a foreign one, so a
    // legitimate credential reference cannot mask an illegitimate storage binding later in
    // the same file.
    const withoutDeclared = source.replace(new RegExp(DECLARED_NON_STORAGE_BINDINGS.source, "g"), " ");
    const foreignBinding = withoutDeclared.match(FOREIGN_BINDING);
    if (foreignBinding) {
      violations.push(`${rel}: non-West-Peek binding ${foreignBinding[0]} (only WP_OS_* bindings exist)`);
    }
    // The adapter itself must reach Network OS through the injected client only.
    if (rel === ADAPTER && /\bfetch\s*\(/.test(source)) {
      violations.push(`${rel}: direct fetch in the adapter (crossings must go through the injected NetworkOsClient)`);
    }
  }
  return violations;
}

function scanRealTree() {
  const files = {};
  for (const full of listSourceFiles()) {
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    files[rel] = readFileSync(full, "utf8");
  }
  return files;
}

function selfTest() {
  const clean = {
    "src/worker/services/networkAdapter.ts": "const page = await client.pull(resource, cursor);\nawait env.WP_OS_DB.prepare('SELECT 1').first();",
    "src/worker/services/portfolio.ts": "await env.WP_OS_DB.prepare('SELECT 1').first();",
    // P16: a declared provider credential is not another system's storage.
    "src/worker/ai/routing.ts": "const key = env.OPENROUTER_API_KEY;",
  };
  const failures = [];
  if (checkSources(clean).length !== 0) failures.push("clean fixture was flagged");

  const cases = {
    "partner repo path": { ...clean, "src/worker/services/sneaky.ts": 'const db = open("../../west-peek-network-os/data/app.db");' },
    "database file literal": { ...clean, "src/worker/services/sneaky.ts": 'const p = "/var/data/contacts.sqlite";' },
    "foreign binding": { ...clean, "src/worker/services/sneaky.ts": "await env.NETWORK_OS_DB.prepare('SELECT 1').all();" },
    "network hostname outside the adapter": { ...clean, "src/worker/services/sneaky.ts": 'await get("https://network-os.example.com/api/contacts");' },
    "direct fetch inside the adapter": {
      ...clean,
      "src/worker/services/networkAdapter.ts": 'await fetch("https://example.com/contacts");',
    },
    // The P16 credential exemption must not become a hiding place for a storage binding.
    "foreign storage binding alongside a declared credential binding": {
      ...clean,
      "src/worker/ai/routing.ts": "const k = env.OPENROUTER_API_KEY;\nawait env.PARTNER_DB.prepare('SELECT 1').all();",
    },
  };
  for (const [name, files] of Object.entries(cases)) {
    if (checkSources(files).length === 0) failures.push(`violating fixture NOT caught: ${name}`);
  }
  return { failures, caseCount: Object.keys(cases).length };
}

if (process.argv.includes("--self-test")) {
  const { failures, caseCount } = selfTest();
  if (failures.length > 0) {
    console.error("SELF-TEST FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`SELF-TEST PASSED: clean fixture passes; all ${caseCount} violating fixtures are caught.`);
  process.exit(0);
}

const violations = checkSources(scanRealTree());
if (violations.length > 0) {
  console.error("NETWORK BOUNDARY SCAN FAILED — cross-repo coupling violations:");
  for (const v of violations) console.error(`  ✗ ${v}`);
  process.exit(1);
}
console.log("NETWORK BOUNDARY SCAN PASSED: no partner-repo paths, foreign DB files, foreign bindings, or Network OS hosts outside the declared adapter.");
