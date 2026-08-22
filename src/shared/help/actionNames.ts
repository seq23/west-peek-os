import { EXTERNAL_EFFECT_ACTION_TYPES, ORDINARY_ACTION_TYPES } from "../registry/actionTypes";
import { HUMAN_RESERVED_ACTIONS } from "../registry/reservedActions";

/**
 * What an action is CALLED, for a person deciding whether to allow it.
 *
 * THE PROBLEM THIS FIXES. Approvals is the page where a Managing Partner makes the firm's binding
 * decisions, and it rendered the schema: `effect.email.send`, `external_effect.execute`,
 * `ai_employee.activate`, requested by `HUMAN/fu_sequoia_taylor`, in state `pending_review`. Every
 * one of those has a human name already written down in the registries — the page simply never
 * joined to them. An operator reading a dotted key is decoding rather than deciding, and a decision
 * made while decoding is the one that gets rubber-stamped.
 *
 * The key is not thrown away. It stays on the card as small print, because when something goes
 * wrong the exact key is what you search for.
 *
 * WHY HERE AND NOT IN THE PAGE. Three registries hold action vocabulary — ordinary, external-effect
 * and human-reserved — and the page should not know that. One lookup, one fallback, one place to
 * fix when a name reads badly.
 */

const NAMES = new Map<string, string>();
for (const a of ORDINARY_ACTION_TYPES) NAMES.set(a.key, a.name);
for (const a of EXTERNAL_EFFECT_ACTION_TYPES) NAMES.set(a.key, a.name);

const DESCRIPTIONS = new Map<string, string>();
for (const a of ORDINARY_ACTION_TYPES) DESCRIPTIONS.set(a.key, a.description);
for (const a of EXTERNAL_EFFECT_ACTION_TYPES) DESCRIPTIONS.set(a.key, a.description);
for (const a of HUMAN_RESERVED_ACTIONS) DESCRIPTIONS.set(a.key, a.description);

/**
 * Reserved actions carry a description but no short name — the canon register names them by key.
 * Deriving a title from the key beats showing the key: `lp.capital_call.issue` becomes
 * "Lp capital call issue", which is clumsy but readable, and a clumsy sentence is a smaller failure
 * than an undecodable one. Anything that reads badly should get a real name in the registry.
 */
function derivedName(key: string): string {
  const words = key.replace(/[._]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What this action is called. Never returns a raw dotted key. */
export function actionName(key: string): string {
  return NAMES.get(key) ?? derivedName(key);
}

/** What it does, when there is room for a sentence. Empty when nothing is written down. */
export function actionDescription(key: string): string {
  return DESCRIPTIONS.get(key) ?? "";
}

/**
 * Approval states in the words a person would use.
 *
 * `pending_review` and `revise_requested` are correct as data and wrong as labels. `means` exists
 * because the states are not self-evident: the difference between "approved" and "executed" is the
 * difference between saying yes and the thing having happened, and an operator who cannot see that
 * distinction cannot tell that something is stuck.
 */
export const APPROVAL_STATE_WORDS: Readonly<Record<string, { label: string; means: string }>> = {
  drafted: { label: "Draft", means: "Written but not sent to anyone yet." },
  pending_review: { label: "Waiting on you", means: "Somebody with the right role has to decide before anything happens." },
  revise_requested: { label: "Sent back", means: "You asked for changes. It comes back here once it has been rewritten." },
  approved: { label: "Approved", means: "You said yes. The action itself has not run yet." },
  executed: { label: "Done", means: "Approved, and the action actually happened." },
  // "This is the end of it" was true when a decision could never be changed. It can now: a later
  // decision supersedes it, the original stays on the card, and saying otherwise here would send a
  // partner looking for a control the page does say they have.
  rejected: { label: "Rejected", means: "You said no. You can still change that later — the original answer stays on the record." },
  // Not a rejection, and the difference is the whole point: a rejection is a verdict on the request,
  // a block is a statement that something ELSE has to happen first. It names what, and it lifts.
  blocked: { label: "Blocked", means: "Something else has to be resolved before this can go anywhere. The card says what, and the block can be released." },
};

export function approvalStateWords(state: string): { label: string; means: string } {
  return APPROVAL_STATE_WORDS[state] ?? { label: state, means: "" };
}

/**
 * Role keys as a person would say them. `MANAGING_PARTNER` is a database value; "a Managing Partner"
 * is what you tell somebody who is being told they cannot decide something.
 *
 * Falls back to title-casing the key, so a role added later reads acceptably rather than shouting.
 */
export function roleWords(key: string): string {
  const known: Readonly<Record<string, string>> = {
    MANAGING_PARTNER: "a Managing Partner",
    INVESTMENT_TEAM: "the investment team",
    COUNSEL: "counsel",
    COMPLIANCE_OFFICER: "the compliance officer",
    FUND_ADMINISTRATOR: "the fund administrator",
    FINANCE_AUTHORITY: "the finance authority",
    ACCOUNTANT_AUDITOR: "the accountant or auditor",
    OPERATIONS: "operations",
  };
  return known[key] ?? key.toLowerCase().replace(/_/g, " ");
}

/**
 * A firm_user id as a person's name.
 *
 * The decision ledger printed `fu_sequoia_taylor` beside every approval — on the page whose entire
 * job is being the readable record of what the firm decided. The same class as Approvals rendering
 * `HUMAN/fu_sequoia_taylor`, in the one place a person is most likely to go looking years later.
 *
 * Derived from the id rather than joined, because the ledger is deliberately a flat read and adding
 * a join to it for cosmetics would be the wrong trade. `fu_sequoia_taylor` → "Sequoia Taylor"; a
 * system actor says so; anything unrecognised is returned untouched rather than mangled into a
 * name that was never there.
 */
export function actorName(actorId: string | null | undefined): string {
  const id = (actorId ?? "").trim();
  if (!id) return "unattributed";
  if (id === "system" || id.startsWith("migration:")) return `the system (${id})`;
  if (id === "fu_browser_agent") return "the firm's browser";
  const m = /^fu_(.+)$/.exec(id);
  if (!m) return id;
  return m[1]!
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
