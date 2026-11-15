/**
 * A DEVELOPER TAKEOVER (15 Nov 2026). A card a developer is doing by hand is HELD (0227's `held_at`, which the sweep
 * already leaves alone) with a reason that starts with this phrase, so every reader can tell it from an ordinary hold
 * and the card says what is happening on its face. See services/developerDirection.ts.
 */
export const TAKEN_OVER_PREFIX = "A developer is doing this by hand";

export function isTakenOver(heldReason: string | null | undefined): boolean {
  return String(heldReason ?? "").startsWith(TAKEN_OVER_PREFIX);
}
