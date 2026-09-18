#!/usr/bin/env node
/**
 * partner-email-boundary.mjs — `npm run validate:partner-email`.
 *
 * ONE ASSERTION: EVERY EMAIL AN EMPLOYEE SENDS A PARTNER LEAVES THROUGH `services/execEmail.ts`,
 * WHICH LAYS IT OUT AND LINTS IT BEFORE ANY TRANSPORT SEES IT.
 *
 * Operator, 16 Sep 2026: "strict rules for every email an employee sends a partner … enforced in
 * code, not by hoping … add a boundary scan: any sendEmail/Resend call to a partner address
 * outside execEmail fails validation." Before this, four senders each composed their own prose
 * and called the transport directly; a fifth would have too.
 *
 * WHAT IS CHECKED
 *   1 · NO TRANSPORT OUTSIDE THE DOOR. `sendViaResend(`, `sendViaCloudflare(` and `sendViaGmail(`
 *       are called only from the files allowed to call them: the transports' own definitions, the
 *       approved external-effect executor (a human decided that send — it is not an employee
 *       writing to a partner), the Gmail send-as path the executor uses, and `execEmail.ts`.
 *   2 · THE DOOR LINTS. `execEmail.ts` calls `renderExecEmail(` and `lintExecEmail(`, and a
 *       violation stops the send (the lint result is tested before the transport is called).
 *   3 · NOTHING BYPASSES IT. `sendPartnerEmail(` / `sendFirmUserCopy(` have callers — "exists but
 *       nothing invokes it" is a defect this portfolio names — and no service file names a partner
 *       address together with a transport.
 *
 * HARD-FAILS ON ZERO: zero files scanned, zero transport call sites found, or zero door callers
 * all exit 1. A scan that examined nothing is not a passing scan.
 *
 * `--self-test` runs the defect this exists to catch — a service composing prose and calling the
 * transport itself — through the same function and requires it to be caught, along with a door
 * that forgot to lint and a door nobody calls.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = path.join(ROOT, "src");
const DOOR = path.join("src", "worker", "services", "execEmail.ts");

/** The transports. A call to any of these outside the allowlist is the violation. */
const TRANSPORTS = /\b(sendViaResend|sendViaCloudflare|sendViaGmail)\s*\(/g;

/**
 * Files that may call a transport, and why.
 *   resendClient / cloudflareEmailClient / googleClient — they DEFINE the transports.
 *   effects/executor.ts — the approved external effect: a human decided that send, on a receipt.
 *   services/googleConnect.ts — `trySendAsPartner`, the executor's send-as-the-partner path.
 *   services/execEmail.ts — the door.
 *   services/previewApproval.ts — "Send it" on a preview. SEE THE NARROW CHECK BELOW: this one is
 *     exempt only because it sends bytes THIS DOOR ALREADY COMPOSED AND LINTED, verbatim. She
 *     approved a specific message; re-rendering it at send time would be a second composition and a
 *     second chance to differ from the thing she said yes to. The exemption is enforced, not
 *     trusted — a version of that file which composed fresh prose fails this scan.
 */
const PREVIEW_SEND = path.join("src", "worker", "services", "previewApproval.ts");

const MAY_CALL_A_TRANSPORT = new Set([
  path.join("src", "worker", "effects", "resendClient.ts"),
  path.join("src", "worker", "effects", "cloudflareEmailClient.ts"),
  path.join("src", "worker", "effects", "googleClient.ts"),
  path.join("src", "worker", "effects", "executor.ts"),
  path.join("src", "worker", "services", "googleConnect.ts"),
  PREVIEW_SEND,
  DOOR,
]);

/** Comments out, line count preserved — prose must not decide the outcome in either direction. */
export function stripComments(source) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
  return out;
}

export function checkSources(sources) {
  const violations = [];
  let transportCallSites = 0;
  let doorCallers = 0;

  for (const [file, source] of Object.entries(sources)) {
    const raw = stripComments(source);
    const calls = [...raw.matchAll(TRANSPORTS)];
    if (calls.length > 0) {
      transportCallSites += calls.length;
      if (!MAY_CALL_A_TRANSPORT.has(file)) {
        violations.push(
          `${file}: calls ${[...new Set(calls.map((c) => c[1]))].join(", ")} directly. Every email to a partner ` +
            `goes through sendPartnerEmail() / sendFirmUserCopy() in ${DOOR}, which lays it out and lints it first.`,
        );
      }
    }
    if (file !== DOOR && /\b(sendPartnerEmail|sendFirmUserCopy)\s*\(/.test(raw)) doorCallers += 1;
    // A partner address named beside a transport is the same bypass with the destination hardcoded.
    if (!MAY_CALL_A_TRANSPORT.has(file) && /(sequoia|scooter)@westpeek\.ventures/.test(raw) && /\bfetch\s*\(\s*["'`]https:\/\/api\.resend\.com/.test(raw)) {
      violations.push(`${file}: reaches the Resend API directly with a partner address in the same file.`);
    }
  }

  /*
   * THE PREVIEW EXEMPTION, NARROWED TO THE THING THAT MAKES IT SAFE.
   *
   * An allowlist entry with only a comment behind it is how a boundary quietly acquires a second
   * door. This one is allowed to reach a transport for exactly one reason: it re-sends bytes that
   * already went through `renderExecEmail` and `lintExecEmail` on the way IN, when the preview was
   * filed. So the file must send the STORED message and must not compose a new one at send time.
   */
  const previewSend = sources[PREVIEW_SEND] ? stripComments(sources[PREVIEW_SEND]) : undefined;
  if (previewSend !== undefined) {
    const at = previewSend.search(/\b(sendViaResend|sendViaCloudflare)\s*\(/);
    const around = previewSend.slice(Math.max(0, at - 1500), at + 500);
    if (!/row\s*\.\s*body_text/.test(around) || !/row\s*\.\s*subject/.test(around)) {
      violations.push(
        `${PREVIEW_SEND}: reaches a transport without sending the stored subject and body. It is exempt ` +
          `from ${DOOR} ONLY because it re-sends a message that door already composed and linted; a version ` +
          "that composes at send time is a second door and must go through the first one.",
      );
    }
    if (/\brenderExecEmail\s*\(/.test(around)) {
      violations.push(
        `${PREVIEW_SEND}: composes with renderExecEmail() at the transport. She approved specific bytes — ` +
          "re-rendering them is a second chance to differ from what she said yes to.",
      );
    }
  }

  const door = sources[DOOR] ? stripComments(sources[DOOR]) : undefined;
  if (!door) {
    violations.push(`${DOOR} is missing — there is no door for an employee's email to leave through.`);
  } else {
    if (!/\brenderExecEmail\s*\(/.test(door)) violations.push(`${DOOR}: does not call renderExecEmail(); the layout is not applied.`);
    const lintAt = door.search(/\blintExecEmail\s*\(/);
    const transportAt = door.search(/\b(sendViaResend|sendViaCloudflare)\s*\(/);
    if (lintAt === -1) violations.push(`${DOOR}: does not call lintExecEmail(); the format is hoped for, not enforced.`);
    if (transportAt === -1) violations.push(`${DOOR}: calls no transport; nothing can leave.`);
    // The lint's verdict must gate the send: `violations.length` is tested somewhere in the door.
    if (lintAt !== -1 && !/violations\.length\s*>\s*0/.test(door)) {
      violations.push(`${DOOR}: runs the lint but nothing tests its result before sending; a violation would go out anyway.`);
    }
  }

  return { violations, transportCallSites, doorCallers };
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────

function selfTest() {
  const failures = [];
  const cleanDoor = [
    'import { sendViaResend } from "../effects/resendClient";',
    'import { lintExecEmail, renderExecEmail } from "../../shared/email/execEmail";',
    "export async function sendPartnerEmail(env, input) {",
    "  const rendered = renderExecEmail(input.email);",
    "  const violations = lintExecEmail(rendered.subject, rendered.text, input.email.employee);",
    "  if (violations.length > 0) return { sent: false };",
    "  return await sendViaResend(env, { to, subject: rendered.subject, text: rendered.text, html: rendered.html });",
    "}",
  ].join("\n");
  const clean = {
    [DOOR]: cleanDoor,
    "src/worker/effects/resendClient.ts": "export async function sendViaResend(env, payload) { return await fetchImpl(RESEND_ENDPOINT, {}); }",
    "src/worker/effects/executor.ts": "const result = cloudflareReady ? await sendViaCloudflare(env, message) : await sendViaResend(env, message);",
    "src/worker/services/requestReply.ts": "const out = await sendPartnerEmail(env, { to, email, objectType: 'work_card' });",
    // A comment naming the transport is not a call.
    "src/worker/services/productions.ts": "// used to call sendViaResend( here\nconst mail = await sendPartnerEmail(env, {});",
    // "Send it" on a preview: the stored bytes, verbatim. Exempt, and the exemption is checked.
    [PREVIEW_SEND]:
      "async function sendApproved(env, row) {\n" +
      "  const payload = { to: row.recipient, subject: row.subject, text: row.body_text };\n" +
      "  return await sendViaResend(approvedEnv, payload);\n}",
  };
  const cleanResult = checkSources(clean);
  if (cleanResult.violations.length !== 0) failures.push(`clean fixture was flagged: ${cleanResult.violations[0]}`);
  if (cleanResult.transportCallSites === 0) failures.push("clean fixture found no transport call site");
  if (cleanResult.doorCallers === 0) failures.push("clean fixture found no door caller");

  const cases = {
    // THE DEFECT: a service composing its own prose and calling the transport.
    "a service calls sendViaResend directly": { ...clean, "src/worker/services/roomPacket.ts": 'const r = await sendViaResend(env, { to: "sequoia@westpeek.ventures", subject, text });' },
    "a service calls sendViaCloudflare directly": { ...clean, "src/worker/services/deliverables.ts": "const r = await sendViaCloudflare(ctx.env, message);" },
    "a service reaches the Resend API itself with a partner address": { ...clean, "src/worker/services/sneaky.ts": 'await fetch("https://api.resend.com/emails", { body: JSON.stringify({ to: "scooter@westpeek.ventures" }) });' },
    "the door forgot to lint": { ...clean, [DOOR]: cleanDoor.replace(/.*lintExecEmail\(rendered.*\n/, "").replace("  if (violations.length > 0) return { sent: false };\n", "") },
    "the door lints but ignores the verdict": { ...clean, [DOOR]: cleanDoor.replace("  if (violations.length > 0) return { sent: false };\n", "") },
    "the door does not lay the email out": { ...clean, [DOOR]: cleanDoor.replace("renderExecEmail(input.email)", "input.email") },
    "the door is gone": Object.fromEntries(Object.entries(clean).filter(([f]) => f !== DOOR)),
    // THE EXEMPTION TURNED INTO A HOLE. Both shapes: composing fresh prose at the transport, and
    // reaching it with something other than the message she actually approved.
    "the preview send composes its own prose at the transport": {
      ...clean,
      [PREVIEW_SEND]:
        "async function sendApproved(env, row) {\n" +
        "  const rendered = renderExecEmail(row);\n" +
        "  return await sendViaResend(approvedEnv, { to: row.recipient, subject: row.subject, text: row.body_text });\n}",
    },
    "the preview send reaches the transport with something she did not approve": {
      ...clean,
      [PREVIEW_SEND]:
        "async function sendApproved(env, row) {\n" +
        "  return await sendViaResend(approvedEnv, { to: row.recipient, subject: 'Re: ' + row.what, text: fresh });\n}",
    },
  };
  for (const [name, files] of Object.entries(cases)) {
    if (checkSources(files).violations.length === 0) failures.push(`violating fixture NOT caught: ${name}`);
  }
  // A HARDCODED COUNT IS A COUNT THAT STOPS MOVING. This line said "all 7" while nine cases ran.
  selfTest.caseCount = Object.keys(cases).length;
  // Nobody calls the door: not a violation list entry, but the scan below hard-fails on it.
  const nobody = checkSources({ ...clean, "src/worker/services/requestReply.ts": "// nothing", "src/worker/services/productions.ts": "// nothing" });
  if (nobody.doorCallers !== 0) failures.push("a fixture with no door callers reported some");
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
  console.log(
    `SELF-TEST PASSED: clean fixture passes; all ${selfTest.caseCount} violating fixtures are caught, ` +
      "including a service calling the transport itself and a preview send that composes instead of re-sending.",
  );
  process.exit(0);
}

const sources = readTree(SRC, [".ts", ".tsx"]);
if (Object.keys(sources).length === 0) {
  console.error(`PARTNER EMAIL SCAN FAILED — examined 0 sources under ${path.relative(ROOT, SRC)}.`);
  process.exit(1);
}

const { violations, transportCallSites, doorCallers } = checkSources(sources);

if (transportCallSites === 0) {
  console.error("PARTNER EMAIL SCAN FAILED — found 0 transport call sites. Either the transports were renamed");
  console.error("and this scan is looking for the wrong thing, or nothing can send email at all.");
  process.exit(1);
}
if (doorCallers === 0) {
  console.error("PARTNER EMAIL SCAN FAILED — nothing calls sendPartnerEmail() or sendFirmUserCopy().");
  console.error("The door exists and nothing goes through it, which is this repo's 'exists but nothing invokes it' defect.");
  process.exit(1);
}
if (violations.length > 0) {
  console.error("PARTNER EMAIL SCAN FAILED — an email can reach a partner without the format:");
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error("\nEvery email an employee sends a partner is composed as an ExecEmailInput and sent through");
  console.error(`sendPartnerEmail() / sendFirmUserCopy() in ${DOOR}: TL;DR first, labelled sections as bullets,`);
  console.error("the details under a rule, the employee's footer — laid out and linted before any transport sees it.");
  process.exit(1);
}

console.log(
  `PARTNER EMAIL SCAN PASSED: ${transportCallSites} transport call site(s) across ${Object.keys(sources).length} sources, ` +
    `all inside the allowed files; ${doorCallers} file(s) send through ${DOOR}, which renders and lints before sending.`,
);
