import type { PageGuide } from "./types";

/** Approvals, as deployed on 287ee44 — the queue, and the standing authority above it. */
export const approvalsGuide: PageGuide = {
  navKey: "approvals",
  title: "Approvals",
  purpose:
    "Everything waiting on a human decision. Nothing leaves the firm and no reserved action happens without a card here — and above the queue, what you have delegated so it stops asking.",
  youCan: [
    "Approve, send back or reject a card",
    "Block it until something else is sorted out",
    "Change a decision you have already made",
    "See what you have delegated, and stop it",
  ],
  sources: ["src/client/pages/ApprovalsPage.tsx", "src/client/pages/ApprovalContextPanel.tsx"],
  bands: [
    { name: "What you have delegated", testid: "standing-authority", shows: "every standing grant — anything it covers is approved without asking you — with Stop this on each." },
    { name: "The filter", testid: "approval-filter", shows: "waiting, blocked, drafted, approved, rejected, sent back or executed." },
    { name: "The cards", testid: "approval-list", shows: "one card per request — what it is, who asked, who may decide it, the evidence and questions on it, the decision form, and how it got here." },
  ],
  acts: [
    {
      label: "Approve",
      testid: "approve-",
      primary: true,
      does: "approves the card, with a note if you want one.",
      then: "The action executes through the firm's one choke point.",
      who: "whoever holds a role the card names — usually a Managing Partner",
    },
    { label: "Send back for changes", testid: "revise-", does: "returns it to whoever asked, for changes." },
    { label: "Reject", testid: "reject-", does: "ends the request." },
    { label: "Approve, and don't ask again", testid: "delegate-", does: "approves it and delegates the rest — until this task is done, for the rest of today, or this week — with a reason. Reserved actions come back to you every time." },
    { label: "Block until that is resolved", testid: "block-", does: "holds the card, saying what it is waiting on; not a no, just not yet." },
    { label: "Release the block", testid: "release-", primary: true, does: "lifts the block with a reason; it decides nothing." },
    { label: "Change this decision", testid: "reopen-", does: "reopens a decided card, with a reason; the old decision stays on the record as superseded." },
    { label: "Attach", does: "attaches evidence to the card." },
    { label: "Ask", testid: "approval-comment-send-", does: "asks a question on the card; comments are part of the record and cannot be edited." },
    { label: "Stop this", testid: "standing-authority-revoke-", does: "revokes a standing grant at once; no reason, no approval." },
  ],
  auto: [
    { what: "Cards are raised whenever a reserved action is requested — from a work card, a transaction, a letter, an employment, an allocation — and each raise also lands in Notifications", when: "as it happens" },
    { what: "A live standing grant approves a matching card the moment it arrives, until its window or its uses run out", when: "on arrival" },
    { what: "A card past its date is flagged as waiting too long; nothing decides it for you", when: "on every read" },
  ],
  elsewhere: [
    { page: "work", why: "the card that asked, when the request came from work." },
    { page: "home", why: "the same waiting cards, decided inline." },
  ],
  walkthroughs: [
    {
      scenario: "A card arrives",
      steps: [
        { do: "Read the card under **The cards** — what it asks, the evidence, the history", then: "**The filter** narrows the queue to a kind or a state." },
        { do: "Press **Approve**, **Send back for changes** or **Reject**", then: "the decision is on the record at once.", not: "nothing leaves the firm without one of these; silence is never approval." },
        { do: "Press **Approve, and don't ask again** when the same ask keeps coming", then: "the rest is delegated with a reason — until this task is done, today, or this week — and shows under **What you have delegated**; **Stop this** revokes it at once.", not: "reserved actions come back to you every time regardless." },
        { do: "Press **Block until that is resolved** when the answer is not yet", then: "the card is held, saying what it waits on; **Release the block** lifts it." },
        { do: "Press **Change this decision** if you were wrong", then: "the card reopens with your reason; the old decision stays on the record as superseded." },
      ],
    },
  ],
};
