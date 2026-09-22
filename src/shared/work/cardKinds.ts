/**
 * EVERY VALUE `work_card.kind` CAN HOLD, in one place (22 Sep 2026).
 *
 * WHY THIS EXISTS. `kind` is the column that decides which runner the sweep hands a card to, and
 * until now the list of legal values existed only as string literals scattered across
 * `services/workSweep.ts`, `services/productions.ts`, `services/productionsHire.ts`,
 * `services/roomPacket.ts`, `services/deck.ts`, `services/dealIntake.ts`,
 * `services/webPropertyChange.ts` and `shared/work/localJobs.ts`. Nothing anywhere could answer
 * "what kinds are there" without a grep, so nothing could answer the question the operator
 * actually asks — "what can I start myself?"
 *
 * `validate:card-kinds` (`scripts/validate/a-kind-has-one-registry.mjs`) holds the two directions:
 * every kind the worker compares or writes is in here, and every entry in here is a kind the
 * worker really uses. A registry that drifts from the code is worse than no registry.
 *
 * ─── WHY MOST KINDS CANNOT BE STARTED BY HAND ────────────────────────────────────────────────
 *
 * A recurring kind's card is opened by its job, under a title the job composes. `duplicateOf()`
 * in `services/workCards.ts` joins a new card to a live one with the same title and owner — so a
 * hand-made "Productions press for October" would not become a second card. It would be silently
 * joined to the job's card, and the person who wrote it would see nothing happen. That is not a
 * hand door with a rough edge; it is a hand door that does not exist, and the registry says so
 * rather than letting the screen offer it.
 *
 * THE PLAIN CARD IS NOT IN HERE. A card with `kind = NULL` — "what needs doing", handed to an
 * employee — is the ordinary case and always startable by hand. This registry names the kinds that
 * carry a runner, which is exactly the set that needs the question asked.
 */

/** Which door a card of this kind comes through. */
export type CardKindDoor =
  /** An email arrives and the intake reads a kind out of it. */
  | "EMAIL"
  /** A person writes it, here or through Intent. */
  | "HAND"
  /** A scheduled job opens it on its cadence. */
  | "JOB";

export interface CardKind {
  /** The literal stored in `work_card.kind`. */
  key: string;
  /** What it is called on screen. */
  label: string;
  /** One sentence: what it does, or — when it cannot be started by hand — why not. */
  oneLine: string;
  /**
   * Whether a person can open one of these directly. FALSE for every job-opened kind: see the
   * `duplicateOf()` note above. `validate:card-kinds` derives this from `door` rather than
   * trusting the flag, so the two can never disagree.
   */
  startableByHand: boolean;
  /** What a card of this kind needs before its runner can do anything. */
  requires: string[];
  door: CardKindDoor;
}

export const CARD_KINDS: readonly CardKind[] = [
  {
    key: "WEB_PROPERTY_CHANGE",
    label: "Change a web property",
    oneLine: "Porter changes a site you own: a plan you approve, a pull request, the checks, the merge, and the live page proved.",
    startableByHand: true,
    requires: ["which property to change", "what the change is, in your words"],
    door: "EMAIL",
  },
  {
    key: "BLOG_HELP",
    label: "Blog help",
    oneLine: "Wren researches, writes the piece in the partner's voice, files it, and emails the partner who asked.",
    startableByHand: true,
    requires: ["the partner who asked", "what the piece is about"],
    door: "EMAIL",
  },
  {
    key: "ARTIFACT",
    label: "Build me something",
    oneLine: "One producer builds the thing you asked for — a one-pager, a memo, a kit — and the artifact is the deliverable.",
    startableByHand: true,
    requires: ["what to build, in words"],
    door: "HAND",
  },
  {
    key: "DECK_REWORK",
    label: "Deck rework",
    oneLine: "Opened by the deck job when a proposed version is sent back; a hand-made one would be joined to that job's card and never worked.",
    startableByHand: false,
    requires: ["the deck version that was sent back"],
    door: "JOB",
  },
  {
    key: "ROOM_PACKET",
    label: "Room or Workshop packet",
    oneLine: "Opened by the Room job for the month it is building; a hand-made one would be joined to that job's card and never worked.",
    startableByHand: false,
    requires: ["the month the Room is for"],
    door: "JOB",
  },
  {
    key: "PRODUCTIONS_CUSTOMERS",
    label: "Productions — customers",
    oneLine: "Opened by the monthly Productions job that finds ten customers; a hand-made one would be joined to that job's card and never worked.",
    startableByHand: false,
    requires: ["the month it covers"],
    door: "JOB",
  },
  {
    key: "PRODUCTIONS_PRESS",
    label: "Productions — press",
    oneLine: "Opened by the monthly Productions job that drafts five press approaches; a hand-made one would be joined to that job's card and never worked.",
    startableByHand: false,
    requires: ["the month it covers"],
    door: "JOB",
  },
  {
    key: "PRODUCTIONS_MONTHLY",
    label: "Productions — the month",
    oneLine: "Opened by the monthly Productions job that searches both sides and emails Scooter once; a hand-made one would be joined to that job's card and never worked.",
    startableByHand: false,
    requires: ["the month it covers"],
    door: "JOB",
  },
  {
    key: "PRODUCTIONS_HIRE_SEARCH",
    label: "Productions — hire search",
    oneLine: "Opened by the weekly hire-search job Walker runs for Scooter; a hand-made one would be joined to that job's card and never worked.",
    startableByHand: false,
    requires: ["the week it covers"],
    door: "JOB",
  },
];

const BY_KEY = new Map(CARD_KINDS.map((k) => [k.key, k]));

/** The registry entry for a stored kind, or null — including for the plain `kind = NULL` card. */
export function cardKind(key: string | null | undefined): CardKind | null {
  return key ? BY_KEY.get(key) ?? null : null;
}

/**
 * Whether a person may open a card of this kind themselves. A card with no kind is the ordinary
 * one and is always yes; an unknown kind is no, because nothing here knows what it would need.
 */
export function startableByHand(key: string | null | undefined): boolean {
  if (!key) return true;
  return cardKind(key)?.startableByHand === true;
}

/** The kinds a person may open, for a screen that has to offer a list. */
export function handStartableKinds(): CardKind[] {
  return CARD_KINDS.filter((k) => k.startableByHand);
}
