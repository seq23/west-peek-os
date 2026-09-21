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

export type ApprovalReading = { kind: "APPROVED" } | { kind: "REFUSED"; text: string } | { kind: "ANSWERS"; text: string };

export const APPROVAL_WORDS = ["approved", "approve", "yes", "go", "land it", "ok", "okay", "lgtm"] as const;
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
  if ((APPROVAL_WORDS as readonly string[]).includes(head)) return { kind: "APPROVED" };
  for (const start of REFUSAL_STARTS) {
    if (head === start || head.startsWith(`${start} `) || head.startsWith(`${start},`) || head.startsWith(start + (start.endsWith(":") ? "" : "."))) {
      return { kind: "REFUSED", text: trimmed };
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
