import type { Env } from "../env";
import type { FirmUserIdentity } from "../auth";
import { PRIVACY_LABELS, type PrivacyLabel } from "../../shared/privacy";

/**
 * authorize() — THE authorization choke point (governing law, P3).
 *
 * Every human-reserved action and every external effect passes through here.
 * Fail closed: unknown action keys, missing roles, cross-firm-scope access, and
 * invalid/absent receipts all resolve to DENY or REQUIRE_APPROVAL — never ALLOW.
 *
 * Decision vocabulary:
 * - ALLOW            — ordinary internal action by an actor inside firm scope,
 *                      or a reserved/external action backed by a valid approved receipt.
 * - REQUIRE_APPROVAL — the actor may perform this only after an approval_card is
 *                      approved by a human holding a required approver role.
 * - DENY             — the actor may never perform this (AI/SYSTEM on reserved
 *                      actions, missing approver role, unknown action, cross-scope).
 *
 * Receipt semantics: an authorization receipt is an approval_card in state
 * 'approved' whose action_key and object match the attempted action. Execution
 * consumes the card (approved → executed); a consumed card can never be replayed.
 */

export type ActorType = "HUMAN" | "AI" | "SYSTEM";

export interface Actor {
  type: ActorType;
  /** Firm user id — present for HUMAN actors. */
  firmUserId?: string;
  roles: string[];
  /** AI employee roster name — present for AI actors. */
  aiEmployeeId?: string;
  /**
   * Firm scopes this actor may touch (§11.7 isolation). HUMAN actors derive this
   * from authority_scope rows (scope_key='firm_scope'); absent rows default to
   * the home firm. AI/SYSTEM actors receive it from their construction context.
   */
  firmScopes: string[];
}

export interface ObjectRef {
  objectType: string;
  objectId?: string;
  firmScope?: string;
}

export interface AuthorizeContext {
  /** An approval_card id presented as an authorization receipt. */
  receiptId?: string;
}

export interface AuthorizationDecision {
  decision: "ALLOW" | "REQUIRE_APPROVAL" | "DENY";
  reason: string;
  requiredApproverRoles?: string[];
  /** The verified receipt card id when ALLOW was granted via receipt. */
  receiptId?: string;
}

export const HOME_FIRM_SCOPE = "west-peek";

const DEFAULT_REQUIRED_APPROVER_ROLES = ["MANAGING_PARTNER"];

/** Build the actor for an authenticated firm user (HTTP layer). */
export function actorFromIdentity(identity: FirmUserIdentity): Actor {
  const firmScopes = identity.authorityScopes
    .filter((s) => s.scopeKey === "firm_scope")
    .map((s) => s.scopeValue);
  return {
    type: "HUMAN",
    firmUserId: identity.id,
    roles: identity.roles,
    firmScopes: firmScopes.length > 0 ? firmScopes : [HOME_FIRM_SCOPE],
  };
}

interface ActionTypeRow {
  key: string;
  is_external_effect: number;
  is_reserved: number;
}

interface ReservedActionRow {
  key: string;
  approver_roles_json: string;
}

export interface ApprovalCardRow {
  id: string;
  action_key: string;
  object_type: string;
  object_id: string;
  title: string;
  summary: string | null;
  payload_json: string;
  requested_by_type: string;
  requested_by_id: string;
  required_approver_roles_json: string;
  state: string;
  firm_scope: string;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
}

export async function getActionType(env: Env, key: string): Promise<ActionTypeRow | null> {
  return env.WP_OS_DB.prepare("SELECT key, is_external_effect, is_reserved FROM action_type WHERE key = ?1")
    .bind(key)
    .first<ActionTypeRow>();
}

export async function getReservedAction(env: Env, key: string): Promise<ReservedActionRow | null> {
  return env.WP_OS_DB.prepare("SELECT key, approver_roles_json FROM human_reserved_action WHERE key = ?1")
    .bind(key)
    .first<ReservedActionRow>();
}

export async function getApprovalCard(env: Env, id: string): Promise<ApprovalCardRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM approval_card WHERE id = ?1").bind(id).first<ApprovalCardRow>();
}

/**
 * Who may take a RESTRICTED action directly. Absent row means the action is not restricted.
 *
 * Fails CLOSED on a malformed row: an unparseable `allowed_json` yields nobody, so a corrupted
 * restriction locks the action rather than opening it. The opposite default would turn a typo into
 * a silent grant, which is the failure this whole file exists to prevent.
 */
async function restrictionFor(env: Env, actionKey: string): Promise<{ roles: string[]; employees: string[] } | null> {
  const row = await env.WP_OS_DB.prepare("SELECT allowed_json FROM restricted_action WHERE key = ?1")
    .bind(actionKey)
    .first<{ allowed_json: string }>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.allowed_json) as { roles?: string[]; employees?: string[] };
    return { roles: parsed.roles ?? [], employees: parsed.employees ?? [] };
  } catch {
    return { roles: [], employees: [] };
  }
}

/** Required approver roles for an action key (reserved register, else MP default). */
export async function requiredApproverRolesFor(env: Env, actionKey: string): Promise<string[]> {
  const reserved = await getReservedAction(env, actionKey);
  if (reserved) return JSON.parse(reserved.approver_roles_json) as string[];
  return DEFAULT_REQUIRED_APPROVER_ROLES;
}

/** Roles currently held by a firm user. */
async function rolesOfFirmUser(env: Env, firmUserId: string): Promise<string[]> {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT r.key AS key
       FROM firm_user_role fur
       JOIN role r ON r.id = fur.role_id
      WHERE fur.firm_user_id = ?1`,
  )
    .bind(firmUserId)
    .all<{ key: string }>();
  return (rows.results ?? []).map((r) => r.key);
}

export interface ReceiptVerification {
  ok: boolean;
  reason: string;
  card?: ApprovalCardRow;
}

/**
 * Verify an authorization receipt: an approval_card that is
 * - in state 'approved' (a consumed card has moved to 'executed' → replay refused),
 * - for the exact action_key being attempted,
 * - for the exact object (object_type + object_id) being acted on,
 * - decided by a HUMAN firm user who holds a required approver role (re-checked
 *   at verification time, so a later role revocation invalidates the receipt).
 */
export async function verifyAuthorizationReceipt(
  env: Env,
  receiptId: string,
  actionKey: string,
  objectRef: ObjectRef,
): Promise<ReceiptVerification> {
  const card = await getApprovalCard(env, receiptId);
  if (!card) return { ok: false, reason: "receipt_not_found" };
  if (card.state !== "approved") {
    return { ok: false, reason: card.state === "executed" ? "receipt_already_consumed" : `receipt_not_approved:${card.state}` };
  }
  if (card.action_key !== actionKey) {
    return { ok: false, reason: `receipt_action_mismatch:${card.action_key}` };
  }
  if (card.object_type !== objectRef.objectType || (objectRef.objectId !== undefined && card.object_id !== objectRef.objectId)) {
    return { ok: false, reason: "receipt_object_mismatch" };
  }
  if (!card.decided_by) return { ok: false, reason: "receipt_missing_decider" };
  const required = JSON.parse(card.required_approver_roles_json) as string[];
  const approverRoles = await rolesOfFirmUser(env, card.decided_by);
  if (!required.some((r) => approverRoles.includes(r))) {
    return { ok: false, reason: "receipt_approver_lacks_required_role" };
  }
  return { ok: true, reason: "receipt_valid", card };
}

/**
 * The choke point. See module docstring for the decision vocabulary.
 */
export async function authorize(
  env: Env,
  actor: Actor,
  actionKey: string,
  objectRef: ObjectRef,
  context: AuthorizeContext = {},
): Promise<AuthorizationDecision> {
  // Unknown action → DENY (fail closed).
  const action = await getActionType(env, actionKey);
  if (!action) return { decision: "DENY", reason: "unknown_action" };

  // Firm isolation (§11.7): enforced here, never by UI hiding.
  const objectScope = objectRef.firmScope ?? HOME_FIRM_SCOPE;
  if (!actor.firmScopes.includes(objectScope)) {
    return { decision: "DENY", reason: "cross_firm_scope" };
  }

  const requiredRoles = await requiredApproverRolesFor(env, actionKey);

  // Receipts authorize both reserved actions and external effects.
  if (action.is_reserved === 1 || action.is_external_effect === 1) {
    if (context.receiptId) {
      const receipt = await verifyAuthorizationReceipt(env, context.receiptId, actionKey, objectRef);
      if (receipt.ok) return { decision: "ALLOW", reason: "approved_receipt", receiptId: context.receiptId };
      // An invalid receipt on a reserved action for a role-less actor is still DENY;
      // otherwise the actor is told (again) that approval is required.
      if (action.is_reserved === 1 && actor.type !== "HUMAN") {
        return { decision: "DENY", reason: `reserved_action_ai_actor (receipt invalid: ${receipt.reason})` };
      }
      if (action.is_reserved === 1 && !requiredRoles.some((r) => actor.roles.includes(r))) {
        return { decision: "DENY", reason: `missing_required_role (receipt invalid: ${receipt.reason})` };
      }
      return {
        decision: "REQUIRE_APPROVAL",
        reason: `invalid_receipt:${receipt.reason}`,
        requiredApproverRoles: requiredRoles,
      };
    }
  }

  // Human-reserved actions: never for AI/SYSTEM; humans need the approver role,
  // and even then the action executes only behind an approved approval card.
  if (action.is_reserved === 1) {
    if (actor.type !== "HUMAN") return { decision: "DENY", reason: "reserved_action_ai_actor" };
    if (!requiredRoles.some((r) => actor.roles.includes(r))) {
      return { decision: "DENY", reason: "missing_required_role", requiredApproverRoles: requiredRoles };
    }
    return { decision: "REQUIRE_APPROVAL", reason: "reserved_action_requires_approval", requiredApproverRoles: requiredRoles };
  }

  // External effects: approval for EVERY actor; AI/SYSTEM can never self-approve
  // (decisions are human-only — enforced in services/approvals.ts).
  if (action.is_external_effect === 1) {
    return { decision: "REQUIRE_APPROVAL", reason: "external_effect_requires_approval", requiredApproverRoles: requiredRoles };
  }

  /*
   * RESTRICTED: role-gated, not approval-gated. The tier that was missing.
   *
   * Operator, 21 Aug 2026, on who may edit a company: "the MPs should be able to edit and the host
   * employee and maybe investment lead?" Reserved could not express that — reserved raises an
   * approval card per action, and a card for every spelling correction is how an approval queue
   * becomes unreadable and then ignored. Ordinary could not express it either: its last line hands
   * the action to any authenticated identity in firm scope, service accounts included.
   *
   * Named roles and named employees act immediately; everyone else is refused with the list, so the
   * refusal tells you who to ask rather than only that you may not. Checked BEFORE the ordinary
   * fallthrough and after reserved, which is exactly where it sits in strictness.
   */
  const restricted = await restrictionFor(env, actionKey);
  if (restricted) {
    const byRole = restricted.roles.some((r) => actor.roles.includes(r));
    const byName = actor.aiEmployeeId ? restricted.employees.includes(actor.aiEmployeeId) : false;
    if (!byRole && !byName) {
      return {
        decision: "DENY",
        reason: "not_permitted_to_act",
        requiredApproverRoles: restricted.roles,
      };
    }
    return { decision: "ALLOW", reason: "restricted_action_permitted" };
  }

  // Ordinary internal action: allowed for any actor inside firm scope.
  return { decision: "ALLOW", reason: "ordinary_internal_action" };
}

// ── Privacy-label visibility (captures, work cards) ──

/** Labels gated behind MP role or an explicit privacy_label authority scope. */
export const SENSITIVE_PRIVACY_LABELS: readonly PrivacyLabel[] = [
  "RESTRICTED",
  "LP_PRIVATE",
  "MNPI_SENSITIVE",
  "BANKING_RESTRICTED",
];

export function canAccessPrivacyLabel(identity: FirmUserIdentity, label: string): boolean {
  if (!(SENSITIVE_PRIVACY_LABELS as readonly string[]).includes(label)) return true;
  if (identity.roles.includes("MANAGING_PARTNER")) return true;
  return identity.authorityScopes.some((s) => s.scopeKey === "privacy_label" && s.scopeValue === label);
}

/**
 * SQL fragment restricting a query to rows the identity may see. Labels come from
 * the fixed PRIVACY_LABELS constant, so inlining them as quoted literals is safe.
 */
export function privacyVisibilityClause(identity: FirmUserIdentity, column = "privacy_label"): string {
  if (identity.roles.includes("MANAGING_PARTNER")) return "1=1";
  const visible = PRIVACY_LABELS.filter((label) => canAccessPrivacyLabel(identity, label));
  return `${column} IN (${visible.map((l) => `'${l}'`).join(", ")})`;
}
