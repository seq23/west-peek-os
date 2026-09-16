import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleRequest } from "../src/worker/index";
import { buildHome, freshness, HOME_MODULE_KEYS, HOME_MODULE_LINKS, itemsHash } from "../src/worker/services/mpHome";
import type { FirmUserIdentity } from "../src/worker/auth";

/**
 * "Who has something for you" means NEW SINCE YOU LAST LOOKED.
 *
 * Operator, 15 Sep 2026: the section counted modules that merely HAD items — five companies in the
 * pipeline was "something" forever, and pressing Open never quieted it. A module has something only
 * if it holds items newer than the moment this partner last opened it (pressed Open, or reached the
 * module's page by any door). Items with no timestamp go quiet after the first Open until their set
 * changes.
 */

let t: TestDb;
let env: Env;

const SEQUOIA: FirmUserIdentity = {
  id: "fu_sequoia_taylor",
  email: "sequoia@westpeek.ventures",
  fullName: "Sequoia Taylor",
  status: "ACTIVE",
  roles: ["MANAGING_PARTNER"],
  authorityScopes: [],
};

const AS_MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };
function req(path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? AS_MP : { ...AS_MP, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});
afterAll(async () => {
  await disposeTestDb(t);
});

describe("freshness, as a pure rule", () => {
  const stamped = (id: string, at: string) => ({ id, created_at: at });

  it("treats everything as new when the module was never opened, and nothing as new when it is empty", () => {
    expect(freshness([stamped("a", "2026-09-15T10:00:00Z")], null)).toEqual({ new_count: 1, has_new: true });
    expect(freshness([], null)).toEqual({ new_count: 0, has_new: false });
    expect(freshness([], { seen_at: "2026-09-15T10:00:00Z", items_hash: null })).toEqual({ new_count: 0, has_new: false });
  });

  it("counts only items stamped after the mark", () => {
    const items = [stamped("old", "2026-09-14T09:00:00Z"), stamped("new", "2026-09-15T20:02:00Z")];
    expect(freshness(items, { seen_at: "2026-09-15T20:01:00Z", items_hash: null })).toEqual({ new_count: 1, has_new: true });
    expect(freshness(items, { seen_at: "2026-09-15T20:03:00Z", items_hash: null })).toEqual({ new_count: 0, has_new: false });
  });

  it("falls back to the set of ids when items carry no timestamp", () => {
    const roster = [{ id: "e1", name: "Wren" }, { id: "e2", name: "Walker" }];
    const seen = { seen_at: "2026-09-15T20:01:00Z", items_hash: itemsHash(roster) };
    expect(freshness(roster, seen).has_new).toBe(false);
    expect(freshness([...roster, { id: "e3", name: "Wyatt" }], seen).has_new).toBe(true);
    // Order does not count as change.
    expect(freshness([roster[1]!, roster[0]!], seen).has_new).toBe(false);
  });
});

describe("Open leaves a mark, and the module goes quiet until something arrives", () => {
  it("is loud before Open, quiet after it, and loud again when a newer item lands", async () => {
    // A work card in her name is a `my_work` item with a created_at.
    await t.db.prepare(
      `INSERT INTO work_card (id, title, state, priority, owner_type, owner_id, firm_scope, created_by, created_at)
       VALUES ('wc_fresh_1', 'Read the Sensori memo', 'OPEN', 'NORMAL', 'HUMAN', 'fu_sequoia_taylor', 'west-peek', 'fu_sequoia_taylor', '2026-09-15T19:00:00.000Z')`,
    ).run();
    const before = (await buildHome(env, SEQUOIA)).modules.find((m) => m.key === "my_work")!;
    expect(before.items.length).toBeGreaterThan(0);
    expect(before.seen_at).toBeNull();
    expect(before.has_new).toBe(true);

    const opened = await handleRequest(req("/api/mp-home/modules/my_work/seen", "POST", {}), env);
    expect(opened.status).toBe(200);
    const after = (await buildHome(env, SEQUOIA)).modules.find((m) => m.key === "my_work")!;
    expect(after.items.length, "the items are still there — quiet is not empty").toBe(before.items.length);
    expect(after.seen_at).toBeTruthy();
    expect(after.has_new, "she opened it; nothing has arrived since").toBe(false);
    expect(after.new_count).toBe(0);

    // A newer card: loud again, and the count says how many.
    await t.db.prepare(
      `INSERT INTO work_card (id, title, state, priority, owner_type, owner_id, firm_scope, created_by, created_at)
       VALUES ('wc_fresh_2', 'Call the Sensori founder', 'OPEN', 'HIGH', 'HUMAN', 'fu_sequoia_taylor', 'west-peek', 'fu_sequoia_taylor', ?1)`,
    ).bind(new Date(Date.now() + 60_000).toISOString()).run();
    const again = (await buildHome(env, SEQUOIA)).modules.find((m) => m.key === "my_work")!;
    expect(again.has_new).toBe(true);
    expect(again.new_count).toBe(1);
  });

  it("goes quiet after Open for a module whose items carry no timestamp, until the set changes", async () => {
    const before = (await buildHome(env, SEQUOIA)).modules.find((m) => m.key === "employees")!;
    expect(before.items.length).toBeGreaterThan(0);
    expect(before.items.every((it) => !("created_at" in it)), "the premise: the roster carries no stamp").toBe(true);
    expect(before.has_new).toBe(true);
    expect((await handleRequest(req("/api/mp-home/modules/employees/seen", "POST", {}), env)).status).toBe(200);
    expect((await buildHome(env, SEQUOIA)).modules.find((m) => m.key === "employees")!.has_new).toBe(false);
  });

  it("marks a module seen when its page is visited by any door", async () => {
    await t.db.prepare(
      `INSERT INTO work_card (id, title, state, priority, owner_type, owner_id, firm_scope, created_by, created_at)
       VALUES ('wc_fresh_3', 'A third card', 'OPEN', 'NORMAL', 'HUMAN', 'fu_sequoia_taylor', 'west-peek', 'fu_sequoia_taylor', ?1)`,
    ).bind(new Date(Date.now() + 120_000).toISOString()).run();
    expect((await buildHome(env, SEQUOIA)).modules.find((m) => m.key === "my_work")!.has_new).toBe(true);
    const visited = await handleRequest(req("/api/mp-home/visited", "POST", { route: "work" }), env);
    expect(visited.status).toBe(200);
    expect(((await visited.json()) as { modules: string[] }).modules).toContain("my_work");
    // The mark is stamped now, and the card is stamped two minutes from now — still newer.
    // What matters is that a visit writes the SAME mark Open writes.
    const row = await t.db.prepare("SELECT seen_at FROM mp_home_module_seen WHERE firm_user_id = 'fu_sequoia_taylor' AND module_key = 'my_work'").first<{ seen_at: string }>();
    expect(row?.seen_at).toBeTruthy();
    // A route no module points at is a no-op, not an error.
    const none = await handleRequest(req("/api/mp-home/visited", "POST", { route: "home" }), env);
    expect(((await none.json()) as { modules: string[] }).modules).toEqual([]);
  });

  it("refuses to mark a module that does not exist", async () => {
    expect((await handleRequest(req("/api/mp-home/modules/nonsense/seen", "POST", {}), env)).status).toBe(404);
  });

  it("keeps the route map and each module's own link in agreement", async () => {
    // Every module must be enabled to check it — the default set omits some.
    await t.db.prepare(
      `INSERT INTO mp_home_preference (id, firm_user_id, version_no, modules_json, briefing_json, set_by)
       VALUES ('mhp_fresh_all', 'fu_sequoia_taylor', 99, ?1, '{}', 'fu_sequoia_taylor')`,
    ).bind(JSON.stringify([...HOME_MODULE_KEYS])).run();
    const home = await buildHome(env, SEQUOIA);
    expect(home.modules.length, "an MP sees every module").toBe(HOME_MODULE_KEYS.length);
    for (const m of home.modules) {
      expect(HOME_MODULE_LINKS[m.key as keyof typeof HOME_MODULE_LINKS], `${m.key} visits would be written against the wrong route`).toBe(m.link);
    }
  });
});
