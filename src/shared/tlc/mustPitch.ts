/**
 * BRANDS WE MUST PITCH (owner, 23 Oct 2026: "are we reaching out to anthropic i think that is important
 * and google?"). The words both sides use, so the TLC panel, Approvals and Wynn's card say the same thing.
 */

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2027-01" → "Jan". */
export function shortMonth(yyyyMm: string): string {
  return SHORT[Number(yyyyMm.slice(5, 7)) - 1] ?? yyyyMm;
}

/** One brand name, one key: case and spacing never make two items for the same brand. */
export function brandKey(brand: string): string {
  return brand.trim().toLowerCase().replace(/\s+/g, " ");
}

/** An address shape check only. Whether it is REAL is the page check's job, or the owner's word. */
export const CONTACT_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/;

/**
 * The "Needs a way in" sentence, word for word:
 * "Anthropic (Jan, Mar): no public partnerships address found. Pages checked: … If you have a contact
 * or an intro, add it here."
 */
/**
 * AFTER THREE WEEKS OF THE SAME ANSWER IT IS SAID ONCE AND THEN NOT AGAIN (owner, 13 Nov 2026). The same four to seven
 * brands were listed as "Needs a way in" four weeks running, each week worded as if new. An item nothing has changed
 * on is listed as usual for WAY_IN_WEEKS weekly notes; the next note says once that it will stop, with what was
 * tried; after that it is left out until something changes (a month, an address, a contact she adds). It stays on the
 * TLC page throughout. Pure: `unchangedDays` is whole days since the item last changed.
 */
export const WAY_IN_WEEKS = 3;
export function wayInListing(item: { brand: string; months: readonly string[]; pages: readonly string[] }, unchangedDays: number): string | null {
  const weeks = Math.floor(unchangedDays / 7);
  if (weeks < WAY_IN_WEEKS) return wayInWords(item);
  if (weeks > WAY_IN_WEEKS) return null;
  const pages = item.pages.length ? item.pages.join(", ") : "none answered";
  return `${item.brand} (${[...item.months].sort().map(shortMonth).join(", ")}): still no public partnerships address after ${WAY_IN_WEEKS} weeks of checking (${pages}). It will not be listed again until something changes; add a contact or an intro on the TLC page, or take the brand off the list.`;
}

export function wayInWords(item: { brand: string; months: readonly string[]; pages: readonly string[] }): string {
  const months = [...item.months].sort().map(shortMonth).join(", ");
  const pages = item.pages.length ? item.pages.join(", ") : "none answered";
  return `${item.brand} (${months}): no public partnerships address found. Pages checked: ${pages}. If you have a contact or an intro, add it here.`;
}
