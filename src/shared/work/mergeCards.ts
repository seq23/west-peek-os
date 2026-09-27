/**
 * MERGE ONE WORK CARD INTO ANOTHER — the pure rules (owner, 27 Sep 2026; migration 0242).
 *
 * Two questions, answered here so the route, the service, the picker and the tests read one answer:
 *
 *   · `mergeRefusal` — may THIS card fold into THAT one? Same card, a finished target, a card that
 *     was already merged: each refused with the sentence the partner reads.
 *   · `orderMergeTargets` — which open cards the picker offers, in which order: the ones the same
 *     primary partner asked for first, then newest first; never the card itself.
 *
 * The service in `worker/services/mergeCards.ts` is the ONE writer; this file decides, it never writes.
 */

export const FINISHED_STATES: readonly string[] = ["DONE", "CANCELLED"];

export interface MergeableCard {
  id: string;
  state: string;
  merged_into_card_id?: string | null;
}

export type MergeRefusal = { ok: true } | { ok: false; status: number; reason: string };

export function mergeRefusal(from: MergeableCard | null, into: MergeableCard | null): MergeRefusal {
  if (!from) return { ok: false, status: 404, reason: "No such card to merge." };
  if (!into) return { ok: false, status: 404, reason: "No such card to merge into." };
  if (from.id === into.id) return { ok: false, status: 400, reason: "A card cannot be merged into itself." };
  if (from.merged_into_card_id) return { ok: false, status: 409, reason: `This card was already merged into ${from.merged_into_card_id}.` };
  if (into.merged_into_card_id) return { ok: false, status: 409, reason: `That card was itself merged into ${into.merged_into_card_id}; merge into that one.` };
  if (FINISHED_STATES.includes(into.state)) return { ok: false, status: 409, reason: `That card is ${into.state.toLowerCase()}; a merge needs a card still in flight.` };
  return { ok: true };
}

export interface MergeTargetCard {
  id: string;
  title: string;
  state: string;
  kind?: string | null;
  owner_id?: string | null;
  requested_by_email?: string | null;
  created_at: string;
}

/**
 * OPEN CARDS ONLY, SELF EXCLUDED, SAME PRIMARY PARTNER FIRST, THEN MOST RECENT FIRST. A stray that
 * Sequoia's reply opened is almost always meant for the card Sequoia already had; within that, the
 * newest is the one being worked on. The comparison is stable, so equal cards keep their input order.
 */
export function orderMergeTargets<T extends MergeTargetCard>(self: Pick<MergeTargetCard, "id" | "requested_by_email">, cards: readonly T[]): T[] {
  const mine = (self.requested_by_email ?? "").trim().toLowerCase();
  const samePartner = (c: MergeTargetCard) => (mine !== "" && (c.requested_by_email ?? "").trim().toLowerCase() === mine ? 1 : 0);
  return cards
    .filter((c) => c.id !== self.id && !FINISHED_STATES.includes(c.state))
    .map((c, i) => ({ c, i }))
    .sort((a, b) => samePartner(b.c) - samePartner(a.c) || b.c.created_at.localeCompare(a.c.created_at) || a.i - b.i)
    .map(({ c }) => c);
}
