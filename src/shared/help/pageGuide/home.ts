import type { PageGuide } from "./types";

/**
 * Home, as rebuilt in #128 (design/HOME_DESIGN.md, approved 19 Sep 2026): one count, the filter
 * rail, decide on the row, Mark all read, the brief as one band, the foot line.
 *
 * `validate:page-guides` holds this file to `HomePage.tsx` and what it mounts. A control the page
 * grows and this file does not name fails the build — which is how this file came to be rewritten
 * the hour #128 landed, rather than a week later when somebody asked.
 */
export const homeGuide: PageGuide = {
  navKey: "home",
  title: "Home",
  purpose: "What is waiting on you, what arrived since you last looked, and today's brief — on demand.",
  youCan: [
    "Approve, reject or open what is waiting on you, from the row",
    "Mark what arrived as read, one or all at once",
    "Build today's brief and watch it arrive",
    "Filter Home to what is waiting, what arrived, or who is quiet",
  ],
  sources: [
    "src/client/pages/HomePage.tsx",
    "src/client/pages/DailyBriefPanel.tsx",
    "src/client/pages/PreviewApprovals.tsx",
    "src/client/pages/DeliverableList.tsx",
  ],
  bands: [
    { name: "The answer", testid: "home-masthead", shows: "one count — how many things are waiting on you — and what kinds, in words." },
    { name: "The rail", testid: "home-rail", shows: "All · Waiting on me · Arrived · Quiet, with the counts; pick one and ← Home brings everything back. Remembered per viewer, never opens on an empty band." },
    { name: "Waiting on you", testid: "home-waiting", shows: "approval cards with Approve · Reject · Open on the row, previews to send, and blockers with I know — quiet for a week. Cards are decided one at a time, never in a batch." },
    { name: "Arrived", testid: "home-deliverables", shows: "what your employees delivered since you last looked, and which colleagues have something new — with Mark all read, Select… for many, and Undo after a put-away." },
    { name: "Today's brief", testid: "home-brief-delivery", shows: "the brief in one of eight named states — none today, requested, building, running long, arrived, retrying, failed out, stalled — and one button whose label says what it will do." },
    { name: "Quiet", testid: "home-quiet", shows: "the colleagues with nothing new, in one line; under the Quiet filter, each as a dimmed row with one door." },
    { name: "The foot", testid: "home-foot", shows: "Ask for anything → · Choose what Home shows · Setup — N of M connected · Private layer." },
  ],
  acts: [
    {
      label: "Approve",
      testid: "home-approve-",
      primary: true,
      does: "approves the card from the row, with a note if you want one.",
      then: "The action executes; the row shows the outcome and leaves on the next read.",
      who: "whoever holds a role the card names",
    },
    { label: "Reject", testid: "home-reject-", does: "opens a one-line reason under the row; Never mind closes it." },
    { label: "Open", testid: "home-waiting-open-", does: "opens the card on Approvals, with its evidence and history." },
    { label: "Send it", testid: "preview-send-", primary: true, does: "sends a previewed email as it is; Send it back returns it with a note; Dismiss drops it." },
    { label: "I know — quiet for a week", testid: "home-attention-ack-", does: "quiets a blocker for a week; it is still true and comes back." },
    {
      label: "I know — quiet selected for a week",
      testids: ["home-waiting-select", "home-waiting-quiet-selected"],
      primary: true,
      does: "after Select…, quiets every ticked blocker; Stop telling me silences them for good — only from the select bar, on purpose.",
    },
    { label: "Bring them back", testid: "home-attention-unsilence", does: "unsilences the blockers you told to stop." },
    { label: "Mark all read", testid: "home-mark-all-read", does: "marks everything that arrived as read, in one press." },
    {
      label: "Mark read",
      testids: ["home-arrived-select", "home-arrived-read-selected"],
      primary: true,
      does: "after Select…, marks the ticked arrivals read; Put away shelves them, and Undo brings a put-away back.",
    },
    { label: "Mark as read", testid: "deliverable-ack-", does: "marks one delivered item read; Put it away shelves it; Download and Email it to me take it with you." },
    { label: "Send it to", testid: "deliverable-feedback-send-", primary: true, does: "passes your verdict on a delivered item back to whoever wrote it." },
    {
      label: "Build today's brief",
      testid: "daily-brief-generate",
      primary: true,
      does: "asks for today's brief now; the label follows the state — Rebuild, Try again now, Start over now, or disabled while it is building.",
      then: "The band shows the stage and how long it usually takes.",
    },
    { label: "All", testid: "home-rail-", does: "shows everything; Waiting on me, Arrived and Quiet show one band, and ← Home returns." },
    { label: "Ask for anything →", testid: "home-ask-open", does: "opens Ask." },
    { label: "Choose what Home shows", testid: "home-settings-toggle", does: "opens the module settings in place; Save keeps them." },
    { label: "Setup", testid: "home-setup-toggle", does: "opens the connections panel — what is connected, and what is not." },
    { label: "Private layer", testid: "home-private-link", does: "opens your private notes on their own page." },
  ],
  auto: [
    { what: "The brief is built only when you ask; it reads the last 48 hours of sources, ranks them, writes, and checks every claim — the band polls every five seconds while it moves", when: "on request", job: "daily_intelligence" },
    { what: "A delivered item unread for a week is put away by itself", when: "after seven days" },
    { what: "Your own brief's failure is folded into the brief band; your partner's stays a blocker under Waiting on you", when: "when a brief fails" },
  ],
  elsewhere: [
    { page: "approvals", why: "the card behind a waiting row, with its evidence, questions and history." },
    { page: "intent", why: "asking for anything in your own words." },
    { page: "notifications", why: "everything that arrived, including what is only worth knowing." },
    { page: "private", why: "the private layer — your own notes, off Home." },
  ],
  notActs: {
    "home-settings-save": "Save inside Choose what Home shows keeps the module choice; the act named is the door that opens it.",
  },
  walkthroughs: [
    {
      scenario: "A morning: what is waiting, what arrived, today's brief",
      steps: [
        { do: "Open Home", then: "the answer line says the one thing that matters — how many cards wait on you, or that nothing does — and the rail under it narrows to one band." },
        { do: "Press **Approve** or **Reject** on a card under **Waiting on you**", then: "the decision is recorded here; **Open** takes you to the card on Approvals when you want the evidence first." },
        { do: "Press **Send it** on a previewed email", then: "it goes as it is; Send it back returns it with a note." },
        { do: "Under **Arrived**, press **Mark as read** on a delivered item, or **Mark all read**", then: "the item is read; **Send it to** passes your verdict back to whoever wrote it." },
        { do: "Press **Build today's brief**", then: "the brief is written now, on demand, from what is on the record — it goes to nobody but you." },
        { do: "Press **I know — quiet for a week** on a blocker you have seen", then: "it stops asking for a week; **Bring them back** unsilences it.", not: "nothing is fixed by quieting it; it is still true and returns." },
      ],
    },
  ],
};
