import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { FirmUserIdentity } from "../src/worker/auth";
import { createWorkCardInternal, handleWorkByOwner, handleMarkWorkDeskSeen } from "../src/worker/services/workCards";

/**
 * THE DESK REMEMBERS WHEN SHE LAST LOOKED (Wave C, 22 Sep 2026, migration 0225).
 *
 * `work_desk_seen` shipped in 0225 with no reader anywhere — the plan's own finding. This is the
 * first thing that reads and writes it: `handleWorkByOwner` reports the moment BEFORE this visit
 * updates it (never the value it is about to write, or "new since you looked" would always read
 * empty), and `handleMarkWorkDeskSeen` is the separate door the client presses once the Desk has
 * actually rendered — never on every background board fetch, which is exactly the failure the
 * migration's own comment rules out for `mp_home_module_seen`.
 *
 * Also pinned here: the board resolves WHO opened a card to a name when it was an AI employee's
 * own seat (rather than a hand-off, which already carries `assigned_from_card_id`), because the
 * desk's origin badge needs a name, not a bare id, and joining it once server-side is cheaper and
 * more honest than the client guessing.
 */

let t: TestDb;
let env: Env;

const SEQUOIA: FirmUserIdentity = {
  id: "fu_sequoia_taylor",
  email: "sequoia@westpeek.ventures",
  fullName: "Sequoia Taylor",
  status: "ACTIVE",
  roles: ["MANAGING_PARTNER"],
  authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "west-peek" }],
};

function req(method = "GET", body?: unknown): Request {
  return new Request("https://os.joinwestpeek.com/x", {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function board(): Promise<{ desk_seen_at: string | null; cards: Array<Record<string, unknown>> }> {
  const res = await handleWorkByOwner({ env, identity: SEQUOIA as never, params: {}, request: req() } as never);
  return (await res.json()) as { desk_seen_at: string | null; cards: Array<Record<string, unknown>> };
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});
afterAll(async () => {
  await disposeTestDb(t);
});

describe("the desk remembers when she last looked", () => {
  it("reads null before she has ever visited", async () => {
    expect((await board()).desk_seen_at).toBeNull();
  });

  it("POST /api/work-cards/desk-seen marks the moment, and the very next board read carries it", async () => {
    const before = new Date().toISOString();
    const res = await handleMarkWorkDeskSeen({ env, identity: SEQUOIA as never, params: {}, request: req("POST", {}) } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; seen_at: string };
    expect(body.ok).toBe(true);
    expect(body.seen_at >= before).toBe(true);

    expect((await board()).desk_seen_at).toBe(body.seen_at);
  });

  it("upserts — one row per partner, not a growing log", async () => {
    await handleMarkWorkDeskSeen({ env, identity: SEQUOIA as never, params: {}, request: req("POST", {}) } as never);
    await handleMarkWorkDeskSeen({ env, identity: SEQUOIA as never, params: {}, request: req("POST", {}) } as never);
    const row = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_desk_seen WHERE firm_user_id = ?1")
      .bind(SEQUOIA.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("the board never updates it — only the dedicated door does", async () => {
    const seenBefore = (await board()).desk_seen_at;
    // Reading the board again, any number of times, must not move the mark forward by itself.
    await board();
    await board();
    expect((await board()).desk_seen_at).toBe(seenBefore);
  });
});

describe("the board names who opened a card, when it was an AI employee's own seat", () => {
  it("resolves the employee's name for a card the seat opened directly", async () => {
    const wyatt: FirmUserIdentity = {
      id: "aie_wyatt",
      email: "wyatt@joinwestpeek.com",
      fullName: "Wyatt",
      status: "ACTIVE",
      roles: ["MANAGING_PARTNER"],
      authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "west-peek" }],
    };
    const c = await createWorkCardInternal(env, wyatt, { title: "Wyatt's own follow-up", machine_id: undefined });
    const found = (await board()).cards.find((x) => x.id === c.id);
    expect(found, "the new card must still be on the board").toBeDefined();
    expect(found?.created_by_ai_name).toBe("Wyatt");
  });

  it("carries no employee name for a card a partner opened", async () => {
    const c = await createWorkCardInternal(env, SEQUOIA, { title: "Something she typed herself", machine_id: undefined });
    const found = (await board()).cards.find((x) => x.id === c.id);
    expect(found?.created_by_ai_name ?? null).toBeNull();
  });
});
