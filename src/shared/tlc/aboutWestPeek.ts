/**
 * WHO WE ARE, in two versions (owner, 22 Oct 2026). "We" voice; no fund size, no fund name, no
 * terms, no internal names, no em dashes. Pinned exactly in tests/learningClub.test.ts.
 *
 * THE BRAND PITCH gets `TLC_ABOUT_COMMUNITY`: community first, no company names, no transaction
 * figure. A brand is buying a room, not a fund (hostile review, 22 Oct 2026). It names Scooter and
 * Quarantine Con (owner, 26 Oct 2026), as Wynn's first emails do.
 *
 * THE INTERNAL ONE-PAGER gets `TLC_ABOUT_WEST_PEEK`, the owner's full text. The secondary figure is
 * the deck's own ("Over $100M in secondary transactions facilitated", src/shared/deck/definition.ts)
 * and the community size is the confirmed 5,000. The $100M line and the portfolio names appear ONLY
 * there.
 *
 * WHY ITS OWN FILE: the full version names portfolio companies, one of them Stripe, and
 * validate:tlc rightly fails any TLC service or shared file that names a payment client. Kept apart
 * so that scan stays strict.
 */
export const TLC_ABOUT_WEST_PEEK =
  "West Peek Ventures is a venture firm and community. We have facilitated more than $100M in secondary transactions, with late-stage positions including Higgsfield, Databricks and Stripe, among others. Our community of more than 5,000 founders, operators, investors, creatives and builders meets in person through West Peek Rooms, our event series. The Learning Club is a series within Rooms: small, hands-on deep dives in New York.";

export const TLC_ABOUT_COMMUNITY =
  "West Peek is a community of more than 5,000 founders, operators, investors, creatives and builders, started by our founding GP Scooter Taylor, who went viral in 2020 with Quarantine Con. We meet in person through West Peek Rooms, our event series in New York. The Learning Club is a series within Rooms: small, hands-on deep dives, one topic at a time, with every seat paid for.";

/** Words that belong only in the internal one-pager, never in anything a brand reads. */
export const TLC_INTERNAL_ONLY_WORDS: readonly RegExp[] = [/\$100M/i, /secondary transactions/i, /Higgsfield/i, /Databricks/i, /\bStripe\b/i, /\bFund I\b/i];
