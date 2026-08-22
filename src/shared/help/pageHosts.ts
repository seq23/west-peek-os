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
  /**
   * The machines THIS PAGE is about, when the seat owns more than this page needs.
   *
   * WHY THIS EXISTS. The page chat prompts the host with `guidanceBlock(machineKeys)` — the firm's
   * own written methods. It was handed the seat's ENTIRE machine set, so asking Wyatt a question on
   * Research arrived with seventeen skills attached: cap-table waterfall methods and opportunity-
   * radar methods alongside the research ones. That is not merely wasteful, it is worse advice — an
   * employee told to follow five unrelated disciplines at once follows none of them well.
   *
   * Omit when the seat's whole remit IS the page. Every key named here must be one the host actually
   * sits on, and `tests/pageHosts.test.ts` fails the build otherwise — the mismatch it caught was
   * silent and had shipped.
   */
  machineKeys?: readonly string[];
}

export const PAGE_HOSTS: Readonly<Record<string, PageHost>> = {
  // ── Deals ──
  /*
   * The mandate machine belongs to Wyatt, who screens against it, while Pierce owns what the fund is
   * looking for. Naming the machine here rather than moving the seat keeps both true: Pierce hosts,
   * and the page chat is prompted with the mandate methods it is actually about. The test below
   * enforces that a named machine is one its host really sits on — so this is declared on Pierce's
   * roster entry too, rather than asserted here and quietly false.
   */
  thesis: {
    employee: "Pierce",
    because: "Owns what the fund is looking for and what it will not chase.",
    machineKeys: ["investment_mandate_exclusion"],
  },
  // Not "from first look" — that is the analyst's. This seat takes it once the firm has
  // decided a company is worth real time. See aiEmployees.ts for why screening moved.
  dealflow: { employee: "Pierce", because: "Takes a deal once it is worth real time, and runs it to a decision." },
  companies: {
    employee: "Wyatt",
    because: "Finds companies and keeps what the firm knows about them straight.",
    machineKeys: ["research_intelligence", "investment_mandate_exclusion"],
  },
  meetings: { employee: "Walter", because: "Sits in the room and makes sure the meeting produces something." },
  secondaries: { employee: "Pierce", because: "Runs the block and secondary side of the book." },
  portfolio: { employee: "Winter", because: "Watches how the companies you own are actually doing." },
  "fund-strategy": { employee: "Preston", because: "Owns fund construction, reserves and the arithmetic under them." },
  /*
   * DEAL MATH IS WYATT'S, and this was a real mismatch rather than a preference. The page hosted to
   * Preston while `venturedeals_deal_math` — the machine, and the hand-verified arithmetic — sits on
   * Wyatt. So the one page in the firm devoted to deal arithmetic was chatting to somebody who had
   * never been given a single method about it. The rule the skill library already states is
   * deal-level to Wyatt, fund-level to Preston; the page is deal-level.
   */
  "deal-math": {
    employee: "Wyatt",
    because: "Owns the deal arithmetic — what a round does to ownership, and what it takes to return the fund.",
    machineKeys: ["venturedeals_deal_math"],
  },

  // ── Firm ──
  lp: { employee: "Wesley", because: "Holds the relationships with the people whose money this is." },
  rooms: { employee: "Parker", because: "Plans the Rooms and the evenings the firm puts its name on." },
  community: { employee: "Waverly", because: "Knows who the firm knows, and who introduced whom." },
  employees: {
    employee: "Pax",
    because: "Runs the workforce — who is employed, on what, and whether it is working.",
    // Not his continuity or approval-queue methods. This page is about the workforce, and he now
    // holds four machines; a question about an employee answered with backup-drill guidance
    // attached is a worse answer rather than a fuller one.
    machineKeys: ["ai_employee_performance_lifecycle", "governance_center_broadcast"],
  },
  // Reporting is now part of LP. The key stays so an old link still resolves to a hosted page.
  reporting: { employee: "Wesley", because: "Holds the relationships with the people whose money this is." },
  record: {
    employee: "Wells",
    because: "Keeps the firm's memory: what was decided, claimed and evidenced.",
    // The memory half of his remit. The document vault is a different question and has its own
    // page below.
    machineKeys: ["knowledge_memory_promotion", "research_data_license_quality"],
  },

  // ── Learn ──
  research: {
    employee: "Wyatt",
    because:
      "Research runs through me. Open a project with the question you actually want answered and I will gather the " +
      "sources, say how reliable each one is, and come back with findings — this is not a search box, and the answer " +
      "arrives after the work rather than instead of it.",
    // Not his cap-table or opportunity-radar methods. A question about a market answered with
    // waterfall arithmetic attached is a worse answer, not a fuller one.
    machineKeys: ["research_intelligence"],
  },
  university: {
    employee: "Whitney",
    because:
      "Name anything in venture and I will teach it — explaining it, testing you on it, running a deal past you, or " +
      "listening to you teach it back. I will tell you when you are wrong.",
  },
  /*
   * DOCUMENTS FINALLY HAS A DOCUMENT MACHINE UNDER IT. This page was hosted by a seat holding no
   * method about documents at all — one of the three silent mismatches the host/machine guard was
   * written for. `data_room_control` was unseated; it is now Wells's, which is the seat that was
   * already accountable for the page.
   */
  documents: {
    employee: "Wells",
    because: "Files what the firm produces, keeps its versions straight, and knows who was given what.",
    machineKeys: ["data_room_control"],
  },
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
    // The page's own machines when it names them, else the seat's whole remit.
    machineKeys: assigned.machineKeys ?? entry.primaryMachineKeys,
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
