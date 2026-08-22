import { z } from "zod";
import type { RouteContext } from "../router";
import { json } from "../router";
import { actorFromIdentity, authorize } from "./authorize";
import { appendEvent } from "../events";

/**
 * Approving something once, and not being asked again — within bounds nobody can omit.
 *
 * Operator, 22 Aug 2026. The reasoning is `docs/APPROVAL_AND_WORK_DESIGN.md`; the architecture is
 * ADR-018. The single sentence that governs this file: **authority is delegable, judgment is not.**
 *
 * WHAT MAKES IT SAFE IS WHERE IT IS CHECKED, not what this file refuses. `authorize()` consults a
 * standing grant only AFTER the reserved and external-effect branches have already returned, so a
 * grant cannot cover one of those however it was recorded. The refusal below is a second line —
 * worth having so the impossible row is never written and the partner is told why at the moment she
 * asks, rather than granted something that silently does nothing.
 */

/** End of this task, end of today, end of this week. There is deliberately no fourth option. */
export const GRANT_WINDOWS = ["THIS_TASK", "TODAY", "THIS_WEEK"] as const;
export type GrantWindow = (typeof GRANT_WINDOWS)[number];

/**
 * How many uses each window carries.
 *
 * Bounded by count as well as by time, because a week is a long time for an unbounded permission and
 * the count is what limits the damage of a grant that turns out to have been a mistake. These are
 * generous against real use — a partner delegating a repetitive approval sees a handful a day — and
 * tight against a loop.
 */
const USES_FOR_WINDOW: Readonly<Record<GrantWindow, number>> = {
  THIS_TASK: 25,
  TODAY: 25,
  THIS_WEEK: 100,
};

const grantSchema = z.object({
  action_key: z.string().trim().min(3),
  window: z.enum(GRANT_WINDOWS),
  reason: z.string().trim().min(4),
  object_type: z.string().trim().min(1).optional(),
  object_id: z.string().trim().min(1).optional(),
  work_card_id: z.string().trim().min(1).optional(),
});

/**
 * When the grant stops.
 *
 * Computed in UTC from a passed-in clock rather than read from `Date.now()` inside the SQL, so the
 * boundary is testable — and so "end of today" means the end of a day somebody can name rather than
 * whatever the database thought the time was.
 */
export function endsAt(window: GrantWindow, now: Date): string {
  const d = new Date(now.getTime());
  if (window === "THIS_TASK") {
    // A task grant is bounded by the card closing, not by the clock. The clock is a backstop for a
    // card nobody ever closes — an open card is not a permanent permission.
    d.setUTCDate(d.getUTCDate() + 30);
  } else if (window === "TODAY") {
    d.setUTCHours(23, 59, 59, 999);
  } else {
    // Through the end of Sunday. `getUTCDay()` is 0 on Sunday, so a Sunday grant lasts that day
    // rather than eight more.
    const daysLeft = (7 - d.getUTCDay()) % 7;
    d.setUTCDate(d.getUTCDate() + daysLeft);
    d.setUTCHours(23, 59, 59, 999);
  }
  return d.toISOString();
}

export async function handleGrantStandingAuthority(ctx: RouteContext): Promise<Response> {
  const parsed = grantSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) {
    return json({ error: "invalid_input", detail: "Say which action, for how long, and why." }, { status: 400 });
  }
  const input = parsed.data;

  const actor = actorFromIdentity(ctx.identity!);
  // Granting authority is itself an act that needs authority. A partner may delegate what she can
  // already do; nobody may delegate their way up.
  const authz = await authorize(ctx.env, actor, "standing_authority.grant", {
    objectType: "standing_authority",
    objectId: input.action_key,
  });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const action = await ctx.env.WP_OS_DB.prepare(
    "SELECT key, name, is_reserved, is_external_effect FROM action_type WHERE key = ?1",
  )
    .bind(input.action_key)
    .first<{ key: string; name: string; is_reserved: number; is_external_effect: number }>();
  if (!action) {
    return json({ error: "unknown_action", detail: `Nothing in this system does ${input.action_key}.` }, { status: 400 });
  }

  /*
   * THE REFUSAL THAT MATTERS. Reserved actions are reserved because the judgment IS the work —
   * deciding an investment, approving a valuation, concluding a legal question. External effects
   * leave the building. Neither is delegable, and saying so plainly is more useful than a generic
   * denial: a partner who is told "this one always comes back to you, and here is why" learns the
   * shape of the system rather than that it said no.
   */
  if (action.is_reserved === 1 || action.is_external_effect === 1) {
    return json(
      {
        error: "not_delegable",
        detail:
          action.is_reserved === 1
            ? `${action.name} is reserved to a partner. The judgement is the work, so it comes back to you every time — there is no version of this you can delegate ahead.`
            : `${action.name} leaves the building. Anything that reaches somebody outside the firm is decided one message at a time.`,
      },
      { status: 400 },
    );
  }

  if (input.window === "THIS_TASK" && !input.work_card_id) {
    return json(
      { error: "invalid_input", detail: "A grant that lasts until a task is done needs the task." },
      { status: 400 },
    );
  }

  const id = `sta_${crypto.randomUUID()}`;
  const ends = endsAt(input.window, new Date());
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO standing_authority
       (id, action_key, object_type, object_id, work_card_id, ends_at, max_uses, granted_by, reason)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      id,
      input.action_key,
      input.object_type ?? null,
      input.object_id ?? null,
      input.work_card_id ?? null,
      ends,
      USES_FOR_WINDOW[input.window],
      ctx.identity!.id,
      input.reason,
    )
    .run();

  await appendEvent(ctx.env, {
    eventType: "authority.standing_granted",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "standing_authority",
    objectId: id,
    payload: { action_key: input.action_key, window: input.window, ends_at: ends, reason: input.reason },
  });

  return json({ id, ends_at: ends, max_uses: USES_FOR_WINDOW[input.window] }, { status: 201 });
}

/** Everything currently delegated, and everything recently spent or stopped. */
export async function handleListStandingAuthority(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT sa.id, sa.action_key, sa.object_type, sa.object_id, sa.work_card_id, sa.ends_at,
            sa.max_uses, sa.uses, sa.reason, sa.revoked_at, sa.created_at,
            at.name AS action_name, wc.title AS work_card_title, wc.state AS work_card_state,
            fu.full_name AS granted_by_name
       FROM standing_authority sa
       LEFT JOIN action_type at ON at.key = sa.action_key
       LEFT JOIN work_card wc ON wc.id = sa.work_card_id
       LEFT JOIN firm_user fu ON fu.id = sa.granted_by
      ORDER BY sa.created_at DESC
      LIMIT 100`,
  ).all<Record<string, unknown>>();

  const now = new Date().toISOString();
  const all = (rows.results ?? []).map((r) => ({
    ...r,
    // Computed here rather than asked of the reader. "Expired" and "used up" and "revoked" are three
    // different reasons a grant is no longer doing anything, and a list that shows only a date makes
    // a partner work out which one applies.
    live:
      !r.revoked_at &&
      String(r.ends_at) > now &&
      Number(r.uses) < Number(r.max_uses) &&
      (!r.work_card_id || ["OPEN", "IN_PROGRESS", "BLOCKED"].includes(String(r.work_card_state))),
    spent: Number(r.uses) >= Number(r.max_uses),
  }));

  return json({ live: all.filter((r) => r.live), finished: all.filter((r) => !r.live) });
}

/**
 * Stopping is always safe, so revoking needs no reason and no approval.
 *
 * The same rule that already governs pausing an employee: a control that makes the system do less
 * should never be harder to reach than the one that made it do more.
 */
export async function handleRevokeStandingAuthority(ctx: RouteContext): Promise<Response> {
  const res = await ctx.env.WP_OS_DB.prepare(
    "UPDATE standing_authority SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revoked_by = ?2 WHERE id = ?1 AND revoked_at IS NULL",
  )
    .bind(ctx.params.id!, ctx.identity!.id)
    .run();
  if ((res.meta?.changes ?? 0) === 0) return json({ error: "not_found" }, { status: 404 });

  await appendEvent(ctx.env, {
    eventType: "authority.standing_revoked",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "standing_authority",
    objectId: ctx.params.id!,
    payload: {},
  });
  return json({ ok: true });
}
