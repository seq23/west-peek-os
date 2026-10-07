/**
 * ── AN ASK OF THE OWNER IS NEVER A TASK THE SYSTEM COULD DO (7 Oct 2026) ─────────────────────────
 *
 * Owner, 7 Oct 2026, about Wyatt's "a question — Deal-flow intake" email: "figure out why the fuck
 * wyatt sent me that email… this friction should be fixed by you and never happen again."
 *
 * What the email asked her for: to forward again a founder's email the firm ALREADY HELD (stored in
 * R2, indexed in `inbound_message`), because "this card's tools are web search, page visits, notes
 * and hand-offs" and none of them could open the stored message or put the company on the board.
 * That is a missing EXECUTOR — a defect on our side — dressed up as a question for her.
 *
 * Her standing rules, which this file turns into code:
 *   - Nothing waits on the owner. Only a secret or an account she alone holds may stop work.
 *   - Decisions are hers; tasks are not.
 *   - Employees cannot drop owned work, and never ask her to chase staff.
 *
 * TWO HALVES, ONE FILE.
 *   1. THE EXECUTOR MAP (`WORK_EXECUTORS`): kinds of work the general loop meets that need an action
 *      beyond search/visit/note, and the action that does them. The loop OFFERS the action whenever
 *      the card carries that work (capability follows the work, so whichever seat holds the card —
 *      Porter routing it, Wyatt after a hand-off — can do it). Today: deal flow → `open_in_funnel`.
 *   2. THE GATE (`ownerAskRefusal`): every `blocked` an employee writes passes it before anything
 *      reaches a partner. It refuses an ask for something the system holds, an admission that the
 *      card's tools cannot do the work, an ask to chase a colleague, and an ask for a manual step —
 *      unless the ask is for a secret, a login or an account only she holds, which is the one
 *      legitimate stop. A refused ask goes back to the employee as a step (do it, or hand it to the
 *      seat that can); at the last step it becomes an ENGINEER stop, never her email.
 *
 * Copied in PATTERN from boss-os PR #67 (executor-capability map, assignment-time validation, copy
 * that refuses to ask the owner to chase staff or do manual steps). Not imported: boss-os carries
 * West Peek chassis code and the two diverge.
 *
 * `validate:owner-ask-gate` pins both halves to the runner and proves them on the real 7 Oct ask.
 */

/** A kind of work the general loop cannot finish with search/visit/note, and the action that can. */
export interface WorkExecutor {
  key: string;
  /** The loop action (EMPLOYEE_ACTIONS) that does this work. */
  action: string;
  /** True when a card's title + description carry this work. */
  carries: (text: string) => boolean;
  /** One line for the prompt: what the action does and when to use it. */
  offer: string;
}

export const DEAL_FLOW_TAG = /#‍?wp(?:dealflow|deck)\b/i;

export const WORK_EXECUTORS: readonly WorkExecutor[] = [
  {
    key: "DEAL_INTAKE",
    action: "open_in_funnel",
    carries: (text) => DEAL_FLOW_TAG.test(text ?? ""),
    offer:
      "This card is DEAL FLOW: the company goes on the firm's board. open_in_funnel puts it there yourself — it checks the board for an existing record first (never a duplicate), opens it at the top of the funnel, attaches the stored message and hands the decision card to the Analyst. Read the company's name out of the forwarded message below. Never ask a partner to forward, re-send or add it.",
  },
];

/** The executors a card's text calls for. */
export function executorsFor(text: string): WorkExecutor[] {
  return WORK_EXECUTORS.filter((e) => e.carries(text));
}

export type OwnerAskRule = "SYSTEM_HOLDS_IT" | "TOOLS_CANNOT" | "CHASE_STAFF" | "MANUAL_STEP";

export interface OwnerAskInput {
  /** The employee's `needs` sentence. */
  needs: string;
  /** The materials they listed as missing, item + where. */
  missing?: ReadonlyArray<{ item: string; where?: string }>;
  /** True when the card carries a stored copy of the message it is about. */
  holdsStoredMessage: boolean;
  /** Every employee's first name, so "ask Porter" is recognised as chasing staff. */
  staffNames: readonly string[];
}

export interface OwnerAskRefusal {
  rule: OwnerAskRule;
  why: string;
}

/**
 * THE ONE LEGITIMATE STOP: a secret, a login or an account only she holds. An ask that names one is
 * never refused, whatever else it says — "sign in to KDP and approve the 2FA prompt" is hers.
 */
const ONLY_SHE_HOLDS = /\b(password|passcode|2fa|two[- ]factor|one[- ]time code|verification code|api key|secret|credential|token|log ?in|sign ?in|oauth|her account|your account|bank|wire|signature|sign the)\b/i;

const ASKS_FOR_THE_ORIGINAL = /\b(original|forwarded|forward(?:ing)?|re-?send|resend|send (?:it|this|me) again)\b[^.]{0,80}\b(e-?mail|message|thread|note)\b|\b(e-?mail|message|thread)\b[^.]{0,60}\b(did not|didn't|never) (?:come|get) through\b/i;

const TOOLS_CANNOT = /\b(my|this card's|the card's|these|our) (?:tools|actions|steps)\b[^.]{0,120}\b(cannot|can't|can not|do not|don't|unable)\b|\bnone of them can\b|\b(?:i|we) (?:cannot|can't|am unable to|have no way to|do not have access to|don't have access to) (?:read|open|access|reach|see|check|create|update|write to|search) (?:the )?(?:firm's |our )?(?:deal )?(?:board|pipeline|funnel|register|record|records|database|stored message|\.eml|inbox|mailbox|r2)\b/i;

const MANUAL_STEP = /\b(forward (?:it|this|the|them)|copy (?:and|&) paste|paste (?:it|this|the)|click|press the|run (?:the|this) (?:script|command)|create the record|add (?:it|the company) to the (?:board|pipeline|funnel)|enter it (?:on|in))\b/i;

/**
 * Null when the ask may reach a partner; otherwise which rule refuses it and what to do instead.
 * Checked on the `needs` sentence AND on every missing item, because the 7 Oct email asked for the
 * forward in both places.
 */
export function ownerAskRefusal(input: OwnerAskInput): OwnerAskRefusal | null {
  const parts = [input.needs ?? "", ...(input.missing ?? []).map((m) => `${m.item} ${m.where ?? ""}`)];
  const all = parts.join(" \n ");
  if (ONLY_SHE_HOLDS.test(all)) return null;

  if (input.holdsStoredMessage && parts.some((p) => ASKS_FOR_THE_ORIGINAL.test(p))) {
    return {
      rule: "SYSTEM_HOLDS_IT",
      why: "The message is already stored on this card — read it from the card instead of asking a partner to send it again.",
    };
  }
  if (TOOLS_CANNOT.test(all)) {
    return {
      rule: "TOOLS_CANNOT",
      why: "\"My tools cannot do this\" is a gap on our side, not a question for a partner. Use the action this card offers for it, or hand it to the seat that can.",
    };
  }
  const names = input.staffNames.filter((n) => n.trim().length >= 3).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (names.length > 0) {
    const chase = new RegExp(`\\b(?:ask|check (?:in )?(?:on|with)|chase|follow up with|nudge|remind|ping|tell)\\s+(?:${names.join("|")})\\b|\\bdo it yourself\\b`, "i");
    if (parts.some((p) => chase.test(p))) {
      return { rule: "CHASE_STAFF", why: "Chasing a colleague is our job, never a partner's. Hand the card to them yourself with assign." };
    }
  }
  if (parts.some((p) => MANUAL_STEP.test(p))) {
    return {
      rule: "MANUAL_STEP",
      why: "A manual step (forward, paste, click, run, add a record) is a task, and tasks are not hers. Do it with this card's actions, or hand it to the seat that can.",
    };
  }
  return null;
}
