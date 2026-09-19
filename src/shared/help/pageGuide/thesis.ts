import type { PageGuide } from "./types";

/** Thesis, as deployed on 287ee44 — the document card, the fit rail, Construction and Versions. */
export const thesisGuide: PageGuide = {
  navKey: "thesis",
  title: "Thesis",
  purpose:
    "What the firm is looking for, in one sentence, and the six numbers it commits the fund to — stage, sector, filter, cheque, ownership and shape. Amending writes a new version; nothing is ever overwritten.",
  youCan: [
    "Amend the thesis as a new version",
    "Have it written from the numbers",
    "Amend the reserve and concentration rules",
    "Read every version the firm has held",
  ],
  sources: ["src/client/pages/ThesisPage.tsx", "src/client/pages/FundPicker.tsx"],
  bands: [
    { name: "The fund", testid: "fund-picker", shows: "which fund this thesis belongs to; a second fund can be added here." },
    { name: "The answer", testid: "thesis-masthead", shows: "which version is current and how many of the six numbers it commits to." },
    { name: "The thesis", testid: "thesis-current", shows: "the sentence in the orange field, with its version and the date it took effect." },
    { name: "What a company must be", testid: "thesis-fit", shows: "the six checks in the order they are applied, what a winner has to return, and any open question." },
    { name: "Construction", testid: "construction-card", shows: "reserves, the most one company may take, the sleeves and the fee estimate." },
    { name: "Versions", testid: "thesis-history", shows: "every version ever held, newest first, and the document's actions." },
  ],
  acts: [
    {
      label: "Amend the thesis",
      testid: "thesis-edit-toggle",
      primary: true,
      does: "opens the form — the sentence, sectors, filter, stage, cheque range, ownership, minimum and positions.",
      then: "Nothing changes until you save.",
    },
    {
      label: "Save as new version",
      testid: "thesis-save",
      primary: true,
      does: "writes the form as the next version and keeps the previous one.",
      then: "Dealflow and Companies screen against the new version at once.",
    },
    { label: "Never mind", testid: "thesis-cancel", does: "closes the form without saving." },
    {
      label: "Write it for me",
      testid: "thesis-write",
      does: "drafts the sentence from the numbers in the form.",
      then: "It lands in the statement box for you to edit, then save.",
    },
    {
      label: "Amend",
      testid: "construction-edit-toggle",
      does: "opens the reserve and concentration rules for editing.",
    },
    {
      label: "Save as new versions",
      testid: "construction-save",
      primary: true,
      does: "writes the changed rules as new versions; unchanged ones are left alone.",
      then: "Fund strategy and Portfolio read them at once.",
    },
    { label: "Print or save as PDF", testid: "thesis-print", does: "prints the document." },
    {
      label: "Create",
      testid: "fund-add-submit",
      does: "adds a second fund (after Add a fund) and switches the page to it.",
    },
  ],
  auto: [
    {
      what: "Nothing runs on a clock here. The returner arithmetic under the fit rail is worked out from the numbers each time the page is read",
      when: "on every visit",
    },
  ],
  elsewhere: [
    { page: "fund-strategy", why: "the sleeves, the fee estimate and the plan ring — amend those there." },
    { page: "dealflow", why: "where companies are screened against this thesis." },
  ],
};
