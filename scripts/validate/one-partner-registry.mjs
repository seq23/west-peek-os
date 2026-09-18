#!/usr/bin/env node
/**
 * one-partner-registry.mjs — `npm run validate:partners`.
 *
 * ONE ASSERTION: THE FIRM ANSWERS "IS THIS ONE OF THE TWO PARTNERS?" IN EXACTLY ONE PLACE.
 *
 * Until 17 Sep 2026 it answered in four, none of which knew about the others: the `firm_user` rows
 * in migration 0001, `ASSIGNING_PARTNERS` (addresses, no ids), `MANAGING_PARTNERS` (names, no
 * addresses), and `SCOOTER_EMAIL` / `SCOOTER_FIRM_USER_ID` typed again in `productions.ts`. The
 * cost was not drift — they happened to agree. It was that a NEW feature needing to go from an
 * authenticated address to the person it belongs to could ask none of them, and had to type a
 * fifth copy. Preview mode was that feature.
 *
 * WHAT IS CHECKED
 *
 *   1 · NO PARTNER ADDRESS OR `firm_user` ID IS TYPED IN `src/` OUTSIDE THE REGISTRY. Not in a
 *       service, not in a component, not in a shared module. The registry is where those strings
 *       live; everywhere else asks for them.
 *
 *   2 · THE OLD LISTS ARE DERIVED, NOT RE-TYPED. `ASSIGNING_PARTNERS` and `MANAGING_PARTNERS` still
 *       exist because callers read them, and both must be built from the registry rather than
 *       written out again — a view that is retyped is a fifth copy with a comment on it.
 *
 *   3 · THE REGISTRY IS ASKED. `isPartnerEmail` / `isPartnerFirmUserId` / `partnerBy…` have callers.
 *       A registry nothing reads is this repo's "exists but nothing invokes it" defect, and would
 *       mean the four copies are still the real answer.
 *
 * WHAT IS DELIBERATELY NOT CHECKED: `migrations/` and `tests/`. A migration is a historical record
 * of what was written to the database and must keep its literals; a test asserting the address is
 * right is exactly the test that should name it.
 *
 * HARD-FAILS ON ZERO: zero sources scanned or zero registry callers exit 1. A scan that examined
 * nothing is not a passing scan.
 *
 * `--self-test` runs the defect this exists to catch — a service typing a partner address — through
 * the same function, along with a retyped list and a registry nobody asks.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = path.join(ROOT, "src");
const REGISTRY = path.join("src", "shared", "registry", "partners.ts");
const ASSIGNING = path.join("src", "shared", "intake", "partnerAuthority.ts");
const MANAGING = path.join("src", "shared", "registry", "managingPartners.ts");

/** The literals only the registry may contain. */
const PARTNER_LITERALS = [
  /"sequoia@westpeek\.ventures"/,
  /"scooter@westpeek\.ventures"/,
  /"fu_sequoia_taylor"/,
  /"fu_scooter_taylor"/,
];

/**
 * Files allowed to name a partner beyond the registry, and why.
 *
 * SHORT ON PURPOSE, and every entry is an address the system must produce rather than ask for:
 *   · scripts/seed and deployment carry example commands, not behaviour — they are outside src/.
 *   · Nothing in src/ is on this list. If a file needs the answer, it asks.
 */
const MAY_NAME_A_PARTNER = new Set([REGISTRY]);

export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1);
}

function readTree(dir, extensions) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((e) => entry.name.endsWith(e))) {
        out[path.relative(ROOT, full)] = readFileSync(full, "utf8");
      }
    }
  };
  walk(dir);
  return out;
}

export function checkSources(sources) {
  const violations = [];
  let registryCallers = 0;

  for (const [file, raw] of Object.entries(sources)) {
    const code = stripComments(raw);
    if (/\b(isPartnerEmail|isPartnerFirmUserId|partnerByEmail|partnerByFirmUserId|partnerByName|partnerFor|PARTNER_EMAILS|PARTNER_FIRM_USER_IDS|PARTNERS|PREVIEW_PARTNER|PRODUCTIONS_PARTNER)\b/.test(code) && file !== REGISTRY) {
      registryCallers += 1;
    }
    if (MAY_NAME_A_PARTNER.has(file)) continue;
    for (const literal of PARTNER_LITERALS) {
      if (literal.test(code)) {
        violations.push(
          `${file} types a partner's address or firm_user id (${literal.source}). Ask ${REGISTRY} instead — ` +
            "one place answers who the partners are, so a feature that needs the join does not write a fifth copy.",
        );
      }
    }
  }

  // ── 2 · the old lists are views, not copies ────────────────────────────────────────────────
  const assigning = sources[ASSIGNING];
  if (assigning && !/ASSIGNING_PARTNERS[^=]*=\s*PARTNER_EMAILS/.test(stripComments(assigning))) {
    violations.push(
      `${ASSIGNING}: ASSIGNING_PARTNERS is not derived from PARTNER_EMAILS. It is the whole mail security ` +
        "boundary; a retyped copy of it can disagree with the identity the rest of the system uses.",
    );
  }
  const managing = sources[MANAGING];
  if (managing && !/MANAGING_PARTNERS[\s\S]{0,80}PARTNERS/.test(stripComments(managing))) {
    violations.push(`${MANAGING}: MANAGING_PARTNERS is not derived from the registry.`);
  }

  return { violations, registryCallers };
}

if (process.argv.includes("--self-test")) {
  const clean = {
    [REGISTRY]: 'export const PARTNERS = [{ email: "sequoia@westpeek.ventures", firmUserId: "fu_sequoia_taylor" }, { email: "scooter@westpeek.ventures", firmUserId: "fu_scooter_taylor" }];',
    [ASSIGNING]: "export const ASSIGNING_PARTNERS = PARTNER_EMAILS;",
    [MANAGING]: "export const MANAGING_PARTNERS = [...PARTNERS].map((p) => p);",
    [path.join("src", "worker", "services", "productions.ts")]:
      "export const SCOOTER_EMAIL = PRODUCTIONS_PARTNER.email;",
  };

  const cases = {
    "a service typing a partner's address": {
      ...clean,
      [path.join("src", "worker", "services", "newFeature.ts")]:
        'const to = "scooter@westpeek.ventures";',
    },
    "a component typing a firm_user id": {
      ...clean,
      [path.join("src", "client", "pages", "Thing.tsx")]: 'if (id === "fu_sequoia_taylor") return null;',
    },
    "ASSIGNING_PARTNERS retyped instead of derived": {
      ...clean,
      [ASSIGNING]: 'export const ASSIGNING_PARTNERS = ["sequoia@westpeek.ventures", "scooter@westpeek.ventures"];',
    },
    "MANAGING_PARTNERS retyped instead of derived": {
      ...clean,
      [MANAGING]: 'export const MANAGING_PARTNERS = [{ fullName: "Scooter Taylor" }];',
    },
  };

  const failures = [];
  const cleanResult = checkSources(clean);
  if (cleanResult.violations.length > 0) failures.push(`the clean fixture was rejected: ${cleanResult.violations.join("; ")}`);
  if (cleanResult.registryCallers === 0) failures.push("the clean fixture found no registry callers");
  for (const [name, fixture] of Object.entries(cases)) {
    if (checkSources(fixture).violations.length === 0) failures.push(`NOT CAUGHT: ${name}`);
  }

  if (failures.length > 0) {
    console.error("SELF-TEST FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`SELF-TEST PASSED: clean fixture passes; all ${Object.keys(cases).length} violating fixtures are caught.`);
  process.exit(0);
}

const sources = readTree(SRC, [".ts", ".tsx"]);
if (Object.keys(sources).length === 0) {
  console.error(`PARTNER REGISTRY SCAN FAILED — examined 0 sources under ${path.relative(ROOT, SRC)}.`);
  process.exit(1);
}

const { violations, registryCallers } = checkSources(sources);

if (registryCallers === 0) {
  console.error("PARTNER REGISTRY SCAN FAILED — nothing asks the registry who the partners are.");
  console.error("A registry nothing reads means the old copies are still the real answer, which is this repo's");
  console.error('"exists but nothing invokes it" defect.');
  process.exit(1);
}
if (violations.length > 0) {
  console.error("PARTNER REGISTRY SCAN FAILED — the firm answers 'who are the partners' in more than one place:");
  for (const v of violations) console.error(`  ✗ ${v}`);
  process.exit(1);
}

console.log(
  `PARTNER REGISTRY SCAN PASSED: ${registryCallers} file(s) ask ${REGISTRY} across ${Object.keys(sources).length} sources; ` +
    "no partner address or firm_user id is typed anywhere else in src/, and both published views are derived from it.",
);
