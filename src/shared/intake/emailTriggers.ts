/**
 * What a hashtag in mail to `os@westpeek.ventures` means, and what happens next.
 *
 * Operator, 21 Aug 2026: "i want the employee monitoring the inbox to know immediately what to do
 * when emails enter the inbox with those triggers."
 *
 * ONE TABLE, READ BY EVERYTHING. The email handler routes from it, Porter's method is written from
 * it, and the help text a partner reads is generated from it. Three copies of a routing rule is
 * three chances for the inbox to do something the documentation says it does not.
 *
 * A TRIGGER ROUTES; IT DOES NOT AUTHORISE. This is the constraint the whole design turns on, carried
 * from BACKLOG.md on 17 Aug: anybody who learns the hashtag can type it, so it can never be the
 * thing that grants entry. `#wpdealflow` says "this is a company for the funnel" — it does not put
 * one there. Every route below lands as a PROPOSAL a human accepts, which is what makes a public
 * word safe to publish.
 *
 * WHY THREE AND NOT TWO. `#wpdealflow` and `#wpnetwork` already exist across the family and mean
 * what they say. The third earns its place twice over.
 *
 * First, it answers a different question — not *what is this* but *where is the information*. A mail
 * carrying `#wpdeck` tells the analyst the content is in the attachment and the body is a covering
 * note. Without it a deck arrives under `#wpdealflow` with an empty-looking body and reads as a poor
 * submission rather than a complete one.
 *
 * Second, and this is the part that makes it structural rather than cosmetic: **a deck is as often
 * about a company already on the board as a new one.** Operator, 21 Aug 2026: "#wpdeck is for the
 * analyst to add deal flow to the top of the funnel for a new company or fill in blanks for a
 * company already added with info missing." So the route is match-first, not create-first. A trigger
 * that always created would quietly build a second Sensori every time somebody forwarded a follow-up
 * deck — and duplicate companies are exactly what the CanonicalCompany model exists to prevent.
 */

export type TriggerOwner = "WEST_PEEK_OS" | "NETWORK_OS";

export interface EmailTrigger {
  /** Written lower-case; matching is case-insensitive. */
  tag: string;
  /** One line, for a person. This is what Porter's method and the help page both say. */
  means: string;
  /** Which system owns the record this creates. Two systems never both claim the same write. */
  owner: TriggerOwner;
  /** What the inbox does, in the order it does it. */
  does: string;
  /** What lands, and in what state. Always a proposal — see the note above. */
  lands: string;
}

export const EMAIL_TRIGGERS: readonly EmailTrigger[] = [
  {
    tag: "#wpdealflow",
    means: "A company for the funnel.",
    owner: "WEST_PEEK_OS",
    does: "Reads the company out of the message, checks it against the companies already on record, and opens a proposed opportunity.",
    lands: "Dealflow, as a proposal with the sender recorded as the source. Nobody has decided anything yet.",
  },
  {
    tag: "#wpnetwork",
    means: "A person for the network.",
    owner: "NETWORK_OS",
    does: "Relays the person to Network OS's intake queue, because Network OS owns who is a member and this app does not.",
    lands: "Network OS's review queue. Somebody there decides whether they become a contact.",
  },
  {
    tag: "#wpdeck",
    means: "A deck to read. The information is in the attachment, and it is either a new company or the missing half of one already on the board.",
    owner: "WEST_PEEK_OS",
    does:
      "Matches the deck against the companies already on record FIRST. A match fills the blanks on that record from the deck; " +
      "no match opens a new company at the top of the funnel. Either way the analyst reads the attachment, not the covering note.",
    lands:
      "Dealflow — a proposal at the top of the funnel for a new company, or proposed answers to the empty fields on an existing " +
      "one. Never a second row for a company already there.",
  },
] as const;

/** Every trigger in one message. A mail may carry more than one and each is routed on its own. */
export function triggersIn(text: string): EmailTrigger[] {
  const lower = (text ?? "").toLowerCase();
  return EMAIL_TRIGGERS.filter((t) => lower.includes(t.tag));
}

/**
 * Mail carrying no trigger is not a failure and must not be dropped.
 *
 * It is the case that actually needs a person: a founder replying into an old thread, a deck with no
 * covering text, an introduction written in prose. Porter takes those, and they surface on "Needs
 * your attention" — an unrouted email sitting in a queue nobody opens is the same failure as a stuck
 * job, which this system has already had once.
 */
export const NO_TRIGGER_ROUTE = {
  owner: "WEST_PEEK_OS" as TriggerOwner,
  does: "Goes to Porter, who reads it and decides where it belongs.",
  lands: "Needs your attention, so it is never silently held.",
};

/**
 * The mailbox itself, named once so nothing hard-codes it.
 *
 * ON joinwestpeek.com AND NOT westpeek.ventures, deliberately. `westpeek.ventures` MX points at
 * Google Workspace, and Cloudflare Email Routing installs its own MX at the zone apex — enabling it
 * there would have taken mail away from sequoia@, scooter@ and info@westpeek.ventures. That is not a
 * trade worth making for a machine inbox.
 *
 * `joinwestpeek.com` carries no mail at all (checked: zero MX records) and is already the app's own
 * domain — `os.joinwestpeek.com` and `network.joinwestpeek.com` both live there. So the address
 * matches the system it belongs to and the firm's email is never at risk. Confirmed with the
 * operator, 21 Aug 2026: "ok then we can change it to os@joinwestpeek.com if we need to."
 */
export const INTAKE_MAILBOX = "os@joinwestpeek.com";
