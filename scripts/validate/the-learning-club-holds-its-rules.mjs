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
  const { shared, service, migration, wrangler, migrations } = src;

  // 1 · The send gate.
  if (!/INSERT INTO tlc_setting \(key, value, set_by\) VALUES \('brand_send', 'off'/.test(migration)) f.push("the brand-send switch is not seeded 'off' in 0259");
  if (!/settings\[BRAND_SEND_SETTING\] !== "on"/.test(shared)) f.push("brandSendGate does not require the exact string 'on'");
  if (!/settings\[ONEPAGER_APPROVAL_SETTING\]/.test(shared) || !/settings\[PLAYBOOK_APPROVAL_SETTING\]/.test(shared)) f.push("brandSendGate does not require both owner approvals");
  if (!/WP_OS_AI_EMAIL_EXTERNAL !== "enabled"/.test(shared)) f.push("brandSendGate does not require the firm's external-email switch");
  if (/WP_OS_AI_EMAIL_EXTERNAL\s*=\s*"enabled"/.test(wrangler)) f.push("wrangler.toml turns employee email to the outside world on");
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
    [/TLC_COST_CAP_USD = 5_000;/, "$5,000 cap"],
    [/TLC_VETO_DAYS = 3;/, "3-day veto window"],
    [/TLC_GO_CHECK_DAYS = \[21, 14\]/, "21/14-day checks"],
  ];
  for (const [re, what] of pins) if (!re.test(shared)) f.push(`the owner's number moved: ${what}`);
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
    ["external switch dropped", { shared: good.shared.replace('WP_OS_AI_EMAIL_EXTERNAL !== "enabled"', 'WP_OS_AI_EMAIL_EXTERNAL === "x"') }],
    ["wrangler enables outside email", { wrangler: `${good.wrangler}\nWP_OS_AI_EMAIL_EXTERNAL = "enabled"\n` }],
    ["filed before the gate", { service: good.service.replace("if (!gate.open || room <= 0)", "if (room <= 0)") }],
    ["direct transport", { service: `${good.service}\nawait sendViaResend(env, {});\n` }],
    ["payment client", { service: `${good.service}\nconst stripe = 1;\n` }],
    ["a spend effect", { service: `${good.service}\nconst x = "effect_type = 'payment.send'";\n` }],
    ["booking rule dropped", { service: good.service.replace("partners, who book and pay. You never book, reserve or pay for anything", "partners.") }],
    ["sponsor row in a migration", { migrations: [...good.migrations, ["9999_x.sql", "INSERT INTO tlc_deal (id) VALUES ('x');"]] }],
    ["drip moved", { shared: good.shared.replace("TLC_DRIP_DAYS = [0, 4, 10, 18]", "TLC_DRIP_DAYS = [0, 2, 4, 6]") }],
    ["ticket price raised", { shared: good.shared.replace("TLC_TICKET_PRICE_MAX_USD = 10;", "TLC_TICKET_PRICE_MAX_USD = 25;") }],
    ["veto window shortened", { shared: good.shared.replace("TLC_VETO_DAYS = 3;", "TLC_VETO_DAYS = 1;") }],
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
  console.log("Learning Club rules hold: brand send off by default and gated, no spend path, no sponsor data in the repo, the owner's numbers pinned.");
}
