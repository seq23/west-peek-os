import type { Env } from "../env";
import { appendEvent } from "../events";
import { partnerByEmail } from "../../shared/registry/partners";
import { answerBlock } from "./blocks";
import { moveShareFiles } from "./driveShares";
import { topicWords, withoutSignatures, type Candidate, type ClarificationRow, type RouteAs } from "./emailRouting";

/**
 * HIS ANSWER TO "WHAT WOULD YOU LIKE ME TO DO WITH IT?" (9 Oct 2026, 0256). Three replies were offered:
 * the number of the open job to add it to, "new", or "file". Anything else is his instruction for the
 * card, carried as the answer to its question — never a second question.
 */
export async function settleShare(env: Env, row: ClarificationRow, written: string, candidates: readonly Candidate[], by: string): Promise<{ routed: boolean; routeAs: RouteAs | null }> {
  const cardId = row.card_id!;
  const first = (withoutSignatures(written).split("\n").find((l) => l.trim()) ?? "").trim().toLowerCase();
  const partner = partnerByEmail(row.partner_email);
  const n = /^#?\s*(\d)\b/.exec(first);
  const mine = topicWords(first);
  const named = n ? candidates[Number(n[1]) - 1] : candidates.find((c) => [...topicWords(c.label)].some((w) => mine.has(w)) && !/\bnew\b/.test(first));
  const claimed = await env.WP_OS_DB.prepare(
    "UPDATE inbound_clarification SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolution = 'CARD', resolved_card_id = ?2, resolved_by = ?3 WHERE id = ?1 AND resolved_at IS NULL",
  )
    .bind(row.id, named?.cardId ?? cardId, by)
    .run();
  if ((claimed.meta?.changes ?? 0) === 0) return { routed: false, routeAs: null };
  let did: string;
  if (named) {
    await moveShareFiles(env, cardId, named.cardId);
    did = "attached";
  } else if (/^(?:just\s+)?(?:file|keep|store|save)\b|^nothing\b|^drop\b/.test(first)) {
    await env.WP_OS_DB.prepare(
      "UPDATE work_card SET state = 'DONE', next_action = NULL, block_nag_at = NULL, lease_until = NULL, description = substr(COALESCE(description, '') || char(10) || '• Filed, as he asked. Nothing to do with it now.', 1, 30000), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
    )
      .bind(cardId)
      .run();
    did = "filed";
  } else {
    const text = /^new\b|start something new/.test(first) ? `Start something new with the shared document. ${withoutSignatures(written)}` : withoutSignatures(written);
    await answerBlock(env, cardId, partner?.firmUserId ?? "inbound_email", { action: "ANSWER", text: text.slice(0, 4000) });
    did = "new";
  }
  await appendEvent(env, {
    eventType: "inbound_email.clarified",
    actorType: "system",
    actorId: by,
    objectType: "inbound_clarification",
    objectId: row.id,
    firmScope: "west-peek",
    payload: { message_id: row.message_id, kind: "SHARE", did, card_id: named?.cardId ?? cardId },
  });
  return { routed: true, routeAs: named ? { cardId: named.cardId } : "NEW" };
}
