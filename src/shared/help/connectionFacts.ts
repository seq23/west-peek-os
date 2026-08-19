/**
 * What connecting actually does, in plain English.
 *
 * WHY THIS IS SHARED RATHER THAN WRITTEN INTO THE PANEL. The same answer has to appear next to the
 * button and on the Help page, and two copies of a promise about access to somebody's private data
 * is exactly the pair that drifts. When the scopes change, this file is the one place to change.
 *
 * WHY IT LEADS WITH WHAT WE CANNOT DO. A partner is being asked to hand a system access to their
 * diary. The honest reassurance is not "we take privacy seriously" — it is a specific, checkable
 * list of things that are impossible, and the reason they are impossible. Everything below is
 * enforced by the scopes requested in effects/googleClient.ts, not by intention.
 */

export interface ConnectionFacts {
  key: string;
  /** What this is, in the words a partner would use. */
  title: string;
  /** One line: is it available at all? */
  availability: string;
  can: readonly string[];
  cannot: readonly string[];
  /** What makes the "cannot" list true, rather than a promise. */
  enforcedBy: string;
  /** What actually happens when you press the button. */
  whenYouConnect: readonly string[];
  /** How to undo it. */
  toUndo: string;
}

export const CONNECTION_FACTS: readonly ConnectionFacts[] = [
  {
    key: "calendar",
    title: "Your calendar",
    availability: "Ready. One click, and only for your own Google account.",
    can: [
      "Read the events on your primary calendar — title, time, location, who is invited.",
      "Open your morning brief with what you are walking into today.",
      "Prepare for a meeting before you ask, because it can see the meeting is coming.",
      "Tell you which of you has connected: yours and Scooter's are separate.",
    ],
    cannot: [
      "Create, move, cancel or edit anything in your calendar. Not a typo — there is no write access at all.",
      "Invite anyone, respond to an invitation, or change your availability.",
      "Read any calendar other than yours, including Scooter's.",
      "See anything in your email. Connecting a calendar asks for the diary alone — no mail permission of any kind is requested.",
      "Keep reading after you disconnect — the access is withdrawn at Google, not just forgotten here.",
    ],
    enforcedBy:
      "The system asks Google for calendar.readonly. Write access is not requested, so it is not granted, and no change to this system could use it without you being asked to approve a new permission at Google.",
    whenYouConnect: [
      "You go to Google and see exactly which permissions are being asked for.",
      "You approve, and come straight back here.",
      "The access token is stored encrypted, outside the main database, under your own name.",
      "Nothing is copied or synced anywhere — events are read when needed and not warehoused.",
    ],
    toUndo:
      "Press Disconnect. The permission is revoked at Google as well as forgotten here, so it stops working immediately rather than sitting dormant in your Google account.",
  },
  {
    key: "email",
    title: "Your mailbox",
    availability: "Not built. There is nothing to connect yet, and the button is off rather than pretending.",
    can: [
      "Nothing yet — this is honest rather than modest.",
    ],
    cannot: [
      "Read your inbox, search it, or draft replies from it.",
      "Send anything through your Gmail, or put a sent message in your Gmail Sent folder.",
      "Be needed in order to send under your own name — that is a switch above, and it needs no mailbox access at all.",
    ],
    enforcedBy:
      "No mailbox permission is requested from Google, and no code exists that would read one.",
    whenYouConnect: [
      "Nothing. The button is disabled deliberately, because a Connect that quietly does something else is worse than no Connect at all.",
    ],
    toUndo: "Nothing to undo.",
  },
];

/**
 * Sending is FIRM-LEVEL and already on, which is the single most confusing thing about this screen.
 *
 * The word "email" covers two unrelated capabilities: the firm sending a message, and a person's
 * own mailbox. The first works today and needs no connection; the second is not built. Reporting
 * only the second is what made a working system look broken.
 */
export const FIRM_SENDING_FACTS = {
  title: "The firm sending email",
  summary:
    "Already on, and separate from anything you connect here. West Peek OS can send email as the firm without touching anybody's personal account.",
  can: [
    "Send an approved message from os@westpeek.ventures — LP updates, event invitations, follow-ups.",
    "Record what was sent, to whom, and who approved it.",
  ],
  cannot: [
    "Send anything without a human approving that specific message first.",
    "Read any reply. Replies come back to your normal inbox, which this system cannot see.",
  ],
} as const;

/**
 * Sending under a partner's own name.
 *
 * Kept beside the firm facts because it is the same capability wearing a different From, and
 * separating them further would invite the belief that this one involves a mailbox. It does not.
 */
export const SEND_AS_FACTS = {
  title: "Sending under your own name",
  summary:
    "Each partner can choose to have their approved messages go out as themselves rather than as the firm. It is off until you turn it on, and you can only turn on your own.",
  can: [
    "Send an approved message from your own firm address, so an LP sees it from you rather than from a shared account.",
    "Be switched on and off whenever you like, with who changed it and when on the record.",
  ],
  cannot: [
    "Be turned on for you by anybody else, including the other Managing Partner.",
    "Read your inbox, even with Gmail sending granted. That permission can only send — it cannot list, search or open a single message.",
    "Skip approval. You still approve each message, exactly as before — this only decides whose name is on it.",
    "Put the message in your Gmail Sent folder — unless you also grant Gmail sending, which is a separate one-click permission offered beside the switch.",
    "Work from an address outside the firm's verified domain, which would fail authentication and land in spam.",
  ],
} as const;
