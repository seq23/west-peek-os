/**
 * EVERY KEYWORD RULE JUDGES THE WHOLE SENTENCE ITS WORDS SIT IN (owner ruling, 19 Nov 2026).
 *
 * The first read (a model) decides what a partner meant. The keyword rules are the logged last resort when no first
 * read exists, and even then a phrase never acts on its own: "I don't think Scooter will take it from here" names a
 * hand-off phrase and means the opposite; "if this fails I'll take it back" is not a take-back. The partner tail patched
 * those one phrase at a time (#531, #542, #546); this is the one splitter and the one judge every rule uses instead
 * (approval, stop, property, hand-off, take-back, plan approval, cc, "back on <day>").
 *
 * A SENTENCE runs from the previous . ! ? ; or line break to the next one. A phrase found in it does NOT stand when the
 * rest of that sentence
 *   NEGATES it      not, never, no longer, cannot, any n't ("don't", "won't", "isn't")
 *   CONDITIONS it   if, unless, when, whenever, once, in case
 *   REPORTS it      said, says, told, tells, mentioned, according to, last time, or the phrase sits inside quotes
 *   ASKS it         the sentence ends with a question mark
 * The phrase's own words are not counted against it: "don't land it" is a stop, and its "don't" is the stop itself.
 *
 * A rule whose firing is the CAUTIOUS reading (it holds or waits, or names which site) may pass the shapes that apply
 * to it, with its reason beside the call. PURE.
 */

export type Shape = "NEGATES" | "CONDITIONS" | "REPORTS" | "ASKS";
export const ALL_SHAPES: readonly Shape[] = ["NEGATES", "CONDITIONS", "REPORTS", "ASKS"];

export interface Sentence {
  /** The sentence, trimmed, with its closing . ! ? or ; kept (so a question still reads as one). */
  text: string;
  /** Where it starts in the text it was split from. */
  start: number;
}

/** A boundary: one or more of . ! ? ; (with any closing quote or bracket) before a space or the end, or a line break. */
const BOUNDARY = /[.!?;]+["”’')\]]*(?=\s|$)|\r?\n/g;

/** The sentences of a text, in order. "joinwestpeek.com" and "e.g" are not boundaries: a stop needs a space after it. */
export function sentencesOf(text: string | null | undefined): Sentence[] {
  const s = String(text ?? "");
  const out: Sentence[] = [];
  const push = (from: number, to: number) => {
    const raw = s.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t) out.push({ text: t, start: from + lead });
  };
  let from = 0;
  for (const m of s.matchAll(BOUNDARY)) {
    const at = m.index ?? 0;
    const isBreak = m[0].includes("\n");
    push(from, isBreak ? at : at + m[0].length);
    from = at + m[0].length;
  }
  push(from, s.length);
  return out;
}

const NEGATES = /\b(?:not|never|no longer|cannot)\b|n['’]t\b/i;
const CONDITIONS = /\b(?:if|unless|when|whenever|once|in case)\b/i;
const REPORTS = /\b(?:said|says|told|tells|mentioned|according to|last time)\b/i;
const ASKS = /\?["”’')\]]*$/;

/** True when the character at `at` sits inside a quotation ("…" or “…”) of this sentence. */
function insideQuotes(sentence: string, at: number): boolean {
  const before = sentence.slice(0, at);
  if (((before.match(/"/g) ?? []).length) % 2 === 1) return true;
  return before.lastIndexOf("“") > before.lastIndexOf("”");
}

/**
 * Why the phrase at [from, to) of this sentence does not stand, or null when it does. With no span the whole sentence
 * is judged (a rule that reads a sentence's meaning rather than one phrase in it).
 */
export function vetoOf(sentence: string, span?: { from: number; to: number } | null, shapes: readonly Shape[] = ALL_SHAPES): Shape | null {
  const s = sentence.trim();
  const rest = span ? `${s.slice(0, span.from)} ${" ".repeat(Math.max(0, span.to - span.from))} ${s.slice(span.to)}` : s;
  if (shapes.includes("ASKS") && ASKS.test(s)) return "ASKS";
  if (shapes.includes("REPORTS") && (REPORTS.test(rest) || (span ? insideQuotes(s, span.from) : false))) return "REPORTS";
  if (shapes.includes("NEGATES") && NEGATES.test(rest)) return "NEGATES";
  if (shapes.includes("CONDITIONS") && CONDITIONS.test(rest)) return "CONDITIONS";
  return null;
}

/** The first match of `re` in this ONE sentence whose sentence lets it stand, or null. `re`'s own flags are kept. */
export function standingIn(sentence: string, re: RegExp, shapes: readonly Shape[] = ALL_SHAPES): RegExpExecArray | null {
  const s = sentence.trim();
  const all = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const m of s.matchAll(all)) {
    const from = m.index ?? 0;
    if (!vetoOf(s, { from, to: from + m[0].length }, shapes)) return m as RegExpExecArray;
  }
  return null;
}

/** The first phrase `re` finds anywhere in `text` that stands in its sentence, with that sentence; null when none does. */
export function firstStanding(text: string | null | undefined, re: RegExp, shapes: readonly Shape[] = ALL_SHAPES): { match: RegExpExecArray; sentence: Sentence } | null {
  for (const sentence of sentencesOf(text)) {
    const match = standingIn(sentence.text, re, shapes);
    if (match) return { match, sentence };
  }
  return null;
}

/** True when `re` finds a phrase in `text` that stands in its sentence. */
export function stands(text: string | null | undefined, re: RegExp, shapes: readonly Shape[] = ALL_SHAPES): boolean {
  return firstStanding(text, re, shapes) !== null;
}
