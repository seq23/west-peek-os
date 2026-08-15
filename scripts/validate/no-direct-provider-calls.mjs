#!/usr/bin/env node
/**
 * no-direct-provider-calls.mjs — static AI-boundary scan (P4, `npm run validate:ai-boundary`).
 *
 * Proves, by construction, that the governed boundary in src/worker/ai/runAi.ts is
 * the ONLY path to a model provider: outside src/worker/ai/providers/, no source
 * file under src/ may contain
 *   (a) provider SDK imports (openai, @anthropic-ai/sdk, @google/generative-ai, …),
 *   (b) model API hostnames (api.openai.com, api.anthropic.com,
 *       generativelanguage.googleapis.com, api.perplexity.ai, openrouter.ai), or
 *   (c) bearer-token model calls (fetch + Bearer authorization in the same file).
 *
 * Scope note: the scan covers src/** (worker/client/shared — executable code).
 * migrations/ and scripts/seed/ legitimately carry provider hostnames as
 * CONFIG DATA (seeded provider_registry rows, D9: providers are configuration);
 * they can perform no calls.
 *
 * The scan FAILS LOUDLY (exit 1, named violations). `--self-test` feeds synthetic
 * violating sources through the same check function and asserts they are caught.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC_DIR = path.join(ROOT, "src");
const PROVIDERS_PREFIX = "src/worker/ai/providers/";

/**
 * Provider SDK import. A PACKAGE import whose specifier names a vendor is a breach; an import
 * of one of OUR OWN adapter modules under `ai/providers/` is the sanctioned pattern and is not
 * (P16: `ai/routing.ts` imports the OpenRouter and Fireworks adapter factories by design —
 * that is precisely how the boundary is supposed to be crossed). Relative specifiers pointing
 * into `providers/` are therefore excluded before the vendor-name test.
 */
const OWN_ADAPTER_IMPORT = /(?:from|require\()\s*["']\.{1,2}\/(?:[^"']*\/)?providers\/[^"']*["']/;
const SDK_IMPORT = /(?:from|require\()\s*["'][^"']*(openai|anthropic|generative-ai|perplexity|openrouter)[^"']*["']/i;
const MODEL_HOSTNAMES = /(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.perplexity\.ai|openrouter\.ai)/;
const BEARER = /bearer/i;

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
 * Run all checks over a map of { relativePath: source }. Returns violation strings.
 * Pure — the same function scans the real tree and the self-test fixtures.
 */
export function checkSources(files) {
  const violations = [];

  for (const [rel, source] of Object.entries(files)) {
    if (rel.startsWith(PROVIDERS_PREFIX)) continue; // adapters are the allowed exception
    // Strip imports of our own adapter modules before testing for vendor SDK imports, so
    // `import { createOpenRouterAdapter } from "./providers/openRouter"` is not mistaken for
    // `import OpenAI from "openai"`. Everything else in the file is still scanned.
    const withoutOwnAdapters = source.replace(new RegExp(OWN_ADAPTER_IMPORT.source, "g"), "");
    if (SDK_IMPORT.test(withoutOwnAdapters)) {
      violations.push(`${rel}: provider SDK import outside src/worker/ai/providers/ (run_ai boundary breach)`);
    }
    if (MODEL_HOSTNAMES.test(source)) {
      violations.push(`${rel}: model API hostname outside src/worker/ai/providers/ (run_ai boundary breach)`);
    }
    if (/\bfetch\s*\(/.test(source) && BEARER.test(source)) {
      violations.push(`${rel}: fetch + Bearer authorization outside src/worker/ai/providers/ (bearer-token model call)`);
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
    "src/worker/services/aiRuns.ts": 'import { runAi } from "../ai/runAi";\nawait runAi(env, input);',
    "src/worker/ai/providers/httpExternal.ts":
      'await fetch(`${baseUrl}/complete`, { headers: { authorization: `Bearer ${apiKey}` } });\n// api.openai.com is fine HERE',
    // P16: importing our OWN adapter factory is the sanctioned way to reach a vendor.
    "src/worker/ai/routing.ts": 'import { createOpenRouterAdapter } from "./providers/openRouter";\nconst a = createOpenRouterAdapter(opts);',
  };
  const failures = [];
  if (checkSources(clean).length !== 0) failures.push("clean fixture was flagged (providers dir must be the allowed exception)");

  const cases = {
    "provider SDK import in a service": {
      ...clean,
      "src/worker/services/sneaky.ts": 'import OpenAI from "openai";\nconst c = new OpenAI();',
    },
    "scoped provider SDK import": {
      ...clean,
      "src/worker/services/sneaky.ts": 'import { Anthropic } from "@anthropic-ai/sdk";',
    },
    "model hostname literal": {
      ...clean,
      "src/worker/ai/sneaky.ts": 'const url = "https://api.openai.com/v1/chat/completions";',
    },
    "bearer-token model call": {
      ...clean,
      "src/client/sneaky.tsx": 'await fetch(url, { headers: { authorization: "Bearer " + key } });',
    },
    // The P16 exemption must not become a hiding place: a real vendor SDK import in the same
    // file as a legitimate adapter import is still a breach.
    "real SDK import alongside a legitimate adapter import": {
      ...clean,
      "src/worker/ai/routing.ts":
        'import { createOpenRouterAdapter } from "./providers/openRouter";\nimport OpenAI from "openai";',
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
  console.log(
    `SELF-TEST PASSED: clean fixture passes (providers dir is the only exception); all ${caseCount} violating fixtures are caught.`,
  );
  process.exit(0);
}

const violations = checkSources(scanRealTree());
if (violations.length > 0) {
  console.error("AI BOUNDARY SCAN FAILED — direct-provider-call violations:");
  for (const v of violations) console.error(`  ✗ ${v}`);
  process.exit(1);
}
console.log("AI BOUNDARY SCAN PASSED: no provider SDK imports, model API hostnames, or bearer-token model calls outside src/worker/ai/providers/.");
