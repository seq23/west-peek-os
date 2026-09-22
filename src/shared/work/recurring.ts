import { CARD_KINDS } from "./cardKinds";

/**
 * RECURRING VS ONE-OFF (Addendum 4/5.1, 22 Sep 2026) — the single axis Record's collapse and
 * Machinery's two buckets ("On a clock" / "One-off") both have to answer, kept here as one small
 * pure function so the two surfaces cannot drift into disagreeing about the same card.
 *
 * Her words: "identical runs collapsed" is right for "noisy recurring duties (the daily brief, the
 * sweep)" and wrong for "a one-off assignment", which "is never identical to anything else and
 * should never collapse". `cardKinds.ts` already carries the fact this needs — its `door` says
 * whether a scheduled job opens a card of this kind on its own cadence (`"JOB"`: Room/Workshop
 * packets, the monthly and weekly Productions jobs, deck rework) or a person does (`"EMAIL"` /
 * `"HAND"`). A plain `kind = NULL` card — the ordinary, always-hand-startable case — is always
 * one-off. This file adds no new list; it reads the one `cardKinds.ts` already has.
 *
 * KEPT DELIBERATELY SMALL. A sibling agent builds Machinery in parallel, in its own worktree, and
 * will want this exact answer for its own two buckets. A tiny, single-purpose file is near-zero
 * merge-conflict surface next to touching `cardKinds.ts` itself.
 */
export const RECURRING_CARD_KINDS: readonly string[] = CARD_KINDS.filter((k) => k.door === "JOB").map((k) => k.key);

/** True when a card of this kind is opened by a scheduled job on a cadence, never by a person. */
export function isRecurringKind(kind: string | null | undefined): boolean {
  return Boolean(kind) && RECURRING_CARD_KINDS.includes(kind as string);
}
