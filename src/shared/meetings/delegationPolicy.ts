/**
 * Who ends up holding a deliverable that came out of a meeting (P33).
 *
 * The operator's direction, 17 Aug 2026: "Walter to assign only to AI employees, with human tasks
 * proposed as recommended... but the default is to get the AI employees to do everything."
 *
 * That is a policy, not a preference, so it lives here as pure functions the service and the tests
 * both read — rather than as prompt wording the model may or may not honour on any given run. The
 * model PROPOSES; this module DECIDES. A model that returns `assignee_kind: "HUMAN_RECOMMENDED"`
 * for everything cannot quietly turn the firm's default upside down, because normalise() is what
 * actually writes the row.
 */

export type AssigneeKind = "AI_EMPLOYEE" | "AI_WITH_HUMAN_TOUCH" | "HUMAN_RECOMMENDED" | "UNASSIGNED";
export type OwnerSide = "FIRM" | "COUNTERPARTY";

/** One deliverable as the model proposed it, before policy is applied. */
export interface ProposedCommitment {
  commitment_text: string;
  owner_side: OwnerSide;
  due_date?: string | null;
  source_quote?: string | null;
  /** The model's suggestion. Advisory — normalise() may override it. */
  assignee_kind?: string | null;
  /** Roster NAME the model suggested (not an id — the model does not know ids). */
  suggested_employee_name?: string | null;
  human_touch_reason?: string | null;
}

/** The same deliverable after policy, ready to write. */
export interface ResolvedCommitment {
  commitment_text: string;
  owner_side: OwnerSide;
  due_date: string | null;
  source_quote: string | null;
  assignee_kind: AssigneeKind;
  ai_employee_id: string | null;
  human_touch_reason: string | null;
}

/**
 * Work only a person can do — the narrow exception to "AI does everything".
 *
 * Deliberately short. Every entry is something where an AI employee doing it would be either
 * impossible (signing) or a misrepresentation (a partner's personal relationship call). The
 * temptation is to grow this list until the default inverts; resist it. If an AI employee can
 * draft it, prepare it, or queue it for one click, that is AI_WITH_HUMAN_TOUCH — not human work.
 */
const HUMAN_ONLY_SIGNALS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(sign|countersign|execute)\b.{0,24}\b(doc|agreement|term sheet|contract|nda|safe)\b/i,
    reason: "Signing binds the firm — a person has to do it." },
  { pattern: /\bwire\b|\bsend (the )?funds\b|\bcapital call\b/i,
    reason: "Moving money is a human-reserved action." },
  { pattern: /\b(personally|partner)\b.{0,20}\b(call|reach out|speak|meet)\b/i,
    reason: "Asked for personally — the relationship is the point." },
  { pattern: /\b(decide|decision|approve)\b.{0,24}\b(invest|pass|allocat|check size|valuation)\b/i,
    reason: "An investment decision is the partners' to make." },
];

/**
 * Work an AI employee owns but where a human should show up somewhere in it.
 * Distinct from the above: the task still gets DONE by an employee, and gets assigned.
 */
const HUMAN_TOUCH_SIGNALS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(intro|introduction|connect)\b/i,
    reason: "Drafted by the employee; the introduction should come from you." },
  { pattern: /\b(founder|ceo)\b.{0,30}\b(email|message|reply|respond|follow up)\b/i,
    reason: "Prepared for you — a founder should hear from a person." },
  { pattern: /\b(lp|limited partner)\b/i,
    reason: "LP-facing: prepared internally, sent by you." },
  { pattern: /\b(reference|backchannel)s?\b.{0,20}\b(calls?|checks?)\b/i,
    reason: "Employee assembles the list and questions; the call is yours." },
];

/** Does this text describe something no AI employee should be handed? */
export function humanOnlyReason(text: string): string | null {
  return HUMAN_ONLY_SIGNALS.find((s) => s.pattern.test(text))?.reason ?? null;
}

/** Does this text want a human in the loop, while still being AI-owned? */
export function humanTouchReason(text: string): string | null {
  return HUMAN_TOUCH_SIGNALS.find((s) => s.pattern.test(text))?.reason ?? null;
}

export interface RosterEntry {
  id: string;
  name: string;
  role: string;
  status: string;
}

/**
 * Apply policy to one proposal.
 *
 * `roster` must already be filtered to ACTIVE employees — seating and assignment both require
 * ACTIVE, and passing the full roster here would let a paused employee be handed work.
 */
export function resolveAssignment(
  proposal: ProposedCommitment,
  roster: readonly RosterEntry[],
  fallback: RosterEntry | null,
): ResolvedCommitment {
  const base = {
    commitment_text: proposal.commitment_text.trim(),
    owner_side: proposal.owner_side,
    due_date: proposal.due_date?.trim() || null,
    source_quote: proposal.source_quote?.trim() || null,
  };

  // What the counterparty promised is tracked, never assigned. Turning "the founder will send
  // their deck" into a task for one of our employees is how a follow-up list becomes fiction.
  if (proposal.owner_side === "COUNTERPARTY") {
    return { ...base, assignee_kind: "UNASSIGNED", ai_employee_id: null, human_touch_reason: null };
  }

  const text = base.commitment_text;

  const humanOnly = humanOnlyReason(text);
  if (humanOnly) {
    // PROPOSED, not assigned: no ai_employee_id, and the operator has to accept it.
    return { ...base, assignee_kind: "HUMAN_RECOMMENDED", ai_employee_id: null, human_touch_reason: humanOnly };
  }

  const named = proposal.suggested_employee_name
    ? roster.find((r) => r.name.toLowerCase() === proposal.suggested_employee_name!.trim().toLowerCase()) ?? null
    : null;
  const owner = named ?? fallback;

  // No active employee to hand it to. Left UNASSIGNED and visible rather than invented — an
  // assignment to nobody that reads as assigned is worse than an honest gap.
  if (!owner) {
    return {
      ...base,
      assignee_kind: "UNASSIGNED",
      ai_employee_id: null,
      human_touch_reason: "No active AI employee was available to take this.",
    };
  }

  const touch = humanTouchReason(text) ?? (proposal.human_touch_reason?.trim() || null);
  return {
    ...base,
    assignee_kind: touch ? "AI_WITH_HUMAN_TOUCH" : "AI_EMPLOYEE",
    ai_employee_id: owner.id,
    human_touch_reason: touch,
  };
}

/** True when this kind results in a work card being created at conversion time. */
export function isAssigned(kind: AssigneeKind): boolean {
  return kind === "AI_EMPLOYEE" || kind === "AI_WITH_HUMAN_TOUCH";
}

/** Human-readable one-liner for the digest and the UI. */
export function assignmentLabel(kind: AssigneeKind): string {
  switch (kind) {
    case "AI_EMPLOYEE": return "Assigned";
    case "AI_WITH_HUMAN_TOUCH": return "Assigned · your input wanted";
    case "HUMAN_RECOMMENDED": return "Recommended for you";
    case "UNASSIGNED": return "Unassigned";
  }
}
