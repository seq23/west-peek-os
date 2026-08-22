import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { runAi } from "../ai/runAi";

/**
 * How the fund is actually doing, computed rather than typed.
 *
 * Operator, 21 Aug 2026: "we are going to need to report to the LPs how the fund is doing and that
 * progress and accurate account of how the fund is doing lives where?... the LP page needs to allow
 * us to create a report for LPs at the drop of a hat that explains where we are at any given time
 * with metrics LPs care about."
 *
 * WHERE EACH FACT LIVES, and it is deliberately not "both":
 *   Portfolio — what we own, what we paid, and what it is worth now. A mark is a fact about a
 *               holding, and it changes when a company raises.
 *   LP        — what each investor committed, what was called, what came back. Facts about the
 *               relationship, not about a company.
 *   Fund strategy — the PLAN, and never actuals. It already says so on its own page. Two surfaces
 *               claiming the fund's position would disagree inside a quarter.
 *
 * This module reads both and writes neither.
 *
 * EVERY FIGURE SAYS WHERE IT CAME FROM. A ratio a partner cannot defend to an LP is worse than no
 * ratio: "why is Sensori held at that" is a question that gets asked, so a holding carries the basis
 * of its mark and the whole report carries how much of it is marked at cost.
 *
 * NOTHING IS INVENTED WHEN IT IS UNKNOWN. Unmarked holdings are held at cost and SAID to be — not
 * quietly counted as if somebody had valued them. DPI with no distributions is 0, which is a fact;
 * TVPI with nothing called is null, which is a question nobody has answered rather than zero.
 */

function fromMinor(minor: number): number {
  return Math.round(minor) / 100;
}

/** `position.cost_basis` is a REAL and predates the minor-unit rule. Converted at the boundary. */
function costToMinor(cost: number): number {
  return Math.round(cost * 100);
}

export interface HoldingView {
  position_id: string;
  company: string;
  cost: number;
  value: number;
  /** How the value was arrived at. `COST` means nobody has marked it. */
  mark_source: string;
  mark_basis: string | null;
  marked_as_of: string | null;
  multiple: number | null;
}

export async function fundPerformance(env: Env, firmScope: string, fundId: string) {
  const fund = await env.WP_OS_DB.prepare(
    "SELECT id, name, currency, target_size_minor, vintage_year FROM fund WHERE id = ?1 AND firm_scope = ?2",
  )
    .bind(fundId, firmScope)
    .first<{ id: string; name: string; currency: string; target_size_minor: number | null; vintage_year: number | null }>();
  if (!fund) return null;

  /*
   * The newest mark per position.
   *
   * Marks are append-only, so "current" is a query rather than a column: what the fund believed a
   * holding was worth last quarter is exactly what last quarter's LP letter asserted, and a column
   * that got overwritten would make the firm's own history disagree with what it sent.
   */
  const holdings = (
    await env.WP_OS_DB.prepare(
      `SELECT p.id AS position_id, p.cost_basis, c.canonical_name AS company,
              m.value_minor, m.source, m.basis, m.as_of_date
         FROM position p
         JOIN canonical_company c ON c.id = p.company_id
         LEFT JOIN position_mark m
           ON m.id = (
             SELECT id FROM position_mark
              WHERE position_id = p.id
              ORDER BY as_of_date DESC, created_at DESC
              LIMIT 1
           )
        WHERE p.fund_id = ?1 AND p.status = 'OPEN'
        ORDER BY c.canonical_name`,
    )
      .bind(fundId)
      .all<{
        position_id: string;
        cost_basis: number;
        company: string;
        value_minor: number | null;
        source: string | null;
        basis: string | null;
        as_of_date: string | null;
      }>()
  ).results ?? [];

  let costMinor = 0;
  let valueMinor = 0;
  let unmarked = 0;

  const views: HoldingView[] = holdings.map((h) => {
    const cost = costToMinor(h.cost_basis);
    // Held at cost when nobody has marked it, and said so rather than implied.
    const value = h.value_minor ?? cost;
    if (h.value_minor === null) unmarked += 1;
    costMinor += cost;
    valueMinor += value;
    return {
      position_id: h.position_id,
      company: h.company,
      cost: fromMinor(cost),
      value: fromMinor(value),
      mark_source: h.source ?? "COST",
      mark_basis: h.basis,
      marked_as_of: h.as_of_date,
      multiple: cost > 0 ? Math.round((value / cost) * 100) / 100 : null,
    };
  });

  const sum = async (table: string, extra = "") => {
    const r = await env.WP_OS_DB.prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM ${table} WHERE fund_id = ?1 AND firm_scope = ?2 ${extra}`,
    )
      .bind(fundId, firmScope)
      .first<{ total: number }>();
    return r?.total ?? 0;
  };

  const calledMinor = await sum("capital_call");
  const distributedMinor = await sum("capital_distribution");
  const committedRow = await env.WP_OS_DB.prepare(
    "SELECT COALESCE(SUM(amount_minor), 0) AS total FROM lp_commitment WHERE fund_id = ?1 AND firm_scope = ?2 AND state = 'SIGNED'",
  )
    .bind(fundId, firmScope)
    .first<{ total: number }>();
  const committedMinor = committedRow?.total ?? 0;

  /*
   * The ratios, and what each is null for.
   *
   * All three are "per dollar called", which is the convention an LP reads them in. With nothing
   * called there is no denominator, and the honest answer is a question nobody has answered — not
   * zero, which would read as a result.
   */
  const ratio = (numeratorMinor: number) =>
    calledMinor > 0 ? Math.round((numeratorMinor / calledMinor) * 100) / 100 : null;

  return {
    fund: {
      id: fund.id,
      name: fund.name,
      currency: fund.currency ?? "USD",
      vintage_year: fund.vintage_year,
      target: fund.target_size_minor === null ? null : fromMinor(fund.target_size_minor),
    },
    committed: fromMinor(committedMinor),
    called: fromMinor(calledMinor),
    // What LPs have signed for and not yet been asked for. The number a partner is asked at dinner.
    uncalled: fromMinor(Math.max(0, committedMinor - calledMinor)),
    distributed: fromMinor(distributedMinor),
    cost: fromMinor(costMinor),
    value: fromMinor(valueMinor),
    holdings: views,
    metrics: {
      // Everything the fund holds plus everything it has paid back, per dollar called.
      tvpi: ratio(valueMinor + distributedMinor),
      // What has actually come back. Zero here is a fact, not a gap.
      dpi: calledMinor > 0 ? Math.round((distributedMinor / calledMinor) * 100) / 100 : null,
      // What is still on the books.
      rvpi: ratio(valueMinor),
    },
    honesty: {
      holdings_total: views.length,
      // The number that decides whether any of the above is worth putting in a letter.
      held_at_cost: unmarked,
      note:
        unmarked === 0
          ? "Every holding carries a mark."
          : `${unmarked} of ${views.length} holdings have never been marked and are counted at what the fund paid. Anything above rests on that.`,
    },
  };
}

export async function handleFundPerformance(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const result = await fundPerformance(ctx.env, firmScope, ctx.params.id!);
  if (!result) return json({ error: "not_found" }, { status: 404 });
  return json(result);
}

// ── Recording the facts the above reads ──

const markSchema = z.object({
  value: z.number().min(0),
  source: z.enum(["COST", "LAST_ROUND", "THIRD_PARTY", "WRITE_DOWN", "WRITE_OFF"]),
  basis: z.string().trim().max(600).optional(),
  as_of_date: z.string().trim().min(4),
});

export async function handleMarkPosition(ctx: RouteContext): Promise<Response> {
  const parsed = markSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") {
    return json({ error: "forbidden", detail: "only a person may say what a holding is worth" }, { status: 403 });
  }
  const firmScope = actor.firmScopes[0] ?? "west-peek";

  const authz = await authorize(ctx.env, actor, "position.mark", { objectType: "position", objectId: ctx.params.id!, firmScope });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const position = await ctx.env.WP_OS_DB.prepare("SELECT id, cost_basis FROM position WHERE id = ?1")
    .bind(ctx.params.id!)
    .first<{ id: string; cost_basis: number }>();
  if (!position) return json({ error: "not_found" }, { status: 404 });

  // A mark that is not at cost has to say what it rests on. "Why is it held there" is a question an
  // LP asks, and a number with no answer is one a partner cannot defend.
  if (parsed.data.source !== "COST" && !parsed.data.basis) {
    return json(
      { error: "basis_required", detail: "Say what this rests on — the round, the 409A, or why it was written down." },
      { status: 400 },
    );
  }

  const id = `pm_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO position_mark (id, position_id, value_minor, source, basis, as_of_date, firm_scope, marked_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(id, position.id, Math.round(parsed.data.value * 100), parsed.data.source, parsed.data.basis ?? null, parsed.data.as_of_date, firmScope, actor.firmUserId!)
    .run();

  await appendEvent(ctx.env, {
    eventType: "position.marked",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "position",
    objectId: position.id,
    firmScope,
    payload: { value_minor: Math.round(parsed.data.value * 100), source: parsed.data.source, as_of: parsed.data.as_of_date },
  });

  return json({ id, value: parsed.data.value, source: parsed.data.source }, { status: 201 });
}

const capitalSchema = z.object({
  fund_id: z.string().trim().min(1),
  lp_record_id: z.string().trim().min(1),
  amount: z.number().positive(),
  on: z.string().trim().min(4),
  note: z.string().trim().max(500).optional(),
  kind: z.enum(["RETURN_OF_CAPITAL", "GAIN", "OTHER"]).optional(),
});

async function recordCapital(
  ctx: RouteContext,
  table: "capital_call" | "capital_distribution",
  actionKey: string,
): Promise<Response> {
  const parsed = capitalSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") return json({ error: "forbidden", detail: "human-only" }, { status: 403 });
  const firmScope = actor.firmScopes[0] ?? "west-peek";

  const authz = await authorize(ctx.env, actor, actionKey, { objectType: "lp_record", objectId: parsed.data.lp_record_id, firmScope });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const id = `${table === "capital_call" ? "cc" : "cd"}_${crypto.randomUUID()}`;
  const dateColumn = table === "capital_call" ? "called_on" : "distributed_on";
  const extraColumn = table === "capital_distribution" ? ", kind" : "";
  const extraValue = table === "capital_distribution" ? ", ?7" : "";

  const stmt = ctx.env.WP_OS_DB.prepare(
    `INSERT INTO ${table} (id, fund_id, lp_record_id, amount_minor, ${dateColumn}, note, recorded_by${extraColumn})
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?8${extraValue})`,
  );
  await stmt
    .bind(
      id,
      parsed.data.fund_id,
      parsed.data.lp_record_id,
      Math.round(parsed.data.amount * 100),
      parsed.data.on,
      parsed.data.note ?? null,
      parsed.data.kind ?? "GAIN",
      actor.firmUserId!,
    )
    .run();

  await appendEvent(ctx.env, {
    eventType: table === "capital_call" ? "capital.called" : "capital.distributed",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "lp_record",
    objectId: parsed.data.lp_record_id,
    firmScope,
    payload: { fund_id: parsed.data.fund_id, amount_minor: Math.round(parsed.data.amount * 100) },
  });

  return json({ id }, { status: 201 });
}

export const handleRecordCall = (ctx: RouteContext) => recordCapital(ctx, "capital_call", "capital_call.record");
export const handleRecordDistribution = (ctx: RouteContext) =>
  recordCapital(ctx, "capital_distribution", "capital_distribution.record");

export type { Actor };

// ── The report itself ──


/**
 * Wesley writes the quarter's account of the fund.
 *
 * Operator: "we need to make sure our ai employee that deals with LPs is hosting this page too and
 * can send the report to LPs when we ask him to."
 *
 * HE WRITES IT; HE DOES NOT SEND IT. That is the firm's standing posture and not a limitation of
 * this route: automatic outbound is off for everyone including the Managing Partners, and mail to an
 * LP leaves only when a partner presses send. An employee that could email investors on its own
 * judgement is the one capability in this system with no undo.
 *
 * THE NUMBERS ARE NOT HIS TO INVENT. Everything quantitative is computed by `fundPerformance` and
 * handed to him already worked out; he is writing prose around figures, not producing them. A model
 * asked to "report on the fund" would fill a gap with something plausible, and plausible is the
 * exact failure mode that ends up in an LP letter.
 *
 * AND HE SAYS WHAT IS NOT KNOWN. The honesty block goes into the prompt as a fact he must state
 * rather than a caveat he may omit — a letter quoting TVPI while silent about every holding being
 * carried at cost is worse than one that never mentioned the ratio.
 */
export async function handleDraftLpReport(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const firmScope = actor.firmScopes[0] ?? "west-peek";

  const authz = await authorize(ctx.env, actor, "ai.run", { objectType: "fund", objectId: ctx.params.id!, firmScope });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const perf = await fundPerformance(ctx.env, firmScope, ctx.params.id!);
  if (!perf) return json({ error: "not_found" }, { status: 404 });

  const money = (n: number) => `${perf.fund.currency} ${n.toLocaleString()}`;
  const facts = [
    `Fund: ${perf.fund.name}${perf.fund.vintage_year ? ` (${perf.fund.vintage_year})` : ""}`,
    perf.fund.target === null ? "Target size: not stated" : `Target size: ${money(perf.fund.target)}`,
    `Committed by investors: ${money(perf.committed)}`,
    `Called to date: ${money(perf.called)}`,
    `Still uncalled: ${money(perf.uncalled)}`,
    `Distributed back: ${money(perf.distributed)}`,
    `Invested at cost: ${money(perf.cost)}`,
    `Held at current marks: ${money(perf.value)}`,
    `TVPI: ${perf.metrics.tvpi ?? "not meaningful yet — nothing has been called"}`,
    `DPI: ${perf.metrics.dpi ?? "not meaningful yet"}`,
    `RVPI: ${perf.metrics.rvpi ?? "not meaningful yet"}`,
    "",
    "Holdings:",
    ...perf.holdings.map(
      (h) =>
        `  ${h.company} — cost ${money(h.cost)}, held at ${money(h.value)} (${h.mark_source.toLowerCase().split("_").join(" ")}${h.mark_basis ? `: ${h.mark_basis}` : ""})`,
    ),
    "",
    `MUST BE STATED: ${perf.honesty.note}`,
  ].join("\n");

  const { run } = await runAi(ctx.env, {
    purpose: `Draft the LP report for ${perf.fund.name}`,
    actor,
    inputs: [
      [
        "You are the LP relations lead at a small venture fund, writing the quarter's letter to limited partners.",
        "",
        "Write four short sections: where the fund stands, what changed this quarter, what the money is doing,",
        "and what to expect next. Plain English, no jargon, no adjectives doing work numbers should do.",
        "",
        "RULES:",
        "- Use ONLY the figures below. Do not compute, adjust or infer any number.",
        "- State the line marked MUST BE STATED plainly in the letter. Do not bury it or soften it.",
        "- Where a figure is 'not meaningful yet', say why in a clause rather than omitting the metric.",
        "- Do not predict returns, do not characterise a company's prospects, and do not thank anybody.",
        "- No greeting and no sign-off; a partner adds those.",
        "",
        facts,
      ].join("\n"),
    ],
    sensitivity: "INTERNAL" as never,
    budgetContext: { expectedOutputTokens: 1400 },
    // Pinned for the same reason University is: an LP letter written by whichever model was cheapest
    // that minute is not a saving.
    routing: { category: "OPERATIONS", taskClass: "lp_report" },
  });

  if (run.status !== "COMPLETED" || !run.output_text) {
    return json(
      { error: "draft_failed", detail: run.failure_reason ?? `The run did not complete (${run.status}).` },
      { status: 502 },
    );
  }

  await appendEvent(ctx.env, {
    eventType: "lp_report.drafted",
    actorType: "firm_user",
    actorId: actor.firmUserId ?? "system",
    objectType: "fund",
    objectId: ctx.params.id!,
    firmScope,
    payload: { held_at_cost: perf.honesty.held_at_cost, holdings: perf.honesty.holdings_total },
  });

  return json({
    fund: perf.fund.name,
    draft: run.output_text,
    figures: perf,
    // Said in the response, because the shape of the reply should not be the only thing implying it.
    note: "Drafted, not sent. Nothing reaches an investor until a Managing Partner sends it.",
  });
}
