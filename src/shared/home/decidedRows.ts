/**
 * KEEP A JUST-DECIDED ROW ON SCREEN THROUGH THE REFETCH THAT WOULD OTHERWISE DROP IT.
 *
 * Found 22 Sep 2026, re-verifying the Home fold fix let `e2e/home-overhaul.spec.ts` reach this
 * journey for the first time — it had always died earlier, on the fold assertion. `HomePage.tsx`'s
 * `decide()` deliberately does not reload after a success ("the row stays wearing its 'approved
 * 7:04 AM' badge... a reload here made the badge a flicker"), but Wave F's global
 * `invalidateAll()` refetches every `useApi` — including Home's own board — on ANY accepted
 * mutation, the decide POST included. The server's own list naturally drops a card the moment it
 * stops being pending, so the deliberately-avoided flicker came back through a different door.
 *
 * The fix is a union, not a flag: everything the server still says is pending, plus anything
 * decided this session whose own snapshot (captured by the caller at the moment she acted) is not
 * already back in the fresh list. Kept here, pure, so the merge itself — not just the component
 * around it — is what a test pins.
 */
export function mergeDecidedRows<T extends { id: string }>(
  fresh: readonly T[],
  decided: Readonly<Record<string, string>>,
  snapshot: Readonly<Record<string, T>>,
): T[] {
  const freshIds = new Set(fresh.map((c) => c.id));
  const stillShowingDecided = Object.keys(decided)
    .filter((id) => !freshIds.has(id) && snapshot[id])
    .map((id) => snapshot[id]!);
  return [...fresh, ...stillShowingDecided];
}
