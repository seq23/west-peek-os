import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { NEWEST_CAP, communityNewest, contactSyncState, type NewestContact } from "../src/worker/services/communityOs";

/**
 * GET /api/community/newest — "so we can see some names" (operator, 27 Sep 2026).
 *
 * The rules under test: newest first in the SHEET'S order — the order the sync first stored each
 * row, not the snapshot's created_at, which the newest rows on the sheet leave blank (28 Sep 2026);
 * at most 25 however many are asked for; contacts only (an event mapping is not a person); this
 * firm's scope only; only the active; only a first and last name; every field extracted in D1
 * from the snapshot — the Worker never parses a snapshot to find the newest.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
/** The subscription claimer: a service identity with no roles and no scopes (auth.ts, migration 0187). */
const CLAIMER = { "x-wpos-dev-user": "subscription-claimer@joinwestpeek.com" };

type Newest = {
  newest: NewestContact[];
  skipped: number;
  cap: number;
  loading: { done: number; total: number } | null;
  source: { last_status: string; last_sync_at: string | null; failure_reason: string | null };
};

async function seedMapping(opts: {
  external_id: string;
  resource?: string;
  firm_scope?: string;
  snapshot: Record<string, unknown>;
}): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO network_external_mapping (id, resource, external_id, identity_key, snapshot_json, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(`nem_${crypto.randomUUID()}`, opts.resource ?? "contact", opts.external_id, opts.external_id, JSON.stringify(opts.snapshot), opts.firm_scope ?? "west-peek")
    .run();
}

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await handleRequest(new Request(`https://test.local${path}`, { headers: MP }), env);
  return { status: res.status, body: (await res.json()) as T };
}

/**
 * Thirty contacts, seeded in a SHUFFLED order that is recorded: the window must come back in the
 * reverse of that order — the sheet's, as the sync met it — and not in the order of the
 * `created_at` each snapshot carries, which is deliberately unrelated to it.
 */
const SEEDED = 30;
const day = (i: number): string => `2026-08-${String(1 + i).padStart(2, "0")}T09:00:00Z`;
let order: number[] = [];
const ext = (i: number): string => `ext_c${i}`;

describe("GET /api/community/newest", () => {
  beforeAll(async () => {
    t = await createTestDb();
    env = makeTestEnv(t.db);
    order = Array.from({ length: SEEDED }, (_, i) => i).sort(() => 0.5 - Math.random());
    for (const i of order) {
      await seedMapping({
        external_id: `ext_c${i}`,
        snapshot: {
          full_name: `Person Test${String(i).padStart(2, "0")}`,
          status: i % 3 === 0 ? "Active" : "active",
          company: `Company ${i}`,
          city: "Chicago",
          person_type: i % 2 === 0 ? "founder" : "general_tech_adjacent",
          relationship_owner: "Scooter",
          created_at: day(i),
        },
      });
    }
    // An event is not a person, and another firm's contact is not this firm's.
    await seedMapping({ external_id: "ext_event", resource: "event", snapshot: { full_name: "Not A Person", created_at: "2030-01-01T00:00:00Z" } });
    await seedMapping({ external_id: "ext_other_firm", firm_scope: "other-firm", snapshot: { full_name: "Other Firm", created_at: "2030-01-01T00:00:00Z" } });
    // The August import, as Network OS holds it: newer than everyone and not a name. Each is
    // passed over and counted, never shown, and never pushes a person off the window.
    for (const [i, junk] of ["? ?", ". Goosby", "@tayllure Taylor", "*alt email: staylor@spry.vc more than a decade", "A K"].entries()) {
      await seedMapping({ external_id: `ext_junk${i}`, snapshot: { full_name: junk, status: "active", person_type: "general_tech_adjacent", created_at: "2029-01-01T00:00:00Z" } });
    }
    // The sheet's status column: anyone not active is not in the window, however new; a row
    // with no status field at all is (the column absent is not the same as inactive).
    for (const [i, status] of ["inactive", "Inactive", "lapsed", "", "removed"].entries()) {
      await seedMapping({ external_id: `ext_inactive${i}`, snapshot: { full_name: `Gone Person${i}`, status, created_at: "2029-06-01T00:00:00Z" } });
    }
  });

  afterAll(async () => {
    await disposeTestDb(t);
  });

  it("returns the newest first, capped at 25 even when 100 are asked for", async () => {
    const { status, body } = await get<Newest>("/api/community/newest?limit=100");
    expect(status).toBe(200);
    expect(body.cap).toBe(25);
    expect(NEWEST_CAP).toBe(25);
    expect(body.newest).toHaveLength(25);
    // The five rows with no first and last name are newer than everyone, skipped and counted.
    expect(body.skipped).toBe(5);
    expect(body.newest.map((c) => c.external_id).filter((id) => id.startsWith("ext_junk"))).toEqual([]);
    // …and the inactive are neither shown nor counted: they are out of the window entirely.
    expect(body.newest.map((c) => c.external_id).filter((id) => id.startsWith("ext_inactive"))).toEqual([]);
    // THE SHEET'S ORDER: the last 25 the sync stored, most recent first — whatever their created_at.
    expect(body.newest.map((c) => c.external_id)).toEqual(order.slice(-25).reverse().map(ext));
    // …and NOT the snapshot's created_at, which would put the highest day first.
    const created = body.newest.map((c) => c.created_at!);
    expect(created).not.toEqual([...created].sort().reverse());
  });

  it("defaults to 25, honours a smaller limit, and never goes below one", async () => {
    expect((await get<{ newest: NewestContact[] }>("/api/community/newest")).body.newest).toHaveLength(25);
    expect((await get<{ newest: NewestContact[] }>("/api/community/newest?limit=5")).body.newest).toHaveLength(5);
    expect((await get<{ newest: NewestContact[] }>("/api/community/newest?limit=0")).body.newest).toHaveLength(1);
    expect((await get<{ newest: NewestContact[] }>("/api/community/newest?limit=abc")).body.newest).toHaveLength(25);
    expect((await communityNewest(env, "west-peek", 3)).newest).toHaveLength(3);
  });

  it("shows contacts of this firm only — no events, no other scope", async () => {
    const { body } = await get<{ newest: NewestContact[] }>("/api/community/newest");
    const ids = body.newest.map((c) => c.external_id);
    expect(ids).not.toContain("ext_event");
    expect(ids).not.toContain("ext_other_firm");
    expect(body.newest.map((c) => c.full_name)).not.toContain("Not A Person");
    // The other firm sees its own one and none of ours.
    const theirs = await communityNewest(env, "other-firm");
    expect(theirs.newest.map((c) => c.external_id)).toEqual(["ext_other_firm"]);
  });

  it("extracts every field in D1 and hands back exactly the row the page reads", async () => {
    const [first] = (await get<{ newest: NewestContact[] }>("/api/community/newest?limit=1")).body.newest;
    const last = order[SEEDED - 1]!;
    expect(first).toEqual({
      external_id: ext(last),
      full_name: `Person Test${String(last).padStart(2, "0")}`,
      company: `Company ${last}`,
      city: "Chicago",
      person_type: last % 2 === 0 ? "founder" : "general_tech_adjacent",
      relationship_owner: "Scooter",
      created_at: day(last),
    });
    // A snapshot missing a field yields null, not a crash and not a made-up value.
    await seedMapping({ external_id: "ext_thin", snapshot: { full_name: "Thin Row", created_at: "2030-02-02T00:00:00Z" } });
    const [thin] = (await get<{ newest: NewestContact[] }>("/api/community/newest?limit=1")).body.newest;
    expect(thin).toMatchObject({ external_id: "ext_thin", full_name: "Thin Row", company: null, person_type: null, relationship_owner: null });
    // No status field at all: kept, as above. Marked inactive, it leaves the window.
    await env.WP_OS_DB.prepare("UPDATE network_external_mapping SET snapshot_json = json_set(snapshot_json, '$.status', 'inactive') WHERE external_id = 'ext_thin'").run();
    const [afterInactive] = (await get<Newest>("/api/community/newest?limit=1")).body.newest;
    expect(afterInactive!.external_id).not.toBe("ext_thin");
  });

  it("answers no one who is not signed in", async () => {
    const res = await handleRequest(new Request("https://test.local/api/community/newest"), env);
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(500);
  });

  it("refuses the subscription claimer: a service identity does not read the community's names", async () => {
    // Codex on #207: the claimer is authenticated with no roles and no scopes, and a router that
    // only asks for authentication would hand it names, companies and owners. It is refused by name.
    const res = await handleRequest(new Request("https://test.local/api/community/newest", { headers: CLAIMER }), env);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden");
    // …and a partner still reads it on the same terms as the population count.
    expect((await get<Newest>("/api/community/newest?limit=1")).status).toBe(200);
  });

  /*
   * THE SYNC STATE RIDES WITH THE NAMES. Codex on #207: during a multi-tick load the mapping table
   * holds a prefix of the community, and a response that omitted the cursor would let the page
   * caption that prefix "the last 25 added in Network OS"; an empty OK read, a failed read and a
   * read that never ran would all look alike. This runs LAST in the file: it writes the cursor row.
   */
  it("carries the contact sync's state — never synced, loading with its progress, then failed", async () => {
    const before = await get<Newest>("/api/community/newest?limit=1");
    expect(before.body.loading).toBeNull();
    expect(before.body.source).toEqual({ last_status: "NEVER_SYNCED", last_sync_at: null, failure_reason: null });

    await env.WP_OS_DB.prepare(
      `INSERT INTO network_sync_cursor (id, resource, cursor_value, last_sync_at, last_status, failure_reason, firm_scope)
       VALUES ('nsc_test_contact', 'contact', ?1, '2026-09-27T12:00:00Z', 'IN_PROGRESS', NULL, 'west-peek')`,
    )
      .bind(JSON.stringify({ offset: 1200, total: 5000 }))
      .run();
    const during = await get<Newest>("/api/community/newest?limit=1");
    expect(during.body.loading).toEqual({ done: 1200, total: 5000 });
    expect(during.body.source.last_status).toBe("IN_PROGRESS");
    expect(during.body.source.last_sync_at).toBe("2026-09-27T12:00:00Z");
    // The same read the population endpoint makes — one helper, so the two panels cannot disagree.
    expect(await contactSyncState(env, "west-peek")).toEqual({ loading: during.body.loading, source: during.body.source });

    await env.WP_OS_DB.prepare(
      "UPDATE network_sync_cursor SET last_status = 'FAILED', failure_reason = 'Network OS answered 503' WHERE id = 'nsc_test_contact'",
    ).run();
    const after = await get<Newest>("/api/community/newest?limit=1");
    expect(after.body.loading).toBeNull();
    expect(after.body.source).toMatchObject({ last_status: "FAILED", failure_reason: "Network OS answered 503" });
    // Another firm's cursor is not this firm's.
    expect((await contactSyncState(env, "other-firm")).source.last_status).toBe("NEVER_SYNCED");
  });

  /*
   * THE CURSOR IS READ BEFORE THE NAMES (Codex on #209). The sync tick writes mappings and then
   * flips the cursor to OK; two reads side by side could pair an OK cursor with names from before
   * the flip, and the page would caption a prefix as complete. A race cannot be staged in D1 from
   * here, so the order is pinned in the handler's source: the cursor awaited first, the names
   * after, and never a Promise.all across the two.
   */
  it("reads the sync state before the names, so an OK cursor never labels an older prefix", () => {
    const src = readFileSync(new URL("../src/worker/services/communityOs.ts", import.meta.url), "utf8");
    const handler = src.slice(src.indexOf("export async function handleCommunityNewest"));
    const cursorRead = handler.indexOf("await contactSyncState(");
    const namesRead = handler.indexOf("await communityNewest(");
    expect(cursorRead).toBeGreaterThan(0);
    expect(namesRead).toBeGreaterThan(cursorRead);
    expect(handler).not.toContain("Promise.all");
  });
});
