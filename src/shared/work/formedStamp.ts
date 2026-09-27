/**
 * WHEN A CARD WAS FORMED, DATE AND TIME (owner, 27 Sep 2026).
 *
 * Four cards formed within an hour of each other on 27 Sep were indistinguishable: the expanded
 * card said "27 Sep" and the collapsed row said nothing. This is the one stamp both read — always
 * the date AND the time ("27 Sep 11:33"), never the time alone, because a card is looked at days
 * later as often as the day it was made. Pure, so two cards from the same day are pinned distinct.
 */
export function formedStamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day} ${time}`;
}
