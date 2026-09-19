import type { PageGuide } from "./types";

/** Record, as deployed on 287ee44 — three read-only views. */
export const recordGuide: PageGuide = {
  navKey: "record",
  title: "Record",
  purpose:
    "Three read-only views: every decision the firm has made and why, every claim it treats as true and what backs it, and who is carrying which open work. Nothing changes here — the pages that own each record are where changes happen.",
  youCan: ["Look up what was decided and why", "Check whether a claim is actually evidenced", "See whose queue work is sitting in"],
  sources: ["src/client/pages/LedgersPage.tsx"],
  bands: [
    { name: "Decision journal", testid: "decision-journal", shows: "investment, approval, build-or-buy and source-conflict decisions, with who decided." },
    { name: "Evidence ledger", testid: "evidence-ledger", shows: "every claim, how many sources back it, and how many are unsourced." },
    { name: "Work queues", testid: "work-queues", shows: "open and blocked cards, grouped by who is carrying them." },
  ],
  acts: [
    { label: "Decision journal", testid: "ledger-tab-decisions", does: "shows the decisions." },
    { label: "Evidence ledger", testid: "ledger-tab-evidence", does: "shows the claims and their sources." },
    { label: "Work queues", testid: "ledger-tab-queues", does: "shows who is carrying what." },
  ],
  auto: [
    { what: "Decisions are written by Dealflow, Approvals and the source-conflict resolver; claims by research and intelligence; queues by the sweep", when: "as they happen", job: "employee_work_sweep" },
  ],
  elsewhere: [
    { page: "contradictions", why: "where two claims disagree and a person settles it." },
    { page: "work", why: "to act on a card in a queue." },
  ],
};
