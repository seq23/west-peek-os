import type { Env } from "../env";
import { appendEvent } from "../events";
import { firstReadDecision, type FirstReadDecision } from "./partnerUnderstood";
import { propertiesIn, type WebProperty } from "../../shared/intake/webPropertyChange";

/**
 * THE FIRST READ DECIDES (owner ruling, 19 Nov 2026). Claude's first read of a partner email (partnerUnderstood.ts,
 * its `DECISION:` line) is the authority for what moves a Porter job: land, rebuild, which site, a hand-off refusal,
 * plan approval. The keyword rules are the last-resort fallback, used only when no first read exists once the
 * ten-minute wait the OS already keeps for it (FIRST_READ_WAIT_MINUTES, `claimNextCard`) has passed. The keywords had
 * been overruling it, and the partner tail patched them one phrase at a time (#531, #542, #546).
 *
 * No new queue: the reply is filed by the door as before, and the runner reads the decision when it reaches the card.
 */
export type FirstRead =
  | { state: "READ"; decision: FirstReadDecision; messageId: string }
  /** No email to read (a button on the card), or its read settled without a decision, or the ten minutes passed. */
  | { state: "ABSENT"; messageId: string | null };

/** How far past the moment a reply answered the card its message may have been stored (the door links it after). */
const LINK_SLACK_MS = 2 * 60_000;

/**
 * The first read of the authenticated partner email behind a reply on this card (or the card it was handed on from):
 * the newest one received after `after` and no later than `until` (+ the door's slack). Never throws.
 *
 * THE WAIT IS THE SWEEP'S, ALREADY (`claimNextCard`, 15 Nov 2026): a card with a partner email from the last
 * FIRST_READ_WAIT_MINUTES whose first read has not settled is not started at all. So by the time a runner reads this,
 * the first read is in, settled without a decision (no reader was there), or ten minutes late: the keywords' turn.
 */
export async function firstReadOf(env: Env, cardId: string, opts: { after?: string | null; until?: string | null } = {}): Promise<FirstRead> {
  const until = opts.until ? new Date(Date.parse(opts.until) + LINK_SLACK_MS).toISOString() : null;
  let row: { id: string } | null = null;
  try {
    row = await env.WP_OS_DB.prepare(
      `SELECT m.id FROM inbound_message m
        WHERE m.work_card_id IN (?1, COALESCE((SELECT assigned_from_card_id FROM work_card WHERE id = ?1), ?1))
          AND json_extract(m.mail_authority_json, '$.partner') IS NOT NULL
          AND (?2 IS NULL OR m.received_at > ?2)
          AND (?3 IS NULL OR m.received_at <= ?3)
        ORDER BY m.received_at DESC LIMIT 1`,
    )
      .bind(cardId, opts.after ?? null, until)
      .first<{ id: string }>();
  } catch {
    row = null;
  }
  if (!row) return { state: "ABSENT", messageId: null };
  const decision = await firstReadDecision(env, row.id).catch(() => null);
  return decision ? { state: "READ", decision, messageId: row.id } : { state: "ABSENT", messageId: row.id };
}

/**
 * Both readings on the record, every time a decision is taken: what the first read said, what the keywords said,
 * and which one acted. Returns the line for the card's findings.
 */
export async function logDecision(
  env: Env,
  card: { id: string; firm_scope: string },
  input: { what: string; read: FirstRead; firstRead: string | null; keyword: string },
): Promise<string> {
  const used = input.read.state === "READ" ? "FIRST_READ" : "KEYWORD";
  const line =
    input.read.state === "READ"
      ? input.firstRead === input.keyword
        ? `First read decides ${input.what}: ${input.firstRead} (the keywords agree).`
        : `First read decides ${input.what}: ${input.firstRead}; the keywords read ${input.keyword} and were overruled.`
      : `first read absent: keyword fallback (${input.what}: ${input.keyword}).`;
  await appendEvent(env, {
    eventType: "partner_reply.first_read_decides",
    actorType: "system",
    actorId: "first_read",
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { what: input.what, used, first_read: input.firstRead, keyword: input.keyword, inbound_message_id: input.read.messageId },
  }).catch(() => undefined);
  if (used === "KEYWORD") console.log(`card ${card.id}: ${line}`);
  return line;
}

/** The registered property the first read named: its host, an alias or its repo exactly, else the one property its words name. */
export function propertyNamed(named: string | null | undefined, registry: readonly WebProperty[]): WebProperty | null {
  const said = String(named ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!said) return null;
  const exact = registry.find((p) => p.host.toLowerCase() === said || p.repo.toLowerCase() === said || (p.aliases ?? []).some((a) => a.toLowerCase() === said));
  if (exact) return exact;
  const found = propertiesIn(String(named), registry);
  return found.length === 1 ? found[0]! : null;
}
