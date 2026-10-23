#!/usr/bin/env node
/**
 * outside-email-one-door.mjs — `npm run validate:outside-email`.
 *
 * ONE ASSERTION: EVERY EMPLOYEE EMAIL TO SOMEBODY OUTSIDE THE FIRM ASKS `outsideEmailAllowed`, AND
 * NOTHING ELSE KEEPS ITS OWN ANSWER.
 *
 * Owner, 23 Oct 2026: "We need a universal narrow switch and i can easily go in the ui and tell it
 * which jobs or work cards to allow". Two components each keeping their own list is a defect, so:
 *
 *   1 · EVERY SENDER IS REGISTERED. Each file in src/ that calls a transport (`sendViaResend(`,
 *       `sendViaCloudflare(`, `sendViaGmail(`) or names a send endpoint is in OUTWARD_SEND_PATHS
 *       (src/shared/policy/outsideEmail.ts), and every registered file still exists.
 *   2 · GOVERNED MEANS ASKED, BEFORE THE SEND. A GOVERNED file calls `outsideEmailAllowed(` before
 *       it reaches its transport (`performEffect(env, request)` in the executor).
 *   3 · ONE READER. Only the two outsideEmail files name the break-glass variable or the list tables;
 *       nobody in src/ reads the retired WP_OS_AI_EMAIL_EXTERNAL.
 *   4 · EVERY EMPLOYEE email.send NAMES ITS JOB OR CARD. An INSERT INTO external_effect_request
 *       written as 'AI' for 'email.send' carries outside_job or work_card_id, and every job id
 *       bound to it is in OUTSIDE_EMAIL_JOBS.
 *   5 · NO "EVERYTHING". The mode table's CHECK allows only OFF and ONLY_ALLOWED; wrangler.toml sets
 *       the break-glass to "list" or "off-hard" and nothing else.
 *
 * HARD-FAILS ON ZERO: zero files scanned, zero transport sites, or zero GOVERNED files exit 1.
 * `--self-test` plants each defect and requires it to be caught.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stripSqlComments, stripTsComments } from "./lib/strip-comments.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const POLICY = "src/shared/policy/outsideEmail.ts";
const DOOR = "src/worker/services/outsideEmail.ts";
const MIGRATION = "migrations/0265_outside_email_allowlist.sql";
const TRANSPORT = /\b(sendViaResend|sendViaCloudflare|sendViaGmail)\s*\(|api\.resend\.com|gmail\/v1\/users\/me\/messages\/send/;
const LIST_NAMES = /WP_OS_OUTSIDE_EMAIL_BREAK_GLASS|BREAK_GLASS_VAR|outside_email_allow\b|outside_email_mode\b/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** wrangler.toml comments are `#` lines; a sentence there sets nothing. */
function stripTomlComments(toml) {
  return toml.replace(/^\s*#.*$/gm, "");
}

function load() {
  const files = {};
  for (const abs of walk(path.join(ROOT, "src"))) files[path.relative(ROOT, abs).split(path.sep).join("/")] = stripTsComments(readFileSync(abs, "utf8"));
  return {
    files,
    migration: existsSync(path.join(ROOT, MIGRATION)) ? stripSqlComments(readFileSync(path.join(ROOT, MIGRATION), "utf8")) : "",
    wrangler: stripTomlComments(readFileSync(path.join(ROOT, "wrangler.toml"), "utf8")),
  };
}

function registry(policy) {
  const block = policy.slice(policy.indexOf("export const OUTWARD_SEND_PATHS"));
  const end = block.indexOf("] as const;");
  const rows = [...block.slice(0, end).matchAll(/\{ file: "([^"]+)", kind: "([A-Z_]+)" \}/g)].map((m) => ({ file: m[1], kind: m[2] }));
  const jobs = [...policy.matchAll(/^\s{4}id: "([a-z0-9_]+)",$/gm)].map((m) => m[1]);
  return { rows, jobs };
}

/** Strip comments so a sentence ABOUT a transport is not a call to one. */
const code = (s) => stripTsComments(s);

function check(src) {
  const f = [];
  const names = Object.keys(src.files);
  if (names.length === 0) return ["zero files scanned under src/"];
  const policy = src.files[POLICY];
  if (!policy) return [`${POLICY} is missing`];
  if (!src.files[DOOR] || !/export async function outsideEmailAllowed\(/.test(src.files[DOOR])) f.push(`${DOOR} does not define outsideEmailAllowed`);
  const { rows, jobs } = registry(policy);
  if (rows.length === 0) return ["OUTWARD_SEND_PATHS is empty or unreadable"];
  if (jobs.length === 0) f.push("OUTSIDE_EMAIL_JOBS names no job");
  const kindOf = new Map(rows.map((r) => [r.file, r.kind]));

  // 1 · every sender registered, every registration real
  const senders = names.filter((n) => TRANSPORT.test(code(src.files[n])));
  if (senders.length === 0) f.push("zero transport call sites found: the scan examined nothing");
  for (const n of senders) if (!kindOf.has(n)) f.push(`${n} sends email and is not in OUTWARD_SEND_PATHS`);
  for (const r of rows) if (!src.files[r.file]) f.push(`OUTWARD_SEND_PATHS names ${r.file}, which does not exist`);

  // 2 · governed means asked, before the send
  const governed = rows.filter((r) => r.kind === "GOVERNED");
  if (governed.length === 0) f.push("no GOVERNED send path: nothing asks outsideEmailAllowed");
  for (const r of governed) {
    const body = code(src.files[r.file] ?? "");
    const ask = body.indexOf("outsideEmailAllowed(");
    const send = body.indexOf("performEffect(env, request)");
    if (ask < 0) f.push(`${r.file} is GOVERNED but never calls outsideEmailAllowed`);
    else if (send >= 0 && send < ask) f.push(`${r.file} reaches its transport before it asks outsideEmailAllowed`);
  }

  // 3 · one reader
  for (const n of names) {
    if (n === POLICY || n === DOOR) continue;
    // env.ts declares the variable's type; a declaration reads nothing.
    if (n === "src/worker/env.ts") { if (/WP_OS_AI_EMAIL_EXTERNAL/.test(code(src.files[n]))) f.push("src/worker/env.ts still declares the retired WP_OS_AI_EMAIL_EXTERNAL"); continue; }
    const body = code(src.files[n]);
    if (LIST_NAMES.test(body)) f.push(`${n} reads the Outside email list or break-glass itself; ask outsideEmailAllowed`);
    if (/WP_OS_AI_EMAIL_EXTERNAL/.test(body)) f.push(`${n} reads the retired WP_OS_AI_EMAIL_EXTERNAL`);
  }

  // 4 · every employee email.send names its job or card
  for (const n of names) {
    const body = code(src.files[n]);
    for (const m of body.matchAll(/INSERT INTO external_effect_request \(([^)]*)\) VALUES \(([^)]*)\)/g)) {
      if (!/'email\.send'/.test(m[2]) || !/'AI'/.test(m[2])) continue;
      if (!/\b(outside_job|work_card_id)\b/.test(m[1])) f.push(`${n} files an employee email.send with no outside_job or work_card_id`);
    }
    for (const m of body.matchAll(/outside_job\s*=\s*'([a-z0-9_]+)'/g)) if (!jobs.includes(m[1])) f.push(`${n} names outside job '${m[1]}', which is not in OUTSIDE_EMAIL_JOBS`);
  }
  if (!/TLC_BRAND_SALES_JOB = "tlc_brand_sales"/.test(policy) || !jobs.includes("tlc_brand_sales")) f.push("TLC brand sales is not a job on the list");

  // 5 · no "everything"
  if (!/CHECK \(mode IN \('OFF','ONLY_ALLOWED'\)\)/.test(src.migration)) f.push("outside_email_mode does not refuse every state but OFF and ONLY_ALLOWED");
  if (/'EVERYTHING'|"EVERYTHING"/.test(code(policy) + stripSqlComments(src.migration))) f.push("an EVERYTHING mode exists");
  const bg = /^WP_OS_OUTSIDE_EMAIL_BREAK_GLASS\s*=\s*"([^"]*)"/m.exec(src.wrangler);
  if (!bg) f.push("wrangler.toml does not declare WP_OS_OUTSIDE_EMAIL_BREAK_GLASS");
  else if (!["list", "off-hard"].includes(bg[1])) f.push(`wrangler.toml sets the break-glass to "${bg[1]}"; only "list" or "off-hard"`);
  if (!/state\.breakGlass\)/.test(policy) || !/BREAK_GLASS_VALUE = "off-hard"/.test(policy)) f.push("break-glass does not win in decideOutsideEmail");
  return f;
}

function selfTest() {
  const good = load();
  const base = check(good);
  if (base.length) {
    console.error(`self-test needs a clean tree first:\n  ${base.join("\n  ")}`);
    process.exit(1);
  }
  const withFile = (name, text) => ({ ...good, files: { ...good.files, [name]: text } });
  const ex = "src/worker/effects/executor.ts";
  const plants = [
    ["an unregistered sender", withFile("src/worker/services/newBlast.ts", "export async function blast(env){ await sendViaResend(env, { to: 'x@y.z' }); }")],
    ["executor stops asking", withFile(ex, good.files[ex].replaceAll("outsideEmailAllowed(", "alwaysYes("))],
    ["a second reader of the list", withFile("src/worker/services/sneaky.ts", "const r = env.WP_OS_DB.prepare('SELECT * FROM outside_email_allow');")],
    ["the retired variable read again", withFile("src/shared/tlc/learningClub.ts", `${good.files["src/shared/tlc/learningClub.ts"]}\nconst x = env.WP_OS_AI_EMAIL_EXTERNAL;\n`)],
    ["an employee email with no job", withFile("src/worker/services/x.ts", `const q = "INSERT INTO external_effect_request (id, effect_type, destination, payload_json, requested_by_type, requested_by_id) VALUES (?1, 'email.send', ?2, ?3, 'AI', ?4)";`)],
    ["a job not on the list", withFile("src/worker/services/y.ts", "const q = \"UPDATE external_effect_request SET outside_job = 'mass_mail'\";")],
    ["an everything mode", { ...good, migration: good.migration.replace("CHECK (mode IN ('OFF','ONLY_ALLOWED'))", "CHECK (mode IN ('OFF','ONLY_ALLOWED','EVERYTHING'))") }],
    ["break-glass set to anything else", { ...good, wrangler: good.wrangler.replace('WP_OS_OUTSIDE_EMAIL_BREAK_GLASS = "list"', 'WP_OS_OUTSIDE_EMAIL_BREAK_GLASS = "everything"') }],
    ["a registered file deleted", (() => { const files = { ...good.files }; delete files["src/worker/services/previewApproval.ts"]; return { ...good, files }; })()],
  ];
  let caught = 0;
  for (const [name, planted] of plants) {
    if (check(planted).length > 0) caught += 1;
    else console.error(`self-test: planted "${name}" was NOT caught`);
  }
  if (caught !== plants.length) process.exit(1);
  console.log(`outside-email self-test passed: ${caught}/${plants.length} planted violations caught`);
}

if (process.argv.includes("--self-test")) selfTest();
else {
  const f = check(load());
  if (f.length) {
    console.error(`Outside email has more than one door:\n  ${f.join("\n  ")}`);
    process.exit(1);
  }
  console.log("Outside email has one door: every sender registered, the governed one asks outsideEmailAllowed first, one reader, no everything.");
}
