import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import type { FirmUserIdentity } from "../auth";
import { canAccessPrivacyLabel, privacyVisibilityClause } from "./authorize";
import { latestPreference } from "./intelligence";
import { dailySpendUsd, getLatestBudgetPolicy } from "../ai/runAi";
import { currentSpendBehaviour, stoppedRuns } from "../ai/spend";
import { leverFromPolicy } from "../../shared/ai/spendLever";

/**
 * MP Home / Executive Command Center aggregation (P14, GAP-04 + GAP-23).
 *
 * ONE read-only aggregation over records that already exist in their owning subsystem.
 * It creates nothing, owns nothing, and stores nothing: every module returns rows that
 * live somewhere else, plus the link the operator should follow to act on them.
 *
 * Every module answers one of the ten Managing Partner questions in task §4. A module
 * that has no data says so; it never renders a fabricated placeholder.
 *
 * Privacy: each module applies the SAME SQL visibility clause the owning surface uses.
 * The home never widens access. LP_PRIVATE and BANKING_RESTRICTED modules are omitted
 * entirely (not emptied) for users without the scope, so their existence is not implied.
 */

export interface HomeModule {
  key: string;
  title: string;
  /** Which of the ten §4 MP questions this module answers. */
  answers: string;
  /** Client route key to drill into. */
  link: string;
  count: number;
  items: Array<Record<string, unknown>>;
  /** Present when a module cannot be computed truthfully; the UI must show it. */
  note?: string;
  /** When this partner last opened the module (pressed Open, or visited its page). Null: never. */
  seen_at?: string | null;
  /** Items newer than that mark — what "has something for you" now means. */
  new_count?: number;
  has_new?: boolean;
}

export const HOME_MODULE_KEYS = [
  "approvals",
  "employees",
  "intelligence",
  "portfolio_risk",
  "allocation_constraints",
  "meetings",
  "ic_priorities",
  "lp_signals",
  "reconciliation",
  "ai_spend",
  "what_changed",
  "my_work",
  "health",
] as const;

/*
 * THE DEFAULT ANSWERS ALL TEN QUESTIONS, which it did not.
 *
 * Operator, 23 Aug 2026, reading her own Home: four of the ten read "no module enabled for this
 * yet" — what is at risk, what the employees are doing, what is costing money, and what is broken.
 * The page names ten questions as its purpose and then leaves four of them unanswered, which makes
 * the list an indictment of the page rather than a description of it.
 *
 * `employees`, `ic_priorities` and `health` are added; every question below now resolves to a
 * module. A partner may still switch any of them off — this is the starting point, not a rule.
 */
export const DEFAULT_HOME_MODULES: readonly string[] = [
  "approvals",
  "intelligence",
  "portfolio_risk",
  "meetings",
  "my_work",
  "ai_spend",
  "what_changed",
  "employees",
  "ic_priorities",
  "health",
];

async function approvalsModule(env: Env, identity: FirmUserIdentity): Promise<HomeModule> {
  // The row on Home decides inline (design/HOME_DESIGN.md §3.3), so it carries what a decision
  // needs to read: the risk level and its note, who raised it, and when it expires.
  const rows = await env.WP_OS_DB.prepare(
    `SELECT id, action_key, object_type, object_id, title, required_approver_roles_json, created_at,
            risk_level, impact_note, expires_at, requested_by_type, requested_by_id
       FROM approval_card WHERE state = 'pending_review' ORDER BY created_at LIMIT 100`,
  ).all<{ id: string; action_key: string; object_type: string; object_id: string; title: string; required_approver_roles_json: string; created_at: string; risk_level: string; impact_note: string | null; expires_at: string | null; requested_by_type: string; requested_by_id: string }>();
  const all = rows.results ?? [];
  const mine = all.filter((c) => {
    try {
      return (JSON.parse(c.required_approver_roles_json) as string[]).some((r) => identity.roles.includes(r));
    } catch {
      return false;
    }
  });
  return {
    key: "approvals",
    title: "Waiting on your decision",
    answers: "What needs my decision?",
    link: "approvals",
    count: mine.length,
    // EVERY card she can decide, not the first eight: Home's masthead, its Waiting pill and the
    // band's rows are ONE count (design/HOME_DESIGN.md §3.1), and the page counts the rows it was
    // handed. Capped at eight, the ninth card was pending, uncounted and undecidable from Home —
    // found 19 Sep 2026 when the Home journey's own card was the ninth. Production has raised 18
    // cards ever and holds 0 pending, so 100 is a ceiling nobody reaches, not a page size.
    items: mine.map((c) => ({
      id: c.id, title: c.title, action_key: c.action_key, created_at: c.created_at,
      risk_level: c.risk_level, impact_note: c.impact_note, expires_at: c.expires_at,
      requested_by_type: c.requested_by_type, requested_by_id: c.requested_by_id,
    })),
    note:
      all.length > mine.length
        ? `${all.length - mine.length} further card(s) are pending for approver roles you do not hold.`
        : undefined,
  };
}

async function intelligenceModule(env: Env, identity: FirmUserIdentity): Promise<HomeModule> {
  const visibility = privacyVisibilityClause(identity, "privacy_label");
  const rows = await env.WP_OS_DB.prepare(
    `SELECT id, title, category, relevance_score, relevance_reason, why_matters, why_matters_origin, created_at
       FROM intelligence_item
      WHERE archived = 0 AND ${visibility}
      ORDER BY relevance_score DESC, created_at DESC
      LIMIT 8`,
  ).all<Record<string, unknown>>();
  const items = rows.results ?? [];
  return {
    key: "intelligence",
    title: "Daily intelligence",
    answers: "What do I need to know? / What opportunities surfaced?",
    // `sources-and-sweeps`, because that is where this now lives and "intelligence" is not a route.
    // A `link` that names no destination does not fail loudly: `navigate()` sets the hash, nothing
    // matches it, and `keyFromHash` falls back — so pressing Open on this module put the operator
    // back on Home with no explanation. A dead link on the surface the partners start their day on.
    link: "sources-and-sweeps",
    count: items.length,
    items,
    note:
      items.length === 0
        ? "No intelligence items yet. Register a source and run the engine on the Intelligence page."
        : "Ranking is a deterministic heuristic; each item states which rules fired.",
  };
}

async function portfolioRiskModule(env: Env): Promise<HomeModule> {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT a.id, a.company_id, c.canonical_name, a.alert_type, a.severity, a.metric_key, a.last_seen_at
       FROM portfolio_alert a
       LEFT JOIN canonical_company c ON c.id = a.company_id
      WHERE a.status = 'OPEN'
      ORDER BY CASE a.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, a.last_seen_at DESC
      LIMIT 10`,
  ).all<Record<string, unknown>>();
  const items = rows.results ?? [];
  return {
    key: "portfolio_risk",
    title: "Portfolio risk",
    answers: "Where is money or execution at risk?",
    link: "portfolio",
    count: items.length,
    items,
    note: items.length === 0 ? "No open portfolio alerts." : undefined,
  };
}

async function allocationConstraintsModule(env: Env): Promise<HomeModule> {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT v.id, v.kind, v.severity, v.detail, v.created_at, v.option_id
       FROM constraint_violation v
      ORDER BY CASE v.severity WHEN 'BREACH' THEN 0 ELSE 1 END, v.created_at DESC
      LIMIT 10`,
  ).all<Record<string, unknown>>();
  const items = rows.results ?? [];
  return {
    key: "allocation_constraints",
    title: "Allocation constraints",
    answers: "Where is money or execution at risk?",
    link: "allocation",
    count: items.length,
    items,
    note: items.length === 0 ? "No constraint findings from the latest comparisons." : "Scenarios are not predictions.",
  };
}

async function meetingsModule(env: Env, identity: FirmUserIdentity, now: Date): Promise<HomeModule> {
  const visibility = privacyVisibilityClause(identity, "privacy_label");
  const rows = await env.WP_OS_DB.prepare(
    `SELECT id, title, meeting_type, scheduled_at, status, company_id, created_at
       FROM meeting
      WHERE status = 'SCHEDULED' AND scheduled_at IS NOT NULL AND scheduled_at >= ?1 AND ${visibility}
      ORDER BY scheduled_at
      LIMIT 8`,
  )
    .bind(now.toISOString())
    .all<Record<string, unknown>>();
  const items = rows.results ?? [];
  return {
    key: "meetings",
    title: "Upcoming meetings",
    answers: "What should I look at today?",
    link: "meetings",
    count: items.length,
    items,
    note: items.length === 0 ? "No scheduled meetings ahead of now." : undefined,
  };
}

async function icPrioritiesModule(env: Env, identity: FirmUserIdentity): Promise<HomeModule> {
  const visibility = privacyVisibilityClause(identity, "o.privacy_label");
  const rows = await env.WP_OS_DB.prepare(
    `SELECT o.id, o.title, o.opportunity_type, o.status, o.company_id, c.canonical_name, o.created_at
       FROM investment_opportunity o
       LEFT JOIN canonical_company c ON c.id = o.company_id
      WHERE o.status IN ('IC_READY','DILIGENCE') AND ${visibility}
      ORDER BY CASE o.status WHEN 'IC_READY' THEN 0 ELSE 1 END, o.created_at DESC
      LIMIT 10`,
  ).all<Record<string, unknown>>();
  const items = rows.results ?? [];
  return {
    key: "ic_priorities",
    title: "IC / deal priorities",
    answers: "What should the firm do next?",
    link: "dealflow",
    count: items.length,
    items,
    note: items.length === 0 ? "Nothing at diligence or IC-ready." : undefined,
  };
}

async function lpSignalsModule(env: Env): Promise<HomeModule> {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT o.id, o.stage, o.target_commitment, o.created_at, r.legal_name
       FROM lp_opportunity o
       LEFT JOIN lp_record r ON r.id = o.lp_record_id
      WHERE o.stage IN ('DILIGENCE','TERMS','COMMITTED')
      ORDER BY o.created_at DESC
      LIMIT 8`,
  ).all<Record<string, unknown>>();
  const items = rows.results ?? [];
  return {
    key: "lp_signals",
    title: "LP / fundraising signals",
    answers: "What changed?",
    link: "lp",
    count: items.length,
    items,
    note: items.length === 0 ? "No LP conversations at diligence or beyond." : undefined,
  };
}

async function reconciliationModule(env: Env): Promise<HomeModule> {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT id, record_kind, record_key, field, exception_kind, difference, status, created_at
       FROM fund_reconciliation_exception
      WHERE status = 'OPEN'
      ORDER BY created_at DESC
      LIMIT 8`,
  ).all<Record<string, unknown>>();
  const items = rows.results ?? [];
  return {
    key: "reconciliation",
    title: "Reconciliation exceptions",
    /*
     * IT ANSWERED THE WRONG QUESTION. This module claimed "What is broken?", so as long as it was
     * enabled that question read as answered — by a list of places where the firm's figures and the
     * administrator's disagree. That is a MONEY problem, and a real one, but a partner asking what
     * is broken means the system: is the brief running, are the jobs alive, did anything fail
     * overnight. `health_fault` is what knows that, and had no module at all, so the one question
     * with a live escalation system behind it was the one Home could not answer.
     */
    answers: "Where is money or execution at risk?",
    // Same as the intelligence module above: reporting folded into LP, "reporting" resolves to
    // nothing, and Open silently bounced back to Home.
    link: "lp",
    count: items.length,
    items,
    note:
      items.length === 0
        ? "No open reconciliation exceptions."
        : "Administrator figures are authoritative; nothing here overwrites them.",
  };
}

/**
 * What is broken, from the system that checks — not from a list that sounds like it might.
 *
 * `runHealthEscalation` runs every tick, keeps a `health_fault` row per failing check, escalates
 * only what persists across two runs, and announces recoveries. All of that existed and none of it
 * reached Home: Diagnostics said "Broken — Scooter's brief" on one tab while Home said nothing on
 * another, which is exactly the split the operator reported as item 22.
 *
 * UNRESOLVED FAULTS ONLY, and it says when it last looked. An empty list here has to mean "checked,
 * and nothing is down" rather than "nothing has been checked" — those are opposite facts and a
 * silent zero reads as the good one.
 */
async function healthModule(env: Env): Promise<HomeModule> {
  const rows = (
    await env.WP_OS_DB.prepare(
      `SELECT check_key, label, reading, remedy, first_seen_at, escalated_at
         FROM health_fault
        WHERE resolved_at IS NULL
        ORDER BY first_seen_at ASC
        LIMIT 8`,
    ).all<Record<string, unknown>>()
  ).results ?? [];
  const lastRun = await env.WP_OS_DB.prepare(
    "SELECT MAX(created_at) AS at FROM health_fault",
  ).first<{ at: string | null }>();

  return {
    key: "health",
    title: "What is broken",
    answers: "What is broken?",
    link: "diagnostics",
    count: rows.length,
    items: rows,
    note:
      rows.length === 0
        ? lastRun?.at
          ? "Every check passed the last time they ran. Nothing is down."
          : "No check has ever recorded a fault here. If that looks wrong, open Diagnostics — an empty history is not the same as a clean one."
        : "Each of these was seen down on two runs in a row before it was raised; a single bad tick is not reported.",
  };
}

async function aiSpendModule(env: Env, identity: FirmUserIdentity): Promise<HomeModule> {
  const firmScope = identity.authorityScopes.find((s) => s.scopeKey === "firm_scope")?.scopeValue ?? "west-peek";
  const now = new Date();
  const policy = await getLatestBudgetPolicy(env, firmScope);
  const spent = await dailySpendUsd(env, firmScope);

  /*
   * ── THE POSTURE THE ROUTER IS ACTUALLY IN, NOT TWO COLUMNS THAT USED TO DECIDE IT ───────────
   *
   * "NORMAL/FRONTIER" — what the owner read here on the morning of 18 Sep 2026, and she read it, as
   * anyone would, as "the router is still reaching for the dearest thing". Both halves were wrong
   * in different ways:
   *
   *   · `cost_mode` has not decided anything since the spend lever landed. `runAi` derives it FROM
   *     the lever to satisfy a NOT NULL column and never reads it back (see runAi.ts, "DERIVED FROM
   *     THE LEVER, never consulted by it"). Printing it as the firm's posture is printing an
   *     artefact of a write.
   *   · `privacy_mode` is a statement about PRIVACY — may an external model be used at all — and
   *     FRONTIER is its ordinary, correct value. On a card headed "what the workforce cost today"
   *     it reads as a spend setting, which it has never been.
   *
   * At that moment the firm was at MODERATE on the lever and CAUTIOUS on the gradient: $9.57 spent
   * against a pro-rated $10 line of $5.87, free-first already switched on, and the daily brief
   * already running at $0 on a free lane. The page said NORMAL.
   *
   * So this reads the SAME function the Cockpit and the router read — one call, no second
   * derivation — and prints the lever and the gradient position. Privacy keeps its own field and
   * its own word, so nothing is lost and nothing is conflated.
   */
  const lever = leverFromPolicy(policy as unknown as Parameters<typeof leverFromPolicy>[0]);
  const behaviour = await currentSpendBehaviour(env, firmScope, lever, now);

  /*
   * AND WHAT STOPPED, WITH ITS CAUSE AND ITS CLOCK. This was `COUNT(*)` over five hand-typed
   * statuses, unscoped to the firm, printed as a bare "2 blocked run(s)". It omitted
   * PREFLIGHT_BLOCKED — every named stop the spend lever raises — and FAILED, so the two screens
   * counted different populations; and the two runs she was looking at had stopped at 01:03 and
   * been fixed by a deploy at 03:06, which the card had no way to say. `stoppedRuns` is the one
   * definition, derived from the schema rather than typed out.
   */
  const stopped = await stoppedRuns(env, firmScope, "TODAY", now);

  return {
    key: "ai_spend",
    title: "AI spend today",
    answers: "What is costing money?",
    link: "cockpit",
    count: stopped.count,
    items: [
      {
        spent_usd: Math.round(spent * 10_000) / 10_000,
        daily_cap_usd: policy.daily_cap_usd,
        /** The lever she set and where the month has put it. The posture that actually routes. */
        spend_lever: behaviour.lever,
        gradient_position: behaviour.position,
        gradient_applies: behaviour.gradientApplies,
        /** Its own field and its own word: privacy, not spend. */
        privacy_mode: policy.privacy_mode,
        blocked_runs_today: stopped.count,
        blocked_reason: stopped.reason,
        blocked_last_at: stopped.last_at,
        blocked_is_hers_to_fix: stopped.she_can_fix,
      },
    ],
    note:
      "Spend is committed cost: actual where a provider reported it, estimate otherwise, and only for this firm's own runs — " +
      "a vendor invoice may also carry spend from outside this system. " +
      behaviour.why,
  };
}

/**
 * "What are the AI employees doing?" — the tenth MP question (P25, GAP-23). Reads the P15
 * workforce layer: who is ACTIVE, what they hold, and what is stuck.
 */
async function employeesModule(env: Env): Promise<HomeModule> {
  const active = (
    await env.WP_OS_DB.prepare(
      `SELECT e.id, e.name, e.role, e.status,
              (SELECT COUNT(*) FROM work_card w WHERE w.owner_type = 'AI' AND w.owner_id = e.id AND w.state IN ('OPEN','IN_PROGRESS','BLOCKED')) AS open_work,
              (SELECT COUNT(*) FROM ai_run r WHERE r.ai_employee_id = e.id AND r.created_at >= date('now','-7 days')) AS runs_7d,
              (SELECT COUNT(*) FROM ai_run r WHERE r.ai_employee_id = e.id AND r.created_at >= date('now','-7 days') AND r.status != 'COMPLETED') AS blocked_7d
         FROM ai_employee e
        WHERE e.status = 'ACTIVE'
        ORDER BY e.name`,
    ).all<Record<string, unknown>>()
  ).results ?? [];
  const exceptions = await env.WP_OS_DB.prepare(
    "SELECT COUNT(*) AS n FROM ai_employee WHERE status IN ('RESTRICTED','RETIRED','PAUSED')",
  ).first<{ n: number }>();
  const deadLetters = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM job_run WHERE status = 'DEAD_LETTER'").first<{ n: number }>();

  return {
    key: "employees",
    title: "AI workforce",
    answers: "What are the AI employees doing?",
    link: "employees",
    count: active.length,
    items: active.slice(0, 8),
    note:
      active.length === 0
        ? "No employee is ACTIVE. Activation is a Managing Partner decision behind an approval receipt (D10)."
        : `${exceptions?.n ?? 0} employee(s) paused, restricted, or retired · ${deadLetters?.n ?? 0} scheduled run(s) in dead-letter.`,
  };
}

async function whatChangedModule(env: Env, identity: FirmUserIdentity): Promise<HomeModule> {
  const state = await env.WP_OS_DB.prepare("SELECT last_viewed_at FROM mp_home_view_state WHERE firm_user_id = ?1")
    .bind(identity.id)
    .first<{ last_viewed_at: string }>();
  const since = state?.last_viewed_at ?? null;
  const rows = since
    ? await env.WP_OS_DB.prepare(
        `SELECT event_type, object_type, object_id, actor_type, actor_id, created_at
           FROM event_record WHERE created_at > ?1 ORDER BY created_at DESC LIMIT 25`,
      )
        .bind(since)
        .all<Record<string, unknown>>()
    : await env.WP_OS_DB.prepare(
        `SELECT event_type, object_type, object_id, actor_type, actor_id, created_at
           FROM event_record ORDER BY created_at DESC LIMIT 25`,
      ).all<Record<string, unknown>>();
  const items = rows.results ?? [];
  return {
    key: "what_changed",
    title: since ? "Changed since your last visit" : "Recent activity",
    answers: "What changed?",
    link: "activity",
    count: items.length,
    items,
    note: since ? `Diff since ${since}.` : "First visit: showing the most recent firm events instead of a diff.",
  };
}

async function myWorkModule(env: Env, identity: FirmUserIdentity): Promise<HomeModule> {
  const visibility = privacyVisibilityClause(identity, "privacy_label");
  const rows = await env.WP_OS_DB.prepare(
    `SELECT id, title, state, priority, next_action, created_at
       FROM work_card
      WHERE owner_id = ?1 AND state IN ('OPEN','IN_PROGRESS','BLOCKED') AND ${visibility}
      ORDER BY CASE priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END, created_at
      LIMIT 10`,
  )
    .bind(identity.id)
    .all<Record<string, unknown>>();
  const items = rows.results ?? [];
  return {
    key: "my_work",
    title: "My open work",
    answers: "What should I look at today?",
    // "work", which is the nav key. "work-cards" is the API path and was never a route — Home's
    // busiest module linked nowhere, and the router falls back to Home, so pressing it appeared to
    // do nothing rather than to fail. `operatorAttention` already says "work"; these two disagreed.
    link: "work",
    count: items.length,
    items,
    note: items.length === 0 ? "No open work cards assigned to you." : undefined,
  };
}

/**
 * "One thing to watch" — a stated, inspectable rule, not a model opinion:
 * the highest-severity open portfolio alert, else the oldest pending approval the user
 * can actually decide, else the top-ranked intelligence item, else nothing.
 *
 * Every `because` opens with "Shown because " and then says, in plain English, what put this
 * item ahead of the others. The prefix is load-bearing rather than decorative: it is the
 * machine-checkable promise that this panel EXPLAINS ITS SELECTION instead of pronouncing on
 * importance, and `tests/intelligence.test.ts` enforces it. Reword the sentences freely; keep
 * the prefix, and never let the sentence read as a judgement the system did not make.
 *
 * The wording is deliberately free of internal vocabulary — no scores, no rule identifiers, no
 * `relevance_reason` values. The operator is owed the reason, not the plumbing.
 */
function oneThingToWatch(modules: HomeModule[]): { headline: string; because: string; link: string } | null {
  const risk = modules.find((m) => m.key === "portfolio_risk");
  if (risk && risk.items.length > 0) {
    const top = risk.items[0] as { severity?: string; canonical_name?: string; alert_type?: string };
    return {
      headline: `${top.severity ?? "OPEN"} alert — ${top.canonical_name ?? "portfolio company"} (${top.alert_type ?? "alert"})`,
      because: "Shown because an open alert on a company you own outranks everything else.",
      link: "portfolio",
    };
  }
  const approvals = modules.find((m) => m.key === "approvals");
  if (approvals && approvals.items.length > 0) {
    const top = approvals.items[0] as { title?: string };
    return {
      headline: `Approval waiting: ${top.title ?? "pending card"}`,
      because: "Shown because nothing is flagged in the portfolio, and this is the oldest decision waiting on you.",
      link: "approvals",
    };
  }
  const intel = modules.find((m) => m.key === "intelligence");
  if (intel && intel.items.length > 0) {
    const top = intel.items[0] as { title?: string; relevance_reason?: string };
    return {
      headline: top.title ?? "top intelligence item",
      because: "Shown because nothing needs your decision today, and this is the closest match to what the firm is watching.",
      link: "intelligence",
    };
  }
  return null;
}

/**
 * Where each module's Open button lands, held once so a visit to that page can be read back as
 * "she has now looked at this module" (`handleMarkRouteVisited`). Each module function repeats
 * its own `link`; `tests/homeFreshness.test.ts` holds the two together.
 */
export const HOME_MODULE_LINKS: Record<(typeof HOME_MODULE_KEYS)[number], string> = {
  approvals: "approvals",
  employees: "employees",
  intelligence: "sources-and-sweeps",
  portfolio_risk: "portfolio",
  allocation_constraints: "allocation",
  meetings: "meetings",
  ic_priorities: "dealflow",
  lp_signals: "lp",
  reconciliation: "lp",
  ai_spend: "cockpit",
  what_changed: "activity",
  my_work: "work",
  health: "diagnostics",
};

/** One module, or null when the reader lacks the scope (omitted, never emptied). */
export async function buildModule(env: Env, identity: FirmUserIdentity, key: string, now: Date): Promise<HomeModule | null> {
  switch (key) {
    case "approvals":
      return approvalsModule(env, identity);
    case "intelligence":
      return intelligenceModule(env, identity);
    case "portfolio_risk":
      return portfolioRiskModule(env);
    case "allocation_constraints":
      return allocationConstraintsModule(env);
    case "meetings":
      return meetingsModule(env, identity, now);
    case "ic_priorities":
      return icPrioritiesModule(env, identity);
    case "lp_signals":
      // Omitted entirely without the scope: an empty LP module would still tell the
      // reader that LP conversations exist.
      return canAccessPrivacyLabel(identity, "LP_PRIVATE") ? lpSignalsModule(env) : null;
    case "reconciliation":
      return canAccessPrivacyLabel(identity, "BANKING_RESTRICTED") ? reconciliationModule(env) : null;
    case "ai_spend":
      return aiSpendModule(env, identity);
    case "employees":
      return employeesModule(env);
    case "what_changed":
      return whatChangedModule(env, identity);
    case "my_work":
      return myWorkModule(env, identity);
    case "health":
      return healthModule(env);
    default:
      return null;
  }
}

/*
 * NEW SINCE YOU LAST LOOKED.
 *
 * Operator, 15 Sep 2026: "Who has something for you" counted modules that merely HAD items, so
 * five companies in the pipeline was "something" forever and pressing Open never quieted it. A
 * module has something only if it holds items newer than the moment this partner last opened it.
 *
 * Two ways to tell, because the modules are not alike:
 *   · items that carry a timestamp — created, updated, last seen, first seen — are new when that
 *     stamp is later than the mark;
 *   · items that carry none (the workforce roster, today's spend) are new when the SET changed:
 *     the ids are hashed at the moment of opening and compared. After the first Open such a
 *     module is quiet until its set moves.
 * Never opened means everything is new, which is what the page said before and is still true.
 */
const ITEM_STAMPS = ["updated_at", "last_seen_at", "created_at", "first_seen_at", "escalated_at"] as const;

function stampOf(item: Record<string, unknown>): string | null {
  for (const k of ITEM_STAMPS) {
    const v = item[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export function itemsHash(items: Array<Record<string, unknown>>): string {
  const ids = items.map((it) => (typeof it.id === "string" || typeof it.id === "number" ? String(it.id) : JSON.stringify(it)));
  // FNV-1a over the sorted ids: stable, short, and needs no crypto for a set-equality check.
  let h = 0x811c9dc5;
  for (const ch of ids.sort().join("\u0000")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `h${h.toString(16)}`;
}

/** Pure: what a module's freshness is, given the mark this partner left on it. */
export function freshness(
  items: Array<Record<string, unknown>>,
  seen: { seen_at: string; items_hash: string | null } | null,
): { new_count: number; has_new: boolean } {
  if (items.length === 0) return { new_count: 0, has_new: false };
  if (!seen) return { new_count: items.length, has_new: true };
  const stamped = items.filter((it) => stampOf(it) !== null);
  if (stamped.length > 0) {
    const newer = stamped.filter((it) => stampOf(it)! > seen.seen_at).length;
    return { new_count: newer, has_new: newer > 0 };
  }
  const changed = itemsHash(items) !== seen.items_hash;
  return { new_count: changed ? items.length : 0, has_new: changed };
}

async function markFreshness(env: Env, identity: FirmUserIdentity, modules: HomeModule[]): Promise<void> {
  const rows = await env.WP_OS_DB.prepare(
    "SELECT module_key, seen_at, items_hash FROM mp_home_module_seen WHERE firm_user_id = ?1",
  )
    .bind(identity.id)
    .all<{ module_key: string; seen_at: string; items_hash: string | null }>();
  const seen = new Map((rows.results ?? []).map((r) => [r.module_key, r]));
  for (const m of modules) {
    const mark = seen.get(m.key) ?? null;
    const f = freshness(m.items, mark);
    m.seen_at = mark?.seen_at ?? null;
    m.new_count = f.new_count;
    m.has_new = f.has_new;
  }
}

/** Record that this partner has now looked at a module: the moment, and the set they saw. */
export async function markModuleSeen(env: Env, identity: FirmUserIdentity, key: string, now = new Date()): Promise<{ seen_at: string } | null> {
  if (!(HOME_MODULE_KEYS as readonly string[]).includes(key)) return null;
  const module = await buildModule(env, identity, key, now);
  const seenAt = now.toISOString();
  await env.WP_OS_DB.prepare(
    `INSERT INTO mp_home_module_seen (firm_user_id, module_key, seen_at, items_hash) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (firm_user_id, module_key) DO UPDATE SET seen_at = excluded.seen_at, items_hash = excluded.items_hash`,
  )
    .bind(identity.id, key, seenAt, module ? itemsHash(module.items) : null)
    .run();
  return { seen_at: seenAt };
}

/** POST /api/mp-home/modules/:key/seen — Open was pressed. */
export async function handleMarkModuleSeen(ctx: RouteContext): Promise<Response> {
  const out = await markModuleSeen(ctx.env, ctx.identity!, ctx.params.key!);
  if (!out) return json({ error: "unknown_module" }, { status: 404 });
  return json({ ok: true, module: ctx.params.key, ...out });
}

/**
 * POST /api/mp-home/visited { route } — the partner reached a page by any door. Every module whose
 * Open lands there is now seen; a route no module points at is a no-op, not an error.
 */
export async function handleMarkRouteVisited(ctx: RouteContext): Promise<Response> {
  const body = (await ctx.request.json().catch(() => ({}))) as { route?: unknown };
  const route = typeof body.route === "string" ? body.route : "";
  const keys = (Object.entries(HOME_MODULE_LINKS) as Array<[string, string]>).filter(([, link]) => link === route).map(([k]) => k);
  const now = new Date();
  for (const key of keys) await markModuleSeen(ctx.env, ctx.identity!, key, now);
  return json({ ok: true, modules: keys });
}

export async function buildHome(
  env: Env,
  identity: FirmUserIdentity,
  opts: { now?: Date } = {},
): Promise<{
  modules: HomeModule[];
  enabled_modules: string[];
  one_thing_to_watch: ReturnType<typeof oneThingToWatch>;
  questions: Array<{ question: string; module: string | null }>;
}> {
  const now = opts.now ?? new Date();
  const pref = await latestPreference(env, identity.id);
  let enabled: string[] = [...DEFAULT_HOME_MODULES];
  if (pref) {
    try {
      const parsed = JSON.parse(pref.modules_json) as string[];
      if (Array.isArray(parsed) && parsed.length > 0) enabled = parsed;
    } catch {
      /* fall back to defaults */
    }
  }

  const modules: HomeModule[] = [];
  for (const key of enabled) {
    const m = await buildModule(env, identity, key, now);
    if (m) modules.push(m);
  }
  await markFreshness(env, identity, modules);

  const byQuestion = (q: string) => modules.find((m) => m.answers.includes(q))?.key ?? null;
  const questions = [
    { question: "What do I need to know?", module: byQuestion("What do I need to know?") },
    { question: "What needs my decision?", module: byQuestion("What needs my decision?") },
    { question: "What changed?", module: byQuestion("What changed?") },
    { question: "Where is money or execution at risk?", module: byQuestion("Where is money or execution at risk?") },
    { question: "What are the AI employees doing?", module: byQuestion("What are the AI employees doing?") },
    { question: "What opportunities surfaced?", module: byQuestion("What opportunities surfaced?") },
    { question: "What is costing money?", module: byQuestion("What is costing money?") },
    { question: "What is broken?", module: byQuestion("What is broken?") },
    { question: "What should I look at today?", module: byQuestion("What should I look at today?") },
    { question: "What should the firm do next?", module: byQuestion("What should the firm do next?") },
  ];

  return { modules, enabled_modules: enabled, one_thing_to_watch: oneThingToWatch(modules), questions };
}

export async function handleMpHome(ctx: RouteContext): Promise<Response> {
  const identity = ctx.identity!;
  const home = await buildHome(ctx.env, identity);
  /*
   * Mail nobody has placed, counted here because Home is where the operator finds out.
   *
   * The inbound handler files every message as a capture whether it routed or not — which makes an
   * unrouted one safely recorded, and silently recorded is exactly how work goes missing. Counted
   * rather than listed: this line's job is to say "go and look", not to reproduce the inbox.
   */
  /*
   * EVERYTHING THE MAILBOX HAD TO HAND TO A PERSON, not only the untagged mail.
   *
   * Operator, 22 Aug 2026: "no inbound emails to os@joinwestpeek.com should silently fail. the
   * employee responsible for routing should surface that an email came in the needs attention box."
   *
   * This counted `EMAIL_UNROUTED` captures alone, so it saw a message with no recognised tag and
   * missed every other way the mailbox gives up: a message too large to read, a deal tag with no
   * readable company, a person the relay could not propose. Those all open a routing card and none
   * of them reached this number.
   *
   * Counting the OPEN ROUTING CARDS instead means it cannot miss a new failure mode by construction:
   * anything the handler hands to a person appears here, because handing it over IS opening a card.
   */
  const unrouted = await ctx.env.WP_OS_DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM capture
         WHERE capture_type = 'EMAIL_UNROUTED' AND status = 'NEW' AND firm_scope = ?1)
     + (SELECT COUNT(*) FROM work_card
         WHERE firm_scope = ?1
           AND state IN ('OPEN','IN_PROGRESS','BLOCKED')
           AND (title LIKE 'Unclear email:%' OR title LIKE 'Too big to read:%')) AS n`,
  )
    .bind("west-peek")
    .first<{ n: number }>();

  return json({
    ...home,
    unrouted_emails: unrouted?.n ?? 0,
    available_modules: HOME_MODULE_KEYS,
    generated_at: new Date().toISOString(),
  });
}

/** Mark home as seen so the next "what changed" is a real diff. */
export async function handleMarkHomeSeen(ctx: RouteContext): Promise<Response> {
  const now = new Date().toISOString();
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO mp_home_view_state (firm_user_id, last_viewed_at) VALUES (?1, ?2)
     ON CONFLICT (firm_user_id) DO UPDATE SET last_viewed_at = excluded.last_viewed_at`,
  )
    .bind(ctx.identity!.id, now)
    .run();
  return json({ ok: true, last_viewed_at: now });
}
