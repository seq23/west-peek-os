import type { PageGuide } from "./types";

/** LP, as deployed on 287ee44 — the raise, commitments, where the fund stands, the letter, the administrator, the data room. */
export const lpGuide: PageGuide = {
  navKey: "lp",
  title: "LP",
  purpose:
    "Your investors — what each committed, where the raise stands against its target, where the fund stands, what the fund has told them, whether the administrator's numbers agree with ours, and who can see the material.",
  youCan: [
    "See what is signed and what is only spoken for",
    "Record what somebody committed",
    "Start the quarter's letter and send it once it is signed off",
    "Check the administrator's numbers against ours",
  ],
  sources: ["src/client/pages/LpPage.tsx"],
  bands: [
    { name: "Where the raise stands", shows: "per fund: signed, said yes but not signed, and the target — or the box to set the target if there is none." },
    { name: "Record what somebody committed", testid: "commitment-form", shows: "who, which fund, how much, and whether it is signed, spoken for, or fell through." },
    { name: "Who has committed", testid: "commitment-list", shows: "every commitment on the record." },
    { name: "Where the fund stands", testid: "fund-standing", shows: "TVPI, DPI, called and held at, the holdings, and Wesley's draft of the report if you asked for one." },
    { name: "What we have told them", testid: "period-form", shows: "the quarters, each quarter's letter, who has read it, and whether it went out. Nothing here certifies a number." },
    { name: "Do the administrator's numbers agree with ours", testid: "reconciliation-form", shows: "their NAV against ours and every exception that came out of the comparison." },
    { name: "Who can see our material", testid: "lp-data-room", shows: "who holds data-room access now and whose access was closed. Nothing is granted from here." },
    { name: "Add an investor", testid: "lp-form", shows: "a name and what kind of investor they are." },
  ],
  acts: [
    { label: "Record it", testid: "commitment-save", primary: true, does: "records a commitment — who, which fund, how much, and where it stands." },
    { label: "Ask Wesley for the report", testid: "lp-report-ask", primary: true, does: "has Wesley draft the fund's standing in words.", then: "Nothing is sent; the draft sits under Where the fund stands." },
    { label: "Start this period's letter", testid: "period-open", does: "opens a quarter (Q1 2026 and so on) to write a letter for." },
    { label: "Start it", testid: "packet-draft-", primary: true, does: "starts the quarter's letter.", then: "Three people have to read it before it can go, and a partner signs the sending." },
    { label: "Put it in front of its reviewers", testid: "packet-submit", does: "sends the letter to finance, compliance and a Managing Partner to read; each presses I have read it." },
    {
      label: "Send it to the investors",
      testid: "packet-distribute",
      primary: true,
      does: "sends the letter once it is signed off.",
      then: "The first press raises the approval card on Approvals; once it is signed, press send again.",
      who: "a Managing Partner signs it",
    },
    { label: "Compare", testid: "reconciliation-run", does: "compares the administrator's NAV with ours and lists every exception." },
    { label: "Close it", testids: ["data-room-close-", "data-room-revoke-"], primary: true, does: "revokes somebody's data-room access, with a reason, after Take this access back opens the field." },
    { label: "Add", testid: "lp-add", does: "adds an investor to the record." },
    { label: "Save", does: "sets a fund's target size, which the raise is measured against.", who: "Managing Partner" },
  ],
  auto: [
    { what: "Nothing runs on a clock here; the standing figures are worked out from the holdings each time the page is read", when: "on every visit" },
  ],
  elsewhere: [
    { page: "approvals", why: "where a Managing Partner signs the letter's sending." },
    { page: "fund-strategy", why: "the fund itself — create it there before recording commitments, and record first close." },
    { page: "documents", why: "the deck and every filed version of what has gone out." },
  ],
  walkthroughs: [
    {
      scenario: "An investor commits, and the quarter's letter goes out",
      steps: [
        { do: "Under **Add an investor**, press **Add**", then: "the investor is on the record." },
        { do: "Under **Record what somebody committed**, press **Record it**", then: "who, which fund, how much, and where it stands — **Where the raise stands** moves against the target a partner set with **Save**." },
        { do: "Under **Where the fund stands**, press **Ask Wesley for the report**", then: "Wesley drafts the fund's standing in words.", not: "nothing is sent." },
        { do: "Under **What we have told them**, press **Start this period's letter**, then **Start it**, then **Put it in front of its reviewers**", then: "finance, compliance and a Managing Partner each read it and press I have read it." },
        { do: "Press **Send it to the investors**", then: "a partner signs the sending and it goes.", not: "it cannot go before all three have read it." },
        { do: "Under **Do the administrator's numbers agree with ours**, press **Compare**", then: "every exception between their NAV and ours is listed." },
        { do: "Under **Who can see our material**, press **Close it** on an access that should end", then: "the access is revoked with a reason." },
      ],
    },
  ],
};
