import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { FirmUserIdentity } from "../src/worker/auth";
import type { Actor } from "../src/worker/services/authorize";
import { declareContract, pullResource, type NetworkOsClient, type NetworkRecord } from "../src/worker/services/networkAdapter";
import { ALREADY_PROPOSED_VIA, REFUSAL_CARD_NEXT_ACTION, REFUSAL_CARD_TITLE } from "../src/worker/services/captures";
import { authorize } from "../src/worker/services/authorize";
import { ORDINARY_ACTION_TYPES } from "../src/shared/registry/actionTypes";

/**
 * Capture hands a person to Network OS by itself, the round trip closes, a refusal is visible.
 *
 * Before 27 Sep 2026 the "Send to Network OS" button existed and production held five captures,
 * all archived unresolved, zero proposals ever sent, 4,715 synced contacts and 0 of them linked to
 * a local person. Every piece was built and nothing joined them. These pin the joins:
 *
 *   1. resolving an unknown person proposes exactly once and records the event;
 *   2. a refused proposal opens ONE HIGH card, and a second refusal joins it;
 *   3. the sync links a proposed person when the contact arrives — by email, and by name plus the
 *      proposal event when the contact has no email — flips the capture to NETWORK_OS and writes
 *      network.person_linked; a name alone never links;
 *   4. an ambiguous match links nothing and writes network.person_link_ambiguous;
 *   5. a second capture of a proposed person reuses the row and sends nothing.
 *
 * The far end is a stubbed fetch: Network OS is never called from a test.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const MP_IDENTITY: FirmUserIdentity = {
  id: "fu_scooter_taylor",
  email: "scooter@westpeek.ventures",
  fullName: "Scooter Taylor",
  status: "ACTIVE",
  roles: ["MANAGING_PARTNER"],
  authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "west-peek" }],
};

const CONTRACT = {
  source_of_truth: { network_os: ["contact"], west_peek_os: ["work_card"] },
  direction: "INBOUND read-only except the link-back of a person West Peek OS itself proposed; OUTBOUND behind network_os.writeback",
  identity_keys: { contact: "email_lower" },
  freshness: "cursor per resource",
  conflict_behavior: "linked-field divergence opens a conflict",
  idempotency: "delivery_id keyed receipt",
  retry_behavior: "bounded",
  audit_event: "network.* events",
  failure_state: "DEGRADED_READ_ONLY",
};

/** What the stubbed Network OS does with the next proposals. */
let farEnd: "accept" | "refuse" = "accept";
const intakeCalls: Array<{ url: string; body: string }> = [];

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
  const res = await call<{ id: string }>("/api/captures", MP, "POST", { capture_type: "NOTE", raw_text: text, source_channel: "test" });
  expect(res.status).toBe(201);
  return res.body.id;
}

interface Resolved {
  person_id: string;
  person_source: string;
  matched_via: string;
  what_this_means: string;
  proposal: { status: string; detail: string; work_card_id: string | null } | null;
}

async function resolvePerson(captureId: string, person: { name: string; email?: string; organization?: string }): Promise<Resolved> {
  const res = await call<Resolved>(`/api/captures/${captureId}/resolve`, MP, "POST", { kind: "PERSON", ...person });
  expect(res.status).toBe(200);
  return res.body;
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await t.db.prepare(sql).bind(...binds).first<{ n: number }>();
  return row!.n;
}

function contactClient(records: NetworkRecord[]): NetworkOsClient {
  let served = false;
  return {
    async pull() {
      const page = served ? [] : records;
      served = true;
      return { records: page, next_cursor: null, provider_version: "fixture" };
    },
    async push() {
      return { ok: true, response: {} };
    },
  };
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, {
    WP_OS_NETWORK_OS_BASE_URL: "https://network.test.invalid",
    WP_OS_NETWORK_OS_SESSION_SECRET: "test-secret",
    WP_OS_NETWORK_OS_USER_EMAIL: "os@westpeek.ventures",
  });
  await declareContract(env, MP_ACTOR, CONTRACT);
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.endsWith("/api/intake/create")) throw new Error(`unexpected fetch in test: ${url}`);
    intakeCalls.push({ url, body: String(init?.body ?? "") });
    if (farEnd === "refuse") {
      return new Response(JSON.stringify({ ok: false, error: "intake is closed for maintenance" }), { status: 503, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, id: `intake_${intakeCalls.length}` }), { status: 200, headers: { "content-type": "application/json" } });
  });
});

afterEach(() => {
  farEnd = "accept";
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

describe("0. who may propose", () => {
  /*
   * The button never worked. `network_os.propose_person` was seeded as an external effect, which
   * authorize() answers with REQUIRE_APPROVAL until a receipt is presented, and the handler turned
   * that into 403 — so every press in production was refused and nothing said so. It is RESTRICTED
   * now (migration 0243): named human roles act at once, an AI actor is refused.
   */
  it("a Managing Partner acts at once; an AI actor is refused; the registry and the row agree", async () => {
    const human = await authorize(env, MP_ACTOR, "network_os.propose_person", { objectType: "person", objectId: "per_x", firmScope: "west-peek" });
    expect(human).toMatchObject({ decision: "ALLOW", reason: "restricted_action_permitted" });
    const ai = await authorize(env, { type: "AI", aiEmployeeId: "aie_wyatt", roles: [], firmScopes: ["west-peek"] }, "network_os.propose_person", {
      objectType: "person",
      objectId: "per_x",
      firmScope: "west-peek",
    });
    expect(ai.decision).toBe("DENY");
    const row = await t.db.prepare("SELECT is_external_effect, is_reserved FROM action_type WHERE key = 'network_os.propose_person'").first<{ is_external_effect: number; is_reserved: number }>();
    expect(row).toEqual({ is_external_effect: 0, is_reserved: 0 });
    expect(ORDINARY_ACTION_TYPES.find((a) => a.key === "network_os.propose_person")?.isExternalEffect).toBe(false);
  });
});

describe("1. resolving an unknown person proposes exactly once", () => {
  it("sends one intake message, records network.person_proposed, and says what happens next", async () => {
    const before = intakeCalls.length;
    const id = await newCapture("met Ines Okafor at the fintech dinner, ines@okafor.example");
    const r = await resolvePerson(id, { name: "Ines Okafor", email: "ines@okafor.example", organization: "Okafor Capital" });

    expect(r.person_source).toBe("LOCAL_UNRESOLVED");
    expect(r.matched_via).toBe("proposed to Network OS — awaiting their review");
    expect(r.proposal?.status).toBe("proposed");
    expect(r.what_this_means).toBe(
      "Network OS did not know this person. They are now in Network OS's review queue; when someone there accepts them, this record links to the contact on the next sync.",
    );
    // The operator is not told to go anywhere.
    expect(r.what_this_means).not.toMatch(/cannot write|press|Network page/i);

    expect(intakeCalls.length).toBe(before + 1);
    expect(intakeCalls[intakeCalls.length - 1]!.body).toContain("Ines Okafor");
    expect(intakeCalls[intakeCalls.length - 1]!.body).toContain("Source: West Peek OS capture");
    expect(await count("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'network.person_proposed' AND object_id = ?1", r.person_id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'network.person_proposal_failed' AND object_id = ?1", r.person_id)).toBe(0);

    // The manual button is a retry: pressed on a person already sent, it says so and sends nothing.
    const again = await call<{ error: string; detail: string }>(`/api/captures/${id}/propose-to-network`, MP, "POST", {});
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_proposed");
    expect(again.body.detail).toContain("already been sent");
    expect(intakeCalls.length).toBe(before + 1);

    // The Network page lists them as sent, not as a button to press.
    const queue = await call<{ people: Array<{ person_id: string; proposed: boolean; last_refusal: string | null }>; to_send: number; awaiting_review: number }>(
      "/api/captures/unresolved-people",
      MP,
    );
    const entry = queue.body.people.find((p) => p.person_id === r.person_id);
    expect(entry?.proposed).toBe(true);
    expect(entry?.last_refusal).toBeNull();
    expect(queue.body.awaiting_review).toBeGreaterThanOrEqual(1);
  });
});

describe("2. a refused proposal is a resolve that succeeded, with one HIGH card", () => {
  it("opens one card naming the refusal, and a second refusal joins it", async () => {
    farEnd = "refuse";
    const id = await newCapture("met Jonah Reyes, jonah@reyes.example");
    const r = await resolvePerson(id, { name: "Jonah Reyes", email: "jonah@reyes.example" });

    expect(r.person_source).toBe("LOCAL_UNRESOLVED");
    expect(r.proposal?.status).toBe("refused");
    expect(r.matched_via).toContain("proposal refused");
    expect(r.matched_via).toContain("intake is closed for maintenance");
    expect(r.what_this_means).toContain("refused");
    expect(r.what_this_means).toContain("HIGH work card");
    expect(r.what_this_means).toContain("not claiming");
    expect(r.proposal?.work_card_id).toMatch(/^wc_/);

    const card = await t.db
      .prepare("SELECT title, priority, state, next_action, capture_id, description FROM work_card WHERE id = ?1")
      .bind(r.proposal!.work_card_id)
      .first<{ title: string; priority: string; state: string; next_action: string; capture_id: string; description: string }>();
    expect(card!.title).toBe(`${REFUSAL_CARD_TITLE}Jonah Reyes`);
    expect(card!.priority).toBe("HIGH");
    expect(card!.state).toBe("OPEN");
    expect(card!.next_action).toBe(REFUSAL_CARD_NEXT_ACTION);
    expect(card!.capture_id).toBe(id);
    expect(card!.description).toContain("intake is closed for maintenance");
    expect(await count("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'network.person_proposal_failed' AND object_id = ?1", r.person_id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'network.person_proposed' AND object_id = ?1", r.person_id)).toBe(0);

    // The retry from the Network page is refused again: one more event, the SAME card.
    const retry = await call<{ error: string; work_card_id: string }>(`/api/captures/${id}/propose-to-network`, MP, "POST", {});
    expect(retry.status).toBe(502);
    expect(retry.body.error).toBe("propose_failed");
    expect(retry.body.work_card_id).toBe(r.proposal!.work_card_id);
    expect(await count("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'network.person_proposal_failed' AND object_id = ?1", r.person_id)).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM work_card WHERE title = ?1", `${REFUSAL_CARD_TITLE}Jonah Reyes`)).toBe(1);

    // And the list shows the reason next to the button.
    const queue = await call<{ people: Array<{ person_id: string; proposed: boolean; last_refusal: string | null }>; to_send: number }>("/api/captures/unresolved-people", MP);
    const entry = queue.body.people.find((p) => p.person_id === r.person_id);
    expect(entry?.proposed).toBe(false);
    expect(entry?.last_refusal).toBe("intake is closed for maintenance");
    expect(queue.body.to_send).toBeGreaterThanOrEqual(1);

    // Once the cause is fixed the retry works, and the person leaves the to-send side of the list.
    farEnd = "accept";
    const ok = await call<{ ok: boolean }>(`/api/captures/${id}/propose-to-network`, MP, "POST", {});
    expect(ok.status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'network.person_proposed' AND object_id = ?1", r.person_id)).toBe(1);
  });
});

describe("3. the sync links a proposed person when the contact arrives", () => {
  it("by email: mapping linked, blanks filled, capture flips to NETWORK_OS, network.person_linked written", async () => {
    const id = await newCapture("met Priya Nair, priya@nair.example");
    const r = await resolvePerson(id, { name: "Priya Nair", email: "priya@nair.example" });
    expect(r.proposal?.status).toBe("proposed");

    const summary = await pullResource(
      env,
      MP_IDENTITY,
      "contact",
      contactClient([
        {
          external_id: "contact_priya",
          identity_key: "priya@nair.example",
          delivery_id: "d_priya_1",
          fields: { full_name: "Priya Nair", email: "Priya@Nair.example", company: "Nair Ventures" },
        },
      ]),
    );
    expect(summary.applied).toBe(1);
    expect(summary.conflicts).toBe(0);
    expect(summary.duplicates).toBe(0);

    const mapping = await t.db
      .prepare("SELECT internal_type, internal_id FROM network_external_mapping WHERE resource = 'contact' AND external_id = 'contact_priya'")
      .first<{ internal_type: string | null; internal_id: string | null }>();
    expect(mapping!.internal_type).toBe("person");
    expect(mapping!.internal_id).toBe(r.person_id);

    const person = await t.db.prepare("SELECT email, organization FROM person WHERE id = ?1").bind(r.person_id).first<{ email: string; organization: string | null }>();
    // The operator's email stays as typed; the organization was blank and is filled from the snapshot.
    expect(person!.email).toBe("priya@nair.example");
    expect(person!.organization).toBe("Nair Ventures");

    const capture = await t.db.prepare("SELECT person_source FROM capture WHERE id = ?1").bind(id).first<{ person_source: string }>();
    expect(capture!.person_source).toBe("NETWORK_OS");

    const linked = await t.db
      .prepare("SELECT payload_json FROM event_record WHERE event_type = 'network.person_linked' AND object_id = ?1")
      .bind(r.person_id)
      .all<{ payload_json: string }>();
    expect(linked.results).toHaveLength(1);
    expect(JSON.parse(linked.results![0]!.payload_json)).toMatchObject({ person_id: r.person_id, external_id: "contact_priya", matched_by: "email" });

    // Linked means known: a later capture of the same person matches Network OS outright.
    const later = await newCapture("Priya again");
    const again = await resolvePerson(later, { name: "Priya Nair" });
    expect(again.person_source).toBe("NETWORK_OS");
    expect(again.person_id).toBe(r.person_id);
    // …and they have left the unresolved list.
    const queue = await call<{ people: Array<{ person_id: string }> }>("/api/captures/unresolved-people", MP);
    expect(queue.body.people.some((p) => p.person_id === r.person_id)).toBe(false);
  });

  it("by name plus the proposal event when the contact has no email; a name alone never links", async () => {
    // Proposed, no email.
    const id = await newCapture("met Theo Lindqvist at the Room");
    const r = await resolvePerson(id, { name: "Theo Lindqvist" });
    expect(r.proposal?.status).toBe("proposed");
    // Same name, never proposed, no email: must NOT be claimed by a contact.
    const bystander = `per_${crypto.randomUUID()}`;
    await t.db
      .prepare("INSERT INTO person (id, full_name, source, firm_scope) VALUES (?1, 'Mira Solano', 'manual', 'west-peek')")
      .bind(bystander)
      .run();

    const summary = await pullResource(
      env,
      MP_IDENTITY,
      "contact",
      contactClient([
        { external_id: "contact_theo", identity_key: "contact_theo", delivery_id: "d_theo_1", fields: { full_name: "  theo lindqvist ", email: null, company: "Lindqvist AB" } },
        { external_id: "contact_mira", identity_key: "contact_mira", delivery_id: "d_mira_1", fields: { full_name: "Mira Solano", email: null } },
      ]),
    );
    expect(summary.applied).toBe(2);
    expect(summary.conflicts).toBe(0);

    const theo = await t.db
      .prepare("SELECT internal_id FROM network_external_mapping WHERE resource = 'contact' AND external_id = 'contact_theo'")
      .first<{ internal_id: string | null }>();
    expect(theo!.internal_id).toBe(r.person_id);
    const capture = await t.db.prepare("SELECT person_source FROM capture WHERE id = ?1").bind(id).first<{ person_source: string }>();
    expect(capture!.person_source).toBe("NETWORK_OS");
    const linked = await t.db
      .prepare("SELECT payload_json FROM event_record WHERE event_type = 'network.person_linked' AND object_id = ?1")
      .bind(r.person_id)
      .first<{ payload_json: string }>();
    expect(JSON.parse(linked!.payload_json)).toMatchObject({ matched_by: "name", external_id: "contact_theo" });

    const mira = await t.db
      .prepare("SELECT internal_id FROM network_external_mapping WHERE resource = 'contact' AND external_id = 'contact_mira'")
      .first<{ internal_id: string | null }>();
    expect(mira!.internal_id).toBeNull();
  });
});

describe("4. an ambiguous match links nothing", () => {
  it("two unlinked people on one email: no link, network.person_link_ambiguous names both", async () => {
    const id = await newCapture("met Sam Achebe, sam@achebe.example");
    const r = await resolvePerson(id, { name: "Sam Achebe", email: "sam@achebe.example" });
    // A second, older local row on the same email that nobody linked (a manual import, say).
    const twin = `per_${crypto.randomUUID()}`;
    await t.db
      .prepare("INSERT INTO person (id, full_name, email, source, firm_scope) VALUES (?1, 'Samuel Achebe', 'SAM@achebe.example', 'manual', 'west-peek')")
      .bind(twin)
      .run();

    const summary = await pullResource(
      env,
      MP_IDENTITY,
      "contact",
      contactClient([{ external_id: "contact_sam", identity_key: "sam@achebe.example", delivery_id: "d_sam_1", fields: { full_name: "Sam Achebe", email: "sam@achebe.example" } }]),
    );
    expect(summary.applied).toBe(1);
    expect(summary.conflicts).toBe(0);

    const mapping = await t.db
      .prepare("SELECT internal_id FROM network_external_mapping WHERE resource = 'contact' AND external_id = 'contact_sam'")
      .first<{ internal_id: string | null }>();
    expect(mapping!.internal_id).toBeNull();
    const capture = await t.db.prepare("SELECT person_source FROM capture WHERE id = ?1").bind(id).first<{ person_source: string }>();
    expect(capture!.person_source).toBe("LOCAL_UNRESOLVED");
    expect(await count("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'network.person_linked' AND object_id = ?1", r.person_id)).toBe(0);

    const ambiguous = await t.db
      .prepare("SELECT payload_json FROM event_record WHERE event_type = 'network.person_link_ambiguous' AND object_id = 'contact_sam'")
      .all<{ payload_json: string }>();
    expect(ambiguous.results).toHaveLength(1);
    const payload = JSON.parse(ambiguous.results![0]!.payload_json) as { candidates: Array<{ person_id: string }> };
    expect(payload.candidates.map((c) => c.person_id).sort()).toEqual([r.person_id, twin].sort());
  });
});

describe("5. a second capture of a proposed person reuses the row", () => {
  it("matches by email or exact name, creates no row, sends nothing", async () => {
    const first = await newCapture("met Lena Vogt, lena@vogt.example");
    const a = await resolvePerson(first, { name: "Lena Vogt", email: "lena@vogt.example" });
    expect(a.proposal?.status).toBe("proposed");
    const sent = intakeCalls.length;

    const second = await newCapture("Lena Vogt again, at a different event");
    const b = await resolvePerson(second, { name: "Lena Vogt", email: "LENA@vogt.example" });
    expect(b.person_id).toBe(a.person_id);
    expect(b.person_source).toBe("LOCAL_UNRESOLVED");
    expect(b.matched_via).toBe(ALREADY_PROPOSED_VIA);
    expect(b.proposal).toBeNull();
    expect(b.what_this_means).toContain("no second record and no second proposal");

    const third = await newCapture("a colleague met lena vogt too, no card");
    const c = await resolvePerson(third, { name: "  lena vogt " });
    expect(c.person_id).toBe(a.person_id);
    expect(c.matched_via).toBe(ALREADY_PROPOSED_VIA);

    expect(intakeCalls.length).toBe(sent);
    expect(await count("SELECT COUNT(*) AS n FROM person WHERE lower(email) = 'lena@vogt.example'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'network.person_proposed' AND object_id = ?1", a.person_id)).toBe(1);

    // When Network OS accepts them, every capture that resolved to the row flips together.
    await pullResource(
      env,
      MP_IDENTITY,
      "contact",
      contactClient([{ external_id: "contact_lena", identity_key: "lena@vogt.example", delivery_id: "d_lena_1", fields: { full_name: "Lena Vogt", email: "lena@vogt.example" } }]),
    );
    expect(await count("SELECT COUNT(*) AS n FROM capture WHERE resolved_person_id = ?1 AND person_source = 'NETWORK_OS'", a.person_id)).toBe(3);
  });
});
