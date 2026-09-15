import { JOINT_CHIEFS } from "./chiefOfStaff";

/**
 * Scheduled work, described the way somebody who did not build it would describe it.
 *
 * WHAT WAS WRONG. The page rendered the row. Every job printed `target SYSTEM · data class
 * INTERNAL · up to 3 attempt(s) · next 2026-08-19T13:00:00.000Z` — six true facts, none of them the
 * ones you want. The operator's question about the weekly review was literally "what is this?", and
 * the page had no answer, because nothing on it said what any job DOES or who hands it to you.
 *
 * Two things a scheduled job has that a work card does not, and both were missing:
 *
 * WHO DELIVERS IT. Everything else the firm produces arrives from somebody — the morning brief is
 * signed, the weekly agenda is prepared jointly. A recurring job that produces the same artifact
 * anonymously is the same anonymity the delivery model exists to fix, one page over.
 *
 * WHETHER IT IS INTELLIGENCE. `kind` already carried this and rendered as the raw enum. It matters
 * because the two kinds fail differently: INTELLIGENCE work reads and synthesises, so a bad run
 * produces a thin brief; EMPLOYEE_TASK work is one named employee doing a job, so it does not run
 * at all if that employee is switched off. The second failure is silent and the page never showed
 * it — Parker's Monthly Room proposal has been ACTIVE with Parker INACTIVE.
 *
 * Facts live here rather than in the database because they are editorial: how to describe a job to
 * a partner is a product decision, and it should read in a diff. `job_key` is the join, and a job
 * with no entry still renders — it just falls back to the row, which is what the page used to be.
 */

export interface JobFacts {
  /** What it is, in a partner's words rather than the job's name. */
  what: string;
  /** Why it exists — the question it saves someone from having to ask. */
  why: string;
  /**
   * Roster names of whoever hands it over. Empty means nobody is named, which is a real state and
   * shown as such rather than papered over with "the system".
   */
  deliveredBy: readonly string[];
}

export const JOB_FACTS: Readonly<Record<string, JobFacts>> = {
  daily_intelligence: {
    what: "The morning brief — what moved overnight in the markets, sectors and companies the firm follows, read and synthesised rather than listed.",
    why: "So the first thing either partner reads is already filtered, and nobody starts the day scrolling.",
    // Intelligence assembles it; a Chief of Staff hands it over, and which one depends on who is
    // reading. Both are named here because the job is one job serving two partners.
    deliveredBy: JOINT_CHIEFS,
  },
  weekly_mp_review: {
    what:
      "The Wednesday operating review — the week's agenda, built from what actually happened rather " +
      "than from memory. It rebuilds every day and that is deliberate: the meeting is weekly, the " +
      "agenda is not, so whatever happened this morning is on it by the time you sit down.",
    why: "So the partners' weekly meeting starts from a prepared page instead of from whoever remembers the most.",
    deliveredBy: JOINT_CHIEFS,
  },
  monthly_room_proposal: {
    what:
      "Rooms. Every half hour it does one thing: builds a Room a partner asked for on Events & Rooms " +
      "whose build did not finish, or — when the FOLLOWING month has no packet yet — proposes Parker's " +
      "own Room for it: theme, who is in the room, run of show, venues, sponsor prospects at $10,000 " +
      "each, risks, and what keeping it commits the firm to. The packet is emailed to both partners.",
    why: "So a Room is proposed with time to sell its sponsors, and a Room you asked for is built even if the button's build failed.",
    deliveredBy: ["Parker"],
  },
  // EVERY JOB SAYS WHAT IT IS. Until 14 Sep 2026 five of these read "No description has been
  // written for this job" and "Nobody is named as delivering this" on the Work page — machinery
  // the operator was asked to switch on or off without being told what it did.
  employee_work_sweep: {
    what: "Works the cards your employees own. Every five minutes it picks up the oldest card waiting on an employee and runs it — the same thing as pressing the button on the card. A card ends Done with its findings, or Blocked with the question it needs you to answer.",
    why: "So assigning work to an employee means it gets done, and \"in progress\" means somebody is actually on it.",
    deliveredBy: ["the firm"],
  },
  deck_rebuild: {
    what: "Rebuilds the LP deck: reads the current deck page by page, carries everything over, corrects every figure to the fund records, and proposes the new version on Fund strategy.",
    why: "Runs when you send a version back — that opens a card for Preston — or when you press Run it now. Not on a timer: a deck is rebuilt when somebody asks, not every morning.",
    deliveredBy: ["Preston"],
  },
  deck_reading: {
    what: "Reads decks that arrived by email — sector, one-liner, claims and what the deck leaves out — and writes them onto the company's record.",
    why: "So the employee who checks a company already has what its deck says, and nobody re-reads a deck by hand.",
    deliveredBy: ["Wells"],
  },
  network_sync: {
    what: "Loads the community from Network OS — new people, changed details, introductions — into this system's records.",
    why: "So the community you see here is the community, not a copy that drifted last month.",
    deliveredBy: ["the firm"],
  },
  diagnostics_sweep: {
    what: "Checks the machinery: every integration, credential and lane the firm depends on, and raises a notice when one goes down or comes back.",
    why: "So a broken connection is reported by the system, not discovered by a partner mid-task.",
    deliveredBy: ["the firm"],
  },
  // WALKER'S DUTIES FOR SCOOTER'S OWN AGENCY. West Peek Productions is not part of the fund; these
  // two are personal-office work for Scooter and the result reaches him alone, by email. The
  // facts say so, because a partner reading this page must be able to tell fund work from a
  // colleague's private business at a glance.
  productions_customer_ideas: {
    what:
      "For West Peek Productions — Scooter's own agency, not the fund. Once a month Walker searches " +
      "for 10 organisations that plausibly need Community-as-a-Service right now (a launch, a hire, a " +
      "raise, a programme), the role to approach, a one-line angle and the page it came from; every " +
      "page is checked live before it is kept. Emailed to scooter@westpeek.ventures only. Nobody is contacted.",
    why: "So Scooter opens the month with ten qualified leads and a reason for each, instead of a blank page.",
    deliveredBy: ["Walker"],
  },
  productions_press_pitches: {
    what:
      "For West Peek Productions — Scooter's own agency, not the fund. Once a month Walker drafts " +
      "pitches to 5 journalists or newsletter writers on community, brand, the creator economy or " +
      "go-to-market: why that writer, the hook, their name and outlet, a public email address only " +
      "when a live page shows one, and a piece proving the beat. Drafts, emailed to Scooter to send " +
      "himself; nothing goes to a journalist from here.",
    why: "So the agency is pitched to the press every month without Scooter starting from a blank page or the OS sending anything outside the firm.",
    deliveredBy: ["Walker"],
  },
  wednesday_prep: {
    what: "Prepares each partner's packet for the Wednesday sync — what completed, what is waiting, and where the records and the deck disagree.",
    why: "So the sync starts from a page, not from memory.",
    deliveredBy: JOINT_CHIEFS,
  },
};

/**
 * Cadence in words. `every 1440 min` is a true and useless way to say "once a day".
 *
 * THE ENUM IS `DAILY_AT`, NOT `DAILY`. This checked for "DAILY", never matched, fell through to the
 * interval branch — which is null for every job the firm has — and printed "No cadence set" on all
 * three, directly above a line stating the next run time. Two contradictory facts, one of them
 * false, from guessing a value instead of reading the schema. `validate:sql` catches this class in
 * SQL; in TypeScript a string comparison against the wrong literal just quietly never matches, so
 * the test below asserts against the values production actually stores.
 */
export function cadenceInWords(job: {
  schedule_kind: string;
  interval_minutes: number | null;
  daily_at_utc: string | null;
}): string {
  if ((job.schedule_kind === "DAILY_AT" || job.schedule_kind === "DAILY") && job.daily_at_utc) {
    return `Every day at ${job.daily_at_utc} UTC`;
  }
  const m = job.interval_minutes;
  if (m == null) return "No cadence set";
  if (m % 10080 === 0) return m === 10080 ? "Once a week" : `Every ${m / 10080} weeks`;
  if (m % 1440 === 0) return m === 1440 ? "Once a day" : `Every ${m / 1440} days`;
  if (m % 60 === 0) return m === 60 ? "Every hour" : `Every ${m / 60} hours`;
  return `Every ${m} minutes`;
}

/**
 * Who hands this over. Falls back to the job's target employee, which is what an EMPLOYEE_TASK job
 * carries in the row itself — so a job added later still names somebody without an entry here.
 */
export function delivererNames(
  job: { job_key: string; target_kind: string; target_id: string | null },
): readonly string[] {
  const facts = JOB_FACTS[job.job_key];
  if (facts && facts.deliveredBy.length > 0) return facts.deliveredBy;
  if (job.target_kind === "EMPLOYEE" && job.target_id) return [job.target_id];
  return [];
}

/** Reads as a byline. Two names are joined with "and", because that is how two people sign a thing. */
export function delivererLine(names: readonly string[]): string {
  if (names.length === 0) return "Nobody is named as delivering this";
  if (names.length === 1) return `Delivered by ${names[0]}`;
  return `Delivered by ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export const JOB_KINDS: Readonly<Record<string, { label: string; means: string }>> = {
  INTELLIGENCE: {
    label: "Intelligence",
    means: "Reads sources and synthesises. Produces a written thing somebody hands you.",
  },
  EMPLOYEE_TASK: {
    label: "An employee's task",
    means: "One named employee doing a job on a cadence. It cannot run if that employee is switched off.",
  },
  SWEEP: {
    label: "Sweep",
    means: "Collects and files. Produces items rather than a document.",
  },
  MAINTENANCE: {
    label: "Maintenance",
    means: "Housekeeping the firm never has to think about unless it fails.",
  },
};
