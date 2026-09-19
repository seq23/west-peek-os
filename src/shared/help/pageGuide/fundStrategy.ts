import type { PageGuide } from "./types";

/** Fund strategy, as deployed on 287ee44 (PR #126) — the door first, the distance from the plan, first close on the record. */
export const fundStrategyGuide: PageGuide = {
  navKey: "fund-strategy",
  title: "Fund strategy",
  purpose:
    "Where the fund is going: the dashboards to model the next cheque, how far reality is from the plan, how the fund is built, the deck the plan is told in, what the reserves are for, and scenarios. What the portfolio is made of is on Portfolio.",
  youCan: [
    "Open the venture deals dashboards with this fund's numbers to hand",
    "See how far initial cheques, companies, reserves and secondaries are from the plan",
    "Amend the construction as a new version, and record first close",
    "Approve or send back a deck version, and open a scenario",
  ],
  sources: [
    "src/client/pages/FundStrategyPage.tsx",
    "src/client/pages/DashboardDoor.tsx",
    "src/client/pages/PlanVsReality.tsx",
    "src/client/pages/FundConstruction.tsx",
    "src/client/pages/DeckPanel.tsx",
    "src/client/pages/ReservesBand.tsx",
    "src/client/pages/ScenariosBand.tsx",
  ],
  bands: [
    { name: "The answer", testid: "fund-strategy-masthead", shows: "how many companies are in against the plan, and how much of the initial-cheque capital is out." },
    { name: "Model it", testid: "fund-door", shows: "what the three dashboards answer, the six mandate figures to carry across, and the one orange button." },
    { name: "Where the fund is against its plan", testid: "fund-plan-vs-reality", shows: "the pace of initial-cheque capital from first close, and the gap pool by pool — initial cheques, companies, reserves, secondaries, fees." },
    { name: "How the fund is built", testid: "fund-construction", shows: "the plan ring, the policy in three sentences, first close, the versions, and Amend." },
    { name: "The deck — what the firm sends", testid: "fund-deck", shows: "the current version, whether it has drifted from the plan, versions waiting on your decision, and every version on the record." },
    { name: "What the reserves are for", testid: "fund-reserves", shows: "held, drawn, headroom, the rationale, and the follow-on reviews waiting on a partner." },
    { name: "Scenarios", testid: "allocation-page", shows: "each scenario with the policy versions it pinned, its assumptions, its capital options and their approvals." },
  ],
  acts: [
    { label: "Open the dashboards ↗", testid: "modeling-open", primary: true, does: "opens the venture deals dashboards in a new tab; nothing entered there comes back." },
    { label: "Copy these six figures", testid: "modeling-copy", primary: true, does: "copies the mandate's six figures to paste into the dashboards." },
    { label: "Record first close", testid: "fund-pace-record-first-close", primary: true, does: "opens Amend with the first-close date, which starts the pace clock." },
    { label: "Amend the construction", testid: "construction-amend", primary: true, does: "opens the three sentences as inputs, the sectors, first close, and what it works out to.", who: "Managing Partners" },
    { label: "Save as a new version", testid: "construction-save", primary: true, does: "writes new mandate, sleeve and reserve versions with your reason; nothing is overwritten.", who: "Managing Partners" },
    { label: "Approve", testid: "deck-approve-", primary: true, does: "makes a proposed deck version the current deck.", who: "a person" },
    { label: "Send it back", testids: ["deck-reject-", "deck-reject-confirm-"], primary: true, does: "sends a version back to Preston with your reason, word for word." },
    { label: "Add a version of the deck", testid: "deck-upload", does: "records a PDF as a proposed version, with a snapshot of every fund figure it was built from." },
    { label: "Pulling ahead → Portfolio", testid: "fund-reserves-to-portfolio", does: "goes to the companies a follow-on review starts from." },
    { label: "Open a scenario", testids: ["scenario-new", "scenario-create"], primary: true, does: "opens a scenario, pinning the current policy versions and the investable figure." },
    { label: "Add option", testid: "option-create", primary: true, does: "adds a capital option to the scenario; Run cross-sleeve comparison checks it against the constraints." },
    { label: "Record APPROVED", testid: "option-approve-", does: "records the decision on an option, against its approval; Request the reserved approval raises the card.", who: "a person" },
    { label: "Open", testid: "scenario-open-", primary: true, does: "opens a scenario's detail." },
  ],
  auto: [
    { what: "Preston rebuilds the deck from the records when asked, and it lands as a version waiting on your decision", when: "on request", job: "deck_rebuild" },
    { what: "The deck's drift from the plan is worked out against the current mandate, sleeve and reserve", when: "on every read" },
    { what: "First close is set by the first signed commitment on LP, or typed behind Amend", when: "when it happens" },
  ],
  elsewhere: [
    { page: "portfolio", why: "what the money bought — the holdings, the composition, the deployment ring." },
    { page: "thesis", why: "the mandate the six figures come from." },
    { page: "documents", why: "every deck version, viewed in place." },
    { page: "lp", why: "the fund's target and first close." },
  ],
  notActs: {
    "sector-": "the sector chips inside Amend toggle a field of the form; the act is Save as a new version.",
  },
  walkthroughs: [
    {
      scenario: "Modelling the next cheque and deciding the deck",
      steps: [
        { do: "Under **Model it**, press **Copy these six figures**, then **Open the dashboards ↗**", then: "the dashboards open in a new tab with the mandate's figures to paste in.", not: "nothing entered there comes back." },
        { do: "Under **Where the fund is against its plan**, press **Record first close**", then: "Amend opens with the first-close date, which starts the pace clock." },
        { do: "Under **How the fund is built**, press **Amend the construction**, then **Save as a new version**", then: "new mandate, sleeve and reserve versions are written with your reason.", not: "nothing is overwritten." },
        { do: "When Preston proposes a deck under **The deck — what the firm sends**, press **Approve** or **Send it back**", then: "the version becomes the current deck, or goes back to Preston with your reason word for word; **Add a version of the deck** records a PDF as a proposal." },
        { do: "Under **Scenarios**, press **Open a scenario**, **Add option**, then **Record APPROVED**", then: "the scenario pins the current policy versions; each option is checked against the constraints; the decision is recorded against its approval." },
      ],
    },
  ],
};
