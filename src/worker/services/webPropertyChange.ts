import type { Env } from "../env";
import { json, type RouteContext } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity } from "./authorize";
import { blockCard } from "./blocks";
import { deliver } from "./deliverables";
import { handOver } from "./employeeWork";
import { parkRun, readRun, type SeatRunRow } from "../ai/subscriptionSeats";
import { partnerByEmail } from "../../shared/registry/partners";
import type { SweepCard } from "./workSweep";
import { readWebPropertyAsk, type WebPropertyAsk } from "../../shared/intake/webPropertyChange";
import {
  CLAUDE_MODEL_ALIASES,
  LOCAL_JOB_RUN_KIND,
  WEB_PROPERTY_CHANGE_KIND,
  localJobKind,
  readLocalJobReport,
  type ClaudeModelAlias,
  type LocalJobPayload,
  type LocalJobReport,
  type WebPropertyChangePhase,
} from "../../shared/work/localJobs";

/**
 * A WEB PROPERTY CHANGE, worked by Porter on her Mac (20 Sep 2026, Plan A).
 *
 * ─── WHAT THIS IS ────────────────────────────────────────────────────────────────────────────
 *
 * Scooter or Sequoia emails os@joinwestpeek.com a Drive folder and instructions. The door
 * (`dealIntake.openAssignmentCard`) reads the folder and the property, hands the card to Porter
 * and opens the `web_property_change` row (migration 0219). This file is the RUNNER the sweep
 * hands the card to on every tick — and the runner does no model work itself. It decides which
 * PHASE is next, parks ONE run for the Mac, and reads what the Mac reported.
 *
 * THREE PHASES, EACH A FRESH CLAUDE CODE CONTEXT ON HER MAC:
 *
 *   PLAN   pull the package with the service account, read the target repo's RUNBOOK.md (BLOCK
 *          if absent), write the plan as a Document on the card with decisions split into
 *          DECIDED (structure, CSS, validators, redirects, assets, build wiring — decided and
 *          recorded) and ASK (brand or colourway, copy meaning, legal or regulatory wording,
 *          removing a public claim, image rights, money — asked). The card goes BLOCKED with the
 *          asks, emailed to the REQUESTING partner; Scooter answers Scooter's questions.
 *   BUILD  in a git worktree of the target repo: the change, the repo's own validators green,
 *          screenshots at desktop and 390px, every new external link curled, a PR opened. The
 *          duty script — not the model — reads `gh pr checks` and reports the check state.
 *   LAND   refused unless the card carries a recorded plan approval AND a recorded green check
 *          (`validate:no-land-without-approval` pins this in the Worker and in the script).
 *          `~/bin/land <pr>` merges, watches main, deploys; the DONE email carries the curl proof.
 *
 * ─── THE LEASE ───────────────────────────────────────────────────────────────────────────────
 *
 * `web_property_change.current_run_id` is the run the Mac holds. While it is QUEUED or CLAIMED
 * the runner does nothing but say so — no attempt is spent, no second run is parked, and the
 * general loop never sees the card. The partial unique index in 0219 makes "one live run per
 * card" true at the row even if this code is wrong.
 *
 * ─── APPROVAL THAT RESUMES ───────────────────────────────────────────────────────────────────
 *
 * The block's ANSWER door (`services/blocks.ts`) writes `block_answer` and `block_answered_at`
 * and reopens the card. A partner's EMAIL reply lands on the same door through
 * `emailThread.steerFromReply`. The runner reads the answer time against the plan's filing time
 * and records the approval; nothing here waits on a second reply once the PR is green, because
 * land-on-green is her rule (rule row `land_on_green`, ON).
 */

export interface WebPropertyChangeRow {
  work_card_id: string;
  target_repo: string;
  property_host: string | null;
  drive_folder_id: string | null;
  drive_folder_url: string | null;
  ask: string;
  phase: WebPropertyChangePhase | "DONE";
  plan_deliverable_id: string | null;
  plan_document_id: string | null;
  plan_filed_at: string | null;
  decided_json: string;
  asks_json: string;
  answers_json: string;
  plan_approved_at: string | null;
  plan_approved_by: string | null;
  pr_url: string | null;
  pr_number: number | null;
  branch: string | null;
  check_state: "PENDING" | "GREEN" | "RED" | null;
  check_url: string | null;
  check_green_at: string | null;
  build_proof: string | null;
  merge_sha: string | null;
  landed_at: string | null;
  live_proof: string | null;
  current_run_id: string | null;
  run_history_json: string;
  last_report: string | null;
  firm_scope: string;
  created_at: string;
  updated_at: string;
}

export interface WebPropertyChangeCard extends SweepCard {
  request_json?: string | null;
  description?: string | null;
  block_answer?: string | null;
  block_answered_at?: string | null;
  block_answered_by?: string | null;
}

export const PORTER_ID = "aie_porter";
export const PORTER_NAME = "Porter";

// ── Rules ─────────────────────────────────────────────────────────────────────────────────────

export interface KindRule {
  kind: string;
  rule_key: string;
  label: string;
  value: string;
  editable: number;
  note: string;
  set_by: string | null;
  set_at: string;
}

/** The standing rules of a kind, as rows. Seeded by 0219; a Managing Partner edits the editable ones. */
export async function rulesFor(env: Env, kind: string): Promise<Record<string, string>> {
  const rows = (
    await env.WP_OS_DB.prepare("SELECT rule_key, value FROM work_kind_rule WHERE kind = ?1").bind(kind).all<{ rule_key: string; value: string }>()
  ).results ?? [];
  return Object.fromEntries(rows.map((r) => [r.rule_key, r.value]));
}

export function isOn(value: string | undefined): boolean {
  return ["on", "1", "true", "yes"].includes((value ?? "").trim().toLowerCase());
}

/**
 * THE ONE READER of the model-per-phase decision. The rule row when it names a real alias, the
 * registry's default otherwise. A typo in a rule row degrades to the default rather than to a
 * CLI error on her Mac at two in the morning.
 */
export function phaseModel(rules: Record<string, string>, phase: WebPropertyChangePhase): ClaudeModelAlias {
  const spec = localJobKind(WEB_PROPERTY_CHANGE_KIND)!;
  const fromRule = (rules[`model_${phase.toLowerCase()}`] ?? "").trim().toLowerCase();
  return (CLAUDE_MODEL_ALIASES as readonly string[]).includes(fromRule) ? (fromRule as ClaudeModelAlias) : spec.phases[phase].model;
}

// ── Opening ───────────────────────────────────────────────────────────────────────────────────

/** Open the row for a card the door has just handed to Porter. Idempotent on the card. */
export async function openWebPropertyChange(
  env: Env,
  input: { cardId: string; ask: WebPropertyAsk; firmScope: string },
): Promise<void> {
  if (!input.ask.target_repo) throw new Error("a web property change needs a target repo — the door names it from the property, never from the email");
  await env.WP_OS_DB.prepare(
    `INSERT INTO web_property_change (work_card_id, target_repo, property_host, drive_folder_id, drive_folder_url, ask, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (work_card_id) DO UPDATE SET
       target_repo = excluded.target_repo, property_host = excluded.property_host,
       drive_folder_id = excluded.drive_folder_id, drive_folder_url = excluded.drive_folder_url,
       ask = excluded.ask, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  )
    .bind(input.cardId, input.ask.target_repo, input.ask.property_host, input.ask.drive_folder_id, input.ask.drive_folder_url, input.ask.ask, input.firmScope)
    .run();
  await env.WP_OS_DB.prepare("UPDATE work_card SET kind = ?2, request_json = ?3, next_action = ?4 WHERE id = ?1")
    .bind(
      input.cardId,
      WEB_PROPERTY_CHANGE_KIND,
      JSON.stringify(input.ask),
      `Web property change on ${input.ask.property_host ?? input.ask.target_repo}: plan on the Mac first, then ask, build, land on green.`,
    )
    .run();
}

export async function readWebPropertyChange(env: Env, cardId: string): Promise<WebPropertyChangeRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM web_property_change WHERE work_card_id = ?1").bind(cardId).first<WebPropertyChangeRow>();
}

function list(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

async function update(env: Env, cardId: string, sets: Record<string, string | number | null>): Promise<void> {
  const keys = Object.keys(sets);
  if (keys.length === 0) return;
  const assign = keys.map((k, i) => `${k} = ?${i + 2}`).join(", ");
  await env.WP_OS_DB.prepare(`UPDATE web_property_change SET ${assign}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE work_card_id = ?1`)
    .bind(cardId, ...keys.map((k) => sets[k]!))
    .run();
}

async function appendFinding(env: Env, cardId: string, text: string): Promise<void> {
  await env.WP_OS_DB.prepare(
    "UPDATE work_card SET description = substr(COALESCE(description, '') || char(10) || '• ' || ?2, 1, 16000) WHERE id = ?1",
  )
    .bind(cardId, text.slice(0, 3000))
    .run();
}

async function recordHistory(env: Env, row: WebPropertyChangeRow, entry: Record<string, unknown>): Promise<void> {
  const history = (() => {
    try {
      const v = JSON.parse(row.run_history_json || "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  })();
  history.push({ at: new Date().toISOString(), ...entry });
  await update(env, row.work_card_id, { run_history_json: JSON.stringify(history.slice(-40)) });
}

function whoFor(card: WebPropertyChangeCard): "SEQUOIA" | "SCOOTER" {
  const partner = card.requested_by_email ? partnerByEmail(card.requested_by_email) : null;
  return partner?.firstName.toUpperCase() === "SCOOTER" ? "SCOOTER" : "SEQUOIA";
}

// ── Parking a phase ───────────────────────────────────────────────────────────────────────────

/**
 * THE ONLY PLACE A RUN IS PARKED FOR THIS KIND, and the LAND gate lives here.
 *
 * `validate:no-land-without-approval` reads this function and asserts that the LAND branch
 * checks `plan_approved_at`, `check_green_at` and `pr_url` before `parkRun` — so the gate cannot
 * be refactored away without the build going red.
 */
export async function parkPhase(
  env: Env,
  card: WebPropertyChangeCard,
  row: WebPropertyChangeRow,
  phase: WebPropertyChangePhase,
  rules: Record<string, string>,
): Promise<{ parked: true; runId: string } | { parked: false; reason: string }> {
  const spec = localJobKind(WEB_PROPERTY_CHANGE_KIND)!;
  if (phase === "LAND") {
    // NO LAND WITHOUT APPROVAL AND GREEN. Both recorded on the row by earlier phases, never by this one.
    if (!row.plan_approved_at) return { parked: false, reason: "the plan has not been approved by the partner who asked" };
    if (!row.pr_url) return { parked: false, reason: "there is no PR to land" };
    if (!row.check_green_at || row.check_state !== "GREEN") return { parked: false, reason: "the PR has no recorded green check" };
  }
  if (phase === "BUILD" && !row.plan_approved_at) return { parked: false, reason: "the plan has not been approved yet" };
  if (phase === "PLAN" && !row.drive_folder_id) return { parked: false, reason: "no Drive folder is on the card" };

  const payload: LocalJobPayload & { queue_max_seconds: number } = {
    card_kind: WEB_PROPERTY_CHANGE_KIND,
    phase,
    model: phaseModel(rules, phase),
    max_seconds: spec.phases[phase].maxSeconds,
    prompt_file: spec.promptFile,
    script: spec.script,
    card: { id: card.id, title: card.title, requested_by: card.requested_by_email ?? null },
    target_repo: row.target_repo,
    property_host: row.property_host,
    drive: { folder_id: row.drive_folder_id, folder_url: row.drive_folder_url },
    ask: row.ask,
    plan: row.plan_filed_at
      ? { document_id: row.plan_document_id, decided: list(row.decided_json), asks: list(row.asks_json), answers: list(row.answers_json), approved_at: row.plan_approved_at }
      : null,
    pr: row.pr_url ? { url: row.pr_url, number: row.pr_number, branch: row.branch, check_state: row.check_state, check_green_at: row.check_green_at } : null,
    rules,
    queue_max_seconds: spec.queueMaxSeconds,
  };

  let runId: string;
  try {
    runId = await parkRun(env, {
      seat: "claude_code",
      purpose: `${PORTER_NAME}: ${phase} — ${card.title.slice(0, 80)}`,
      prompt: `${spec.phases[phase].purpose} See job_json.`,
      modelAccess: "PUBLIC_MODEL_APPROVED",
      workCardId: card.id,
      aiEmployeeId: PORTER_ID,
      taskClass: "web-property-change",
      firmScope: card.firm_scope,
      maxSeconds: spec.phases[phase].maxSeconds,
      runKind: LOCAL_JOB_RUN_KIND,
      jobJson: JSON.stringify(payload),
    });
  } catch (err) {
    // The one-live-run index refused a second row. The card already holds a run; say so.
    return { parked: false, reason: `a run is already live for this card (${err instanceof Error ? err.message.slice(0, 120) : String(err)})` };
  }
  await update(env, card.id, { current_run_id: runId, phase });
  await env.WP_OS_DB.prepare("UPDATE work_card SET next_action = ?2 WHERE id = ?1")
    .bind(card.id, `${phase} is queued for the Mac (${payload.model}). ${spec.phases[phase].purpose}`.slice(0, 900))
    .run();
  await appendEvent(env, {
    eventType: "web_property_change.phase_queued",
    actorType: "ai_employee",
    actorId: PORTER_ID,
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { phase, run_id: runId, model: payload.model, target_repo: row.target_repo },
  });
  return { parked: true, runId };
}

// ── Reading a report ──────────────────────────────────────────────────────────────────────────

export interface RunOutcome {
  finished: boolean;
  blocked: boolean;
  /** This tick did its job and the card is not done: hand it back without spending an attempt. */
  progressed: boolean;
  detail: string;
}

async function blockWithAsks(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, asks: string[]): Promise<string> {
  const who = whoFor(card);
  const lines = asks.length
    ? asks.map((a, i) => `${i + 1}. ${a}`)
    : ["Nothing to decide — the plan is all structure and wiring. Reply \"go\" to approve it as written."];
  const needed = [
    `The plan is on the card as a Document${row.plan_document_id ? ` (${row.plan_document_id})` : ""}. ${asks.length ? `${asks.length} decision${asks.length === 1 ? "" : "s"} for you:` : ""}`,
    ...lines,
    "Reply to this email with your answers, or answer on the card. \"go\" approves the plan as written.",
  ].join("\n");
  return blockCard(env, card, {
    reason: "a_question_for_you",
    trying: card.title,
    employee: PORTER_NAME,
    who,
    detail: needed.slice(0, 900),
  });
}

/** What the DONE email says: the proof, not the process. */
export function doneSummary(row: WebPropertyChangeRow): string {
  return [
    `Landed ${row.pr_url ?? "the PR"}${row.merge_sha ? ` as ${row.merge_sha.slice(0, 10)}` : ""} on ${row.property_host ?? row.target_repo}.`,
    row.live_proof ? `Live proof:\n${row.live_proof}` : "",
    row.build_proof ? `Build proof:\n${row.build_proof}` : "",
    list(row.decided_json).length ? `Decided without asking: ${list(row.decided_json).join("; ")}` : "",
  ]
    .filter((l) => l.length > 0)
    .join("\n\n");
}

async function finishCard(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow): Promise<string> {
  const finding = doneSummary(row);
  await appendFinding(env, card.id, finding);
  let deliverableId: string | null = null;
  try {
    const filed = await deliver(
      env,
      { type: "SYSTEM", roles: [], firmScopes: [card.firm_scope] },
      {
        kind: "employee_finding",
        title: card.title,
        body: finding,
        preparedBy: PORTER_NAME,
        preparedFor: (card.requested_by_email ? partnerByEmail(card.requested_by_email)?.firmUserId : null) ?? "fu_sequoia_taylor",
        sourceType: "work_card",
        sourceId: card.id,
      },
    );
    deliverableId = filed.id;
  } catch (err) {
    await appendEvent(env, {
      eventType: "deliverable.not_filed",
      actorType: "system",
      actorId: "web_property_change",
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      payload: { detail: String(err).slice(0, 300) },
    });
  }
  await handOver(env, { ...card, kind: WEB_PROPERTY_CHANGE_KIND, preview_first: card.preview_first ?? null, preview_owner_id: card.preview_owner_id ?? null, result_recipient: card.result_recipient ?? null, requested_by_email: card.requested_by_email ?? null }, { employee: PORTER_NAME, finding, deliverableId });
  await update(env, card.id, { phase: "DONE" });
  // The 0219 trigger checks pr_url, check_green_at and merge_sha on the row before this succeeds.
  await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE', next_action = NULL WHERE id = ?1").bind(card.id).run();
  return finding;
}

/**
 * Apply what the Mac reported for the run the row holds. Clears the lease either way.
 */
export async function applyReport(
  env: Env,
  card: WebPropertyChangeCard,
  row: WebPropertyChangeRow,
  run: SeatRunRow,
  rules: Record<string, string>,
): Promise<RunOutcome> {
  await update(env, card.id, { current_run_id: null, last_report: (run.output_text ?? run.error ?? "").slice(0, 16000) });

  if (run.status !== "REPORTED") {
    const why = run.error ?? run.resolution ?? `the run ended ${run.status}`;
    await recordHistory(env, row, { run_id: run.id, phase: row.phase, status: run.status, reason: why.slice(0, 300) });
    await appendFinding(env, card.id, `${row.phase} did not finish on the Mac: ${why}`);
    if (run.status === "ABANDONED" && !run.claimed_by) {
      // Nobody picked it up inside the queue ceiling. A fault to look at, with the lane named.
      const why2 = await blockCard(env, card, {
        reason: "a_lane_refused_the_work",
        trying: card.title,
        employee: PORTER_NAME,
        who: whoFor(card),
        lane: "Claude Code (her Mac)",
        laneKey: "claude_code",
        laneKind: "LANE_DOWN",
        vendorWords: "no machine claimed this job before its queue ceiling — the Mac is asleep or the local-jobs launchd job is not running",
        raw: why,
      });
      return { finished: false, blocked: true, progressed: false, detail: why2 };
    }
    return { finished: false, blocked: false, progressed: false, detail: `${row.phase} on the Mac: ${why}` };
  }

  const { report, problem } = readLocalJobReport(run.output_text);
  if (!report) {
    await recordHistory(env, row, { run_id: run.id, phase: row.phase, status: "UNREADABLE", reason: problem });
    return { finished: false, blocked: false, progressed: false, detail: `${row.phase} reported something the OS could not read: ${problem}` };
  }
  await recordHistory(env, row, { run_id: run.id, phase: report.phase, status: report.status, reason: (report.reason ?? "").slice(0, 300) });

  if (report.status === "blocked") {
    const why = await blockCard(env, card, {
      reason: "a_question_for_you",
      trying: card.title,
      employee: PORTER_NAME,
      who: whoFor(card),
      detail: report.reason!.slice(0, 900),
    });
    return { finished: false, blocked: true, progressed: false, detail: why };
  }
  if (report.status === "failed") {
    await appendFinding(env, card.id, `${report.phase} failed on the Mac: ${report.reason}`);
    return { finished: false, blocked: false, progressed: false, detail: `${report.phase} failed: ${report.reason}` };
  }

  if (report.phase === "PLAN") return applyPlan(env, card, row, report);
  if (report.phase === "BUILD") return applyBuild(env, card, row, report, rules);
  return applyLand(env, card, row, report);
}

async function applyPlan(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, report: LocalJobReport): Promise<RunOutcome> {
  if (!report.document) {
    return { finished: false, blocked: false, progressed: false, detail: "PLAN came back without a plan document" };
  }
  // THE PLAN IS A DOCUMENT ON THE CARD. Filed through the one deliverables road, so it is in
  // Documents, on the partner's Home, and linked from the card — never a string in a column.
  const filed = await deliver(
    env,
    { type: "SYSTEM", roles: [], firmScopes: [card.firm_scope] },
    {
      kind: "employee_finding",
      title: `Plan: ${card.title.replace(/^From [^:]+@[^:]+:\s*/i, "").slice(0, 120)}`,
      body: report.document,
      preparedBy: PORTER_NAME,
      preparedFor: (card.requested_by_email ? partnerByEmail(card.requested_by_email)?.firmUserId : null) ?? "fu_sequoia_taylor",
      sourceType: "work_card_plan",
      sourceId: card.id,
    },
  );
  const now = new Date().toISOString();
  await update(env, card.id, {
    plan_deliverable_id: filed.id,
    plan_document_id: filed.document_id ?? null,
    plan_filed_at: now,
    decided_json: JSON.stringify(report.decided ?? []),
    asks_json: JSON.stringify(report.asks ?? []),
  });
  const decided = report.decided ?? [];
  await appendFinding(
    env,
    card.id,
    `Plan filed as Document ${filed.document_id ?? filed.id}. Decided (${decided.length}): ${decided.join("; ") || "nothing"}. Asking (${(report.asks ?? []).length}): ${(report.asks ?? []).join("; ") || "nothing"}.`,
  );
  const fresh = { ...row, plan_document_id: filed.document_id ?? null, plan_filed_at: now };
  const why = await blockWithAsks(env, card, fresh, report.asks ?? []);
  return { finished: false, blocked: true, progressed: false, detail: why };
}

async function applyBuild(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, report: LocalJobReport, rules: Record<string, string>): Promise<RunOutcome> {
  if (!report.pr_url) return { finished: false, blocked: false, progressed: false, detail: "BUILD came back without a PR link" };
  const state = report.check_state ?? "PENDING";
  const now = new Date().toISOString();
  await update(env, card.id, {
    pr_url: report.pr_url,
    pr_number: report.pr_number ?? null,
    branch: report.branch ?? null,
    check_state: state,
    check_url: report.check_url ?? null,
    check_green_at: state === "GREEN" ? now : null,
    build_proof: (report.proof ?? "").slice(0, 8000) || null,
  });
  await appendFinding(env, card.id, `PR opened: ${report.pr_url} — checks ${state}${report.check_url ? ` (${report.check_url})` : ""}.${report.proof ? `\n${report.proof.slice(0, 1500)}` : ""}`);
  if (state !== "GREEN") {
    // The script watched the checks and they are not green. That is a failed attempt: the next
    // BUILD run resumes the same branch and fixes it. Never landed, never asked to be.
    return { finished: false, blocked: false, progressed: false, detail: `the PR's checks are ${state}: ${report.reason ?? "the build must fix them before anything lands"}` };
  }
  const fresh: WebPropertyChangeRow = { ...row, pr_url: report.pr_url, check_state: "GREEN", check_green_at: now };
  if (isOn(rules.land_on_green)) {
    const parked = await parkPhase(env, card, fresh, "LAND", rules);
    if (!parked.parked) return { finished: false, blocked: false, progressed: false, detail: `green, but LAND could not be queued: ${parked.reason}` };
    return { finished: false, blocked: false, progressed: true, detail: `PR ${report.pr_url} is green; landing is queued for the Mac (land on green is on).` };
  }
  const why = await blockCard(env, card, {
    reason: "a_question_for_you",
    trying: card.title,
    employee: PORTER_NAME,
    who: whoFor(card),
    detail: `The PR is green: ${report.pr_url}. Land on green is OFF for this kind, so say "land it" to merge and deploy, or say what to change.`,
  });
  return { finished: false, blocked: true, progressed: false, detail: why };
}

async function applyLand(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, report: LocalJobReport): Promise<RunOutcome> {
  if (!report.merge_sha) return { finished: false, blocked: false, progressed: false, detail: "LAND came back without a merge SHA — nothing is recorded as landed" };
  const now = new Date().toISOString();
  await update(env, card.id, { merge_sha: report.merge_sha, landed_at: now, live_proof: (report.live_proof ?? "").slice(0, 8000) || null });
  const fresh: WebPropertyChangeRow = { ...row, merge_sha: report.merge_sha, landed_at: now, live_proof: report.live_proof ?? null };
  const finding = await finishCard(env, card, fresh);
  return { finished: true, blocked: false, progressed: false, detail: finding };
}

// ── The runner ────────────────────────────────────────────────────────────────────────────────

/** Has the partner answered since the plan (or the green) was recorded? */
function answerSince(card: WebPropertyChangeCard, since: string | null): string | null {
  if (!card.block_answered_at || !since) return null;
  if (card.block_answered_at <= since) return null;
  const text = (card.block_answer ?? "").trim();
  return text.length > 0 ? text : null;
}

export async function runWebPropertyChangeCard(env: Env, sweepCard: SweepCard): Promise<RunOutcome> {
  const card: WebPropertyChangeCard =
    (await env.WP_OS_DB.prepare(
      "SELECT id, title, kind, owner_id, state, COALESCE(work_attempts,0) AS work_attempts, firm_scope, requested_by_email, preview_first, result_recipient, preview_owner_id, request_json, description, block_answer, block_answered_at, block_answered_by FROM work_card WHERE id = ?1",
    )
      .bind(sweepCard.id)
      .first<WebPropertyChangeCard>()) ?? sweepCard;
  let row = await readWebPropertyChange(env, card.id);
  if (!row) {
    // A card marked with the kind but never opened at the door: try the stored request.
    const ask = readWebPropertyAsk((card as WebPropertyChangeCard).request_json);
    if (ask?.target_repo && ask.drive_folder_id) {
      await openWebPropertyChange(env, { cardId: card.id, ask, firmScope: card.firm_scope });
      row = await readWebPropertyChange(env, card.id);
    }
  }
  if (!row) {
    const why = await blockCard(env, card, {
      reason: "the_brief_is_missing",
      trying: card.title,
      employee: PORTER_NAME,
      who: whoFor(card),
      detail: "Send the Google Drive FOLDER link with the package and name the site (westpeek.ventures, westpeekproductions.com or joinwestpeek.com).",
    });
    return { finished: false, blocked: true, progressed: false, detail: why };
  }
  if (row.phase === "DONE") return { finished: true, blocked: false, progressed: false, detail: doneSummary(row) };
  const rules = await rulesFor(env, WEB_PROPERTY_CHANGE_KIND);

  // 1 · The lease. A run the Mac holds is the whole answer for this tick.
  if (row.current_run_id) {
    const run = await readRun(env, row.current_run_id);
    if (run && (run.status === "QUEUED" || run.status === "CLAIMED")) {
      const where = run.status === "CLAIMED" ? `on ${run.claimed_by ?? "the Mac"}${run.progress_note ? ` — ${run.progress_note}` : ""}` : "queued, waiting for the Mac to claim it";
      return { finished: false, blocked: false, progressed: true, detail: `${row.phase} is ${where}.` };
    }
    if (run) {
      const out = await applyReport(env, card, row, run, rules);
      return out;
    }
    await update(env, card.id, { current_run_id: null });
  }

  // 2 · No live run. Decide the next phase from the row.
  if (row.phase === "PLAN") {
    if (!row.plan_filed_at) {
      if (!row.drive_folder_id) {
        const why = await blockCard(env, card, {
          reason: "the_brief_is_missing",
          trying: card.title,
          employee: PORTER_NAME,
          who: whoFor(card),
          detail: `Send the Google Drive FOLDER link with the package${row.drive_folder_url ? "" : " (a file link was sent, not a folder)"}.`,
        });
        return { finished: false, blocked: true, progressed: false, detail: why };
      }
      const parked = await parkPhase(env, card, row, "PLAN", rules);
      if (!parked.parked) return { finished: false, blocked: false, progressed: true, detail: parked.reason };
      return { finished: false, blocked: false, progressed: true, detail: `PLAN queued for the Mac (${phaseModel(rules, "PLAN")}).` };
    }
    // The plan is filed. Was it approved?
    const answer = answerSince(card, row.plan_approved_at ?? row.plan_filed_at);
    if (!answer) {
      // Back here without an answer — reopened by a person by another door, or the block was
      // cleared some other way. Ask again rather than build on nothing.
      const why = await blockWithAsks(env, card, row, list(row.asks_json));
      return { finished: false, blocked: true, progressed: false, detail: why };
    }
    const answers = [...list(row.answers_json), answer];
    const now = new Date().toISOString();
    await update(env, card.id, { answers_json: JSON.stringify(answers), plan_approved_at: now, plan_approved_by: card.block_answered_by ?? card.requested_by_email ?? null, phase: "BUILD" });
    await appendFinding(env, card.id, `Plan approved by ${card.requested_by_email ?? "a partner"}: "${answer.slice(0, 400)}"`);
    await appendEvent(env, {
      eventType: "web_property_change.plan_approved",
      actorType: "firm_user",
      actorId: card.block_answered_by ?? "unknown",
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      payload: { answer: answer.slice(0, 400) },
    });
    const fresh: WebPropertyChangeRow = { ...row, answers_json: JSON.stringify(answers), plan_approved_at: now, phase: "BUILD" };
    const parked = await parkPhase(env, card, fresh, "BUILD", rules);
    if (!parked.parked) return { finished: false, blocked: false, progressed: true, detail: parked.reason };
    return { finished: false, blocked: false, progressed: true, detail: `Plan approved; BUILD queued for the Mac (${phaseModel(rules, "BUILD")}).` };
  }

  if (row.phase === "BUILD") {
    if (!row.pr_url || row.check_state !== "GREEN") {
      const parked = await parkPhase(env, card, row, "BUILD", rules);
      if (!parked.parked) return { finished: false, blocked: false, progressed: true, detail: parked.reason };
      return { finished: false, blocked: false, progressed: true, detail: `BUILD queued for the Mac (${phaseModel(rules, "BUILD")})${row.pr_url ? ` to fix ${row.pr_url}` : ""}.` };
    }
    // Green, and back here: land on green, or wait for the word.
    if (!isOn(rules.land_on_green)) {
      const answer = answerSince(card, row.check_green_at);
      if (!answer) {
        const why = await blockCard(env, card, {
          reason: "a_question_for_you",
          trying: card.title,
          employee: PORTER_NAME,
          who: whoFor(card),
          detail: `The PR is green: ${row.pr_url}. Land on green is OFF for this kind, so say "land it" to merge and deploy, or say what to change.`,
        });
        return { finished: false, blocked: true, progressed: false, detail: why };
      }
      await appendFinding(env, card.id, `Landing approved: "${answer.slice(0, 300)}"`);
    }
    const parked = await parkPhase(env, card, row, "LAND", rules);
    if (!parked.parked) return { finished: false, blocked: false, progressed: true, detail: parked.reason };
    return { finished: false, blocked: false, progressed: true, detail: `LAND queued for the Mac (${phaseModel(rules, "LAND")}).` };
  }

  // LAND with no live run: the previous LAND run ended without a merge. Try once more; the
  // attempt count decides when to stop. The gate inside parkPhase still applies.
  const parked = await parkPhase(env, card, row, "LAND", rules);
  if (!parked.parked) {
    const why = await blockCard(env, card, {
      reason: "a_question_for_you",
      trying: card.title,
      employee: PORTER_NAME,
      who: whoFor(card),
      detail: `Cannot land: ${parked.reason}. Say how to proceed.`,
    });
    return { finished: false, blocked: true, progressed: false, detail: why };
  }
  return { finished: false, blocked: false, progressed: true, detail: `LAND queued for the Mac (${phaseModel(rules, "LAND")}).` };
}

// ── HTTP: the rules, and the row for the page ────────────────────────────────────────────────

/** GET /api/work-kinds/:kind/rules */
export async function handleWorkKindRules(ctx: RouteContext): Promise<Response> {
  const kind = ctx.params.kind ?? "";
  const rows = (await ctx.env.WP_OS_DB.prepare("SELECT * FROM work_kind_rule WHERE kind = ?1 ORDER BY editable DESC, rule_key").bind(kind).all<KindRule>()).results ?? [];
  return json({ kind, rules: rows, model_aliases: CLAUDE_MODEL_ALIASES });
}

/** PATCH /api/work-kinds/:kind/rules/:key — a Managing Partner flips an editable rule. */
export async function handleSetWorkKindRule(ctx: RouteContext): Promise<Response> {
  const kind = ctx.params.kind ?? "";
  const key = ctx.params.key ?? "";
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN" || !actor.roles.includes("MANAGING_PARTNER")) {
    return json({ error: "forbidden", detail: "A standing rule is a Managing Partner's to change." }, { status: 403 });
  }
  const body = (await ctx.request.json().catch(() => null)) as { value?: unknown } | null;
  const value = typeof body?.value === "string" ? body.value.trim().toLowerCase() : "";
  if (!value || value.length > 40) return json({ error: "invalid_input", detail: "Say the value." }, { status: 400 });
  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM work_kind_rule WHERE kind = ?1 AND rule_key = ?2").bind(kind, key).first<KindRule>();
  if (!row) return json({ error: "not_found" }, { status: 404 });
  if (row.editable !== 1) return json({ error: "not_editable", detail: `"${row.label}" is a fact about how this kind runs; it changes in a commit, not here.` }, { status: 409 });
  if (key.startsWith("model_") && !(CLAUDE_MODEL_ALIASES as readonly string[]).includes(value)) {
    return json({ error: "invalid_input", detail: `A model is one of: ${CLAUDE_MODEL_ALIASES.join(", ")}.` }, { status: 400 });
  }
  if (key === "land_on_green" && !["on", "off"].includes(value)) {
    return json({ error: "invalid_input", detail: "Land on green is on or off." }, { status: 400 });
  }
  await ctx.env.WP_OS_DB.prepare("UPDATE work_kind_rule SET value = ?3, set_by = ?4, set_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind = ?1 AND rule_key = ?2")
    .bind(kind, key, value, ctx.identity!.id)
    .run();
  await appendEvent(ctx.env, {
    eventType: "work_kind_rule.changed",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "work_kind_rule",
    objectId: `${kind}:${key}`,
    firmScope: actor.firmScopes[0] ?? "west-peek",
    payload: { from: row.value, to: value },
  });
  return json({ ok: true, kind, rule_key: key, value });
}

/** GET /api/work-cards/:id/web-property-change — the row, for the card on the Work page. */
export async function handleGetWebPropertyChange(ctx: RouteContext): Promise<Response> {
  const id = ctx.params.id ?? "";
  const row = await readWebPropertyChange(ctx.env, id);
  if (!row) return json({ error: "not_found" }, { status: 404 });
  const run = row.current_run_id ? await readRun(ctx.env, row.current_run_id) : null;
  return json({
    ...row,
    decided: list(row.decided_json),
    asks: list(row.asks_json),
    answers: list(row.answers_json),
    current_run: run ? { id: run.id, status: run.status, claimed_by: run.claimed_by, claimed_at: run.claimed_at, progressed_at: run.progressed_at, progress_note: run.progress_note } : null,
  });
}
