/**
 * Reading a blog-help request at the door (16 Sep 2026).
 *
 * The partners are starting blogs. Operator: a partner emails os@joinwestpeek.com with "help me
 * make an outline for a blog post on X and do research", "write a blog post on X", or "help me
 * come up with a phrase I can repeat across posts to build authority", and Porter routes it to
 * that partner's chief of staff as a BLOG_HELP card with the ask parsed into a MODE.
 *
 * PURE AND DETERMINISTIC, on purpose. The alternative — asking a model what the email means —
 * would read the same email differently on different days, and the reading is written on the
 * card once and worked from for three attempts. Word lists are legible and testable; a phrasing
 * that does not match lands on the same chief of staff as an ordinary assignment, so nothing is
 * lost, it is simply not sped up.
 *
 *   OUTLINE  — a spine with research: "outline", "structure", "spine", "research", "skeleton".
 *   DRAFT    — the whole post: "write", "draft", "full post" — unless the object of the verb is
 *              the outline or the phrase ("draft an outline" is an outline).
 *   PHRASE   — a signature line: "phrase", "tagline", "line I can repeat", "signature", "authority".
 *
 * Any combination is kept in the order OUTLINE, DRAFT, PHRASE. A blog ask with no recognisable
 * verb is an OUTLINE: the spine is the useful default, and the reply says how to ask for more.
 */

export const BLOG_MODES = ["OUTLINE", "DRAFT", "PHRASE"] as const;
export type BlogMode = (typeof BLOG_MODES)[number];

export interface BlogAsk {
  modes: BlogMode[];
  /** What the post is about, in the partner's words; falls back to the subject. */
  topic: string;
  /** The request as written, so the runner works from the partner's own words. */
  ask: string;
}

const BLOG_CONTEXT = /\b(blog|blogs|blogging|article|newsletter|substack|linkedin post|medium post|essay|posts? (?:on|about|for)|(?:across|my|every|each|our|future|all(?: of)? my) posts?\b|(?:write|draft|outline|structure)\b[^.\n]{0,40}\bposts?\b)/i;
const OUTLINE_WORDS = /\b(outline|structure|spine|skeleton|research|sections?|talking points|bullet points)\b/i;
const PHRASE_WORDS = /\b(phrase|phrases|tagline|catchphrase|signature (?:line|phrase|sentence)|(?:line|sentence|saying|motto|mantra)s? (?:i|we) can (?:repeat|reuse|use)|repeat(?:ed|able)?\b[^.\n]{0,30}\b(?:across|in every|through)|build(?:ing)? authority|authority line)\b/i;
const DRAFT_VERBS = /\b(write|draft|compose|pen|full (?:post|draft|article|piece)|whole (?:post|article)|entire (?:post|article)|write[- ]?up)\b/i;

/** Does a write/draft verb take the outline or the phrase as its object, rather than the post? */
function draftIsOfSomethingElse(text: string): boolean {
  const verbs = text.matchAll(/\b(write|draft|compose|pen)\b([^.\n]{0,40})/gi);
  let sawAVerb = false;
  let allElse = true;
  for (const m of verbs) {
    sawAVerb = true;
    if (!/\b(outline|spine|structure|phrase|tagline|line|research|skeleton)\b/i.test(m[2] ?? "")) allElse = false;
  }
  return sawAVerb && allElse;
}

function topicFrom(text: string, subject: string): string {
  const m =
    text.match(/\b(?:post|article|piece|blog|essay|newsletter)\s+(?:on|about|titled|called)\s+["“]?([^"”.\n]{3,140})/i) ??
    text.match(/\b(?:on|about)\s+["“]?([^"”.\n]{3,140})/i);
  const found = (m?.[1] ?? "")
    .replace(/\s+(?:and|then|plus|,)\s*(?:then\s+)?(?:do|write|draft|make|give|include|add|come up|suggest|research)\b.*$/i, "")
    .replace(/[\s,]+(?:and|then|plus)$/i, "")
    .trim();
  if (found.length >= 3) return found;
  const fromSubject = subject.replace(/^(?:re|fwd?):\s*/i, "").trim();
  return fromSubject || "the topic in the request";
}

/**
 * Null when this is not a blog-help ask. Otherwise the modes, the topic and the ask itself.
 */
export function parseBlogAsk(subject: string, body: string): BlogAsk | null {
  const text = `${subject}\n${body}`.replace(/\r/g, "");
  if (!BLOG_CONTEXT.test(text)) return null;

  const modes: BlogMode[] = [];
  const wantsPhrase = PHRASE_WORDS.test(text);
  const wantsOutline = OUTLINE_WORDS.test(text);
  const wantsDraft = DRAFT_VERBS.test(text) && !draftIsOfSomethingElse(text);
  if (wantsOutline) modes.push("OUTLINE");
  if (wantsDraft) modes.push("DRAFT");
  if (wantsPhrase) modes.push("PHRASE");
  // A phrase-only ask is about the blog as a whole, not one post — no outline is implied.
  if (modes.length === 0) modes.push("OUTLINE");

  const ask = body.trim().slice(0, 4000) || subject.trim();
  return { modes, topic: topicFrom(text, subject), ask };
}

export function describeModes(modes: readonly BlogMode[]): string {
  const words: Record<BlogMode, string> = { OUTLINE: "an outline with research", DRAFT: "a full draft", PHRASE: "signature phrases" };
  const list = modes.map((m) => words[m]);
  return list.length <= 1 ? (list[0] ?? "an outline") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** The recorded reading of a card's request, or null when the column is empty or not ours. */
export function readBlogAsk(requestJson: string | null | undefined): BlogAsk | null {
  if (!requestJson) return null;
  try {
    const p = JSON.parse(requestJson) as Partial<BlogAsk> & { kind?: string };
    const modes = Array.isArray(p.modes) ? p.modes.filter((m): m is BlogMode => (BLOG_MODES as readonly string[]).includes(String(m))) : [];
    if (modes.length === 0) return null;
    return { modes, topic: typeof p.topic === "string" && p.topic.trim() ? p.topic.trim() : "the topic in the request", ask: typeof p.ask === "string" ? p.ask : "" };
  } catch {
    return null;
  }
}
