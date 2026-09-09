#!/usr/bin/env node
/**
 * employee-sender-domain.mjs — `npm run validate:employee-sender`.
 *
 * ONE ASSERTION: A WEST PEEK OS EMPLOYEE SENDS FROM <name>@joinwestpeek.com, AND FROM NOWHERE ELSE.
 *
 * Operator, 9 Sep 2026: "why dont any of the ai employees from os.joinwestpeek.com have emails from
 * @joinwestpeek.com". They did not because they had no sender identity at all, and when one was
 * wired to a notifier by hand it borrowed Boss OS's — a WEST PEEK employee signing three emails from
 * `preston@sequoiataylor.com`, the domain of a DIFFERENT BUSINESS. The same defect ran the other way
 * that morning: a Boss OS employee writing from `westpeek.ventures`. Both were caught by a human
 * reading a signature, which is not a control.
 *
 * WHAT IS CHECKED
 *   1 · NO BOSS OS ANYWHERE. `sequoiataylor.com` and `BOSS_OS_MAIL_KEY` appear in no source file.
 *       Two businesses, never blended — and a key from one Resend account cannot sign the other's
 *       domains anyway, so the failure would read as a DNS problem and cost an hour of hunting.
 *   2 · NO EMPLOYEE ON THE LP-FACING DOMAIN. No roster first name is ever concatenated onto
 *       `westpeek.ventures`. That domain is `sequoia@` and `scooter@` and is printed on page 15 of
 *       the deck; `preston@westpeek.ventures` reads to an outsider as a person at the fund.
 *   3 · THE ROSTER IS THE LIST. `employeeSenderAddress` refuses an unnamed sender and refuses a name
 *       that is not on `AI_EMPLOYEE_ROSTER` — a verified domain signs any local part, so a typo
 *       would send perfectly from an address belonging to nobody.
 *   4 · NOTHING BYPASSES IT. Every module that hands a `from` to a transport for an AI-requested
 *       message resolves it through `employeeSenderAddress`. A hardcoded employee address anywhere
 *       is a violation even if the address happens to be right today.
 *
 * HARD-FAILS ON ZERO. Zero files scanned, zero roster names known, or zero sender-resolving call
 * sites found all exit 1. A scan that examined nothing is not a passing scan.
 *
 * `--self-test` runs the real defect — an employee pointed at sequoiataylor.com, and one pointed at
 * westpeek.ventures — through the same functions and requires both to be caught.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = path.join(ROOT, "src");
const ROSTER_FILE = path.join(SRC, "shared", "registry", "aiEmployees.ts");
const MAIL_FILE = path.join("src", "shared", "registry", "employeeMail.ts");

/** Boss OS. A different business, a different Resend account, a different key. */
const FOREIGN = [/sequoiataylor\.com/i, /BOSS_OS_MAIL_KEY/];

/**
 * Files allowed to NAME the forbidden things, because naming them is their job.
 *
 * `employeeMail.ts` states which domains are refused and why; this scan states the same. Neither
 * SENDS from them, and the difference between naming a rule and breaking it is the difference this
 * allowlist encodes. Anything else mentioning Boss OS's domain is a violation.
 */
const MAY_NAME_THE_RULE = new Set([MAIL_FILE, path.join("scripts", "validate", "employee-sender-domain.mjs")]);

/**
 * Comments out, line count preserved.
 *
 * PROSE MUST NOT DECIDE THE OUTCOME, IN EITHER DIRECTION. The first run of this scan failed on its
 * own explanation — `employeeMail.ts` and `executor.ts` both NAME `preston@westpeek.ventures` and
 * `preston@sequoiataylor.com` as the things being refused, which is exactly what they should say and
 * exactly what a naive grep cannot tell from doing it. Stripping comments is what makes the
 * difference between describing a rule and breaking it legible to the scan, and it also stops a
 * violation being smuggled past by burying real code in a comment.
 */
export function stripComments(source) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
  return out;
}

/** Roster first names, read from the registry rather than retyped. There is no second list. */
export function rosterNames(rosterSource) {
  return [...rosterSource.matchAll(/^\s*E\(\s*"([A-Za-z]+)"/gm)].map((m) => m[1]);
}

export function checkSources(sources, names) {
  const violations = [];
  let senderCallSites = 0;

  const lower = names.map((n) => n.toLowerCase());
  // `preston@westpeek.ventures` written out, or built by concatenation onto that domain.
  const lpFacing = new RegExp(`(?:${lower.join("|")})\\s*@\\s*westpeek\\.ventures`, "i");
  const lpConcat = /\$\{[^}]*\}@westpeek\.ventures|@\$\{[^}]*LP_FACING/;
  // A roster address hardcoded instead of resolved. Right today, wrong the moment a name changes.
  const hardcoded = new RegExp(`["'\`](?:${lower.join("|")})@joinwestpeek\\.com`, "i");

  for (const [file, source] of Object.entries(sources)) {
    const raw = stripComments(source);
    if (!MAY_NAME_THE_RULE.has(file)) {
      for (const pattern of FOREIGN) {
        if (pattern.test(raw)) {
          violations.push(
            `${file}: references ${pattern.source.replace(/\\/g, "")} — Boss OS's domain or key. Two ` +
              `businesses, never blended: a West Peek employee must never sign from sequoiataylor.com.`,
          );
        }
      }
      if (hardcoded.test(raw)) {
        violations.push(
          `${file}: hardcodes an employee address instead of resolving it through employeeSenderAddress(). ` +
            `The roster is the list; a second copy of it drifts.`,
        );
      }
    }
    if (lpFacing.test(raw) || lpConcat.test(raw)) {
      violations.push(
        `${file}: puts an employee on westpeek.ventures, the LP-FACING identity. sequoia@ and scooter@ ` +
          `live there and it is printed on page 15 of the deck; preston@westpeek.ventures reads to an ` +
          `outsider as a person at the fund.`,
      );
    }
    if (/employeeSenderAddress\s*\(/.test(raw) && file !== MAIL_FILE) senderCallSites += 1;
  }

  // The module itself must refuse, not merely prefer.
  const mail = sources[MAIL_FILE] ? stripComments(sources[MAIL_FILE]) : undefined;
  if (!mail) {
    violations.push(`${MAIL_FILE} is missing — nothing defines where an employee's mail comes from.`);
  } else {
    if (!/EMPLOYEE_MAIL_DOMAIN\s*=\s*["']joinwestpeek\.com["']/.test(mail)) {
      violations.push(`${MAIL_FILE}: the employee domain is not joinwestpeek.com.`);
    }
    if (!/throw new EmployeeSenderError/.test(mail)) {
      violations.push(
        `${MAIL_FILE}: no refusal. An unnamed or off-roster sender must THROW, not fall back — a silent ` +
          `default is what let every employee send as a generic address for weeks unnoticed.`,
      );
    }
    if (!/AI_EMPLOYEE_ROSTER/.test(mail)) {
      violations.push(
        `${MAIL_FILE}: the addresses are not derived from AI_EMPLOYEE_ROSTER, so the roster is no longer ` +
          `the closed list this depends on.`,
      );
    }
  }

  return { violations, senderCallSites };
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────

function selfTest() {
  const failures = [];
  const names = ["Preston", "Wren", "Walker"];

  const cleanMail = [
    'import { AI_EMPLOYEE_ROSTER } from "./aiEmployees";',
    'export const EMPLOYEE_MAIL_DOMAIN = "joinwestpeek.com";',
    "export function employeeSenderAddress(name) {",
    '  if (!ok) throw new EmployeeSenderError("not on the roster");',
    "  return `${name.toLowerCase()}@${EMPLOYEE_MAIL_DOMAIN}`;",
    "}",
  ].join("\n");
  const clean = {
    [MAIL_FILE]: cleanMail,
    "src/worker/effects/executor.ts": "const from = employeeSenderAddress(employee.name);",
  };
  const cleanResult = checkSources(clean, names);
  if (cleanResult.violations.length !== 0) failures.push(`clean fixture was flagged: ${cleanResult.violations[0]}`);
  if (cleanResult.senderCallSites === 0) failures.push("clean fixture found no sender call site");

  const cases = {
    // THE ACTUAL DEFECT: a West Peek employee on Boss OS's domain.
    "an employee pointed at sequoiataylor.com": {
      ...clean,
      "src/worker/effects/notifier.ts": 'const from = "preston@sequoiataylor.com";',
    },
    "the Boss OS key reached into this repo": {
      ...clean,
      "src/worker/env.ts": "BOSS_OS_MAIL_KEY?: string;",
    },
    // The other direction, which is the morning's defect pointed back this way.
    "an employee on the LP-facing domain": {
      ...clean,
      "src/worker/effects/notifier.ts": 'const from = "preston@westpeek.ventures";',
    },
    "an employee address built onto the LP-facing domain": {
      ...clean,
      "src/worker/effects/notifier.ts": "const from = `${employee.name}@westpeek.ventures`;",
    },
    "an employee address hardcoded rather than resolved": {
      ...clean,
      "src/worker/effects/notifier.ts": 'const from = "wren@joinwestpeek.com";',
    },
    "the refusal removed, so an unknown name gets an address anyway": {
      ...clean,
      [MAIL_FILE]: cleanMail.replace('throw new EmployeeSenderError("not on the roster")', 'return "os@joinwestpeek.com"'),
    },
    "the addresses stop coming from the roster": {
      ...clean,
      [MAIL_FILE]: cleanMail.replace('import { AI_EMPLOYEE_ROSTER } from "./aiEmployees";', "const NAMES = [];"),
    },
    "the employee domain quietly moved": {
      ...clean,
      [MAIL_FILE]: cleanMail.replace('"joinwestpeek.com"', '"westpeek.ventures"'),
    },
  };
  for (const [name, files] of Object.entries(cases)) {
    if (checkSources(files, names).violations.length === 0) failures.push(`violating fixture NOT caught: ${name}`);
  }

  if (rosterNames('  E("Preston", "Finance", "Ops", [], "INTERNAL_ONLY",\n  E("Wren", "CoS", "MP", [], "INTERNAL_ONLY",').length !== 2) {
    failures.push("rosterNames failed to read the roster shape");
  }

  return failures;
}

// ── real tree ─────────────────────────────────────────────────────────────────────────────────

function readTree(dir, exts) {
  const out = {};
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (exts.some((e) => entry.name.endsWith(e))) out[path.relative(ROOT, full)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

if (process.argv.includes("--self-test")) {
  const failures = selfTest();
  if (failures.length > 0) {
    console.error("SELF-TEST FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("SELF-TEST PASSED: clean fixture passes; all 8 violating fixtures are caught, including the real sequoiataylor.com defect.");
  process.exit(0);
}

const sources = readTree(SRC, [".ts", ".tsx"]);
const names = rosterNames(readFileSync(ROSTER_FILE, "utf8"));

if (Object.keys(sources).length === 0) {
  console.error(`EMPLOYEE SENDER SCAN FAILED — examined 0 sources under ${path.relative(ROOT, SRC)}.`);
  process.exit(1);
}
if (names.length === 0) {
  console.error("EMPLOYEE SENDER SCAN FAILED — read 0 names from AI_EMPLOYEE_ROSTER.");
  console.error("Every check below is built from those names. Zero of them means this scan compares");
  console.error("nothing against nothing and would pass whatever the code said.");
  process.exit(1);
}

const { violations, senderCallSites } = checkSources(sources, names);

if (senderCallSites === 0) {
  console.error("EMPLOYEE SENDER SCAN FAILED — found 0 places that resolve an employee sender.");
  console.error("employeeSenderAddress() exists but nothing calls it, which is this repo's");
  console.error("'exists but nothing invokes it' defect: employees would still send as the firm.");
  process.exit(1);
}

if (violations.length > 0) {
  console.error("EMPLOYEE SENDER SCAN FAILED — an employee can sign from the wrong business:");
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error("\nA West Peek OS employee sends from <name>@joinwestpeek.com, resolved through");
  console.error("employeeSenderAddress() against the closed roster, signed with RESEND_API_KEY.");
  console.error("westpeek.ventures is the LP-facing identity and belongs to the partners and the firm.");
  console.error("sequoiataylor.com is Boss OS — a different business with a different key.");
  process.exit(1);
}

console.log(
  `EMPLOYEE SENDER SCAN PASSED: ${names.length} roster employees, all on joinwestpeek.com and resolved ` +
    `through employeeSenderAddress() at ${senderCallSites} call site(s) across ${Object.keys(sources).length} ` +
    `sources; no reference to sequoiataylor.com or BOSS_OS_MAIL_KEY; no employee on westpeek.ventures.`,
);
