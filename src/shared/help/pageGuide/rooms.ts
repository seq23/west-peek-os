import type { PageGuide } from "./types";

/** Events & Rooms, as deployed on 287ee44 — Parker's proposals, the request door, the record of gatherings, the rhythm, the sponsors. */
export const roomsGuide: PageGuide = {
  navKey: "rooms",
  title: "Events & Rooms",
  purpose:
    "How West Peek gathers: the Rooms and Workshops Parker proposes and a partner keeps or dismisses, the door to ask him for one, every gathering on the record, the rhythm at full speed, and the sponsors paying for it.",
  youCan: ["Keep or dismiss the Room proposed this month", "Ask Parker for a Room or a Workshop", "Put a gathering on the record and close it out", "Work the sponsor pipeline"],
  sources: ["src/client/pages/RoomsPage.tsx", "src/client/pages/EventsPage.tsx"],
  bands: [
    { name: "Rooms waiting on you", testid: "rooms-waiting", shows: "each packet Parker has built or is building — concepts, invite list, agenda, venues, sponsors, budget, pitch, risks — with keep or dismiss." },
    { name: "Ask Parker for a Room", testid: "request-room", shows: "Room or Workshop, the audience, the month, the city, sponsors to try, and whether to build it now or hold it for its month." },
    { name: "What Parker has been told", testid: "steer-board", shows: "steers held for months he has not built yet." },
    { name: "Approved Rooms", testid: "rooms-approved", shows: "the packets a partner kept." },
    { name: "Workshops", testid: "workshops-heading", shows: "workshops waiting and approved, the same shape as Rooms." },
    { name: "Every gathering on the record", testid: "events-list", shows: "each gathering with where it is in its life, and the close-out once it is over." },
    { name: "Put a gathering on the record", testid: "event-create-form", shows: "title, type, when, and a live link." },
    { name: "Rooms we turned down", testid: "declined-proposals", shows: "every dismissed proposal with the note." },
    { name: "How often West Peek gathers", testid: "programme-rhythm", shows: "the stance, the money, and the rhythm at full speed." },
    { name: "Who is paying for it", testid: "sponsor-table", shows: "every sponsor prospect and where each stands, with a form to add one." },
  ],
  acts: [
    { label: "Keep this", testid: "approve-", primary: true, does: "approves the Room or Workshop packet.", then: "It moves to Approved.", who: "a person, never an employee" },
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
    { label: "Add prospect", testid: "add-sponsor", does: "adds a sponsor prospect; the select on each row moves it along the pipeline." },
  ],
  auto: [
    { what: "Parker proposes the month's Room, delivering any steer held for that month", when: "the 1st of the month before", job: "monthly_room_proposal" },
    { what: "The sweep builds a requested packet one stage at a time — discover, research, concepts, venues, packet, kit, PDF — and emails both partners when the PDF is ready", when: "every few minutes", job: "employee_work_sweep" },
  ],
  elsewhere: [
    { page: "work", why: "Parker's card while he is building a packet." },
    { page: "community", why: "the people a Room is for." },
  ],
  walkthroughs: [
    {
      scenario: "Parker proposes a Room and you keep it",
      steps: [
        { do: "Under **Ask Parker for a Room**, press **Ask Parker for this** with a topic, or **Or let Parker think of one**", then: "the steer waits for its month; **Take it back** withdraws it before then." },
        { do: "A packet appears under **Rooms waiting on you** — press **Download the packet (PDF)** and read it" },
        { do: "Press **Keep this** or **Dismiss it**", then: "the Room moves to **Approved Rooms**, or is turned down with a note it keeps; **Propose again with changes** refills the door from a dismissed one.", not: "an employee can never press Keep this." },
        { do: "Press **I called — confirmed** once you have rung the venue", then: "the venue check is on the record." },
        { do: "Press **Put it on the calendar** as it moves along, then **Close it out** when it is over", then: "with notes, Parker extracts what West Peek committed to and opens the cards." },
        { do: "Under **Put a gathering on the record**, press **Put it on the record** for one that happened another way; under **Who is paying for it**, press **Add prospect**", then: "the gathering and the sponsor prospect are on the record." },
      ],
    },
  ],
};
