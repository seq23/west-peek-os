import { useCallback, useEffect, useState } from "react";
import { readableDate, shortDate } from "./lib/dates";
import { api, getDevUser, mutationError, onNotificationsChanged, signOut, useApi, type MeResponse } from "./lib/api";
import { RecordInvestment } from "./pages/RecordInvestment";
import { DeckPanel } from "./pages/DeckPanel";
import { FundConstruction } from "./pages/FundConstruction";
import { LpPage } from "./pages/LpPage";
import { PortfolioPage } from "./pages/PortfolioPage";
import { PageHostCard } from "./pages/PageHostCard";
import { HomePage } from "./pages/HomePage";
import { IntelligencePage } from "./pages/IntelligencePage";
import { EmployeesPage } from "./pages/EmployeesPage";
import { EventsPage } from "./pages/EventsPage";
import { RoomsPage } from "./pages/RoomsPage";
import { IntroductionsPage } from "./pages/IntroductionsPage";
import { DealProvenance } from "./pages/DealProvenance";
import { CommunityPage } from "./pages/CommunityPage";
import { IcPortalPage } from "./pages/IcPortalPage";
import { LedgersPage } from "./pages/LedgersPage";
import { FollowOnPage } from "./pages/FollowOnPage";
import { WeeklyReviewPage } from "./pages/WeeklyReviewPage";
import { CrossOfficePage } from "./pages/CrossOfficePage";
import { SecondariesPage } from "./pages/SecondariesPage";
import { PagePurposeBlock } from "./pages/PagePurposeBlock";
import { actionName, actorName } from "@shared/help/actionNames";
import { stateMeaning } from "@shared/work/workCards";
import { SignInCard, SignedOutPage } from "./pages/AuthSurfaces";
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
import { CockpitPage } from "./pages/CockpitPage";
import { DutyRosterPanel } from "./pages/DutyRosterPanel";
import { ThesisPage } from "./pages/ThesisPage";
import { ModelingPage } from "./pages/ModelingPage";
import { DealflowPage } from "./pages/DealflowPage";
import { MeetingsPage as MeetingsSurface } from "./pages/MeetingsPage";
import { CompaniesPage as CompanyRegister } from "./pages/CompaniesPage";
import { FundAllocation, Composition } from "./pages/FundAllocation";
import { BrowserTasksPage } from "./pages/BrowserTasksPage";
import { WorkCardsPage as WorkSurface } from "./pages/WorkCardsPage";
import { GOVERNANCE_UPDATE_TYPES, RECOMMENDED_GOVERNANCE, governanceType } from "@shared/governance/updateTypes";
import { useSelectedFund } from "./lib/selectedFund";
import { HelpCenterPage } from "./pages/HelpCenterPage";
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
      { key: "weekly-review", label: "Weekly review" },
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
        Signed in as <strong>{me.fullName}</strong> ({me.email}) — {me.roles.join(", ") || "no roles"}
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
            setMessage(status === 201 ? "Issued. It is in the list below and every employee reads it." : `Failed: ${data?.error ?? status}`);
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
  privacy_label: string;
  created_at: string;
}

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

function DocumentsPage() {
  const documents = useApi<{ documents: DocumentRow[] }>("/api/documents");
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
    document.querySelector(`[data-testid="document-${focus}"]`)?.scrollIntoView({ block: "center" });
  }, [focus, documents.data]);
  const focused = focus ? (documents.data?.documents ?? []).find((d) => d.id === focus) ?? null : null;
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState("diligence_note");
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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

  return (
    <section data-testid="documents-page">
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
          const buffer = await file.arrayBuffer();
          let binary = "";
          new Uint8Array(buffer).forEach((b) => (binary += String.fromCharCode(b)));
          const { status, data } = await api<{ id: string; version?: { sha256: string }; error?: string; detail?: string }>("/api/documents", {
            method: "POST",
            body: { title: title || file.name, doc_type: docType, content_base64: window.btoa(binary), content_type: file.type || "application/octet-stream" },
          });
          setMessage(
            status === 201 ? `Uploaded ${data!.id} (sha256 ${data!.version?.sha256.slice(0, 12)}…).` : `Upload failed: ${data?.detail ?? data?.error ?? status}`,
          );
          if (status === 201) {
            setTitle("");
            setFile(null);
            documents.reload();
          }
        }}
      >
        <div className="form-row">
          <label>
            Title <input data-testid="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            Type <input data-testid="doc-type" value={docType} onChange={(e) => setDocType(e.target.value)} />
          </label>
          <input data-testid="doc-file" aria-label="Choose a file to upload" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <button type="submit" className="btn-strong" data-testid="doc-submit">
          Upload
        </button>
        {message && <p className="notice" data-testid="doc-message">{message}</p>}
      </form>
      {focused && (
        <div className="card" data-testid="document-viewer">
          <div className="home-section-head">
            <h3>{focused.title}</h3>
            <button type="button" className="link-button" onClick={() => setFocus(null)}>close</button>
          </div>
          <iframe
            title={focused.title}
            src={`/api/documents/${focused.id}/download`}
            style={{ width: "100%", height: "70vh", border: "1px solid var(--line, #ddd)", background: "#fff" }}
          />
        </div>
      )}
      <ul data-testid="document-list" className="card-list">
        {(documents.data?.documents ?? []).map((d) => (
          <li key={d.id} className={d.id === focus ? "card card-focus" : "card"} data-testid={`document-${d.id}`}>
            <strong>{d.title}</strong> — {d.doc_type} · {d.privacy_label}{" "}
            <button type="button" data-testid={`download-${d.id}`} onClick={() => download(d.id, d.title)}>
              Download
            </button>{" "}
            {/* OFF THE SHELF, NOT DESTROYED. There was no removal of any kind before this — five
                document routes and none of them removed anything — so six of the eight documents
                here were machine noise nobody could clear. A reason is required because six months
                from now the reason is the only part that still helps. */}
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
                setMessage(failed ?? `Archived. It is kept, with your reason attached.`);
                documents.reload();
              }}
            >
              Archive
            </button>
          </li>
        ))}
        {(documents.data?.documents ?? []).length === 0 && <li className="state-empty">Nothing on the shelf. Morning briefs are not filed here on purpose — they live on Home and are superseded each day.</li>}
      </ul>
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

interface OpportunityRow {
  id: string;
  company_id: string;
  opportunity_type: string;
  title: string;
  status: string;
  seller_name: string | null;
  broker_name: string | null;
  price_per_share: number | null;
  quantity: number | null;
  /** JSON array of fields whose value is a stand-in rather than a fact (migration 0052). */
  placeholder_fields?: string;
  placeholder_note?: string | null;
  backfilled_at?: string | null;
}

interface DealMathPacketRow {
  id: string;
  opportunity_id: string;
  deal_type: string;
  entry_mode: string;
  math_quality_status: string;
  missing_inputs_json: string;
  valuation: number | null;
  ownership_at_close: number | null;
  moic: number | null;
  tvpi: number | null;
  ic_ready: number;
}

interface IcPacketRow {
  id: string;
  opportunity_id: string;
  status: string;
  drafted_by_type: string;
  deal_math_packet_id: string | null;
  unresolved_material_contradictions_current?: ContradictionRow[];
  decisions?: Array<{ id: string; decision: string; decided_by: string; rationale: string | null }>;
  dissents?: Array<{ id: string; dissenter_id: string; dissent_text: string }>;
}

interface Company360 {
  company: CompanyRow;
  opportunities: OpportunityRow[];
  transactions: Array<{ id: string; transaction_type: string; status: string; quantity: number; net_amount: number }>;
  positions: Array<{ id: string; security_class_id: string; quantity: number; cost_basis: number; status: string }>;
  pricing_observations: Array<{ id: string; observation_type: string; price_per_share: number | null; observed_at: string }>;
  security_classes: Array<{ id: string; class_name: string }>;
  ic_packets: IcPacketRow[];
}

/** Company 360: every investment view resolves through the ONE canonical identity (D3). */
function Company360Panel({ companyId }: { companyId: string }) {
  const view = useApi<Company360>(`/api/companies/${companyId}/360`, [companyId]);
  if (!view.data) return <p data-testid="company-360-loading">Loading 360…</p>;
  const v = view.data;
  return (
    <div className="card" data-testid="company-360">
      <h4>{v.company.canonical_name} — 360</h4>
      <p data-testid="company-360-counts">
        opportunities: {v.opportunities.length} · transactions: {v.transactions.length} · positions: {v.positions.length} · share classes:{" "}
        {v.security_classes.length} · pricing observations: {v.pricing_observations.length} · IC packets: {v.ic_packets.length}
      </p>
      <ul data-testid="company-360-positions">
        {v.positions.map((p) => (
          <li key={p.id} data-testid={`position-${p.id}`}>
            {p.quantity} shares · cost {p.cost_basis}{" "}
            <span className={p.status === "OPEN" ? "help-tag help-tag-good" : "help-tag help-tag-muted"}>
              {p.status === "OPEN" ? "still held" : "closed out"}
            </span>
          </li>
        ))}
        {v.positions.length === 0 && <li className="state-empty" data-testid="no-positions">No positions. A position row appears when a transaction is executed against an approved receipt.</li>}
      </ul>
    </div>
  );
}

function IcPacketPanel({ packetId, onChanged }: { packetId: string; onChanged: () => void }) {
  const packet = useApi<IcPacketRow>(`/api/ic/packets/${packetId}`, [packetId]);
  const [message, setMessage] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const [receiptId, setReceiptId] = useState("");
  if (!packet.data) return <p>Loading IC packet…</p>;
  const p = packet.data;
  const unresolved = p.unresolved_material_contradictions_current ?? [];
  return (
    <div className="card" data-testid={`ic-packet-${p.id}`}>
      <p>
        IC packet{" "}
        <span className="help-tag" data-testid="ic-packet-status">{p.status.split("_").join(" ").toLowerCase()}</span>{" "}
        · drafted by {p.drafted_by_type.split("_").join(" ").toLowerCase()}
      </p>
      {/* Never filtered: an unresolved material contradiction always reaches the decision. */}
      <p data-testid="ic-unresolved-contradictions">
        Unresolved material contradictions: {unresolved.length}
        {unresolved.map((c) => (
          <span key={c.id} data-testid={`ic-contradiction-${c.id}`}>
            {" "}
            · {c.materiality} {c.topic}
          </span>
        ))}
      </p>
      <div className="form-row">
        <button
          type="button"
          data-testid="ic-submit"
          onClick={async () => {
            const { status, data } = await api<{ approval_card_id: string; error?: string }>(`/api/ic/packets/${p.id}/submit`, { method: "POST", body: {} });
            setMessage(status === 200 ? `Submitted — approval card ${data!.approval_card_id} awaits an MP.` : `Submit refused: ${data?.error ?? status}`);
            packet.reload();
            onChanged();
          }}
        >
          Submit for IC decision
        </button>
      </div>
      <form
        className="form-row"
        data-testid="ic-decide-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const { status, data } = await api<{ decision: string; error?: string; detail?: string }>(`/api/ic/packets/${p.id}/decide`, {
            method: "POST",
            body: { decision: "APPROVE", rationale, receipt_id: receiptId || undefined },
          });
          setMessage(status === 201 ? `IC decision recorded: ${data!.decision}.` : `Decision refused: ${data?.error ?? status}`);
          packet.reload();
          onChanged();
        }}
      >
        <label>
          Rationale <input data-testid="ic-rationale" value={rationale} onChange={(e) => setRationale(e.target.value)} />
        </label>
        <label>
          Approval receipt id <input data-testid="ic-receipt" value={receiptId} onChange={(e) => setReceiptId(e.target.value)} />
        </label>
        <button type="submit" className="btn-strong" data-testid="ic-approve">
          Record APPROVE
        </button>
      </form>
      {(p.decisions ?? []).length > 0 && (
        <ul data-testid="ic-decisions">
          {(p.decisions ?? []).map((d) => (
            <li key={d.id} data-testid={`ic-decision-${d.id}`}>
              <strong>{d.decision.split("_").join(" ").toLowerCase()}</strong> by {d.decided_by} —{" "}
              {d.rationale ?? "no reason recorded"}
            </li>
          ))}
        </ul>
      )}
      {message && <p className="notice" data-testid="ic-message">{message}</p>}
    </div>
  );
}

/**
 * Values that are stand-ins, and the form that replaces them.
 *
 * A placeholder is only safe while it is loud. The whole reason stand-in economics are allowed at
 * all — the operator wanted editable numbers rather than empty fields on a deal whose paperwork is
 * not to hand — is that every surface showing one has to say so. An unmarked stand-in gets charted
 * and eventually reported to an LP, and by then nobody can tell which figures were ever true.
 *
 * So this renders nothing at all when a record is solid, and is impossible to miss when it is not.
 * It posts to the placeholder door rather than the ordinary update route, which is what lets it
 * work on a CLOSED holding: correcting a stand-in is not editing a decision.
 */
function PlaceholderPanel({
  opportunity,
  onConfirmed,
}: {
  opportunity: OpportunityRow;
  onConfirmed: () => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  let provisional: string[] = [];
  try {
    provisional = JSON.parse(opportunity.placeholder_fields ?? "[]") as string[];
  } catch {
    provisional = [];
  }
  if (provisional.length === 0) return null;

  const label: Record<string, string> = {
    price_per_share: "Price per share",
    quantity: "Shares",
    fees: "Fees",
    carry: "Carry",
    discount_premium: "Discount / premium",
    seller_name: "Seller",
    broker_name: "Broker",
  };

  return (
    <div className="notice" data-testid={`placeholder-panel-${opportunity.id}`}>
      <strong>Needs editing.</strong>{" "}
      {provisional.length} value{provisional.length === 1 ? " is a placeholder" : "s are placeholders"}:{" "}
      {provisional.map((f) => label[f] ?? f).join(", ")}.
      {opportunity.placeholder_note && <div className="muted small">{opportunity.placeholder_note}</div>}
      <button
        type="button"
        className="link-button"
        data-testid={`placeholder-edit-${opportunity.id}`}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "Cancel" : "Enter the real numbers"}
      </button>
      {message && <div className="small" data-testid={`placeholder-message-${opportunity.id}`}>{message}</div>}
      {open && (
        <form
          className="form-row"
          data-testid={`placeholder-form-${opportunity.id}`}
          onSubmit={async (e) => {
            e.preventDefault();
            // Only send what was actually filled in. Confirming one field and leaving another
            // provisional is a normal outcome of a meeting, not an error.
            const payload: Record<string, number | string> = {};
            for (const f of provisional) {
              const raw = (values[f] ?? "").trim();
              if (!raw) continue;
              payload[f] = f.endsWith("_name") ? raw : Number(raw);
            }
            if (Object.keys(payload).length === 0) {
              setMessage("Nothing entered yet.");
              return;
            }
            const res = await api<{ placeholder_fields?: string; error?: string; detail?: string }>(
              `/api/opportunities/${opportunity.id}/placeholders`,
              { method: "POST", body: { values: payload } },
            );
            if (res.status !== 200) {
              setMessage(`Not saved: ${res.data?.detail ?? res.data?.error ?? res.status}`);
              return;
            }
            const left = JSON.parse(res.data?.placeholder_fields ?? "[]") as string[];
            setMessage(
              left.length === 0
                ? "Recorded. Nothing on this deal is a placeholder any more."
                : `Recorded. Still to confirm: ${left.map((f) => label[f] ?? f).join(", ")}.`,
            );
            setOpen(false);
            onConfirmed();
          }}
        >
          {provisional.map((f) => (
            <label key={f}>
              {label[f] ?? f}{" "}
              <input
                data-testid={`placeholder-input-${f}-${opportunity.id}`}
                value={values[f] ?? ""}
                onChange={(ev) => setValues((v) => ({ ...v, [f]: ev.target.value }))}
              />
            </label>
          ))}
          <button type="submit" className="btn-strong" data-testid={`placeholder-save-${opportunity.id}`}>
            Save
          </button>
        </form>
      )}
    </div>
  );
}

function InvestmentPage({ me, initialCompanyId }: { me: MeResponse; initialCompanyId?: string }) {
  const companies = useApi<{ companies: CompanyRow[] }>("/api/companies");
  const [companyId, setCompanyId] = useState(initialCompanyId ?? "");
  // Follows the pipeline when a row above asks for this company. Guarded on a value, so opening the
  // page normally does not clear a choice the reader just made.
  useEffect(() => {
    if (initialCompanyId) setCompanyId(initialCompanyId);
  }, [initialCompanyId]);


  const opportunities = useApi<{ opportunities: OpportunityRow[] }>(companyId ? `/api/opportunities?company_id=${companyId}` : null, [companyId]);
  const [title, setTitle] = useState("");
  const [dealType, setDealType] = useState("EARLY_STAGE_PRIMARY");
  // Provenance is captured HERE rather than on a later screen. "Where did we meet them" is
  // recoverable from memory for about a week; make it a separate errand and it never gets recorded.
  const [origin, setOrigin] = useState("UNRECORDED");
  const [relStartedAt, setRelStartedAt] = useState("");
  const [selected, setSelected] = useState<OpportunityRow | null>(null);

  /*
   * THE RECORD OPENS WITH THE COMPANY. Operator: "there should be 1 deal record for every company
   * with all fields in it... and it should open once u select a company."
   *
   * A company almost always has exactly one live deal, so the click between picking the company and
   * seeing its record bought nothing and hid the fields somebody came here to fill in. Where there
   * genuinely are several — a follow-on beside a secondary — the list still stands and nothing is
   * chosen for the reader, because then it is a real question.
   */
  const opportunityRows = opportunities.data?.opportunities ?? [];
  useEffect(() => {
    if (!companyId) {
      setSelected(null);
      return;
    }
    if (opportunityRows.length === 1) setSelected(opportunityRows[0]!);
  }, [companyId, opportunityRows.length]);
  const [packet, setPacket] = useState<DealMathPacketRow | null>(null);
  /*
   * THE DEAL'S OWN NUMBERS, TYPED. This panel used to submit a hardcoded $1M cheque into a $20M
   * pre-money with a $500M exit — for whatever company happened to be selected — and then display
   * valuation, ownership and MOIC computed from them. A partner had no way to know the arithmetic
   * had nothing to do with the company on screen, and the firm's own stated cheque is $500-750K,
   * not $1M. Empty by default: an unanswered field is visibly unanswered, where a prefilled one is
   * a number nobody chose that looks like one somebody did.
   */
  const [math, setMath] = useState({
    check_size: "",
    round_size: "",
    pre_money: "",
    exit_value: "",
    future_dilution_pct: "",
    hold_years: "",
    fund_size: "",
  });
  const [icPacketId, setIcPacketId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  void me;

  return (
    <section data-testid="investment-page">
      {/*
        RESTRUCTURED, 21 Aug 2026. Operator: "this page needs dividers between the sections, its
        just all feeling so jumbled — and the opportunities is weird just sitting there empty until
        a deal is chosen from the drop down."

        WHAT WAS WRONG WITH THE ORDER. The page led with a form for CREATING a deal, whose first
        field happened to be the company picker — so the control that gates the entire rest of the
        page was buried inside the one action you least often want. Everything below it then sat
        empty, headed "Opportunities", with no indication that it was waiting on you rather than
        broken.

        The first step is picking a company, so that is now the first thing, said as a step. Nothing
        below renders until one is chosen, and what does render is grouped under headings with rules
        between them — the sections were always distinct and the page never showed it.

        Creating a deal moved to a disclosure beneath the company's existing deals, where it belongs:
        Dealflow's own "Add a company" is the primary door, and this is the rarer case of adding a
        second deal to a company already on the board.
      */}
      <div className="deal-record-step" data-testid="deal-record-pick">
        <label>
          <strong>Which company?</strong>{" "}
          <select data-testid="deal-record-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">— pick one —</option>
            {(companies.data?.companies ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.canonical_name}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">
          Its deal math, its IC packet, what the fund owns of it — and where the real numbers go.
        </span>
      </div>

      {!companyId && (
        <p className="state-empty" data-testid="no-company-picked">
          Nothing is shown until you pick one. This is the page where a deal's actual numbers are
          entered — the placeholder figures on the pipeline above are replaced here.
        </p>
      )}

      {companyId && (
        <>
      <details className="card deal-record-new" data-testid="opportunity-create-details">
        <summary>Add another deal for this company</summary>
        <p className="muted small">
          Only for a second deal in a company already on the board — a follow-on, or a secondary.
          A company new to the firm goes in through “Add a company” at the top of this page.
        </p>
      <form
        className="form-row"
        data-testid="opportunity-create-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const { status, data } = await api<OpportunityRow & { error?: string }>("/api/opportunities", {
            method: "POST",
            body: {
              company_id: companyId,
              opportunity_type: dealType,
              title,
              relationship_origin: origin,
              ...(relStartedAt ? { relationship_started_at: relStartedAt } : {}),
            },
          });
          setMessage(status === 201 ? `Opportunity ${data!.id} created (${data!.status}).` : `Create refused: ${data?.error ?? status}`);
          if (status === 201) {
            setTitle("");
            setRelStartedAt("");
            opportunities.reload();
          }
        }}
      >
        <label>
          Type{" "}
          <select data-testid="opportunity-type" value={dealType} onChange={(e) => setDealType(e.target.value)}>
            {["EARLY_STAGE_PRIMARY", "FOLLOW_ON", "SECONDARY_PURCHASE", "SECONDARY_SALE", "OTHER"].map((tt) => (
              <option key={tt} value={tt}>
                {tt}
              </option>
            ))}
          </select>
        </label>
        <label>
          Title <input data-testid="opportunity-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Met them via{" "}
          <select data-testid="opportunity-origin" value={origin} onChange={(e) => setOrigin(e.target.value)}>
            {/* UNRECORDED stays selectable and is the default: forcing a choice would get a wrong
                one, and a wrong origin is worse than a visible gap. */}
            <option value="UNRECORDED">— not recorded —</option>
            {["ROOM", "MASTERMIND", "OFFICE", "COUNCIL", "COMMUNITY_INTRO", "PORTFOLIO_REFERRAL",
              "LP_REFERRAL", "INBOUND", "OUTBOUND", "NETWORK", "OTHER"].map((o) => (
              <option key={o} value={o}>{o.charAt(0) + o.slice(1).toLowerCase().replace(/_/g, " ")}</option>
            ))}
          </select>
        </label>
        <label>
          Known since{" "}
          <input
            type="date"
            data-testid="opportunity-known-since"
            value={relStartedAt}
            onChange={(e) => setRelStartedAt(e.target.value)}
          />
        </label>
        <button type="submit" className="btn-strong" data-testid="opportunity-create-submit">
          Create opportunity
        </button>
        {message && <span data-testid="investment-message">{message}</span>}
      </form>
      </details>

      <div className="deal-record-section">
        <h4>What the firm knows about them</h4>
        <p className="muted small">Everything on record, and where each part of it came from.</p>
        <Company360Panel key={`${companyId}-${nonce}`} companyId={companyId} />
      </div>

      <div className="deal-record-section">
      <h4>Its deals</h4>
      <p className="muted small">Pick one to open its record. That is where the real numbers go.</p>
      <ul className="card-list" data-testid="opportunity-list">
        {(opportunities.data?.opportunities ?? []).map((o) => (
          <li key={o.id} className="card" data-testid={`opportunity-${o.id}`}>
            <button type="button" className="link-button" data-testid={`opportunity-open-${o.id}`} onClick={() => setSelected(o)}>
              {o.title}
            </button>{" "}
            — <code>{o.opportunity_type}</code> <code>{o.status}</code>
            {o.seller_name ? ` · seller ${o.seller_name}` : ""}
            {o.broker_name ? ` · broker ${o.broker_name}` : ""}
            {o.backfilled_at && (
              <span className="badge" title="Status was entered as history, not decided here">
                backfilled
              </span>
            )}
            <PlaceholderPanel opportunity={o} onConfirmed={() => opportunities.reload()} />
          </li>
        ))}
        {/*
          Absence and "not asked yet" are different facts, and this list used to say the same thing
          for both — "No opportunities" directly beneath a pipeline showing three. The second case is
          now handled before the section renders at all, so what is left here means what it says.
        */}
        {(opportunities.data?.opportunities ?? []).length === 0 && (
          <li className="state-empty" data-testid="no-opportunities">
            Nothing recorded against this company yet. Create one to start its investment record.
          </li>
        )}
      </ul>

      <details className="card" data-testid="company-360-details">
        <summary>Everything else on record for this company</summary>
        <Company360Panel key={`${companyId}-${nonce}`} companyId={companyId} />
      </details>
      </div>

      {selected && (
        <div className="deal-record-section" data-testid="opportunity-detail">
          {/*
            LAID OUT LIKE THE LP PAGE. Operator: "i dont understand why it cant be simple like the lp
            page — everything is there and its easy to follow."

            The LP page works because it is a FLAT SEQUENCE: a heading, one card, the next heading.
            Nothing nested, nothing behind a disclosure, nothing that reveals a further thing when
            you pick something. This record was the opposite — pick a company, pick a deal, then
            three unlabelled blocks inside one section, one of which was a bare row of inputs with
            no heading at all. Same content, laid out the same way as the page she can follow.
          */}
          <h4>What the fund would own</h4>
          <p className="muted small">
            The price, the shares, and what that adds up to. These are the real numbers — anything
            still a stand-in is marked.
          </p>
          {/*
            THE MISSING RUNG. A `position` is created only when a transaction is executed, and every
            route in that lifecycle was built, authorized and tested with nothing able to reach it.
            Production held zero positions and always would have, while the pipeline said the fund
            had money in. This is where the ladder gets its rungs.
          */}
          <RecordInvestment
            companyId={selected.company_id}
            companyName={selected.title}
            opportunityId={selected.id}
            me={me}
            onRecorded={() => opportunities.reload()}
          />
          <h4>The arithmetic</h4>
          <p className="muted small">
            What the cheque buys and what it is worth if it works. Every figure is typed by a person;
            nothing here is assumed.
          </p>
          <div className="form-row" data-testid="deal-math-inputs">
            {(
              [
                ["check_size", "Our cheque"],
                ["round_size", "Round size"],
                ["pre_money", "Pre-money"],
                ["exit_value", "Exit value"],
                ["future_dilution_pct", "Future dilution %"],
                ["hold_years", "Hold years"],
                ["fund_size", "Fund size"],
              ] as const
            ).map(([key, label]) => {
              // Computed here rather than inline: a template literal with an interpolation inside a
              // JSX attribute defeats the brace tracking in tests/accessibility.test.ts, which then
              // reads past the tag and reports a duplicate label that does not exist.
              const testId = "deal-math-" + key.split("_").join("-");
              return (
                <label key={key}>
                  {label}{" "}
                  <input
                    data-testid={testId}
                    inputMode="decimal"
                    value={math[key]}
                    onChange={(e) => setMath((m) => ({ ...m, [key]: e.target.value }))}
                  />
                </label>
              );
            })}
          </div>
          <div className="form-row">
            <button
              type="button"
              data-testid="deal-math-create"
              onClick={async () => {
                // Every field is required, and none is invented. A packet built on a number nobody
                // entered is worse than no packet: it is arithmetic presented as belonging to this
                // deal. (Written without an apostrophe on purpose — the tag scanner in
                // tests/accessibility.test.ts treats one in a comment as an unclosed string.)
                const missing = Object.entries(math).filter(([, v]) => v.trim() === "" || !Number.isFinite(Number(v)));
                if (missing.length > 0) {
                  setMessage(`Fill in the numbers for this deal first — missing: ${missing.map(([k]) => k.replace(/_/g, " ")).join(", ")}.`);
                  return;
                }
                // Manual entry is ALWAYS available (D6); the CALCULATED path is a separate step.
                const { status, data } = await api<DealMathPacketRow & { error?: string }>(`/api/opportunities/${selected.id}/deal-math`, {
                  method: "POST",
                  body: {
                    deal_type: selected.opportunity_type,
                    source_inputs: Object.fromEntries(
                      Object.entries(math).map(([k, v]) => [k, Number(v)]),
                    ),
                  },
                });
                setPacket(status === 201 ? data : null);
                setMessage(status === 201 ? `Deal math packet ${data!.id} (${data!.math_quality_status}).` : `Packet refused: ${data?.error ?? status}`);
              }}
            >
              Create deal math packet
            </button>
            <button
              type="button"
              data-testid="deal-math-calculate"
              onClick={async () => {
                const { status, data } = await api<DealMathPacketRow & { error?: string; detail?: string }>(
                  `/api/opportunities/${selected.id}/deal-math/calculate`,
                  { method: "POST", body: {} },
                );
                setPacket(status === 200 ? data : packet);
                setMessage(status === 200 ? `Calculated with verified formulas (${data!.entry_mode}).` : `Calculate refused: ${data?.error ?? status}`);
              }}
            >
              Calculate (verified formulas only)
            </button>
            <button
              type="button"
              data-testid="ic-assemble"
              onClick={async () => {
                const { status, data } = await api<IcPacketRow & { error?: string }>("/api/ic/packets", {
                  method: "POST",
                  body: { opportunity_id: selected.id, deal_math_packet_id: packet?.id },
                });
                setIcPacketId(status === 201 ? data!.id : null);
                setMessage(status === 201 ? `IC packet ${data!.id} assembled.` : `Assemble refused: ${data?.error ?? status}`);
                setNonce((n) => n + 1);
              }}
            >
              Assemble IC packet
            </button>
          </div>
          {packet && (
            <p className="card" data-testid="deal-math-packet">
              <code>{packet.id}</code> — entry mode <code data-testid="deal-math-entry-mode">{packet.entry_mode}</code> · status{" "}
              <code data-testid="deal-math-status">{packet.math_quality_status}</code> · valuation {packet.valuation ?? "—"} · ownership{" "}
              {packet.ownership_at_close ?? "—"} · MOIC {packet.moic ?? "—"} · TVPI {packet.tvpi ?? "— (manual only)"}
            </p>
          )}
          {/* The last step in the sequence, and it gets a heading like the rest of them. Nesting is
              reserved for the rare action — adding a second deal — rather than for the work. */}
          {icPacketId && (
            <>
              <h4>Ready for the committee</h4>
              <p className="muted small">
                What the committee decides on, and what it still needs before it can.
              </p>
              <IcPacketPanel packetId={icPacketId} onChanged={() => setNonce((n) => n + 1)} />
              <IcPortalPage packetId={icPacketId} />
            </>
          )}
        </div>
      )}
        </>
      )}

      <DealProvenance />
    </section>
  );
}

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

interface FundRow {
  id: string;
  name: string;
}

interface ScenarioRow {
  id: string;
  name: string;
  status: string;
  model_version: string;
}

interface AllocationOptionRow {
  id: string;
  option_type: string;
  label: string;
  capital: number;
  decision: string;
  proposed_by_type: string;
}

interface RunResultRow {
  option_id: string;
  sleeve_remaining_after: number;
  concentration_pct_after: number;
  reserve_uncommitted_after: number;
  breach_count: number;
}

interface ViolationRow {
  id: string;
  option_id: string;
  kind: string;
  severity: string;
  detail: string;
}

function AllocationPage({ me }: { me: MeResponse }) {
  const [nonce, setNonce] = useState(0);
  const funds = useApi<{ funds: FundRow[] }>("/api/funds");
  const scenarios = useApi<{ scenarios: ScenarioRow[] }>("/api/allocation/scenarios", [nonce]);
  const [scenarioId, setScenarioId] = useState("");
  const detail = useApi<{
    name: string;
    model_version: string;
    outcome_label: string;
    mandate_version_id: string;
    sleeve_version_id: string;
    reserve_version_id: string;
    concentration_version_id: string;
    options: AllocationOptionRow[];
    assumptions: Array<{ id: string; assumption_key: string; assumption_value: string; basis: string }>;
  }>(scenarioId ? `/api/allocation/scenarios/${scenarioId}` : null, [scenarioId, nonce]);
  const [runId, setRunId] = useState("");
  const run = useApi<{ results: RunResultRow[]; violations: ViolationRow[]; breach_count: number }>(runId ? `/api/allocation/runs/${runId}` : null, [runId]);
  const [optionType, setOptionType] = useState("FOLLOW_ON");
  const [optionLabel, setOptionLabel] = useState("");
  const [capital, setCapital] = useState("2100000");
  const [existingCost, setExistingCost] = useState("1500000");
  const [receipt, setReceipt] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  void me;

  const post = async <T,>(path: string, body: unknown, okStatus: number, label: string): Promise<{ status: number; data: (T & { error?: string }) | null }> => {
    const { status, data } = await api<T & { error?: string }>(path, { method: "POST", body });
    setMessage(status === okStatus ? `${label} ok.` : `${label} refused: ${data?.error ?? status}`);
    setNonce((n) => n + 1);
    return { status, data };
  };

  return (
    <section data-testid="allocation-page">
      <h4>Scenarios (each pins its policy versions)</h4>
      <form
        className="form-row"
        data-testid="scenario-form"
        onSubmit={async (e) => {
          e.preventDefault();
          // Read the form BEFORE any await: currentTarget is gone by the time the
          // policy lookups below resolve.
          const form = new FormData(e.currentTarget);
          const scenarioName = (form.get("name") as string) || "scenario";
          const fundId = (form.get("fund") as string) || funds.data?.funds[0]?.id;
          if (!fundId) {
            setMessage("Scenario refused: no fund exists yet.");
            return;
          }
          // Pin the CURRENT latest version of each policy at scenario-open time.
          const pins: Record<string, string> = {};
          for (const kind of ["mandate", "sleeve", "reserve", "concentration"]) {
            const { data } = await api<{ versions: Array<{ id: string }>; current: { id: string } | null }>(`/api/funds/${fundId}/policies/${kind}`);
            // `current` from the API. This was the ONE call site that took `.at(-1)` while six
            // others took `[0]`, so the allocation model pinned a different policy version from
            // the one every display showed.
            const latest = data?.current;
            if (!latest) {
              setMessage(`Scenario refused: fund has no ${kind} policy version yet.`);
              return;
            }
            pins[kind] = latest.id;
          }

          // THE FUND'S OWN NUMBERS, READ RATHER THAN INVENTED. What stood here was
          // `fund_size: 30000000, investable: 24000000, fund_deployed: 10000000` — hardcoded, in
          // the request body, where no partner ever saw them. The constraint engine then answered
          // "does the sleeve fit" and "is the reserve sufficient" against a thirty-million-dollar
          // fund the firm does not have, and printed the answers as arithmetic. This page already
          // refused to open a scenario without a pinned policy version; it had no business being
          // stricter about a policy id than about the size of the fund.
          /*
           * Read BEFORE any await, like the rest of this handler: `currentTarget` is gone by the
           * time the policy lookups resolve, and reading it afterwards is how this form lost fields
           * silently once already.
           */
          const investableGiven = Number(form.get("investable"));
          if (!Number.isFinite(investableGiven) || investableGiven <= 0) {
            setMessage(
              "Scenario refused: say how much of the fund is actually investable after fees. Nobody has recorded a fee model, so this is the one number the system cannot work out for you.",
            );
            return;
          }

          const { data: basis } = await api<{
            fund_size: number | null;
            fund_deployed: number;
            ready: boolean;
            blocked_because: string | null;
          }>(`/api/funds/${fundId}/basis`);
          if (!basis?.ready) {
            setMessage(`Scenario refused: ${basis?.blocked_because ?? "the fund's own numbers could not be read."}`);
            return;
          }

          const { status, data } = await post<{ id: string }>(
            "/api/allocation/scenarios",
            {
              fund_id: fundId,
              name: scenarioName,
              mandate_version_id: pins.mandate,
              sleeve_version_id: pins.sleeve,
              reserve_version_id: pins.reserve,
              concentration_version_id: pins.concentration,
              fund_size: basis.fund_size,
              investable: investableGiven,
              fund_deployed: basis.fund_deployed,
              // Investable and the modelled reserve need are OMITTED, not zeroed. Nobody has
              // recorded a fee model or a reserve plan, and a zero would be read as "the fund has
              // nothing set aside" rather than "we were never told" — which is how the last set of
              // invented numbers came to look like facts.
            },
            201,
            "Scenario",
          );
          if (status === 201 && data) setScenarioId(data.id);
        }}
      >
        <label>
          Fund{" "}
          <select name="fund" data-testid="scenario-fund">
            {(funds.data?.funds ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name <input name="name" data-testid="scenario-name" defaultValue="" />
        </label>
        {/*
          ASKED FOR, BECAUSE NOBODY HAS RECORDED IT. `investable` is NOT NULL and the firm has no fee
          model on file, so there are only three options: invent a number, refuse to open scenarios
          at all, or ask. Inventing is what put a $30M fund into every scenario in the first place,
          and refusing would take Fund strategy away entirely — so the form asks for the one figure
          the system genuinely does not know, and the answer is recorded rather than assumed.
        */}
        <label>
          Investable after fees{" "}
          <input
            name="investable"
            data-testid="scenario-investable"
            inputMode="decimal"
            placeholder="what is actually deployable"
          />
        </label>
        <button type="submit" className="btn-strong" data-testid="scenario-create">
          Open scenario (pins current policy versions)
        </button>
      </form>

      <label>
        Working scenario{" "}
        <select data-testid="scenario-select" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
          <option value="">— select —</option>
          {(scenarios.data?.scenarios ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.status})
            </option>
          ))}
        </select>
      </label>
      {detail.data && (
        <div className="card" data-testid="scenario-detail">
          <p data-testid="scenario-pins">
            model <code>{detail.data.model_version}</code> · mandate <code>{detail.data.mandate_version_id}</code> · sleeve{" "}
            <code>{detail.data.sleeve_version_id}</code> · reserve <code>{detail.data.reserve_version_id}</code> · concentration{" "}
            <code>{detail.data.concentration_version_id}</code>
          </p>
          <p data-testid="scenario-outcome-label">{detail.data.outcome_label}</p>
          <h4>Assumptions (stated, append-only)</h4>
          <ul data-testid="assumption-list">
            {detail.data.assumptions.map((a) => (
              <li key={a.id} data-testid={`assumption-${a.id}`}>
                <code>{a.assumption_key}</code> = {a.assumption_value} — {a.basis}
              </li>
            ))}
            {detail.data.assumptions.length === 0 && <li className="state-empty" data-testid="no-assumptions">No assumptions stated yet. An allocation scenario cannot run until its assumptions are on the record.</li>}
          </ul>
          <button
            type="button"
            data-testid="assumption-add"
            onClick={() =>
              post(
                `/api/allocation/scenarios/${scenarioId}/assumptions`,
                { assumption_key: "graduation_rate", assumption_value: "35%", basis: "operator-stated planning figure, not an observed rate" },
                201,
                "Assumption",
              )
            }
          >
            State graduation-rate assumption
          </button>
        </div>
      )}

      <h4>Capital options (initial, follow-on, reserve, secondary, exit — one framework)</h4>
      <form
        className="form-row"
        data-testid="option-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await post(
            `/api/allocation/scenarios/${scenarioId}/options`,
            {
              option_type: optionType,
              label: optionLabel,
              sleeve_key: "early",
              sleeve_target_pct: 60,
              sleeve_deployed: 10000000,
              capital: Number(capital),
              reserve_draw: optionType === "RESERVE" ? Number(capital) : 0,
              existing_company_cost: Number(existingCost),
            },
            201,
            "Option",
          );
        }}
      >
        <label>
          Type{" "}
          <select data-testid="option-type" value={optionType} onChange={(e) => setOptionType(e.target.value)}>
            {["INITIAL", "FOLLOW_ON", "RESERVE", "SECONDARY_PURCHASE", "SECONDARY_SALE", "EXIT"].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          Label <input data-testid="option-label" value={optionLabel} onChange={(e) => setOptionLabel(e.target.value)} />
        </label>
        <label>
          Capital <input data-testid="option-capital" value={capital} onChange={(e) => setCapital(e.target.value)} />
        </label>
        <label>
          Existing cost <input data-testid="option-existing-cost" value={existingCost} onChange={(e) => setExistingCost(e.target.value)} />
        </label>
        <button type="submit" className="btn-strong" data-testid="option-create">
          Add option
        </button>
      </form>

      <button
        type="button"
        data-testid="run-comparison"
        onClick={async () => {
          const { status, data } = await post<{ run: { id: string } }>(`/api/allocation/scenarios/${scenarioId}/compare`, {}, 201, "Comparison");
          if (status === 201 && data) setRunId(data.run.id);
        }}
      >
        Run cross-sleeve comparison
      </button>
      {message && <p className="notice" data-testid="allocation-message">{message}</p>}

      {run.data && (
        <div className="card" data-testid="run-detail">
          <p data-testid="run-breaches">{run.data.violations.filter((v) => v.severity === "BREACH").length} constraint breach(es)</p>
          <ul data-testid="violation-list">
            {run.data.violations.map((v) => (
              <li key={v.id} data-testid={`violation-${v.kind}`}>
                <code>{v.severity}</code> <code>{v.kind}</code> — {v.detail}
              </li>
            ))}
            {run.data.violations.length === 0 && <li className="state-empty" data-testid="no-violations">No constraint violations.</li>}
          </ul>
        </div>
      )}

      <h4>Options — humans decide</h4>
      {/* The receipt is typed in, not remembered for you: an approval card is
          presented deliberately, and it survives leaving this page to approve it. */}
      <label>
        Approval receipt <input data-testid="option-receipt" value={receipt} onChange={(e) => setReceipt(e.target.value)} />
      </label>
      <ul className="card-list" data-testid="option-list">
        {(detail.data?.options ?? []).map((o) => (
          <li key={o.id} className="card" data-testid={`option-${o.id}`}>
            <code>{o.option_type}</code> {o.label} · {o.capital} · <code data-testid={`option-decision-${o.id}`}>{o.decision}</code> · proposed by{" "}
            {o.proposed_by_type}
            <div className="form-row">
              <button
                type="button"
                data-testid={`option-request-${o.id}`}
                onClick={async () => {
                  const { status, data } = await post<{ id: string }>(`/api/allocation/options/${o.id}/request-approval`, {}, 201, "Approval request");
                  if (status === 201 && data) setReceipt(data.id);
                }}
              >
                Request the reserved approval
              </button>
              <button
                type="button"
                data-testid={`option-approve-${o.id}`}
                onClick={() => post(`/api/allocation/options/${o.id}/decide`, { decision: "APPROVED", ...(receipt ? { approval_receipt_id: receipt } : {}) }, 200, "Decision")}
              >
                Record APPROVED
              </button>
            </div>
          </li>
        ))}
        {(detail.data?.options ?? []).length === 0 && <li className="state-empty" data-testid="no-options">No options in this scenario.</li>}
      </ul>
    </section>
  );
}

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

/** What the portfolio is actually made of — needs no fund, it reads the closed holdings. */
function PortfolioComposition(): JSX.Element {
  return <Composition />;
}

/** Resolves the selected fund for the allocation ring; renders nothing before one exists. */
function PortfolioAllocation(): JSX.Element | null {
  const selected = useSelectedFund();
  if (selected.loading || !selected.fund) return null;
  return <FundAllocation fundId={selected.fund.id} />;
}

/**
 * Fund strategy — the allocation decision, start to finish.
 *
 * TWO TABS ANSWERED ONE QUESTION. Allocation carried "What the portfolio is made of" and "Where the
 * fund goes"; Fund strategy carried "Allocation decision view". Each duplicated a heading the other
 * owned, so being sure you had seen everything meant visiting both — the same failure that merged
 * Scheduled Work into Work.
 *
 * ORDERED AS THE DECISION RUNS, not as the components happened to be written. The question a
 * partner arrives with is "can we write this cheque, and what does it cost us later", and that is
 * answered in a sequence: what the thesis promised, what has gone out, what is left, what this
 * cheque does to the shape, and what it costs the reserves. Five panels of numbers in an arbitrary
 * order is a dashboard; the same five in that order is a method.
 */
const STRATEGY_STEPS: readonly { q: string; where: string }[] = [
  { q: "What did we say we would build?", where: "The thesis — target positions, ownership and cheque size." },
  { q: "What have we actually got?", where: "Composition: where the money has gone so far." },
  { q: "What is left, and what is at risk?", where: "Alerts and the companies moving the wrong way." },
  { q: "What would this next cheque do?", where: "Scenarios: model it before you commit to it." },
  { q: "What does it cost us later?", where: "Reserves and follow-on capacity after the cheque." },
  { q: "And the companies we already own?", where: "Follow-on: which of them earns the next cheque." },
];

function FundStrategyPage({ me, onNavigate }: { me: MeResponse; onNavigate?: (key: string) => void }): JSX.Element {
  /*
   * The deck and the construction editor sit at the TOP of this page, above the analysis, because
   * they are the two things the operator asked for by name — "we should have our deck displayed
   * prominently in the OS" and "we need to be able to adjust this ourselves in the OS UI". A
   * document that lives only in Canva and a construction that needs a migration to change are the
   * two gaps that produced every discrepancy found on 9 Sep 2026.
   */
  const funds = useApi<{ funds: Array<{ id: string }> }>("/api/funds");
  const fundId = funds.data?.funds?.[0]?.id ?? null;

  return (
    <section data-testid="fund-strategy-page">
      <DeckPanel onNavigate={onNavigate} />
      <FundConstruction fundId={fundId} />

      {/* The sequence, stated once at the top. It teaches the order rather than assuming it. */}
      <details className="card" data-testid="strategy-how">
        <summary className="muted small">How this decision runs</summary>
        <ol className="card-list small">
          {STRATEGY_STEPS.map((s) => (
            <li key={s.q}>
              <strong>{s.q}</strong> — {s.where}
            </li>
          ))}
        </ol>
      </details>

      <CockpitPage me={me} />

      <div className="home-section-head">
        <h3>What the portfolio is made of</h3>
        <span className="muted small">read from closed holdings, not projected</span>
      </div>
      <PortfolioComposition />
      <PortfolioAllocation />

      {/* DEAL MATH, FOLDED IN (item 13). Before the scenarios, because you size a cheque by what it
          buys: what this round does to ownership, and what an exit would have to be for it to
          return the fund. The scenarios below then ask whether the fund can afford it. */}
      <div className="home-section-head">
        <h3>What this cheque actually buys</h3>
        <span className="muted small">ownership, dilution, and what it takes to return the fund</span>
      </div>
      <ModelingPage me={me} />

      <div className="home-section-head">
        <h3>Modelling the next cheque</h3>
        <span className="muted small">scenarios, and what each one breaks</span>
      </div>
      <AllocationPage me={me} />

      {/* FOLLOW-ON IS THE SAME DECISION, SEEN LATER.
          It had its own tab, which meant "should we write this cheque" and "should we write ANOTHER
          cheque into a company we already own" were answered on different pages — while sharing the
          reserves they both draw from. Deciding a follow-on without the allocation picture in front
          of you is deciding it blind, and the reserve consequence is the last step of the sequence
          this page already walks. */}
      <div className="home-section-head">
        <h3>Following on</h3>
        <span className="muted small">the companies we already own, and what a second cheque costs</span>
      </div>
      <FollowOnPage />
    </section>
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
};

function keyFromHash(known: (key: string) => boolean): string {
  const raw = window.location.hash.replace(/^#\/?/, "").trim();
  const resolved = MERGED_ROUTES[raw] ?? raw;
  return resolved && known(resolved) ? resolved : "home";
}

export function App() {
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

  // On the phone sheet, choosing a destination is the whole interaction — close behind it.
  const navigate = useCallback((key: string) => {
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
          {active === "help" && <HelpCenterPage />}
          {authed && active === "home" && <HomePage me={me.data!} onNavigate={navigate} />}
          {authed && active === "setup" && <SetupPage me={me.data!} />}
          {authed && active === "sources-and-sweeps" && <IntelligencePage me={me.data!} />}
          {authed && active === "employees" && <EmployeesPage me={me.data!} />}
          {authed && active === "rooms" && <RoomsPage />}
          {authed && active === "introductions" && <IntroductionsPage />}
          {authed && active === "community" && <CommunityPage />}
          {authed && active === "record" && <LedgersPage />}
          {/* Follow-on merged into Fund strategy. The route stays live. */}
          {authed && active === "follow-on" && <FundStrategyPage me={me.data!} onNavigate={navigate} />}
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
          {authed && active === "work" && (
            <>
              <WorkSurface me={me.data!} onChanged={refresh} onNavigate={navigate} />
              {/* "Runs on a schedule" read as a sentence fragment rather than a section name, and
                  nothing said where the section ended. A chevron makes it obvious that what follows
                  is the scheduled half of this page. */}
              <div className="home-section-head work-scheduled-head">
                <h3>
                  <span className="chev" aria-hidden="true" /> Scheduled work
                </h3>
                <span className="muted small">machinery, not anything somebody carries</span>
              </div>
              <JobsPage me={me.data!} />
            </>
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
          {authed && active === "deal-math" && <FundStrategyPage me={me.data!} onNavigate={navigate} />}
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
          {authed && active === "fund-strategy" && <FundStrategyPage me={me.data!} onNavigate={navigate} />}
          {authed && active === "network" && <NetworkPage me={me.data!} />}
          {authed && active === "integrations" && <IntegrationsPage me={me.data!} />}
          {authed && active === "lp" && <LpPage me={me.data!} />}
          {/* The old address still works and lands in the same place. */}
          {authed && active === "allocation" && <FundStrategyPage me={me.data!} onNavigate={navigate} />}
          {/* Reporting folded into LP (item 16): an LP is somebody who gave the fund money and
              whom the fund owes an account of it, and two tabs for one relationship meant
              answering "what has Cedar been told?" required knowing packets lived elsewhere.
              The route still resolves so an old link lands on the page that now holds it. */}
          {authed && active === "reporting" && <LpPage me={me.data!} />}
          {authed && active === "documents" && <DocumentsPage />}
          {authed && active === "contradictions" && <ContradictionsPage />}
          {authed && active === "activity" && <ActivityPage me={me.data!} refreshNonce={refreshNonce} />}
          {authed && active === "governance" && <GovernancePage me={me.data!} />}
          {authed && active === "ai-controls" && <AiPage me={me.data!} />}
          {authed && active === "cockpit" && <AiOpsPage me={me.data!} />}
          {authed && active === "diagnostics" && <DiagnosticsPage onNavigate={navigate} />}
          </div>
        </main>
      </div>
    </div>
  );
}
