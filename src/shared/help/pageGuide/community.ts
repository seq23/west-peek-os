import type { PageGuide } from "./types";

/**
 * Community — the Network OS band with its one orange button and the door for someone new, and the
 * population read. One roster (27 Sep 2026): the member form, the members list and the mix that
 * wrote to a local table are gone, and Introductions is retired from this page while the operator
 * decides where it belongs.
 */
export const communityGuide: PageGuide = {
  navKey: "community",
  title: "Community",
  purpose:
    "The community as a population — how many people, what kinds, and how warm it is — read from Network OS, which owns who is a member.",
  youCan: ["See the shape of the community and how warm it is", "Open Network OS, where the people themselves are added and edited", "Capture someone new so West Peek OS proposes them to Network OS"],
  sources: ["src/client/pages/CommunityPage.tsx"],
  bands: [
    { name: "Network OS", testid: "community-network-os", shows: "the reminder that the people live in Network OS, the link there, and the door for someone new." },
    { name: "What the community looks like", testid: "community-population", shows: "how many people, each kind as a tile with its share, and how warm it is — read from Network OS." },
  ],
  acts: [
    {
      label: "Open Network OS ↗",
      testid: "community-network-os-link",
      primary: true,
      band: "Network OS",
      does: "opens Network OS in a new tab — where the people themselves are added and edited.",
      then: "It is a separate sign-in, so this page stays open alongside it; nothing here changes.",
    },
    {
      label: "Capture them",
      testid: "community-capture-link",
      band: "Network OS",
      does: "opens Capture, where someone you just met is written down.",
      then: "West Peek OS proposes them to Network OS; nothing is added on this page.",
    },
  ],
  auto: [
    { what: "The community is read from Network OS", when: "on its schedule", job: "network_sync" },
  ],
  elsewhere: [
    { page: "capture", why: "writing down someone new — West Peek OS proposes them to Network OS." },
    { page: "network", why: "what is synced from Network OS and where the two disagree." },
    { page: "rooms", why: "the gatherings these people are invited to." },
  ],
  walkthroughs: [
    {
      scenario: "Where the people live",
      steps: [
        { do: "Read **What the community looks like** — the count, the kinds, and how warm it is", then: "you know what the room is made of before you convene one." },
        { do: "To look at, add or edit a person, press **Open Network OS ↗** in the **Network OS** band", then: "Network OS opens in a new tab beside this page.", not: "nothing on this page is edited — it is West Peek's read on them, never the record." },
        { do: "Met someone new? Press **Capture them** in the **Network OS** band", then: "Capture opens and, once written down, West Peek OS proposes them to Network OS.", not: "no member is added here — there is no roster on this page." },
      ],
    },
  ],
};
