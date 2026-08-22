import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import {
  openPortfolioUpdateCard,
  periodComparison,
  shiftMonths,
  UPDATE_CARD_PREFIX,
  PORTFOLIO_PERFORMANCE_MACHINE,
  PORTFOLIO_UPDATE_EMPLOYEE,
  type ReportingSnapshot,
} from "../src/worker/services/portfolioReporting";

/**
 * Item 12 — portfolio reporting off the back of the updates companies send in.
 *
 * The two rules worth holding still:
 *
 * A MONTH IS A CALENDAR MONTH, not "whatever the reading before last was". A company that reported
 * in January and again in June has no month-over-month, and the surface has to SAY that rather than
 * compare across the gap and call the result a month. This is the whole difference between this
 * report and the cockpit's trend list, and it is the thing most likely to be quietly "simplified"
 * later into the same comparison twice.
 *
 * AN EMAIL OPENS A JOB, NEVER A FIGURE. `#wpupdate` routes a founder's mail to Winter with the
 * message attached. Nothing an unauthenticated sender writes may become the number the fund goes on
 * to report to its own investors.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

function req(path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call<T = any>(path: string, headers: Record<string, string>, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(req(path, headers, method, body), env);
  return { status: res.status, body: (await res.json()) as T };
}

let seq = 0;
async function createCompany(name?: string): Promise<{ id: string; name: string }> {
  seq += 1;
  const canonical = name ?? `Reporting Co ${seq} ${crypto.randomUUID().slice(0, 8)}`;
  const res = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: canonical });
  expect(res.status).toBe(201);
  return { id: res.body.id, name: canonical };
}

async function defineMetric(direction = "HIGHER_IS_BETTER"): Promise<string> {
  seq += 1;
  const key = `revenue_${seq}_${crypto.randomUUID().slice(0, 6)}`;
  const res = await call("/api/portfolio/metric-definitions", MP, "POST", { metric_key: key, name: `Metric ${key}`, direction });
  expect(res.status).toBe(201);
  return key;
}

async function snapshot(companyId: string, metricKey: string, asOf: string, value: number): Promise<void> {
  const res = await call("/api/portfolio/snapshots", MP, "POST", {
    company_id: companyId,
    metric_key: metricKey,
    as_of_date: asOf,
    value,
    source: "monthly update",
  });
  expect(res.status).toBe(201);
}

/** The shape the comparison reads. Written out so the pure tests need no database at all. */
function snap(over: Partial<ReportingSnapshot> & { as_of_date: string; value: number }): ReportingSnapshot {
  return {
    company_id: "co_1",
    canonical_name: "Northwind",
    metric_key: "revenue",
    metric_name: "Monthly revenue",
    direction: "HIGHER_IS_BETTER",
    stale_after_days: null,
    ...over,
  };
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs });
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("1. a month back is a calendar month, not a guess", () => {
  it("goes back a whole month, a whole quarter and across a year boundary", () => {
    expect(shiftMonths("2026-06-30", -1)).toBe("2026-05-30");
    expect(shiftMonths("2026-06-30", -3)).toBe("2026-03-30");
    expect(shiftMonths("2026-01-15", -1)).toBe("2025-12-15");
    expect(shiftMonths("2026-01-15", -3)).toBe("2025-10-15");
  });

  it("clamps to the end of a shorter month, because that is how a company dates a monthly figure", () => {
    expect(shiftMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(shiftMonths("2024-03-31", -1)).toBe("2024-02-29");
    expect(shiftMonths("2026-05-31", -3)).toBe("2026-02-28");
  });

  it("does not drift by a day under a local timezone", () => {
    // The reason this is string arithmetic. `new Date("2026-03-01")` is UTC midnight, and west of
    // Greenwich it reads back as 29 February — a one-day error exactly at the month boundary these
    // comparisons live on, which would silently pick the wrong snapshot.
    expect(shiftMonths("2026-03-01", -1)).toBe("2026-02-01");
    expect(shiftMonths("2026-01-01", -1)).toBe("2025-12-01");
  });
});

describe("2. the comparison picks the reading a month back, not the reading before last", () => {
  it("compares against the newest figure at least a month older, skipping the ones between", () => {
    const rows = [
      snap({ as_of_date: "2026-06-30", value: 120 }),
      snap({ as_of_date: "2026-06-15", value: 118 }),
      snap({ as_of_date: "2026-05-31", value: 100 }),
    ];
    const { moved } = periodComparison(rows, 1);
    expect(moved).toHaveLength(1);
    // 100 → 120, NOT 118 → 120. The mid-month reading is the one a "previous reading" comparison
    // would have used, and it would have reported 2% where the month actually moved 20%.
    expect(moved[0]!.previous).toBe(100);
    expect(moved[0]!.latest).toBe(120);
    expect(moved[0]!.change_pct).toBe(20);
    expect(moved[0]!.verdict).toBe("IMPROVING");
  });

  it("names the gap instead of comparing across it", () => {
    const rows = [snap({ as_of_date: "2026-06-30", value: 120 }), snap({ as_of_date: "2026-06-20", value: 90 })];
    const { moved, skipped } = periodComparison(rows, 1);
    expect(moved).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toContain("Only one reading this far back");
    // The date it would have needed is named, so the gap is actionable rather than a shrug. It is
    // the END of the month a month back (31 May), not the same calendar day in it (30 May): every
    // figure here is dated month-end, so a cutoff of the 30th sits one day the wrong side of the
    // reading it is looking for and silently reaches back a further month.
    expect(skipped[0]!.reason).toContain("2026-05-31");
  });

  it("refuses to state a percentage against zero", () => {
    const rows = [snap({ as_of_date: "2026-06-30", value: 120 }), snap({ as_of_date: "2026-04-30", value: 0 })];
    const { moved, skipped } = periodComparison(rows, 1);
    expect(moved).toHaveLength(0);
    expect(skipped[0]!.reason).toContain("zero");
  });

  it("reads a fall as an improvement where lower is better, exactly as the alert list does", () => {
    const rows = [
      snap({ as_of_date: "2026-06-30", value: 40, direction: "LOWER_IS_BETTER", metric_name: "Monthly burn" }),
      snap({ as_of_date: "2026-05-30", value: 60, direction: "LOWER_IS_BETTER", metric_name: "Monthly burn" }),
    ];
    // This is the reuse that matters: the verdict comes from the cockpit's own comparison, so the
    // report and the flags can never disagree about whether a number moved the right way.
    expect(periodComparison(rows, 1).moved[0]!.verdict).toBe("IMPROVING");
  });

  it("keeps each company and each figure separate", () => {
    const rows = [
      snap({ company_id: "co_1", canonical_name: "Northwind", as_of_date: "2026-06-30", value: 120 }),
      snap({ company_id: "co_1", canonical_name: "Northwind", as_of_date: "2026-05-30", value: 100 }),
      snap({ company_id: "co_2", canonical_name: "Sensori", metric_key: "burn", metric_name: "Burn", as_of_date: "2026-06-30", value: 50 }),
      snap({ company_id: "co_2", canonical_name: "Sensori", metric_key: "burn", metric_name: "Burn", as_of_date: "2026-05-30", value: 40 }),
    ];
    expect(periodComparison(rows, 1).moved.map((m) => m.company).sort()).toEqual(["Northwind", "Sensori"]);
  });
});

describe("3. the report reads month on month and quarter on quarter off the same records", () => {
  it("reports a month and a quarter for one company from four dated figures", async () => {
    const company = await createCompany();
    const metric = await defineMetric();
    await snapshot(company.id, metric, "2026-03-31", 100);
    await snapshot(company.id, metric, "2026-04-30", 110);
    await snapshot(company.id, metric, "2026-05-31", 120);
    await snapshot(company.id, metric, "2026-06-30", 150);

    const res = await call<{
      month_over_month: Array<{ company: string; previous: number; latest: number; change_pct: number }>;
      quarter_over_quarter: Array<{ company: string; previous: number; latest: number }>;
      definitions: Record<string, string>;
    }>("/api/portfolio/reporting", MP);
    expect(res.status).toBe(200);

    const mom = res.body.month_over_month.find((m) => m.company === company.name)!;
    expect([mom.previous, mom.latest]).toEqual([120, 150]);
    expect(mom.change_pct).toBe(25);

    const qoq = res.body.quarter_over_quarter.find((m) => m.company === company.name)!;
    expect([qoq.previous, qoq.latest]).toEqual([100, 150]);

    // The rule travels with the result, so nobody has to guess what "month over month" meant.
    expect(res.body.definitions.month_over_month).toContain("calendar month");
  });

  it("says how many figures were taken out of each update, so an unread one is visible", async () => {
    const company = await createCompany();
    const metric = await defineMetric();
    const update = await call<{ id: string }>("/api/portfolio/updates", MP, "POST", {
      company_id: company.id,
      received_at: "2026-06-01",
      source: "emailed by the founder",
      period_label: "May 2026",
    });
    expect(update.status).toBe(201);

    await call("/api/portfolio/snapshots", MP, "POST", {
      company_id: company.id,
      metric_key: metric,
      as_of_date: "2026-05-31",
      value: 42,
      source: "the update",
      update_id: update.body.id,
    });

    const res = await call<{ updates: Array<{ id: string; company: string; numbers_taken: number }> }>("/api/portfolio/reporting", MP);
    const row = res.body.updates.find((u) => u.id === update.body.id)!;
    expect(row.company).toBe(company.name);
    expect(row.numbers_taken).toBe(1);
  });

  it("refuses to write a summary of a portfolio with nothing to compare", async () => {
    const empty = await createTestDb();
    const emptyEnv = makeTestEnv(empty.db, { WP_OS_DOCUMENTS: empty.docs });
    const res = await handleRequest(req("/api/portfolio/reporting/summary", MP, "POST", {}), emptyEnv);
    expect(res.status).toBe(409);
    // Not a paragraph about an empty portfolio. A model asked to summarise nothing writes something.
    expect(((await res.json()) as { error: string }).error).toBe("nothing_to_compare");
    await disposeTestDb(empty);
  });

  it("is denied to somebody who is not signed in", async () => {
    expect((await handleRequest(req("/api/portfolio/reporting"), env)).status).toBe(401);
    expect((await handleRequest(req("/api/portfolio/reporting/summary", {}, "POST", {}), env)).status).toBe(401);
  });
});

describe("4. an emailed update opens a job, never a figure", () => {
  it("opens a card for the portfolio seat with the message attached", async () => {
    const company = await createCompany();
    const cardId = await openPortfolioUpdateCard(env, {
      subject: `${company.name} — March`,
      from: "founder@example.com",
      raw: "Revenue 120k, burn 40k, 14 months of runway.",
      company: company.name,
    });

    const card = await t.db
      .prepare("SELECT title, description, owner_type, owner_id, machine_id, state, next_action FROM work_card WHERE id = ?1")
      .bind(cardId)
      .first<Record<string, string | number>>();

    expect(String(card!.title)).toContain(UPDATE_CARD_PREFIX);
    expect(card!.owner_type).toBe("AI");
    expect(card!.owner_id).toBe(PORTFOLIO_UPDATE_EMPLOYEE);
    expect(card!.machine_id).toBe(PORTFOLIO_PERFORMANCE_MACHINE);
    expect(card!.state).toBe("OPEN");
    // The message survives, because the numbers in it are the point of the card.
    expect(String(card!.description)).toContain("Revenue 120k");
    expect(String(card!.next_action)).toContain("record");

    // And nothing about the mail became a figure about the company.
    const snapshots = await t.db.prepare("SELECT COUNT(*) AS n FROM portfolio_metric_snapshot WHERE company_id = ?1").bind(company.id).first<{ n: number }>();
    expect(snapshots!.n).toBe(0);
  });

  it("says the fund holds no position in the company it names, rather than failing silently", async () => {
    const company = await createCompany();
    const cardId = await openPortfolioUpdateCard(env, {
      subject: "update",
      from: "founder@example.com",
      raw: "doing well",
      company: company.name,
    });
    const card = await t.db.prepare("SELECT description FROM work_card WHERE id = ?1").bind(cardId).first<{ description: string }>();
    // A portfolio update about a company the fund does not own is either a mislabelled mail or a
    // holding somebody forgot to book. Both are worth a sentence to whoever opens the card.
    expect(card!.description).toContain("holds no position");
  });

  it("says so plainly when no company on record matches", async () => {
    const cardId = await openPortfolioUpdateCard(env, {
      subject: "update",
      from: "stranger@example.com",
      raw: "hello",
      company: "A Company Nobody Has Heard Of",
    });
    const card = await t.db.prepare("SELECT description FROM work_card WHERE id = ?1").bind(cardId).first<{ description: string }>();
    expect(card!.description).toContain("No company on record matches");
  });

  it("surfaces an unread update on the reporting page, so it cannot sit in a queue nobody opens", async () => {
    const res = await call<{ waiting_count: number; waiting: Array<{ title: string }> }>("/api/portfolio/reporting", MP);
    expect(res.body.waiting_count).toBeGreaterThan(0);
    expect(res.body.waiting.every((w) => w.title.startsWith(UPDATE_CARD_PREFIX))).toBe(true);
  });
});
