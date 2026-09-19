/**
 * What every page is for, in plain English (P40).
 *
 * Operator direction, 17 Aug 2026: "each linked page in the NAV needs a block at the top that is
 * like the help section that explains in plain english what the page is for and what a user can do
 * on the page overall with a link to the main help section page."
 *
 * WHY A REGISTRY AND NOT A PROP ON EACH PAGE. Thirty-eight nav destinations written by different
 * hands over months. If each page carried its own copy, the ones nobody thinks about — Diagnostics,
 * Activity, Contradictions — are exactly the ones that would end up without one, and those are the
 * pages a new operator most needs explained. Keeping them together means a single test can assert
 * every nav key has an entry, and adding a page without one fails the build.
 *
 * HOW THIS DIFFERS FROM HowThisWorks. That component sits at the BOTTOM and answers seven detailed
 * questions for someone already working. This sits at the TOP and answers one: should I be here?
 * A reader who knows the page skims past it; a reader who does not gets oriented in a sentence.
 *
 * WRITING RULE: `purpose` says what the page IS, `youCan` says what you DO. No system vocabulary —
 * a person manages notifications, not "delivery preferences"; they set spend, not "budget policy
 * versions". If a line needs a term from the schema to make sense, it is written wrong.
 */

import { PAGE_GUIDES } from "./pageGuide";

export interface PagePurpose {
  /** One or two sentences: what this page is. */
  purpose: string;
  /** Two to four things you can actually do here, in the operator's words. */
  youCan: string[];
  /**
   * The page is archived: off the nav, still answering its URL, nothing new made on it. The string
   * is the dated reason, said on the page itself so a bookmark that lands here is not confusing.
   */
  archived?: string;
}

/**
 * A page that has a guide takes its purpose FROM the guide, and only from there.
 *
 * 19 Sep 2026: this file said Meetings was "Prepare for a meeting · Confer with an AI employee
 * during it · Run a close-out" a week after the page stopped being that, and the host read it out
 * to the owner. The guide in `pageGuide/` is held to the page by `validate:page-guides`; a purpose
 * written here beside it would be a second copy, and second copies are how this went wrong.
 */
function fromGuide(navKey: string): PagePurpose {
  const g = PAGE_GUIDES[navKey];
  if (!g) throw new Error(`pagePurpose: no guide for ${navKey}`);
  return g.archived ? { purpose: g.purpose, youCan: g.youCan, archived: g.archived } : { purpose: g.purpose, youCan: g.youCan };
}

export const PAGE_PURPOSES: Readonly<Record<string, PagePurpose>> = {
  home: fromGuide("home"),
  intent: fromGuide("intent"),
  approvals: fromGuide("approvals"),
  today: {
    purpose: "What is on today — meetings, due work, and anything with a deadline attached.",
    youCan: ["See today's commitments", "Open the work behind each one"],
  },
  "weekly-review": {
    purpose: "One agenda across sixteen areas of the firm, assembled from live records rather than written by hand.",
    youCan: ["Read the reviews already written", "Work down one with both partners", "Record how each item was resolved"],
    // Owner, 18 Sep 2026: "we don't need it anymore." Off the nav; the route stays live so a
    // bookmark lands; the job that generated it is retired; every review written is kept.
    archived: "Archived 18 Sep 2026 — the per-person Wednesday prep packet replaced it. Nothing new is generated here; what was written is kept.",
  },
  capture: fromGuide("capture"),
  work: fromGuide("work"),
  notifications: fromGuide("notifications"),
  thesis: fromGuide("thesis"),
  dealflow: fromGuide("dealflow"),
  companies: fromGuide("companies"),
  secondaries: fromGuide("secondaries"),
  meetings: fromGuide("meetings"),
  portfolio: fromGuide("portfolio"),
  // Merged into Fund strategy — "should we write this cheque" and "should we write another into a
  // company we already own" were answered on separate pages while sharing the same reserves. The
  // entry stays so an old link still gets an explanation rather than a blank block.
  "follow-on": {
    purpose: "Now part of Fund strategy, where the reserves a follow-on draws from are actually visible.",
    youCan: ["See which companies have earned another cheque", "Check what a follow-on leaves for everyone else"],
  },
  // Merged into Fund strategy — the entry stays so an old link still gets an explanation rather
  // than a blank block, and it says where the page went.
  allocation: {
    purpose: "Now part of Fund strategy, which answers the whole question in one place rather than half of it on each of two tabs.",
    youCan: ["See how capital is split across the sleeves", "Compare allocation options", "See what a change requires before approving it"],
  },
  // Merged into Fund strategy (22 Aug 2026) — the dashboards door is that page's first band. The
  // route resolves to fund-strategy before anything renders; the entry stays so the key is explained.
  "deal-math": {
    purpose: "Now the first band of Fund strategy — the venture deals dashboards, with this fund's six figures ready to carry across.",
    youCan: ["Open the dashboards to model a deal or a fund", "Copy the fund's six figures"],
  },
  "fund-strategy": fromGuide("fund-strategy"),
  network: {
    purpose: "The firm's relationships, held in Network OS. This page shows what is synced and where the two systems disagree.",
    youCan: ["Pull the latest from Network OS", "Resolve a conflict between records"],
  },
  lp: fromGuide("lp"),
  introductions: {
    purpose: "Suggested introductions between people we know, where one person's need meets another's experience. Deliberately rare, never sent by a machine, and now part of Community.",
    youCan: ["Note what someone needs or can help with", "Approve or dismiss a suggestion", "Record that both sides said yes"],
  },
  rooms: fromGuide("rooms"),
  community: fromGuide("community"),
  // Reporting is part of LP now — "What we have told them". The key stays so an old link resolves.
  reporting: {
    purpose: "Now part of LP, under what we have told them — the quarter's letter, who has read it, and whether it went out.",
    youCan: ["Start this period's letter", "Put it in front of its reviewers", "Send it to the investors once it is signed off"],
  },
  "sources-and-sweeps": {
    purpose: "Where your briefing gets its material. A sweep checks every source, drops duplicates and ranks what is left against what you follow. Setup, not reading — the brief itself is on Home.",
    youCan: ["See which sources are working", "Add a source", "Choose what to watch", "Check what a brief was written from"],
  },
  research: fromGuide("research"),
  "market-map": {
    purpose: "The picture of who is already doing the thing a founder just pitched you — incumbents, challengers, who is funded and by whom, and where the gap is. Lives inside Research.",
    youCan: ["Map any sector or subsector", "See which companies are already yours", "Read the table, ranked by how much each has raised", "Follow a number back to the filing it came from"],
  },
  university: fromGuide("university"),
  documents: fromGuide("documents"),
  record: fromGuide("record"),
  contradictions: {
    purpose: "Where the firm's records disagree with each other. A contradiction stays visible until a person settles it.",
    youCan: ["See what conflicts", "Investigate the sources", "Record a resolution"],
  },
  employees: fromGuide("employees"),
  "cockpit": {
    // Operator, 21 Aug 2026: "cockpit is about controlling the app and how much the app spends".
    // Both halves are now true — the ceilings here refuse work rather than describing it.
    purpose: "Controlling the system and what it spends. Providers, models, how work is routed, and the limits on the bill.",
    youCan: [
      "Say the most it may spend in a month, or ever",
      "Raise or lower how much it spends per piece of work",
      "Turn a provider on or off",
      "Use or throw away work a model finished",
    ],
  },
  "ai-controls": {
    purpose: "Every AI run the firm has made, and the governance around it.",
    // Accepting quarantined output moved to Cockpit with the rest of the spend controls. A page
    // that lists something you cannot do there sends a partner hunting for a button that is not
    // on the page — the same class of promise-without-a-control this whole review is closing.
    youCan: ["Inspect a run and its cost", "See why a run was refused", "Follow a run back to the work that asked for it"],
  },
  "browser-tasks": {
    purpose: "Send an employee to read a live page and report back — does this company still list a VP of Sales, what are their pricing tiers now. Approved by a human each time, because this is the one thing here that touches the live web. Reached from a card on Work.",
    youCan: ["Ask for something small and checkable", "Read what it found, fenced as untrusted", "See which tasks are waiting on approval"],
  },
  machines: {
    purpose: "The firm's departments, and what each is responsible for.",
    youCan: ["See what a machine owns", "Check whether it is running"],
  },
  governance: {
    purpose: "The rules this firm operates under, and the reasoning behind decisions somebody will otherwise re-argue in six months. Everything issued here is permanent and attributed — a correction is a new update, never an edit.",
    youCan: ["Set a rule that binds what people and employees may do", "Tell the firm something without changing anyone's permissions", "Record why a decision was taken, for whoever reads it next", "See what is worth writing down and has not been"],
  },
  "cross-office": {
    purpose: "Where the two partners' offices are colliding — the same work twice, the same employee twice, or two drafts to one recipient.",
    youCan: ["Check for collisions", "Mark one resolved, or accepted if both of you meant it"],
  },
  activity: {
    purpose: "Everything that has happened, in order. Append-only, so nothing here can be edited after the fact.",
    youCan: ["Trace what happened and when", "Find who did something"],
  },
  integrations: {
    purpose: "Connections to systems outside West Peek OS, and whether each is actually working.",
    youCan: ["See what is connected", "Check why something is not"],
  },
  diagnostics: {
    purpose: "Whether anything is broken right now, read from the system itself rather than from its settings.",
    youCan: ["See at a glance whether anything is wrong", "Read the measurement behind every light", "Go straight to the page that fixes it", "Watch how often you are being asked to approve things"],
  },
  setup: {
    purpose: "Getting the firm configured — the team, the providers, and the work that should run without being asked.",
    youCan: ["Work through what is not set up yet", "See what each step unlocks"],
  },
  help: {
    purpose: "How every part of the system works, in plain language, with what is built and what is not.",
    youCan: ["Look up any surface", "See what still needs setting up"],
  },
};

export function pagePurpose(navKey: string): PagePurpose | undefined {
  return PAGE_PURPOSES[navKey];
}
