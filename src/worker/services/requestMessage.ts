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
    `SELECT id, message_id, r2_key, from_address, to_address, subject, received_at, bytes, work_card_id, firm_scope
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
