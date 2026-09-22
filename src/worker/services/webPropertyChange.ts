import type { Env } from "../env";
import { json, type RouteContext } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, type Actor } from "./authorize";
import { blockCard } from "./blocks";
import { runAi } from "../ai/runAi";
import { deliver } from "./deliverables";
import { handOver } from "./employeeWork";
import { parkRun, readRun, type SeatRunRow } from "../ai/subscriptionSeats";
import { PARTNERS, PREVIEW_PARTNER, partnerByEmail } from "../../shared/registry/partners";
import { sendOrPreview } from "./previewApproval";
import type { SweepCard } from "./workSweep";
import { readWebPropertyAsk, type WebPropertyAsk } from "../../shared/intake/webPropertyChange";
import { approvedAnswers, askLines, decidedFromAsks, readApprovalReply, readAsks, type Ask } from "../../shared/work/approvalReply";
import { abandonRun } from "../ai/subscriptionSeats";
import { alreadyTold, recordNotice, routedByFor, threadRootFor, type NoticeKind } from "./requestReply";
import { doneReplyLaneFor, isOn, rulesFor, ON_OFF_RULE_KEYS, type KindRule } from "./kindRules";
import { attachmentBytes } from "../effects/mimeAttachments";
import { SUBSCRIPTION_CLAIMER_EMAIL } from "../auth";
import { strippedSubject } from "../../shared/intake/emailTriggers";
import { decodeMimeHeader } from "../effects/inboundEmail";
import { isTechnicalBlock } from "../../shared/work/blocks";
import { INTAKE_JUDGMENT_STANDARD } from "../../shared/registry/aiEmployeePersonas";
import { defaultGenerateBanterReply, replyToBanter, type BanterReplyGenerator } from "./banterReply";
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
  /** 0220. 0 when the plan would ship placeholders; the change previews first and lands on a second approval. */
  publish_ready: number;
  placeholders_json: string;
  /** 0220. The partner replied "preview" to a ready plan. */
  preview_only: number;
  preview_url: string | null;
  preview_emailed_at: string | null;
  /** 0220. The SECOND approval, after the preview email. Only the requesting partner's "approved". */
  land_approved_at: string | null;
  land_approved_by: string | null;
  /** 0220. The named bypass: the requesting partner's "approved to production" on a not-ready plan. */
  forced_by: string | null;
  forced_at: string | null;
  forced_placeholders_json: string | null;
  /** 0220. The pre-approval phrase in the partner's own request, written at the door only. */
  pre_approved_phrase: string | null;
  force_phrase: string | null;
  /** 0221. The partner's own words, readable — the specification. */
  request_text: string | null;
  /** 0222. When "the site" was inferred: which card it came from, in a sentence for the RECEIVED email. */
  property_assumed_from: string | null;
}

export interface RequestAttachment {
  id: string;
  filename: string;
  media_type: string;
  bytes: number;
  eml_key: string;
}

export async function attachmentsFor(env: Env, cardId: string): Promise<RequestAttachment[]> {
  return (
    (await env.WP_OS_DB.prepare("SELECT id, filename, media_type, bytes, eml_key FROM request_attachment WHERE work_card_id = ?1 ORDER BY created_at ASC").bind(cardId).all<RequestAttachment>()).results ?? []
  );
}

/**
 * WHICH EMAIL THIS IS, so it is sent at most once per cause (her rule, 21 Sep 2026). PLAN when the
 * plan is filed and waits for approval (cause: its filing time); PREVIEW when the preview waits
 * for the second approval (cause: the green time); QUESTION for any other block (cause: the
 * question's words); DONE once.
 */
export async function noticeFor(env: Env, cardId: string, outcome: "DONE" | "BLOCKED"): Promise<{ kind: NoticeKind; cause: string }> {
  if (outcome === "DONE") return { kind: "DONE", cause: "" };
  const row = await readWebPropertyChange(env, cardId);
  const card = await env.WP_OS_DB.prepare("SELECT block_needed, block_reason FROM work_card WHERE id = ?1").bind(cardId).first<{ block_needed: string | null; block_reason: string | null }>();
  // A FAULT is "I'm stuck", not a question: a lane refused, three attempts spent, stopped part way.
  if (isTechnicalBlock(card?.block_reason) || ["tried_and_could_not_finish", "stopped_part_way"].includes(card?.block_reason ?? "")) {
    return { kind: "STUCK", cause: `block:${card?.block_reason}` };
  }
  const isPlanBlock = /The plan is in this email|NOT PUBLISH-READY/.test(card?.block_needed ?? "");
  if (row?.plan_filed_at && !row.plan_approved_at && isPlanBlock) return { kind: "PLAN", cause: row.plan_filed_at };
  if (row?.pr_url && row.check_state === "GREEN" && needsPreview(row) && !row.land_approved_at && !row.forced_by) return { kind: "PREVIEW", cause: row.check_green_at ?? "green" };
  return { kind: "QUESTION", cause: (card?.block_needed ?? "").slice(0, 400) };
}

/** One short email through the lane, recorded as a notice; never twice for the same cause. */
async function tellRequester(
  env: Env,
  card: Pick<WebPropertyChangeCard, "id" | "title" | "firm_scope" | "requested_by_email" | "preview_first" | "preview_owner_id"> & { assigned_from_card_id?: string | null },
  notice: { kind: NoticeKind; cause: string },
  email: { what: string; tldr: string; sections: Array<{ label: string; bullets: string[] }>; details?: string | null },
  /** An earlier note's thread token, so this lands in the partner's same conversation. */
  replyOnThread: string | null = null,
): Promise<{ sent: boolean; reason: string }> {
  const to = (card.requested_by_email ?? "").trim().toLowerCase();
  const partner = to ? partnerByEmail(to) : null;
  if (!partner) return { sent: false, reason: "the card was not asked for by a partner's email" };
  if (await alreadyTold(env, card.id, notice.kind, notice.cause)) return { sent: false, reason: `${notice.kind} already sent for this cause` };
  /*
   * HER RULE, READ IN ONE PLACE (0223, 22 Sep 2026). A DONE reply takes the preview lane when
   * `done_reply_preview_first` is on, whatever the card's own tick says; everything else — RECEIVED,
   * PLAN, PREVIEW, QUESTION, STUCK — carries the card's tick exactly as before. `doneReplyLaneFor`
   * is the only reader, and `services/requestReply.ts` asks the same function.
   */
  const lane = await doneReplyLaneFor(env, { kind: WEB_PROPERTY_CHANGE_KIND, preview_first: card.preview_first, preview_owner_id: card.preview_owner_id }, notice);
  /*
   * HER TWO RULES, ON EVERY NOTICE PORTER SENDS (22 Sep 2026).
   *
   * WHO ROUTED IT — `routedByFor` reads `assigned_from_card_id`, so when Walker or Wren handed the
   * change to Porter the footer says so ("Walker routed this to me; the work is mine."). No
   * hand-off and it returns null, and the footer is byte-identical to what it was before.
   *
   * ONE CONVERSATION — every notice about this card lands under the first one sent about it, rather
   * than each minting a thread of its own. Before this, only RECEIVED could be handed a token by
   * its caller; PLAN, QUESTION, STUCK and DONE each started a new conversation in the partner's
   * inbox about the same request. An explicit token from the caller still wins, because that is the
   * inbound path naming the partner's own message.
   */
  const routedBy = await routedByFor(env, card.assigned_from_card_id, PORTER_NAME);
  const onThread = replyOnThread ?? (await threadRootFor(env, card.id));
  let out: { sent: boolean; reason: string; threadToken?: string | null };
  try {
    out = await sendOrPreview(env, {
      to,
      email: { employee: PORTER_NAME, ...email, details: email.details ?? null, routedBy },
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      cardKind: WEB_PROPERTY_CHANGE_KIND,
      workCardId: card.id,
      cardAsked: lane.cardAsked,
      tickedByFirmUserId: lane.tickedByFirmUserId,
      requestedByEmail: to,
      what: card.title,
      replyOnThread: onThread,
    });
  } catch (err) {
    out = { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
  await recordNotice(env, { cardId: card.id, kind: notice.kind, cause: notice.cause, to, messageId: out.threadToken ?? null, sent: out.sent, detail: out.reason, firmScope: card.firm_scope });
  return { sent: out.sent, reason: out.reason };
}

/**
 * RECEIVED — "Got it — I'm on it." Once per card, at intake (or when a card is re-opened by hand,
 * with an apology folded in). Says what was understood and what comes next.
 */
export async function sendReceived(env: Env, cardId: string, input: { tldr?: string | null; replyOnThread?: string | null } = {}): Promise<{ sent: boolean; reason: string }> {
  const card = await env.WP_OS_DB.prepare("SELECT id, title, firm_scope, requested_by_email, preview_first, preview_owner_id, assigned_from_card_id FROM work_card WHERE id = ?1").bind(cardId).first<WebPropertyChangeCard>();
  const row = await readWebPropertyChange(env, cardId);
  if (!card || !row) return { sent: false, reason: "no such web property change" };
  const attachments = await attachmentsFor(env, cardId);
  const asked = card.title.replace(/^From [^:]+@[^:]+:\s*/i, "").trim() || card.title;
  const next = row.pre_approved_phrase
    ? `You pre-approved this ("${row.pre_approved_phrase}"), so the next thing you'll get is the finished result${row.publish_ready === 0 ? " — or the preview link first if the package is not publish-ready" : ""}.`
    : "If any decision is yours to make — brand, copy meaning, legal wording, a public claim, image rights, money — I'll send you the plan with those questions; one word back is enough. If none is, the next thing you'll get is the finished result.";
  const assumption = row.property_assumed_from ? `I'm reading "the site" as ${row.property_assumed_from} — reply if not.` : null;
  const unresolved = row.target_repo === UNRESOLVED_REPO ? "You said \"the site\" and I have nothing recent to go on — I'll ask you which one." : null;
  return tellRequester(env, card, { kind: "RECEIVED", cause: "" }, {
    what: `got it — ${asked.slice(0, 60)}`,
    tldr: input.tldr?.trim() || `Got it — I'm on it. ${assumption ? `${assumption} ` : ""}${unresolved ? `${unresolved} ` : ""}${next}`,
    sections: [
      {
        label: "What I understood",
        bullets: [
          `Property: ${row.target_repo === UNRESOLVED_REPO ? "unresolved — I'll ask" : row.property_host ?? row.target_repo}${assumption ? ` (${assumption})` : ""}`,
          `Attachments: ${attachments.length === 0 ? "none" : attachments.map((a) => a.filename).join(", ")}`,
          `Drive folder: ${row.drive_folder_url ? "yes" : "no"}`,
          `Your words: "${(row.request_text ?? row.ask).replace(/\s+/g, " ").slice(0, 200)}"`,
        ],
      },
      { label: "What comes next", bullets: [next, `The card: https://os.joinwestpeek.com/#/work (card ${card.id})`] },
    ],
  }, input.replyOnThread ?? null);
}

/** STUCK — only when the work cannot proceed without a person, or has sat idle past the ceiling. Once per cause. */
export async function sendStuck(env: Env, card: WebPropertyChangeCard, cause: string, reason: string, next: string): Promise<{ sent: boolean; reason: string }> {
  return tellRequester(env, card, { kind: "STUCK", cause }, {
    what: `stuck — ${card.title.replace(/^From [^:]+@[^:]+:\s*/i, "").slice(0, 60)}`,
    tldr: `I'm stuck: ${reason} — ${next}`,
    sections: [
      { label: "Why", bullets: [reason] },
      { label: "What happens next", bullets: [next, `The card: https://os.joinwestpeek.com/#/work (card ${card.id})`] },
    ],
  });
}

/** Is the "stuck" window open? `06-22` means 06:00–22:00 Central. Pure. */
export function stuckWindowOpen(window: string | undefined, now: Date): boolean {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec((window ?? "06-22").trim());
  const from = m ? Number(m[1]) : 6;
  const to = m ? Number(m[2]) : 22;
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }).format(now));
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** Does this change stop at a preview before landing? Not ready, or the partner asked. */
export function needsPreview(row: Pick<WebPropertyChangeRow, "publish_ready" | "preview_only">): boolean {
  return row.publish_ready === 0 || row.preview_only === 1;
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

/*
 * THE RULES LIVE IN `kindRules.ts` (22 Sep 2026). They moved there when the DONE path got a rule of
 * its own — `done_reply_preview_first` — because BOTH doors that can send a finished-work email
 * have to read it, and the other one (`requestReply.ts`) is imported BY this file. A reader kept
 * here would have made that a cycle, and a second copy over there would have been the defect the
 * preview lane already produced once. Re-exported so every existing call site and test is unchanged
 * and there is still exactly one implementation.
 */
export { isOn, rulesFor, type KindRule };

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
export const UNRESOLVED_REPO = "unresolved";

export async function openWebPropertyChange(
  env: Env,
  input: { cardId: string; ask: WebPropertyAsk; firmScope: string; assumedFrom?: string | null },
): Promise<void> {
  if (!input.ask.target_repo && !input.ask.property_unresolved) throw new Error("a web property change needs a target repo — the door names it from the property, never from the email");
  /*
   * THE PRE-APPROVAL AND THE FORCE PHRASE COME FROM THE DOOR'S PARSE OF THE VERIFIED REQUEST — the
   * partner's own authenticated text (`parseWebPropertyAsk(subject, raw)` in openAssignmentCard),
   * never a later message, never the other partner. This is the ONLY write of either column;
   * `validate:no-land-without-approval` holds it to that.
   */
  await env.WP_OS_DB.prepare(
    `INSERT INTO web_property_change (work_card_id, target_repo, property_host, drive_folder_id, drive_folder_url, ask, firm_scope, pre_approved_phrase, force_phrase)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (work_card_id) DO UPDATE SET
       target_repo = excluded.target_repo, property_host = excluded.property_host,
       drive_folder_id = excluded.drive_folder_id, drive_folder_url = excluded.drive_folder_url,
       ask = excluded.ask, pre_approved_phrase = excluded.pre_approved_phrase, force_phrase = excluded.force_phrase,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  )
    .bind(input.cardId, input.ask.target_repo ?? UNRESOLVED_REPO, input.ask.property_host, input.ask.drive_folder_id, input.ask.drive_folder_url, input.ask.ask, input.firmScope, input.ask.pre_approval ?? null, input.ask.force ?? null)
    .run();
  // The readable request, the specification Porter reads first (0221); and, when "the site" was
  // inferred from a recent card, where the assumption came from (0222).
  await env.WP_OS_DB.prepare("UPDATE web_property_change SET request_text = ?2, property_assumed_from = ?3 WHERE work_card_id = ?1").bind(input.cardId, input.ask.ask.slice(0, 12000), input.assumedFrom ?? null).run();
  await env.WP_OS_DB.prepare("UPDATE work_card SET kind = ?2, request_json = ?3, next_action = ?4 WHERE id = ?1")
    .bind(
      input.cardId,
      WEB_PROPERTY_CHANGE_KIND,
      JSON.stringify(input.ask),
      `Web property change on ${input.ask.property_host ?? input.ask.target_repo}: plan on the Mac first, then ask only what is missing, build, land on green.`,
    )
    .run();
}

export async function readWebPropertyChange(env: Env, cardId: string): Promise<WebPropertyChangeRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM web_property_change WHERE work_card_id = ?1").bind(cardId).first<WebPropertyChangeRow>();
}

function asksOf(row: WebPropertyChangeRow): Ask[] {
  try {
    return readAsks(JSON.parse(row.asks_json || "[]"));
  } catch {
    return [];
  }
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
    // A CHANGE THAT PREVIEWS FIRST NEEDS THE SECOND APPROVAL (0220). Land-on-green does not reach here.
    if (needsPreview(row) && !row.land_approved_at && !row.forced_by) return { parked: false, reason: "this change previews first and the partner has not approved the landing after the preview, nor forced it to production" };
  }
  if (phase === "BUILD" && !row.plan_approved_at) return { parked: false, reason: "the plan has not been approved yet" };

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
      ? {
          document_id: row.plan_document_id,
          // The plan's text rides on the job: the filed Document is the source of truth and the Mac
          // that runs BUILD may not be the one that ran PLAN.
          text: row.plan_deliverable_id
            ? ((await env.WP_OS_DB.prepare("SELECT body FROM deliverable WHERE id = ?1").bind(row.plan_deliverable_id).first<{ body: string }>())?.body ?? null)
            : null,
          decided: list(row.decided_json),
          asks: asksOf(row),
          answers: list(row.answers_json),
          approved_at: row.plan_approved_at,
          publish_ready: row.publish_ready !== 0,
          placeholders: list(row.placeholders_json),
          preview_only: row.preview_only === 1,
        }
      : null,
    pre_approved: row.pre_approved_phrase,
    request: row.request_text ?? row.ask,
    attachments: (await attachmentsFor(env, card.id)).map((a) => ({ id: a.id, filename: a.filename, media_type: a.media_type, bytes: a.bytes, path: `/api/work-cards/${card.id}/attachments/${a.id}` })),
    pr: row.pr_url ? { url: row.pr_url, number: row.pr_number, branch: row.branch, check_state: row.check_state, check_green_at: row.check_green_at, preview_url: row.preview_url, land_approved_at: row.land_approved_at, forced_by: row.forced_by } : null,
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
  /**
   * THE MAC HOLDS THIS CARD (21 Sep 2026). The sweep works ONE card per tick, oldest first, and a
   * card the Mac holds for an hour would be that card every tick — every other card starves. So a
   * held card asks the sweep to leave it alone for a while (`lease_until`) and take the next one.
   */
  held?: boolean;
  /**
   * BANTER RESOLVED WITHOUT EVER REACHING THE MAC (Addendum 10, 22 Sep 2026). The card is already
   * terminal — `state = 'CANCELLED'`, `auto_resolution = 'NO_ACTION_NEEDED'` — by the time this
   * comes back; the sweep reads it to skip the DONE/BLOCKED bookkeeping and record its own outcome.
   */
  autoResolved?: boolean;
  detail: string;
}

/**
 * THE QUESTION ON THE CARD, SHORT; THE PLAN IN THE MAIL, WHOLE (owner, 21 Sep 2026: "the approval
 * step must have zero friction"). The card's `block_needed` is capped at 900 characters by the
 * catalogue, so it carries the numbered asks with Porter's recommended default and the one word
 * that approves. The EMAIL carries the whole plan above them — `blockedEmailDetail` assembles it
 * where the partner email is composed, from the filed Document's text.
 */
export function askBlockText(asks: readonly Ask[], planRef: string | null, readiness?: { publishReady: boolean; placeholders: string[] }): string {
  const lines = asks.length
    ? askLines(asks)
    : ["Nothing to decide — the plan is all structure and wiring."];
  const notReady = readiness && !readiness.publishReady;
  return [
    ...(notReady
      ? [
          `NOT PUBLISH-READY. This will ship with ${readiness.placeholders.length} placeholder${readiness.placeholders.length === 1 ? "" : "s"}: ${readiness.placeholders.join("; ") || "(unnamed)"}. ` +
            `I will open the PR and send you the preview link; landing needs a second approval.`,
        ]
      : []),
    `The plan is in this email and on the card as a Document${planRef ? ` (${planRef})` : ""}.${asks.length ? ` ${asks.length} decision${asks.length === 1 ? "" : "s"}, each with a recommendation:` : ""}`,
    ...lines,
    notReady
      ? `Reply "approved" to take every recommendation and build the preview. Reply "approved to production" to skip the preview and land on green with the placeholders as they are — the DONE email will name them and you. Reply "no" or "changes: …" to hold it. Anything else is read as your answers.`
      : `Reply "approved" to take every recommendation and build. Reply "preview" to see it on a preview link before it lands. Reply "no" or "changes: …" to hold it. Anything else is read as your answers.`,
  ].join("\n");
}

/** The second question: the preview is up, land it? */
export function previewBlockText(row: Pick<WebPropertyChangeRow, "pr_url" | "preview_url" | "placeholders_json" | "publish_ready">): string {
  const placeholders = list(row.placeholders_json);
  return [
    `PREVIEW READY. ${row.preview_url ? `Look at it here: ${row.preview_url}` : "No preview deployment exists for this repo — the PR link and the screenshots stand in for it"}. The PR: ${row.pr_url ?? "(none)"}.`,
    ...(placeholders.length ? [`Ships with ${placeholders.length} placeholder${placeholders.length === 1 ? "" : "s"}: ${placeholders.join("; ")}.`] : []),
    `Reply "approved" to land it, or "changes: …" to hold it. Nothing lands without that word.${placeholders.length ? ` ("approved to production" also lands it and names the placeholders and you in the DONE email.)` : ""}`,
  ].join("\n");
}

/** Record the named bypass on the row. The 0220 trigger refuses anyone but the requesting partner. */
async function recordForce(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, byFirmUserId: string): Promise<WebPropertyChangeRow> {
  const now = new Date().toISOString();
  const placeholders = list(row.placeholders_json);
  await update(env, card.id, { forced_by: byFirmUserId, forced_at: now, forced_placeholders_json: JSON.stringify(placeholders) });
  const who = PARTNERS.find((p) => p.firmUserId === byFirmUserId)?.fullName ?? byFirmUserId;
  await appendFinding(env, card.id, `FORCED TO PRODUCTION by ${who} at ${now}: the preview gate is skipped and it lands on green with ${placeholders.length} placeholder${placeholders.length === 1 ? "" : "s"} — ${placeholders.join("; ") || "(none named)"}.`);
  await appendEvent(env, {
    eventType: "web_property_change.forced_to_production",
    actorType: "firm_user",
    actorId: byFirmUserId,
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { placeholders },
  });
  return { ...row, forced_by: byFirmUserId, forced_at: now, forced_placeholders_json: JSON.stringify(placeholders) };
}

/** The line at the top of a forced landing's DONE email. */
export function forcedLine(row: Pick<WebPropertyChangeRow, "forced_by" | "forced_placeholders_json">): string | null {
  if (!row.forced_by) return null;
  const placeholders = list(row.forced_placeholders_json);
  const who = PARTNERS.find((p) => p.firmUserId === row.forced_by)?.fullName ?? row.forced_by;
  return `Landed to production with ${placeholders.length} placeholder${placeholders.length === 1 ? "" : "s"} by ${who}'s instruction: ${placeholders.join("; ") || "(none named)"}.`;
}

async function blockWithAsks(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, asks: readonly Ask[]): Promise<string> {
  return blockCard(env, card, {
    reason: "a_question_for_you",
    trying: card.title,
    employee: PORTER_NAME,
    who: whoFor(card),
    detail: askBlockText(asks, row.plan_document_id, { publishReady: row.publish_ready !== 0, placeholders: list(row.placeholders_json) }).slice(0, 900),
  });
}

/** BLOCK on the preview: the second question. Records when it was asked so the second approval is read against it. */
async function blockOnPreview(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow): Promise<string> {
  const why = await blockCard(env, card, {
    reason: "a_question_for_you",
    trying: card.title,
    employee: PORTER_NAME,
    who: whoFor(card),
    detail: previewBlockText(row).slice(0, 900),
  });
  await update(env, card.id, { preview_emailed_at: new Date().toISOString() });
  return why;
}

/**
 * WHAT THE BLOCKED EMAIL SAYS: the asks with their defaults, then the WHOLE PLAN, readable in the
 * mail. Read from the filed Document's text (`deliverable.body`), never from the card's capped
 * column. The sweep calls this for a BLOCKED card of this kind before it emails the requester.
 */
export async function blockedEmailDetail(env: Env, cardId: string): Promise<string | null> {
  const row = await readWebPropertyChange(env, cardId);
  if (!row || !row.plan_filed_at) return null;
  const plan = row.plan_deliverable_id
    ? (await env.WP_OS_DB.prepare("SELECT body FROM deliverable WHERE id = ?1").bind(row.plan_deliverable_id).first<{ body: string }>())?.body ?? null
    : null;
  // THE PREVIEW EMAIL: the link, the PR, the placeholders and the proof — the second question.
  if (row.pr_url && row.check_state === "GREEN" && needsPreview(row) && !row.land_approved_at && !row.forced_by) {
    return [
      previewBlockText(row),
      "",
      "WHAT WAS PROVEN BEFORE THE PR:",
      "",
      row.build_proof ?? "(no proof text came back with the build)",
    ].join("\n");
  }
  // Only the PLAN email carries the plan; any other question (land it? stop? "you said no") is
  // the card's own words, which the sweep already holds.
  const blocked = await env.WP_OS_DB.prepare("SELECT block_needed FROM work_card WHERE id = ?1").bind(cardId).first<{ block_needed: string | null }>();
  if (row.plan_approved_at || !/The plan is in this email|NOT PUBLISH-READY/.test(blocked?.block_needed ?? "")) return null;
  const asks = asksOf(row);
  return [
    askBlockText(asks, row.plan_document_id, { publishReady: row.publish_ready !== 0, placeholders: list(row.placeholders_json) }),
    "",
    "THE PLAN, in full:",
    "",
    plan ?? "(the plan document could not be read back — open it on the card)",
  ].join("\n");
}

/** What the DONE email says: the proof, not the process. */
export function doneSummary(row: WebPropertyChangeRow): string {
  return [
    forcedLine(row) ?? "",
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
        preparedFor: (card.requested_by_email ? partnerByEmail(card.requested_by_email)?.firmUserId : null) ?? PREVIEW_PARTNER.firmUserId,
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
  /*
   * A FORCED LANDING IS TOLD TO BOTH PARTNERS. The requester gets the DONE reply on their thread
   * (the sweep's `announceOutcome`); the OTHER partner gets the same top line through the lane,
   * so the one who did not force it knows what shipped with placeholders and on whose word.
   */
  if (row.forced_by) {
    const requester = card.requested_by_email ? partnerByEmail(card.requested_by_email) : null;
    for (const other of PARTNERS.filter((p) => p.firmUserId !== (requester?.firmUserId ?? row.forced_by))) {
      try {
        await sendOrPreview(env, {
          to: other.email,
          email: {
            employee: PORTER_NAME,
            what: `landed to production with placeholders — ${card.title.replace(/^From [^:]+@[^:]+:\s*/i, "").slice(0, 60)}`,
            tldr: forcedLine(row)!,
            sections: [
              { label: "What shipped", bullets: [`${row.pr_url ?? "the PR"}${row.merge_sha ? ` as ${row.merge_sha.slice(0, 10)}` : ""} on ${row.property_host ?? row.target_repo}`] },
              { label: "Your call", bullets: ["Nothing — this is so you know. The card carries the placeholder list and the proof."] },
            ],
            details: finding,
          },
          objectType: "work_card",
          objectId: card.id,
          firmScope: card.firm_scope,
          cardKind: WEB_PROPERTY_CHANGE_KIND,
          workCardId: card.id,
          cardAsked: null,
          tickedByFirmUserId: null,
          requestedByEmail: other.email,
          what: card.title,
        });
      } catch (err) {
        await appendEvent(env, { eventType: "work_card.handover_failed", actorType: "system", actorId: "web_property_change", objectType: "work_card", objectId: card.id, firmScope: card.firm_scope, payload: { to: other.email, detail: String(err).slice(0, 300) } });
      }
    }
  }
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
    /*
     * A MAC "BLOCKED" IS NEVER A QUESTION FOR THE PARTNER (21 Sep 2026). The partner's decisions
     * travel as the plan's `asks`, through applyPlan and the plan email. A script that says
     * "blocked" with free text is the LANE unable to proceed — on 21 Sep a stale claimer said
     * "no Drive FOLDER is on the card" (a stop deleted from the repo eight hours earlier), this
     * turned it into "a question for you", emailed Scooter to send a folder link for a photo he
     * had attached, and parked the card for a 24-hour nag. Nothing would have moved it again but
     * a person. So: the first two "blocked" reports are failed attempts (the sweep retries, the
     * claimer may have been fixed or restarted in between); the third is a lane fault addressed
     * to the OWNER, never to the requesting partner, and it says what the Mac said.
     */
    const why = report.reason!.slice(0, 900);
    await appendFinding(env, card.id, `${report.phase} on the Mac could not proceed: ${why}`);
    if (card.work_attempts < 3) {
      return { finished: false, blocked: false, progressed: false, detail: `${report.phase} could not proceed on the Mac (attempt ${card.work_attempts}): ${why}` };
    }
    const blocked = await blockCard(env, card, {
      reason: "a_lane_refused_the_work",
      trying: card.title,
      employee: PORTER_NAME,
      who: "SEQUOIA",
      lane: "Claude Code (her Mac)",
      laneKey: "claude_code",
      laneKind: "LANE_DOWN",
      vendorWords: `the ${report.phase} script stopped itself three times: ${why}`,
      raw: why,
    });
    return { finished: false, blocked: true, progressed: false, detail: blocked };
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
      preparedFor: (card.requested_by_email ? partnerByEmail(card.requested_by_email)?.firmUserId : null) ?? PREVIEW_PARTNER.firmUserId,
      sourceType: "work_card_plan",
      sourceId: card.id,
    },
  );
  const now = new Date().toISOString();
  const asks = report.asks ?? [];
  await update(env, card.id, {
    plan_deliverable_id: filed.id,
    plan_document_id: filed.document_id ?? null,
    plan_filed_at: now,
    decided_json: JSON.stringify(report.decided ?? []),
    asks_json: JSON.stringify(asks),
    publish_ready: report.publish_ready === false ? 0 : 1,
    placeholders_json: JSON.stringify(report.placeholders ?? []),
  });
  const decided = report.decided ?? [];
  if (report.publish_ready === false) {
    await appendFinding(env, card.id, `NOT publish-ready: would ship ${(report.placeholders ?? []).length} placeholder(s) — ${(report.placeholders ?? []).join("; ")}. It will preview first; landing needs a second approval.`);
  }
  await appendFinding(
    env,
    card.id,
    `Plan filed as Document ${filed.document_id ?? filed.id}. Decided (${decided.length}): ${decided.join("; ") || "nothing"}. Asking (${asks.length}): ${askLines(asks).join("; ") || "nothing"}.`,
  );
  const fresh: WebPropertyChangeRow = { ...row, plan_document_id: filed.document_id ?? null, plan_filed_at: now, publish_ready: report.publish_ready === false ? 0 : 1, placeholders_json: JSON.stringify(report.placeholders ?? []) };
  if (row.pre_approved_phrase) return approveAtFiling(env, card, fresh, asks, report.document);
  /*
   * NO PARTNER DECISIONS IN THIS CHANGE → BUILT WITHOUT ASKING (owner, 21 Sep 2026: "why does
   * scooter need to pre-approve anything?"). The plan email exists to carry the decisions that
   * are the partner's under the policy. When there are none and the plan is publish-ready, there
   * is nothing to ask; the card proceeds to BUILD and lands on green, and the partner hears
   * RECEIVED then DONE. A single ask, or a plan that is not ready, still sends the email.
   * `validate:no-land-without-approval` pins that this branch is entered only on both facts.
   */
  if (asks.length === 0 && fresh.publish_ready === 1) return proceedWithoutAsking(env, card, fresh);
  const why = await blockWithAsks(env, card, fresh, asks);
  return { finished: false, blocked: true, progressed: false, detail: why };
}

async function proceedWithoutAsking(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow): Promise<RunOutcome> {
  const now = new Date().toISOString();
  const approvedBy = `${PORTER_ID} (no partner decisions in this change; built without asking)`;
  await update(env, card.id, { plan_approved_at: now, plan_approved_by: approvedBy, phase: "BUILD" });
  await appendFinding(env, card.id, "No partner decisions in this change; built without asking. The plan is publish-ready and every decision was structure, CSS, validators, redirects, assets or build wiring — Porter's to make. It lands on green; the partner hears when it is done.");
  const fresh: WebPropertyChangeRow = { ...row, plan_approved_at: now, plan_approved_by: approvedBy, phase: "BUILD" };
  const rules = await rulesFor(env, WEB_PROPERTY_CHANGE_KIND);
  const parked = await parkPhase(env, card, fresh, "BUILD", rules);
  if (!parked.parked) return { finished: false, blocked: false, progressed: true, detail: parked.reason };
  return { finished: false, blocked: false, progressed: true, detail: `Plan filed with nothing to ask; BUILD queued for the Mac (${phaseModel(rules, "BUILD")}).` };
}

/**
 * PRE-APPROVED IN THE REQUEST (21 Sep 2026). The partner said "your call": every ask becomes the
 * decision Porter recommended, the plan is approved AT FILING in the requesting partner's name,
 * the email is an FYI, and BUILD parks at once. NOT a landing approval: a plan that is not
 * publish-ready still stops at the preview — unless the same request carried a force phrase, in
 * which case it is forced, named, exactly as a reply would have.
 */
async function approveAtFiling(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, asks: readonly Ask[], planText: string): Promise<RunOutcome> {
  const requester = card.requested_by_email ? partnerByEmail(card.requested_by_email) : null;
  const now = new Date().toISOString();
  const decided = [...list(row.decided_json), ...decidedFromAsks(asks)];
  const approvedBy = `${requester?.firmUserId ?? card.requested_by_email ?? "the requesting partner"} (pre-approved in the request)`;
  await update(env, card.id, {
    decided_json: JSON.stringify(decided),
    asks_json: "[]",
    answers_json: JSON.stringify(approvedAnswers(asks)),
    plan_approved_at: now,
    plan_approved_by: approvedBy,
    phase: "BUILD",
  });
  await appendFinding(env, card.id, `Pre-approved in the request by ${requester?.fullName ?? card.requested_by_email ?? "the partner"} ("${row.pre_approved_phrase}"): every decision is Porter's recommendation, no options offered; the plan is approved as filed.`);
  let fresh: WebPropertyChangeRow = { ...row, decided_json: JSON.stringify(decided), asks_json: "[]", plan_approved_at: now, plan_approved_by: approvedBy, phase: "BUILD" };
  if (row.force_phrase && requester) {
    await appendFinding(env, card.id, `The same request said "${row.force_phrase}": a plan that is not publish-ready lands anyway, named as forced by ${requester.fullName}.`);
    if (needsPreview(fresh)) fresh = await recordForce(env, card, fresh, requester.firmUserId);
  }
  // NO EMAIL (her rule, 21 Sep 2026: "I don't see why Scooter should get an email at all until
  // it's done"). The plan is on the card for anyone who looks; the partner hears DONE, or a
  // question if something only they can supply is missing.
  const rules = await rulesFor(env, WEB_PROPERTY_CHANGE_KIND);
  const parked = await parkPhase(env, card, fresh, "BUILD", rules);
  if (!parked.parked) return { finished: false, blocked: false, progressed: true, detail: parked.reason };
  return { finished: false, blocked: false, progressed: true, detail: `Plan filed and pre-approved ("${row.pre_approved_phrase}"); BUILD queued for the Mac (${phaseModel(rules, "BUILD")}).` };
}

/**
 * "STOP" FROM THE PARTNER WHO ASKED HOLDS THE CARD AT ANY POINT BEFORE LAND (21 Sep 2026). A reply
 * to the FYI email lands as a note (the card is not blocked, so `steerFromReply` files it there);
 * an answer to a block lands on `block_answer`. Both are read here, only from the requester, only
 * words that read REFUSED. A queued run is closed so the Mac does not build what she stopped; a run
 * already on the Mac finishes and its report waits on the held card.
 */
async function heldByRequester(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow): Promise<string | null> {
  const requester = card.requested_by_email ? partnerByEmail(card.requested_by_email) : null;
  const since = [row.plan_approved_at, row.preview_emailed_at, row.forced_at].filter((x): x is string => Boolean(x)).sort().pop() ?? null;
  // 1 · An answer to a block, from the requester, that reads REFUSED.
  const answer = answerSince(card, since);
  if (answer && (!requester || !card.block_answered_by || card.block_answered_by === requester.firmUserId) && readApprovalReply(answer).kind === "REFUSED") {
    return answer;
  }
  // 2 · Notes nobody has read yet. EVERY unread note is acknowledged here (the sweep takes a held
  //     card only while one is unread, so an unread note left behind would spin it): the
  //     requester's "stop" holds the card; any other word of theirs is carried to the next phase
  //     as an answer; the other partner's note is kept and named, not acted on.
  const notes = (
    await env.WP_OS_DB.prepare("SELECT id, author_id, body FROM work_card_note WHERE work_card_id = ?1 AND acknowledged_at IS NULL ORDER BY created_at ASC")
      .bind(card.id)
      .all<{ id: string; author_id: string; body: string }>()
  ).results ?? [];
  let held: string | null = null;
  for (const n of notes) {
    const ack = async (response: string) =>
      env.WP_OS_DB.prepare("UPDATE work_card_note SET acknowledged_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), response = ?2 WHERE id = ?1").bind(n.id, response).run();
    if (n.body.startsWith("You asked what to do.")) {
      await ack("Read as the answer to the block.");
      continue;
    }
    const fromRequester = !requester || n.author_id === requester.firmUserId;
    if (!fromRequester) {
      await ack(`Kept, not acted on: only ${requester?.fullName ?? "the partner who asked"} steers this card.`);
      continue;
    }
    if (!held && readApprovalReply(n.body).kind === "REFUSED") {
      await ack("Held: nothing is built or landed until you say otherwise.");
      held = n.body;
      continue;
    }
    if (readApprovalReply(n.body).kind === "PREVIEW" && !row.land_approved_at) {
      // "preview" at any point before landing: see it on a preview link first.
      await ack("Noted: it will stop at a preview link and ask you before it lands.");
      await update(env, card.id, { preview_only: 1 });
      await appendFinding(env, card.id, `${card.requested_by_email ?? "The partner"} asked for a preview first ("${n.body.slice(0, 40)}").`);
      continue;
    }
    await ack("Carried into the next phase as your answer.");
    await update(env, card.id, { answers_json: JSON.stringify([...list(row.answers_json), n.body.slice(0, 2000)]) });
  }
  return held;
}

async function holdCard(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, said: string): Promise<RunOutcome> {
  if (row.current_run_id) {
    const run = await readRun(env, row.current_run_id);
    if (run?.status === "QUEUED") {
      await abandonRun(env, run.id, `${card.requested_by_email ?? "the partner"} said "${said.slice(0, 60)}" — the card is held and this phase will not run.`);
      await update(env, card.id, { current_run_id: null });
    }
  }
  await appendFinding(env, card.id, `Held by ${card.requested_by_email ?? "the partner"}: "${said.slice(0, 400)}". Nothing is built or landed until they say otherwise.`);
  const why = await blockCard(env, card, {
    reason: "a_question_for_you",
    trying: card.title,
    employee: PORTER_NAME,
    who: whoFor(card),
    detail: `You said: "${said.slice(0, 300)}". Nothing is built or landed. Reply "approved" to carry on, "changes: …" to re-plan, or "drop it" on the card.`.slice(0, 900),
  });
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
    preview_url: report.preview_url ?? null,
  });
  await appendFinding(env, card.id, `PR opened: ${report.pr_url} — checks ${state}${report.check_url ? ` (${report.check_url})` : ""}.${report.proof ? `\n${report.proof.slice(0, 1500)}` : ""}`);
  if (state !== "GREEN") {
    // The script watched the checks and they are not green. That is a failed attempt: the next
    // BUILD run resumes the same branch and fixes it. Never landed, never asked to be.
    return { finished: false, blocked: false, progressed: false, detail: `the PR's checks are ${state}: ${report.reason ?? "the build must fix them before anything lands"}` };
  }
  /*
   * THE ROW THE NEXT PHASE IS PARKED FROM CARRIES EVERYTHING THE REPORT WROTE (21 Sep 2026). The
   * first real newsletter job built PR #14 green and then landed "#null": `fresh` copied the URL
   * and the check state from the report but not the number or the branch, so the LAND job ran
   * `land ""` and `gh pr view null`. What the update wrote to the row and what the next phase read
   * from memory were two different rows. One object, every field the report carries.
   */
  const fresh: WebPropertyChangeRow = { ...row, pr_url: report.pr_url, pr_number: report.pr_number ?? row.pr_number ?? null, branch: report.branch ?? row.branch ?? null, check_state: "GREEN", check_green_at: now, check_url: report.check_url ?? row.check_url ?? null, preview_url: report.preview_url ?? null, build_proof: (report.proof ?? "").slice(0, 8000) || null };
  /*
   * A CHANGE THAT PREVIEWS FIRST STOPS HERE (21 Sep 2026). Not publish-ready, or the partner said
   * "preview": the second email carries the preview link, the PR, the placeholders and the proof,
   * and the card waits for the second "approved". Land-on-green does not apply to this row.
   */
  if (needsPreview(fresh) && !fresh.land_approved_at && !fresh.forced_by) {
    const why = await blockOnPreview(env, card, fresh);
    return { finished: false, blocked: true, progressed: false, detail: why };
  }
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

// ── Catching banter and plain questions before they reach the Mac (Addendum 10, 22 Sep 2026) ────

/**
 * THE INCIDENT THIS EXISTS FOR. Scooter replied to a thread with pure banter — "'on our side' —
 * we're all one team :)" — a joke, not a request. `dealIntake.ts`'s capture principle is "ONLY THE
 * ADDRESS IS AUTHORITY, NEVER THE CONTENT": every authenticated partner email still opens a card,
 * unconditionally, so a real ask is never silently guessed away. That is untouched. What was
 * missing is a step AFTER capture and BEFORE the card's first PLAN ever dispatches to her Mac — the
 * Mac tried to fulfil it literally: "I can't find 'on our side' anywhere on joinwestpeek.com. I
 * searched every page." A wasted Claude Code invocation on nothing.
 *
 * THREE-WAY, NOT TWO (her follow-up). A plain question — "what are you asking of me?" — is neither
 * actionable work nor banter: it has real content but nothing to build, so dispatching it for a
 * PLAN attempt wastes a cycle exactly like a joke would, just differently. `ACTIONABLE_WORK`
 * proceeds to PLAN exactly as today; `QUESTION_NEEDS_REPLY` skips the Mac and reuses the existing
 * `a_question_for_you` block reason (services/blocks.ts) — the same "needs a reply" state a partner
 * already answers elsewhere in this system, so nothing new has to be built for it to resolve;
 * `BANTER_NO_ACTION` auto-resolves the card (see `autoResolveNoAction` below).
 *
 * BIAS HARD TOWARD `ACTIONABLE_WORK`. Any real ambiguity at either boundary — work-vs-question or
 * question-vs-banter — must default to `ACTIONABLE_WORK`. Only a near-certain non-ask is ever
 * caught, and the prompt says so explicitly rather than leaving it implicit in a model's mood.
 */
export const ACTIONABILITY_VERDICTS = ["ACTIONABLE_WORK", "QUESTION_NEEDS_REPLY", "BANTER_NO_ACTION"] as const;
export type ActionabilityVerdict = (typeof ACTIONABILITY_VERDICTS)[number];

export interface ActionabilityClassification {
  verdict: ActionabilityVerdict;
  /** Brief, one sentence — this is what lands on the card and in the event_record audit row. */
  reason: string;
  aiRunId: string | null;
}

export type ActionabilityClassifier = (
  env: Env,
  input: { cardId: string; firmScope: string; text: string },
) => Promise<ActionabilityClassification>;

/** Read from the classifier's fixed answer format. Any failure to parse defaults to ACTIONABLE_WORK. */
export function parseActionabilityVerdict(outputText: string | null | undefined): { verdict: ActionabilityVerdict; reason: string } {
  const text = (outputText ?? "").trim();
  const verdictMatch = /VERDICT:\s*(ACTIONABLE_WORK|QUESTION_NEEDS_REPLY|BANTER_NO_ACTION)/i.exec(text);
  const reasonMatch = /REASON:\s*(.+)/i.exec(text);
  if (!verdictMatch) {
    return {
      verdict: "ACTIONABLE_WORK",
      reason: text ? `could not read the classifier's answer — defaulting to actionable. Raw: "${text.slice(0, 200)}"` : "the classifier returned nothing — defaulting to actionable",
    };
  }
  const verdict = verdictMatch[1]!.toUpperCase() as ActionabilityVerdict;
  return { verdict, reason: (reasonMatch?.[1] ?? text).trim().slice(0, 400) || "(no reason given)" };
}

/**
 * THE DEFAULT CLASSIFIER — one fast, cheap model call. NOT `judgement: true`: "mechanical steps
 * leave it off and stay cheap" (runAi.ts), and catching only near-certain banter or a near-certain
 * plain question is the mechanical end of "does this need an employee" rather than the drafting or
 * deciding end. Injectable so tests can prove the ROUTING (three verdicts → three outcomes) without
 * a model — see `defaultInterpreter`/`Interpreter` in instruction.ts and `Synthesise` in
 * dailyIntelligence.ts for the same shape used elsewhere in this repo.
 */
const defaultClassifyActionability: ActionabilityClassifier = async (env, input) => {
  const actor: Actor = { type: "AI", aiEmployeeId: PORTER_ID, roles: [], firmScopes: [input.firmScope] };
  const { run } = await runAi(env, {
    purpose: "checking whether a partner's email needs real work, a reply, or nothing at all",
    actor,
    inputs: [
      `${INTAKE_JUDGMENT_STANDARD}\n\n` +
        "A partner emailed the firm's work-intake address. Decide which of three things it is:\n\n" +
        "ACTIONABLE_WORK — there is a real request or task to do, however casually worded.\n" +
        "QUESTION_NEEDS_REPLY — a plain question, pushback, or something that needs an answer in " +
        "words, but nothing to build or change (e.g. \"what are you asking of me?\", \"explain it " +
        "like a sixth grader\").\n" +
        "BANTER_NO_ACTION — pure banter, a joke, an acknowledgment (\"thanks\", \"sounds good\", " +
        "\"lol true\"), or an emoji-only reply — nothing to do and nothing to answer.\n\n" +
        "BIAS HARD TOWARD ACTIONABLE_WORK. When in doubt, when the message is ambiguous or " +
        "borderline, or when it could plausibly contain a real ask however casually phrased, answer " +
        "ACTIONABLE_WORK. Only answer QUESTION_NEEDS_REPLY when you are near-certain it is a plain " +
        "question with nothing to build, and only answer BANTER_NO_ACTION when you are near-certain " +
        "there is nothing to do and nothing to answer. A real ask must never be silently guessed " +
        "away — when genuinely unsure between two of these, pick the one closer to ACTIONABLE_WORK.\n\n" +
        `THE MESSAGE:\n"""\n${input.text.slice(0, 4000)}\n"""\n\n` +
        "Answer in exactly this format and nothing else:\n" +
        "VERDICT: ACTIONABLE_WORK|QUESTION_NEEDS_REPLY|BANTER_NO_ACTION\n" +
        "REASON: <one short sentence>",
    ],
    sensitivity: "INTERNAL" as never,
    // Mechanical and cheap on purpose (see the note above `defaultClassifyActionability`); a few
    // words back is all this call needs.
    budgetContext: { expectedOutputTokens: 60 },
    routing: { category: "OPERATIONS", taskClass: "intake-actionability-classification", workCardId: input.cardId },
  });
  if (run.status !== "COMPLETED" || !run.output_text) {
    return { verdict: "ACTIONABLE_WORK", reason: `classification unavailable (${run.failure_reason ?? run.status}) — defaulting to actionable`, aiRunId: run.id };
  }
  const { verdict, reason } = parseActionabilityVerdict(run.output_text);
  return { verdict, reason, aiRunId: run.id };
};

/**
 * A CAUGHT CARD IS RECOVERABLE, NEVER A SILENT DROP. `state = 'CANCELLED'` — the existing
 * terminal, put-back-able state — carries a new `auto_resolution = 'NO_ACTION_NEEDED'` so Record
 * (and the purge job, see noActionPurge.ts) can tell an auto-caught card apart from both a real
 * DONE and a person's own Drop. Never `DONE`: no real work happened, and rendering it as if it did
 * would corrupt completion stats and Record's history of what the firm actually built.
 *
 * ALONGSIDE THE RESOLUTION, NOT INSTEAD OF IT (Addendum 11): the sender's own chief of staff
 * banters back before the card goes terminal — see `replyToBanter`. The reply step never blocks the
 * resolution; a reply that fails to send still leaves the card correctly auto-resolved.
 */
async function autoResolveNoAction(
  env: Env,
  card: WebPropertyChangeCard,
  classification: ActionabilityClassification,
  senderMessage: string,
  generateReply: BanterReplyGenerator = defaultGenerateBanterReply,
): Promise<RunOutcome> {
  await appendFinding(env, card.id, `Classified as banter/acknowledgment — auto-resolved without reaching the Mac. ${classification.reason}`);
  await env.WP_OS_DB.prepare(
    "UPDATE work_card SET state = 'CANCELLED', auto_resolution = 'NO_ACTION_NEEDED', next_action = NULL, lease_until = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  )
    .bind(card.id)
    .run();
  await appendEvent(env, {
    eventType: "work_card.auto_resolved_no_action",
    actorType: "ai_employee",
    actorId: PORTER_ID,
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { reason: classification.reason, ai_run_id: classification.aiRunId },
  });
  await replyToBanter(env, card, senderMessage, generateReply);
  return {
    finished: false,
    blocked: false,
    progressed: false,
    autoResolved: true,
    detail: `No actionable request found — auto-resolved without reaching the Mac. ${classification.reason}`.slice(0, 900),
  };
}

/**
 * A PLAIN QUESTION REUSES THE EXISTING "NEEDS A REPLY" BLOCK, rather than inventing a new state.
 * `a_question_for_you` already has a catalogue entry (shared/work/blocks.ts), already resurfaces if
 * nobody answers (`resurfaceStaleBlocks`), and already reopens through `answerBlock` exactly the
 * way a partner clears any other question on this card kind — see `blockWithAsks` above for the
 * same reason used for a plan's own asks.
 */
async function blockAsQuestion(env: Env, card: WebPropertyChangeCard, classification: ActionabilityClassification): Promise<RunOutcome> {
  const why = await blockCard(env, card, {
    reason: "a_question_for_you",
    trying: card.title,
    employee: PORTER_NAME,
    who: whoFor(card),
    detail: `This reads like a question rather than something to build (${classification.reason}). Reply here with what you'd like done, or just answer — nothing has been started.`.slice(0, 900),
  });
  await appendEvent(env, {
    eventType: "work_card.classified_as_question",
    actorType: "ai_employee",
    actorId: PORTER_ID,
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { reason: classification.reason, ai_run_id: classification.aiRunId },
  });
  return { finished: false, blocked: true, progressed: false, detail: why };
}

// ── The runner ────────────────────────────────────────────────────────────────────────────────

/** Has the partner answered since the plan (or the green) was recorded? */
function answerSince(card: WebPropertyChangeCard, since: string | null): string | null {
  if (!card.block_answered_at || !since) return null;
  if (card.block_answered_at <= since) return null;
  const text = (card.block_answer ?? "").trim();
  return text.length > 0 ? text : null;
}

export async function runWebPropertyChangeCard(
  env: Env,
  sweepCard: SweepCard,
  classify: ActionabilityClassifier = defaultClassifyActionability,
  generateBanterReply: BanterReplyGenerator = defaultGenerateBanterReply,
): Promise<RunOutcome> {
  const card: WebPropertyChangeCard =
    (await env.WP_OS_DB.prepare(
      "SELECT id, title, kind, owner_id, state, COALESCE(work_attempts,0) AS work_attempts, firm_scope, requested_by_email, preview_first, result_recipient, preview_owner_id, request_json, description, block_answer, block_answered_at, block_answered_by, assigned_from_card_id FROM work_card WHERE id = ?1",
    )
      .bind(sweepCard.id)
      .first<WebPropertyChangeCard>()) ?? sweepCard;
  let row = await readWebPropertyChange(env, card.id);
  if (!row) {
    // A card marked with the kind but never opened at the door: try the stored request.
    const ask = readWebPropertyAsk((card as WebPropertyChangeCard).request_json);
    if (ask?.target_repo) {
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
  if (row.target_repo === UNRESOLVED_REPO) {
    // "the site", and nothing recent to infer it from: the one question only they can answer.
    const why = await blockCard(env, card, {
      reason: "a_question_for_you",
      trying: card.title,
      employee: PORTER_NAME,
      who: whoFor(card),
      detail: "Which site? westpeek.ventures, westpeekproductions.com or joinwestpeek.com — reply with the one, and I'm on it.",
    });
    return { finished: false, blocked: true, progressed: false, detail: why };
  }
  const rules = await rulesFor(env, WEB_PROPERTY_CHANGE_KIND);

  // 0 · "STOP" FROM THE PARTNER WHO ASKED, at any point after the plan was approved and before LAND.
  if (row.plan_approved_at && row.phase !== "LAND") {
    const said = await heldByRequester(env, card, row);
    if (said) return holdCard(env, card, row, said);
  }

  // 1 · The lease. A run the Mac holds is the whole answer for this tick.
  if (row.current_run_id) {
    const run = await readRun(env, row.current_run_id);
    if (run && (run.status === "QUEUED" || run.status === "CLAIMED")) {
      const where = run.status === "CLAIMED" ? `on ${run.claimed_by ?? "the Mac"}${run.progress_note ? ` — ${run.progress_note}` : ""}` : "queued, waiting for the Mac to claim it";
      /*
       * IDLE PAST THE CEILING, INSIDE THE WINDOW → "I'm stuck", once (her decision, 21 Sep 2026).
       * A job nobody has claimed for `stuck_after_minutes` during `stuck_window_ct` is a Mac that
       * is asleep or a launchd job that is not running; the partner hears it once, with what
       * happens next. A run returned and re-claimed inside the ceiling says nothing.
       */
      const now = new Date();
      const idleMs = now.getTime() - Date.parse(run.status === "QUEUED" ? run.created_at : (run.progressed_at ?? run.claimed_at ?? run.created_at));
      const ceilingMs = Math.max(5, Number(rules.stuck_after_minutes ?? "45") || 45) * 60_000;
      if (run.status === "QUEUED" && idleMs > ceilingMs && stuckWindowOpen(rules.stuck_window_ct, now)) {
        await sendStuck(
          env,
          card,
          `unclaimed:${run.id}`,
          `the ${row.phase.toLowerCase()} has been waiting ${Math.round(idleMs / 60_000)} minutes for the Mac to pick it up, and it has not`,
          "it runs the moment the Mac is awake and the local-jobs job is running; nothing is lost. If you want it sooner, wake the Mac.",
        );
      }
      return { finished: false, blocked: false, progressed: true, held: true, detail: `${row.phase} is ${where}.` };
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
      /*
       * ADDENDUM 10 (22 Sep 2026): CATCH BANTER AND PLAIN QUESTIONS RIGHT HERE, BEFORE THE FIRST
       * PLAN EVER DISPATCHES TO THE MAC. This is the singular gate — `!row.plan_filed_at` is only
       * ever true before PLAN has run once for this card, so the classification runs at most once
       * per card in the ordinary path (a park failure that leaves plan_filed_at unset re-runs it
       * next tick, which is harmless and idempotent).
       */
      const senderMessage = row.request_text ?? row.ask;
      const classification = await classify(env, { cardId: card.id, firmScope: card.firm_scope, text: senderMessage });
      if (classification.verdict === "BANTER_NO_ACTION") return autoResolveNoAction(env, card, classification, senderMessage, generateBanterReply);
      if (classification.verdict === "QUESTION_NEEDS_REPLY") return blockAsQuestion(env, card, classification);
      // A Drive folder is OPTIONAL (21 Sep 2026): the request is the specification; Porter reads it
      // and asks only when something it references did not arrive.
      const parked = await parkPhase(env, card, row, "PLAN", rules);
      if (!parked.parked) return { finished: false, blocked: false, progressed: true, detail: parked.reason };
      return { finished: false, blocked: false, progressed: true, detail: `PLAN queued for the Mac (${phaseModel(rules, "PLAN")}).` };
    }
    // The plan is filed. Was it approved?
    const answer = answerSince(card, row.plan_approved_at ?? row.plan_filed_at);
    const asks = asksOf(row);
    if (!answer) {
      // Back here without an answer — reopened by a person by another door, or the block was
      // cleared some other way. Ask again rather than build on nothing.
      const why = await blockWithAsks(env, card, row, asks);
      return { finished: false, blocked: true, progressed: false, detail: why };
    }
    /*
     * ONLY THE PARTNER WHO ASKED APPROVES THEIR OWN CARD. The email door already refuses the other
     * partner; the card door lets any Managing Partner type an answer, so the same rule is applied
     * here: an answer from anyone but the requester is kept as a finding and the question stands.
     */
    const requester = card.requested_by_email ? partnerByEmail(card.requested_by_email) : null;
    if (requester && card.block_answered_by && card.block_answered_by !== requester.firmUserId) {
      await appendFinding(env, card.id, `An answer from ${card.block_answered_by} was recorded but not acted on — only ${requester.fullName} can approve this plan: "${answer.slice(0, 300)}"`);
      const why = await blockWithAsks(env, card, row, asks);
      return { finished: false, blocked: true, progressed: false, detail: why };
    }
    const reading = readApprovalReply(answer);
    if (reading.kind === "REFUSED") {
      // "no" HOLDS THE CARD. The text is on the record; the plan stands; nothing is built.
      await appendFinding(env, card.id, `Not approved by ${card.requested_by_email ?? "the partner"}: "${answer.slice(0, 600)}". The plan stands as written until they say what changes, or drop it.`);
      const why = await blockCard(env, card, {
        reason: "a_question_for_you",
        trying: card.title,
        employee: PORTER_NAME,
        who: whoFor(card),
        detail: `You said: "${answer.slice(0, 300)}". Nothing is built. Reply "changes: …" with what to change and Porter re-plans, or "drop it" on the card.`.slice(0, 900),
      });
      return { finished: false, blocked: true, progressed: false, detail: why };
    }
    const oneWord = reading.kind === "APPROVED" || reading.kind === "PREVIEW" || reading.kind === "FORCED";
    const newAnswers = oneWord ? approvedAnswers(asks) : [reading.text];
    const answers = [...list(row.answers_json), ...newAnswers];
    const now = new Date().toISOString();
    await update(env, card.id, {
      answers_json: JSON.stringify(answers),
      plan_approved_at: now,
      plan_approved_by: card.block_answered_by ?? card.requested_by_email ?? null,
      phase: "BUILD",
      // "preview" approves the plan AND asks to see it before it lands. Never a landing approval.
      ...(reading.kind === "PREVIEW" ? { preview_only: 1 } : {}),
    });
    let forcedRow: WebPropertyChangeRow = row;
    if (reading.kind === "FORCED") {
      // THE NAMED BYPASS. Recorded now, so BUILD → green lands without the preview stop.
      forcedRow = await recordForce(env, card, row, card.block_answered_by ?? requester?.firmUserId ?? "");
    }
    await appendFinding(
      env,
      card.id,
      reading.kind === "PREVIEW"
        ? `Plan approved by ${card.requested_by_email ?? "a partner"} for a PREVIEW first: every recommendation taken; the card will ask again with the preview link before anything lands.`
        : reading.kind === "APPROVED"
          ? `Plan approved by ${card.requested_by_email ?? "a partner"} with one word ("${answer.slice(0, 40)}"): every recommendation taken.`
          : `Plan approved by ${card.requested_by_email ?? "a partner"} with answers: "${answer.slice(0, 400)}"`,
    );
    await appendEvent(env, {
      eventType: "web_property_change.plan_approved",
      actorType: "firm_user",
      actorId: card.block_answered_by ?? "unknown",
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      payload: { reading: reading.kind, answer: answer.slice(0, 400) },
    });
    const fresh: WebPropertyChangeRow = { ...forcedRow, answers_json: JSON.stringify(answers), plan_approved_at: now, phase: "BUILD", preview_only: reading.kind === "PREVIEW" ? 1 : row.preview_only };
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
    // Green, and back here. A change that previews first needs the SECOND "approved" from the
    // requesting partner, read against the time the preview email went out.
    if (needsPreview(row) && !row.land_approved_at && !row.forced_by) {
      const answer = answerSince(card, row.preview_emailed_at);
      const requester = card.requested_by_email ? partnerByEmail(card.requested_by_email) : null;
      const fromRequester = !requester || !card.block_answered_by || card.block_answered_by === requester.firmUserId;
      const landReading = answer && fromRequester ? readApprovalReply(answer) : null;
      if (landReading?.kind === "FORCED") {
        const forced = await recordForce(env, card, row, card.block_answered_by ?? requester?.firmUserId ?? "");
        const parked = await parkPhase(env, card, forced, "LAND", rules);
        if (!parked.parked) return { finished: false, blocked: false, progressed: true, detail: parked.reason };
        return { finished: false, blocked: false, progressed: true, detail: `Forced to production after the preview; LAND queued for the Mac (${phaseModel(rules, "LAND")}).` };
      }
      if (landReading?.kind !== "APPROVED") {
        if (answer) {
          await appendFinding(env, card.id, `${fromRequester ? "After the preview" : `An answer from ${card.block_answered_by} (not the partner who asked)`}: "${answer.slice(0, 400)}" — not a landing approval; nothing lands.`);
        }
        const why = await blockOnPreview(env, card, row);
        return { finished: false, blocked: true, progressed: false, detail: why };
      }
      const now = new Date().toISOString();
      await update(env, card.id, { land_approved_at: now, land_approved_by: card.block_answered_by ?? card.requested_by_email ?? null });
      await appendFinding(env, card.id, `Landing approved after the preview by ${card.requested_by_email ?? "a partner"} ("${answer!.slice(0, 40)}").`);
      const fresh: WebPropertyChangeRow = { ...row, land_approved_at: now };
      const parked = await parkPhase(env, card, fresh, "LAND", rules);
      if (!parked.parked) return { finished: false, blocked: false, progressed: true, detail: parked.reason };
      return { finished: false, blocked: false, progressed: true, detail: `Landing approved after the preview; LAND queued for the Mac (${phaseModel(rules, "LAND")}).` };
    }
    // Land on green, or wait for the word.
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
  /*
   * A SWITCH IS ON OR OFF, AND THE LIST OF SWITCHES IS ONE LIST (22 Sep 2026). This used to name
   * `land_on_green` and only `land_on_green`, so 0223's `done_reply_preview_first` would have
   * accepted any forty-character string here while the Work page — which had the same name typed
   * into it separately — rendered it as a read-only badge. `ON_OFF_RULE_KEYS` is the one list both
   * sides read, and `validate:kind-rule-switches` fails the build if they ever disagree again.
   */
  if (ON_OFF_RULE_KEYS.includes(key) && !["on", "off"].includes(value)) {
    return json({ error: "invalid_input", detail: `"${row.label}" is on or off.` }, { status: 400 });
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

/**
 * Her words on the card, with the author resolved to a first name (0224). Served with the panel's
 * own row rather than from a second route: it is the same card and the same question — what is
 * going to leave the firm about this piece of work.
 */
async function requesterNotesOf(env: Env, cardId: string): Promise<{ requester_notes: string | null; requester_notes_by_name: string | null; requester_notes_at: string | null }> {
  const row = await env.WP_OS_DB.prepare("SELECT requester_notes, requester_notes_by, requester_notes_at FROM work_card WHERE id = ?1")
    .bind(cardId)
    .first<{ requester_notes: string | null; requester_notes_by: string | null; requester_notes_at: string | null }>();
  return {
    requester_notes: row?.requester_notes ?? null,
    requester_notes_by_name: row?.requester_notes_by ? (PARTNERS.find((p) => p.firmUserId === row.requester_notes_by)?.firstName ?? row.requester_notes_by) : null,
    requester_notes_at: row?.requester_notes_at ?? null,
  };
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
    asks: askLines(asksOf(row)),
    answers: list(row.answers_json),
    placeholders: list(row.placeholders_json),
    needs_preview: needsPreview(row),
    forced_by_name: row.forced_by ? (PARTNERS.find((p) => p.firmUserId === row.forced_by)?.fullName ?? row.forced_by) : null,
    forced_placeholders: list(row.forced_placeholders_json),
    attachments: (await attachmentsFor(ctx.env, id)).map((a) => ({ id: a.id, filename: a.filename, media_type: a.media_type, bytes: a.bytes })),
    notices: ((await ctx.env.WP_OS_DB.prepare("SELECT kind, cause, sent, sent_at FROM work_card_notice WHERE work_card_id = ?1 ORDER BY sent_at").bind(id).all<{ kind: string; cause: string; sent: number; sent_at: string }>()).results ?? []),
    current_run: run ? { id: run.id, status: run.status, claimed_by: run.claimed_by, claimed_at: run.claimed_at, progressed_at: run.progressed_at, progress_note: run.progress_note } : null,
    // 0224: her words for the finished email, served with the card's own facts so the panel does
    // not need a second fetch to show a field the partner is expected to fill in.
    ...(await requesterNotesOf(ctx.env, id)),
  });
}

/** The Mac's claimer, or a Managing Partner — the two who may fetch a request's files. */
function mayFetch(ctx: RouteContext): boolean {
  const identity = ctx.identity;
  if (!identity) return false;
  if (identity.email.toLowerCase() === SUBSCRIPTION_CLAIMER_EMAIL) return true;
  return identity.roles.includes("MANAGING_PARTNER");
}

/**
 * GET /api/work-cards/:id/attachments/:attId — one attached file, by name, extracted from the
 * stored message on demand (0221). The bytes never sit in D1; the Mac fetches them into the
 * package's attachments directory before the PLAN runs.
 */
export async function handleGetRequestAttachment(ctx: RouteContext): Promise<Response> {
  if (!mayFetch(ctx)) return json({ error: "forbidden", detail: "A request's files are fetched by the Mac's claimer or a Managing Partner." }, { status: 403 });
  const cardId = ctx.params.id ?? "";
  const attId = ctx.params.attId ?? "";
  const row = await ctx.env.WP_OS_DB.prepare("SELECT id, filename, media_type, bytes, eml_key FROM request_attachment WHERE id = ?1 AND work_card_id = ?2")
    .bind(attId, cardId)
    .first<RequestAttachment>();
  if (!row) return json({ error: "not_found" }, { status: 404 });
  const bucket = ctx.env.WP_OS_DOCUMENTS;
  if (!bucket) return json({ error: "no_store", detail: "the document store is not bound" }, { status: 503 });
  const obj = await bucket.get(row.eml_key);
  if (!obj) return json({ error: "not_found", detail: `the stored message ${row.eml_key} is gone` }, { status: 404 });
  const extracted = attachmentBytes(await obj.text(), row.filename);
  if (!extracted) return json({ error: "not_found", detail: `${row.filename} is not in the stored message` }, { status: 404 });
  return new Response(new Blob([extracted.bytes as BlobPart]), {
    headers: {
      "content-type": row.media_type || extracted.mediaType || "application/octet-stream",
      "content-disposition": `attachment; filename="${row.filename.replace(/"/g, "")}"`,
      "cache-control": "private, no-store",
    },
  });
}

/**
 * POST /api/inbound-email/reingest { object_key } — read a stored message through the door again
 * (21 Sep 2026: the photo email that became a "Deck" card before the door could read a partner's
 * request). Managing Partner or the Mac's claimer. The message's own dedupe key is bypassed on
 * purpose — that is what "again" means — and the event says so.
 */
export async function handleReingestStoredEmail(ctx: RouteContext): Promise<Response> {
  if (!mayFetch(ctx)) return json({ error: "forbidden" }, { status: 403 });
  const body = (await ctx.request.json().catch(() => null)) as { object_key?: unknown; received_tldr?: unknown; reply_on_thread?: unknown } | null;
  const key = typeof body?.object_key === "string" ? body.object_key.trim() : "";
  const receivedTldr = typeof body?.received_tldr === "string" ? body.received_tldr.trim().slice(0, 600) : null;
  const replyOnThread = typeof body?.reply_on_thread === "string" && /^wpt_[a-f0-9]{32}$/.test(body.reply_on_thread) ? body.reply_on_thread : null;
  if (!/^inbound-email\/[\w./-]+\.eml$/.test(key)) return json({ error: "invalid_input", detail: "object_key must be a stored inbound-email/….eml" }, { status: 400 });
  const bucket = ctx.env.WP_OS_DOCUMENTS;
  if (!bucket) return json({ error: "no_store" }, { status: 503 });
  const obj = await bucket.get(key);
  if (!obj) return json({ error: "not_found" }, { status: 404 });
  const raw = await obj.text();
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const headText = (headerEnd === -1 ? raw : raw.slice(0, headerEnd)).replace(/\r?\n[ \t]+/g, " ");
  const headers = new Headers();
  for (const line of headText.split(/\r?\n/)) {
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (m) {
      try {
        headers.append(m[1]!, m[2]!);
      } catch {
        /* an unrepresentable header is skipped */
      }
    }
  }
  const msgId = (headers.get("message-id") ?? "").replace(/^<|>$/g, "").trim();
  const from = ((headers.get("from") ?? "").match(/<([^>]+)>/)?.[1] ?? headers.get("from") ?? "").trim().toLowerCase();
  const subject = decodeMimeHeader(headers.get("subject") ?? "");

  /*
   * "AGAIN" SUPERSEDES (21 Sep 2026). The first re-read of Scooter's newsletter email created
   * NOTHING: `createWorkCardInternal` joined the new assignment into the still-BLOCKED old card
   * with the same owner and title ("runs but inert"). So every live card this message produced
   * before — the chief's assignment card by its title, and any web-property card carrying this
   * message's subject for this partner — is CANCELLED first, with the superseding key on it.
   */
  const assignmentTitle = `From ${from}: ${strippedSubject(subject) || "(no subject)"}`;
  const live = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT c.id FROM work_card c
        WHERE c.state IN ('OPEN', 'IN_PROGRESS', 'BLOCKED')
          AND lower(c.requested_by_email) = ?1
          AND (lower(trim(c.title)) = lower(trim(?2))
               OR (c.kind = 'WEB_PROPERTY_CHANGE' AND c.description LIKE ?3))`,
    )
      .bind(from, assignmentTitle, `%${strippedSubject(subject).slice(0, 80)}%`)
      .all<{ id: string }>()
  ).results ?? [];
  const superseded: string[] = [];
  for (const c of live) {
    await ctx.env.WP_OS_DB.prepare(
      `UPDATE work_card SET state = 'CANCELLED', next_action = ?2, block_nag_at = NULL, lease_until = NULL,
              description = substr(COALESCE(description, '') || char(10) || '• Superseded: this message was read through the door again from ' || ?3 || ' (21 Sep 2026 door fix); the new card carries the request.', 1, 16000)
        WHERE id = ?1`,
    )
      .bind(c.id, `Superseded by a re-read of the stored message ${key}.`, key)
      .run();
    superseded.push(c.id);
  }
  if (msgId) await ctx.env.WP_OS_DB.prepare("DELETE FROM inbound_email_seen WHERE message_id = ?1").bind(msgId).run();
  const startedAt = new Date().toISOString();
  const { handleInboundEmail } = await import("../effects/inboundEmail");
  const bytes = new TextEncoder().encode(raw);
  await handleInboundEmail({ from, to: headers.get("to") ?? "os@joinwestpeek.com", headers, raw: new Blob([bytes as BlobPart]).stream(), rawSize: bytes.byteLength }, ctx.env, { receivedTldr, replyOnThread });
  // THE NEW CARD, not "the newest card of the kind": created by this read, for this partner.
  const created = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT id, kind, owner_id, title FROM work_card WHERE lower(requested_by_email) = ?1 AND created_at >= ?2 ORDER BY (kind = 'WEB_PROPERTY_CHANGE') DESC, created_at DESC`,
    )
      .bind(from, startedAt)
      .all<{ id: string; kind: string | null; owner_id: string | null; title: string }>()
  ).results ?? [];
  const card = created[0] ?? null;
  await appendEvent(ctx.env, {
    eventType: "inbound_email.reingested",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "inbound_email",
    objectId: key,
    firmScope: "west-peek",
    payload: { message_id: msgId, superseded, created: created.map((c) => c.id), new_card: card?.id ?? null, new_card_kind: card?.kind ?? null },
  });
  if (!card) return json({ ok: false, object_key: key, superseded, detail: "the door produced no card for this partner from this message — see inbound_email events" }, { status: 409 });
  return json({ ok: true, object_key: key, superseded, new_card: card.id, new_card_kind: card.kind, owner_id: card.owner_id, title: card.title });
}
