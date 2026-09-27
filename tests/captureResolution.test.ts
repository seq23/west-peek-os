import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";

/**
 * Capture resolution, and the queue underneath it (migration 0054).
 *
 * Four things were easy to confuse because only two of them may be the truth about anything:
 * Network OS owns PEOPLE, the company register owns COMPANIES, capture is a holding pen that owns
 * nothing, and Community is a lens rather than a roster.
 *
 * Capture could be routed to a machine and nothing else, so both systems of record were fed by
 * hand while the inbox filled up beside them. The sharper problem sat underneath: Network OS is
 * read-only from here, so somebody it has never heard of had nowhere to go at all.
 *
 * What these assert is that the system never claims otherwise. A person Network OS does not know
 * is recorded, marked, and queued — and every surface says which of those two states they are in.
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

async function newCapture(text: string): Promise<string> {
  const res = await call<{ id: string }>("/api/captures", MP, "POST", {
    capture_type: "NOTE",
    raw_text: text,
    source_channel: "test",
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("a capture resolves to what it is actually about", () => {
  it("creates a company when the register genuinely has none", async () => {
    const id = await newCapture("met the founder of Northwind Robotics at a Room");
    const res = await call<{ company_id: string; matched_via: string }>(`/api/captures/${id}/resolve`, MP, "POST", {
      kind: "COMPANY",
      name: "Northwind Robotics",
    });
    expect(res.status).toBe(200);
    expect(res.body.company_id).toMatch(/^cc_/);
    expect(res.body.matched_via).toBe("created");
  });

  it("matches an existing company instead of creating a second one", async () => {
    const first = await newCapture("Northwind again");
    const a = await call<{ company_id: string }>(`/api/captures/${first}/resolve`, MP, "POST", {
      kind: "COMPANY",
      name: "Southgate Health",
    });
    const second = await newCapture("Southgate once more");
    const b = await call<{ company_id: string; matched_via: string }>(`/api/captures/${second}/resolve`, MP, "POST", {
      kind: "COMPANY",
      name: "  southgate health  ", // messier than the first, deliberately
    });
    expect(b.body.company_id).toBe(a.body.company_id);
    expect(b.body.matched_via).toBe("existing register entry");

    // D3: one canonical identity per real company. A second row here is the whole failure.
    const count = await t.db
      .prepare("SELECT COUNT(*) AS n FROM canonical_company WHERE lower(canonical_name) = 'southgate health'")
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it("resolves a company through an alias rather than duplicating it", async () => {
    const seed = await newCapture("first sighting");
    const made = await call<{ company_id: string }>(`/api/captures/${seed}/resolve`, MP, "POST", {
      kind: "COMPANY",
      name: "Meridian Labs",
    });
    await t.db
      .prepare("INSERT INTO company_alias (id, company_id, alias, source) VALUES (?1, ?2, 'Meridian Laboratories', 'test')")
      .bind(`ca_${crypto.randomUUID()}`, made.body.company_id)
      .run();

    const again = await newCapture("someone called them Meridian Laboratories");
    const res = await call<{ company_id: string; matched_via: string }>(`/api/captures/${again}/resolve`, MP, "POST", {
      kind: "COMPANY",
      name: "Meridian Laboratories",
    });
    expect(res.body.company_id).toBe(made.body.company_id);
    expect(res.body.matched_via).toBe("existing register entry");
  });

  it("queues a person Network OS has never heard of, proposes them, and when that is refused says so plainly", async () => {
    // This env has no Network OS settings, so the automatic hand-off is REFUSED — the resolve still
    // succeeds, the refusal is named on the card, and a HIGH work card carries it to a person.
    const id = await newCapture("introduced to Dana Whitfield, operator, at the mastermind");
    const res = await call<{
      person_source: string;
      person_id: string;
      matched_via: string;
      what_this_means: string;
      proposal: { status: string; detail: string; work_card_id: string | null };
    }>(`/api/captures/${id}/resolve`, MP, "POST", { kind: "PERSON", name: "Dana Whitfield", email: "dana@example.com", organization: "Whitfield & Co" });
    expect(res.status).toBe(200);
    expect(res.body.person_source).toBe("LOCAL_UNRESOLVED");
    expect(res.body.proposal.status).toBe("refused");
    expect(res.body.proposal.detail).toContain("WP_OS_NETWORK_OS_BASE_URL is not set");
    expect(res.body.matched_via).toContain("proposal refused");
    // The claim the system must never make is that this person is in the system of record.
    expect(res.body.what_this_means).toContain("not claiming");
    // And it says what was refused and where the work now sits, rather than sending her elsewhere.
    expect(res.body.what_this_means).toContain("refused");
    expect(res.body.what_this_means).toContain("HIGH work card");
    const card = await t.db
      .prepare("SELECT title, priority, state FROM work_card WHERE id = ?1")
      .bind(res.body.proposal.work_card_id)
      .first<{ title: string; priority: string; state: string }>();
    expect(card).toEqual({ title: "Network OS refused a captured person: Dana Whitfield", priority: "HIGH", state: "OPEN" });
    const failed = await t.db
      .prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'network.person_proposal_failed' AND object_id = ?1")
      .bind(res.body.person_id)
      .first<{ n: number }>();
    expect(failed!.n).toBe(1);
  });

  it("matches a person Network OS already holds, and leaves it the system of record", async () => {
    // A contact that arrived through the Network OS mapping, as a real sync would leave it.
    const personId = `per_${crypto.randomUUID()}`;
    await t.db
      .prepare("INSERT INTO person (id, full_name, email, source) VALUES (?1, 'Rowan Feld', 'rowan@example.com', 'network_os')")
      .bind(personId)
      .run();
    await t.db
      .prepare(
        `INSERT INTO network_external_mapping (id, resource, external_id, identity_key, internal_type, internal_id, firm_scope)
         VALUES (?1, 'contact', 'ext_rowan', 'rowan@example.com', 'person', ?2, 'west-peek')`,
      )
      .bind(`nem_${crypto.randomUUID()}`, personId)
      .run();

    const id = await newCapture("caught up with Rowan Feld");
    const res = await call<{ person_source: string; person_id: string }>(`/api/captures/${id}/resolve`, MP, "POST", {
      kind: "PERSON",
      name: "Rowan Feld",
      email: "rowan@example.com",
    });
    expect(res.body.person_source).toBe("NETWORK_OS");
    expect(res.body.person_id).toBe(personId);
  });

  it("accepts NEITHER without inventing a record anywhere", async () => {
    const before = await t.db.prepare("SELECT COUNT(*) AS n FROM canonical_company").first<{ n: number }>();
    const id = await newCapture("remember to reread the reserve policy");
    const res = await call(`/api/captures/${id}/resolve`, MP, "POST", { kind: "NEITHER", note: "a note to self" });
    expect(res.status).toBe(200);
    const after = await t.db.prepare("SELECT COUNT(*) AS n FROM canonical_company").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it("refuses to resolve the same capture twice", async () => {
    const id = await newCapture("one thing only");
    await call(`/api/captures/${id}/resolve`, MP, "POST", { kind: "COMPANY", name: "Once Only Ltd" });
    const again = await call(`/api/captures/${id}/resolve`, MP, "POST", { kind: "COMPANY", name: "Something Else" });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_resolved");
  });

  it("requires a name for anything that is not NEITHER", async () => {
    const id = await newCapture("nameless");
    const res = await call(`/api/captures/${id}/resolve`, MP, "POST", { kind: "PERSON" });
    expect(res.status).toBe(400);
  });
});

describe("the unresolved-people queue", () => {
  it("lists exactly the people who are not in the system of record", async () => {
    const id = await newCapture("met Quinn Alvarez at a dinner");
    await call(`/api/captures/${id}/resolve`, MP, "POST", { kind: "PERSON", name: "Quinn Alvarez" });

    const res = await call<{
      people: Array<{ full_name: string; proposed: boolean; last_refusal: string | null }>;
      count: number;
      to_send: number;
      awaiting_review: number;
      why: string;
      next_step: string;
    }>("/api/captures/unresolved-people", MP);
    expect(res.status).toBe(200);
    const quinn = res.body.people.find((p) => p.full_name === "Quinn Alvarez");
    expect(quinn).toBeDefined();
    // Not sent (this env cannot reach Network OS), and the reason is on the row for the retry.
    expect(quinn!.proposed).toBe(false);
    expect(quinn!.last_refusal).toContain("WP_OS_NETWORK_OS_BASE_URL is not set");
    expect(res.body.to_send + res.body.awaiting_review).toBe(res.body.count);
    // Rowan came from Network OS and must NOT be waiting in a queue for Network OS.
    expect(res.body.people.some((p) => p.full_name === "Rowan Feld")).toBe(false);
    expect(res.body.why).toContain("system of record");
    expect(res.body.next_step).toContain("Network OS");
  });

  it("is reachable by its own name rather than being swallowed by the :id route", async () => {
    // "unresolved-people" is a perfectly good capture id as far as the router is concerned, so
    // this asserts the literal path still wins after any future reordering.
    const res = await call<{ count: number }>("/api/captures/unresolved-people", MP);
    expect(res.status).toBe(200);
    expect(typeof res.body.count).toBe("number");
  });
});
