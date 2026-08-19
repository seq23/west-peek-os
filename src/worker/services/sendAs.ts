import type { Env } from "../env";
import { json } from "../router";
import type { RouteContext } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity } from "./authorize";
import { authorize } from "./authorize";
import { hasGmailSend } from "./googleConnect";

/**
 * Sending as a partner rather than as the firm (P33).
 *
 * WHY THIS NEEDS NO INTEGRATION. westpeek.ventures is a verified sending domain, so any address on
 * it is a legitimate From. "Send as Scooter" is therefore a policy question, not a Google one — no
 * mailbox permission, no Gmail scope, no second consent screen. That is worth stating because the
 * phrase sounds like it should require reading somebody's mail, and it does not.
 *
 * OFF BY DEFAULT, and that default is the substance rather than caution. A message from
 * scooter@westpeek.ventures reads to an LP as Scooter writing to them personally. The system may
 * speak in a partner's voice only because that partner decided it may.
 *
 * SELF-SERVICE ONLY. A Managing Partner may flip their own switch and nobody else's — including the
 * other Managing Partner's. Enabling this for a colleague would be arranging to have mail sent in
 * their name without asking them, and no role should carry that.
 *
 * WHAT IT DOES NOT CHANGE. Every message still needs a human to approve that specific message, and
 * the approval still names the recipient and the text. This decides only whose name is on it.
 */

export interface SendAsRow {
  firm_user_id: string;
  enabled: number;
  from_address: string | null;
  changed_by: string;
  changed_at: string;
}

/** The domain the firm can actually send from, taken from the configured firm address. */
export function verifiedDomain(env: Env): string | null {
  const from = env.WP_OS_EMAIL_FROM;
  const at = from?.indexOf("@") ?? -1;
  return at > 0 ? from!.slice(at + 1).toLowerCase() : null;
}

/**
 * Can this address be sent as at all?
 *
 * A partner whose login is on some other domain cannot be a From here, and letting them switch it
 * on would produce mail that fails DMARC and lands in spam — a failure that looks like the message
 * was never sent rather than like a misconfiguration.
 */
export function canSendAs(env: Env, address: string | null): boolean {
  const domain = verifiedDomain(env);
  if (!domain || !address) return false;
  const at = address.indexOf("@");
  return at > 0 && address.slice(at + 1).toLowerCase() === domain;
}

export async function loadSendAs(env: Env, firmUserId: string): Promise<SendAsRow | null> {
  return await env.WP_OS_DB.prepare("SELECT * FROM partner_send_as WHERE firm_user_id = ?1")
    .bind(firmUserId)
    .first<SendAsRow>();
}

/**
 * The From address for a message this partner asked for.
 *
 * Falls back to the firm address whenever the switch is off, absent, or points somewhere the domain
 * cannot vouch for. Fail-closed: an unexpected state sends as the firm, which is always safe,
 * rather than as a person, which is not.
 */
export async function fromAddressFor(env: Env, firmUserId: string | null): Promise<string | null> {
  const firmAddress = env.WP_OS_EMAIL_FROM ?? null;
  if (!firmUserId) return firmAddress;
  const row = await loadSendAs(env, firmUserId);
  if (!row || row.enabled !== 1) return firmAddress;
  if (!canSendAs(env, row.from_address)) return firmAddress;
  return row.from_address;
}

export async function handleGetSendAs(ctx: RouteContext): Promise<Response> {
  const me = ctx.identity!;
  const row = await loadSendAs(ctx.env, me.id);
  const eligible = canSendAs(ctx.env, me.email);
  // Whether their mail can go through their OWN Gmail, which is what puts it in their Sent folder.
  const viaGmail = await hasGmailSend(ctx.env, me.id);
  return json({
    via_gmail: viaGmail,
    enabled: row?.enabled === 1,
    from_address: row?.from_address ?? me.email,
    changed_at: row?.changed_at ?? null,
    eligible,
    firm_address: ctx.env.WP_OS_EMAIL_FROM ?? null,
    detail: eligible
      ? row?.enabled === 1
        ? `Your approved messages go out as ${row?.from_address}. Replies come back to you.`
        : `Your approved messages go out as ${ctx.env.WP_OS_EMAIL_FROM ?? "the firm"}. Turn this on to send them under your own name instead.`
      : `Only addresses on the firm's verified domain can be used. ${me.email} is not one, so this stays off.`,
    // Said here because it is the question everyone asks second.
    note: viaGmail
      ? "Your messages go through your own Gmail, so they land in your Sent folder and thread with replies exactly as if you had written them there. Every message still needs you to approve it first."
      : "This changes whose name is on the message, nothing else. Every message still needs you to approve that exact message first, and replies go to your normal inbox. Sent mail will not appear in your Gmail Sent folder unless you connect Gmail sending below.",
  });
}

export async function handleSetSendAs(ctx: RouteContext): Promise<Response> {
  const me = ctx.identity!;
  const body = (await ctx.request.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") {
    return json({ error: "invalid_input", detail: "enabled must be true or false" }, { status: 400 });
  }

  const actor = actorFromIdentity(me);
  const authz = await authorize(ctx.env, actor, "mp_home_preference.set", {
    objectType: "partner_send_as",
    objectId: me.id,
  });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  // The guard that matters. Enabling for an address the domain cannot vouch for produces mail that
  // fails DMARC and disappears into spam, which reads as "the system did not send it".
  if (body.enabled && !canSendAs(ctx.env, me.email)) {
    return json(
      {
        error: "address_not_sendable",
        detail: `Only addresses on the firm's verified sending domain can be used, and ${me.email} is not one.`,
      },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO partner_send_as (firm_user_id, enabled, from_address, changed_by, changed_at, firm_scope)
     VALUES (?1, ?2, ?3, ?1, ?4, ?5)
     ON CONFLICT (firm_user_id) DO UPDATE SET
       enabled = excluded.enabled,
       from_address = excluded.from_address,
       changed_by = excluded.changed_by,
       changed_at = excluded.changed_at`,
  )
    .bind(me.id, body.enabled ? 1 : 0, me.email, now, actor.firmScopes[0] ?? "west-peek")
    .run();

  await appendEvent(ctx.env, {
    eventType: body.enabled ? "partner_send_as.enabled" : "partner_send_as.disabled",
    actorType: "firm_user",
    actorId: me.id,
    objectType: "partner_send_as",
    objectId: me.id,
    firmScope: actor.firmScopes[0] ?? "west-peek",
    payload: { from_address: me.email },
  });

  return json({
    enabled: body.enabled,
    from_address: me.email,
    changed_at: now,
    detail: body.enabled
      ? `Approved messages you request now go out as ${me.email}.`
      : `Approved messages you request go out as ${ctx.env.WP_OS_EMAIL_FROM ?? "the firm"} again.`,
  });
}
