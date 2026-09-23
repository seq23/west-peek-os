import type { PartnerView } from "@shared/work/partnerOwnership";

/**
 * WHICH HAND-OFF DOOR THE CARD OFFERS THE PERSON LOOKING AT IT (0241, 23 Sep 2026).
 *
 * The primary partner may hand the card to the other partner; the secondary may take it back. The
 * server decides whether either is allowed (`changeOwnership`, services/handOff.ts) and refuses with
 * a detail the card shows; this only picks which button to draw, from the card's own two partners.
 * Pure, so the choice is pinned without a browser.
 */
export type HandOffControl =
  | { kind: "HAND_OFF"; to: string; label: string }
  | { kind: "TAKE_BACK"; label: string }
  | null;

export function handOffControl(
  card: { primary_partner?: PartnerView | null; secondary_partner?: PartnerView | null; state?: string },
  meId: string,
  partners: ReadonlyArray<{ id: string; full_name: string }>,
): HandOffControl {
  if (card.state === "DONE" || card.state === "CANCELLED") return null;
  const primary = card.primary_partner ?? null;
  const secondary = card.secondary_partner ?? null;
  if (!primary) return null;
  if (secondary && secondary.firm_user_id === meId) return { kind: "TAKE_BACK", label: "Take this back" };
  if (primary.firm_user_id !== meId) return null;
  const other = partners.find((p) => p.id !== meId);
  if (!other) return null;
  const first = other.full_name.split(/\s+/)[0]!;
  return { kind: "HAND_OFF", to: first, label: `Hand to ${first}` };
}
