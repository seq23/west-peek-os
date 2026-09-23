/**
 * ONE WORD APPROVES (owner, 21 Sep 2026): "the approval step must have zero friction."
 *
 * The PLAN phase's blocked email carries the whole plan and every ask as a numbered question with
 * Porter's recommended default. The partner replies with ONE WORD and the card resumes into BUILD
 * taking every recommendation. Three readings, and nothing else:
 *
 *   APPROVED  "approved", "approve", "yes", "go", "land it" (alone, or with trailing punctuation
 *             and a signature) → every ask is answered with its recommended default.
 *   REFUSED   starts with "no", "not approved", "stop" or "changes:" → the card STAYS BLOCKED and
 *             the text is recorded; nothing is built.
 *   ANSWERS   anything else → recorded as the answers, and BUILD resumes with them.
 *
 * PURE. The words are read the same on Tuesday as on Monday, and the tests can say exactly which
 * word does what. Authority is not decided here: `steerFromReply` only accepts the reply from the
 * partner the question was addressed to, and the runner checks the same before it acts.
 */

export type ApprovalReading =
  | { kind: "APPROVED" }
  /** "preview" (21 Sep 2026): approve the plan, but build to a PREVIEW and ask again before landing. Never a landing approval. */
  | { kind: "PREVIEW" }
  /** "approved to production" (21 Sep 2026): the named bypass — land a not-ready plan, placeholders and all. Separate and explicit; never plain "approved". */
  | { kind: "FORCED" }
  /**
   * "publish" AFTER A PREVIEW (owner, 23 Sep 2026, option 3): "attach them or add them to Drive,
   * reply 'publish', and I'll fill them in and publish without another preview." A landing approval
   * that binds to a rebuild with the new materials — never to the preview she is looking at, and
   * never when nothing new arrived. Before a plan is approved it reads like "approved".
   */
  | { kind: "PUBLISH" }
  /** `changes` is true for "changes: …" — after a preview that means "make them and send a new preview"; before the plan it holds. */
  | { kind: "REFUSED"; text: string; changes?: boolean }
  | { kind: "ANSWERS"; text: string };

export const APPROVAL_WORDS = ["approved", "approve", "yes", "go", "land it", "ok", "okay", "lgtm"] as const;
export const PREVIEW_WORDS = ["preview", "preview only", "preview first", "preview it"] as const;
export const FORCE_WORDS = ["approved to production", "approve to production", "force production", "ship it anyway", "land anyway", "land it anyway"] as const;
export const PUBLISH_WORDS = ["publish", "publish it", "publish now", "publish with them", "fill them in and publish"] as const;
const CHANGE_STARTS = ["changes:", "change:"] as const;
const REFUSAL_STARTS = ["no", "not approved", "stop", "changes:", "change:", "don't", "do not"] as const;

/** The first line the person wrote, without a signature, quoted text or punctuation noise. */
function firstWords(text: string): string {
  const line = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith(">")) ?? "";
  return line.replace(/[.!,;:\s]+$/g, "").trim().toLowerCase();
}

export function readApprovalReply(text: string | null | undefined): ApprovalReading {
  const trimmed = (text ?? "").trim();
  const head = firstWords(trimmed);
  // The force phrase is read FIRST: "approved to production" must never collapse into "approved".
  if ((FORCE_WORDS as readonly string[]).includes(head)) return { kind: "FORCED" };
  if ((APPROVAL_WORDS as readonly string[]).includes(head)) return { kind: "APPROVED" };
  if ((PREVIEW_WORDS as readonly string[]).includes(head)) return { kind: "PREVIEW" };
  if ((PUBLISH_WORDS as readonly string[]).includes(head)) return { kind: "PUBLISH" };
  for (const start of REFUSAL_STARTS) {
    if (head === start || head.startsWith(`${start} `) || head.startsWith(`${start},`) || head.startsWith(start + (start.endsWith(":") ? "" : "."))) {
      return (CHANGE_STARTS as readonly string[]).includes(start) ? { kind: "REFUSED", text: trimmed, changes: true } : { kind: "REFUSED", text: trimmed };
    }
  }
  if (trimmed.length === 0) return { kind: "REFUSED", text: "" };
  return { kind: "ANSWERS", text: trimmed };
}

export interface Ask {
  question: string;
  recommended: string;
}

/** Read asks as the PLAN reports them: objects, or "question — recommended: default" strings. */
export function readAsks(raw: unknown): Ask[] {
  if (!Array.isArray(raw)) return [];
  const out: Ask[] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const q = String((item as { question?: unknown; q?: unknown }).question ?? (item as { q?: unknown }).q ?? "").trim();
      const r = String((item as { recommended?: unknown; default?: unknown }).recommended ?? (item as { default?: unknown }).default ?? "").trim();
      if (q) out.push({ question: q, recommended: r || "(no recommendation given)" });
    } else if (typeof item === "string" && item.trim()) {
      const m = item.match(/^(.*?)\s*(?:—|-|–)\s*(?:recommended|recommend|default)\s*:\s*(.+)$/i);
      out.push(m ? { question: m[1]!.trim(), recommended: m[2]!.trim() } : { question: item.trim(), recommended: "(no recommendation given)" });
    }
  }
  return out;
}

/** The numbered lines the email carries. */
export function askLines(asks: readonly Ask[]): string[] {
  return asks.map((a, i) => `${i + 1}. ${a.question} — Porter recommends: ${a.recommended}`);
}

/** What "approved" means: every ask answered with its recommendation. */
export function approvedAnswers(asks: readonly Ask[]): string[] {
  return asks.length === 0 ? ["approved as written"] : asks.map((a, i) => `${i + 1}. ${a.recommended} (approved as recommended)`);
}

/**
 * PRE-APPROVAL IN THE REQUEST (owner, 21 Sep 2026). A partner may say up front that they do not
 * care about the decisions: Porter picks everything, offers no options, the plan is approved at
 * filing and the email is an FYI. Read from the partner's OWN authenticated request text at the
 * door — never from a later message, never from the other partner.
 */
export const PRE_APPROVAL_PHRASES = ["your call", "you decide", "no need to ask", "just do it", "pick everything", "no options"] as const;

function phraseIn(text: string | null | undefined, phrases: readonly string[]): string | null {
  const lower = ` ${(text ?? "").replace(/\s+/g, " ").toLowerCase()} `;
  for (const p of phrases) if (new RegExp(`(^|[^a-z])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(lower)) return p;
  return null;
}

/** The pre-approval phrase the request carries, or null. */
export function preApprovalIn(requestText: string | null | undefined): string | null {
  return phraseIn(requestText, PRE_APPROVAL_PHRASES);
}

/** The force phrase the request carries ("approved to production", "ship it anyway", …), or null. */
export function forcePhraseIn(requestText: string | null | undefined): string | null {
  return phraseIn(requestText, FORCE_WORDS);
}

/** Every ask becomes a decision: the recommended default IS the decision. */
export function decidedFromAsks(asks: readonly Ask[]): string[] {
  return asks.map((a) => `${a.question} → ${a.recommended} (decided; pre-approved in the request)`);
}
