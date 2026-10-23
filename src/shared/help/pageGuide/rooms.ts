import type { PageGuide } from "./types";

/** Events & Rooms, as redesigned on 23 Oct 2026 (the approved v8 mock-up): the first of four pages — ideas, the record, asking Parker, and every Room and Workshop through its life. */
export const roomsGuide: PageGuide = {
  navKey: "rooms",
  title: "Events & Rooms",
  purpose:
    "How West Peek gathers: the ideas, asking Parker for a Room or a Workshop, every Room from proposed to kept to scheduled, and the record. The Learning Club, Room sponsors and the Research library are one tap away.",
  youCan: ["Add an idea, or a note to one", "Ask Parker for a Room or a Workshop", "Keep a Room for later, then schedule it", "Put a gathering on the record and close it out"],
  sources: ["src/client/pages/RoomsPage.tsx", "src/client/pages/EventsPage.tsx", "src/client/pages/LearningClubPanel.tsx", "src/client/pages/RoomsLinks.tsx", "src/client/pages/ScheduleRoom.tsx"],
  bands: [
    { name: "The links row", testid: "rooms-links", shows: "The Learning Club, Room sponsors and the Research library, each one tap away, and ← Back." },
    { name: "Ideas", testid: "tlc-ideas-card", shows: "every topic idea once, with who sent it, its notes, a filter, a search, and the form to add one." },
    { name: "Put a gathering on the record", testid: "event-create-form", shows: "title, type, when, and a live link." },
    { name: "Ask Parker for a Room", testid: "ask-parker", shows: "what is waiting on you, and the request: Room or Workshop, audience, month, city, sponsors to try." },
    { name: "What Parker has been told", testid: "steer-board", shows: "steers held for months he has not built yet." },
    { name: "Scheduled Rooms", shows: "Rooms with a date; their sponsors are live." },
    { name: "Kept for later", shows: "Rooms the firm kept, with their sponsors parked, and Schedule this Room on each." },
    { name: "Workshops", shows: "workshops waiting and approved, the same shape as Rooms." },
    { name: "Every gathering on the record", shows: "each gathering with where it is in its life, and the close-out once it is over." },
    { name: "Rooms we turned down", testid: "declined-proposals", shows: "every dismissed proposal with the note." },
    { name: "How this works", shows: "Parker's card, how events work here, how often West Peek gathers, and the full guide." },
  ],
  acts: [
    { label: "Keep this", testid: "approve-", primary: true, does: "keeps the Room or Workshop packet for later.", then: "It moves to Kept for later, its sponsors parked.", who: "a person, never an employee" },
    { label: "Schedule this Room", testid: "schedule-open-", primary: true, does: "gives a kept Room a date and a place, after asking first.", then: "It is on the calendar and its sponsors go live.", who: "a person" },
    { label: "Add a note to this idea", testid: "tlc-idea-note-add-", does: "saves a note under an idea, with who and when." },
    { label: "Dismiss it", testid: "decline-", does: "turns the proposal down, with a note it keeps." },
    { label: "Download the packet (PDF)", testid: "download-packet-", primary: true, does: "saves the packet Parker produced." },
    { label: "I called — confirmed", testid: "confirm-", does: "records that you rang the venue and it checked out; the other two buttons record wrong details or no answer." },
    {
      label: "Ask Parker for this",
      testid: "request-room-submit",
      primary: true,
      does: "hands Parker the request for a Room or a Workshop; Hold this for a month parks it as a steer instead.",
      then: "A card lands on his desk on Work and the sweep builds the packet stage by stage.",
    },
    { label: "Or let Parker think of one", testid: "propose-room", does: "asks him to propose a Room for the month with no brief." },
    { label: "Take it back", testid: "steer-withdraw-", does: "withdraws a steer before its month." },
    { label: "Put it on the calendar", testid: "event-advance-", does: "moves a gathering through its life — on the calendar, happening now, over." },
    { label: "Close it out", testid: "closeout-run-", primary: true, does: "closes a gathering that is over.", then: "With notes, Parker extracts what West Peek committed to and opens the cards." },
    { label: "Put it on the record", testid: "event-create", primary: true, does: "records a gathering." },
    { label: "Propose again with changes", testid: "again-", does: "refills the request door from a dismissed proposal." },
  ],
  auto: [
    { what: "Parker proposes the month's Room, delivering any steer held for that month", when: "the 1st of the month before", job: "monthly_room_proposal" },
    { what: "The sweep builds a requested packet one stage at a time — discover, research, concepts, venues, packet, kit, PDF — and emails both partners when the PDF is ready", when: "every few minutes", job: "employee_work_sweep" },
  ],
  elsewhere: [
    { page: "learning-club", why: "The Learning Club: sending, the next three clubs, who we pitch, and partners who said yes." },
    { page: "room-sponsors", why: "who is paying for each Room, with Schedule this Room and Add a sponsor to a Room." },
    { page: "research-library", why: "the research pages, the trend story and the regulatory checks." },
    { page: "work", why: "Parker's card while he is building a packet." },
    { page: "community", why: "the people a Room is for." },
  ],
  walkthroughs: [
    {
      scenario: "Parker proposes a Room and you keep it",
      steps: [
        { do: "Under **Ask Parker for a Room**, press **Ask Parker for this** with a topic, or **Or let Parker think of one**", then: "the steer waits for its month; **Take it back** withdraws it before then." },
        { do: "A packet appears under **Ask Parker for a Room** — press **Download the packet (PDF)** and read it" },
        { do: "Press **Keep this** or **Dismiss it**", then: "the Room moves to **Kept for later**, or is turned down with a note it keeps; **Propose again with changes** refills the door from a dismissed one.", not: "an employee can never press Keep this." },
        { do: "Press **Schedule this Room** with a date and a place", then: "it moves to **Scheduled Rooms** and its sponsors go live." },
        { do: "Press **I called — confirmed** once you have rung the venue", then: "the venue check is on the record." },
        { do: "Press **Put it on the calendar** as it moves along, then **Close it out** when it is over", then: "with notes, Parker extracts what West Peek committed to and opens the cards." },
        { do: "Under **Put a gathering on the record**, press **Put it on the record** for one that happened another way; under **Ideas**, press **Add a note to this idea**", then: "the gathering and the note are on the record." },
      ],
    },
  ],
};
