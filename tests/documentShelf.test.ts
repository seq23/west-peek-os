import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { kindDef } from "../src/shared/deliverables/deliverable";

/**
 * Taking a document off the shelf, and not filing what was never worth keeping.
 *
 * The operator asked to clean up documents "and time stamp who did it for a trail". There was no
 * delete route of any kind, for anyone — five document routes and none of them removed anything —
 * so there was nothing to record either. Six of the eight documents in production were machine
 * noise: four byte-identical copies of one weekly review, two morning briefs, and a
 * capability-probe JPEG.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures", "content-type": "application/json" };

function req(path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: MP,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call<T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(req(path, method, body), env);
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  // Something to take off the shelf.
  await call("/api/documents", "POST", {
    title: "Weekly operating review — week of 2026-08-19",
    doc_type: "REVIEW",
    content_type: "text/markdown",
    content_base64: btoa("# review"),
  });
  await call("/api/documents", "POST", {
    title: "Weekly operating review — week of 2026-08-19 (duplicate)",
    doc_type: "REVIEW",
    content_type: "text/markdown",
    content_base64: btoa("# review"),
  });
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("a document can be taken off the shelf, and the record of it survives", () => {
  async function shelfIds(): Promise<string[]> {
    const res = await call<{ documents: Array<{ id: string }> }>("/api/documents");
    return res.body.documents.map((d) => d.id);
  }

  it("requires a reason, because the reason is the only part that still helps later", async () => {
    const [id] = await shelfIds();
    const res = await call(`/api/documents/${id}/archive`, "POST", { reason: "x" });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("reason_required");
  });

  it("takes it off the shelf and keeps who, when and why", async () => {
    const [id] = await shelfIds();
    const res = await call(`/api/documents/${id}/archive`, "POST", {
      reason: "duplicate of the 19 Aug weekly review",
    });
    expect(res.status).toBe(200);

    expect(await shelfIds()).not.toContain(id);

    const archived = await call<{ documents: Array<{ id: string; archive_reason: string; archived_by: string; archived_at: string }> }>(
      "/api/documents?archived=1",
    );
    const found = archived.body.documents.find((d) => d.id === id)!;
    expect(found.archive_reason).toContain("duplicate");
    expect(found.archived_by).toBeTruthy();
    expect(found.archived_at).toBeTruthy();
  });

  it("refuses to archive the same document twice", async () => {
    const archived = await call<{ documents: Array<{ id: string }> }>("/api/documents?archived=1");
    const id = archived.body.documents[0]!.id;
    const res = await call(`/api/documents/${id}/archive`, "POST", { reason: "trying again" });
    expect(res.status).toBe(409);
  });

  it("destroys nothing — archiving changes only who took it off the shelf", async () => {
    const [id] = await shelfIds();
    const versionsBefore = await t.db
      .prepare("SELECT COUNT(*) AS n FROM document_version WHERE document_id = ?1")
      .bind(id)
      .first<{ n: number }>();

    await call(`/api/documents/${id}/archive`, "POST", { reason: "no longer relevant" });

    // The row is still there, and so is everything that pointed at it. Counted before and after
    // rather than asserted non-zero, so this tests the archive rather than the fixture.
    const row = await t.db.prepare("SELECT id, title FROM document WHERE id = ?1").bind(id).first<{ id: string; title: string }>();
    expect(row?.id).toBe(id);
    expect(row?.title).toBeTruthy();

    const versionsAfter = await t.db
      .prepare("SELECT COUNT(*) AS n FROM document_version WHERE document_id = ?1")
      .bind(id)
      .first<{ n: number }>();
    expect(versionsAfter!.n).toBe(versionsBefore!.n);
  });

  it("records the removal on the event spine, which is where the trail belongs", async () => {
    const ev = await t.db
      .prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'document.archived'")
      .first<{ n: number }>();
    expect(ev!.n).toBeGreaterThan(0);
  });
});

describe("only what is worth keeping is filed", () => {
  it("does not file a morning brief, which is read once and superseded tomorrow", () => {
    expect(kindDef("daily_brief")?.file).toBe(false);
  });

  it("files the things a partner refers back to", () => {
    expect(kindDef("weekly_review")?.file).toBe(true);
    expect(kindDef("research_packet")?.file).toBe(true);
    expect(kindDef("ask_brief")?.file).toBe(true);
  });
});

/**
 * THE DECK HAS A HOME ON THE SHELF (15 Sep 2026).
 *
 * "where the fuck is the section for the current deck to stay?!" — eight deck PDFs in one flat
 * list under one identical title, no version number on any of them; v14 archived by accident; the
 * current Canva deck uploaded as a `diligence_note` and never reaching Fund strategy. Each of those
 * is one assertion below.
 */
describe("the deck on the shelf", () => {
  let t2: TestDb;
  let env2: Env;
  const MPH = { "x-wpos-dev-user": "sequoia@westpeek.ventures", "content-type": "application/json" };
  const call2 = async <T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await handleRequest(new Request(`https://test.local${path}`, { method, headers: MPH, body: body === undefined ? undefined : JSON.stringify(body) }), env2);
    return { status: res.status, body: (await res.json()) as T };
  };
  const PDF = btoa("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type /Page >> endobj\n%%EOF");

  beforeAll(async () => {
    t2 = await createTestDb();
    env2 = makeTestEnv(t2.db, { WP_OS_DOCUMENTS: t2.docs });
    await env2.WP_OS_DB.prepare("DELETE FROM fund").run();
    await env2.WP_OS_DB.prepare("INSERT INTO fund (id, name, status, firm_scope) VALUES ('fund_shelf', 'West Peek Ventures Fund I', 'ACTIVE', 'west-peek')").run();
    // A deck version snapshots the fund's figures, so the fund needs a mandate and a sleeve policy.
    await env2.WP_OS_DB.prepare(
      `INSERT INTO investment_mandate_version (id, fund_id, version_no, effective_from, mandate_json, created_by, firm_scope)
       VALUES ('pv_shelf_m', 'fund_shelf', 1, '2026-09-09', ?1, 'fu_sequoia_taylor', 'west-peek')`,
    ).bind(JSON.stringify({ target_size_usd: 30_000_000, sectors: ["AI"], target_positions: 25, check_size_usd: { min: 250_000, max: 1_000_000 }, management_fee_pct: 2, carried_interest_pct: 20 })).run();
    await env2.WP_OS_DB.prepare(
      `INSERT INTO sleeve_policy_version (id, fund_id, version_no, effective_from, sleeve_json, created_by, firm_scope)
       VALUES ('pv_shelf_s', 'fund_shelf', 1, '2026-09-09', ?1, 'fu_sequoia_taylor', 'west-peek')`,
    ).bind(JSON.stringify({ estimated_fees_usd: 6_000_000, estimated_expenses_usd: 600_000, sleeves: [{ key: "EARLY_STAGE_PRIMARY", target_pct: 70 }, { key: "SECONDARY_PURCHASE", target_pct: 30 }] })).run();
    await env2.WP_OS_DB.prepare(
      `INSERT INTO reserve_policy_version (id, fund_id, version_no, effective_from, reserve_json, created_by, firm_scope)
       VALUES ('pv_shelf_r', 'fund_shelf', 1, '2026-09-09', ?1, 'fu_sequoia_taylor', 'west-peek')`,
    ).bind(JSON.stringify({ reserve_pct: 40 })).run();
  });
  afterAll(async () => {
    await disposeTestDb(t2);
  });

  it("the list says what each type is, in words, and offers the list of types to choose from", async () => {
    await call2("/api/documents", "POST", { title: "Sensori call notes", doc_type: "diligence_note", content_type: "text/plain", content_base64: btoa("notes") });
    const list = await call2<{ documents: Array<{ title: string; doc_type: string; type_label: string }>; types: Array<{ key: string; label: string; means: string }> }>("/api/documents");
    const note = list.body.documents.find((d) => d.title === "Sensori call notes")!;
    expect(note.doc_type, "the old spelling is normalised on the way in").toBe("DILIGENCE_NOTE");
    expect(note.type_label).toBe("Diligence note");
    expect(list.body.types.map((t) => t.label)).toContain("The LP deck");
    expect(list.body.types.every((t) => t.means.length > 20)).toBe(true);
  });

  it("a deck uploaded on Documents is a numbered deck version waiting on Fund strategy, not a loose file", async () => {
    const up = await call2<{ id: string; deck_version?: { version_no: number; state: string }; note?: string }>("/api/documents", "POST", {
      title: "Aug 2026 West Peek Ventures Fund I (Deck as it is in Canva)", doc_type: "DECK", content_type: "application/pdf", content_base64: PDF,
    });
    expect(up.status).toBe(201);
    expect(up.body.deck_version).toMatchObject({ version_no: 1, state: "PROPOSED" });
    expect(up.body.note).toMatch(/not the deck the firm sends until you approve it on Fund strategy/);
    const deck = await call2<{ versions: Array<{ version_no: number; state: string; page_count: number | null; document_id: string }> }>("/api/deck");
    expect(deck.body.versions[0]).toMatchObject({ version_no: 1, state: "PROPOSED", page_count: 3 });
    expect(deck.body.versions[0]!.document_id).toBe(up.body.id);
    // And on the shelf it SAYS it is v1 and what state it is in.
    const list = await call2<{ documents: Array<{ id: string; deck: { version_no: number; state: string } | null }> }>("/api/documents");
    expect(list.body.documents.find((d) => d.id === up.body.id)!.deck).toMatchObject({ version_no: 1, state: "PROPOSED" });
  });

  it("a version waiting on a decision, or the current deck, cannot be archived from the shelf", async () => {
    const list = await call2<{ documents: Array<{ id: string; deck: { version_no: number; state: string; id: string } | null }> }>("/api/documents");
    const v1 = list.body.documents.find((d) => d.deck?.version_no === 1)!;
    const refused = await call2<{ error: string; detail: string }>(`/api/documents/${v1.id}/archive`, "POST", { reason: "thought it was a duplicate" });
    expect(refused.status).toBe(409);
    expect(refused.body.detail).toMatch(/v1, waiting on your decision on Fund strategy/);
    await call2(`/api/deck/versions/${v1.deck!.id}/decide`, "POST", { decision: "APPROVE" });
    const still = await call2<{ error: string; detail: string }>(`/api/documents/${v1.id}/archive`, "POST", { reason: "tidying" });
    expect(still.status).toBe(409);
    expect(still.body.detail).toMatch(/the deck the firm sends/);
  });

  it("an archived document can be restored, and the trail of both acts is on the spine", async () => {
    const list = await call2<{ documents: Array<{ id: string; title: string }> }>("/api/documents");
    const note = list.body.documents.find((d) => d.title === "Sensori call notes")!;
    expect((await call2(`/api/documents/${note.id}/archive`, "POST", { reason: "old" })).status).toBe(200);
    const archived = await call2<{ documents: Array<{ id: string; archive_reason: string }> }>("/api/documents?archived=1");
    expect(archived.body.documents.find((d) => d.id === note.id)!.archive_reason).toBe("old");
    const restored = await call2<{ archived: boolean; note: string }>(`/api/documents/${note.id}/restore`, "POST");
    expect(restored.status).toBe(200);
    expect(restored.body.note).toMatch(/Back on the shelf/);
    const back = await call2<{ documents: Array<{ id: string }> }>("/api/documents");
    expect(back.body.documents.some((d) => d.id === note.id)).toBe(true);
    expect((await call2(`/api/documents/${note.id}/restore`, "POST")).status).toBe(409);
    const events = await env2.WP_OS_DB.prepare("SELECT event_type FROM event_record WHERE object_id = ?1 ORDER BY created_at").bind(note.id).all<{ event_type: string }>();
    expect(events.results!.map((e) => e.event_type)).toEqual(expect.arrayContaining(["document.archived", "document.restored"]));
  });

  it("archive-all takes everything off the shelf in one act and keeps the deck the firm sends and any version waiting", async () => {
    await call2("/api/documents", "POST", { title: "Old memo", doc_type: "OTHER", content_type: "text/plain", content_base64: btoa("memo") });
    await call2("/api/documents", "POST", { title: "v2 attempt", doc_type: "DECK", content_type: "application/pdf", content_base64: PDF });
    expect((await call2("/api/documents/archive-all", "POST", { reason: "" })).status).toBe(400);
    const out = await call2<{ archived: number; kept: Array<{ version_no: number; state: string }>; note: string }>("/api/documents/archive-all", "POST", { reason: "clearing the shelf" });
    expect(out.status).toBe(200);
    expect(out.body.archived).toBeGreaterThanOrEqual(2);
    expect(out.body.kept.map((k) => k.state).sort()).toEqual(["CURRENT", "PROPOSED"]);
    expect(out.body.note).toMatch(/Kept: v1 \(the deck the firm sends\), v2 \(waiting on your decision\)/);
    const left = await call2<{ documents: Array<{ deck: { state: string } | null }> }>("/api/documents");
    expect(left.body.documents.every((d) => d.deck && ["CURRENT", "PROPOSED"].includes(d.deck.state))).toBe(true);
  });
});
