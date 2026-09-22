import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleRequest } from "../src/worker/index";
import { originOf, type OriginCard, type OriginKind } from "../src/shared/work/origin";
import { NO_KIND_FILTER_VALUE, type RecordRow } from "../src/shared/work/record";

/**
 * RECORD'S NEW FILTERS AND THE COLLAPSE/ORIGIN AXIS (Addendum 4, 22 Sep 2026, follow-on to
 * Wave A–E: "Record becomes the permanent read-only version of the card page").
 *
 * Three things this guards, each traceable to her decision:
 *
 *   · KIND, ORIGIN AND A DATE RANGE ARE REAL SERVER FILTERS — not full-text search standing in
 *     for them, and not a client-side narrowing of a page the server already truncated (the exact
 *     failure `validate:record-scales` exists to catch for `q`/`who`/`month`/`state`).
 *   · THE SQL ORIGIN CLASSIFICATION AGREES WITH `originOf()`. `ORIGIN_CASE_SQL` in
 *     `workCards.ts` cannot literally call the TS function — D1 only runs SQL — so it is a
 *     hand-written mirror of the same precedence, and THIS is the test that pins the two cannot
 *     silently disagree: one fixture of every origin kind, checked both ways.
 *   · "A ONE-OFF ASSIGNMENT IS NEVER IDENTICAL TO ANYTHING ELSE AND SHOULD NEVER COLLAPSE, EVEN
 *     IF IT LOOKS SIMILAR TO ANOTHER" — her words. A recurring kind (`ROOM_PACKET`, job-door)
 *     collapses two identical runs into one row; a one-off kind (`WEB_PROPERTY_CHANGE`, and the
 *     plain `kind = NULL` card) never does, even when every visible column matches.
 */

let t: TestDb;
let env: Env;

const SCOOTER = "scooter@westpeek.ventures";

async function insertCard(fields: {
  id: string;
  title: string;
  kind?: string | null;
  state?: "DONE" | "CANCELLED";
  createdBy?: string;
  requestedByEmail?: string | null;
  captureId?: string | null;
  meetingId?: string | null;
  assignedFromCardId?: string | null;
  createdAt?: string;
  ownerId?: string | null;
}): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO work_card
        (id, title, kind, state, created_by, requested_by_email, capture_id, meeting_id, assigned_from_card_id, owner_id, firm_scope, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'west-peek', ?11)`,
  )
    .bind(
      fields.id,
      fields.title,
      fields.kind ?? null,
      fields.state ?? "DONE",
      fields.createdBy ?? "system",
      fields.requestedByEmail ?? null,
      fields.captureId ?? null,
      fields.meetingId ?? null,
      fields.assignedFromCardId ?? null,
      fields.ownerId ?? null,
      fields.createdAt ?? new Date().toISOString(),
    )
    .run();
}

async function recordRows(qs: string): Promise<RecordRow[]> {
  const res = await handleRequest(new Request(`https://test.local/api/work-cards/record?${qs}`, { headers: { "x-wpos-dev-user": SCOOTER } }), env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { rows: RecordRow[] };
  return body.rows;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, {} as Partial<Env>);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("origin: the SQL classification agrees with originOf()", () => {
  const fixtures: Array<{ label: string; kind: OriginKind; card: OriginCard & { id: string } }> = [
    { label: "an email assignment", kind: "EMAIL", card: { id: "wc_origin_email", requested_by_email: "scooter@westpeek.ventures", created_by: "system" } },
    { label: "a partner, in the OS", kind: "PARTNER", card: { id: "wc_origin_partner", created_by: "fu_scooter_taylor" } },
    { label: "a meeting commitment", kind: "MEETING", card: { id: "wc_origin_meeting", created_by: "system", meeting_id: "mtg_1" } },
    { label: "something captured", kind: "CAPTURE", card: { id: "wc_origin_capture", created_by: "system", capture_id: "cap_1" } },
    { label: "handed off from another card", kind: "ANOTHER_CARD", card: { id: "wc_origin_handoff", created_by: "system", assigned_from_card_id: "wc_ancestor" } },
    { label: "the system or the sweep", kind: "SYSTEM", card: { id: "wc_origin_system", created_by: "sjob_room_packet" } },
  ];

  beforeAll(async () => {
    // The three foreign-keyed origins need a real row to point at — a capture, a meeting, and an
    // ancestor card (`assigned_from_card_id` is self-referencing on `work_card`).
    await env.WP_OS_DB.prepare(
      "INSERT INTO capture (id, capture_type, raw_text, source_channel, captured_by) VALUES ('cap_1', 'NOTE', 'origin fixture', 'MANUAL', 'system')",
    ).run();
    await env.WP_OS_DB.prepare(
      "INSERT INTO meeting (id, title, meeting_type, created_by) VALUES ('mtg_1', 'origin fixture meeting', 'INTERNAL', 'system')",
    ).run();
    await insertCard({ id: "wc_ancestor", title: "origin fixture — the ancestor card" });

    for (const f of fixtures) {
      await insertCard({
        id: f.card.id,
        title: `origin fixture — ${f.label}`,
        createdBy: f.card.created_by ?? undefined,
        requestedByEmail: f.card.requested_by_email ?? null,
        captureId: f.card.capture_id ?? null,
        meetingId: f.card.meeting_id ?? null,
        assignedFromCardId: f.card.assigned_from_card_id ?? null,
      });
    }
  });

  it.each(fixtures)("$label: the record row's origin_kind matches originOf()'s own answer", async ({ kind, card }) => {
    const rows = await recordRows(`limit=200&q=origin+fixture`);
    const row = rows.find((r) => r.id === card.id);
    expect(row, `${card.id} did not come back from the record`).toBeTruthy();
    // originOf() with no viewer (Record's own convention: never "YOU", see RECORD_ORIGIN_KINDS).
    expect(originOf(card, null).kind).toBe(kind);
    expect(row!.origin_kind, "the SQL classification and originOf() must name the same kind").toBe(kind);
  });

  it.each(fixtures)("filters to exactly this origin when asked for $kind", async ({ kind, card }) => {
    const rows = await recordRows(`limit=200&q=origin+fixture&origin=${kind}`);
    expect(rows.map((r) => r.id)).toContain(card.id);
    for (const r of rows) expect(r.origin_kind).toBe(kind);
  });
});

describe("kind: a real server filter", () => {
  beforeAll(async () => {
    await insertCard({ id: "wc_kind_a", title: "kind filter — web property", kind: "WEB_PROPERTY_CHANGE" });
    await insertCard({ id: "wc_kind_b", title: "kind filter — blog help", kind: "BLOG_HELP" });
    await insertCard({ id: "wc_kind_c", title: "kind filter — no kind at all", kind: null });
  });

  it("kind=WEB_PROPERTY_CHANGE returns only that kind", async () => {
    const rows = await recordRows(`limit=200&q=kind+filter&kind=WEB_PROPERTY_CHANGE`);
    expect(rows.map((r) => r.id)).toEqual(["wc_kind_a"]);
  });

  it(`kind=${NO_KIND_FILTER_VALUE} returns only the plain, un-kinded card`, async () => {
    const rows = await recordRows(`limit=200&q=kind+filter&kind=${NO_KIND_FILTER_VALUE}`);
    expect(rows.map((r) => r.id)).toEqual(["wc_kind_c"]);
  });

  it("the kinds facet names every kind seen, including the plain card", async () => {
    const res = await handleRequest(new Request(`https://test.local/api/work-cards/record?limit=200&q=kind+filter`, { headers: { "x-wpos-dev-user": SCOOTER } }), env);
    const body = (await res.json()) as { kinds: Array<{ kind: string; label: string; cards: number }> };
    const keys = body.kinds.map((k) => k.kind);
    expect(keys).toContain("WEB_PROPERTY_CHANGE");
    expect(keys).toContain(NO_KIND_FILTER_VALUE);
  });
});

describe("a date range narrows to a calendar span, inclusive of the last day", () => {
  beforeAll(async () => {
    await insertCard({ id: "wc_date_early", title: "date range fixture — early", createdAt: "2026-01-05T10:00:00.000Z" });
    await insertCard({ id: "wc_date_mid", title: "date range fixture — mid", createdAt: "2026-01-10T23:59:00.000Z" });
    await insertCard({ id: "wc_date_late", title: "date range fixture — late", createdAt: "2026-01-20T10:00:00.000Z" });
  });

  it("from=2026-01-08&to=2026-01-10 includes the mid card, not the early or late ones", async () => {
    const rows = await recordRows(`limit=200&q=date+range+fixture&from=2026-01-08&to=2026-01-10`);
    expect(rows.map((r) => r.id)).toEqual(["wc_date_mid"]);
  });

  it("to is inclusive of the whole last day, not just its midnight", async () => {
    const rows = await recordRows(`limit=200&q=date+range+fixture&from=2026-01-10&to=2026-01-10`);
    expect(rows.map((r) => r.id)).toContain("wc_date_mid");
  });
});

describe("a one-off assignment never collapses, even when it looks identical to another", () => {
  it("a recurring kind (ROOM_PACKET, job-door) still collapses two identical runs into one row", async () => {
    await insertCard({ id: "wc_recur_1", title: "September 2026 Room packet", kind: "ROOM_PACKET", createdAt: "2026-09-05T10:00:00.000Z" });
    await insertCard({ id: "wc_recur_2", title: "September 2026 Room packet", kind: "ROOM_PACKET", createdAt: "2026-09-16T10:00:00.000Z" });
    const rows = await recordRows(`limit=200&q=September+2026+Room+packet`);
    const matching = rows.filter((r) => r.title === "September 2026 Room packet");
    expect(matching).toHaveLength(1);
    expect(matching[0]!.runs).toBe(2);
    // "Reopen" acts on the most recent of the collapsed runs.
    expect(matching[0]!.id).toBe("wc_recur_2");
  });

  it("a one-off kind (WEB_PROPERTY_CHANGE) with an identical title/owner/month/state never collapses", async () => {
    await insertCard({ id: "wc_oneoff_1", title: "Update the ventures footer", kind: "WEB_PROPERTY_CHANGE", createdAt: "2026-09-03T10:00:00.000Z" });
    await insertCard({ id: "wc_oneoff_2", title: "Update the ventures footer", kind: "WEB_PROPERTY_CHANGE", createdAt: "2026-09-12T10:00:00.000Z" });
    const rows = await recordRows(`limit=200&q=Update+the+ventures+footer`);
    const matching = rows.filter((r) => r.title === "Update the ventures footer");
    expect(matching, "both one-off cards stay two separate rows").toHaveLength(2);
    for (const r of matching) expect(r.runs).toBe(1);
    expect(matching.map((r) => r.id).sort()).toEqual(["wc_oneoff_1", "wc_oneoff_2"]);
  });

  it("the plain, un-kinded card (kind = NULL) is one-off too and never collapses", async () => {
    await insertCard({ id: "wc_plain_1", title: "Draft the LP letter", kind: null, createdAt: "2026-09-02T10:00:00.000Z" });
    await insertCard({ id: "wc_plain_2", title: "Draft the LP letter", kind: null, createdAt: "2026-09-08T10:00:00.000Z" });
    const rows = await recordRows(`limit=200&q=Draft+the+LP+letter`);
    const matching = rows.filter((r) => r.title === "Draft the LP letter");
    expect(matching).toHaveLength(2);
    for (const r of matching) expect(r.runs).toBe(1);
  });
});
