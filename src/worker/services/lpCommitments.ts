import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize } from "./authorize";

/**
 * What an LP committed, and how big the fund is.
 *
 * THE TWO QUESTIONS ANYBODY ASKS ABOUT LIMITED PARTNERS, and until now this system could answer
 * neither. Operator, on the LP page: "i have no idea what a claim is." The vocabulary was the
 * smaller half — there was nowhere to record how much money an LP had committed, or the fund's
 * size. "COMMITTED" existed only as a status string in three places, so the system could say an LP
 * had committed while holding no idea what to, or how much.
 *
 * THE TOTAL IS DERIVED, NEVER TYPED. `target_size_minor` is what a partner says they are raising;
 * everything else is summed from commitments that actually exist. A fund that can report a total
 * nobody signed for is a fund that will eventually report the wrong one — and this is the number
 * that ends up in an LP letter.
 *
 * SOFT IS NOT IN THE TOTAL, and that distinction is the whole reason `state` exists. A verbal yes
 * over dinner belongs in the pipeline view because it tells the partner where the raise stands. It
 * does not belong in "committed", because the moment those two numbers are the same figure, the
 * fund's headline is a hope.
 */

/** Minor units everywhere. Money is never a float in this file. */
function toMinor(amount: number): number {
  return Math.round(amount * 100);
}

export function fromMinor(minor: number): number {
  return minor / 100;
}

const commitmentSchema = z.object({
  lp_record_id: z.string().trim().min(1),
  fund_id: z.string().trim().min(1),
  /** Whole currency units as a partner types them; converted to minor units on the way in. */
  amount: z.number().positive(),
  state: z.enum(["SOFT", "SIGNED", "WITHDRAWN"]).default("SOFT"),
  committed_on: z.string().trim().optional(),
  note: z.string().trim().max(1000).optional(),
});

export async function handleRecordCommitment(ctx: RouteContext): Promise<Response> {
  const parsed = commitmentSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") {
    return json({ error: "forbidden", detail: "only a person may record what an LP committed" }, { status: 403 });
  }
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const input = parsed.data;

  const authz = await authorize(ctx.env, actor, "lp_commitment.record", {
    objectType: "lp_record",
    objectId: input.lp_record_id,
    firmScope,
  });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const lp = await ctx.env.WP_OS_DB.prepare("SELECT id, legal_name FROM lp_record WHERE id = ?1 AND firm_scope = ?2")
    .bind(input.lp_record_id, firmScope)
    .first<{ id: string; legal_name: string }>();
  if (!lp) return json({ error: "not_found", detail: "no such LP" }, { status: 404 });

  const fund = await ctx.env.WP_OS_DB.prepare("SELECT id, name, currency FROM fund WHERE id = ?1 AND firm_scope = ?2")
    .bind(input.fund_id, firmScope)
    .first<{ id: string; name: string; currency: string }>();
  if (!fund) return json({ error: "not_found", detail: "no such fund" }, { status: 404 });

  const amountMinor = toMinor(input.amount);
  const existing = await ctx.env.WP_OS_DB.prepare(
    "SELECT id, amount_minor, state FROM lp_commitment WHERE lp_record_id = ?1 AND fund_id = ?2 AND firm_scope = ?3",
  )
    .bind(lp.id, fund.id, firmScope)
    .first<{ id: string; amount_minor: number; state: string }>();

  // An increase EDITS the row rather than adding one. Two rows for the same LP and fund would
  // double-count the same money in the fund's total, which is the one number that has to be right.
  const id = existing?.id ?? `lpc_${crypto.randomUUID()}`;
  if (existing) {
    await ctx.env.WP_OS_DB.prepare(
      `UPDATE lp_commitment
          SET amount_minor = ?2, state = ?3, committed_on = ?4, note = ?5,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?1`,
    )
      .bind(id, amountMinor, input.state, input.committed_on ?? null, input.note ?? null)
      .run();
  } else {
    await ctx.env.WP_OS_DB.prepare(
      `INSERT INTO lp_commitment (id, lp_record_id, fund_id, amount_minor, currency, state, committed_on, note, firm_scope, recorded_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
      .bind(id, lp.id, fund.id, amountMinor, fund.currency ?? "USD", input.state, input.committed_on ?? null, input.note ?? null, firmScope, actor.firmUserId!)
      .run();
  }

  // Both the old and new amounts, because "raised it from 2m to 5m" is the interesting fact and a
  // record that only ever holds the current figure cannot tell anyone that it moved.
  await appendEvent(ctx.env, {
    eventType: existing ? "lp_commitment.revised" : "lp_commitment.recorded",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "lp_commitment",
    objectId: id,
    firmScope,
    payload: {
      lp: lp.legal_name,
      fund: fund.name,
      amount_minor: amountMinor,
      ...(existing ? { from_amount_minor: existing.amount_minor, from_state: existing.state } : {}),
      state: input.state,
    },
  });

  return json({ id, lp: lp.legal_name, fund: fund.name, amount: input.amount, state: input.state }, { status: existing ? 200 : 201 });
}

const fundSizeSchema = z.object({
  target_size: z.number().positive().nullable(),
  currency: z.string().trim().length(3).optional(),
  vintage_year: z.number().int().min(2000).max(2100).nullable().optional(),
});

export async function handleSetFundSize(ctx: RouteContext): Promise<Response> {
  const parsed = fundSizeSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") return json({ error: "forbidden", detail: "human-only" }, { status: 403 });
  const firmScope = actor.firmScopes[0] ?? "west-peek";

  const authz = await authorize(ctx.env, actor, "fund.set_size", { objectType: "fund", objectId: ctx.params.id!, firmScope });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const before = await ctx.env.WP_OS_DB.prepare("SELECT target_size_minor FROM fund WHERE id = ?1 AND firm_scope = ?2")
    .bind(ctx.params.id!, firmScope)
    .first<{ target_size_minor: number | null }>();
  if (!before) return json({ error: "not_found" }, { status: 404 });

  await ctx.env.WP_OS_DB.prepare(
    "UPDATE fund SET target_size_minor = ?2, currency = COALESCE(?3, currency), vintage_year = COALESCE(?4, vintage_year) WHERE id = ?1",
  )
    .bind(
      ctx.params.id!,
      parsed.data.target_size === null ? null : toMinor(parsed.data.target_size),
      parsed.data.currency ?? null,
      parsed.data.vintage_year ?? null,
    )
    .run();

  await appendEvent(ctx.env, {
    eventType: "fund.size_set",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "fund",
    objectId: ctx.params.id!,
    firmScope,
    payload: { from_minor: before.target_size_minor, to_minor: parsed.data.target_size === null ? null : toMinor(parsed.data.target_size) },
  });

  return json({ ok: true });
}

/**
 * Where the raise stands, for one fund.
 *
 * Signed and soft are returned as separate figures and never added together. A partner looking at
 * this has to be able to tell what is banked from what is hoped, and one number labelled "raised"
 * removes exactly that distinction.
 */
export async function handleFundraisingSummary(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const firmScope = actor.firmScopes[0] ?? "west-peek";

  const funds = (
    await ctx.env.WP_OS_DB.prepare(
      "SELECT id, name, currency, target_size_minor, vintage_year FROM fund WHERE firm_scope = ?1 ORDER BY created_at",
    )
      .bind(firmScope)
      .all<{ id: string; name: string; currency: string; target_size_minor: number | null; vintage_year: number | null }>()
  ).results ?? [];

  const totals = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT fund_id, state, COUNT(*) AS n, SUM(amount_minor) AS total
         FROM lp_commitment WHERE firm_scope = ?1 GROUP BY fund_id, state`,
    )
      .bind(firmScope)
      .all<{ fund_id: string; state: string; n: number; total: number }>()
  ).results ?? [];

  return json({
    funds: funds.map((f) => {
      const mine = totals.filter((t) => t.fund_id === f.id);
      const at = (state: string) => mine.find((t) => t.state === state);
      const signed = at("SIGNED");
      const soft = at("SOFT");
      const targetMinor = f.target_size_minor;
      const signedMinor = signed?.total ?? 0;
      return {
        id: f.id,
        name: f.name,
        currency: f.currency ?? "USD",
        vintage_year: f.vintage_year,
        target: targetMinor === null ? null : fromMinor(targetMinor),
        signed: fromMinor(signedMinor),
        signed_count: signed?.n ?? 0,
        soft: fromMinor(soft?.total ?? 0),
        soft_count: soft?.n ?? 0,
        // Against the TARGET, and only when there is one. A percentage of nothing is not zero
        // per cent, it is a question nobody has answered yet.
        percent_of_target: targetMinor && targetMinor > 0 ? Math.round((signedMinor / targetMinor) * 1000) / 10 : null,
      };
    }),
  });
}

export async function handleListCommitments(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const rows = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT c.id, c.amount_minor, c.currency, c.state, c.committed_on, c.note,
              l.legal_name AS lp_name, l.id AS lp_record_id, f.name AS fund_name, f.id AS fund_id
         FROM lp_commitment c
         JOIN lp_record l ON l.id = c.lp_record_id
         JOIN fund f ON f.id = c.fund_id
        WHERE c.firm_scope = ?1
        ORDER BY c.amount_minor DESC`,
    )
      .bind(firmScope)
      .all<Record<string, unknown>>()
  ).results ?? [];

  return json({
    commitments: rows.map((r) => ({ ...r, amount: fromMinor(Number(r.amount_minor)) })),
  });
}
