import type { Env } from "../env";
import { eventStatement } from "../events";

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
 * card that was put back, worked, and later dropped still carries the flag. A card is taken only
 * when ALL of these hold; any other card is SPARED (left whole, quietly, every run):
 *   · still CANCELLED + NO_ACTION_NEEDED, not merged into another card;
 *   · last touched (`updated_at`) more than 30 days ago — the window runs from when it was stowed;
 *   · no `work_card.state_changed` event, ever — a person moving it at any point is a dispute;
 *   · no stored message on it received inside the window;
 *   · none of its stored emails was re-read through the door (`inbound_email.reingested`) — a re-read
 *     is how a mis-stowed email is recovered, so it is a dispute too;
 *   · no stored email of its is named by any other card (a re-read's attachments, a deck queued for
 *     reading): a blob another card reads is never deleted;
 *   · no row in a `KEEPS_THE_CARD` table — anything beyond what the banter flow writes (a note, a
 *     hand-off, a preview awaiting approval, a file…) means someone engaged with it.
 *
 * EVERY FOREIGN KEY TO work_card IS DECIDED. `PURGED_WITH_CARD` ∪ `KEEPS_THE_CARD` is pinned against
 * the live schema by a test, so a migration that adds a new reference fails that test until someone
 * decides which list it belongs in — a hand list can never quietly go stale and turn the job red.
 *
 * ALL OR NOTHING, TRACE INCLUDED, BUCKET LAST. The card's rows AND its `work_card.no_action_purged`
 * event (carrying every R2 key) go in ONE D1 batch (a transaction): either the rows are gone and the
 * permanent record names every blob, or nothing changed. A batch that fails (a race with a new
 * reference) keeps the card whole, names it in `kept` with the tables pointing at it, and fails the
 * run so a person sees it. Blobs are deleted only after that commit; a bucket that refuses is a
 * named leftover in a permanent record, never an untraceable one.
 *
 * NO BUCKET, NO PURGE. Without the documents binding the blobs cannot be removed, so removing their
 * index would orphan them: the run purges nothing and says why.
 *
 * THE THREADS GO TOO. `email_thread` rows for the card (no foreign key) are removed in the batch, so a
 * partner replying to the old "got it" email later reaches the door as a new email instead of a
 * thread whose card no longer exists.
 *
 * EVENT_RECORD IS NEVER UPDATED OR DELETED (migration 0008's triggers refuse both); this job only
 * inserts its own event.
 */
export const NO_ACTION_PURGE_AFTER_DAYS = 30;

/** Tables (and their column) whose rows for the card the banter flow itself writes; removed with it. */
export const PURGED_WITH_CARD: ReadonlyArray<readonly [table: string, column: string]> = [
  ["partner_ask", "work_card_id"],
  ["partner_understood", "work_card_id"],
  ["request_attachment", "work_card_id"],
  ["inbound_message", "work_card_id"],
  ["work_card_notice", "work_card_id"],
  ["web_property_change", "work_card_id"],
];

/** Spend history: the ai_run row stays; only its pointer at the removed card is cleared. */
export const DETACHED_FROM_CARD: ReadonlyArray<readonly [table: string, column: string]> = [["ai_run_attribution", "work_card_id"]];

/** Any row here means the card is more than an untouched joke: it is spared, every run. */
export const KEEPS_THE_CARD: ReadonlyArray<readonly [table: string, column: string]> = [
  ["artifact", "work_card_id"],
  ["browser_task", "work_card_id"],
  ["capability_after_action", "work_card_id"],
  ["card_drive_file", "work_card_id"],
  ["drive_watch", "work_card_id"],
  ["employee_handoff", "work_card_id"],
  ["ic_followup", "work_card_id"],
  ["meeting_artifact", "work_card_id"],
  ["meeting_artifact_pre_0218", "work_card_id"],
  ["meeting_commitment", "work_card_id"],
  ["network_conflict", "work_card_id"],
  ["partner_session", "work_card_id"],
  ["pending_deck", "work_card_id"],
  ["preview_approval", "work_card_id"],
  ["standing_authority", "work_card_id"],
  ["web_property_dns", "work_card_id"],
  ["weekly_review_item", "work_card_id"],
  ["work_card", "merged_into_card_id"],
  ["work_card_file", "work_card_id"],
  ["work_card_hand_off", "work_card_id"],
  ["work_card_instruction", "work_card_id"],
  ["work_card_merge", "into_card_id"],
  ["work_card_merge", "from_card_id"],
  ["work_card_note", "work_card_id"],
  ["work_packet", "work_card_id"],
];

export interface NoActionPurgeResult {
  examined: number;
  purged: string[];
  /** Cards that qualified but whose batch failed or that could not be purged safely; the run FAILS. */
  kept: Array<{ cardId: string; detail: string }>;
  /** Cards left whole because another card reads one of their stored emails; never a failure. */
  spared: Array<{ cardId: string; detail: string }>;
  blobFailures: Array<{ cardId: string; r2Key: string; detail: string }>;
}

const short = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

const untouchedByOtherTables = KEEPS_THE_CARD.map(([t, c]) => `AND NOT EXISTS (SELECT 1 FROM ${t} k WHERE k.${c} = wc.id)`).join("\n              ");

/** Which tables still point at the card — named in `kept` so a person can act on a failed batch. */
async function pointingAt(db: D1Database, cardId: string): Promise<string[]> {
  const found: string[] = [];
  for (const [t, c] of [...PURGED_WITH_CARD, ...DETACHED_FROM_CARD, ...KEEPS_THE_CARD]) {
    try {
      if (await db.prepare(`SELECT 1 AS x FROM ${t} WHERE ${c} = ?1 LIMIT 1`).bind(cardId).first()) found.push(`${t}.${c}`);
    } catch {
      found.push(`${t}.${c} (unreadable)`);
    }
  }
  return found;
}

/** Another card that names one of these stored emails, or null. */
async function keyUsedElsewhere(db: D1Database, cardId: string, keys: string[]): Promise<string | null> {
  if (keys.length === 0) return null;
  const marks = keys.map((_, i) => `?${i + 2}`).join(", ");
  const hit = await db
    .prepare(
      `SELECT work_card_id AS other FROM inbound_message WHERE r2_key IN (${marks}) AND work_card_id IS NOT ?1
       UNION ALL SELECT work_card_id FROM request_attachment WHERE eml_key IN (${marks}) AND work_card_id IS NOT ?1
       UNION ALL SELECT work_card_id FROM pending_deck WHERE object_key IN (${marks}) AND work_card_id IS NOT ?1
       LIMIT 1`,
    )
    .bind(cardId, ...keys)
    .first<{ other: string | null }>();
  return hit ? (hit.other ?? "an unlinked stored message") : null;
}

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
              AND NOT EXISTS (SELECT 1 FROM inbound_message m JOIN event_record e ON e.object_type = 'inbound_email' AND e.object_id = m.r2_key AND e.event_type = 'inbound_email.reingested' WHERE m.work_card_id = wc.id)
              ${untouchedByOtherTables}
            ORDER BY wc.updated_at`,
        )
        .bind(cutoff)
        .all<{ id: string; firm_scope: string; created_at: string }>()
    ).results ?? [];

  const out: NoActionPurgeResult = { examined: rows.length, purged: [], kept: [], spared: [], blobFailures: [] };
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
    const other = await keyUsedElsewhere(db, row.id, keys);
    if (other) {
      out.spared.push({ cardId: row.id, detail: `a stored email of its is also read by ${other}` });
      continue;
    }
    const event = eventStatement(env, {
      eventType: "work_card.no_action_purged",
      actorType: "system",
      actorId: "no_action_purge",
      objectType: "work_card",
      objectId: row.id,
      firmScope: row.firm_scope,
      payload: { created_at: row.created_at, purged_at: now.toISOString(), after_days: NO_ACTION_PURGE_AFTER_DAYS, r2_keys: keys },
    });
    try {
      // One transaction: the rows, the thread pointers, the spend pointer, the card, and the trace.
      await db.batch([
        ...PURGED_WITH_CARD.map(([t, c]) => db.prepare(`DELETE FROM ${t} WHERE ${c} = ?1`).bind(row.id)),
        ...DETACHED_FROM_CARD.map(([t, c]) => db.prepare(`UPDATE ${t} SET ${c} = NULL WHERE ${c} = ?1`).bind(row.id)),
        db.prepare("DELETE FROM email_thread WHERE object_type = 'work_card' AND object_id = ?1").bind(row.id),
        db.prepare("DELETE FROM work_card WHERE id = ?1").bind(row.id),
        event.statement,
      ]);
    } catch (err) {
      const tables = await pointingAt(db, row.id);
      out.kept.push({ cardId: row.id, detail: `kept whole: ${short(err)}${tables.length ? ` (still pointed at by ${tables.join(", ")})` : ""}` });
      continue;
    }
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
