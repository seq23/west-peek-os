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
export function wayInWords(item: { brand: string; months: readonly string[]; pages: readonly string[] }): string {
  const months = [...item.months].sort().map(shortMonth).join(", ");
  const pages = item.pages.length ? item.pages.join(", ") : "none answered";
  return `${item.brand} (${months}): no public partnerships address found. Pages checked: ${pages}. If you have a contact or an intro, add it here.`;
}
