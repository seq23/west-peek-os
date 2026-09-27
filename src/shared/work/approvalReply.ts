/**
 * ONE WORD APPROVES (owner, 21 Sep 2026): "the approval step must have zero friction."
 *
 * The PLAN phase's blocked email carries the whole plan and every ask as a numbered question with
 * Porter's recommended default. The partner replies with ONE WORD and the card resumes into BUILD
 * taking every recommendation. Three readings, and nothing else:
 *
 *   APPROVED  "approved", "approve", "yes", "go", "land it" (alone, or with trailing punctuation
 *             and a signature) → every ask is answered with its recommended default.
 *   REFUSED   an explicit stop — "no", "stop", "hold off", "not approved", "don't build it" → the
 *             card is HELD and the text is recorded; nothing is built.
 *   CHANGES   "changes: …" → instructions to apply; the work continues with them.
 *   ANSWERS   anything else → the whole written half is read for its intent by `replyIntent.ts`
 *             (CONTINUE, with or without changes; QUESTION; or an explicit STOP said in more words).
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
  /**
   * AN EXPLICIT STOP, AND NOTHING ELSE (owner, 27 Sep 2026: "a partner's reply is permission to
   * continue"). "no", "stop", "hold off", "not approved", "don't build it" — the card is held and
   * nothing is built. A reply that merely STARTS with "no" ("No problem, looks great") is not a
   * refusal; it reads as ANSWERS and the whole written half is read for its intent (replyIntent.ts).
   */
  | { kind: "REFUSED"; text: string }
  /** "changes: …" — instructions to apply. After a preview: make them and send a new preview; at the plan: build with them. Never a hold. */
  | { kind: "CHANGES"; text: string }
  | { kind: "ANSWERS"; text: string };

export const APPROVAL_WORDS = ["approved", "approve", "yes", "go", "land it", "ok", "okay", "lgtm"] as const;
export const PREVIEW_WORDS = ["preview", "preview only", "preview first", "preview it"] as const;
export const FORCE_WORDS = ["approved to production", "approve to production", "force production", "ship it anyway", "land anyway", "land it anyway"] as const;
export const PUBLISH_WORDS = ["publish", "publish it", "publish now", "publish with them", "fill them in and publish"] as const;
export const CHANGE_STARTS = ["changes:", "change:"] as const;
/** The whole first line is one of these → STOP. */
export const STOP_WORDS = ["no", "stop", "hold", "hold off", "hold on", "wait", "pause", "not approved", "not yet", "don't", "do not", "cancel", "hold it", "hold this"] as const;
/** The first line starts with one of these → STOP ("stop the build", "hold off until Monday", "don't land it yet"). */
export const STOP_STARTS = ["stop ", "stop,", "stop.", "hold off", "hold on", "hold it", "hold this", "not approved", "not yet", "don't build", "do not build", "don't land", "do not land", "don't publish", "do not publish", "don't ship", "do not ship", "don't go", "do not go", "don't proceed", "do not proceed", "don't continue", "do not continue", "pause ", "pause,", "wait,", "wait ", "cancel "] as const;

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
  for (const start of CHANGE_STARTS) if (head.startsWith(start)) return { kind: "CHANGES", text: trimmed };
  if ((STOP_WORDS as readonly string[]).includes(head)) return { kind: "REFUSED", text: trimmed };
  for (const start of STOP_STARTS) if (head.startsWith(start)) return { kind: "REFUSED", text: trimmed };
  if (trimmed.length === 0) return { kind: "REFUSED", text: "" };
  return { kind: "ANSWERS", text: trimmed };
}

/** "changes: swap the logo" → "swap the logo". The instructions without their prefix. Pure. */
export function changesTextOf(text: string): string {
  const t = text.trim();
  for (const start of CHANGE_STARTS) if (t.toLowerCase().startsWith(start)) return t.slice(start.length).trim();
  return t;
}

/**
 * A REPLY ON AN EARLIER EMAIL THREAD (27 Sep 2026). When a partner answers the PLAN email after the
 * plan is already approved and the card is waiting on its PREVIEW, the reply is kept as a note
 * carrying this prefix: its instructions are applied, its "approved" never lands a preview it did
 * not answer — the approval binds to the latest preview (#194). One string, read by the email door
 * that writes it and the runner that reads it.
 */
export const LATE_THREAD_NOTE_PREFIX = "(Reply on the earlier email thread; read as instructions, never as an approval of the preview.) ";

export function stripLateThreadPrefix(body: string): { late: boolean; text: string } {
  return body.startsWith(LATE_THREAD_NOTE_PREFIX) ? { late: true, text: body.slice(LATE_THREAD_NOTE_PREFIX.length).trim() } : { late: false, text: body };
}

export interface Ask {
  question: string;
  recommended: string;
}

/** What `readAsks` writes when the PLAN offered a question with no recommended answer. */
export const NO_RECOMMENDATION = "(no recommendation given)";

/**
 * A PLAN NEVER WAITS WHEN EVERY ASK CARRIES A RECOMMENDATION (owner, 27 Sep 2026: a partner's
 * instructive email IS the plan approval; the card should not need more approvals). True when
 * there is nothing a partner must decide from scratch — every ask has Porter's recommended answer,
 * or there are no asks at all. The recommendations are then taken, the plan is approved by the
 * request itself, and the PLAN email is an FYI. Only an ask WITHOUT a recommendation still blocks.
 * Pure.
 */
export function everyAskRecommended(asks: readonly Ask[]): boolean {
  return asks.every((a) => a.recommended.trim().length > 0 && a.recommended.trim() !== NO_RECOMMENDATION);
}

/** Read asks as the PLAN reports them: objects, or "question — recommended: default" strings. */
export function readAsks(raw: unknown): Ask[] {
  if (!Array.isArray(raw)) return [];
  const out: Ask[] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const q = String((item as { question?: unknown; q?: unknown }).question ?? (item as { q?: unknown }).q ?? "").trim();
      const r = String((item as { recommended?: unknown; default?: unknown }).recommended ?? (item as { default?: unknown }).default ?? "").trim();
      if (q) out.push({ question: q, recommended: r || NO_RECOMMENDATION });
    } else if (typeof item === "string" && item.trim()) {
      const m = item.match(/^(.*?)\s*(?:—|-|–)\s*(?:recommended|recommend|default)\s*:\s*(.+)$/i);
      out.push(m ? { question: m[1]!.trim(), recommended: m[2]!.trim() } : { question: item.trim(), recommended: NO_RECOMMENDATION });
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
