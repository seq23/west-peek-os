import type { PageGuide } from "./types";

/** Work, as deployed on 287ee44 — the Desk, the Record, the Machinery. */
export const workGuide: PageGuide = {
  navKey: "work",
  title: "Work",
  purpose:
    "Three places: the Desk is what needs you and what is in flight, the Record is everything the firm has finished, the Machinery is what runs on a clock.",
  youCan: ["See what has stopped, and who is carrying what", "Write a card and hand it to an employee or your partner", "Search the record of everything finished", "Check the machinery is healthy"],
  sources: ["src/client/pages/WorkCardsPage.tsx", "src/client/pages/WorkRecordView.tsx", "src/client/pages/JobsPage.tsx", "src/shared/work/blocks.ts"],
  bands: [
    { name: "The answer", testid: "work-answer", shows: "whether anything is waiting on you, with Add a card beside it." },
    { name: "Desk · Record · Machinery", testid: "work-view-", shows: "the three tabs." },
    { name: "A deck is waiting on your decision", testid: "work-decks-waiting", shows: "proposed deck versions, with View and Decide on Fund strategy." },
    { name: "Waiting on you", testid: "work-owner-", shows: "blocked, unowned or yours — nothing moves until you act; each block says what was asked and what would clear it." },
    { name: "In flight", shows: "cards being worked; the sweep picks each up within five minutes and it ends Done or Blocked." },
    { name: "The record", testid: "work-record", shows: "everything finished, by month, searchable by words, who did it and when." },
    { name: "The machinery", testid: "jobs-page", shows: "every scheduled job — state, cadence, runs, and whether it is stalled or paused — and the on-request ones." },
  ],
  acts: [
    { label: "Add a card", testids: ["work-card-add-toggle", "work-card-submit"], primary: true, does: "writes a card — what needs doing, what happens next, who carries it, who it is for, which models may see it — and Add hands it over.", then: "An employee's card is picked up by the sweep within five minutes." },
    { label: "Answer it", testid: "work-card-block-", primary: true, does: "clears a block by answering what it asked; the other doors change the ask, drop it, send it to an engineer, retry, move it to another model, or hand it on." },
    { label: "Try it again now", testid: "work-card-block-do-", primary: true, does: "requeues a stopped card; Send it elsewhere stands the lane down for six hours; Stop using this one, for a week." },
    { label: "Give it to them", testid: "work-card-block-handon-", primary: true, does: "hands a blocked card to another employee and restarts it." },
    { label: "Send it", testid: "work-card-block-send-", primary: true, does: "sends your answer, change or escalation on a block." },
    { label: "Yes — open it", testid: "work-card-block-choice-", primary: true, does: "answers a page-permission block; No — carry on without it refuses it." },
    { label: "Done", testid: "work-card-done-", primary: true, does: "finishes a card; it goes to the Record. Start and Drop are beside it." },
    { label: "Send it over", testid: "work-card-steer-send-", primary: true, does: "tells the employee something mid-work; they pick it up on their next step." },
    { label: "Check a page", testid: "work-card-look-", does: "sends the employee to read a live page; Go and look runs now if the card has standing permission, otherwise Ask to look raises an approval card." },
    { label: "Reopen", testid: "work-card-undrop-", does: "puts a finished or dropped card back on the Desk." },
    { label: "Run everything due now", testid: "jobs-tick", does: "runs the tick by hand — every due job." },
    { label: "Run it now", testid: "job-run-", primary: true, does: "runs one job; Preview it to me runs it and emails only you; Pause… stops it with a reason; Put it back on resumes." },
    { label: "Decide on Fund strategy", does: "goes to the deck decision." },
  ],
  auto: [
    { what: "The sweep works the oldest employee-owned card, up to three attempts, ending Done or Blocked", when: "every five minutes", job: "employee_work_sweep" },
    { what: "An unanswered block is re-raised as a notification, and after three times says so", when: "on its nag date" },
    { what: "One cron trigger runs every due job, closes abandoned runs and serves the brief", when: "every tick" },
  ],
  elsewhere: [
    { page: "approvals", why: "where a Check a page request is signed for." },
    { page: "fund-strategy", why: "deciding a proposed deck version." },
    { page: "documents", why: "viewing a deck version." },
    { page: "employees", why: "who is employed to carry cards at all." },
  ],
};
