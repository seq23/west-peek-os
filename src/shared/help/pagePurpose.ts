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
    youCan: ["Approve, reject or ask for changes", "See the evidence behind a request", "Check who is allowed to decide"],
  },
  today: {
    purpose: "What is on today — meetings, due work, and anything with a deadline attached.",
    youCan: ["See today's commitments", "Open the work behind each one"],
  },
  "weekly-review": {
    purpose: "One agenda across sixteen areas of the firm, assembled from live records rather than written by hand.",
    youCan: ["Generate this week's agenda", "Work down it with both partners", "Record how each item was resolved"],
  },
  capture: {
    purpose: "Somewhere to put anything that arrives before it has a home — a note, a forward, a thought between meetings.",
    youCan: ["Capture something quickly", "Route it to the right machine later"],
  },
  "work-cards": {
    purpose: "Units of governed work. Every task the firm is actually doing lives here with an owner and a next action.",
    youCan: ["See what is open, blocked or in progress", "Change an owner or a next action", "Follow a card back to what created it"],
  },
  jobs: {
    purpose: "Work that runs on a schedule rather than because someone asked. Everything starts paused.",
    youCan: ["Switch a job on or off", "See when it last ran and what happened", "Investigate a failure"],
  },
  notifications: {
    purpose: "What the system has told you, and how it reached you.",
    youCan: ["Read and acknowledge notifications", "Set quiet hours and what you want to hear about"],
  },
  thesis: {
    purpose: "What the firm is looking for, and the check and ownership it is looking for it at. Editing writes a new version rather than replacing the old one.",
    youCan: ["Change the sectors, stage and filters that define a fit", "Set the check size and the ownership to hold out for", "Read every version the firm has held"],
  },
  investment: {
    purpose: "The early-stage pipeline — opportunities from first look through to an IC decision.",
    youCan: ["Move an opportunity through its stages", "Open the diligence behind it", "Take it to the Investment Committee"],
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
  "follow-on": {
    purpose: "Where more money might go — reviews already open, and companies where a tracked metric has improved.",
    youCan: ["See which reviews are pending", "Look at what is moving before deciding to open one"],
  },
  allocation: {
    purpose: "How capital is split across the fund's sleeves, and what moving it would mean.",
    youCan: ["Compare allocation options", "See what a change requires before approving it"],
  },
  cockpit: {
    purpose: "Fund strategy — construction scenarios and the assumptions behind them, stated so they can be argued with.",
    youCan: ["Work through a scenario", "See which assumptions a finding rests on"],
  },
  network: {
    purpose: "The firm's relationships, held in Network OS. This page shows what is synced and where the two systems disagree.",
    youCan: ["Pull the latest from Network OS", "Resolve a conflict between records"],
  },
  lp: {
    purpose: "Limited partners — who they are, where each conversation stands, and what the fund owes them.",
    youCan: ["Track an LP conversation", "Prepare reporting", "See what is committed and what is not"],
  },
  introductions: {
    purpose: "Suggested introductions between people we know, where one person's need meets another's experience. Deliberately rare, and never sent by a machine.",
    youCan: ["Note what someone needs or can help with", "Approve or dismiss a suggestion", "Record that both sides said yes"],
  },
  rooms: {
    purpose: "Rooms are West Peek's curated gatherings for 25-35 people, built around one real question, and the part of the community that earns money through sponsors.",
    youCan: ["Read and approve the Room proposed this month", "Call a venue and confirm it", "Work the sponsor pipeline"],
  },
  events: {
    purpose: "Events as firm records: who came, when, and what came out of it. West Peek Live runs the room itself.",
    youCan: ["Record an event", "Track attendance", "Link the room in West Peek Live"],
  },
  community: {
    purpose: "The firm's read on the community as a population — segments, engagement, and what that suggests. Network OS owns who is a member.",
    youCan: ["Place someone in a segment", "Record how engaged they are"],
  },
  reporting: {
    purpose: "What goes out to LPs, and the review it passes through first.",
    youCan: ["Assemble a reporting packet", "Send it for review", "See what was distributed and when"],
  },
  intelligence: {
    purpose: "Where the firm's intelligence comes from. A sweep checks your sources, drops duplicates and ranks what is left.",
    youCan: ["Run a sweep", "Add something you found yourself", "Choose what to watch", "Read the day's brief in full"],
  },
  research: {
    purpose: "Get up to speed on a market, a company or a question — synthesised into something you can read and take with you.",
    youCan: ["Ask for a research packet", "See the evidence behind each finding", "Export it"],
  },
  "market-map": {
    purpose: "A map of who exists in a sector and how big they are, grouped into subsegments, with every figure traceable to its source.",
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
  "ai-ops": {
    purpose: "The admin console. Providers, models, how work is routed, and what the firm is spending on AI.",
    youCan: ["Raise or lower AI spend", "Turn a provider on or off", "See what has cost what", "Change how tasks are routed"],
  },
  ai: {
    purpose: "Every AI run the firm has made, and the governance around it.",
    youCan: ["Inspect a run and its cost", "See why a run was refused", "Accept or reject quarantined output"],
  },
  machines: {
    purpose: "The firm's departments, and what each is responsible for.",
    youCan: ["See what a machine owns", "Check whether it is running"],
  },
  governance: {
    purpose: "The rules the firm operates under, and who acknowledged them.",
    youCan: ["Issue a rule or a bulletin", "See who has read it"],
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
    purpose: "Whether the system itself is healthy, and what is degraded if not.",
    youCan: ["Check system health", "See what is failing and why"],
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
