/**
 * The event programme: what West Peek is for, how often it gathers, and what to run when.
 *
 * WHY THIS IS CODE AND NOT A PARAGRAPH IN A COMPONENT. All of it is already written down in
 * `docs/COMMUNITY.md`, which is where the operator's own words live. Restating them inside a page
 * would create a second copy that drifts the first time either is edited, and the one that drifts
 * is always the one nobody is looking at. This module is the single place the wording lives, and
 * `tests/programme.test.ts` fails if it stops matching the document.
 *
 * THE ETHOS IS LOAD-BEARING, NOT DECORATION. "We are curators and conveners, not event organisers"
 * is a constraint on what the firm will schedule: it rules out programming for its own sake, and
 * it is why the recommendations below are one per interval rather than a calendar to fill. A page
 * that shows a cadence without the stance behind it invites exactly the thing the stance forbids.
 */

/** Verbatim from docs/COMMUNITY.md, "West Peek's Role" and "Business Model". */
export const EVENT_ETHOS = {
  stance: "We are curators and conveners.",
  notThis: [
    "We are not influencers.",
    "We are not event organizers.",  // doc spelling, quoted verbatim
    "We are not constantly teaching.",
  ],
  job:
    "Make thoughtful introductions, notice talented people, create meaningful Rooms, facilitate " +
    "useful conversations, and protect the quality of the community.",
  posture: "We stay visible without becoming the centre of attention.",
  product: "Conversation — not presentations — is the product.",
  money:
    "Membership is free. Revenue comes from sponsored Rooms, ecosystem partnerships, annual summit " +
    "sponsors and hospitality partners. Sponsors support experiences. They never purchase access to members.",
} as const;

export interface Interval {
  key: string;
  /** How often, in the operator's language. */
  label: string;
  /** What runs at this interval, from the Operating Rhythm table. */
  runs: readonly string[];
  /** What this interval is FOR — the sentence in COMMUNITY.md's closing summary. */
  purpose: string;
  /**
   * What the Event Marketing Coordinator suggests running next at this interval, and why.
   * A recommendation, never a booking: nothing here schedules anything.
   */
  recommendation: string;
}

/**
 * The rhythm at full speed, from the Operating Rhythm table in docs/COMMUNITY.md.
 *
 * "At full speed" matters: this is the cadence when the community is running properly, not a
 * promise about this month. A firm with two partners and one live Room is not behind because it is
 * not yet running an annual summit — it is earlier in the sequence, and the page says so rather
 * than presenting an aspiration as a backlog.
 */
export const OPERATING_RHYTHM: readonly Interval[] = [
  {
    key: "WEEKLY",
    label: "Weekly",
    runs: ["The Office — virtual coworking, as Tap In Tuesday and Deep Work Wednesday on westpeek.live"],
    purpose: "Creates familiarity and casual interaction. Members quietly work alongside each other.",
    recommendation:
      "Keep The Office running even when attendance is thin. It is the only surface where nothing " +
      "is being asked of anyone, and that is precisely what makes people show up to the rest.",
  },
  {
    key: "MONTHLY",
    label: "Monthly",
    runs: ["Community Mastermind", "One Room, built around a single real question"],
    purpose: "The mastermind creates habit. Rooms create deeper relationships.",
    recommendation:
      "One Room a month, 25–35 people, one question worth an evening. Resist running two: the " +
      "scarcity is what makes an invitation mean something, and a half-full Room costs more " +
      "reputation than a skipped month.",
  },
  {
    key: "QUARTERLY",
    label: "Quarterly",
    runs: ["Regional hybrid gatherings", "Curated dinners", "Workshops"],
    purpose: "Extends the community beyond one city and deepens the strongest relationships.",
    recommendation:
      "A curated dinner in whichever of SF, ATL or NYC has the most members you have not seen in " +
      "person this year. Twelve people, no programme, no pitch.",
  },
  {
    key: "ANNUALLY",
    label: "Annually",
    runs: ["West Peek Community Summit", "Special Council experiences"],
    purpose: "The Council creates trust. The summit is where the community sees itself.",
    recommendation:
      "The summit is the one event worth a sponsor conversation twelve months ahead, because it is " +
      "the only one with enough lead time to be worth a real budget.",
  },
] as const;

/** Closing summary of docs/COMMUNITY.md — why the rhythm is shaped this way. */
export const WHY_THE_RHYTHM =
  "Community creates reach. Masterminds create momentum. Rooms create deeper relationships. The " +
  "Council creates trust. Together they make West Peek part of important decisions before they " +
  "become public opportunities — so instead of chasing deals, the firm becomes part of the " +
  "environment where deals are first imagined.";
