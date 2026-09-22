import { isOnRequest } from "./scheduledWork";
import { originBadgeText, originOf, type OriginCard } from "./origin";

/**
 * MACHINERY IS A LENS FILTERED BY RHYTHM, NOT A PLACE A CARD MOVES TO (Addendum 4 item 2 /
 * Addendum 5 & 5.1, 22 Sep 2026). Work, Machinery and Record all read the same underlying rows —
 * Machinery's own question is just "recurring, or one-off": a scheduled duty on a clock, or a
 * single-instance `work_card` that is moving without her pressing anything, unless it blocks.
 *
 * Kept here, pure and small, rather than inside the Machinery page component, for two reasons: it
 * is unit-tested without a browser, and it is the "is this card recurring?" helper the sequencing
 * brief anticipated a sibling surface might also want — small enough that a collision, if any, is
 * trivial to resolve.
 */

export interface ScheduledJobLike {
  name: string;
  schedule_kind: string;
  daily_at_utc: string | null;
  interval_minutes: number | null;
}

/**
 * "14:00" → 840. Null for a job with no literal clock time — an INTERVAL job cycles rather than
 * lands at a moment, and an ON_REQUEST job has no clock at all.
 */
export function timeOfDayMinutes(job: Pick<ScheduledJobLike, "daily_at_utc">): number | null {
  if (!job.daily_at_utc) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(job.daily_at_utc);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * "ON A CLOCK", ordered the one way "order of the day" can mean anything for a job: literal time
 * of day, earliest to latest. A job with no literal time — INTERVAL (it cycles), ON_REQUEST (it has
 * none) — sorts after every timed job, since neither has a clock position to read; INTERVAL before
 * ON_REQUEST, because an interval job still runs itself on a cadence and an on-request job never
 * does. Ties break on name, so the order is stable rather than fetch-order noise.
 */
export function sortOnAClock<T extends ScheduledJobLike>(jobs: readonly T[]): T[] {
  const rank = (j: T): [number, number, string] => {
    const t = timeOfDayMinutes(j);
    if (t !== null) return [0, t, j.name];
    if (!isOnRequest(j)) return [1, j.interval_minutes ?? Number.MAX_SAFE_INTEGER, j.name];
    return [2, 0, j.name];
  };
  return [...jobs].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2]);
  });
}

export interface OneOffCardLike extends OriginCard {
  id: string;
  state?: string | null;
  held_at?: string | null;
}

/**
 * "ONE-OFF" (Addendum 5.1, correcting Addendum 4 item 2's three-bucket read): every single-
 * instance card that moves without her pressing anything, unless it blocks —
 *   (a) an authenticated partner email, which started itself the moment it arrived
 *       (`dealIntake.ts`'s `openAssignmentCard`, "only the address is authority"), or
 *   (b) a card she created and is holding for later, sitting on her one flip.
 * A card she created and started by hand through the ordinary Work flow is neither: she pressed
 * something to make it move, so it is not machinery — it is her, working. That is what keeps this
 * list from becoming "every card", which is Record's job, not this one's.
 */
export function isOneOffMachineryCard(card: OneOffCardLike, viewerFirmUserId?: string | null): boolean {
  if (card.state === "HELD" || Boolean(card.held_at)) return true;
  return originOf(card, viewerFirmUserId).kind === "EMAIL";
}

/** Earliest arrival first — when the email landed, or when she created and held the card. */
export function sortOneOff<T extends OneOffCardLike & { created_at?: string | null }>(cards: readonly T[]): T[] {
  return [...cards].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
}

/**
 * THE ROW'S TAG. Held beats origin: a row sitting on her flip is waiting BECAUSE she is holding it,
 * and "held by you" says that; re-deriving "from you" from `created_by` would be true and would
 * miss the point of the row. Off the hold, the ordinary origin badge applies unchanged — reusing
 * Wave C's `originOf`/`originBadgeText` rather than a second way to answer "where did this come
 * from".
 */
export function oneOffTag(
  card: OneOffCardLike & { held_by?: string | null; held_by_name?: string | null; created_by_ai_name?: string | null },
  viewerFirmUserId?: string | null,
): string {
  if (card.state === "HELD" || Boolean(card.held_at)) {
    if (viewerFirmUserId && card.held_by === viewerFirmUserId) return "held by you";
    const who = (card.held_by_name ?? "").trim();
    return `held by ${who || "a partner"}`;
  }
  return originBadgeText(originOf(card, viewerFirmUserId), card.created_by_ai_name);
}
