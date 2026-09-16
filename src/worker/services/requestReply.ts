import type { Env } from "../env";
import { ASSIGNING_PARTNERS } from "../../shared/intake/partnerAuthority";
import { bulletsFrom } from "../../shared/email/execEmail";
import { sendPartnerEmail } from "./execEmail";

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
export async function replyToRequester(
  env: Env,
  card: { id: string; title: string; requested_by_email?: string | null; firm_scope: string },
  outcome: "DONE" | "BLOCKED",
  who: string,
  detail: string,
): Promise<{ sent: boolean; to: string | null; reason: string }> {
  const to = (card.requested_by_email ?? "").trim().toLowerCase();
  if (!to) return { sent: false, to: null, reason: "the card was not asked for by email" };
  if (!ASSIGNING_PARTNERS.includes(to)) {
    return { sent: false, to, reason: `${to} is not one of the two partner addresses; a reply goes nowhere else` };
  }

  // The card's title is "From sequoia@…: <subject>" at the door; the partner knows who they are.
  const asked = card.title.replace(/^From [^:]+@[^:]+:\s*/i, "").trim() || card.title;
  const finding = bulletsFrom(detail);
  const cardLink = `https://os.joinwestpeek.com/#/work (card ${card.id})`;
  const out = await sendPartnerEmail(env, {
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
    firmScope: card.firm_scope,
    actorId: "work_sweep",
    events: { sent: "work_card.replied_by_email", notSent: "work_card.reply_not_sent" },
  });
  return { sent: out.sent, to, reason: out.reason };
}
