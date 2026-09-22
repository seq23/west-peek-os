import type { PageGuide } from "./types";

/** Work, as deployed on 287ee44 — the Desk, the Record, the Machinery. */
export const workGuide: PageGuide = {
  navKey: "work",
  title: "Work",
  purpose:
    "Three places: the Desk is what needs you and what is in flight, the Record is everything the firm has finished, the Machinery is what runs on a clock.",
  youCan: ["See what has stopped, and who is carrying what", "Write a card and hand it to an employee or your partner", "Search the record of everything finished", "Check the machinery is healthy"],
  /*
   * THE WORK SURFACE IS FIVE FILES NOW (22 Sep 2026). `WorkCardsPage.tsx` was 1,588 lines and was
   * split into a shell plus `pages/work/`; naming only the shell here would leave
   * `validate:page-guides` reading a file that no longer emits most of the page's testids, and it
   * would pass having checked almost nothing.
   */
  sources: [
    "src/client/pages/WorkCardsPage.tsx",
    "src/client/pages/work/WorkDesk.tsx",
    "src/client/pages/work/NewWorkCard.tsx",
    "src/client/pages/work/BlockPanel.tsx",
    "src/client/pages/work/NotesPanel.tsx",
    "src/client/pages/work/LooksPanel.tsx",
    "src/client/pages/WorkRecordView.tsx",
    "src/client/pages/JobsPage.tsx",
    "src/shared/work/blocks.ts",
  ],
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
    { label: "Do it now", testid: "work-card-doitnow-", primary: true, does: "starts an employee-owned card that has not been picked up yet, right on the Desk row, ahead of the sweep's next five-minute pass — the same door the card's own page uses.", then: "it moves to In flight on its next reload." },
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
  walkthroughs: [
    {
      scenario: "A card from Desk to Record",
      steps: [
        { do: "Press **Add a card** under **Waiting on you** — what needs doing, who carries it, who it is for", then: "the card is on the Desk; an employee owner is worked by the sweep on its next tick." },
        { do: "When a card stops under **A deck is waiting on your decision** or with a block, press **Answer it**, **Give it to them** or **Try it again now**", then: "the block clears and the card restarts; **Send it** carries your answer." },
        { do: "Press **Send it over** to tell the employee something mid-work", then: "they pick it up on their next step." },
        { do: "Press **Done** when it is finished", then: "the card goes to **The record**; **Reopen** brings it back." },
        { do: "Under **The machinery**, press **Run it now** on a job, or **Run everything due now**", then: "the job runs by hand; Preview it to me runs it and emails only you." },
      ],
    },
  ],
};
