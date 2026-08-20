/**
 * What a work card is, and where they come from.
 *
 * WHY THIS NEEDED WRITING DOWN. The operator's question was "I don't understand work cards, and
 * there's no way to create them" — and both halves were fair. Cards are created as a CONSEQUENCE of
 * five different things happening elsewhere in the product, the page never said which, and the one
 * route that makes a card directly had no button. So the concept was invisible and the page looked
 * broken. Production has zero cards, which is honest: none of the five things has happened yet.
 *
 * WHAT A CARD IS. A unit of work somebody owns, with a next action. That is the whole definition,
 * and the two halves are what make it different from everything nearby:
 *
 *   a NOTIFICATION says look at this — nobody owns it, and dismissing it ends it;
 *   an APPROVAL says decide this — it is blocked on a person and dies when they decide;
 *   a WORK CARD says somebody is doing this, and here is what happens next.
 *
 * A recurring sweep is none of those, which answers the other half of the question: a scheduled job
 * does not get a card, because a job is not a task somebody owns — it is machinery that runs. What
 * a job PRODUCES can become a card, when it produces something a person has to carry.
 */

export interface CardSource {
  key: string;
  /** Where the card came from, in the operator's words. */
  label: string;
  /** What has to happen for a card to appear this way. */
  how: string;
  /** The surface that produces it, for a link. */
  page: string | null;
}

export const CARD_SOURCES: readonly CardSource[] = [
  {
    key: "capture",
    label: "Something you captured",
    how: "Route a capture and tick “make this a piece of work”. The note becomes a card with the capture still attached to it.",
    page: "capture",
  },
  {
    key: "ask",
    label: "Something you asked for",
    // Was "Ask turns a rough request into a work packet; executing that packet creates the card".
    // That described the flow Ask replaced — it now drafts the card itself, and a request that
    // wants a document rather than a task comes back as a brief instead.
    how: "Ask reads what you need, writes the card for you, and shows it before anything is created — or hands back a written brief when a document is what you actually wanted.",
    page: "intent",
  },
  {
    key: "meeting",
    label: "A commitment from a meeting",
    how: "Close-out reads what was promised and raises a card for each one, assigned by the same rules everywhere else uses.",
    page: "meetings",
  },
  {
    key: "conflict",
    label: "Two systems disagreeing",
    how: "When Network OS and this system hold different truths, the card is what carries the reconciliation.",
    page: "network",
  },
  {
    key: "direct",
    label: "You just made one",
    how: "Some work does not arrive through any of the above. You can write the card yourself.",
    page: null,
  },
] as const;

export const CARD_STATES = ["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"] as const;
export type CardState = (typeof CARD_STATES)[number];

export interface StateMeaning {
  key: CardState;
  label: string;
  /** What being in this state actually claims. */
  means: string;
}

export const STATE_MEANINGS: readonly StateMeaning[] = [
  { key: "OPEN", label: "Open", means: "Real work, nobody has started it." },
  { key: "IN_PROGRESS", label: "In progress", means: "Somebody is on it now." },
  {
    key: "BLOCKED",
    label: "Blocked",
    means: "Waiting on something outside this card. Blocked without a stated reason is just stalled.",
  },
  { key: "DONE", label: "Done", means: "Finished. Kept, because what got done is the record." },
  { key: "CANCELLED", label: "Dropped", means: "Deliberately not doing it. Also kept — a decision not to act is a decision." },
] as const;

export function stateMeaning(key: string): StateMeaning | null {
  return STATE_MEANINGS.find((s) => s.key === key) ?? null;
}

/**
 * Cards that are open work, in the order they should be looked at.
 *
 * BLOCKED FIRST, deliberately. A blocked card is the only state where the work has stopped and
 * somebody has to intervene; open and in-progress cards are moving. Sorting by age or priority
 * alone buries the one kind that needs a person.
 */
export function triage<T extends { state: string; priority?: string; due_at?: string | null }>(cards: readonly T[]): T[] {
  const rank = (c: T) => (c.state === "BLOCKED" ? 0 : c.state === "IN_PROGRESS" ? 1 : 2);
  const urgency = (c: T) => (c.priority === "URGENT" ? 0 : c.priority === "HIGH" ? 1 : 2);
  return [...cards]
    .filter((c) => c.state !== "DONE" && c.state !== "CANCELLED")
    .sort((a, b) => rank(a) - rank(b) || urgency(a) - urgency(b) || (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"));
}
