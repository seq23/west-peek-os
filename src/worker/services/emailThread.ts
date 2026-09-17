import type { Env } from "../env";
import { appendEvent } from "../events";
import { mintThreadToken, threadHeaders, threadTokensIn, type EmailThreadRow } from "../../shared/email/thread";
import { writtenAndQuoted } from "../../shared/intake/replyBody";
import { mailAuthority } from "../../shared/intake/partnerAuthority";
import { partnerByEmail } from "../../shared/registry/partners";
import type { InstructionPiece } from "../../shared/work/instruction";

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
  thread: EmailThreadRow | null;
  /** What the partner WROTE. Never the quoted original. Empty when they wrote nothing above it. */
  written: string;
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
  },
): Promise<SteerFromReply> {
  const tokens = threadTokensIn({ inReplyTo: message.inReplyTo, references: message.references });
  if (tokens.length === 0) return NOT_A_REPLY;

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

  const split = writtenAndQuoted(message.raw, {
    inReplyTo: message.inReplyTo,
    references: message.references,
    subject: message.subject,
  });
  const written = split.written.trim();
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
   * AND A NOTE ON THE CARD ITSELF WHEN IT IS STILL OPEN, because the card's thread is where a
   * person looks for what was said about a piece of work. `steerFor` reads unacknowledged notes, so
   * a reply that lands mid-run reaches the very next stage — which is the behaviour
   * `services/instruction.ts` already promises for a note typed in the UI.
   */
  if (thread.object_type === "work_card") {
    const partner = partnerByEmail(authority.partnerAddress);
    const open = await env.WP_OS_DB.prepare(
      "SELECT id FROM work_card WHERE id = ?1 AND state IN ('OPEN','IN_PROGRESS')",
    )
      .bind(thread.object_id)
      .first<{ id: string }>();
    if (open && partner) {
      await env.WP_OS_DB.prepare(
        "INSERT INTO work_card_note (id, work_card_id, author_id, body, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5)",
      )
        .bind(`wcn_${crypto.randomUUID()}`, thread.object_id, partner.firmUserId, written.slice(0, 4000), thread.firm_scope)
        .run();
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
    },
  });

  return { steered: true, thread, written, reason: "", attempted: true };
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
