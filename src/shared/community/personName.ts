/**
 * Does a Network OS name read as a FIRST AND LAST NAME?
 *
 * On 28 Sep 2026 the "Newest in the community" window showed the operator this, verbatim:
 * "? ?", ". Goosby", "@iamnovastyles 77", "*alt email: staylor@spry.vc more than a decade", "A K".
 * Every one of them is a row Network OS holds — the August 2026 import took whatever the sheet
 * said — and the operator asked: "i dont know if this is an issue of network OS or west peek OS".
 * It is Network OS's data and West Peek OS's job not to present it as a person. The window is
 * "so we can see some names", and a name is what this decides.
 *
 * THE RULE, kept deliberately loose so a real name is never hidden: at least two words; every word
 * carries a letter; no word is a handle (starts with "@") and nothing in it is a "?"; the LAST word
 * has at least two letters, so "A K" and "ACP ?" are not a surname but "A. Walton" is. It cannot
 * tell "AFE BVLOG" from a person, and does not try: hiding a real person is the worse mistake.
 * Rows it declines are COUNTED and the count is shown, so a reader can see the data for what it is.
 */
const LETTER = /\p{L}/u;
const LETTERS = /\p{L}/gu;

export function hasFirstAndLastName(name: string | null | undefined): boolean {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  if (words.some((w) => !LETTER.test(w) || w.startsWith("@") || w.includes("?") || w.includes("@"))) return false;
  const last = words[words.length - 1]!;
  return (last.match(LETTERS) ?? []).length >= 2;
}
