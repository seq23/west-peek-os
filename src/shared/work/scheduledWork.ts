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
      "Rooms. The quarter-hour tick is for Rooms you ask for: it opens Parker's card for a Room a partner " +
      "requested on Events & Rooms. Parker's OWN Room is proposed once a month — only when the FOLLOWING " +
      "month has no packet yet — inside the same tick. The employee sweep then runs the chain a stage at a time: who pays to be in front of this " +
      "audience (with evidence and the named person who runs partnerships), three concepts compared and one " +
      "chosen, venues with a reason, the run of show to the minute, the budget with its basis, a sponsorship " +
      "structure priced to cost plus the firm's keep, the pitch email, and a PDF emailed to both partners.",
    why: "So a Room is proposed with time to sell its sponsors, and a Room you asked for is built without a second prompt from you.",
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
    why: "Runs when you send a version back — that opens a card for Preston — or when you press Run it now. Only when asked: a deck is rebuilt when somebody wants one, not every morning.",
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
  productions_monthly: {
    what:
      "For West Peek Productions — Scooter's own agency, not the fund. Once a month Walker sends " +
      "Scooter ONE note: ten organisations that could buy Community-as-a-Service (trigger, who to " +
      "approach, the page it came from) and five press pitches chosen with intent, each with the " +
      "writer's address read off a live page and a draft to send. Nothing goes to a prospect or a " +
      "journalist from here.",
    why: "So the agency gets its leads and its press in one note from his chief of staff, not two emails from a machine (folded 15 Sep 2026; on the 1st of the month since 0169).",
    deliveredBy: ["Walker"],
  },
  // THE WEEKLY HIRE SEARCH (16 Sep 2026). Same office, same boundary: Scooter's agency, his desk
  // only. The OS never contacts a candidate; it finds, checks, judges and reports.
  productions_hire_search: {
    what:
      "For West Peek Productions — Scooter's own agency, not the fund. Every Monday Walker searches " +
      "live public sources for a senior experiential producer, freelance, who can bring in brand deals: " +
      "LinkedIn profiles, agency team pages, speaker lists, portfolios, award lists. Every profile URL " +
      "is checked, every candidate is judged against the written archetype, and Scooter gets ONE note — " +
      "who they are, why they fit with the page that shows it, a suggested opening line, a fit score. " +
      "Candidates are remembered week to week; he marks each Contacted or Passed on Home and it never " +
      "comes back. Nothing is sent to a candidate from here.",
    why: "So the agency's hire search runs every week without Scooter running it, and every name in the note is a real person on a live page.",
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
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function cadenceInWords(job: {
  schedule_kind: string;
  interval_minutes: number | null;
  daily_at_utc: string | null;
  day_of_week?: number | null;
  day_of_month?: number | null;
}): string {
  if (job.schedule_kind === "ON_REQUEST") return "Only when asked";
  if (job.schedule_kind === "WEEKLY" && job.daily_at_utc) {
    return `Every ${DAY_NAMES[job.day_of_week ?? 1] ?? "Monday"} at ${job.daily_at_utc} UTC`;
  }
  if (job.schedule_kind === "MONTHLY" && job.daily_at_utc) {
    return `On the ${ordinal(job.day_of_month ?? 1)} of every month at ${job.daily_at_utc} UTC`;
  }
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

/** 1st, 2nd, 3rd, 4th … 21st, 22nd, 23rd, 28th. */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const rem10 = n % 10;
  return `${n}${rem10 === 1 ? "st" : rem10 === 2 ? "nd" : rem10 === 3 ? "rd" : "th"}`;
}

/** Recurring on a clock, or only when somebody asks. The Work page is split on this. */
export function isOnRequest(job: { schedule_kind: string }): boolean {
  return job.schedule_kind === "ON_REQUEST";
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
