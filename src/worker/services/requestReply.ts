import { isTechnicalBlock } from "../../shared/work/blocks";
import { porterContext } from "./porterContext";
import { WEB_PROPERTY_CHANGE_KIND } from "../../shared/work/localJobs";
import type { Env } from "../env";
import { ASSIGNING_PARTNERS } from "../../shared/intake/partnerAuthority";
import { bulletsFrom, type ExecEmailSection } from "../../shared/email/execEmail";
import { missingSectionFor } from "./requestMaterials";
import { partnerByFirmUserId } from "../../shared/registry/partners";
import { sendOrPreview } from "./previewApproval";
import { doneReplyLaneFor } from "./kindRules";

/**
 * A request that came in by email is answered by email.
 *
 * Operator, 14 Sep 2026: "make sure e2e that sequoia@ and scooter@ can email os@joinwestpeek.com
 * for requests and they will be routed to the right employee … completed e2e and we will be
 * notified when its done." Until now the only notice was inside the OS: a partner who had emailed
 * a request learned it was done by opening Work. The request came from an inbox; the answer goes
 * back to the same inbox.
 *
 * WHY THIS IS NOT THE BYPASS `inboundEmail.ts` WARNS ABOUT. That file declined an auto-reply because
 * every `email.send` is an external effect behind a human-approved receipt, and an automatic send
 * on the path that accepts outside instructions would be a bypass around that gate. This reply is
 * bounded on every axis that gate protects, and the bounds live in ONE place — `execEmail.ts`:
 *
 *   · THE DESTINATION IS NEVER CHOSEN BY CONTENT. It is the AUTHENTICATED address the request came
 *     from (`work_card.requested_by_email`, set only by `openAssignmentCard` after DKIM/DMARC passed),
 *     and it is checked against `ASSIGNING_PARTNERS` — the two partners — before anything is sent.
 *   · THE SWITCH IS THE DEPLOYMENT'S. `WP_OS_AI_EMAIL_PARTNERS` governs "may an employee email the
 *     partners".
 *   · THE TRANSPORT DEFUSES TRIGGERS, so a finding that quotes "#wpdealflow" cannot re-enter the
 *     mailbox as a new instruction.
 *   · THE FORMAT IS THE BUSY-EXECUTIVE ONE (16 Sep 2026): TL;DR first, what was asked, what was
 *     done, the finding as bullets, and the partner's call — the employee's full words below the rule.
 *
 * Nothing here can reach a founder, an LP, or anyone outside the firm.
 */
export type NoticeKind = "RECEIVED" | "PLAN" | "PREVIEW" | "QUESTION" | "STUCK" | "DONE";

/**
 * AT MOST ONE OF EACH KIND PER CARD PER CAUSE (owner, 21 Sep 2026: "I don't see why Scooter should
 * get an email at all until it's done"). `work_card_notice` is UNIQUE on (card, kind, cause); a
 * second sweep over the same block, a re-tick, a re-claim — none of them can ring twice. The
 * cause is the fact the email is about (the plan's filing time, the green time, the question's
 * words), so a genuinely new question or a re-filed plan IS sent.
 */
export const NOTICE_KINDS: readonly NoticeKind[] = ["RECEIVED", "PLAN", "PREVIEW", "QUESTION", "STUCK", "DONE"];

export async function alreadyTold(env: Env, cardId: string, kind: NoticeKind, cause: string): Promise<boolean> {
  const row = await env.WP_OS_DB.prepare("SELECT 1 AS one FROM work_card_notice WHERE work_card_id = ?1 AND kind = ?2 AND cause = ?3")
    .bind(cardId, kind, cause.slice(0, 400))
    .first<{ one: number }>();
  return Boolean(row);
}

export async function recordNotice(
  env: Env,
  input: { cardId: string; kind: NoticeKind; cause: string; to: string; messageId: string | null; sent: boolean; detail?: string; firmScope: string },
): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT OR IGNORE INTO work_card_notice (id, work_card_id, kind, cause, sent_to, message_id, sent, detail, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(`wcn_${crypto.randomUUID()}`, input.cardId, input.kind, input.cause.slice(0, 400), input.to, input.messageId, input.sent ? 1 : 0, (input.detail ?? "").slice(0, 400) || null, input.firmScope)
    .run();
}

/**
 * HER WORDS ON THE FINISHED EMAIL (0224, 22 Sep 2026). A Managing Partner may put a line or two on
 * the card; they go out with the finished work as a section in her own name, immediately before
 * "Your call", and on the DONE reply only. A card with none renders exactly the email it did before.
 */
export function requesterNotesSection(notes: string | null | undefined, byFirmUserId: string | null | undefined): ExecEmailSection | null {
  const bullets = String(notes ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^(?:[•·\-*]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  if (bullets.length === 0) return null;
  const partner = partnerByFirmUserId(byFirmUserId ?? null);
  // Only a Managing Partner can set them (the card API refuses anyone else), so a row whose author
  // is not on the partner registry is a row from before that rule — it speaks for the firm, unnamed.
  return { label: partner ? `From ${partner.firstName}` : "From the firm", bullets };
}

/**
 * WHO ROUTED IT (her rule, 22 Sep 2026). `work_card.assigned_from_card_id` is the hand-off trail
 * (0160): the card this one was created from, whose owner is whoever passed the work on. Resolved
 * to a roster NAME here, because "aie_wren" in a partner's inbox is an id, not an answer.
 */
/**
 * THE ONE CONVERSATION A CARD HAS (22 Sep 2026).
 *
 * Every notice about a card — RECEIVED, PLAN, QUESTION, STUCK, DONE — must land in the SAME thread
 * in the partner's mail client. Until now only the RECEIVED path could be handed an earlier token,
 * by a caller that happened to have one; every other notice minted a fresh token and started a
 * fresh conversation. A partner who asked one question got five unrelated messages.
 *
 * `work_card_notice.message_id` already records the thread token of every notice sent about a card,
 * so the root of the conversation is the OLDEST one — asked for here, and carried as
 * `replyOnThread` so the new message names it in `In-Reply-To` and repeats it in `References`.
 *
 * THE ROOT AND NOT THE PREVIOUS MESSAGE, deliberately. Every notice then descends from one common
 * ancestor, so a client that never saw the middle of the chain — a partner added late, a message
 * filtered — still puts the last one under the first. Chaining to the previous would make each
 * message depend on the one before it arriving.
 *
 * A row whose send FAILED still holds a token and is still the right ancestor: the token is an
 * address, not a receipt, and threading a later notice under a message that never arrived costs
 * nothing.
 */
/*
 * THE CONVERSATION WITH THE PARTNER WHO HOLDS THE CARD NOW (0241). After a hand-off the card's
 * primary is someone who never saw the first notice, so its root is not theirs to thread under. The
 * root is the oldest message this card sent to the CURRENT primary — a notice, or the one hand-off
 * email they got — which for a card never handed off is exactly the oldest notice, as before.
 */
export async function threadRootFor(env: Env, cardId: string): Promise<string | null> {
  const row = await env.WP_OS_DB.prepare(
    `SELECT message_id FROM (
       SELECT n.message_id, n.sent_at AS at, 0 AS src, n.rowid AS seq
         FROM work_card_notice n JOIN work_card c ON c.id = n.work_card_id
        WHERE n.work_card_id = ?1 AND n.message_id IS NOT NULL AND n.message_id <> ''
          AND (c.requested_by_email IS NULL OR lower(n.sent_to) = lower(c.requested_by_email))
       UNION ALL
       SELECT h.message_id, h.created_at AS at, 1 AS src, h.rowid AS seq
         FROM work_card_hand_off h JOIN work_card c ON c.id = h.work_card_id
        WHERE h.work_card_id = ?1 AND h.message_id IS NOT NULL AND h.message_id <> '' AND h.sent = 1
          AND lower(h.primary_email) = lower(COALESCE(c.requested_by_email, ''))
     )
     ORDER BY at ASC, src ASC, seq ASC
     LIMIT 1`,
  )
    .bind(cardId)
    .first<{ message_id: string | null }>();
  const token = (row?.message_id ?? "").trim();
  return /^wpt_[0-9a-f]{32}$/i.test(token) ? token.toLowerCase() : null;
}

export async function routedByFor(env: Env, assignedFromCardId: string | null | undefined, who: string): Promise<string | null> {
  const from = (assignedFromCardId ?? "").trim();
  if (!from) return null;
  const row = await env.WP_OS_DB.prepare(
    `SELECT COALESCE(e.name, p.full_name) AS name
       FROM work_card c
       LEFT JOIN ai_employee e ON e.id = c.owner_id
       LEFT JOIN firm_user p ON p.id = c.owner_id
      WHERE c.id = ?1`,
  )
    .bind(from)
    .first<{ name: string | null }>();
  const name = (row?.name ?? "").trim();
  // A hand-off to yourself is not a hand-off, and an owner nobody can name is not worth a sentence.
  return name && name !== who ? name : null;
}

export async function replyToRequester(
  env: Env,
  card: {
    id: string;
    title: string;
    kind?: string | null;
    requested_by_email?: string | null;
    firm_scope: string;
    preview_first?: number | null;
    preview_owner_id?: string | null;
    requester_notes?: string | null;
    requester_notes_by?: string | null;
    assigned_from_card_id?: string | null;
  },
  outcome: "DONE" | "BLOCKED",
  who: string,
  detail: string,
  /** The kind and cause this email is; when given, it is sent at most once per card per cause. */
  notice?: { kind: NoticeKind; cause: string },
  /**
   * A NOTICE COMPOSED BY ITS KIND (23 Sep 2026): Porter's PLAN and PREVIEW emails are built from data
   * in `shared/work/porterNotices.ts` — the reply options as the TL;DR, the plan on the card, never
   * "blocked". Everything else about the send (the lane, the cc, the thread, once per cause) is this
   * function's, unchanged.
   */
  composed?: { what: string; tldr: string; tldrBullets: readonly string[]; sections: ReadonlyArray<{ label: string; bullets: string[] }>; details?: string | null } | null,
): Promise<{ sent: boolean; to: string | null; reason: string }> {
  const to = (card.requested_by_email ?? "").trim().toLowerCase();
  if (!to) return { sent: false, to: null, reason: "the card was not asked for by email" };
  if (!ASSIGNING_PARTNERS.includes(to)) {
    return { sent: false, to, reason: `${to} is not one of the two partner addresses; a reply goes nowhere else` };
  }
  if (notice && (await alreadyTold(env, card.id, notice.kind, notice.cause))) {
    return { sent: false, to, reason: `${notice.kind} was already sent for this cause; not ringing twice` };
  }

  // The card's title is "From sequoia@…: <subject>" at the door; the partner knows who they are.
  // A web property change reads its PLAIN title and its latest preview (porterContext): never the
  // brief cut off mid-word, and the preview link on every email once one exists.
  const porter = card.kind === WEB_PROPERTY_CHANGE_KIND ? await porterContext(env, card.id) : null;
  const asked = porter?.title ?? (card.title.replace(/^From [^:]+@[^:]+:\s*/i, "").trim() || card.title);
  const finding = bulletsFrom(detail);
  const cardLink = `https://os.joinwestpeek.com/#/work (card ${card.id})`;
  /*
   * HER RULE ON THE FINISHED EMAIL (0223, 22 Sep 2026), READ IN THE ONE PLACE BOTH DOORS ASK.
   * `done_reply_preview_first` on the card's kind puts the DONE reply in the preview lane — filed
   * for her on Home with Send it / Send it back / Dismiss — even when the card's own tick was never
   * set. BLOCKED replies, and every notice kind but DONE, carry the card's tick exactly as before:
   * a partner waiting on an answer to a question should not be waiting on a third person as well.
   */
  const lane = await doneReplyLaneFor(env, card, notice);
  // Her words on the card, and who passed the work on — both DONE-only.
  const notes = outcome === "DONE" && notice?.kind === "DONE" ? requesterNotesSection(card.requester_notes, card.requester_notes_by) : null;
  /*
   * WHO ROUTED IT, ON EVERY NOTICE AND NOT ONLY THE LAST ONE (22 Sep 2026). Her rule is that an
   * employee email names who routed the work as well as who did it — and the FIRST message a
   * partner gets about a hand-off is the one where "who is this and why are they writing to me"
   * actually needs answering. #158 wired it to the DONE reply alone, which answered the question
   * only after the work was over. `routedByFor` returns null when there was no hand-off, so a card
   * nobody passed on renders the byte-identical footer it always did.
   */
  const routedBy = await routedByFor(env, card.assigned_from_card_id, who);
  /*
   * WHAT IS STILL MISSING, IN EVERY EMPLOYEE'S EMAIL (0237). One list on the card, one renderer:
   * a question or a plan asks for each item and says how to send it; a preview or a finished piece
   * of work names what went out without it. Every kind's ask, preview and DONE email passes here.
   */
  const missing = await missingSectionFor(env, card.id, outcome === "DONE" || notice?.kind === "PREVIEW" ? "STILL" : "ASK");
  // One conversation per card: this note lands under the first notice sent about it.
  const replyOnThread = await threadRootFor(env, card.id);
  /*
   * THROUGH THE LANE, LIKE EVERYTHING ELSE AN EMPLOYEE FINISHES (18 Sep 2026).
   *
   * `sendOrPreview` was called from exactly ONE file — Walker's hire search — and every other
   * employee reached the transport another way. A rule one caller remembers is the defect this
   * repo keeps producing, and the cost here is specific: her "Show me first?" tick on a card
   * worked by anybody but Walker did nothing at all. Routing through the lane changes nothing
   * about a note to a partner with the box unticked — `previewFirstFor` sends those straight out,
   * exactly as before — and makes the tick mean something everywhere.
   *
   * `scripts/validate/every-employee-takes-the-lane.mjs` fails the build if a new send path is
   * added that reaches a transport without passing through here.
   */
  /*
   * NEVER "BLOCKED" TO A PARTNER (owner, 23 Sep 2026: "it says blocked and i have no idea how to
   * unblock"). A question is called a question, says what answers it, and puts that first. Shared by
   * every employee, so every employee's question reads this way.
   */
  // STUCK only when the block is a fault on our side (a lane refused, attempts spent, stopped part way)
  // — the same reading webPropertyChange's noticeFor uses; a question addressed to her is a question.
  const blockReason = outcome === "BLOCKED" ? (await env.WP_OS_DB.prepare("SELECT block_reason FROM work_card WHERE id = ?1").bind(card.id).first<{ block_reason: string | null }>())?.block_reason ?? null : null;
  const stuck = outcome === "BLOCKED" && (isTechnicalBlock(blockReason) || ["tried_and_could_not_finish", "stopped_part_way"].includes(blockReason ?? ""));
  const previewSection = porter?.previewLine ? [{ label: "Current preview", bullets: [porter.previewLine] }] : [];
  const email = composed
    ? { employee: who, what: composed.what, tldr: composed.tldr, tldrBullets: [...composed.tldrBullets], sections: composed.sections.map((s) => ({ label: s.label, bullets: [...s.bullets] })), details: composed.details ?? null, routedBy }
    : {
        employee: who,
        // A LANE FAULT IS "STUCK", NOT A QUESTION: the reader cannot answer it, and it says so.
        what: outcome === "DONE" ? `done — ${asked}` : stuck ? `stuck — ${asked}` : `a question — ${asked}`,
        tldr:
          outcome === "DONE"
            ? `Finished what you asked for: ${asked}. Nothing needs deciding unless you want more.`
            : stuck
              ? `I'm stuck on ${asked}: something on our side has to be fixed first. What stopped me is below.`
              : `One question before I go on with ${asked}: reply to this email with your answer and I carry on.`,
        sections: [
          { label: "What you asked", bullets: [asked] },
          outcome === "DONE"
            ? { label: "What I found", bullets: finding.length ? finding : ["Finished. The findings are on the card."] }
            : { label: stuck ? "What stopped me" : "What I need from you", bullets: finding.length ? finding : ["One decision from you, and I carry on."] },
          ...previewSection,
          ...(missing ? [missing] : []),
          ...(notes ? [notes] : []),
          {
            label: "Your call",
            bullets:
              outcome === "DONE"
                ? ["Nothing, unless you want it taken further — reply and say how.", `Everything done on it is on the card: ${cardLink}`]
                : // R8 FOR EVERY KIND (0254): the way to clear it is a reply — never "on the card", never a link into the OS.
                  ["Reply to this email with your answer and I carry on — nothing else is needed."],
          },
        ],
        details: detail,
        routedBy,
      };
  // 0253: a site job's files ride on DONE and PREVIEW (attached under the cap, listed always), and the
  // keys it still lacks ride on every email with the exact SECRET line that sends one.
  // ALL KINDS (owner, 6 Oct 2026): a file any employee put on the card rides on its DONE email; a Porter card adds its missing keys.
  const extras = await (await import("./webPropertyChange")).porterEmailExtras(env, card.id, outcome === "DONE" || notice?.kind === "PREVIEW");
  if (extras?.sections.length) {
    const at = email.sections.findIndex((s) => s.label === "Your call" || /^On the card/i.test(s.label));
    email.sections = at < 0 ? [...email.sections, ...extras.sections] : [...email.sections.slice(0, at), ...extras.sections, ...email.sections.slice(at)];
  }
  const out = await sendOrPreview(env, {
    to,
    email,
    ...(extras?.attachments.length ? { attachments: extras.attachments } : {}),
    objectType: "work_card",
    objectId: card.id,
    workCardId: card.id,
    cardKind: card.kind ?? null,
    replyOnThread,
    // 0239: a finished email — or a site change's preview — copies the partners the requester asked to cc.
    finished: outcome === "DONE" || notice?.kind === "PREVIEW",
    cardAsked: lane.cardAsked,
    tickedByFirmUserId: lane.tickedByFirmUserId,
    requestedByEmail: card.requested_by_email ?? null,
    firmScope: card.firm_scope,
    actorId: "work_sweep",
    events: { sent: "work_card.replied_by_email", notSent: "work_card.reply_not_sent" },
  });
  if (notice) {
    await recordNotice(env, { cardId: card.id, kind: notice.kind, cause: notice.cause, to, messageId: out.threadToken ?? null, sent: out.sent, detail: out.reason, firmScope: card.firm_scope });
  }
  return { sent: out.sent, to, reason: out.reason };
}
