import type { PageGuide } from "./types";

/** Secondaries, as deployed on 287ee44 — the sleeve, read from the same pipeline. */
export const secondariesGuide: PageGuide = {
  navKey: "secondaries",
  title: "Secondaries",
  purpose:
    "The secondary sleeve — purchases from existing holders and sales out of the portfolio. A secondary enters on Dealflow like any deal and walks the same stages; it shows here because the sleeve is kept apart on purpose.",
  youCan: ["See what is in the sleeve and what it has spent", "Filter the sleeve by stage", "Open a secondary on Dealflow, or add one there"],
  sources: ["src/client/pages/SecondariesPage.tsx"],
  bands: [
    { name: "The answer", testid: "secondaries-masthead", shows: "how many are in the sleeve, buying and selling, and what the sleeve has left." },
    { name: "The rail", testid: "secondaries-rail-card", shows: "the six stages with the block's own questions, and the sleeve's budget against what is deployed." },
    { name: "What have we bought from existing holders?", testid: "secondaries-purchases-band", shows: "each purchase with seller, price against the last round, stage and clock — or the honest shape of one while empty." },
    { name: "What have we sold out of the portfolio?", testid: "secondaries-sales-band", shows: "each sale; a sale begins on the holding's row on Portfolio." },
    { name: "The doors", testid: "secondaries-doors", shows: "add a secondary on Dealflow, or model one in the venture deals dashboards." },
  ],
  acts: [
    { label: "Open on Dealflow", testid: "secondary-open-", primary: true, does: "opens Dealflow, where the deal is worked." },
    { label: "Add a secondary on Dealflow", testid: "secondaries-add", primary: true, does: "goes to Dealflow to add one marked as a purchase or a sale." },
    { label: "show every stage", testid: "secondaries-clear-filter", does: "clears the stage filter set by pressing a node on the rail." },
    { label: "Model a secondary scenario in VentureDeals →", testid: "secondaries-venturedeals", does: "opens the dashboards in a new tab." },
  ],
  auto: [{ what: "The sleeve's budget is read from the sleeve policy and what is deployed from booked purchases; nothing writes a pricing observation yet, so last-round pricing reads to confirm", when: "on every read" }],
  elsewhere: [
    { page: "dealflow", why: "every change to a secondary deal." },
    { page: "portfolio", why: "where a sale begins — Sell on the holding's row." },
    { page: "fund-strategy", why: "the sleeve policy that sets the budget." },
  ],
};
