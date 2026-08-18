import { HUMAN_RESERVED_ACTION_KEYS } from "../registry/reservedActions";
import { EXTERNAL_EFFECT_ACTION_TYPES } from "../registry/actionTypes";

/**
 * How risky an approval is, derived from what it does (P47, canon §24.2).
 *
 * DERIVED, NEVER TYPED. If risk were a field on the request, the requester would set it — and the
 * requester is often an AI employee with an interest in a fast approval. Deriving it from the
 * action key means an external send is HIGH whoever raised it, and nobody can mark their own
 * request low to get a lighter look.
 *
 * The point of the classification is triage. An approver with fourteen pending cards needs to know
 * which three could actually hurt, and a queue where everything looks equally important is a queue
 * that gets cleared rather than read.
 */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "RESERVED";

const EXTERNAL_KEYS = new Set(EXTERNAL_EFFECT_ACTION_TYPES.map((a) => a.key));
const RESERVED_KEYS = new Set(HUMAN_RESERVED_ACTION_KEYS);

/** Money, legal exposure, or an irreversible commitment — high whatever else is true. */
const HIGH_SIGNALS = /\b(wire|payment|capital_call|distribution|invest|allocat|writeback|delete|revoke|terminate)\b/i;

export interface RiskAssessment {
  level: RiskLevel;
  /** Why, in the approver's terms. Shown on the card. */
  reason: string;
}

export function assessRisk(actionKey: string): RiskAssessment {
  // Human-reserved is its own tier, above HIGH: canon reserved these because a machine must never
  // do them at all, which is a stronger statement than "this is risky".
  if (RESERVED_KEYS.has(actionKey)) {
    return { level: "RESERVED", reason: "Human-reserved: this action can only ever be taken by a person." };
  }
  if (EXTERNAL_KEYS.has(actionKey)) {
    return { level: "HIGH", reason: "Leaves the firm. Once sent it cannot be unsent." };
  }
  if (HIGH_SIGNALS.test(actionKey)) {
    return { level: "HIGH", reason: "Moves money or makes a commitment that is hard to reverse." };
  }
  if (/\b(approve|decide|promote|publish|merge|resolve)\b/i.test(actionKey)) {
    return { level: "MEDIUM", reason: "Changes the firm's record of what is true." };
  }
  return { level: "LOW", reason: "Internal and reversible." };
}

/** Which role should look at this first. Advisory — it never restricts who may decide. */
export function recommendApprover(actionKey: string, requiredRoles: readonly string[]): string {
  if (requiredRoles.length === 1) return requiredRoles[0]!;
  const risk = assessRisk(actionKey);
  if (risk.level === "RESERVED" || risk.level === "HIGH") return "MANAGING_PARTNER";
  return requiredRoles[0] ?? "MANAGING_PARTNER";
}

/** How long before a card goes stale. Riskier things should be looked at sooner. */
export function expiryHours(level: RiskLevel): number {
  switch (level) {
    case "RESERVED": return 72;
    case "HIGH": return 48;
    case "MEDIUM": return 120;
    case "LOW": return 336;
  }
}

/**
 * Stale means "look at this, it has been sitting", never "it has been decided".
 *
 * Auto-approving on expiry would let silence approve an external send; auto-rejecting would let
 * silence kill a deal. Both are the system taking a decision it has no authority to take.
 */
export function isStale(expiresAt: string | null | undefined, now: Date): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t < now.getTime();
}

/** Order a queue so the things that can hurt are read first. */
export function queueRank(level: string): number {
  return ({ RESERVED: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNCLASSIFIED: 4 } as Record<string, number>)[level] ?? 4;
}
