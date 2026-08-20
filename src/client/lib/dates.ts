/**
 * Dates, written the way the reader's own machine writes them.
 *
 * The interface printed `2026-08-20` in a dozen places by slicing an ISO string. That is the
 * database's format, not a person's, and it is the same class of thing as rendering `fu_sequoia_taylor`
 * where a name belongs — correct data, addressed to the wrong audience.
 *
 * `Intl` rather than a hand-rolled format, because the alternative is deciding on somebody's behalf
 * whether the month or the day comes first. Both partners are in Chicago today; that is not a
 * reason to hard-code an American ordering into the product.
 *
 * ISO IS KEPT WHERE IT IS THE POINT. A `<time dateTime>` attribute, a filename, an API argument and
 * a database value all want the machine form. This is only for text a person reads.
 */

/** "20 August 2026" — for a date somebody is reading rather than sorting by. */
export function readableDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

/** "20 Aug" — when the year is obvious from context and the space is tight. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The machine form, for `<time dateTime>` and anything an API will parse. */
export function isoDay(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return Number.isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 10);
}
