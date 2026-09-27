import type { Env } from "../env";
import { json, type RouteContext } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize } from "./authorize";
import { getVisibleWorkCard } from "./workCards";
import { readableMessage } from "./dealIntake";

/**
 * THE EMAIL A WORK CARD CAME FROM, READ BACK (0226, 22 Sep 2026).
 *
 * Owner: "the original emails received for the work card or replied should be kept … we need to
 * overhaul this." Keeping them was the first half — `handleInboundEmailOnce` now stores every
 * message that passes the dedupe and indexes it in `inbound_message`. This is the half that makes
 * the copy worth keeping: a card can be asked what arrived, and answer.
 *
 * ── BODY ON THE CARD, RAW BEHIND A LID (her choice) ───────────────────────────────────────────
 *
 * Two routes, deliberately, because they answer two different questions for two different readers:
 *
 *   `GET /api/work-cards/:id/request-message`      what the person WROTE — decoded, quote-stripped,
 *                                                  the same text the card's description carries,
 *                                                  served as data so a panel can show it whole.
 *   `GET /api/work-cards/:id/raw`                   the message EXACTLY as it arrived, headers,
 *                                                  routing, signatures and all.
 *
 * WHY THE RAW ONE IS NARROWER. The decoded body is the request; the raw message is the envelope
 * around it — `Received:` chains naming intermediate hosts, DKIM signatures, and, on a forward, the
 * whole quoted original including anything the forwarder did not think about. That is a Managing
 * Partner's to read, so it goes through `authorize()` against `inbound_message.read_raw`, which
 * migration 0226 registers as RESTRICTED to MANAGING_PARTNER. Restricted rather than reserved: the
 * role decides immediately, without raising an approval card for every read.
 *
 * ── THE CARD'S OWN VISIBILITY DECIDES, AND IT IS NOT RE-IMPLEMENTED HERE ──────────────────────
 *
 * Both routes go through `getVisibleWorkCard`, which is the one function that answers "may this
 * identity see this card" with BOTH the firm-scope clause and the privacy-label clause. The notes
 * routes on the same resource read `SELECT id FROM work_card WHERE id = ?1` and check neither —
 * a known missing guard, and precisely the shape not to copy: a new route that re-typed it would
 * serve a RESTRICTED card's email to anyone who could guess its id.
 *
 * A card in another firm scope, or one whose privacy label this reader cannot access, is 404 and
 * not 403. 403 would confirm the card exists, which is the fact being withheld.
 */

interface StoredMessageRow {
  id: string;
  message_id: string;
  r2_key: string;
  from_address: string;
  to_address: string | null;
  subject: string | null;
  received_at: string;
  bytes: number;
  work_card_id: string | null;
  firm_scope: string;
  /** The SPF/DKIM/DMARC verdict as it stood on arrival — see `inboundEmail.ts`'s write. */
  mail_authority_json: string | null;
}

interface MailAuthoritySummary {
  spf: string;
  dkim: string;
  dmarc: string;
  passed: boolean;
  signing_domain: string | null;
}

/** Read back exactly what `inboundEmail.ts` wrote. A malformed or absent record is honestly null. */
function parseMailAuthority(json: string | null): MailAuthoritySummary | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    return {
      spf: String(v.spf ?? "none"),
      dkim: String(v.dkim ?? "none"),
      dmarc: String(v.dmarc ?? "none"),
      passed: Boolean(v.passed),
      signing_domain: typeof v.signing_domain === "string" ? v.signing_domain : null,
    };
  } catch {
    return null;
  }
}

/**
 * The message indexed against this card, when the reader may see the card at all.
 *
 * NEWEST FIRST. A card can be steered more than once — a partner replies twice to the same note —
 * and "the message this card came from" means the most recent one indexed against it.
 */
async function messageForVisibleCard(
  ctx: RouteContext,
): Promise<{ row: StoredMessageRow } | { error: Response }> {
  const identity = ctx.identity;
  if (!identity) return { error: json({ error: "unauthenticated" }, { status: 401 }) };
  const cardId = ctx.params.id ?? "";
  const card = await getVisibleWorkCard(ctx.env, identity, cardId);
  // 404 RATHER THAN 403, on purpose: outside this reader's scope, the card's existence is itself
  // the thing being withheld.
  if (!card) return { error: json({ error: "not_found" }, { status: 404 }) };
  const row = await ctx.env.WP_OS_DB.prepare(
    `SELECT id, message_id, r2_key, from_address, to_address, subject, received_at, bytes, work_card_id, firm_scope, mail_authority_json
       FROM inbound_message WHERE work_card_id = ?1 ORDER BY received_at DESC LIMIT 1`,
  )
    .bind(cardId)
    .first<StoredMessageRow>();
  if (!row) {
    return {
      error: json(
        {
          error: "not_found",
          detail: "no inbound message is indexed against this card — it was not raised from an email, or it predates 0226.",
        },
        { status: 404 },
      ),
    };
  }
  return { row };
}

/**
 * GET /api/work-cards/:id/request-message
 *
 * `{ message_id, from, subject, received_at, text, has_raw, r2_key }`. `text` is decoded and
 * quote-stripped through the SAME function the doors write the card's description with
 * (`readableMessage`), so the panel and the card can never disagree about what was said.
 *
 * `has_raw` is false when the object is gone from the store — the row is the index, and an index
 * that lies about what it can serve is worse than one that admits a gap.
 */
export async function handleGetRequestMessage(ctx: RouteContext): Promise<Response> {
  const found = await messageForVisibleCard(ctx);
  if ("error" in found) return found.error;
  const row = found.row;

  const bucket = ctx.env.WP_OS_DOCUMENTS;
  let text = "";
  let hasRaw = false;
  if (bucket) {
    const obj = await bucket.get(row.r2_key);
    if (obj) {
      hasRaw = true;
      // The cap is the readable one every door uses, not a byte budget: the whole message is behind
      // the raw route for anyone who may read it.
      text = readableMessage(await obj.text());
    }
  }

  return json({
    message_id: row.message_id,
    from: row.from_address,
    subject: row.subject,
    received_at: row.received_at,
    text,
    has_raw: hasRaw,
    r2_key: row.r2_key,
    // Wave A: "who asked and how" needs the DKIM verdict beside the sender, not just the address —
    // the same fact `partnerAuthority.ts` already computes on arrival, read back rather than
    // re-derived (re-checking headers months later would re-trust them, not the resolver).
    mail_authority: parseMailAuthority(row.mail_authority_json),
  });
}

/**
 * GET /api/work-cards/:id/raw — the `.eml` exactly as it arrived.
 *
 * `text/plain` rather than `message/rfc822`, so it opens in a browser tab instead of downloading as
 * a file the reader then has to find. `private, no-store`: a partner's mail is not something an
 * intermediary caches.
 *
 * EVERY READ IS ON THE SPINE. Who read a partner's raw message, and which one, is exactly the kind
 * of question that is only answerable if the answer was written down at the time.
 */
export async function handleGetRequestMessageRaw(ctx: RouteContext): Promise<Response> {
  const found = await messageForVisibleCard(ctx);
  if ("error" in found) return found.error;
  const row = found.row;

  const identity = ctx.identity!;
  const decision = await authorize(ctx.env, actorFromIdentity(identity), "inbound_message.read_raw", {
    objectType: "inbound_message",
    objectId: row.id,
    firmScope: row.firm_scope,
  });
  if (decision.decision !== "ALLOW") {
    return json(
      {
        error: "forbidden",
        detail: "the raw message — headers, routing and signatures — is a Managing Partner's to read. The decoded body is on the card.",
        reason: decision.reason,
      },
      { status: 403 },
    );
  }

  const bucket = ctx.env.WP_OS_DOCUMENTS;
  if (!bucket) return json({ error: "no_store", detail: "the document store is not bound" }, { status: 503 });
  const obj = await bucket.get(row.r2_key);
  if (!obj) return json({ error: "not_found", detail: `the stored message ${row.r2_key} is gone` }, { status: 404 });

  await appendEvent(ctx.env, {
    eventType: "inbound_message.read_raw",
    actorType: "firm_user",
    actorId: identity.id,
    objectType: "inbound_message",
    objectId: row.id,
    firmScope: row.firm_scope,
    payload: { work_card_id: row.work_card_id, r2_key: row.r2_key, message_id: row.message_id },
  });

  return new Response(await obj.text(), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}

// ── THE MESSAGE TRAIL (Wave A, Addendum 2, 22 Sep 2026) ─────────────────────────────────────────

export interface MessageTrailEntry {
  at: string;
  /** RECEIVED_EMAIL for an inbound message; a notice kind (RECEIVED, PLAN, PREVIEW, QUESTION, STUCK,
   *  DONE — see `NOTICE_KINDS` in requestReply.ts); a hand-off (HAND_OFF, TAKE_BACK, CLAIM) or the
   *  one email it sent (HAND_OFF_EMAIL). */
  kind: string;
  who: string;
  what: string;
  /** HAND_OFF / TAKE_BACK / CLAIM only: the door it came through (REPLY, NOTE, API, NOTIFICATION). */
  via?: string;
  /** HAND_OFF_EMAIL only: the address copied on the one email, or null when nobody was. */
  cc?: string | null;
  /** True when this entry is an inbound message and can be opened whole on the card. */
  hasMessage: boolean;
}

/**
 * ONE CHRONOLOGICAL LIST, not the old terse "TOLD THE PARTNER: RECEIVED · PLAN · PREVIEW" one-liner.
 *
 * Her words: "I want to see the flow of information and what was said by whom, on the card." Three
 * tables hold it — `inbound_message` (0226, what arrived), `work_card_notice` (0221, what was sent
 * back) and `work_card_hand_off` (0241, who holds the card and the one email that told them) — and
 * until now nothing read them together. Merged here, ordered, each entry showing who said what and when.
 */
export async function handleGetWorkCardMessageTrail(ctx: RouteContext): Promise<Response> {
  const identity = ctx.identity;
  if (!identity) return json({ error: "unauthenticated" }, { status: 401 });
  const cardId = ctx.params.id ?? "";
  const card = await getVisibleWorkCard(ctx.env, identity, cardId);
  if (!card) return json({ error: "not_found" }, { status: 404 });

  const inbound = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT from_address, subject, received_at FROM inbound_message WHERE work_card_id = ?1 ORDER BY received_at ASC`,
    )
      .bind(cardId)
      .all<{ from_address: string; subject: string | null; received_at: string }>()
  ).results ?? [];

  const notices = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT kind, cause, sent_to, sent, detail, sent_at FROM work_card_notice WHERE work_card_id = ?1 ORDER BY sent_at ASC`,
    )
      .bind(cardId)
      .all<{ kind: string; cause: string; sent_to: string; sent: number; detail: string | null; sent_at: string }>()
  ).results ?? [];

  /*
   * THE HAND-OFFS (0241; owner, 27 Sep 2026): "I don't see the card displaying the handoff and the
   * new email it sent to Scooter." Both were recorded — `work_card_hand_off` and the event — but this
   * list read only the two tables above, so a card that changed hands showed her reply and then
   * nothing. Each row becomes two entries: who handed it to whom, and the one email the new primary got.
   */
  const handOffs = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT action, by_email, primary_email, secondary_email, via, sent, created_at FROM work_card_hand_off WHERE work_card_id = ?1 ORDER BY created_at ASC`,
    )
      .bind(cardId)
      .all<{ action: string; by_email: string; primary_email: string; secondary_email: string; via: string; sent: number; created_at: string }>()
  ).results ?? [];

  const trail: MessageTrailEntry[] = [
    ...handOffs.flatMap((h): MessageTrailEntry[] => [
      { at: h.created_at, kind: h.action, who: h.by_email, what: h.primary_email, via: h.via, hasMessage: false },
      {
        at: h.created_at,
        kind: "HAND_OFF_EMAIL",
        who: h.sent ? `told ${h.primary_email}` : `tried to tell ${h.primary_email}`,
        what: "where it stands",
        // A hand-off and a claim copy the partner who held it; a take-back sends exactly one email.
        cc: h.action === "TAKE_BACK" ? null : h.secondary_email,
        hasMessage: false,
      },
    ]),
    ...inbound.map((m) => ({
      at: m.received_at,
      kind: "RECEIVED_EMAIL",
      who: m.from_address,
      what: m.subject ? `emailed: ${m.subject}` : "emailed this in",
      hasMessage: true,
    })),
    ...notices.map((n) => ({
      at: n.sent_at,
      kind: n.kind,
      who: n.sent ? `told ${n.sent_to}` : `tried to tell ${n.sent_to}`,
      what: n.cause || (n.kind === "RECEIVED" ? "Acknowledged the ask, no changes made yet." : n.kind === "DONE" ? "Finished." : n.kind),
      hasMessage: false,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return json({ trail });
}
