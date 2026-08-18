/**
 * Community acts and Council evidence (docs/COMMUNITY.md).
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID. The Council "is not an application, it is not based on
 * status, it emerges naturally from consistent participation". Every software instinct answers that
 * with a member `stage` column and a participation score. Both are wrong here, and wrong in a way
 * that is hard to walk back:
 *
 *   - A stage column makes the majority look stalled. The document says most members stay in the
 *     broad mastermind forever and that this is INTENTIONAL. Give them a stage and someone will
 *     compute a conversion rate to Council, which manufactures exactly the status ladder the
 *     Council is defined as not being.
 *   - A score turns generosity into a leaderboard. People optimise a visible number, and the
 *     behaviour that scores well is not the behaviour the Council is selecting for.
 *
 * SO: this module records what happened and groups it. It does not rank, total, weight or predict.
 * `summariseEvidence` returns counts and dates for a human to read. There is a test asserting no
 * numeric score field appears in its output, which will fail the day someone adds one — that
 * failure is the point, and its message says so.
 *
 * WHAT COUNTS AS AN ACT. Only what West Peek witnessed. A member promising another member an
 * introduction is between those two members (operator, 17 Aug 2026); the OS does not watch
 * interactions West Peek is not part of. "Follow-through" therefore means follow-through on a
 * commitment made TO West Peek — agreed to host, agreed to speak, agreed to bring three people.
 */

export const ACT_KINDS = [
  /** Came to a Room, Mastermind or Office session. */
  "ATTENDED",
  /** Ran a Room or a breakout table. The strongest single signal of investment in the community. */
  "HOSTED",
  /** Spoke or presented. */
  "SPOKE",
  /** Put a real problem to the room. Generosity cuts both ways — asking well helps others too. */
  "ASKED_QUESTION",
  /** Answered someone else's problem. */
  "ANSWERED_QUESTION",
  /** Made an introduction WITH West Peek's knowledge — at a Room, or via a match we proposed. */
  "MADE_INTRODUCTION",
  /** Referred a new member who was accepted. */
  "REFERRED_MEMBER",
  /** Brought a guest to a Room. */
  "BROUGHT_GUEST",
  /** Did the thing they told West Peek they would do. */
  "KEPT_COMMITMENT",
  /** Did not. Recorded because follow-through is a named Council signal and half a signal lies. */
  "MISSED_COMMITMENT",
] as const;

export type ActKind = (typeof ACT_KINDS)[number];

/**
 * Where the record came from.
 *
 * Carried from the first migration even though only three values are reachable today. Where the
 * continuous community eventually lives is undecided, and possibly a white-labelled platform. When
 * that arrives, an act arriving from it is the same row with a different source — an adapter rather
 * than a rewrite. Adding the column later would mean backfilling every existing row with a guess.
 */
export const ACT_SOURCES = [
  /** A partner recorded it by hand. */
  "PARTNER_ENTRY",
  /** Fell out of an event close-out. */
  "EVENT_CLOSEOUT",
  /** Came from the structured part of a Mastermind — submissions and answers. */
  "MASTERMIND",
  /** A future member-facing surface. Nothing writes this yet. */
  "PLATFORM",
] as const;

export type ActSource = (typeof ACT_SOURCES)[number];

export interface CommunityAct {
  id: string;
  personId: string;
  kind: ActKind;
  source: ActSource;
  /** ISO date. */
  occurredAt: string;
  /** The Room, Mastermind or Office session this happened at, when there was one. */
  eventId?: string | null;
  /** Free text a partner can read. Never parsed. */
  note?: string | null;
}

/**
 * Grouped evidence for one member.
 *
 * Every field is either a count, a date or a list. Nothing here is comparable between two members
 * except by a person deciding to compare them, which is the only comparison the model allows.
 */
export interface CouncilEvidence {
  personId: string;
  /** When we first saw them do anything. Tenure is context, not credit. */
  firstActAt: string | null;
  lastActAt: string | null;
  /** Distinct gatherings they showed up to. Turning up repeatedly is the "consistent" in the doc. */
  distinctEvents: number;
  /** Counts by kind, most frequent first, each with the date it last happened. */
  byKind: Array<{ kind: ActKind; count: number; lastAt: string }>;
  /** Kinds with no acts, so a reader sees absence rather than inferring it from a missing row. */
  absent: ActKind[];
  totalActs: number;
}

function isoMax(a: string | null, b: string): string {
  return a === null || b > a ? b : a;
}

/**
 * Group a member's acts for a human to read.
 *
 * `totalActs` is a count of rows, not a score: it is not weighted, and a MISSED_COMMITMENT
 * increments it exactly like a HOSTED does. It is there so a reader knows whether they are looking
 * at four data points or four hundred. Any future temptation to weight these belongs in a partner's
 * head, where the document puts it.
 */
export function summariseEvidence(
  personId: string,
  acts: readonly CommunityAct[],
): CouncilEvidence {
  const mine = acts.filter((a) => a.personId === personId);

  const counts = new Map<ActKind, { count: number; lastAt: string }>();
  const events = new Set<string>();
  let firstActAt: string | null = null;
  let lastActAt: string | null = null;

  for (const act of mine) {
    const existing = counts.get(act.kind);
    counts.set(act.kind, {
      count: (existing?.count ?? 0) + 1,
      lastAt: existing ? isoMax(existing.lastAt, act.occurredAt) : act.occurredAt,
    });
    if (act.eventId) events.add(act.eventId);
    if (firstActAt === null || act.occurredAt < firstActAt) firstActAt = act.occurredAt;
    lastActAt = isoMax(lastActAt, act.occurredAt);
  }

  const byKind = [...counts.entries()]
    .map(([kind, v]) => ({ kind, count: v.count, lastAt: v.lastAt }))
    // Frequency first, then alphabetical so the order is stable for a snapshot test.
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

  return {
    personId,
    firstActAt,
    lastActAt,
    distinctEvents: events.size,
    byKind,
    absent: ACT_KINDS.filter((k) => !counts.has(k)),
    totalActs: mine.length,
  };
}

/**
 * A one-line, unranked description for a list view.
 *
 * Reads like something a colleague would say — "hosted twice, answered 6, 11 gatherings since
 * Mar 2027" — rather than "score 84". If there is nothing to say, it says that instead of showing
 * a zero, because a zero next to other members' numbers is a ranking with extra steps.
 */
export function describeEvidence(evidence: CouncilEvidence): string {
  if (evidence.totalActs === 0) return "no recorded participation yet";

  const label: Partial<Record<ActKind, (n: number) => string>> = {
    HOSTED: (n) => (n === 1 ? "hosted once" : `hosted ${n}×`),
    SPOKE: (n) => `spoke ${n}×`,
    ANSWERED_QUESTION: (n) => `answered ${n}`,
    MADE_INTRODUCTION: (n) => (n === 1 ? "1 introduction" : `${n} introductions`),
    REFERRED_MEMBER: (n) => (n === 1 ? "referred 1 member" : `referred ${n} members`),
    BROUGHT_GUEST: (n) => (n === 1 ? "brought 1 guest" : `brought ${n} guests`),
    MISSED_COMMITMENT: (n) => (n === 1 ? "1 missed commitment" : `${n} missed commitments`),
  };

  const parts = evidence.byKind
    .map(({ kind, count }) => label[kind]?.(count))
    .filter((s): s is string => Boolean(s));

  if (evidence.distinctEvents > 0) {
    parts.push(`${evidence.distinctEvents} gathering${evidence.distinctEvents === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(", ") : `${evidence.totalActs} recorded`;
}

/**
 * Council membership is a human decision recorded as a flag, with a reason.
 *
 * No threshold, no eligibility check, no "ready for Council" queue. Those would each be a score
 * wearing a different hat. The evidence is assembled; the judgement stays with a partner.
 */
export interface CouncilDecision {
  personId: string;
  inCouncil: boolean;
  /** Why. Required — an unexplained flag is unreviewable a year later. */
  reason: string;
  decidedBy: string;
  decidedAt: string;
}

export function validateCouncilDecision(
  input: Partial<CouncilDecision>,
): { ok: true } | { ok: false; error: string } {
  if (!input.personId) return { ok: false, error: "personId is required" };
  if (typeof input.inCouncil !== "boolean") return { ok: false, error: "inCouncil must be true or false" };
  if (!input.reason || input.reason.trim().length < 10) {
    return { ok: false, error: "a reason of at least 10 characters is required — an unexplained Council flag cannot be reviewed later" };
  }
  if (!input.decidedBy) return { ok: false, error: "decidedBy is required" };
  return { ok: true };
}
