#!/usr/bin/env node
/**
 * the-learning-club-holds-its-rules.mjs — `npm run validate:tlc`.
 *
 * THE LEARNING CLUB (owner-approved 22 Oct 2026) carries four hard rules. A test proves today's
 * behaviour; this proves the rules are still WIRED, in the files a future change would touch:
 *
 *   1 · NOTHING SENDS TO A BRAND BY DEFAULT. The switch row is seeded 'off'; the gate needs the
 *       exact string 'on', BOTH owner approvals and the firm's external-email switch; the external
 *       switch is not "enabled" in wrangler.toml; and the service files an `email.send` request
 *       only after `brandSendGate(` and executes one only through `executeExternalEffect(`.
 *   2 · AGENTS NEVER SPEND MONEY. No TLC file names a transport, a payment client, or any effect
 *       type other than `email.send`; the booking-pack prompt says the partners book and pay.
 *   3 · NO SPONSOR NAME OR AMOUNT IN THE PUBLIC REPO. No migration inserts a deal, a ticket or a
 *       story row.
 *   4 · THE NUMBERS ARE THE OWNER'S: drip 0/4/10/18, 25–40 seats, $10 ticket max, $10,000 target,
 *       $7,500 floor, $5,000 cap, 3-day veto window, 21/14-day checks.
 *   5 · BRANDS WE MUST PITCH COME FIRST AND ARE NEVER DROPPED (owner, 23 Oct 2026). The batch calls
 *       `handleMustPitch(` before it reads the model's own picks; both paths pass the ONE address check
 *       `addressReadOffPage(` (the address must be in the page's text); a brand that fails it is written
 *       to tlc_way_in; and tlc_deal has ONE insert, `queueDeal`. No migration writes a way-in contact.
 *
 * Hard-fails on zero: every file it reads must exist and be non-empty. `--self-test` plants each
 * violation and requires it to be caught.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stripCommentsFor } from "./lib/strip-comments.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FILES = {
  shared: "src/shared/tlc/learningClub.ts",
  service: "src/worker/services/learningClub.ts",
  mustPitch: "src/worker/services/tlcMustPitch.ts",
  migration: "migrations/0259_the_learning_club_and_wynn_returns.sql",
  wrangler: "wrangler.toml",
};

// Product source is read WITHOUT its comments: a sentence explaining a rule must never satisfy it,
// and a sentence naming a forbidden thing must never trip it. The same holds for SQL.
function read(rel) {
  const full = path.join(ROOT, rel);
  if (!existsSync(full)) return null;
  return stripCommentsFor(rel, readFileSync(full, "utf8"));
}

export function check(src) {
  const f = [];
  for (const [k, v] of Object.entries(src)) {
    if (k === "migrations") continue;
    if (!v || !v.trim()) f.push(`${k}: file missing or empty — a scan that read nothing is not a pass`);
  }
  if (f.length) return f;
  const { shared, service, migration, wrangler, migrations, mustPitch } = src;

  // 1 · The send gate.
  if (!/INSERT INTO tlc_setting \(key, value, set_by\) VALUES \('brand_send', 'off'/.test(migration)) f.push("the brand-send switch is not seeded 'off' in 0259");
  if (!/settings\[BRAND_SEND_SETTING\] !== "on"/.test(shared)) f.push("brandSendGate does not require the exact string 'on'");
  // 22 Oct 2026: an approval is of exact content: the gate compares stored hashes to the current ones.
  if (!/approvalState\(settings, PITCH_APPROVAL_HASH_SETTING, hashes\.pitch\)/.test(shared) || !/approvalState\(settings, PLAYBOOK_APPROVAL_HASH_SETTING, hashes\.playbook\)/.test(shared)) f.push("brandSendGate does not require both owner approvals of the current content");
  if (!/return stored === current \? "APPROVED" : "CHANGED"/.test(shared)) f.push("an approval is not tied to the exact content it approved");
  // One TLC recipient list, enforced at the partner-mail door (22 Oct 2026: Sequoia only).
  if (!/TLC_RECIPIENTS: readonly string\[\] = \[TLC_OWNER\.email\]/.test(shared)) f.push("TLC mail is not addressed from the one recipient list");
  if (/scooter@/i.test(shared) || /scooter@/i.test(service)) f.push("a TLC file names Scooter's address");
  // 23 Oct 2026: outside email is her Outside email list, asked through ONE function.
  if (!/if \(!outside\.allowed\) reasons\.push\(/.test(shared)) f.push("brandSendGate does not require the Outside email list's answer");
  if (/WP_OS_AI_EMAIL_EXTERNAL/.test(shared) || /\benv\./.test(shared.slice(shared.indexOf("export function brandSendGate"), shared.indexOf("export function brandSendGate") + 1600))) f.push("brandSendGate reads an env var instead of outsideEmailAllowed's answer");
  if (!/outsideEmailAllowed\(env, \{ job: TLC_BRAND_SALES_JOB \}\)/.test(service)) f.push("the TLC service does not ask outsideEmailAllowed for TLC brand sales");
  if (/WP_OS_AI_EMAIL_EXTERNAL\s*=/.test(wrangler)) f.push("wrangler.toml still sets the retired all-or-nothing WP_OS_AI_EMAIL_EXTERNAL");
  const gateAt = service.indexOf("brandSendGate(");
  const fileAt = service.indexOf("INSERT INTO external_effect_request");
  const heldAt = service.indexOf("if (!gate.open || room <= 0)");
  if (gateAt < 0 || fileAt < 0 || heldAt < 0 || !(gateAt < heldAt && heldAt < fileAt)) f.push("a brand email can be filed without passing the gate first");
  if (!/executeExternalEffect\(/.test(service)) f.push("brand email is not executed through executeExternalEffect");
  if (!/requestApproval\(/.test(service)) f.push("brand email is filed without an approval card");

  // 2 · No spend.
  for (const [name, text] of [["shared", shared], ["service", service]]) {
    if (/\b(sendViaResend|sendViaCloudflare|sendViaGmail)\s*\(/.test(text)) f.push(`${name}: calls a mail transport directly`);
    if (/stripe|paypal|square\.com|checkout\.session|payment_intent|payouts?\b/i.test(text)) f.push(`${name}: names a payment client`);
    for (const m of text.matchAll(/effect_type[^'"\n]*['"]([a-z_.]+)['"]/g)) if (m[1] !== "email.send") f.push(`${name}: files an effect other than email.send (${m[1]})`);
  }
  if (!/partners, who book and pay\. You never book, reserve or pay for anything/.test(service)) f.push("the booking-pack prompt no longer says the partners book and pay");

  // 3 · No sponsor data in the repo.
  for (const [file, text] of migrations) {
    if (/INSERT\s+(OR\s+\w+\s+)?INTO\s+(tlc_deal|tlc_ticket|tlc_story|tlc_source)\b/i.test(text)) f.push(`${file}: writes sponsor, ticket or story rows into the public repo`);
  }

  // 4 · The owner's numbers.
  const pins = [
    [/TLC_DRIP_DAYS = \[0, 4, 10, 18\]/, "drip days 0/4/10/18"],
    [/TLC_SEATS = \{ min: 25, max: 40 \}/, "25–40 seats"],
    [/TLC_TICKET_PRICE_MAX_USD = 10;/, "$10 ticket max"],
    [/TLC_NET_TARGET_USD = 10_000;/, "$10,000 target"],
    [/TLC_NET_FLOOR_USD = 7_500;/, "$7,500 floor"],
    // 22 Oct 2026 (owner): raise $25,000, spend up to $15,000, net $10,000; $7,500 stays the escalation line.
    [/TLC_COST_BUDGET_USD = 15_000;/, "$15,000 cost budget"],
    [/TLC_SPONSOR_GOAL_USD = 25_000;/, "$25,000 sponsor goal"],
    [/TLC_FUNDED_EVENTS_BEFORE_NON_AI = 6;/, "six funded clubs before a no-AI-angle primary"],
    [/TITLE: \{ label: "Title partner", priceUsd: 25_000/, "Title partner $25,000"],
    [/LEAD: \{ label: "Lead partner", priceUsd: 10_000/, "Lead partner $10,000"],
    [/TLC_VETO_DAYS = 3;/, "3-day veto window"],
    [/TLC_GO_CHECK_DAYS = \[21, 14\]/, "21/14-day checks"],
    [/PARTNER: \{ label: "Partner", priceUsd: 5_000/, "Partner $5,000"],
    [/PRESENTING: \{ label: "Presenting partner", priceUsd: 15_000/, "Presenting partner $15,000"],
  ];
  for (const [re, what] of pins) if (!re.test(shared)) f.push(`the owner's number moved: ${what}`);

  // 5 · Brands we must pitch: first, the same address check, never dropped, one insert.
  // The batch works one club per tick (24 Oct 2026): runBrandBatch must hand each club to brandBatchForClub,
  // and the rules below are read off that one club's body.
  const runAt = service.indexOf("async function runBrandBatch(");
  const runBody = runAt < 0 ? "" : service.slice(runAt, service.indexOf("\nasync function ", runAt + 10));
  if (!/brandBatchForClub\(/.test(runBody)) f.push("the brand batch does not work its clubs through brandBatchForClub");
  const batchAt = service.indexOf("async function brandBatchForClub(");
  const batchBody = batchAt < 0 ? "" : service.slice(batchAt, service.indexOf("\nasync function ", batchAt + 10));
  const mustAt = batchBody.indexOf("handleMustPitch(");
  const picksAt = batchBody.indexOf("for (const b of brands)");
  if (mustAt < 0 || picksAt < 0 || !(mustAt < picksAt)) f.push("the brand batch does not handle the must-pitch brands before the model's own picks");
  if (!/addressReadOffPage\(email, source, check, pageText\)/.test(batchBody)) f.push("the model's own picks do not pass the one address check");
  if (!/addressReadOffPage\(email, source, check, pageText\)/.test(mustPitch)) f.push("must-pitch brands do not pass the one address check");
  if (!/if \(!text\.toLowerCase\(\)\.includes\(email\)\) return/.test(mustPitch)) f.push("the address check no longer requires the address in the page's text");
  if (!/INSERT INTO tlc_way_in/.test(mustPitch)) f.push("a must-pitch brand with no address is not written as a Needs a way in item");
  const dealInserts = [service, mustPitch].reduce((n, t) => n + (t.match(/INSERT (OR \w+ )?INTO tlc_deal\b/g) ?? []).length, 0);
  if (dealInserts !== 1) f.push(`tlc_deal has ${dealInserts} inserts; there must be one (queueDeal)`);
  for (const [file, text] of migrations) {
    if (/INSERT\s+(OR\s+\w+\s+)?INTO\s+tlc_way_in\b/i.test(text)) f.push(`${file}: writes a way-in contact into the public repo`);
  }
  return f;
}

function load() {
  const src = Object.fromEntries(Object.entries(FILES).map(([k, rel]) => [k, read(rel)]));
  const dir = path.join(ROOT, "migrations");
  src.migrations = readdirSync(dir).filter((x) => x.endsWith(".sql")).map((x) => [x, stripCommentsFor(x, readFileSync(path.join(dir, x), "utf8"))]);
  return src;
}

function selfTest() {
  const good = load();
  const base = check(good);
  if (base.length) {
    console.error(`self-test needs a clean tree first:\n  ${base.join("\n  ")}`);
    process.exit(1);
  }
  const plants = [
    ["switch seeded on", { migration: good.migration.replace("VALUES ('brand_send', 'off'", "VALUES ('brand_send', 'on'") }],
    ["gate reads truthy", { shared: good.shared.replace('settings[BRAND_SEND_SETTING] !== "on"', "!settings[BRAND_SEND_SETTING]") }],
    ["outside list dropped", { shared: good.shared.replace("if (!outside.allowed) reasons.push(", "if (false) reasons.push(") }],
    ["gate reads env", { shared: good.shared.replace("if (!outside.allowed) reasons.push(", 'if (env.WP_OS_AI_EMAIL_EXTERNAL !== "enabled") reasons.push(') }],
    ["service skips the one function", { service: good.service.replace("outsideEmailAllowed(env, { job: TLC_BRAND_SALES_JOB })", "({ allowed: true, code: \"ALLOWED\", reason: \"\" })") }],
    ["wrangler sets the retired var", { wrangler: `${good.wrangler}\nWP_OS_AI_EMAIL_EXTERNAL = "enabled"\n` }],
    ["filed before the gate", { service: good.service.replace("if (!gate.open || room <= 0)", "if (room <= 0)") }],
    ["direct transport", { service: `${good.service}\nawait sendViaResend(env, {});\n` }],
    ["payment client", { service: `${good.service}\nconst stripe = 1;\n` }],
    ["a spend effect", { service: `${good.service}\nconst x = "effect_type = 'payment.send'";\n` }],
    ["booking rule dropped", { service: good.service.replace("partners, who book and pay. You never book, reserve or pay for anything", "partners.") }],
    ["sponsor row in a migration", { migrations: [...good.migrations, ["9999_x.sql", "INSERT INTO tlc_deal (id) VALUES ('x');"]] }],
    ["drip moved", { shared: good.shared.replace("TLC_DRIP_DAYS = [0, 4, 10, 18]", "TLC_DRIP_DAYS = [0, 2, 4, 6]") }],
    ["ticket price raised", { shared: good.shared.replace("TLC_TICKET_PRICE_MAX_USD = 10;", "TLC_TICKET_PRICE_MAX_USD = 25;") }],
    ["non-AI gate loosened", { shared: good.shared.replace("TLC_FUNDED_EVENTS_BEFORE_NON_AI = 6;", "TLC_FUNDED_EVENTS_BEFORE_NON_AI = 2;") }],
    ["goal lowered", { shared: good.shared.replace("TLC_SPONSOR_GOAL_USD = 25_000;", "TLC_SPONSOR_GOAL_USD = 15_000;") }],
    ["cost budget raised", { shared: good.shared.replace("TLC_COST_BUDGET_USD = 15_000;", "TLC_COST_BUDGET_USD = 20_000;") }],
    ["veto window shortened", { shared: good.shared.replace("TLC_VETO_DAYS = 3;", "TLC_VETO_DAYS = 1;") }],
    ["approval not tied to content", { shared: good.shared.replace('return stored === current ? "APPROVED" : "CHANGED"', 'return "APPROVED"') }],
    ["pitch approval dropped", { shared: good.shared.replace("approvalState(settings, PITCH_APPROVAL_HASH_SETTING, hashes.pitch)", '"APPROVED"') }],
    ["TLC mail to both partners", { shared: good.shared.replace("TLC_RECIPIENTS: readonly string[] = [TLC_OWNER.email]", "TLC_RECIPIENTS: readonly string[] = PARTNER_EMAILS") }],
    ["Scooter addressed", { service: `${good.service}\nconst to = "scooter@westpeek.ventures";\n` }],
    ["price moved", { shared: good.shared.replace('PARTNER: { label: "Partner", priceUsd: 5_000', 'PARTNER: { label: "Partner", priceUsd: 2_500') }],
    ["must-pitch after the picks", { service: good.service.replace("handleMustPitch(", "handleMustPitchLater(").replace("for (const b of brands) {", "for (const b of brands) {\n    const late = await handleMustPitch(env);") }],
    ["must-pitch handling removed", { service: good.service.replace("handleMustPitch(", "skipMustPitch(") }],
    ["picks skip the address check", { service: good.service.replace("addressReadOffPage(email, source, check, pageText)", "null") }],
    ["must-pitch skips the address check", { mustPitch: good.mustPitch.replace("addressReadOffPage(email, source, check, pageText)", "null") }],
    ["address check loosened", { mustPitch: good.mustPitch.replace("if (!text.toLowerCase().includes(email)) return", "if (false) return") }],
    ["no-address brand dropped", { mustPitch: good.mustPitch.replace("INSERT INTO tlc_way_in", "SELECT 1 FROM tlc_way_in") }],
    ["second deal insert", { service: `${good.service}\nconst q = "INSERT INTO tlc_deal (id) VALUES (1)";\n` }],
    ["way-in contact in a migration", { migrations: [...good.migrations, ["9999_y.sql", "INSERT INTO tlc_way_in (brand_key) VALUES ('x');"]] }],
    ["file missing", { service: null }],
  ];
  let caught = 0;
  for (const [name, patch] of plants) {
    const out = check({ ...good, ...patch });
    if (out.length === 0) {
      console.error(`self-test FAILED: planted "${name}" was not caught`);
      process.exit(1);
    }
    caught += 1;
  }
  console.log(`learning-club self-test passed: ${caught}/${plants.length} planted violations caught`);
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const failures = check(load());
  if (failures.length) {
    console.error(`The Learning Club's rules are not wired:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("Learning Club rules hold: brand send off by default and gated, no spend path, no sponsor data in the repo, the owner's numbers pinned, must-pitch brands first and never dropped.");
}
