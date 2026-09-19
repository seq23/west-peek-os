import type { PageGuide } from "./types";

/** University, as deployed on 287ee44 — Whitney, one topic at a time. */
export const universityGuide: PageGuide = {
  navKey: "university",
  title: "University",
  purpose:
    "An interactive venture professor. Name any topic and choose how Whitney teaches it — explaining, testing you, running a scenario, or listening to you teach it back. Sessions are saved to you, and anything worth remembering goes to your diary.",
  youCan: ["Learn any venture topic", "Choose how it is taught", "Keep what is worth remembering", "Pick up a past session"],
  sources: ["src/client/pages/UniversityPage.tsx"],
  bands: [
    { name: "What do you want to learn?", testid: "university-start-form", shows: "the topic, and the way Whitney should teach it." },
    { name: "The session", testid: "university-session", shows: "the conversation, turn by turn, with a box to reply." },
    { name: "Past sessions", testid: "university-history", shows: "every session you have had, to pick up again." },
  ],
  acts: [
    { label: "Start session", testid: "university-start", primary: true, does: "opens a session on the topic in the mode you chose." },
    { label: "Send", testid: "university-send", primary: true, does: "replies to Whitney." },
    { label: "Keep this", testid: "university-keep-", does: "saves one of Whitney's turns to your diary." },
    { label: "New topic", testid: "university-back", does: "goes back to the start form; the session is kept." },
  ],
  auto: [{ what: "Nothing runs on a clock; every reply is a governed AI run under the firm's spend and privacy settings", when: "as you talk" }],
  elsewhere: [{ page: "research", why: "when the question is about a real market or company rather than a lesson." }],
};
