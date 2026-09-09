#!/usr/bin/env node
/**
 * mail-assignment-needs-authentication.mjs — `npm run validate:mail-authority`.
 *
 * ONE ASSERTION: NO CODE PATH TURNS AN EMAIL INTO AN ASSIGNMENT ON A `From:` HEADER ALONE.
 *
 * `os@joinwestpeek.com` is publicly addressable — anyone in the world can write to it. Everything it
 * received before this filed a CAPTURE, which is a claim for a person to read. An assignment is
 * different in kind: it is work an AI employee performs, so anyone who can put text in front of Wren
 * can attempt to steer her. A `From:` header is a string the sender chooses, so the boundary is an
 * AUTHENTICATED sender — SPF, DKIM, DMARC, and a signature aligned with the sender's domain — AND
 * membership of a two-address allow-list the operator named herself.
 *
 * A comment saying so is not a guard. This is.
 *
 * WHAT IS CHECKED
 *   1 · The allow-list is EXACTLY sequoia@westpeek.ventures and scooter@westpeek.ventures. Her
 *       words: "only scooter@ and sequoia@ can email them". A third entry is somebody new able to
 *       direct the firm's employees by writing an email, and it must never arrive unnoticed.
 *   2 · `mailAuthority` refuses before it grants: the verdict is consulted and a failed one returns
 *       without a partner, so no ordering change can leave a granting path above the check.
 *   3 · Every call site of `openAssignmentCard` is gated on `isAssignment`, and lives in a file that
 *       actually calls `mailAuthority`. An assignment opened from anywhere else is a bypass.
 *   4 · The verdict itself still requires all three of SPF, DKIM and DMARC to pass, and still checks
 *       DKIM alignment — a `dkim=pass` signed by another domain proves that domain sent something,
 *       not that this From wrote it, which is the exact shape of a spoof.
 *   5 · The trusted resolver is a CONSTANT, not configuration. An environment variable naming who to
 *       trust for authentication is a setting whose wrong value silently disables the whole check.
 *
 * HARD-FAILS ON ZERO. Zero files scanned, or zero places where a message can become an assignment,
 * exits 1: a scan that found no path to guard has not proven the paths are safe, only that it could
 * not see them.
 *
 * `--self-test` runs the bypasses through the same functions — an assignment opened straight off a
 * From header, the verdict check deleted, a third address added — and requires each to be caught.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = path.join(ROOT, "src");
const AUTHORITY_FILE = path.join("src", "shared", "intake", "partnerAuthority.ts");

const EXPECTED_PARTNERS = ["scooter@westpeek.ventures", "sequoia@westpeek.ventures"];

/** Comments out, line count kept, so prose can neither pass nor fail the scan. */
export function stripComments(source) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
  return out;
}

function bodyOf(code, name) {
  const at = code.indexOf(`export function ${name}`);
  if (at === -1) return null;
  const next = code.indexOf("\nexport ", at + 1);
  return code.slice(at, next === -1 ? code.length : next);
}

export function checkSources(sources) {
  const violations = [];
  let assignmentSites = 0;

  const authorityRaw = sources[AUTHORITY_FILE];
  if (!authorityRaw) {
    violations.push(`${AUTHORITY_FILE} is missing — nothing decides who may assign work by email.`);
  } else {
    const code = stripComments(authorityRaw);

    // 1 · The allow-list, exactly.
    const listed = [...code.matchAll(/["']([a-z0-9._-]+@[a-z0-9.-]+)["']/gi)]
      .map((m) => m[1].toLowerCase())
      .filter((a) => a.endsWith("@westpeek.ventures"));
    const unique = [...new Set(listed)].sort();
    if (unique.length === 0) {
      violations.push(`${AUTHORITY_FILE}: no partner addresses found at all, so the allow-list is not readable here.`);
    } else if (unique.join("|") !== EXPECTED_PARTNERS.join("|")) {
      violations.push(
        `${AUTHORITY_FILE}: the assigning allow-list is [${unique.join(", ")}], not exactly ` +
          `[${EXPECTED_PARTNERS.join(", ")}]. Adding an address grants somebody the ability to direct ` +
          `the firm's employees by writing an email — a decision, never an incidental edit.`,
      );
    }

    // 2 · Refuses before it grants.
    const authority = bodyOf(code, "mailAuthority");
    if (!authority) {
      violations.push(`${AUTHORITY_FILE}: mailAuthority is gone, so nothing decides whether a message authorises.`);
    } else {
      if (!/verdict\.passed/.test(authority)) {
        violations.push(
          `${AUTHORITY_FILE}: mailAuthority never consults the authentication verdict. A From header is ` +
            `a string the sender chooses; without the verdict the allow-list checks a forgery against a list.`,
        );
      }
      const refusalAt = authority.indexOf("!verdict.passed");
      const grantAt = authority.indexOf("isAssignment: true");
      if (refusalAt === -1 || (grantAt !== -1 && refusalAt > grantAt)) {
        violations.push(
          `${AUTHORITY_FILE}: mailAuthority can reach "isAssignment: true" without having refused a ` +
            `failed verdict first. The refusal must come before the grant, not beside it.`,
        );
      }
    }

    // 4 · All three methods, plus alignment.
    const verdict = bodyOf(code, "authenticationVerdict");
    if (!verdict) {
      violations.push(`${AUTHORITY_FILE}: authenticationVerdict is gone.`);
    } else {
      for (const method of ["spf", "dkim", "dmarc"]) {
        if (!new RegExp(`${method}\\s*!==\\s*["']pass["']`).test(verdict)) {
          violations.push(
            `${AUTHORITY_FILE}: authenticationVerdict no longer requires ${method.toUpperCase()} to pass. ` +
              `All three are required — dropping one is dropping the boundary.`,
          );
        }
      }
      if (!/signingDomain\s*!==\s*fromDomain/.test(verdict)) {
        violations.push(
          `${AUTHORITY_FILE}: DKIM alignment is no longer checked. A signature from another domain proves ` +
            `that domain sent something, not that this From wrote it — which is the shape of a spoof.`,
        );
      }
    }

    // 5 · The trusted resolver is a constant, never configuration.
    if (!/TRUSTED_AUTHSERV_ID\s*=\s*["'][a-z0-9.-]+["']/i.test(code)) {
      violations.push(
        `${AUTHORITY_FILE}: TRUSTED_AUTHSERV_ID is not a literal constant. Reading who to trust from the ` +
          `environment is a setting whose wrong value silently disables the entire check.`,
      );
    }
    if (/TRUSTED_AUTHSERV_ID\s*=\s*[^"';\n]*env\./i.test(code)) {
      violations.push(`${AUTHORITY_FILE}: TRUSTED_AUTHSERV_ID is read from the environment.`);
    }
  }

  // 3 · Every assignment site is gated, in a file that actually authenticates.
  for (const [file, raw] of Object.entries(sources)) {
    if (file === AUTHORITY_FILE) continue;
    const code = stripComments(raw);
    const lines = code.split("\n");
    lines.forEach((line, i) => {
      if (!/openAssignmentCard\s*\(/.test(line)) return;
      // The definition is not a call site.
      if (/export async function openAssignmentCard/.test(line)) return;
      assignmentSites += 1;
      const window = lines.slice(Math.max(0, i - 30), i + 1).join("\n");
      if (!/\.isAssignment\b/.test(window)) {
        violations.push(
          `${file}:${i + 1}: opens an assignment without a nearby isAssignment gate. An email becomes ` +
            `work only when the sender authenticated AND is on the allow-list.`,
        );
      }
      if (!/mailAuthority\s*\(/.test(code)) {
        violations.push(
          `${file}:${i + 1}: opens an assignment in a file that never calls mailAuthority(), so nothing ` +
            `here authenticated anything. A From header is not proof.`,
        );
      }
    });
  }

  return { violations, assignmentSites };
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────

function selfTest() {
  const failures = [];

  const cleanAuthority = [
    'export const ASSIGNING_PARTNERS = ["sequoia@westpeek.ventures", "scooter@westpeek.ventures"];',
    'export const TRUSTED_AUTHSERV_ID = "mx.cloudflare.net";',
    "export function authenticationVerdict(header, from) {",
    '  if (spf !== "pass") failed.push("spf");',
    '  if (dkim !== "pass") failed.push("dkim");',
    '  if (dmarc !== "pass") failed.push("dmarc");',
    "  if (signingDomain !== fromDomain) failed.push('misaligned');",
    "  return { passed: failed.length === 0 };",
    "}",
    "export function mailAuthority(input) {",
    "  const verdict = authenticationVerdict(input.authenticationResults, from);",
    "  if (!verdict.passed) return { isAssignment: false };",
    "  if (!ASSIGNING_PARTNERS.includes(from)) return { isAssignment: false };",
    "  return { isAssignment: true, partnerAddress: from };",
    "}",
  ].join("\n");
  const handler = [
    "const authority = mailAuthority({ fromHeader: message.headers.get('from') });",
    "if (summary.unrouted && authority.isAssignment) {",
    "  await openAssignmentCard(env, { partnerAddress: authority.partnerAddress });",
    "}",
  ].join("\n");
  const clean = { [AUTHORITY_FILE]: cleanAuthority, "src/worker/effects/inboundEmail.ts": handler };

  const cleanResult = checkSources(clean);
  if (cleanResult.violations.length !== 0) failures.push(`clean fixture was flagged: ${cleanResult.violations[0]}`);
  if (cleanResult.assignmentSites === 0) failures.push("clean fixture found no assignment site to guard");

  const cases = {
    "an assignment opened straight off a From header": {
      [AUTHORITY_FILE]: cleanAuthority,
      "src/worker/effects/inboundEmail.ts":
        "if (ASSIGNING_PARTNERS.includes(message.headers.get('from'))) { await openAssignmentCard(env, {}); }",
    },
    "the verdict check deleted from mailAuthority": {
      ...clean,
      [AUTHORITY_FILE]: cleanAuthority.replace("if (!verdict.passed) return { isAssignment: false };", ""),
    },
    "the grant moved above the refusal": {
      ...clean,
      [AUTHORITY_FILE]: cleanAuthority.replace(
        "  const verdict = authenticationVerdict(input.authenticationResults, from);",
        "  if (ASSIGNING_PARTNERS.includes(from)) return { isAssignment: true };\n  const verdict = authenticationVerdict(input.authenticationResults, from);",
      ),
    },
    "a third address added to the allow-list": {
      ...clean,
      [AUTHORITY_FILE]: cleanAuthority.replace(
        '"scooter@westpeek.ventures"]',
        '"scooter@westpeek.ventures", "assistant@westpeek.ventures"]',
      ),
    },
    "DMARC no longer required": {
      ...clean,
      [AUTHORITY_FILE]: cleanAuthority.replace('  if (dmarc !== "pass") failed.push("dmarc");', ""),
    },
    "DKIM alignment dropped": {
      ...clean,
      [AUTHORITY_FILE]: cleanAuthority.replace("  if (signingDomain !== fromDomain) failed.push('misaligned');", ""),
    },
    "who to trust moved into the environment": {
      ...clean,
      [AUTHORITY_FILE]: cleanAuthority.replace(
        'export const TRUSTED_AUTHSERV_ID = "mx.cloudflare.net";',
        "export const TRUSTED_AUTHSERV_ID = env.WP_OS_AUTHSERV_ID;",
      ),
    },
    "the gate removed from the handler": {
      ...clean,
      "src/worker/effects/inboundEmail.ts": handler.replace("&& authority.isAssignment", ""),
    },
  };
  for (const [name, files] of Object.entries(cases)) {
    if (checkSources(files).violations.length === 0) failures.push(`violating fixture NOT caught: ${name}`);
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
  console.log("SELF-TEST PASSED: clean fixture passes; all 8 bypasses are caught, including an assignment opened straight off a From header.");
  process.exit(0);
}

const sources = readTree(SRC, [".ts", ".tsx"]);
if (Object.keys(sources).length === 0) {
  console.error(`MAIL AUTHORITY SCAN FAILED — examined 0 sources under ${path.relative(ROOT, SRC)}.`);
  process.exit(1);
}

const { violations, assignmentSites } = checkSources(sources);

if (assignmentSites === 0) {
  console.error("MAIL AUTHORITY SCAN FAILED — found 0 places where an email can become an assignment.");
  console.error("Either the feature is not wired up — a decision function with no caller is this repo's");
  console.error("'exists but nothing invokes it' defect — or it is reached by a path this scan cannot see.");
  console.error("Neither is a passing result.");
  process.exit(1);
}

if (violations.length > 0) {
  console.error("MAIL AUTHORITY SCAN FAILED — an email could become an assignment without proving who sent it:");
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error("\nos@joinwestpeek.com is publicly addressable and a From header is a string the sender");
  console.error("chooses. A message becomes work only when the receiving resolver says SPF, DKIM and DMARC");
  console.error("passed with an aligned signature, AND the sender is one of the two addresses the operator");
  console.error("named. Anything else stays a capture — never dropped, never partially honoured.");
  process.exit(1);
}

console.log(
  `MAIL AUTHORITY SCAN PASSED: the allow-list is exactly ${EXPECTED_PARTNERS.join(" and ")}; ` +
    `mailAuthority refuses a failed verdict before it grants; SPF, DKIM, DMARC and alignment are all ` +
    `required; the trusted resolver is a constant; ${assignmentSites} assignment site(s) across ` +
    `${Object.keys(sources).length} sources, each gated on isAssignment.`,
);
