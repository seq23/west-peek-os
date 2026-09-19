import { useCallback, useEffect, useState } from "react";
import { readableDate, shortDate } from "./lib/dates";
import { api, getDevUser, mutationError, onNotificationsChanged, signOut, useApi, type MeResponse } from "./lib/api";
import { DocumentPreview } from "./components/DocumentPreview";
import { LpPage } from "./pages/LpPage";
import { PortfolioPage } from "./pages/PortfolioPage";
import { PageHostCard } from "./pages/PageHostCard";
import { HomePage } from "./pages/HomePage";
import { IntelligencePage } from "./pages/IntelligencePage";
import { EmployeesPage } from "./pages/EmployeesPage";
import { EventsPage } from "./pages/EventsPage";
import { RoomsPage } from "./pages/RoomsPage";
import { IntroductionsPage } from "./pages/IntroductionsPage";
import { CommunityPage } from "./pages/CommunityPage";
import { LedgersPage } from "./pages/LedgersPage";
import { WeeklyReviewPage } from "./pages/WeeklyReviewPage";
import { CrossOfficePage } from "./pages/CrossOfficePage";
import { SecondariesPage } from "./pages/SecondariesPage";
import { PagePurposeBlock } from "./pages/PagePurposeBlock";
import { FundStrategyPage } from "./pages/FundStrategyPage";
import { PrivateLayerPage } from "./pages/PrivateLayerPage";
import { actionName, actorName } from "@shared/help/actionNames";
import { stateMeaning } from "@shared/work/workCards";
import { SignInCard, SignedOutPage } from "./pages/AuthSurfaces";
import { SurfaceBoundary } from "./pages/SurfaceBoundary";
import { UniversityPage } from "./pages/UniversityPage";
import { MarketMapPage } from "./pages/MarketMapPage";
// The approvals queue is its own surface file, like every other page. It left App.tsx when the
// cards became collapsible and grew a block, a release and a change-your-mind path: three hundred
// lines of one surface inside the shell is where a file stops being readable.
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { AiOpsPage } from "./pages/AiOpsPage";
import { MachinesPage } from "./pages/MachinesPage";
import { IntentPage } from "./pages/IntentPage";
import { JobsPage } from "./pages/JobsPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { ResearchPage } from "./pages/ResearchPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";
import { DutyRosterPanel } from "./pages/DutyRosterPanel";
import { ThesisPage } from "./pages/ThesisPage";
import { DealflowPage } from "./pages/DealflowPage";
import { MeetingsPage as MeetingsSurface } from "./pages/MeetingsPage";
import { RoomPanel } from "./pages/RoomPanel";
import { CompaniesPage as CompanyRegister } from "./pages/CompaniesPage";
import { BrowserTasksPage } from "./pages/BrowserTasksPage";
import { WorkCardsPage as WorkSurface } from "./pages/WorkCardsPage";
import { GOVERNANCE_UPDATE_TYPES, RECOMMENDED_GOVERNANCE, governanceType } from "@shared/governance/updateTypes";
import { useSelectedFund } from "./lib/selectedFund";
import { HelpCenterPage, type HelpGroup } from "./pages/HelpCenterPage";
import { LiveHelpPanel } from "./pages/LiveHelpPanel";
import { CloseoutPanel } from "./pages/CloseoutPanel";
import { SetupPage } from "./pages/SetupPage";
import { enqueueCapture, flushCaptures, isOnline, queuedCaptures } from "./lib/offlineQueue";

/**
 * West Peek OS client shell.
 *
 * P3 built the governed work surface (Today, +Capture, Work Cards, Approvals, Activity,
 * Governance, Diagnostics) and P5–P12 added the institutional surfaces. The P13–P25
 * continuation adds the operating surfaces (Home, Intelligence, …) as their own modules
 * under `pages/`, and leaves every existing journey where it was.
 *
 * Identity comes from /api/me; in local mode the client sends the dev identity header
 * (x-wpos-dev-user) from localStorage.
 */

export { getDevUser };

interface HealthResponse {
  ok: boolean;
  env: string;
  d1: { reachable: boolean; schemaVersion: string | null; error?: string };
  bindings: Record<string, boolean>;
}

interface CaptureRow {
  id: string;
  capture_type: string;
  raw_text: string;
  source_channel: string;
  privacy_label: string;
  status: string;
  routed_machine_id: number | null;
  created_at: string;
}

interface MachineRow {
  id: number;
  key: string;
  name: string;
  domain_id: string;
}

interface WorkCardRow {
  id: string;
  title: string;
  state: string;
  owner_type: string;
  owner_id: string | null;
  priority: string;
  privacy_label: string;
  next_action: string | null;
  created_at: string;
}

interface ApprovalCardRow {
  id: string;
  action_key: string;
  object_type: string;
  object_id: string;
  title: string;
  state: string;
  requested_by_type: string;
  requested_by_id: string;
  required_approver_roles_json: string;
  decided_by: string | null;
  decision_note: string | null;
  created_at: string;
  decisions?: Array<{ id: string; decision: string; decided_by: string; note: string | null; created_at: string }>;
}

interface ActivityEvent {
  id: string;
  event_type: string;
  actor_type: string;
  actor_id: string;
  object_type: string;
  object_id: string;
  created_at: string;
  payload: Record<string, unknown>;
}

interface GovernanceUpdateRow {
  id: string;
  update_type: string;
  title: string;
  body: string;
  issued_by: string;
  created_at: string;
}

interface MemoRow {
  id: string;
  audience: string;
  department: string | null;
  title: string;
  body: string;
  author_type: string;
  author_id: string;
  created_at: string;
}

interface ApprovalVolume {
  targetPerDay: number;
  days: Array<{ date: string; count: number; overTarget: boolean }>;
  weekly: Array<{ week: string; count: number; overTarget: boolean }>;
  daysOverTarget: string[];
}

interface AiRunRow {
  id: string;
  purpose: string;
  status: string;
  sensitivity: string;
  privacy_mode: string;
  cost_mode: string;
  model: string | null;
  provider_id: string | null;
  trace_id: string;
  failure_reason: string | null;
  output_quarantine: number;
  created_at: string;
}

interface AiProviderRow {
  id: string;
  provider_key: string;
  display_name: string;
  enabled: number;
  kill_switched: number;
}

interface AiBudgetResponse {
  policy: { cost_mode: string; privacy_mode: string; daily_cap_usd: number; per_run_cap_usd: number };
  today: { spent_usd: number; daily_cap_usd: number };
}

/**
 * Navigation. Twenty-nine destinations in one flat list did not survive their own length:
 * measured at 1440x900 the rail stood 1624px tall inside a 900px viewport, so twelve
 * destinations sat below the fold and scrolling the work scrolled the wayfinding away
 * (docs/WEST_PEEK_DESIGN_REFERENCE_AUDIT.md §3.2).
 *
 * The same twenty-nine destinations are now grouped by the job they belong to. Grouping is
 * labelling only: every destination stays a visible, reachable button — none is hidden behind
 * a disclosure, and no label changed, so every existing selector still resolves.
 */
/**
 * Two tiers, not one flat list of twenty-nine.
 *
 * The rail previously gave every destination the same weight, which asks a Managing Partner to
 * know what a Machine or an AI Op is before they can find Approvals. Everyday work is now six
 * groups plus Help; the operator surfaces that only matter when something is wrong or being
 * administered live behind one disclosure.
 *
 * NOTHING WAS REMOVED. All twenty-nine original destinations keep their key AND their exact
 * label, so every existing deep link and selector still resolves; the twelve that moved are one
 * keystroke away rather than one scroll away. `secondary` is the only new axis.
 */
/**
 * The rail, grouped by WHEN you use something rather than what it is (P53).
 *
 * The previous shape grouped by subject — eight groups, forty destinations, and a "Team" group with
 * one item in it. A one-item group is not a group, it is an orphan wearing a header, and that
 * unevenness is what the eye reads as untidy before any styling detail.
 *
 * Grouping by the rhythm of a day means an operator asks "am I doing today's work, deal work, firm
 * work, or looking something up" — which is a question they can answer — rather than "is Follow-on
 * an Investing thing or a Portfolio thing", which they cannot.
 *
 * HOME AND ASK STAY UNGROUPED at the top, with icons. They are reached by muscle memory rather than
 * by reading, and an icon is what makes that possible. Icons stop there deliberately: forty icons
 * would mean inventing metaphors for things like "Contradictions", and a bad icon is worse than
 * none because it has to be read AND decoded.
 */
const NAV_GROUPS = [
  {
    group: "",
    pinned: true,
    items: [
      { key: "home", label: "Home", icon: "home" },
      { key: "intent", label: "Ask", icon: "ask" },
      { key: "capture", label: "Capture", icon: "capture" },
    ],
  },
  {
    // What is in front of you today. Approvals leads because it is the only group where something
    // is waiting on YOU rather than the other way round.
    group: "Now",
    blurb: "What is in front of you today",
    items: [
      // ITEM 4: Approvals and Work sit together, and the checkmark is gone.
      //
      // Operator: "Move Work under Approvals; drop the checkmark." Both answer the same question —
      // what is waiting on a person — so they belong adjacent rather than separated by Today,
      // Notifications and the weekly review. The tick was the only icon on any nav item in the
      // group, which made Approvals look like a state (done) rather than a place, and made every
      // other item look like it was missing something.
      { key: "approvals", label: "Approvals" },
      { key: "work", label: "Work" },
      { key: "notifications", label: "Notifications" },
      // Introductions moved into Community. It sat here beside Approvals and Notifications — things
      // that always have something waiting — while being a surface that is deliberately empty most
      // months, so its presence read as a system that had stopped working. The route stays live.
      //
      // The weekly review is archived, 18 Sep 2026 — owner: "we don't need it anymore." The
      // per-person Wednesday prep packet (services/meetingPrep.ts, kind `meeting_prep`) replaced
      // the one shared sixteen-heading agenda, and its job `weekly_mp_review` is RETIRED (0198).
      // Every review already written is kept. The route stays live so a bookmark still lands;
      // it is simply no longer listed here.
    ],
  },
  {
    group: "Deals",
    blurb: "Companies, from first look to exit",
    items: [
      { key: "thesis", label: "Thesis" },
      { key: "dealflow", label: "Dealflow" },
      { key: "companies", label: "Companies" },
      { key: "meetings", label: "Meetings" },
      { key: "secondaries", label: "Secondaries" },
      { key: "portfolio", label: "Portfolio" },
      // Allocation merged into Fund strategy. Two tabs answered one question — "what the portfolio
      // is made of" and "where the fund goes" lived on one, "allocation decision view" on the
      // other — so you had to visit both to be sure you had seen everything. The route stays live.
      // Deal Math merged in, 22 Aug 2026 (item 13). It was a signpost to the VentureDeals
      // dashboards plus the firm's own figures to carry across — which is the step you take WHILE
      // deciding a cheque, not a separate errand. Two tabs meant reading the fund's position on one
      // and the numbers to model it with on the other. The route stays live so a bookmark lands.
      { key: "fund-strategy", label: "Fund strategy" },
    ],
  },
  {
    // The firm as an institution: the people around it and what it owes them. Employees sits here
    // rather than in a group of its own — the AI workforce is part of the firm, not a category.
    group: "Firm",
    blurb: "The institution, and the people around it",
    items: [
      { key: "lp", label: "LP" },
      // Events used to be its own tab. A Room IS an event, and two tabs for one idea made the
      // operator pick between them every time; the events surface now renders inside Rooms.
      { key: "rooms", label: "Events & Rooms" },
      { key: "community", label: "Community" },
      { key: "employees", label: "Employees" },
      { key: "record", label: "Record" },
    ],
  },
  {
    // Looking something up, or being taught it.
    group: "Learn",
    blurb: "Looking something up, or being taught it",
    items: [
      // Sources moved to Admin as "Sources & sweeps". Once the brief itself came off that page it
      // was feeds, a watchlist, raw gathered items and sweep history — setup, not something you
      // read, and Learn is for looking things up.
      // Market mapping had its own tab and almost nothing on it, which reads as abandoned rather
      // than unused. It is the same activity as Research — finding out what is true about a market
      // — and now renders there. The route stays live so old links still resolve.
      { key: "research", label: "Research" },
      { key: "university", label: "University" },
      { key: "documents", label: "Documents" },
    ],
  },
  {
    group: "Admin",
    blurb: "How the system is set up and behaving",
    secondary: true,
    items: [
      { key: "cockpit", label: "Cockpit" },
      // "AI" named nothing — it is where the provider kill switches, the spend ceiling and
      // the outbound-email switches live, all of which are controls rather than a subject.
      { key: "ai-controls", label: "AI controls" },
      { key: "sources-and-sweeps", label: "Sources & sweeps" },
      // "Go and look" moved to Work. Admin is where you configure the system; sending an employee
      // to read a live page is work that produces something you act on. The route stays live.
      { key: "machines", label: "Machines" },
      { key: "governance", label: "Governance" },
      { key: "contradictions", label: "Contradictions" },
      { key: "cross-office", label: "Cross-office" },
      { key: "activity", label: "Activity" },
      { key: "integrations", label: "Integrations" },
      { key: "network", label: "Network OS" },
      { key: "diagnostics", label: "Diagnostics" },
    ],
  },
  {
    group: "",
    footer: true,
    items: [
      { key: "setup", label: "Set up" },
      { key: "help", label: "Help" },
    ],
  },
] as const;

/**
 * The four icons. Inline SVG rather than a font or a sprite: the artifact CSP blocks external
 * requests, and four paths do not justify a dependency.
 */
function NavIcon({ name }: { name: string }): JSX.Element | null {
  const common = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true as const };
  if (name === "home") {
    return (
      <svg {...common} className="nav-icon">
        <path d="M2 6.5 8 2l6 4.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "ask") {
    return (
      <svg {...common} className="nav-icon">
        <path d="M14 9.5A2.5 2.5 0 0 1 11.5 12H6l-3 2.5V4.5A2.5 2.5 0 0 1 5.5 2h6A2.5 2.5 0 0 1 14 4.5v5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "capture") {
    return (
      <svg {...common} className="nav-icon">
        <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "approvals") {
    return (
      <svg {...common} className="nav-icon">
        <path d="m3 8.5 3.2 3.2L13 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return null;
}

const NAV_ITEMS: Array<{ key: string; label: string; group: string; secondary: boolean }> =
  NAV_GROUPS.flatMap((g) =>
    g.items.map((item) => ({
      key: item.key,
      label: item.label,
      group: g.group,
      secondary: "secondary" in g && g.secondary === true,
    })),
  );

/** The nav as the Help tab lists it — one section per page, in the order the rail shows them. */
const HELP_GROUPS: readonly HelpGroup[] = NAV_GROUPS.map((g) => ({
  group: "footer" in g && g.footer ? "" : g.group,
  keys: g.items.map((i) => i.key).filter((k) => k !== "help" && k !== "setup"),
}));

/**
 * Every destination the URL may name.
 *
 * Derived from the nav rather than listed, so a page added to NAV_GROUPS is linkable the moment it
 * exists and a page removed stops resolving — the two cannot drift. Routes kept alive after a merge
 * (allocation, follow-on, market-map) are handled where they render, not here.
 */
const ALL_NAV_KEYS: ReadonlySet<string> = new Set([
  ...NAV_ITEMS.map((n) => n.key),
  // Merged destinations whose addresses still work, so an old link or bookmark lands somewhere real.
  "allocation",
  // The private layer: reachable by URL and from Home's foot, never in the nav (design/HOME_DESIGN.md §2).
  "private",
  "follow-on",
  "market-map",
  "jobs",
  "browser-tasks",
  "introductions",
]);

/** Keys that live behind the More / System disclosure. */
const SECONDARY_KEYS: ReadonlySet<string> = new Set(
  NAV_ITEMS.filter((n) => n.secondary).map((n) => n.key),
);

/** Home is the shell's fallback surface; NAV_GROUPS is authored so it always exists. */
const NAV_FALLBACK = NAV_ITEMS[0]!;

const WORK_CARD_STATES = ["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"];

// ── Identity ──

function initials(fullName: string): string {
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

/**
 * Who is asking, in the surface header — one line, always in the same place, so the operator
 * can see their own authority without leaving the screen they are working on.
 */
function IdentityPanel({ me, status, loading, onSignOut }: { me: MeResponse | null; status: number | null; loading: boolean; onSignOut: () => void }) {
  if (loading) return <p data-testid="identity-status">Checking identity…</p>;
  if (status === 200 && me) {
    return (
      <p data-testid="identity-status">
        <span className="avatar" aria-hidden="true">
          {initials(me.fullName)}
        </span>
        Signed in as <strong>{me.fullName}</strong>{" "}
        {/* The address is the one thing on this line a phone can do without: at 390px it wrapped the
            identity line to three, and with the purpose block put 437px of chrome above Home's
            answer (design/HOME_DESIGN.md: the answer sits above the 844px fold). Hidden ≤ 40rem
            by `.identity-email` and `.identity-role`; the name and Sign out stay. */}
        <span className="identity-email">({me.email})</span><span className="identity-role"> — {me.roles.join(", ") || "no roles"}</span>
        <button type="button" className="link-button" data-testid="sign-out" onClick={onSignOut}>
          Sign out
        </button>
      </p>
    );
  }
  return (
    <p data-testid="identity-status">
      <span className="badge badge-gate">NOT AUTHENTICATED</span>
    </p>
  );
}

// ── Pages ──

function ResolveCapture({ captureId, onResolved }: { captureId: string; onResolved: () => void }): JSX.Element {
  const [kind, setKind] = useState<"COMPANY" | "PERSON" | "NEITHER">("COMPANY");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [organization, setOrganization] = useState("");
  const [outcome, setOutcome] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  return (
    <div data-testid={`resolve-capture-${captureId}`}>
      <p className="muted small">
        What is this about? Companies are matched against the register before a new one is created.
        People are checked against Network OS, which owns them.
      </p>
      <form
        className="form-row"
        data-testid="resolve-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const res = await api<{ what_this_means?: string; person_source?: string; error?: string; detail?: string }>(
            `/api/captures/${captureId}/resolve`,
            {
              method: "POST",
              body: {
                kind,
                ...(kind === "NEITHER" ? {} : { name }),
                ...(kind === "PERSON" && email ? { email } : {}),
                ...(kind === "PERSON" && organization ? { organization } : {}),
              },
            },
          );
          if (res.status !== 200) {
            setOutcome(`Not resolved: ${res.data?.detail ?? res.data?.error ?? res.status}`);
            return;
          }
          setQueued(res.data?.person_source === "LOCAL_UNRESOLVED");
          setOutcome(res.data?.what_this_means ?? "Resolved.");
          onResolved();
        }}
      >
        <label>
          This is a{" "}
          <select data-testid="resolve-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="COMPANY">Company</option>
            <option value="PERSON">Person</option>
            <option value="NEITHER">Neither</option>
          </select>
        </label>
        {kind !== "NEITHER" && (
          <label>
            Name{" "}
            <input data-testid="resolve-name" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        {kind === "PERSON" && (
          <>
            <label>
              Email <input data-testid="resolve-email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label>
              Organisation{" "}
              <input data-testid="resolve-org" value={organization} onChange={(e) => setOrganization(e.target.value)} />
            </label>
          </>
        )}
        <button type="submit" data-testid="resolve-submit">
          Resolve
        </button>
      </form>
      {outcome && (
        <p className={queued ? "notice" : "muted small"} data-testid="resolve-outcome">
          {outcome}
        </p>
      )}
    </div>
  );
}

/**
 * WHAT A CAPTURE IS FOR, and why this page had never been used once.
 *
 * The page asked for a "Type" and a "Channel" as free text and offered a privacy dropdown of seven
 * SHOUTING enum values. Nothing on it said what a capture was, what happened to one after you wrote
 * it, or why you would use this instead of Ask. So nobody did — production held zero captures on
 * the day this was rewritten.
 *
 * The distinction that makes it worth having: ASK is for something you want done, and it comes back
 * with an answer. CAPTURE is for something you do not want to lose and do not want to think about
 * yet — a name from a dinner, a rumour, a number, a thing to chase. It is written down first and
 * sorted second. So the page leads with the box, offers real kinds rather than free text, and says
 * where each kind ends up.
 */
const CAPTURE_KINDS: readonly [{ value: string; label: string; hint: string }, ...{ value: string; label: string; hint: string }[]] = [
  { value: "note", label: "A note to self", hint: "Anything you want kept. Sits in the record until you or someone routes it." },
  { value: "company", label: "A company worth a look", hint: "Route it to Dealflow and it becomes a deal record to screen." },
  { value: "person", label: "Someone worth knowing", hint: "Goes to the Network so the firm remembers who they are and who introduced them." },
  { value: "signal", label: "A market signal or rumour", hint: "Feeds the morning brief and the thesis work — what is moving and who said so." },
  { value: "task", label: "Something that must get done", hint: "Route it and it becomes a work card with an owner and a next action." },
  { value: "lp", label: "An LP conversation", hint: "Kept against the LP record. Mark it LP-private if it was said in confidence." },
  { value: "meeting", label: "Something from a meeting", hint: "Attaches to the meeting record so the debrief has it." },
  { value: "question", label: "A question to answer later", hint: "Held until you send it to Ask, so it is not lost while you are busy." },
];

const CAPTURE_CHANNELS: { value: string; label: string }[] = [
  { value: "web", label: "Typed here" },
  { value: "phone", label: "Phone call" },
  { value: "email", label: "Email" },
  { value: "meeting", label: "In a meeting" },
  { value: "event", label: "At an event" },
  { value: "text", label: "Text or DM" },
  { value: "referral", label: "Someone told me" },
];

/** The seven storage labels in the words a partner would use, with what each one costs you. */
const PRIVACY_CHOICES: readonly [{ value: string; label: string; hint: string }, { value: string; label: string; hint: string }, ...{ value: string; label: string; hint: string }[]] = [
  { value: "PUBLIC", label: "Public — already public knowledge", hint: "Any employee can use it, including with an outside model." },
  { value: "INTERNAL", label: "Internal — ordinary firm business", hint: "The default. Employees can work with it." },
  { value: "CONFIDENTIAL", label: "Confidential — sensitive to the firm", hint: "Stays inside. No outside model sees it." },
  { value: "RESTRICTED", label: "Restricted — partners only", hint: "No AI employee may read it." },
  { value: "LP_PRIVATE", label: "LP private — said by an LP in confidence", hint: "Never leaves the LP record." },
  { value: "MNPI_SENSITIVE", label: "Material non-public information", hint: "Locked. Handling it wrongly is a regulatory problem, not a preference." },
  { value: "BANKING_RESTRICTED", label: "Banking restricted", hint: "Locked to the banking side of a deal." },
];

function CapturePage({ onChanged, onNavigate }: { me: MeResponse; onChanged: () => void; onNavigate: (page: string) => void }) {
  const [captureType, setCaptureType] = useState("note");
  const [sourceChannel, setSourceChannel] = useState("web");
  const [rawText, setRawText] = useState("");
  const [privacyLabel, setPrivacyLabel] = useState("INTERNAL");
  const [result, setResult] = useState<CaptureRow | null>(null);
  const [routeResult, setRouteResult] = useState<string | null>(null);
  const [machineId, setMachineId] = useState<number>(3);
  const [error, setError] = useState<string | null>(null);
  const machines = useApi<{ machines: MachineRow[] }>("/api/machines");
  const recent = useApi<{ captures: CaptureRow[] }>("/api/captures");

  const kind = CAPTURE_KINDS.find((k) => k.value === captureType) ?? CAPTURE_KINDS[0];
  const privacy = PRIVACY_CHOICES.find((p) => p.value === privacyLabel) ?? PRIVACY_CHOICES[1];
  const unrouted = (recent.data?.captures ?? []).filter((c) => c.status === "NEW");

  return (
    <section data-testid="capture-page">
      <div className="card capture-explainer">
        <h4>Write it down now, sort it out later</h4>
        <p>
          This is the box for anything you do not want to lose and do not want to think about yet — a name from a
          dinner, a company somebody mentioned, a number, a thing to chase. Nothing here needs to be tidy.
        </p>
        <p className="muted">
          It is not the{" "}
          <button type="button" className="link-button" onClick={() => onNavigate("intent")}>
            Ask
          </button>{" "}
          box. Ask is for something you want done and comes back with an answer. Capture is for something you want
          kept. Once it is in, you — or an AI employee — can send it on to{" "}
          <button type="button" className="link-button" onClick={() => onNavigate("companies")}>
            Dealflow
          </button>
          ,{" "}
          <button type="button" className="link-button" onClick={() => onNavigate("network")}>
            the Network
          </button>
          , or{" "}
          <button type="button" className="link-button" onClick={() => onNavigate("work")}>
            a work card
          </button>{" "}
          with an owner. Until then it just sits there safely, and it survives losing signal mid-sentence.
        </p>
      </div>

      <form
        data-testid="capture-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setResult(null);
          setRouteResult(null);
          // P20: capture is the one thing that survives a bad connection — and a held capture is
          // stated as NOT saved, never shown as recorded.
          if (!isOnline()) {
            const held = enqueueCapture({
              capture_type: captureType,
              raw_text: rawText,
              source_channel: sourceChannel,
              privacy_label: privacyLabel,
            });
            setError(
              `Offline: held on this device as ${held.local_id}. It is NOT saved to West Peek OS yet — send it from the status bar when you are back online.`,
            );
            return;
          }
          try {
            const { status, data } = await api<CaptureRow & { error?: string }>("/api/captures", {
              method: "POST",
              body: { capture_type: captureType, raw_text: rawText, source_channel: sourceChannel, privacy_label: privacyLabel },
            });
            if (status === 201 && data) {
              setResult(data);
              setRawText("");
              recent.reload();
              onChanged();
            } else {
              setError(data?.error ?? `HTTP ${status}`);
            }
          } catch {
            const held = enqueueCapture({
              capture_type: captureType,
              raw_text: rawText,
              source_channel: sourceChannel,
              privacy_label: privacyLabel,
            });
            setError(
              `Could not reach West Peek OS: held on this device as ${held.local_id}. It is NOT saved yet — send it from the status bar when the connection returns.`,
            );
          }
        }}
      >
        <label className="capture-box-label" htmlFor="capture-text">
          What happened, or what do you want to remember?
        </label>
        <textarea
          id="capture-text"
          data-testid="capture-text"
          className="capture-box"
          rows={5}
          placeholder="Met the founder of a warehouse-robotics company at the Ferry Building — ex-Amazon, raising a seed in the autumn, wants an intro to Scooter."
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
        />

        <div className="form-row capture-choices">
          <label>
            What kind of thing is it?{" "}
            <select data-testid="capture-type" value={captureType} onChange={(e) => setCaptureType(e.target.value)}>
              {CAPTURE_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Where did it come from?{" "}
            <select data-testid="capture-channel" value={sourceChannel} onChange={(e) => setSourceChannel(e.target.value)}>
              {CAPTURE_CHANNELS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Who may see it?{" "}
            <select data-testid="capture-privacy" value={privacyLabel} onChange={(e) => setPrivacyLabel(e.target.value)}>
              {PRIVACY_CHOICES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {/* The two choices that change what happens next explain themselves in place, so nobody has
            to guess what "signal" does or what LP_PRIVATE costs them. */}
        <p className="muted small capture-hint" data-testid="capture-hint">
          {kind.hint} · {privacy.hint}
        </p>

        <button type="submit" className="btn-primary" data-testid="capture-submit" disabled={!rawText.trim()}>
          Keep this
        </button>
        {error && <p role="alert">Capture failed: {error}</p>}
      </form>

      {result && (
        <div className="card" data-testid="capture-result">
          <p>
            Kept. <strong>{kind.label}</strong> · {privacy.value.replace(/_/g, " ").toLowerCase()}
          </p>
          <ResolveCapture captureId={result.id} onResolved={onChanged} />
          {result.status === "NEW" && (
            <form
              data-testid="route-form"
              onSubmit={async (e) => {
                e.preventDefault();
                const { status, data } = await api<{ capture: CaptureRow; work_card: WorkCardRow | null; error?: string }>(
                  `/api/captures/${result.id}/route`,
                  { method: "POST", body: { machine_id: machineId, create_work_card: true, title: (result.raw_text ?? "").slice(0, 120) } },
                );
                if (status === 200 && data) {
                  setResult(data.capture);
                  recent.reload();
                  setRouteResult(`Sent to machine #${data.capture.routed_machine_id}. ${data.work_card ? "A work card was opened for it." : "No work card was opened."}`);
                  onChanged();
                } else {
                  setRouteResult(`Could not send it on: ${data?.error ?? `HTTP ${status}`}`);
                }
              }}
            >
              <p className="muted small">
                It is saved either way. Sending it on hands it to a department and opens a work card so somebody
                owns it.
              </p>
              <label>
                Send it to{" "}
                <select data-testid="route-machine" value={machineId} onChange={(e) => setMachineId(Number(e.target.value))}>
                  {(machines.data?.machines ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      #{m.id} {m.name}
                    </option>
                  ))}
                </select>
              </label>{" "}
              <button type="submit" className="btn-strong" data-testid="route-submit">
                Send it on and open a work card
              </button>
            </form>
          )}
          {routeResult && <p data-testid="route-result">{routeResult}</p>}
        </div>
      )}

      {/* A page with nothing on it reads as broken. Recent captures show the box is real and give
          the unrouted ones somewhere to be seen rather than quietly accumulating. */}
      <h4>Recently kept</h4>
      {unrouted.length > 0 && (
        <p className="notice" data-testid="capture-unrouted">
          {unrouted.length} {unrouted.length === 1 ? "capture has" : "captures have"} not been sent anywhere yet.
        </p>
      )}
      {(recent.data?.captures ?? []).length === 0 ? (
        <p className="muted">
          Nothing kept yet. The first one can be a single line — it does not have to be a finished thought.
        </p>
      ) : (
        <ul className="card-list" data-testid="capture-recent">
          {(recent.data?.captures ?? []).slice(0, 8).map((c) => (
            <li key={c.id} className="card" data-testid={`capture-row-${c.id}`}>
              <p>
                <strong>{CAPTURE_KINDS.find((k) => k.value === c.capture_type)?.label ?? c.capture_type}</strong>{" "}
                <span className="muted small">
                  · {c.status === "NEW" ? "not sent anywhere yet" : c.status.toLowerCase().replace(/_/g, " ")}
                </span>
              </p>
              <p>{(c.raw_text ?? "").slice(0, 220)}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


function ActivityPage({ refreshNonce }: { me: MeResponse; refreshNonce: number }) {
  const activity = useApi<{ events: ActivityEvent[] }>("/api/activity?limit=100", [refreshNonce]);
  return (
    <section className="page" data-testid="activity-page">
      {/*
        The page had no heading, no prose and no empty state: a bare table whose Event column
        printed `approval.decided` and whose Object column printed `{object_type}/{object_id}` —
        a table of primary keys shown to a Managing Partner. `actionName` already existed and
        already promised never to return a raw dotted key; this surface simply never called it.
      */}
      <h3>Everything the firm has done, newest first</h3>
      <p className="muted small">
        The append-only record. Nothing here can be edited or removed after the fact, which is what
        makes it worth reading — it is the one account of the firm that cannot be tidied.
      </p>

      <div className="table-wrap">
        <table data-testid="activity-feed">
          <thead>
            <tr>
              <th>When</th>
              <th>What happened</th>
              <th>Who</th>
              <th>To what</th>
            </tr>
          </thead>
          <tbody>
            {(activity.data?.events ?? []).map((e) => (
              <tr key={e.id} data-testid={`activity-event-${e.event_type}`}>
                <td>{new Date(e.created_at).toLocaleString()}</td>
                <td>{actionName(e.event_type)}</td>
                <td>{actorName(e.actor_id)}</td>
                {/* The id stays — it is how you find the row again — but behind the thing's name
                    rather than as the whole cell. */}
                <td>
                  {e.object_type.split("_").join(" ")} <span className="muted small">{e.object_id}</span>
                </td>
              </tr>
            ))}
            {!activity.loading && (activity.data?.events ?? []).length === 0 && (
              <tr>
                <td colSpan={4} className="state-empty">
                  Nothing has happened yet. Every approval, decision and recorded fact lands here as it occurs.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Firmwide notices — the standing things every employee reads before doing anything.
 *
 * Under Governance rather than as a section of its own, because that is where the firm already
 * writes down what it operates under. A governance update is an ACT with a date: this changed on
 * this day. A notice is a STANDING FACT: this is how we work, and it is true on every run.
 *
 * The list is honest when empty. It is not seeded with filler, and it does not claim employees are
 * reading something the firm has not written.
 */
function FirmNotices({ isMp }: { isMp: boolean }) {
  const memos = useApi<{ memos: MemoRow[] }>("/api/workforce/memos");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const notices = (memos.data?.memos ?? []).filter((m) => m.audience === "FIRM");

  return (
    <section className="card" data-testid="firm-notices">
      <h3>Notices every employee reads</h3>
      <p className="muted small">
        Standing facts about how this firm works, not a log of changes. Every one of these is put in
        front of an AI employee at the start of every piece of work they do — so a notice here is an
        instruction they actually follow, not a page somebody has to remember to open.
      </p>
      <ul className="card-list" data-testid="firm-notices-list">
        {memos.loading && (
          <li className="state-message" data-testid="firm-notices-loading">
            Loading…
          </li>
        )}
        {notices.map((n) => (
          <li key={n.id} className="card" data-testid="firm-notice">
            <p>
              <strong>{n.title}</strong>{" "}
              <span className="muted small">
                {n.author_type === "SYSTEM" ? "the firm's standing practice" : n.author_id} ·{" "}
                {readableDate(n.created_at)}
              </span>
            </p>
            <p>{n.body}</p>
          </li>
        ))}
        {!memos.loading && notices.length === 0 && (
          <li className="state-empty" data-testid="firm-notices-empty">
            No firmwide notices have been written. Until one is, employees are given none — this
            list is empty because the firm has written nothing down, not because something failed.
          </li>
        )}
      </ul>
      {isMp && (
        <form
          data-testid="firm-notice-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const { status, data } = await api<MemoRow & { error?: string }>("/api/workforce/memos", {
              method: "POST",
              body: { audience: "FIRM", title, body },
            });
            setMessage(
              status === 201
                ? "Written. Every employee reads it from their next piece of work onwards."
                : `Failed: ${data?.error ?? status}`,
            );
            if (status === 201) {
              setTitle("");
              setBody("");
              memos.reload();
            }
          }}
        >
          <h4>Write a notice</h4>
          {/* A notice is permanent: internal_memo rejects UPDATE at the database. Saying so before
              the box is cheaper than saying so after. */}
          <p className="muted small">
            A notice cannot be edited or deleted once written — a correction is a new notice. Write
            it as something an employee can act on, in the words you would use out loud.
          </p>
          <div className="form-row">
            <label>
              Title{" "}
              <input data-testid="firm-notice-title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
          </div>
          <div className="form-row">
            <textarea
              aria-label="What the notice says"
              data-testid="firm-notice-body"
              rows={3}
              style={{ width: "100%" }}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What every employee should know"
            />
          </div>
          <button type="submit" data-testid="firm-notice-submit">
            Write it
          </button>
          {message && <p>{message}</p>}
        </form>
      )}
    </section>
  );
}

function GovernancePage({ me }: { me: MeResponse }) {
  const updates = useApi<{ governance_updates: GovernanceUpdateRow[] }>("/api/governance/updates");
  const [updateType, setUpdateType] = useState("BULLETIN");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const isMp = me.roles.includes("MANAGING_PARTNER");

  const chosen = governanceType(updateType);

  return (
    <section data-testid="governance-page">
      {/* The page used to open on a dropdown of five nouns. Every one is a different act with a
          different consequence, and the screen explained none of them — so the honest response was
          to pick the first and hope, which is how a rule ends up filed as a bulletin and binds
          nobody. */}
      <section className="card" data-testid="governance-explainer">
        <h4>What this page is for</h4>
        <p>
          The rules this firm operates under, and the reasoning behind decisions somebody will
          otherwise re-argue in six months. Everything issued here is permanent and attributed —
          nothing is edited or deleted, and a correction is a new update.
        </p>
        <p className="muted small">
          The distinction that matters is whether it <strong>binds</strong>. A rule changes what
          people and employees may do. Everything else tells the firm something. Getting that
          backwards is expensive in both directions: an unenforced rule is worse than none, and a
          bulletin dressed as a rule makes the firm ignore the next real one.
        </p>
        <ul className="card-list small" data-testid="governance-types">
          {GOVERNANCE_UPDATE_TYPES.map((t) => (
            <li key={t.key}>
              <strong>{t.label}</strong>
              {t.binds && <span className="badge">binding</span>} — {t.what}
              <div className="muted small">{t.when}</div>
            </li>
          ))}
        </ul>
      </section>

      <FirmNotices isMp={isMp} />

      {isMp && RECOMMENDED_GOVERNANCE.length > 0 && (
        <section className="card" data-testid="governance-recommended">
          <h3>Worth writing down</h3>
          <p className="muted small">
            Three suggestions, not a checklist. Each is somewhere this firm&apos;s own history
            already shows the cost of not having written it down.
          </p>
          <ul className="card-list small">
            {RECOMMENDED_GOVERNANCE.map((g) => (
              <li key={g.key} data-testid={`governance-gap-${g.key}`}>
                <strong>{g.title}</strong>{" "}
                <span className="badge">{governanceType(g.suggests)?.label ?? g.suggests}</span>
                <div className="muted small">{g.because}</div>
                <button
                  type="button"
                  className="link-button"
                  data-testid={`governance-draft-${g.key}`}
                  onClick={() => {
                    setUpdateType(g.suggests);
                    setTitle(g.title);
                    setBody("");
                    setMessage("Drafted from a suggestion — write the body in your own words before issuing.");
                  }}
                >
                  Start this one
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {isMp && (
        <form
          className="card"
          data-testid="governance-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const { status, data } = await api<GovernanceUpdateRow & { error?: string }>("/api/governance/updates", {
              method: "POST",
              body: { update_type: updateType, title, body },
            });
            // Was `Issued gov_01H…` — a row id handed to the operator as confirmation. What she
            // needs to know is that it landed and where to look, not its primary key.
            setMessage(status === 201 ? "Issued. It is in the list below, and people acknowledge it. If employees must act on it, write it as a notice above too." : `Failed: ${data?.error ?? status}`);
            if (status === 201) {
              setTitle("");
              setBody("");
              updates.reload();
            }
          }}
        >
          {/* The "(MP only)" was documentation inside a title. The form only renders for a
              Managing Partner, so saying so in the heading told the one person who could see it
              something they already knew, and told nobody else anything. */}
          <h3>Write something down for the firm</h3>
          <div className="form-row">
            <label>
              Type{" "}
              <select value={updateType} onChange={(e) => setUpdateType(e.target.value)}>
                {GOVERNANCE_UPDATE_TYPES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Title <input data-testid="governance-title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
          </div>
          <div className="form-row">
            <textarea aria-label="What the update says" rows={4} style={{ width: "100%" }} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Body" />
          </div>
          {chosen && (
            <div className="notice small" data-testid="governance-example">
              <strong>{chosen.label}</strong>
              {chosen.binds ? " binds the firm. " : " changes no permissions. "}
              {chosen.when}
              <details>
                <summary>What one of these looks like</summary>
                <p><strong>{chosen.example.title}</strong></p>
                <p>{chosen.example.body}</p>
              </details>
            </div>
          )}
          <button type="submit" className="btn-strong" data-testid="governance-submit">
            Issue
          </button>
          {message && <p>{message}</p>}
        </form>
      )}
      {/* Without this, a reader who is not a Managing Partner and has no governance updates to
          read sees a completely blank surface — indistinguishable from a broken one. Found by
          walking every surface as a low-authority identity, which the first pass never did. */}
      {!isMp && (
        <p className="notice notice-gate" data-testid="governance-reserved">
          Issuing a governance update is reserved for a Managing Partner. You hold{" "}
          {me.roles.join(", ") || "no roles"}. Updates issued to the firm are listed below, and
          acknowledging one is your own act.
        </p>
      )}
      {/* The list of what has actually been issued had no heading, so the page's whole point sat
          below two explainer cards and a form with nothing announcing it. */}
      <h3>What the firm has told everyone</h3>
      <ul className="card-list" data-testid="governance-list">
        {updates.loading && <li className="state-message" data-testid="governance-list-loading">Loading…</li>}
        {(updates.data?.governance_updates ?? []).map((u) => (
          <li key={u.id} className="card">
            <p>
              <strong>{u.title}</strong>{" "}
              <span className="badge">{governanceType(u.update_type)?.label ?? u.update_type}</span>
              {governanceType(u.update_type)?.binds && <span className="badge">binding</span>}{" "}
              <span className="muted small">issued {readableDate(u.created_at)}</span>
            </p>
            <p>{u.body}</p>
          </li>
        ))}
        {!updates.loading && (updates.data?.governance_updates ?? []).length === 0 && (
          <li className="state-empty" data-testid="governance-empty">
            No governance updates have been issued. A Managing Partner issues rules, bulletins,
            broadcasts, context notes, and vendor updates here; each one is recorded on the event
            spine and acknowledged per actor.
          </li>
        )}
      </ul>
    </section>
  );
}

interface OutboundSwitch {
  on: boolean;
  what: string;
  risk: string;
  variable: string;
}

/**
 * Whether an AI employee may email anybody.
 *
 * Operator, 21 Aug 2026: "no ai employee should be able to email anything to anyone right now, but
 * the plumbing should be there for them to a) email the MPs and b) one day later email the outside
 * world with a separate flip switch for each", and "those switches should be in red because they
 * are dangerous — red gets attention for the MPs and humans in the app."
 *
 * RED, DELIBERATELY OFF-PALETTE. The brand is black and white with one orange accent, and orange
 * here would make these read like every other emphasis on the page. These are the two settings that
 * let a machine speak on the firm's behalf, and they should not look like anything else in the
 * product. `--wp-danger` is already declared in the token block, so the palette rule holds.
 *
 * READ-ONLY ON PURPOSE. They are deployment settings, so flipping one leaves a diff, a review and a
 * timestamp instead of being a click any session with an MP cookie can make. The page says what
 * they are and how to change them, and cannot change them itself.
 */
function OutboundSwitches() {
  const policy = useApi<{ to_partners: OutboundSwitch; to_external: OutboundSwitch; summary: string; how_to_change: string }>(
    "/api/ai/outbound-policy",
  );
  const p = policy.data;
  if (!p) return null;

  const row = (s: OutboundSwitch, label: string) => (
    <li key={s.variable} className={s.on ? "danger-switch danger-switch-on" : "danger-switch"} data-testid={`outbound-${s.variable}`}>
      <span className="danger-switch-state">{s.on ? "ON" : "OFF"}</span>
      <span>
        <strong>{label}</strong> — {s.what}
        <br />
        <span className="muted small">{s.risk}</span>
        <br />
        <code className="small">{s.variable}</code>
      </span>
    </li>
  );

  return (
    <section className="card" data-testid="ai-outbound">
      <h4>Can an employee email anybody</h4>
      <p className="small">{p.summary}</p>
      <ul className="danger-switches">
        {row(p.to_partners, "The partners")}
        {row(p.to_external, "Outside the firm")}
      </ul>
      <p className="muted small">{p.how_to_change}</p>
    </section>
  );
}

function AiPage({ me }: { me: MeResponse }) {
  const [purpose, setPurpose] = useState("");
  const [inputText, setInputText] = useState("");
  const [sensitivity, setSensitivity] = useState("INTERNAL");
  const [message, setMessage] = useState<string | null>(null);
  const runs = useApi<{ runs: AiRunRow[] }>("/api/ai/runs");
  const providers = useApi<{ providers: AiProviderRow[] }>("/api/ai/providers");
  const budget = useApi<AiBudgetResponse>("/api/ai/budget");
  const isMp = me.roles.includes("MANAGING_PARTNER");

  const killSwitch = async (providerKey: string) => {
    // Governance path: reserved action card → MP approval → receipted call. All logged.
    const card = await api<ApprovalCardRow & { error?: string }>("/api/approvals", {
      method: "POST",
      body: {
        action_key: "governance.policy_change",
        object_type: "provider_registry",
        object_id: providerKey,
        title: `Kill-switch provider: ${providerKey}`,
        submit: true,
      },
    });
    if (card.status !== 201 || !card.data) {
      setMessage(`Kill-switch approval card failed: ${card.data?.error ?? card.status}`);
      return;
    }
    await api(`/api/approvals/${card.data.id}/decide`, { method: "POST", body: { decision: "approved", note: "MP kill-switch" } });
    const res = await api<AiProviderRow & { error?: string; detail?: string }>(`/api/ai/providers/${providerKey}/kill-switch`, {
      method: "POST",
      body: { approval_receipt_id: card.data.id },
    });
    setMessage(
      res.status === 200
        ? `Provider ${providerKey} kill-switched (receipt ${card.data.id}).`
        : `Kill-switch refused: ${res.data?.detail ?? res.data?.error ?? res.status}`,
    );
    providers.reload();
  };

  return (
    <section data-testid="ai-page">
      {/* First on the page, because it is the answer to the question a partner walks in with. */}
      <OutboundSwitches />

      {/*
        THE DUTY ROSTER LIVES HERE, on the operator's instruction that she wants to change it "in
        the admin section". This page is the one Admin surface whose subject is controls over how
        the firm's AI behaves rather than a record you read — the kill switches, the ceiling, the
        outbound switches. Who the firm leans on at 3am is that kind of thing.

        Above the run box deliberately: the rota governs the whole workforce every hour of every
        day, and a one-off governed run does not.
      */}
      <DutyRosterPanel />

      <h4>Run AI task (governed boundary)</h4>
      <form
        className="card"
        data-testid="ai-run-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setMessage(null);
          const { status, data } = await api<AiRunRow & { error?: string; detail?: string }>("/api/ai/run", {
            method: "POST",
            body: { purpose, inputs: [inputText], sensitivity },
          });
          if (status === 201 && data) {
            setMessage(
              `Run ${data.id} — ${data.status}${data.failure_reason ? ` (${data.failure_reason})` : ""} · trace ${data.trace_id}`,
            );
            runs.reload();
          } else {
            setMessage(`Run failed: ${data?.detail ?? data?.error ?? status}`);
          }
        }}
      >
        <div className="form-row">
          <label>
            Purpose <input data-testid="ai-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
          </label>
          <label>
            Sensitivity{" "}
            {/*
              `PRIVACY_CHOICES` — the same seven labels, already written in a partner's words with
              what each one costs them — sat sixty lines up in this very file while this picker
              hand-typed the raw column values beside it. A second copy of a list is a list that
              drifts; this one had already drifted into showing `LP_PRIVATE` and `MNPI_SENSITIVE`
              to a Managing Partner.
            */}
            <select
              data-testid="ai-sensitivity"
              aria-label="How sensitive this material is"
              value={sensitivity}
              onChange={(e) => setSensitivity(e.target.value)}
            >
              {PRIVACY_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row">
          <textarea
            data-testid="ai-input" aria-label="What you want to ask"
            rows={3}
            style={{ width: "100%" }}
            placeholder="Input for the model"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
          />
        </div>
        <button type="submit" className="btn-strong" data-testid="ai-run-submit">
          Run
        </button>
      </form>
      {message && <p className="notice" data-testid="ai-message">{message}</p>}

      {/*
        THIS WAS AN <h4> WHOSE CONTENT WAS A LIVE DATA READOUT — "Policy: `BALANCED` privacy ·
        `NORMAL` cost · today $0.0031 / $5". A heading names a section; a number is not a name, and
        a figure that changes every few minutes cannot be one. It is a sentence now, under a real
        heading, and the page has headings at section rank at all — it previously had none.
      */}
      <h3>What the firm has told the models it may do</h3>
      <p className="muted small" data-testid="ai-policy-line">
        {budget.data
          ? `Privacy is set to ${budget.data.policy.privacy_mode.toLowerCase()} and cost to ${budget.data.policy.cost_mode.toLowerCase()}. Spent today: $${budget.data.today.spent_usd.toFixed(4)} of $${budget.data.today.daily_cap_usd}.`
          : "Reading the current policy…"}
      </p>

      <h3>Who the firm buys thinking from</h3>
      <p className="muted small">
        A kill switch stops a provider immediately and for everyone. Only a Managing Partner can
        throw one, and doing so is recorded against an approval receipt.
      </p>
      <ul data-testid="ai-provider-list" className="card-list">
        {(providers.data?.providers ?? []).map((p) => (
          <li key={p.provider_key} className="card" data-testid={`provider-${p.provider_key}`}>
            <p>
              <strong>{p.display_name}</strong>{" "}
              <span
                className={p.kill_switched ? "help-tag help-tag-warn" : p.enabled ? "help-tag help-tag-good" : "help-tag help-tag-muted"}
                data-testid={`provider-ks-${p.provider_key}`}
              >
                {p.kill_switched ? "stopped" : p.enabled ? "in use" : "switched off"}
              </span>
            </p>
            {isMp && !p.kill_switched && (
              <button type="button" data-testid={`kill-switch-${p.provider_key}`} onClick={() => killSwitch(p.provider_key)}>
                Kill switch
              </button>
            )}
          </li>
        ))}
      </ul>

      <h3>Every run the firm has made</h3>
      <ul data-testid="ai-run-list" className="card-list">
        {(runs.data?.runs ?? []).map((r) => (
          <li key={r.id} className="card" data-testid={`ai-run-${r.id}`}>
            <p>
              <strong>{r.purpose}</strong>{" "}
              <span className={r.status === "COMPLETED" ? "help-tag help-tag-good" : r.status === "REFUSED" ? "help-tag help-tag-muted" : "help-tag help-tag-warn"}>
                {r.status.split("_").join(" ").toLowerCase()}
              </span>
              {r.output_quarantine ? <span className="help-tag help-tag-warn"> held back</span> : null}
            </p>
            <p className="muted small">
              {r.sensitivity.split("_").join(" ").toLowerCase()} · {r.privacy_mode.toLowerCase()} privacy ·{" "}
              {r.cost_mode.toLowerCase()} cost · {r.model ?? "no model reached"}
            </p>
            {/* The trace id is how support finds the run; kept, but not competing with the purpose. */}
            <p className="muted small">{r.trace_id}</p>
            {r.failure_reason && <p className="notice small" data-testid={`ai-run-reason-${r.id}`}>{r.failure_reason}</p>}
          </li>
        ))}
      </ul>
      {(runs.data?.runs ?? []).length === 0 && <p className="state-empty">No AI runs yet. Every run is governed: it needs a purpose, a sensitivity, and a privacy mode, and it is recorded here with its trace id.</p>}
    </section>
  );
}

interface HealthCheckRow {
  key: string;
  label: string;
  state: "OK" | "DEGRADED" | "DOWN";
  reading: string;
  remedy?: string;
  page?: string;
}
interface SystemHealth {
  overall: "OK" | "DEGRADED" | "DOWN";
  summary: string;
  checks: HealthCheckRow[];
  checked_at: string;
}

const HEALTH_WORD: Record<string, string> = { OK: "Working", DEGRADED: "Needs a look", DOWN: "Broken" };
/* Where each check is fixed, named as the destination rather than as the fault — "Open the morning
   brief" is a place to go; "Go to morning brief" is the check's title said twice. */
const HEALTH_DESTINATION: Record<string, string> = {
  home: "Open the morning brief",
  // Keyed "work", which is what health.ts actually emits and what the nav actually has.
  // "work-cards" is the API path; keyed by that, this entry never matched and the check fell back
  // to the generic "Go and look" — a lookup that misses is indistinguishable from one with no entry.
  work: "Open scheduled work",
  employees: "Open the employee lounge",
  "cockpit": "Open spend and routing",
  record: "Open the record",
  integrations: "Open integrations",
};
const HEALTH_CLASS: Record<string, string> = { OK: "health-ok", DEGRADED: "health-warn", DOWN: "health-down" };

/**
 * The dot never travels alone. Colour says it fast, the word beside it says it at all — the same
 * fact twice, so the board still reads for somebody who cannot separate the red from the green.
 */
function HealthDot({ state }: { state: string }) {
  return <span className={`health-dot ${HEALTH_CLASS[state] ?? "health-warn"}`} aria-hidden="true" />;
}

function DiagnosticsPage({ onNavigate }: { onNavigate: (page: string) => void }) {
  const health = useApi<SystemHealth>("/api/diagnostics/health");
  const volume = useApi<ApprovalVolume>("/api/diagnostics/approval-volume");
  const data = health.data;

  return (
    <section data-testid="diagnostics-page">
      <h4>Is anything broken?</h4>
      {data ? (
        <>
          <div className="health-headline" data-testid="health-headline" role="status">
            <HealthDot state={data.overall} />
            <strong>{HEALTH_WORD[data.overall]}</strong>
            <span className="muted">— {data.summary}</span>
          </div>
          <div className="health-grid" data-testid="health-grid">
            {data.checks.map((c) => (
              <div className="health-card" data-state={c.state} data-testid={`health-${c.key}`} key={c.key}>
                <div className="health-card-top">
                  <HealthDot state={c.state} />
                  <span className="health-card-label">{c.label}</span>
                  <span className="health-card-state">{HEALTH_WORD[c.state]}</span>
                </div>
                <div className="health-card-reading">{c.reading}</div>
                {c.remedy ? <div className="health-card-remedy">{c.remedy}</div> : null}
                {c.page ? (
                  <button type="button" className="link-button" onClick={() => onNavigate(c.page!)}>
                    {HEALTH_DESTINATION[c.page] ?? "Go and look"} &rarr;
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <p className="muted small">
            Read {data.checked_at.slice(11, 16)} UTC. Every line above is a measurement taken just now, not a
            configuration setting — a green light here means something was actually checked.
          </p>
        </>
      ) : (
        <p>{health.status ? `Health check failed (HTTP ${health.status}).` : "Reading the system\u2026"}</p>
      )}

      <h4>How much are you being asked to approve?</h4>
      <p className="muted">
        The firm is supposed to need you no more than {volume.data?.targetPerDay ?? 15} times a day. More than that
        and the machine is pushing its judgement onto you.
      </p>
      <div className="table-wrap">
        <table data-testid="approval-volume">
          <thead>
            <tr>
              <th>Day</th>
              <th>Cards</th>
              <th>Flag</th>
            </tr>
          </thead>
          <tbody>
            {(volume.data?.days ?? []).map((d) => (
              <tr key={d.date} data-testid={d.overTarget ? `volume-day-over-${d.date}` : `volume-day-${d.date}`}>
                <td>{d.date}</td>
                <td>{d.count}</td>
                <td>{d.overTarget ? "OVER TARGET" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4>The week in one place</h4>
      <ul>
        {(volume.data?.weekly ?? []).map((w) => (
          <li key={w.week}>
            {w.week}: {w.count}
            {w.overTarget ? " (over target)" : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── P5 pages: Companies (evidence), Documents, Contradictions ──

interface CompanyRow {
  id: string;
  canonical_name: string;
  status: string;
  created_at: string;
}

interface ClaimRow {
  id: string;
  claim_text: string;
  claim_status: string;
  metric_key: string | null;
  metric_value: string | null;
  extracted_by_type: string;
  superseded_by: string | null;
  created_at: string;
}

interface ContradictionRow {
  id: string;
  contradiction_type: string;
  topic: string;
  materiality: string;
  status: string;
  company_id: string | null;
  human_disposition_by: string | null;
  created_at: string;
}

interface EvidenceSummary {
  company_id: string;
  total_claims: number;
  claims_by_status: Record<string, number>;
  claims: ClaimRow[];
  unresolved_material_contradictions: ContradictionRow[];
}

interface ContradictionCandidate {
  contradiction_type: string;
  topic: string;
  metric_key: string;
  claim_ids: string[];
  rationale: string;
}

interface DocumentRow {
  id: string;
  title: string;
  doc_type: string;
  type_label?: string;
  privacy_label: string;
  created_at: string;
  archived_at?: string | null;
  archive_reason?: string | null;
  deck?: { version_no: number; state: string; id: string; title?: string | null } | null;
}
type DocumentTypeChoice = { key: string; label: string; means: string };

function ResolveContradictionForm({ contradiction, onDone }: { contradiction: ContradictionRow; onDone: () => void }) {
  const [disposition, setDisposition] = useState("RESOLVED");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const open = contradiction.status === "OPEN" || contradiction.status === "INVESTIGATING";
  if (!open) return null;
  return (
    <form
      className="form-row"
      data-testid={`resolve-form-${contradiction.id}`}
      onSubmit={async (e) => {
        e.preventDefault();
        const { status, data } = await api<ContradictionRow & { error?: string }>(`/api/contradictions/${contradiction.id}/resolve`, {
          method: "POST",
          body: { disposition, resolution_evidence: { note } },
        });
        setMessage(status === 200 ? `Resolved as ${disposition}.` : `Resolve refused: ${data?.error ?? status}`);
        if (status === 200) onDone();
      }}
    >
      <select aria-label={`disposition-${contradiction.id}`} data-testid={`resolve-disposition-${contradiction.id}`} value={disposition} onChange={(e) => setDisposition(e.target.value)}>
        {["RESOLVED", "ACCEPTED_RISK", "INVALID"].map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
      <input
        placeholder="resolution evidence note"
        aria-label={`evidence-${contradiction.id}`}
        data-testid={`resolve-note-${contradiction.id}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button type="submit" className="btn-strong" data-testid={`resolve-submit-${contradiction.id}`}>
        Resolve
      </button>
      {message && <span data-testid={`resolve-message-${contradiction.id}`}>{message}</span>}
    </form>
  );
}

function CompanyDetail({ company, me }: { company: CompanyRow; me: MeResponse }) {
  const summary = useApi<EvidenceSummary>(`/api/companies/${company.id}/evidence-summary`);
  const [claimText, setClaimText] = useState("");
  const [metricKey, setMetricKey] = useState("");
  const [metricValue, setMetricValue] = useState("");
  const [sourceType, setSourceType] = useState("HUMAN_STATEMENT");
  const [sourceLocation, setSourceLocation] = useState("founder call");
  const [sourceDate, setSourceDate] = useState("2026-01-15");
  const [sourceMethod, setSourceMethod] = useState("interview notes");
  const [message, setMessage] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ContradictionCandidate[] | null>(null);
  void me;

  const reloadAll = () => {
    summary.reload();
    setCandidates(null);
  };

  return (
    <div data-testid="company-detail">
      <h4>{company.canonical_name} — evidence summary</h4>
      {summary.data && (
        <div className="card" data-testid="evidence-summary">
          <p data-testid="summary-claims-by-status">
            {Object.entries(summary.data.claims_by_status)
              .map(([s, n]) => `${s}: ${n}`)
              .join(" · ")}
          </p>
          <h4>Disagreements that matter and are still open</h4>
          <ul data-testid="unresolved-contradictions">
            {summary.data.unresolved_material_contradictions.map((c) => (
              <li key={c.id} data-testid={`summary-contradiction-${c.id}`}>
<span className={c.status === "OPEN" ? "help-tag help-tag-warn" : "help-tag"}>{c.status.toLowerCase()}</span>{" "}
                <span className="muted small">{c.materiality.toLowerCase()}</span> {c.topic}
                <ResolveContradictionForm contradiction={c} onDone={reloadAll} />
              </li>
            ))}
            {summary.data.unresolved_material_contradictions.length === 0 && <li className="state-empty" data-testid="no-material-contradictions">None.</li>}
          </ul>
        </div>
      )}

      <h4>Record something the firm believes, and where it came from</h4>
      <form
        className="card"
        data-testid="claim-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setMessage(null);
          const { status, data } = await api<ClaimRow & { error?: string }>("/api/claims", {
            method: "POST",
            body: {
              company_id: company.id,
              subject_type: "company",
              subject_id: company.id,
              claim_text: claimText,
              metric_key: metricKey || undefined,
              metric_value: metricValue || undefined,
              confidence: 0.8,
              sources: [{ source_type: sourceType, location: sourceLocation, source_date: sourceDate, method: sourceMethod }],
            },
          });
          setMessage(status === 201 ? `Claim ${data!.id} recorded (${data!.claim_status}).` : `Claim refused: ${data?.error ?? status}`);
          if (status === 201) {
            setClaimText("");
            reloadAll();
          }
        }}
      >
        <div className="form-row">
          <label>
            Claim <input data-testid="claim-text" value={claimText} onChange={(e) => setClaimText(e.target.value)} />
          </label>
          <label>
            Metric key <input data-testid="claim-metric-key" value={metricKey} onChange={(e) => setMetricKey(e.target.value)} />
          </label>
          <label>
            Metric value <input data-testid="claim-metric-value" value={metricValue} onChange={(e) => setMetricValue(e.target.value)} />
          </label>
        </div>
        <div className="form-row">
          <label>
            Source{" "}
            <select data-testid="claim-source-type" value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
              {["HUMAN_STATEMENT", "DOCUMENT", "TRANSCRIPT", "WEB", "VENDOR", "OTHER"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            Location <input data-testid="claim-source-location" value={sourceLocation} onChange={(e) => setSourceLocation(e.target.value)} />
          </label>
          <label>
            Date <input data-testid="claim-source-date" value={sourceDate} onChange={(e) => setSourceDate(e.target.value)} />
          </label>
          <label>
            Method <input data-testid="claim-source-method" value={sourceMethod} onChange={(e) => setSourceMethod(e.target.value)} />
          </label>
        </div>
        <button type="submit" className="btn-strong" data-testid="claim-submit">
          Add claim
        </button>
        {message && <p className="notice" data-testid="claim-message">{message}</p>}
      </form>

      <h4>What the firm is treating as true</h4>
      <ul data-testid="claim-list" className="card-list">
        {(summary.data?.claims ?? []).map((c) => (
          <li key={c.id} className="card" data-testid={`claim-${c.id}`}>
            {c.claim_text} — <code data-testid={`claim-status-${c.id}`}>{c.claim_status}</code> · {c.extracted_by_type}
            {c.superseded_by ? ` · superseded by ${c.superseded_by}` : ""}
            {/* Human verification is the ONLY path to VERIFIED on an existing claim;
                the service refuses AI-extracted and source-poor claims outright. */}
            {c.claim_status !== "VERIFIED" && !c.superseded_by && (
              <button
                type="button"
                data-testid={`claim-verify-${c.id}`}
                onClick={async () => {
                  const { status, data } = await api<ClaimRow & { error?: string }>(`/api/claims/${c.id}/verify`, { method: "POST", body: {} });
                  setMessage(status === 200 ? `Claim ${c.id} is now ${data!.claim_status}.` : `Verify refused: ${data?.error ?? status}`);
                  reloadAll();
                }}
              >
                Verify (human)
              </button>
            )}
          </li>
        ))}
      </ul>

      <h4>Look for records that disagree</h4>
      <button
        type="button"
        data-testid="detect-contradictions"
        onClick={async () => {
          const { data } = await api<{ candidates: ContradictionCandidate[] }>(`/api/companies/${company.id}/contradiction-candidates`);
          setCandidates(data?.candidates ?? []);
        }}
      >
        Detect
      </button>
      {candidates !== null && (
        <ul data-testid="contradiction-candidates">
          {candidates.map((cand, i) => (
            <li key={i} data-testid={`candidate-${i}`}>
              <span className="muted small">
                {CONTRADICTION_KINDS[cand.contradiction_type] ?? cand.contradiction_type.split("_").join(" ").toLowerCase()}
              </span>{" "}
              {cand.rationale}{" "}
              <button
                type="button"
                data-testid={`open-contradiction-${i}`}
                onClick={async () => {
                  const { status, data } = await api<ContradictionRow & { error?: string }>("/api/contradictions", {
                    method: "POST",
                    body: {
                      contradiction_type: cand.contradiction_type,
                      topic: cand.topic,
                      company_id: company.id,
                      materiality: "HIGH",
                      required_question: `Resolve ${cand.metric_key}: ${cand.rationale}`,
                      claim_links: cand.claim_ids.map((id, j) => ({ claim_id: id, side_label: `side_${j + 1}` })),
                    },
                  });
                  setMessage(status === 201 ? `Contradiction ${data!.id} opened.` : `Open refused: ${data?.error ?? status}`);
                  reloadAll();
                }}
              >
                Open contradiction
              </button>
            </li>
          ))}
          {candidates.length === 0 && <li className="state-empty" data-testid="no-candidates">No contradiction candidates.</li>}
        </ul>
      )}
    </div>
  );
}

function CompaniesPage({ me }: { me: MeResponse }) {
  const companies = useApi<{ companies: CompanyRow[] }>("/api/companies");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<CompanyRow | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <section data-testid="companies-page">
      <form
        className="form-row"
        data-testid="company-create-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const { status, data } = await api<CompanyRow & { error?: string }>("/api/companies", { method: "POST", body: { canonical_name: name } });
          setMessage(status === 201 ? `Created ${data!.canonical_name}.` : `Create refused: ${data?.error ?? status}`);
          if (status === 201) {
            setName("");
            companies.reload();
          }
        }}
      >
        <label>
          New company <input data-testid="company-create-name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" className="btn-strong" data-testid="company-create-submit">
          Create
        </button>
        {message && <span data-testid="company-message">{message}</span>}
      </form>
      <ul data-testid="company-list" className="card-list">
        {(companies.data?.companies ?? []).map((c) => (
          <li key={c.id} className="card" data-testid={`company-item-${c.id}`}>
            <button type="button" className="link-button" data-testid={`company-open-${c.id}`} onClick={() => setSelected(c)}>
              {c.canonical_name}
            </button>{" "}
            — {c.status}
          </li>
        ))}
        {/*
          A LIST WITH NOTHING IN IT AND NOTHING BESIDE IT. On a firm with no companies this rendered
          an empty <ul> and stopped — the one shape the design system forbids outright (§7: an empty
          slot is a stated fact, never a gap the reader has to interpret). Every sibling list on this
          page already said what would fill it; this one, the register a person types the first
          company into, said nothing at all on the only day it is certain to be empty.
        */}
        {(companies.data?.companies ?? []).length === 0 && (
          <li className="state-empty" data-testid="company-list-empty">
            No company is on the register yet. Add the first one above, or let one arrive by email —
            everything the firm knows about a company hangs off its entry here.
          </li>
        )}
      </ul>
      {selected && <CompanyDetail company={selected} me={me} />}
    </section>
  );
}

function DocumentsPage({ onNavigate }: { onNavigate: (page: string) => void }) {
  const documents = useApi<{ documents: DocumentRow[]; types: DocumentTypeChoice[] }>("/api/documents");
  const archived = useApi<{ documents: DocumentRow[] }>("/api/documents?archived=1");
  /*
   * ARRIVING FROM "VIEW THE DECK". Fund strategy names a document and hands over; this page opens
   * it in a viewer at the top and scrolls the list to it. The handoff is a session key rather than
   * a URL parameter so a bookmarked #/documents stays a plain list. Cleared once read, so a later
   * visit to Documents is not still pinned to last week's deck.
   */
  const [focus, setFocus] = useState<string | null>(() => {
    try {
      const id = window.sessionStorage.getItem("wpos.documents.focus");
      window.sessionStorage.removeItem("wpos.documents.focus");
      return id;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!focus || !documents.data) return;
    // The viewer, not the row: what she asked to see is the document, and it opens at the top.
    document.querySelector('[data-testid="document-viewer"]')?.scrollIntoView({ block: "start" });
  }, [focus, documents.data]);
  const all = documents.data?.documents ?? [];
  const focused = focus ? all.find((d) => d.id === focus) ?? (archived.data?.documents ?? []).find((d) => d.id === focus) ?? null : null;
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const types = documents.data?.types ?? [];
  const chosenType = types.find((t) => t.key === docType) ?? null;

  /*
   * THE DECK SITS ON THE SHELF WITH EVERYTHING ELSE. Operator, 15 Sep 2026: no special section —
   * the versions are documents, grouped under "The LP deck" like every other type. What makes them
   * findable is the ROW, not a section: each says which version it is (the same v{N} badge Fund
   * strategy shows), carries the deck version's own title (so Documents and Fund strategy call v15
   * by one name), and wears its state as a badge. The current one leads, the one waiting on her is
   * next, and earlier versions sit below in version order. The parking spot for the CURRENT deck
   * stays on Fund strategy (`DeckPanel.tsx`); this page is the shelf.
   */
  const deckRank = (d: DocumentRow): number => (d.deck!.state === "CURRENT" ? 0 : d.deck!.state === "PROPOSED" ? 1 : 2);
  const byType = new Map<string, DocumentRow[]>();
  for (const d of all) {
    const k = d.type_label ?? d.doc_type;
    byType.set(k, [...(byType.get(k) ?? []), d]);
  }
  for (const [k, docs] of byType) {
    if (docs.some((d) => d.deck)) {
      byType.set(
        k,
        [...docs].sort((a, b) => {
          if (a.deck && b.deck) return deckRank(a) - deckRank(b) || b.deck.version_no - a.deck.version_no;
          return a.deck ? -1 : b.deck ? 1 : 0;
        }),
      );
    }
  }
  const liveDecks = all.filter((d) => d.deck && (d.deck.state === "CURRENT" || d.deck.state === "PROPOSED"));
  const others = all.filter((d) => !liveDecks.includes(d));

  // THE TITLE IS THE FILE'S NAME UNTIL SHE SAYS OTHERWISE. "why the title of the document doesnt
  // auto match the title of the file i upload?" — it did on submit, invisibly; now it fills the box
  // the moment a file is chosen, and she can change it before uploading.
  const chooseFile = (chosen: File | null) => {
    setFile(chosen);
    if (chosen && !title.trim()) setTitle(chosen.name.replace(/\.[a-z0-9]{2,5}$/i, ""));
  };

  const download = async (id: string, docTitle: string) => {
    const headers: Record<string, string> = {};
    const devUser = getDevUser();
    if (devUser) headers["x-wpos-dev-user"] = devUser;
    const res = await fetch(`/api/documents/${id}/download`, { headers });
    if (res.status !== 200) {
      setMessage(`Download failed: HTTP ${res.status}`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = docTitle;
    a.click();
    URL.revokeObjectURL(url);
  };

  const deckState = (d: DocumentRow): string =>
    d.deck!.state === "CURRENT"
      ? "current"
      : d.deck!.state === "PROPOSED"
        ? "waiting on your decision"
        : d.deck!.state === "REJECTED"
          ? "sent back"
          : "superseded";
  const deckStateClass = (d: DocumentRow): string =>
    d.deck!.state === "CURRENT" ? "badge badge-ok" : d.deck!.state === "PROPOSED" ? "badge badge-gate" : "badge badge-quiet";

  const row = (d: DocumentRow, opts: { archived?: boolean } = {}) => (
    <li key={d.id} className={d.id === focus ? "card deal-row-selected" : "card"} data-testid={`document-${d.id}`}>
      <div>
        {d.deck && (
          <span className={d.deck.state === "CURRENT" ? "badge badge-ok" : d.deck.state === "PROPOSED" ? "badge badge-gate" : "badge"} data-testid={`document-deck-${d.id}`}>
            v{d.deck.version_no}
          </span>
        )}{" "}
        {/* A deck row is named the way Fund strategy names it: the version's own title. */}
        <strong>{d.deck?.title ?? d.title}</strong>
        {d.deck && (
          <>
            {" "}
            <span className={deckStateClass(d)} data-testid={`document-deck-state-${d.id}`}>{deckState(d)}</span>
          </>
        )}
        <span className="muted small">
          {" "}· {d.type_label ?? d.doc_type} · {new Date(d.created_at).toLocaleDateString()}
          {opts.archived && d.archive_reason ? ` · archived: ${d.archive_reason}` : ""}
        </span>
      </div>
      <div className="notification-actions">
        <button type="button" className="link-button" data-testid={`view-${d.id}`} onClick={() => setFocus(d.id)}>
          View here
        </button>
        <button type="button" className="link-button" data-testid={`download-${d.id}`} onClick={() => download(d.id, d.title)}>
          Download
        </button>
        {d.deck && d.deck.state === "PROPOSED" && (
          <button type="button" className="btn-strong" onClick={() => onNavigate("fund-strategy")}>
            Decide on Fund strategy
          </button>
        )}
        {opts.archived ? (
          <button
            type="button"
            className="link-button"
            data-testid={`doc-restore-${d.id}`}
            onClick={async () => {
              const failed = mutationError(await api(`/api/documents/${d.id}/restore`, { method: "POST" }), 200);
              setMessage(failed ?? "Back on the shelf.");
              documents.reload();
              archived.reload();
            }}
          >
            Restore
          </button>
        ) : d.deck && (d.deck.state === "CURRENT" || d.deck.state === "PROPOSED") ? null : (
          /* OFF THE SHELF, NOT DESTROYED. A reason is required because six months from now the
             reason is the only part that still helps. The current deck and a version waiting on a
             decision offer no Archive at all — they are retired on Fund strategy, not here. */
          <button
            type="button"
            className="link-button"
            data-testid={`doc-archive-${d.id}`}
            onClick={async () => {
              const reason = window.prompt(`Why are you taking "${d.title}" off the shelf?`);
              if (!reason || reason.trim().length < 3) return;
              const failed = mutationError(
                await api(`/api/documents/${d.id}/archive`, { method: "POST", body: { reason: reason.trim() } }),
                200,
              );
              setMessage(failed ?? `Archived. It is kept, with your reason attached — find it under "Archived" below.`);
              documents.reload();
              archived.reload();
            }}
          >
            Archive
          </button>
        )}
      </div>
    </li>
  );

  return (
    <section data-testid="documents-page">
      {message && <p className="notice" data-testid="doc-message">{message}</p>}
      {focused && (
        <div className="card" data-testid="document-viewer">
          <div className="home-section-head">
            <h3>
              {focused.deck ? `v${focused.deck.version_no} — ` : ""}
              {focused.deck?.title ?? focused.title}
            </h3>
            <button type="button" className="link-button" onClick={() => setFocus(null)}>close</button>
          </div>
          <DocumentPreview documentId={focused.id} title={focused.title} height="70vh" />
        </div>
      )}

      <form
        className="card"
        data-testid="document-upload-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setMessage(null);
          if (!file) {
            setMessage("Choose a file first.");
            return;
          }
          if (!docType) {
            setMessage("Say what kind of document this is.");
            return;
          }
          const buffer = await file.arrayBuffer();
          let binary = "";
          new Uint8Array(buffer).forEach((b) => (binary += String.fromCharCode(b)));
          const { status, data } = await api<{ id: string; version?: { sha256: string }; deck_version?: { version_no: number }; note?: string; error?: string; detail?: string }>("/api/documents", {
            method: "POST",
            body: { title: title || file.name, doc_type: docType, content_base64: window.btoa(binary), content_type: file.type || "application/octet-stream" },
          });
          setMessage(
            status === 201
              ? data?.deck_version
                ? `Recorded as v${data.deck_version.version_no} of the deck. It is not the deck the firm sends until you approve it on Fund strategy.`
                : `Uploaded ${data!.id}${data!.version ? ` (sha256 ${data!.version.sha256.slice(0, 12)}…)` : ""}.`
              : `Upload failed: ${data?.detail ?? data?.error ?? status}`,
          );
          if (status === 201) {
            setTitle("");
            setFile(null);
            documents.reload();
          }
        }}
      >
        <h4>Put a document on the shelf</h4>
        <div className="form-row">
          <label>
            Title <input data-testid="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="what a partner would call it" />
          </label>
          <label>
            What is it?{" "}
            <select data-testid="doc-type" value={docType} onChange={(e) => setDocType(e.target.value)}>
              <option value="">— pick one —</option>
              {types.map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
          </label>
          <input data-testid="doc-file" aria-label="Choose a file to upload" type="file" onChange={(e) => chooseFile(e.target.files?.[0] ?? null)} />
        </div>
        {chosenType && <p className="muted small" data-testid="doc-type-means">{chosenType.means}</p>}
        <button type="submit" className="btn-strong" data-testid="doc-submit">
          Upload
        </button>
      </form>

      <div className="home-section-head">
        <h3>The shelf</h3>
        {others.length > 0 && (
          <button
            type="button"
            className="link-button"
            data-testid="doc-archive-all"
            onClick={async () => {
              const reason = window.prompt(`Take all ${others.length} of these off the shelf? The current deck and any version waiting on your decision stay. Say why:`);
              if (!reason || reason.trim().length < 3) return;
              const res = await api<{ note?: string }>("/api/documents/archive-all", { method: "POST", body: { reason: reason.trim() } });
              setMessage(mutationError(res, 200) ?? res.data?.note ?? "Archived.");
              documents.reload();
              archived.reload();
            }}
          >
            Archive everything here
          </button>
        )}
      </div>
      <ul data-testid="document-list" className="card-list">
        {[...byType.entries()].map(([label, docs]) => (
          <li key={label} className="card">
            <h4>{label} <span className="count-pill">{docs.length}</span></h4>
            <ul className="card-list">{docs.map((d) => row(d))}</ul>
          </li>
        ))}
        {all.length === 0 && <li className="state-empty">Nothing on the shelf. Morning briefs are not filed here on purpose — they live on Home and are superseded each day.</li>}
      </ul>

      {(archived.data?.documents ?? []).length > 0 && (
        <details data-testid="documents-archived">
          <summary className="muted small">Archived — {(archived.data?.documents ?? []).length} taken off the shelf, none destroyed</summary>
          <ul className="card-list">{(archived.data?.documents ?? []).map((d) => row(d, { archived: true }))}</ul>
        </details>
      )}
    </section>
  );
}

/** The stored kind, said in words. The raw values are `VALUE_DISAGREEMENT` and friends. */
const CONTRADICTION_KINDS: Record<string, string> = {
  VALUE_DISAGREEMENT: "two sources give different numbers",
  PERIOD_DISAGREEMENT: "the same figure is dated differently",
  DEFINITION_DISAGREEMENT: "the same word is being used two ways",
};

function ContradictionsPage() {
  const contradictions = useApi<{ contradictions: ContradictionRow[] }>("/api/contradictions");
  return (
    <section className="page" data-testid="contradictions-page">
      {/*
        The page had NO HEADING OF ANY KIND, no explanation, and opened on a bare "Refresh" button
        followed by a raw list reading `VALUE_DISAGREEMENT · OPEN · HIGH`. A partner arriving here
        could not tell what a contradiction was, why one existed, or what pressing anything would do.
      */}
      <h3>Where the firm's own records disagree</h3>
      <p className="muted small">
        These open by themselves when two sourced claims say different things about the same value,
        period or definition. Nothing is deleted to settle one — you say which reading the firm is
        going with, and both stay on the record.
      </p>

      <ul data-testid="contradiction-list" className="card-list">
        {(contradictions.data?.contradictions ?? []).map((c) => (
          <li key={c.id} className="card" data-testid={`contradiction-${c.id}`}>
            <p>
              <strong>{c.topic}</strong>{" "}
              {/* Was `<code>VALUE_DISAGREEMENT</code> · <code>OPEN</code> · HIGH`. */}
              <span className={c.status === "OPEN" ? "help-tag help-tag-warn" : "help-tag help-tag-good"} data-testid={`contradiction-status-${c.id}`}>
                {c.status === "OPEN" ? "not settled" : c.status.split("_").join(" ").toLowerCase()}
              </span>
            </p>
            <p className="muted small">
              {CONTRADICTION_KINDS[c.contradiction_type] ?? c.contradiction_type.split("_").join(" ").toLowerCase()} ·{" "}
              {c.materiality.toLowerCase()} materiality
            </p>
            {c.human_disposition_by && <p className="muted small">Settled by {c.human_disposition_by}.</p>}
            <ResolveContradictionForm contradiction={c} onDone={() => contradictions.reload()} />
          </li>
        ))}
        {(contradictions.data?.contradictions ?? []).length === 0 && (
          <li className="state-empty">
            Nothing is in conflict. One will appear here the moment two sourced claims disagree.
          </li>
        )}
      </ul>

      {/* At the bottom, because it is a thing you do to the page rather than the point of it. */}
      <p>
        <button type="button" className="btn-ghost" onClick={() => contradictions.reload()}>
          Check again
        </button>
      </p>
    </section>
  );
}

// ── P6: investment / deal math / IC ──
//
// RETIRED, 18 Sep 2026 (design/DEALS_SECTION_DESIGN.md §4, build order §12.3). `InvestmentPage`,
// `Company360Panel`, `IcPacketPanel` and `PlaceholderPanel` lived here after the deal record moved
// into `pages/DealflowPage.tsx`; nothing routed to them, and the only thing they still hosted was
// the IC Portal (`pages/IcPortalPage.tsx`), whose Memo · Market · People · Audit tabs nobody had
// reached since the Investment page was superseded. Those tabs are now faces of the packet inside
// Dealflow (`pages/DealPacket.tsx`), reachable from "Open the packet" on the record's committee
// face. There was never a hash route for the portal, so no address is left dangling: the deal
// record and the committee both answer at `#/dealflow`.

// ── P7: meetings ──
//
// THE WHOLE SURFACE IS `pages/MeetingsPage.tsx` NOW, and that is the fix rather than a tidy-up.
// Two Meetings pages used to render one under the other: a list with a create form from the
// surface file, and a second list with the notes, consent, transcript and close-out machinery
// from here. Both emitted `meeting-list` and `meeting-${id}`, so every selector on this surface
// was ambiguous and opening a meeting in one had no effect on the other. Anybody looking at it
// was reading two pages and being asked to work out which one they were on — which is most of
// what the operator meant by "it is not self explanatory from looking at the page what im able
// to do". See ADR-019.

// ── P9: Network OS integration boundary ──

interface NetworkConflictRow {
  id: string;
  resource: string;
  external_id: string;
  field: string;
  external_value: string | null;
  internal_value: string | null;
  status: string;
  resolution: string | null;
  work_card_id: string | null;
}

interface ContractView {
  active: { version: number; declaration_json: string } | null;
  versions: Array<{ id: string; version: number; active: number; created_at: string }>;
  required_clauses: string[];
  integration_state: string;
}

/**
 * The declared Network OS adapter contract (canon §12A).
 *
 * Renamed from FIXTURE_CONTRACT (P35): the name was wrong and dangerously so. Its content was
 * always a genuine description of the integration, and it is now declared against a LIVE client —
 * a governance record labelled "fixture" while real data moves is exactly the false record this
 * system exists to prevent.
 *
 * `freshness` was corrected at the same time. It claimed "cursor per resource", which was true of
 * the intended design and is not true of the built one: Network OS exposes a whole-snapshot
 * endpoint, so every pull reads current state and there is no cursor to advance. Declaring
 * cursoring we do not do would misstate the firm's own integration in its audit trail.
 */
const NETWORK_OS_CONTRACT = {
  source_of_truth: {
    network_os: ["contact", "relationship", "touch", "gmail_thread"],
    west_peek_os: ["work_card", "approval", "investment_record", "canonical_company_mapping", "audit"],
  },
  direction: "INBOUND read-only by default; OUTBOUND only behind network_os.writeback",
  identity_keys: { contact: "email_lower", relationship: "contact_external_id", touch: "touch_external_id", gmail_thread: "thread_id" },
  freshness: "full snapshot per pull (Network OS exposes current state, not a paged feed); last_sync_at recorded on every pull; fresh=1 bypasses its 45s cache",
  conflict_behavior: "divergence opens a conflict plus a resolver work card; never a silent overwrite",
  idempotency: "delivery_id keyed receipt; duplicates recorded as DUPLICATE_IGNORED",
  retry_behavior: "bounded retries; the approval receipt survives a failed writeback",
  audit_event: "network.* typed events on the one spine",
  failure_state: "DEGRADED_READ_ONLY / FAILED on the cursor; WP OS keeps working",
};

/**
 * People the firm has met who are not in the system of record.
 *
 * This belongs on the Network OS page rather than on Capture, because it is not a capture problem —
 * it is the visible edge of a deliberate constraint. Network OS owns people and West Peek OS reads
 * it without writing to it, so anyone it has never heard of is recorded here and waits.
 *
 * It is a plain list on purpose. Its job is to be visible, short enough to act on, and to turn
 * "we should probably build writeback" into a countable set of real people — so that decision,
 * when it is taken, rests on evidence rather than a hunch.
 */
function UnresolvedPeople(): JSX.Element | null {
  const queue = useApi<{
    people: Array<{ capture_id: string; person_id: string; full_name: string; email: string | null; organization: string | null; resolved_at: string }>;
    count: number;
    why: string;
    next_step: string;
  }>("/api/captures/unresolved-people");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const d = queue.data;
  if (!d || d.count === 0) return null;

  /*
   * THE BUTTON THIS LIST WAS ASKING FOR.
   *
   * Its own next_step read "Add these N to Network OS, or use this list as the case for building a
   * write path" — so it has been telling the operator to go and do it by hand while the write path
   * was built and reachable from nothing. The same shape as every other gap this review found.
   *
   * It PROPOSES. The person lands in Network OS's intake queue for a human there to review, which
   * is why one press is enough: the far end still holds the veto, so there is nothing here for an
   * approval card to protect.
   */
  async function propose(captureId: string, name: string) {
    setBusy(captureId);
    const res = await api<{ detail?: string; error?: string }>(`/api/captures/${captureId}/propose-to-network`, {
      method: "POST",
      body: {},
    });
    setBusy(null);
    setMessage(res.status === 200 ? res.data?.detail ?? `${name} sent.` : `Could not send ${name}: ${res.data?.detail ?? res.data?.error ?? `HTTP ${res.status}`}`);
    queue.reload();
  }

  return (
    <section className="card" data-testid="unresolved-people">
      <h4>
        Not in Network OS <span className="module-count">{d.count}</span>
      </h4>
      <p className="muted small">{d.why}</p>
      <ul className="card-list small">
        {d.people.map((p) => (
          <li key={p.capture_id} data-testid={`unresolved-${p.person_id}`}>
            <strong>{p.full_name}</strong>
            {p.organization ? ` — ${p.organization}` : ""}
            {p.email ? ` · ${p.email}` : ""}
            <span className="muted small"> · met {readableDate(p.resolved_at)}</span>{" "}
            <button
              type="button"
              className="btn-strong"
              disabled={busy === p.capture_id}
              data-testid={`propose-${p.person_id}`}
              onClick={() => void propose(p.capture_id, p.full_name)}
            >
              {busy === p.capture_id ? "Sending…" : "Send to Network OS"}
            </button>
          </li>
        ))}
      </ul>
      <p className="muted small">
        Sending puts someone in Network OS's review queue — it never writes a contact, because
        Network OS decides who is a member.
      </p>
      {message && (
        <p className="notice small" data-testid="unresolved-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

function NetworkPage({ me }: { me: MeResponse }) {
  const contract = useApi<ContractView>("/api/network/contract");
  const [nonce, setNonce] = useState(0);
  const conflicts = useApi<{ conflicts: NetworkConflictRow[] }>("/api/network/conflicts?status=OPEN", [nonce]);
  const syncState = useApi<{ cursors: Array<{ resource: string; last_status: string; failure_reason: string | null }> }>("/api/network/sync-state", [nonce]);
  const [owner, setOwner] = useState("Scooter");
  const [message, setMessage] = useState<string | null>(null);
  void me;

  const post = async (path: string, body: unknown, okStatus: number, label: string) => {
    const { status, data } = await api<{ error?: string; detail?: string; provider?: string }>(path, { method: "POST", body });
    setMessage(status === okStatus ? `${label} ok${data?.provider ? ` (${data.provider})` : ""}.` : `${label} refused: ${data?.error ?? status}`);
    setNonce((n) => n + 1);
    contract.reload();
  };

  return (
    <section data-testid="network-page">
      <p data-testid="integration-state">{contract.data?.integration_state ?? "loading…"}</p>

      <UnresolvedPeople />

      <div className="form-row">
        <button type="button" data-testid="contract-declare" onClick={() => post("/api/network/contract", NETWORK_OS_CONTRACT, 201, "Contract declared")}>
          Declare adapter contract
        </button>
        {/* No client is configured, so a LIVE pull must fail closed. */}
        <button type="button" data-testid="pull-live" onClick={() => post("/api/network/pull/contact", {}, 201, "Live pull")}>
          Pull contacts (live)
        </button>
      </div>

      {contract.data?.active && (
        <p className="card" data-testid="contract-active">
          Active contract v{contract.data.active.version} — declares {contract.data.required_clauses.length} required clauses:{" "}
          {contract.data.required_clauses.join(", ")}
        </p>
      )}

      <h4>Practice run against sample data</h4>
      <form
        className="form-row"
        data-testid="fixture-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await post(
            "/api/network/pull/contact",
            {
              fixture_records: [
                {
                  external_id: "fixture_contact_1",
                  identity_key: "founder@example.com",
                  delivery_id: `d_${Date.now()}`,
                  fields: { email: "founder@example.com", relationship_owner: owner },
                },
              ],
            },
            201,
            "Fixture pull",
          );
        }}
      >
        <label>
          Network OS says relationship_owner ={" "}
          <input data-testid="fixture-owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
        </label>
        <button type="submit" className="btn-strong" data-testid="fixture-pull">
          Pull from fixture
        </button>
        {message && <span data-testid="network-message">{message}</span>}
      </form>

      <h4>Sync state</h4>
      <ul data-testid="sync-state">
        {(syncState.data?.cursors ?? []).map((c) => (
          <li key={c.resource} data-testid={`cursor-${c.resource}`}>
            {c.resource}: <code>{c.last_status}</code>
            {c.failure_reason ? ` — ${c.failure_reason}` : ""}
          </li>
        ))}
        {(syncState.data?.cursors ?? []).length === 0 && <li className="state-empty" data-testid="no-cursors">No sync has run.</li>}
      </ul>

      <h4>Conflict resolver</h4>
      <ul className="card-list" data-testid="conflict-list">
        {(conflicts.data?.conflicts ?? []).map((c) => (
          <li key={c.id} className="card" data-testid={`conflict-${c.id}`}>
            <code>{c.resource}</code> {c.external_id} · <strong>{c.field}</strong> — Network OS: “{c.external_value ?? "∅"}” vs West Peek OS: “
            {c.internal_value ?? "∅"}”{c.work_card_id ? ` · resolver card ${c.work_card_id}` : ""}
            <div className="form-row">
              <button type="button" data-testid={`conflict-keep-external-${c.id}`} onClick={() => post(`/api/network/conflicts/${c.id}/resolve`, { resolution: "KEEP_EXTERNAL", note: "Network OS owns this field" }, 200, "Conflict resolved")}>
                Keep Network OS value
              </button>
              <button type="button" data-testid={`conflict-keep-internal-${c.id}`} onClick={() => post(`/api/network/conflicts/${c.id}/resolve`, { resolution: "KEEP_INTERNAL", note: "our observation is current" }, 200, "Conflict resolved")}>
                Keep West Peek value
              </button>
            </div>
          </li>
        ))}
        {(conflicts.data?.conflicts ?? []).length === 0 && <li className="state-empty" data-testid="no-conflicts">No open conflicts.</li>}
      </ul>
    </section>
  );
}

// ── P10: LP, fundraising, claims, data room ──

interface LpRecordRow {
  id: string;
  legal_name: string;
  lp_type: string;
  status: string;
}

interface LpClaimRow {
  id: string;
  claim_text: string;
  claim_type: string;
  status: string;
  drafted_by_type: string;
  published_at: string | null;
}

interface ArtifactRow {
  id: string;
  title: string;
  version: number;
  status: string;
  provider_ref: string | null;
}

interface AccessRow {
  id: string;
  artifact_id: string;
  artifact_version: number;
  recipient_label: string;
  permission: string;
  expires_at: string | null;
  effective_status: string;
}

// ── P11: fund construction and cross-sleeve allocation ──

// ── P12: LP reporting and fund-admin reconciliation ──

interface PeriodRow {
  id: string;
  label: string;
  status: string;
}

interface PacketRow {
  id: string;
  title: string;
  version: number;
  status: string;
}

interface ReviewRow {
  review_type: string;
  status: string;
  reviewer_id: string | null;
}

interface ExceptionRow {
  id: string;
  record_kind: string;
  record_key: string;
  field: string;
  administrator_value: string | null;
  internal_value: string | null;
  difference: number | null;
  exception_kind: string;
  status: string;
}

// ── Shell ──

/**
 * Status bar (P20, GAP-20): unread exceptions, connection state, and any captures held on this
 * device. A queued capture is stated as NOT SAVED — the operator is never left thinking the firm
 * has something it does not.
 */
function StatusBar({ onNavigate, refreshNonce }: { onNavigate: (key: string) => void; refreshNonce: number }) {
  const notifications = useApi<{ unread_count: number; critical_unread: number }>("/api/notifications?unread=1", [refreshNonce]);
  const [online, setOnline] = useState(isOnline());
  const [queued, setQueued] = useState(queuedCaptures().length);
  const [message, setMessage] = useState<string | null>(null);

  /*
   * THE BADGE FOLLOWS HER ACTIONS. Operator, 9 Sep 2026: "the west peek os home screen still says
   * 12 unread even tho i read it all and dismissed or took responsibility."
   *
   * This component held its own copy of the count, refreshed only when App's `refreshNonce`
   * changed — and that nonce is handed to `CapturePage` and `WorkSurface` and to nothing else. The
   * Notifications page calls its own `useApi().reload()`, which cannot reach this one. So she could
   * clear the entire inbox, watch the page say "You are caught up", and see this number sit
   * unchanged until she reloaded the tab. A counter that does not answer to what she just did
   * teaches her the counter is decorative — and the day it means something looks exactly like the
   * forty days it did not.
   *
   * `onNotificationsChanged` fires from `api()` whenever a notification write is ACCEPTED, whatever
   * surface made it, so no page has to remember to tell the badge.
   */
  const reloadCount = notifications.reload;
  useEffect(() => onNotificationsChanged(reloadCount), [reloadCount]);

  useEffect(() => {
    const update = () => {
      setOnline(isOnline());
      setQueued(queuedCaptures().length);
    };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    const timer = window.setInterval(update, 5000);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      window.clearInterval(timer);
    };
  }, []);

  const unread = notifications.data?.unread_count ?? 0;
  const critical = notifications.data?.critical_unread ?? 0;

  return (
    <p className="status-bar" data-testid="status-bar">
      <button type="button" className="link-button" data-testid="status-notifications" onClick={() => onNavigate("notifications")}>
        {/*
          "WAITING ON YOU", NOT "UNREAD", because that is now what the number counts and the two
          had stopped being the same thing. `?unread=1` returns what is unread AND still true: a
          warning about a fault that has since been fixed is not waiting on anybody. Calling that
          "unread" would be accurate about a column and wrong about the firm — and it is the second
          vocabulary on this subject, since the Notifications page has always said "N waiting".
          One definition, one word.
        */}
        {unread} waiting on you{critical > 0 ? ` (${critical} critical)` : ""}
      </button>
      <span className={online ? "badge badge-ok" : "badge badge-bad"} data-testid="status-connection">
        {online ? "online" : "offline"}
      </span>
      {queued > 0 && (
        <span data-testid="status-queued">
          <span className="badge badge-gate">{queued} capture(s) held on this device — NOT saved to West Peek OS yet</span>{" "}
          <button
            type="button"
            className="link-button"
            data-testid="status-flush"
            onClick={async () => {
              const result = await flushCaptures();
              setQueued(result.remaining);
              setMessage(
                result.remaining === 0
                  ? `${result.sent} capture(s) saved.`
                  : `${result.sent} saved, ${result.remaining} still held: ${result.failures.map((f) => f.reason).join(", ")}`,
              );
            }}
          >
            Send now
          </button>
        </span>
      )}
      {message && <span className="muted small">{message}</span>}
    </p>
  );
}

/**
 * Which page the URL is asking for.
 *
 * THE APP HAD NO ROUTING AT ALL. `active` was React state initialised to "home", so the address bar
 * never changed: a page could not be bookmarked, a link to one could not be sent to Scooter,
 * refreshing dumped you back at Home from wherever you were, and the browser's back button did
 * nothing. Everything in here already speaks in nav keys — `onNavigate("work")` — so the keys
 * were a routing table that was simply never connected to the URL.
 *
 * HASH RATHER THAN PATH, deliberately. A path needs the server to serve the app for every route;
 * the Worker already does that, but a hash cannot 404 and cannot be mistaken for an API path — and
 * `/api/...` and `/work-cards` living in the same namespace is a trap worth not setting.
 *
 * An unknown key falls back to Home rather than rendering nothing, because a stale link somebody
 * saved should land somewhere real.
 */
/**
 * Addresses that outlived their tab.
 *
 * When two tabs merge, the old address has to keep working — people bookmark, and a link in a note
 * from three weeks ago should still land somewhere sensible rather than dumping the reader on Home
 * with no explanation. Resolving the ALIAS rather than merely rendering the merged page also keeps
 * the host card, the purpose block and the page title consistent: `deal-math` used to render Fund
 * strategy's content under Deal Math's host, which is a page signed by the wrong person.
 */
const MERGED_ROUTES: Readonly<Record<string, string>> = {
  "deal-math": "fund-strategy",
  today: "home",
  allocation: "fund-strategy",
  // "Decide on Fund strategy" buttons navigated here and the page rendered under the header "Home".
  "follow-on": "fund-strategy",
};

function keyFromHash(known: (key: string) => boolean): string {
  const raw = window.location.hash.replace(/^#\/?/, "").trim();
  const resolved = MERGED_ROUTES[raw] ?? raw;
  return resolved && known(resolved) ? resolved : "home";
}

/**
 * TIER 3 PREP (Phase C). `#/room/<meeting id>` renders the During face ALONE — no rail, no top
 * bar, no purpose block — behind the same `/api/me` gate as everything else. That is the shape a
 * Google Meet Add-on side panel hosts later: one route, one meeting, the whole live room. Nothing
 * else in the shell knows about it, so it cannot drift from the app's own During face — it is the
 * same component.
 */
function roomIdFromHash(): string | null {
  const m = window.location.hash.match(/^#\/room\/([A-Za-z0-9_-]+)$/);
  return m ? m[1]! : null;
}

export function RoomStandalone({ meetingId }: { meetingId: string }): JSX.Element {
  const me = useApi<MeResponse>("/api/me");
  const authed = me.status === 200 && me.data;
  return (
    <main className="surface-body room-standalone-shell" id="wp-surface" data-testid="room-standalone">
      {authed ? (
        <RoomPanel meetingId={meetingId} standalone />
      ) : me.loading ? (
        <p className="muted small">Signing you in…</p>
      ) : (
        <SignInCard onLogin={() => me.reload()} />
      )}
    </main>
  );
}

export function App() {
  const [roomId, setRoomId] = useState<string | null>(() => (typeof window === "undefined" ? null : roomIdFromHash()));
  useEffect(() => {
    const onHash = () => setRoomId(roomIdFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (roomId) return <RoomStandalone meetingId={roomId} />;
  return <Shell />;
}

function Shell() {
  const [active, setActive] = useState<string>(() => keyFromHash((k) => ALL_NAV_KEYS.has(k)));
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [navOpen, setNavOpen] = useState(false);
  // Open if the current destination lives there, so arriving at a system page by deep link or by
  // an in-app jump never leaves the operator looking at a collapsed region with no active item.
  const [systemOpen, setSystemOpen] = useState<boolean>(() => SECONDARY_KEYS.has("home"));
  const me = useApi<MeResponse>("/api/me");

  /*
   * The back button, and anyone arriving on a link. Without this, pressing back changed the URL and
   * left the page where it was — which is worse than no routing, because the address then lies
   * about what is on screen.
   */
  useEffect(() => {
    const onHash = () => {
      const key = keyFromHash((k) => ALL_NAV_KEYS.has(k));
      setActive(key);
      if (SECONDARY_KEYS.has(key)) setSystemOpen(true);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // Distinguishes "signed out deliberately" from "never signed in". Without it the two states
  // render the same screen and the operator cannot tell whether sign-out worked.
  const [signedOut, setSignedOut] = useState(false);
  /* Which company the deal record is showing used to be held here, because the pipeline and the
     record were two components on one page. They are one component now and it owns the choice. */

  /**
   * Which nav groups are collapsed, remembered across sessions.
   *
   * Stores what is CLOSED rather than what is open, so a group added later appears expanded by
   * default — a new destination that arrives already hidden is one nobody discovers.
   */
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem("wp-nav-closed");
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });

  function toggleGroup(name: string) {
    setClosedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      try {
        window.localStorage.setItem("wp-nav-closed", JSON.stringify([...next]));
      } catch {
        // Storage unavailable; the rail still works, it just forgets between sessions.
      }
      return next;
    });
  }

  function handleSignOut() {
    const redirect = signOut();
    if (redirect) {
      // Production: Cloudflare Access owns the session, so only its logout endpoint can end it.
      window.location.href = redirect;
      return;
    }
    setSignedOut(true);
    me.reload();
  }
  const activeItem = NAV_ITEMS.find((n) => n.key === active) ?? NAV_FALLBACK;

  const refresh = useCallback(() => setRefreshNonce((n) => n + 1), []);
  const authed = me.status === 200 && me.data;

  /*
   * VISITING A PAGE IS LOOKING AT IT. Home's "Who has something for you" counts what is new since
   * the partner last looked at each module, and the mark is left by pressing Open OR by reaching
   * the module's page any other way — the nav, a bookmark, a link from an approval. Home itself is
   * not a module. Fire-and-forget: a mark that fails to land costs one stale row, never the page.
   */
  useEffect(() => {
    if (!authed || active === "home") return;
    void api("/api/mp-home/visited", { method: "POST", body: { route: active } });
  }, [authed, active]);

  // On the phone sheet, choosing a destination is the whole interaction — close behind it.
  const navigate = useCallback((rawKey: string) => {
    // A merged or legacy key resolves here too, not only when typed into the URL.
    const key = MERGED_ROUTES[rawKey] ?? rawKey;
    setActive(key);
    setNavOpen(false);
    // The URL follows the page, so it can be bookmarked, sent to your partner, and survive a
    // refresh. `replace: false` on purpose — the back button should walk back through where you
    // have actually been.
    if (typeof window !== "undefined" && keyFromHash((k) => ALL_NAV_KEYS.has(k)) !== key) {
      window.location.hash = `#/${key}`;
    }
    // Reveal the secondary tier when something inside it becomes current. Never auto-COLLAPSE:
    // closing the region under an operator who just opened it is the annoying half of this.
    if (SECONDARY_KEYS.has(key)) setSystemOpen(true);
  }, []);

  return (
    <div className="shell">
      <a className="skip-link" href="#wp-surface">
        Skip to content
      </a>
      <div className="shell-topbar">
        <img className="rail-mark" src="/wp-mark.svg" alt="" width={30} height={30} />
        <span className="topbar-wordmark">West Peek OS</span>
        <button
          type="button"
          className="nav-toggle"
          data-testid="nav-toggle"
          aria-expanded={navOpen}
          aria-controls="wp-nav"
          onClick={() => setNavOpen((open) => !open)}
        >
          Menu
        </button>
      </div>
      <div className="shell-body">
        <nav className="shell-nav" id="wp-nav" aria-label="Primary" data-open={navOpen ? "true" : "false"}>
          <div className="rail-brand">
            <img className="rail-mark" src="/wp-mark.svg" alt="" width={30} height={30} />
            <span>
              <h1 className="rail-wordmark">West Peek OS</h1>
              <span className="rail-context">West Peek Ventures</span>
            </span>
            <button type="button" className="nav-close" data-testid="nav-close" onClick={() => setNavOpen(false)}>
              Close
            </button>
          </div>
          <div className="rail-scroll">
            {NAV_GROUPS.map((group) => {
              const isSecondary = "secondary" in group && group.secondary === true;
              if (!isSecondary) {
                const pinned = "pinned" in group && group.pinned === true;
                const footer = "footer" in group && group.footer === true;
                return (
                  <div
                    key={group.group || (pinned ? "__pinned" : "__footer")}
                    className={pinned ? "rail-pinned" : footer ? "rail-footer" : undefined}
                  >
                    {/* A group header is a LABEL, never a target. Rendered as a non-interactive
                        <p> with no hover and no pointer, so the eye can tell a heading from a
                        destination without trying one to find out. Pinned and footer tiers carry
                        no header at all — three items need no category name. */}
                    {/* The header is now a disclosure rather than a dead label. It is still
                        visually quieter than the destinations under it — a signpost should not
                        compete with the things it points at — but it is operable, because a rail
                        with forty items needs to be foldable down to the part you are working in. */}
                    {group.group ? (
                      <button
                        type="button"
                        className="rail-group rail-group-toggle"
                        data-testid={`nav-group-${group.group.toLowerCase()}`}
                        aria-expanded={!closedGroups.has(group.group)}
                        onClick={() => toggleGroup(group.group)}
                      >
                        <span>{group.group}</span>
                        <span className="rail-group-mark" aria-hidden="true">
                          {closedGroups.has(group.group) ? "+" : "−"}
                        </span>
                      </button>
                    ) : null}
                    {/* WHAT THIS SECTION IS FOR, in the operator's own terms. The reasoning behind
                        each grouping lived only in a source comment, so the rail asked somebody to
                        infer from five destination names what "Firm" means. Shown only while the
                        group is open: a collapsed group is somebody saying they know what is in
                        there. */}
                    {group.group && "blurb" in group && group.blurb && !closedGroups.has(group.group) ? (
                      <p className="rail-group-blurb">{group.blurb}</p>
                    ) : null}
                    <ul
                      aria-label={group.group || (pinned ? "Primary" : "Secondary")}
                      hidden={Boolean(group.group) && closedGroups.has(group.group)}
                    >
                      {group.items.map((item) => (
                        <li key={item.key}>
                          <button
                            type="button"
                            className={item.key === active ? "nav-link nav-link-active" : "nav-link"}
                            aria-current={item.key === active ? "page" : undefined}
                            onClick={() => navigate(item.key)}
                          >
                            {"icon" in item && item.icon ? <NavIcon name={item.icon} /> : null}
                            {item.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              }
              // The secondary tier. `hidden` (not display:none in CSS) so that assistive tech and
              // Playwright agree with what a sighted operator sees — a collapsed region is really
              // collapsed, not merely painted out of view.
              return (
                <div key={group.group} className="rail-secondary">
                  <button
                    type="button"
                    className="rail-disclosure"
                    data-testid="nav-system-toggle"
                    aria-expanded={systemOpen}
                    aria-controls="wp-nav-system"
                    onClick={() => setSystemOpen((open) => !open)}
                  >
                    <span>{group.group}</span>
                    <span className="rail-disclosure-mark" aria-hidden="true">
                      {systemOpen ? "−" : "+"}
                    </span>
                  </button>
                  <div id="wp-nav-system" hidden={!systemOpen}>
                    <p className="rail-secondary-note">
                      Administration and diagnostics. You do not need these for everyday work.
                    </p>
                    <ul>
                      {group.items.map((item) => (
                        <li key={item.key}>
                          <button
                            type="button"
                            className={item.key === active ? "nav-link nav-link-active" : "nav-link"}
                            aria-current={item.key === active ? "page" : undefined}
                            onClick={() => navigate(item.key)}
                          >
                            {item.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="rail-foot">
            {authed ? (
              <>
                <strong>{me.data!.fullName}</strong>
                <br />
                {me.data!.roles.join(", ") || "no roles"}
              </>
            ) : (
              "Not signed in"
            )}
          </p>
        </nav>
        <main className="shell-main">
          <header className="shell-header">
            <p className="surface-eyebrow">{activeItem.group}</p>
            {/*
              h2, not h3, and this one character is the spine of the whole layout pass.
              The rail wordmark is the h1. This title used to be an h3, which skipped h2 outright
              and — worse — put the page's own name at the SAME rank as a section inside it. That is
              why ranks drifted everywhere below: with the title at h3, some pages made their
              sections h4, some h5, some h3 again, and none of them was wrong relative to the others.
              With the title at h2, one rule falls out and every page can follow it: a section is an
              h3, and a thing inside a section is an h4. LpPage already did exactly that, which is
              why it is the page the operator says reads well.
            */}
            <h2>{activeItem.label}</h2>
            <div className="surface-identity">
              <IdentityPanel me={me.data} status={me.status} loading={me.loading} onSignOut={handleSignOut} />
              {authed && <StatusBar onNavigate={navigate} refreshNonce={refreshNonce} />}
            </div>
          </header>
          <div className="surface-body" id="wp-surface">
          {/* A page that throws takes only itself (SurfaceBoundary.tsx). Keyed on the route AND
              the identity, so the fault clears when she moves on — and when the session ends, so
              the signed-out page is never held behind a page's fault. */}
          <SurfaceBoundary key={`${active}:${authed ? me.data!.id : "out"}`} label={activeItem.label}>
          {/* Plain-English orientation, rendered once for every route (P40). Only when signed in:
              an anonymous visitor sees the login prompt, and explaining a page they cannot open
              would be noise. */}
          {authed && <PagePurposeBlock navKey={active} label={activeItem.label} onNavigate={navigate} />}
          {/* WHO RUNS THIS PAGE, directly under what the page is for — the operator asked for the
              host's picture, name and title to be among the first things you see. Renders nothing on
              Admin and on the personal surfaces: `pageHost` returns null there, because Admin is
              machinery rather than a room somebody runs and Home is already signed by its deliverer. */}
          {authed && <PageHostCard navKey={active} />}
          {!authed && !me.loading && active !== "help" && (
            signedOut ? (
              <SignedOutPage onSignIn={() => setSignedOut(false)} />
            ) : (
              <SignInCard onLogin={() => { setSignedOut(false); me.reload(); }} />
            )
          )}
          {/* Help is reachable signed-out too: an operator who cannot get in still deserves to
              learn what this is and how to get started. */}
          {active === "help" && <HelpCenterPage groups={HELP_GROUPS} onNavigate={authed ? navigate : undefined} />}
          {authed && active === "home" && <HomePage me={me.data!} onNavigate={navigate} />}
          {authed && active === "setup" && <SetupPage me={me.data!} />}
          {authed && active === "sources-and-sweeps" && <IntelligencePage me={me.data!} />}
          {authed && active === "employees" && <EmployeesPage me={me.data!} />}
          {authed && active === "rooms" && <RoomsPage />}
          {authed && active === "introductions" && <IntroductionsPage />}
          {authed && active === "community" && <CommunityPage />}
          {authed && active === "record" && <LedgersPage />}
          {/* Follow-on merged into Fund strategy. The route stays live. */}
          {authed && active === "follow-on" && <FundStrategyPage onNavigate={navigate} />}
          {authed && active === "weekly-review" && <WeeklyReviewPage onNavigate={navigate} />}
          {authed && active === "cross-office" && <CrossOfficePage />}
          {authed && active === "secondaries" && <SecondariesPage onNavigate={navigate} />}
          {authed && active === "university" && <UniversityPage />}
          {authed && active === "market-map" && <MarketMapPage />}
          {authed && active === "browser-tasks" && <BrowserTasksPage me={me.data!} />}
          {authed && active === "machines" && <MachinesPage me={me.data!} />}
          {authed && active === "notifications" && <NotificationsPage me={me.data!} />}
          {/* ITEM 1: Today folded into Home.
              It showed open work, pending approvals and recent activity — all three of which Home
              already carries as modules (`my_work`, `approvals`, `what_changed`), and the first two
              of which are now tabs sitting directly above where Today used to be. The review found
              it also promised a date, meetings and deadlines it never showed, so it read as a page
              that had stopped working rather than one that was a smaller copy of Home.
              The route still resolves, so a bookmark lands on the page that holds it. */}
          {authed && active === "today" && <HomePage me={me.data!} onNavigate={navigate} />}
          {authed && active === "capture" && <CapturePage me={me.data!} onChanged={refresh} onNavigate={navigate} />}
          {authed && active === "intent" && <IntentPage me={me.data!} onNavigate={navigate} />}
          {authed && active === "private" && <PrivateLayerPage />}
          {/*
            THE MACHINERY IS HANDED IN, NOT STACKED UNDERNEATH.

            It used to render below the whole board behind a "Runs on a clock" heading, which put
            twelve scheduled jobs in the same scroll as the one card that had stopped — machinery
            competing with what is happening now, which is the third of the four things the 18 Sep
            redesign was asked to separate. `WorkCardsPage` now owns the three addresses and renders
            this only on the one it belongs to; the shell still owns what the machinery IS.
          */}
          {authed && active === "work" && (
            <WorkSurface
              me={me.data!}
              onChanged={refresh}
              onNavigate={navigate}
              machinery={<JobsPage me={me.data!} />}
            />
          )}
          {authed && active === "approvals" && <ApprovalsPage me={me.data!} refreshNonce={refreshNonce} />}
          {authed && active === "companies" && (
            <>
              <CompanyRegister me={me.data!} onNavigate={navigate} />
              {/* Identity work — aliases, merges, external ids — belongs to one company rather
                  than to the register, and is where duplicates get resolved. */}
              <details className="card" data-testid="company-identity">
                <summary>Identity: aliases, merges and duplicates</summary>
                <CompaniesPage me={me.data!} />
              </details>
            </>
          )}
          {authed && active === "research" && <ResearchPage me={me.data!} onNavigate={navigate} />}
          {authed && active === "thesis" && <ThesisPage me={me.data!} />}
          {/* The old Deal Math address, kept working. `MERGED_ROUTES` normally resolves it to
              fund-strategy before it gets here; this stays so a direct jump cannot land nowhere. */}
          {authed && active === "deal-math" && <FundStrategyPage onNavigate={navigate} />}
          {/*
            THE PIPELINE AND THE DEAL RECORD ARE ONE PAGE AND ONE COMPONENT.

            They used to be two: this file rendered the pipeline, then a second section headed
            "Deal records and tooling" holding a separate page whose first control was ANOTHER
            company picker. So picking a company on the pipeline did not open its record — it
            scrolled you to a dropdown where you picked the same company again. Operator: "you need
            to fix it once we pick a company and all the stuff comes out."

            The record now lives inside DealflowPage, opens from the row you pressed, and is the
            only thing on this route. `InvestmentPage` and the three panels it alone used are
            superseded by it and remain in this file for whoever owns App.tsx to remove.
          */}
          {authed && active === "dealflow" && <DealflowPage me={me.data!} onNavigate={navigate} />}
          {/* ONE SURFACE, five sections, in the order a partner asks in (ADR-019). What used to be
              mounted underneath this — a second meetings list with the notes, consent, transcript
              and close-out machinery — is now section two of the page itself, under a heading that
              says what it is for. */}
          {authed && active === "meetings" && <MeetingsSurface me={me.data!} onNavigate={navigate} />}
          {/* ITEM 12: Portfolio is its own file and its own two sub-tabs — how the companies are
              doing, and what they have reported. The fund-allocation ring and the composition bars
              that used to sit above it are the PLAN, and they already have a home on Fund strategy;
              composition also counts closed opportunities while the holdings list counts booked
              positions, so the two could print different portfolios on one screen. */}
          {authed && active === "portfolio" && <PortfolioPage me={me.data!} />}
          {authed && active === "fund-strategy" && <FundStrategyPage onNavigate={navigate} />}
          {authed && active === "network" && <NetworkPage me={me.data!} />}
          {authed && active === "integrations" && <IntegrationsPage me={me.data!} />}
          {authed && active === "lp" && <LpPage me={me.data!} />}
          {/* The old address still works and lands in the same place. */}
          {authed && active === "allocation" && <FundStrategyPage onNavigate={navigate} />}
          {/* Reporting folded into LP (item 16): an LP is somebody who gave the fund money and
              whom the fund owes an account of it, and two tabs for one relationship meant
              answering "what has Cedar been told?" required knowing packets lived elsewhere.
              The route still resolves so an old link lands on the page that now holds it. */}
          {authed && active === "reporting" && <LpPage me={me.data!} />}
          {authed && active === "documents" && <DocumentsPage onNavigate={navigate} />}
          {authed && active === "contradictions" && <ContradictionsPage />}
          {authed && active === "activity" && <ActivityPage me={me.data!} refreshNonce={refreshNonce} />}
          {authed && active === "governance" && <GovernancePage me={me.data!} />}
          {authed && active === "ai-controls" && <AiPage me={me.data!} />}
          {authed && active === "cockpit" && <AiOpsPage me={me.data!} />}
          {authed && active === "diagnostics" && <DiagnosticsPage onNavigate={navigate} />}
          </SurfaceBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
