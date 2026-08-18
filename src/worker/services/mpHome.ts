import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import type { FirmUserIdentity } from "../auth";
import { canAccessPrivacyLabel, privacyVisibilityClause } from "./authorize";
import { latestPreference } from "./intelligence";
import { dailySpendUsd, getLatestBudgetPolicy } from "../ai/runAi";

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
] as const;

export const DEFAULT_HOME_MODULES: readonly string[] = [
  "approvals",
  "intelligence",
  "portfolio_risk",
  "meetings",
  "my_work",
  "ai_spend",
  "what_changed",
];

async function approvalsModule(env: Env, identity: FirmUserIdentity): Promise<HomeModule> {
  const rows = await env.WP_OS_DB.prepare(
    "SELECT id, action_key, object_type, object_id, title, required_approver_roles_json, created_at FROM approval_card WHERE state = 'pending_review' ORDER BY created_at LIMIT 25",
  ).all<{ id: string; action_key: string; object_type: string; object_id: string; title: string; required_approver_roles_json: string; created_at: string }>();
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
    items: mine.slice(0, 8).map((c) => ({ id: c.id, title: c.title, action_key: c.action_key, created_at: c.created_at })),
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
    link: "intelligence",
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
    `SELECT id, title, meeting_type, scheduled_at, status, company_id
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
    `SELECT o.id, o.title, o.opportunity_type, o.status, o.company_id, c.canonical_name
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
    link: "investment",
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
    answers: "What is broken?",
    link: "reporting",
    count: items.length,
    items,
    note:
      items.length === 0
        ? "No open reconciliation exceptions."
        : "Administrator figures are authoritative; nothing here overwrites them.",
  };
}

async function aiSpendModule(env: Env, identity: FirmUserIdentity): Promise<HomeModule> {
  const firmScope = identity.authorityScopes.find((s) => s.scopeKey === "firm_scope")?.scopeValue ?? "west-peek";
  const policy = await getLatestBudgetPolicy(env, firmScope);
  const spent = await dailySpendUsd(env, firmScope);
  const blocked = await env.WP_OS_DB.prepare(
    `SELECT COUNT(*) AS n FROM ai_run WHERE date(created_at) = date('now') AND status IN ('BUDGET_BLOCKED','KILL_SWITCHED','PROVIDER_DISABLED','EGRESS_BLOCKED','BLOCKED_DEFERRED')`,
  ).first<{ n: number }>();
  return {
    key: "ai_spend",
    title: "AI spend today",
    answers: "What is costing money?",
    link: "ai-ops",
    count: blocked?.n ?? 0,
    items: [
      {
        spent_usd: Math.round(spent * 10_000) / 10_000,
        daily_cap_usd: policy.daily_cap_usd,
        cost_mode: policy.cost_mode,
        privacy_mode: policy.privacy_mode,
        blocked_runs_today: blocked?.n ?? 0,
      },
    ],
    note: "Spend is committed cost: actual where a provider reported it, estimate otherwise.",
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
    link: "work-cards",
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

  const canSeeLp = canAccessPrivacyLabel(identity, "LP_PRIVATE");
  const canSeeBanking = canAccessPrivacyLabel(identity, "BANKING_RESTRICTED");

  const modules: HomeModule[] = [];
  for (const key of enabled) {
    switch (key) {
      case "approvals":
        modules.push(await approvalsModule(env, identity));
        break;
      case "intelligence":
        modules.push(await intelligenceModule(env, identity));
        break;
      case "portfolio_risk":
        modules.push(await portfolioRiskModule(env));
        break;
      case "allocation_constraints":
        modules.push(await allocationConstraintsModule(env));
        break;
      case "meetings":
        modules.push(await meetingsModule(env, identity, now));
        break;
      case "ic_priorities":
        modules.push(await icPrioritiesModule(env, identity));
        break;
      case "lp_signals":
        // Omitted entirely without the scope: an empty LP module would still tell the
        // reader that LP conversations exist.
        if (canSeeLp) modules.push(await lpSignalsModule(env));
        break;
      case "reconciliation":
        if (canSeeBanking) modules.push(await reconciliationModule(env));
        break;
      case "ai_spend":
        modules.push(await aiSpendModule(env, identity));
        break;
      case "employees":
        modules.push(await employeesModule(env));
        break;
      case "what_changed":
        modules.push(await whatChangedModule(env, identity));
        break;
      case "my_work":
        modules.push(await myWorkModule(env, identity));
        break;
      default:
        break;
    }
  }

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
  return json({
    ...home,
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
