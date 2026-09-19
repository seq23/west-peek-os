import type { PageGuide } from "./types";

/**
 * Home, as deployed on 287ee44.
 *
 * FOR THE AGENT LANDING `design/home-overhaul`: the purpose and the headline acts are already
 * written to the approved design (`design/HOME_DESIGN.md` on `design/home`): what is waiting on
 * you, what arrived since you last looked, and today's brief on demand. The bands and act testids
 * below are the page AS IT RENDERS TODAY, because `validate:page-guides` holds this file to the
 * page — when the redesign lands, its inline Approve · Reject, the filter rail, Mark all read and
 * the foot line replace the entries here, and the validator fails until they do. That is the
 * contract working, not an obstacle: a page cannot change its controls without saying so here.
 */
export const homeGuide: PageGuide = {
  navKey: "home",
  title: "Home",
  purpose: "What is waiting on you, what arrived since you last looked, and today's brief — on demand.",
  youCan: ["See what is waiting on you, and decide it", "Read what arrived since you last looked", "Build today's brief when you want it", "Choose what Home shows"],
  sources: [
    "src/client/pages/HomePage.tsx",
    "src/client/pages/DailyBriefPanel.tsx",
    "src/client/pages/PreviewApprovals.tsx",
    "src/client/pages/DeliverableList.tsx",
  ],
  bands: [
    { name: "The answer", testid: "home-masthead", shows: "whether anything is waiting on you, in one line." },
    { name: "Waiting on you", testid: "home-waiting", shows: "approval cards, previews waiting to be sent, and anything blocked — each with its act." },
    { name: "Today's brief", testid: "daily-brief", shows: "the brief once built, or the button to build it, with what it examined and how long it usually takes." },
    { name: "Arrived", testid: "home-deliverables", shows: "what your employees delivered since you last looked — packets, prep, briefs — to read, put away, or answer." },
    { name: "Quiet", testid: "home-quiet-roll", shows: "the colleagues with nothing new, in one line." },
    { name: "The rest", testid: "home-rest", shows: "what this page answers, and which modules appear here." },
  ],
  acts: [
    { label: "Decide", testid: "home-waiting-open-", primary: true, does: "opens the waiting card on Approvals." },
    { label: "Build today's brief", testid: "daily-brief-generate", primary: true, does: "asks for today's brief now; the label says where the build is — requested, building, arrived, or failed and why." },
    { label: "Send it", testid: "preview-send-", primary: true, does: "sends a previewed email as it is; Send it back returns it with a note; Dismiss drops it." },
    { label: "Mark as read", testid: "deliverable-ack-", does: "marks a delivered item read; Put it away shelves it; Download and Email it to me take it with you." },
    { label: "Send it to", testid: "deliverable-feedback-send-", primary: true, does: "passes your verdict on a delivered item back to whoever wrote it." },
    { label: "Ask for anything", testid: "home-ask-open", does: "opens Ask." },
    { label: "Bring them back", testid: "home-attention-unsilence", does: "unsilences the alerts you told to stop." },
    { label: "Record", testid: "personal-submit", does: "records a private note of something you are watching for yourself." },
  ],
  auto: [
    { what: "The brief is built only when you ask; it reads the last 48 hours of sources, ranks them, writes, and checks every claim", when: "on request", job: "daily_intelligence" },
    { what: "A delivered item unread for a week is put away by itself", when: "after seven days" },
  ],
  elsewhere: [
    { page: "approvals", why: "the card behind a waiting row, with its evidence and history." },
    { page: "intent", why: "asking for anything in your own words." },
    { page: "notifications", why: "everything that arrived, including what is only worth knowing." },
  ],
  notActs: {},
};
