/**
 * WHO WE ARE, on every one-pager a brand sees (owner's words, 22 Oct 2026). "We" voice; no fund size,
 * no fund name, no terms, no internal names, no em dashes. The secondary figure is the deck's own
 * ("Over $100M in secondary transactions facilitated", src/shared/deck/definition.ts) and the
 * community size is the confirmed 5,000. Pinned exactly in tests/learningClub.test.ts.
 *
 * WHY ITS OWN FILE: it names portfolio companies, one of them Stripe, and validate:tlc rightly fails
 * any TLC service or shared file that names a payment client. Kept apart so that scan stays strict.
 */
export const TLC_ABOUT_WEST_PEEK =
  "West Peek Ventures is a venture firm and community. We have facilitated more than $100M in secondary transactions, with late-stage positions including Higgsfield, Databricks and Stripe, among others. Our community of more than 5,000 founders, operators, investors, creatives and builders meets in person through West Peek Rooms, our event series. The Learning Club is a series within Rooms: small, hands-on deep dives in New York.";
