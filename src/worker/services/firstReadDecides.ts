import type { Env } from "../env";
import { appendEvent } from "../events";
import { FIRST_READ_WAIT_MINUTES, firstReadDecision, type FirstReadDecision } from "./partnerUnderstood";
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
  /** His email is younger than the wait and its first read has not settled: nothing acts yet. */
  | { state: "WAIT"; until: string; messageId: string }
  /** No email to read (a button on the card), or the read settled without a decision, or the wait is over. */
  | { state: "ABSENT"; messageId: string | null };

/** How far past the moment a reply answered the card its message may have been stored (the door links it after). */
const LINK_SLACK_MS = 2 * 60_000;

/**
 * The first read of the authenticated partner email behind a reply on this card (or the card it was handed on from):
 * the newest one received after `after` and no later than `until` (+ the door's slack). Never throws.
 */
export async function firstReadOf(env: Env, cardId: string, opts: { after?: string | null; until?: string | null; now?: Date } = {}): Promise<FirstRead> {
  const now = opts.now ?? new Date();
  const until = opts.until ? new Date(Date.parse(opts.until) + LINK_SLACK_MS).toISOString() : null;
  let row: { id: string; received_at: string; u_state: string | null } | null = null;
  try {
    row = await env.WP_OS_DB.prepare(
      `SELECT m.id, m.received_at, u.state AS u_state
         FROM inbound_message m LEFT JOIN partner_understood u ON u.inbound_message_id = m.id
        WHERE m.work_card_id IN (?1, COALESCE((SELECT assigned_from_card_id FROM work_card WHERE id = ?1), ?1))
          AND json_extract(m.mail_authority_json, '$.partner') IS NOT NULL
          AND (?2 IS NULL OR m.received_at > ?2)
          AND (?3 IS NULL OR m.received_at <= ?3)
        ORDER BY m.received_at DESC LIMIT 1`,
    )
      .bind(cardId, opts.after ?? null, until)
      .first<{ id: string; received_at: string; u_state: string | null }>();
  } catch {
    row = null;
  }
  if (!row) return { state: "ABSENT", messageId: null };
  const decision = await firstReadDecision(env, row.id).catch(() => null);
  if (decision) return { state: "READ", decision, messageId: row.id };
  const waitEnds = Date.parse(row.received_at) + FIRST_READ_WAIT_MINUTES * 60_000;
  const unsettled = row.u_state === null || row.u_state === "CLAIMED";
  if (unsettled && now.getTime() < waitEnds) return { state: "WAIT", until: new Date(waitEnds).toISOString(), messageId: row.id };
  return { state: "ABSENT", messageId: row.id };
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
