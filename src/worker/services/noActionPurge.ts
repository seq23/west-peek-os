import type { Env } from "../env";
import { appendEvent } from "../events";

/**
 * THE STOWED-CARD PURGE (Addendum 10, 22 Sep 2026).
 *
 * A card the classifier caught as pure banter (`work_card.auto_resolution = 'NO_ACTION_NEEDED'`,
 * `state = 'CANCELLED'` — see `webPropertyChange.ts`'s `autoResolveNoAction`) stays in Record,
 * reopenable and auditable. Her decision, 22 Sep 2026: once nobody has disputed it for 30 days, a
 * confirmed joke carries near-zero lasting value, so this job removes the card, the rows its own
 * flow wrote, and any stored raw `.eml` in R2. Real work (a decision, a shipped change) is kept
 * forever.
 *
 * ONLY A CARD NOBODY TOUCHED (eng sweep, 22 Nov 2026). `auto_resolution` is never cleared, so a
 * card that was put back, worked, and later dropped still carries the flag; the old WHERE clause
 * would have purged it with every email on it. A card is taken only when ALL of these hold:
 *   · still CANCELLED + NO_ACTION_NEEDED, not merged into another card;
 *   · last touched (`updated_at`) more than 30 days ago — the window runs from when it was stowed,
 *     not from when the email arrived;
 *   · no `work_card.state_changed` event, ever — a person moving it at any point is a dispute;
 *   · no stored message on it received inside the window.
 *
 * ALL OR NOTHING, AND THE BUCKET LAST. The rows go in ONE D1 batch (a transaction). Every real
 * banter card carries a `work_card_notice` (its RECEIVED note), which the old code never deleted, so
 * the final `DELETE FROM work_card` failed its foreign key every run — AFTER the blobs, the message
 * index and the property row were already gone and a "purged" event was written. Now any other row
 * still referencing the card makes the batch fail whole: nothing is deleted, the card is kept and
 * named in `kept`, and the run reports FAILED so a person sees it. Blobs are deleted only after the
 * rows are gone; their keys are written into the purge event first, so a bucket that refuses is a
 * named leftover in a permanent record, never an untraceable one.
 *
 * NO BUCKET, NO PURGE. Without the documents binding the blobs cannot be removed, so removing their
 * index would orphan them: the run purges nothing and says why.
 *
 * EVENT_RECORD IS NEVER TOUCHED. It is append-only (migration 0008's triggers refuse UPDATE and
 * DELETE); the `work_card.no_action_purged` event is written only once the rows are really gone.
 */
export const NO_ACTION_PURGE_AFTER_DAYS = 30;

export interface NoActionPurgeResult {
  examined: number;
  purged: string[];
  /** Cards that qualified but were left whole, with the reason (a row elsewhere still points at them, no bucket). */
  kept: Array<{ cardId: string; detail: string }>;
  blobFailures: Array<{ cardId: string; r2Key: string; detail: string }>;
}

const short = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export async function purgeNoActionCards(env: Env, now: Date): Promise<NoActionPurgeResult> {
  const db = env.WP_OS_DB;
  const cutoff = new Date(now.getTime() - NO_ACTION_PURGE_AFTER_DAYS * 24 * 60 * 60_000).toISOString();
  const rows =
    (
      await db
        .prepare(
          `SELECT wc.id, wc.firm_scope, wc.created_at FROM work_card wc
            WHERE wc.state = 'CANCELLED' AND wc.auto_resolution = 'NO_ACTION_NEEDED'
              AND wc.merged_into_card_id IS NULL
              AND wc.updated_at < ?1
              AND NOT EXISTS (SELECT 1 FROM event_record e WHERE e.object_type = 'work_card' AND e.object_id = wc.id AND e.event_type = 'work_card.state_changed')
              AND NOT EXISTS (SELECT 1 FROM inbound_message m WHERE m.work_card_id = wc.id AND m.received_at >= ?1)
            ORDER BY wc.updated_at`,
        )
        .bind(cutoff)
        .all<{ id: string; firm_scope: string; created_at: string }>()
    ).results ?? [];

  const out: NoActionPurgeResult = { examined: rows.length, purged: [], kept: [], blobFailures: [] };
  const bucket = env.WP_OS_DOCUMENTS;
  if (!bucket) {
    for (const row of rows) out.kept.push({ cardId: row.id, detail: "no documents bucket bound, so its stored emails could not be removed; nothing deleted" });
    return out;
  }

  for (const row of rows) {
    const keys = [
      ...new Set(
        [
          ...((await db.prepare("SELECT r2_key AS k FROM inbound_message WHERE work_card_id = ?1").bind(row.id).all<{ k: string }>()).results ?? []),
          ...((await db.prepare("SELECT eml_key AS k FROM request_attachment WHERE work_card_id = ?1").bind(row.id).all<{ k: string }>()).results ?? []),
        ]
          .map((r) => r.k)
          .filter(Boolean),
      ),
    ];
    try {
      // The rows this flow itself writes; a row in any other table makes the whole batch fail, so nothing goes.
      await db.batch([
        db.prepare("DELETE FROM partner_ask WHERE work_card_id = ?1").bind(row.id),
        db.prepare("DELETE FROM partner_understood WHERE work_card_id = ?1").bind(row.id),
        db.prepare("DELETE FROM request_attachment WHERE work_card_id = ?1").bind(row.id),
        db.prepare("DELETE FROM inbound_message WHERE work_card_id = ?1").bind(row.id),
        db.prepare("DELETE FROM work_card_notice WHERE work_card_id = ?1").bind(row.id),
        db.prepare("DELETE FROM web_property_change WHERE work_card_id = ?1").bind(row.id),
        db.prepare("DELETE FROM work_card WHERE id = ?1").bind(row.id),
      ]);
    } catch (err) {
      out.kept.push({ cardId: row.id, detail: `kept whole: ${short(err)}` });
      continue;
    }
    await appendEvent(env, {
      eventType: "work_card.no_action_purged",
      actorType: "system",
      actorId: "no_action_purge",
      objectType: "work_card",
      objectId: row.id,
      firmScope: row.firm_scope,
      payload: { created_at: row.created_at, purged_at: now.toISOString(), after_days: NO_ACTION_PURGE_AFTER_DAYS, r2_keys: keys },
    });
    out.purged.push(row.id);
    for (const key of keys) {
      try {
        await bucket.delete(key);
      } catch (err) {
        out.blobFailures.push({ cardId: row.id, r2Key: key, detail: short(err) });
      }
    }
  }
  return out;
}
