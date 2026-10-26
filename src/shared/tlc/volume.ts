/**
 * MORE SPONSOR VOLUME FOR THE LEARNING CLUB (owner, 26 Oct 2026). Pure rules, read by services/tlcVolume.ts.
 *
 *   1 · PARKER'S LIST. About 35 brands per club, in two bands: about 5 Title or Presenting candidates ($15–25K)
 *       and about 30 Partner, Lead or Product candidates. Each carries a real public contact (an address printed on
 *       a live page) and is checked with NeverBounce before its first email. The list lives in `tlc_prospect`
 *       (migration 0277), written only to the production database — never to this public repo.
 *   2 · WYNN'S PACE. About 10 NEW brands per club per week, nearest club first, until that club's committed
 *       sponsor cash reaches its $25,000 goal; then that club's outreach stops by itself.
 *   3 · EVERY EARLIER RULE STAYS: one brand per category per club at a time, a featured partner's competitors
 *       never approached, one follow-up, never a follow-up to a bounce, one weekly approval email, the warm-up
 *       daily send cap (`warmupDailyCap`), no call asks, 25–40 guests.
 */

/** New brands Wynn starts on per club per ISO week (her number: "about 10"). Brands from his own search count too. */
export const TLC_NEW_BRANDS_PER_EVENT_WEEK = 10;

/** The size of Parker's list per club: about 5 Title/Presenting candidates and about 30 Partner/Lead/Product. */
export const TLC_PROSPECT_BANDS = { TITLE: 5, PARTNER: 30 } as const;
export type ProspectBand = keyof typeof TLC_PROSPECT_BANDS;

/** Wynn searches for more brands of his own only when a club's ready list holds fewer than a week's worth. */
export const TLC_BENCH_LOW = TLC_NEW_BRANDS_PER_EVENT_WEEK;

/**
 * NEVERBOUNCE'S ANSWER, and the one that lets a first email go. Only `valid` passes: an invalid, disposable,
 * catch-all or unknown address is never sent to (her rule: "an invalid/unknown address is never sent to"), and an
 * address that ever bounced is `bounced` for good, for every club.
 */
export const ADDRESS_RESULTS = ["valid", "invalid", "disposable", "catchall", "unknown", "bounced"] as const;
export type AddressResult = (typeof ADDRESS_RESULTS)[number];
export const addressSendable = (r: AddressResult | null | undefined): boolean => r === "valid";

/** Monday 00:00 UTC of the ISO week `now` falls in: the week Wynn's ten are counted in. */
export function weekStartUtc(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString();
}

/** Has this club's committed sponsor cash reached its goal? Then its outreach stops. */
export const goalReached = (committedUsd: number, goalUsd: number): boolean => committedUsd >= goalUsd;

/** How many more new brands Wynn may start on for one club this week. */
export function weeklyRoom(startedThisWeek: number, perWeek: number = TLC_NEW_BRANDS_PER_EVENT_WEEK): number {
  return Math.max(0, perWeek - startedThisWeek);
}

export interface ProspectPick {
  id: string;
  brand: string;
  band: ProspectBand;
  category: string | null;
  rank: number;
}

/**
 * THE ORDER WYNN WORKS A CLUB'S LIST IN: Title candidates first, then Parker's rank, then the name. Every earlier
 * rule (one brand per category per club at a time, a featured partner's competitors, NeverBounce) is applied by the
 * caller as it walks this order, so a brand that cannot go this week leaves its place to the next.
 */
export function orderProspects<T extends ProspectPick>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => (a.band === b.band ? 0 : a.band === "TITLE" ? -1 : 1) || a.rank - b.rank || a.brand.localeCompare(b.brand));
}

/** One club's line in the weekly email: money against the goal, then the counts. */
export function progressLine(input: { club: string; topic: string | null; committedUsd: number; goalUsd: number; pitched: number; replied: number; yes: number; ready: number; stopped: boolean }): string {
  const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  const name = `${input.club}${input.topic ? ` (${input.topic})` : ""}`;
  return [
    `${name}: ${usd(input.committedUsd)} agreed of ${usd(input.goalUsd)}.`,
    `${input.pitched} pitched, ${input.replied} replied, ${input.yes} said yes.`,
    input.stopped ? "Goal reached, so new pitches for this club have stopped." : `${input.ready} more brand${input.ready === 1 ? "" : "s"} ready to pitch.`,
  ].join(" ");
}
