/**
 * Has a partner looked at this deal yet?
 *
 * ONE RULE, STATED ONCE. The dealflow board badges a deal "by email · not yet looked at" when it
 * arrived through the email route, is still at NEW, and has never moved (`handleDealflowBoard`,
 * `unreviewed`). The Companies register shows the same fact as a chip on the card. Two pages, one
 * question — so the derivation lives here and both read it, rather than each page keeping its own
 * copy of "email:, NEW, never moved" that can drift a word apart. Derived, never stored: the moment
 * somebody transitions the deal the answer changes on its own, and a stored "reviewed" boolean would
 * be one more thing that can disagree with what actually happened.
 *
 * `tests/companyRegisterClock.test.ts` pins that the register's `looked_at` and the board's
 * `unreviewed` are inverses on the same deal, before and after it moves.
 */
export interface LookedAtInput {
  /** `investment_opportunity.source_channel`; the email route writes an `email:` prefix. */
  source_channel: string | null | undefined;
  /** `investment_opportunity.status`. */
  status: string | null | undefined;
  /** The last transition-or-backfill on the spine, null where the deal never moved. */
  last_moved_at: string | null | undefined;
}

/** True when the deal arrived by email and nobody has acted on it. */
export function isUnreviewed(d: LookedAtInput): boolean {
  return String(d.source_channel ?? "").startsWith("email:") && d.status === "NEW" && !d.last_moved_at;
}
