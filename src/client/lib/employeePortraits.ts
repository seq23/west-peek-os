import { AI_EMPLOYEE_ROSTER } from "@shared/registry/aiEmployees";

/**
 * AI employee portraits (P32, Employee Lounge).
 *
 * These are AI-GENERATED IMAGES OF PEOPLE WHO DO NOT EXIST. That is stated here, in the alt text
 * every portrait renders with, and in the manifest committed beside the assets — because the one
 * way this becomes a problem is if a portrait is later mistaken for a photograph of real staff.
 *
 * Only the 256px versions are committed. The 1024px originals stay out of the repository: at
 * ~1.4MB each they would add ~43MB to every artifact and slow every packaging run, for detail no
 * avatar ever shows. Half a megabyte total is the whole set at the size it is actually displayed.
 *
 * Served from `src/client/public/employees/`, so the path is stable and no bundler import is
 * needed. A missing file degrades to initials rather than a broken image.
 */

/**
 * Roster names that have a committed portrait — DERIVED, not listed.
 *
 * This was a hardcoded set of thirty-one names, and after the roster consolidated to seventeen it
 * still named fourteen people whose portrait files had been deleted. Nothing broke visibly, because
 * retired employees do not render — which is precisely the kind of drift that sits there until the
 * day something does render them and shows a broken image.
 *
 * The roster is the source of truth for who exists and the committed files are the source of truth
 * for who has a face; `tests/employeePortraits.test.ts` already asserts those two agree in both
 * directions, so deriving from the roster keeps this list correct without anyone maintaining it.
 */
/**
 * WHO HAS A FACE — everybody, including the retired.
 *
 * This was derived from AI_EMPLOYEE_ROSTER, which holds only the currently-employed seats.
 * That was right while retired employees never rendered, and wrong the moment the lounge let you
 * bring one back: an employee returning from retirement arrived with no face, and the page that
 * exists to make the workforce feel like people showed a grey initial.
 *
 * All thirty-one portraits from the original run are committed — the whole set is 520KB at the size
 * it is actually displayed. Keying off the FILES rather than the roster means a name resolves if
 * its picture exists, which is the honest question, and un-retiring somebody needs no change here.
 *
 * `tests/employeePortraits.test.ts` asserts the roster is a SUBSET of what is committed: every
 * working employee must have a face; a face with nobody currently claiming it is a retired seat, not
 * dead weight.
 */
const COMMITTED = new Set([
  "paige", "parker", "pax", "penn", "percy", "perrin", "perry", "pierce", "piper", "pippa",
  "poppy", "porter", "preston", "priya", "prue", "walker", "walter", "waverly", "wells",
  "wendy", "wesley", "whitney", "willa", "willow", "wilson", "winnie", "winter", "winton",
  "wren", "wyatt", "wynn",
]);

/** Public URL for an employee's portrait, or null when there is none. */
export function portraitFor(name: string): string | null {
  const file = name.trim().toLowerCase();
  return COMMITTED.has(file) ? `/employees/${file}.jpg` : null;
}

/**
 * Alt text. Deliberately NOT "photo of {name}" — it names the portrait as AI-generated, so a
 * screen-reader user is told what a sighted user can only infer.
 */
export function portraitAlt(name: string, role: string): string {
  return `${name}, ${role} — AI-generated portrait of an AI employee`;
}
