import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import type { FirmUserIdentity } from "../src/worker/auth";
import {
  declareContract,
  pullResource,
  resolveConflict,
  writeBack,
  REQUIRED_CONTRACT_CLAUSES,
  RECORDS_PER_PULL,
  type NetworkOsClient,
  type NetworkRecord,
} from "../src/worker/services/networkAdapter";
import { checkSources } from "../scripts/validate/no-cross-repo-coupling.mjs";

/**
 * P9 — Network OS integration boundary (D5).
 *
 * Rules under test (plan §8/P9 + §12.2): the adapter contract must DECLARE every
 * required clause; inbound sync is read-only and idempotent by delivery key; a
 * divergence opens a conflict AND a resolver work card instead of overwriting;
 * adapter failure degrades to read-only with previously synced data still readable;
 * outbound writeback is the MP-reserved `network_os.writeback` (receipt consumed,
 * never replayed, never fired without one); every crossing leaves an append-only
 * receipt; and there is no direct storage coupling to any partner repository.
 *
 * The live integration itself is UNPROVEN — INTEGRATION APPROVAL GATE: the HTTP
 * layer has no configured client, so live calls fail closed. All behaviour below is
 * proven against an injected in-memory client (fixture), never a real system.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MEMBER = { "x-wpos-dev-user": "member@westpeek.ventures" };

const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const MEMBER_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_test_member", roles: ["INVESTMENT_TEAM"], firmScopes: ["west-peek"] };
const AI_ACTOR: Actor = { type: "AI", aiEmployeeId: "aie_wyatt", roles: [], firmScopes: ["west-peek"] };

const MP_IDENTITY: FirmUserIdentity = {
  id: "fu_scooter_taylor",
  email: "scooter@westpeek.ventures",
  fullName: "Scooter Taylor",
  status: "ACTIVE",
  roles: ["MANAGING_PARTNER"],
  authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "west-peek" }],
};

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

const FULL_CONTRACT = {
  source_of_truth: {
    network_os: ["contact", "relationship", "touch", "gmail_thread"],
    west_peek_os: ["work_card", "approval", "investment_record", "canonical_company_mapping", "audit"],
  },
  direction: "INBOUND read-only by default; OUTBOUND only for west-peek-owned fields behind network_os.writeback",
  identity_keys: { contact: "email_lower", relationship: "contact_external_id", touch: "touch_external_id", gmail_thread: "thread_id" },
  freshness: "cursor per resource; last_sync_at recorded; stale reads are labelled, never silently trusted",
  conflict_behavior: "divergence opens a network_conflict plus a resolver work card; never a silent overwrite",
  idempotency: "delivery_id (or external_id) keyed receipt; duplicates recorded as DUPLICATE_IGNORED",
  retry_behavior: "bounded retries by the caller; failures recorded with reason; the approval receipt survives a failed writeback",
  audit_event: "network.* typed events on the one spine (D15) for every crossing",
  failure_state: "DEGRADED_READ_ONLY or FAILED on the cursor; WP OS keeps working with the last synced snapshot",
};

/** An in-memory Network OS stand-in. Never a real system. */
function fixtureClient(pages: Record<string, Array<{ records: NetworkRecord[]; next_cursor: string | null }>>, opts: { failPull?: string; failPush?: boolean } = {}): NetworkOsClient {
  const calls: Record<string, number> = {};
  return {
    async pull(resource, _cursor) {
      if (opts.failPull === resource) throw new Error("network unreachable: ECONNREFUSED");
      const index = calls[resource] ?? 0;
      calls[resource] = index + 1;
      const page = pages[resource]?.[index];
      return page ? { ...page, provider_version: "fixture-v1" } : { records: [], next_cursor: null, provider_version: "fixture-v1" };
    },
    async push(_resource, _record, _idempotencyKey) {
      if (opts.failPush) throw new Error("network unreachable: ETIMEDOUT");
      return { ok: true, response: { accepted: true } };
    },
  };
}

/** Create + submit + approve an approval card as MP; returns the receipt id. */
async function approvedCard(actionKey: string, objectType: string, objectId: string): Promise<string> {
  const created = await call<{ id: string }>("/api/approvals", MP, "POST", {
    action_key: actionKey,
    object_type: objectType,
    object_id: objectId,
    title: `p9: ${actionKey} ${objectId}`,
    submit: true,
  });
  expect(created.status).toBe(201);
  const decided = await call(`/api/approvals/${created.body.id}/decide`, MP, "POST", { decision: "approved" });
  expect(decided.status).toBe(200);
  return created.body.id;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs });
  await t.db
    .prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_test_member', 'member@westpeek.ventures', 'Test Member', 'ACTIVE')")
    .run();
  await t.db.prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_test_member', 'role_investment_team')").run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

// ── 0. Unauthenticated requests are denied ──

describe("0. unauthenticated requests are denied (401) across the P9 surface", () => {
  it("returns 401 on every P9 route", async () => {
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "/api/network/contract", {}],
      ["GET", "/api/network/contract"],
      ["POST", "/api/network/pull/contact", {}],
      ["GET", "/api/network/sync-state"],
      ["GET", "/api/network/mappings"],
      ["GET", "/api/network/conflicts"],
      ["POST", "/api/network/conflicts/ncf_x/resolve", {}],
      ["POST", "/api/network/writeback", {}],
    ];
    for (const [method, path, body] of routes) {
      const res = await handleRequest(req(path, {}, method, body), env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

// ── 1. The declared contract ──

describe("1. the adapter contract must declare every required clause", () => {
  it("refuses an incomplete contract and names the missing clauses", async () => {
    const res = await call<{ error: string; detail: string }>("/api/network/contract", MP, "POST", {
      source_of_truth: { network_os: ["contact"] },
      direction: "INBOUND",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("incomplete_contract");
    for (const clause of ["identity_keys", "freshness", "conflict_behavior", "idempotency", "retry_behavior", "audit_event", "failure_state"]) {
      expect(res.body.detail).toContain(clause);
    }
  });

  it("accepts a complete contract, activates exactly one version, and records the declaration", async () => {
    const res = await call<{ id: string; version: number; active: number }>("/api/network/contract", MP, "POST", FULL_CONTRACT);
    expect(res.status).toBe(201);
    expect(res.body.active).toBe(1);

    const second = await call<{ version: number }>("/api/network/contract", MP, "POST", { ...FULL_CONTRACT, notes: "v2: added touch freshness" });
    expect(second.status).toBe(201);
    expect(second.body.version).toBe(res.body.version + 1);

    const view = await call<{ active: { version: number }; versions: unknown[]; required_clauses: string[]; integration_state: string }>("/api/network/contract", MP);
    expect(view.body.active.version).toBe(second.body.version);
    expect(view.body.versions.length).toBeGreaterThanOrEqual(2);
    expect(view.body.required_clauses).toEqual([...REQUIRED_CONTRACT_CLAUSES]);
    expect(view.body.integration_state).toContain("UNPROVEN");
    const active = await t.db.prepare("SELECT COUNT(*) AS n FROM network_adapter_contract WHERE active = 1").first<{ n: number }>();
    expect(active!.n).toBe(1);
  });

  it("a declared version is immutable — a change is a new version, not an edit", async () => {
    await expect(t.db.prepare("UPDATE network_adapter_contract SET declaration_json = '{}'").run()).rejects.toThrow(/versioned/);
  });

  it("an AI actor can never declare the integration contract", async () => {
    await expect(declareContract(env, AI_ACTOR, FULL_CONTRACT)).rejects.toMatchObject({ status: 403 });
  });
});

// ── 2. Inbound: read-only, idempotent, conflict-safe ──

describe("2. inbound sync is read-only and idempotent", () => {
  it("applies records once and records a duplicate delivery as DUPLICATE_IGNORED", async () => {
    const record: NetworkRecord = {
      external_id: "contact_1",
      identity_key: "founder@example.com",
      delivery_id: "delivery_1",
      fields: { email: "founder@example.com", full_name: "Founder One", relationship_owner: "Scooter" },
    };
    const client = fixtureClient({ contact: [{ records: [record], next_cursor: "cur_1" }, { records: [record], next_cursor: "cur_1" }] });

    const first = await pullResource(env, MP_IDENTITY, "contact", client);
    expect(first).toMatchObject({ applied: 1, duplicates: 0, conflicts: 0, status: "OK", cursor: "cur_1" });

    // The SAME delivery arrives again: nothing changes, and the duplicate is recorded.
    const second = await pullResource(env, MP_IDENTITY, "contact", client);
    expect(second).toMatchObject({ applied: 0, duplicates: 1, conflicts: 0, status: "OK" });

    const mappings = await call<{ mappings: Array<{ external_id: string; snapshot_json: string }> }>("/api/network/mappings?resource=contact", MP);
    expect(mappings.body.mappings.filter((m) => m.external_id === "contact_1")).toHaveLength(1);
    const receipts = await t.db
      .prepare("SELECT status FROM network_sync_receipt WHERE resource = 'contact' AND external_id = 'contact_1' ORDER BY created_at, id")
      .all<{ status: string }>();
    expect((receipts.results ?? []).map((r) => r.status)).toEqual(["APPLIED", "DUPLICATE_IGNORED"]);
  });

  it("a divergence opens a conflict AND a resolver work card — never an overwrite", async () => {
    const v1: NetworkRecord = {
      external_id: "contact_2",
      identity_key: "lp@example.com",
      delivery_id: "d1",
      fields: { email: "lp@example.com", relationship_owner: "Scooter" },
    };
    const v2: NetworkRecord = {
      external_id: "contact_2",
      identity_key: "lp@example.com",
      delivery_id: "d2",
      fields: { email: "lp@example.com", relationship_owner: "Sequoia" },
    };
    const client = fixtureClient({ contact: [{ records: [v1], next_cursor: "c1" }, { records: [v2], next_cursor: "c2" }] });

    await pullResource(env, MP_IDENTITY, "contact", client);
    const conflicted = await pullResource(env, MP_IDENTITY, "contact", client);
    expect(conflicted.conflicts).toBe(1);
    expect(conflicted.applied).toBe(0);

    const conflicts = await call<{ conflicts: Array<{ id: string; field: string; external_value: string; internal_value: string; status: string; work_card_id: string }> }>(
      "/api/network/conflicts?status=OPEN",
      MP,
    );
    const conflict = conflicts.body.conflicts.find((c) => c.field === "relationship_owner")!;
    expect(conflict.external_value).toBe("Sequoia");
    expect(conflict.internal_value).toBe("Scooter");
    expect(conflict.work_card_id).toMatch(/^wc_/);

    // The stored snapshot still holds the pre-conflict value: nothing was overwritten.
    const mapping = await t.db.prepare("SELECT snapshot_json FROM network_external_mapping WHERE external_id = 'contact_2'").first<{ snapshot_json: string }>();
    expect(JSON.parse(mapping!.snapshot_json).relationship_owner).toBe("Scooter");

    // The resolver card is real, governed work.
    const card = await call<{ title: string; state: string; priority: string }>(`/api/work-cards/${conflict.work_card_id}`, MP);
    expect(card.status).toBe(200);
    expect(card.body.title).toContain("Network OS conflict");
    expect(card.body.state).toBe("OPEN");

    // Only an explicit human resolution moves the observed value.
    const resolved = await call<{ status: string; resolution: string }>(`/api/network/conflicts/${conflict.id}/resolve`, MP, "POST", {
      resolution: "KEEP_EXTERNAL",
      note: "Network OS owns relationship ownership (D5)",
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.resolution).toBe("KEEP_EXTERNAL");
    const after = await t.db.prepare("SELECT snapshot_json FROM network_external_mapping WHERE external_id = 'contact_2'").first<{ snapshot_json: string }>();
    expect(JSON.parse(after!.snapshot_json).relationship_owner).toBe("Sequoia");
    const again = await call(`/api/network/conflicts/${conflict.id}/resolve`, MP, "POST", { resolution: "KEEP_INTERNAL" });
    expect(again.status).toBe(409);
  });

  it("KEEP_INTERNAL resolves the conflict without adopting the external value", async () => {
    const base: NetworkRecord = { external_id: "contact_3", identity_key: "x@example.com", delivery_id: "e1", fields: { title: "Head of Ops" } };
    const changed: NetworkRecord = { external_id: "contact_3", identity_key: "x@example.com", delivery_id: "e2", fields: { title: "Ops Lead" } };
    const client = fixtureClient({ relationship: [{ records: [base], next_cursor: null }, { records: [changed], next_cursor: null }] });
    await pullResource(env, MP_IDENTITY, "relationship", client);
    await pullResource(env, MP_IDENTITY, "relationship", client);
    const conflicts = await call<{ conflicts: Array<{ id: string; external_id: string; field: string }> }>("/api/network/conflicts?status=OPEN", MP);
    const conflict = conflicts.body.conflicts.find((c) => c.external_id === "contact_3")!;
    await call(`/api/network/conflicts/${conflict.id}/resolve`, MP, "POST", { resolution: "KEEP_INTERNAL", note: "our title is current" });
    const mapping = await t.db.prepare("SELECT snapshot_json FROM network_external_mapping WHERE external_id = 'contact_3'").first<{ snapshot_json: string }>();
    expect(JSON.parse(mapping!.snapshot_json).title).toBe("Head of Ops");
  });

  it("an AI actor cannot resolve a Network OS conflict", async () => {
    const rec: NetworkRecord = { external_id: "contact_4", identity_key: "y@example.com", delivery_id: "f1", fields: { tier: "A" } };
    const changed: NetworkRecord = { external_id: "contact_4", identity_key: "y@example.com", delivery_id: "f2", fields: { tier: "B" } };
    const client = fixtureClient({ touch: [{ records: [rec], next_cursor: null }, { records: [changed], next_cursor: null }] });
    await pullResource(env, MP_IDENTITY, "touch", client);
    await pullResource(env, MP_IDENTITY, "touch", client);
    const conflict = await t.db.prepare("SELECT id FROM network_conflict WHERE external_id = 'contact_4' AND status = 'OPEN'").first<{ id: string }>();
    await expect(resolveConflict(env, AI_ACTOR, conflict!.id, "KEEP_EXTERNAL")).rejects.toMatchObject({ status: 403 });
  });
});

// ── 3. Failure degrades to read-only ──

describe("3. adapter failure degrades to read-only and stays visible", () => {
  it("records FAILED with the reason, keeps prior mappings readable, and leaves WP OS working", async () => {
    const failing = fixtureClient({}, { failPull: "gmail_thread" });
    const summary = await pullResource(env, MP_IDENTITY, "gmail_thread", failing);
    expect(summary.status).toBe("FAILED");
    expect(summary.failure_reason).toContain("ECONNREFUSED");

    const state = await call<{ cursors: Array<{ resource: string; last_status: string; failure_reason: string }> }>("/api/network/sync-state", MP);
    const cursor = state.body.cursors.find((c) => c.resource === "gmail_thread")!;
    expect(cursor.last_status).toBe("FAILED");
    expect(cursor.failure_reason).toContain("ECONNREFUSED");

    // Previously synced relationship data is still readable…
    const mappings = await call<{ mappings: unknown[] }>("/api/network/mappings?resource=contact", MP);
    expect(mappings.body.mappings.length).toBeGreaterThan(0);
    // …and the rest of the system is unaffected.
    const me = await call("/api/me", MP);
    expect(me.status).toBe(200);
  });

  it("with no configured client the HTTP route fails closed as UNPROVEN and records the refusal", async () => {
    const res = await call<{ error: string; detail: string }>("/api/network/pull/contact", MP, "POST", {});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("adapter_unconfigured");
    expect(res.body.detail).toContain("UNPROVEN");
    const refusals = await t.db.prepare("SELECT COUNT(*) AS n FROM network_sync_receipt WHERE status = 'REFUSED' AND failure_reason = 'adapter_unconfigured'").first<{ n: number }>();
    expect(refusals!.n).toBeGreaterThan(0);
  });
});

describe("3b. a fixture proves the transform, never the far end", () => {
  /**
   * Production, 21 Aug 2026: the cursor read `contact — OK` over three FAILED/REFUSED receipts and
   * zero mappings. The OK came from a fixture run the following day, which never touches Network OS
   * at all — so a test of the mapping code reported a live integration healthy that had never once
   * worked, and the only surface watching it went green for three days.
   */
  it("leaves the live cursor untouched, however it goes", async () => {
    const before = await t.db
      .prepare("SELECT last_status, failure_reason FROM network_sync_cursor WHERE resource = 'gmail_thread'")
      .first<{ last_status: string; failure_reason: string | null }>();
    // The previous block left this resource FAILED; that is the state a fixture must not improve.
    expect(before!.last_status).toBe("FAILED");

    const res = await call<{ provider: string; applied: number }>("/api/network/pull/gmail_thread", MP, "POST", {
      fixture_records: [
        { external_id: "thread_fixture_1", identity_key: "thread_fixture_1", fields: { subject: "fixture" } },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.provider).toBe("LOCAL_FIXTURE");

    const after = await t.db
      .prepare("SELECT last_status, failure_reason FROM network_sync_cursor WHERE resource = 'gmail_thread'")
      .first<{ last_status: string; failure_reason: string | null }>();
    expect(after!.last_status).toBe("FAILED");
    expect(after!.failure_reason).toBe(before!.failure_reason);
  });

  it("still records its own receipt, so the run itself is not invisible", async () => {
    const receipts = await t.db
      .prepare("SELECT COUNT(*) AS n FROM network_sync_receipt WHERE resource = 'gmail_thread' AND status = 'APPLIED'")
      .first<{ n: number }>();
    expect(receipts!.n).toBeGreaterThan(0);
  });
});

// ── 4. Outbound writeback is MP-reserved and receipted ──

describe("4. writeback requires the reserved approval and is never replayed", () => {
  it("refuses without a receipt (and records the refusal), then executes once with one", async () => {
    const client = fixtureClient({});
    await expect(writeBack(env, MP_ACTOR, { resource: "contact", external_id: "contact_1", fields: { firm_note: "IC approved" } }, client)).rejects.toMatchObject({
      status: 409,
      code: "approval_required",
    });
    const refused = await t.db
      .prepare("SELECT COUNT(*) AS n FROM network_sync_receipt WHERE direction = 'OUTBOUND' AND status = 'REFUSED' AND failure_reason = 'approval_required'")
      .first<{ n: number }>();
    expect(refused!.n).toBe(1);

    const receipt = await approvedCard("network_os.writeback", "network_external_mapping", "contact_1");
    const applied = (await writeBack(env, MP_ACTOR, { resource: "contact", external_id: "contact_1", fields: { firm_note: "IC approved" }, approval_receipt_id: receipt }, client)) as {
      status: string;
      approval_card_id: string;
    };
    expect(applied.status).toBe("APPLIED");
    expect(applied.approval_card_id).toBe(receipt);

    // The receipt is consumed: the same authorization cannot be reused.
    await expect(
      writeBack(env, MP_ACTOR, { resource: "contact", external_id: "contact_1", fields: { firm_note: "again" }, approval_receipt_id: receipt }, client),
    ).rejects.toMatchObject({ status: 409 });
    const card = await call<{ state: string }>(`/api/approvals/${receipt}`, MP);
    expect(card.body.state).toBe("executed");
  });

  it("a non-MP cannot obtain the writeback authorization", async () => {
    const created = await call<{ id: string }>("/api/approvals", MEMBER, "POST", {
      action_key: "network_os.writeback",
      object_type: "network_external_mapping",
      object_id: "contact_1",
      title: "member self-approval attempt",
      submit: true,
    });
    const decision = await call(`/api/approvals/${created.body.id}/decide`, MEMBER, "POST", { decision: "approved" });
    expect(decision.status).toBe(403);
    await expect(
      writeBack(env, MEMBER_ACTOR, { resource: "contact", external_id: "contact_1", fields: { x: 1 }, approval_receipt_id: created.body.id }, fixtureClient({})),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("an AI actor can never write back", async () => {
    await expect(writeBack(env, AI_ACTOR, { resource: "contact", external_id: "contact_1", fields: { x: 1 } }, fixtureClient({}))).rejects.toMatchObject({ status: 403 });
  });

  it("a failed delivery records FAILED and preserves the human authorization for a retry", async () => {
    const receipt = await approvedCard("network_os.writeback", "network_external_mapping", "contact_2");
    await expect(
      writeBack(env, MP_ACTOR, { resource: "contact", external_id: "contact_2", fields: { firm_note: "x" }, approval_receipt_id: receipt }, fixtureClient({}, { failPush: true })),
    ).rejects.toMatchObject({ status: 502 });
    const card = await call<{ state: string }>(`/api/approvals/${receipt}`, MP);
    expect(card.body.state).toBe("approved"); // NOT consumed

    // The retry with a working client succeeds under the same authorization.
    const applied = (await writeBack(env, MP_ACTOR, { resource: "contact", external_id: "contact_2", fields: { firm_note: "x" }, approval_receipt_id: receipt }, fixtureClient({}))) as {
      status: string;
    };
    expect(applied.status).toBe("APPLIED");
  });

  it("every crossing leaves an append-only receipt", async () => {
    const row = await t.db.prepare("SELECT id FROM network_sync_receipt LIMIT 1").first<{ id: string }>();
    await expect(t.db.prepare("UPDATE network_sync_receipt SET status = 'APPLIED' WHERE id = ?1").bind(row!.id).run()).rejects.toThrow(/append-only/);
    await expect(t.db.prepare("DELETE FROM network_sync_receipt WHERE id = ?1").bind(row!.id).run()).rejects.toThrow(/append-only/);
  });

  it("the journey leaves typed network.* events on the ONE spine (D15)", async () => {
    const events = await t.db.prepare("SELECT DISTINCT event_type FROM event_record WHERE event_type LIKE 'network.%'").all<{ event_type: string }>();
    const types = new Set((events.results ?? []).map((e) => e.event_type));
    for (const expected of [
      "network.contract_declared",
      "network.sync_completed",
      "network.sync_failed",
      "network.conflict_opened",
      "network.conflict_resolved",
      "network.writeback_executed",
    ]) {
      expect(types, expected).toContain(expected);
    }
  });
});

// ── 5. No direct storage coupling ──

describe("5. there is no direct cross-repo storage coupling", () => {
  it("the boundary scanner catches every coupling pattern it claims to catch", () => {
    const clean = {
      "src/worker/services/networkAdapter.ts": "const page = await client.pull(resource, cursor);\nawait env.WP_OS_DB.prepare('SELECT 1').first();",
    };
    expect(checkSources(clean)).toHaveLength(0);
    expect(checkSources({ ...clean, "src/x.ts": 'open("../../west-peek-network-os/data/app.db")' }).length).toBeGreaterThan(0);
    expect(checkSources({ ...clean, "src/x.ts": "await env.NETWORK_OS_DB.prepare('x').all()" }).length).toBeGreaterThan(0);
    expect(checkSources({ ...clean, "src/x.ts": 'fetch("https://network-os.example.com/contacts")' }).length).toBeGreaterThan(0);
    // Naming a partner repo in a COMMENT is provenance, not coupling.
    expect(checkSources({ ...clean, "src/x.ts": "// ported from seq23/secondaries app.js\nconst x = 1;" })).toHaveLength(0);
  });

  it("West Peek OS never becomes the source of truth for a Network OS resource", async () => {
    // Mappings store an observed SNAPSHOT plus the identity key — there is no
    // contact/relationship/touch table in the West Peek OS schema at all.
    const tables = await t.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    const names = (tables.results ?? []).map((r) => r.name);
    for (const forbidden of ["contact", "relationship", "touch", "gmail_thread", "network_contact"]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
    expect(names).toContain("network_external_mapping");
  });
});


/*
 * THE COMMUNITY COULD NEVER GET PAST ITS FIRST PAGE.
 *
 * `pullResource` writes `last_status = 'IN_PROGRESS'` when more records remain, and the CHECK on
 * `network_sync_cursor` allowed only NEVER_RUN, OK, DEGRADED_READ_ONLY and FAILED. So every partial
 * sync threw on the write that records where it got to, `cursor_value` stayed NULL, `readProgress`
 * returned offset 0, and the next tick re-applied the same first 250 records. For ever.
 *
 * In production it failed on every run for two hours while the job reported SUCCEEDED, because the
 * dispatch returned SUCCEEDED unconditionally and the error travelled in the summary line. The
 * operator found it by asking how long a full sync would take. The honest answer was: it never
 * finishes.
 *
 * This is the test that would have caught it: a community larger than one page.
 */
describe("a community that does not fit in one pull", () => {
  it("advances the cursor, reports IN_PROGRESS, and resumes where it stopped", async () => {
    const records: NetworkRecord[] = Array.from({ length: RECORDS_PER_PULL + 40 }, (_, i) => ({
      external_id: `bigsync_${i}`,
      identity_key: `p${i}@example.test`,
      delivery_id: `bigsync_delivery_${i}`,
      fields: { email: `p${i}@example.test`, full_name: `Person ${i}` },
    }));
    // One page from the far end carrying everybody: the paging under test is OURS, applied across
    // ticks so a large community does not have to arrive inside one CPU budget.
    const client = fixtureClient({ contact: [{ records, next_cursor: null }, { records, next_cursor: null }] });

    const first = await pullResource(env, MP_IDENTITY, "contact", client);
    expect(first.status, "a partial pass is IN_PROGRESS, never OK").toBe("IN_PROGRESS");
    expect(first.progress?.complete).toBe(false);
    expect(first.applied).toBe(RECORDS_PER_PULL);

    // THE CURSOR MOVED. This is the assertion that fails against the bug: the write that records
    // progress was rejected by the CHECK, so it stayed null and the next pass started from zero.
    const cursor = await t.db
      .prepare("SELECT cursor_value, last_status FROM network_sync_cursor WHERE resource = 'contact'")
      .first<{ cursor_value: string | null; last_status: string }>();
    expect(cursor?.cursor_value, "without this the next tick re-reads the same page for ever").toBeTruthy();
    expect(cursor?.last_status).toBe("IN_PROGRESS");

    const second = await pullResource(env, MP_IDENTITY, "contact", client);
    expect(second.applied, "the remainder, not the same page again").toBe(40);
    expect(second.status).toBe("OK");
    expect(second.progress?.complete).toBe(true);

    // Everybody arrived exactly once.
    const mapped = await t.db
      .prepare("SELECT COUNT(*) AS n FROM network_external_mapping WHERE resource = 'contact'")
      .first<{ n: number }>();
    // Everybody arrived exactly once — plus whatever earlier tests in this file mapped.
    expect(mapped!.n).toBeGreaterThanOrEqual(records.length);
    const mine = await t.db
      .prepare("SELECT COUNT(*) AS n FROM network_external_mapping WHERE resource = 'contact' AND external_id LIKE 'bigsync/_%' ESCAPE '/'")
      .first<{ n: number }>();
    expect(mine?.n).toBe(records.length);
  });
});
