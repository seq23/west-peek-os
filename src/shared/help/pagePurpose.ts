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

export const PAGE_PURPOSES: Readonly<Record<string, PagePurpose>> = {
  home: {
    purpose: "Your starting point each morning — what needs attention, what the firm knows, and what you asked to keep an eye on.",
    youCan: ["See what is blocked or waiting on you", "Read the day's intelligence", "Ask for anything in your own words", "Choose which modules appear here"],
  },
  intent: {
    purpose: "Describe what you need in plain language. Ask works out which part of the firm owns it and shows you the plan before anything happens.",
    youCan: ["Ask a question about the firm", "Request work without knowing which page owns it", "See the plan before approving it"],
  },
  approvals: {
    purpose: "Everything waiting on a human decision. Nothing leaves the firm and no reserved action happens without an approval here.",
    // "Block it until something else is sorted" and "Change a decision" are listed because a control
    // nobody knows exists is a control nobody uses — which is how this queue came to look like it
    // only had one answer in it.
    youCan: [
      "Approve, reject or send it back for changes",
      "Block it until something else is sorted out",
      "Change a decision you have already made",
      "See the evidence behind a request, and who is allowed to decide it",
    ],
  },
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
  capture: {
    purpose: "Somewhere to put anything that arrives before it has a home — a note, a forward, a thought between meetings.",
    youCan: ["Capture something quickly", "Route it to the right machine later"],
  },
  /*
   * SHORTENED ON 18 SEP, AND THE LENGTH WAS THE PROBLEM. This block renders above everything a page
   * puts on screen, and the four-sentence version pushed the one line that answers "is anything
   * waiting on me" below where the eye lands. On day 200 she reads that answer twice a day and this
   * paragraph never again. Three addresses, one clause each.
   */
  "work": {
    purpose: "Three places: the desk is what needs you and what is in flight, the record is everything the firm has finished, the machinery is what runs on a clock.",
    youCan: ["See what has stopped, and who is carrying what", "Write a card and hand it to an employee or your partner", "Search the record of everything finished", "Check the machinery is healthy"],
  },
  notifications: {
    purpose: "What is waiting on you, then what is worth knowing, then what you have already dealt with. Dismissing something says you saw it; acknowledging says you have taken responsibility for it, and that is recorded.",
    youCan: ["See what actually needs you, first", "Dismiss everything at once", "Acknowledge a serious one, on the record", "Set the hours you would rather not hear from us"],
  },
  thesis: {
    purpose: "What the firm is looking for, and the check and ownership it is looking for it at. Editing writes a new version rather than replacing the old one.",
    youCan: ["Change the sectors, stage and filters that define a fit", "Set the check size and the ownership to hold out for", "Read every version the firm has held"],
  },
  dealflow: {
    purpose: "Where every company stands and what is stopping the next decision. Deals die of neglect rather than judgement, so each one shows how long it has sat where it is against that stage's own clock.",
    youCan: ["See the whole pipeline as one line", "Move a company to its next stage", "Find what has stalled, and what is only waiting on your decision", "Add a company at the stage it is actually at"],
  },
  companies: {
    purpose: "Every company the firm has a record of, and what is known about each one.",
    youCan: ["Find a company", "See its metrics, claims and history", "Check where a number came from"],
  },
  secondaries: {
    purpose: "The secondary sleeve — purchases of existing shares and sales out of the portfolio, kept separate from early-stage primaries.",
    youCan: ["Review what is in the sleeve", "See pricing against the last round"],
  },
  meetings: {
    purpose: "Preparation, live help and what came out of each meeting. Walter can sit in with you and hand back the deliverables afterwards.",
    youCan: ["Prepare for a meeting", "Confer with an AI employee during it", "Run a close-out and see who was given which task"],
  },
  portfolio: {
    purpose: "How portfolio companies are doing, and where they need help.",
    youCan: ["See metrics and alerts", "Record a founder's request for support", "Track whether help actually landed"],
  },
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
  "deal-math": {
    purpose: "The team's venture deal dashboards — secondary deals, primary rounds and fund construction — with the firm's own numbers ready to carry across. The math there and the math on a deal here are the same code.",
    youCan: ["Open the dashboards to model a deal or a fund", "Copy the fund's current check, ownership and reserve figures", "See why a number modelled there matches one on a real deal"],
  },
  "fund-strategy": {
    purpose:
      "Can we write this cheque, and what does it cost us later? What the portfolio is made of, " +
      "what is going wrong in it, and what the next cheque would do to the shape of the fund.",
    youCan: [
      "See where the money has actually gone",
      "Find the companies moving the wrong way",
      "Model the next cheque before committing to it",
      "See what it leaves for reserves and follow-ons",
    ],
  },
  network: {
    purpose: "The firm's relationships, held in Network OS. This page shows what is synced and where the two systems disagree.",
    youCan: ["Pull the latest from Network OS", "Resolve a conflict between records"],
  },
  lp: {
    // Reporting folded in here (item 16). An LP is somebody who gave the fund money and whom the
    // fund owes an account of it; those were two tabs for one relationship.
    purpose: "Your investors — what each committed, where the raise stands, and what the fund has told them.",
    youCan: [
      "See what is signed and what is only spoken for",
      "Record what somebody committed",
      "Start the quarter's letter and see what has gone out",
      "Check the administrator's numbers against ours",
    ],
  },
  introductions: {
    purpose: "Suggested introductions between people we know, where one person's need meets another's experience. Deliberately rare, never sent by a machine, and now part of Community.",
    youCan: ["Note what someone needs or can help with", "Approve or dismiss a suggestion", "Record that both sides said yes"],
  },
  rooms: {
    purpose: "How West Peek gathers: the stance behind it, the rhythm at full speed, the Room being planned this month, the sponsors paying for it, and every gathering the firm has on record.",
    youCan: ["Read and approve the Room proposed this month", "Call a venue and confirm it", "Work the sponsor pipeline"],
  },
  community: {
    purpose: "The people around the firm, and what the firm does about them — how they are behaving, and which of them should meet each other.",
    youCan: ["See suggested introductions", "Record that both sides said yes", "Add or update a member", "Read the firm's take on a segment"],
  },
  reporting: {
    purpose: "What goes out to LPs, and the review it passes through first.",
    youCan: ["Assemble a reporting packet", "Send it for review", "See what was distributed and when"],
  },
  "sources-and-sweeps": {
    purpose: "Where your briefing gets its material. A sweep checks every source, drops duplicates and ranks what is left against what you follow. Setup, not reading — the brief itself is on Home.",
    youCan: ["See which sources are working", "Add a source", "Choose what to watch", "Check what a brief was written from"],
  },
  research: {
    purpose: "Get up to speed on a market, a company or a question — synthesised into something you can read and take with you.",
    youCan: ["Ask for a research packet", "See the evidence behind each finding", "Export it"],
  },
  "market-map": {
    purpose: "The picture of who is already doing the thing a founder just pitched you — incumbents, challengers, who is funded and by whom, and where the gap is. Lives inside Research.",
    youCan: ["Map any sector or subsector", "See which companies are already yours", "Sort by how much each has raised", "Follow a number back to the filing it came from"],
  },
  university: {
    purpose: "An interactive venture professor. Name any topic and it teaches it — explaining, testing you, running scenarios, or listening to you teach it back.",
    youCan: ["Learn any venture topic", "Choose how it is taught", "Be marked honestly on your reasoning", "Keep what is worth remembering"],
  },
  documents: {
    purpose: "Files the firm holds, with a version history and a record of where each came from.",
    youCan: ["Upload a document", "Download any version", "See what has been extracted from it"],
  },
  record: {
    purpose: "Three read-only views: every decision the firm has made, every claim and where it came from, and what each AI employee is holding.",
    youCan: ["Look up what was decided and why", "Check whether a claim is actually evidenced", "See whose queue work is sitting in"],
  },
  contradictions: {
    purpose: "Where the firm's records disagree with each other. A contradiction stays visible until a person settles it.",
    youCan: ["See what conflicts", "Investigate the sources", "Record a resolution"],
  },
  employees: {
    purpose: "Your AI employees — who they are, what they are good at, and which are switched on.",
    youCan: ["Read what someone is for", "Activate or pause an employee", "See how they have been performing"],
  },
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
    purpose: "Send an employee to read a live page and report back — does this company still list a VP of Sales, what are their pricing tiers now. Approved by a human each time, because this is the one thing here that touches the live web. Lives inside Work.",
    youCan: ["Ask for something small and checkable", "Approve a task before it runs", "Read what it found, fenced as untrusted"],
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
