import type { Env } from "../env";
import { readableMessage, storedMessageLine } from "./dealIntake";
import type { FirmUserIdentity } from "../auth";
import type { RouteContext } from "../router";
import { json } from "../router";
import { actorFromIdentity, authorize, privacyVisibilityClause } from "./authorize";
import { computeTrends, type TrendRow } from "./cockpit";
import { createWorkCardInternal } from "./workCards";
import { runAi } from "../ai/runAi";
import { INTAKE_MAILBOX } from "../../shared/intake/emailTriggers";

/**
 * Portfolio reporting — what the companies told us, and how it reads month on month.
 *
 * Operator, item 12: a "Portfolio Reporting sub-tab where the host employee parses inbound updates
 * emailed to os@joinwestpeek.com and summarises month-over-month and quarter-over-quarter."
 *
 * THE COMPARISON MATH IS COCKPIT'S, NOT A SECOND COPY. `computeTrends` already decides what
 * "better" means for a metric — it reads the metric's declared direction, and the alert evaluator
 * uses the same rule. Writing a second percentage-change function here is how a page ends up saying
 * a company improved while the alert list says it deteriorated, which this repo has already paid for
 * once. So this module's whole contribution is CHOOSING THE PAIR: it picks the reading from a month
 * (or a quarter) back, hands that pair to cockpit's function, and reports whatever it says.
 *
 * A MONTH IS A CALENDAR MONTH, NOT "THE PREVIOUS READING". That is the entire difference between
 * this surface and the cockpit's. A company that reported in January and then again in June has one
 * "previous reading" and no month-over-month at all, and saying so is more useful than quietly
 * comparing five months of drift and labelling it a month.
 *
 * NOTHING IS COMPARED THAT CANNOT BE. No earlier reading, or an earlier reading of zero, is
 * reported as a named gap rather than dropped — a company silently missing from a report reads as a
 * company with nothing to report.
 */

/** Winter. "How the companies are actually doing and where they need help." */
export const PORTFOLIO_UPDATE_EMPLOYEE = "Winter";

/** Machine 28 — "Detects winners, KPIs/signals". An update is KPIs arriving, so it is that seat. */
export const PORTFOLIO_PERFORMANCE_MACHINE = 28;

/**
 * How an arrived update is recognised again once it is a work card.
 *
 * Declared once and read by both the writer and the reader below, because the alternative is a
 * string typed twice that silently stops matching the day somebody rewords a title.
 */
export const UPDATE_CARD_PREFIX = "Portfolio update:";

export interface ReportingSnapshot {
  company_id: string;
  canonical_name: string | null;
  metric_key: string;
  as_of_date: string;
  value: number;
  direction: string;
  metric_name: string;
  stale_after_days: number | null;
}

export interface SkippedComparison {
  company: string;
  metric: string;
  as_of_date: string;
  reason: string;
}

export interface PeriodComparison {
  moved: TrendRow[];
  skipped: SkippedComparison[];
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysIn(year: number, monthIndex: number): number {
  if (monthIndex === 1 && (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))) return 29;
  return DAYS_IN_MONTH[monthIndex]!;
}

/**
 * The same calendar day, some months earlier, clamped to the end of a shorter month.
 *
 * Done as string arithmetic rather than through `Date`. A `Date` built from "2026-03-31" is parsed
 * as UTC midnight and then read back in the local zone, so west of Greenwich the same expression
 * hands back the 30th — a one-day error that would silently pick the wrong snapshot at a month
 * boundary, which is exactly where these comparisons live.
 *
 * 31 March back one month is 28 February, because the last day of a month is what a company that
 * reports monthly actually dates its figures.
 */
/**
 * The last day of the month a date falls in. String arithmetic for the same reason as `shiftMonths`
 * — a `Date` round-trip loses a day west of Greenwich at exactly the boundary this works on.
 */
export function endOfMonth(isoDate: string): string {
  const [y, m] = isoDate.split("-").map(Number) as [number, number, number];
  // Day 0 of the following month is the last day of this one, and this arithmetic is done in UTC
  // so it cannot drift; only the numbers are used, never a formatted local date.
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${isoDate.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

export function shiftMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number) as [number, number, number];
  const total = (y * 12 + (m - 1)) + months;
  const year = Math.floor(total / 12);
  const monthIndex = total - year * 12;
  const day = Math.min(d, daysIn(year, monthIndex));
  return `${String(year).padStart(4, "0")}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Latest reading against the newest reading at least `months` older, per company and metric.
 *
 * The verdict and the percentage come from cockpit's `computeTrends`, handed exactly the two rows
 * chosen here. That is the reuse that matters: this file decides WHICH readings to compare and
 * never decides what the comparison means.
 */
export function periodComparison(rows: ReportingSnapshot[], months: number): PeriodComparison {
  const byPair = new Map<string, ReportingSnapshot[]>();
  for (const r of rows) {
    const key = `${r.company_id}|${r.metric_key}`;
    byPair.set(key, [...(byPair.get(key) ?? []), r]);
  }

  const moved: TrendRow[] = [];
  const skipped: SkippedComparison[] = [];

  for (const [, snaps] of byPair) {
    const sorted = [...snaps].sort((a, b) => (a.as_of_date < b.as_of_date ? 1 : -1));
    const latest = sorted[0]!;
    const company = latest.canonical_name ?? latest.company_id;
    /*
     * THE CUTOFF IS THE END OF THE TARGET MONTH, not the same calendar day in it.
     *
     * Shifting 30 June back one month gives 30 May, and a company that reports monthly dates its
     * May figure the 31st — one day the wrong side of the line. The comparison therefore skipped
     * the reading it wanted and reached back to April instead, reporting a two-month move as a
     * monthly one. Every figure in this system is dated month-end, so this was not an edge case:
     * it was the ordinary path, wrong for every month with 31 days.
     *
     * Month-end also gives the right answer to what "month on month" means to somebody reading it:
     * compare this reporting period with the previous one, not with a point 30 days ago.
     */
    const cutoff = endOfMonth(shiftMonths(latest.as_of_date, -months));
    const earlier = sorted.find((s) => s.as_of_date <= cutoff);

    if (!earlier) {
      skipped.push({
        company,
        metric: latest.metric_name,
        as_of_date: latest.as_of_date,
        reason: `Only one reading this far back — nothing on or before ${cutoff} to compare it with.`,
      });
      continue;
    }
    if (earlier.value === 0) {
      // A percentage against zero is not a percentage. Said, rather than shown as infinite growth.
      skipped.push({
        company,
        metric: latest.metric_name,
        as_of_date: latest.as_of_date,
        reason: `The earlier reading was zero, so there is no percentage to state.`,
      });
      continue;
    }
    moved.push(...computeTrends([latest, earlier]));
  }

  moved.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));
  skipped.sort((a, b) => (a.company < b.company ? -1 : 1));
  return { moved, skipped };
}

async function readSnapshots(ctx: RouteContext): Promise<ReportingSnapshot[]> {
  const visibility = privacyVisibilityClause(ctx.identity as FirmUserIdentity, "s.privacy_label");
  return (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT s.company_id, c.canonical_name, s.metric_key, s.as_of_date, s.value,
              d.direction, d.name AS metric_name, d.stale_after_days
         FROM portfolio_metric_snapshot s
         JOIN portfolio_metric_definition d ON d.metric_key = s.metric_key
         LEFT JOIN canonical_company c ON c.id = s.company_id
        WHERE ${visibility}
        ORDER BY s.as_of_date DESC`,
    ).all<ReportingSnapshot>()
  ).results ?? [];
}

/**
 * GET /api/portfolio/reporting — what arrived, and how it reads over a month and over a quarter.
 */
export async function handlePortfolioReporting(ctx: RouteContext): Promise<Response> {
  const snapshots = await readSnapshots(ctx);

  const updates = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT u.id, u.company_id, c.canonical_name AS company, u.period_label, u.received_at,
              u.summary, u.source,
              (SELECT COUNT(*) FROM portfolio_metric_snapshot s WHERE s.update_id = u.id) AS numbers_taken
         FROM portfolio_update u
         LEFT JOIN canonical_company c ON c.id = u.company_id
        ORDER BY u.received_at DESC
        LIMIT 50`,
    ).all<Record<string, unknown>>()
  ).results ?? [];

  // Mail that arrived and has not been read yet. It is a work card and not a row in a table, which
  // is the whole point: nothing an outsider emailed becomes a fact about a company on its own.
  const waiting = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT id, title, next_action, created_at
         FROM work_card
        WHERE title LIKE ?1 AND state IN ('OPEN','IN_PROGRESS')
        ORDER BY created_at DESC
        LIMIT 25`,
    )
      .bind(`${UPDATE_CARD_PREFIX}%`)
      .all<Record<string, unknown>>()
  ).results ?? [];

  const mom = periodComparison(snapshots, 1);
  const qoq = periodComparison(snapshots, 3);

  return json({
    updates,
    waiting,
    waiting_count: waiting.length,
    month_over_month: mom.moved,
    month_over_month_skipped: mom.skipped,
    quarter_over_quarter: qoq.moved,
    quarter_over_quarter_skipped: qoq.skipped,
    mailbox: INTAKE_MAILBOX,
    reads_the_inbox: PORTFOLIO_UPDATE_EMPLOYEE,
    definitions: {
      month_over_month:
        "The newest figure a company reported, against the newest one dated at least a calendar month before it. Not simply the reading before last — a company that skipped four months has no month-over-month, and this says so instead of comparing across the gap.",
      quarter_over_quarter: "The same comparison over three calendar months.",
      better_or_worse:
        "Read against the metric's declared direction, using the same comparison the alert list uses. The two cannot disagree about whether a number moved the right way.",
      waiting: `Mail tagged for a portfolio update opens a job for ${PORTFOLIO_UPDATE_EMPLOYEE}. Nothing an email says becomes a recorded figure until a person or their machine puts it there.`,
    },
  });
}

/**
 * POST /api/portfolio/reporting/summary — Winter writes up the quarter in prose.
 *
 * THE FIGURES ARE NOT HIS TO INVENT, exactly as on the LP letter: every number is computed above and
 * handed over already worked out, and the prompt forbids computing or adjusting any of them. A model
 * asked to "summarise the portfolio" fills a gap with something plausible, and plausible is what
 * ends up quoted in a partner meeting.
 *
 * WITH NOTHING TO COMPARE IT REFUSES rather than writing a paragraph about an empty portfolio.
 */
export async function handleDraftPortfolioSummary(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const firmScope = actor.firmScopes[0] ?? "west-peek";

  const authz = await authorize(ctx.env, actor, "ai.run", { objectType: "portfolio_update", firmScope });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const snapshots = await readSnapshots(ctx);
  const mom = periodComparison(snapshots, 1);
  const qoq = periodComparison(snapshots, 3);

  if (mom.moved.length === 0 && qoq.moved.length === 0) {
    return json(
      {
        error: "nothing_to_compare",
        detail:
          "No company has two readings far enough apart to compare yet. Record what the companies reported and this becomes writable.",
      },
      { status: 409 },
    );
  }

  const line = (t: TrendRow) =>
    `  ${t.company} — ${t.metric}: ${t.previous} → ${t.latest} (${t.change_pct > 0 ? "+" : ""}${t.change_pct}%, ${t.verdict.toLowerCase()}), ${t.window}`;

  const facts = [
    "MONTH OVER MONTH:",
    ...(mom.moved.length > 0 ? mom.moved.map(line) : ["  nothing has two readings a month apart"]),
    "",
    "QUARTER OVER QUARTER:",
    ...(qoq.moved.length > 0 ? qoq.moved.map(line) : ["  nothing has two readings a quarter apart"]),
    "",
    "NOT COMPARED, AND MUST BE STATED:",
    ...(qoq.skipped.length > 0 ? qoq.skipped.map((s) => `  ${s.company} — ${s.metric}: ${s.reason}`) : ["  nothing was left out"]),
  ].join("\n");

  const { run } = await runAi(ctx.env, {
    purpose: "Summarise how the portfolio companies moved",
    actor,
    inputs: [
      [
        "You watch how a small venture fund's portfolio companies are doing, writing the partners a short summary.",
        "",
        "Write two short paragraphs — how the month looks, then how the quarter looks — and finish with one",
        "line naming what could not be compared. Plain English for somebody running their first fund.",
        "",
        "RULES:",
        "- Use ONLY the figures below. Do not compute, adjust, extrapolate or infer any number.",
        "- State the NOT COMPARED lines plainly. A summary that quietly omits them overstates what is known.",
        "- Do not predict, do not recommend, and do not characterise a company's prospects.",
        "- No greeting and no sign-off.",
        "",
        facts,
      ].join("\n"),
    ],
    sensitivity: "INTERNAL" as never,
    budgetContext: { judgement: true, confidential: true, expectedOutputTokens: 900 },
    routing: { category: "OPERATIONS", taskClass: "portfolio_summary" },
  });

  if (run.status !== "COMPLETED" || !run.output_text) {
    return json(
      { error: "draft_failed", detail: run.failure_reason ?? `The run did not complete (${run.status}).` },
      { status: 502 },
    );
  }

  return json({
    draft: run.output_text,
    compared: { month_over_month: mom.moved.length, quarter_over_quarter: qoq.moved.length, not_compared: qoq.skipped.length },
    note: "Written for the partners. Nothing here has been sent to anybody.",
  });
}

/**
 * A portfolio update arriving by email opens a JOB, never a row.
 *
 * The same constraint the rest of the inbox runs on: a hashtag is a public word, so it may route and
 * must never authorise. `#wpupdate` on a message means "this looks like a company reporting its
 * numbers" — it does not make those numbers the firm's record of that company. Winter reads it and
 * records what it actually says.
 *
 * WHETHER THE FIRM EVEN HOLDS THE COMPANY IS PART OF THE CARD. An update naming a company the fund
 * has no position in is either a mislabelled mail or a company somebody forgot to book, and both are
 * worth a sentence to the person opening the card rather than a silent match failure.
 */
export async function openPortfolioUpdateCard(
  env: Env,
  input: {
    subject: string;
    from: string;
    raw: string;
    company: string | null;
    /** The stored `.eml` this message lives in, kept once at the door (0226). */
    emlKey: string | null;
    /** What to say when it was not kept, so the card is never silent about a missing original. */
    storeNote?: string | null;
  },
): Promise<string> {
  const firmScope = "west-peek";

  let held: string | null = null;
  if (input.company) {
    const wanted = input.company.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const rows = (
      await env.WP_OS_DB.prepare(
        `SELECT c.canonical_name, COUNT(p.id) AS positions
           FROM canonical_company c
           LEFT JOIN position p ON p.company_id = c.id AND p.status = 'OPEN'
          GROUP BY c.id`,
      ).all<{ canonical_name: string; positions: number }>()
    ).results ?? [];
    const match = rows.find((r) => r.canonical_name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === wanted);
    held = match
      ? match.positions > 0
        ? `The fund holds ${match.canonical_name}.`
        : `${match.canonical_name} is on record, but the fund holds no position in it — check this is really a portfolio update.`
      : `No company on record matches "${input.company}".`;
  }

  const systemIdentity: FirmUserIdentity = {
    // Nobody at the firm typed this. Attributing it to whoever opens it would put a name on the
    // record that did not do the thing. Copied deliberately from the deal-intake path so the two
    // machine-created cards are attributable the same way.
    id: "system:inbound_email",
    email: INTAKE_MAILBOX,
    fullName: "Inbound mail",
    status: "ACTIVE",
    roles: ["MANAGING_PARTNER"],
    authorityScopes: [{ scopeKey: "firm_scope", scopeValue: firmScope }],
  };

  const card = await createWorkCardInternal(env, systemIdentity, {
    title: `${UPDATE_CARD_PREFIX} ${input.company ?? (input.subject || "(no subject)")}`.slice(0, 200),
    description: [
      `Arrived by email from ${input.from}.`,
      held ?? "No company name could be read out of the message.",
      "",
      "--- the message ---",
      /*
       * THE COMPANY'S OWN WORDS, DECODED. This was `input.raw.slice(0, 4000)`, which on any real
       * email is four thousand characters of `Received:` and DKIM headers with the update itself
       * cut off below them — and Winter is asked to "record only figures the message actually
       * states". He could not read the message. See `readableMessage` in `dealIntake.ts`.
       */
      readableMessage(input.raw),
      "",
      storedMessageLine(input.emlKey, input.storeNote),
    ].join("\n"),
    owner_type: "AI",
    owner_id: PORTFOLIO_UPDATE_EMPLOYEE,
    machine_id: PORTFOLIO_PERFORMANCE_MACHINE,
    priority: "NORMAL",
    firm_scope: firmScope,
    next_action:
      "Read what the company reported and record it on Portfolio — the update, then each figure with the date it is as of.",
    prompt:
      "Record only figures the message actually states, with the date the company gave them as of. " +
      "A number you inferred from prose is a number nobody can defend in a partner meeting. " +
      "If the message names no company you can match, mark this BLOCKED so a partner sees it.",
  });
  return card.id;
}
