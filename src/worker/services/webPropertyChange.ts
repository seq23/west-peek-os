import { ccAck, ccAsksIn, isOnlyACc, resolveCc } from "../../shared/work/ccPartners";
import { secondaryNoteAck } from "../../shared/work/partnerOwnership";
import type { Env } from "../env";
import { json, type RouteContext } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, type Actor } from "./authorize";
import { answerBlock, blockCard, restoreBlock } from "./blocks";
import { notifyQuietly } from "./notifications";
import { runAi } from "../ai/runAi";
import { deliver } from "./deliverables";
import { handOver } from "./employeeWork";
import { isWaitingForMac, parkRun, readRun, type SeatRunRow } from "../ai/subscriptionSeats";
import { PARTNERS, PREVIEW_PARTNER, partnerByEmail } from "../../shared/registry/partners";
import { sendOrPreview } from "./previewApproval";
import type { SweepCard } from "./workSweep";
import { hostsSentence, pagesHostsOf, readWebPropertyAsk, sitesOf, type WebPropertyAsk } from "../../shared/intake/webPropertyChange";
import { loadRegistry, recordRepoFacts, registryEntryFor } from "./webPropertyRegistry";
import { outboundFilesFor } from "./workCardFiles";
import { recordDnsWaits } from "./dnsWaits";
import { missingSecretLine, waitDetail } from "../../shared/work/porterWaits";
import { dueLine } from "../../shared/intake/dueTime";
import type { MissingSecret } from "../../shared/work/localJobs";
import { doneLines } from "../../shared/work/partnerPractices";
import { practicesForCard, recordPartnerConstraints } from "./partnerConstraints";
import { approvedAnswers, askLines, decidedFromAsks, everyAskRecommended, readApprovalReply, readAsks, stripLateThreadPrefix, type Ask } from "../../shared/work/approvalReply";
import { defaultReadReplyIntent, readReplyIntent, type ReplyIntent, type ReplyIntentReader } from "./replyIntent";
import { isReplyToOurs } from "./emailThread";
import { abandonRun } from "../ai/subscriptionSeats";
import { alreadyTold, recordNotice, routedByFor, threadRootFor, type NoticeKind } from "./requestReply";
import { doneReplyLaneFor, isOn, previewAllPartnerEmailsIsOn, rulesFor, ON_OFF_RULE_KEYS, type KindRule } from "./kindRules";
import { attachmentBytes } from "../effects/mimeAttachments";
import { SUBSCRIPTION_CLAIMER_EMAIL } from "../auth";
import { strippedSubject } from "../../shared/intake/emailTriggers";
import { decodeMimeHeader } from "../effects/inboundEmail";
import { isTechnicalBlock } from "../../shared/work/blocks";
import { INTAKE_JUDGMENT_STANDARD } from "../../shared/registry/aiEmployeePersonas";
import { defaultGenerateBanterReply, replyToBanter, type BanterReplyGenerator } from "./banterReply";
import { answerQuestionForCard, type QuestionAnswerer, type QuestionAnswerResult } from "./questionRouting";
import {
  CLAUDE_MODEL_ALIASES,
  LOCAL_JOB_RUN_KIND,
  WEB_PROPERTY_CHANGE_KIND,
  localJobKind,
  readLocalJobReport,
  type ClaudeModelAlias,
  type LocalJobPart,
  type LocalJobPartReport,
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
 *
 * ─── ONE JOB, SEVERAL REPOS (0236, 23 Sep 2026) ──────────────────────────────────────────────
 *
 * Her words: "there is a world where we ask you to fix something on the community site and
 * westpeek live in the same email." The door groups the named sites by repo; two or more repos
 * make ONE card with one `web_property_change_part` row per repo. The parent row keeps what is one
 * per job (the request, the plan and its approval, the preview gate, the force, the lease) and the
 * AGGREGATE of its parts (every PR url, GREEN only when every part is GREEN, every merge), so every
 * gate above reads the job as a whole. ONE Mac run per phase covers every repo — the one-live-run
 * index makes that the only possible shape, and one run is what gives one plan, one approval, one
 * preview email and one landing: PLAN writes a single plan over all the repos; BUILD works each
 * repo in its own worktree and opens one PR each; LAND re-checks every PR live and lands them all
 * or none. A single-repo job has no parts and runs exactly as it always did.
 */

export interface WebPropertyChangeRow {
  work_card_id: string;
  target_repo: string;
  property_host: string | null;
  drive_folder_id: string | null;
  drive_folder_url: string | null;
  ask: string;
  phase: WebPropertyChangePhase | "DONE";
  /** Kept for a card planned before 0231 — its plan is still a filed Document, still openable. */
  plan_deliverable_id: string | null;
  plan_document_id: string | null;
  /** 0231. The plan's own text, on the row — never filed into Documents. Null for a pre-0231 card. */
  plan_text: string | null;
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
  /** 0237. The DRIVE_MANIFEST paths the approved plan uses; BUILD fetches exactly these. */
  assets_json: string;
  /** 0240. What a rebuild filled in since the last preview (JSON list), for the next preview email. */
  filled_json?: string | null;
  /** 0244: the partner's words a CHANGES rebuild is for — the run's whole job, and the preview email's "changed since" line. */
  rebuilt_for?: string | null;
  /** 0240. The material set the last BUILD used, and a materials check she asked for. */
  materials_fingerprint?: string | null;
  refresh_requested_at?: string | null;
  refresh_intent?: "PREVIEW" | "PUBLISH" | "CHANGES" | null;
  /** 0240. Option 3 — "publish" with new materials: lands only a build green AFTER it. */
  publish_approved_at?: string | null;
  publish_approved_by?: string | null;
  /** 0253: keys the vault does not hold (JSON list of MissingSecret). Never a value. */
  missing_secrets_json?: string | null;
}

/** 0253: the keys a card still lacks, read back. */
export function missingSecretsOf(row: Pick<WebPropertyChangeRow, "missing_secrets_json">): MissingSecret[] {
  try {
    const v = JSON.parse(row.missing_secrets_json ?? "[]");
    return Array.isArray(v) ? v.filter((m) => m && typeof m === "object" && typeof m.name === "string").map((m) => ({ name: String(m.name), vendor_url: m.vendor_url ?? null, searched: Array.isArray(m.searched) ? m.searched.map(String) : [] })) : [];
  } catch {
    return [];
  }
}

/** 0253: the "Still missing" section every email about a card carries while a key is absent. */
export function missingSecretsSection(missing: readonly MissingSecret[]): { label: string; bullets: string[] } | null {
  if (!missing.length) return null;
  return { label: "Still missing (keys)", bullets: missing.map((m) => missingSecretLine(m.name, m.vendor_url ?? null, m.searched.join(", ") || null)) };
}

// A card's files and its missing materials live in one shared module (0237) — every employee's
// runs read them the same way. Re-exported so existing callers and tests are unchanged.
export { attachmentsFor };
export type { RequestAttachment };
import { attachmentsFor, missingFor, recordMissing, type RequestAttachment } from "./requestMaterials";
import { cleanPreviewUrls, currentPreviewLine, decidedSoFar, decisionResolutionIn, doneNotice, liveUrlsFrom, MATERIALS_ADDED_PHRASE, planNotice, previewNotice, questionNotice, STAGE, stageSubject, stuckNotice, type NoticeEmail } from "../../shared/work/porterNotices";
import { porterContext } from "./porterContext";
import type { MissingMaterial } from "../../shared/work/missingMaterials";

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
  email: { what: string; tldr: string; tldrBullets?: string[]; sections: Array<{ label: string; bullets: string[] }>; details?: string | null },
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
  const ctx = await porterContext(env, card.id);
  const onThread = replyOnThread ?? (await threadRootFor(env, card.id));
  /*
   * 0253: THE FILES THE JOB MADE ride on DONE and PREVIEW — attached when the set fits the 10 MB cap,
   * listed by name either way — and THE KEYS STILL MISSING ride on EVERY notice until they arrive,
   * each with where to get one and the exact email that sends it. Both read from the card, never
   * from the model's words.
   */
  const files = notice.kind === "DONE" || notice.kind === "PREVIEW" ? await outboundFilesFor(env, card.id) : { attachments: [], section: null };
  const keysRow = await readWebPropertyChange(env, card.id);
  const keys = missingSecretsSection(keysRow ? missingSecretsOf(keysRow) : []);
  let out: { sent: boolean; reason: string; threadToken?: string | null };
  try {
    out = await sendOrPreview(env, {
      to,
      // THE LATEST PREVIEW ON EVERY EMAIL (owner, 23 Sep 2026), once one exists — read in one place.
      email: { employee: PORTER_NAME, ...email, sections: [...email.sections, ...(files.section ? [files.section] : []), ...(keys ? [keys] : []), ...(ctx?.previewLine && !email.sections.some((s) => /preview/i.test(s.label)) ? [{ label: "Current preview", bullets: [ctx.previewLine] }] : [])], details: email.details ?? null, routedBy },
      ...(files.attachments.length ? { attachments: files.attachments } : {}),
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
      // 0239: DONE and PREVIEW copy the partners the requester asked to cc; nothing else does.
      finished: notice.kind === "DONE" || notice.kind === "PREVIEW",
    });
  } catch (err) {
    out = { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
  await recordNotice(env, { cardId: card.id, kind: notice.kind, cause: notice.cause, to, messageId: out.threadToken ?? null, sent: out.sent, detail: out.reason, firmScope: card.firm_scope });
  return { sent: out.sent, reason: out.reason };
}

/**
 * A BLOCK REMINDER REACHES AN EMAILED REQUESTER BY EMAIL (9 Oct 2026). `resurfaceStaleBlocks` rings
 * the in-app notice centre only; a partner who asked by email (Scooter works by email alone) never
 * saw "Still waiting on you". The sweep hands each rung row here, and the same Porter notice the
 * block first sent (PREVIEW, PLAN, QUESTION, STUCK) goes again on the card's thread, headed by how
 * long it has waited. Cause `nag:<n>` makes it once per ring. Null composer (not a web property
 * change card) → nothing sent here; the in-app notice stands either way.
 */
export async function remindRequesterByEmail(
  env: Env,
  row: { id: string; block_needed: string | null; block_nags: number; blocked_at: string | null },
  now: Date,
): Promise<{ sent: boolean; reason: string }> {
  const card = await env.WP_OS_DB.prepare("SELECT id, title, firm_scope, requested_by_email, preview_first, preview_owner_id, assigned_from_card_id FROM work_card WHERE id = ?1")
    .bind(row.id)
    .first<WebPropertyChangeCard>();
  if (!card) return { sent: false, reason: "no such card" };
  const { kind } = await noticeFor(env, row.id, "BLOCKED");
  const email = await porterNoticeEmail(env, row.id, kind, row.block_needed ?? "", { resend: true });
  if (!email) return { sent: false, reason: "not a web property change card" };
  const nag = (row.block_nags ?? 0) + 1;
  const days = row.blocked_at ? Math.max(1, Math.round((now.getTime() - Date.parse(row.blocked_at)) / 86_400_000)) : 1;
  // WHAT CLEARS IT, IN THE CARD'S OWN WORDS — when the composed notice does not already carry them.
  const needed = (row.block_needed ?? "").split("\n").map((l) => l.replace(/^[•·\-*]\s+/, "").trim()).filter(Boolean);
  const carried = JSON.stringify(email);
  const neededSection = needed.length && !needed.every((l) => carried.includes(l)) ? [{ label: "What I'm waiting on", bullets: needed.slice(0, 12) }] : [];
  return tellRequester(env, card, { kind, cause: `nag:${nag}` }, {
    ...email,
    tldr: `Still waiting on you (${days} day${days === 1 ? "" : "s"}). ${email.tldr}`,
    sections: [...neededSection, ...email.sections],
  });
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
  const parts = await readParts(env, cardId);
  // The plain title (porterContext): the partner's subject, never the brief cut off mid-word.
  const asked = (await porterContext(env, cardId))?.title ?? (card.title.replace(/^From [^:]+@[^:]+:\s*/i, "").trim() || card.title);
  // WHAT COMES NEXT, READ FROM THE GATE ITSELF (0238): every site change previews first unless the
  // request carried the named force, so "the finished result" is only promised when it is true.
  // (A force phrase acts only beside a pre-approval — `approveAtFiling` is its one reader.)
  const afterBuild = needsPreview(row) && !(row.pre_approved_phrase && row.force_phrase)
    ? `the preview link — reply "approved" and it goes live`
    : "the finished result";
  const next = row.pre_approved_phrase
    ? `You pre-approved this ("${row.pre_approved_phrase}"), so the next thing you'll get is ${afterBuild}.`
    : `If any decision is yours to make — brand, copy meaning, legal wording, a public claim, image rights, money — I'll send you the plan with those questions; one word back is enough. If none is, the next thing you'll get is ${afterBuild}.`;
  const assumption = row.property_assumed_from ? `I'm reading "the site" as ${row.property_assumed_from} — reply if not.` : null;
  const unresolved = row.target_repo === UNRESOLVED_REPO ? "You said \"the site\" and I have nothing recent to go on — I'll ask you which one." : null;
  return tellRequester(env, card, { kind: "RECEIVED", cause: "" }, {
    what: stageSubject(asked, STAGE.RECEIVED),
    tldr: input.tldr?.trim() || `Got it — I'm on it. ${assumption ? `${assumption} ` : ""}${unresolved ? `${unresolved} ` : ""}${next}`,
    sections: [
      {
        label: "What I understood",
        bullets: [
          `Property: ${row.target_repo === UNRESOLVED_REPO ? "unresolved — I'll ask" : row.property_host ?? row.target_repo}${assumption ? ` (${assumption})` : ""}`,
          ...(parts.length
            ? [`Repos: ${parts.map((p) => `${p.repo} (${p.property_host})`).join("; ")} — one job, one PR in each, and they land together or not at all`]
            : []),
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
    what: stageSubject((await porterContext(env, card.id))?.title ?? card.title.replace(/^From [^:]+@[^:]+:\s*/i, "").slice(0, 60), STAGE.STUCK),
    tldr: `Blocked: ${reason} — ${next}`,
    sections: [
      { label: "Why", bullets: [reason] },
      { label: "What happens next", bullets: [next, `The card: https://os.joinwestpeek.com/#/work (card ${card.id})`] },
    ],
  });
}

/**
 * ASLEEP — the lane that builds is her Mac, and it is not awake (28 Sep 2026). Once per run.
 *
 * Her ruling, after a night of five "Blocked" emails for a closed lid: the closed-lid case is not a
 * block and must never say so. The partner hears, once, that the lane is closed because the Mac is
 * asleep, that Porter starts the moment it wakes, and that the owner of the Mac can be asked to wake
 * it. The subject says "Waiting for the Mac", never "Blocked"; the card is not blocked either.
 */
export async function sendAsleep(env: Env, card: WebPropertyChangeCard, cause: string, reason: string): Promise<{ sent: boolean; reason: string }> {
  return tellRequester(env, card, { kind: "STUCK", cause }, {
    what: stageSubject((await porterContext(env, card.id))?.title ?? card.title.replace(/^From [^:]+@[^:]+:\s*/i, "").slice(0, 60), STAGE.ASLEEP),
    tldr: `Not started yet: the lane I build on (Sequoia's Mac) is asleep. I'll get to work the moment it wakes; nothing you sent is lost.`,
    sections: [
      { label: "Why", bullets: [reason] },
      {
        label: "What happens next",
        bullets: [
          "The job waits in the queue and runs by itself when the Mac wakes; I do not need anything from you.",
          "If you want it sooner, tell Sequoia to open the Mac.",
          `The card: https://os.joinwestpeek.com/#/work (card ${card.id})`,
        ],
      },
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
    `INSERT INTO web_property_change (work_card_id, target_repo, property_host, drive_folder_id, drive_folder_url, ask, firm_scope, pre_approved_phrase, force_phrase, preview_only)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT (work_card_id) DO UPDATE SET
       target_repo = excluded.target_repo, property_host = excluded.property_host,
       drive_folder_id = excluded.drive_folder_id, drive_folder_url = excluded.drive_folder_url,
       ask = excluded.ask, pre_approved_phrase = excluded.pre_approved_phrase, force_phrase = excluded.force_phrase,
       preview_only = MAX(web_property_change.preview_only, excluded.preview_only),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  )
    /*
     * PREVIEW FIRST, ALWAYS (owner, 23 Sep 2026: "we should default to preview first for all repo
     * work"). preview_only is written 1 on every open, whatever the request said — the request's own
     * "preview first" phrase is still parsed and kept in request_json, but it no longer decides the
     * default. The ONLY way past the preview is the named force ("approved to production" →
     * `recordForce`), which leaves preview_only as it is and records `forced_by`. Never cleared by a
     * re-read. `validate:no-land-without-approval` holds this bind to the literal 1.
     */
    .bind(input.cardId, input.ask.target_repo ?? UNRESOLVED_REPO, input.ask.property_host, input.ask.drive_folder_id, input.ask.drive_folder_url, input.ask.ask, input.firmScope, input.ask.pre_approval ?? null, input.ask.force ?? null, 1)
    .run();
  // The readable request, the specification Porter reads first (0221); and, when "the site" was
  // inferred from a recent card, where the assumption came from (0222).
  await env.WP_OS_DB.prepare("UPDATE web_property_change SET request_text = ?2, property_assumed_from = ?3 WHERE work_card_id = ?1").bind(input.cardId, input.ask.ask.slice(0, 12000), input.assumedFrom ?? null).run();
  // SEVERAL REPOS → ONE PART EACH (0236). Re-opening the same card rewrites its parts from the ask;
  // a single-repo ask leaves none, so it runs exactly as before.
  if ((input.ask.parts?.length ?? 0) > 1) {
    await env.WP_OS_DB.prepare("DELETE FROM web_property_change_part WHERE work_card_id = ?1 AND merge_sha IS NULL").bind(input.cardId).run();
    for (const [i, part] of input.ask.parts!.entries()) {
      await env.WP_OS_DB.prepare(
        "INSERT INTO web_property_change_part (work_card_id, repo, position, property_host, ask) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (work_card_id, repo) DO NOTHING",
      )
        .bind(input.cardId, part.repo, i, part.property_host, part.ask.slice(0, 12000))
        .run();
    }
  }
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

/** One repo of a multi-repo job (0236). */
export interface WebPropertyChangePart {
  work_card_id: string;
  repo: string;
  position: number;
  property_host: string;
  ask: string;
  pr_url: string | null;
  pr_number: number | null;
  branch: string | null;
  check_state: "PENDING" | "GREEN" | "RED" | null;
  check_url: string | null;
  check_green_at: string | null;
  preview_url: string | null;
  build_proof: string | null;
  merge_sha: string | null;
  landed_at: string | null;
  live_proof: string | null;
}

/** The parts of a card, in order. [] for a single-repo job — the only test of "is this multi-repo". */
export async function readParts(env: Env, cardId: string): Promise<WebPropertyChangePart[]> {
  return (await env.WP_OS_DB.prepare("SELECT * FROM web_property_change_part WHERE work_card_id = ?1 ORDER BY position ASC").bind(cardId).all<WebPropertyChangePart>()).results ?? [];
}

async function updatePart(env: Env, cardId: string, repo: string, sets: Record<string, string | number | null>): Promise<void> {
  const keys = Object.keys(sets);
  if (keys.length === 0) return;
  const assign = keys.map((k, i) => `${k} = ?${i + 3}`).join(", ");
  await env.WP_OS_DB.prepare(`UPDATE web_property_change_part SET ${assign}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE work_card_id = ?1 AND repo = ?2`)
    .bind(cardId, repo, ...keys.map((k) => sets[k]!))
    .run();
}

/**
 * THE PARENT ROW CARRIES THE AGGREGATE OF ITS PARTS, so every gate that reads the row reads the
 * whole job: GREEN only when every part is GREEN (RED when any is), a PR url for each part, a merge
 * only when every part merged. Pure.
 */
export function aggregateParts(parts: readonly Pick<WebPropertyChangePart, "repo" | "pr_url" | "check_state" | "check_green_at" | "preview_url" | "build_proof" | "merge_sha">[]): {
  pr_url: string | null;
  check_state: "PENDING" | "GREEN" | "RED";
  check_green_at: string | null;
  preview_url: string | null;
  build_proof: string | null;
  merge_sha: string | null;
} {
  const states = parts.map((p) => p.check_state ?? "PENDING");
  const check_state = states.some((x) => x === "RED") ? "RED" : parts.length > 0 && states.every((x) => x === "GREEN") ? "GREEN" : "PENDING";
  const greens = parts.map((p) => p.check_green_at).filter((x): x is string => Boolean(x)).sort();
  const withPr = parts.filter((p) => p.pr_url);
  return {
    pr_url: withPr.length ? withPr.map((p) => p.pr_url).join(" · ") : null,
    check_state,
    check_green_at: check_state === "GREEN" && greens.length === parts.length ? greens[greens.length - 1]! : null,
    preview_url: parts.some((p) => p.preview_url) ? parts.map((p) => `${p.repo}: ${p.preview_url ?? "no preview deployment"}`).join(" · ") : null,
    build_proof: parts.some((p) => p.build_proof) ? parts.map((p) => `── ${p.repo} ──\n${p.build_proof ?? "(no proof came back for this repo)"}`).join("\n\n").slice(0, 8000) : null,
    merge_sha: parts.length > 0 && parts.every((p) => p.merge_sha) ? parts.map((p) => `${p.repo}@${p.merge_sha}`).join(", ") : null,
  };
}

/** Which parts stop the job landing, in words for the card: "westpeek-live RED (url)". Empty when every part is green. */
export function notGreenParts(parts: readonly Pick<WebPropertyChangePart, "repo" | "pr_url" | "pr_number" | "check_state" | "check_green_at">[]): string[] {
  return parts
    .filter((p) => !(p.pr_url && p.pr_number && p.check_state === "GREEN" && p.check_green_at))
    .map((p) => `${p.repo} ${p.pr_url ? `${p.check_state ?? "PENDING"} (${p.pr_url})` : "has no PR yet"}`);
}

function partPayload(p: WebPropertyChangePart): LocalJobPart {
  return {
    repo: p.repo,
    property_host: p.property_host,
    sites: sitesOf(p.property_host),
    pages_hosts: pagesHostsOf(p.property_host),
    ask: p.ask,
    pr: p.pr_url ? { url: p.pr_url, number: p.pr_number, branch: p.branch, check_state: p.check_state, check_green_at: p.check_green_at, preview_url: p.preview_url } : null,
    merge_sha: p.merge_sha,
  };
}

/** Write what the Mac reported for each repo, then the parent's aggregate. Returns the fresh parts. */
async function recordPartReports(env: Env, cardId: string, reports: readonly LocalJobPartReport[], phase: "BUILD" | "LAND"): Promise<WebPropertyChangePart[]> {
  const known = await readParts(env, cardId);
  const now = new Date().toISOString();
  for (const r of reports) {
    const part = known.find((p) => p.repo === r.repo);
    if (!part) continue; // a repo this card never named is not written, whatever the Mac said
    if (phase === "BUILD" && r.pr_url) {
      const state = r.check_state ?? "PENDING";
      await updatePart(env, cardId, r.repo, {
        pr_url: r.pr_url,
        pr_number: r.pr_number ?? part.pr_number ?? null,
        branch: r.branch ?? part.branch ?? null,
        check_state: state,
        check_url: r.check_url ?? null,
        check_green_at: state === "GREEN" ? (part.check_state === "GREEN" && part.check_green_at ? part.check_green_at : now) : null,
        preview_url: r.preview_url ?? null,
        build_proof: (r.proof ?? "").slice(0, 8000) || null,
      });
    }
    if (phase === "LAND" && r.merge_sha && !part.merge_sha) {
      // The 0236 trigger refuses this unless every part is green and the approvals are on the parent.
      await updatePart(env, cardId, r.repo, { merge_sha: r.merge_sha, landed_at: now, live_proof: (r.live_proof ?? "").slice(0, 8000) || null });
    }
  }
  return readParts(env, cardId);
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

/**
 * A QUEUED JOB IS KEPT CURRENT (27 Sep 2026). BUILD used to park only after the partner's reply, so
 * the files that reply carried were already on the card when the payload was written. Now that a plan
 * with nothing to decide parks BUILD the moment it is filed, a reply can arrive while the job waits
 * for the Mac — Scooter's Carlos photo, an hour after the plan. The Mac fetches exactly the
 * `attachments` the payload lists, so a payload frozen at parking would build without the file.
 * Until the Mac CLAIMS the job, its `attachments` and the plan's `answers` are re-read from the card
 * on every tick; a claimed job is never rewritten under the Mac.
 */
async function refreshQueuedJob(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, run: SeatRunRow): Promise<void> {
  if (!run.job_json) return;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(run.job_json) as Record<string, unknown>;
  } catch {
    return;
  }
  const attachments = (await attachmentsFor(env, card.id)).map((a) => ({ id: a.id, filename: a.filename, media_type: a.media_type, bytes: a.bytes, path: `/api/work-cards/${card.id}/attachments/${a.id}` }));
  const plan = payload.plan && typeof payload.plan === "object" ? { ...(payload.plan as Record<string, unknown>), answers: list(row.answers_json), approved_at: row.plan_approved_at } : payload.plan;
  const next = { ...payload, attachments, plan };
  const before = JSON.stringify(payload);
  const after = JSON.stringify(next);
  if (before === after) return;
  await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET job_json = ?2 WHERE id = ?1 AND status = 'QUEUED'").bind(run.id, after).run();
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
    // THE APPROVAL BINDS TO THE LATEST PREVIEW (0240): an "approved" older than the preview now
    // showing never lands it, and "publish" with new materials lands only a build green after it.
    if (needsPreview(row) && !row.forced_by && row.land_approved_at && row.preview_emailed_at && row.land_approved_at < row.preview_emailed_at) return { parked: false, reason: "the landing approval predates the latest preview — a stale approval never lands" };
    if (row.publish_approved_at && (!row.check_green_at || row.check_green_at <= row.publish_approved_at)) return { parked: false, reason: "\"publish\" was approved, but no build with the new materials has gone green since — nothing lands" };
    // SEVERAL REPOS LAND ALL OR NOTHING (0236): every part's PR recorded green, or nothing is parked.
    const blocking = notGreenParts(await readParts(env, card.id));
    if (blocking.length) return { parked: false, reason: `not every PR is green, so none lands: ${blocking.join("; ")}` };
  }
  if (phase === "BUILD" && !row.plan_approved_at) return { parked: false, reason: "the plan has not been approved yet" };

  const parts = await readParts(env, card.id);
  // One run covers every repo; BUILD and LAND work them one after another, so the ceiling scales.
  const maxSeconds = spec.phases[phase].maxSeconds * (phase === "PLAN" ? 1 : Math.max(1, parts.length));
  // 0253: the registry names the repo's GitHub home and the secret NAMES the duty may inject.
  const registry = await loadRegistry(env);
  const entry = await registryEntryFor(env, row.target_repo);
  const payload: LocalJobPayload & { queue_max_seconds: number } = {
    card_kind: WEB_PROPERTY_CHANGE_KIND,
    phase,
    model: phaseModel(rules, phase),
    max_seconds: maxSeconds,
    prompt_file: spec.promptFile,
    script: spec.script,
    card: { id: card.id, title: card.title, requested_by: card.requested_by_email ?? null },
    target_repo: row.target_repo,
    property_host: row.property_host,
    github_repo: entry?.githubRepo ?? null,
    secret_names: [...(entry?.secretNames ?? [])],
    missing_secrets: missingSecretsOf(row),
    constraints: [...(entry?.constraints ?? [])],
    // R7–R23 FOR EVERY KIND (0254): the SAME standing-practices block every other duty's prompt carries,
    // with the requesting partner's constraints register — carried on the job because the duty imports nothing from src/.
    practices: await practicesForCard(env, card.id, card.firm_scope),
    // 0256: Drive files a partner shared onto this card, with their text as read through the firm's delegation.
    drive_files: await (await import("./driveShares")).driveFilesFor(env, card.id),
    due: readWebPropertyAsk(card.request_json)?.due ?? null,
    sites: sitesOf(row.property_host, registry),
    pages_hosts: pagesHostsOf(row.property_host, registry),
    drive: { folder_id: row.drive_folder_id, folder_url: row.drive_folder_url },
    ask: row.ask,
    plan: row.plan_filed_at
      ? {
          document_id: row.plan_document_id,
          /*
           * THE PLAN'S TEXT RIDES ON THE JOB, the Mac that runs BUILD may not be the one that ran
           * PLAN. Since 0231 the row's own `plan_text` is the source of truth (0231, Addendum 4.3:
           * the plan is not filed into Documents any more). `plan_deliverable_id` is read only as a
           * fallback, for a card planned before 0231 whose plan still lives solely in the
           * deliverable this row used to file.
           */
          text: row.plan_text
            ? row.plan_text
            : row.plan_deliverable_id
              ? ((await env.WP_OS_DB.prepare("SELECT body FROM deliverable WHERE id = ?1").bind(row.plan_deliverable_id).first<{ body: string }>())?.body ?? null)
              : null,
          decided: list(row.decided_json),
          asks: asksOf(row),
          answers: list(row.answers_json),
          approved_at: row.plan_approved_at,
          publish_ready: row.publish_ready !== 0,
          placeholders: list(row.placeholders_json),
          preview_only: row.preview_only === 1,
          // 0237: the Drive assets the plan will use; BUILD fetches exactly these.
          assets: list(row.assets_json),
        }
      : null,
    pre_approved: row.pre_approved_phrase,
    request: row.request_text ?? row.ask,
    attachments: (await attachmentsFor(env, card.id)).map((a) => ({ id: a.id, filename: a.filename, media_type: a.media_type, bytes: a.bytes, path: `/api/work-cards/${card.id}/attachments/${a.id}` })),
    pr: row.pr_url ? { url: row.pr_url, number: row.pr_number, branch: row.branch, check_state: row.check_state, check_green_at: row.check_green_at, preview_url: row.preview_url, land_approved_at: row.land_approved_at, forced_by: row.forced_by, preview_emailed_at: row.preview_emailed_at ?? null, publish_approved_at: row.publish_approved_at ?? null } : null,
    // 0240: a materials check asked for by her reply or the button, and what the last build used.
    refresh: phase === "BUILD" && (row.refresh_intent === "PREVIEW" || row.refresh_intent === "PUBLISH"),
    materials_fingerprint: row.materials_fingerprint ?? null,
    // 0244: a rebuild after the preview says so, and a CHANGES rebuild carries the partner's words
    // as THE job — not one answer among many the model may decide are already done.
    rebuild:
      phase === "BUILD" && row.refresh_intent
        ? { intent: row.refresh_intent, changes: row.refresh_intent === "CHANGES" ? (row.rebuilt_for ?? list(row.answers_json).at(-1) ?? null) : null, since: row.preview_emailed_at ?? null }
        : null,
    rules,
    ...(parts.length ? { parts: parts.map(partPayload) } : {}),
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
      maxSeconds,
      runKind: LOCAL_JOB_RUN_KIND,
      jobJson: JSON.stringify(payload),
    });
  } catch (err) {
    // The one-live-run index refused a second row. The card already holds a run; say so.
    return { parked: false, reason: `a run is already live for this card (${err instanceof Error ? err.message.slice(0, 120) : String(err)})` };
  }
  await update(env, card.id, { current_run_id: runId, phase });
  await env.WP_OS_DB.prepare("UPDATE work_card SET next_action = ?2, waiting_until = NULL, waiting_for = NULL WHERE id = ?1")
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
   * WAITING FOR A PLAN TO RESET (1 Oct 2026). With `held`: the ISO time the sweep leaves this card alone until,
   * instead of the usual few minutes. Set only when both subscription seats reported a spent plan.
   */
  waitUntil?: string;
  /**
   * BANTER RESOLVED WITHOUT EVER REACHING THE MAC (Addendum 10, 22 Sep 2026). The card is already
   * terminal — `state = 'CANCELLED'`, `auto_resolution = 'NO_ACTION_NEEDED'` — by the time this
   * comes back; the sweep reads it to skip the DONE/BLOCKED bookkeeping and record its own outcome.
   */
  autoResolved?: boolean;
  /**
   * A QUESTION WAS ANSWERED BY WHOEVER OWNS THE KIND, CONFIDENTLY, WITHOUT EVER REACHING HER
   * (Addendum 12, 22 Sep 2026). The card is already terminal — `state = 'CANCELLED'`,
   * `question_auto_answered_at` set — by the time this comes back; the sweep reads it to skip the
   * DONE/BLOCKED bookkeeping and record its own outcome, the same shape `autoResolved` already is.
   */
  questionAnswered?: boolean;
  detail: string;
}

/**
 * THE QUESTION ON THE CARD, SHORT; THE PLAN IN THE MAIL, WHOLE (owner, 21 Sep 2026: "the approval
 * step must have zero friction"). The card's `block_needed` is capped at 900 characters by the
 * catalogue, so it carries the numbered asks with Porter's recommended default and the one word
 * that approves. The EMAIL carries the whole plan above them — `blockedEmailDetail` assembles it
 * where the partner email is composed, from the filed Document's text.
 */
export function askBlockText(asks: readonly Ask[], readiness?: { publishReady: boolean; placeholders: string[] }): string {
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
    // NEVER "…on the card as a Document" (0231): the plan is not filed into Documents any more —
    // it is on the card's own trail. The literal "The plan is in this email" substring stays,
    // because `noticeFor()`/`blockedEmailDetail()` both match it to recognise a PLAN block.
    `The plan is in this email and on the card.${asks.length ? ` ${asks.length} decision${asks.length === 1 ? "" : "s"}, each with a recommendation:` : ""}`,
    ...lines,
    notReady
      ? `Reply "approved" to take every recommendation and build the preview. Reply "approved to production" to skip the preview and land on green with the placeholders as they are — the DONE email will name them and you. Reply "no" or "changes: …" to hold it. Anything else is read as your answers.`
      : `Reply "approved" to take every recommendation and build; you'll get a preview link, and it goes live only when you approve that too. Reply "approved to production" to skip the preview and land on green. Reply "no" or "changes: …" to hold it. Anything else is read as your answers.`,
  ].join("\n");
}

/** The second question: the preview is up, land it? One email for every repo of the job. */
export function previewBlockText(
  row: Pick<WebPropertyChangeRow, "pr_url" | "preview_url" | "placeholders_json" | "publish_ready"> & Partial<Pick<WebPropertyChangeRow, "property_host" | "branch" | "rebuilt_for">>,
  parts: readonly Pick<WebPropertyChangePart, "repo" | "property_host" | "pr_url" | "preview_url">[] = [],
): string {
  const placeholders = list(row.placeholders_json);
  // 0244: a preview rebuilt for the partner's words says what it changed, in their words.
  const changed = row.rebuilt_for?.trim() ? [`Changed since the last preview, as you asked: "${row.rebuilt_for.trim().slice(0, 300)}".`] : [];
  // THE ONE CLEAN LINK (23 Sep 2026): the site's branch alias, never six URLs and HTML fragments.
  row = { ...row, preview_url: cleanPreviewUrls(row.preview_url, pagesHostsOf(row.property_host ?? null), row.branch ?? "") };
  if (parts.length) {
    return [
      `PREVIEW READY in ${parts.length} repos — one landing for all of them:`,
      ...changed,
      ...parts.map((p) =>
        `• ${p.repo} (${p.property_host}): ${p.preview_url ? `look at it here: ${p.preview_url}` : "no preview deployment for this repo — the PR and its screenshots stand in for it"}. The PR: ${p.pr_url ?? "(none)"}.`,
      ),
      ...(placeholders.length ? [`Ships with ${placeholders.length} placeholder${placeholders.length === 1 ? "" : "s"}: ${placeholders.join("; ")}.`] : []),
      `Reply "approved" to land every PR together, or "changes: …" to hold them all. Nothing lands without that word, and nothing lands unless every PR is green.${placeholders.length ? ` ("approved to production" also lands them and names the placeholders and you in the DONE email.)` : ""}`,
    ].join("\n");
  }
  return [
    `PREVIEW READY. ${row.preview_url ? `Look at it here: ${row.preview_url}` : "No preview deployment exists for this repo — the PR link and the screenshots stand in for it"}. The PR: ${row.pr_url ?? "(none)"}.`,
    ...changed,
    ...(placeholders.length ? [`Ships with ${placeholders.length} placeholder${placeholders.length === 1 ? "" : "s"}: ${placeholders.join("; ")}.`] : []),
    `Reply "approved" to land it, or "changes: …" to hold it. Nothing lands without that word.${placeholders.length ? ` ("approved to production" also lands it and names the placeholders and you in the DONE email.)` : ""}`,
  ].join("\n");
}

/** "fu_sequoia_taylor" / "sequoia@…" → "Sequoia"; anything else (Porter's own approval) as it is. */
export function approverName(by: string | null | undefined): string | null {
  if (!by) return null;
  const p = PARTNERS.find((x) => x.firmUserId === by || x.email === by.toLowerCase());
  if (/^request:/.test(by)) return "the request (every decision carried a recommendation)";
  return p ? p.firstName : /built without asking/.test(by) ? "Porter (nothing to ask)" : /pre-approved/.test(by) ? `${PARTNERS.find((x) => by.startsWith(x.firmUserId))?.firstName ?? "the partner"} (pre-approved in the request)` : by;
}

/**
 * PORTER'S PLAN AND PREVIEW EMAILS, COMPOSED FROM THE ROW (owner, 23 Sep 2026). The sweep asks for
 * this before it emails the requester; null for every other notice, which keeps the shared skeleton
 * (plus the current preview line, from `porterContext`). See `shared/work/porterNotices.ts`.
 */
export async function porterNoticeEmail(env: Env, cardId: string, kind: NoticeKind, detail: string = "", opts: { resend?: boolean; fyi?: boolean } = {}): Promise<NoticeEmail | null> {
  const row = await readWebPropertyChange(env, cardId);
  const ctx = await porterContext(env, cardId);
  if (!row || !ctx) return null;
  const missing = await missingFor(env, cardId);
  // THE QUESTION ITSELF — the card's `block_needed`, what would clear it — never the long sentence the
  // sweep wraps around it; the sweep's own detail only when the card carries none.
  const needed = (await env.WP_OS_DB.prepare("SELECT block_needed FROM work_card WHERE id = ?1").bind(cardId).first<{ block_needed: string | null }>())?.block_needed ?? "";
  const lines = (needed.trim() || detail).split("\n").map((l) => l.replace(/^[•·\-*]\s+/, "").trim()).filter(Boolean);
  if (kind === "PLAN") return planNotice({ title: ctx.title, asks: asksOf(row), missing, previewLine: ctx.previewLine, cardId, sites: ctx.sites, fyi: opts.fyi ?? false });
  if (kind === "PREVIEW") {
    // A preview's round counts the previews actually sent, re-sends of the same one excluded.
    const sent = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card_notice WHERE work_card_id = ?1 AND kind = 'PREVIEW' AND sent = 1 AND cause NOT LIKE 'resend:%'").bind(cardId).first<{ n: number }>();
    return previewNotice({ title: ctx.title, previewLine: ctx.previewLine, placeholders: list(row.placeholders_json), filled: list(row.filled_json), changed: row.rebuilt_for ?? null, round: Math.max(1, (sent?.n ?? 0) + (opts.resend ? 0 : 1)), cardId, sites: ctx.sites, decided: decidedSoFar(asksOf(row), list(row.answers_json), approverName(row.plan_approved_by)) });
  }
  if (kind === "QUESTION") return questionNotice({ title: ctx.title, question: lines.slice(0, 12), previewLine: ctx.previewLine, missing: missing.map((m) => m.item), cardId });
  if (kind === "STUCK") return stuckNotice({ title: ctx.title, blockedBy: lines[0] ?? "something on our side stopped the work", next: lines[1] ?? "Sequoia has been told; you don't need to do anything.", previewLine: ctx.previewLine, cardId });
  if (kind === "DONE") {
    // Every site that went live, from the LAND's own curl proof — each repo's, for a job over several.
    const parts = await readParts(env, cardId);
    const proof = [row.live_proof ?? "", ...parts.map((p) => p.live_proof ?? "")].join("\n");
    return doneNotice({ title: ctx.title, liveUrls: liveUrlsFrom(proof), forced: forcedLine(row), missing: missing.map((m) => m.item), previewLine: ctx.previewLine, cardId });
  }
  return null;
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
    detail: [waitDetail("PLAN_APPROVAL"), askBlockText(asks, { publishReady: row.publish_ready !== 0, placeholders: list(row.placeholders_json) })].join("\n").slice(0, 900),
  });
}

/** BLOCK on the preview: the second question. Records when it was asked so the second approval is read against it. */
/**
 * What her KEYWORD reply to a preview asks for (0240). Null: not a keyword rebuild — "approved",
 * "no"/"stop", and FREE TEXT, which since 27 Sep 2026 is read for its intent by the runner
 * (`replyIntent.ts`: CONTINUE lands or rebuilds with the changes, STOP holds, QUESTION is answered).
 * Pure.
 */
export function rebuildIntentFor(answer: string): "PREVIEW" | "PUBLISH" | "CHANGES" | null {
  if (decisionResolutionIn(answer)) return null;
  if (/^Attached: [^\n]+$/.test(answer.trim())) return "PREVIEW";
  if (answer.trim().replace(/[.!]+$/, "").toLowerCase() === MATERIALS_ADDED_PHRASE.toLowerCase()) return "PREVIEW";
  const r = readApprovalReply(answer);
  if (r.kind === "PUBLISH") return "PUBLISH";
  if (r.kind === "PREVIEW") return "PREVIEW";
  if (r.kind === "CHANGES") return "CHANGES";
  return null;
}

/**
 * THE ONE SWITCH FOR FREE-FORM REPLIES TO A PREVIEW (owner's decision, 27 Sep 2026): a reply read
 * as CONTINUE with no changes lands the preview, the same as "approved". Off, it is noted and the
 * preview waits for a keyword. Read from the kind's rules so a partner can flip it without a deploy;
 * ON when no row says otherwise.
 */
export const FREE_REPLY_LANDS_PREVIEW = "free_reply_lands_preview";
export function freeReplyLandsPreview(rules: Record<string, string>): boolean {
  return isOn(rules[FREE_REPLY_LANDS_PREVIEW] ?? "on");
}

/**
 * QUEUE THE REBUILD HER REPLY ASKED FOR (0240). CHANGES carries her words into the build whatever the
 * materials; PREVIEW and PUBLISH ask the Mac for a materials check first and rebuild only if the set
 * changed. PUBLISH is recorded like the named force — hers alone, with the time — as a landing
 * approval that binds to a build that goes green AFTER it, never to the preview she is looking at.
 */
async function requestRebuild(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, intent: "PREVIEW" | "PUBLISH" | "CHANGES", answer: string | null, rules: Record<string, string>): Promise<RunOutcome> {
  const now = new Date().toISOString();
  const requester = card.requested_by_email ? partnerByEmail(card.requested_by_email) : null;
  const by = card.block_answered_by ?? requester?.firmUserId ?? null;
  const patch: Partial<WebPropertyChangeRow> = { refresh_intent: intent, refresh_requested_at: now };
  if (intent === "CHANGES" && answer) {
    patch.answers_json = JSON.stringify([...list(row.answers_json), answer.slice(0, 2000)]);
    // 0244: THE WORDS THIS REBUILD IS FOR. A remark or a worry is a change to make; the Mac gets
    // them as the run's whole job, and a build that moves nothing for them is a failed attempt.
    patch.rebuilt_for = answer.slice(0, 2000);
  } else {
    patch.rebuilt_for = null;
  }
  if (intent === "PUBLISH") Object.assign(patch, { land_approved_at: now, land_approved_by: by, publish_approved_at: now, publish_approved_by: by });
  await update(env, card.id, patch);
  await appendFinding(
    env,
    card.id,
    intent === "CHANGES"
      ? `After the preview, ${card.requested_by_email ?? "the partner"} asked for changes ("${(answer ?? "").slice(0, 200)}"): rebuilding with them; a new preview follows.`
      : `After the preview, ${card.requested_by_email ?? "the partner"} ${answer ? `replied "${answer.slice(0, 80)}"` : "pressed \"I added missing items\""}: checking the Drive folder and the files on the card for anything new. ${intent === "PUBLISH" ? "If something changed, it is filled in and published without another preview" : "If something changed, a new preview follows"}; if nothing did, she is told so.`,
  );
  const parked = await parkPhase(env, card, { ...row, ...patch } as WebPropertyChangeRow, "BUILD", rules);
  if (!parked.parked) return { finished: false, blocked: false, progressed: true, detail: parked.reason };
  return { finished: false, blocked: false, progressed: true, detail: `${intent === "CHANGES" ? "Changes after the preview" : "A materials check after the preview"}; BUILD queued for the Mac (${phaseModel(rules, "BUILD")}).` };
}

async function blockOnPreview(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow): Promise<string> {
  const why = await blockCard(env, card, {
    reason: "a_question_for_you",
    trying: card.title,
    employee: PORTER_NAME,
    who: whoFor(card),
    detail: [waitDetail("PREVIEW_APPROVAL", { what: cleanPreviewUrls(row.preview_url, pagesHostsOf(row.property_host ?? null, await loadRegistry(env)), row.branch ?? "") }), previewBlockText(row, await readParts(env, card.id))].join("\n").slice(0, 900),
  });
  await update(env, card.id, { preview_emailed_at: new Date().toISOString() });
  return why;
}

/**
 * WHAT THE BLOCKED EMAIL SAYS: the asks with their defaults, then the WHOLE PLAN, readable in the
 * mail. Read from `plan_text` — the row's own column since 0231 — never from the card's capped
 * `description`. `plan_deliverable_id` is read only for a card planned before 0231, whose plan
 * still lives in the deliverable that PLAN filed back then. The sweep calls this for a BLOCKED
 * card of this kind before it emails the requester.
 */
export async function blockedEmailDetail(env: Env, cardId: string): Promise<string | null> {
  const row = await readWebPropertyChange(env, cardId);
  if (!row || !row.plan_filed_at) return null;
  const plan = row.plan_text
    ? row.plan_text
    : row.plan_deliverable_id
      ? (await env.WP_OS_DB.prepare("SELECT body FROM deliverable WHERE id = ?1").bind(row.plan_deliverable_id).first<{ body: string }>())?.body ?? null
      : null;
  // THE PREVIEW EMAIL: the link, the PR, the placeholders and the proof — the second question.
  if (row.pr_url && row.check_state === "GREEN" && needsPreview(row) && !row.land_approved_at && !row.forced_by) {
    return [
      previewBlockText(row, await readParts(env, cardId)),
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
    askBlockText(asks, { publishReady: row.publish_ready !== 0, placeholders: list(row.placeholders_json) }),
    "",
    "THE PLAN, in full:",
    "",
    plan ?? "(the plan document could not be read back — open it on the card)",
  ].join("\n");
}

/** The plan's missing materials: its own list, else each named placeholder as an item to send. Pure. */
export function missingFromPlan(report: Pick<LocalJobReport, "missing_materials" | "placeholders">): MissingMaterial[] {
  if (report.missing_materials && report.missing_materials.length) return report.missing_materials;
  return (report.placeholders ?? []).map((p) => ({ item: p, where: "the site, where the plan marks its placeholder" }));
}

/** What the DONE email says: the proof, not the process. A multi-repo job names every repo and its proof. */
export function doneSummary(row: WebPropertyChangeRow, parts: readonly WebPropertyChangePart[] = []): string {
  if (parts.length) {
    return [
      forcedLine(row) ?? "",
      `Landed ${parts.length} PRs in ${parts.length} repos, together:`,
      ...parts.map((p) =>
        [
          `• ${p.repo} (${p.property_host}): ${p.pr_url ?? "the PR"}${p.merge_sha ? ` as ${p.merge_sha.slice(0, 10)}` : ""}`,
          p.live_proof ? `  Live proof:\n${p.live_proof}` : "",
        ]
          .filter((l) => l.length > 0)
          .join("\n"),
      ),
      row.live_proof ? `Live proof:\n${row.live_proof}` : "",
      row.build_proof ? `Build proof:\n${row.build_proof}` : "",
      list(row.decided_json).length ? `Decided without asking: ${list(row.decided_json).join("; ")}` : "",
    ]
      .filter((l) => l.length > 0)
      .join("\n\n");
  }
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
  const finding = doneSummary(row, await readParts(env, card.id));
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
 * BOTH SEATS SPENT: WAIT FOR THE RESET (1 Oct 2026). Claude Code and Codex both said their plan is out of usage, so
 * nobody can run this phase until one resets. That is not the phase's failure and not a question for anybody:
 * no attempt is charged (the sweep hands the claim's attempt back for a `progressed` outcome), nobody is emailed
 * and the card is not blocked. It is leased until the earlier reset, says so on its face, and the next tick
 * after that parks the same phase again — by itself. A plan still spent at that moment simply holds it again.
 */
export async function holdUntilAPlanResets(env: Env, card: { id: string; firm_scope: string }, phase: string, waitSeconds: number, said: string, now = new Date()): Promise<RunOutcome> {
  const seconds = Math.min(Math.max(Math.round(waitSeconds), 60), 7 * 24 * 60 * 60);
  const until = new Date(now.getTime() + seconds * 1000).toISOString();
  const when = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(until));
  const line = `Both AI plans (Claude Code and Codex) are out of usage · ${phase.toLowerCase()} starts again by itself at about ${when} Central`;
  await env.WP_OS_DB.prepare("UPDATE work_card SET waiting_until = ?2, waiting_for = ?3, next_action = ?3 WHERE id = ?1").bind(card.id, until, line).run();
  await appendFinding(env, card.id, `${line}. ${said.slice(0, 600)}`);
  await appendEvent(env, {
    eventType: "work_card.waiting_for_reset",
    actorType: "system",
    actorId: "web_property_change",
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { phase, until, seconds },
  });
  return { finished: false, blocked: false, progressed: true, held: true, waitUntil: until, detail: line };
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
      /*
       * Nobody picked it up inside the queue ceiling (twelve hours for a website job). A fault to
       * look at, with the lane named — and addressed to the OWNER OF THE MAC, never the requesting
       * partner (28 Sep 2026): a Mac that has been asleep for twelve hours is hers to wake, and the
       * partner already heard once that the lane is asleep (`sendAsleep`). They must never be told
       * "Blocked" for a laptop lid.
       */
      // 0253: an infrastructure wait, in the three-part shape; it clears itself and the email says so.
      const why2 = await blockCard(env, card, {
        reason: "a_question_for_you",
        trying: card.title,
        employee: PORTER_NAME,
        who: whoFor(card),
        detail: waitDetail("MAC_ASLEEP", { why: dueLine(readWebPropertyAsk(card.request_json)?.due) }).slice(0, 900),
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

  // 0253: what the repo itself said, the keys the vault lacks (only with the lookup that proves it), the runs.
  const absorbed = await absorbRepoReport(env, card, row, report);
  if (absorbed) return absorbed;

  if (report.status === "failed" && typeof report.waits_seconds === "number") {
    return holdUntilAPlanResets(env, card, report.phase, report.waits_seconds, report.reason ?? "");
  }

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
    // 0253: after the bound, ONE email to the partner who asked — what was tried, and the reply that clears it.
    const blocked = await blockCard(env, card, {
      reason: "a_question_for_you",
      trying: card.title,
      employee: PORTER_NAME,
      who: whoFor(card),
      detail: waitDetail("TRIED_AND_STOPPED", { what: `${report.phase} three times`, why }).slice(0, 900),
    });
    return { finished: false, blocked: true, progressed: false, detail: blocked };
  }
  if (report.status === "failed") {
    // A multi-repo BUILD or LAND that stopped part way still reports what it did per repo: PRs
    // opened, or merges that happened before a later repo refused. Recorded, so the next attempt
    // resumes rather than repeats (a merged part is never landed twice).
    if (report.parts?.length && (report.phase === "BUILD" || report.phase === "LAND")) {
      const parts = await recordPartReports(env, card.id, report.parts, report.phase);
      const agg = aggregateParts(parts);
      await update(env, card.id, { pr_url: agg.pr_url, check_state: agg.check_state, check_green_at: agg.check_green_at, preview_url: agg.preview_url, build_proof: agg.build_proof });
    }
    await appendFinding(env, card.id, `${report.phase} failed on the Mac: ${report.reason}`);
    return { finished: false, blocked: false, progressed: false, detail: `${report.phase} failed: ${report.reason}` };
  }

  if (report.status === "unchanged") return applyUnchanged(env, card, row, report);
  if (report.phase === "PLAN") return applyPlan(env, card, row, report);
  /*
   * A REBUILD THAT MOVED NOTHING IS NOT A PREVIEW (0244, 28 Sep 2026). Scooter wrote "I don't know
   * if people know they can scroll on the flyers"; the Mac's BUILD found the branch already had
   * commits, verified them, changed nothing, reported ok — and Porter sent him the same preview
   * email a second time. The script now reports whether the branch head moved; a CHANGES rebuild
   * whose head did not move is a failed attempt: the next BUILD carries the same words, and after
   * three the card is STUCK for the owner. No email goes out for a build that built nothing.
   */
  if (report.phase === "BUILD" && row.refresh_intent === "CHANGES" && report.changed !== true) {
    const asked = (row.rebuilt_for ?? list(row.answers_json).at(-1) ?? "").slice(0, 300);
    await appendFinding(env, card.id, `The rebuild for "${asked}" came back with no new commit on the branch (attempt ${card.work_attempts}) — nothing changed, so no new preview was sent. The next attempt must make the change.`);
    return { finished: false, blocked: false, progressed: false, detail: `BUILD moved nothing for the partner's request ("${asked.slice(0, 120)}"): no commit on the branch, so no new preview. It runs again.` };
  }
  // 0240: the material set this build used, and what it filled in since the last preview.
  if (report.phase === "BUILD") {
    const before = (await missingFor(env, card.id)).map((m) => m.item);
    const after = report.missing_materials ? report.missing_materials.map((m) => m.item) : before;
    const filled = before.filter((b) => !after.includes(b));
    await update(env, card.id, { ...(report.materials ? { materials_fingerprint: report.materials } : {}), filled_json: JSON.stringify(filled), refresh_intent: null });
    row = { ...row, ...(report.materials ? { materials_fingerprint: report.materials } : {}), filled_json: JSON.stringify(filled), refresh_intent: null };
    if (filled.length) await appendFinding(env, card.id, `Filled in by this build: ${filled.join("; ")}.`);
  }
  // AFTER A REBUILD (0237): what is STILL missing, re-checked against the re-mapped package, replaces
  // the plan's list — the preview and DONE emails name only what did not arrive. Not reported: stands.
  if (report.phase === "BUILD" && report.missing_materials) {
    await recordMissing(env, card.id, report.missing_materials);
    await update(env, card.id, { placeholders_json: JSON.stringify(report.missing_materials.map((m) => m.item)) });
    row = { ...row, placeholders_json: JSON.stringify(report.missing_materials.map((m) => m.item)) };
  }
  if (report.phase === "BUILD") return applyBuild(env, card, row, report, rules);
  return applyLand(env, card, row, report);
}

/**
 * NOTHING NEW ARRIVED (0240). She replied "preview" or "publish", or pressed "I added missing items",
 * and the Mac found the same folder and the same files the last build used — so it built nothing.
 * She is told once, in words; a "publish" approval is withdrawn (it was for new materials, and there
 * are none), and the card waits on the SAME preview, whose approval still binds.
 */
/**
 * WHAT EVERY REPORT MAY CARRY SINCE 0253, read in one place:
 *   · `repo_facts` — the host, Pages project and secret NAMES the duty read from the repo's own
 *     config and RUNBOOK → the registry row (never from the email);
 *   · `missing_secrets` — keys the vault does not hold. REFUSED unless the report also carries the
 *     vault lookup that proves it searched (names only): "we have many api keys in the vault and any
 *     job should always check the vault first" (owner, 6 Oct 2026). A refused report is a failed
 *     attempt, retried, never a question for the partner;
 *   · `runs` — the RUNBOOK-named scripts the script ran for the model, each recorded as a finding.
 * Returns an outcome only when the report is refused.
 */
async function absorbRepoReport(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, report: LocalJobReport): Promise<RunOutcome | null> {
  if (report.repo_facts && report.repo_facts.repo) {
    await recordRepoFacts(env, report.repo_facts.repo, { host: report.repo_facts.host ?? null, pagesHost: report.repo_facts.pages_host ?? null, secretNames: report.repo_facts.secret_names ?? null, githubRepo: report.repo_facts.github_repo ?? null, constraints: report.repo_facts.constraints ?? null });
    // R19 (0254): the partner's constraints are THEIRS, not the repo's — every other employee working for them reads them too.
    if (report.repo_facts.constraints?.length) await recordPartnerConstraints(env, card.requested_by_email ?? null, report.repo_facts.constraints, `repo ${report.repo_facts.repo}`, card.firm_scope);
    if (report.repo_facts.runbook_generated) await appendFinding(env, card.id, `${report.repo_facts.repo} had no RUNBOOK.md; one was generated from its package.json and wrangler config and committed on the job's branch.`);
  }
  if (Array.isArray(report.missing_secrets)) {
    const searched = [...new Set([...(report.vault_lookup?.searched ?? []), ...report.missing_secrets.flatMap((m) => m.searched ?? [])])];
    if (report.missing_secrets.length && searched.length === 0) {
      await appendFinding(env, card.id, `${report.phase} named a missing key (${report.missing_secrets.map((m) => m.name).join(", ")}) without a vault lookup — the vault is always checked first; this attempt does not count.`);
      return { finished: false, blocked: false, progressed: false, detail: `${report.phase} reported a missing secret without a vault lookup (names searched) — refused; the vault is checked first` };
    }
    const missing: MissingSecret[] = report.missing_secrets.map((m) => ({ name: String(m.name), vendor_url: m.vendor_url ?? null, searched: (m.searched?.length ? m.searched : searched).map(String) }));
    const before = missingSecretsOf(row).map((m) => m.name).sort().join(",");
    await update(env, card.id, { missing_secrets_json: JSON.stringify(missing) });
    if (missing.length && before !== missing.map((m) => m.name).sort().join(",")) {
      await appendFinding(env, card.id, `Keys the vault does not hold: ${missing.map((m) => m.name).join(", ")} (searched ${searched.join(", ")}). Everything that does not need them goes ahead; each email names them and how to send one.`);
    }
  }
  if (Array.isArray(report.dns) && report.dns.length) {
    const told = await recordDnsWaits(env, { cardId: card.id, repo: row.target_repo, requestedBy: card.requested_by_email ?? null, firmScope: card.firm_scope, records: report.dns });
    if (told.length) await appendFinding(env, card.id, `A host outside the firm's Cloudflare zones: ${told.join(", ")}. The partner has the exact record to add at their registrar; the site is live on pages.dev meanwhile and I re-check every 15 minutes for 7 days.`);
  }
  // Addendum 5: work the partner dated for later becomes its own card, leased until its week — never lost on close.
  if (Array.isArray(report.deferred) && report.deferred.length) {
    for (const d of report.deferred.slice(0, 5)) await deferWork(env, card, row, d);
  }
  if (Array.isArray(report.items) && report.items.length) {
    await appendFinding(env, card.id, `Per item: ${doneLines(report.items).join("; ")}`);
  }
  if (Array.isArray(report.runs) && report.runs.length) {
    await appendFinding(env, card.id, `Ran for the partner's ask: ${report.runs.map((r) => `${r.script} (${r.env}) → exit ${r.exit}${r.line ? `: ${r.line.slice(0, 160)}` : ""}`).join("; ")}`);
  }
  if (Array.isArray(report.deliverables) && report.deliverables.length) {
    await appendFinding(env, card.id, `Files for the partner: ${report.deliverables.map((d) => `${d.filename} (${d.bytes} bytes, ${d.via})`).join(", ")}.`);
  }
  return null;
}

/**
 * DEFERRED WORK WITH A DATE (0253, addendum 5): "for next week, …" is its own card on the same repo,
 * for the same partner, leased until the date so the sweep leaves it alone until then and then
 * runs it as any other job; the partner hears about it when it runs. Idempotent on (card, ask).
 */
export async function deferWork(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, d: { ask: string; due_at: string; words?: string }): Promise<void> {
  // R14 / R23 FOR EVERY KIND (0254): the dated card itself is made by the shared door; Porter's part is making it a site job.
  const { deferCard } = await import("./deferredWork");
  const madeId = await deferCard(
    env,
    { id: card.id, title: card.title, owner_id: PORTER_ID, requested_by_email: card.requested_by_email ?? null, firm_scope: card.firm_scope },
    { ask: d.ask, due_at: d.due_at, words: d.words ?? null },
    { where: row.target_repo, nextAction: `Waiting for its week (${String(d.due_at).slice(0, 10)}); then planned, built and previewed like any site job.` },
  );
  if (!madeId) return;
  const ask = readWebPropertyAsk(card.request_json);
  await env.WP_OS_DB.prepare("UPDATE work_card SET kind = ?2 WHERE id = ?1").bind(madeId, WEB_PROPERTY_CHANGE_KIND).run();
  await openWebPropertyChange(env, { cardId: madeId, ask: { drive_folder_id: row.drive_folder_id, drive_folder_url: row.drive_folder_url, drive_file_url: null, property_host: row.property_host, target_repo: row.target_repo, site: ask?.site ?? null, ask: d.ask, pre_approval: null, force: null, addressee: "Porter", property_unresolved: false }, firmScope: card.firm_scope });
  await appendFinding(env, card.id, `Deferred, as asked: "${d.ask.slice(0, 160)}" — its own card (${madeId}) runs on ${d.due_at.slice(0, 10)}.`);
}

/**
 * A KEY ARRIVED BY EMAIL (0253): every open card for that repo — or any card naming that key as
 * missing — drops it from its list and rebuilds, so the feature that needed it ships without a
 * second ask and without a new card. A BLOCKED card is answered the way a follow-up answers it:
 * `block_answer` reads "changes: …", which the runner reads as a CHANGES rebuild at either stage
 * (plan or preview); an open card just carries the intent to its next BUILD. Returns the card ids.
 */
export async function resumeForSecret(env: Env, input: { name: string; repo: string | null; byFirmUserId: string | null }): Promise<string[]> {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT w.work_card_id, w.target_repo, w.missing_secrets_json, w.current_run_id, c.state
       FROM web_property_change w JOIN work_card c ON c.id = w.work_card_id
      WHERE w.phase != 'DONE' AND c.state NOT IN ('DONE', 'CANCELLED')
        AND (w.missing_secrets_json LIKE ?1 OR (?2 IS NOT NULL AND w.target_repo = ?2 AND w.missing_secrets_json != '[]'))`,
  )
    .bind(`%"name":"${input.name}"%`, input.repo)
    .all<{ work_card_id: string; target_repo: string; missing_secrets_json: string; current_run_id: string | null; state: string }>();
  const resumed: string[] = [];
  const now = new Date().toISOString();
  for (const r of rows.results ?? []) {
    const left = missingSecretsOf(r).filter((m) => m.name !== input.name);
    if (left.length === missingSecretsOf(r).length && r.target_repo !== input.repo) continue;
    const words = `changes: the key ${input.name} has arrived in the vault — build and ship the feature that needed it`;
    await update(env, r.work_card_id, { missing_secrets_json: JSON.stringify(left), refresh_intent: "CHANGES", refresh_requested_at: now, rebuilt_for: words });
    await appendFinding(env, r.work_card_id, `${input.name} arrived by email and is in the vault. Rebuilding so what needed it ships; the next email carries the result.`);
    if (r.state === "BLOCKED") {
      await env.WP_OS_DB.prepare(
        `UPDATE work_card SET state = 'OPEN', work_attempts = 0, work_steps = 0, lease_until = NULL, waiting_until = NULL, waiting_for = NULL, block_answer = ?2, block_answered_by = ?3, block_answered_at = ?4, block_nag_at = NULL, updated_at = ?4 WHERE id = ?1`,
      )
        .bind(r.work_card_id, words, input.byFirmUserId ?? "secret_handoff", now)
        .run();
    }
    resumed.push(r.work_card_id);
  }
  // ALL KINDS (owner, 6 Oct 2026): any other employee's card blocked on this key by name is answered the same way.
  const others = await env.WP_OS_DB.prepare(
    `SELECT id FROM work_card WHERE state = 'BLOCKED' AND (kind IS NULL OR kind != ?2) AND block_needed LIKE ?1`,
  )
    .bind(`%${input.name}%`, WEB_PROPERTY_CHANGE_KIND)
    .all<{ id: string }>();
  for (const o of others.results ?? []) {
    const words = `the key ${input.name} has arrived in the vault — carry on with what needed it`;
    await env.WP_OS_DB.prepare(
      `UPDATE work_card SET state = 'OPEN', work_attempts = 0, work_steps = 0, lease_until = NULL, waiting_until = NULL, waiting_for = NULL, block_answer = ?2, block_answered_by = ?3, block_answered_at = ?4, block_nag_at = NULL, updated_at = ?4 WHERE id = ?1`,
    )
      .bind(o.id, words, input.byFirmUserId ?? "secret_handoff", now)
      .run();
    await appendFinding(env, o.id, `${input.name} arrived by email and is in the vault; the card is back in the queue.`);
    resumed.push(o.id);
  }
  return resumed;
}

/** 0253: what a Porter card's finished or waiting email carries besides its words — the files, and the keys still missing. */
export async function porterEmailExtras(env: Env, cardId: string, withFiles: boolean): Promise<{ attachments: Awaited<ReturnType<typeof outboundFilesFor>>["attachments"]; sections: Array<{ label: string; bullets: string[] }> }> {
  const files = withFiles ? await outboundFilesFor(env, cardId) : { attachments: [], section: null };
  const row = await readWebPropertyChange(env, cardId);
  const keys = missingSecretsSection(row ? missingSecretsOf(row) : []);
  return { attachments: files.attachments, sections: [...(files.section ? [{ label: files.section.label, bullets: [...files.section.bullets] }] : []), ...(keys ? [keys] : [])] };
}

async function applyUnchanged(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, report: LocalJobReport): Promise<RunOutcome> {
  const wasPublish = row.refresh_intent === "PUBLISH";
  const patch: Partial<WebPropertyChangeRow> = { refresh_intent: null, ...(report.materials ? { materials_fingerprint: report.materials } : {}) };
  if (wasPublish) Object.assign(patch, { land_approved_at: null, land_approved_by: null, publish_approved_at: null, publish_approved_by: null });
  await update(env, card.id, patch);
  const said = `I didn't find anything new in the folder or attached${wasPublish ? `; reply "approved" to publish as is` : ""}.`;
  await appendFinding(env, card.id, `Materials check: nothing new since the last build. ${wasPublish ? "The \"publish\" approval is withdrawn; nothing lands. " : ""}Told ${card.requested_by_email ?? "the partner"}: "${said}"`);
  await tellRequester(env, card, { kind: "QUESTION", cause: `unchanged:${row.refresh_requested_at ?? new Date().toISOString()}` }, {
    what: stageSubject((await porterContext(env, card.id))?.title ?? "Your site change", STAGE.UNCHANGED),
    tldr: said,
    sections: [
      { label: "What I checked", bullets: ["The Drive folder, re-mapped just now, and every file attached on this card."] },
      { label: "Your call", bullets: [`**approved**: publish the current preview as is.`, `Add the missing items to Drive or attach them to a reply, then reply "preview" or "publish".`, `The card: https://os.joinwestpeek.com/#/work (card ${card.id})`] },
    ],
  });
  const fresh = { ...row, ...patch } as WebPropertyChangeRow;
  const why = await blockOnPreview(env, card, fresh);
  return { finished: false, blocked: true, progressed: false, detail: `nothing new in the materials; waiting on the same preview. ${why}` };
}

async function applyPlan(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, report: LocalJobReport): Promise<RunOutcome> {
  if (!report.document) {
    return { finished: false, blocked: false, progressed: false, detail: "PLAN came back without a plan document" };
  }
  /*
   * THE PLAN LIVES ON THE CARD, NOT IN DOCUMENTS (0231, Addendum 4.3, 22 Sep 2026). Her words:
   * "plans for work to be done are not like real documents, like an LP deck or something." It used
   * to be filed through the deliverables road — a Document in Documents, a card on the partner's
   * Home titled "Plan: …" — which read wrong beside a room packet or an LP statement: it is
   * process, not a deliverable. `plan_text` holds the whole thing directly on the row, where the
   * block/ask email and the BUILD job's payload already read every other fact of this phase.
   */
  const now = new Date().toISOString();
  const asks = report.asks ?? [];
  await update(env, card.id, {
    plan_text: report.document,
    plan_filed_at: now,
    decided_json: JSON.stringify(report.decided ?? []),
    asks_json: JSON.stringify(asks),
    publish_ready: report.publish_ready === false ? 0 : 1,
    placeholders_json: JSON.stringify(report.placeholders ?? []),
    assets_json: JSON.stringify(report.assets ?? []),
  });
  /*
   * THE MISSING MATERIALS GO ON THE CARD (0237): the plan's own list, or — from a plan that named
   * placeholders but no list — each placeholder as an item to send. The plan email (and every later
   * email about this card) renders it through the one shared section, asking for each and saying how.
   */
  await recordMissing(env, card.id, missingFromPlan(report));
  const decided = report.decided ?? [];
  if (report.publish_ready === false) {
    await appendFinding(env, card.id, `NOT publish-ready: would ship ${(report.placeholders ?? []).length} placeholder(s) — ${(report.placeholders ?? []).join("; ")}. It will preview first; landing needs a second approval.`);
  }
  await appendFinding(
    env,
    card.id,
    `Plan filed on the card. Decided (${decided.length}): ${decided.join("; ") || "nothing"}. Asking (${asks.length}): ${askLines(asks).join("; ") || "nothing"}.`,
  );
  /*
   * THE ROW AS WRITTEN, NOT A HAND-BUILT COPY (27 Sep 2026). The three filing-time approvers below
   * park BUILD from this row, and the job's `plan.assets` (0237: BUILD fetches exactly these) come
   * from `assets_json` — which the copy this used to assemble by hand left out, so a build parked at
   * filing carried no assets. Read back what was just written; nothing is re-typed.
   */
  const fresh: WebPropertyChangeRow = (await readWebPropertyChange(env, card.id)) ?? { ...row, plan_text: report.document, plan_filed_at: now, publish_ready: report.publish_ready === false ? 0 : 1, placeholders_json: JSON.stringify(report.placeholders ?? []), assets_json: JSON.stringify(report.assets ?? []), decided_json: JSON.stringify(report.decided ?? []), asks_json: JSON.stringify(asks) };
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
  /*
   * EVERY ASK CARRIES A RECOMMENDATION → THE PLAN NEVER WAITS (owner, 27 Sep 2026). A partner's
   * instructive email IS the plan approval; the card should not need more approvals. The
   * recommendations are taken, the plan is approved by the request, BUILD parks now, and the PLAN
   * email is an FYI ("Going ahead with these; reply 'changes: …' to steer"). The PREVIEW before
   * going live stays: nothing lands without the primary's "approved" on the preview.
   */
  if (everyAskRecommended(asks)) return approveByRequest(env, card, fresh, asks);
  const why = await blockWithAsks(env, card, fresh, asks);
  return { finished: false, blocked: true, progressed: false, detail: why };
}

/** How `plan_approved_by` reads when the request itself approved the plan. Never a partner's id or email, so 0241's primary-only trigger does not read it as a person. */
export function requestApprover(cardId: string): string {
  return `request:${cardId} (every decision carried a recommendation; taken as the plan was filed)`;
}

/**
 * APPROVED BY THE REQUEST (owner, 27 Sep 2026). Every ask the PLAN raised carried Porter's
 * recommendation, so there is nothing a partner must decide from scratch: each recommendation is
 * the answer, the plan is approved in the request's own name (never a partner's — 0241's trigger
 * holds that a plan approval recorded against a partner must be the card's primary, and this is
 * neither), the card goes straight to BUILD, and the partner hears an FYI rather than a question.
 * NOT a landing approval: a change that previews first still stops at the preview link.
 *
 * Reached from two places, deliberately: `applyPlan` the moment the plan is filed, and the PLAN
 * branch of the runner for a card that was BLOCKED at this stage before the rule existed (the sweep
 * releases those — `releasePlansNobodyNeedsToAnswer`).
 */
async function approveByRequest(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, asks: readonly Ask[]): Promise<RunOutcome> {
  const now = new Date().toISOString();
  const approvedBy = requestApprover(card.id);
  const answers = [...list(row.answers_json), ...approvedAnswers(asks)];
  await update(env, card.id, { answers_json: JSON.stringify(answers), plan_approved_at: now, plan_approved_by: approvedBy, phase: "BUILD" });
  const requester = card.requested_by_email ? partnerByEmail(card.requested_by_email) : null;
  await appendFinding(
    env,
    card.id,
    `Approved by the request: ${asks.length === 0 ? "the plan raised no decisions" : `every decision (${asks.length}) carried Porter's recommendation`}, so ${asks.length === 0 ? "it" : asks.length === 1 ? "it was taken" : "each was taken"} and the plan went straight to BUILD without waiting on ${requester?.firstName ?? "the partner"} (owner's rule, 27 Sep 2026: a partner's instructive email is the plan approval). ${needsPreview(row) && !row.forced_by ? "It stops at a preview link before anything lands." : "It lands on green."} A reply "changes: …" steers it.`,
  );
  await appendEvent(env, {
    eventType: "web_property_change.plan_approved",
    actorType: "system",
    actorId: "web_property_change",
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { reading: "REQUEST", asks: asks.length, approved_by: approvedBy },
  });
  const fresh: WebPropertyChangeRow = { ...row, answers_json: JSON.stringify(answers), plan_approved_at: now, plan_approved_by: approvedBy, phase: "BUILD" };
  // THE FYI, once per plan filing: the same PLAN notice, in its "going ahead" form. `fyi:` in the
  // cause so a card whose asking form already went out (blocked before this rule) still hears that
  // it is moving — one email, never the question twice.
  const email = await porterNoticeEmail(env, card.id, "PLAN", "", { fyi: true });
  if (email) await tellRequester(env, card, { kind: "PLAN", cause: `fyi:${row.plan_filed_at ?? now}` }, { what: email.what, tldr: email.tldr, tldrBullets: email.tldrBullets, sections: email.sections });
  const rules = await rulesFor(env, WEB_PROPERTY_CHANGE_KIND);
  const parked = await parkPhase(env, card, fresh, "BUILD", rules);
  if (!parked.parked) return { finished: false, blocked: false, progressed: true, detail: parked.reason };
  return { finished: false, blocked: false, progressed: true, detail: `Plan approved by the request (every decision carried a recommendation); BUILD queued for the Mac (${phaseModel(rules, "BUILD")}).` };
}

/**
 * A CARD BLOCKED AT THE PLAN WITH NOTHING TO DECIDE IS RELEASED (owner, 27 Sep 2026). Cards that
 * were parked "waiting for approved" before the rule above existed — wc_77f52b33 on the night of
 * the Sensori announcement, one ask, one recommendation — are put back in the sweep's hands: the
 * block is cleared, the card is OPEN, and the very next tick runs the PLAN branch, which approves
 * by the request and parks BUILD. Called by the sweep every tick; a no-op when nothing qualifies.
 * A card a partner has HELD, or one whose asks include a real question, is left exactly as it is.
 */
export async function releasePlansNobodyNeedsToAnswer(env: Env): Promise<string[]> {
  const rows = (
    await env.WP_OS_DB.prepare(
      `SELECT c.id, w.asks_json FROM work_card c JOIN web_property_change w ON w.work_card_id = c.id
        WHERE c.kind = ?1 AND c.state = 'BLOCKED' AND c.held_at IS NULL AND c.block_reason = 'a_question_for_you'
          AND w.phase = 'PLAN' AND w.plan_filed_at IS NOT NULL AND w.plan_approved_at IS NULL
          AND c.block_answered_at IS NULL`,
    )
      .bind(WEB_PROPERTY_CHANGE_KIND)
      .all<{ id: string; asks_json: string | null }>()
  ).results ?? [];
  const released: string[] = [];
  for (const r of rows) {
    let asks: Ask[] = [];
    try {
      asks = readAsks(JSON.parse(r.asks_json || "[]"));
    } catch {
      asks = [];
    }
    if (!everyAskRecommended(asks)) continue;
    await env.WP_OS_DB.prepare(
      `UPDATE work_card
          SET state = 'OPEN', work_attempts = 0, work_steps = 0, lease_until = NULL,
              block_reason = NULL, block_trying = NULL, block_stopped = NULL, block_needed = NULL, block_who = NULL, block_actions_json = NULL,
              blocked_at = NULL, block_nag_at = NULL,
              next_action = 'Every decision carried a recommendation, so the plan needs no answer: it is approved by the request and moves to BUILD on the next tick.',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?1 AND state = 'BLOCKED'`,
    )
      .bind(r.id)
      .run();
    await appendFinding(env, r.id, `Released from the plan wait: every decision carried a recommendation, so nobody has to answer it (owner's rule, 27 Sep 2026). The plan is approved by the request on the next tick and BUILD starts.`);
    await appendEvent(env, {
      eventType: "web_property_change.plan_wait_released",
      actorType: "system",
      actorId: "work_sweep",
      objectType: "work_card",
      objectId: r.id,
      firmScope: "west-peek",
      payload: { asks: asks.length },
    });
    released.push(r.id);
  }
  return released;
}

async function proceedWithoutAsking(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow): Promise<RunOutcome> {
  const now = new Date().toISOString();
  const approvedBy = `${PORTER_ID} (no partner decisions in this change; built without asking)`;
  await update(env, card.id, { plan_approved_at: now, plan_approved_by: approvedBy, phase: "BUILD" });
  await appendFinding(env, card.id, `No partner decisions in this change; built without asking. The plan is publish-ready and every decision was structure, CSS, validators, redirects, assets or build wiring — Porter's to make. ${needsPreview(row) && !row.forced_by ? "On green it stops at a preview link; it lands when the partner approves the preview." : "It lands on green; the partner hears when it is done."}`);
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
    await appendFinding(env, card.id, `The same request said "${row.force_phrase}": ${row.publish_ready === 0 ? "a plan that is not publish-ready lands anyway" : "the preview is skipped and it lands on green"}, named as forced by ${requester.fullName}.`);
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
/** What the requester's unread words did this tick: a hold, and/or changes to rebuild the preview with. */
interface RequesterWords {
  held: string | null;
  /** At the preview stage: instructions from a note (or a late reply on an earlier thread) to rebuild with. */
  rebuildWith: string | null;
}

async function heldByRequester(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, deps: { readIntent: ReplyIntentReader; answerQuestion?: QuestionAnswerer }): Promise<RequesterWords> {
  const requester = card.requested_by_email ? partnerByEmail(card.requested_by_email) : null;
  const since = [row.plan_approved_at, row.preview_emailed_at, row.forced_at].filter((x): x is string => Boolean(x)).sort().pop() ?? null;
  // 1 · An answer to a block, from the requester, that reads as an explicit STOP. Free text at the
  //     preview is read for its intent by the preview branch itself (once, not twice).
  const answer = answerSince(card, since);
  const atPreview = row.phase === "BUILD" && row.check_state === "GREEN" && needsPreview(row) && !row.land_approved_at && !row.forced_by;
  const reading = answer ? readApprovalReply(answer) : null;
  let rebuildWith: string | null = null;
  if (answer && (!requester || !card.block_answered_by || card.block_answered_by === requester.firmUserId) && reading?.kind === "REFUSED") {
    return { held: answer, rebuildWith };
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
  const secondary = partnerByEmail(
    (await env.WP_OS_DB.prepare("SELECT secondary_partner_email FROM work_card WHERE id = ?1").bind(card.id).first<{ secondary_partner_email: string | null }>())?.secondary_partner_email ?? null,
  );
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
      /*
       * THE SECONDARY'S NOTE IS CONTEXT, NEVER A STEER (0241). Kept on the card's trail — which the
       * Mac reads with the brief — and answered with who approves; it is not carried into the next
       * phase as an answer, and it can hold, approve or publish nothing.
       */
      if (requester && secondary && n.author_id === secondary.firmUserId) {
        await ack(secondaryNoteAck(requester));
        await appendFinding(env, card.id, `Context from ${secondary.firstName} (secondary; not an approval): "${n.body.slice(0, 600)}"`);
        continue;
      }
      await ack(`Kept, not acted on: only ${requester?.fullName ?? "the partner who asked"} steers this card.`);
      continue;
    }
    /*
     * "CC SCOOTER" (0239). Recorded when the note arrived (`recordCcFrom`, at the door it came
     * through); acknowledged here in the same words. A note that says nothing BUT the cc is not an
     * answer for the next phase and is not carried as one.
     */
    const ccSaid = ccAck(resolveCc(ccAsksIn(n.body), requester?.email ?? null), true, requester?.firstName ?? null);
    if (ccSaid && isOnlyACc(n.body)) {
      await ack(ccSaid);
      continue;
    }
    /*
     * A REPLY ON AN EARLIER THREAD (27 Sep 2026): the email door keeps it as a note with a prefix
     * when the card has moved on (it answered the PLAN email while the PREVIEW waits). Its words are
     * read below like any note; its "approved" can never land — a note never does — and says so.
     */
    const late = stripLateThreadPrefix(n.body);
    const body = late.text;
    const keyword = readApprovalReply(body);
    if (!held && keyword.kind === "REFUSED") {
      await ack("Held: nothing is built or landed until you say otherwise.");
      held = body;
      continue;
    }
    /*
     * "APPROVED TO PRODUCTION" BY NOTE OR REPLY TO THE FYI (27 Sep 2026). Since a plan whose every ask
     * carries a recommendation is approved by the request, the requester's named bypass now arrives
     * as a note on an OPEN card rather than as the answer to a block. It is the same word with the
     * same weight: recorded as the force, in their name, so green lands without the preview stop.
     * A LATE reply on an earlier thread is the one exception: it never forces a preview it did not see.
     */
    if (keyword.kind === "FORCED" && !late.late && !row.forced_by && requester && row.phase !== "LAND") {
      await ack(`Forced to production in your name: it lands on green${row.publish_ready === 0 ? ", placeholders and all" : ""}; no preview stop.`);
      await recordForce(env, card, row, requester.firmUserId);
      continue;
    }
    if (keyword.kind === "PREVIEW" && !row.land_approved_at) {
      // "preview" at any point before landing: see it on a preview link first.
      await ack("Noted: it will stop at a preview link and ask you before it lands.");
      await update(env, card.id, { preview_only: 1 });
      await appendFinding(env, card.id, `${card.requested_by_email ?? "The partner"} asked for a preview first ("${body.slice(0, 40)}").`);
      continue;
    }
    if (late.late && (keyword.kind === "APPROVED" || keyword.kind === "FORCED" || keyword.kind === "PUBLISH")) {
      // THE APPROVAL BINDS TO THE LATEST PREVIEW (#194). "approved" on the plan email, after the plan
      // was approved and while the preview waits, is recorded and acknowledged — and lands nothing.
      await ack(atPreview ? "Noted — this answered the plan email. The preview still waits for your approval of it: reply to the preview email." : "Noted — this answered the plan email, which is already approved; the build carries on.");
      await appendFinding(env, card.id, `${requester?.firstName ?? "The partner"} replied "${body.slice(0, 60)}" on the PLAN email thread after the plan was approved${atPreview ? "; the preview it did not answer still waits for its own approval" : ""}. Nothing landed from it.`);
      continue;
    }
    /*
     * FREE TEXT IS READ FOR ITS INTENT (27 Sep 2026: a partner's reply is permission to continue).
     * CONTINUE with changes at the preview → rebuild with them; a QUESTION → Porter answers it now;
     * an explicit STOP said in more words → held; anything else is carried as the answer.
     */
    const intent = keyword.kind === "ANSWERS" ? await readReplyIntent(env, { cardId: card.id, firmScope: card.firm_scope, text: body }, deps.readIntent) : null;
    if (intent?.kind === "STOP" && !held) {
      await ack("Held: nothing is built or landed until you say otherwise.");
      held = body;
      continue;
    }
    if (intent?.kind === "QUESTION") {
      const answered = await answerMidFlowQuestion(env, card, intent.question ?? body, deps.answerQuestion);
      await ack(`Answered by email: ${answered.slice(0, 200)}${intent.changes ? " Your instructions are carried into the build." : " The work carries on with the recommendations."}`);
      if (intent.changes) await update(env, card.id, { answers_json: JSON.stringify([...list(row.answers_json), intent.changes.slice(0, 2000)]) });
      if (atPreview && intent.changes) rebuildWith = rebuildWith ?? intent.changes;
      continue;
    }
    const carried = intent?.changes ?? body;
    if (atPreview && intent && intent.changes) {
      await ack(`Rebuilding the preview with your changes.${ccSaid ? ` ${ccSaid}` : ""}`);
      rebuildWith = rebuildWith ?? carried;
      continue;
    }
    if (atPreview && intent && !intent.changes) {
      await ack(late.late ? "Noted — this answered the plan email. The preview still waits for your approval of it: reply to the preview email." : "Noted. The preview still waits for your word on it: reply to the preview email to land it.");
      continue;
    }
    await ack(`Carried into the next phase as your answer.${ccSaid ? ` ${ccSaid}` : ""}`);
    await update(env, card.id, { answers_json: JSON.stringify([...list(row.answers_json), carried.slice(0, 2000)]) });
  }
  return { held, rebuildWith };
}

/**
 * PORTER ANSWERS A QUESTION IN HIS NEXT EMAIL, AND THE WORK CONTINUES (27 Sep 2026). A partner's
 * reply that asks something is a QUESTION intent: the owning employee tries to answer it with real
 * confidence (`answerQuestionForCard`, the same seam Addendum 12 uses) and the answer goes out on
 * the card's thread now — it never blocks the card. Not confident → Porter says so honestly in the
 * same email and Sequoia is told quietly; the work still carries on with the recommendations.
 */
async function answerMidFlowQuestion(env: Env, card: WebPropertyChangeCard, question: string, answerQuestion: QuestionAnswerer | undefined): Promise<string> {
  const routed = await answerQuestionForCard(
    env,
    { cardId: card.id, firmScope: card.firm_scope, kind: card.kind ?? WEB_PROPERTY_CHANGE_KIND, cardTitle: card.title, question },
    answerQuestion,
  );
  const answer =
    routed.confident && routed.answer
      ? routed.answer
      : "Good question — I don't know that one for certain, so I've passed it to Sequoia rather than guess. The work carries on with my recommendations in the meantime; nothing goes live until you approve the preview.";
  const sent = await sendQuestionAnswer(env, card, question, { ...routed, employeeName: routed.employeeName ?? PORTER_NAME, answer });
  if (!routed.confident || !routed.answer) {
    // The partner who answers what an employee cannot — named by the registry, never typed here.
    await notifyQuietly(env, {
      kind: "MEETING",
      severity: "INFO",
      title: `A question from ${card.requested_by_email ?? "a partner"} Porter could not answer`,
      body: `On "${card.title.slice(0, 80)}": "${question.slice(0, 300)}". Porter told them he would pass it to you; the work carries on with the recommendations.`,
      objectType: "work_card",
      objectId: card.id,
      firmUserId: PREVIEW_PARTNER.firmUserId,
      dedupeKey: `work_card:${card.id}:question:${question.slice(0, 40)}`,
    });
  }
  await appendFinding(env, card.id, `${card.requested_by_email ?? "The partner"} asked: "${question.slice(0, 300)}" — ${routed.confident && routed.answer ? `answered by ${routed.employeeName}` : "Porter could not answer with confidence; Sequoia was told"}${sent.sent ? ", by email on the card's thread" : ` (the email did not go: ${sent.reason})`}. The work continues.`);
  await appendEvent(env, {
    eventType: "work_card.question_answered_mid_flow",
    actorType: "ai_employee",
    actorId: routed.employeeId ?? PORTER_ID,
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { question: question.slice(0, 400), confident: routed.confident, sent: sent.sent, sent_reason: sent.reason, ai_run_id: routed.aiRunId },
  });
  return answer;
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
    detail: waitDetail("HELD_BY_YOU", { what: said }).slice(0, 900),
  });
  return { finished: false, blocked: true, progressed: false, detail: why };
}

async function applyBuild(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, report: LocalJobReport, rules: Record<string, string>): Promise<RunOutcome> {
  if ((await readParts(env, card.id)).length) return applyBuildOfParts(env, card, row, report, rules);
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
    // EVERY PREVIEW ON THE CARD'S TIMELINE (0240), with what it reflects.
    await appendFinding(env, card.id, `Preview ready — ${currentPreviewLine(fresh, [], { pagesHosts: pagesHostsOf(fresh.property_host), branch: fresh.branch }) ?? report.pr_url}.`);
    const why = await blockOnPreview(env, card, fresh);
    return { finished: false, blocked: true, progressed: false, detail: why };
  }
  if (isOn(rules.land_on_green)) {
    const parked = await parkPhase(env, card, fresh, "LAND", rules);
    if (!parked.parked) return { finished: false, blocked: false, progressed: false, detail: `green, but LAND could not be queued: ${parked.reason}` };
    return { finished: false, blocked: false, progressed: true, detail: `PR ${report.pr_url} is green; landing is queued for the Mac (${fresh.publish_approved_at ? "published with the new materials, as she asked — no further preview" : "land on green is on"}).` };
  }
  const why = await blockCard(env, card, {
    reason: "a_question_for_you",
    trying: card.title,
    employee: PORTER_NAME,
    who: whoFor(card),
    detail: waitDetail("LAND_WORD", { what: report.pr_url ?? "the PR" }).slice(0, 900),
  });
  return { finished: false, blocked: true, progressed: false, detail: why };
}

/**
 * A MULTI-REPO BUILD (0236): one PR per repo, each with its own checks and preview. The parent row
 * takes the aggregate, and from there the job takes the same road a single PR does — the preview
 * stop, land on green — because every gate reads the parent. Any part not GREEN is a failed
 * attempt that names the repo; the next BUILD resumes only what is not green yet.
 */
async function applyBuildOfParts(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, report: LocalJobReport, rules: Record<string, string>): Promise<RunOutcome> {
  if (!report.parts?.length) return { finished: false, blocked: false, progressed: false, detail: "BUILD came back without a PR for each repo" };
  const parts = await recordPartReports(env, card.id, report.parts, "BUILD");
  const agg = aggregateParts(parts);
  await update(env, card.id, { pr_url: agg.pr_url, pr_number: null, branch: null, check_state: agg.check_state, check_green_at: agg.check_green_at, preview_url: agg.preview_url, build_proof: agg.build_proof, check_url: null });
  await appendFinding(env, card.id, `PRs opened: ${parts.map((p) => `${p.repo} ${p.pr_url ?? "(none yet)"} — checks ${p.check_state ?? "PENDING"}`).join("; ")}.`);
  const blocking = notGreenParts(parts);
  if (agg.check_state !== "GREEN" || blocking.length) {
    // ONE RED PR HOLDS THEM ALL. Nothing lands, and the card says which repo is holding it.
    await appendFinding(env, card.id, `Not every PR is green, so nothing lands: ${blocking.join("; ")}.`);
    return { finished: false, blocked: false, progressed: false, detail: `not every PR is green, so none lands: ${blocking.join("; ")}` };
  }
  const fresh: WebPropertyChangeRow = { ...row, pr_url: agg.pr_url, pr_number: null, branch: null, check_state: "GREEN", check_green_at: agg.check_green_at, preview_url: agg.preview_url, build_proof: agg.build_proof };
  if (needsPreview(fresh) && !fresh.land_approved_at && !fresh.forced_by) {
    const why = await blockOnPreview(env, card, fresh);
    return { finished: false, blocked: true, progressed: false, detail: why };
  }
  if (isOn(rules.land_on_green)) {
    const parked = await parkPhase(env, card, fresh, "LAND", rules);
    if (!parked.parked) return { finished: false, blocked: false, progressed: false, detail: `green, but LAND could not be queued: ${parked.reason}` };
    return { finished: false, blocked: false, progressed: true, detail: `All ${parts.length} PRs are green; landing all of them is queued for the Mac (land on green is on).` };
  }
  const why = await blockCard(env, card, {
    reason: "a_question_for_you",
    trying: card.title,
    employee: PORTER_NAME,
    who: whoFor(card),
    detail: waitDetail("LAND_WORD", { what: `all ${parts.length} PRs (${agg.pr_url})` }).slice(0, 900),
  });
  return { finished: false, blocked: true, progressed: false, detail: why };
}

async function applyLand(env: Env, card: WebPropertyChangeCard, row: WebPropertyChangeRow, report: LocalJobReport): Promise<RunOutcome> {
  if ((await readParts(env, card.id)).length) {
    // EVERY REPO MERGED, OR THE CARD IS NOT DONE (0236). What merged is recorded either way.
    const parts = await recordPartReports(env, card.id, report.parts ?? [], "LAND");
    const unmerged = parts.filter((p) => !p.merge_sha).map((p) => p.repo);
    if (unmerged.length) return { finished: false, blocked: false, progressed: false, detail: `LAND came back without a merge for ${unmerged.join(", ")} — the card is not done until every repo has landed` };
    const agg = aggregateParts(parts);
    const now = new Date().toISOString();
    await update(env, card.id, { merge_sha: agg.merge_sha, landed_at: now, live_proof: (report.live_proof ?? "").slice(0, 8000) || null });
    const fresh: WebPropertyChangeRow = { ...row, merge_sha: agg.merge_sha, landed_at: now, live_proof: report.live_proof ?? null };
    const finding = await finishCard(env, card, fresh);
    return { finished: true, blocked: false, progressed: false, detail: finding };
  }
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
    // words back is all this call needs. Said explicitly (found unclassified by
    // `validate:call-classification`, 22 Sep 2026, and fixed here rather than left — Rule 0):
    // "mechanical" was always the intent, it just was not written down for the scan to read.
    budgetContext: { mechanical: true, expectedOutputTokens: 60 },
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
async function blockAsQuestion(env: Env, card: WebPropertyChangeCard, classification: ActionabilityClassification, routed?: QuestionAnswerResult | null): Promise<RunOutcome> {
  // A TRIED-AND-DECLINED ROUTING ATTEMPT GETS A HONEST LINE, NOT SILENCE (Addendum 12). She still
  // sees the question, but she also sees that it was tried first and why nobody could answer it
  // with real confidence — the same transparency the escalation event carries for the audit trail.
  const triedNote = routed?.employeeName ? ` ${routed.employeeName} looked at it first and did not have a confident answer (${routed.reason}).` : "";
  const why = await blockCard(env, card, {
    reason: "a_question_for_you",
    trying: card.title,
    employee: PORTER_NAME,
    who: whoFor(card),
    detail: waitDetail("QUESTION_NOT_A_JOB", { why: `${classification.reason}${triedNote}` }).slice(0, 900),
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

/**
 * BEFORE ESCALATING TO HER, TRY WHOEVER OWNS THIS CARD'S KIND (Addendum 12, 22 Sep 2026).
 *
 * `QUESTION_NEEDS_REPLY` used to route straight to `blockAsQuestion` — a plain question landing on
 * her, every time, even when the answer is one the owning employee already knows. This is the step
 * in front of that: `answerQuestionForCard` looks up the kind's registered host
 * (`shared/work/kindHosts.ts`), asks them in their own grounded voice
 * (`services/questionRouting.ts`, the `askRoom`/`askLiveHelp` shape lifted out of the meeting
 * room), and only when they answer with real, self-reported confidence does the partner ever hear
 * from anyone but her.
 *
 * ESCALATION IS THE DEFAULT, NOT THE EXCEPTION. No kind host, an inactive employee, or a
 * not-confident answer all fall through to the EXACT SAME `blockAsQuestion` this file always
 * called — nothing about that path changes. The only new thing a partner can experience is a
 * confident, grounded answer arriving instead of a wait for her; nothing about the safety net
 * changes shape.
 */
async function handleQuestionNeedsReply(
  env: Env,
  card: WebPropertyChangeCard,
  classification: ActionabilityClassification,
  senderMessage: string,
  answerQuestion: QuestionAnswerer | undefined,
): Promise<RunOutcome> {
  const routed = await answerQuestionForCard(
    env,
    { cardId: card.id, firmScope: card.firm_scope, kind: card.kind ?? WEB_PROPERTY_CHANGE_KIND, cardTitle: card.title, question: senderMessage },
    answerQuestion,
  );

  if (!routed.confident || !routed.answer) {
    await appendEvent(env, {
      eventType: "work_card.question_answer_escalated",
      actorType: "system",
      actorId: routed.employeeId ?? "work_sweep",
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      payload: { tried_employee: routed.employeeName, reason: routed.reason, ai_run_id: routed.aiRunId },
    });
    return blockAsQuestion(env, card, classification, routed);
  }

  const sent = await sendQuestionAnswer(env, card, senderMessage, routed);
  await appendFinding(env, card.id, `${routed.employeeName} answered your question directly, without reaching the Mac: "${routed.answer.slice(0, 300)}"`);
  await env.WP_OS_DB.prepare(
    `UPDATE work_card
        SET state = 'CANCELLED', next_action = NULL, lease_until = NULL,
            question_auto_answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?1`,
  )
    .bind(card.id)
    .run();
  await appendEvent(env, {
    eventType: "work_card.question_auto_answered",
    actorType: "ai_employee",
    actorId: routed.employeeId ?? PORTER_ID,
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { employee: routed.employeeName, reason: routed.reason, ai_run_id: routed.aiRunId, sent: sent.sent, sent_reason: sent.reason },
  });
  return {
    finished: false,
    blocked: false,
    progressed: false,
    questionAnswered: true,
    detail: `${routed.employeeName} answered directly, with real confidence: ${routed.reason}`.slice(0, 900),
  };
}

/**
 * THE ANSWER REACHES THE PARTNER THE SAME WAY ANY FINISHED WORK DOES (Addendum 12/8, 22 Sep 2026).
 * No exception was carved out for this the way banter's reply got one (Addendum 11.1) — this is a
 * partner-facing email with real content, so it goes through `sendOrPreview`
 * (`scripts/validate/every-employee-takes-the-lane.mjs`'s one door) exactly like every other notice
 * this file sends, gated by the card's own "show me first?" tick and Addendum 8's firm-wide
 * "preview every partner-facing email" dial (0228) — the two her decision named. Deliberately NOT
 * chained through this kind's own `done_reply_preview_first` override (`doneReplyLaneFor`'s other
 * input): that rule is Porter's for a real finished DONE reply specifically, a different kind of
 * email than a question he answered directly, and Addendum 12 names only "Addendum 8's firm-wide
 * dial" as the gate this owes — not whatever per-kind override a DONE reply happens to carry.
 *
 * Never recorded as a `work_card_notice` row: those six kinds (`requestReply.ts`'s `NoticeKind`)
 * are the lifecycle of a card that is still being WORKED; an auto-answered question never enters
 * that lifecycle at all, so it is not one of them.
 */
async function sendQuestionAnswer(
  env: Env,
  card: WebPropertyChangeCard,
  senderMessage: string,
  routed: QuestionAnswerResult,
): Promise<{ sent: boolean; reason: string }> {
  const to = (card.requested_by_email ?? "").trim().toLowerCase();
  const partner = to ? partnerByEmail(to) : null;
  if (!partner || !routed.employeeName || !routed.answer) {
    return { sent: false, reason: "no authenticated partner address to answer, or nothing to send" };
  }

  const asked = card.title.replace(/^From [^:]+@[^:]+:\s*/i, "").trim() || card.title;
  const routedBy = await routedByFor(env, card.assigned_from_card_id, routed.employeeName);
  const replyOnThread = await threadRootFor(env, card.id);
  // The card's own tick, OR'd with the firm-wide dial — the same asymmetry `doneReplyLaneFor` uses:
  // either one can ADD a preview, neither can remove one the other already asked for.
  const cardOwnTick = card.preview_first === 1 ? true : card.preview_first === 0 ? false : null;
  const cardAsked = (await previewAllPartnerEmailsIsOn(env)) ? true : cardOwnTick;
  /*
   * WHO APPROVES IT, NOT DERIVED FROM THE REQUESTER (the same fix `doneReplyLaneFor` already made
   * for a real DONE reply). The requester here IS the recipient — the partner whose question this
   * answers — so falling back to `previewOwnerFor`'s `requestedByEmail` tier would have the
   * partner approve sending mail to themselves. Whoever explicitly ticked the card's own box still
   * owns their preview; anyone else defaults to her, exactly like every other rule-forced preview.
   */
  const tickedByFirmUserId = card.preview_owner_id ?? PREVIEW_PARTNER.firmUserId;

  const out = await sendOrPreview(env, {
    to,
    email: {
      employee: routed.employeeName,
      what: `answered — ${asked.slice(0, 60)}`,
      tldr: routed.answer.slice(0, 300),
      sections: [
        { label: "What you asked", bullets: [senderMessage.replace(/\s+/g, " ").trim().slice(0, 300) || asked] },
        { label: "Where things stand", bullets: ["Nothing is being built for this — it was a question, not a job. Reply if you'd like something done."] },
      ],
      details: routed.answer,
      routedBy,
    },
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    actorId: routed.employeeId ?? undefined,
    cardKind: card.kind ?? WEB_PROPERTY_CHANGE_KIND,
    workCardId: card.id,
    cardAsked: cardAsked,
    tickedByFirmUserId: tickedByFirmUserId,
    requestedByEmail: to,
    what: `answered — ${asked.slice(0, 60)}`,
    replyOnThread,
  });
  return { sent: out.sent, reason: out.reason };
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
  answerQuestion?: QuestionAnswerer,
  readIntent: ReplyIntentReader = defaultReadReplyIntent,
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
      reason: "a_question_for_you",
      trying: card.title,
      employee: PORTER_NAME,
      who: whoFor(card),
      detail: waitDetail("WHICH_SITE", { hosts: hostsSentence(await loadRegistry(env)) }).slice(0, 900),
    });
    return { finished: false, blocked: true, progressed: false, detail: why };
  }
  if (row.phase === "DONE") return { finished: true, blocked: false, progressed: false, detail: doneSummary(row, await readParts(env, card.id)) };
  if (row.target_repo === UNRESOLVED_REPO) {
    // "the site", and nothing recent to infer it from: the one question only they can answer.
    const why = await blockCard(env, card, {
      reason: "a_question_for_you",
      trying: card.title,
      employee: PORTER_NAME,
      who: whoFor(card),
      detail: waitDetail("WHICH_SITE", { hosts: hostsSentence(await loadRegistry(env)) }).slice(0, 900),
    });
    return { finished: false, blocked: true, progressed: false, detail: why };
  }
  const rules = await rulesFor(env, WEB_PROPERTY_CHANGE_KIND);

  // 0 · "STOP" FROM THE PARTNER WHO ASKED, at any point after the plan was approved and before LAND.
  if (row.plan_approved_at && row.phase !== "LAND") {
    const words = await heldByRequester(env, card, row, { readIntent, answerQuestion });
    if (words.held) return holdCard(env, card, row, words.held);
    // A note may have changed the row (a force, "preview first", an answer): read it back.
    row = (await readWebPropertyChange(env, card.id)) ?? row;
    // Changes said in a note (or a late reply on an earlier thread) while the preview waits: rebuild with them.
    if (words.rebuildWith && row.phase === "BUILD" && row.check_state === "GREEN" && needsPreview(row) && !row.land_approved_at && !row.forced_by && !row.current_run_id) {
      return requestRebuild(env, card, row, "CHANGES", words.rebuildWith, rules);
    }
  }

  // 1 · The lease. A run the Mac holds is the whole answer for this tick.
  if (row.current_run_id) {
    const run = await readRun(env, row.current_run_id);
    if (run && (run.status === "QUEUED" || run.status === "CLAIMED")) {
      // A QUEUED job stays current with what arrived since it was parked (27 Sep 2026): since a plan
      // whose every ask carries a recommendation parks BUILD at filing, a file or an answer the
      // partner sends afterwards must still reach the run the Mac has not claimed yet.
      if (run.status === "QUEUED") await refreshQueuedJob(env, card, row, run);
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
        /*
         * A MAC THAT IS ASLEEP IS NOT A BLOCK (28 Sep 2026). Whether the job was never claimed
         * (the Mac was away when it was parked) or was claimed and then the Mac slept mid-run (the
         * reaper put it back with `isWaitingForMac` on the row), the partner hears the same thing
         * once: the lane is closed because the Mac is asleep, Porter starts when it wakes, and the
         * owner of the Mac can be asked to open it. Never "Blocked", never an attempt spent.
         */
        await sendAsleep(
          env,
          card,
          `asleep:${run.id}`,
          isWaitingForMac(run.resolution)
            ? `the Mac went to sleep part-way through the ${row.phase.toLowerCase()}; the job is back in the queue and has been waiting ${Math.round(idleMs / 60_000)} minutes for it to wake`
            : `the ${row.phase.toLowerCase()} has been waiting ${Math.round(idleMs / 60_000)} minutes for the Mac to pick it up, and it has not — the Mac is asleep or the local-jobs job is not running`,
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
      if (classification.verdict === "QUESTION_NEEDS_REPLY") return handleQuestionNeedsReply(env, card, classification, senderMessage, answerQuestion);
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
      // Back here without an answer — released by the sweep because nothing needs deciding, reopened
      // by a person by another door, or the block was cleared some other way. Every ask recommended
      // → approved by the request (27 Sep 2026); a real question → ask again rather than build on nothing.
      if (everyAskRecommended(asks)) return approveByRequest(env, card, row, asks);
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
    /*
     * FILES ALONE ARE NOT AN APPROVAL (0237). A reply that only carried attachments ("Attached: …",
     * written by the thread door) delivered materials; it did not approve the plan. The files are on
     * the card and reach BUILD; the plan still waits for the word.
     */
    if (/^Attached: [^\n]+$/.test(answer.trim())) {
      await appendFinding(env, card.id, `Files arrived with a reply (${answer.trim().slice(10, 300)}); they are on the card for the build. The plan still waits for "approved".`);
      const why = await blockWithAsks(env, card, row, asks);
      return { finished: false, blocked: true, progressed: false, detail: why };
    }
    const reading = readApprovalReply(answer);
    /*
     * A REPLY OF ANY KIND EXCEPT STOP APPROVES THE PLAN (owner, 27 Sep 2026). The keywords decide
     * themselves; free text is read for its intent: CONTINUE (with or without instructions) approves,
     * a QUESTION approves on the recommendations and is answered by email, only STOP holds.
     */
    const intent: ReplyIntent = await readReplyIntent(env, { cardId: card.id, firmScope: card.firm_scope, text: answer }, readIntent);
    if (intent.kind === "STOP") {
      // "no" / "hold off" HOLDS THE CARD. The text is on the record; the plan stands; nothing is built.
      await appendFinding(env, card.id, `Not approved by ${card.requested_by_email ?? "the partner"}: "${answer.slice(0, 600)}". The plan stands as written until they say what changes, or drop it.`);
      const why = await blockCard(env, card, {
        reason: "a_question_for_you",
        trying: card.title,
        employee: PORTER_NAME,
        who: whoFor(card),
        detail: waitDetail("HELD_BY_YOU", { what: answer }).slice(0, 900),
      });
      return { finished: false, blocked: true, progressed: false, detail: why };
    }
    // "publish" before any preview exists reads as "approved": build the preview (every change previews first).
    const oneWord = reading.kind === "APPROVED" || reading.kind === "PREVIEW" || reading.kind === "FORCED" || reading.kind === "PUBLISH";
    // Free text: a plain go-ahead takes every recommendation; instructions ride along as the answers.
    const newAnswers = oneWord || (intent.source !== "KEYWORD" && !intent.changes) ? approvedAnswers(asks) : [intent.changes ?? (reading.kind === "CHANGES" || reading.kind === "ANSWERS" ? reading.text : answer)];
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
          : intent.source !== "KEYWORD"
            ? `Plan approved by ${card.requested_by_email ?? "a partner"} — their reply read as ${intent.kind === "QUESTION" ? "a question" : "go ahead"}${intent.changes ? " with instructions" : ", every recommendation taken"} (${intent.reason}): "${answer.slice(0, 400)}"`
            : `Plan approved by ${card.requested_by_email ?? "a partner"} with answers: "${answer.slice(0, 400)}"`,
    );
    if (intent.kind === "QUESTION") await answerMidFlowQuestion(env, card, intent.question ?? answer, answerQuestion);
    await appendEvent(env, {
      eventType: "web_property_change.plan_approved",
      actorType: "firm_user",
      actorId: card.block_answered_by ?? "unknown",
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      payload: { reading: reading.kind, intent: intent.kind, intent_source: intent.source, answer: answer.slice(0, 400) },
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
      /*
       * A PREVIEW AT EVERY STOPPING POINT (0240). Her reply to a preview — or "I added missing items"
       * since it went out — is the ONLY thing that re-checks the materials; nothing polls. "changes:
       * …" (and any answer in her own words) rebuilds with them; "preview" and "publish" rebuild only
       * if the Drive folder or her files actually changed. "approved" and "no"/"stop" are below.
       */
      // "decision 6: …" SETTLES ONE DECISION — recorded as its answer, no rebuild, the same preview waits.
      const resolution = fromRequester && answer ? decisionResolutionIn(answer) : null;
      if (resolution && resolution.n >= 1 && resolution.n <= asksOf(row).length) {
        const who = (card.requested_by_email ? partnerByEmail(card.requested_by_email)?.firstName : null) ?? "the partner";
        const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" }).format(new Date());
        const entry = `${resolution.n}. ${resolution.chosen} (solved: ${who} confirmed ${resolution.why ?? "it"} (${day}))`;
        await update(env, card.id, { answers_json: JSON.stringify([...list(row.answers_json), entry]) });
        await appendFinding(env, card.id, `Decision ${resolution.n} settled by ${who}: ${resolution.chosen}${resolution.why ? ` — ${resolution.why}` : ""}. No rebuild: the preview already reflects it; the same preview waits for "approved".`);
        const why = await blockOnPreview(env, card, { ...row, answers_json: JSON.stringify([...list(row.answers_json), entry]) });
        return { finished: false, blocked: true, progressed: false, detail: `Decision ${resolution.n} recorded; waiting on the same preview. ${why}` };
      }
      // The "I added missing items" button answers the block with exactly that phrase (handleMaterialsAdded).
      const keywordRebuild = landReading?.kind === "APPROVED" || !fromRequester || !answer ? null : rebuildIntentFor(answer);
      if (keywordRebuild) return requestRebuild(env, card, row, keywordRebuild, answer, rules);
      /*
       * FREE TEXT TO A PREVIEW, READ FOR ITS INTENT (owner's decision, 27 Sep 2026). CONTINUE with no
       * changes lands it — the same as "approved" — while `free_reply_lands_preview` is on. CONTINUE
       * WITH changes → make them and send a fresh preview; the next positive reply of any wording
       * lands. STOP holds. QUESTION → answered by email now; the preview stays up and nothing lands
       * until a positive reply. The keyword forms above keep working exactly as before.
       */
      let landsByIntent = false;
      let freeIntent: ReplyIntent | null = null;
      if (answer && fromRequester && landReading?.kind === "ANSWERS") {
        freeIntent = await readReplyIntent(env, { cardId: card.id, firmScope: card.firm_scope, text: answer }, readIntent);
        if (freeIntent.kind === "STOP") return holdCard(env, card, row, answer);
        if (freeIntent.kind === "QUESTION") {
          await answerMidFlowQuestion(env, card, freeIntent.question ?? answer, answerQuestion);
          if (freeIntent.changes) return requestRebuild(env, card, row, "CHANGES", freeIntent.changes, rules);
          await appendFinding(env, card.id, `After the preview, ${card.requested_by_email ?? "the partner"} asked a question; answered by email. The same preview waits for a positive reply — nothing lands until then.`);
          const why = await blockOnPreview(env, card, row);
          return { finished: false, blocked: true, progressed: false, detail: `Question answered; waiting on the same preview. ${why}` };
        }
        if (freeIntent.changes) return requestRebuild(env, card, row, "CHANGES", freeIntent.changes, rules);
        landsByIntent = freeReplyLandsPreview(rules);
        if (!landsByIntent) await appendFinding(env, card.id, `After the preview, ${card.requested_by_email ?? "the partner"} wrote "${answer.slice(0, 200)}" — read as go-ahead, but ${FREE_REPLY_LANDS_PREVIEW} is off for this kind, so the preview waits for "approved".`);
      }
      if (landReading?.kind !== "APPROVED" && !landsByIntent) {
        if (answer && !freeIntent) {
          await appendFinding(env, card.id, `${fromRequester ? "After the preview" : `An answer from ${card.block_answered_by} (not the partner who asked)`}: "${answer.slice(0, 400)}" — not a landing approval; nothing lands.`);
        }
        const why = await blockOnPreview(env, card, row);
        return { finished: false, blocked: true, progressed: false, detail: why };
      }
      const now = new Date().toISOString();
      await update(env, card.id, { land_approved_at: now, land_approved_by: card.block_answered_by ?? card.requested_by_email ?? null });
      await appendFinding(
        env,
        card.id,
        landsByIntent
          ? `Landing approved after the preview by ${card.requested_by_email ?? "a partner"} — their reply read as go ahead (${freeIntent?.reason ?? "free text"}): "${answer!.slice(0, 200)}".`
          : `Landing approved after the preview by ${card.requested_by_email ?? "a partner"} ("${answer!.slice(0, 40)}").`,
      );
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
          detail: waitDetail("LAND_WORD", { what: row.pr_url ?? "the PR" }).slice(0, 900),
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
      detail: waitDetail("TRIED_AND_STOPPED", { what: "to land it", why: parked.reason }).slice(0, 900),
    });
    return { finished: false, blocked: true, progressed: false, detail: why };
  }
  return { finished: false, blocked: false, progressed: true, detail: `LAND queued for the Mac (${phaseModel(rules, "LAND")}).` };
}

// ── HTTP: the rules, and the row for the page ────────────────────────────────────────────────

// ── "I added missing items", and the preview re-sent in the new template (0240) ──────────────

/** The requesting partner, from the signed-in identity, or the refusal. */
async function requesterOnly(ctx: RouteContext): Promise<{ card: WebPropertyChangeCard & { kind: string | null; state: string }; partner: NonNullable<ReturnType<typeof partnerByEmail>> } | Response> {
  const id = ctx.params.id ?? "";
  const card = await ctx.env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<WebPropertyChangeCard & { kind: string | null; state: string }>();
  if (!card) return json({ error: "not_found" }, { status: 404 });
  const partner = PARTNERS.find((p) => p.firmUserId === ctx.identity?.id) ?? null;
  if (!partner) return json({ error: "forbidden", detail: "Only a Managing Partner can do this." }, { status: 403 });
  const requester = card.requested_by_email ? partnerByEmail(card.requested_by_email) : null;
  if (requester && requester.firmUserId !== partner.firmUserId) return json({ error: "forbidden", detail: `Only ${requester.fullName} asked for this, so only ${requester.firstName} can.` }, { status: 403 });
  return { card, partner };
}

/**
 * POST /api/work-cards/:id/materials-added — the "I added missing items" button (owner, 23 Sep 2026;
 * the label is hers, exactly). Pressing it is the same as replying with those words: waiting on a
 * preview, the card re-checks the Drive folder and its files and rebuilds only if something changed
 * (and says so if nothing did); anywhere else it is noted for the next run, which re-maps the folder
 * and reads every file on the card anyway. Never a plan approval. The requesting partner only.
 */
export async function handleMaterialsAdded(ctx: RouteContext): Promise<Response> {
  const who = await requesterOnly(ctx);
  if (who instanceof Response) return who;
  const { card, partner } = who;
  const out = await materialsAdded(ctx.env, card, partner.firmUserId, `${partner.firstName} pressed "${MATERIALS_ADDED_PHRASE}".`);
  if (!out.ok) return json({ error: "not_answered", detail: out.said }, { status: 409 });
  return json({ ok: true, said: out.said });
}

/**
 * THE MATERIALS ARRIVED — the button, or the Drive watch seeing files land in a folder the ask named
 * (R21, 0254). One behaviour for both: waiting on a preview, the card re-checks the Drive folder and
 * its files and rebuilds only if something changed; any other kind's blocked card is answered with the
 * same words; anywhere else a note is left for the next run, which re-maps the folder. Never a plan approval.
 */
export async function materialsAdded(
  env: Env,
  card: { id: string; kind: string | null; state: string; firm_scope: string },
  byFirmUserId: string,
  why: string,
  arrived?: string,
): Promise<{ ok: boolean; said: string }> {
  const noteFor = arrived ?? `${MATERIALS_ADDED_PHRASE} — look again at the Drive folder and the files on this card.`;
  const row = card.kind === WEB_PROPERTY_CHANGE_KIND ? await readWebPropertyChange(env, card.id) : null;
  const atPreview = Boolean(row && card.state === "BLOCKED" && row.check_state === "GREEN" && needsPreview(row) && !row.land_approved_at && !row.forced_by);
  if (atPreview || (card.state === "BLOCKED" && card.kind !== WEB_PROPERTY_CHANGE_KIND)) {
    const out = await answerBlock(env, card.id, byFirmUserId, { action: "ANSWER", text: card.kind === WEB_PROPERTY_CHANGE_KIND || !arrived ? MATERIALS_ADDED_PHRASE : arrived });
    if (!out.ok) return { ok: false, said: out.said };
    return { ok: true, said: `${MATERIALS_ADDED_PHRASE} — noted. I'll check the Drive folder and the files on the card; if anything is new you'll get a new preview, and if not I'll say so.` };
  }
  await env.WP_OS_DB.prepare("INSERT INTO work_card_note (id, work_card_id, author_id, body, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(`wcn_${crypto.randomUUID()}`, card.id, byFirmUserId, noteFor.slice(0, 3900), card.firm_scope)
    .run();
  if (row) await appendFinding(env, card.id, `${why} The next build re-maps the Drive folder and reads every file on the card, so they are used from then on.`);
  return { ok: true, said: `${MATERIALS_ADDED_PHRASE} — noted. The next run picks them up from the Drive folder and the card.` };
}

/**
 * POST /api/work-cards/:id/resend-preview — the preview email again, in the current template, on the
 * same thread with the same link (23 Sep 2026: a preview that went out in the old format before the
 * rewrite shipped). Through the normal notice path, so it is recorded in `work_card_notice`; once
 * per preview (`resend:<preview_emailed_at>`), so a double press sends nothing twice. Requester only.
 */
export async function handleResendPreview(ctx: RouteContext): Promise<Response> {
  const who = await requesterOnly(ctx);
  if (who instanceof Response) return who;
  const { card } = who;
  const row = await readWebPropertyChange(ctx.env, card.id);
  if (!row || !(row.check_state === "GREEN" && needsPreview(row) && !row.land_approved_at && !row.forced_by)) {
    return json({ error: "no_preview_waiting", detail: "This card is not waiting on a preview, so there is nothing to re-send." }, { status: 409 });
  }
  const email = await porterNoticeEmail(ctx.env, card.id, "PREVIEW", "", { resend: true });
  if (!email) return json({ error: "no_preview_waiting" }, { status: 409 });
  const out = await tellRequester(ctx.env, card, { kind: "PREVIEW", cause: `resend:${row.preview_emailed_at ?? row.check_green_at ?? ""}` }, { what: email.what, tldr: email.tldr, tldrBullets: email.tldrBullets, sections: email.sections });
  const notice = await ctx.env.WP_OS_DB.prepare("SELECT message_id, sent FROM work_card_notice WHERE work_card_id = ?1 AND kind = 'PREVIEW' AND cause = ?2").bind(card.id, `resend:${row.preview_emailed_at ?? row.check_green_at ?? ""}`).first<{ message_id: string | null; sent: number }>();
  return json({ ok: out.sent, detail: out.reason, message_id: notice?.message_id ?? null });
}

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
    // 0236: a multi-repo job's repos, each with its own PR, check, preview and merge — and, since the
    // work-card follow-up (23 Sep 2026), each with its ONE clean preview link for its own site.
    parts: (await readParts(ctx.env, id)).map((p) => ({ ...p, preview_link: cleanPreviewUrls(p.preview_url, pagesHostsOf(p.property_host), row.branch ?? "") })),
    /**
     * THE ONE PREVIEW LINK FOR THIS CARD'S SITE (owner review of #193, 23 Sep 2026): the branch alias
     * under the site's own Pages project, from `cleanPreviewUrls` — the same strict reading the
     * emails use. The card never shows `preview_url` raw: on wc_c9e36e8b it held six URLs, two of
     * them other sites' previews, with ' and </a fragments.
     */
    preview_link: cleanPreviewUrls(row.preview_url, pagesHostsOf(row.property_host), row.branch ?? ""),
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
   * ONE RE-READ AT A TIME PER MESSAGE (9 Oct 2026). Two re-reads of Scooter's "New site build" two
   * seconds apart (a person and the partner tail) both cleared the dedupe row and both ran the door:
   * two cards, two "Got it" emails. A re-read now claims the message for five minutes in one atomic
   * statement; the second is refused with the first one's time, and changes nothing.
   */
  const claimKey = key;
  const claimNow = new Date();
  const claim = await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO inbound_reingest_claim (object_key, claimed_at) VALUES (?1, ?2)
     ON CONFLICT (object_key) DO UPDATE SET claimed_at = excluded.claimed_at WHERE inbound_reingest_claim.claimed_at < ?3`,
  )
    .bind(claimKey, claimNow.toISOString(), new Date(claimNow.getTime() - 5 * 60_000).toISOString())
    .run();
  if ((claim.meta?.changes ?? 0) === 0) {
    const held = await ctx.env.WP_OS_DB.prepare("SELECT claimed_at FROM inbound_reingest_claim WHERE object_key = ?1").bind(claimKey).first<{ claimed_at: string }>();
    return json({ ok: false, error: "already_rereading", object_key: key, detail: `this message was re-read at ${held?.claimed_at ?? "a moment ago"}; one re-read per message per five minutes, so nothing was done twice` }, { status: 409 });
  }

  /*
   * "AGAIN" SUPERSEDES (21 Sep 2026). The first re-read of Scooter's newsletter email created
   * NOTHING: `createWorkCardInternal` joined the new assignment into the still-BLOCKED old card
   * with the same owner and title ("runs but inert"). So every live card this message produced
   * before — the chief's assignment card by its title, and any web-property card carrying this
   * message's subject for this partner — is CANCELLED first, with the superseding key on it.
   */
  const assignmentTitle = `From ${from}: ${strippedSubject(subject) || "(no subject)"}`;
  /*
   * A REPLY SUPERSEDES NOTHING (27 Sep 2026, learned in production). The re-read of Scooter's reply to
   * the PLAN email — through the fixed door, so it steered wc_77f52b33 — first CANCELLED wc_77f52b33
   * itself: this step used to match any live website card whose DESCRIPTION contained the subject,
   * and the merge of the stray card had just written that stray's title ("From scooter@…: Porter:
   * Porter: Plan ready") into the survivor's trail. A description is prose about the card, never its
   * identity. So: a message that is a reply to one of our threads supersedes nothing (the card it is
   * about is the card it steers), and the website card a request produced is found through the
   * intake card it was handed on from — an exact title, never a LIKE.
   */
  const isReply = await isReplyToOurs(ctx.env, { from, subject, inReplyTo: headers.get("in-reply-to"), references: headers.get("references") });
  const live = isReply
    ? []
    : ((
        await ctx.env.WP_OS_DB.prepare(
          `SELECT c.id FROM work_card c
            WHERE c.state IN ('OPEN', 'IN_PROGRESS', 'BLOCKED')
              AND lower(c.requested_by_email) = ?1
              AND (lower(trim(c.title)) = lower(trim(?2))
                   OR (c.kind = 'WEB_PROPERTY_CHANGE' AND c.assigned_from_card_id IN (SELECT i.id FROM work_card i WHERE lower(trim(i.title)) = lower(trim(?2)))))`,
        )
          .bind(from, assignmentTitle)
          .all<{ id: string }>()
      ).results ?? []);
  /*
   * AND EVERY LIVE CARD THE EARLIER READ OF THIS SAME MESSAGE OPENED, hand-offs included (7 Oct
   * 2026). The match above is the partner-request title only, so a deal forward that went to Porter
   * and was handed to Wyatt left Wyatt's BLOCKED card — the one that emailed her — standing after
   * the fixed door read the message again and put the company in the funnel.
   */
  const earlier = isReply
    ? []
    : ((
        await ctx.env.WP_OS_DB.prepare(
          /*
           * ONLY CARDS THE MESSAGE OPENED (9 Oct 2026). `inbound_message.work_card_id` is also the card a
           * message STEERED — and a mis-steer is exactly what a re-read is for. The re-read of Scooter's
           * "New site build: voting.topbarz.xyz/entry", which the door had wrongly joined to the
           * westpeek.ventures spam fix, CANCELLED that spam fix while it waited on his preview. A card
           * the message opened is created after the message was stored (the index row is written
           * first, in server time); a card it steered already existed. The minute of slack is clock
           * skew between isolates, never a real card.
           */
          `SELECT c.id FROM work_card c
            WHERE c.state IN ('OPEN', 'IN_PROGRESS', 'BLOCKED')
              AND (c.id IN (SELECT work_card_id FROM inbound_message WHERE r2_key = ?1)
                   OR c.assigned_from_card_id IN (SELECT work_card_id FROM inbound_message WHERE r2_key = ?1))
              AND c.created_at >= (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', julianday(MIN(received_at)) - 60.0 / 86400) FROM inbound_message WHERE r2_key = ?1)`,
        )
          .bind(key)
          .all<{ id: string }>()
      ).results ?? []);
  for (const c of earlier) if (!live.some((l) => l.id === c.id)) live.push(c);
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
  /*
   * A CARD THE MESSAGE WAS WRONGLY ATTACHED TO GETS ITS BLOCK BACK (9 Oct 2026, rules 2 and 3). A NEW
   * email (not a reply) is never the answer to a block (rule 1b). If the door once recorded this message
   * as the answer to a card that existed before it arrived, that card is not cancelled (#234) — it is put
   * back exactly as it was: BLOCKED on its own question, the recorded "answer" gone, and its reminder
   * clock set again (`restoreBlock`), so the re-read can place the message where it belongs.
   */
  const restored: string[] = [];
  if (!isReply) {
    const attached =
      (
        await ctx.env.WP_OS_DB.prepare(
          `SELECT c.id FROM work_card c
            WHERE c.id IN (SELECT work_card_id FROM inbound_message WHERE r2_key = ?1)
              AND c.created_at < (SELECT MIN(received_at) FROM inbound_message WHERE r2_key = ?1)
              AND c.block_answered_at >= (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', julianday(MIN(received_at)) - 60.0 / 86400) FROM inbound_message WHERE r2_key = ?1)`,
        )
          .bind(key)
          .all<{ id: string }>()
      ).results ?? [];
    for (const c of attached) {
      if (await restoreBlock(ctx.env, c.id, `a new email (${subject.slice(0, 80)}) had been recorded as its answer; a new email never answers a block, and the re-read of ${key} put the block back.`)) restored.push(c.id);
    }
    // The message is no longer that card's: the re-read links it to wherever it now lands.
    if (restored.length) await ctx.env.WP_OS_DB.prepare("UPDATE inbound_message SET work_card_id = NULL WHERE r2_key = ?1").bind(key).run();
  }
  // A superseded card no longer holds the message: the re-read links it to wherever it lands now.
  for (const id of superseded) await ctx.env.WP_OS_DB.prepare("UPDATE inbound_message SET work_card_id = NULL WHERE r2_key = ?1 AND work_card_id = ?2").bind(key, id).run();
  if (msgId) await ctx.env.WP_OS_DB.prepare("DELETE FROM inbound_email_seen WHERE message_id = ?1").bind(msgId).run();
  // Where the message lived before this read (after the links above were cleared): a link written by THIS
  // read is where it landed; an unchanged old link says nothing about this read.
  const linkBefore = (await ctx.env.WP_OS_DB.prepare("SELECT work_card_id FROM inbound_message WHERE r2_key = ?1").bind(key).first<{ work_card_id: string | null }>())?.work_card_id ?? null;
  const startedAt = new Date().toISOString();
  const { handleInboundEmail } = await import("../effects/inboundEmail");
  const bytes = new TextEncoder().encode(raw);
  await handleInboundEmail({ from, to: headers.get("to") ?? "os@joinwestpeek.com", headers, raw: new Blob([bytes as BlobPart]).stream(), rawSize: bytes.byteLength }, ctx.env, { receivedTldr, replyOnThread });
  // THE NEW CARD, not "the newest card of the kind": created by this read, for this partner.
  const created = (
    await ctx.env.WP_OS_DB.prepare(
      // 7 Oct 2026: a non-reply the door read as DEAL FLOW opens the analyst's card with no requester,
      // and this route then reported it as "a reply that steered" — so the door's own cards count too.
      `SELECT id, kind, owner_id, title FROM work_card
        WHERE created_at >= ?2 AND (lower(requested_by_email) = ?1 OR (?3 = 0 AND created_by LIKE 'system:%'))
        ORDER BY (kind = 'WEB_PROPERTY_CHANGE') DESC, (lower(COALESCE(requested_by_email, '')) = ?1) DESC, created_at DESC`,
    )
      .bind(from, startedAt, isReply ? 1 : 0)
      .all<{ id: string; kind: string | null; owner_id: string | null; title: string }>()
  ).results ?? [];
  const card = created[0] ?? null;
  /*
   * RULE 1a (9 Oct 2026): A SUPERSEDED CARD POINTS AT ITS REPLACEMENT, so a reply to the old card's
   * thread steers the card that carries the request now — never a CANCELLED row.
   */
  for (const old of superseded) {
    const oldKind = (await ctx.env.WP_OS_DB.prepare("SELECT kind FROM work_card WHERE id = ?1").bind(old).first<{ kind: string | null }>())?.kind ?? null;
    const twin = created.filter((c) => (c.kind ?? null) === oldKind);
    if (twin.length === 1) await ctx.env.WP_OS_DB.prepare("UPDATE work_card SET merged_into_card_id = ?2 WHERE id = ?1 AND state = 'CANCELLED' AND merged_into_card_id IS NULL").bind(old, twin[0]!.id).run();
  }
  /*
   * A RE-READ THAT STEERED (27 Sep 2026). Since the oversize branch runs the same reply check as a
   * small message, a stored reply read again lands on the card it answers and opens nothing — which
   * this route used to report as a 409 "no card". The stored message's index row names the card the
   * door steered (`linkStoredMessage`), and that is the answer.
   */
  const steered = card
    ? null
    : ((await ctx.env.WP_OS_DB.prepare("SELECT work_card_id FROM inbound_message WHERE r2_key = ?1 OR (?2 <> '' AND message_id = ?2) ORDER BY (r2_key = ?1) DESC, received_at DESC LIMIT 1").bind(key, msgId).first<{ work_card_id: string | null }>())?.work_card_id ?? null);
  // …and when the re-read opened nothing but landed on an existing card (a follow-up, a shared file
  // attached to its job), the superseded card points at THAT card (rule 1a).
  if (!card && steered) {
    for (const old of superseded) {
      if (old !== steered) await ctx.env.WP_OS_DB.prepare("UPDATE work_card SET merged_into_card_id = ?2 WHERE id = ?1 AND state = 'CANCELLED' AND merged_into_card_id IS NULL").bind(old, steered).run();
    }
  }
  await appendEvent(ctx.env, {
    eventType: "inbound_email.reingested",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "inbound_email",
    objectId: key,
    firmScope: "west-peek",
    payload: { message_id: msgId, superseded, restored_blocks: restored, created: created.map((c) => c.id), new_card: card?.id ?? null, new_card_kind: card?.kind ?? null, steered_card: steered },
  });
  /*
   * A RE-READ THAT LANDED ON AN EXISTING CARD (9 Oct 2026): a reply steering its card, or a new email /
   * shared file the fixed door placed on the open job it belongs to (the Top Barz rules doc). The latter
   * counts only when THIS read wrote the link — never a stale link from the mis-read being corrected.
   */
  if (!card && steered && (isReply || (linkBefore === null && !superseded.includes(steered)))) {
    const target = await ctx.env.WP_OS_DB.prepare("SELECT id, kind, owner_id, title, state FROM work_card WHERE id = ?1").bind(steered).first<{ id: string; kind: string | null; owner_id: string | null; title: string; state: string }>();
    return json({ ok: true, object_key: key, superseded, steered_card: steered, steered_card_state: target?.state ?? null, new_card: null, new_card_kind: null, owner_id: target?.owner_id ?? null, title: target?.title ?? null, detail: isReply ? "the message is a reply: it steered the card it answers and opened no card" : "the message landed on the open card it belongs to and opened no card" });
  }
  if (!card) return json({ ok: false, object_key: key, superseded, detail: "the door produced no card for this partner from this message — see inbound_email events" }, { status: 409 });
  return json({ ok: true, object_key: key, superseded, new_card: card.id, new_card_kind: card.kind, owner_id: card.owner_id, title: card.title });
}
