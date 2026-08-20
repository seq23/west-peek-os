import { useCallback, useEffect, useState } from "react";
import { readableDate, shortDate } from "./lib/dates";
import { api, getDevUser, signOut, useApi, type MeResponse } from "./lib/api";
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
import { actionDescription, actionName, actorName, approvalStateWords, roleWords } from "@shared/help/actionNames";
import { stateMeaning } from "@shared/work/workCards";
import { SignInCard, SignedOutPage } from "./pages/AuthSurfaces";
import { UniversityPage } from "./pages/UniversityPage";
import { MarketMapPage } from "./pages/MarketMapPage";
import { ApprovalContextPanel } from "./pages/ApprovalContextPanel";
import { AiOpsPage } from "./pages/AiOpsPage";
import { MachinesPage } from "./pages/MachinesPage";
import { IntentPage } from "./pages/IntentPage";
import { JobsPage } from "./pages/JobsPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { ResearchPage } from "./pages/ResearchPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";
import { CockpitPage } from "./pages/CockpitPage";
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
      { key: "approvals", label: "Approvals", icon: "approvals" },
      { key: "today", label: "Today" },
      { key: "notifications", label: "Notifications" },
      // Introductions moved into Community. It sat here beside Approvals and Notifications — things
      // that always have something waiting — while being a surface that is deliberately empty most
      // months, so its presence read as a system that had stopped working. The route stays live.
      { key: "weekly-review", label: "Weekly review" },
      // Scheduled work and work cards answered the same question — what is the firm doing — from
      // two tabs, so you had to check both. One destination, two sections: the distinction between
      // machinery on a clock and a task somebody carries is real and stays visible.
      { key: "work-cards", label: "Work" },
    ],
  },
  {
    group: "Deals",
    blurb: "Companies, from first look to exit",
    items: [
      { key: "thesis", label: "Thesis" },
      { key: "investment", label: "Dealflow" },
      { key: "companies", label: "Companies" },
      { key: "meetings", label: "Meetings" },
      { key: "secondaries", label: "Secondaries" },
      { key: "portfolio", label: "Portfolio" },
      // Allocation merged into Fund strategy. Two tabs answered one question — "what the portfolio
      // is made of" and "where the fund goes" lived on one, "allocation decision view" on the
      // other — so you had to visit both to be sure you had seen everything. The route stays live.
      { key: "cockpit", label: "Fund strategy" },
      { key: "modeling", label: "Deal Math" },
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
      { key: "reporting", label: "Reporting" },
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
      { key: "ai-ops", label: "Cockpit" },
      { key: "ai", label: "AI" },
      { key: "intelligence", label: "Sources & sweeps" },
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

function TodayPage({ me, onNavigate }: { me: MeResponse; onNavigate: (k: string) => void }) {
  const cards = useApi<{ work_cards: WorkCardRow[] }>("/api/work-cards");
  const approvals = useApi<{ approvals: ApprovalCardRow[] }>("/api/approvals?state=pending_review");
  const activity = useApi<{ events: ActivityEvent[] }>("/api/activity?limit=10");

  const mine = (cards.data?.work_cards ?? []).filter(
    (c) => c.owner_id === me.id && (c.state === "OPEN" || c.state === "IN_PROGRESS"),
  );
  const pendingCount = approvals.data?.approvals.length ?? 0;

  return (
    <section data-testid="today-page">
      {/* A LIST OF WORK WITH NO WAY TO REACH IT. Today showed the operator their open cards and
          offered no route to the page that can do anything about them — you could read that a card
          existed and then had to go and find it yourself. Every item is a link now, and the section
          heading carries the way through. */}
      <div className="home-section-head">
        <h3>My open work</h3>
        {mine.length > 0 && (
          <button type="button" className="link-button" data-testid="today-open-work" onClick={() => onNavigate("work-cards")}>
            Open Work →
          </button>
        )}
      </div>
      {mine.length === 0 ? (
        <p className="state-empty">
          Nothing open and assigned to you.{" "}
          <button type="button" className="link-button" onClick={() => onNavigate("work-cards")}>
            Add a card on Work
          </button>{" "}
          — or one reaches you from a routed capture, an accepted handoff, or something you asked for.
        </p>
      ) : (
        <ul className="card-list small" data-testid="today-my-work">
          {mine.map((c) => (
            <li key={c.id}>
              <button type="button" className="link-button" onClick={() => onNavigate("work-cards")}>
                <strong>{c.title}</strong>
              </button>{" "}
              <span className="muted small">
                {stateMeaning(c.state)?.label ?? c.state}
                {c.next_action ? ` · next: ${c.next_action}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="home-section-head">
        <h3>Pending approvals</h3>
        {pendingCount > 0 && (
          <button type="button" className="link-button" data-testid="today-open-approvals" onClick={() => onNavigate("approvals")}>
            Open Approvals →
          </button>
        )}
      </div>
      <p data-testid="pending-approvals-count">
        {pendingCount === 0 ? "Nothing is waiting on your signature." : `${pendingCount} waiting on a decision from you.`}
      </p>
      {/* FOLDED, because it is the audit spine rather than something to read. It answers "did that
          actually get recorded" on the rare day somebody asks, and the rest of the time it is a
          wall of event types and ids between the reader and the bottom of the page. */}
      <details className="card" data-testid="today-activity-panel">
        <summary>
          Recent activity <span className="muted small">{(activity.data?.events ?? []).length}</span>
        </summary>
        <p className="muted small">
          Every governed action this firm took, newest first — the record behind the pages above.
          Nothing here needs doing; it is here so you can check that something happened.
        </p>
        <ul data-testid="today-activity" className="small">
          {(activity.data?.events ?? []).slice(0, 40).map((e) => (
            <li key={e.id}>
              {/* An audit row keeps its ids — they are what you search for when something has gone
                  wrong, and hiding them would defeat the point of the ledger. The TIMESTAMP is a
                  different matter: `2026-08-20T06:41:28.855Z` is a machine's way of saying a time
                  to a person who is scanning for when something happened. */}
              <code>{e.event_type}</code> {e.object_type}/{e.object_id}{" "}
              <span className="muted">— {new Date(e.created_at).toLocaleString()}</span>
            </li>
          ))}
          {(activity.data?.events ?? []).length === 0 && (
            <li className="state-empty">Nothing recorded yet today.</li>
          )}
        </ul>
        {(activity.data?.events ?? []).length > 40 && (
          <p className="muted small">Showing the 40 most recent of {(activity.data?.events ?? []).length}.</p>
        )}
      </details>
    </section>
  );
}

/**
 * Say what a capture is about.
 *
 * Capture is a holding pen — it owns nothing, and until this existed the only thing you could do
 * with a note was hand it to a processing machine. Meanwhile the two systems of record were fed by
 * hand: companies here, people in Network OS.
 *
 * The person branch is the one worth reading. Network OS owns people and this system cannot write
 * to it, so somebody it has never heard of has nowhere to go. Rather than pretend, they are
 * recorded locally, marked, and queued — and the response says which of those two happened in
 * words rather than a status code, because "we filed this under a system that does not know them"
 * is exactly the kind of thing an interface usually hides.
 */
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

function CapturePage({ onChanged }: { me: MeResponse; onChanged: () => void }) {
  const [captureType, setCaptureType] = useState("note");
  const [sourceChannel, setSourceChannel] = useState("web");
  const [rawText, setRawText] = useState("");
  const [privacyLabel, setPrivacyLabel] = useState("INTERNAL");
  const [result, setResult] = useState<CaptureRow | null>(null);
  const [routeResult, setRouteResult] = useState<string | null>(null);
  const [machineId, setMachineId] = useState<number>(3);
  const [error, setError] = useState<string | null>(null);
  const machines = useApi<{ machines: MachineRow[] }>("/api/machines");

  return (
    <section data-testid="capture-page">
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
        <div className="form-row">
          <label>
            Type{" "}
            <input data-testid="capture-type" value={captureType} onChange={(e) => setCaptureType(e.target.value)} />
          </label>
          <label>
            Channel{" "}
            <input data-testid="capture-channel" value={sourceChannel} onChange={(e) => setSourceChannel(e.target.value)} />
          </label>
          <label>
            Privacy{" "}
            <select data-testid="capture-privacy" value={privacyLabel} onChange={(e) => setPrivacyLabel(e.target.value)}>
              {["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED", "LP_PRIVATE", "MNPI_SENSITIVE", "BANKING_RESTRICTED"].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row">
          <textarea
            data-testid="capture-text" aria-label="What you need, in your own words"
            rows={4}
            style={{ width: "100%" }}
            placeholder="What's on your mind?"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
          />
        </div>
        <button type="submit" className="btn-primary" data-testid="capture-submit">
          Capture
        </button>
        {error && <p role="alert">Capture failed: {error}</p>}
      </form>

      {result && (
        <div className="card" data-testid="capture-result">
          <p>
            Captured <code>{result.id}</code> — status <strong>{result.status}</strong> · privacy {result.privacy_label}
          </p>
          <ResolveCapture captureId={result.id} onResolved={onChanged} />
          {result.status === "NEW" && (
            <form
              data-testid="route-form"
              onSubmit={async (e) => {
                e.preventDefault();
                const { status, data } = await api<{ capture: CaptureRow; work_card: WorkCardRow | null; error?: string }>(
                  `/api/captures/${result.id}/route`,
                  { method: "POST", body: { machine_id: machineId, create_work_card: true, title: rawText.slice(0, 120) } },
                );
                if (status === 200 && data) {
                  setResult(data.capture);
                  setRouteResult(`Routed to machine #${data.capture.routed_machine_id}; work card ${data.work_card?.id ?? "none"} created.`);
                  onChanged();
                } else {
                  setRouteResult(`Route failed: ${data?.error ?? `HTTP ${status}`}`);
                }
              }}
            >
              <label>
                Route to machine{" "}
                <select data-testid="route-machine" value={machineId} onChange={(e) => setMachineId(Number(e.target.value))}>
                  {(machines.data?.machines ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      #{m.id} {m.name}
                    </option>
                  ))}
                </select>
              </label>{" "}
              <button type="submit" className="btn-strong" data-testid="route-submit">
                Route + create work card
              </button>
            </form>
          )}
          {routeResult && <p data-testid="route-result">{routeResult}</p>}
        </div>
      )}
    </section>
  );
}

function WorkCardsPage({ me, onChanged }: { me: MeResponse; onChanged: () => void }) {
  const [stateFilter, setStateFilter] = useState("ALL");
  const [message, setMessage] = useState<string | null>(null);
  const cards = useApi<{ work_cards: WorkCardRow[] }>("/api/work-cards");

  const visible = (cards.data?.work_cards ?? []).filter((c) => stateFilter === "ALL" || c.state === stateFilter);

  return (
    <section data-testid="work-cards-page">
      <div className="form-row">
        <label>
          State{" "}
          <select data-testid="work-card-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            {["ALL", ...WORK_CARD_STATES].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn-ghost" onClick={() => cards.reload()}>
          Refresh
        </button>
      </div>
      {message && <p className="notice" data-testid="work-card-message">{message}</p>}
      <ul data-testid="work-card-list" className="card-list">
        {visible.map((c) => (
          <li key={c.id} className="card" data-testid={`work-card-${c.id}`}>
            <p>
              <strong>{c.title}</strong> — <code>{c.state}</code> · {c.priority} · {c.privacy_label}
            </p>
            <p>
              owner: {c.owner_type}
              {c.owner_id ? `/${c.owner_id}` : ""}
              {c.next_action ? ` · next: ${c.next_action}` : ""}
            </p>
            <div className="form-row">
              <select
                aria-label={`transition-${c.id}`}
                data-testid={`transition-select-${c.id}`}
                defaultValue=""
                onChange={async (e) => {
                  const next = e.target.value;
                  if (!next) return;
                  const { status, data } = await api<WorkCardRow & { error?: string; detail?: string }>(`/api/work-cards/${c.id}`, {
                    method: "PATCH",
                    body: { state: next },
                  });
                  setMessage(status === 200 ? `${c.title}: → ${next}` : `Transition refused: ${data?.detail ?? data?.error ?? status}`);
                  cards.reload();
                  onChanged();
                  e.target.value = "";
                }}
              >
                <option value="" disabled>
                  Transition…
                </option>
                {WORK_CARD_STATES.filter((s) => s !== c.state).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              {c.owner_id !== me.id && (
                <button
                  type="button"
                  onClick={async () => {
                    await api(`/api/work-cards/${c.id}`, { method: "PATCH", body: { owner_type: "HUMAN", owner_id: me.id } });
                    cards.reload();
                  }}
                >
                  Assign to me
                </button>
              )}
              <button
                type="button"
                data-testid={`request-approval-${c.id}`}
                onClick={async () => {
                  const { status, data } = await api<ApprovalCardRow & { error?: string }>("/api/approvals", {
                    method: "POST",
                    body: {
                      action_key: "external_effect.execute",
                      object_type: "work_card",
                      object_id: c.id,
                      title: `Approval for work card: ${c.title}`,
                      submit: true,
                    },
                  });
                  setMessage(status === 201 ? `Approval card ${data!.id} submitted for review.` : `Approval request failed: ${data?.error ?? status}`);
                  onChanged();
                }}
              >
                Request approval
              </button>
            </div>
          </li>
        ))}
      </ul>
      {visible.length === 0 && <p className="state-empty">No work cards match this filter. Change the state filter above, or open +Capture to route new work.</p>}
    </section>
  );
}

function ApprovalCard({ card, me, onDecided }: { card: ApprovalCardRow; me: MeResponse; onDecided: () => void }) {
  const [note, setNote] = useState("");
  const detail = useApi<ApprovalCardRow>(`/api/approvals/${card.id}`);
  const decisions = detail.data?.decisions ?? [];
  const requiredRoles: string[] = (() => {
    try {
      return JSON.parse(card.required_approver_roles_json) as string[];
    } catch {
      return [];
    }
  })();
  const canDecide = card.state === "pending_review" && requiredRoles.some((r) => me.roles.includes(r));
  // "requested by HUMAN/fu_sequoia_taylor" is you. Saying so beats printing your own row id back.
  const whoRequested =
    card.requested_by_id === me.id ? "you" : card.requested_by_type === "HUMAN" ? "your partner" : card.requested_by_id;

  const decide = async (decision: "approved" | "rejected" | "revise_requested") => {
    await api(`/api/approvals/${card.id}/decide`, { method: "POST", body: { decision, note: note || undefined } });
    setNote("");
    onDecided();
  };

  return (
    <li className="card" data-testid={`approval-card-${card.id}`}>
      <div className="panel-head">
        <h4>{card.title}</h4>
        <span className={approvalStateBadge(card.state)} title={approvalStateWords(card.state).means}>{approvalStateWords(card.state).label}</span>
      </div>

      {/* Risk, evidence and questions, on the card. Canon §24.2 asks for these because an approval
          you have to leave the page to evaluate is one you end up rubber-stamping. */}
      <ApprovalContextPanel cardId={card.id} />
      {/* WHAT YOU ARE ACTUALLY DECIDING, in English. This line used to read
          `action effect.email.send on external_effect/eff_01J… · requested by HUMAN/fu_sequoia_taylor`
          — six facts, all true, none of them readable, on the one page where a Managing Partner
          makes the firm's binding decisions. Every one of those keys has a human name written down
          in the action registries; the page had simply never joined to them. */}
      <p className="small">
        <strong>{actionName(card.action_key)}</strong>
        {actionDescription(card.action_key) ? ` — ${actionDescription(card.action_key)}` : ""}
      </p>
      <p className="muted small">
        Asked for by {card.requested_by_type === "AI" ? card.requested_by_id : whoRequested}
        {" · "}
        {requiredRoles.length === 0
          ? "no particular role is required"
          : `only ${requiredRoles.map(roleWords).join(" or ")} can decide this`}
      </p>
      {/* The key stays, because when something goes wrong it is what you search for. */}
      <p className="muted small approval-keys">
        <code>{card.action_key}</code> on <code>{card.object_type}/{card.object_id}</code>
      </p>

      {/* WHY THE BUTTONS ARE OFF. Three disabled buttons and no reason is the same failure as an
          empty page with no explanation: the operator cannot tell whether the system is broken,
          whether they lack permission, or whether the decision has already been made. */}
      {!canDecide && (
        <p className="notice small" data-testid={`approval-why-locked-${card.id}`}>
          {card.state !== "pending_review"
            ? `Nothing to decide — this is ${approvalStateWords(card.state).label.toLowerCase()}. ${approvalStateWords(card.state).means}`
            : `This needs ${requiredRoles.map(roleWords).join(" or ")}, and you do not hold that role.`}
        </p>
      )}
      {card.state === "pending_review" && (
        <>
          <div className="form-row">
            <label>
              Decision note
              <input
                placeholder="decision note"
                aria-label={`note-${card.id}`}
                data-testid={`decision-note-${card.id}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn-primary"
              data-testid={`approve-${card.id}`}
              disabled={!canDecide}
              onClick={() => decide("approved")}
            >
              Approve
            </button>
            <button
              type="button"
              data-testid={`revise-${card.id}`}
              disabled={!canDecide}
              onClick={() => decide("revise_requested")}
            >
              Request revision
            </button>
            <button
              type="button"
              className="btn-danger"
              data-testid={`reject-${card.id}`}
              disabled={!canDecide}
              onClick={() => decide("rejected")}
            >
              Reject
            </button>
          </div>
          {/* A disabled control must say why it is disabled — never a dead button. */}
          {!canDecide && (
            <p className="notice notice-gate small" data-testid={`decision-blocked-${card.id}`}>
              You cannot decide this card. It is reserved for {requiredRoles.join(" or ") || "a role you do not hold"};
              you hold {me.roles.join(", ") || "no roles"}.
            </p>
          )}
        </>
      )}
      {decisions.length > 0 && (
        <ul className="card-list small" data-testid={`decision-history-${card.id}`}>
          {decisions.map((d) => (
            <li key={d.id}>
              <code>{d.decision}</code> by {d.decided_by}
              {d.note ? ` — ${d.note}` : ""} ({d.created_at})
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Approval state is the product's core fact: it gets a tone, not just a word. */
function approvalStateBadge(state: string): string {
  if (state === "approved" || state === "executed") return "badge badge-ok";
  if (state === "rejected" || state === "blocked") return "badge badge-bad";
  if (state === "pending_review" || state === "revise_requested") return "badge badge-gate";
  return "badge";
}

function ApprovalsPage({ me, refreshNonce }: { me: MeResponse; refreshNonce: number }) {
  const [stateFilter, setStateFilter] = useState("pending_review");
  const approvals = useApi<{ approvals: ApprovalCardRow[] }>(`/api/approvals?state=${stateFilter}`, [refreshNonce]);

  return (
    <section data-testid="approvals-page">
      <div className="form-row">
        <label>
          State{" "}
          <select data-testid="approval-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            {["pending_review", "drafted", "approved", "rejected", "revise_requested", "executed", "blocked"].map((s) => (
              <option key={s} value={s}>
                {approvalStateWords(s).label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn-ghost" onClick={() => approvals.reload()}>
          Refresh
        </button>
      </div>
      <ul className="card-list" data-testid="approval-list">
        {(approvals.data?.approvals ?? []).map((c) => (
          <ApprovalCard key={c.id} card={c} me={me} onDecided={() => approvals.reload()} />
        ))}
      </ul>
      {!approvals.loading && (approvals.data?.approvals ?? []).length === 0 && (
        <p className="state-message" data-testid="approvals-empty">
          No approval cards in state {stateFilter}. Cards arrive here when a reserved action is requested — from a work
          card, a transaction, an LP claim, an allocation option, or a policy change. Nothing executes without one.
        </p>
      )}
    </section>
  );
}

function ActivityPage({ refreshNonce }: { me: MeResponse; refreshNonce: number }) {
  const activity = useApi<{ events: ActivityEvent[] }>("/api/activity?limit=100", [refreshNonce]);
  return (
    <section data-testid="activity-page">
      <div className="table-wrap">
        <table data-testid="activity-feed">
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Actor</th>
              <th>Object</th>
            </tr>
          </thead>
          <tbody>
            {(activity.data?.events ?? []).map((e) => (
              <tr key={e.id} data-testid={`activity-event-${e.event_type}`}>
                <td>{new Date(e.created_at).toLocaleString()}</td>
                <td>
                  <code>{e.event_type}</code>
                </td>
                <td className="mono">
                  {actorName(e.actor_id)}
                </td>
                <td className="mono">
                  {e.object_type}/{e.object_id}
                </td>
              </tr>
            ))}
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
        <h3>What this page is for</h3>
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
            setMessage(status === 201 ? `Issued ${data!.id}` : `Failed: ${data?.error ?? status}`);
            if (status === 201) {
              setTitle("");
              setBody("");
              updates.reload();
            }
          }}
        >
          <h3>Issue governance update (MP only)</h3>
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
      <h3>Run AI task (governed boundary)</h3>
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
            <select data-testid="ai-sensitivity" value={sensitivity} onChange={(e) => setSensitivity(e.target.value)}>
              {["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED", "LP_PRIVATE", "MNPI_SENSITIVE", "BANKING_RESTRICTED"].map((l) => (
                <option key={l} value={l}>
                  {l}
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

      <h3>
        Policy: <code>{budget.data?.policy.privacy_mode ?? "…"}</code> privacy · <code>{budget.data?.policy.cost_mode ?? "…"}</code> cost
        {budget.data ? ` · today $${budget.data.today.spent_usd.toFixed(4)} / $${budget.data.today.daily_cap_usd}` : ""}
      </h3>

      <h3>Providers (kill switch is MP-only, logged via approval receipt)</h3>
      <ul data-testid="ai-provider-list" className="card-list">
        {(providers.data?.providers ?? []).map((p) => (
          <li key={p.provider_key} className="card" data-testid={`provider-${p.provider_key}`}>
            <p>
              <strong>{p.display_name}</strong> — enabled: <code>{p.enabled ? "yes" : "no"}</code> · kill-switched:{" "}
              <code data-testid={`provider-ks-${p.provider_key}`}>{p.kill_switched ? "yes" : "no"}</code>
            </p>
            {isMp && !p.kill_switched && (
              <button type="button" data-testid={`kill-switch-${p.provider_key}`} onClick={() => killSwitch(p.provider_key)}>
                Kill switch
              </button>
            )}
          </li>
        ))}
      </ul>

      <h3>AI runs</h3>
      <button type="button" className="btn-ghost" onClick={() => runs.reload()}>
        Refresh
      </button>
      <ul data-testid="ai-run-list" className="card-list">
        {(runs.data?.runs ?? []).map((r) => (
          <li key={r.id} className="card" data-testid={`ai-run-${r.id}`}>
            <p>
              <strong>{r.purpose}</strong> — <code>{r.status}</code> · {r.sensitivity} · {r.privacy_mode}/{r.cost_mode}
            </p>
            <p>
              trace <code>{r.trace_id}</code> · model {r.model ?? "none"}
              {r.output_quarantine ? " · output QUARANTINED" : ""}
            </p>
            {r.failure_reason && <p data-testid={`ai-run-reason-${r.id}`}>reason: {r.failure_reason}</p>}
          </li>
        ))}
      </ul>
      {(runs.data?.runs ?? []).length === 0 && <p className="state-empty">No AI runs yet. Every run is governed: it needs a purpose, a sensitivity, and a privacy mode, and it is recorded here with its trace id.</p>}
    </section>
  );
}

function DiagnosticsPage() {
  const health = useApi<HealthResponse>("/api/health");
  const volume = useApi<ApprovalVolume>("/api/diagnostics/approval-volume");
  return (
    <section data-testid="diagnostics-page">
      <h3>System health</h3>
      {health.status === 200 && health.data ? (
        <div data-testid="health-panel">
          <p>
            API: <strong>{health.data.ok ? "OK" : "DEGRADED"}</strong> — env <code>{health.data.env}</code>, schema{" "}
            <code>{health.data.d1.schemaVersion ?? "none"}</code>
          </p>
          <ul>
            {Object.entries(health.data.bindings).map(([name, present]) => (
              <li key={name}>
                {name}: {present ? "bound" : "absent (degraded)"}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p>Health check failed (HTTP {health.status ?? "network error"}).</p>
      )}

      <h3>Approval volume (D7 — observational; target ≤ {volume.data?.targetPerDay ?? 15}/day)</h3>
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
      <h4>Weekly rollup</h4>
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
      <h3>{company.canonical_name} — evidence summary</h3>
      {summary.data && (
        <div className="card" data-testid="evidence-summary">
          <p data-testid="summary-claims-by-status">
            {Object.entries(summary.data.claims_by_status)
              .map(([s, n]) => `${s}: ${n}`)
              .join(" · ")}
          </p>
          <h4>Unresolved material contradictions (HIGH/CRITICAL, OPEN/INVESTIGATING)</h4>
          <ul data-testid="unresolved-contradictions">
            {summary.data.unresolved_material_contradictions.map((c) => (
              <li key={c.id} data-testid={`summary-contradiction-${c.id}`}>
                <code>{c.materiality}</code> <code>{c.status}</code> {c.topic}
                <ResolveContradictionForm contradiction={c} onDone={reloadAll} />
              </li>
            ))}
            {summary.data.unresolved_material_contradictions.length === 0 && <li className="state-empty" data-testid="no-material-contradictions">None.</li>}
          </ul>
        </div>
      )}

      <h4>Add claim (source provenance required)</h4>
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

      <h4>Claims</h4>
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

      <h4>Detect contradictions (deterministic; humans decide)</h4>
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
              <code>{cand.contradiction_type}</code> {cand.rationale}{" "}
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
      </ul>
      {selected && <CompanyDetail company={selected} me={me} />}
    </section>
  );
}

function DocumentsPage() {
  const documents = useApi<{ documents: DocumentRow[] }>("/api/documents");
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
      <ul data-testid="document-list" className="card-list">
        {(documents.data?.documents ?? []).map((d) => (
          <li key={d.id} className="card" data-testid={`document-${d.id}`}>
            <strong>{d.title}</strong> — {d.doc_type} · {d.privacy_label}{" "}
            <button type="button" data-testid={`download-${d.id}`} onClick={() => download(d.id, d.title)}>
              Download
            </button>
          </li>
        ))}
        {(documents.data?.documents ?? []).length === 0 && <li className="state-empty">No documents yet. Upload one above — it is stored in R2 with a SHA-256 that must match on download.</li>}
      </ul>
    </section>
  );
}

function ContradictionsPage() {
  const contradictions = useApi<{ contradictions: ContradictionRow[] }>("/api/contradictions");
  return (
    <section data-testid="contradictions-page">
      <button type="button" className="btn-ghost" onClick={() => contradictions.reload()}>
        Refresh
      </button>
      <ul data-testid="contradiction-list" className="card-list">
        {(contradictions.data?.contradictions ?? []).map((c) => (
          <li key={c.id} className="card" data-testid={`contradiction-${c.id}`}>
            <p>
              <strong>{c.topic}</strong> — <code>{c.contradiction_type}</code> · <code data-testid={`contradiction-status-${c.id}`}>{c.status}</code> ·{" "}
              {c.materiality}
            </p>
            {c.human_disposition_by && <p>disposition by {c.human_disposition_by}</p>}
            <ResolveContradictionForm contradiction={c} onDone={() => contradictions.reload()} />
          </li>
        ))}
        {(contradictions.data?.contradictions ?? []).length === 0 && <li className="state-empty">No contradictions recorded. They open automatically when two sourced claims disagree on a value, a period, or a definition.</li>}
      </ul>
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
            class {p.security_class_id} — qty {p.quantity} · basis {p.cost_basis} · <code>{p.status}</code>
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
        IC packet <code>{p.id}</code> — <code data-testid="ic-packet-status">{p.status}</code> · drafted by {p.drafted_by_type}
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
              <code>{d.decision}</code> by {d.decided_by} — {d.rationale ?? "no rationale"}
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

function InvestmentPage({ me }: { me: MeResponse }) {
  const companies = useApi<{ companies: CompanyRow[] }>("/api/companies");
  const [companyId, setCompanyId] = useState("");
  const opportunities = useApi<{ opportunities: OpportunityRow[] }>(companyId ? `/api/opportunities?company_id=${companyId}` : null, [companyId]);
  const [title, setTitle] = useState("");
  const [dealType, setDealType] = useState("EARLY_STAGE_PRIMARY");
  // Provenance is captured HERE rather than on a later screen. "Where did we meet them" is
  // recoverable from memory for about a week; make it a separate errand and it never gets recorded.
  const [origin, setOrigin] = useState("UNRECORDED");
  const [relStartedAt, setRelStartedAt] = useState("");
  const [selected, setSelected] = useState<OpportunityRow | null>(null);
  const [packet, setPacket] = useState<DealMathPacketRow | null>(null);
  const [icPacketId, setIcPacketId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  void me;

  return (
    <section data-testid="investment-page">
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
          Company{" "}
          <select data-testid="opportunity-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">— select —</option>
            {(companies.data?.companies ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.canonical_name}
              </option>
            ))}
          </select>
        </label>
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

      {companyId && <Company360Panel key={`${companyId}-${nonce}`} companyId={companyId} />}

      <h4>Opportunities</h4>
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
        {(opportunities.data?.opportunities ?? []).length === 0 && <li className="state-empty" data-testid="no-opportunities">No opportunities. Create one against a canonical company to start the investment record.</li>}
      </ul>

      {selected && (
        <div data-testid="opportunity-detail">
          <h4>{selected.title} — deal math and IC</h4>
          <div className="form-row">
            <button
              type="button"
              data-testid="deal-math-create"
              onClick={async () => {
                // Manual entry is ALWAYS available (D6); the CALCULATED path is a separate step.
                const { status, data } = await api<DealMathPacketRow & { error?: string }>(`/api/opportunities/${selected.id}/deal-math`, {
                  method: "POST",
                  body: {
                    deal_type: selected.opportunity_type,
                    source_inputs: {
                      check_size: 1000000,
                      round_size: 5000000,
                      pre_money: 20000000,
                      exit_value: 500000000,
                      future_dilution_pct: 30,
                      hold_years: 7,
                      fund_size: 30000000,
                    },
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
          {icPacketId && <IcPacketPanel packetId={icPacketId} onChanged={() => setNonce((n) => n + 1)} />}
          {icPacketId && <IcPortalPage packetId={icPacketId} />}
        </div>
      )}
      <DealProvenance />
    </section>
  );
}

// ── P7: meetings ──

interface MeetingListRow {
  id: string;
  title: string;
  meeting_type: string;
  status: string;
  company_id: string | null;
  recording_enabled: number;
}

interface MeetingDetailRow extends MeetingListRow {
  consent_current: Record<string, { id: string; state: string; basis: string } | null>;
  consent_history: Array<{ id: string; consent_type: string; state: string; created_at: string }>;
  notes: Array<{ id: string; note_type: string; body: string; author_type: string }>;
  commitments: Array<{ id: string; commitment_text: string; status: string; work_card_id: string | null }>;
  debriefs: Array<{ id: string; summary: string }>;
  transcript_imports: Array<{ id: string; status: string; refusal_reason: string | null; source: string }>;
  prep_packets: Array<{ id: string; unresolved_contradictions_json: string }>;
}

function MeetingDetail({ meetingId }: { meetingId: string }) {
  const meeting = useApi<MeetingDetailRow>(`/api/meetings/${meetingId}`, [meetingId]);
  const [noteBody, setNoteBody] = useState("");
  const [noteType, setNoteType] = useState("MANUAL");
  const [commitmentText, setCommitmentText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  if (!meeting.data) return <p>Loading meeting…</p>;
  const m = meeting.data;
  const transcription = m.consent_current.TRANSCRIPTION;

  const post = async (path: string, body: unknown, okStatus: number, label: string) => {
    const { status, data } = await api<{ error?: string; detail?: string }>(path, { method: "POST", body });
    setMessage(status === okStatus ? `${label} ok.` : `${label} refused: ${(data as { error?: string })?.error ?? status}`);
    meeting.reload();
  };

  return (
    <div data-testid="meeting-detail">
      <h4>
        {m.title} — <code data-testid="meeting-status">{m.status}</code> · recording{" "}
        <code data-testid="meeting-recording">{m.recording_enabled === 1 ? "ACTIVE" : "NOT ACTIVATED"}</code> · transcription consent{" "}
        <code data-testid="meeting-consent">{transcription?.state ?? "NOT RECORDED"}</code>
      </h4>

      <div className="form-row">
        <button
          type="button"
          data-testid="consent-grant"
          onClick={() =>
            post(
              `/api/meetings/${m.id}/consent`,
              { consent_type: "TRANSCRIPTION", state: "GRANTED", basis: "verbal consent recorded on the call", granted_by: "counterparty" },
              201,
              "Consent GRANTED",
            )
          }
        >
          Record consent: GRANTED
        </button>
        <button
          type="button"
          data-testid="consent-revoke"
          onClick={() => post(`/api/meetings/${m.id}/consent`, { consent_type: "TRANSCRIPTION", state: "REVOKED", basis: "counterparty revoked" }, 201, "Consent REVOKED")}
        >
          Revoke consent
        </button>
        {/* Both gates are independent: this attempt is refused (and recorded) unless
            the recording policy was activated through an approved receipt. */}
        <button type="button" data-testid="transcript-import" onClick={() => post(`/api/meetings/${m.id}/transcript`, { source: "transcription export" }, 201, "Transcript import")}>
          Import transcript
        </button>
        <button type="button" data-testid="prep-assemble" onClick={() => post(`/api/meetings/${m.id}/prep`, { open_questions: ["What is the authoritative ARR?"] }, 201, "Prep packet")}>
          Assemble prep packet
        </button>
      </div>

      <form
        className="form-row"
        data-testid="note-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await post(`/api/meetings/${m.id}/notes`, { note_type: noteType, body: noteBody }, 201, "Note");
          setNoteBody("");
        }}
      >
        <select data-testid="note-type" aria-label="Kind of note" value={noteType} onChange={(e) => setNoteType(e.target.value)}>
          {["MANUAL", "OFF_RECORD"].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <input data-testid="note-body" aria-label="What the update says" value={noteBody} onChange={(e) => setNoteBody(e.target.value)} placeholder="meeting note" />
        <button type="submit" className="btn-strong" data-testid="note-submit">
          Add note
        </button>
      </form>

      <form
        className="form-row"
        data-testid="commitment-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await post(`/api/meetings/${m.id}/commitments`, { commitment_text: commitmentText, owner_side: "FIRM" }, 201, "Commitment");
          setCommitmentText("");
        }}
      >
        <input data-testid="commitment-text" aria-label="What you need, in your own words" value={commitmentText} onChange={(e) => setCommitmentText(e.target.value)} placeholder="commitment made in the meeting" />
        <button type="submit" className="btn-strong" data-testid="commitment-submit">
          Record commitment
        </button>
      </form>

      <ul data-testid="commitment-list" className="card-list">
        {m.commitments.map((c) => (
          <li key={c.id} className="card" data-testid={`commitment-${c.id}`}>
            {c.commitment_text} — <code>{c.status}</code>
            {c.work_card_id ? ` · work card ${c.work_card_id}` : ""}
            {c.status === "OPEN" && (
              <button type="button" data-testid={`commitment-convert-${c.id}`} onClick={() => post(`/api/meeting-commitments/${c.id}/convert`, {}, 200, "Converted to work card")}>
                Convert to work card
              </button>
            )}
          </li>
        ))}
        {m.commitments.length === 0 && <li className="state-empty" data-testid="no-commitments">No commitments.</li>}
      </ul>

      <ul data-testid="note-list">
        {m.notes.map((n) => (
          <li key={n.id} data-testid={`note-${n.id}`}>
            <code>{n.note_type}</code> {n.body} ({n.author_type})
          </li>
        ))}
      </ul>

      <ul data-testid="transcript-list">
        {m.transcript_imports.map((tr) => (
          <li key={tr.id} data-testid={`transcript-${tr.id}`}>
            <code>{tr.status}</code> {tr.source}
            {tr.refusal_reason ? ` — ${tr.refusal_reason}` : ""}
          </li>
        ))}
        {m.transcript_imports.length === 0 && <li className="state-empty" data-testid="no-transcripts">No transcript imports.</li>}
      </ul>

      <LiveHelpPanel meetingId={m.id} />
      <CloseoutPanel meetingId={m.id} />

      {message && <p className="notice" data-testid="meeting-message">{message}</p>}
    </div>
  );
}

function MeetingsPage({ me }: { me: MeResponse }) {
  const meetings = useApi<{ meetings: MeetingListRow[] }>("/api/meetings");
  const companies = useApi<{ companies: CompanyRow[] }>("/api/companies");
  const [title, setTitle] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  void me;

  return (
    <section data-testid="meetings-page">
      <form
        className="form-row"
        data-testid="meeting-create-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const { status, data } = await api<MeetingListRow & { error?: string }>("/api/meetings", {
            method: "POST",
            body: { title, meeting_type: "FOUNDER", company_id: companyId || undefined, occurred_at: new Date().toISOString() },
          });
          setMessage(status === 201 ? `Meeting ${data!.id} recorded.` : `Create refused: ${data?.error ?? status}`);
          if (status === 201) {
            setTitle("");
            meetings.reload();
          }
        }}
      >
        <label>
          Title <input data-testid="meeting-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Company{" "}
          <select data-testid="meeting-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">— none —</option>
            {(companies.data?.companies ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.canonical_name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-strong" data-testid="meeting-create-submit">
          Record meeting
        </button>
        {message && <span data-testid="meetings-message">{message}</span>}
      </form>

      <ul className="card-list" data-testid="meeting-list">
        {(meetings.data?.meetings ?? []).map((m) => (
          <li key={m.id} className="card" data-testid={`meeting-${m.id}`}>
            <button type="button" className="link-button" data-testid={`meeting-open-${m.id}`} onClick={() => setSelected(m.id)}>
              {m.title}
            </button>{" "}
            — <code>{m.meeting_type}</code> <code>{m.status}</code>
          </li>
        ))}
        {(meetings.data?.meetings ?? []).length === 0 && <li className="state-empty" data-testid="no-meetings">No meetings.</li>}
      </ul>

      {selected && <MeetingDetail meetingId={selected} />}
    </section>
  );
}

// ── P8: portfolio monitoring and support ──

interface AlertRow {
  id: string;
  company_id: string;
  alert_type: string;
  metric_key: string | null;
  severity: string;
  status: string;
  occurrence_count: number;
  escalated_from: string | null;
  detail_json: string;
}

interface SupportRequestRow {
  id: string;
  company_id: string;
  request_type: string;
  description: string;
  status: string;
  matches?: Array<{ id: string; target_label: string; status: string; proposed_by_type: string; approval_card_id: string | null }>;
  outcomes?: Array<{ id: string; outcome_type: string; value_note: string | null; relationship_note: string | null }>;
}

function PortfolioPage({ me }: { me: MeResponse }) {
  const companies = useApi<{ companies: CompanyRow[] }>("/api/companies");
  const [companyId, setCompanyId] = useState("");
  const [nonce, setNonce] = useState(0);
  const alerts = useApi<{ alerts: AlertRow[] }>(companyId ? `/api/portfolio/alerts?company_id=${companyId}` : "/api/portfolio/alerts", [companyId, nonce]);
  const requests = useApi<{ support_requests: SupportRequestRow[] }>(companyId ? `/api/support/requests?company_id=${companyId}` : "/api/support/requests", [companyId, nonce]);
  const [metricKey, setMetricKey] = useState("arr");
  const [asOf, setAsOf] = useState("2026-01-31");
  const [value, setValue] = useState("100");
  const [message, setMessage] = useState<string | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<string | null>(null);
  void me;

  const post = async (path: string, body: unknown, okStatus: number, label: string) => {
    const { status, data } = await api<{ error?: string }>(path, { method: "POST", body });
    setMessage(status === okStatus ? `${label} ok.` : `${label} refused: ${data?.error ?? status}`);
    setNonce((n) => n + 1);
    return { status, data };
  };

  return (
    <section data-testid="portfolio-page">
      <form
        className="form-row"
        data-testid="metric-definition-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await post(
            "/api/portfolio/metric-definitions",
            { metric_key: metricKey, name: metricKey.toUpperCase(), direction: "HIGHER_IS_BETTER", severity_bands: { MEDIUM: 5, HIGH: 15, CRITICAL: 30 }, stale_after_days: 120 },
            201,
            "Metric definition",
          );
        }}
      >
        <label>
          Company{" "}
          <select data-testid="portfolio-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">— select —</option>
            {(companies.data?.companies ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.canonical_name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Metric <input data-testid="metric-key" value={metricKey} onChange={(e) => setMetricKey(e.target.value)} />
        </label>
        <button type="submit" className="btn-strong" data-testid="metric-define">
          Define metric (operator bands)
        </button>
      </form>

      <form
        className="form-row"
        data-testid="snapshot-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await post(
            "/api/portfolio/snapshots",
            { company_id: companyId, metric_key: metricKey, as_of_date: asOf, value: Number(value), source: "portfolio update" },
            201,
            "Snapshot",
          );
        }}
      >
        <label>
          As of <input data-testid="snapshot-date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
        <label>
          Value <input data-testid="snapshot-value" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <button type="submit" className="btn-strong" data-testid="snapshot-submit">
          Record dated snapshot
        </button>
        <button type="button" data-testid="evaluate-alerts" onClick={() => post(`/api/portfolio/companies/${companyId}/evaluate`, {}, 201, "Evaluation")}>
          Evaluate alerts
        </button>
        {message && <span data-testid="portfolio-message">{message}</span>}
      </form>

      <h4>Alerts</h4>
      <ul className="card-list" data-testid="alert-list">
        {(alerts.data?.alerts ?? []).map((a) => (
          <li key={a.id} className="card" data-testid={`alert-${a.id}`}>
            <code>{a.alert_type}</code> <code data-testid={`alert-severity-${a.id}`}>{a.severity}</code> <code>{a.status}</code> · {a.metric_key ?? "—"} · seen{" "}
            {a.occurrence_count}×{a.escalated_from ? ` · escalated from ${a.escalated_from}` : ""}
            <button type="button" data-testid={`alert-ack-${a.id}`} onClick={() => post(`/api/portfolio/alerts/${a.id}/decide`, { to: "ACKNOWLEDGED" }, 200, "Alert acknowledged")}>
              Acknowledge
            </button>
            <button
              type="button"
              data-testid={`alert-support-${a.id}`}
              onClick={() =>
                post(
                  "/api/support/requests",
                  { company_id: a.company_id, request_type: "OPERATIONS", description: `Support triggered by ${a.alert_type} on ${a.metric_key ?? "portfolio"}`, alert_id: a.id },
                  201,
                  "Support request",
                )
              }
            >
              Open support request
            </button>
          </li>
        ))}
        {(alerts.data?.alerts ?? []).length === 0 && <li className="state-empty" data-testid="no-alerts">No alerts.</li>}
      </ul>

      <h4>Support requests</h4>
      <ul className="card-list" data-testid="support-list">
        {(requests.data?.support_requests ?? []).map((r) => (
          <li key={r.id} className="card" data-testid={`support-${r.id}`}>
            {r.description} — <code>{r.status}</code>
            <button type="button" data-testid={`support-open-${r.id}`} onClick={() => setSelectedRequest(r.id)}>
              Open
            </button>
          </li>
        ))}
        {(requests.data?.support_requests ?? []).length === 0 && <li className="state-empty" data-testid="no-support-requests">No support requests.</li>}
      </ul>

      {selectedRequest && <SupportRequestDetail requestId={selectedRequest} onChanged={() => setNonce((n) => n + 1)} />}
    </section>
  );
}

function SupportRequestDetail({ requestId, onChanged }: { requestId: string; onChanged: () => void }) {
  const request = useApi<SupportRequestRow>(`/api/support/requests/${requestId}`, [requestId]);
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  if (!request.data) return <p>Loading support request…</p>;
  const r = request.data;

  const post = async (path: string, body: unknown, okStatus: number, label: string) => {
    const { status, data } = await api<{ error?: string; approval_card_id?: string }>(path, { method: "POST", body });
    setMessage(status === okStatus ? `${label} ok${data?.approval_card_id ? ` — approval card ${data.approval_card_id}` : ""}.` : `${label} refused: ${data?.error ?? status}`);
    request.reload();
    onChanged();
  };

  return (
    <div data-testid="support-detail">
      <h4>{r.description}</h4>
      <form
        className="form-row"
        data-testid="match-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await post(`/api/support/requests/${r.id}/matches`, { match_type: "PERSON", target_label: target, rationale: "proposed from the firm network" }, 201, "Match proposed");
          setTarget("");
        }}
      >
        <input data-testid="match-target" aria-label="Who or what to match against" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="who could help" />
        <button type="submit" className="btn-strong" data-testid="match-submit">
          Propose match
        </button>
      </form>
      <ul data-testid="match-list">
        {(r.matches ?? []).map((m) => (
          <li key={m.id} data-testid={`match-${m.id}`}>
            {m.target_label} — <code data-testid={`match-status-${m.id}`}>{m.status}</code> · proposed by {m.proposed_by_type}
            {m.approval_card_id ? ` · introduction approval ${m.approval_card_id}` : ""}
            {m.status === "PROPOSED" && (
              <button type="button" data-testid={`match-accept-${m.id}`} onClick={() => post(`/api/support/matches/${m.id}/decide`, { decision: "ACCEPTED" }, 200, "Match accepted")}>
                Accept (opens MP introduction approval)
              </button>
            )}
          </li>
        ))}
        {(r.matches ?? []).length === 0 && <li className="state-empty" data-testid="no-matches">No matches proposed.</li>}
      </ul>
      <form
        className="form-row"
        data-testid="outcome-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await post(
            `/api/support/requests/${r.id}/outcomes`,
            { outcome_type: "PARTIALLY_HELPED", value_note: "one intro converted", relationship_note: "founder felt supported" },
            201,
            "Outcome recorded",
          );
        }}
      >
        <button type="submit" className="btn-strong" data-testid="outcome-submit">
          Record outcome
        </button>
      </form>
      <ul data-testid="outcome-list">
        {(r.outcomes ?? []).map((o) => (
          <li key={o.id} data-testid={`outcome-${o.id}`}>
            <code>{o.outcome_type}</code> {o.value_note} · {o.relationship_note}
          </li>
        ))}
      </ul>
      {message && <p className="notice" data-testid="support-message">{message}</p>}
    </div>
  );
}

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

  const d = queue.data;
  if (!d || d.count === 0) return null;

  return (
    <section className="card" data-testid="unresolved-people">
      <h3>
        Not in Network OS <span className="module-count">{d.count}</span>
      </h3>
      <p className="muted small">{d.why}</p>
      <ul className="card-list small">
        {d.people.map((p) => (
          <li key={p.capture_id} data-testid={`unresolved-${p.person_id}`}>
            <strong>{p.full_name}</strong>
            {p.organization ? ` — ${p.organization}` : ""}
            {p.email ? ` · ${p.email}` : ""}
            <span className="muted small"> · met {readableDate(p.resolved_at)}</span>
          </li>
        ))}
      </ul>
      <p className="muted small">{d.next_step}</p>
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

      <h4>Local fixture sync (no live system)</h4>
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

function LpPage({ me }: { me: MeResponse }) {
  const [nonce, setNonce] = useState(0);
  const records = useApi<{ lp_records: LpRecordRow[] }>("/api/lp/records", [nonce]);
  const claims = useApi<{ lp_claims: LpClaimRow[] }>("/api/lp/claims", [nonce]);
  const artifacts = useApi<{ artifacts: ArtifactRow[]; vdr_state: string }>("/api/lp/data-room/artifacts", [nonce]);
  const access = useApi<{ access_records: AccessRow[] }>("/api/lp/data-room/access", [nonce]);
  const verified = useApi<{ claims: ClaimRow[] }>("/api/claims?status=VERIFIED", [nonce]);
  const [lpName, setLpName] = useState("");
  const [claimText, setClaimText] = useState("");
  const [selectedClaim, setSelectedClaim] = useState("");
  const [evidenceId, setEvidenceId] = useState("");
  const [receiptId, setReceiptId] = useState("");
  const [artifactTitle, setArtifactTitle] = useState("");
  const [recipient, setRecipient] = useState("cio@example.com");
  const [grantReceipt, setGrantReceipt] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  void me;

  const post = async <T,>(path: string, body: unknown, okStatus: number, label: string): Promise<{ status: number; data: (T & { error?: string }) | null }> => {
    const { status, data } = await api<T & { error?: string }>(path, { method: "POST", body });
    setMessage(status === okStatus ? `${label} ok.` : `${label} refused: ${data?.error ?? status}`);
    setNonce((n) => n + 1);
    return { status, data };
  };

  return (
    <section data-testid="lp-page">
      <p className="notice notice-gate" data-testid="vdr-state">{artifacts.data?.vdr_state ?? "…"}</p>

      <h4>LP records (LP_PRIVATE)</h4>
      <form
        className="form-row"
        data-testid="lp-record-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await post("/api/lp/records", { legal_name: lpName, lp_type: "FAMILY_OFFICE" }, 201, "LP record");
        }}
      >
        <label>
          Legal name <input data-testid="lp-record-name" value={lpName} onChange={(ev) => setLpName(ev.target.value)} />
        </label>
        <button type="submit" className="btn-strong" data-testid="lp-record-submit">
          Record LP
        </button>
      </form>
      <ul className="card-list" data-testid="lp-record-list">
        {(records.data?.lp_records ?? []).map((r) => (
          <li key={r.id} className="card" data-testid={`lp-record-${r.id}`}>
            {r.legal_name} — <code>{r.lp_type}</code> <code>{r.status}</code>
          </li>
        ))}
        {(records.data?.lp_records ?? []).length === 0 && <li className="state-empty" data-testid="no-lp-records">No LP records visible to you.</li>}
      </ul>

      <h4>LP claims — evidence-backed or unpublishable</h4>
      <form
        className="form-row"
        data-testid="lp-claim-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const { status, data } = await post<{ id: string }>("/api/lp/claims", { claim_text: claimText, claim_type: "TRACK_RECORD" }, 201, "LP claim draft");
          if (status === 201 && data) setSelectedClaim(data.id);
        }}
      >
        <label>
          Claim <input data-testid="lp-claim-text" value={claimText} onChange={(ev) => setClaimText(ev.target.value)} />
        </label>
        <button type="submit" className="btn-strong" data-testid="lp-claim-submit">
          Draft claim
        </button>
      </form>

      <form
        className="form-row"
        data-testid="lp-evidence-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await post("/api/lp/claims/" + selectedClaim + "/evidence", { evidence_type: "DILIGENCE_CLAIM", evidence_ref_id: evidenceId }, 201, "Evidence link");
        }}
      >
        <label>
          Working claim{" "}
          <select data-testid="lp-claim-select" value={selectedClaim} onChange={(ev) => setSelectedClaim(ev.target.value)}>
            <option value="">— select —</option>
            {(claims.data?.lp_claims ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.claim_text.slice(0, 48)} ({c.status})
              </option>
            ))}
          </select>
        </label>
        <label>
          VERIFIED evidence{" "}
          <select data-testid="lp-evidence-select" value={evidenceId} onChange={(ev) => setEvidenceId(ev.target.value)}>
            <option value="">— select —</option>
            {(verified.data?.claims ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.claim_text.slice(0, 48)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-strong" data-testid="lp-evidence-link">
          Link evidence
        </button>
      </form>

      <div className="form-row" data-testid="lp-claim-actions">
        <button
          type="button"
          data-testid="lp-claim-submit-review"
          onClick={async () => {
            const { status, data } = await post<{ approval_card_id: string }>(`/api/lp/claims/${selectedClaim}/submit`, {}, 200, "Submit for review");
            if (status === 200 && data) setReceiptId(data.approval_card_id);
          }}
        >
          Submit for compliance review
        </button>
        <label>
          Approval receipt <input data-testid="lp-publish-receipt" value={receiptId} onChange={(ev) => setReceiptId(ev.target.value)} />
        </label>
        <button
          type="button"
          data-testid="lp-claim-publish"
          onClick={() => post(`/api/lp/claims/${selectedClaim}/publish`, receiptId ? { approval_receipt_id: receiptId } : {}, 200, "Publish")}
        >
          Publish
        </button>
      </div>
      {message && <p className="notice" data-testid="lp-message">{message}</p>}

      <ul className="card-list" data-testid="lp-claim-list">
        {(claims.data?.lp_claims ?? []).map((c) => (
          <li key={c.id} className="card" data-testid={`lp-claim-${c.id}`}>
            {c.claim_text} — <code data-testid={`lp-claim-status-${c.id}`}>{c.status}</code> · drafted by {c.drafted_by_type}
          </li>
        ))}
        {(claims.data?.lp_claims ?? []).length === 0 && <li className="state-empty" data-testid="no-lp-claims">No LP claims. A claim must be drafted, evidenced by a VERIFIED diligence claim, reviewed, and receipted before it can be published.</li>}
      </ul>

      <h4>Data room — the room is EXTERNAL; this is the record of what was shared</h4>
      <form
        className="form-row"
        data-testid="artifact-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await post(
            "/api/lp/data-room/artifacts",
            {
              title: artifactTitle,
              version: 1,
              status: "READY",
              lp_claim_ids: selectedClaim ? [selectedClaim] : [],
              provider_ref: "external-vdr://folder/pending-provider-selection",
            },
            201,
            "Artifact",
          );
        }}
      >
        <label>
          Title <input data-testid="artifact-title" value={artifactTitle} onChange={(ev) => setArtifactTitle(ev.target.value)} />
        </label>
        <button type="submit" className="btn-strong" data-testid="artifact-create">
          Register artifact (attaches the selected claim)
        </button>
      </form>
      <ul className="card-list" data-testid="artifact-list">
        {(artifacts.data?.artifacts ?? []).map((a) => (
          <li key={a.id} className="card" data-testid={`artifact-${a.id}`}>
            {a.title} v{a.version} — <code>{a.status}</code>
            <div className="form-row">
              <label>
                Recipient <input data-testid={`grant-recipient-${a.id}`} value={recipient} onChange={(ev) => setRecipient(ev.target.value)} />
              </label>
              <label>
                Send receipt <input data-testid={`grant-receipt-${a.id}`} value={grantReceipt} onChange={(ev) => setGrantReceipt(ev.target.value)} />
              </label>
              <button
                type="button"
                data-testid={`grant-access-${a.id}`}
                onClick={() =>
                  post(
                    "/api/lp/data-room/access",
                    {
                      artifact_id: a.id,
                      recipient_label: recipient,
                      permission: "VIEW",
                      expires_at: "2099-01-01T00:00:00.000Z",
                      ...(grantReceipt ? { approval_receipt_id: grantReceipt } : {}),
                    },
                    201,
                    "Access grant",
                  )
                }
              >
                Grant recorded access
              </button>
            </div>
          </li>
        ))}
        {(artifacts.data?.artifacts ?? []).length === 0 && <li className="state-empty" data-testid="no-artifacts">No artifacts.</li>}
      </ul>

      <h4>Access ledger (append-only; revocation is a new record)</h4>
      <ul className="card-list" data-testid="access-ledger">
        {(access.data?.access_records ?? []).map((r) => (
          <li key={r.id} className="card" data-testid={`access-${r.id}`}>
            {r.recipient_label} · v{r.artifact_version} · <code>{r.permission}</code> ·{" "}
            <code data-testid={`access-status-${r.id}`}>{r.effective_status}</code>
            {r.effective_status === "ACTIVE" && (
              <button type="button" data-testid={`access-revoke-${r.id}`} onClick={() => post(`/api/lp/data-room/access/${r.id}/revoke`, { reason: "engagement ended" }, 201, "Revocation")}>
                Revoke
              </button>
            )}
          </li>
        ))}
        {(access.data?.access_records ?? []).length === 0 && <li className="state-empty" data-testid="no-access-records">Nothing has been shared.</li>}
      </ul>
    </section>
  );
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
            const { data } = await api<{ versions: Array<{ id: string }> }>(`/api/funds/${fundId}/policies/${kind}`);
            const latest = (data?.versions ?? []).at(-1);
            if (!latest) {
              setMessage(`Scenario refused: fund has no ${kind} policy version yet.`);
              return;
            }
            pins[kind] = latest.id;
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
              fund_size: 30000000,
              investable: 24000000,
              fund_deployed: 10000000,
              reserve_modeled_need: 8000000,
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
          <h5>Assumptions (stated, append-only)</h5>
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

function ReportingPage({ me }: { me: MeResponse }) {
  const [nonce, setNonce] = useState(0);
  const funds = useApi<{ funds: FundRow[] }>("/api/funds");
  const periods = useApi<{ periods: PeriodRow[] }>("/api/reporting/periods", [nonce]);
  const packets = useApi<{ packets: PacketRow[]; certification_state: string }>("/api/reporting/packets", [nonce]);
  const runs = useApi<{ runs: unknown[]; source_state: string; contract_version: string }>("/api/reconciliation/runs", [nonce]);
  const exceptions = useApi<{ exceptions: ExceptionRow[] }>("/api/reconciliation/exceptions", [nonce]);
  const [packetId, setPacketId] = useState("");
  const detail = useApi<{ title: string; status: string; reviews: ReviewRow[]; outstanding: string[]; all_complete: boolean }>(
    packetId ? `/api/reporting/packets/${packetId}` : null,
    [packetId, nonce],
  );
  const [periodLabel, setPeriodLabel] = useState("");
  const [receipt, setReceipt] = useState("");
  const [adminNav, setAdminNav] = useState("31500000");
  const [internalNav, setInternalNav] = useState("31000000");
  const [message, setMessage] = useState<string | null>(null);
  void me;

  const post = async <T,>(path: string, body: unknown, okStatus: number, label: string): Promise<{ status: number; data: (T & { error?: string }) | null }> => {
    const { status, data } = await api<T & { error?: string }>(path, { method: "POST", body });
    setMessage(status === okStatus ? `${label} ok.` : `${label} refused: ${data?.error ?? status}`);
    setNonce((n) => n + 1);
    return { status, data };
  };

  return (
    <section data-testid="reporting-page">
      <p data-testid="certification-state">{packets.data?.certification_state ?? "…"}</p>

      <h4>Reporting periods and packets</h4>
      <form
        className="form-row"
        data-testid="period-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const fundId = (form.get("fund") as string) || funds.data?.funds[0]?.id;
          if (!fundId) {
            setMessage("Period refused: no fund exists yet.");
            return;
          }
          const { status, data } = await post<{ id: string }>(
            "/api/reporting/periods",
            { fund_id: fundId, label: periodLabel, period_start: "2026-01-01", period_end: "2026-03-31" },
            201,
            "Period",
          );
          if (status === 201 && data) {
            const packet = await post<{ id: string }>(`/api/reporting/periods/${data.id}/packets`, { title: `${periodLabel} LP report` }, 201, "Packet");
            if (packet.status === 201 && packet.data) setPacketId(packet.data.id);
          }
        }}
      >
        <label>
          Fund{" "}
          <select name="fund" data-testid="reporting-fund">
            {(funds.data?.funds ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Period label <input data-testid="period-label" value={periodLabel} onChange={(e) => setPeriodLabel(e.target.value)} />
        </label>
        <button type="submit" className="btn-strong" data-testid="period-create">
          Open period and draft packet
        </button>
      </form>
      <ul data-testid="period-list">
        {(periods.data?.periods ?? []).map((p) => (
          <li key={p.id} data-testid={`period-${p.id}`}>
            {p.label} — <code>{p.status}</code>
          </li>
        ))}
        {!periods.loading && (periods.data?.periods ?? []).length === 0 && (
          <li className="state-empty" data-testid="period-list-empty">
            No reporting periods open. Opening one drafts its packet; the packet then needs a review
            from each required function before it can be distributed.
          </li>
        )}
      </ul>

      <label>
        Working packet{" "}
        <select data-testid="packet-select" value={packetId} onChange={(e) => setPacketId(e.target.value)}>
          <option value="">— select —</option>
          {(packets.data?.packets ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.title} v{p.version} ({p.status})
            </option>
          ))}
        </select>
      </label>

      {detail.data && (
        <div className="card" data-testid="packet-detail">
          <p>
            {detail.data.title} — <code data-testid="packet-status">{detail.data.status}</code>
          </p>
          <p data-testid="packet-outstanding">
            Outstanding required reviews: {detail.data.outstanding.length > 0 ? detail.data.outstanding.join(", ") : "none"}
          </p>
          <ul data-testid="review-list">
            {detail.data.reviews.map((r) => (
              <li key={r.review_type} data-testid={`review-${r.review_type}`}>
                {r.review_type}: <code>{r.status}</code>
                {r.reviewer_id ? ` · ${r.reviewer_id}` : ""}
              </li>
            ))}
            {detail.data.reviews.length === 0 && <li data-testid="no-reviews">Not submitted for review yet.</li>}
          </ul>
          <div className="form-row">
            <button type="button" data-testid="packet-submit" onClick={() => post(`/api/reporting/packets/${packetId}/submit`, {}, 200, "Submit")}>
              Submit for review
            </button>
            {["FINANCE", "COMPLIANCE", "MANAGING_PARTNER"].map((reviewType) => (
              <button
                key={reviewType}
                type="button"
                data-testid={`review-record-${reviewType}`}
                onClick={() =>
                  post(`/api/reporting/packets/${packetId}/reviews`, { review_type: reviewType, status: "COMPLETED", note: `${reviewType} reviewed` }, 200, `${reviewType} review`)
                }
              >
                Record {reviewType} review
              </button>
            ))}
          </div>
          <div className="form-row">
            <label>
              Send receipt <input data-testid="distribute-receipt" value={receipt} onChange={(e) => setReceipt(e.target.value)} />
            </label>
            <button
              type="button"
              data-testid="packet-distribute"
              onClick={() =>
                post(
                  `/api/reporting/packets/${packetId}/distribute`,
                  {
                    recipients: [{ recipient_label: "lp@example.com" }],
                    delivery_note: "shared through the external data room",
                    ...(receipt ? { approval_receipt_id: receipt } : {}),
                  },
                  200,
                  "Distribution",
                )
              }
            >
              Distribute to LPs
            </button>
          </div>
        </div>
      )}
      {message && <p className="notice" data-testid="reporting-message">{message}</p>}

      <h4>Fund-administration reconciliation</h4>
      <p data-testid="reconciliation-source-state">{runs.data?.source_state ?? "…"}</p>
      <form
        className="form-row"
        data-testid="reconciliation-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const fundId = (form.get("fund") as string) || funds.data?.funds[0]?.id;
          if (!fundId) {
            setMessage("Reconciliation refused: no fund exists yet.");
            return;
          }
          await post(
            "/api/reconciliation/runs",
            {
              fund_id: fundId,
              source_system: "example_fund_administrator",
              source_reference: "quarterly export (fixture)",
              administrator_records: [{ record_kind: "NAV", record_key: "fund", field: "nav", value: adminNav }],
              internal_records: [{ record_kind: "NAV", record_key: "fund", field: "nav", value: internalNav }],
            },
            201,
            "Reconciliation",
          );
        }}
      >
        <label>
          Fund{" "}
          <select name="fund" data-testid="reconciliation-fund">
            {(funds.data?.funds ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Administrator NAV <input data-testid="admin-nav" value={adminNav} onChange={(e) => setAdminNav(e.target.value)} />
        </label>
        <label>
          Our NAV <input data-testid="internal-nav" value={internalNav} onChange={(e) => setInternalNav(e.target.value)} />
        </label>
        <button type="submit" className="btn-strong" data-testid="reconciliation-run">
          Import and compare
        </button>
      </form>

      <ul className="card-list" data-testid="exception-list">
        {(exceptions.data?.exceptions ?? []).map((x) => (
          <li key={x.id} className="card" data-testid={`exception-${x.id}`}>
            <code>{x.exception_kind}</code> {x.record_kind}/{x.record_key}.{x.field} — administrator “{x.administrator_value ?? "∅"}” vs West Peek OS “
            {x.internal_value ?? "∅"}”{x.difference !== null ? ` · difference ${x.difference}` : ""} · <code data-testid={`exception-status-${x.id}`}>{x.status}</code>
            {x.status === "OPEN" && (
              <button
                type="button"
                data-testid={`exception-escalate-${x.id}`}
                onClick={() =>
                  post(
                    `/api/reconciliation/exceptions/${x.id}/resolve`,
                    { resolution: "ESCALATE_TO_ADMINISTRATOR", note: "asked the administrator to confirm the figure" },
                    201,
                    "Escalation",
                  )
                }
              >
                Escalate to administrator
              </button>
            )}
          </li>
        ))}
        {(exceptions.data?.exceptions ?? []).length === 0 && <li className="state-empty" data-testid="no-exceptions">No reconciliation exceptions.</li>}
      </ul>
    </section>
  );
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
        {unread} unread{critical > 0 ? ` (${critical} critical)` : ""}
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

function FundStrategyPage({ me }: { me: MeResponse }): JSX.Element {
  return (
    <section data-testid="fund-strategy-page">
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
        <h2>What the portfolio is made of</h2>
        <span className="muted small">read from closed holdings, not projected</span>
      </div>
      <PortfolioComposition />
      <PortfolioAllocation />

      <div className="home-section-head">
        <h2>Modelling the next cheque</h2>
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
        <h2>Following on</h2>
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
 * nothing. Everything in here already speaks in nav keys — `onNavigate("work-cards")` — so the keys
 * were a routing table that was simply never connected to the URL.
 *
 * HASH RATHER THAN PATH, deliberately. A path needs the server to serve the app for every route;
 * the Worker already does that, but a hash cannot 404 and cannot be mistaken for an API path — and
 * `/api/...` and `/work-cards` living in the same namespace is a trap worth not setting.
 *
 * An unknown key falls back to Home rather than rendering nothing, because a stale link somebody
 * saved should land somewhere real.
 */
function keyFromHash(known: (key: string) => boolean): string {
  const raw = window.location.hash.replace(/^#\/?/, "").trim();
  return raw && known(raw) ? raw : "home";
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
          {authed && active === "intelligence" && <IntelligencePage me={me.data!} />}
          {authed && active === "employees" && <EmployeesPage me={me.data!} />}
          {authed && active === "rooms" && <RoomsPage />}
          {authed && active === "introductions" && <IntroductionsPage />}
          {authed && active === "community" && <CommunityPage />}
          {authed && active === "record" && <LedgersPage />}
          {/* Follow-on merged into Fund strategy. The route stays live. */}
          {authed && active === "follow-on" && <FundStrategyPage me={me.data!} />}
          {authed && active === "weekly-review" && <WeeklyReviewPage onNavigate={navigate} />}
          {authed && active === "cross-office" && <CrossOfficePage />}
          {authed && active === "secondaries" && <SecondariesPage onNavigate={navigate} />}
          {authed && active === "university" && <UniversityPage />}
          {authed && active === "market-map" && <MarketMapPage />}
          {authed && active === "browser-tasks" && <BrowserTasksPage me={me.data!} />}
          {authed && active === "machines" && <MachinesPage me={me.data!} />}
          {authed && active === "notifications" && <NotificationsPage me={me.data!} />}
          {authed && active === "today" && <TodayPage me={me.data!} onNavigate={navigate} />}
          {authed && active === "capture" && <CapturePage me={me.data!} onChanged={refresh} />}
          {authed && active === "intent" && <IntentPage me={me.data!} onNavigate={navigate} />}
          {authed && active === "work-cards" && (
            <>
              <WorkSurface me={me.data!} onChanged={refresh} onNavigate={navigate} />
              {/* "Runs on a schedule" read as a sentence fragment rather than a section name, and
                  nothing said where the section ended. A chevron makes it obvious that what follows
                  is the scheduled half of this page. */}
              <div className="home-section-head work-scheduled-head">
                <h2>
                  <span className="chev" aria-hidden="true" /> Scheduled work
                </h2>
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
          {authed && active === "modeling" && <ModelingPage me={me.data!} />}
          {authed && active === "investment" && (
            <>
              <DealflowPage me={me.data!} onNavigate={navigate} />
              {/* A SECTION, NOT A DRAWER. This was folded away, so the deal math, the IC assembly
                  and the company record — the tools you reach for once a deal is real — were
                  behind a disclosure most people never opened. A heading and the tool beneath it
                  is what a person expects; hiding working machinery is how it stops being used. */}
              <section data-testid="deal-records">
                <div className="home-section-head">
                  <h2>Deal records and tooling</h2>
                  <span className="muted small">acts on one deal you pick, not on the pipeline above</span>
                </div>
                <p className="muted small">
                  Deal math, IC packets and the full record behind a single company.
                </p>
                <InvestmentPage me={me.data!} />
              </section>
            </>
          )}
          {authed && active === "meetings" && (
            <>
              <MeetingsSurface me={me.data!} onNavigate={navigate} />
              {/* The older meeting record keeps prep packets, notes, debriefs and close-out —
                  real machinery that belongs to one meeting rather than to the list. */}
              <details className="card" data-testid="meeting-records">
                <summary>Meeting records and close-out</summary>
                <MeetingsPage me={me.data!} />
              </details>
            </>
          )}
          {authed && active === "portfolio" && (
            <>
              {/* Where the fund goes, before how the companies are doing: the plan is the frame
                  the positions are read against. */}
              <PortfolioAllocation />
              <PortfolioComposition />
              <PortfolioPage me={me.data!} />
            </>
          )}
          {authed && active === "cockpit" && <FundStrategyPage me={me.data!} />}
          {authed && active === "network" && <NetworkPage me={me.data!} />}
          {authed && active === "integrations" && <IntegrationsPage me={me.data!} />}
          {authed && active === "lp" && <LpPage me={me.data!} />}
          {/* The old address still works and lands in the same place. */}
          {authed && active === "allocation" && <FundStrategyPage me={me.data!} />}
          {authed && active === "reporting" && <ReportingPage me={me.data!} />}
          {authed && active === "documents" && <DocumentsPage />}
          {authed && active === "contradictions" && <ContradictionsPage />}
          {authed && active === "activity" && <ActivityPage me={me.data!} refreshNonce={refreshNonce} />}
          {authed && active === "governance" && <GovernancePage me={me.data!} />}
          {authed && active === "ai" && <AiPage me={me.data!} />}
          {authed && active === "ai-ops" && <AiOpsPage me={me.data!} />}
          {authed && active === "diagnostics" && <DiagnosticsPage />}
          </div>
        </main>
      </div>
    </div>
  );
}
