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
 *   9 · PRE-APPROVAL COMES FROM THE VERIFIED REQUEST ONLY (owner, 21 Sep 2026). `pre_approved_phrase`
 *       and `force_phrase` are written in exactly one place — `openWebPropertyChange`, from the ask
 *       the door parsed out of the partner's authenticated request — and nowhere in the runner; the
 *       door parses `parseWebPropertyAsk(input.subject, written)`, where `written` is
 *       `readableMessage(input.raw, …)` (the raw request, decoded, quote-stripped — never a reply);
 *       the parser reads only the WRITTEN part above a quote; `approveAtFiling` names the phrase in
 *       its finding, writes `plan_approved_by` as "<partner> (pre-approved in the request)", never
 *       writes `land_approved_at`, and calls `recordForce` only under `row.force_phrase`; the
 *       reader finds each phrase and none in a quoted original.
 *  10 · BUILT WITHOUT ASKING ONLY WHEN THERE IS NOTHING TO ASK (owner, 21 Sep 2026: "why does
 *       scooter need to pre-approve anything?"). `applyPlan` enters `proceedWithoutAsking` only
 *       under `asks.length === 0 && fresh.publish_ready === 1`; that path's finding says "built
 *       without asking"; and no other path writes `plan_approved_at` without a reading of the
 *       partner's reply or a pre-approval phrase — so a non-empty asks list can never reach BUILD
 *       without an approval.
 *  11 · THE PARTNER HEARS AT MOST ONCE PER CAUSE. `replyToRequester` checks `alreadyTold` before
 *       it sends and records the notice after; the kinds are exactly RECEIVED | PLAN | PREVIEW |
 *       QUESTION | STUCK | DONE (the 0221 CHECK and `NOTICE_KINDS` agree).
 *   6 · "NO" NEVER APPROVES (owner, 21 Sep 2026). `runWebPropertyChangeCard` reads the partner's
 *       answer through `readApprovalReply`, the REFUSED branch returns before `plan_approved_at`
 *       is written, and the answer is checked against the requesting partner first. And the real
 *       reader, loaded from `shared/work/approvalReply.ts`, reads "no" as REFUSED, "approved" as
 *       APPROVED, and a paragraph as ANSWERS.
 *
 *  12 · SEVERAL REPOS LAND ALL OR NOTHING (owner, 23 Sep 2026, migration 0236). `parkPhase`'s LAND
 *       branch refuses unless `notGreenParts` is empty; the Mac's `landGate` checks every part's
 *       recorded green; `run()` hands a multi-repo job to `runSeveral` only after `landGate(job)`;
 *       `runSeveral` reads every PR's checks live through `liveLandGate` before its first
 *       `~/bin/land`, and returns when it refuses; 0236's part trigger refuses a part's merge
 *       unless every sibling is green and the approvals are on the parent; its DONE trigger
 *       refuses DONE while any part is unmerged.
 *
 *  13 · EVERY SITE CHANGE PREVIEWS FIRST, AND THE DESK SHOWS IT (owner, 23 Sep 2026: "we should
 *       default to preview first for all repo work"). `openWebPropertyChange` binds preview_only to
 *       the literal 1 — never to the request's phrase — and its upsert can never lower it; migration
 *       0238 backfills preview_only = 1 on every unmerged row; the board payload
 *       (`handleWorkByOwner`) serves `web_property_change.preview_only AS site_preview_only`; the
 *       desk's read-only badge (`sitePreviewBadge`) reads exactly that column and nothing else, only
 *       for WEB_PROPERTY_CHANGE; WorkDesk renders it; and the "Show me first" switch keeps its own
 *       meaning (`work_card.preview_first`) — it neither reads nor writes preview_only.
 *
 * HARD-FAILS ON ZERO: zero gates examined exits 1.
 *
 * `--self-test` plants: the Worker's LAND branch with the approval check removed; with the green
 * check removed; the script's gate with the green test removed; `run()` landing before the gate;
 * the trigger without `check_green_at`; the rule seeded `off`; `applyBuild` landing regardless;
 * the runner approving without reading the reply; the REFUSED branch that no longer returns; a
 * reader that lets "no" through — and requires each to be caught. The shipped source must pass.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTsComments } from "./lib/strip-comments.mjs";
import { loadTs } from "./lib/load-ts.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKER = path.join(ROOT, "src", "worker", "services", "webPropertyChange.ts");
const SCRIPT = path.join(ROOT, "scripts", "duties", "web-property-change.mjs");
const MIGRATION = path.join(ROOT, "migrations", "0219_porter_changes_a_web_property_from_her_mac.sql");
const READER = path.join(ROOT, "src", "shared", "work", "approvalReply.ts");
const DOOR = path.join(ROOT, "src", "worker", "services", "dealIntake.ts");
const PARSER = path.join(ROOT, "src", "shared", "intake", "webPropertyChange.ts");
const REPLY = path.join(ROOT, "src", "worker", "services", "requestReply.ts");
const MIGRATION_0221 = path.join(ROOT, "migrations", "0221_porter_reads_the_email.sql");
const MIGRATION_0220 = path.join(ROOT, "migrations", "0220_a_plan_that_is_not_publish_ready_previews_first.sql");
const MIGRATION_0236 = path.join(ROOT, "migrations", "0236_one_website_job_can_span_several_repos.sql");
const MIGRATION_0238 = path.join(ROOT, "migrations", "0238_every_site_change_previews_first.sql");
const BOARD = path.join(ROOT, "src", "worker", "services", "workCards.ts");
const DESK = path.join(ROOT, "src", "client", "pages", "work", "WorkDesk.tsx");
const BADGE = path.join(ROOT, "src", "client", "pages", "work", "sitePreviewBadge.ts");
const read = (p) => stripTsComments(readFileSync(p, "utf8"));
/** SQL: `--` line comments blanked, so a comment naming a column cannot satisfy or fail the trigger check. */
function stripSqlComments(sql) {
  return String(sql ?? "").replace(/--[^\n]*/g, "");
}
const readSql = (p) => stripSqlComments(readFileSync(p, "utf8"));
/** 0238 with its statement whitespace collapsed, one clause replaced — for the self-test's plants. */
function sql0238Fixture(from, to) {
  return readSql(MIGRATION_0238).replace(/\s+/g, " ").replace(from, to);
}

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
  // PRE-APPROVAL: written only at the door's open, from the verified request.
  const opener = body(src, "export async function openWebPropertyChange(");
  // A WRITE: SQL `pre_approved_phrase = …` or an object literal `pre_approved_phrase: <value>` — not the row type's `: string | null`.
  const WRITE = /pre_approved_phrase\s*(?:=(?!=)|:\s*(?![\s]*string\b))/g;
  const writes = [...src.matchAll(WRITE)].length;
  const inOpener = opener ? [...opener.matchAll(WRITE)].length : 0;
  if (!opener || inOpener === 0) violations.push("openWebPropertyChange() no longer writes pre_approved_phrase — pre-approval has no source");
  if (writes > inOpener) violations.push(`pre_approved_phrase is written in ${writes - inOpener} place(s) outside openWebPropertyChange() — a later message or the other partner could pre-approve`);
  const filing = body(src, "async function approveAtFiling(");
  if (!filing) violations.push("approveAtFiling() is gone — a pre-approved plan would block for an answer that never comes, or worse, not");
  else {
    examined += 1;
    if (!/\(pre-approved in the request\)/.test(filing)) violations.push("approveAtFiling() does not record plan_approved_by as '(pre-approved in the request)'");
    if (!/appendFinding\([^;]*row\.pre_approved_phrase/.test(filing)) violations.push("approveAtFiling()'s finding does not name the pre-approval phrase");
    if (/land_approved_at/.test(filing)) violations.push("approveAtFiling() touches land_approved_at — a pre-approval would count as the preview's second approval");
    const forceAt = filing.indexOf("recordForce(");
    if (forceAt >= 0 && !/row\.force_phrase/.test(filing.slice(Math.max(0, forceAt - 400), forceAt))) violations.push("approveAtFiling() forces without the request's own force phrase");
  }
  // BUILT WITHOUT ASKING: only on asks=[] AND publish-ready, and said so.
  const plan = body(src, "async function applyPlan(");
  if (!plan) violations.push("applyPlan() is gone");
  else {
    examined += 1;
    const at = plan.indexOf("proceedWithoutAsking(");
    if (at < 0) violations.push("applyPlan() never proceeds without asking — a change with nothing to ask would still email the partner for approval");
    else if (!/if\s*\(asks\.length\s*===\s*0\s*&&\s*fresh\.publish_ready\s*===\s*1\)\s*return proceedWithoutAsking\(/.test(plan)) {
      violations.push("applyPlan() proceeds without asking on a condition other than asks=[] AND publish_ready — a card with a partner's decision, or placeholders, could build unasked");
    }
  }
  const proceed = body(src, "async function proceedWithoutAsking(");
  if (!proceed) violations.push("proceedWithoutAsking() is gone");
  else {
    examined += 1;
    if (!/built without asking/.test(proceed)) violations.push("proceedWithoutAsking() does not record 'built without asking' on the card");
    if (/land_approved_at|recordForce\(/.test(proceed)) violations.push("proceedWithoutAsking() touches the landing approval or the force — it may only approve the plan");
  }
  // Every plan_approved_at write is one of: the partner's reading, the pre-approval at filing, or nothing-to-ask.
  const approvalWrites = [...src.matchAll(/update\(env, card\.id, \{[^}]*plan_approved_at:\s*now/g)].length;
  if (approvalWrites !== 3) violations.push(`plan_approved_at is written in ${approvalWrites} place(s); exactly three are allowed (the partner's reply, pre-approval at filing, nothing to ask) — a fourth is an approval nobody gave`);
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

/** 12 · several repos land all or nothing — in the Worker, on the Mac, and at the row (0236). */
export function checkSeveral(worker, script, sql) {
  const violations = [];
  let examined = 0;
  const park = body(worker, "export async function parkPhase(");
  const landBranch = park?.match(/if\s*\(phase\s*===\s*"LAND"\)\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
  examined += 1;
  if (!/notGreenParts\(/.test(landBranch) || !/blocking\.length\)\s*return\s*\{\s*parked:\s*false/.test(landBranch)) violations.push("parkPhase()'s LAND branch does not refuse a multi-repo job while any part is not green");
  const gate = body(script, "export function landGate(") ?? "";
  examined += 1;
  if (!/isSeveral\(job\)/.test(gate) || !/job\.parts\.filter\([\s\S]*check_green_at[\s\S]*check_state === "GREEN"/.test(gate) || !/notGreen\.length\)\s*return\s*\{\s*ok:\s*false/.test(gate)) violations.push("landGate() does not require EVERY part's PR recorded green for a multi-repo job");
  const run = body(script, "export async function run(") ?? "";
  examined += 1;
  const gateAt = run.indexOf("landGate(job)");
  const handAt = run.indexOf("runSeveral(job");
  if (handAt < 0) violations.push("run() never hands a multi-repo job to runSeveral — it would run as one repo");
  else if (gateAt < 0 || gateAt > handAt) violations.push("run() hands a multi-repo job to runSeveral before landGate(job)");
  const several = body(script, "async function runSeveral(") ?? "";
  examined += 1;
  const liveAt = several.indexOf("liveLandGate(states)");
  const refuseAt = several.search(/if \(!live\.ok\) return/);
  const landAt = several.search(/sh\(land,/);
  if (!several) violations.push("web-property-change.mjs has no runSeveral()");
  else if (landAt < 0) violations.push("runSeveral() never runs ~/bin/land — a multi-repo LAND does nothing");
  else if (liveAt < 0 || refuseAt < 0 || liveAt > landAt || refuseAt > landAt) violations.push("runSeveral() reaches ~/bin/land before the live all-green gate refuses");
  const live = body(script, "export function liveLandGate(") ?? "";
  examined += 1;
  if (!/!s\.merged && s\.state !== "GREEN"/.test(live)) violations.push("liveLandGate() does not refuse on any unmerged PR that is not GREEN right now");
  const partTrigger = sql.match(/CREATE TRIGGER trg_web_property_change_part_lands_all_or_none[\s\S]*?END;/)?.[0] ?? "";
  examined += 1;
  if (!partTrigger) violations.push("0236 has no trg_web_property_change_part_lands_all_or_none — a part could be recorded merged while a sibling is red");
  else {
    if (!/s\.check_green_at IS NULL/.test(partTrigger) || !/s\.check_state IS NOT 'GREEN'/.test(partTrigger)) violations.push("the 0236 part trigger does not require every sibling part green");
    if (!/w\.plan_approved_at IS NOT NULL/.test(partTrigger)) violations.push("the 0236 part trigger does not require the plan approval");
    if (!/w\.land_approved_at IS NOT NULL/.test(partTrigger) || !/w\.forced_by IS NOT NULL/.test(partTrigger)) violations.push("the 0236 part trigger does not require the second approval (or a named force) on a previewing job");
    if (!/RAISE\(ABORT/.test(partTrigger)) violations.push("the 0236 part trigger does not abort");
  }
  const doneTrigger = sql.match(/CREATE TRIGGER trg_web_property_change_done_needs_every_part[\s\S]*?END;/)?.[0] ?? "";
  examined += 1;
  if (!doneTrigger || !/p\.merge_sha IS NULL/.test(doneTrigger) || !/RAISE\(ABORT/.test(doneTrigger)) violations.push("0236 does not refuse DONE while a part is unmerged");
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

export function checkDoor(door, parser) {
  const violations = [];
  let examined = 0;
  if (!/export async function openAssignmentCard\(/.test(door)) violations.push("openAssignmentCard() is gone");
  else {
    examined += 1;
    /*
     * THE ASK IS PARSED FROM THE WRITTEN PART OF THE REQUEST'S OWN TEXT BODY — never a later
     * message. Until 0226 (22 Sep 2026) `openAssignmentCard` decoded `input.raw` inline
     * (`textBodyOf` then `splitQuoted().written`); it now calls the shared `readableMessage()`
     * (also `dealIntake.ts`, so a single door cannot drift from its own decode), which does the
     * identical two steps under one name — `raw.slice(0, 4000)` used to be typed out separately in
     * three doors, and one shared reader is the fix. Checked in two parts so a `readableMessage`
     * that quietly stopped decoding, or a door that stopped calling it, is caught either way.
     */
    const doorChain = /const written = readableMessage\(input\.raw[\s\S]*?parseWebPropertyAsk\(input\.subject,\s*written\)/.test(door);
    if (!doorChain) violations.push("the door does not parse the web ask from the partner's own raw request (readableMessage(input.raw) → parseWebPropertyAsk) — pre-approval could come from elsewhere");
    const readerChain = /function readableMessage\([^)]*\)[\s\S]{0,200}?textBodyOf\(raw[\s\S]*?splitQuoted\(text\)\.written/.test(door);
    if (!readerChain) violations.push("readableMessage() no longer decodes via textBodyOf() → splitQuoted().written — the door's request text would be undecoded or would include the quoted original");
  }
  const parse = body(parser, "export function parseWebPropertyAsk(");
  if (!parse) violations.push("parseWebPropertyAsk() is gone");
  else {
    examined += 1;
    if (!/preApprovalIn\(written\)/.test(parse) || !/forcePhraseIn\(written\)/.test(parse)) violations.push("parseWebPropertyAsk() reads the pre-approval or force phrase from the whole text, not only what the partner wrote above a quote");
  }
  return { violations, examined };
}

export function checkNotices(reply, sql0221) {
  const violations = [];
  let examined = 0;
  const start = reply.indexOf("export async function replyToRequester(");
  const fn = start < 0 ? null : reply.slice(start, reply.indexOf("\nexport ", start + 10) < 0 ? undefined : reply.indexOf("\nexport ", start + 10));
  if (!fn) violations.push("replyToRequester() is gone");
  else {
    examined += 1;
    const told = fn.indexOf("alreadyTold(");
    const send = fn.indexOf("sendOrPreview(");
    const rec = fn.indexOf("recordNotice(");
    if (told < 0 || send < 0 || told > send) violations.push("replyToRequester() does not check alreadyTold before it sends — the same cause could email twice");
    if (rec < 0 || rec < send) violations.push("replyToRequester() does not record the notice after sending");
  }
  const kindsTs = reply.match(/export type NoticeKind = ([^;]+);/)?.[1]?.match(/"([A-Z]+)"/g)?.map((k) => k.replace(/"/g, "")) ?? [];
  const kindsSql = sql0221.match(/kind\s+TEXT NOT NULL CHECK \(kind IN \(([^)]+)\)\)/)?.[1]?.match(/'([A-Z]+)'/g)?.map((k) => k.replace(/'/g, "")) ?? [];
  examined += 1;
  const want = ["RECEIVED", "PLAN", "PREVIEW", "QUESTION", "STUCK", "DONE"];
  if (kindsTs.join(",") !== want.join(",")) violations.push(`NoticeKind is ${kindsTs.join("|") || "(none)"}; the reply kinds are exactly ${want.join("|")}`);
  if (kindsSql.join(",") !== want.join(",")) violations.push(`0221's work_card_notice CHECK admits ${kindsSql.join("|") || "(none)"}; it must be exactly ${want.join("|")}`);
  if (!/UNIQUE \(work_card_id, kind, cause\)/.test(sql0221)) violations.push("0221 has no UNIQUE (work_card_id, kind, cause) — the row would allow a second email for the same cause");
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

/** 13 · Preview first on every site change, and one truth for it on the desk. */
export function checkPreviewDefault({ worker, sql0238, board, desk, badge }) {
  const violations = [];
  let examined = 0;
  const opener = body(worker, "export async function openWebPropertyChange(");
  if (!opener) violations.push("openWebPropertyChange() is gone — nothing writes the preview default");
  else {
    examined += 1;
    const bind = opener.match(/INSERT INTO web_property_change \([^)]*\bpreview_only\)[\s\S]*?\.bind\(([^;]*?)\)\s*\.run\(\)/)?.[1];
    if (!bind) violations.push("openWebPropertyChange() no longer inserts preview_only — a site change would open without its preview");
    else {
      const last = bind.split(",").pop().trim();
      if (last !== "1") violations.push(`openWebPropertyChange() binds preview_only to \`${last}\`, not the literal 1 — a site change could open without a preview (owner, 23 Sep 2026: preview first for all repo work)`);
    }
    if (/preview_first/.test(opener)) violations.push("openWebPropertyChange() reads preview_first — the request's phrase no longer decides the preview; it is always on");
    if (!/preview_only\s*=\s*MAX\(web_property_change\.preview_only,\s*excluded\.preview_only\)/.test(opener)) violations.push("openWebPropertyChange()'s upsert no longer keeps preview_only at MAX(old, new) — a re-read could clear the preview");
  }
  if (!sql0238) violations.push("migration 0238 is missing — site changes already in flight keep preview_only = 0");
  else {
    examined += 1;
    if (!/UPDATE\s+web_property_change\s+SET\s+preview_only\s*=\s*1\b[\s\S]*?WHERE\s+merge_sha\s+IS\s+NULL/.test(sql0238)) violations.push("0238 does not set preview_only = 1 on every unmerged web_property_change row");
  }
  examined += 1;
  if (!/LEFT JOIN web_property_change wpc ON wpc\.work_card_id = wc\.id/.test(board) || !/wpc\.preview_only AS site_preview_only/.test(board)) violations.push("handleWorkByOwner() does not serve web_property_change.preview_only as site_preview_only — the desk cannot show the site's preview gate");
  const fn = body(badge, "export function sitePreviewBadge(");
  if (!fn) violations.push("sitePreviewBadge() is gone — the desk shows no site preview gate");
  else {
    examined += 1;
    if (!/card\.site_preview_only\s*===\s*1/.test(fn)) violations.push("sitePreviewBadge() does not read site_preview_only — the badge would not show the site's real gate");
    if (/preview_first/.test(fn)) violations.push("sitePreviewBadge() reads preview_first — two flags again; the badge must read the site gate only");
    if (!/card\.kind\s*!==\s*WEB_PROPERTY_CHANGE_KIND\)\s*return null/.test(fn)) violations.push("sitePreviewBadge() is not limited to WEB_PROPERTY_CHANGE cards");
  }
  examined += 1;
  if (!/const sitePreview = sitePreviewBadge\(c\)/.test(desk) || !/\{sitePreview\.text\}/.test(desk)) violations.push("WorkDesk does not render sitePreviewBadge() — the site's preview gate is invisible on the desk");
  if (!/const previewOn = c\.preview_first === 1;/.test(desk)) violations.push("the desk's \"Show me first\" switch no longer reads work_card.preview_first — its meaning (hold the result for her) changed");
  const toggle = body(desk, "async function togglePreviewFirst(");
  if (!toggle || /preview_only/.test(toggle) || !/preview_first:\s*next/.test(toggle)) violations.push("togglePreviewFirst() no longer writes only preview_first — the switch could turn off a site's preview gate, a land bypass nobody named");
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
  for (const phrase of ["your call", "you decide", "no need to ask", "just do it", "pick everything", "no options"]) {
    examined += 1;
    if (mod.preApprovalIn(`Update the site with the package. ${phrase}, thanks.`) !== phrase) violations.push(`preApprovalIn does not find "${phrase}"`);
  }
  if (mod.preApprovalIn("please update the team page") !== null) violations.push("preApprovalIn pre-approves a request that said nothing of the kind");
  if (mod.forcePhraseIn("your call, and approved to production please") !== "approved to production") violations.push("forcePhraseIn does not find the force phrase in a request");
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
  const door = read(DOOR);
  const parser = read(PARSER);
  const reply = read(REPLY);
  const sql0221 = readSql(MIGRATION_0221);
  const sql0236 = readSql(MIGRATION_0236);
  const pd = { worker, sql0238: readSql(MIGRATION_0238), board: read(BOARD), desk: read(DESK), badge: read(BADGE) };
  const real = [checkWorker(worker), checkScript(script), checkMigration(sql), checkMigration0220(sql0220), await checkReader(reader), checkDoor(door, parser), checkNotices(reply, sql0221), checkSeveral(worker, script, sql0236), checkPreviewDefault(pd)];
  say(real.every((r) => r.violations.length === 0) && real.reduce((n, r) => n + r.examined, 0) >= 8, `shipped source passes (${real.reduce((n, r) => n + r.examined, 0)} gates): ${real.flatMap((r) => r.violations).join("; ")}`);

  const unaskedWithAsks = worker.replace("if (asks.length === 0 && fresh.publish_ready === 1) return proceedWithoutAsking(", "if (fresh.publish_ready === 1) return proceedWithoutAsking(");
  say(checkWorker(unaskedWithAsks).violations.some((v) => /condition other than asks=\[\]/.test(v)), "a plan that builds unasked with a partner's decision on it is caught");
  const unaskedNotReady = worker.replace("if (asks.length === 0 && fresh.publish_ready === 1) return proceedWithoutAsking(", "if (asks.length === 0) return proceedWithoutAsking(");
  say(checkWorker(unaskedNotReady).violations.some((v) => /condition other than asks=\[\]/.test(v)), "a plan that builds unasked while not publish-ready is caught");
  const fourthApproval = worker.replace("await update(env, card.id, { merge_sha: report.merge_sha,", "await update(env, card.id, { plan_approved_at: now, merge_sha: report.merge_sha,");
  say(checkWorker(fourthApproval).violations.some((v) => /exactly three are allowed/.test(v)), "a fourth plan_approved_at write (an approval nobody gave) is caught");
  const twiceReply = reply.replace("if (notice && (await alreadyTold(env, card.id, notice.kind, notice.cause))) {", "if (false) {");
  say(checkNotices(twiceReply, sql0221).violations.some((v) => /email twice/.test(v)), "a reply path that no longer checks alreadyTold is caught");
  const extraKind = sql0221.replace("'STUCK', 'DONE'", "'STUCK', 'NUDGE', 'DONE'");
  say(checkNotices(reply, extraKind).violations.some((v) => /must be exactly/.test(v)), "a notice kind outside the six is caught");
  const laterPreApproval = worker.replace("await update(env, card.id, { land_approved_at: now, land_approved_by:", "await update(env, card.id, { pre_approved_phrase: answer, land_approved_at: now, land_approved_by:");
  say(checkWorker(laterPreApproval).violations.some((v) => /outside openWebPropertyChange/.test(v)), "a runner that writes pre_approved_phrase from a later message is caught");
  const filingLands = worker.replace('plan_approved_by: approvedBy,\n    phase: "BUILD",', 'plan_approved_by: approvedBy,\n    land_approved_at: now,\n    phase: "BUILD",');
  say(checkWorker(filingLands).violations.some((v) => /touches land_approved_at/.test(v)), "a pre-approval that also approves the landing is caught");
  const noPhrase = worker.replace('("${row.pre_approved_phrase}"): every decision', "(pre-approved): every decision");
  say(checkWorker(noPhrase).violations.some((v) => /does not name the pre-approval phrase/.test(v)), "a finding that hides the phrase is caught");
  const doorFromElsewhere = door.replace("parseWebPropertyAsk(input.subject, written)", "parseWebPropertyAsk(input.subject, laterReply)");
  say(checkDoor(doorFromElsewhere, parser).violations.some((v) => /partner's own raw request/.test(v)), "a door that parses something other than the verified request is caught");
  const quotedPreApproval = parser.replace("preApprovalIn(written)", "preApprovalIn(text)");
  say(checkDoor(door, quotedPreApproval).violations.some((v) => /above a quote/.test(v)), "a parser that reads a quoted 'your call' is caught");

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

  // 12 · several repos, all or nothing (0236).
  const parkNoParts = worker.replace("if (blocking.length) return { parked: false,", "if (false) return { parked: false,");
  say(checkSeveral(parkNoParts, script, sql0236).violations.some((v) => /any part is not green/.test(v)), "a Worker LAND gate that parks a multi-repo job with a red part is caught");
  const gateNoParts = script.replace("if (notGreen.length) return { ok: false,", "if (false) return { ok: false,");
  say(checkSeveral(worker, gateNoParts, sql0236).violations.some((v) => /EVERY part's PR/.test(v)), "a Mac gate that lands several repos without every part green is caught");
  const handEarly = script.replace("if (isSeveral(job)) return runSeveral(job, ctx);", "").replace("const phase = job.phase;\n", "const phase = job.phase;\n  if (isSeveral(job)) return runSeveral(job, ctx);\n");
  say(checkSeveral(worker, handEarly, sql0236).violations.some((v) => /before landGate/.test(v)), "run() handing a multi-repo LAND to runSeveral before the gate is caught");
  const noLive = script.replace("if (!live.ok) return", "if (false) void");
  say(checkSeveral(worker, noLive, sql0236).violations.some((v) => /live all-green gate/.test(v)), "runSeveral() landing without the live all-green refusal is caught");
  const liveLoose = script.replace('!s.merged && s.state !== "GREEN"', '!s.merged && s.state === "RED"');
  say(checkSeveral(worker, liveLoose, sql0236).violations.some((v) => /right now/.test(v)), "a live gate that lets a PENDING PR through is caught");
  const trigLoose = sql0236.replace("s.check_green_at IS NULL OR ", "");
  say(checkSeveral(worker, script, trigLoose).violations.some((v) => /every sibling part green/.test(v)), "a part trigger that no longer requires every sibling green is caught");
  const trigNoPreview = sql0236.replace(" OR w.land_approved_at IS NOT NULL", "");
  say(checkSeveral(worker, script, trigNoPreview).violations.some((v) => /second approval/.test(v)), "a part trigger that forgets the preview's second approval is caught");
  const noDone = sql0236.replace(/CREATE TRIGGER trg_web_property_change_done_needs_every_part[\s\S]*?END;/, "");
  say(checkSeveral(worker, script, noDone).violations.some((v) => /DONE while a part is unmerged/.test(v)), "a missing every-part DONE trigger is caught");

  const pdCaught = (patch, re, what) => say(checkPreviewDefault({ ...pd, ...patch }).violations.some((v) => re.test(v)), what);
  pdCaught({ worker: worker.replace("input.ask.force ?? null, 1)", "input.ask.force ?? null, input.ask.preview_first ? 1 : 0)") }, /not the literal 1/, "an opener that previews only on the request's phrase is caught");
  pdCaught({ worker: worker.replace("preview_only = MAX(web_property_change.preview_only, excluded.preview_only)", "preview_only = excluded.preview_only") }, /MAX\(old, new\)/, "an upsert that can clear the preview is caught");
  pdCaught({ sql0238: sql0238Fixture("WHERE merge_sha IS NULL", "WHERE phase = 'PLAN'") }, /unmerged/, "a 0238 that misses in-flight rows is caught");
  pdCaught({ sql0238: "" }, /0238 is missing/, "a missing 0238 is caught");
  pdCaught({ board: pd.board.replace("wpc.preview_only AS site_preview_only", "wc.preview_first AS site_preview_only") }, /site_preview_only/, "a board that serves preview_first as the site gate is caught");
  pdCaught({ badge: pd.badge.replace("card.site_preview_only === 1", "card.preview_first === 1") }, /site_preview_only|preview_first/, "a badge that reads preview_first is caught");
  pdCaught({ badge: pd.badge.replace("if (card.kind !== WEB_PROPERTY_CHANGE_KIND) return null;", "") }, /limited to WEB_PROPERTY_CHANGE/, "a badge shown on every kind is caught");
  pdCaught({ desk: pd.desk.replace("{sitePreview.text}", "") }, /does not render sitePreviewBadge/, "a desk that never draws the badge is caught");
  pdCaught({ desk: pd.desk.replace("const previewOn = c.preview_first === 1;", "const previewOn = c.site_preview_only === 1;") }, /Show me first/, "a switch repointed at the site gate is caught");
  pdCaught({ desk: pd.desk.replace("body: { preview_first: next },", "body: { preview_first: next, preview_only: next },") }, /land bypass/, "a switch that writes preview_only is caught");

  if (failed > 0) process.exit(1);
  console.log("SELF-TEST PASSED: fifty planted defects are each caught; the shipped source passes.");
}

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  const results = [checkWorker(read(WORKER)), checkScript(read(SCRIPT)), checkMigration(readSql(MIGRATION)), checkMigration0220(readSql(MIGRATION_0220)), await checkReader(await loadTs(READER)), checkDoor(read(DOOR), read(PARSER)), checkNotices(read(REPLY), readSql(MIGRATION_0221)), checkSeveral(read(WORKER), read(SCRIPT), readSql(MIGRATION_0236)), checkPreviewDefault({ worker: read(WORKER), sql0238: existsSync(MIGRATION_0238) ? readSql(MIGRATION_0238) : "", board: read(BOARD), desk: read(DESK), badge: read(BADGE) })];
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
  console.log(`NO-LAND-WITHOUT-APPROVAL SCAN PASSED: ${examined} gates examined — the Worker refuses to park LAND, the Mac script refuses to run it, and the row refuses DONE, each without a recorded plan approval and a recorded green check; land_on_green is seeded ON; a reply starting with "no" never approves, "preview" never lands, a previewing change needs a second approval after the preview email OR a named force ("approved to production") — never neither — pre-approval comes only from the partner's own verified request, only the requesting partner gives any of them, a job over several repos lands every PR or none, and every site change previews first with the desk showing that gate from its own column.`);
}
