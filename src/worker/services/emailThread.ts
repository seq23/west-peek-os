import { recordCcFrom } from "./ccPartners";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { mintThreadToken, threadHeaders, threadTokensIn, type EmailThreadRow } from "../../shared/email/thread";
import { writtenAndQuoted } from "../../shared/intake/replyBody";
import { containsGenuineQuestion } from "../../shared/intake/genuineQuestion";
import { addressIn, mailAuthority } from "../../shared/intake/partnerAuthority";
import { partnerByEmail, PREVIEW_PARTNER, type Partner } from "../../shared/registry/partners";
import type { InstructionPiece } from "../../shared/work/instruction";
import { answerBlock } from "./blocks";
import { ownershipFromWords, tellPartner, tellSecondaryRefused } from "./handOff";
import { ownershipOf, roleOf } from "../../shared/work/partnerOwnership";
import { readApprovalReply } from "../../shared/work/approvalReply";
import { textBodyOf } from "../effects/mimeAttachments";
import { storeAttachments } from "./requestMaterials";
import { answerQuestionForCard, type QuestionAnswerer, type QuestionAnswerResult } from "./questionRouting";
import { previewAllPartnerEmailsIsOn } from "./kindRules";
import { routedByFor } from "./requestReply";
import { sendOrPreview } from "./previewApproval";
import { notifyPartners } from "./notifications";

/**
 * A REPLY, MATCHED TO ITS CONVERSATION AND TURNED INTO A STEER (17 Sep 2026).
 *
 * The scheme is in `shared/email/thread.ts` (why `References` and not `provider_message_id`, and
 * why no capability token), the split is in `shared/intake/replyBody.ts` (what a person wrote
 * versus what their client quoted), and migration 0180 holds the two tables. This file is the half
 * that needs a database.
 */

// ── Outbound: the thread a note starts ────────────────────────────────────────────────────────

export interface StartThreadInput {
  objectType: string;
  objectId: string;
  /** The `work_card.kind`, when there is one, so a reply steers the KIND of recurring work. */
  cardKind?: string | null;
  employee?: string | null;
  to: string;
  subject: string;
  firmScope: string;
}

/**
 * Mint the token for a message about to go out, and return the headers that carry it.
 *
 * WRITTEN BEFORE THE SEND, not after, and deliberately. The row has to exist by the time a reply
 * could arrive, and a reply can arrive within seconds; recording it afterwards would open a window
 * in which a partner's answer is unmatched for no reason anybody could see. A row whose message
 * then failed to send is harmless: it is an address nobody will ever quote back.
 */
export async function startThread(
  env: Env,
  input: StartThreadInput,
): Promise<{ token: string; headers: Record<string, string> }> {
  const token = mintThreadToken();
  await env.WP_OS_DB.prepare(
    `INSERT INTO email_thread (token, object_type, object_id, card_kind, employee, to_address, subject, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      token,
      input.objectType,
      input.objectId,
      input.cardKind ?? null,
      input.employee ?? null,
      input.to.trim().toLowerCase(),
      input.subject,
      input.firmScope,
    )
    .run();
  return { token, headers: threadHeaders(token) };
}

/**
 * Record what the transport called the message.
 *
 * EVIDENCE, NEVER A KEY. `provider_message_id` is what a receipt should say when somebody asks how
 * a message left the building; it is not what a reply points at. See `shared/email/thread.ts` for
 * the confirmed reason — Resend's id is not the Message-ID and SES issues its own; Cloudflare's is
 * a log identifier and refuses to let anybody set the header at all.
 */
export async function recordThreadDelivery(
  env: Env,
  token: string,
  result: { provider: string; provider_message_id: string | null },
): Promise<void> {
  await env.WP_OS_DB.prepare(
    "UPDATE email_thread SET provider = ?2, provider_message_id = ?3 WHERE token = ?1",
  )
    .bind(token, result.provider, result.provider_message_id)
    .run();
}

// ── Inbound: the reply that comes back ────────────────────────────────────────────────────────

export interface SteerFromReply {
  /** True when the message was matched to one of our threads AND accepted as a partner's. */
  steered: boolean;
  /**
   * 20 Sep 2026. True when the reply CLEARED A BLOCK: the card was BLOCKED with a question for the
   * partner who asked, and their reply is the answer. The card is OPEN again with the answer on
   * it, and the next sweep resumes the work with it.
   */
  answered?: boolean;
  thread: EmailThreadRow | null;
  /** What the partner WROTE. Never the quoted original. Empty when they wrote nothing above it. */
  written: string;
  /** 0237: the files the reply carried, kept against the card for its next run. */
  attached?: string[];
  /** Why it was not acted on, for the routing card. Empty when it was. */
  reason: string;
  /** True when the message carried one of our tokens at all — an ordinary email carries none. */
  attempted: boolean;
}

const NOT_A_REPLY: SteerFromReply = { steered: false, thread: null, written: "", reason: "", attempted: false };

/**
 * Read an arriving message as a steer on the work it is replying to.
 *
 * ─── TWO FACTS, BOTH REQUIRED, AND NEITHER IS A SECRET ─────────────────────────────────────────
 *
 *   1 · One of our thread tokens in `In-Reply-To` or `References` — which says WHICH conversation,
 *       and nothing else. A token is not a permission.
 *   2 · The message authenticated through the trusted resolver as one of the two partners, which is
 *       the same bar an emailed work assignment passes. That is the whole authority.
 *
 * ─── AND THE WRITTEN HALF ONLY ─────────────────────────────────────────────────────────────────
 *
 * What is stored is what the person typed above the quote. Storing the whole body would feed the
 * firm's own note back to the interpreter as though the partner had written it, and a model asked
 * to read "not this one" plus eight hundred words of Walker's own prose has been handed the wrong
 * question.
 *
 * The QUOTED half is not lost: the caller still has the whole message and still files it, so the
 * context a bare "not this one" refers to is intact — that is the property the operator asked to
 * keep. What the quote may no longer do is FIRE anything.
 */
export async function steerFromReply(
  env: Env,
  message: {
    fromHeader: string | null;
    authenticationResults: string | null;
    subject: string;
    raw: string;
    inReplyTo: string | null;
    references: string | null;
    /**
     * The stored `.eml` this reply lives in, kept once at the door (0226).
     *
     * A STEER KEEPS ONLY THE WRITTEN HALF, and that is correct — feeding the firm's own quoted note
     * back to an interpreter as though a partner had written it is the wrong question. But until
     * 22 Sep 2026 the quoted half was simply GONE: nothing stored the message a steer came from, so
     * "what was he actually answering" had no answer at all. The whole message is now kept at the
     * door and the key travels with the reply, so the written half drives the work and the complete
     * original is one join away on `inbound_message.work_card_id`.
     */
    emlKey: string | null;
  },
  /**
   * INJECTABLE, LIKE `ActionabilityClassifier`/`QuestionAnswerer` ELSEWHERE, so a test can prove the
   * ROUTING on a reply to a DONE card (confident vs. not, and what a partner receives) without a
   * live model call. Omitted, this defaults to Addendum 12's own real answerer — the production
   * path is unchanged by this parameter existing.
   */
  deps: { answerQuestion?: QuestionAnswerer } = {},
): Promise<SteerFromReply> {
  const tokens = threadTokensIn({ inReplyTo: message.inReplyTo, references: message.references });

  let thread: EmailThreadRow | null = null;
  for (const token of tokens) {
    const row = await env.WP_OS_DB.prepare("SELECT * FROM email_thread WHERE token = ?1")
      .bind(token)
      .first<EmailThreadRow>();
    // Newest first, so the first hit is the message being answered rather than the one that started
    // the conversation four weeks ago.
    if (row) {
      thread = row;
      break;
    }
  }

  /*
   * "RE: <ONE OF OUR SUBJECTS>" IS A REPLY EVEN WHEN THE TOKEN DID NOT COME BACK (21 Sep 2026).
   * Scooter answered Walker's blocked note from his iPhone — "Yes he can open." — and the
   * References header did not carry our token, so the door opened a NEW assignment card (kind
   * BLOG_HELP, because the subject said "newsletter") and would have written a blog outline on
   * "Yes he can open". A message from an authenticated partner whose subject is Re:/Fwd: of a note
   * we sent THEM is that note's reply: matched on the subject we rendered and the address we sent
   * it to, newest first. Only for the partners (the authority check below still decides), and
   * only for subjects that are ours.
   */
  if (!thread && tokens.length === 0 && /^\s*(?:re|fwd?|aw|sv)\s*:/i.test(message.subject)) {
    const from = (addressIn(message.fromHeader) ?? "").toLowerCase();
    const bare = message.subject.replace(/^\s*(?:(?:re|fwd?|aw|sv)\s*:\s*)+/i, "").trim();
    if (from && bare) {
      thread =
        (await env.WP_OS_DB.prepare("SELECT * FROM email_thread WHERE to_address = ?1 AND lower(trim(subject)) = lower(?2) ORDER BY created_at DESC LIMIT 1")
          .bind(from, bare)
          .first<EmailThreadRow>()) ?? null;
    }
  }
  if (!thread && tokens.length === 0) return NOT_A_REPLY;
  if (!thread) {
    return {
      steered: false,
      thread: null,
      written: "",
      reason: "it answers a conversation this system does not have a record of",
      attempted: true,
    };
  }

  const authority = mailAuthority({
    fromHeader: message.fromHeader,
    authenticationResults: message.authenticationResults,
  });
  if (!authority.isAssignment) {
    return {
      steered: false,
      thread,
      written: "",
      reason: `it replies to one of our notes, and it was not accepted as coming from a Managing Partner: ${authority.reason}`,
      attempted: true,
    };
  }

  // THE WORDS, NOT THE MIME (21 Sep 2026): a Gmail or iPhone reply is multipart; the answer is its
  // text part, decoded, and only what sits above the quote.
  const split = writtenAndQuoted(`\r\n\r\n${textBodyOf(message.raw)}`, {
    inReplyTo: message.inReplyTo,
    references: message.references,
    subject: message.subject,
  });
  let written = split.written.trim();
  /*
   * A REPLY'S FILES ARE KEPT, FOR EVERY CARD (23 Sep 2026, 0237). "Here's the logo" with the logo
   * attached used to lose the logo: this door read the text and dropped the MIME. The files are now
   * kept against the card by the same mechanism the door uses for an opening email, so the card's
   * next run — whatever its kind, whoever's card it is — is handed them. A reply that is ONLY files
   * is still an answer: it says what it carried.
   */
  let attached: string[] = [];
  if (thread.object_type === "work_card") {
    const kept = await storeAttachments(env, { cardId: thread.object_id, raw: message.raw, emlKey: message.emlKey, firmScope: thread.firm_scope, source: "REPLY" });
    attached = kept.stored;
    if (kept.stored.length || kept.unread.length || (kept.attachments > 0 && !message.emlKey)) {
      await env.WP_OS_DB.prepare("UPDATE work_card SET description = substr(COALESCE(description, '') || char(10) || ?2, 1, 16000) WHERE id = ?1")
        .bind(
          thread.object_id,
          [
            ...(kept.stored.length ? [`• ATTACHED WITH A REPLY from ${authority.partnerAddress}: ${kept.stored.join(", ")}`] : []),
            ...(kept.attachments > 0 && !message.emlKey ? ["• A reply's attachment(s) could NOT be kept — the message itself was not kept."] : []),
            ...kept.unread.map((u) => `• Could NOT keep a reply's attachment: ${u}.`),
          ].join("\n"),
        )
        .run();
    }
    if (written.length < 2 && attached.length) written = `Attached: ${attached.join(", ")}`;
  }
  if (written.length < 2) {
    return {
      steered: false,
      thread,
      written: "",
      reason: "it replies to one of our notes but has nothing written above the quoted original",
      attempted: true,
    };
  }

  /*
   * STORED AGAINST THE KIND OF WORK, NOT THE CARD — and without this the whole feature is inert.
   *
   * By the time a partner answers Monday's note, Monday's card is DONE, and next Monday's card is a
   * different row with no notes on it. A note filed on the closed card would be read by nothing,
   * ever. See migration 0180.
   */
  const kind = thread.card_kind;
  if (kind) {
    await env.WP_OS_DB.prepare(
      `INSERT INTO work_steer (id, card_kind, from_card_id, said_by, body, thread_token, firm_scope)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(
        `wst_${crypto.randomUUID()}`,
        kind,
        thread.object_type === "work_card" ? thread.object_id : null,
        authority.partnerAddress!,
        written.slice(0, 4000),
        thread.token,
        thread.firm_scope,
      )
      .run();
  }

  /*
   * ── APPROVAL THAT RESUMES (20 Sep 2026, Plan A) ────────────────────────────────────────────
   *
   * A BLOCKED card emailed its question to the partner who asked for the work. Their reply IS the
   * answer, and it goes through the SAME door the button on the card uses — `answerBlock` with
   * ANSWER — so the card is OPEN again with `block_answer` on it, a note for the loop, and the
   * attempts reset; the next sweep resumes the run with the answer in front of it. Nothing here
   * interprets the words: "go", "yes to 1, no to 2, use the orange" and a paragraph are all
   * answers, and the runner reads them.
   *
   * SCOOTER ANSWERS SCOOTER'S QUESTIONS. The block is addressed to the partner who asked
   * (`requested_by_email`); a reply from the other partner is kept as a note on the card — it is
   * still a Managing Partner's word — but it does not clear a question that was not theirs. A
   * card with no requester on it (raised by hand) is cleared by either partner.
   */
  /*
   * ONE CARD READ, THREE OUTCOMES (22 Sep 2026). Used to be two separate `WHERE state IN (...)`
   * reads — one for BLOCKED, one for OPEN/IN_PROGRESS — and whichever missed left the reply with
   * nowhere to go. Read once, and the state on the row itself decides which of the three doors below
   * takes it, so there is no fourth, unhandled shape hiding between two queries that could disagree.
   */
  let answered = false;
  if (thread.object_type === "work_card") {
    const partner = partnerByEmail(authority.partnerAddress);
    const cardRow = await env.WP_OS_DB.prepare(
      `SELECT id, title, kind, state, requested_by_email, secondary_partner_email, preview_first, preview_owner_id, assigned_from_card_id, firm_scope
         FROM work_card WHERE id = ?1`,
    )
      .bind(thread.object_id)
      .first<{
        id: string;
        title: string;
        kind: string | null;
        state: string;
        requested_by_email: string | null;
        secondary_partner_email: string | null;
        preview_first: number | null;
        preview_owner_id: string | null;
        assigned_from_card_id: string | null;
        firm_scope: string;
      }>();

    // "CC SCOOTER" IN A REPLY (0239): recorded from the authenticated sender, whatever the state;
    // `recordCcFrom` refuses anyone but the requesting partner and names non-partners it refused.
    if (cardRow && partner) await recordCcFrom(env, cardRow.id, written, partner.email);

    /*
     * "HAND THIS TO SCOOTER" / "TAKE THIS BACK" (0241). Read before anything else acts on the reply:
     * it moves the card and is never an answer to a block. The authenticated sender decides, through
     * the same rules as the note and the route; a refusal is answered on the sender's own thread.
     */
    const owned = cardRow && partner ? await ownershipFromWords(env, { cardId: cardRow.id, writer: partner.email, text: written, via: "REPLY", ackOnThread: thread.token }) : null;
    /*
     * A SECONDARY'S "APPROVED" (0241): refused, and told who approves and how to take it over. The
     * reply is still kept as a note below — read as context, never as an approval.
     */
    const secondarySaidApproved =
      !owned && cardRow && partner && roleOf(cardRow, partner.email) === "SECONDARY" && ["APPROVED", "FORCED", "PREVIEW", "PUBLISH"].includes(readApprovalReply(written).kind);
    if (owned && !owned.ok && cardRow && partner) {
      await tellPartner(env, { cardId: cardRow.id, to: partner, label: "Not changed", line: owned.reason ?? "Not changed.", subjectTail: "not handed off", onThread: thread.token });
    } else if (secondarySaidApproved && cardRow && partner) {
      await tellSecondaryRefused(env, { cardId: cardRow.id, secondary: partner, primary: ownershipOf(cardRow).primary!, said: written, onThread: thread.token });
    }

    if (owned) {
      // Handled: the card changed hands (or was refused, and said so). Nothing below reads it.
    } else if (cardRow && partner && cardRow.state === "BLOCKED") {
      const asked = (cardRow.requested_by_email ?? "").trim().toLowerCase();
      if (!asked || asked === partner.email) {
        const out = await answerBlock(env, cardRow.id, partner.firmUserId, { action: "ANSWER", text: written.slice(0, 4000) });
        answered = out.ok;
      } else {
        await env.WP_OS_DB.prepare(
          "INSERT INTO work_card_note (id, work_card_id, author_id, body, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
          .bind(
            `wcn_${crypto.randomUUID()}`,
            cardRow.id,
            partner.firmUserId,
            roleOf(cardRow, partner.email) === "SECONDARY"
              ? `(From the secondary partner; read as context, not an approval.) ${written.slice(0, 3900)}`
              : `(Not the partner this question was addressed to; kept as a note.) ${written.slice(0, 3900)}`,
            thread.firm_scope,
          )
          .run();
      }
    } else if (cardRow && partner && (cardRow.state === "OPEN" || cardRow.state === "IN_PROGRESS")) {
      /*
       * A NOTE ON THE CARD ITSELF WHEN IT IS STILL OPEN, because the card's thread is where a
       * person looks for what was said about a piece of work. `steerFor` reads unacknowledged
       * notes, so a reply that lands mid-run reaches the very next stage — which is the behaviour
       * `services/instruction.ts` already promises for a note typed in the UI.
       */
      await env.WP_OS_DB.prepare(
        "INSERT INTO work_card_note (id, work_card_id, author_id, body, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5)",
      )
        .bind(`wcn_${crypto.randomUUID()}`, cardRow.id, partner.firmUserId, written.slice(0, 4000), thread.firm_scope)
        .run();
    } else if (cardRow && partner) {
      /*
       * ── A REPLY ON A CARD NEITHER BLOCKED NOR OPEN — THE COMMON CASE, AND UNTIL NOW A SILENT
       * DROP (22 Sep 2026). By the time a partner reads and replies to a weekly deliverable, the
       * card has almost always finished: DONE, or CANCELLED (auto-resolved, dropped, or Addendum
       * 12's own auto-answer). Neither branch above ever claimed that shape, so a genuine QUESTION
       * riding alongside the steering — Scooter's "What's her email, do you have it?" next to his
       * "prefer a music background going forward" — went nowhere. The steering half is already
       * filed into `work_steer` above, unconditionally, regardless of card state; this is only the
       * missing other half.
       */
      await handleReplyOnClosedCard(env, cardRow, partner, written, thread, message.emlKey, deps.answerQuestion);
    }
  }

  await appendEvent(env, {
    eventType: "work.steered_by_reply",
    actorType: "firm_user",
    actorId: partnerByEmail(authority.partnerAddress)?.firmUserId ?? "unknown",
    objectType: thread.object_type,
    objectId: thread.object_id,
    firmScope: thread.firm_scope,
    payload: {
      thread_token: thread.token,
      card_kind: kind,
      employee: thread.employee,
      // The written length and the quoted length, side by side: the one number that shows the split
      // did something. A reply where these are equal is one with no quote, not a failed split.
      written_chars: written.length,
      quoted_chars: split.quoted.length,
      said: written.slice(0, 400),
      answered_block: answered,
      // Where the whole reply is, quoted half included — the half a steer deliberately does not act
      // on and just as deliberately no longer throws away.
      stored: message.emlKey,
    },
  });

  return { steered: true, thread, written, reason: "", attempted: true, answered, attached };
}

// ── A reply lands on a card that is neither BLOCKED nor OPEN/IN_PROGRESS (22 Sep 2026) ──────────

interface ClosedCardRow {
  id: string;
  title: string;
  kind: string | null;
  requested_by_email: string | null;
  preview_first: number | null;
  preview_owner_id: string | null;
  assigned_from_card_id: string | null;
  firm_scope: string;
}

/**
 * THE MISSING THIRD DOOR. `steerFromReply`'s two existing branches assume the card is still being
 * worked — answering a block, or leaving a note for the loop to read on its next step. A DONE (or
 * CANCELLED) card has no next step; nothing ever reads a note left on it, and nothing was ever
 * surfaced instead. This is that surfacing, scoped narrowly to the one thing that actually needs
 * it: a REAL QUESTION in the reply, never the steering instruction alone (that already reached
 * `work_steer`, above, unconditionally, and needs nothing more done with it here).
 */
async function handleReplyOnClosedCard(
  env: Env,
  card: ClosedCardRow,
  partner: Partner,
  written: string,
  thread: EmailThreadRow,
  emlKey: string | null,
  answerQuestion: QuestionAnswerer | undefined,
): Promise<void> {
  if (!containsGenuineQuestion(written)) return; // pure steering — nothing further to do, by design.

  /*
   * ANSWER IT FROM WHAT THE FIRM ACTUALLY HAS, THE SAME WAY A LIVE CARD'S QUESTION IS TRIED FIRST
   * (Addendum 12, `services/questionRouting.ts`). Reused rather than duplicated: `answerQuestionForCard`
   * already carries the "whoever owns this kind tries first, biased hard toward NOT confident,
   * never guesses" discipline this brief asks for — the exact posture a candidate's contact email
   * needs (only a verified source counts, and "I don't know" beats a scraped guess). It looks up
   * the card's KIND against `shared/work/kindHosts.ts`; a kind with no registered owner (most of
   * them, today — `PRODUCTIONS_HIRE_SEARCH` among them) always comes back not confident, which is
   * the correct, safe default until that registry grows. THIS IS THE PLUG-IN SEAM: when Addendum
   * 12's registry grows to cover more kinds, or gains a real grounded lookup against the card's own
   * stored data (a candidate search's actual results, not just a persona's say-so), this call needs
   * no change — the mechanism it reuses gets better underneath it.
   */
  const routed = await answerQuestionForCard(
    env,
    { cardId: card.id, firmScope: card.firm_scope, kind: card.kind, cardTitle: card.title, question: written },
    answerQuestion,
  );

  const dedupeKey = `work_card:${card.id}:question_after_done:${emlKey ?? thread.token}`;

  if (routed.confident && routed.answer && routed.employeeName) {
    const sent = await sendClosedCardAnswer(env, card, partner.email, written, routed, thread);
    await env.WP_OS_DB.prepare(
      "INSERT INTO work_card_note (id, work_card_id, author_id, body, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(
        `wcn_${crypto.randomUUID()}`,
        card.id,
        partner.firmUserId,
        `[Answered after DONE] ${routed.employeeName} replied directly, without reaching you again: "${routed.answer}"`.slice(0, 4000),
        card.firm_scope,
      )
      .run();
    await appendEvent(env, {
      eventType: "work_card.question_after_done_answered",
      actorType: "ai_employee",
      actorId: routed.employeeId ?? "unknown",
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      payload: { employee: routed.employeeName, reason: routed.reason, ai_run_id: routed.aiRunId, sent: sent.sent, sent_reason: sent.reason, thread_token: thread.token },
    });
    return;
  }

  /*
   * NOT CONFIDENTLY ANSWERABLE — SURFACED, NEVER SILENT, AND NEVER DISGUISED AS A LIVE BLOCK. The
   * card stays exactly as done (or cancelled) as it was; nothing here reopens it or touches its
   * state, because a question arriving after the fact is not the same thing as work still being
   * done — conflating the two would make a finished deliverable look unfinished on Record. Two
   * durable, human-visible traces instead: a distinctly labelled note on the card's own thread (for
   * whoever opens it later) and a firm-wide notification (for whoever is meant to see it now).
   */
  await env.WP_OS_DB.prepare(
    "INSERT INTO work_card_note (id, work_card_id, author_id, body, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(
      `wcn_${crypto.randomUUID()}`,
      card.id,
      partner.firmUserId,
      `[QUESTION AFTER DONE — needs a reply from you] ${written}`.slice(0, 4000),
      card.firm_scope,
    )
    .run();
  await notifyPartners(env, {
    kind: "MEETING",
    severity: "INFO",
    title: `A question arrived after "${card.title.slice(0, 60)}" was already done`,
    body:
      `${partner.fullName} replied to a finished card with something that reads like a question` +
      `${routed.employeeName ? ` — ${routed.employeeName} tried to answer it and was not confident (${routed.reason})` : ""}: "${written.slice(0, 300)}". ` +
      "This card is already DONE and stays that way; it will not reopen on its own. Reply to them directly, or open the card and answer it there.",
    objectType: "work_card",
    objectId: card.id,
    dedupeKey,
    firmScope: card.firm_scope,
  });
  await appendEvent(env, {
    eventType: "work_card.question_after_done_escalated",
    actorType: "system",
    actorId: routed.employeeId ?? "email_thread",
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { tried_employee: routed.employeeName, reason: routed.reason, ai_run_id: routed.aiRunId, thread_token: thread.token },
  });
}

/**
 * THE ANSWER REACHES THE PARTNER THE SAME WAY ANY FINISHED WORK DOES — the identical "show me
 * first" gate `webPropertyChange.ts`'s own `sendQuestionAnswer` (Addendum 12) uses for a live
 * card's confident answer, applied here to a card that had already finished. No exception carved
 * out for it: it is a partner-facing email with real content, so it goes through `sendOrPreview`,
 * gated by the card's own preview tick OR'd with Addendum 8's firm-wide "preview every partner
 * email" dial (0228) — whichever asks for a look decides, and the requester is never made her own
 * approver (`tickedByFirmUserId` falls back to `PREVIEW_PARTNER`, never to the recipient).
 */
async function sendClosedCardAnswer(
  env: Env,
  card: ClosedCardRow,
  to: string,
  askedText: string,
  routed: QuestionAnswerResult,
  thread: EmailThreadRow,
): Promise<{ sent: boolean; reason: string }> {
  if (!routed.employeeName || !routed.answer) return { sent: false, reason: "nothing to send" };

  const routedBy = await routedByFor(env, card.assigned_from_card_id, routed.employeeName);
  const cardOwnTick = card.preview_first === 1 ? true : card.preview_first === 0 ? false : null;
  const cardAsked = (await previewAllPartnerEmailsIsOn(env)) ? true : cardOwnTick;
  const tickedByFirmUserId = card.preview_owner_id ?? PREVIEW_PARTNER.firmUserId;
  const what = `answered — ${card.title.slice(0, 60)}`;

  const out = await sendOrPreview(env, {
    to,
    email: {
      employee: routed.employeeName,
      what,
      tldr: routed.answer.slice(0, 300),
      sections: [
        { label: "What you asked", bullets: [askedText.replace(/\s+/g, " ").trim().slice(0, 300) || card.title] },
        { label: "Where things stand", bullets: [`"${card.title.slice(0, 80)}" is already done — this answers your question, nothing more was reopened.`] },
      ],
      details: routed.answer,
      routedBy,
    },
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    actorId: routed.employeeId ?? undefined,
    cardKind: card.kind ?? undefined,
    workCardId: card.id,
    cardAsked: cardAsked,
    tickedByFirmUserId,
    requestedByEmail: to,
    what,
    replyOnThread: thread.token,
  });
  return { sent: out.sent, reason: out.reason };
}

// ── The standing steer a recurring duty reads before it runs ──────────────────────────────────

/**
 * What the partners have said about this kind of work, oldest first, as instruction pieces.
 *
 * OLDEST FIRST because the interpretation prompt asks the model to let a LATER instruction win
 * where two conflict, and `gatherInstruction` relies on that ordering for the same reason.
 *
 * BOUNDED AT TEN. A duty that has run for a year should not send a year of asides to a model on
 * every run — the cost is real and the older ones have almost always been superseded. Ten is the
 * most recent conversation, which is what "what has he told me lately" means.
 */
export async function standingSteer(
  env: Env,
  cardKind: string,
  firmScope = "west-peek",
  limit = 10,
): Promise<InstructionPiece[]> {
  const rows = (
    await env.WP_OS_DB.prepare(
      `SELECT body, said_by, created_at FROM work_steer
        WHERE card_kind = ?1 AND firm_scope = ?2
        ORDER BY created_at DESC LIMIT ?3`,
    )
      .bind(cardKind, firmScope, limit)
      .all<{ body: string; said_by: string; created_at: string }>()
  ).results ?? [];
  return rows
    .reverse()
    .map((r) => ({
      source: "NOTE" as const,
      text: r.body,
      who: `${partnerByEmail(r.said_by)?.fullName ?? r.said_by} (replied ${r.created_at.slice(0, 10)})`,
    }));
}
