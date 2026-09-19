import type { PageGuide } from "./types";

/** Notifications, as deployed on 287ee44 — needs you, worth knowing, dealt with, quiet hours. */
export const notificationsGuide: PageGuide = {
  navKey: "notifications",
  title: "Notifications",
  purpose:
    "What is waiting on you, then what is worth knowing, then what you have already dealt with. Dismissing something says you saw it; taking responsibility puts your name and the time on the record.",
  youCan: ["See what actually needs you, first", "Dismiss everything at once", "Take responsibility for a serious one, on the record", "Set the hours you would rather not hear from us"],
  sources: ["src/client/pages/NotificationsPage.tsx"],
  bands: [
    { name: "The count", testid: "notifications-read-all", shows: "caught up, or how many are waiting, with Dismiss all beside it." },
    { name: "Needs you", testid: "notifications-needs-you", shows: "critical and warning items you have not dealt with — an approval raised, a job that died, a lane down, a block nag." },
    { name: "Worth knowing", testid: "notifications-worth-knowing", shows: "everything else; nothing here is blocked on you." },
    { name: "Already dealt with", testid: "notifications-handled", shows: "what you dismissed, and what you took responsibility for." },
    { name: "When you hear from us", testid: "notifications-settings", shows: "quiet hours in your own timezone, and what gets sent when. Nothing is sent to a phone yet." },
  ],
  acts: [
    { label: "Take responsibility", testid: "notification-ack-", primary: true, does: "puts your name and the time against a serious one, on the record." },
    { label: "Dismiss", testid: "notification-read-", does: "takes one off your list; nothing is recorded beyond your having seen it." },
    { label: "Dismiss all", testid: "notifications-read-all", does: "clears everything waiting in one press." },
    { label: "Save", testid: "quiet-submit", primary: true, does: "saves quiet hours; everything except critical is held until they end." },
  ],
  auto: [
    { what: "Rows arrive from approvals raised, the diagnostics sweep, block nags, dead jobs, briefs and portfolio alerts", when: "as they happen", job: "diagnostics_sweep" },
    { what: "A fault that has been fixed, or a brief replaced by a newer one, stops counting as waiting without anyone marking it", when: "on every read" },
  ],
  elsewhere: [
    { page: "approvals", why: "the card behind an approval notification." },
    { page: "work", why: "the card behind a block nag." },
  ],
};
