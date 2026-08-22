import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";

/**
 * Item 14 — the panel that lets a partner ask whoever runs the page they are on.
 *
 * What this suite holds, in order of how badly each would hurt:
 *
 * 1. **A switched-off host does not answer.** The card already refuses to smile over a page nobody
 *    is working; a box that answers anyway would teach a partner that the status is decoration. The
 *    refusal must be a RECORDED TURN, not an error that vanishes — the partner asked, and that they
 *    asked and got nothing back is part of the conversation.
 * 2. **An unhosted page has no panel at all.** Admin deliberately has no host, and a chat box there
 *    would invent an owner for machinery nobody runs.
 * 3. **The thread is per partner.** Two partners typing into one page thread would be a room, which
 *    needs presence and ordering across clients. What Sequoia asks Preston is not in Scooter's panel.
 * 4. **A failed turn keeps its number.** Turn numbers count every turn including the failures, or
 *    the next reply collides with a failed one on the UNIQUE constraint and the thread jams.
 */

let t: TestDb;
let env: Env;

const SEQUOIA = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };
const SCOOTER = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

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

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("a partner can ask whoever runs the page", () => {
  it("refuses in the host's own name when the host is not employed, and keeps the refusal in the thread", async () => {
    // No employee is ACTIVE in a fresh database — that is the honest default and the case a
    // first-time partner actually meets.
    const asked = await call<{ ok: boolean; detail: string | null }>("/api/pages/lp/reply", SEQUOIA, "POST", {
      message: "What does a soft commitment mean here?",
    });
    expect(asked.status).toBe(200);
    expect(asked.body.ok).toBe(false);
    expect(asked.body.detail).toMatch(/employ|not set up/i);

    const thread = await call<{ host: { name: string }; turns: Array<{ role: string; state: string; body: string }> }>(
      "/api/pages/lp/thread",
      SEQUOIA,
    );
    expect(thread.status).toBe(200);
    // Both turns survive: what was asked, and why nothing came back.
    expect(thread.body.turns).toHaveLength(2);
    expect(thread.body.turns[0]!.role).toBe("PARTNER");
    expect(thread.body.turns[1]!.state).toBe("REFUSED");
    // Named, not anonymous. "The assistant is unavailable" tells a partner nothing they can act on.
    expect(thread.body.turns[1]!.body).toContain(thread.body.host.name);
  });

  it("has nothing to offer on a page nobody hosts", async () => {
    // Admin surfaces are machinery, not rooms somebody runs. `pageHost` returns null and so must this.
    const res = await call("/api/pages/diagnostics/thread", SEQUOIA);
    expect(res.status).toBe(404);
  });

  it("keeps one thread per partner, so a question is not overheard", async () => {
    await call("/api/pages/portfolio/reply", SEQUOIA, "POST", { message: "Which of these is worth a second cheque?" });

    const hers = await call<{ turns: unknown[] }>("/api/pages/portfolio/thread", SEQUOIA);
    const his = await call<{ turns: unknown[] }>("/api/pages/portfolio/thread", SCOOTER);
    expect(hers.body.turns.length).toBeGreaterThan(0);
    expect(his.body.turns).toHaveLength(0);
  });

  it("numbers turns past the failures, so a jammed thread cannot happen", async () => {
    // Two refused exchanges on one page: if numbering counted only OK turns, the second ask would
    // reuse turn 1 and violate UNIQUE (nav_key, firm_user_id, turn_no).
    await call("/api/pages/thesis/reply", SEQUOIA, "POST", { message: "What belongs in the mandate?" });
    const second = await call<{ ok: boolean }>("/api/pages/thesis/reply", SEQUOIA, "POST", {
      message: "And what should we refuse outright?",
    });
    expect(second.status).toBe(200);

    const thread = await call<{ turns: Array<{ turn_no: number }> }>("/api/pages/thesis/thread", SEQUOIA);
    expect(thread.body.turns.map((x) => x.turn_no)).toEqual([1, 2, 3, 4]);
  });

  it("will not accept an empty question or a pasted document", async () => {
    const empty = await call("/api/pages/lp/reply", SEQUOIA, "POST", { message: " " });
    expect(empty.status).toBe(400);

    const essay = await call<{ detail: string }>("/api/pages/lp/reply", SEQUOIA, "POST", { message: "x".repeat(1201) });
    expect(essay.status).toBe(400);
    expect(essay.body.detail).toMatch(/shorter/i);
  });
});
