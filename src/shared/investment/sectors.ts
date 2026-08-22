/**
 * The sectors a company can be filed under — derived from the thesis, never typed.
 *
 * Operator, item 10: "Sectors should derive from the thesis, plus a Misc catch-all."
 *
 * WHAT WAS WRONG. Sector was free text, and it had already drifted from the firm's own mandate: the
 * mandate says `AI, FUTURE_OF_WORK, HEALTH_TECH, ED_TECH, CONSUMER` and the companies on record
 * carried "AI", "Ed tech" and "Consumer". Three spellings of one taxonomy means nothing can be
 * counted — "how much of the pipeline is health tech" has no answer when half the rows say
 * HEALTH_TECH and half say "Healthtech".
 *
 * DERIVED AND NOT COPIED. The list comes from the current mandate at read time, so amending the
 * thesis changes the dropdown and the two can never disagree. A constant here would be a second
 * copy of the firm's strategy, which is exactly the thing the mandate exists to be the only one of.
 *
 * OFF-THESIS IS A REAL ANSWER. A company that does not fit is a fact worth recording — the firm
 * meets them, and "we saw eleven off-thesis companies this quarter" is a finding about deal flow.
 * Forcing every company into a mandate sector would make the register lie to make the dropdown
 * tidy. It is deliberately named for what it means rather than "Other".
 */

export const OFF_THESIS = "OFF_THESIS";

export interface SectorOption {
  key: string;
  label: string;
  /** False for the catch-all, so a surface can show it differently. */
  inMandate: boolean;
}

/**
 * How a sector key is written out for a person.
 *
 * THE KEY AND THE LABEL ARE DIFFERENT THINGS, and keeping them apart is what makes this safe.
 * `AI` is the identifier the mandate holds and the companies are filed under; "Artificial
 * intelligence" is what the firm calls it out loud. Operator, 21 Aug 2026: "u can use artificial
 * intelligence as the sector name to be official."
 *
 * Renaming the KEY in the mandate would have been the other way to do this and would have quietly
 * orphaned every company already filed as `AI` into off-thesis — the register would have stopped
 * agreeing with itself to make a dropdown read better.
 *
 * NAMED, not inferred. `AI` rendered as "Ai" on the first live read; the rule that fixes it ("short
 * all-caps words stay capitalised") turns `ED_TECH` into "ED tech", so no heuristic is right about
 * both. A list is a five-second fix when something is missing and cannot be wrong about what is on it.
 */
const SPOKEN: Record<string, string> = {
  AI: "Artificial intelligence",
  ML: "Machine learning",
  SAAS: "SaaS",
  IOT: "Internet of things",
  EV: "Electric vehicles",
  AR: "AR",
  VR: "VR",
  API: "API",
  B2B: "B2B",
  B2C: "B2C",
  HR: "HR",
};

/** `HEALTH_TECH` → `Health tech`, `AI` → `AI`. The mandate is written in constants; a person is not. */
export function sectorLabel(key: string): string {
  if (key === OFF_THESIS) return "Off-thesis";
  // A whole-key match first, so "AI" reads as the firm says it rather than as its letters.
  const whole = SPOKEN[key.trim().toUpperCase()];
  if (whole) return whole;

  const words = key.trim().replace(/[_-]+/g, " ").split(/\s+/).filter(Boolean);
  return words
    .map((w, i) => {
      const spoken = SPOKEN[w.toUpperCase()];
      // Inside a compound the short form is right: "AI infrastructure", not
      // "Artificial intelligence infrastructure".
      if (spoken) return w.toUpperCase() === "AI" ? "AI" : spoken;
      const lower = w.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

/**
 * The options a picker should show. The catch-all is always last and always present, including when
 * the mandate has no sectors at all — a fund with no stated sectors can still meet a company.
 */
export function sectorOptions(mandateSectors: readonly string[] | undefined): SectorOption[] {
  const seen = new Set<string>();
  const options: SectorOption[] = [];
  for (const raw of mandateSectors ?? []) {
    const key = raw.trim().toUpperCase().replace(/\s+/g, "_");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    options.push({ key, label: sectorLabel(key), inMandate: true });
  }
  options.push({ key: OFF_THESIS, label: sectorLabel(OFF_THESIS), inMandate: false });
  return options;
}

/**
 * Match what is already on a company to a mandate sector.
 *
 * Existing rows carry free text — "Ed tech", "AI", "Consumer" — written before the mandate was the
 * source. Normalised comparison recognises those as the sectors they plainly are, so history is
 * read rather than discarded. Anything that genuinely does not match reads as off-thesis, which is
 * true of it.
 */
export function matchSector(existing: string | null | undefined, options: readonly SectorOption[]): string {
  if (!existing) return OFF_THESIS;
  const norm = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = norm(existing);
  return options.find((o) => o.inMandate && norm(o.key) === wanted)?.key
    ?? options.find((o) => o.inMandate && norm(o.label) === wanted)?.key
    ?? OFF_THESIS;
}
