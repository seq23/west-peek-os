import type { Env } from "../env";
import { appendEvent } from "../events";
import { readDeck } from "./deckReader";
import { DEAL_INTAKE_EMPLOYEE } from "../../shared/intake/emailTriggers";

/**
 * Reading the decks that arrived, and filling in what the company record did not know.
 *
 * Operator, 22 Aug 2026: "if we snd a deck the employee extracts all relevant info and fills in gaps
 * in the deal flow tab's company card. if its a new company they create a new one. if existing they
 * update it."
 *
 * WHY THIS RUNS ON A JOB AND NOT ON ARRIVAL. Reading a deck is a model call; the email handler has
 * 10ms of CPU. The bytes are stored when the mail lands, which is I/O and nearly free, and this
 * reads them with its own budget. Store now, read later — the same asymmetry that lets a 7MB message
 * be kept but not parsed.
 *
 * IT WRITES, AND IT MAY CORRECT WHAT IS ALREADY THERE. Operator, 22 Aug 2026, overruling an earlier
 * blanks-only rule of mine: "i think the updated deck should overwrite us....coming from the
 * company. overwriting us is fine. maybe each company card has a field for MP notes that cannot be
 * overwritten."
 *
 * She is right, and the original rule was split on the wrong axis. It asked "did a human type it",
 * when the question is WHOSE FACT IT IS. Sector, one-liner and website are things the COMPANY is the
 * authority on — our copy is a transcription of something they told us earlier, and a deck sent
 * later is a more recent statement from the same source. Keeping a stale transcription because a
 * human typed it is how a register slowly stops describing reality.
 *
 * WHAT IS NEVER TOUCHED is `mp_notes` — the firm's own judgement, guarded by a database trigger
 * rather than by this file remembering. That is the field a partner can write in knowing nothing
 * automatic will ever overwrite it.
 *
 * NOTHING IS LOST. The previous value travels on the event beside the new one, so "what did we think
 * their sector was in July" stays answerable. An overwrite that erased the prior reading would trade
 * one kind of staleness for a worse one.
 */

/**
 * How many decks one tick reads. ONE.
 *
 * NOT A GUESS — production evidence. Three `ai_run` rows there died with "abandoned: the invocation
 * ended before this call returned", including Scooter's daily brief on 21 Aug: the Worker was torn
 * down while a model call was still in flight. Stacking three of them into a single scheduled
 * invocation is precisely that failure mode, and the symptom would have been a deck marked FAILED
 * with a reason that reads like the PDF was bad.
 *
 * One per tick is four an hour. A night's arrivals are on the record before the morning brief, which
 * is the only deadline this has, and a slower queue that finishes beats a faster one that is
 * abandoned halfway.
 *
 * The AI budget is the second reason to cap it at all: `deck_reading` carries $0.50 and, unlike the
 * diagnostics sweep, is deliberately allowed to be stopped by a spend ceiling. An uncapped loop
 * could spend the day's allowance on one bad night's mail before the partners are awake.
 */
const PER_RUN = 1;

const FILLABLE = ["sector", "one_liner", "website"] as const;

export async function runDeckReading(env: Env): Promise<{ read: number; failed: number; skipped: number }> {
  if (!env.WP_OS_DOCUMENTS) return { read: 0, failed: 0, skipped: 0 };

  /*
   * ONLY DECKS THAT HAVE A COMPANY TO FILL. A deck can arrive before its company exists — the EMAIL
   * route raises a card rather than writing the pipeline — and those are stored, waiting, rather
   * than read: there is no record to correct yet. They are picked up on a later tick, once the
   * analyst has opened the company and something has set `company_id`.
   *
   * Left PENDING rather than marked FAILED, because nothing has failed. A deck waiting for its
   * company is the system working as designed, and marking it failed would put a red mark against
   * a founder who did nothing wrong.
   */
  const pending = await env.WP_OS_DB.prepare(
    `SELECT id, company_id, filename, object_key, work_card_id
       FROM pending_deck WHERE state = 'PENDING' AND company_id IS NOT NULL
        ORDER BY created_at ASC LIMIT ?1`,
  )
    .bind(PER_RUN)
    .all<{ id: string; company_id: string; filename: string; object_key: string; work_card_id: string | null }>();


  let read = 0;
  let failed = 0;

  for (const deck of pending.results ?? []) {
    const fail = async (detail: string) => {
      failed += 1;
      // The reason is stored, not swallowed. A deck that could not be read is a fact the partners
      // need — it is the difference between "the deck said nothing about revenue" and "nobody read
      // the deck", and those look identical on a company card unless one of them is written down.
      await env.WP_OS_DB.prepare(
        "UPDATE pending_deck SET state = 'FAILED', detail = ?2, read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
      )
        .bind(deck.id, detail.slice(0, 500))
        .run();
    };

    const object = await env.WP_OS_DOCUMENTS.get(deck.object_key);
    if (!object) {
      await fail("The stored file could not be found, so there was nothing to read.");
      continue;
    }

    /*
     * READ BACK AS TEXT. The object IS base64 — stored exactly as MIME delivered it — so there is no
     * decode and no re-encode, which is the whole point: both directions are real CPU work and a
     * Worker has 10ms. A five-megabyte deck round-tripped through bytes would have exhausted the
     * budget and failed as though the deck were unreadable.
     */
    const dataBase64 = (await object.text()).trim();
    if (!dataBase64) {
      await fail("The stored file was empty.");
      continue;
    }

    const reading = await readDeck(
      env,
      { type: "AI", aiEmployeeId: DEAL_INTAKE_EMPLOYEE, roles: [], firmScopes: ["west-peek"] },
      { dataBase64, label: deck.filename, mediaType: "application/pdf" },
    );
    if (!reading.ok) {
      await fail(reading.detail);
      continue;
    }

    const company = await env.WP_OS_DB.prepare(
      "SELECT id, canonical_name, sector, one_liner, website FROM canonical_company WHERE id = ?1",
    )
      .bind(deck.company_id)
      .first<Record<string, string | null>>();
    if (!company) {
      await fail("The company this deck belongs to is no longer on record.");
      continue;
    }

    const filled: string[] = [];
    const corrected: Array<{ field: string; from: string; to: string }> = [];
    for (const field of FILLABLE) {
      const found = reading.reading[field];
      if (!found) continue;
      const before = company[field];
      // Unchanged is neither a fill nor a correction, and reporting it as either would make the
      // event log say a deck did something when it agreed with what was already there.
      if (before === found) continue;
      await env.WP_OS_DB.prepare(`UPDATE canonical_company SET ${field} = ?2 WHERE id = ?1`)
        .bind(deck.company_id, found)
        .run();
      if (before) corrected.push({ field, from: before, to: found });
      else filled.push(field);
    }

    await env.WP_OS_DB.prepare(
      "UPDATE pending_deck SET state = 'READ', applied_json = ?2, read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
    )
      .bind(deck.id, JSON.stringify({ filled, corrected, claims: reading.reading.claims, missing: reading.reading.missing }))
      .run();

    /*
     * WHAT THE DECK CLAIMS IS NOT WHAT THE FIRM KNOWS. The filled fields are stamped with their
     * source in this event; the claims are recorded as claims and never promoted into the record.
     * That boundary is the whole reason the CanonicalCompany design exists and it is not relaxed
     * here — only the blanks were.
     */
    await appendEvent(env, {
      eventType: "company.deck_read",
      actorType: "ai_employee",
      actorId: DEAL_INTAKE_EMPLOYEE,
      objectType: "canonical_company",
      objectId: deck.company_id,
      payload: {
        filename: deck.filename,
        filled,
        // The old value travels with the new one. An overwrite nobody can undo is not a correction.
        corrected,
        source: "deck",
        verified: false,
        claims: reading.reading.claims.slice(0, 20),
        missing: reading.reading.missing.slice(0, 20),
      },
    });
    read += 1;
  }

  return { read, failed, skipped: 0 };
}
