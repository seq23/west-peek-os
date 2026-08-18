/**
 * The sponsor boundary (docs/COMMUNITY.md).
 *
 *   "Sponsors support experiences. They never purchase access to members."
 *
 * WHY THIS IS CODE AND NOT A PARAGRAPH. That sentence is the community's central promise, and it
 * will come under pressure exactly once — the week a $25,000 presenting partner asks for the
 * attendee list and the answer costs real money. A rule that lives in a document loses that
 * argument. A rule that lives in a function has to be deleted by someone, in a diff, on purpose.
 *
 * WHAT THE RULE IS NOT. It is not "sponsors may not meet members". Every ask in the pilot puts a
 * sponsor's person in the room — the AWS startup specialist, the Ramp finance operator, the lawyer
 * participating as a problem solver. That is the product. Reading the rule as no-contact would
 * gut the Room to protect a principle the Room does not violate.
 *
 * WHAT THE RULE IS. No member data leaves West Peek. No attendee list, no export, no post-event
 * contact file, no "here are the twelve founders you should follow up with". The sponsor's person
 * meets whoever they meet, like any other guest, and leaves with what they remember. This is the
 * line already drawn by hand in the pilot's legal ask: "no attendee-list harvesting".
 *
 * So: a sponsor may receive AGGREGATES and never IDENTITIES.
 */

/** Who a payload is being assembled for. Sponsor-facing output is the only constrained case. */
export type Audience = "INTERNAL" | "SPONSOR";

export interface PolicyViolation {
  /** Machine-readable so a caller can branch; a person still needs the detail. */
  code:
    | "member_name"
    | "member_email"
    | "person_id"
    | "attendee_list"
    | "export_forbidden";
  detail: string;
}

/** The identity fields the boundary protects. Held as a record so a caller can pass what it has. */
export interface MemberIdentity {
  personId?: string | null;
  displayName?: string | null;
  email?: string | null;
}

/**
 * The ONLY shape that may be sent to a sponsor.
 *
 * Deliberately not `Partial<Event>` or a filtered attendee array. A shape built by removing fields
 * leaks the day someone adds a field upstream and forgets the filter; a shape built by naming the
 * permitted fields cannot. Everything here is either West Peek's own copy or a count.
 */
export interface SponsorRecap {
  eventTitle: string;
  eventDate: string | null;
  /** How many came. Never who. */
  attendeeCount: number;
  /** e.g. { FOUNDER: 12, LP: 3 }. A mix is useful to a sponsor and identifies nobody. */
  roleMix: Record<string, number>;
  /** Themes discussed, written by West Peek — not quotes attributable to a member. */
  themes: string[];
  /** Room photography, which the venue and West Peek own. */
  photoUrls: string[];
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** A person id in this system is `per_…`; a member overlay row is `com_…`. Either identifies. */
const ID_RE = /\b(?:per|com)_[A-Za-z0-9-]{6,}\b/;

/**
 * Aggregate a roster into the sponsor-safe mix.
 *
 * Small-count suppression is deliberate. "LP: 1" at a Room with one LP present names that person to
 * anyone who was there, which is most of the point of a curated Room. Roles below the floor are
 * folded into OTHER rather than dropped, so the counts still sum to the total.
 */
export const SMALL_COUNT_FLOOR = 3;

export function buildRoleMix(
  roles: readonly string[],
  floor: number = SMALL_COUNT_FLOOR,
): Record<string, number> {
  const raw = new Map<string, number>();
  for (const role of roles) raw.set(role, (raw.get(role) ?? 0) + 1);

  const mix: Record<string, number> = {};
  let folded = 0;
  for (const [role, count] of raw) {
    if (count < floor) folded += count;
    else mix[role] = count;
  }
  if (folded > 0) mix.OTHER = (mix.OTHER ?? 0) + folded;
  return mix;
}

export function buildSponsorRecap(input: {
  eventTitle: string;
  eventDate: string | null;
  attendeeRoles: readonly string[];
  themes?: readonly string[];
  photoUrls?: readonly string[];
}): SponsorRecap {
  return {
    eventTitle: input.eventTitle,
    eventDate: input.eventDate,
    attendeeCount: input.attendeeRoles.length,
    roleMix: buildRoleMix(input.attendeeRoles),
    themes: [...(input.themes ?? [])],
    photoUrls: [...(input.photoUrls ?? [])],
  };
}

/**
 * Scan an outbound payload for member identity.
 *
 * The belt to buildSponsorRecap's braces. A recap built by the function above is safe by
 * construction, but sponsor-facing text also gets written by people and by models — a thank-you
 * note, a wrap report, a proposal for next year's Room — and any of those can quote a member by
 * name without anyone intending a policy breach. This catches it before it leaves.
 *
 * Matching on known member names rather than on "looks like a name" is on purpose: a generic
 * name detector would flag the sponsor's own staff, the venue, and the city.
 */
export function checkSponsorPayload(
  payload: unknown,
  members: readonly MemberIdentity[] = [],
): PolicyViolation[] {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  const violations: PolicyViolation[] = [];

  const email = text.match(EMAIL_RE);
  if (email) {
    violations.push({ code: "member_email", detail: `payload contains an email address: ${email[0]}` });
  }

  const id = text.match(ID_RE);
  if (id) {
    violations.push({ code: "person_id", detail: `payload contains a person or member id: ${id[0]}` });
  }

  const haystack = text.toLowerCase();
  for (const member of members) {
    const name = member.displayName?.trim();
    // Two characters would match inside ordinary words; a full name is what actually leaks.
    if (name && name.length >= 3 && haystack.includes(name.toLowerCase())) {
      violations.push({ code: "member_name", detail: `payload names a member: ${name}` });
    }
    const memberEmail = member.email?.trim().toLowerCase();
    if (memberEmail && haystack.includes(memberEmail)) {
      violations.push({ code: "member_email", detail: `payload contains a member email: ${memberEmail}` });
    }
  }

  return violations;
}

/**
 * There is no sponsor-facing attendee export, and there is no flag to turn one on.
 *
 * Written as a function returning a violation rather than as an `if` at each call site, so the
 * refusal is one thing to find and one thing to test.
 */
export function canExportAttendees(audience: Audience): PolicyViolation | null {
  if (audience === "SPONSOR") {
    return {
      code: "export_forbidden",
      detail:
        "Attendee lists are never shared with a sponsor. A sponsor receives aggregate counts " +
        "(buildSponsorRecap). See docs/COMMUNITY.md — sponsors support experiences, they do not " +
        "purchase access to members.",
    };
  }
  return null;
}

/** Convenience for a service: throwable summary, or null when the payload is clean. */
export function sponsorPolicyFailure(
  audience: Audience,
  payload: unknown,
  members: readonly MemberIdentity[] = [],
): string | null {
  if (audience !== "SPONSOR") return null;
  const violations = checkSponsorPayload(payload, members);
  if (violations.length === 0) return null;
  return violations.map((v) => v.detail).join("; ");
}
