import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { deliver } from "./deliverables";
import { jointByline } from "../../shared/work/chiefOfStaff";
import { json } from "../router";
import type { RouteContext } from "../router";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { REVIEW_HEADINGS, guessHeading, isResolved, weekEnd, weekStart, type ReviewHeading } from "../../shared/review/weeklyAgenda";
import { NOTES_PROMPT_VERSION, buildNotesPrompt, parseProposals, resolveOwner } from "../../shared/review/meetingNotes";
import { runAi } from "../ai/runAi";

/**
 * The weekly MP operating review (P37, V1 #18, canon §8).
 *
 * GENERATED FROM LIVE STATE, which §33 requires and which decides the whole implementation. Every
 * agenda item is DERIVED from a record that already exists — a pending approval, an open
 * commitment, a portfolio alert, a failing job — and carries a `source_type`/`source_id` back to
 * it. Nothing here is written by a model.
 *
 * That is a deliberate rejection of the easier build. Asking an LLM to "summarise the firm's week"
 * produces something fluent, plausible, and impossible to check; when a partner asks "where did
 * this come from" the answer has to be a row, not a paraphrase. The cost is that the agenda is
 * drier. That is the right trade for a document two people make decisions from.
 *
 * DUPLICATES AND DISAGREEMENTS (canon §8). Each Chief of Staff's brief is the same derivation run
 * with that partner's lens; an item both briefs raise is merged and marked BOTH, an item only one
 * raises keeps that partner's name. The merge never drops the attribution, because "only Scooter
 * flagged this" is frequently the most useful line in the review.
 */

export class WeeklyReviewError extends Error {
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

interface DerivedItem {
  heading: ReviewHeading;
  body: string;
  source_type: string;
  source_id: string;
  /** Which partner's brief surfaces this. Both, unless the lens is partner-specific. */
  raised_by: "SCOOTER" | "SEQUOIA" | "BOTH";
}

/**
 * Derive the agenda from live state.
 *
 * Exported so tests can assert the derivation without going through HTTP, and so a heading that
 * produces nothing is visibly absent rather than silently missing.
 */
export async function deriveItems(env: Env, firmScope: string): Promise<DerivedItem[]> {
  const items: DerivedItem[] = [];
  const q = async (sql: string, ...binds: unknown[]) =>
    (await env.WP_OS_DB.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results ?? [];

  // 1 · Decisions required — approval cards waiting on a human.
  for (const r of await q(
    "SELECT id, title, created_at FROM approval_card WHERE state = 'pending_review' AND firm_scope = ?1 ORDER BY created_at LIMIT 25",
    firmScope,
  )) {
    items.push({
      heading: "decisions_required",
      body: `Approval pending: ${r.title}`,
      source_type: "approval_card", source_id: String(r.id), raised_by: "BOTH",
    });
  }

  // 2 · Fundraising and LP pipeline — LP engagements that moved, or are stuck.
  for (const r of await q(
    `SELECT e.lp_record_id, e.state, e.next_step, l.legal_name FROM lp_engagement e
       LEFT JOIN lp_record l ON l.id = e.lp_record_id
      WHERE e.firm_scope = ?1 ORDER BY e.updated_at DESC LIMIT 15`,
    firmScope,
  )) {
    items.push({
      heading: "fundraising_lp",
      body: `${r.legal_name ?? "LP"} — ${r.state}${r.next_step ? `; next: ${r.next_step}` : ""}`,
      // Keyed by lp_record_id: lp_engagement has no id of its own, it is one row per LP.
      source_type: "lp_engagement", source_id: String(r.lp_record_id),
      // Wesley's lane is Fund I; LP relations sit with Sequoia in the operating model.
      raised_by: "SEQUOIA",
    });
  }

  // 3/4 · Opportunities, split by sleeve so primaries and secondaries stay distinct (canon §10.1).
  for (const r of await q(
    `SELECT id, title, opportunity_type, status FROM investment_opportunity
      WHERE firm_scope = ?1 AND status NOT IN ('PASS','CLOSED','WITHDRAWN') ORDER BY created_at DESC LIMIT 25`,
    firmScope,
  )) {
    const secondary = String(r.opportunity_type).startsWith("SECONDARY");
    items.push({
      heading: secondary ? "secondary" : "early_stage",
      body: `${r.title} — ${r.status}`,
      source_type: "investment_opportunity", source_id: String(r.id), raised_by: "BOTH",
    });
  }

  // 6 · Portfolio company health — unresolved alerts.
  for (const r of await q(
    `SELECT a.id, a.alert_type, a.severity, c.canonical_name FROM portfolio_alert a
       LEFT JOIN canonical_company c ON c.id = a.company_id
      WHERE a.status != 'RESOLVED' AND a.firm_scope = ?1 ORDER BY a.severity DESC LIMIT 20`,
    firmScope,
  )) {
    items.push({
      heading: "portfolio_health",
      body: `${r.canonical_name ?? "Company"}: ${r.alert_type} (${r.severity})`,
      source_type: "portfolio_alert", source_id: String(r.id), raised_by: "BOTH",
    });
  }

  // 7 · Community and founder support — open support requests.
  for (const r of await q(
    `SELECT s.id, s.description, s.urgency, c.canonical_name FROM support_request s
       LEFT JOIN canonical_company c ON c.id = s.company_id
      WHERE s.status NOT IN ('CLOSED','WITHDRAWN') AND s.firm_scope = ?1 ORDER BY s.created_at DESC LIMIT 15`,
    firmScope,
  )) {
    items.push({
      heading: "community_founder",
      body: `${r.canonical_name ?? "Founder"}: ${String(r.description).slice(0, 120)}`,
      source_type: "support_request", source_id: String(r.id), raised_by: "SCOOTER",
    });
  }

  // 8 · Events — anything not yet complete.
  for (const r of await q(
    `SELECT id, title, status, starts_at FROM evt_event
      WHERE status NOT IN ('COMPLETE','CANCELLED') AND firm_scope = ?1 ORDER BY starts_at LIMIT 15`,
    firmScope,
  )) {
    items.push({
      heading: "events",
      body: `${r.title} — ${r.status}${r.starts_at ? ` (${r.starts_at})` : ""}`,
      source_type: "evt_event", source_id: String(r.id), raised_by: "SCOOTER",
    });
  }

  // 14 · Agent work and approvals — AI runs that failed, and dead-lettered jobs.
  for (const r of await q(
    `SELECT r.id, r.status, r.error, j.job_key FROM job_run r
       LEFT JOIN scheduled_job j ON j.id = r.job_id
      WHERE r.status IN ('FAILED','DEAD_LETTER') ORDER BY r.created_at DESC LIMIT 15`,
  )) {
    items.push({
      heading: "agent_work",
      body: `Scheduled work ${r.job_key ?? "(unknown job)"} is ${r.status}${r.error ? `: ${String(r.error).slice(0, 100)}` : ""}`,
      source_type: "job_run", source_id: String(r.id), raised_by: "BOTH",
    });
  }

  // 15 · Risks and unresolved commitments — meeting commitments still open.
  for (const r of await q(
    `SELECT c.id, c.commitment_text, c.due_date, m.title FROM meeting_commitment c
       LEFT JOIN meeting m ON m.id = c.meeting_id
      WHERE c.status = 'OPEN' AND c.firm_scope = ?1 ORDER BY c.due_date LIMIT 25`,
    firmScope,
  )) {
    items.push({
      heading: "risks_unresolved",
      body: `${String(r.commitment_text).slice(0, 140)}${r.due_date ? ` (due ${r.due_date})` : ""}`,
      source_type: "meeting_commitment", source_id: String(r.id), raised_by: "BOTH",
    });
  }

  // 15 · Contradictions the firm has not resolved — an unresolved contradiction is a risk.
  for (const r of await q(
    `SELECT id, topic, materiality FROM contradiction_record WHERE status != 'RESOLVED' ORDER BY created_at DESC LIMIT 10`,
  )) {
    items.push({
      heading: "risks_unresolved",
      body: `Unresolved contradiction: ${String(r.topic).slice(0, 140)} (${r.materiality})`,
      source_type: "contradiction_record", source_id: String(r.id), raised_by: "BOTH",
    });
  }

  return items;
}

/**
 * Merge duplicates while preserving attribution (canon §8).
 *
 * Two items are the same when they point at the same record. When both partners' lenses surface
 * the same row, the merged item is marked BOTH — but a row raised under only one lens keeps that
 * partner, because losing that is losing the disagreement the review exists to surface.
 */
export function mergeItems(items: readonly DerivedItem[]): DerivedItem[] {
  const bySource = new Map<string, DerivedItem>();
  for (const item of items) {
    const key = `${item.heading}:${item.source_type}:${item.source_id}`;
    const seen = bySource.get(key);
    if (!seen) {
      bySource.set(key, { ...item });
      continue;
    }
    if (seen.raised_by !== item.raised_by) seen.raised_by = "BOTH";
  }
  return Array.from(bySource.values());
}

/** Generate (or regenerate) the review for the week containing `now`. */
export async function generateReview(
  env: Env,
  actor: Actor,
  now: Date,
): Promise<{ review: Record<string, unknown>; items: Record<string, unknown>[] }> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "weekly_review.manage", { objectType: "weekly_review", firmScope });
  if (authz.decision !== "ALLOW") throw new WeeklyReviewError(403, "forbidden", authz.reason);

  const week = weekStart(now);
  const id = `wrv_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO weekly_review (id, week_start, firm_scope, created_by) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (firm_scope, week_start) DO UPDATE SET generated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  )
    .bind(id, week, firmScope, actor.firmUserId ?? "system")
    .run();

  const review = (await env.WP_OS_DB.prepare(
    "SELECT * FROM weekly_review WHERE firm_scope = ?1 AND week_start = ?2",
  )
    .bind(firmScope, week)
    .first<Record<string, unknown>>())!;
  const reviewId = String(review.id);

  const derived = mergeItems(await deriveItems(env, firmScope));

  // Regeneration replaces items that are still UNRESOLVED and LEAVES DECIDED ONES ALONE. Wiping
  // the table would erase the partners' decisions the moment anyone refreshed the agenda.
  //
  // OPERATOR ITEMS SURVIVE REGARDLESS. Anything a partner typed into the capture box is not derived
  // from a row, so re-deriving cannot reproduce it — deleting it here would mean a thought
  // disappears the moment somebody refreshes the page, which is the one failure that would stop
  // anyone trusting the box at all.
  await env.WP_OS_DB.prepare(
    "DELETE FROM weekly_review_item WHERE review_id = ?1 AND exit_type = 'UNRESOLVED' AND COALESCE(source_type,'') NOT IN ('operator','meeting_notes')",
  )
    .bind(reviewId)
    .run();

  // DEFERRED ITEMS COME BACK BY THEMSELVES. An item nobody decided has not gone away, and making a
  // partner retype it next week is how it quietly stops being raised. It returns UNRESOLVED with
  // its deferral count incremented — "deferred three times" is usually a more useful finding than
  // the item's own text by that point.
  const priorWeek = new Date(`${week}T00:00:00Z`);
  priorWeek.setUTCDate(priorWeek.getUTCDate() - 7);
  const priorWeekStart = priorWeek.toISOString().slice(0, 10);

  const deferred = ((await env.WP_OS_DB.prepare(
    `SELECT i.heading, i.body, i.raised_by, i.source_type, i.source_id, i.deferred_count
       FROM weekly_review_item i
       JOIN weekly_review r ON r.id = i.review_id
      WHERE r.firm_scope = ?1 AND r.week_start = ?2 AND i.exit_type = 'DEFERRED_ITEM'`,
  )
    .bind(firmScope, priorWeekStart)
    .all<Record<string, unknown>>()).results ?? []);

  for (const d of deferred) {
    const already = await env.WP_OS_DB.prepare(
      "SELECT id FROM weekly_review_item WHERE review_id = ?1 AND body = ?2",
    )
      .bind(reviewId, String(d.body))
      .first();
    if (already) continue;
    await env.WP_OS_DB.prepare(
      `INSERT INTO weekly_review_item (id, review_id, heading, body, raised_by, source_type, source_id, deferred_count, firm_scope)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(
        `wri_${crypto.randomUUID()}`,
        reviewId,
        String(d.heading),
        String(d.body),
        String(d.raised_by ?? "BOTH"),
        d.source_type ?? null,
        d.source_id ?? null,
        Number(d.deferred_count ?? 0) + 1,
        firmScope,
      )
      .run();
  }

  const existing = new Set(
    ((await env.WP_OS_DB.prepare("SELECT source_type, source_id FROM weekly_review_item WHERE review_id = ?1")
      .bind(reviewId)
      .all<{ source_type: string; source_id: string }>()).results ?? []
    ).map((r) => `${r.source_type}:${r.source_id}`),
  );

  for (const item of derived) {
    if (existing.has(`${item.source_type}:${item.source_id}`)) continue;
    await env.WP_OS_DB.prepare(
      `INSERT INTO weekly_review_item (id, review_id, heading, body, raised_by, source_type, source_id, firm_scope)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(`wri_${crypto.randomUUID()}`, reviewId, item.heading, item.body, item.raised_by, item.source_type, item.source_id, firmScope)
      .run();
  }

  /*
   * HAND THE AGENDA OVER, to both partners.
   *
   * SIGNED JOINTLY. The weekly review is one document two partners work through, so it is prepared
   * by both Chiefs of Staff rather than by whichever of them happened to press the button — an
   * agenda that appears to belong to one partner is one the other stops treating as theirs.
   *
   * DELIVERED TO BOTH, for the same reason: it is the firm's page, not a personal one, and it
   * should be on both Home pages without either having to go and find it.
   *
   * Best effort, and re-generating updates the existing deliverable rather than stacking copies —
   * the unique index on (source_type, source_id) does that, and the source is the review.
   */
  try {
    const partners = ((await env.WP_OS_DB.prepare(
      "SELECT id FROM firm_user WHERE firm_scope = ?1",
    ).bind(firmScope).all<{ id: string }>()).results ?? []);

    const items = ((await env.WP_OS_DB.prepare(
      "SELECT heading, body, exit_type, source_type FROM weekly_review_item WHERE review_id = ?1 ORDER BY heading",
    ).bind(reviewId).all<{ heading: string; body: string; exit_type: string; source_type: string | null }>()).results ?? []);

    if (items.length > 0) {
      for (const partner of partners) {
        await deliver(env, actor, {
          kind: "weekly_review",
          title: `Weekly operating review — week of ${week}`,
          body: renderAgenda(items),
          preparedBy: jointByline(),
          preparedFor: partner.id,
          // Scoped per partner so each gets their own row; re-generation updates rather than stacks.
          sourceType: "weekly_review",
          sourceId: `${reviewId}:${partner.id}`,
        });
      }
    }
  } catch {
    // The agenda stands. It simply has not been filed, which the page reports.
  }

  await appendEvent(env, {
    eventType: "weekly_review.generated",
    actorType: actor.type === "HUMAN" ? "firm_user" : "system",
    actorId: actor.firmUserId ?? "system",
    objectType: "weekly_review",
    objectId: reviewId,
    firmScope,
    payload: { week_start: week, item_count: derived.length },
  });

  return await loadReview(env, firmScope, week);
}

export async function loadReview(env: Env, firmScope: string, week: string) {
  const review = await env.WP_OS_DB.prepare(
    "SELECT * FROM weekly_review WHERE firm_scope = ?1 AND week_start = ?2",
  )
    .bind(firmScope, week)
    .first<Record<string, unknown>>();
  if (!review) throw new WeeklyReviewError(404, "not_found", "no review for that week");
  const items = (await env.WP_OS_DB.prepare(
    "SELECT * FROM weekly_review_item WHERE review_id = ?1 ORDER BY heading, created_at",
  )
    .bind(String(review.id))
    .all<Record<string, unknown>>()).results ?? [];
  return { review, items };
}

// ── Route handlers ───────────────────────────────────────────────────────────

function errorResponse(err: unknown): Response {
  if (err instanceof WeeklyReviewError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

export async function handleGetWeeklyReview(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const week = url.searchParams.get("week") ?? weekStart(new Date());
  const scope = "west-peek";
  try {
    const { review, items } = await loadReview(ctx.env, scope, week);
    // ONLY THE HEADINGS THAT HAVE SOMETHING. Sixteen headings render, nine of which currently have
    // no derivation at all and can never populate — so a partner scrolled past a wall of permanent
    // blanks to reach two or three real lines, and learned to skim a page whose whole purpose is
    // that it gets read. A heading returns the moment it has an item.
    const present = new Set(items.map((i) => String(i.heading)));
    const carried = items.filter((i) => Number((i as Record<string, unknown>).deferred_count ?? 0) > 0);
    return json({
      review, items,
      week_end: weekEnd(week),
      headings: REVIEW_HEADINGS.filter((h) => present.has(h.key)),
      // The full list stays available so the capture box can offer every heading as an override,
      // including ones nothing has landed under yet.
      all_headings: REVIEW_HEADINGS,
      resolved: isResolved(items as Array<{ exit_type: string }>),
      // Named so the page can say what is still outstanding instead of showing a bare count.
      unresolved: items.filter((i) => i.exit_type === "UNRESOLVED").length,
      decisions_waiting: items.filter((i) => i.heading === "decisions_required" && i.exit_type === "UNRESOLVED").length,
      carried_over: carried.length,
      /** The oldest thing still on the table. Usually the most useful line on the page. */
      most_deferred: carried.reduce(
        (worst, i) =>
          Number((i as Record<string, unknown>).deferred_count ?? 0) > Number(worst?.deferred_count ?? 0) ? i : worst,
        null as Record<string, unknown> | null,
      ),
    });
  } catch (err) {
    if (err instanceof WeeklyReviewError && err.status === 404) {
      return json({
        review: null, items: [], headings: [], all_headings: REVIEW_HEADINGS,
        resolved: false, unresolved: 0, decisions_waiting: 0, carried_over: 0, most_deferred: null,
      });
    }
    return errorResponse(err);
  }
}

export async function handleGenerateWeeklyReview(ctx: RouteContext): Promise<Response> {
  try {
    const out = await generateReview(ctx.env, actorFromIdentity(ctx.identity!), new Date());
    return json(out, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const exitSchema = z.object({
  exit_type: z.enum(["UNRESOLVED", "DECISION", "OWNER", "DEADLINE", "DELEGATED_ACTION", "DEFERRED_ITEM", "CLOSED_ITEM"]),
  exit_note: z.string().max(2000).nullish(),
  owner_id: z.string().max(80).nullish(),
  deadline: z.string().max(40).nullish(),
});

/** POST /api/weekly-review/items/:id/exit — record how an agenda item was resolved. */
export async function handleSetItemExit(ctx: RouteContext): Promise<Response> {
  const itemId = ctx.params.id;
  const parsed = exitSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!itemId || !parsed.success) return json({ error: "invalid_input" }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "weekly_review.manage", { objectType: "weekly_review_item", objectId: itemId });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const d = parsed.data;
  await ctx.env.WP_OS_DB.prepare(
    `UPDATE weekly_review_item SET exit_type = ?2, exit_note = ?3, owner_id = ?4, deadline = ?5,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`,
  )
    .bind(itemId, d.exit_type, d.exit_note ?? null, d.owner_id ?? null, d.deadline ?? null)
    .run();

  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM weekly_review_item WHERE id = ?1")
    .bind(itemId)
    .first<Record<string, unknown>>();
  if (!row) return json({ error: "not_found" }, { status: 404 });

  // AN EXIT THAT EXITS INTO NOTHING IS NOT AN EXIT. Marking an item OWNER, DEADLINE or
  // DELEGATED_ACTION used to update a column and stop there, so a partner made a real decision in a
  // real meeting and the system forgot it by Thursday. Those three now raise a work card, which is
  // where work already lives — the review stops being a document nobody reopens.
  //
  // DECISION and CLOSED_ITEM deliberately raise nothing: a decision IS the artifact, and closing
  // something is the absence of further work. DEFERRED_ITEM raises nothing either, because it comes
  // back on next week's agenda by itself.
  let workCardId: string | null = null;
  const raisesWork = d.exit_type === "OWNER" || d.exit_type === "DEADLINE" || d.exit_type === "DELEGATED_ACTION";
  if (raisesWork) {
    const { createWorkCardInternal } = await import("./workCards");
    try {
      const card = await createWorkCardInternal(ctx.env, ctx.identity!, {
        title: String(row.body ?? "Weekly review item").slice(0, 200),
        description: `Raised in the weekly review week of ${String(row.review_id ?? "")}. ${d.exit_note ?? ""}`.trim(),
        owner_type: d.owner_id ? "HUMAN" : "UNASSIGNED",
        ...(d.owner_id ? { owner_id: d.owner_id } : {}),
        ...(d.deadline ? { due_at: d.deadline } : {}),
        ...(d.exit_note ? { next_action: d.exit_note } : {}),
        priority: d.exit_type === "DEADLINE" ? "HIGH" : "NORMAL",
      });
      workCardId = card.id;
      await ctx.env.WP_OS_DB.prepare(
        "UPDATE weekly_review_item SET work_card_id = ?2 WHERE id = ?1",
      )
        .bind(itemId, workCardId)
        .run();
    } catch {
      // The exit stands even if the card could not be raised. Losing the decision because the
      // follow-through failed would be the wrong way round.
      workCardId = null;
    }
  }

  await appendEvent(ctx.env, {
    eventType: "weekly_review.item_exited",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "weekly_review_item",
    objectId: itemId,
    firmScope: actor.firmScopes[0] ?? "west-peek",
    payload: { exit_type: d.exit_type, work_card_id: workCardId },
  });

  return json({ ...row, work_card_id: workCardId, work_card_created: Boolean(workCardId) });
}

const dumpSchema = z.object({
  body: z.string().trim().min(3).max(2000),
  /** Optional override. Absent means "you guess", which is the point of the box. */
  heading: z.string().trim().min(2).max(60).optional(),
  /**
   * Set when the line came from meeting notes a partner accepted, so the item can say so. Still an
   * operator item — a person chose to put it on the agenda — but "from the Wednesday notes" is
   * different from "Sequoia typed this", and the page should be able to tell you which.
   */
  from_notes: z.boolean().optional(),
  owner_id: z.string().trim().max(80).optional(),
  deadline: z.string().trim().max(40).optional(),
});

/**
 * POST /api/weekly-review/items — put something on the agenda that no record knows about.
 *
 * WHY THIS EXISTS. Every other item on this page is derived from a row, which is what makes the
 * agenda checkable. But the things that actually decide a fund's week — a hunch about a founder, a
 * worry about runway, a name somebody mentioned — are in two people's heads and nowhere else. Until
 * now they had no way onto the agenda at all, so the review could only discuss what the database
 * already knew.
 *
 * PROVENANCE STAYS HONEST. A dumped item is recorded with source_type 'operator' and the partner
 * who raised it, never dressed up as derived. "Sequoia raised this on 20 Aug" is a different kind
 * of claim from "this is a pending approval", and the page should never blur them.
 */
export async function handleAddReviewItem(ctx: RouteContext): Promise<Response> {
  const parsed = dumpSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "weekly_review.manage", { objectType: "weekly_review_item" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const scope = actor.firmScopes[0] ?? "west-peek";
  const week = weekStart(new Date());
  let review = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM weekly_review WHERE firm_scope = ?1 AND week_start = ?2",
  )
    .bind(scope, week)
    .first<{ id: string }>();

  // Typing a thought should never fail because nobody pressed Generate yet.
  if (!review) {
    await generateReview(ctx.env, actor, new Date());
    review = await ctx.env.WP_OS_DB.prepare(
      "SELECT * FROM weekly_review WHERE firm_scope = ?1 AND week_start = ?2",
    )
      .bind(scope, week)
      .first<{ id: string }>();
  }
  if (!review) return json({ error: "no_review", detail: "could not open this week's review" }, { status: 500 });

  const known = new Set<string>(REVIEW_HEADINGS.map((h) => h.key));
  const heading =
    parsed.data.heading && known.has(parsed.data.heading)
      ? (parsed.data.heading as ReviewHeading)
      : guessHeading(parsed.data.body);

  const raisedBy = ctx.identity!.id.includes("scooter") ? "SCOOTER" : "SEQUOIA";
  const id = `wri_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO weekly_review_item (id, review_id, heading, body, raised_by, source_type, source_id, owner_id, deadline, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      id,
      review.id,
      heading,
      parsed.data.body,
      raisedBy,
      parsed.data.from_notes ? "meeting_notes" : "operator",
      ctx.identity!.id,
      parsed.data.owner_id ?? null,
      parsed.data.deadline ?? null,
      scope,
    )
    .run();

  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM weekly_review_item WHERE id = ?1").bind(id).first();
  return json({ item: row, guessed: !parsed.data.heading }, { status: 201 });
}

const refileSchema = z.object({ heading: z.string().trim().min(2).max(60) });

/**
 * POST /api/weekly-review/items/:id/heading — move an item to a different heading.
 *
 * Exists because the capture box GUESSES. A guess is only acceptable when being wrong is cheap, and
 * "cheap" has to mean one control on the item itself — not retyping it, and not a settings page.
 */
export async function handleRefileReviewItem(ctx: RouteContext): Promise<Response> {
  const itemId = ctx.params.id;
  const parsed = refileSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!itemId || !parsed.success) return json({ error: "invalid_input" }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "weekly_review.manage", {
    objectType: "weekly_review_item",
    objectId: itemId,
  });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  // A heading the canon does not define would render nowhere and be invisible rather than moved.
  if (!REVIEW_HEADINGS.some((h) => h.key === parsed.data.heading)) {
    return json({ error: "unknown_heading", detail: parsed.data.heading }, { status: 400 });
  }

  await ctx.env.WP_OS_DB.prepare(
    "UPDATE weekly_review_item SET heading = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  )
    .bind(itemId, parsed.data.heading)
    .run();

  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM weekly_review_item WHERE id = ?1").bind(itemId).first();
  if (!row) return json({ error: "not_found" }, { status: 404 });
  return json(row);
}

/**
 * DELETE /api/weekly-review/items/:id — take an item off the agenda.
 *
 * WHY DELETION IS ALLOWED AT ALL, on a page where nothing else is. Every other record here is
 * evidence: a decision, an owner, a deadline. An agenda item is not evidence — it is a proposal
 * about what to spend the meeting on, and a proposal you do not want to discuss should be
 * removable. The operator's report was an item they could not place and could not remove.
 *
 * IT IS A REAL DELETE, and that is the right call here rather than the soft-delete used for work
 * cards. A dropped work card records a DECISION not to do something, which is worth keeping. An
 * agenda item removed before the meeting records nothing — it was never discussed. Keeping a
 * tombstone would just move the clutter.
 *
 * The event ledger keeps the fact that it happened, including the item's text, so the deletion
 * itself is on the record even though the row is not.
 *
 * A DERIVED ITEM COMES BACK. If the deal is still screening, next week's agenda raises it again —
 * deleting it says "not this week", not "never". Only a typed item is gone for good, because
 * nothing can re-derive a thought.
 */
export async function handleDeleteReviewItem(ctx: RouteContext): Promise<Response> {
  const itemId = ctx.params.id;
  if (!itemId) return json({ error: "invalid_input" }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "weekly_review.manage", {
    objectType: "weekly_review_item",
    objectId: itemId,
  });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM weekly_review_item WHERE id = ?1")
    .bind(itemId)
    .first<Record<string, unknown>>();
  if (!row) return json({ error: "not_found" }, { status: 404 });

  await ctx.env.WP_OS_DB.prepare("DELETE FROM weekly_review_item WHERE id = ?1").bind(itemId).run();

  await appendEvent(ctx.env, {
    eventType: "weekly_review.item_removed",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "weekly_review_item",
    objectId: itemId,
    firmScope: String(row.firm_scope ?? "west-peek"),
    // The text goes in the payload so the ledger answers "what was removed", not just "something was".
    payload: { heading: row.heading, body: row.body, source_type: row.source_type },
  });

  return json({ removed: itemId, was_typed: row.source_type === "operator" || row.source_type === "meeting_notes" });
}

const notesSchema = z.object({
  notes: z.string().trim().min(20).max(60_000),
  /**
   * What is in these notes. The partner says, because only they know what the meeting covered.
   * Defaults to INTERNAL, which is what an ordinary partner meeting is.
   */
  sensitivity: z.enum(["PUBLIC", "INTERNAL", "RESTRICTED", "LP_PRIVATE", "CONFIDENTIAL", "MNPI_SENSITIVE"]).default("INTERNAL"),
});

/**
 * POST /api/weekly-review/notes — read meeting notes and PROPOSE agenda items.
 *
 * PROPOSES. Writes nothing. The partner accepts the ones that are right, and each accepted item is
 * created through the ordinary path. A model reading a meeting and silently filling the agenda
 * would put words in two partners' mouths on the page they make decisions from.
 *
 * THE NOTES ARE NOT STORED. Only accepted items are, and each records that it came from notes. A
 * transcript of a partner meeting is a far heavier thing to hold than a line saying what to do
 * about it, and there is no reason to hold the former.
 *
 * THE SENSITIVITY LABEL IS THE PARTNER'S TO SET, because only they know whether the meeting
 * discussed LP commitments or material non-public information. If they say it did, the AI boundary
 * refuses the run — OpenRouter is permitted PUBLIC and INTERNAL and nothing else — and the refusal
 * is reported plainly so they can type the items by hand instead. Guessing INTERNAL on their behalf
 * would be the system quietly relabelling somebody else's confidential conversation.
 */
export async function handleReviewNotes(ctx: RouteContext): Promise<Response> {
  const parsed = notesSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "weekly_review.manage", { objectType: "weekly_review" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const week = weekStart(new Date());
  const { run } = await runAi(ctx.env, {
    purpose: `weekly review: reading meeting notes for the week of ${week}`,
    actor,
    inputs: [buildNotesPrompt(parsed.data.notes, week)],
    sensitivity: parsed.data.sensitivity as never,
    budgetContext: { expectedOutputTokens: 1500 },
    routing: { category: "OPERATIONS", taskClass: "employee-work" },
  });

  if (run.status === "EGRESS_BLOCKED") {
    return json(
      {
        error: "refused_by_privacy_boundary",
        detail:
          `These notes are labelled ${parsed.data.sensitivity}, which may not be sent to a model. ` +
          "Nothing was sent. Add the items by hand using the box above.",
        run_id: run.id,
      },
      { status: 409 },
    );
  }
  if (run.status !== "COMPLETED" || !run.output_text) {
    return json({ error: "read_failed", detail: run.failure_reason ?? `run ended ${run.status}`, run_id: run.id }, { status: 502 });
  }

  const proposals = parseProposals(run.output_text);
  if (!proposals) {
    return json({ error: "unreadable", detail: "the model did not return usable items", run_id: run.id }, { status: 502 });
  }

  return json({
    proposals: proposals.map((p) => ({ ...p, owner_id: resolveOwner(p.owner_hint) })),
    run_id: run.id,
    prompt_version: NOTES_PROMPT_VERSION,
    note:
      proposals.length === 0
        ? "Nothing in those notes needed deciding or doing. That is a real answer, not a failure."
        : "Nothing has been added yet. Accept the ones that are right.",
  });
}

/**
 * The agenda as a document.
 *
 * Grouped by heading, because that is how the meeting runs. Items already decided are marked as
 * such rather than dropped — an agenda that hides what was settled makes it look like nothing
 * happened last week.
 */
function renderAgenda(
  items: readonly { heading: string; body: string; exit_type: string; source_type: string | null }[],
): string {
  const byHeading = new Map<string, typeof items[number][]>();
  for (const i of items) {
    const list = byHeading.get(i.heading) ?? [];
    list.push(i);
    byHeading.set(i.heading, list);
  }

  const out: string[] = [];
  for (const h of REVIEW_HEADINGS) {
    const rows = byHeading.get(h.key);
    if (!rows?.length) continue;
    out.push(`## ${h.label}`, "");
    for (const r of rows) {
      const settled = r.exit_type !== "UNRESOLVED" ? ` _(${r.exit_type.toLowerCase().replace(/_/g, " ")})_` : "";
      const typed = r.source_type === "operator" ? " · you raised this" : "";
      out.push(`- ${r.body}${settled}${typed}`);
    }
    out.push("");
  }
  return out.join("\n");
}
