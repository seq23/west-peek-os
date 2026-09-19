import { useEffect, useState } from "react";
import { CONNECTION_FACTS, FIRM_SENDING_FACTS, SEND_AS_FACTS } from "@shared/help/connectionFacts";
import { PAGE_GUIDES, pageGuidesInOrder, type PageGuide } from "@shared/help/pageGuide";
import { renderGuideMarkdown, renderWalkthroughMarkdown, titleOf } from "@shared/help/pageGuide/render";
import { pageHost } from "@shared/help/pageHosts";
import { pagePurpose } from "@shared/help/pagePurpose";
import { AI_EMPLOYEE_ROSTER, FOCUS_TEAM_SIZE_DOC, MAX_ACTIVE_AI_EMPLOYEES_DOC } from "../lib/helpFacts";
import { MarkdownLite } from "../components/MarkdownLite";

/**
 * The Help tab.
 *
 * TWO HALVES, ONE SOURCE EACH. The first half is THE PAGES: one section per page, rendered from the
 * page's guide in `src/shared/help/pageGuide/` — the same text the page's host speaks when asked
 * "how does this page work", and the same purpose the block at the top of the page shows. Nothing
 * here is typed by hand about a page. Owner, 19 Sep 2026: Walter described Meetings as it was a
 * week earlier, and this tab still carried its own, third description of the same page. A guide is
 * held to the page by `validate:page-guides`; a paragraph here was held to nothing.
 *
 * The second half is HOW THE FIRM WORKS: the material that is not about one page — what needs a
 * person, the employees, jobs, privacy, why something is blocked. Each topic carries a maturity
 * marker and, where it states a rule, says where in the code that rule lives, so a reader can check
 * it rather than trust it.
 *
 * THE RULE THIS FILE STILL OBEYS: it may say what the product DOES and what a subsystem WOULD do
 * once configured; it may never assert that an integration is connected or working. Those are live
 * facts and belong to Integrations and Diagnostics.
 *
 * `How everything works →` on a page lands on that page's section: the block writes the key to
 * `sessionStorage` before navigating and this page scrolls to it on arrival.
 */

/** Where the purpose block leaves the page it came from. Same mechanism as Documents' focus. */
export const HELP_FOCUS_KEY = "wpos.help.focus";

export interface HelpGroup {
  group: string;
  keys: readonly string[];
}

type Maturity =
  | "IMPLEMENTED"
  | "IMPLEMENTED_LOCAL_ONLY"
  | "DEPENDS_ON_LIVE_STATE"
  | "REQUIRES_APPROVAL"
  | "AUDIT_PENDING";

const MATURITY_COPY: Record<Maturity, { label: string; tone: string; blurb: string }> = {
  IMPLEMENTED: {
    label: "Implemented",
    tone: "good",
    blurb: "Built and covered by tests in this build.",
  },
  IMPLEMENTED_LOCAL_ONLY: {
    label: "Implemented · locally validated",
    tone: "good",
    blurb: "Built and validated locally. Not independently verified against an external provider.",
  },
  DEPENDS_ON_LIVE_STATE: {
    label: "Depends on live state",
    tone: "warn",
    blurb: "Whether this works right now depends on configuration. Check the readiness surface.",
  },
  REQUIRES_APPROVAL: {
    label: "Requires a Managing Partner",
    tone: "warn",
    blurb: "Prepared automatically, but a human decision is required before anything happens.",
  },
  AUDIT_PENDING: {
    label: "Not yet audited",
    tone: "muted",
    blurb:
      "This area exists in the product, but its true configured/connected status has not been " +
      "verified. Treat any claim here as unproven until it has been.",
  },
};

interface Topic {
  id: string;
  title: string;
  maturity: Maturity;
  /** Words the search may match beyond the title. */
  keywords?: string;
  body: JSX.Element;
}

function MaturityTag({ maturity }: { maturity: Maturity }): JSX.Element {
  const m = MATURITY_COPY[maturity];
  return (
    <span className={`help-tag help-tag-${m.tone}`} title={m.blurb} data-testid={`help-tag-${maturity}`}>
      {m.label}
    </span>
  );
}

/** Where a rule lives, so a reader can check it rather than trust it. */
function Where({ path }: { path: string }): JSX.Element {
  return (
    <p className="muted small help-where">
      Where this is enforced: <code>{path}</code>
    </p>
  );
}

const TOPICS: Topic[] = [
  {
    id: "connecting-email-calendar",
    title: "Connecting your email and calendar — what can and cannot happen",
    maturity: "IMPLEMENTED",
    body: (
      <>
        <p>
          Two unrelated things get called &ldquo;email&rdquo; here, and that is most of the
          confusion. <strong>Sending</strong> is something the firm does. A <strong>mailbox</strong>{" "}
          and a <strong>calendar</strong> belong to a person. One being on says nothing about the
          other.
        </p>

        <h4>{FIRM_SENDING_FACTS.title} — already on</h4>
        <p>{FIRM_SENDING_FACTS.summary}</p>
        <p><strong>It can</strong></p>
        <ul>{FIRM_SENDING_FACTS.can.map((x) => <li key={x}>{x}</li>)}</ul>
        <p><strong>It cannot</strong></p>
        <ul>{FIRM_SENDING_FACTS.cannot.map((x) => <li key={x}>{x}</li>)}</ul>

        <h4>{SEND_AS_FACTS.title}</h4>
        <p>{SEND_AS_FACTS.summary}</p>
        <p><strong>It cannot</strong></p>
        <ul>{SEND_AS_FACTS.cannot.map((x) => <li key={x}>{x}</li>)}</ul>
        <p><strong>It can</strong></p>
        <ul>{SEND_AS_FACTS.can.map((x) => <li key={x}>{x}</li>)}</ul>

        {CONNECTION_FACTS.map((f) => (
          <section key={f.key}>
            <h4>{f.title}</h4>
            <p>{f.availability}</p>
            <p><strong>It cannot</strong></p>
            <ul>{f.cannot.map((x) => <li key={x}>{x}</li>)}</ul>
            <p><strong>It can</strong></p>
            <ul>{f.can.map((x) => <li key={x}>{x}</li>)}</ul>
            <p><strong>Why that is true.</strong> {f.enforcedBy}</p>
            <p><strong>When you press Connect</strong></p>
            <ol>{f.whenYouConnect.map((x) => <li key={x}>{x}</li>)}</ol>
            <p><strong>To undo it.</strong> {f.toUndo}</p>
          </section>
        ))}

        <p>
          <strong>Each partner connects their own.</strong> Sequoia connecting a calendar does
          nothing for Scooter&apos;s and cannot see it. There is no firm-level switch for this, and
          the absence is deliberate — one toggle would be a claim about whose diary the system can
          read, and it would be false.
        </p>
      </>
    ),
  },
  {
    id: "what-is",
    title: "What West Peek OS is",
    maturity: "IMPLEMENTED",
    body: (
      <>
        <p>
          West Peek OS is the firm's operating system: the place where firm state, investment
          workflow, approvals, LP workflow, portfolio monitoring, governed AI activity and the audit
          trail live. It is for the two Managing Partners of West Peek Ventures.
        </p>
        <p>
          <strong>It is deliberately not a CRM.</strong> Network OS remains authoritative for
          contacts, relationships, touches and relationship history. West Peek OS reads from that
          authority; it does not replace it or keep a competing copy.
        </p>
      </>
    ),
  },
  {
    id: "getting-started",
    title: "Getting started in five minutes",
    maturity: "IMPLEMENTED",
    keywords: "start begin first day nav",
    body: (
      <ol>
        <li>
          <strong>Home</strong> — what is waiting on you, what arrived, and today's brief on demand.
        </li>
        <li>
          <strong>Now → Approvals</strong> — the decisions only a person can make, and what you have delegated.
        </li>
        <li>
          <strong>Now → Work</strong> — the Desk, the Record and the Machinery: what needs you, what is finished, what runs on a clock.
        </li>
        <li>
          <strong>Deals</strong> — Thesis, Dealflow, Companies, Meetings, Secondaries, Portfolio, Fund strategy. Each page's section above says what is on it and who hosts it.
        </li>
        <li>
          <strong>Firm → Employees</strong> — who is on duty, who is employed, one press to employ.
        </li>
        <li>
          <strong>Admin</strong> — how the system is set up and behaving, only when something is wrong.
        </li>
      </ol>
    ),
  },
  {
    id: "cadence",
    title: "The Wednesday-to-Wednesday cadence",
    maturity: "IMPLEMENTED",
    keywords: "week wednesday prep packet weekly review",
    body: (
      <>
        <p>
          The firm operates on a Wednesday-to-Wednesday week. The Managing Partner meeting on
          Wednesday is the decision point, and the week either prepares for it or executes what it
          decided. Surfaces that group work "since last Wednesday" are using that boundary, not a
          rolling seven days.
        </p>
        <ul>
          <li>
            <strong>Each partner's Wednesday prep packet</strong> is written by a job the night before and arrives on Home.
          </li>
          <li>
            <strong>The shared weekly review is archived</strong> (18 Sep 2026). What was written is kept and still answers its address; nothing new is generated.
          </li>
        </ul>
        <Where path="src/worker/services/meetingPrep.ts · scripts/validate/an-archived-lane-stays-archived.mjs" />
      </>
    ),
  },
  {
    id: "ai-vs-human",
    title: "What AI can do, and what needs you",
    maturity: "REQUIRES_APPROVAL",
    keywords: "reserved approval human partner decide",
    body: (
      <>
        <p>AI in West Peek OS drafts, researches, monitors, summarises and prepares. It does not decide.</p>
        <ul>
          <li>
            <strong>Always a person:</strong> investing, booking a position, approving what goes to an LP, employing an AI employee for the first time, turning the Google Meet firm default off, any reserved action, and anything sent outside the firm.
          </li>
          <li>
            <strong>One choke point.</strong> Every external effect and every reserved action passes through <code>authorize()</code>, which answers allow, require approval, or deny — and a require-approval answer is a card on Approvals.
          </li>
          <li>
            <strong>Fail closed.</strong> If authority cannot be established, the action is refused rather than attempted, and the refusal names the missing authority.
          </li>
        </ul>
        <Where path="src/worker/services/authorize.ts · src/shared/registry/reservedActions.ts · scripts/validate/no-unauthorized-effects.mjs" />
      </>
    ),
  },
  {
    id: "employees",
    title: "AI employees and employment",
    maturity: "REQUIRES_APPROVAL",
    keywords: "roster employ activate duty cap on duty pause retire",
    body: (
      <>
        <p>
          There is a governed roster of <strong>{AI_EMPLOYEE_ROSTER} AI employee roles</strong>. All{" "}
          <strong>{MAX_ACTIVE_AI_EMPLOYEES_DOC} may be active at once</strong> — the cap is the whole
          roster. What stays small is the <strong>duty window</strong>: {FOCUS_TEAM_SIZE_DOC} on point
          in a given hour, because attention is the scarce thing, not headcount.
        </p>
        <ol>
          <li>
            <strong>Employ</strong> on the employee's card is one press. The first employment raises one approval card; if you hold the role, it is approved as you press.
          </li>
          <li>
            <strong>Working — turn off</strong> pauses an employee without a card. Restrict and retire are on the employee's detail panel.
          </li>
          <li>
            <strong>On duty now</strong> at the top of Employees shows who is on point this hour; the roster itself is on AI controls.
          </li>
          <li>
            An employee cannot employ itself, and the interface cannot bypass the cap.
          </li>
        </ol>
        <Where path="src/worker/services/aiEmployees.ts (MAX_ACTIVE_AI_EMPLOYEES, FOCUS_TEAM_SIZE) · tests/help-facts.test.ts" />
      </>
    ),
  },
  {
    id: "work-approvals",
    title: "Work cards and approval cards",
    maturity: "IMPLEMENTED",
    keywords: "card block sweep done blocked receipt",
    body: (
      <>
        <ol>
          <li>
            <strong>A work card</strong> is a unit of work somebody owns with a next action. It moves through open, in progress, blocked, done and cancelled.
          </li>
          <li>
            <strong>The sweep</strong> works the oldest employee-owned card every five minutes, up to three attempts, and ends it Done or Blocked. A blocked card says what it was asked and what would clear it.
          </li>
          <li>
            <strong>An approval card</strong> is raised whenever a reserved action is requested. Approving it executes the action and writes a receipt — who approved what, when, on what evidence.
          </li>
          <li>
            <strong>Standing authority</strong> — "approve, and don't ask again" until the task is done, today, or this week — is shown at the top of Approvals with Stop this on each grant. Reserved actions never delegate.
          </li>
        </ol>
        <Where path="src/worker/services/workSweep.ts · src/worker/services/approvals.ts · src/worker/services/standingAuthority.ts · scripts/validate/a-block-can-be-cleared.mjs" />
      </>
    ),
  },
  {
    id: "scheduled",
    title: "Scheduled and recurring work",
    maturity: "DEPENDS_ON_LIVE_STATE",
    keywords: "job cron tick machinery cadence pause",
    body: (
      <>
        <ol>
          <li>
            <strong>One cron trigger</strong> runs every due job. The same path is <code>POST /api/jobs/tick</code>, and <strong>Run everything due now</strong> on Work → Machinery presses it by hand.
          </li>
          <li>
            <strong>A job is on unless there is a stated reason it is not.</strong> Pausing one needs a reason; putting it back on does not.
          </li>
          <li>
            <strong>A job that cannot run says why</strong> — a missing employee, integration, provider or credential — rather than failing silently, and a job that died is a notification.
          </li>
        </ol>
        <Where path="src/worker/services/jobs.ts · src/shared/work/scheduledWork.ts" />
      </>
    ),
  },
  {
    id: "network-os",
    title: "Relationships and the Network OS boundary",
    maturity: "IMPLEMENTED",
    body: (
      <p>
        Network OS owns contacts, relationships, touches and relationship history. West Peek OS
        must not become a second copy of that data. When you need relationship history, Network OS
        is the answer; West Peek OS records the firm's operating and investment state around it.
      </p>
    ),
  },
  {
    id: "governance",
    title: "Governance, privacy and security",
    maturity: "IMPLEMENTED",
    keywords: "privacy mode lockdown frontier local spend lever budget egress",
    body: (
      <>
        <ul>
          <li>
            <strong>Reserved actions</strong> require a Managing Partner and produce an approval receipt.
          </li>
          <li>
            <strong>Privacy mode</strong> is one of LOCAL, FRONTIER or LOCKDOWN; LOCAL and LOCKDOWN route every AI run to the deterministic offline adapter and nothing leaves the system.
          </li>
          <li>
            <strong>Spend</strong> is one lever — FREE_ONLY, MODERATE or OPEN — with a monthly ceiling set on Cockpit; a free route never sees LP or deal material.
          </li>
          <li>
            <strong>Evidence and provenance</strong> are retained for governed activity; deterministic calculations are never delegated to a model.
          </li>
          <li>
            <strong>Governed actions fail closed;</strong> a false success is never shown.
          </li>
          <li>
            <strong>No fund term is invented.</strong> Check size, ownership, reserves, pace, closing dates and LP totals appear only once you entered them — on Thesis, Fund strategy or LP — and a figure the record does not hold reads as not recorded, never as a guess.
          </li>
        </ul>
        <Where path="docs/AI_GOVERNANCE.md · scripts/validate/one-lever-not-four.mjs · scripts/validate/free-lanes-cannot-see-confidential.mjs · src/shared/fund/pace.ts (no clock, nothing guessed)" />
      </>
    ),
  },
  {
    id: "glossary",
    title: "Glossary",
    maturity: "IMPLEMENTED",
    body: (
      <dl className="help-glossary">
        <dt>Work card</dt>
        <dd>A unit of tracked work, with an owner and a next action.</dd>
        <dt>Reserved action</dt>
        <dd>An action that may only proceed with a Managing Partner approval.</dd>
        <dt>Receipt</dt>
        <dd>The durable record of who approved what, when, on what evidence.</dd>
        <dt>Face</dt>
        <dd>One of the tabs a record has — a meeting's Before, During and After; a deal's five.</dd>
        <dt>Band</dt>
        <dd>One horizontal section of a page, with a heading and one question it answers.</dd>
        <dt>Host</dt>
        <dd>The AI employee responsible for a page, whose card sits at the top and who answers questions about it.</dd>
        <dt>Machine</dt>
        <dd>An internal execution surface work can be routed to. Administration only.</dd>
        <dt>Data class</dt>
        <dd>The sensitivity label that governs where data may travel.</dd>
        <dt>Provider</dt>
        <dd>An external service (for example a model provider) used under policy.</dd>
      </dl>
    ),
  },
  {
    id: "blocked",
    title: "Why something is blocked",
    maturity: "IMPLEMENTED",
    keywords: "stuck refused waiting",
    body: (
      <>
        <p>Blocked is a designed state, not an error. Common causes:</p>
        <ul>
          <li>An approval is required and has not been given.</li>
          <li>No employee is employed for the work.</li>
          <li>A capability, integration or provider is not configured.</li>
          <li>A credential is missing, or two credentials conflict and the choice is yours.</li>
          <li>OAuth is required and has not been completed.</li>
          <li>An external provider is unavailable, and the lane has been stood down.</li>
        </ul>
        <p>The surface that blocked the work names the specific cause and the door that clears it.</p>
        <Where path="src/shared/work/blocks.ts · scripts/validate/a-stopped-card-says-why.mjs" />
      </>
    ),
  },
  {
    id: "integrations",
    title: "Integrations and provider readiness",
    maturity: "DEPENDS_ON_LIVE_STATE",
    keywords: "provider connected google cloudflare openrouter credential",
    body: (
      <>
        <p>
          <strong>This topic will not tell you an integration is working.</strong> That is a live
          fact; <em>Admin → Integrations</em> and <em>Admin → Diagnostics</em> are authoritative, and
          they read the system rather than its settings.
        </p>
        <ul>
          <li>
            <strong>Providers</strong> are turned on and off on Cockpit; which of them may see which data class is fixed at the router, not in a prompt.
          </li>
          <li>
            <strong>Google</strong> — each partner connects their own mailbox and calendar; the firm's Meet calls are read by the calendar and Meet jobs once the firm default is on.
          </li>
          <li>
            <strong>Credentials</strong> live only in the vault. A missing or conflicting one is shown to you as a choice, never resolved on your behalf.
          </li>
        </ul>
        <Where path="src/worker/ai/routing.ts · src/worker/services/health.ts · docs/ENVIRONMENT_CONTRACT.md" />
      </>
    ),
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    maturity: "IMPLEMENTED",
    body: (
      <ul>
        <li>
          <strong>A page is empty.</strong> Usually nothing has been created yet. The empty state
          says what would put something there.
        </li>
        <li>
          <strong>An action was refused.</strong> Governed actions fail closed. The refusal names the
          missing authority.
        </li>
        <li>
          <strong>A job will not run.</strong> Open it on Work → Machinery; its blocker is listed explicitly.
        </li>
        <li>
          <strong>An integration looks wrong.</strong> Trust <em>Admin → Integrations</em>,
          not this Help tab.
        </li>
        <li>
          <strong>A host says something the page does not have.</strong> Ask again with "how does this page work" — that answer is the page's guide, verbatim, and a build check holds it to the page.
        </li>
      </ul>
    ),
  },
];

/** Words the search may match on a page's section: its title, purpose, bands and controls. */
function pageSearchText(g: PageGuide): string {
  return [
    g.title,
    g.navKey,
    g.purpose,
    ...g.youCan,
    ...g.bands.map((b) => `${b.name} ${b.shows}`),
    ...g.acts.map((a) => `${a.label} ${a.does}`),
    ...g.walkthroughs.flatMap((w) => [w.scenario, ...w.steps.map((st) => `${st.do} ${st.then ?? ""} ${st.not ?? ""}`)]),
  ]
    .join(" ")
    .toLowerCase();
}

/** The nav groups when App.tsx does not hand them over (Help before sign-in) — the same keys. */
const FALLBACK_GROUPS: readonly HelpGroup[] = [
  { group: "", keys: ["home", "intent", "capture"] },
  { group: "Now", keys: ["approvals", "work", "notifications"] },
  { group: "Deals", keys: ["thesis", "dealflow", "companies", "meetings", "secondaries", "portfolio", "fund-strategy"] },
  { group: "Firm", keys: ["lp", "rooms", "community", "employees", "record"] },
  { group: "Learn", keys: ["research", "university", "documents"] },
  {
    group: "Admin",
    keys: ["cockpit", "ai-controls", "sources-and-sweeps", "machines", "governance", "contradictions", "cross-office", "activity", "integrations", "network", "diagnostics"],
  },
];

function PageSection({ navKey, onNavigate }: { navKey: string; onNavigate?: (key: string) => void }): JSX.Element | null {
  const guide = PAGE_GUIDES[navKey];
  const purpose = pagePurpose(navKey);
  const host = pageHost(navKey);
  if (!guide && !purpose) return null;
  return (
    <section id={`help-page-${navKey}`} className="help-topic help-page" data-testid={`help-page-${navKey}`}>
      <h3>
        {titleOf(navKey)}
        {onNavigate && (
          <button type="button" className="link-button help-page-open" data-testid={`help-page-open-${navKey}`} onClick={() => onNavigate(navKey)}>
            Open {titleOf(navKey)} →
          </button>
        )}
      </h3>
      {host && (
        <p className="muted small" data-testid={`help-page-host-${navKey}`}>
          Hosted by <strong>{host.name}</strong>, {host.role} — ask {host.name} on the page itself.
        </p>
      )}
      {guide ? (
        <>
          <MarkdownLite text={renderGuideMarkdown(guide)} className="md-lite" />
          {/*
            HOW YOU WOULD USE IT — the same walkthrough the host speaks when asked "walk me through
            it" (19 Sep 2026), under the guide, so the Help tab and the host cannot disagree about
            the order of the steps or what a control does not do.
          */}
          <div className="help-walkthrough" data-testid={`help-walkthrough-${navKey}`}>
            <h4>How you would use it</h4>
            <MarkdownLite text={renderWalkthroughMarkdown(guide)} className="md-lite" />
          </div>
        </>
      ) : (
        <>
          <p>{purpose!.purpose}</p>
          <ul>
            {purpose!.youCan.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function HelpCenterPage({ groups, onNavigate }: { groups?: readonly HelpGroup[]; onNavigate?: (key: string) => void } = {}): JSX.Element {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const navGroups = (groups ?? FALLBACK_GROUPS).filter((g) => g.keys.length > 0 && !g.keys.includes("help"));
  const orderedKeys = navGroups.flatMap((g) => g.keys);
  // Every page with a guide is listed even if the nav handed over does not carry it (a route that
  // is off the nav still has a section, so a bookmark's page is explained).
  const guidedExtras = pageGuidesInOrder(orderedKeys).map((g) => g.navKey).filter((k) => !orderedKeys.includes(k));

  const pageMatches = (k: string): boolean => {
    if (!needle) return true;
    const g = PAGE_GUIDES[k];
    if (g) return pageSearchText(g).includes(needle);
    const p = pagePurpose(k);
    return Boolean(p && `${titleOf(k)} ${k} ${p.purpose} ${p.youCan.join(" ")}`.toLowerCase().includes(needle));
  };
  const shownTopics = needle
    ? TOPICS.filter((t) => t.title.toLowerCase().includes(needle) || t.id.includes(needle) || (t.keywords ?? "").includes(needle))
    : TOPICS;
  const shownGroups = navGroups
    .map((g) => ({ group: g.group, keys: g.keys.filter(pageMatches) }))
    .filter((g) => g.keys.length > 0);
  const shownExtras = guidedExtras.filter(pageMatches);
  const nothing = shownTopics.length === 0 && shownGroups.length === 0 && shownExtras.length === 0;

  // Arrived from a page's "How everything works →": land on that page's section.
  useEffect(() => {
    let key: string | null = null;
    try {
      key = sessionStorage.getItem(HELP_FOCUS_KEY);
      if (key) sessionStorage.removeItem(HELP_FOCUS_KEY);
    } catch {
      key = null;
    }
    if (!key) return;
    const el = document.getElementById(`help-page-${key}`);
    if (el) el.scrollIntoView({ block: "start" });
  }, []);

  return (
    <div data-testid="help-center-page">
      <p className="surface-lede">
        Every page, in the same shape — what it is for, what you see top to bottom, what you can do,
        what runs on its own, and where the rest lives — then how the firm works around them. A
        page's section is the same text its host speaks when asked how the page works; a build check
        holds it to the page.
      </p>

      <label className="help-search">
        <span>Search help</span>
        <input
          type="search"
          value={query}
          data-testid="help-search"
          placeholder="meetings, approvals, employees, blocked…"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      <nav aria-label="Help topics" className="help-toc" data-testid="help-toc">
        {shownGroups.map((g) => (
          <div key={g.group || "pinned"} className="help-toc-group">
            <span className="help-toc-label">{g.group || "Pinned"}</span>
            <ul>
              {g.keys.map((k) => (
                <li key={k}>
                  <a href={`#help-page-${k}`}>{titleOf(k)}</a>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {shownTopics.length > 0 && (
          <div className="help-toc-group">
            <span className="help-toc-label">How the firm works</span>
            <ul>
              {shownTopics.map((t) => (
                <li key={t.id}>
                  <a href={`#help-${t.id}`}>{t.title}</a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </nav>

      {nothing && (
        <p className="notice" data-testid="help-no-results">
          No page or topic matches “{query}”. Try “meetings”, “approvals”, “employees”, “blocked” or “glossary”.
        </p>
      )}

      {(shownGroups.length > 0 || shownExtras.length > 0) && (
        <h3 className="help-part" data-testid="help-pages">
          The pages
        </h3>
      )}
      {shownGroups.map((g) => g.keys.map((k) => <PageSection key={k} navKey={k} onNavigate={onNavigate} />))}
      {shownExtras.map((k) => (
        <PageSection key={k} navKey={k} onNavigate={onNavigate} />
      ))}

      {shownTopics.length > 0 && (
        <h3 className="help-part" data-testid="help-firm">
          How the firm works
        </h3>
      )}
      <div className="help-legend" data-testid="help-legend">
        {(Object.keys(MATURITY_COPY) as Maturity[]).map((m) => (
          <span key={m} className={`help-tag help-tag-${MATURITY_COPY[m].tone}`}>
            {MATURITY_COPY[m].label}
          </span>
        ))}
      </div>
      {shownTopics.map((t) => (
        <section key={t.id} id={`help-${t.id}`} className="help-topic" data-testid={`help-topic-${t.id}`}>
          <h3>
            {t.title} <MaturityTag maturity={t.maturity} />
          </h3>
          {t.body}
        </section>
      ))}
    </div>
  );
}
