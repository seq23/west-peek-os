/**
 * Plain words for Network OS's `person_type` vocabulary.
 *
 * The population panel reads categories straight from Network OS rather than inventing a second
 * taxonomy (communityOs.ts), which means it shows whatever key Network OS chose to store. On
 * 27 Sep 2026 the biggest tile on the Community page read `general_tech_adjacent` — 4,571 people
 * labelled in a machine's underscores because the dictionary knew seven keys and Network OS had an
 * eighth. `service_provider` is not a category anybody says out loud, and neither is that.
 *
 * So the dictionary is the preferred reading, and ANY key it does not know is humanised rather
 * than shown raw: underscores become spaces, the first letter is capitalised. A test pins both
 * halves, so an unknown key can never again reach the screen as snake_case.
 */
export const TYPE_WORDS: Record<string, string> = {
  investor: "Investors",
  founder: "Founders",
  operator: "Operators",
  lawyer: "Lawyers",
  service_provider: "Service providers",
  media: "Media",
  general: "General",
  general_tech_adjacent: "Tech-adjacent",
  unknown: "Not categorised",
};

/** The word for a `person_type` key. Never returns a key's underscores. */
export function typeWord(key: string): string {
  const known = TYPE_WORDS[key.toLowerCase()];
  if (known) return known;
  const spaced = key.replace(/[_-]+/g, " ").trim();
  if (spaced === "") return TYPE_WORDS.unknown!;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
