import type { Env } from "../env";
import { appendEvent } from "../events";
import { createWorkCardInternal } from "./workCards";
import { sweepIdentity } from "./workSweep";
import { isoWeekOf } from "./jobs";

/**
 * PRESTON'S WEEKLY DUTY: FUND I FIRST-CLOSE READINESS (31 Oct 2026, migration 0287).
 *
 * WHY HIM AND WHY NOW. The owner's first priority for the fund is the first close, and the brain's
 * worst gap is that no agent can say how far away it is. Preston is Finance & Fund Admin and had no
 * card or run in six weeks: the deck rebuild is on request and nobody asked. The fund records he
 * owns (`fund.first_close_on`, `lp_record`, `lp_commitment`) are exactly what a first close is
 * measured from, so this is his job rather than a new seat's.
 *
 * THE SHAPE IS WALKER'S: the job opens the week's card and the employee sweep works it, so this tick
 * does one cheap thing. The facts are read HERE, deterministically, and written onto the card, so
 * Preston reasons from the firm's own numbers rather than from what a model imagines a fund looks
 * like. Tuesday, so the note is on Work before the Wednesday partner sync. The card is week-unique
 * by title: "Run it now" twice in a week opens nothing the second time.
 *
 * Counts and dates only. Nothing here names an LP, and nothing is sent to anyone outside the firm:
 * the finished card notifies both partners inside the OS, like every other employee card.
 */
export const FIRST_CLOSE_OWNER = "aie_preston";

export interface FirstCloseFacts {
  fundName: string | null;
  firstCloseOn: string | null;
  lpRecords: number;
  lpEngaged: number;
  commitmentsSoft: number;
  commitmentsSigned: number;
  deckCardState: string | null;
  deckCardUpdatedAt: string | null;
}

export async function readFirstCloseFacts(env: Env, firmScope: string): Promise<FirstCloseFacts> {
  const db = env.WP_OS_DB;
  const fund = await db
    .prepare("SELECT name, first_close_on FROM fund WHERE firm_scope = ?1 ORDER BY created_at LIMIT 1")
    .bind(firmScope)
    .first<{ name: string; first_close_on: string | null }>();
  const lp = await db
    .prepare(
      "SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('ENGAGED','COMMITTED','CLOSED') THEN 1 ELSE 0 END) AS engaged FROM lp_record WHERE firm_scope = ?1",
    )
    .bind(firmScope)
    .first<{ n: number; engaged: number | null }>();
  const commitments = await db
    .prepare(
      "SELECT SUM(CASE WHEN state = 'SOFT' THEN 1 ELSE 0 END) AS soft, SUM(CASE WHEN state = 'SIGNED' THEN 1 ELSE 0 END) AS signed FROM lp_commitment",
    )
    .first<{ soft: number | null; signed: number | null }>();
  const deck = await db
    .prepare("SELECT state, updated_at FROM work_card WHERE kind = 'DECK_REWORK' AND firm_scope = ?1 ORDER BY updated_at DESC LIMIT 1")
    .bind(firmScope)
    .first<{ state: string; updated_at: string }>();
  return {
    fundName: fund?.name ?? null,
    firstCloseOn: fund?.first_close_on ?? null,
    lpRecords: lp?.n ?? 0,
    lpEngaged: lp?.engaged ?? 0,
    commitmentsSoft: commitments?.soft ?? 0,
    commitmentsSigned: commitments?.signed ?? 0,
    deckCardState: deck?.state ?? null,
    deckCardUpdatedAt: deck?.updated_at ?? null,
  };
}

/** The facts as the card states them: one line each, every gap named as a gap. */
export function describeFacts(f: FirstCloseFacts): string {
  return [
    `Fund record: ${f.fundName ?? "NONE — there is no fund row"}.`,
    `First close date recorded: ${f.firstCloseOn ?? "NOT RECORDED"}.`,
    `LP records in the OS: ${f.lpRecords} (${f.lpEngaged} engaged or further).`,
    `Commitments: ${f.commitmentsSigned} signed, ${f.commitmentsSoft} soft.`,
    `LP deck rework: ${f.deckCardState ? `last card ${f.deckCardState}, ${f.deckCardUpdatedAt}` : "no rework card yet"}.`,
  ].join("\n");
}

export async function openFirstCloseCard(
  env: Env,
  now: Date,
  firmScope = "west-peek",
): Promise<{ opened: boolean; cardId: string; title: string; facts: FirstCloseFacts }> {
  const title = `Preston: Fund I first-close readiness ${isoWeekOf(now)}`;
  const facts = await readFirstCloseFacts(env, firmScope);
  const existing = await env.WP_OS_DB.prepare("SELECT id FROM work_card WHERE title = ?1 AND firm_scope = ?2 AND state != 'CANCELLED' LIMIT 1")
    .bind(title, firmScope)
    .first<{ id: string }>();
  if (existing) return { opened: false, cardId: existing.id, title, facts };
  const card = await createWorkCardInternal(env, sweepIdentity(firmScope), {
    title,
    description:
      "Weekly, before the Wednesday partner sync: how far Fund I is from its first close, from the fund records " +
      "below and nothing else.\n\n" +
      describeFacts(facts) +
      "\n\nWrite: (1) what a first close still needs, in order, each step with its owner (a partner, or the " +
      "employee whose job it is); (2) what changed since last week's card; (3) the one step that moves the " +
      "close most this week. Name every missing record as missing — never estimate a figure the records do " +
      "not hold. Send nothing to anyone outside the firm.",
    owner_type: "AI",
    owner_id: FIRST_CLOSE_OWNER,
    priority: "NORMAL",
    firm_scope: firmScope,
    next_action: "Read the fund records, write the readiness note, finish the card for both partners.",
  });
  await appendEvent(env, {
    eventType: "fund.first_close_card_opened",
    actorType: "system",
    actorId: "scheduled_job",
    objectType: "work_card",
    objectId: card.id,
    firmScope,
    payload: { title },
  });
  return { opened: true, cardId: card.id, title, facts };
}
