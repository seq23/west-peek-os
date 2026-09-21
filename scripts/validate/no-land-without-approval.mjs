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
 *   7 · A PREVIEW NEEDS A SECOND APPROVAL (owner, 21 Sep 2026). `parkPhase`'s LAND branch refuses
 *       a row where `needsPreview(row)` and `land_approved_at` is null; the runner writes
 *       `land_approved_at` only under a fresh `readApprovalReply` that read APPROVED, against
 *       `preview_emailed_at`; `applyBuild` blocks on the preview before it can queue LAND on green;
 *       the real reader reads "preview" as PREVIEW (never APPROVED); migration 0220's trigger
 *       refuses `merge_sha` on a previewing row with no `land_approved_at`; the Mac script's
 *       `landGate` refuses a job that previews without `land_approved_at`.
 *   8 · THE FORCE IS NAMED, EXPLICIT AND THE REQUESTER'S (owner, 21 Sep 2026). A not-ready card
 *       reaches LAND only with a second approval after the preview OR a force record — never
 *       neither: the LAND gate's condition names both `land_approved_at` and `forced_by`; every
 *       `recordForce(` call sits under a reading that read FORCED; the reader reads "approved to
 *       production" as FORCED and plain "approved" as APPROVED (never FORCED); 0220's merge trigger
 *       admits `forced_by` beside `land_approved_at`, and its second trigger refuses a `forced_by`
 *       whose address is not the card's `requested_by_email`; the Mac gate admits `forced_by`.
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
const MIGRATION_0220 = path.join(ROOT, "migrations", "0220_a_plan_that_is_not_publish_ready_previews_first.sql");
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
      if (!/needsPreview\(row\)\s*&&\s*!row\.land_approved_at/.test(landBranch)) violations.push("parkPhase()'s LAND branch does not refuse a previewing change without row.land_approved_at — a not-ready plan could land on green");
      if (!/needsPreview\(row\)\s*&&\s*!row\.land_approved_at\s*&&\s*!row\.forced_by/.test(landBranch)) violations.push("parkPhase()'s LAND branch does not name BOTH ways past the preview (land_approved_at OR forced_by) — a named force could not land, or a nameless one could");
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
    // THE FORCE is recorded only under a reading that read FORCED — never from a plain "approved".
    const forceSites = [...runner.matchAll(/recordForce\(/g)].map((m) => m.index);
    if (forceSites.length === 0) violations.push("the runner never records a force — the named bypass does not exist");
    for (const at of forceSites) {
      const before = runner.slice(Math.max(0, at - 260), at);
      if (!/kind\s*===\s*"FORCED"/.test(before)) violations.push("recordForce() is called without a reading that read FORCED — a plain \"approved\" could force a not-ready plan to production");
    }
    // The SECOND approval: written only from a fresh reading of a reply after the preview email.
    const landAt = runner.indexOf("land_approved_at: now");
    if (landAt < 0) violations.push("the runner never records land_approved_at — a previewing change could never land");
    else {
      const before = runner.slice(Math.max(0, landAt - 2600), landAt);
      if (!/answerSince\(card,\s*row\.preview_emailed_at\)/.test(before)) violations.push("land_approved_at is not read against the preview email's time — an earlier 'approved' (the plan's) would count as the second");
      if (!/landReading\?\.kind\s*!==\s*"APPROVED"/.test(before)) violations.push("land_approved_at is written without requiring the reply to read APPROVED — 'preview' or 'no' after the preview would land");
      if (!/fromRequester/.test(before)) violations.push("the second approval is not checked against the requesting partner");
    }
  }
  const build = body(src, "async function applyBuild(");
  if (!build) violations.push("applyBuild() is gone");
  else {
    examined += 1;
    if (!/isOn\(rules\.land_on_green\)/.test(build)) violations.push("applyBuild() no longer reads the land_on_green rule before queueing LAND");
    const previewAt = build.indexOf("needsPreview(fresh) && !fresh.land_approved_at");
    const greenAt = build.indexOf("isOn(rules.land_on_green)");
    if (previewAt < 0) violations.push("applyBuild() does not stop a previewing change at the preview — land-on-green would land a plan that ships placeholders");
    else if (greenAt >= 0 && previewAt > greenAt) violations.push("applyBuild() reads land-on-green before the preview stop — the rule would override the preview");
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
    if (!/land_approved_at/.test(gate) || !/publish_ready|preview_only/.test(gate)) violations.push("landGate() does not refuse a previewing job without land_approved_at");
    if (!/forced_by/.test(gate)) violations.push("landGate() does not admit a named force — a forced landing would be refused on the Mac, or the Mac would ignore the force record");
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

export function checkMigration0220(sql) {
  const violations = [];
  let examined = 0;
  const trigger = sql.match(/CREATE TRIGGER trg_web_property_change_preview_needs_second_approval([\s\S]*?)END;/)?.[1];
  if (!trigger) violations.push("0220 has no trg_web_property_change_preview_needs_second_approval trigger");
  else {
    examined += 1;
    if (!/NEW\.publish_ready\s*=\s*0/.test(trigger) || !/NEW\.preview_only\s*=\s*1/.test(trigger)) violations.push("the 0220 trigger does not cover both a not-ready plan and a preview-only one");
    if (!/NEW\.land_approved_at IS NULL/.test(trigger)) violations.push("the 0220 trigger does not require land_approved_at");
    if (!/NEW\.forced_by IS NULL/.test(trigger)) violations.push("the 0220 merge trigger does not admit a named force beside the second approval");
    if (!/RAISE\(ABORT/.test(trigger)) violations.push("the 0220 trigger does not abort");
  }
  const force = sql.match(/CREATE TRIGGER trg_web_property_change_force_is_the_requester([\s\S]*?)END;/)?.[1];
  if (!force) violations.push("0220 has no trg_web_property_change_force_is_the_requester trigger — anyone could be recorded as the forcer");
  else {
    examined += 1;
    if (!/requested_by_email\)\s*=\s*lower\(f\.email\)/.test(force) || !/f\.id\s*=\s*NEW\.forced_by/.test(force)) violations.push("the force trigger does not check the forcer's address against the card's requested_by_email");
    if (!/RAISE\(ABORT/.test(force)) violations.push("the force trigger does not abort");
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
    ["preview", "PREVIEW"], ["Preview only", "PREVIEW"], ["preview first", "PREVIEW"],
    ["approved to production", "FORCED"], ["Approved to production.", "FORCED"], ["force production", "FORCED"], ["ship it anyway", "FORCED"], ["land anyway", "FORCED"],
    ["approved", "APPROVED"], ["approved!", "APPROVED"],
  ];
  for (const [text, want] of cases) {
    examined += 1;
    const got = mod.readApprovalReply(text)?.kind;
    if (got !== want) violations.push(`readApprovalReply(${JSON.stringify(text)}) reads ${got}, expected ${want}`);
  }
  if (mod.approvedAnswers([{ question: "q", recommended: "r" }])[0]?.includes("r") !== true) violations.push("approvedAnswers does not take the recommended default");
  if (mod.readApprovalReply("preview")?.kind === "APPROVED") violations.push("readApprovalReply reads \"preview\" as APPROVED — a preview request would land");
  if (mod.readApprovalReply("approved")?.kind === "FORCED") violations.push("readApprovalReply reads plain \"approved\" as FORCED — a plain approval would skip the preview");
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
  const sql0220 = readSql(MIGRATION_0220);
  const real = [checkWorker(worker), checkScript(script), checkMigration(sql), checkMigration0220(sql0220), await checkReader(reader)];
  say(real.every((r) => r.violations.length === 0) && real.reduce((n, r) => n + r.examined, 0) >= 8, `shipped source passes (${real.reduce((n, r) => n + r.examined, 0)} gates): ${real.flatMap((r) => r.violations).join("; ")}`);

  const noSecondGate = worker.replace(/if \(needsPreview\(row\) && !row\.land_approved_at && !row\.forced_by\) return \{ parked: false[^\n]*\n/, "");
  say(checkWorker(noSecondGate).violations.some((v) => /previewing change without row\.land_approved_at/.test(v)), "a LAND gate that forgets the second approval is caught");
  const secondFromPlan = worker.replace("answerSince(card, row.preview_emailed_at)", "answerSince(card, row.plan_filed_at)");
  say(checkWorker(secondFromPlan).violations.some((v) => /preview email's time/.test(v)), "a second approval read against the plan's time (the first 'approved' counting twice) is caught");
  const previewLands = worker.replace('if (landReading?.kind !== "APPROVED") {', "if (false) {");
  say(checkWorker(previewLands).violations.some((v) => /without requiring the reply to read APPROVED/.test(v)), "a runner that lands on any reply after the preview is caught");
  const greenOverridesPreview = worker.replace("if (needsPreview(fresh) && !fresh.land_approved_at && !fresh.forced_by) {", "if (false) {");
  say(checkWorker(greenOverridesPreview).violations.some((v) => /stop a previewing change at the preview/.test(v)), "land-on-green overriding the preview is caught");
  const previewReader = { ...reader, readApprovalReply: (t) => (String(t).trim().toLowerCase() === "preview" ? { kind: "APPROVED" } : reader.readApprovalReply(t)) };
  say((await checkReader(previewReader)).violations.some((v) => /"preview"/.test(v)), "a reader that lets \"preview\" approve a landing is caught");
  const triggerLoose0220 = sql0220.replace("AND NEW.land_approved_at IS NULL", "");
  say(checkMigration0220(triggerLoose0220).violations.some((v) => /land_approved_at/.test(v)), "a 0220 trigger that no longer requires the second approval is caught");
  const forceAnywhere = worker.replace('if (landReading?.kind === "FORCED") {', "if (landReading) {");
  say(checkWorker(forceAnywhere).violations.some((v) => /recordForce\(\) is called without a reading that read FORCED/.test(v)), "a runner that forces on any reply after the preview is caught");
  const gateNoForce = worker.replace("if (needsPreview(row) && !row.land_approved_at && !row.forced_by) return { parked: false", "if (needsPreview(row) && !row.land_approved_at) return { parked: false");
  say(checkWorker(gateNoForce).violations.some((v) => /BOTH ways past the preview/.test(v)), "a LAND gate that does not name the force is caught");
  const plainForces = { ...reader, readApprovalReply: (t) => (String(t).trim().toLowerCase() === "approved" ? { kind: "FORCED" } : reader.readApprovalReply(t)) };
  say((await checkReader(plainForces)).violations.some((v) => /plain "approved" as FORCED|"approved"\) reads FORCED/.test(v)), "a reader that lets plain \"approved\" force production is caught");
  const anyForcer = sql0220.replace("AND (c.requested_by_email IS NULL OR lower(c.requested_by_email) = lower(f.email))", "");
  say(checkMigration0220(anyForcer).violations.some((v) => /forcer's address/.test(v)), "a force trigger that no longer checks the requester is caught");
  const scriptNoSecond = script.replace(/if \(needsPreview && !job\?\.pr\?\.land_approved_at && !job\?\.pr\?\.forced_by\)[^\n]*\n/, "");
  say(checkScript(scriptNoSecond).violations.some((v) => /previewing job without land_approved_at/.test(v)), "a Mac gate that lands a previewing job without the second approval is caught");

  const noReading = worker.replace("const reading = readApprovalReply(answer);", "const reading = { kind: \"APPROVED\" };");
  // With the plan's reading gone, the only `readApprovalReply(answer)` left is the preview stage's — after plan_approved_at.
  say(checkWorker(noReading).violations.some((v) => /without reading the reply|before it reads the reply/.test(v)), "a runner that approves without reading the reply is caught");
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
  console.log("SELF-TEST PASSED: twenty-two planted defects are each caught; the shipped source passes.");
}

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  const results = [checkWorker(read(WORKER)), checkScript(read(SCRIPT)), checkMigration(readSql(MIGRATION)), checkMigration0220(readSql(MIGRATION_0220)), await checkReader(await loadTs(READER))];
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
  console.log(`NO-LAND-WITHOUT-APPROVAL SCAN PASSED: ${examined} gates examined — the Worker refuses to park LAND, the Mac script refuses to run it, and the row refuses DONE, each without a recorded plan approval and a recorded green check; land_on_green is seeded ON; a reply starting with "no" never approves, "preview" never lands, a previewing change needs a second approval after the preview email OR a named force ("approved to production") — never neither — and only the requesting partner gives any of them.`);
}
