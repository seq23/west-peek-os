import type { PageGuide } from "./types";

/**
 * Meetings, as deployed on 287ee44 — the list, the Meet band, and one record with three faces.
 *
 * This is the page the owner asked Walter about on 19 Sep 2026 and was told "Prepare for a meeting
 * · Confer with an AI employee during it · Run a close-out" — the page before PRs #115, #122 and
 * #123. Every band and control below is what the page renders now, and the validator holds it there.
 */
export const meetingsGuide: PageGuide = {
  navKey: "meetings",
  title: "Meetings",
  purpose:
    "One room per meeting, several doors, all landing in it. Three faces — Before is the brief, During is the live room, After is what came out of it — and one approval makes it the record. Above it: coming up, on the record, the Google Meet switch.",
  youCan: [
    "Go to the next meeting's room, brief in hand, and join the call from there — inside it, beside it, or on the laptop mic",
    "Record on this laptop's microphone with consent, ask the room, and seat an employee",
    "Approve the draft of what came out — decisions, commitments, open questions, a stage move",
    "Turn the firm's Google Meet transcription on or off",
  ],
  sources: [
    "src/client/pages/MeetingsPage.tsx",
    "src/client/pages/CallDoors.tsx",
    "src/client/pages/MeetingFacesPanel.tsx",
    "src/client/pages/RoomPanel.tsx",
    "src/client/pages/LiveHelpPanel.tsx",
    "src/client/pages/CloseoutPanel.tsx",
    "src/client/pages/MeetBand.tsx",
  ],
  bands: [
    { name: "The answer", testid: "meetings-answer", shows: "what is waiting on you — stage moves, drafts — or that the next meeting's brief is ready." },
    { name: "Coming up", testid: "band-upcoming", shows: "meetings on the calendar, soonest first, each with its readiness and one door — Go to this meeting — with the call's doors beneath it. A meeting that has started is on the record as happening now." },
    { name: "On the record", testid: "band-record", shows: "every meeting held, newest first, with what it produced — decisions, commitments, open questions, a draft waiting." },
    { name: "Start a meeting now", testid: "band-start", shows: "the door for a meeting the calendar did not bring — title, type, company, now or later." },
    { name: "Google Meet", testid: "band-meet", shows: "the firm-default switch — transcribe every firm-hosted Meet — and whether Google is connected and syncing." },
    { name: "Before", testid: "face-", shows: "the brief: why this meeting, what we need to find out, what we said last time, the record, the diligence framework, who is in the room." },
    { name: "During", shows: "the room: how this room hears, the recording switch with consent every time, the rolling draft, Ask the room by text or hold-to-talk, what the room handed back, who is seated, the notes." },
    { name: "After", shows: "Move it on a proposed stage move, Decided, Still unknown, Owed — both sides, Saved from the room, who is holding each piece, and the draft with its one approval." },
  ],
  acts: [
    { label: "Go to this meeting", testid: "upcoming-open-", primary: true, band: "Coming up", does: "opens the one room for this meeting, on Before: the brief, then the live draft, ask the room, your employees, and what came out of it.", then: "Join the call from there, or open the room on its own." },
    { label: "Open the room", testid: "brief-open-room", band: "Before", does: "for a meeting without a call, goes from Before into the same room on During; with a call, the call's doors stand there instead." },
    { label: "Prepare for it", testid: "brief-build", primary: true, band: "Before", does: "builds the brief now; Build the brief again refreshes it.", then: "The brief is written from the record and the last meeting." },
    { label: "Record meeting", testid: "meeting-create-submit", primary: true, band: "Start a meeting now", does: "records a meeting the calendar did not bring, now or on the calendar." },
    { label: "Join on Meet", testid: "join-", band: "Coming up", does: "opens the call two ways, remembered: Beside the call — the Meet in a new tab, this room narrow in this one; Inside the call — the room as the Meet's side panel, once the add-on is installed." },
    { label: "Use my laptop mic for this Meet call", testid: "laptop-mic-", band: "Coming up", does: "opens the Meet and arms the room's recording switch through the same consent prompt — nothing records before They said yes.", then: "You directly, them through your speakers: speakers, not headphones; mic unmuted in Meet." },
    { label: "Open what came out of it", testid: "room-return-", band: "During", does: "from the room in its own window, once the call is over, goes back to After in the app with the draft as it stands." },
    { label: "Open what came out of it", testid: "meeting-open-", band: "On the record", does: "opens a past meeting on After." },
    { label: "Take it off the record", testids: ["archive-", "archive-confirm-"], primary: true, band: "On the record", does: "archives a meeting with a reason; its notes stay exactly where they are." },
    {
      label: "Firm default: transcribe every firm-hosted Google Meet",
      testids: ["meet-default-switch", "meet-default-activate"],
      band: "Google Meet",
      does: "turns the firm default on or off; Turn it on finishes it once the card is approved.",
      then: "Turning it on raises one approval card; turning it off is a Managing Partner's move.",
    },
    { label: "They said yes — record", testid: "consent-yes", primary: true, band: "During", does: "records their consent, every time, and starts recording; They said no records the refusal and nothing is captured." },
    { label: "Ask", testid: "room-ask-send", primary: true, band: "During", does: "asks the room a question, by text or Hold to talk.", then: "The answer is saved on the meeting; nothing becomes a record until you approve the draft." },
    { label: "Seat", testid: "seat-", band: "During", does: "seats an employee in the room: they answer by name in Ask the room and can take a task that returns here; Release takes them out.", then: "They read what is written down and are never in the Meet call. Revoke all AI access shuts the room to employees." },
    { label: "Add a note", testid: "note-submit", primary: true, band: "During", does: "adds a note, on or off the record." },
    { label: "Done — open the record", testids: ["live-finish", "room-finish-"], primary: true, band: "During", does: "leaves the room for After — from the app, or from the room in its own window back to the app." },
    { label: "Draft what came out of it", testid: "draft-run", primary: true, band: "After", does: "has the lead employee draft decisions, commitments, open questions and a stage move from the notes." },
    { label: "Approve — make these the record", testid: "draft-approve", primary: true, band: "After", does: "makes the draft the record.", then: "The one human card a meeting costs. Set it aside discards it." },
    { label: "Move it", testid: "stage-accept-", primary: true, band: "After", does: "accepts the stage move the meeting proposed.", then: "The deal moves at once — a click, not a card; Leave it where it is declines." },
    { label: "Record the answer", testid: "answer-save-", primary: true, band: "After", does: "answers a still-unknown question." },
    { label: "It was delivered", testid: "honour-", band: "After", does: "marks a commitment delivered; Make it a work card hands one of ours to an employee." },
    { label: "Record it", testid: "commitment-submit", primary: true, band: "After", does: "records something we owe them." },
    { label: "Run close-out", testid: "closeout-run", primary: true, band: "After", does: "has Walter read the notes and say who is holding each piece." },
    { label: "Open Dealflow", testid: "meetings-ic-open", band: "Google Meet", does: "goes to the committee, which lives on Dealflow now." },
  ],
  auto: [
    { what: "The partners' calendars are read and every Meet call appears under Coming up on its own", when: "every hour", job: "calendar_sync" },
    { what: "An ended Meet call — Google's own transcript and who was there — is read into its record; refused until the firm default is on", when: "every hour", job: "meet_ingest" },
    { what: "Nothing else writes a meeting down: the laptop microphone live, or Google's transcript after the call. Fireflies exports are no longer brought in", when: "since 19 Sep 2026" },
    { what: "A brief is written for every meeting in the next 36 hours that has none", when: "22:00 UTC nightly", job: "meeting_brief" },
    { what: "In the room, the draft rolls every five minutes while there is something new, and a recording posts a minute at a time", when: "while During is open" },
  ],
  elsewhere: [
    { page: "dealflow", why: "the committee, and the deal a stage move lands on." },
    { page: "approvals", why: "the Google Meet firm-default card." },
    { page: "work", why: "a commitment made into a work card." },
  ],
  /*
   * THE WALKTHROUGH WALTER GIVES (owner, 19 Sep 2026: "He skipped over the screen I get to when I
   * open the room and can seat AI employees … If I push Join on Meet what happens? … Are my AI
   * employees there from Join on Meet alone?"). Two scenarios: the calendar Meet call, and the
   * in-person one on the laptop microphone. Every bold control is one the page renders; every
   * "what does not happen" was read off the code before it was written.
   */
  walkthroughs: [
    {
      scenario: "A founder call that arrived from the calendar, on Google Meet",
      steps: [
        { do: "The call appears under **Coming up** on its own", then: "the partners' calendar is read every hour; the row says it is from the firm calendar and shows its readiness — brief or no brief, what to find out, what is owed each way." },
        { do: "The night before, the brief is written for it", then: "if it is not there yet, press **Prepare for it** on Before and it is built now from the record and the last meeting." },
        { do: "Press **Go to this meeting** on the row — one room, several doors", then: "the record opens on **Before**: the why-line, what we need to find out, what we said last time, the record, the diligence framework, and who is in the room. Everything else — the live draft, ask the room, your employees, what came out of it — is this same room's other faces." },
        { do: "Press **Seat** beside Wyatt under who is in the room", then: "Wyatt is in the room — address him by name in Ask the room, or hand him a task.", not: "he is not in the Google Meet call. He reads what is written down here: typed notes, and the recording when it is on." },
        { do: "Choose how to join, once, and press **Join on Meet**", then: "Beside the call: the Meet opens in a new tab and this room, narrow, in this one. Inside the call: the Meet with the room as its side panel, once the add-on is installed — until then it says so and opens beside. The **During** face in the app is the same room.", not: "nothing joins for you; no employee is in the call. Google's transcript is read in within the hour after it ends." },
        { do: "Or press **Use my laptop mic for this Meet call**", then: "the Meet opens and the room's consent prompt opens here — ask them out loud and press **They said yes — record**. The room hears you directly and them through your speakers: speakers, not headphones; mic unmuted in Meet. The line reads laptop mic · live.", not: "nothing records before their yes; Google's transcript still arrives after the call as the authoritative record." },
        { do: "During the call, type a question and press **Ask**, or hold the talk button and speak", then: "Walter answers from the brief, the record and what is written down so far; the answer is saved on the meeting under what the room handed back." },
        { do: "Type “Wyatt, pull the district contacts” and press **Ask**", then: "Wyatt takes it as a task: a work card opens, preview-first, and his result comes back into the room as a block with a chip beside his seat." },
        { do: "Hang up in Meet; the room shows **Open what came out of it** once Google reports the call ended, or press **Done — open the record**", then: "back to After in the app, with the draft as it stands. Within the hour Google's transcript and the participants land on this record; After says where this came from, with the time." },
        { do: "Press **Draft what came out of it**", then: "Walter reads the notes and the transcript and proposes decisions, commitments, open questions and a stage move. Nothing is a record yet." },
        { do: "Press **Approve — make these the record**", then: "the four things become the record — the one human card a meeting costs. Set it aside discards the draft." },
        { do: "Press **Move it** on the proposed stage move", then: "the deal moves on Dealflow at once; Leave it where it is declines it." },
      ],
    },
    {
      scenario: "In person or by phone — no calendar, the laptop microphone",
      steps: [
        { do: "Under **Start a meeting now**, give it a title, a type and a company, and press **Record meeting**", then: "the one room opens on During if it is happening right now, on Before if you gave it a time; **Open the room** on Before goes into it, since there is no call." },
        { do: "Press **Seat** beside anyone you want in the room", then: "they answer by name in Ask the room and read what is written down." },
        { do: "Switch recording on — it opens the consent prompt — ask them out loud, and press **They said yes — record**", then: "the laptop microphone records a minute at a time and each minute is written down; their yes is on the file for this meeting and is asked for again every session. They said no records the refusal and nothing is captured.", not: "nothing starts until a Managing Partner has switched recording on for this meeting; the line under the switch says which gate is shut." },
        { do: "Press **Ask** as you go; press **Add a note** for anything said while the recording was off", then: "answers and notes are saved on the meeting." },
        { do: "Press **Done — open the record**, then **Draft what came out of it**, then **Approve — make these the record**", then: "After says where this came from — laptop capture, with the minutes and the times." },
      ],
    },
  ],
};
