import type { PageGuide } from "./types";

/** Ask, as deployed on 287ee44 — the box, what it produced, and the checks. */
export const intentGuide: PageGuide = {
  navKey: "intent",
  title: "Ask",
  purpose:
    "Describe what you need in plain language. Ask works out whether a page already has it, whether it can just tell you, whether it is work somebody should carry, or a brief to be written — and shows you the plan before anything is created.",
  youCan: ["Ask a question about the firm", "Request work without knowing which page owns it", "Have a brief written and filed", "Put something through the checks before it runs"],
  sources: ["src/client/pages/IntentPage.tsx", "src/client/pages/DeliverableList.tsx"],
  bands: [
    { name: "What do you need?", testid: "ask-form", shows: "the box, three kinds of example, and then the plan — go there, an answer, a card to add, or a brief to write." },
    { name: "What you have asked for", testid: "ask-produced", shows: "every brief this page has written, newest first." },
    { name: "What checks it before it runs", testid: "ask-lenses", shows: "the bench of checks, a box to put something through them yourself, and what the checks are holding." },
  ],
  acts: [
    { label: "Ask", testid: "ask-submit", primary: true, does: "works out what you asked for and shows the plan." },
    { label: "Take me there", does: "opens the page that already has it." },
    { label: "Add to Work", testid: "ask-draft-add", primary: true, does: "opens the card as planned, owned by the employee it named.", then: "The sweep picks it up within five minutes." },
    { label: "Write it", testid: "ask-brief-write", primary: true, does: "writes the brief.", then: "Signed, filed in Documents, and on your Home." },
    { label: "Put it under the checks", testid: "intent-submit", primary: true, does: "holds a piece of work until every check that can stop it has been looked at." },
    { label: "Record it", testid: "packet-lens-save-", primary: true, does: "records your verdict on one check, in your words." },
    { label: "Run it", testid: "packet-execute", primary: true, does: "runs the held work once the checks allow it; the card it opens is on Work." },
    { label: "Send it to", testid: "deliverable-feedback-send-", primary: true, does: "passes your verdict on a brief back to whoever wrote it." },
  ],
  auto: [
    { what: "A brief unread for a week is put away by itself", when: "after seven days" },
    { what: "A card added here with an employee owner is worked by the sweep", when: "every five minutes", job: "employee_work_sweep" },
  ],
  elsewhere: [
    { page: "work", why: "the card Ask opened." },
    { page: "documents", why: "every brief, filed." },
  ],
};
