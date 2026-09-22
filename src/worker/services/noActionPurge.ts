import type { Env } from "../env";
import { appendEvent } from "../events";

/**
 * THE STOWED-CARD PURGE (Addendum 10, 22 Sep 2026).
 *
 * A card the classifier caught as pure banter (`work_card.auto_resolution = 'NO_ACTION_NEEDED'`,
 * `state = 'CANCELLED'` — see `webPropertyChange.ts`'s `autoResolveNoAction`) is real work in the
 * sense that it stays in Record, is reopenable, and is fully auditable. It is NOT real work in the
 * sense that matters for retention: her decision, 22 Sep 2026, is that a confirmed joke carries
 * near-zero lasting value once nobody has disputed the classification, unlike a genuine decision or
 * a shipped change, which is kept forever. So this job purges the LIVE `work_card` row (and any
 * stored raw `.eml` in R2, indexed by `inbound_message`) once the card has sat unresolved for 30
 * days.
 *
 * WHY THE WHERE CLAUSE ALONE IS THE "WAS IT DISPUTED" CHECK. Reopening a card — the same put-back
 * door every DONE/CANCELLED card already offers — moves it out of `state = 'CANCELLED'`. A card
 * that is still `CANCELLED` with `auto_resolution = 'NO_ACTION_NEEDED'` 30 days later is, by
 * construction, one nobody touched. No separate "disputed" flag is needed; the state the reopen
 * door already writes is the flag.
 *
 * EVENT_RECORD IS NEVER TOUCHED. It is append-only (its own triggers refuse UPDATE and DELETE —
 * migration 0008) and this job writes its own `work_card.no_action_purged` event before removing
 * the row, so the permanent trace — that it happened, when, and why — survives the card itself.
 */
export const NO_ACTION_PURGE_AFTER_DAYS = 30;

export interface NoActionPurgeResult {
  examined: number;
  purged: string[];
  blobFailures: Array<{ cardId: string; r2Key: string; detail: string }>;
}

export async function purgeNoActionCards(env: Env, now: Date): Promise<NoActionPurgeResult> {
  const cutoff = new Date(now.getTime() - NO_ACTION_PURGE_AFTER_DAYS * 24 * 60 * 60_000).toISOString();
  const rows =
    (
      await env.WP_OS_DB.prepare(
        `SELECT id, firm_scope, created_at FROM work_card
          WHERE state = 'CANCELLED' AND auto_resolution = 'NO_ACTION_NEEDED' AND created_at < ?1`,
      )
        .bind(cutoff)
        .all<{ id: string; firm_scope: string; created_at: string }>()
    ).results ?? [];

  const purged: string[] = [];
  const blobFailures: NoActionPurgeResult["blobFailures"] = [];

  for (const row of rows) {
    const messages =
      (
        await env.WP_OS_DB.prepare("SELECT id, r2_key FROM inbound_message WHERE work_card_id = ?1")
          .bind(row.id)
          .all<{ id: string; r2_key: string }>()
      ).results ?? [];

    for (const m of messages) {
      if (env.WP_OS_DOCUMENTS) {
        try {
          await env.WP_OS_DOCUMENTS.delete(m.r2_key);
        } catch (err) {
          // Best-effort on the blob: the index row is still removed below and the card is still
          // purged, because a bucket that refused a delete must not keep a stale card alive forever.
          blobFailures.push({ cardId: row.id, r2Key: m.r2_key, detail: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) });
        }
      }
      await env.WP_OS_DB.prepare("DELETE FROM inbound_message WHERE id = ?1").bind(m.id).run();
    }

    // The 1:1 web_property_change row (its PRIMARY KEY is work_card_id) is the only other row this
    // flow itself creates; every other table this repo has is left alone — this purge is scoped to
    // what the banter-classification flow wrote, not a general work_card deletion tool.
    await env.WP_OS_DB.prepare("DELETE FROM web_property_change WHERE work_card_id = ?1").bind(row.id).run();

    await appendEvent(env, {
      eventType: "work_card.no_action_purged",
      actorType: "system",
      actorId: "no_action_purge",
      objectType: "work_card",
      objectId: row.id,
      firmScope: row.firm_scope,
      payload: { created_at: row.created_at, purged_at: now.toISOString(), after_days: NO_ACTION_PURGE_AFTER_DAYS },
    });

    await env.WP_OS_DB.prepare("DELETE FROM work_card WHERE id = ?1").bind(row.id).run();
    purged.push(row.id);
  }

  return { examined: rows.length, purged, blobFailures };
}
