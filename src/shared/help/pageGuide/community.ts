import type { PageGuide } from "./types";

/**
 * Community — the Network OS band with its two doors, the population read as four numbers and two
 * rings, and the newest names. One roster (27 Sep 2026): the member form, the members list and the
 * mix that wrote to a local table are gone, and Introductions is retired from this page while the
 * operator decides where it belongs.
 */
export const communityGuide: PageGuide = {
  navKey: "community",
  title: "Community",
  purpose:
    "The community as a population — how many people, how many the firm can place, how warm it is, and who arrived most recently — read from Network OS, which owns who is a member.",
  youCan: [
    "See the shape of the community as four numbers and two rings, and how warm it is",
    "See the last 25 people added in Network OS",
    "Capture someone new so they go to Network OS's review queue",
    "Open Network OS, where the people themselves are added and edited",
  ],
  sources: ["src/client/pages/CommunityPage.tsx"],
  bands: [
    { name: "Network OS", testid: "community-network-os", shows: "the reminder that the people live in Network OS, and the two doors: Capture someone, and Network OS itself." },
    {
      name: "What the community looks like",
      testid: "community-population",
      shows: "four headline numbers, a ring of who the firm can place with the tech-adjacent thousands said beneath it, a ring of how warm it is, and when this was last read from Network OS.",
    },
    { name: "Newest in the community", testid: "community-newest", shows: "the last 25 people added in Network OS — name, company, kind, owner and when they were added. Read-only; nothing is stored." },
  ],
  acts: [
    {
      label: "Capture someone",
      testid: "community-capture-link",
      band: "Network OS",
      does: "opens Capture, where someone you just met is written down.",
      then: "They go to Network OS's review queue; nothing is added on this page.",
    },
    {
      label: "Open Network OS ↗",
      testid: "community-network-os-link",
      primary: true,
      band: "Network OS",
      does: "opens Network OS in a new tab — where the people themselves are added and edited.",
      then: "It is a separate sign-in, so this page stays open alongside it; nothing here changes.",
    },
  ],
  auto: [
    { what: "The community is read from Network OS", when: "on its schedule", job: "network_sync" },
  ],
  elsewhere: [
    { page: "capture", why: "writing down someone new — they go to Network OS's review queue." },
    { page: "network", why: "what is synced from Network OS and where the two disagree." },
    { page: "rooms", why: "the gatherings these people are invited to." },
  ],
  walkthroughs: [
    {
      scenario: "Where the people live",
      steps: [
        { do: "Read **What the community looks like** — the four numbers, who the firm can place, and how warm it is", then: "you know what the room is made of before you convene one." },
        { do: "Scan **Newest in the community** for the last 25 names added", then: "you can see who has arrived without opening Network OS.", not: "there is no per-person link — Network OS has no per-contact page; its button is the door." },
        { do: "To look at, add or edit a person, press **Open Network OS ↗** in the **Network OS** band", then: "Network OS opens in a new tab beside this page.", not: "nothing on this page is edited — it is West Peek's read on them, never the record." },
        { do: "Met someone new? Press **Capture someone** in the **Network OS** band", then: "Capture opens and, once written down, they go to Network OS's review queue.", not: "no member is added here — there is no roster on this page." },
      ],
    },
  ],
};
