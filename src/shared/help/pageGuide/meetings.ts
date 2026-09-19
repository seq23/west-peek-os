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
    "One meeting is one record with three faces: Before is the brief, During is the room, After is what came out of it — and one approval makes it the record. Above the record, what is coming up, what is on the record, and the Google Meet switch.",
  youCan: [
    "Open the room for the next meeting, brief in hand",
    "Record with consent, ask the room, and seat an employee",
    "Approve the draft of what came out — decisions, commitments, open questions, a stage move",
    "Turn the firm's Google Meet transcription on or off",
  ],
  sources: [
    "src/client/pages/MeetingsPage.tsx",
    "src/client/pages/MeetingFacesPanel.tsx",
    "src/client/pages/RoomPanel.tsx",
    "src/client/pages/LiveHelpPanel.tsx",
    "src/client/pages/CloseoutPanel.tsx",
    "src/client/pages/MeetBand.tsx",
  ],
  bands: [
    { name: "The answer", testid: "meetings-answer", shows: "what is waiting on you — stage moves, drafts — or that the next meeting's brief is ready." },
    { name: "Coming up", testid: "band-upcoming", shows: "meetings on the calendar, soonest first, each with its readiness: brief ready, what to find out, what is owed each way." },
    { name: "On the record", testid: "band-record", shows: "every meeting held, newest first, with what it produced — decisions, commitments, open questions, a draft waiting." },
    { name: "Start a meeting now", testid: "band-start", shows: "the door for a meeting the calendar did not bring — title, type, company, now or later." },
    { name: "Google Meet", testid: "band-meet", shows: "the firm-default switch — transcribe every firm-hosted Meet — and whether Google is connected and syncing." },
    { name: "Before", testid: "face-", shows: "the brief: why this meeting, what we need to find out, what we said last time, the record, the diligence framework, who is in the room." },
    { name: "During", shows: "the room: the recording switch with consent every time, the rolling draft, Ask the room by text or hold-to-talk, what the room handed back, who is seated, the notes." },
    { name: "After", shows: "Move it on a proposed stage move, Decided, Still unknown, Owed — both sides, Saved from the room, who is holding each piece, and the draft with its one approval." },
  ],
  acts: [
    { label: "Open the room", testids: ["upcoming-open-", "brief-open-room"], primary: true, does: "opens the meeting on Before, or from Before goes into the room." },
    { label: "Prepare for it", testid: "brief-build", primary: true, does: "builds the brief now; Build the brief again refreshes it.", then: "The brief is written from the record and the last meeting." },
    { label: "Record meeting", testid: "meeting-create-submit", primary: true, does: "records a meeting the calendar did not bring, now or on the calendar." },
    { label: "Join on Meet", testid: "join-", does: "opens the Google Meet call in a new tab." },
    { label: "Open what came out of it", testid: "meeting-open-", does: "opens a past meeting on After." },
    { label: "Take it off the record", testids: ["archive-", "archive-confirm-"], primary: true, does: "archives a meeting with a reason; its notes stay exactly where they are." },
    {
      label: "Firm default: transcribe every firm-hosted Google Meet",
      testids: ["meet-default-switch", "meet-default-activate"],
      does: "turns the firm default on or off; Turn it on finishes it once the card is approved.",
      then: "Turning it on raises one approval card; turning it off is a Managing Partner's move.",
    },
    { label: "They said yes — record", testid: "consent-yes", primary: true, does: "records their consent, every time, and starts recording; They said no records the refusal and nothing is captured." },
    { label: "Ask", testid: "room-ask-send", primary: true, does: "asks the room a question, by text or Hold to talk.", then: "The answer is saved on the meeting; nothing becomes a record until you approve the draft." },
    { label: "Seat", testid: "seat-", does: "seats an employee in the room; Release takes them out; Revoke all AI access shuts the room to employees." },
    { label: "Add a note", testid: "note-submit", primary: true, does: "adds a note, on or off the record." },
    { label: "Bring it in", testid: "fireflies-submit", primary: true, does: "brings in a Fireflies transcript." },
    { label: "Done — open the record", testid: "live-finish", primary: true, does: "leaves the room for After." },
    { label: "Draft what came out of it", testid: "draft-run", primary: true, does: "has the lead employee draft decisions, commitments, open questions and a stage move from the notes." },
    { label: "Approve — make these the record", testid: "draft-approve", primary: true, does: "makes the draft the record.", then: "The one human card a meeting costs. Set it aside discards it." },
    { label: "Move it", testid: "stage-accept-", primary: true, does: "accepts the stage move the meeting proposed.", then: "The deal moves at once — a click, not a card; Leave it where it is declines." },
    { label: "Record the answer", testid: "answer-save-", primary: true, does: "answers a still-unknown question." },
    { label: "It was delivered", testid: "honour-", does: "marks a commitment delivered; Make it a work card hands one of ours to an employee." },
    { label: "Record it", testid: "commitment-submit", primary: true, does: "records something we owe them." },
    { label: "Run close-out", testid: "closeout-run", primary: true, does: "has Walter read the notes and say who is holding each piece." },
    { label: "Open Dealflow", testid: "meetings-ic-open", does: "goes to the committee, which lives on Dealflow now." },
  ],
  auto: [
    { what: "The partners' calendars are read and every Meet call appears under Coming up on its own", when: "every hour", job: "calendar_sync" },
    { what: "An ended Meet call is read into its record — refused until the firm default is on", when: "every hour", job: "meet_ingest" },
    { what: "A brief is written for every meeting in the next 36 hours that has none", when: "22:00 UTC nightly", job: "meeting_brief" },
    { what: "In the room, the draft rolls every five minutes while there is something new, and a recording posts a minute at a time", when: "while During is open" },
  ],
  elsewhere: [
    { page: "dealflow", why: "the committee, and the deal a stage move lands on." },
    { page: "approvals", why: "the Google Meet firm-default card." },
    { page: "work", why: "a commitment made into a work card." },
  ],
};
