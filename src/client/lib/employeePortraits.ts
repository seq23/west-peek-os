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
 * Roster names whose portrait has not been committed yet.
 *
 * EMPTY, AND THAT IS THE POINT. It exists so a gap is a named, reviewable line rather than a broken
 * image — Whitney was in it for exactly as long as it took to find that her portrait had survived
 * the retirement in the operator's own archive, from the original run of thirty-one. The two-way
 * drift check in `tests/employeePortraits.test.ts` treats a non-empty set as a deliberate exception
 * and still enforces parity for everybody else.
 */
export const AWAITING_PORTRAIT: ReadonlySet<string> = new Set();

const WITH_PORTRAIT = new Set(
  AI_EMPLOYEE_ROSTER.map((e) => e.name).filter((n) => !AWAITING_PORTRAIT.has(n)),
);

/** Public URL for an employee's portrait, or null when there is none. */
export function portraitFor(name: string): string | null {
  return WITH_PORTRAIT.has(name) ? `/employees/${name.toLowerCase()}.jpg` : null;
}

/**
 * Alt text. Deliberately NOT "photo of {name}" — it names the portrait as AI-generated, so a
 * screen-reader user is told what a sighted user can only infer.
 */
export function portraitAlt(name: string, role: string): string {
  return `${name}, ${role} — AI-generated portrait of an AI employee`;
}
