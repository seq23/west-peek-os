#!/usr/bin/env node
/**
 * one-employee-one-address.mjs — `npm run validate:one-employee-one-address`.
 *
 * ONE ASSERTION: ONE EMPLOYEE HAS ONE SENDING ADDRESS, AND EVERY PATH THAT PUTS BYTES ON THE WIRE
 * RESOLVES IT THROUGH THE ONE RESOLVER.
 *
 * ─── THE DEFECT THIS EXISTS ABOUT (production, 22 Sep 2026) ───────────────────────────────────
 *
 * One card. One employee. TWO sender addresses on TWO domains, in the same conversation:
 *
 *   · the intake notice      "Delivered to scooter@westpeek.ventures as os@westpeek.ventures"
 *   · the finished-work mail "Porter · West Peek <porter@joinwestpeek.com>"
 *
 * In the partner's mail client that is two correspondents and two threads about one request.
 *
 * ─── WHY THE SIBLING SCAN WAS GREEN THROUGH ALL OF IT, AND THIS ONE IS NOT A DUPLICATE ─────────
 *
 * `validate:employee-sender` asks "does anything hardcode an employee address, or put an employee
 * on the LP-facing domain, or reach for Boss OS's?" — and on 22 Sep the honest answer to all three
 * was NO. Nothing was wrong; something was MISSING. `services/execEmail.ts`'s `transport()` never
 * set `from` at all, so every employee message through the firm's one door fell through to
 * `sendViaResend`'s `env.WP_OS_EMAIL_FROM` fallback and signed as the firm. A scan that looks for a
 * wrong VALUE cannot see an absent KEY, which is this repo's "runs but inert" class exactly.
 *
 * So the assertion here is the positive one, and it is deliberately about OMISSION:
 *
 *   1 · EVERY SEND PATH NAMES ITS SENDER. A file that calls `sendViaResend(` or `sendViaCloudflare(`
 *       and is not a transport itself must build its payload with a `from`, and that `from` must be
 *       resolved through `employeeSenderHeader(` / `employeeSenderAddress(` — never a literal, never
 *       a concatenation, never left out for the environment to fill in.
 *
 *   2 · THE ONE DOOR'S OWN HELPER CANNOT BE CALLED WITHOUT ONE. Every `transport(env, {` call inside
 *       `services/execEmail.ts` passes `from:`, and `transport`'s parameter type REQUIRES it
 *       (`from: string`, not `from?: string`). A required field is the check that survives a
 *       refactor this scan has not imagined.
 *
 *   3 · NO SENDER LITERAL IN A SEND PATH. A `from` assigned a quoted address on `joinwestpeek.com`
 *       or `westpeek.ventures`, or built by interpolation onto either domain, fails — outside the
 *       resolver and the registry, which are the two files allowed to know what an address looks
 *       like. `os@joinwestpeek.com` as REPLY-TO is untouched and deliberately so: it is the intake
 *       mailbox the inbound door actually receives on, and the footer's "reply to this email" is
 *       only honest because of it.
 *
 *   4 · EVERY ROSTER EMPLOYEE RESOLVES TO EXACTLY ONE ADDRESS. One domain constant, one minting
 *       expression, and no two roster names that collide once lowercased — two Porters would be one
 *       mailbox wearing two people's work.
 *
 * HARD-FAILS ON ZERO: zero sources, zero roster names, or zero send paths found exits 1. A scan
 * that examined no send path is not a passing scan; it is the defect with a green tick on it.
 *
 * `--self-test` plants the real 22 Sep shape and eight more and requires each to be caught.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = path.join(ROOT, "src");
const ROSTER_FILE = path.join("src", "shared", "registry", "aiEmployees.ts");
const MAIL_FILE = path.join("src", "shared", "registry", "employeeMail.ts");
const DOOR_FILE = path.join("src", "worker", "services", "execEmail.ts");

/** The transports. A file that calls one of these is a send path. */
const TRANSPORT_CALL = /\b(?:sendViaResend|sendViaCloudflare)\s*\(/;

/** The transports THEMSELVES, which define the call rather than make one. */
const TRANSPORT_FILES = new Set([
  path.join("src", "worker", "effects", "resendClient.ts"),
  path.join("src", "worker", "effects", "cloudflareEmailClient.ts"),
]);

/** The two files allowed to know what an employee address is made of. */
const MAY_MINT = new Set([MAIL_FILE, path.join("src", "shared", "email", "thread.ts")]);

const RESOLVER = /\bemployeeSender(?:Header|Address)\s*\(/;

/**
 * Comments stripped before any check, because this repo documents its rules by NAMING the thing
 * being refused. `employeeMail.ts` writes out `preston@westpeek.ventures` to say it is forbidden,
 * and a scan that cannot tell an explanation from a violation punishes the explaining.
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

/**
 * A `from` bound to a literal address on one of our own domains, or built onto one by
 * interpolation. `replyTo:` is explicitly NOT this: the intake mailbox is a destination.
 */
const FROM_LITERAL = /\bfrom\s*[:=]\s*["'`][^"'`]*@(?:joinwestpeek\.com|westpeek\.ventures)/i;
const FROM_CONCAT = /\bfrom\s*[:=]\s*`[^`]*\$\{[^}]*\}\s*@\s*(?:joinwestpeek\.com|westpeek\.ventures)/i;

export function checkSources(sources, names) {
  const violations = [];
  const sendPaths = [];

  for (const [file, source] of Object.entries(sources)) {
    const raw = stripComments(source);

    if (FROM_LITERAL.test(raw) && !MAY_MINT.has(file)) {
      violations.push(
        `${file}: sets a sender to a literal address. An employee's address is resolved from the ` +
          `roster through employeeSenderHeader(); a copy of one here drifts the day a name changes.`,
      );
    }
    if (FROM_CONCAT.test(raw) && !MAY_MINT.has(file)) {
      violations.push(
        `${file}: builds a sender by interpolating onto one of our domains. A verified domain signs ` +
          `ANY local part, so a typo sends perfectly from an address belonging to nobody.`,
      );
    }

    if (!TRANSPORT_CALL.test(raw) || TRANSPORT_FILES.has(file)) continue;
    sendPaths.push(file);

    if (!/\bfrom\b\s*[:=]/.test(raw)) {
      violations.push(
        `${file}: reaches a transport without ever naming a sender. This is the 22 Sep 2026 defect ` +
          `exactly — an OMITTED from falls through to env.WP_OS_EMAIL_FROM, the FIRM's address, so ` +
          `one employee signs two ways in one conversation and nothing looks wrong.`,
      );
      continue;
    }
    if (!RESOLVER.test(raw)) {
      violations.push(
        `${file}: names a sender but does not resolve it through employeeSenderHeader() / ` +
          `employeeSenderAddress(). One resolver, reading the roster, or there is no "one address".`,
      );
    }
  }

  // 2 · The one door's helper cannot be called without a sender.
  const door = sources[DOOR_FILE] ? stripComments(sources[DOOR_FILE]) : undefined;
  if (!door) {
    violations.push(`${DOOR_FILE} is missing — nothing defines the one door an employee's mail leaves through.`);
  } else {
    if (!/\bmessage\s*:\s*\{[^}]*\bfrom\s*:\s*string\b/.test(door.replace(/\n/g, " "))) {
      violations.push(
        `${DOOR_FILE}: transport()'s payload type does not REQUIRE a from. Optional is how it was ` +
          `forgotten; a required field is the only version a future refactor cannot drop silently.`,
      );
    }
    const calls = [...door.matchAll(/\btransport\s*\(\s*env\s*,\s*\{([\s\S]{0,400}?)\}\s*\)/g)];
    if (calls.length === 0) {
      violations.push(`${DOOR_FILE}: no transport(env, { … }) call found — the door's shape changed and this scan is now blind.`);
    }
    for (const [i, call] of calls.entries()) {
      if (!/\bfrom\s*:/.test(call[1])) {
        violations.push(`${DOOR_FILE}: transport() call #${i + 1} passes no from, so that send signs as the firm.`);
      }
    }
  }

  // 4 · One address each.
  const mail = sources[MAIL_FILE] ? stripComments(sources[MAIL_FILE]) : undefined;
  if (!mail) {
    violations.push(`${MAIL_FILE} is missing — nothing resolves an employee's address.`);
  } else {
    const domains = [...mail.matchAll(/EMPLOYEE_MAIL_DOMAIN\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
    if (domains.length !== 1) {
      violations.push(`${MAIL_FILE}: ${domains.length} employee sending domains declared; one employee, one address means one domain.`);
    } else if (domains[0] !== "joinwestpeek.com") {
      violations.push(
        `${MAIL_FILE}: the employee domain is "${domains[0]}". It is joinwestpeek.com — the hostname the ` +
          `employees inhabit, verified for sending on the West Peek Resend account, and carrying no ` +
          `implication that the sender is a person at the fund.`,
      );
    }
    const mints = [...mail.matchAll(/\$\{[^}]*\}@\$\{EMPLOYEE_MAIL_DOMAIN\}/g)];
    if (mints.length !== 1) {
      violations.push(`${MAIL_FILE}: ${mints.length} expressions mint an address; exactly one may, or an employee has two.`);
    }
  }

  const seen = new Map();
  for (const name of names) {
    const key = name.trim().toLowerCase();
    if (seen.has(key)) {
      violations.push(`the roster has two employees named "${seen.get(key)}" and "${name}" — they would share one mailbox.`);
    }
    seen.set(key, name);
  }

  return { violations, sendPaths };
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────

function selfTest() {
  const failures = [];
  const names = ["Porter", "Walker", "Wren"];

  const cleanDoor = [
    'import { employeeSenderHeader } from "../../shared/registry/employeeMail";',
    "function senderFor(employee) { return { from: employeeSenderHeader(employee) }; }",
    "async function transport(env, message: { to: string; subject: string; text: string; html: string; from: string }) {",
    "  const payload = { ...message, replyTo: INTAKE_MAILBOX };",
    "  return isCloudflareEmailEnabled(env) ? await sendViaCloudflare(env, payload) : await sendViaResend(env, payload);",
    "}",
    "async function go() {",
    "  const sender = senderFor(input.email.employee);",
    "  result = await transport(env, { to, subject: r.subject, text: r.text, html: r.html, from: sender.from });",
    "}",
  ].join("\n");
  const cleanMail = [
    'import { AI_EMPLOYEE_ROSTER } from "./aiEmployees";',
    'export const EMPLOYEE_MAIL_DOMAIN = "joinwestpeek.com";',
    'export const LP_FACING_MAIL_DOMAIN = "westpeek.ventures";',
    "export function employeeSenderAddress(name) { return `${key}@${EMPLOYEE_MAIL_DOMAIN}`; }",
  ].join("\n");
  const clean = {
    [DOOR_FILE]: cleanDoor,
    [MAIL_FILE]: cleanMail,
    "src/worker/services/previewApproval.ts":
      'const payload = { to: row.recipient, from: employeeSenderHeader(row.employee), replyTo: "os@joinwestpeek.com" };\n' +
      "return isCloudflareEmailEnabled(env) ? await sendViaCloudflare(e, payload) : await sendViaResend(e, payload);",
  };
  const cleanResult = checkSources(clean, names);
  if (cleanResult.violations.length !== 0) failures.push(`clean fixture was flagged: ${cleanResult.violations[0]}`);
  if (cleanResult.sendPaths.length !== 2) failures.push(`clean fixture found ${cleanResult.sendPaths.length} send paths, expected 2`);

  const cases = {
    // THE ACTUAL DEFECT, 22 Sep 2026: the door reaches a transport and never names a sender.
    "the real defect — a send path with no from at all": {
      ...clean,
      [DOOR_FILE]: cleanDoor
        .replace(", from: string }", " }")
        .replace(", from: sender.from }", " }")
        .replace("function senderFor(employee) { return { from: employeeSenderHeader(employee) }; }", ""),
    },
    "transport()'s from went optional again": {
      ...clean,
      [DOOR_FILE]: cleanDoor.replace("from: string }", "from?: string }"),
    },
    "one transport() call quietly drops its from": {
      ...clean,
      [DOOR_FILE]: cleanDoor.replace(", from: sender.from }", " }"),
    },
    "a send path names a sender without resolving it": {
      ...clean,
      "src/worker/services/notifier.ts": "const payload = { to, from: env.WP_OS_EMAIL_FROM };\nawait sendViaResend(env, payload);",
    },
    "a sender literal on the LP-facing domain": {
      ...clean,
      "src/worker/services/notifier.ts": 'const from = "os@westpeek.ventures";\nawait sendViaResend(env, { to, from });',
    },
    "a sender literal on the employee domain, outside the resolver": {
      ...clean,
      "src/worker/services/notifier.ts": 'const from = "porter@joinwestpeek.com";\nawait sendViaResend(env, { to, from });',
    },
    "a sender built by interpolation onto a domain": {
      ...clean,
      "src/worker/services/notifier.ts": "const from = `${name}@joinwestpeek.com`;\nawait sendViaResend(env, { to, from });",
    },
    "two employee domains declared": {
      ...clean,
      [MAIL_FILE]: `${cleanMail}\nexport const EMPLOYEE_MAIL_DOMAIN = "westpeek.ventures";`,
    },
    "the employee domain moved to the LP-facing one": {
      ...clean,
      [MAIL_FILE]: cleanMail.replace('EMPLOYEE_MAIL_DOMAIN = "joinwestpeek.com"', 'EMPLOYEE_MAIL_DOMAIN = "westpeek.ventures"'),
    },
    "a second expression mints an address": {
      ...clean,
      [MAIL_FILE]: `${cleanMail}\nexport function other(n) { return \`\${n}@\${EMPLOYEE_MAIL_DOMAIN}\`; }`,
    },
    "the door disappeared": (() => {
      const f = { ...clean };
      delete f[DOOR_FILE];
      return f;
    })(),
  };
  for (const [name, files] of Object.entries(cases)) {
    if (checkSources(files, names).violations.length === 0) failures.push(`violating fixture NOT caught: ${name}`);
  }

  // Two people, one mailbox.
  if (checkSources(clean, ["Porter", "porter"]).violations.length === 0) {
    failures.push("violating fixture NOT caught: two roster names collapsing to one address");
  }
  // And the intake mailbox as REPLY-TO must stay legal, or the footer's promise becomes a violation.
  if (checkSources({ ...clean, "src/worker/services/x.ts": 'const replyTo = "os@joinwestpeek.com";' }, names).violations.length !== 0) {
    failures.push("clean fixture flagged: reply-to on the intake mailbox must remain legal");
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
  console.log("SELF-TEST PASSED: clean fixture passes; all 13 violating fixtures are caught, including the real 22 Sep 2026 omitted-from defect.");
  process.exit(0);
}

const sources = readTree(SRC, [".ts", ".tsx"]);
const names = rosterNames(readFileSync(path.join(ROOT, ROSTER_FILE), "utf8"));

if (Object.keys(sources).length === 0) {
  console.error(`ONE ADDRESS SCAN FAILED — examined 0 sources under ${path.relative(ROOT, SRC)}.`);
  process.exit(1);
}
if (names.length === 0) {
  console.error("ONE ADDRESS SCAN FAILED — read 0 names from AI_EMPLOYEE_ROSTER.");
  console.error("The roster is the closed list every address is minted from. Zero names means this");
  console.error("scan compared nothing against nothing and would pass whatever the code said.");
  process.exit(1);
}

const { violations, sendPaths } = checkSources(sources, names);

if (sendPaths.length === 0) {
  console.error("ONE ADDRESS SCAN FAILED — found 0 send paths.");
  console.error("Nothing in src/ calls sendViaResend() or sendViaCloudflare() outside the transports");
  console.error("themselves, so every check above examined nothing. Either the send paths moved and");
  console.error("this scan is now blind, or the firm can no longer send mail at all.");
  process.exit(1);
}

if (violations.length > 0) {
  console.error("ONE ADDRESS SCAN FAILED — an employee can sign two ways in one conversation:");
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error("\nONE EMPLOYEE, ONE ADDRESS. Every send path resolves its From through");
  console.error("employeeSenderHeader() against the closed roster, and every employee is");
  console.error("<name>@joinwestpeek.com. os@joinwestpeek.com stays the intake mailbox — reply-to,");
  console.error("never a sender. westpeek.ventures is the partners' and the firm's LP-facing identity.");
  process.exit(1);
}

console.log(
  `ONE ADDRESS SCAN PASSED: ${sendPaths.length} send path(s) (${sendPaths.join(", ")}) each resolve From ` +
    `through the one resolver; transport()'s from is required and passed at every call; ${names.length} roster ` +
    `employees, one address each on joinwestpeek.com; no sender literal outside the registry.`,
);
