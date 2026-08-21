import { AI_EMPLOYEE_ROSTER, type AIEmployeeRosterEntry } from "../registry/aiEmployees";
import { JOINT_CHIEFS, chiefOfStaffFor } from "../work/chiefOfStaff";

/**
 * Who is responsible for each surface.
 *
 * Operator direction, 21 Aug 2026: "Every single tab in the deals / firm / learn section of the NAV
 * needs a host employee who is responsible for that page — this should link to the machine tab in
 * the back end and who is responsible for the work in the various machines; the host employee's
 * picture and name and title should be prominently displayed as one of the first things you see."
 *
 * WHY A REGISTRY, AND WHY THIS ONE. `pagePurpose.ts` already proved the shape: a table keyed by nav
 * key, with a test that reads the real nav out of App.tsx so a page cannot ship without an entry.
 * The pages that would otherwise be missed are the ones nobody thinks about, and an unowned page is
 * worse than an unexplained one — it is work nobody is accountable for.
 *
 * WHAT IS NOT DUPLICATED HERE. Only the assignment. The name, title, biography and machines all come
 * from `AI_EMPLOYEE_ROSTER`, and the live employment status comes from the database at render time.
 * Copying any of that would produce a second roster that drifts, which is the failure
 * `chiefOfStaff.ts` was written to prevent for bylines.
 *
 * STATUS IS NOT ASSUMED. Home currently gives INACTIVE employees cheerful bylines — Winter reports
 * "no open alerts on anything you own" and has never been hired. A host card must therefore say
 * plainly when its host is switched off. Somebody's face over a page nobody is working is worse
 * than an unsigned page, because it answers the question "is anyone on this?" with a lie.
 *
 * THE READER'S OWN CHIEF OF STAFF hosts the personal surfaces. Home, Today and Notifications are
 * read by one partner about their own week, so the host is Walker or Wren depending on who is
 * looking — resolved through `chiefOfStaffFor`, never hardcoded.
 */

/**
 * A surface hosted by whichever Chief of Staff belongs to the reader.
 *
 * Nothing uses this today: the personal surfaces are already signed by their deliverer, so a host
 * card there would be a second signature. Kept because the resolution is the awkward part and a
 * future personal surface should not have to reinvent it.
 */
export const OWN_CHIEF_OF_STAFF = "__own_chief_of_staff__";

export interface PageHost {
  /** A roster name, or OWN_CHIEF_OF_STAFF for a surface that belongs to the reader. */
  employee: string;
  /** Why this seat owns this page, in the operator's language. One line, shown under the name. */
  because: string;
}

export const PAGE_HOSTS: Readonly<Record<string, PageHost>> = {
  // ── Deals ──
  thesis: { employee: "Pierce", because: "Owns what the fund is looking for and what it will not chase." },
  investment: { employee: "Pierce", because: "Carries deals from first look to a decision." },
  companies: { employee: "Wyatt", because: "Finds companies and keeps what the firm knows about them straight." },
  meetings: { employee: "Walter", because: "Sits in the room and makes sure the meeting produces something." },
  secondaries: { employee: "Pierce", because: "Runs the block and secondary side of the book." },
  portfolio: { employee: "Winter", because: "Watches how the companies you own are actually doing." },
  cockpit: { employee: "Preston", because: "Owns fund construction, reserves and the arithmetic under them." },
  modeling: { employee: "Preston", because: "Owns the deal arithmetic and what it means for the fund." },

  // ── Firm ──
  lp: { employee: "Wesley", because: "Holds the relationships with the people whose money this is." },
  rooms: { employee: "Parker", because: "Plans the Rooms and the evenings the firm puts its name on." },
  community: { employee: "Waverly", because: "Knows who the firm knows, and who introduced whom." },
  employees: { employee: "Pax", because: "Runs the workforce — who is employed, on what, and whether it is working." },
  reporting: { employee: "Preston", because: "Prepares what goes to the people the fund reports to." },
  record: { employee: "Wells", because: "Keeps the firm's memory: what was decided, claimed and evidenced." },

  // ── Learn ──
  research: { employee: "Wyatt", because: "Does the digging and says how much each source can be trusted." },
  university: { employee: "Whitney", because: "Teaches any venture topic and marks your reasoning honestly." },
  documents: { employee: "Wells", because: "Files what the firm produces and keeps its versions straight." },
};

/**
 * The nav groups whose pages carry a host, and the reason the others do not.
 *
 * Operator direction, 21 Aug 2026: "not all tabs need a host. none of the admin tabs need a host."
 * That is the right line and it is not merely about clutter. Deals, Firm and Learn are ROOMS —
 * places where somebody does work on the firm's behalf and where a partner reasonably asks who is
 * on it. Admin is MACHINERY: Diagnostics, Activity, Integrations and the rest report on the system
 * itself, and putting a colleague's face over a spend table implies a judgement nobody is making.
 *
 * The personal surfaces — Home, Today, Notifications — are excluded for a different reason: they
 * are already signed. Home carries a byline per delivered module and the weekly review is signed by
 * both Chiefs of Staff, so a host card there would be a second signature on a page that has one.
 */
export const HOSTED_NAV_GROUPS: readonly string[] = ["Deals", "Firm", "Learn"];

export interface ResolvedPageHost {
  name: string;
  role: string;
  bio: string;
  /** Machines this seat is responsible for — the link to the back end the operator asked for. */
  machineKeys: readonly string[];
  /** Why they own this page. */
  because: string;
  /** Reference status from the roster. The LIVE status must come from the database. */
  rosterStatus: AIEmployeeRosterEntry["status"];
}

function rosterEntry(name: string): AIEmployeeRosterEntry | null {
  return AI_EMPLOYEE_ROSTER.find((e) => e.name === name) ?? null;
}

/**
 * The host of a surface, resolved against the roster.
 *
 * `readerFullName` is only consulted for the personal surfaces. Passing nothing on those returns
 * null rather than guessing a partner, because signing a page with the wrong Chief of Staff is a
 * worse answer than signing it with none.
 */
export function pageHost(navKey: string, readerFullName?: string): ResolvedPageHost | null {
  const assigned = PAGE_HOSTS[navKey];
  if (!assigned) return null;

  const name =
    assigned.employee === OWN_CHIEF_OF_STAFF
      ? readerFullName
        ? chiefOfStaffFor(readerFullName)
        : null
      : assigned.employee;
  if (!name) return null;

  const entry = rosterEntry(name);
  if (!entry) return null;

  return {
    name: entry.name,
    role: entry.role,
    bio: entry.bio,
    machineKeys: entry.primaryMachineKeys,
    because: assigned.because,
    rosterStatus: entry.status,
  };
}

/**
 * Roster seats that host nothing.
 *
 * Not a defect on its own — not every employee needs a page. It is reported because the operator
 * asked for a cull of duplicated and unused seats, and "hosts no surface" is one honest input to
 * that decision rather than the whole answer.
 */
export function employeesHostingNothing(): string[] {
  const hosting = new Set<string>();
  for (const h of Object.values(PAGE_HOSTS)) {
    if (h.employee === OWN_CHIEF_OF_STAFF) {
      // The sentinel resolves to a real person per reader. Counting it as a literal name reported
      // Walker as hosting nothing while he hosts every personal surface Scooter opens.
      for (const chief of JOINT_CHIEFS) hosting.add(chief);
    } else {
      hosting.add(h.employee);
    }
  }
  return AI_EMPLOYEE_ROSTER.filter((e) => !hosting.has(e.name) && e.status !== "RETIRED")
    .map((e) => e.name)
    .sort();
}
