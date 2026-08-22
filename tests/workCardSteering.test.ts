import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import { buildStepPrompt } from "../src/shared/work/employeeLoop";
import type { Env } from "../src/worker/env";

/**
 * A partner steering work that is already running.
 *
 * Operator, 22 Aug 2026: "can the MPs give feedback on a work card that we want the ai employee to
 * acknowledge while they are doing the work?"
 *
 * THE TEST THAT MATTERS IS THE PROMPT ONE. A note that renders on a page and never reaches the
 * instruction the employee is working from is a comment box: the partner types and the machine
 * carries on. Everything else here is bookkeeping around that one fact.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

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

const BASE_CTX = {
  title: "Screen the inbound decks",
  next_action: "read them",
  description: null,
  employee_name: "Wyatt",
  employee_role: "Analyst & Scout",
  allows_browser: false,
  prompt: "Start with the ones from people we know.",
  guidance: "",
  history: [],
};

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  await env.WP_OS_DB.prepare(
    "INSERT INTO work_card (id, title, state, created_by) VALUES ('wc_steer', 'Screen the inbound decks', 'IN_PROGRESS', 'fu_sequoia_taylor')",
  ).run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("a note reaches the instruction the employee is working from", () => {
  it("outranks the partner's original brief, because it was said later and while watching", () => {
    const prompt = buildStepPrompt(
      { ...BASE_CTX, steering: [{ id: "n1", body: "Sequoia: skip anything pre-revenue for now" }] },
      3,
    );
    expect(prompt).toContain("skip anything pre-revenue");
    // Placed AFTER the original instruction and said to outrank it. A model that averaged the two
    // would follow neither, which is the failure mode of putting a correction beside a brief.
    expect(prompt.indexOf("skip anything pre-revenue")).toBeGreaterThan(prompt.indexOf("Start with the ones from people we know"));
    expect(prompt).toMatch(/outranks everything above/i);
  });

  it("asks for what changed rather than for agreement", () => {
    const prompt = buildStepPrompt({ ...BASE_CTX, steering: [{ id: "n1", body: "Sequoia: focus on fintech" }] }, 3);
    // "Say plainly that it changes nothing and why" is a real answer. An acknowledgement that can
    // only mean yes teaches an employee to agree rather than to think.
    expect(prompt).toMatch(/changes nothing and why/i);
    expect(prompt).toMatch(/ACKNOWLEDGED:/);
  });

  it("says nothing at all when there is nothing to say", () => {
    const prompt = buildStepPrompt({ ...BASE_CTX, steering: [] }, 3);
    expect(prompt).not.toMatch(/ACKNOWLEDGED:/);
    // An employee told "A PARTNER HAS SAID SOMETHING" followed by nothing has been told something
    // false, which is the same rule that governs the empty guidance block.
    expect(prompt).not.toMatch(/A PARTNER HAS SAID SOMETHING/);
  });
});

describe("what a note is, and is not", () => {
  it("takes a note on work that is still running", async () => {
    const res = await call<{ id: string; waiting: boolean }>("/api/work-cards/wc_steer/notes", MP, "POST", {
      body: "Skip anything pre-revenue for now",
    });
    expect(res.status).toBe(201);
    expect(res.body.waiting).toBe(true);
  });

  it("refuses a note on finished work rather than accepting it into a void", async () => {
    await env.WP_OS_DB.prepare(
      "INSERT INTO work_card (id, title, state, created_by) VALUES ('wc_done', 'Finished', 'DONE', 'fu_sequoia_taylor')",
    ).run();
    const res = await call<{ error: string; detail: string }>("/api/work-cards/wc_done/notes", MP, "POST", {
      body: "One more thing",
    });
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/nobody will read/i);
  });

  it("cannot be rewritten after it is left", async () => {
    // A steering note is part of the record of how a piece of work came out the way it did.
    // Editing it afterwards would rewrite that, so the database refuses.
    await expect(
      env.WP_OS_DB.prepare("UPDATE work_card_note SET body = 'something else' WHERE work_card_id = 'wc_steer'").run(),
    ).rejects.toThrow();
  });

  it("cannot be marked acknowledged without saying what it changed", async () => {
    // The CHECK makes acknowledged and answered one event. A flag on its own would let an employee
    // dismiss a partner's instruction without it ever touching the work.
    await expect(
      env.WP_OS_DB.prepare(
        "UPDATE work_card_note SET acknowledged_at = '2026-08-22T00:00:00.000Z' WHERE work_card_id = 'wc_steer'",
      ).run(),
    ).rejects.toThrow();
  });

  it("shows what was said and what came back", async () => {
    const res = await call<{ notes: Array<{ body: string; acknowledged_at: string | null }> }>(
      "/api/work-cards/wc_steer/notes",
      MP,
    );
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0]!.body).toMatch(/pre-revenue/);
    expect(res.body.notes[0]!.acknowledged_at).toBeNull();
  });
});
