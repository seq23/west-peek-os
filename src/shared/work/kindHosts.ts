import { AI_EMPLOYEE_ROSTER } from "../registry/aiEmployees";

/**
 * Who owns each work-card KIND (Addendum 12, 22 Sep 2026).
 *
 * `src/shared/help/pageHosts.ts` already does this for a PAGE — "every surface has somebody
 * responsible for it". Her question was the same shape applied to a card: "each page has someone
 * who can answer questions about it" — shouldn't a `WEB_PROPERTY_CHANGE` question try Porter before
 * it tries her? Checked against the real code first (not assumed): `PORTER_NAME`/`PORTER_ID` are
 * already hardcoded constants in `services/webPropertyChange.ts`, and the sweep
 * (`workSweep.ts`'s dispatch on `card.kind`) already routes every card of this kind to Porter's own
 * runner. That is kind-ownership, already true and already load-bearing — just never written down
 * as a fact a second caller could read. This registry is that fact, written down once.
 *
 * WHY A SEPARATE REGISTRY FROM `pageHosts.ts` RATHER THAN ONE MERGED TABLE. A page and a work-card
 * kind are different keyspaces (nav keys vs `work_card.kind` values) that happen to overlap in
 * spirit, not in identity — `pageHosts.ts`'s own test reads nav keys out of `App.tsx`, which a kind
 * has no relationship to. Folding them into one table would make an unrelated key collision
 * (a nav key and a kind sharing a string) silently mean something neither author intended.
 *
 * MINIMAL ON PURPOSE. Only kinds with one true, fixed AI-employee owner belong here.
 * `WEB_PROPERTY_CHANGE` is the only kind with that property today — `ARTIFACT` and `BLOG_HELP`
 * cards are each owned per-card via `work_card.owner_id` (whoever the partner asked, or `steerFor`
 * resolved), with no single fixed seat; inventing a kind-level entry for those would just be wrong
 * more often than it was right. Add an entry here only when a kind genuinely has one fixed owner,
 * the same discipline `pageHosts.ts` already holds pages to.
 */

export interface KindHost {
  /** A roster name — the "someone who owns this" the operator described. */
  employee: string;
  /** Why this seat owns this kind, in the operator's language. */
  because: string;
}

export const KIND_HOSTS: Readonly<Record<string, KindHost>> = {
  WEB_PROPERTY_CHANGE: {
    employee: "Porter",
    because: "Systems-of-record discipline across intake, sync and pipelines — every web property change is his to run, end to end.",
  },
};

export interface ResolvedKindHost {
  name: string;
  role: string;
  because: string;
}

function rosterEntry(name: string) {
  return AI_EMPLOYEE_ROSTER.find((e) => e.name === name) ?? null;
}

/** The registered owner of a kind, resolved against the roster. Null when nobody is registered. */
export function kindHost(kind: string | null | undefined): ResolvedKindHost | null {
  if (!kind) return null;
  const assigned = KIND_HOSTS[kind];
  if (!assigned) return null;
  const entry = rosterEntry(assigned.employee);
  if (!entry) return null;
  return { name: entry.name, role: entry.role, because: assigned.because };
}
