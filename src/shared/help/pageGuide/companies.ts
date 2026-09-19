import type { PageGuide } from "./types";

/** Companies, as deployed on 287ee44 — the register. Nothing is created here. */
export const companiesGuide: PageGuide = {
  navKey: "companies",
  title: "Companies",
  purpose:
    "The register: every company the firm has a record of, one card each — what they do, where the deal stands, how much of the fund is in it. Nothing is created here; every company enters on Dealflow.",
  youCan: ["Find a company", "Read its card and its history", "Fix what they do, their sector or website", "See who we turned down, and why"],
  sources: ["src/client/pages/CompaniesPage.tsx"],
  bands: [
    { name: "The answer", testid: "companies-masthead", shows: "how many companies are on the record, how many the fund has money in, how many it turned down." },
    { name: "Find and Sector", testid: "companies-search", shows: "a search box and a sector filter — both narrow the cards below." },
    { name: "A fault, if there is one", testid: "companies-fault", shows: "any company that is on the record but not on the board, which should never happen." },
    { name: "The cards", testid: "company-grid", shows: "one card per working company — stage and clock, what they do, In it, Met via, Meetings, and one more fact: booked, looked at, or open contradictions." },
    { name: "Who did we turn down, and why?", testid: "companies-passed", shows: "passed and withdrawn companies with the date and the reason, dimmed but on the record." },
  ],
  acts: [
    { label: "Add one on Dealflow →", testid: "companies-add-toggle", does: "goes to Dealflow — the only door a company enters through." },
    { label: "The deal", testid: "company-deal-", does: "opens Dealflow; Look at it again does the same for a passed company." },
    { label: "Edit", testid: "company-edit-", does: "opens the sector, what they do and website for editing; Save writes it and the change lands in History." },
    { label: "History", testid: "company-history-", does: "shows every change to the card, with who made it." },
    { label: "Add the reason", testid: "company-add-reason-", does: "opens Dealflow to record why a passed company was passed." },
  ],
  auto: [
    { what: "The stage clock on each card runs from the same clocks as Dealflow, and a card sorts itself as stalled past its stage's limit", when: "on every read" },
    { what: "Companies appear here as they arrive on Dealflow — by email, from the scout or from Network OS; Booked flips when a partner's approval books the position", when: "as it happens" },
    { what: "A card opens and scrolls itself into view when you arrive from a deal's Its register entry →", when: "on arrival from Dealflow" },
  ],
  elsewhere: [
    { page: "dealflow", why: "adding a company, moving it, passing on it — every change to a deal." },
    { page: "portfolio", why: "how the companies the fund owns are actually doing." },
  ],
  walkthroughs: [
    {
      scenario: "Finding a company and what happened to it",
      steps: [
        { do: "Type a name or pick a sector under **Find and Sector**", then: "**The cards** narrow to it — what they do, where the deal stands, how much of the fund is in it." },
        { do: "Press **The deal** on a card", then: "Dealflow opens on it.", not: "nothing is created here; **Add one on Dealflow →** is the only door in." },
        { do: "Press **Edit** to correct the sector, what they do, or the website", then: "Save writes it and **History** shows who changed what." },
        { do: "Under **Who did we turn down, and why?**, press **Add the reason** where one is missing", then: "Dealflow opens to record it." },
      ],
    },
  ],
};
