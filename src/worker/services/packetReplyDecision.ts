import type { Env } from "../env";
import { appendEvent } from "../events";
import { mailAuthority } from "../../shared/intake/partnerAuthority";
import { expiryFor, mintToken, readReply, tagFor } from "../../shared/events/packetDecisionToken";
import { decidePacket, RoomPacketError, type PacketRow } from "./roomPacket";
import type { Actor } from "./authorize";

/**
 * A PARTNER DECIDES A PACKET BY HITTING REPLY — and the decision lands exactly where the button
 * lands (17 Sep 2026).
 *
 * The scheme, the threat model and the parser are in `shared/events/packetDecisionToken.ts`. This
 * file is the half that needs a database and an identity: mint a token for a packet about to be
 * emailed, and spend one when a reply arrives.
 *
 * ─── THE ONE DECISION PATH ─────────────────────────────────────────────────────────────────────
 *
 * `applyReplyDecision` calls `decidePacket`. It does not write `evt_room_packet.status`, does not
 * append its own `room_packet.declined`, does not touch the work card. Everything the in-app
 * decline does — the status, the note, the event, the cancelled build card, the greyed row on the
 * shelf — happens because it is literally the same function. A second decision path would be a
 * second set of rules to keep in step with the first, and the first is the one with the authority
 * check in it.
 *
 * ─── UNSURE MEANS PORTER, NEVER A GUESS ────────────────────────────────────────────────────────
 *
 * Every refusal below returns a `capture` reason and changes nothing. The caller opens the routing
 * card that already handles mail nobody could place. A reply that declines the wrong month is far
 * worse than a person reading one email, so this code is written to lose ties rather than break
 * them: two codes, two answers, an unknown code, an expired code, a spent code, an unauthenticated
 * sender, a sender who is not a partner — all of them go to a human with the reason written down.
 */

export interface MintedToken {
  token: string;
  keepTag: string;
  noTag: string;
}

/**
 * The token that goes into the email about to be sent.
 *
 * IDEMPOTENT ON THE LIVE TOKEN. A packet re-emailed (a retried PDF stage, a second send) must
 * carry the SAME code the first email carried, or a partner holding the first email has a code
 * that no longer works and no way to know why. The unique index on `(packet_id) WHERE used_at IS
 * NULL` is what makes that a database guarantee rather than a convention here.
 */
export async function tokenForPacket(env: Env, packet: Pick<PacketRow, "id" | "proposed_for_month" | "firm_scope">): Promise<MintedToken> {
  const live = await env.WP_OS_DB.prepare(
    "SELECT token FROM evt_packet_decision_token WHERE packet_id = ?1 AND used_at IS NULL",
  ).bind(packet.id).first<{ token: string }>();
  const token = live?.token ?? mintToken();
  if (!live) {
    await env.WP_OS_DB.prepare(
      `INSERT OR IGNORE INTO evt_packet_decision_token (token, packet_id, proposed_for_month, expires_at, firm_scope)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(token, packet.id, packet.proposed_for_month, expiryFor(packet.proposed_for_month), packet.firm_scope).run();
  }
  return { token, keepTag: tagFor("KEEP", token), noTag: tagFor("NO", token) };
}

export interface ReplyOutcome {
  /** True only when a packet was actually decided. */
  decided: boolean;
  packetId: string | null;
  decision: "APPROVED" | "DECLINED" | null;
  /** Set when a person has to look at it. The caller opens Porter's routing card with this on it. */
  capture: string | null;
  /** Null when the message carried no decision tag at all — an ordinary email, routed as one. */
  attempted: boolean;
}

const NOTHING: ReplyOutcome = { decided: false, packetId: null, decision: null, capture: null, attempted: false };

/**
 * Read an arriving message as a decision, and apply it if — and only if — everything holds.
 *
 * TWO INDEPENDENT FACTS ARE REQUIRED and neither is sufficient: a live, unspent, unexpired token
 * minted for a real packet, AND a `From` that authenticated through the trusted resolver as one of
 * the two assigning partners. `mailAuthority` is the same check an emailed work assignment passes,
 * deliberately — this door commits the firm to a date and a budget, so it does not get a lower bar
 * than "please ask Wyatt to look at a company".
 */
export async function applyReplyDecision(
  env: Env,
  message: { fromHeader: string | null; authenticationResults: string | null; subject: string; body: string },
): Promise<ReplyOutcome> {
  const read = readReply(message.body);
  if (!read.decision && !read.unsure) return NOTHING;

  const firmScope = "west-peek";
  const authority = mailAuthority({ fromHeader: message.fromHeader, authenticationResults: message.authenticationResults });

  const refuse = async (why: string, token: string | null): Promise<ReplyOutcome> => {
    /*
     * REFUSALS ARE RECORDED, not only reported. Rule 0 applied to a security check: a scan that
     * writes nothing when it refuses is indistinguishable from one that never ran, and "has anyone
     * tried to decide a packet with a leaked code" is only answerable because a failed attempt
     * writes as much as a successful one. The token is recorded, the sender is recorded, and the
     * verdict is recorded — the same shape `mail_authority` already uses on every inbound event.
     */
    await appendEvent(env, {
      eventType: "room_packet.reply_decision_refused",
      actorType: "system",
      actorId: "inbound_email",
      objectType: "inbound_email",
      objectId: `${message.fromHeader ?? "unknown"}:${message.subject}`.slice(0, 200),
      firmScope,
      payload: {
        why,
        token,
        from: authority.partnerAddress ?? message.fromHeader,
        spf: authority.verdict.spf,
        dkim: authority.verdict.dkim,
        dmarc: authority.verdict.dmarc,
        partner_authenticated: authority.isAssignment,
      },
    });
    return { decided: false, packetId: null, decision: null, capture: why, attempted: true };
  };

  // The reply could not be read confidently. This is the path that must never guess.
  if (read.unsure) return await refuse(read.unsure, read.token);

  const row = await env.WP_OS_DB.prepare(
    "SELECT * FROM evt_packet_decision_token WHERE token = ?1",
  ).bind(read.token).first<{
    token: string; packet_id: string; proposed_for_month: string; expires_at: string;
    used_at: string | null; used_by: string | null; firm_scope: string;
  }>();

  /*
   * A WRONG CODE IS NOT AN ERROR MESSAGE. It says only "I could not place this", with no hint of
   * whether the code was close — there is nothing for a prober to read, and the honest reading of
   * a mistyped code is the same as the honest reading of a guessed one: a person should look.
   */
  if (!row) return await refuse("the reply carries a keep/no code I do not recognise, so I could not tell which packet it is about", read.token);
  if (row.used_at) return await refuse(`that code was already used on ${row.used_at.slice(0, 10)}, so this reply decided nothing`, read.token);
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return await refuse(`that code expired with ${row.proposed_for_month}; an old thread cannot decide a later month`, read.token);
  }

  // THE SECOND FACT. A live code from somebody the resolver did not authenticate as a partner is
  // exactly the leaked-token case, and it stops here with the reason on a card.
  if (!authority.isAssignment) {
    return await refuse(`a valid code arrived, but the message was not accepted as coming from a Managing Partner: ${authority.reason}`, read.token);
  }

  const partner = await env.WP_OS_DB.prepare("SELECT id FROM firm_user WHERE lower(email) = ?1")
    .bind(authority.partnerAddress!)
    .first<{ id: string }>();
  if (!partner) {
    return await refuse(`the code and the sender both checked out, but ${authority.partnerAddress} is not a person in the OS, so I could not record who decided it`, read.token);
  }

  /*
   * A HUMAN ACTOR, AND THAT IS THE POINT RATHER THAN A DETAIL.
   *
   * `decidePacket` refuses a non-HUMAN actor outright — "A Room is approved by a person, not by the
   * employee who proposed it." The reply path does not weaken that: what it produces is a HUMAN
   * actor for a partner the receiving resolver authenticated, which is the same person pressing the
   * same button through a different surface. It is constructed here rather than passed in because
   * the only address that carries authority is the one on the envelope this Worker accepted.
   */
  const actor: Actor = { type: "HUMAN", firmUserId: partner.id, roles: [], firmScopes: [row.firm_scope] };
  const note = read.reason
    ? `${read.reason} — decided by email from ${authority.partnerAddress}.`
    : `Decided by email from ${authority.partnerAddress}; no reason given.`;

  try {
    await decidePacket(env, actor, row.packet_id, read.decision!, note.slice(0, 1000));
  } catch (err) {
    const detail = err instanceof RoomPacketError ? err.message : err instanceof Error ? err.message : String(err);
    // A packet already decided, or in a state that refuses one, is a person's problem and not a
    // silent no-op. The token is NOT spent, so the partner can be told and can try again.
    return await refuse(`the code and the sender both checked out, but the decision could not be recorded: ${detail}`, read.token);
  }

  /*
   * SPENT ONLY AFTER THE DECISION LANDED. Spending it first would burn a partner's one code on a
   * decision that then failed, and she would have no way back in except the page.
   */
  await env.WP_OS_DB.prepare(
    `UPDATE evt_packet_decision_token
        SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), used_by = ?2, used_decision = ?3
      WHERE token = ?1 AND used_at IS NULL`,
  ).bind(row.token, authority.partnerAddress, read.decision).run();

  await appendEvent(env, {
    eventType: "room_packet.decided_by_email",
    actorType: "firm_user",
    actorId: partner.id,
    objectType: "room_packet",
    objectId: row.packet_id,
    firmScope: row.firm_scope,
    payload: { decision: read.decision, by: authority.partnerAddress, reason: read.reason, token: row.token },
  });

  return { decided: true, packetId: row.packet_id, decision: read.decision, capture: null, attempted: true };
}
