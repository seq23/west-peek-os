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

/** Roster names that have a committed portrait. */
const WITH_PORTRAIT = new Set([
  "Walker", "Wendy", "Wren", "Willa",
  "Winton", "Porter", "Winnie", "Waverly", "Wells", "Willow", "Wilson",
  "Pierce", "Priya", "Paige", "Wyatt", "Poppy", "Walter",
  "Piper", "Perry", "Wesley", "Penn",
  "Winter", "Parker", "Wynn", "Percy", "Prue", "Pippa", "Pax", "Preston", "Perrin",
  "Whitney",
]);

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
