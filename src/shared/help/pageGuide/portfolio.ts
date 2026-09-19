import type { PageGuide } from "./types";

/** Portfolio, as deployed on 287ee44 — what we own, and how it is doing. */
export const portfolioGuide: PageGuide = {
  navKey: "portfolio",
  title: "Portfolio",
  purpose:
    "How portfolio companies are doing, what the firm owns, and whether each holding is booked. Book it, Mark it, Reserve for it and Sell sit on the holding's row; what is going wrong, who has gone quiet and who asked for help sit below.",
  youCan: ["Book a holding — one card, and a partner's approval opens the position", "Mark a holding, or reserve for it", "See what is going wrong and who has gone quiet", "Record what a company reported, or asked for"],
  sources: [
    "src/client/pages/PortfolioPage.tsx",
    "src/client/pages/FundAllocation.tsx",
    "src/client/pages/PortfolioAllocation.tsx",
    "src/client/pages/FollowOnCandidates.tsx",
  ],
  bands: [
    { name: "The answer", testid: "portfolio-masthead", shows: "how many companies the firm owns, how many are booked, and how many wait on a partner." },
    { name: "What we own", testid: "holdings", shows: "one row per holding — paid, owned, reserved, held at, and its standing: booked, draft, awaiting a partner, not yet booked — with the concentration against the cap beneath." },
    { name: "What the portfolio is made of", testid: "portfolio-shape", shows: "composition by kind of deal and sector, and where the money is against the plan." },
    { name: "What is going wrong right now", testid: "alert-list", shows: "a figure that moved the wrong way, went unreported too long, or crossed a line the firm set." },
    { name: "Which way each company is moving", testid: "movement", shows: "going the wrong way, pulling ahead, and which qualify for a follow-on review." },
    { name: "Who we have not heard from", testid: "stale", shows: "against how long the firm said it would wait." },
    { name: "Where a company has asked for help", testid: "support-list", shows: "each ask, who was suggested, and whether help landed." },
    { name: "What they have reported", testid: "reporting", shows: "updates on file, month on month and quarter on quarter, Winter's write-up, and a form to file one that came another way." },
    { name: "Record what a company reported", testid: "snapshot-form", shows: "a dated figure per company per metric, and Track it for a new metric." },
  ],
  acts: [
    {
      label: "Book it",
      testids: ["holding-book-", "book-save-"],
      primary: true,
      does: "opens the booking under the row — share class, price, shares, date, vehicle, fund — and Save and send raises the card.",
      then: "One approval card; approving it books the position. Send for approval resends a draft.",
      who: "Managing Partner",
    },
    { label: "Send for approval", testid: "holding-send-", primary: true, does: "sends a drafted booking for a partner's approval.", who: "Managing Partner" },
    { label: "Mark it", testids: ["holding-mark-", "mark-submit"], primary: true, does: "records a new value with its source and date; the old figure is kept.", who: "Managing Partner" },
    { label: "Reserve for it", testids: ["holding-reserve-", "reserve-submit"], primary: true, does: "earmarks part of the reserve for this company.", who: "Managing Partner" },
    { label: "Sell", testid: "holding-sell-", does: "opens a sale on Dealflow; it walks the stages like any deal.", who: "Managing Partner" },
    { label: "I have seen it", testid: "alert-ack-", does: "acknowledges an alert; Get the firm behind it opens a support request from it." },
    { label: "Open the review", testid: "follow-on-submit-", primary: true, does: "opens a follow-on review for a company pulling ahead, against a scenario on Fund strategy." },
    { label: "Suggest them", testid: "match-submit", primary: true, does: "suggests somebody for a support request; Take it to a partner asks permission to introduce them; Write it down records the outcome." },
    { label: "Record the ask", testid: "support-ask-submit", does: "records what a company asked for." },
    { label: "Ask", testid: "summary-ask", primary: true, does: "has Winter write up what they have reported; it goes to nobody." },
    { label: "File it", testid: "update-submit", does: "files an update that came another way." },
    { label: "Record it", testid: "snapshot-submit", primary: true, does: "records a dated figure; Check its history evaluates the alerts; Track it starts a new metric." },
  ],
  auto: [
    { what: "A company appears here the moment a deal closes on Dealflow; the position opens when a partner approves the booking card", when: "on approval" },
    { what: "An email to the firm's mailbox with #wpupdate becomes a card for Winter, counted under What they have reported", when: "as it arrives" },
    { what: "Movement, staleness and the month-on-month tables are worked out from dated figures each time the page is read", when: "on every read" },
  ],
  elsewhere: [
    { page: "approvals", why: "the booking card a partner approves." },
    { page: "fund-strategy", why: "the plan ring, the reserve headroom, the concentration cap, and the scenario a follow-on review needs." },
    { page: "dealflow", why: "the deal behind a holding, and a sale once it is open." },
    { page: "work", why: "the update cards Winter is reading." },
  ],
};
