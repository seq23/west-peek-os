#!/usr/bin/env node
/**
 * no-land-without-approval.mjs — `npm run validate:no-land-without-approval`.
 *
 * ONE ASSERTION: NOTHING LANDS A WEB PROPERTY CHANGE WITHOUT A RECORDED PLAN APPROVAL AND A
 * RECORDED GREEN CHECK — IN THE WORKER, IN THE SCRIPT ON HER MAC, AND AT THE ROW.
 *
 * WHAT THIS GUARDS (owner, 20 Sep 2026, Plan A). "Land on green" is her rule: once the PR is
 * green, Porter merges and deploys without a further reply. The rule only holds because two
 * facts are RECORDED before anything is landed — the partner approved the plan (their answer,
 * by reply or on the card), and the PR's checks were observed green by the script, never by the
 * model ("never take an agent's word that CI is green", 19 Sep). Three places must refuse without
 * both, and each is a different failure if it drifts: the Worker parks a LAND run it should not;
 * the script lands a run the Worker never gated; the row lets a card go DONE with no proof.
 *
 * WHAT IS CHECKED
 *   1 · `services/webPropertyChange.ts` `parkPhase`: inside the `phase === "LAND"` branch, both
 *       `plan_approved_at` and `check_green_at` are tested and the branch returns before
 *       `parkRun` is called. Also `pr_url`.
 *   2 · `scripts/duties/web-property-change.mjs` `landGate`: tests `plan.approved_at` and
 *       `pr.check_green_at` and `check_state !== "GREEN"`; and `run()` calls `landGate` BEFORE it
 *       calls `~/bin/land`.
 *   3 · Migration 0219's trigger refuses DONE for the kind unless `pr_url`, `check_green_at` and
 *       `merge_sha` are all present.
 *   4 · The `land_on_green` rule row exists in the migration and defaults to `on`.
 *   5 · `applyBuild` in the Worker only queues LAND when `isOn(rules.land_on_green)`, otherwise blocks.
 *   6 · "NO" NEVER APPROVES (owner, 21 Sep 2026). `runWebPropertyChangeCard` reads the partner's
 *       answer through `readApprovalReply`, the REFUSED branch returns before `plan_approved_at`
 *       is written, and the answer is checked against the requesting partner first. And the real
 *       reader, loaded from `shared/work/approvalReply.ts`, reads "no" as REFUSED, "approved" as
 *       APPROVED, and a paragraph as ANSWERS.
 *
 * HARD-FAILS ON ZERO: zero gates examined exits 1.
 *
 * `--self-test` plants: the Worker's LAND branch with the approval check removed; with the green
 * check removed; the script's gate with the green test removed; `run()` landing before the gate;
 * the trigger without `check_green_at`; the rule seeded `off`; `applyBuild` landing regardless;
 * the runner approving without reading the reply; the REFUSED branch that no longer returns; a
 * reader that lets "no" through — and requires each to be caught. The shipped source must pass.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTsComments } from "./lib/strip-comments.mjs";
import { loadTs } from "./lib/load-ts.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKER = path.join(ROOT, "src", "worker", "services", "webPropertyChange.ts");
const SCRIPT = path.join(ROOT, "scripts", "duties", "web-property-change.mjs");
const MIGRATION = path.join(ROOT, "migrations", "0219_porter_changes_a_web_property_from_her_mac.sql");
const READER = path.join(ROOT, "src", "shared", "work", "approvalReply.ts");
const read = (p) => stripTsComments(readFileSync(p, "utf8"));
/** SQL: `--` line comments blanked, so a comment naming a column cannot satisfy or fail the trigger check. */
function stripSqlComments(sql) {
  return String(sql ?? "").replace(/--[^\n]*/g, "");
}
const readSql = (p) => stripSqlComments(readFileSync(p, "utf8"));

function body(src, name) {
  const start = src.indexOf(name);
  if (start < 0) return null;
  // The body's brace is the first `{` that ends a line: a return type like `Promise<{ … }>` sits
  // inside the signature and must be skipped.
  const open = src.indexOf("{\n", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

export function checkWorker(src) {
  const violations = [];
  let examined = 0;
  const park = body(src, "export async function parkPhase(");
  if (!park) violations.push("services/webPropertyChange.ts has no parkPhase() — the one place a LAND run is parked is gone");
  else {
    examined += 1;
    const landBranch = park.match(/if\s*\(phase\s*===\s*"LAND"\)\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
    if (!landBranch) violations.push("parkPhase() has no `phase === \"LAND\"` branch — a LAND run would be parked with no gate");
    else {
      if (!/plan_approved_at/.test(landBranch) || !/return\s*\{\s*parked:\s*false/.test(landBranch)) violations.push("parkPhase()'s LAND branch does not refuse without row.plan_approved_at");
      if (!/check_green_at/.test(landBranch)) violations.push("parkPhase()'s LAND branch does not refuse without row.check_green_at");
      if (!/pr_url/.test(landBranch)) violations.push("parkPhase()'s LAND branch does not refuse without row.pr_url");
      const gateAt = park.indexOf('phase === "LAND"');
      const parkAt = park.indexOf("parkRun(");
      if (parkAt >= 0 && gateAt > parkAt) violations.push("parkPhase() calls parkRun() before the LAND gate");
    }
  }
  const runner = body(src, "export async function runWebPropertyChangeCard(");
  if (!runner) violations.push("runWebPropertyChangeCard() is gone");
  else {
    examined += 1;
    const readAt = runner.indexOf("readApprovalReply(answer)");
    const approveAt = runner.indexOf("plan_approved_at: now");
    if (readAt < 0) violations.push("the runner approves a plan without reading the reply through readApprovalReply — \"no\" would build");
    if (approveAt < 0) violations.push("the runner never records plan_approved_at — nothing could ever build");
    if (readAt >= 0 && approveAt >= 0 && readAt > approveAt) violations.push("the runner records plan_approved_at before it reads the reply");
    const refused = runner.match(/if\s*\(reading\.kind\s*===\s*"REFUSED"\)\s*\{([\s\S]*?)\n\s{4}\}/)?.[1] ?? "";
    if (!refused) violations.push("the runner has no REFUSED branch — a reply starting with \"no\" would be treated as answers and build");
    else if (!/return\s*\{/.test(refused) || !/blockCard\(/.test(refused)) violations.push("the runner's REFUSED branch does not block the card and return — \"no\" would fall through to plan_approved_at");
    const requesterAt = runner.indexOf("block_answered_by !== requester.firmUserId");
    if (requesterAt < 0 || requesterAt > readAt) violations.push("the runner does not check the answer came from the requesting partner before reading it as an approval");
  }
  const build = body(src, "async function applyBuild(");
  if (!build) violations.push("applyBuild() is gone");
  else {
    examined += 1;
    if (!/isOn\(rules\.land_on_green\)/.test(build)) violations.push("applyBuild() no longer reads the land_on_green rule before queueing LAND");
    if (!/blockCard\(/.test(build)) violations.push("applyBuild() never blocks when land_on_green is off — it would land regardless");
  }
  return { violations, examined };
}

export function checkScript(src) {
  const violations = [];
  let examined = 0;
  const gate = body(src, "export function landGate(");
  if (!gate) violations.push("web-property-change.mjs has no landGate()");
  else {
    examined += 1;
    if (!/plan\??\.approved_at/.test(gate)) violations.push("landGate() does not test plan.approved_at");
    if (!/check_green_at/.test(gate)) violations.push("landGate() does not test pr.check_green_at");
    if (!/check_state\s*!==\s*"GREEN"/.test(gate)) violations.push("landGate() does not require check_state GREEN");
  }
  const run = body(src, "export async function run(");
  if (!run) violations.push("web-property-change.mjs exports no run()");
  else {
    examined += 1;
    const gateAt = run.indexOf("landGate(job)");
    const landAt = run.search(/"bin",\s*"land"/);
    if (gateAt < 0) violations.push("run() never calls landGate(job)");
    if (landAt < 0) violations.push("run() never runs ~/bin/land — LAND does nothing");
    if (gateAt >= 0 && landAt >= 0 && gateAt > landAt) violations.push("run() reaches ~/bin/land before landGate(job)");
  }
  return { violations, examined };
}

export function checkMigration(sql) {
  const violations = [];
  let examined = 0;
  const trigger = sql.match(/CREATE TRIGGER trg_web_property_change_done_needs_proof([\s\S]*?)END;/)?.[1];
  if (!trigger) violations.push("0219 has no trg_web_property_change_done_needs_proof trigger");
  else {
    examined += 1;
    for (const col of ["pr_url", "check_green_at", "merge_sha"]) {
      if (!new RegExp(`w\\.${col}\\s+IS NOT NULL`).test(trigger)) violations.push(`the DONE trigger does not require ${col}`);
    }
    if (!/RAISE\(ABORT/.test(trigger)) violations.push("the DONE trigger does not abort");
  }
  const rule = sql.match(/\('WEB_PROPERTY_CHANGE',\s*'land_on_green',[^)]*\)/)?.[0];
  if (!rule) violations.push("0219 seeds no land_on_green rule row");
  else {
    examined += 1;
    if (!/'on',\s*1,/.test(rule)) violations.push("land_on_green is not seeded ON and editable — her decision of 20 Sep 2026");
  }
  return { violations, examined };
}

export async function checkReader(mod) {
  const violations = [];
  let examined = 0;
  const cases = [
    ["no", "REFUSED"], ["No.", "REFUSED"], ["not approved", "REFUSED"], ["stop", "REFUSED"], ["changes: use blue", "REFUSED"], ["No, keep the old logo", "REFUSED"],
    ["approved", "APPROVED"], ["Approved!", "APPROVED"], ["approve", "APPROVED"], ["yes", "APPROVED"], ["go", "APPROVED"], ["land it", "APPROVED"],
    ["1. keep black and white. 2. yes remove it.", "ANSWERS"], ["nothing on 1, and drop the second logo", "ANSWERS"],
  ];
  for (const [text, want] of cases) {
    examined += 1;
    const got = mod.readApprovalReply(text)?.kind;
    if (got !== want) violations.push(`readApprovalReply(${JSON.stringify(text)}) reads ${got}, expected ${want}`);
  }
  if (mod.approvedAnswers([{ question: "q", recommended: "r" }])[0]?.includes("r") !== true) violations.push("approvedAnswers does not take the recommended default");
  return { violations, examined };
}

async function selfTest() {
  let failed = 0;
  const say = (ok, what) => {
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${what}`);
  };
  const worker = read(WORKER);
  const script = read(SCRIPT);
  const sql = readSql(MIGRATION);
  const reader = await loadTs(READER);
  const real = [checkWorker(worker), checkScript(script), checkMigration(sql), await checkReader(reader)];
  say(real.every((r) => r.violations.length === 0) && real.reduce((n, r) => n + r.examined, 0) >= 7, `shipped source passes (${real.reduce((n, r) => n + r.examined, 0)} gates): ${real.flatMap((r) => r.violations).join("; ")}`);

  const noReading = worker.replace("const reading = readApprovalReply(answer);", "const reading = { kind: \"APPROVED\" };");
  say(checkWorker(noReading).violations.some((v) => /without reading the reply/.test(v)), "a runner that approves without reading the reply is caught");
  const noRefusal = worker.replace(/if \(reading\.kind === "REFUSED"\) \{[\s\S]*?\n    \}\n/, "");
  say(checkWorker(noRefusal).violations.some((v) => /no REFUSED branch/.test(v)), "a runner whose REFUSED branch is gone is caught");
  const noRequester = worker.replace("card.block_answered_by !== requester.firmUserId", "false");
  say(checkWorker(noRequester).violations.some((v) => /requesting partner/.test(v)), "a runner that lets the other partner approve is caught");
  const leakyReader = { ...reader, readApprovalReply: (t) => (String(t).trim().toLowerCase() === "no" ? { kind: "ANSWERS", text: t } : reader.readApprovalReply(t)) };
  say((await checkReader(leakyReader)).violations.some((v) => /"no"\) reads ANSWERS/.test(v)), "a reader that lets \"no\" through as answers is caught");

  const noApproval = worker.replace(/if \(!row\.plan_approved_at\) return \{ parked: false[^\n]*\n/, "");
  say(checkWorker(noApproval).violations.some((v) => /plan_approved_at/.test(v)), "Worker LAND branch without the approval check is caught");
  const noGreen = worker.replace(/if \(!row\.check_green_at \|\| row\.check_state !== "GREEN"\) return \{ parked: false[^\n]*\n/, "");
  say(checkWorker(noGreen).violations.some((v) => /check_green_at/.test(v)), "Worker LAND branch without the green check is caught");
  const landsRegardless = worker.replace("if (isOn(rules.land_on_green)) {", "if (true) {");
  say(checkWorker(landsRegardless).violations.some((v) => /land_on_green/.test(v)), "applyBuild ignoring the land_on_green rule is caught");

  const scriptNoGreen = script.replace(/if \(!job\?\.pr\?\.check_green_at \|\| job\.pr\.check_state !== "GREEN"\)[^\n]*\n/, "");
  say(checkScript(scriptNoGreen).violations.some((v) => /check_green_at|GREEN/.test(v)), "script gate without the green test is caught");
  const gateLate = script.replace("const gate = landGate(job);", "const gate = { ok: true };").replace(/return \{ phase, status: "ok", merge_sha: mergeSha,/, "landGate(job); return { phase, status: \"ok\", merge_sha: mergeSha,");
  say(checkScript(gateLate).violations.some((v) => /before landGate/.test(v)), "run() landing before the gate is caught");

  const triggerLoose = sql.replace("AND w.check_green_at IS NOT NULL", "");
  say(checkMigration(triggerLoose).violations.some((v) => /check_green_at/.test(v)), "a DONE trigger that no longer requires check_green_at is caught");
  const ruleOff = sql.replace("'land_on_green', 'Land on green', 'on', 1,", "'land_on_green', 'Land on green', 'off', 1,");
  say(checkMigration(ruleOff).violations.some((v) => /seeded ON/.test(v)), "land_on_green seeded OFF is caught");

  if (failed > 0) process.exit(1);
  console.log("SELF-TEST PASSED: eleven planted defects are each caught; the shipped source passes.");
}

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  const results = [checkWorker(read(WORKER)), checkScript(read(SCRIPT)), checkMigration(readSql(MIGRATION)), await checkReader(await loadTs(READER))];
  const examined = results.reduce((n, r) => n + r.examined, 0);
  const violations = results.flatMap((r) => r.violations);
  if (examined === 0) {
    console.error("NO-LAND-WITHOUT-APPROVAL SCAN FAILED — examined 0 gates. An empty loop reporting success is the defect this repo calls Rule 0.");
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error("NO-LAND-WITHOUT-APPROVAL SCAN FAILED — something could land without a recorded approval and a recorded green:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    process.exit(1);
  }
  console.log(`NO-LAND-WITHOUT-APPROVAL SCAN PASSED: ${examined} gates examined — the Worker refuses to park LAND, the Mac script refuses to run it, and the row refuses DONE, each without a recorded plan approval and a recorded green check; land_on_green is seeded ON; a reply starting with "no" never approves, and only the requesting partner does.`);
}
