import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { intakeDealFromEmail } from "../src/worker/services/dealIntake";
import { isUnreviewed } from "../src/shared/investment/lookedAt";

/**
 * Phase D §5 — the register card carries the board's stage clock and the board's "looked at".
 *
 * TWO PAGES, ONE FACT. The dealflow board says "by email · not yet looked at" on a deal that arrived
 * by email, sits at NEW, and has never moved; the Companies card shows the same deal with a
 * "Looked at: not yet" chip. If the two derivations ever drift — one reads a stored flag, the other
 * reads the spine — the operator sees a chip on one page contradict a badge on the other, and
 * nothing fails. So this pins the two ROUTES against each other on the same deal, before and after
 * it moves, rather than trusting that both import the same function.
 *
 * THE CLOCK IS THE BOARD'S CLOCK. `in_stage_since` on the register must equal the board's
 * `in_stage_since` for the same deal: creation while it has never moved, the transition once it has.
 * A register that dated the clock from creation forever would paint every hard-won deal stalled.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

async function call<T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(
    new Request(`https://test.local${path}`, {
      method,
      headers: body === undefined ? MP : { ...MP, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, body: (await res.json()) as T };
}

interface RegisterRow {
  id: string;
  deal_id: string | null;
  deal_status: string | null;
  looked_at: boolean | null;
  in_stage_since: string | null;
  deal_moved_at: string | null;
  booked: boolean;
  open_contradictions: number;
  next_meeting_at: string | null;
}
interface BoardDeal {
  id: string;
  company_id: string;
  unreviewed: boolean;
  in_stage_since: string;
}

async function registerRow(companyId: string): Promise<RegisterRow> {
  const res = await call<{ companies: RegisterRow[] }>("/api/companies/register");
  expect(res.status).toBe(200);
  const row = res.body.companies.find((c) => c.id === companyId);
  expect(row, "the company must be on the register").toBeTruthy();
  return row!;
}

async function boardDeal(dealId: string): Promise<BoardDeal> {
  const res = await call<{ deals: BoardDeal[] }>("/api/dealflow/board");
  expect(res.status).toBe(200);
  const deal = res.body.deals.find((d) => d.id === dealId);
  expect(deal, "the deal must be on the board").toBeTruthy();
  return deal!;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("looked_at on the register is the inverse of unreviewed on the board", () => {
  it("an emailed deal nobody has touched: the board says unreviewed, the register says not looked at", async () => {
    const entry = await intakeDealFromEmail(env, {
      company: "Clock Test Email Co",
      sector: null,
      one_liner: null,
      website: null,
      from: "founder@clocktest.example",
      isDeck: false,
      raw: "",
    });
    expect(entry.outcome).toBe("IN_FUNNEL");

    const board = await boardDeal(entry.opportunity_id);
    const reg = await registerRow(entry.company_id);
    expect(reg.deal_id).toBe(entry.opportunity_id);
    expect(board.unreviewed, "the board's own badge keys on the email prefix").toBe(true);
    expect(reg.looked_at, "the register must say the same thing the board says").toBe(false);
    expect(reg.looked_at).toBe(!board.unreviewed);

    // The shared function is what both are meant to be reading.
    expect(isUnreviewed({ source_channel: "email:founder@clocktest.example", status: "NEW", last_moved_at: null })).toBe(true);

    // Never moved: the clock starts at creation on both pages.
    expect(reg.deal_moved_at).toBeNull();
    expect(reg.in_stage_since, "the register's clock must be the board's clock").toBe(board.in_stage_since);

    // The moment a partner moves it, both flip together and the clock restarts on both.
    const moved = await call(`/api/opportunities/${entry.opportunity_id}/transition`, "POST", { to: "SCREENING" });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);

    const boardAfter = await boardDeal(entry.opportunity_id);
    const regAfter = await registerRow(entry.company_id);
    expect(boardAfter.unreviewed).toBe(false);
    expect(regAfter.looked_at).toBe(true);
    expect(regAfter.deal_status).toBe("SCREENING");
    expect(regAfter.deal_moved_at, "a moved deal carries when it moved").toBeTruthy();
    expect(regAfter.in_stage_since).toBe(regAfter.deal_moved_at);
    expect(regAfter.in_stage_since, "the restarted clock must match on both pages").toBe(boardAfter.in_stage_since);
  });

  it("a deal a partner entered by hand was looked at by definition", async () => {
    const co = await call<{ id: string }>("/api/companies", "POST", { canonical_name: "Clock Test Manual Co" });
    expect(co.status).toBe(201);
    const opp = await call<{ id: string }>("/api/opportunities", "POST", {
      company_id: co.body.id,
      opportunity_type: "EARLY_STAGE_PRIMARY",
      title: "Clock Test Manual Co — pre-seed",
      relationship_origin: "INBOUND",
    });
    expect(opp.status).toBe(201);

    const reg = await registerRow(co.body.id);
    const board = await boardDeal(opp.body.id);
    expect(board.unreviewed).toBe(false);
    expect(reg.looked_at).toBe(true);
    expect(reg.booked, "no position has been opened").toBe(false);
    expect(reg.open_contradictions).toBe(0);
    expect(reg.next_meeting_at).toBeNull();
  });

  it("a company with no deal has nothing to have looked at, and no clock — the row the page names as a fault", async () => {
    const co = await call<{ id: string }>("/api/companies", "POST", { canonical_name: "Clock Test Ghost Co" });
    expect(co.status).toBe(201);
    const reg = await registerRow(co.body.id);
    expect(reg.deal_id).toBeNull();
    expect(reg.looked_at).toBeNull();
    expect(reg.in_stage_since).toBeNull();
    expect(reg.deal_moved_at).toBeNull();
  });
});
