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
