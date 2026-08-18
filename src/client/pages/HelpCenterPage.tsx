import { useState } from "react";
import { AI_EMPLOYEE_ROSTER, MAX_ACTIVE_AI_EMPLOYEES_DOC } from "../lib/helpFacts";

/**
 * The Help Center (P26 §2).
 *
 * THE RULE THIS FILE OBEYS: a help page may state what the product DOES, and may state what a
 * subsystem WOULD do once configured, but it may never assert that an integration is connected,
 * reachable or working. Those are runtime facts and they belong to the readiness surface, not to
 * prose that was true on the day someone typed it.
 *
 * So every topic below carries an explicit maturity marker. Where a claim depends on live state,
 * the topic says so and points at the surface that knows. Topics whose honest status cannot yet be
 * established are marked AUDIT PENDING rather than given confident text — an unverified claim in a
 * help centre is worse than an admitted gap, because the operator acts on it.
 */

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

const TOPICS: Topic[] = [
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
    body: (
      <ol>
        <li>
          <strong>Home</strong> — what needs attention, what changed, what is blocked.
        </li>
        <li>
          <strong>Work → Approvals</strong> — the decisions only a Managing Partner can make.
        </li>
        <li>
          <strong>Team → Employees</strong> — the AI roster, who is active, and the activation cap.
        </li>
        <li>
          <strong>Work → Scheduled Work</strong> — recurring jobs, their cadence, and why any are
          paused.
        </li>
        <li>
          <strong>More / System</strong> — administration and diagnostics, only when something is
          wrong.
        </li>
      </ol>
    ),
  },
  {
    id: "cadence",
    title: "The Wednesday-to-Wednesday cadence",
    maturity: "IMPLEMENTED",
    body: (
      <>
        <p>
          The firm operates on a Wednesday-to-Wednesday week. The Managing Partner meeting on
          Wednesday is the decision point, and the week either prepares for it or executes what it
          decided.
        </p>
        <p>
          Surfaces that group work "since last Wednesday" are using that boundary, not a rolling
          seven days.
        </p>
      </>
    ),
  },
  {
    id: "ai-vs-human",
    title: "What AI can do, and what needs you",
    maturity: "REQUIRES_APPROVAL",
    body: (
      <>
        <p>AI in West Peek OS drafts, researches, monitors, summarises and prepares. It does not decide.</p>
        <p>
          <strong>Always a Managing Partner:</strong> investment decisions, activating an AI
          employee, enabling consequential recurring work, anything designated a reserved action, and
          any external communication to an LP, founder, portfolio company or the community.
        </p>
        <p>
          Governed actions <em>fail closed</em>. If authority cannot be established, the action is
          refused rather than attempted.
        </p>
      </>
    ),
  },
  {
    id: "employees",
    title: "AI employees and activation",
    maturity: "REQUIRES_APPROVAL",
    body: (
      <>
        <p>
          There is a governed roster of <strong>{AI_EMPLOYEE_ROSTER} AI employee roles</strong>. Every
          employee starts <code>INACTIVE</code>. At most{" "}
          <strong>{MAX_ACTIVE_AI_EMPLOYEES_DOC} may be active at once</strong> — the cap is enforced
          by the server, not by the interface.
        </p>
        <p>
          Activation requires explicit human selection and an approval receipt. An employee cannot
          activate itself, and the interface cannot bypass the cap. Lifecycle states you will see:{" "}
          <code>INACTIVE</code>, <code>CANDIDATE</code>, <code>ACTIVE</code>, <code>PAUSED</code>,{" "}
          <code>RESTRICTED</code>, <code>RETIRED</code>.
        </p>
      </>
    ),
  },
  {
    id: "work-approvals",
    title: "Work and approvals",
    maturity: "IMPLEMENTED",
    body: (
      <p>
        Work is captured, routed and tracked as work cards, moving through <code>OPEN</code>,{" "}
        <code>IN_PROGRESS</code>, <code>BLOCKED</code>, <code>DONE</code> and <code>CANCELLED</code>.
        Anything reserved becomes an approval card carrying its own receipt, so what was decided, by
        whom, and on what evidence stays auditable.
      </p>
    ),
  },
  {
    id: "scheduled",
    title: "Scheduled and recurring work",
    maturity: "DEPENDS_ON_LIVE_STATE",
    body: (
      <p>
        Recurring work runs as jobs with an explicit cadence. New jobs are created{" "}
        <code>PAUSED</code>; enabling one is a governed step. A job that cannot run will say why —
        a missing employee, capability, integration, provider, authorisation or credential — rather
        than failing silently.
      </p>
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
    body: (
      <ul>
        <li>Reserved actions require a Managing Partner and produce an approval receipt.</li>
        <li>Evidence and provenance are retained for governed activity.</li>
        <li>Privacy and egress controls constrain what may leave the system.</li>
        <li>Budgets and cost limits bound AI spend.</li>
        <li>Deterministic calculations are not delegated to a model.</li>
        <li>Governed actions fail closed; a false success is never shown.</li>
      </ul>
    ),
  },
  {
    id: "glossary",
    title: "Glossary",
    maturity: "IMPLEMENTED",
    body: (
      <dl className="help-glossary">
        <dt>Work card</dt>
        <dd>A unit of tracked work.</dd>
        <dt>Reserved action</dt>
        <dd>An action that may only proceed with a Managing Partner approval.</dd>
        <dt>Receipt</dt>
        <dd>The durable record of who approved what, when, on what evidence.</dd>
        <dt>Machine</dt>
        <dd>An internal execution surface work can be routed to. Administration only.</dd>
        <dt>Capability</dt>
        <dd>A specific thing an employee is permitted to do.</dd>
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
    body: (
      <>
        <p>Blocked is a designed state, not an error. Common causes:</p>
        <ul>
          <li>An approval is required and has not been given.</li>
          <li>No employee is active for the work, or the activation cap is reached.</li>
          <li>A capability, integration or provider is not configured.</li>
          <li>A credential is missing, or two credentials conflict and the choice is yours.</li>
          <li>OAuth is required and has not been completed.</li>
          <li>An external provider is unavailable.</li>
        </ul>
        <p>The surface that blocked the work names the specific cause and the action that clears it.</p>
      </>
    ),
  },
  {
    id: "integrations",
    title: "Integrations and provider readiness",
    maturity: "DEPENDS_ON_LIVE_STATE",
    body: (
      <>
        <p>
          <strong>This topic will not tell you an integration is working.</strong> That is a live
          fact; the readiness surface under <em>More / System → Integrations</em> is authoritative.
        </p>
        <p>What the P26 audit established, and what it did not:</p>
        <ul>
          <li>
            <strong>Cloudflare (Worker, D1, KV, R2) — connected and externally verified.</strong> A
            real production deploy succeeded with all three bindings verified, and{" "}
            <code>os.joinwestpeek.com</code> is live behind Cloudflare Access.
          </li>
          <li>
            <strong>All AI work flows through OpenRouter.</strong> It is the one enabled provider and
            its credential is bound in production. It is <em>configured, not externally verified</em>{" "}
            — no model call has been made yet, so the first real run is the proof.
          </li>
          <li>
            <strong>Sensitive material still cannot reach it.</strong> Enabling the lane did not widen
            egress: only <code>PUBLIC</code> and <code>INTERNAL</code> may go to OpenRouter.{" "}
            <code>CONFIDENTIAL</code>, <code>RESTRICTED</code>, <code>LP_PRIVATE</code>,{" "}
            <code>MNPI_SENSITIVE</code> and <code>BANKING_RESTRICTED</code> are denied.
          </li>
          <li>
            <strong>Fireworks is unconfigured</strong> (no credential exists), and the other model
            vendors are deliberately disabled — one lane, on purpose.
          </li>
          <li>
            <strong>Harvey and Norm are configuration only.</strong> Registered, disabled, with no
            data-class allowance and no vendor account. Their adapters are explicitly unproven.
          </li>
          <li>
            <strong>Connectors ship <code>NOT_CONFIGURED</code>.</strong> A connector row is
            configuration, not a working integration.
          </li>
        </ul>
        <p>
          Credentials exist in the vault for a primary model provider, but several plausible ones
          across different vendors compete and none has been chosen — a conflict is shown to you
          rather than resolved on your behalf. See{" "}
          <code>docs/PROVIDER_READINESS_AUDIT.md</code> for the full mapping.
        </p>
      </>
    ),
  },
  {
    id: "intelligence",
    title: "Intelligence and research",
    maturity: "IMPLEMENTED_LOCAL_ONLY",
    body: (
      <>
        <p>
          The boundary that matters here is <strong>research versus evidence</strong>. A finding
          stays research — useful, but not something a decision may rest on — until it is explicitly
          promoted. Promotion is what turns it into governed evidence with provenance attached.
        </p>
        <p>
          That promotion step is proven end to end by the browser suite, not merely coded. What is{" "}
          <em>not</em> established is freshness or coverage from any external source: research
          quality depends on providers, and only the OpenRouter lane is configured, unverified.
        </p>
      </>
    ),
  },
  {
    id: "investing",
    title: "Investing, diligence and IC",
    maturity: "IMPLEMENTED_LOCAL_ONLY",
    body: (
      <>
        <p>
          The full path is implemented and proven end to end:{" "}
          <strong>opportunity → deal math → IC packet → receipted decision</strong>. The decision
          carries a receipt, so what was decided, by whom, and on what evidence stays auditable.
        </p>
        <p>
          Allocation is enforced against <strong>pinned policy versions</strong>: a breach is made
          visible and clearing it takes a receipted human decision rather than an override.
        </p>
        <p>
          Meetings gate on <strong>consent and recording</strong> before anything is captured, and a
          commitment made in a meeting becomes a work card rather than a note someone must remember.
        </p>
      </>
    ),
  },
  {
    id: "lp",
    title: "LP and fundraising",
    maturity: "IMPLEMENTED_LOCAL_ONLY",
    body: (
      <>
        <p>
          The LP path is implemented and proven end to end:{" "}
          <strong>evidence gate → compliance receipt → publish → recorded share → revocation</strong>.
          Material cannot be published without passing the evidence gate, every share is recorded,
          and access can be revoked afterwards.
        </p>
        <p>
          Reporting works the same way: review gates, then receipted distribution. A reconciliation
          exception is raised rather than resolved by overwriting — the system will not quietly make
          two numbers agree.
        </p>
        <p>
          Fund I is a $30M target and the firm is earliest-stage / pre-seed oriented.{" "}
          <strong>No other fund term is asserted anywhere in this product</strong> — not check size,
          ownership target, reserve policy, deployment pace, closing dates or current LP totals —
          unless you entered it.
        </p>
      </>
    ),
  },
  {
    id: "portfolio",
    title: "Portfolio",
    maturity: "IMPLEMENTED_LOCAL_ONLY",
    body: (
      <>
        <p>
          Proven end to end:{" "}
          <strong>dated metrics → deterioration alert → support request → match → MP introduction gate</strong>.
          An introduction to a portfolio company is gated on a Managing Partner, not sent because a
          match looked good.
        </p>
        <p>
          Deterioration is a <strong>deterministic, direction-aware comparison of dated values</strong>,
          not a model judgement. Two details worth knowing, both asserted by tests: an improvement
          raises nothing, and if you have not configured severity bands the alert still fires but
          reports its severity as <em>unconfigured</em> rather than inventing one.
        </p>
      </>
    ),
  },
  {
    id: "notifications",
    title: "Notifications",
    maturity: "IMPLEMENTED_LOCAL_ONLY",
    body: (
      <p>
        Notifications surface changes that need your attention. Delivery to any external channel
        depends on that channel being configured; in-product notification is what this build
        validates.
      </p>
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
          <strong>A job will not run.</strong> Open the job; its blocker is listed explicitly.
        </li>
        <li>
          <strong>An integration looks wrong.</strong> Trust <em>More / System → Integrations</em>,
          not this Help Center.
        </li>
      </ul>
    ),
  },
];

export function HelpCenterPage(): JSX.Element {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? TOPICS.filter((t) => t.title.toLowerCase().includes(needle) || t.id.includes(needle))
    : TOPICS;

  return (
    <div data-testid="help-center-page">
      <p className="surface-lede">
        How West Peek OS works, what it does for you, and what still needs a Managing Partner. Every
        topic is marked with how far it has actually been proven.
      </p>

      <div className="help-legend" data-testid="help-legend">
        {(Object.keys(MATURITY_COPY) as Maturity[]).map((m) => (
          <span key={m} className={`help-tag help-tag-${MATURITY_COPY[m].tone}`}>
            {MATURITY_COPY[m].label}
          </span>
        ))}
      </div>

      <label className="help-search">
        <span>Search help</span>
        <input
          type="search"
          value={query}
          data-testid="help-search"
          placeholder="approvals, employees, blocked…"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      <nav aria-label="Help topics" className="help-toc" data-testid="help-toc">
        <ul>
          {shown.map((t) => (
            <li key={t.id}>
              <a href={`#help-${t.id}`}>{t.title}</a>
            </li>
          ))}
        </ul>
      </nav>

      {shown.length === 0 && (
        <p className="notice" data-testid="help-no-results">
          No help topic matches “{query}”. Try “approvals”, “employees”, “blocked” or “glossary”.
        </p>
      )}

      {shown.map((t) => (
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
