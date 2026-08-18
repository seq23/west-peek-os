import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { json } from "../router";
import type { RouteContext } from "../router";
import { actorFromIdentity, authorize, type Actor } from "./authorize";

/**
 * Cross-office reconciliation (P38, V1 #8, canon §7.5).
 *
 * Canon's coordination law: "A central orchestration service detects duplicate requests,
 * contradictory instructions, resource conflicts, and overlapping outbound drafts." Those four
 * detectors are implemented here and nothing else is — a fifth would be a change to the law.
 *
 * WHAT THIS IS ACTUALLY GUARDING AGAINST. Two Managing Partners each get a personal office with a
 * Chief of Staff and an EA. Both offices have full access to the firm. The failure mode canon is
 * worried about is not malice, it is two competent offices independently doing the same work — the
 * same founder emailed twice, the same employee committed to two jobs at once, two drafts going to
 * the same LP. None of those look wrong from inside either office.
 *
 * DETECTION IS IDEMPOTENT. Each finding carries a stable dedupe_key, so running the detector twice
 * updates `last_seen_at` rather than raising a second copy. A conflict surface that re-raises what
 * you already resolved is one people stop reading, and then it protects nothing.
 *
 * PRIVACY: §7.5 keeps partner-private notes private. Every detector below reads only shared firm
 * records — work cards, external effect requests, governance updates. No private note is read, and
 * no conflict row can contain one.
 */

export class CrossOfficeError extends Error {
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

export interface Finding {
  conflict_type: "DUPLICATE_REQUEST" | "CONTRADICTORY_INSTRUCTION" | "RESOURCE_CONFLICT" | "OVERLAPPING_OUTBOUND";
  object_type: string;
  object_id: string;
  summary: string;
  detail: Record<string, unknown>;
  dedupe_key: string;
}

/**
 * Run all four detectors.
 *
 * Exported for tests: each detector is a SQL shape that is easy to get subtly wrong, and a detector
 * that silently returns nothing is indistinguishable from a firm with no conflicts.
 */
export async function detectConflicts(env: Env, firmScope: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const q = async (sql: string, ...binds: unknown[]) =>
    (await env.WP_OS_DB.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results ?? [];

  // 1 · DUPLICATE REQUESTS — two open work cards created by DIFFERENT people against the same
  // object. Same person creating two cards is their own business; two offices doing it separately
  // is the thing neither can see.
  for (const r of await q(
    `SELECT a.id AS a_id, b.id AS b_id, a.title AS a_title, b.title AS b_title,
            a.created_by AS a_by, b.created_by AS b_by, a.machine_id
       FROM work_card a
       JOIN work_card b
         ON a.machine_id = b.machine_id
        AND a.id < b.id
        AND a.created_by <> b.created_by
      WHERE a.state IN ('OPEN','IN_PROGRESS') AND b.state IN ('OPEN','IN_PROGRESS')
        AND a.machine_id IS NOT NULL
        AND a.firm_scope = ?1 AND b.firm_scope = ?1
      LIMIT 25`,
    firmScope,
  )) {
    findings.push({
      conflict_type: "DUPLICATE_REQUEST",
      object_type: "work_card",
      object_id: String(r.a_id),
      summary: `Two offices have open work on the same machine: "${r.a_title}" and "${r.b_title}"`,
      detail: { a: r.a_id, b: r.b_id, a_by: r.a_by, b_by: r.b_by, machine_id: r.machine_id },
      // Sorted pair so the key is identical whichever order the join returns them in.
      dedupe_key: `dup:${[r.a_id, r.b_id].sort().join(":")}`,
    });
  }

  // 2 · RESOURCE CONFLICTS — one AI employee holding work from two different requesters at once.
  // The ≤5 active-employee cap makes this likely rather than theoretical.
  for (const r of await q(
    `SELECT w.owner_id, e.name, COUNT(DISTINCT w.created_by) AS requesters, COUNT(*) AS cards
       FROM work_card w
       LEFT JOIN ai_employee e ON e.id = w.owner_id
      WHERE w.owner_type = 'AI' AND w.state IN ('OPEN','IN_PROGRESS') AND w.firm_scope = ?1
      GROUP BY w.owner_id
     HAVING requesters > 1
      LIMIT 25`,
    firmScope,
  )) {
    findings.push({
      conflict_type: "RESOURCE_CONFLICT",
      object_type: "ai_employee",
      object_id: String(r.owner_id),
      summary: `${r.name ?? r.owner_id} is holding ${r.cards} open cards from ${r.requesters} different requesters`,
      detail: { requesters: r.requesters, cards: r.cards },
      dedupe_key: `res:${r.owner_id}`,
    });
  }

  // 3 · OVERLAPPING OUTBOUND DRAFTS — more than one unexecuted effect aimed at the same recipient.
  // This is the one with real external consequence: two offices each about to email the same LP.
  for (const r of await q(
    `SELECT destination, effect_type, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
       FROM external_effect_request
      WHERE state IN ('REQUESTED','APPROVED')
      GROUP BY destination, effect_type
     HAVING n > 1
      LIMIT 25`,
  )) {
    findings.push({
      conflict_type: "OVERLAPPING_OUTBOUND",
      object_type: "external_effect_request",
      object_id: String(r.ids).split(",")[0] ?? "",
      summary: `${r.n} unsent ${r.effect_type} drafts are queued for ${r.destination}`,
      detail: { destination: r.destination, effect_type: r.effect_type, ids: String(r.ids).split(",") },
      dedupe_key: `out:${r.effect_type}:${r.destination}`,
    });
  }

  // 4 · CONTRADICTORY INSTRUCTIONS — two governance updates with the same title issued by
  // different partners. Governance updates are how a partner tells the firm "do it this way", so
  // two of them on one subject is the literal case canon describes.
  //
  // NOTE: governance_update has no lifecycle column — every row is live once issued — so this
  // cannot filter to "active". If a status is added later, this query should filter on it;
  // without one, matching titles is the honest signal available.
  for (const r of await q(
    `SELECT a.id AS a_id, b.id AS b_id, a.title, a.issued_by AS a_by, b.issued_by AS b_by
       FROM governance_update a
       JOIN governance_update b
         ON a.title = b.title AND a.id < b.id AND a.issued_by <> b.issued_by
      WHERE a.firm_scope = ?1 AND b.firm_scope = ?1
      LIMIT 25`,
    firmScope,
  )) {
    findings.push({
      conflict_type: "CONTRADICTORY_INSTRUCTION",
      object_type: "governance_update",
      object_id: String(r.a_id),
      summary: `Both partners issued an instruction titled "${r.title}"`,
      detail: { a: r.a_id, b: r.b_id, a_by: r.a_by, b_by: r.b_by },
      dedupe_key: `instr:${[r.a_id, r.b_id].sort().join(":")}`,
    });
  }

  return findings;
}

/** Persist findings idempotently. Resolved conflicts are NOT reopened by a later run. */
export async function recordFindings(env: Env, firmScope: string, findings: readonly Finding[]): Promise<number> {
  let raised = 0;
  for (const f of findings) {
    const existing = await env.WP_OS_DB.prepare(
      "SELECT id, status FROM cross_office_conflict WHERE firm_scope = ?1 AND dedupe_key = ?2",
    )
      .bind(firmScope, f.dedupe_key)
      .first<{ id: string; status: string }>();

    if (existing) {
      // Touch last_seen_at so a still-live conflict shows as current — but leave the status alone.
      // Reopening something a partner deliberately ACCEPTED would override a human decision on
      // every detection run.
      await env.WP_OS_DB.prepare(
        "UPDATE cross_office_conflict SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
      )
        .bind(existing.id)
        .run();
      continue;
    }

    const id = `cof_${crypto.randomUUID()}`;
    await env.WP_OS_DB.prepare(
      `INSERT INTO cross_office_conflict (id, conflict_type, object_type, object_id, summary, detail_json, dedupe_key, firm_scope)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(id, f.conflict_type, f.object_type, f.object_id, f.summary, JSON.stringify(f.detail), f.dedupe_key, firmScope)
      .run();
    raised += 1;

    // §7.5: "Every cross-office handoff, conflict, override, and resolution is logged."
    await appendEvent(env, {
      eventType: "cross_office.conflict_detected",
      actorType: "system",
      actorId: "system",
      objectType: "cross_office_conflict",
      objectId: id,
      firmScope,
      payload: { conflict_type: f.conflict_type, dedupe_key: f.dedupe_key },
    });
  }
  return raised;
}

// ── Route handlers ───────────────────────────────────────────────────────────

function errorResponse(err: unknown): Response {
  if (err instanceof CrossOfficeError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

/** GET /api/cross-office — open conflicts, newest first. */
export async function handleListConflicts(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const status = url.searchParams.get("status") ?? "OPEN";
  const rows = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM cross_office_conflict WHERE status = ?1 ORDER BY last_seen_at DESC LIMIT 200",
  )
    .bind(status)
    .all<Record<string, unknown>>();
  const conflicts = rows.results ?? [];
  return json({
    conflicts,
    counts: conflicts.reduce<Record<string, number>>((acc, c) => {
      const k = String(c.conflict_type);
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
  });
}

/** POST /api/cross-office/detect — run the four detectors. */
export async function handleDetect(ctx: RouteContext): Promise<Response> {
  const actor: Actor = actorFromIdentity(ctx.identity!);
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(ctx.env, actor, "weekly_review.manage", { objectType: "cross_office_conflict", firmScope });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });
  try {
    const findings = await detectConflicts(ctx.env, firmScope);
    const raised = await recordFindings(ctx.env, firmScope, findings);
    return json({ detected: findings.length, newly_raised: raised }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const resolveSchema = z.object({
  status: z.enum(["RESOLVED", "ACCEPTED"]),
  resolution_note: z.string().max(2000).nullish(),
});

/** POST /api/cross-office/:id/resolve — record how a conflict was settled. */
export async function handleResolveConflict(ctx: RouteContext): Promise<Response> {
  const id = ctx.params.id;
  const parsed = resolveSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!id || !parsed.success) return json({ error: "invalid_input" }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "weekly_review.manage", { objectType: "cross_office_conflict", objectId: id });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  await ctx.env.WP_OS_DB.prepare(
    `UPDATE cross_office_conflict SET status = ?2, resolution_note = ?3, resolved_by = ?4,
            resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`,
  )
    .bind(id, parsed.data.status, parsed.data.resolution_note ?? null, actor.firmUserId ?? null)
    .run();

  await appendEvent(ctx.env, {
    eventType: "cross_office.conflict_resolved",
    actorType: "firm_user",
    actorId: actor.firmUserId ?? "system",
    objectType: "cross_office_conflict",
    objectId: id,
    payload: { status: parsed.data.status, note: parsed.data.resolution_note ?? null },
  });

  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM cross_office_conflict WHERE id = ?1").bind(id).first();
  if (!row) return json({ error: "not_found" }, { status: 404 });
  return json(row);
}
