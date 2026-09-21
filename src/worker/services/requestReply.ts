import type { Env } from "../env";
import { ASSIGNING_PARTNERS } from "../../shared/intake/partnerAuthority";
import { bulletsFrom } from "../../shared/email/execEmail";
import { sendOrPreview } from "./previewApproval";

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

export async function replyToRequester(
  env: Env,
  card: {
    id: string;
    title: string;
    requested_by_email?: string | null;
    firm_scope: string;
    preview_first?: number | null;
    preview_owner_id?: string | null;
  },
  outcome: "DONE" | "BLOCKED",
  who: string,
  detail: string,
  /** The kind and cause this email is; when given, it is sent at most once per card per cause. */
  notice?: { kind: NoticeKind; cause: string },
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
  const asked = card.title.replace(/^From [^:]+@[^:]+:\s*/i, "").trim() || card.title;
  const finding = bulletsFrom(detail);
  const cardLink = `https://os.joinwestpeek.com/#/work (card ${card.id})`;
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
  const out = await sendOrPreview(env, {
    to,
    email: {
      employee: who,
      what: outcome === "DONE" ? `done — ${asked}` : `blocked — ${asked}`,
      tldr:
        outcome === "DONE"
          ? `Finished what you asked for: ${asked}. Nothing needs deciding unless you want more.`
          : `Blocked on what you asked for: ${asked}. One decision from you unblocks it.`,
      sections: [
        { label: "What you asked", bullets: [asked] },
        outcome === "DONE"
          ? { label: "What I found", bullets: finding.length ? finding : ["Finished. The findings are on the card."] }
          : { label: "Where I am stuck", bullets: finding.length ? finding : ["I need a decision from you before I can go on."] },
        {
          label: "Your call",
          bullets:
            outcome === "DONE"
              ? ["Nothing, unless you want it taken further — reply and say how.", `Everything done on it is on the card: ${cardLink}`]
              : ["Answer the question above by replying to this email, or on the card.", `The card: ${cardLink}`],
        },
      ],
      details: detail,
    },
    objectType: "work_card",
    objectId: card.id,
    workCardId: card.id,
    cardAsked: card.preview_first === 1 ? true : card.preview_first === 0 ? false : null,
    tickedByFirmUserId: card.preview_owner_id ?? null,
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
