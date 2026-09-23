import type { PageGuide } from "./types";

/** Work, as deployed on 287ee44 — the Desk, the Record, the Machinery. */
export const workGuide: PageGuide = {
  navKey: "work",
  title: "Work",
  purpose:
    "Three places: the Desk is what needs you and what is being worked, one collapsed row per card with Show everything opening the whole card in place; the Record is everything the firm has finished; the Machinery is what runs on a clock.",
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
    "src/client/pages/work/CardExpanded.tsx",
    "src/client/pages/work/PreviewReadyPanel.tsx",
    "src/client/pages/work/NewWorkCard.tsx",
    "src/client/pages/work/BlockPanel.tsx",
    "src/client/pages/work/NotesPanel.tsx",
    "src/client/pages/work/LooksPanel.tsx",
    "src/client/pages/WorkRecordView.tsx",
    "src/client/pages/JobsPage.tsx",
    "src/shared/work/blocks.ts",
  ],
  bands: [
    { name: "The answer", testid: "work-answer", shows: "one line counted from the sections below — how many need you, how many are being worked, how many wait for their next try — with Add a card beside it." },
    { name: "Desk · Record · Machinery", testid: "work-view-", shows: "the three tabs." },
    { name: "Needs you", testid: "work-owner-needs", shows: "decks waiting on your decision, then cards that are blocked, unowned, held or yours — each one row: who has it, a plain title, one status and Show everything." },
    { name: "Being worked", testid: "work-owner-worked", shows: "cards an employee or your partner is carrying; Working now pulses only while something is actually running it, otherwise it says when the next try is." },
    { name: "The record", testid: "work-record", shows: "everything finished, by month, searchable by words, who did it and when." },
    { name: "The machinery", testid: "jobs-page", shows: "two lists of one-line rows: every scheduled job on a clock, sorted by time of day, and every one-off card moving on its own, tagged with where it came from." },
  ],
  acts: [
    { label: "Add a card", testids: ["work-card-add-toggle", "work-card-submit"], primary: true, does: "writes a card — what needs doing, what happens next, who carries it, who it is for, which models may see it — and Add hands it over.", then: "An employee's card is picked up by the sweep within five minutes." },
    { label: "Answer it", testid: "work-card-block-", primary: true, does: "clears a block by answering what it asked; the other doors change the ask, drop it, send it to an engineer, retry, move it to another model, or hand it on." },
    { label: "Try it again now", testid: "work-card-block-do-", primary: true, does: "requeues a stopped card; Send it elsewhere stands the lane down for six hours; Stop using this one, for a week." },
    { label: "Give it to them", testid: "work-card-block-handon-", primary: true, does: "hands a blocked card to another employee and restarts it." },
    { label: "Send it", testid: "work-card-block-send-", primary: true, does: "sends your answer, change or escalation on a block." },
    { label: "Yes — open it", testid: "work-card-block-choice-", primary: true, does: "answers a page-permission block; No — carry on without it refuses it." },
    { label: "Show everything", testid: "work-card-toggle-", does: "opens the whole card right under its row: where it is, what has happened, the details, a box to tell the employee something, and your request. Hide closes it." },
    { label: "Publish it", testid: "work-card-preview-publish-", primary: true, does: "on a website preview that is ready, replies \"approved\": the preview goes live as it is." },
    { label: "Send the changes", testid: "work-card-preview-changes-send-", primary: true, does: "after Ask for changes, sends what should change; a new preview follows." },
    { label: "Look and decide", testid: "work-deck-decide-", primary: true, does: "goes to the deck version waiting on your decision, to approve it or send it back." },
    { label: "Done", testid: "work-card-done-", primary: true, does: "finishes a card done by hand; it goes to the Record. Not offered on an employee's card in flight, which the employee finishes." },
    { label: "Stop this work", testid: "work-card-drop-", does: "decides not to do it; the card ends Stopped and is kept on the record." },
    { label: "Give it to someone else", testid: "work-card-reassign-", does: "hands the card to another employee, your partner or nobody." },
    { label: "Release it", testid: "work-card-release-", primary: true, does: "lets a card you put on hold be worked again; it re-queues fresh from the top." },
    { label: "Do it now", testid: "work-card-doitnow-", primary: true, does: "starts an employee-owned card that has not been picked up yet, ahead of the sweep's next five-minute pass — the same door the card's own page uses.", then: "it shows Working now on its next reload." },
    { label: "Send to", testid: "work-card-steer-send-", primary: true, does: "tells the employee something mid-work, from the box in the open card; they pick it up on their next step." },
    { label: "Check a page", testid: "work-card-look-", does: "sends the employee to read a live page; Go and look runs now if the card has standing permission, otherwise Ask to look raises an approval card." },
    { label: "Reopen", testid: "work-card-undrop-", does: "puts a finished or dropped card back on the Desk." },
    { label: "Run everything due now", testid: "jobs-tick", does: "runs the tick by hand — every due job." },
    { label: "Run it now", testid: "job-run-", primary: true, does: "runs one job; Preview it to me runs it and emails only you; Pause… stops it with a reason; Put it back on resumes." },
    { label: "Turn it on", testid: "oneoff-release-", primary: true, does: "flips on a one-off card she is holding for later — the same release Wave D's card page uses — right from its row on Machinery, no separate page visit.", then: "it re-queues fresh from the top and starts showing on the Desk too." },
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
        { do: "Press **Add a card** — what needs doing, who carries it, who it is for", then: "the card is on the Desk under **Being worked**; an employee owner is worked by the sweep on its next tick." },
        { do: "When a card shows under **Needs you**, press **Show everything**, then **Answer it**, **Give it to them** or **Try it again now**; a deck there has **Look and decide**", then: "the block clears and the card restarts; **Send it** carries your answer." },
        { do: "In an open card, type in the box and press **Send to** to tell the employee something mid-work", then: "they pick it up on their next step." },
        { do: "Press **Done** when it is finished", then: "the card goes to **The record**; **Reopen** brings it back." },
        { do: "Under **The machinery**, press **Run it now** on a job, or **Run everything due now**", then: "the job runs by hand; Preview it to me runs it and emails only you." },
        { do: "Still on **The machinery**, under One-off, press **Turn it on** on a card she is holding", then: "it re-queues fresh from the top and starts showing on the Desk too — no separate page visit." },
      ],
    },
  ],
};
