import type { PageGuide } from "./types";

/** Community, as deployed on 287ee44 — the population read, introductions, signals, members, the mix. */
export const communityGuide: PageGuide = {
  navKey: "community",
  title: "Community",
  purpose:
    "The people around the firm and what the firm does about them — the community as a population, who should meet whom, what each one needs or can help with, and the members. Network OS owns who is a member.",
  youCan: ["See suggested introductions and approve the ones worth making", "Record that both sides said yes", "Note what someone needs or can help with", "Add or update a member"],
  sources: ["src/client/pages/CommunityPage.tsx", "src/client/pages/IntroductionsPage.tsx"],
  bands: [
    { name: "Network OS", testid: "community-network-os", shows: "the reminder that the people live in Network OS, with the link." },
    { name: "What the community looks like", testid: "community-population", shows: "cohorts by segment and engagement, and how warm it is — read from Network OS." },
    { name: "Introductions", testid: "run-matching", shows: "suggested pairs where one person's need meets another's experience, each waiting on you." },
    { name: "What we know about people", testid: "signal-body", shows: "what someone is looking for or can help with, and how long each note has left." },
    { name: "Add or update a member", testid: "community-form", shows: "name, type, status, segment and engagement." },
    { name: "Members", testid: "community-list", shows: "everyone on the local roster." },
    { name: "Who is in the room", testid: "community-mix", shows: "founders, operators, investors, alumni and members as bars — press one to filter." },
  ],
  acts: [
    { label: "Look for matches", testid: "run-matching", does: "asks for suggested introductions from the signals on file." },
    { label: "Worth doing — ask them both", testid: "approve-match-", primary: true, does: "approves a suggestion.", then: "Nothing is sent; you ask each side yourself and record their yes." },
    { label: "said yes", does: "records one side's consent — one button per person." },
    { label: "I made the introduction", testid: "connected-", primary: true, does: "records that the introduction was made, against both people." },
    { label: "Note it", testid: "add-signal", does: "records what someone needs or can help with; it expires on its own." },
    { label: "Save member", testid: "community-save", primary: true, does: "adds a member or updates the one with that name." },
  ],
  auto: [
    { what: "The community is read from Network OS", when: "on its schedule", job: "network_sync" },
    { what: "A signal expires about four months after it was noted", when: "on its date" },
  ],
  elsewhere: [
    { page: "network", why: "what is synced from Network OS and where the two disagree." },
    { page: "rooms", why: "the gatherings these people are invited to." },
  ],
  walkthroughs: [
    {
      scenario: "Who should meet whom",
      steps: [
        { do: "Under **What we know about people**, press **Note it** for what someone needs or can help with", then: "the signal is on file and expires on its own." },
        { do: "Under **Introductions**, press **Look for matches**", then: "suggested introductions come from the signals on file." },
        { do: "Press **Worth doing — ask them both**", then: "the suggestion is approved.", not: "nothing is sent — you ask each side yourself." },
        { do: "Press **said yes** for each person as they agree, then **I made the introduction**", then: "consent is recorded per person, and the introduction against both." },
        { do: "Under **Add or update a member**, press **Save member**", then: "the member is added or updated; who is a member is owned by Network OS." },
      ],
    },
  ],
};
