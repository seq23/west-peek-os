import type { PageGuide } from "./types";

/**
 * Dealflow, as deployed on 287ee44 — the rail, Waiting on you, the pipeline, the record's five
 * faces, the committee (moved here from Meetings), and where deals come from.
 */
export const dealflowGuide: PageGuide = {
  navKey: "dealflow",
  title: "Dealflow",
  purpose:
    "Where every company stands and what is stopping the next decision. Deals die of neglect rather than judgement, so each one shows how long it has sat where it is against that stage's own clock — and the committee lives here now.",
  youCan: [
    "See what is waiting on you, first",
    "Move a company to its next stage, or pass",
    "Add a company at the stage it is actually at",
    "Run the committee and record what it decided",
  ],
  sources: [
    "src/client/pages/DealflowPage.tsx",
    "src/client/pages/Faces.tsx",
    "src/client/pages/RecordInvestment.tsx",
    "src/client/pages/DealPacket.tsx",
    "src/client/pages/DealProvenance.tsx",
  ],
  bands: [
    { name: "The answer", testid: "dealflow-answer", shows: "how many decisions are waiting on you, with the live, invested and passed counts above it." },
    { name: "The rail", testid: "stage-rail", shows: "the six stages with a count and a clock each — press a stage to see only its companies; the exits line counts who left." },
    { name: "Waiting on you", testid: "dealflow-waiting", shows: "stage moves proposed after meetings, deals at the committee, and deals that arrived by email and have not been looked at." },
    { name: "The pipeline", testid: "dealflow-pipeline", shows: "every deal as a row — name, stage and clock, what is stopping it, and the act; filters for live, needs you, invested, passed." },
    { name: "The record", testid: "deal-record", shows: "one company, opened from a row, with five faces: Where this stands · The deal itself · What we know · The committee · History." },
    { name: "The committee", testid: "dealflow-committee", shows: "every deal with a packet, whether the facilitator is on, and what each is waiting for." },
    { name: "Where deals come from", testid: "deal-provenance", shows: "the origins of the firm's deals, and any deal still missing one." },
  ],
  acts: [
    {
      label: "Move it",
      testid: "proposal-accept-",
      primary: true,
      does: "accepts a stage move a meeting proposed.",
      then: "The deal moves at once — a click, not an approval card.",
    },
    {
      label: "Leave it where it is",
      testid: "proposal-decline-",
      does: "declines the proposed move, with a reason.",
    },
    {
      label: "Move to",
      testids: ["deal-advance-", "deal-record-advance"],
      primary: true,
      does: "moves the deal to its next stage, from the row or from the record.",
      then: "Reaching IC-ready opens the committee packet on its own; recording the fund as invested is a Managing Partner's move.",
    },
    {
      label: "Pass on this",
      testids: ["deal-pass-", "deal-record-pass"],
      does: "passes on the deal, with a reason of at least a sentence.",
      then: "It moves to the pass pile and stays on the record.",
    },
    { label: "Look at it again", testids: ["deal-reopen-", "deal-record-reopen"], does: "brings a passed or withdrawn deal back to Screening." },
    { label: "Remove this record", testid: "deal-archive-", does: "takes a deal off the board, with a reason; nothing is destroyed and a booked deal cannot be removed." },
    {
      label: "Add a company",
      testids: ["dealflow-add-toggle", "dealflow-add-submit"],
      primary: true,
      does: "opens the form — company, sector, deck, sleeve, the stage it is really at, and how it came to you — and Add puts it in.",
      then: "The record opens on The deal itself.",
    },
    { label: "Look at it", testid: "waiting-look-", primary: true, does: "opens a deal that arrived by email and has not been looked at." },
    {
      label: "Record what the committee decided",
      testids: ["waiting-decide-", "ic-decide-", "ic-open-"],
      primary: true,
      does: "opens the committee face with the Why field ready.",
    },
    {
      label: "The firm is investing",
      testid: "ic-invest-",
      primary: true,
      does: "records the committee's yes, against the approved card.",
      then: "The deal is marked decided; the capital itself is a separate signature on Approvals.",
      who: "Managing Partner",
    },
    { label: "The firm passes", testid: "ic-pass-", does: "records a pass with the reason; Not yet leaves the deal where it is.", who: "Managing Partner" },
    {
      label: "Put it in front of the partners",
      testid: "ic-submit-",
      primary: true,
      does: "sends the packet to both partners.",
      then: "One approval card is raised on Approvals.",
    },
    {
      label: "Save answer",
      testids: ["ic-save-", "ic-answer-save-"],
      primary: true,
      does: "answers a diligence section or an open question in the packet; the champion cannot answer the bear case.",
    },
    { label: "Record that you disagreed with this", testid: "ic-dissent-save-", primary: true, does: "records your dissent against a decision, in your words, permanently." },
    {
      label: "Save the deal record",
      testid: "deal-terms-save",
      primary: true,
      does: "saves the deal's terms, class, price, seller and dates on The deal itself; stand-in numbers are replaced by real ones.",
    },
    { label: "Work it out", testid: "deal-math-create", primary: true, does: "works the deal arithmetic from the seven numbers you type — ownership, dilution, what it takes to return the fund." },
    {
      label: "Draft it",
      testid: "txn-draft",
      primary: true,
      does: "drafts the transaction naming the fund and vehicle.",
      then: "Send for approval raises the card; a Managing Partner's approval books the position — no receipt to paste.",
    },
    { label: "Add it", testid: "deal-second-submit", primary: true, does: "adds a second deal for the same company — a follow-on or a secondary." },
    { label: "Its register entry →", testid: "deal-record-open-register", does: "opens the company's card on Companies." },
    { label: "What we are looking for →", testid: "dealflow-thesis", does: "opens the Thesis the pipeline screens against." },
  ],
  auto: [
    { what: "The stage clocks run — 7 days at New, 14 at Screening, 42 in Diligence, 7 at IC-ready, 21 decided — and a row past its clock sorts to the top as stalled", when: "on every read" },
    { what: "Deals arrive by themselves at New — forwarded to the intake mailbox, found by the scout, or synced from Network OS — and show as not yet looked at", when: "as they arrive" },
    { what: "Wyatt reads pending decks", when: "daily", job: "deck_reading" },
    { what: "Employees work the intake cards and may leave a recommendation on the row", when: "every sweep", job: "employee_work_sweep" },
    { what: "Network OS is read for new companies", when: "on its schedule", job: "network_sync" },
    { what: "A move to IC-ready opens the committee packet, drafts its open questions and hands the facilitator a work card", when: "on the move" },
    { what: "A meeting's After face proposes stage moves that land in Waiting on you", when: "when a draft is approved" },
  ],
  elsewhere: [
    { page: "thesis", why: "the mandate every deal is screened against." },
    { page: "companies", why: "the register — every company's card and history." },
    { page: "approvals", why: "where the capital is signed for and the position booked." },
    { page: "meetings", why: "where the stage proposals come from." },
    { page: "work", why: "the facilitator's card when it is holding a packet." },
  ],
  walkthroughs: [
    {
      scenario: "A deal from the inbox to the committee",
      steps: [
        { do: "A deal arrives by email and sits under **Waiting on you** — press **Look at it**", then: "the record opens: what the deck said, what it did not, and the seven numbers." },
        { do: "Or press **Add a company** for one that came another way", then: "it enters at the top of **The pipeline** like every company does." },
        { do: "Press **Move it** on the answer line, or **Move to** on the record", then: "the deal moves a stage; **Leave it where it is** declines; **Pass on this** ends it with a reason." },
        { do: "Press **Work it out** on the record", then: "the arithmetic runs from the seven numbers — ownership, dilution, what it takes to return the fund." },
        { do: "Press **Put it in front of the partners**", then: "the packet goes to **The committee**; **Save answer** fills what it does not yet know." },
        { do: "Press **Record what the committee decided** — **The firm is investing** or **The firm passes**", then: "the decision and the reason are on the record; **Record that you disagreed with this** keeps a dissent, permanently." },
      ],
    },
  ],
};
