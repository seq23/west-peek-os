/**
 * THE BRAIN'S OWN SECTIONS, BY HEADING (15 Nov 2026). A company brain is a long markdown document (the west-peek brain
 * is over 11,000 words), so a reader is given only the `### …` subsections it needs, found by heading PREFIX (live
 * headings carry parentheticals: "### West Peek Productions (the agency)"). Private spans
 * (`<!-- confidential -->…<!-- /confidential -->`) are removed before anything leaves; an unclosed one removes the rest
 * of the section (fail closed). Pure.
 */
const OPEN = /<!--\s*confidential\s*-->/i;
const CLOSE = /<!--\s*\/\s*confidential\s*-->/i;

export function withoutPrivateSpans(text: string): string {
  let rest = text;
  let out = "";
  for (;;) {
    const open = OPEN.exec(rest);
    if (!open) return out + rest;
    out += rest.slice(0, open.index);
    const after = rest.slice(open.index + open[0].length);
    const close = CLOSE.exec(after);
    if (!close) return out;
    rest = after.slice(close.index + close[0].length);
  }
}

/** The `### <prefix>…` subsection, heading included, up to the next `##`/`###` heading; null when there is none. */
export function subsection(md: string, prefix: string): string | null {
  const lines = md.replace(/\r/g, "").split("\n");
  const want = prefix.trim().toLowerCase();
  const start = lines.findIndex((l) => /^###\s+/.test(l) && l.replace(/^###\s+/, "").trim().toLowerCase().startsWith(want));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{2,3}\s+/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return withoutPrivateSpans(lines.slice(start, end).join("\n")).trim();
}

/** Which business a card or an email is about, as the brain's heading prefix. */
const BUSINESS_BY_HOST: ReadonlyArray<[RegExp, string]> = [
  [/westpeekproductions\.com/i, "West Peek Productions"],
  [/topbarz/i, "Top Barz"],
  [/westpeek\.live/i, "westpeek.live"],
  [/westpeek\.ventures/i, "West Peek Ventures"],
  [/joinwestpeek\.com/i, "West Peek (the community)"],
];
const BUSINESS_BY_WORD: ReadonlyArray<[RegExp, string]> = [
  [/\btop ?barz\b|\bculturecon\b/i, "Top Barz"],
  [/\bproductions\b/i, "West Peek Productions"],
  [/\bwestpeek\.live\b/i, "westpeek.live"],
  [/\b(?:tlc|the learning club|rooms?)\b/i, "TLC and Rooms"],
];

/** The business headings a card (its title, kind and host) and an email's words point at, most specific first. Pure. */
export function businessesFor(cardText: string, words: string): string[] {
  const out: string[] = [];
  const add = (h: string) => { if (!out.includes(h)) out.push(h); };
  for (const [re, h] of BUSINESS_BY_HOST) if (re.test(cardText)) add(h);
  for (const [re, h] of BUSINESS_BY_WORD) if (re.test(cardText)) add(h);
  for (const [re, h] of BUSINESS_BY_WORD) if (re.test(words)) add(h);
  for (const [re, h] of BUSINESS_BY_HOST) if (re.test(words)) add(h);
  return out;
}

/** The "which business is this word?" lookup, wherever it sits: the section whose heading names it. */
export function wordLookup(md: string): string | null {
  const lines = md.replace(/\r/g, "").split("\n");
  const start = lines.findIndex((l) => /^#{2,4}\s+.*which business/i.test(l));
  if (start < 0) return null;
  const level = /^(#+)/.exec(lines[start]!)![1]!.length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = /^(#+)\s+/.exec(lines[i]!);
    if (m && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return withoutPrivateSpans(lines.slice(start, end).join("\n")).trim();
}
